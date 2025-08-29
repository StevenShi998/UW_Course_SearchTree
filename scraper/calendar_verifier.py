import re
import os
import json
import argparse
import time
from typing import Dict, List, Tuple, Optional, Any

import requests
from bs4 import BeautifulSoup
from requests.exceptions import HTTPError
import mysql.connector
from dotenv import load_dotenv

try:
    from .llm_parser import parse_prereq_with_llm  # type: ignore
except Exception:
    from llm_parser import parse_prereq_with_llm  # type: ignore


CAL_BASE = "https://ucalendar.uwaterloo.ca"


def canonical_code(text: str) -> str:
    if not text:
        return ""
    t = re.sub(r"\s+", "", str(text).upper())
    t = t.replace("-", "")
    return t


def normalize_code_from_text(text: str) -> str:
    if not text:
        return ""
    m = re.search(r"\b([A-Z]{2,5})\s*-?\s*(\d{2,3}[A-Z]?)\b", text)
    return (m.group(1) + m.group(2)).upper() if m else ""


def fetch_calendar_html(year: str, dept: str) -> str:
    url = f"{CAL_BASE}/{year}/COURSE/course-{dept.upper()}.html"
    headers = {
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    resp = requests.get(url, headers=headers, timeout=45)
    resp.raise_for_status()
    return resp.text


def extract_course_blocks(html: str) -> List[Tuple[str, List[str]]]:
    """Return a list of (course_code, cell_texts[]) in appearance order.

    UW Calendar pages for 2324 use a repeated structure:
    <div class="divTable"> ... multiple <div class="divTableCell[ colspan-2]?"> ...
    The first cell (often with <strong>) contains the header with code like "CS 136 ... 0.50".
    Later cells with <em> may include lines starting with "Prereq:".
    """
    soup = BeautifulSoup(html, "html.parser")
    blocks: List[Tuple[str, List[str]]] = []
    for block in soup.find_all("div", class_="divTable"):
        # header cell
        header_cell = block.find("div", class_="divTableCell")
        if not header_cell:
            continue
        header_text = header_cell.get_text(" ", strip=True)
        code = normalize_code_from_text(header_text)
        if not code:
            continue
        # collect all cell texts for this course block
        cell_texts: List[str] = []
        for cell in block.find_all("div", class_=re.compile(r"^divTableCell")):
            t = cell.get_text(" ", strip=True)
            if t:
                cell_texts.append(t)
        blocks.append((code, cell_texts))
    return blocks


def extract_prereq_text_from_paragraphs(paragraphs: List[str]) -> str:
    """Find the paragraph that contains prerequisites and return the text after the label.

    Handles variants like "Prereq:", "Prerequisite(s):", "Prerequisites:", case-insensitive.
    Stops before other headings like Coreq/Antireq/Notes if they appear in the same paragraph.
    """
    label_re = re.compile(r"^(Prereq(?:uisite(?:\(s\))?s?)?)\s*:\s*", re.IGNORECASE)
    stop_re = re.compile(r"\b(coreq|co-?requisite|antireq|anti-?requisite|notes?)\b", re.IGNORECASE)
    for para in paragraphs:
        if re.search(r"\bprereq", para, re.IGNORECASE):
            # Many cells prefix with "Prereq:" and sometimes include Coreq/Antireq after.
            txt = label_re.sub("", para)
            m = stop_re.search(txt)
            if m:
                txt = txt[: m.start()].strip()
            return txt.strip()
    return ""


def parse_calendar_for_dept(year: str, dept: str) -> Dict[str, str]:
    """Return mapping course_code -> raw prereq text (may be empty if none)."""
    html = fetch_calendar_html(year, dept)
    out: Dict[str, str] = {}
    for code, paras in extract_course_blocks(html):
        raw = extract_prereq_text_from_paragraphs(paras)
        out[canonical_code(code)] = raw
    return out


def _split_outside_parens(s: str, sep: str) -> List[str]:
    parts: List[str] = []
    buf: List[str] = []
    depth = 0
    for ch in s:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth = max(0, depth - 1)
        if ch == sep and depth == 0:
            part = ''.join(buf).strip()
            if part:
                parts.append(part)
            buf = []
        else:
            buf.append(ch)
    tail = ''.join(buf).strip()
    if tail:
        parts.append(tail)
    return parts


def _split_outside_parens_word(s: str, word: str) -> List[str]:
    s_lower = s.lower()
    word_lower = word.lower()
    parts: List[str] = []
    buf: List[str] = []
    depth = 0
    i = 0
    n = len(s)
    wlen = len(word_lower)
    while i < n:
        ch = s[i]
        if ch == '(':
            depth += 1
            buf.append(ch)
            i += 1
            continue
        if ch == ')':
            depth = max(0, depth - 1)
            buf.append(ch)
            i += 1
            continue
        if depth == 0 and s_lower.startswith(word_lower, i):
            part = ''.join(buf).strip()
            if part:
                parts.append(part)
            buf = []
            i += wlen
            continue
        buf.append(ch)
        i += 1
    tail = ''.join(buf).strip()
    if tail:
        parts.append(tail)
    return parts


def heuristic_parse_groups(raw_text: str) -> List[List[Dict[str, Optional[int]]]]:
    # Normalize whitespace and trim terminal punctuation
    text = re.sub(r"\s+", " ", (raw_text or "")).strip().rstrip('.')
    if not text:
        return []
    # Split into AND-clauses using semicolons outside parentheses; fallback to commas; then ' and '
    groups_text = _split_outside_parens(text, ';')
    if len(groups_text) <= 1:
        groups_text = _split_outside_parens(text, ',')
    if len(groups_text) <= 1:
        groups_text = _split_outside_parens_word(text, ' and ')
    code_iter_re = re.compile(r"\b([A-Z]{2,5})\s*-?\s*(\d{2,3}[A-Z]?)\b")
    grade_nearby_re = re.compile(r"with (?:a )?grade of at least\s*(\d{1,3})\s*%|with at least\s*(\d{1,3})\s*%", re.IGNORECASE)
    groups: List[List[Dict[str, Optional[int]]]] = []
    for clause in groups_text:
        seen_codes: set[str] = set()
        items: List[Dict[str, Optional[int]]] = []
        for m in code_iter_re.finditer(clause):
            code = (m.group(1) + m.group(2)).upper()
            if code in seen_codes:
                continue
            lookahead = clause[m.end(): m.end() + 90]
            g = grade_nearby_re.search(lookahead)
            mg: Optional[int] = None
            if g:
                for gi in (1, 2):
                    if g.group(gi):
                        try:
                            mg = int(g.group(gi))
                        except Exception:
                            mg = None
                        break
            items.append({"code": canonical_code(code), "min_grade": mg})
            seen_codes.add(code)
        if items:
            groups.append(items)
    return groups


def get_db_connection():
    load_dotenv()
    host = os.getenv("DB_HOST")
    port = int(os.getenv("DB_PORT", "3306"))
    user = os.getenv("DB_USER")
    password = os.getenv("DB_PASSWORD")
    database = os.getenv("DB_NAME")
    return mysql.connector.connect(host=host, port=port, user=user, password=password, database=database, autocommit=True)


def fetch_known_codes_from_db(cur) -> List[str]:
    cur.execute("SELECT course_id FROM course")
    return [canonical_code(r[0]) for r in cur.fetchall() if r and r[0]]


def fetch_db_groups(cur, course_id: str) -> List[List[Dict[str, Optional[int]]]]:
    cur.execute(
        """
        SELECT prerequisite_group, prereq_course_id, min_grade
        FROM course_prereq
        WHERE course_id = %s
        ORDER BY prerequisite_group, prereq_course_id
        """,
        (course_id,),
    )
    groups: Dict[int, List[Dict[str, Optional[int]]]] = {}
    for grp, pid, mg in cur.fetchall():
        groups.setdefault(int(grp), []).append({"code": canonical_code(pid), "min_grade": (int(mg) if mg is not None else None)})
    return [groups[k] for k in sorted(groups.keys())]


def groups_equal(a: List[List[Dict[str, Optional[int]]]], b: List[List[Dict[str, Optional[int]]]]) -> bool:
    def norm(g: List[List[Dict[str, Optional[int]]]]):
        return [sorted([(x["code"], x.get("min_grade")) for x in clause]) for clause in g]
    na = sorted(norm(a))
    nb = sorted(norm(b))
    return na == nb


def replace_db_groups(cur, course_id: str, groups: List[List[Dict[str, Optional[int]]]]):
    # Build desired set with stricter min_grade kept per (course_id, prereq, group)
    desired: Dict[Tuple[str, str, int], Optional[int]] = {}
    for gidx, clause in enumerate(groups, start=1):
        for item in clause:
            code = canonical_code(item.get("code"))
            if not code or code == course_id:
                continue
            key = (course_id, code, int(gidx))
            mg = item.get("min_grade")
            try:
                mgv: Optional[int] = int(mg) if mg is not None else None
            except Exception:
                mgv = None
            if key not in desired or (mgv is not None and (desired[key] is None or mgv > desired[key])):
                desired[key] = mgv

    # Fetch current rows for this course
    cur.execute(
        "SELECT prereq_course_id, prerequisite_group, min_grade FROM course_prereq WHERE course_id = %s",
        (course_id,),
    )
    current: Dict[Tuple[str, int], Optional[int]] = {}
    for pid, grp, mg in cur.fetchall():
        current[(canonical_code(pid), int(grp))] = int(mg) if mg is not None else None

    # Compute deletes (present in current but not in desired) and upserts
    desired_keys = {(k[1], k[2]) for k in desired.keys()}
    current_keys = set(current.keys())
    to_delete = list(current_keys - desired_keys)
    to_upsert = [(k[0], k[1], desired[(course_id, k[0], k[1])]) for k in sorted(desired_keys)]

    # Ensure prereq courses exist
    _ensure_courses_exist(cur, [pid for (pid, _grp, _mg) in to_upsert])

    # Delete only necessary rows (one-by-one with retries)
    for pid, grp in to_delete:
        for attempt in range(5):
            try:
                cur.execute(
                    "DELETE FROM course_prereq WHERE course_id=%s AND prereq_course_id=%s AND prerequisite_group=%s",
                    (course_id, pid, grp),
                )
                break
            except Exception as e:
                if attempt == 4 or not any(code in str(e) for code in ["1213", "1205"]):
                    raise
                time.sleep(0.25 * (attempt + 1))

    # Upsert desired rows
    for pid, grp, mg in to_upsert:
        for attempt in range(5):
            try:
                cur.execute(
                    "INSERT INTO course_prereq (course_id, prereq_course_id, prerequisite_group, min_grade) VALUES (%s,%s,%s,%s) "
                    "ON DUPLICATE KEY UPDATE min_grade=VALUES(min_grade)",
                    (course_id, pid, grp, mg),
                )
                break
            except Exception as e:
                if attempt == 4 or not any(code in str(e) for code in ["1213", "1205"]):
                    raise
                time.sleep(0.25 * (attempt + 1))


def upsert_prereq_text(cur, course_id: str, raw_text: str, logic: Dict[str, Any]):
    try:
        cur.execute(
            """
            INSERT INTO course_prereq_text (course_id, source, raw_text, logic_json)
            VALUES (%s, 'uw_calendar', %s, %s)
            ON DUPLICATE KEY UPDATE source=VALUES(source), raw_text=VALUES(raw_text), logic_json=VALUES(logic_json), parsed_at=CURRENT_TIMESTAMP
            """,
            (course_id, raw_text, json.dumps(logic, ensure_ascii=False)),
        )
    except Exception:
        # Table may not exist in some schemas; ignore
        pass


def _ensure_courses_exist(cur, codes: List[str]) -> None:
    if not codes:
        return
    uniq = sorted({canonical_code(c) for c in codes if c})
    if not uniq:
        return
    fmt = ",".join(["%s"] * len(uniq))
    cur.execute(f"SELECT course_id FROM course WHERE course_id IN ({fmt})", tuple(uniq))
    have = {canonical_code(r[0]) for r in cur.fetchall()}
    missing = [c for c in uniq if c not in have]
    if missing:
        cur.executemany("INSERT IGNORE INTO course (course_id) VALUES (%s)", [(m,) for m in missing])


def verify_department(dept: str, *, year: str = "2324", apply: bool = False, model: str = "sonar-pro", confidence_threshold: float = 0.75, only_course: Optional[str] = None, log_path: str = "calendar_verify.ndjson") -> Dict[str, int]:
    stats = {"checked": 0, "updated": 0, "skipped_low_conf": 0, "no_change": 0, "missing_prereq_text": 0, "skipped_locked": 0}
    cal_map = parse_calendar_for_dept(year, dept)
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            # Reduce lock waits to fail fast and retry
            try:
                cur.execute("SET SESSION innodb_lock_wait_timeout = 3")
            except Exception:
                pass
            known_codes = set(fetch_known_codes_from_db(cur))
            for code, raw in cal_map.items():
                if only_course and canonical_code(only_course) != code:
                    continue
                stats["checked"] += 1
                # Skip if no prereq text found
                if not raw:
                    stats["missing_prereq_text"] += 1
                    _log(log_path, {
                        "course_id": code,
                        "dept": dept.upper(),
                        "issue": "no_prereq_text",
                        "raw": "",
                    })
                    continue
                # LLM parse into CNF groups
                groups_new: List[List[Dict[str, Optional[int]]]] = []
                conf: float = 0.0
                constraints: List[str] = []
                llm_ok = False
                try:
                    llm = parse_prereq_with_llm(raw, sorted(list(known_codes)), model=model)
                    groups_new = llm.get("groups") or []
                    conf = float(llm.get("confidence") or 0.0)
                    constraints = llm.get("constraints") or []
                    llm_ok = True
                except Exception as e:
                    llm_ok = False
                # Heuristic fallback when LLM unavailable or weak
                if not groups_new or conf < 0.1:
                    heur = heuristic_parse_groups(raw)
                    if heur:
                        groups_new = heur
                        # Assign moderate confidence to allow update when structure is clear
                        conf = max(conf, 0.82)

                # Fetch current groups from DB
                current = fetch_db_groups(cur, code)

                # Decide action
                if not groups_new:
                    _log(log_path, {
                        "course_id": code,
                        "dept": dept.upper(),
                        "issue": "empty_groups",
                        "confidence": conf,
                        "raw": raw[:500],
                        "constraints": constraints,
                    })
                    stats["skipped_low_conf"] += 1
                    continue

                if groups_equal(groups_new, current):
                    stats["no_change"] += 1
                    # Still store the latest parsed text for audit
                    try:
                        upsert_prereq_text(cur, code, raw, {"groups": groups_new, "constraints": constraints, "confidence": conf})
                    except Exception:
                        pass
                    continue

                if conf < confidence_threshold:
                    _log(log_path, {
                        "course_id": code,
                        "dept": dept.upper(),
                        "issue": "mismatch_low_conf",
                        "confidence": conf,
                        "raw": raw[:500],
                        "current_groups": current,
                        "new_groups": groups_new,
                        "constraints": constraints,
                    })
                    stats["skipped_low_conf"] += 1
                    continue

                # High-confidence update
                if apply:
                    try:
                        replace_db_groups(cur, code, groups_new)
                        upsert_prereq_text(cur, code, raw, {"groups": groups_new, "constraints": constraints, "confidence": conf})
                    except Exception as e:
                        # If we repeatedly hit locks/deadlocks on this course, log and continue
                        if any(code in str(e) for code in ["1213", "1205"]):
                            _log(log_path, {
                                "course_id": code,
                                "dept": dept.upper(),
                                "issue": "skipped_locked",
                                "confidence": conf,
                                "raw": raw[:500],
                                "error": str(e)[:200],
                                "current_groups": fetch_db_groups(cur, code),
                                "new_groups": groups_new,
                                "constraints": constraints,
                            })
                            stats["skipped_locked"] += 1
                            continue
                        raise
                _log(log_path, {
                    "course_id": code,
                    "dept": dept.upper(),
                    "issue": "updated" if apply else "would_update",
                    "confidence": conf,
                    "raw": raw[:500],
                    "current_groups": current,
                    "new_groups": groups_new,
                    "constraints": constraints,
                })
                stats["updated"] += 1
    finally:
        conn.close()
    return stats


def _log(path: str, obj: Dict[str, Any]) -> None:
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser(description="Verify and update course_prereq from UW Calendar using LLM")
    parser.add_argument("--dept", type=str, default="CS", help="Department code, e.g., CS, MATH, STAT")
    parser.add_argument("--year", type=str, default="2324", help="Calendar year path segment, e.g., 2324")
    parser.add_argument("--apply", action="store_true", help="Apply updates to the database (otherwise dry-run)")
    parser.add_argument("--only-course", type=str, default="", help="Limit to a single course code, e.g., CS135")
    parser.add_argument("--llm-model", type=str, default="sonar-pro", help="Perplexity model: sonar-small or sonar-pro")
    parser.add_argument("--confidence-threshold", type=float, default=0.75, help="Min confidence required to update")
    parser.add_argument("--log", type=str, default="calendar_verify.ndjson", help="Path to NDJSON log file")
    parser.add_argument("--all-from-db", action="store_true", help="Process all distinct departments found in the DB")
    args = parser.parse_args()

    if args.all_from_db:
        # Collect distinct departments from DB and process each if a calendar page exists
        conn = get_db_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT DISTINCT department FROM course WHERE department IS NOT NULL AND department <> '' ORDER BY department")
                depts = [str(r[0]).upper() for r in cur.fetchall() if r and r[0]]
        finally:
            conn.close()
        summary: Dict[str, Dict[str, int]] = {}
        for d in depts:
            try:
                # probe: skip quickly if page 404s
                try:
                    _ = fetch_calendar_html(args.year, d)
                except HTTPError as he:
                    # skip departments without a calendar page
                    if getattr(he, 'response', None) is not None and he.response is not None and he.response.status_code == 404:
                        continue
                    # other HTTP errors propagate
                stats_d = verify_department(
                    d,
                    year=args.year,
                    apply=args.apply,
                    model=args.llm_model,
                    confidence_threshold=args.confidence_threshold,
                    only_course=None,
                    log_path=args.log,
                )
                summary[d] = stats_d
            except Exception:
                # continue on any department error
                continue
        print(json.dumps({"all_from_db": True, "year": args.year, "departments": len(summary), "stats": summary}, indent=2))
        return
    else:
        stats = verify_department(
            args.dept,
            year=args.year,
            apply=args.apply,
            model=args.llm_model,
            confidence_threshold=args.confidence_threshold,
            only_course=(args.only_course or None),
            log_path=args.log,
        )
        print(json.dumps({"dept": args.dept.upper(), **stats}, indent=2))


if __name__ == "__main__":
    main()


