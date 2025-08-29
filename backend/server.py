import os
from typing import Dict, List, Tuple, Set
from statistics import median

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import mysql.connector
from dotenv import load_dotenv


def get_db_connection():
    host = os.getenv("DB_HOST")
    port = int(os.getenv("DB_PORT"))
    user = os.getenv("DB_USER")
    password = os.getenv("DB_PASSWORD")
    database = os.getenv("DB_NAME")

    return mysql.connector.connect(
        host=host,
        port=port,
        user=user,
        password=password,
        database=database,
        autocommit=True,
    )


load_dotenv()  # Load .env if present

app = FastAPI(title="UW Course API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    try:
        conn = get_db_connection()
        conn.close()
        return {"status": "ok"}
    except Exception:
        raise HTTPException(status_code=503, detail="Database connection is not available")


def fetch_course(cursor, course_id: str) -> Dict:
    cursor.execute(
        "SELECT course_id, COALESCE(course_name, '') AS course_name, COALESCE(department, ''), course_level, "
        "COALESCE(description, ''), liked, easy, useful, rating_num "
        "FROM course WHERE course_id = %s",
        (course_id,),
    )
    row = cursor.fetchone()
    if not row:
        # Course might not be in `course` table; still respond minimally
        return {"course_id": course_id, "course_name": "", "department": "", "course_level": None, "description": ""}
    return {
        "course_id": row[0],
        "course_name": row[1],
        "department": row[2],
        "course_level": row[3],
        "description": row[4],
        "liked": None if row[5] is None else float(row[5]),
        "easy": None if row[6] is None else float(row[6]),
        "useful": None if row[7] is None else float(row[7]),
        "rating_num": None if row[8] is None else int(row[8]),
    }


def fetch_prereq_groups(cursor, course_id: str) -> List[Dict]:
    cursor.execute(
        """
        SELECT prerequisite_group, prereq_course_id, min_grade
        FROM course_prereq
        WHERE course_id = %s
        ORDER BY prerequisite_group, prereq_course_id
        """,
        (course_id,),
    )
    groups: Dict[int, Dict] = {}
    for grp, prereq, min_grade in cursor.fetchall():
        if grp not in groups:
            groups[grp] = {"group": int(grp), "courses": []}
        groups[grp]["courses"].append({"course_id": prereq, "min_grade": None if min_grade is None else int(min_grade)})
    # Compute type from group size for backward compatibility
    for g in groups.values():
        g["type"] = "OR" if len(g["courses"]) > 1 else "AND"
    return [groups[k] for k in sorted(groups.keys())]


def build_prereq_tree(cursor, root_id: str, *, max_depth: int = 99) -> Dict:
    visited: Set[str] = set()

    def expand(course_id: str, depth: int, min_grade: int | None = None) -> Dict:
        if depth >= max_depth or course_id in visited:
            return {"id": course_id, "groups": [], "min_grade": min_grade}
        visited.add(course_id)
        groups = fetch_prereq_groups(cursor, course_id)
        children = []
        for g in groups:
            for item in g["courses"]:
                children.append(expand(item["course_id"], depth + 1, item["min_grade"]))
        return {"id": course_id, "groups": groups, "children": children, "min_grade": min_grade}

    return expand(root_id, 0)


def fetch_course_metrics_map(cursor, ids: Set[str]) -> Dict[str, Dict]:
    if not ids:
        return {}
    # MySQL requires placeholders list of the right length
    placeholders = ",".join(["%s"] * len(ids))
    cursor.execute(
        f"SELECT course_id, liked, easy, useful, rating_num FROM course WHERE course_id IN ({placeholders})",
        tuple(ids),
    )
    out: Dict[str, Dict] = {}
    for row in cursor.fetchall():
        out[row[0]] = {
            "liked": None if row[1] is None else float(row[1]),
            "easy": None if row[2] is None else float(row[2]),
            "useful": None if row[3] is None else float(row[3]),
            "rating_num": None if row[4] is None else int(row[4]),
        }
    return out


def fetch_metrics_medians(cursor) -> Dict[str, float]:
    vals = {"liked": [], "easy": [], "useful": []}
    cursor.execute("SELECT liked, easy, useful FROM course")
    for r in cursor.fetchall():
        if r[0] is not None:
            vals["liked"].append(float(r[0]))
        if r[1] is not None:
            vals["easy"].append(float(r[1]))
        if r[2] is not None:
            vals["useful"].append(float(r[2]))
    def m(arr):
        try:
            return float(median(arr)) if arr else 0.0
        except Exception:
            return 0.0
    return {"liked": m(vals["liked"]), "easy": m(vals["easy"]), "useful": m(vals["useful"]) }


def fetch_metrics_min(cursor) -> Dict[str, float]:
    cursor.execute("SELECT MIN(liked), MIN(easy), MIN(useful) FROM course")
    row = cursor.fetchone() or (None, None, None)
    return {
        "liked": 0.0 if row[0] is None else float(row[0]),
        "easy": 0.0 if row[1] is None else float(row[1]),
        "useful": 0.0 if row[2] is None else float(row[2]),
    }


def build_future_tree(cursor, root_id: str, *, max_depth: int = 2) -> Dict:
    visited: Set[str] = set([root_id])

    def forward(course_id: str, depth: int) -> Dict:
        if depth > max_depth:
            return {"id": course_id}
        cursor.execute(
            "SELECT DISTINCT course_id FROM course_prereq WHERE prereq_course_id = %s",
            (course_id,),
        )
        next_courses = [r[0] for r in cursor.fetchall()]
        children = []
        for nxt in next_courses:
            if nxt in visited:
                continue
            visited.add(nxt)
            children.append(forward(nxt, depth + 1))
        return {"id": course_id, "children": children}

    return forward(root_id, 1)


def check_course_exists(cursor, course_id: str) -> bool:
    """Check if a course ID is present in `course` or `course_prereq` tables."""
    cursor.execute("SELECT 1 FROM course WHERE TRIM(course_id) = %s LIMIT 1", (course_id,))
    if cursor.fetchone():
        return True
    cursor.execute(
        "SELECT 1 FROM course_prereq WHERE TRIM(course_id) = %s OR TRIM(prereq_course_id) = %s LIMIT 1",
        (course_id, course_id),
    )
    if cursor.fetchone():
        return True
    return False


@app.get("/api/course/{course_id}")
def get_course(course_id: str):
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            course = fetch_course(cur, course_id)
            cur.execute(
                "SELECT term FROM offering WHERE course_id = %s ORDER BY term DESC LIMIT 100",
                (course_id,),
            )
            offerings = [{"term": r[0]} for r in cur.fetchall()]
            course["offerings"] = offerings
            return course
    finally:
        conn.close()


@app.get("/api/course/{course_id}/prereqs")
def get_prereqs(course_id: str):
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            groups = fetch_prereq_groups(cur, course_id)
            return {"course_id": course_id, "groups": groups}
    finally:
        conn.close()


@app.get("/api/course/{course_id}/future")
def get_future(course_id: str, depth: int = 2):
    if depth < 0 or depth > 6:
        raise HTTPException(400, detail="depth must be between 0 and 6")
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            tree = build_future_tree(cur, course_id, max_depth=depth)
            return {"course_id": course_id, "tree": tree}
    finally:
        conn.close()


@app.get("/api/course/{course_id}/tree")
def get_course_tree(course_id: str, prereq_depth: int = 99, future_depth: int = 2):
    if future_depth < 0 or future_depth > 6:
        raise HTTPException(400, detail="future_depth must be between 0 and 6")
    if prereq_depth < 1 or prereq_depth > 100:
        raise HTTPException(400, detail="prereq_depth must be between 1 and 100")
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            if not check_course_exists(cur, course_id):
                raise HTTPException(status_code=404, detail=f"Course '{course_id}' not found")
            course = fetch_course(cur, course_id)
            prereq_tree = build_prereq_tree(cur, course_id, max_depth=prereq_depth)
            future_tree = build_future_tree(cur, course_id, max_depth=future_depth)
            # Collect course ids appearing in either tree
            def collect_ids(node, acc: Set[str]):
                if not node:
                    return
                nid = str(node.get("id") or "")
                if nid and not (nid.startswith("and-") or nid.startswith("or-")):
                    acc.add(nid)
                for ch in node.get("children", []) or []:
                    collect_ids(ch, acc)

            all_ids: Set[str] = set()
            collect_ids(prereq_tree, all_ids)
            collect_ids(future_tree, all_ids)
            metrics_map = fetch_course_metrics_map(cur, all_ids)
            metrics_median = fetch_metrics_medians(cur)
            metrics_min = fetch_metrics_min(cur)
            return {
                "course": course,
                "prereq_tree": prereq_tree,
                "future_tree": future_tree,
                "course_metrics": metrics_map,
                "metrics_median": metrics_median,
                "metrics_min": metrics_min,
            }
    finally:
        conn.close()


@app.get("/api/course/{course_id}/prereq_source")
def get_prereq_source(course_id: str):
    """Return the stored raw prerequisite text and parsed JSON for debugging."""
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COALESCE(raw_text, ''), COALESCE(logic_json, '{}') FROM course_prereq_text WHERE course_id = %s",
                (course_id,)
            )
            row = cur.fetchone()
            if not row:
                return {"course_id": course_id, "raw_text": "", "logic_json": {}}
            raw_text = row[0] or ""
            logic_json = row[1] or "{}"
            try:
                import json as _json
                parsed = _json.loads(logic_json)
            except Exception:
                parsed = {}
            return {"course_id": course_id, "raw_text": raw_text, "logic_json": parsed}
    finally:
        conn.close()


@app.get("/api/courses/suggest")
def suggest_courses(q: str = "", limit: int = 20):
    """Suggest course codes and names (prefix + contains on code/name).

    Returns: { items: [{ course_id, course_name }] }
    """
    query = (q or "").strip().upper()
    lim = max(1, min(int(limit or 20), 100))
    if len(query) < 2 and not any(ch.isdigit() for ch in query):
        return {"items": []}

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            pfx = f"{query}%"
            anylike = f"%{query}%"
            # Rank: prefix match on code > contains in code > contains in name
            cur.execute(
                (
                    "SELECT course_id, COALESCE(course_name, ''), "
                    "CASE WHEN UPPER(course_id) LIKE %s THEN 3 "
                    "     WHEN UPPER(course_id) LIKE %s THEN 2 "
                    "     WHEN UPPER(course_name) LIKE %s THEN 1 "
                    "     ELSE 0 END AS rank1, "
                    "LOCATE(%s, UPPER(course_id)) AS pos "
                    "FROM course "
                    "WHERE UPPER(course_id) LIKE %s OR UPPER(course_name) LIKE %s "
                    "ORDER BY rank1 DESC, pos, course_id "
                    "LIMIT %s"
                ),
                (pfx, anylike, anylike, query, anylike, anylike, lim),
            )
            items = [{"course_id": r[0], "course_name": r[1]} for r in cur.fetchall()]
            return {"items": items}
    finally:
        conn.close()


