import os
import json
import time
from typing import Dict, Any, List, Optional

import requests


PPLX_URL = "https://api.perplexity.ai/chat/completions"


def _post_pplx(messages: List[Dict[str, str]], *, model: str = "sonar-pro", temperature: float = 0.0, max_retries: int = 3) -> Dict[str, Any]:
    api_key = os.getenv("PPLX_API_KEY")
    if not api_key:
        raise RuntimeError("PPLX_API_KEY not set")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    # Perplexity supports response_format json_schema; define strict schema
    schema = {
        "type": "object",
        "properties": {
            "groups": {
                "type": "array",
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "code": {"type": "string"},
                            "min_grade": {"type": ["integer", "null"]},
                        },
                        "required": ["code"],
                        "additionalProperties": False,
                    },
                },
            },
            "constraints": {"type": "array", "items": {"type": "string"}},
            "confidence": {"type": "number"},
        },
        "required": ["groups"],
        "additionalProperties": False,
    }
    # Some models may not accept json_schema; prefer 'text' format and instruct JSON-only.
    body = {
        "model": model,
        "temperature": temperature,
        "messages": messages,
        "response_format": {"type": "text"},
    }
    last_err = None
    for i in range(max_retries):
        try:
            resp = requests.post(PPLX_URL, headers=headers, json=body, timeout=45)
            if resp.status_code == 200:
                return resp.json()
            last_err = RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        except Exception as e:
            last_err = e
        time.sleep(1.5 * (i + 1))
    raise last_err or RuntimeError("Unknown error calling Perplexity API")


def parse_prereq_with_llm(raw_text: str, known_codes: List[str], *, model: str = "sonar-pro") -> Dict[str, Any]:
    """Ask the LLM to convert prerequisite text into CNF groups.

    Returns a dict: { groups: List[List[{code,min_grade?}]], constraints: List[str], confidence: float }
    """
    codes_hint = ", ".join(sorted(set([str(c).upper() for c in known_codes if c])))[:4000]
    sys = (
        "You are a data normalizer. Convert prerequisite prose into CNF — an AND of OR-clauses. "
        "Return JSON only. Schema: { groups: Clause[], constraints: string[], confidence: number }. "
        "Clause := CourseAlt[] where CourseAlt := { code: string, min_grade?: integer }. "
        "Rules: (1) Use only codes from the provided whitelist. (2) Parentheses groupings and 'one of' => OR. "
        "(3) Conjunction words like 'and', semicolons => AND between clauses. (4) Apply phrases like 'with at least N%' to the nearest course(s). "
        "(5) Put non-course conditions (e.g., program restrictions, averages) into constraints[]."
    )
    user = (
        "Text:\n" + (raw_text or "").strip() + "\n\n"
        "Codes:\n" + codes_hint + "\n\n"
        "Return JSON only."
    )
    # Few-shot example to anchor format
    ex_user = (
        "Text:\nCS 335 prerequisites (One of CS 116, CS 136, CS 138, CS 146) or (CS 114 with at least 60%; CS 115 or CS 135); "
        "One of MATH 106 with at least 70%, MATH 136 or MATH 146; MATH 237 or MATH 247; One of STAT 206, STAT 231, STAT 241.\n\n"
        "Codes:\nCS116, CS136, CS138, CS146, CS114, CS115, CS135, MATH106, MATH136, MATH146, MATH237, MATH247, STAT206, STAT231, STAT241"
    )
    ex_assistant = (
        '{"groups":['
        '[{"code":"CS116"},{"code":"CS136"},{"code":"CS138"},{"code":"CS146"}],' 
        '[{"code":"CS114","min_grade":60},{"code":"CS115"},{"code":"CS135"}],' 
        '[{"code":"MATH106","min_grade":70},{"code":"MATH136"},{"code":"MATH146"}],' 
        '[{"code":"MATH237"},{"code":"MATH247"}],' 
        '[{"code":"STAT206"},{"code":"STAT231"},{"code":"STAT241"}]' 
        '],"constraints":[],"confidence":0.9}'
    )

    # Additional few-shot examples to robustly capture nested "one of" groups,
    # slashes (A/B), and repeated group patterns separated by semicolons/commas.
    ex2_user = (
        "Text:\nOne of AMATH 250, AMATH 251, MATH 228; One of PHYS 267, STAT 202, STAT 206, STAT 221, STAT 231, STAT 241; One of CS 114, CS 116, CS 136, CS 146.\n\n"
        "Codes:\nAMATH250, AMATH251, MATH228, PHYS267, STAT202, STAT206, STAT221, STAT231, STAT241, CS114, CS116, CS136, CS146"
    )
    ex2_assistant = (
        '{"groups":'
        '[[{"code":"AMATH250"},{"code":"AMATH251"},{"code":"MATH228"}],' 
        '[[{"code":"PHYS267"},{"code":"STAT202"},{"code":"STAT206"},{"code":"STAT221"},{"code":"STAT231"},{"code":"STAT241"}]],' 
        '[[{"code":"CS114"},{"code":"CS116"},{"code":"CS136"},{"code":"CS146"}]],'
        '"constraints":[],"confidence":0.9}'
    )

    ex3_user = (
        "Text:\nMATH 137 or MATH 147 and (STAT 220 with at least 70% or a corequisite of STAT 230 or STAT 240).\n\n"
        "Codes:\nMATH137, MATH147, STAT220, STAT230, STAT240"
    )
    ex3_assistant = (
        '{"groups":'
        '[[{"code":"MATH137"},{"code":"MATH147"}],' 
        '[[{"code":"STAT220","min_grade":70},{"code":"STAT230"},{"code":"STAT240"}]],'
        '"constraints":["coreq allowed for STAT230/STAT240"],"confidence":0.85}'
    )

    ex4_user = (
        "Text:\nOne of AFM 274/AFM 371, ACTSC 372, ACTSC 391/AFM 372 or ECON 372.\n\n"
        "Codes:\nAFM274, AFM371, ACTSC372, ACTSC391, AFM372, ECON372"
    )
    ex4_assistant = (
        '{"groups":'
        '[[{"code":"AFM274"},{"code":"AFM371"}],' 
        '[[{"code":"ACTSC372"}],' 
        '[[{"code":"ACTSC391"},{"code":"AFM372"},{"code":"ECON372"}]],'
        '"constraints":[],"confidence":0.8}'
    )

    ex5_user = (
        "Text:\n(One of PHYS 112, PHYS 122, PHYS 125) and (one of MATH 118, MATH 119, MATH 128, MATH 138, MATH 148) and (one of AMATH 250 or AMATH 251, AMATH 350, CIVE 222, ENVE 223, MATH 218, MATH 228, ME 203, SYDE 211).\n\n"
        "Codes:\nPHYS112, PHYS122, PHYS125, MATH118, MATH119, MATH128, MATH138, MATH148, AMATH250, AMATH251, AMATH350, CIVE222, ENVE223, MATH218, MATH228, ME203, SYDE211"
    )
    ex5_assistant = (
        '{"groups":'
        '[[{"code":"PHYS112"},{"code":"PHYS122"},{"code":"PHYS125"}],' 
        '[[{"code":"MATH118"},{"code":"MATH119"},{"code":"MATH128"},{"code":"MATH138"},{"code":"MATH148"}],' 
        '[[{"code":"AMATH250"},{"code":"AMATH251"},{"code":"AMATH350"},{"code":"CIVE222"},{"code":"ENVE223"},{"code":"MATH218"},{"code":"MATH228"},{"code":"ME203"},{"code":"SYDE211"}]],'
        '"constraints":[],"confidence":0.9}'
    )

    ex6_user = (
        "Text:\nOne of MATH 118, MATH 119, MATH 128, MATH 138, MATH 148; One of STAT 202, STAT 206, STAT 220, STAT 230, STAT 240; One of AMATH 250, AMATH 251, AMATH 350, MATH 211, MATH 213, MATH 218, MATH 228.\n\n"
        "Codes:\nMATH118, MATH119, MATH128, MATH138, MATH148, STAT202, STAT206, STAT220, STAT230, STAT240, AMATH250, AMATH251, AMATH350, MATH211, MATH213, MATH218, MATH228"
    )
    ex6_assistant = (
        '{"groups":'
        '[[{"code":"MATH118"},{"code":"MATH119"},{"code":"MATH128"},{"code":"MATH138"},{"code":"MATH148"}],' 
        '[[{"code":"STAT202"},{"code":"STAT206"},{"code":"STAT220"},{"code":"STAT230"},{"code":"STAT240"}],' 
        '[[{"code":"AMATH250"},{"code":"AMATH251"},{"code":"AMATH350"},{"code":"MATH211"},{"code":"MATH213"},{"code":"MATH218"},{"code":"MATH228"}]],'
        '"constraints":[],"confidence":0.9}'
    )

    ex7_user = (
        "Text:\n(One of MATH 106, MATH 114, MATH 115, MATH 136, MATH 146) and (One of AMATH 250, AMATH 251, AMATH 350 or MATH 218, MATH 228) and (One of STAT 202, STAT 206, STAT 211, STAT 220, STAT 230, STAT 231, STAT 241).\n\n"
        "Codes:\nMATH106, MATH114, MATH115, MATH136, MATH146, AMATH250, AMATH251, AMATH350, MATH218, MATH228, STAT202, STAT206, STAT211, STAT220, STAT230, STAT231, STAT241"
    )
    ex7_assistant = (
        '{"groups":'
        '[[{"code":"MATH106"},{"code":"MATH114"},{"code":"MATH115"},{"code":"MATH136"},{"code":"MATH146"}],' 
        '[[{"code":"AMATH250"},{"code":"AMATH251"},{"code":"AMATH350"},{"code":"MATH218"},{"code":"MATH228"}],' 
        '[[{"code":"STAT202"},{"code":"STAT206"},{"code":"STAT211"},{"code":"STAT220"},{"code":"STAT230"},{"code":"STAT231"},{"code":"STAT241"}]],'
        '"constraints":[],"confidence":0.9}'
    )

    messages_all = [
        {"role": "system", "content": sys},
        {"role": "user", "content": ex_user},
        {"role": "assistant", "content": ex_assistant},
        {"role": "user", "content": ex2_user},
        {"role": "assistant", "content": ex2_assistant},
        {"role": "user", "content": ex3_user},
        {"role": "assistant", "content": ex3_assistant},
        {"role": "user", "content": ex4_user},
        {"role": "assistant", "content": ex4_assistant},
        {"role": "user", "content": ex5_user},
        {"role": "assistant", "content": ex5_assistant},
        {"role": "user", "content": ex6_user},
        {"role": "assistant", "content": ex6_assistant},
        {"role": "user", "content": ex7_user},
        {"role": "assistant", "content": ex7_assistant},
        {"role": "user", "content": user},
    ]

    data = _post_pplx(messages_all, model=model, temperature=0.0)

    def try_parse(d: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        c = (((d.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
        try:
            return json.loads(c)
        except Exception:
            return None

    obj = try_parse(data)
    if obj is None:
        # Second attempt with a stricter user instruction
        strict = user + "\n\nReturn VALID JSON only. If uncertain, return {\"groups\":[],\"constraints\":[],\"confidence\":0.3}."
        data2 = _post_pplx([
            {"role": "system", "content": sys},
            {"role": "user", "content": ex_user},
            {"role": "assistant", "content": ex_assistant},
            {"role": "user", "content": strict},
        ], model=model, temperature=0.0)
        obj = try_parse(data2)
    if obj is None:
        obj = {"groups": [], "constraints": ["invalid_json"], "confidence": 0.0}
    # sanitize
    keep = set(c.upper() for c in known_codes)
    def _flatten_clause(clause_any):
        # Some few-shots or model outputs produce nested lists like [[{...}], [{...}]]
        # Normalize to a flat list of dicts
        flat = []
        stack = list(clause_any if isinstance(clause_any, list) else [clause_any])
        while stack:
            elem = stack.pop(0)
            if isinstance(elem, list):
                for sub in elem:
                    stack.append(sub)
            else:
                flat.append(elem)
        return flat

    groups = []
    for clause in obj.get("groups", []):
        items = _flatten_clause(clause)
        cleaned = []
        for item in items:
            if not isinstance(item, dict):
                continue
            code = str(item.get("code", "")).upper()
            if code in keep:
                mg = item.get("min_grade")
                try:
                    mg = int(mg) if mg is not None else None
                except Exception:
                    mg = None
                cleaned.append({"code": code, "min_grade": mg})
        if cleaned:
            groups.append(cleaned)
    if not isinstance(obj.get("confidence"), (int, float)):
        obj["confidence"] = 0.5
    return {"groups": groups, "constraints": obj.get("constraints", []), "confidence": float(obj.get("confidence", 0.5))}


