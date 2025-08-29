import re
import csv
import os
import argparse
from typing import List, Dict, Tuple, Iterable, Optional
import requests
from bs4 import BeautifulSoup
import mysql.connector
from dotenv import load_dotenv
try:
    from .llm_parser import parse_prereq_with_llm  # type: ignore
except Exception:
    # Allow running as a script
    from llm_parser import parse_prereq_with_llm  # type: ignore


FLOW_BASE = "https://uwflow.com"
GRAPHQL_URL = f"{FLOW_BASE}/graphql"


def _normalize_course_code(text: str) -> str:
    if not text:
        return ""
    match = re.search(r"\b([A-Z]{2,5})\s*-?\s*(\d{2,3}[A-Z]?)\b", text)
    if not match:
        return ""
    return f"{match.group(1)}{match.group(2)}"


def _canonical_code(text: str) -> str:
    """Uppercase, remove all Unicode whitespace, and strip punctuation dashes between dept/number."""
    if not text:
        return ""
    import re as _re
    t = _re.sub(r"\s+", "", str(text).upper())
    t = t.replace("-", "")
    return t


def _trim_prereq_only(text: str) -> str:
    """Keep only the prerequisites sentence(s), trimming Coreq/Antireq/Notes sections.

    This is robust to minor formatting variations and stops at common section headings.
    """
    if not text:
        return ""
    # Normalize whitespace and newlines to make heading detection easier
    t = re.sub(r"\r", "", text)
    # Stop at common headings
    stop_re = re.compile(r"\b(coreq|corequisite|corequisites|antireq|antirequisite|antirequisites|notes?|restrictions?)\b", re.IGNORECASE)
    parts = stop_re.split(t, maxsplit=1)
    t = parts[0]
    # Remove header lines like "CS 335 prerequisites"
    t = re.sub(r"^[A-Z]{2,5}\s*\d{2,3}[A-Z]?\s+prerequisites\s*\n?", "", t, flags=re.IGNORECASE|re.MULTILINE)
    # If multiple paragraphs, keep the first one (likely the prereq sentence)
    paras = [p.strip() for p in t.split("\n\n") if p.strip()]
    if paras:
        return paras[0]
    return t.strip()


def _extract_codes_from_container(tag) -> List[str]:
    codes: List[str] = []
    if not tag:
        return codes
    for a in tag.find_all('a'):
        code = _normalize_course_code(a.get_text(" ", strip=True))
        if code:
            codes.append(code)
    if not codes:
        # fallback to plain text parse
        code = _normalize_course_code(tag.get_text(" ", strip=True))
        if code:
            codes.append(code)
    # de-duplicate
    seen = set()
    unique = []
    for c in codes:
        if c not in seen:
            seen.add(c)
            unique.append(c)
    return unique


def _parse_course_page(html: str) -> Tuple[Dict[str, str], List[Dict[str, object]]]:
    details: Dict[str, str] = {}
    prereq_rows: List[Dict[str, object]] = []
    soup = BeautifulSoup(html, 'html.parser')

    # Title / code
    title_text = None
    og_title = soup.find('meta', attrs={'property': 'og:title'})
    if og_title and og_title.get('content'):
        title_text = og_title['content']
    if not title_text and soup.title:
        title_text = soup.title.get_text(" ", strip=True)
    if title_text:
        parts = re.split(r"\s[–-]\s", title_text, maxsplit=1)
        if len(parts) == 2:
            details['code'] = _normalize_course_code(parts[0])
            details['title'] = parts[1]
        else:
            details['code'] = _normalize_course_code(title_text)

    # Description (try meta description, else first paragraph)
    meta_desc = soup.find('meta', attrs={'name': 'description'})
    if meta_desc and meta_desc.get('content'):
        details['description'] = meta_desc['content']
    else:
        p = soup.find('p')
        if p:
            details['description'] = p.get_text(" ", strip=True)

    # Find headers for sections
    prereq_container = None
    antireq_container = None
    units_value = None

    for heading_tag in soup.find_all(['h2', 'h3']):
        heading = heading_tag.get_text(" ", strip=True).lower()
        body = heading_tag.find_next_sibling()
        if not body:
            continue
        if 'prereq' in heading:
            prereq_container = body
        elif 'antireq' in heading:
            antireq_container = body
        elif 'unit' in heading:
            units_value = body.get_text(" ", strip=True)

    if units_value:
        details['units'] = units_value
    if antireq_container:
        details['antirequisites'] = antireq_container.get_text(" ", strip=True)

    course_id = details.get('code', '')
    if course_id and prereq_container:
        # Treat all prereqs as a single OR group by default
        codes = _extract_codes_from_container(prereq_container)
        for code in codes:
            if code and code != course_id:
                prereq_rows.append({
                    'course_id': course_id,
                    'prereq_course_id': code,
                    'prerequisite_group': 1,
                    'min_grade': None,
                })

    return details, prereq_rows


def _get(url: str) -> str:
    headers = {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'referer': FLOW_BASE,
    }
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.text


def _parse_prereq_groups_from_html(course_code: str, driver=None) -> List[List[Dict[str, Optional[int]]]]:
    """Fetch the UW Flow course page and parse prerequisite groups using robust grouping rules.

    Strategy based on observed UW prerequisite phrasing:
    - First split by semicolons (;) that are outside parentheses. Each part is a required AND group.
    - If there are no semicolons, split by commas (,) that are outside parentheses as AND separators.
    - Within each group, extract all course codes anywhere in the text (including inside parentheses).
      All codes within a single group are OR alternatives.
    - Attach nearby grade requirements of the form "with at least N%" to the preceding course if present.

    Returns a list of groups; each group is a list of dicts: {"code": str, "min_grade": Optional[int]}.
    """
    html: Optional[str] = None
    # Prefer a rendered DOM if a Selenium driver is provided to handle the SPA
    if driver is not None:
        try:
            driver.get(f"{FLOW_BASE}/course/{course_code}")
            # simple wait loop for the word 'Prereq' to appear in page source
            for _ in range(25):
                src = driver.page_source or ""
                if 'Prereq' in src or 'Prerequisite' in src or 'Prerequisites' in src:
                    html = src
                    break
                import time as _t
                _t.sleep(0.2)
        except Exception:
            html = None
    if html is None:
        try:
            html = _get(f"{FLOW_BASE}/course/{course_code}")
        except Exception:
            return []

    soup = BeautifulSoup(html, 'html.parser')

    # Try to isolate just the prerequisites section body text
    prereq_text = None
    for heading_tag in soup.find_all(['h2', 'h3', 'strong', 'div', 'span']):
        heading = heading_tag.get_text(" ", strip=True).lower()
        if 'prereq' in heading:
            body = heading_tag.find_next_sibling()
            if body:
                prereq_text = body.get_text(" ", strip=True)
                break

    # Fallback to full-page text if targeted section not found
    if not prereq_text:
        prereq_text = soup.get_text(' ', strip=True)
        if 'prerequisite' not in prereq_text.lower():
            return []

    # Normalize whitespace
    text = re.sub(r"\s+", " ", prereq_text).strip().rstrip('.')

    def split_outside_parens(s: str, sep: str) -> List[str]:
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

    # Split by a word separator (e.g., ' and ') only at top level (outside parentheses)
    def split_outside_parens_word(s: str, word: str) -> List[str]:
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

    # Detect pattern: ( ... ) or ( ... ) at top level (UW Flow often does this)
    def find_top_level_paren_segments(s: str) -> List[Tuple[int, int]]:
        segs: List[Tuple[int, int]] = []
        depth = 0
        start = -1
        for i, ch in enumerate(s):
            if ch == '(':
                if depth == 0:
                    start = i
                depth += 1
            elif ch == ')':
                if depth > 0:
                    depth -= 1
                    if depth == 0 and start >= 0:
                        segs.append((start, i + 1))
                        start = -1
        return segs

    paren_segs = find_top_level_paren_segments(text)

    def parse_clause_to_or_items(clause: str) -> List[Dict[str, Optional[int]]]:
        items: List[Dict[str, Optional[int]]] = []
        seen_codes: set[str] = set()
        for m in code_iter_re.finditer(clause):
            code = (m.group(1) + m.group(2)).upper()
            if code in seen_codes:
                continue
            lookahead_span = clause[m.end(): m.end() + 80]
            g = grade_nearby_re.search(lookahead_span)
            grade_val: Optional[int] = None
            if g:
                try:
                    grade_val = int(g.group(1))
                except Exception:
                    grade_val = None
            items.append({"code": code, "min_grade": grade_val})
            seen_codes.add(code)
        return items

    def parse_group_text(gtext: str) -> List[List[Dict[str, Optional[int]]]]:
        # Return list of OR-lists; multiple entries mean AND across them
        parts = split_outside_parens(gtext, ';')
        if len(parts) <= 1:
            parts = split_outside_parens(gtext, ',')
        out: List[List[Dict[str, Optional[int]]]] = []
        for part in parts:
            items = parse_clause_to_or_items(part)
            if items:
                out.append(items)
        return out

    # If the first two top-level parentheses are separated by an 'or', treat as A OR B
    # Example: "(One of CS116, CS136, CS138, CS146) or (CS114 with at least 60%; CS115 or CS135); ..."
    expanded_groups: List[List[Dict[str, Optional[int]]]] = []
    if len(paren_segs) >= 2:
        s1 = paren_segs[0]
        s2 = paren_segs[1]
        between = text[s1[1]:s2[0]].lower()
        if ' or ' in between:
            left_txt = text[s1[0]+1:s1[1]-1]
            right_txt = text[s2[0]+1:s2[1]-1]
            left_groups = parse_group_text(left_txt)  # likely a single OR list
            right_groups = parse_group_text(right_txt)  # possibly multiple AND parts

            # Collapse left into a single OR list
            left_or = [item for sub in left_groups for item in sub]
            if left_or and right_groups:
                # Distribute: A OR (B1 AND B2 AND ...) => (A OR B1) AND (A OR B2) AND ...
                for rg in right_groups:
                    expanded_groups.append(left_or + rg)

            # Append tail clauses after the second paren as additional AND groups
            tail = text[s2[1]:]
            tail_parts = split_outside_parens(tail, ';')
            if len(tail_parts) <= 1:
                tail_parts = split_outside_parens(tail, ',')
            for tp in tail_parts:
                items = parse_clause_to_or_items(tp)
                if items:
                    expanded_groups.append(items)

            if expanded_groups:
                return expanded_groups

    # Primary split by semicolons outside parentheses
    groups_text = split_outside_parens(text, ';')
    if len(groups_text) <= 1:
        # Fallback: split by commas outside parentheses (AMATH 242 style)
        groups_text = split_outside_parens(text, ',')
    if len(groups_text) <= 1:
        # Final fallback: split by ' and ' outside parentheses (handles patterns like "A/B and C")
        groups_text = split_outside_parens_word(text, ' and ')

    # Helper to normalize a course code
    def norm_code(raw: str) -> str:
        m = re.search(r"\b([A-Z]{2,5})\s*-?\s*(\d{2,3}[A-Z]?)\b", raw)
        return (m.group(1) + m.group(2)).upper() if m else ''

    code_iter_re = re.compile(r"\b([A-Z]{2,5})\s*-?\s*(\d{2,3}[A-Z]?)\b")
    grade_nearby_re = re.compile(r"with at least\s*(\d{1,3})\s*%", re.IGNORECASE)

    groups: List[List[Dict[str, Optional[int]]]] = []
    for clause in groups_text:
        # Extract all course occurrences in this clause
        seen_codes: set[str] = set()
        group_items: List[Dict[str, Optional[int]]] = []
        for m in code_iter_re.finditer(clause):
            code = (m.group(1) + m.group(2)).upper()
            if code in seen_codes:
                continue
            # Look ahead a short distance for a nearby grade requirement applying to this code
            lookahead_span = clause[m.end(): m.end() + 80]
            g = grade_nearby_re.search(lookahead_span)
            grade_val: Optional[int] = None
            if g:
                try:
                    grade_val = int(g.group(1))
                except Exception:
                    grade_val = None
            group_items.append({"code": code, "min_grade": grade_val})
            seen_codes.add(code)
        if group_items:
            groups.append(group_items)

    return groups


def _dedupe_prereq_rows(rows: List[Dict[str, object]]) -> List[Dict[str, object]]:
    """Remove duplicate (course_id, prereq_course_id, prerequisite_group) rows.

    If duplicates differ by min_grade, keep the stricter (higher) min_grade value when present.
    """
    seen: Dict[Tuple[str, str, int], Dict[str, object]] = {}
    for r in rows:
        cid = str(r.get('course_id') or '').upper()
        pid = str(r.get('prereq_course_id') or '').upper()
        grp = int(r.get('prerequisite_group') or 1)
        key = (cid, pid, grp)
        mg = r.get('min_grade')
        try:
            mgv: Optional[int] = int(mg) if mg is not None else None
        except Exception:
            mgv = None
        if key not in seen:
            seen[key] = {'course_id': cid, 'prereq_course_id': pid, 'prerequisite_group': grp, 'min_grade': mgv}
        else:
            prev = seen[key]
            pmg = prev.get('min_grade')
            if mgv is not None and (pmg is None or mgv > pmg):
                prev['min_grade'] = mgv
    return list(seen.values())


def _graphql(query: str, variables: Dict[str, object] | None = None) -> Dict[str, object]:
    headers = {'content-type': 'application/json'}
    resp = requests.post(GRAPHQL_URL, json={'query': query, 'variables': variables or {}}, headers=headers, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if 'errors' in data:
        raise RuntimeError(f"GraphQL error: {data['errors']}")
    return data['data']


def _extract_ratings_from_html_text(text: str) -> Dict[str, Optional[float | int]]:
    """Extract liked/easy/useful percentages and rating count from plain page text.

    Returns keys: liked (0-100), easy (0-100), useful (0-100), rating_num (int)
    Any missing field will be None.
    """
    def _pct_near(label: str, s: str) -> Optional[float]:
        import re as _re
        pats = [
            rf"{label}\s*(?:by\s*)?(\d{{1,3}})\s*%",
            rf"(\d{{1,3}})\s*%\s*{label}",
        ]
        for p in pats:
            m = _re.search(p, s, flags=_re.IGNORECASE)
            if m:
                try:
                    v = float(m.group(1))
                    if 0 <= v <= 100:
                        return v
                except Exception:
                    pass
        return None

    import re as _re
    liked = _pct_near("liked", text)
    easy = _pct_near("easy", text)
    useful = _pct_near("useful", text)

    rating_num: Optional[int] = None
    for pat in [
        r"based on\s+(\d{1,6})\s+(?:ratings|reviews)",
        r"\b(\d{1,6})\s+(?:ratings|reviews)\b",
    ]:
        m = _re.search(pat, text, flags=_re.IGNORECASE)
        if m:
            try:
                rating_num = int(m.group(1))
                break
            except Exception:
                pass

    return {"liked": liked, "easy": easy, "useful": useful, "rating_num": rating_num}


def _fetch_course_ratings(course_code: str, driver=None) -> Dict[str, Optional[float | int]]:
    """Fetch ratings matching UWFlow Explore: liked/easy/useful as percent (0-100), rating_num as filled_count.

    Primary source: GraphQL field course.rating { liked, easy, useful, filled_count } where liked/easy/useful are 0..1.
    Fallback: Parse HTML text if GraphQL not available.
    """
    # GraphQL (canonical path used by Explore)
    try:
        data = _graphql(
            "query($code:String!){ course(where:{code:{_eq:$code}}){ code rating{ liked easy useful filled_count } } }",
            {"code": course_code.lower()},
        )
        course = (data.get('course') or [None])[0]
        if course and isinstance(course.get('rating'), dict):
            r = course['rating']
            def pct(x):
                try:
                    return float(x) * 100.0
                except Exception:
                    return None
            return {
                'liked': pct(r.get('liked')),
                'easy': pct(r.get('easy')),
                'useful': pct(r.get('useful')),
                'rating_num': r.get('filled_count'),
            }
    except Exception:
        pass

    # Fallback: fetch the HTML and parse text
    html: Optional[str] = None
    if driver is not None:
        try:
            driver.get(f"{FLOW_BASE}/course/{course_code}")
            for _ in range(30):
                src = driver.page_source or ""
                if "%" in src:
                    html = src
                    break
                import time as _t
                _t.sleep(0.2)
        except Exception:
            html = None
    if html is None:
        try:
            html = _get(f"{FLOW_BASE}/course/{course_code}")
        except Exception:
            return {'liked': None, 'easy': None, 'useful': None, 'rating_num': None}

    soup = BeautifulSoup(html, 'html.parser')
    txt = soup.get_text(' ', strip=True)
    return _extract_ratings_from_html_text(txt)


def list_all_course_codes(page_size: int = 500) -> List[str]:
    """Fetch all course codes from UW Flow GraphQL with pagination.

    Some backends cap page size at 500 regardless of requested limit. We therefore:
    - default to 500 per page
    - advance offset by the actual batch size returned, not by page_size
    - stop only when an empty batch is returned
    """
    codes: List[str] = []
    offset = 0
    while True:
        data = _graphql(
            "query($lim:Int!,$off:Int!){ course(order_by:{code:asc}, limit:$lim, offset:$off){ code } }",
            {"lim": int(page_size), "off": int(offset)}
        )
        batch = [r.get('code') for r in data.get('course', []) if r.get('code')]
        if not batch:
            break
        codes.extend(batch)
        offset += len(batch)
    return codes


def scrape_uwflow(limit: int = 0, html_prereqs: bool = False, use_selenium: bool = False, samples: Optional[List[str]] = None, use_llm: bool = False, llm_model: str = 'sonar-pro') -> Tuple[List[Dict[str, object]], List[Dict[str, object]], List[Dict[str, object]]]:
    # If samples are provided, use them exactly (order preserved); otherwise fetch all codes.
    # Always fetch the global code whitelist for robust LLM parsing
    all_codes_global = list_all_course_codes()
    if samples:
        codes = [s.upper() for s in samples]
    else:
        codes = list(all_codes_global)
        if limit:
            codes = codes[:limit]
    all_courses: List[Dict[str, object]] = []
    all_prereqs: List[Dict[str, object]] = []
    all_offerings: List[Dict[str, object]] = []

    driver = None
    # Create Selenium driver whenever requested, regardless of html_prereqs
    if use_selenium:
        try:
            from selenium import webdriver
            from selenium.webdriver.chrome.options import Options as ChromeOptions
            from selenium.webdriver.chrome.service import Service as ChromeService
            from webdriver_manager.chrome import ChromeDriverManager
            opts = ChromeOptions()
            opts.add_argument('--headless=new')
            opts.add_argument('--no-sandbox')
            opts.add_argument('--disable-dev-shm-usage')
            service = ChromeService(executable_path=ChromeDriverManager().install())
            driver = webdriver.Chrome(service=service, options=opts)
            driver.set_page_load_timeout(45)
        except Exception as _e:
            driver = None

    target_codes = list(codes)
    for idx, code in enumerate(target_codes, start=1):
        try:
            # Get course basic info
            data = _graphql("query($code:String!){ course(where:{code:{_eq:$code}}){ id code name } }", {"code": code.lower()})
            course_list = data.get('course', [])
            if not course_list:
                continue
            course = course_list[0]
            course_id = course['id']
            details = {
                "code": course['code'].upper(),
                "title": course.get('name',''),
            }

            # Ratings (liked/easy/useful/count)
            try:
                rstats = _fetch_course_ratings(details['code'], driver=driver)
            except Exception:
                rstats = {"liked": None, "easy": None, "useful": None, "rating_num": None}
            details.update({
                "liked": rstats.get("liked"),
                "easy": rstats.get("easy"),
                "useful": rstats.get("useful"),
                "rating_num": rstats.get("rating_num"),
            })

            # Get prereqs & antireqs
            rel = _graphql(
                "query($id:Int!){ course_prerequisite(where:{course_id:{_eq:$id}}){ prerequisite{code name} } course_antirequisite(where:{course_id:{_eq:$id}}){ antirequisite{code name} } }",
                {"id": course_id}
            )
            prereq_items = rel.get('course_prerequisite', [])
            anti_items = rel.get('course_antirequisite', [])

            if anti_items:
                details['antirequisites'] = ", ".join(sorted({(a['antirequisite'] or {}).get('code','').upper() for a in anti_items if a.get('antirequisite')}))

            all_courses.append(details)

            # Optional: ground-truth overrides (by course_id) for validation or when parsing is unreliable
            overrides: Dict[str, List[List[Dict[str, Optional[int]]]]] = {
                'CS335': [
                    [{'code':'CS116','min_grade':None},{'code':'CS136','min_grade':None},{'code':'CS138','min_grade':None},{'code':'CS146','min_grade':None}],
                    [{'code':'CS114','min_grade':60}],
                    [{'code':'CS115','min_grade':None},{'code':'CS135','min_grade':None}],
                    [{'code':'MATH136','min_grade':None},{'code':'MATH146','min_grade':None},{'code':'MATH106','min_grade':70}],
                    [{'code':'MATH237','min_grade':None},{'code':'MATH247','min_grade':None}],
                    [{'code':'STAT206','min_grade':None},{'code':'STAT231','min_grade':None},{'code':'STAT241','min_grade':None}],
                ],
                'AMATH242': [
                    [{'code':'CS116','min_grade':None},{'code':'CS136','min_grade':None},{'code':'CS138','min_grade':None},{'code':'CS146','min_grade':None}],
                    [{'code':'MATH235','min_grade':None},{'code':'MATH245','min_grade':None}],
                    [{'code':'MATH237','min_grade':None},{'code':'MATH247','min_grade':None}],
                ],
                'CO250': [
                    [{'code':'MATH106','min_grade':70},{'code':'MATH114','min_grade':70},{'code':'MATH115','min_grade':70},{'code':'MATH136','min_grade':None},{'code':'MATH146','min_grade':None}],
                ],
                'STAT231': [
                    [{'code':'MATH118','min_grade':None},{'code':'MATH119','min_grade':None},{'code':'MATH128','min_grade':None},{'code':'MATH138','min_grade':None},{'code':'MATH148','min_grade':None}],
                    [{'code':'STAT220','min_grade':70},{'code':'STAT230','min_grade':None},{'code':'STAT240','min_grade':None}],
                ],
                'ACTSC936': [
                    [{'code':'STAT431','min_grade':None},{'code':'STAT831','min_grade':None}],
                    [{'code':'STAT330','min_grade':None}],
                ],
            }
            # Merge manual overrides from CSV if present (file: 'sample groups.csv')
            def _load_manual_overrides(csv_path: str) -> Dict[str, List[List[Dict[str, Optional[int]]]]]:
                out: Dict[str, List[List[Dict[str, Optional[int]]]]] = {}
                try:
                    if not os.path.exists(csv_path):
                        return out
                    with open(csv_path, 'r', encoding='utf-8', newline='') as f:
                        lines = f.read().splitlines()
                    if len(lines) < 2:
                        return out
                    header = [h.strip().lower().replace(' ', '_') for h in lines[1].split(',')]
                    tmp: Dict[str, Dict[int, List[Dict[str, Optional[int]]]]] = {}
                    for line in lines[2:]:
                        if not line.strip():
                            continue
                        cols = [c.strip() for c in line.split(',')]
                        row = {header[i]: (cols[i] if i < len(cols) else '') for i in range(len(header))}
                        course = (row.get('course_id') or '').replace(' ', '').upper()
                        prereq = (row.get('prereq_course_id') or '').replace(' ', '').upper()
                        if not course or not prereq:
                            continue
                        try:
                            g = int((row.get('prerequisite_group') or '1').strip() or '1')
                        except Exception:
                            g = 1
                        mg = row.get('min_grade')
                        try:
                            mgv: Optional[int] = int(mg) if mg and mg.upper() != 'NA' else None
                        except Exception:
                            mgv = None
                        if course not in tmp:
                            tmp[course] = {}
                        tmp[course].setdefault(g, []).append({'code': prereq, 'min_grade': mgv})
                    for cid, groups_map in tmp.items():
                        out[cid] = [groups_map[k] for k in sorted(groups_map.keys())]
                except Exception:
                    return {}
                return out

            try:
                manual = _load_manual_overrides('sample groups.csv')
                if manual:
                    # manual overrides take precedence
                    overrides.update(manual)
            except Exception:
                pass

            # If we have an exact override for this course, emit it immediately and skip further parsing
            if details['code'] in overrides:
                tmp_rows: List[Dict[str, object]] = []
                for gidx, clause in enumerate(overrides[details['code']], start=1):
                    for item in clause:
                        ccode = _canonical_code(item.get('code') or '')
                        if ccode and ccode != _canonical_code(details['code']):
                            tmp_rows.append({
                                'course_id': _canonical_code(details['code']),
                                'prereq_course_id': ccode,
                                'prerequisite_group': gidx,
                                'min_grade': item.get('min_grade'),
                            })
                if tmp_rows:
                    all_prereqs.extend(_dedupe_prereq_rows(tmp_rows))
                # Continue to next course
                if idx % 50 == 0 or idx == 1 or idx == len(target_codes):
                    print(f"Fetched {idx}/{len(target_codes)}: {code}")
                continue

            # Build prereq groups into a local buffer so LLM can replace weak structures
            prereq_rows_for_course: List[Dict[str, object]] = []
            groups_from_html = _parse_prereq_groups_from_html(course['code'], driver=driver) if html_prereqs else []
            if groups_from_html:
                for idx, group_items in enumerate(groups_from_html, start=1):
                    for item in group_items:
                        # Backward-compat: handle either dict with code/min_grade or plain string
                        if isinstance(item, dict):
                            code_norm = (item.get('code') or '').upper()
                            min_grade_val = item.get('min_grade')
                        else:
                            code_norm = str(item).upper()
                            min_grade_val = None
                        code_norm = _canonical_code(code_norm)
                        if code_norm and code_norm != _canonical_code(details['code']):
                            prereq_rows_for_course.append({
                                'course_id': details['code'],
                                'prereq_course_id': code_norm,
                                'prerequisite_group': idx,
                                'min_grade': min_grade_val,
                            })
            # LLM fallback when HTML parse yields a single flat group or none
            if use_llm and (not groups_from_html or (len(groups_from_html) == 1)):
                # Try to capture raw prereq block text from UW Flow page quickly
                raw_text = ''
                try:
                    if driver is not None:
                        # Use Selenium to capture the most link-dense block near a 'Prerequisites' header
                        driver.get(f"{FLOW_BASE}/course/{course['code']}")
                        import time as _t
                        for _ in range(40):
                            if 'Prereq' in (driver.page_source or '') or 'Prerequisites' in (driver.page_source or ''):
                                break
                            _t.sleep(0.2)
                        js = """
                        function pickBlock(){
                          const all = Array.from(document.querySelectorAll('a[href^="/course/"]'));
                          if(all.length===0) return '';
                          const counts = new Map();
                          function upTo(el, depth){ let n=el; for(let i=0;i<depth && n; i++){ n=n.parentElement; } return n; }
                          for(const a of all){
                            for(let d=0; d<5; d++){
                              const anc = upTo(a,d); if(!anc) break;
                              const key = anc;
                              const prev = counts.get(key)||0; counts.set(key, prev+1);
                            }
                          }
                          // Prefer blocks containing 'one of' or 'prereq'
                          let best=null, bestScore=-1;
                          counts.forEach((cnt, el)=>{
                            const t = (el.innerText||'').toLowerCase();
                            let score = cnt;
                            if(/one of|prereq/.test(t)) score += 3;
                            if(score>bestScore){ best=el; bestScore=score; }
                          });
                          return best ? (best.innerText||'').trim() : '';
                        }
                        return pickBlock();
                        """
                        try:
                            raw_text = driver.execute_script(js) or ''
                        except Exception:
                            raw_text = ''
                    if not raw_text:
                        html = _get(f"{FLOW_BASE}/course/{course['code']}")
                        soup2 = BeautifulSoup(html, 'html.parser')
                        for heading_tag in soup2.find_all(['h2', 'h3', 'strong', 'div', 'span']):
                            heading = heading_tag.get_text(" ", strip=True).lower()
                            if 'prereq' in heading:
                                body = heading_tag.find_next_sibling()
                                if body:
                                    raw_text = body.get_text(" ", strip=True)
                                    break
                except Exception:
                    raw_text = ''
                # Use a broad whitelist of codes so cross-department prereqs are retained
                known_codes = all_codes_global
                llm = None
                if raw_text:
                    raw_text = _trim_prereq_only(raw_text)
                    # Build a tight whitelist of codes actually present in the text
                    txt_codes = []
                    try:
                        for m in re.finditer(r"\b([A-Z]{2,5})\s*-?\s*(\d{2,3}[A-Z]?)\b", raw_text.upper()):
                            code = f"{m.group(1)}{m.group(2)}"
                            if code not in txt_codes:
                                txt_codes.append(code)
                    except Exception:
                        pass
                    # intersect with global known codes to avoid noise
                    txt_known = [c for c in txt_codes if c in codes]
                    # Always include the course's own department neighbors in case formatting varies
                    if details['code'][:2] and not txt_known:
                        dept = re.match(r"^([A-Z]+)", details['code']).group(1)
                        txt_known = [c for c in codes if c.startswith(dept)]
                    llm = parse_prereq_with_llm(raw_text, txt_known or all_codes_global, model=llm_model)
                    if llm.get('groups'):
                        llm_rows: List[Dict[str, object]] = []
                        for idx2, clause in enumerate(llm['groups'], start=1):
                            for item in clause:
                                code_norm = _canonical_code((item.get('code') or ''))
                                if code_norm and code_norm != details['code'] and code_norm in (txt_known or txt_codes):
                                    llm_rows.append({
                                        'course_id': details['code'],
                                        'prereq_course_id': code_norm,
                                        'prerequisite_group': idx2,
                                        'min_grade': item.get('min_grade'),
                                    })
                        # Replace if LLM produced structured groups (more than one group or any rows when we had none)
                        existing_groups = {int(r['prerequisite_group']) for r in prereq_rows_for_course}
                        if llm_rows:
                            prereq_rows_for_course = llm_rows
                # Debug dump (always)
                try:
                    with open('llm_debug.ndjson', 'a', encoding='utf-8') as f:
                        import json as _json
                        f.write(_json.dumps({
                            'course_id': details['code'],
                            'raw_text_head': (raw_text or '')[:200],
                            'raw_len': len(raw_text or ''),
                            'llm_ok': bool(llm and llm.get('groups'))
                        }) + "\n")
                except Exception:
                    pass
                # If still empty, fall back to GraphQL flat list below

            # Final fallback: GraphQL flat prereq list when nothing parsed yet (regardless of LLM usage)
            if not prereq_rows_for_course:
                for pr in prereq_items:
                    if not isinstance(pr, dict):
                        continue
                    prc = (pr.get('prerequisite') or {}) if isinstance(pr.get('prerequisite'), dict) else {}
                    code_norm = _canonical_code((prc.get('code') or ''))
                    if code_norm and code_norm != _canonical_code(details['code']):
                        prereq_rows_for_course.append({
                            'course_id': details['code'],
                            'prereq_course_id': code_norm,
                            'prerequisite_group': 1,
                            'min_grade': None,
                        })

            # Commit rows for this course
            # Apply override if present to ensure correctness for critical courses
            if details['code'] in overrides:
                prereq_rows_for_course = []
                for gidx, clause in enumerate(overrides[details['code']], start=1):
                    for item in clause:
                        if item['code'] != details['code']:
                            prereq_rows_for_course.append({
                                'course_id': details['code'],
                                'prereq_course_id': item['code'],
                                'prerequisite_group': gidx,
                                'min_grade': item.get('min_grade'),
                            })
            if prereq_rows_for_course:
                all_prereqs.extend(_dedupe_prereq_rows(prereq_rows_for_course))

            # Fetch up to 50 most recent sections for offerings
            sec = _graphql(
                "query($code:String!){ course_section(where:{course:{code:{_eq:$code}}}, order_by:{term_id:desc}, limit:100){ id term_id course{code} } }",
                {"code": code}
            )
            # Keep at most one row per (term, course_id), and at most 3 latest terms per course
            seen_terms_for_course = set()
            for s in sec.get('course_section', []):
                term = str(s.get('term_id'))
                cid = (s.get('course') or {}).get('code','').upper()
                if term in seen_terms_for_course:
                    continue
                offering_id = f"TERM-{term}-{cid}"
                all_offerings.append({
                    'offering_id': offering_id,
                    'term': term,
                    'course_id': cid,
                })
                seen_terms_for_course.add(term)
                if len(seen_terms_for_course) >= 3:
                    break

            if idx % 50 == 0 or idx == 1 or idx == len(codes):
                print(f"Fetched {idx}/{len(codes)}: {code}")
        except Exception as e:
            print(f"Failed {code}: {e}")

    if driver is not None:
        try:
            driver.quit()
        except Exception:
            pass
    return all_courses, all_prereqs, all_offerings


def _save_dicts_to_csv(data: List[Dict[str, object]], filename: str) -> None:
    if not data:
        print(f"No data to save for {filename}.")
        return
    keys = set().union(*(row.keys() for row in data))
    with open(filename, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=sorted(list(keys)))
        w.writeheader()
        w.writerows(data)
    print(f"Saved {len(data)} rows to {filename}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Scrape UW Flow and export or store to DB')
    parser.add_argument('--limit', type=int, default=500, help='Max courses to fetch (default 500; 0 = all)')
    parser.add_argument('--to-db', action='store_true', help='Write directly to DB using .env settings')
    parser.add_argument('--html-prereqs', action='store_true', help='Parse prerequisite groups from UW Flow course HTML (slower but grouped)')
    parser.add_argument('--use-selenium', action='store_true', help='Render UW Flow pages with headless Chrome for accurate prerequisite text (recommended)')
    parser.add_argument('--samples', type=str, default='', help='Comma-separated course codes to fetch only (overrides --limit if provided)')
    parser.add_argument('--use-llm', action='store_true', help='Enable LLM fallback (Perplexity) to structure prerequisites when heuristics are weak')
    parser.add_argument('--llm-model', type=str, default='sonar-small', help='Perplexity model: sonar-small or sonar-pro')
    parser.add_argument('--update-ratings', action='store_true', help='Fetch ratings from UWFlow and update existing DB course rows')
    parser.add_argument('--export-ratings-csv', type=str, default='', help='Export ratings (code, liked, easy, useful, rating_num) to CSV file')
    args = parser.parse_args()

    sample_list = [s.strip().upper() for s in (args.samples or '').split(',') if s.strip()]

    if args.export_ratings_csv:
        # Export ratings for a subset of course codes to CSV (no DB writes)
        codes = sample_list or []
        if not codes:
            codes = list_all_course_codes()[: max(1, int(args.limit or 50))]
        rows = []
        driver = None
        if args.use_selenium:
            try:
                from selenium import webdriver
                from selenium.webdriver.chrome.options import Options as ChromeOptions
                from selenium.webdriver.chrome.service import Service as ChromeService
                from webdriver_manager.chrome import ChromeDriverManager
                opts = ChromeOptions()
                opts.add_argument('--headless=new')
                opts.add_argument('--no-sandbox')
                opts.add_argument('--disable-dev-shm-usage')
                service = ChromeService(executable_path=ChromeDriverManager().install())
                driver = webdriver.Chrome(service=service, options=opts)
                driver.set_page_load_timeout(45)
            except Exception:
                driver = None
        try:
            for code in codes:
                stats = _fetch_course_ratings(code, driver=driver)
                rows.append({
                    'course_id': code.upper(),
                    'liked': stats.get('liked'),
                    'easy': stats.get('easy'),
                    'useful': stats.get('useful'),
                    'rating_num': stats.get('rating_num'),
                })
            _save_dicts_to_csv(rows, args.export_ratings_csv)
        finally:
            if driver is not None:
                try:
                    driver.quit()
                except Exception:
                    pass
        raise SystemExit(0)

    if args.update_ratings:
        # Direct ratings backfill for all existing DB courses
        load_dotenv()
        host = os.getenv('DB_HOST', 'localhost')
        port = int(os.getenv('DB_PORT', '3306'))
        user = os.getenv('DB_USER', 'uw_app')
        password = os.getenv('DB_PASSWORD', 'uw_app')
        database = os.getenv('DB_NAME', 'uw_courses')

        conn = mysql.connector.connect(host=host, port=port, user=user, password=password, database=database)
        driver = None
        if args.use_selenium:
            try:
                from selenium import webdriver
                from selenium.webdriver.chrome.options import Options as ChromeOptions
                from selenium.webdriver.chrome.service import Service as ChromeService
                from webdriver_manager.chrome import ChromeDriverManager
                opts = ChromeOptions()
                opts.add_argument('--headless=new')
                opts.add_argument('--no-sandbox')
                opts.add_argument('--disable-dev-shm-usage')
                service = ChromeService(executable_path=ChromeDriverManager().install())
                driver = webdriver.Chrome(service=service, options=opts)
                driver.set_page_load_timeout(45)
            except Exception:
                driver = None
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=%s AND TABLE_NAME='course'",
                    (database,)
                )
                course_cols = {r[0].lower() for r in cur.fetchall()}
                needed = {'liked','easy','useful','rating_num'}
                if not needed.issubset(course_cols):
                    print("Ratings columns are missing from 'course' table. Please run the ALTER TABLE first.")
                else:
                    cur.execute("SELECT course_id FROM course")
                    codes = [r[0] for r in cur.fetchall()]
                    if sample_list:
                        codes = [c for c in codes if c.upper() in {s.upper() for s in sample_list}]
                    if args.limit and args.limit > 0:
                        codes = codes[:args.limit]

                    total = len(codes)
                    processed = 0
                    batch: list[tuple] = []
                    for cid in codes:
                        stats = _fetch_course_ratings(cid, driver=driver)
                        batch.append((
                            stats.get('liked'), stats.get('easy'), stats.get('useful'), stats.get('rating_num'), cid
                        ))
                        if len(batch) >= 50:
                            try:
                                cur.executemany("UPDATE course SET liked=%s, easy=%s, useful=%s, rating_num=%s WHERE course_id=%s", batch)
                                conn.commit()
                            except mysql.connector.Error:
                                try:
                                    conn.rollback()
                                except Exception:
                                    pass
                                # Retry per-row on transient errors (e.g., lock wait)
                                import time as _t
                                for row in batch:
                                    for _ in range(3):
                                        try:
                                            cur.execute("UPDATE course SET liked=%s, easy=%s, useful=%s, rating_num=%s WHERE course_id=%s", row)
                                            conn.commit()
                                            break
                                        except mysql.connector.Error:
                                            try:
                                                conn.rollback()
                                            except Exception:
                                                pass
                                            _t.sleep(0.3)
                            processed += len(batch)
                            print(f"Updated ratings for {processed}/{total}")
                            batch = []
                    if batch:
                        try:
                            cur.executemany("UPDATE course SET liked=%s, easy=%s, useful=%s, rating_num=%s WHERE course_id=%s", batch)
                            conn.commit()
                        except mysql.connector.Error:
                            try:
                                conn.rollback()
                            except Exception:
                                pass
                            import time as _t
                            for row in batch:
                                for _ in range(3):
                                    try:
                                        cur.execute("UPDATE course SET liked=%s, easy=%s, useful=%s, rating_num=%s WHERE course_id=%s", row)
                                        conn.commit()
                                        break
                                    except mysql.connector.Error:
                                        try:
                                            conn.rollback()
                                        except Exception:
                                            pass
                                        _t.sleep(0.3)
                        processed += len(batch)
                        print(f"Updated ratings for {processed}/{total}")
                    print(f"Finished updating ratings for {total} courses.")
        finally:
            if driver is not None:
                try:
                    driver.quit()
                except Exception:
                    pass
            conn.close()
        raise SystemExit(0)

    courses, prereqs, offerings = scrape_uwflow(limit=args.limit, html_prereqs=args.html_prereqs, use_selenium=args.use_selenium, samples=(sample_list or None), use_llm=args.use_llm, llm_model=args.llm_model)

    if args.to_db:
        # Write directly to DB using same env vars as backend
        load_dotenv()
        host = os.getenv('DB_HOST', 'localhost')
        port = int(os.getenv('DB_PORT', '3306'))
        user = os.getenv('DB_USER', 'uw_app')
        password = os.getenv('DB_PASSWORD', 'uw_app')
        # default DB name matches Workbench schema
        database = os.getenv('DB_NAME', 'uw_courses')

        conn = mysql.connector.connect(host=host, port=port, user=user, password=password, database=database)
        try:
            with conn.cursor() as cur:
                # Detect actual columns present in `course` table to avoid unknown column errors
                cur.execute(
                    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=%s AND TABLE_NAME='course'",
                    (database,)
                )
                course_cols = {r[0].lower() for r in cur.fetchall()}
                has_description = 'description' in course_cols

                # Upsert courses (ensure all referenced prereq courses exist too)
                def upsert_courses(rows: Iterable[Dict[str, object]]):
                    # Build column list dynamically to safely include ratings when present
                    cols = ['course_id','course_name','department','course_level']
                    if has_description:
                        cols.append('description')
                    for extra in ['liked','easy','useful','rating_num']:
                        if extra in course_cols:
                            cols.append(extra)

                    insert_cols_sql = ", ".join(cols)
                    placeholders = ", ".join(["%s"] * len(cols))
                    update_cols = [c for c in cols if c != 'course_id']
                    update_sql = ", ".join([f"{c}=VALUES({c})" for c in update_cols])
                    sql = f"INSERT INTO course ({insert_cols_sql}) VALUES ({placeholders}) ON DUPLICATE KEY UPDATE {update_sql}"
                    def derive_dept_level(cid: str) -> Tuple[str, int]:
                        # Be tolerant: find the first 2-3 digit cluster; default lvl=0
                        m = re.match(r"^([A-Z]+)(\d{2,3})", cid or "")
                        if not m:
                            m = re.search(r"([A-Z]+).*?(\d{2,3})", cid or "")
                        dept = (m.group(1) if m else "")
                        lvl = 0
                        if m:
                            try:
                                lvl = int(m.group(2))
                            except Exception:
                                lvl = 0
                        return (dept, lvl)

                    data = []
                    for r in rows:
                        cid = (r.get('code') or r.get('course_id'))
                        dept, lvl = derive_dept_level(cid)
                        name = (r.get('title') or r.get('course_name') or cid)
                        row_vals = [cid, name, dept or '', int(lvl)]
                        if has_description:
                            row_vals.append(r.get('description') or '')
                        if 'liked' in cols:
                            row_vals.append(r.get('liked'))
                        if 'easy' in cols:
                            row_vals.append(r.get('easy'))
                        if 'useful' in cols:
                            row_vals.append(r.get('useful'))
                        if 'rating_num' in cols:
                            row_vals.append(r.get('rating_num'))
                        data.append(tuple(row_vals))
                    cur.executemany(sql, data)

                upsert_courses(courses)

                # Ensure prereq course rows exist
                prereq_only = []
                have_ids = {c['code'] for c in courses}
                for r in prereqs:
                    pid = r['prereq_course_id']
                    if pid not in have_ids:
                        prereq_only.append({'course_id': pid, 'code': pid, 'title': None, 'description': None})
                        have_ids.add(pid)
                if prereq_only:
                    upsert_courses(prereq_only)

                # Replace prereqs per course
                affected = sorted({r['course_id'] for r in prereqs})
                for cid in affected:
                    cur.execute("DELETE FROM course_prereq WHERE course_id = %s", (cid,))

                sql_pr = (
                    "INSERT INTO course_prereq (course_id, prereq_course_id, prerequisite_group, min_grade) "
                    "VALUES (%s, %s, %s, %s)"
                )
                cur.executemany(sql_pr, [
                    (r['course_id'], r['prereq_course_id'], int(r.get('prerequisite_group', 1)), r.get('min_grade'))
                    for r in prereqs
                ])

                # Upsert offerings (idempotent by PK)
                if offerings:
                    # Prefer composite-PK schema (term, course_id). Fallback to legacy schema with offering_id PK.
                    try:
                        cur.executemany(
                            "INSERT INTO offering (term, course_id) VALUES (%s, %s) ON DUPLICATE KEY UPDATE term=VALUES(term)",
                            [(o['term'], o['course_id']) for o in offerings]
                        )
                    except mysql.connector.Error as e:  # type: ignore
                        # Legacy schema path: offering(offering_id PK, term, course_id)
                        cur.executemany(
                            "INSERT IGNORE INTO offering (offering_id, term, course_id) VALUES (%s, %s, %s)",
                            [(o['offering_id'], o['term'], o['course_id']) for o in offerings]
                        )
            conn.commit()
            print(f"Inserted/updated {len(courses)} courses, {len(prereqs)} prereqs, {len(offerings)} offerings")
        finally:
            conn.close()
    else:
        if courses:
            _save_dicts_to_csv(courses, 'uwflow_courses.csv')
        if prereqs:
            _save_dicts_to_csv(prereqs, 'uwflow_course_prereq.csv')
        if offerings:
            _save_dicts_to_csv(offerings, 'uwflow_offerings.csv')


