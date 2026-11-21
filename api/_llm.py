"""Gemini 호출과 단계별 프롬프트. api/ask.py(Vercel)와 tools/serve.py(내 PC)가 함께 쓴다.

AI에는 질문 · 테이블 설명(schema.json) · 집계 결과(최대 50행)만 보낸다. 원본 행은 받지 않는다.
"""

import json
import os
import urllib.error
import urllib.request

try:  # Vercel(api/ 가 sys.path) · serve.py(my-app 이 sys.path) 둘 다 지원
    from _sqlguard import check as check_sql
except ImportError:  # pragma: no cover
    from api._sqlguard import check as check_sql

DEFAULT_MODEL = "gemini-3.5-flash-lite"
API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
MAX_BODY = 200_000      # 요청 본문 상한(바이트)
MAX_RESULT_ROWS = 50    # AI에 보낼 수 있는 결과 행 상한


class AskError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


SQL_SYSTEM = """너는 인사 데이터 분석가다. 사용자의 한국어 질문에 답하는 DuckDB SQL 한 문장을 쓴다.

규칙
- 아래 schema 의 테이블 · 컬럼만 쓴다. 없는 컬럼을 지어내지 않는다.
- SELECT 또는 WITH 로 시작하는 읽기 전용 SQL 한 문장. 세미콜론 · 주석 금지. read_csv 같은 파일 함수 금지.
- 지표는 schema.metrics 의 정의를 그대로 따른다. 특히 월 인원은 COUNT(DISTINCT emp_id)이고 payroll 행 수를 세지 않는다.
- payroll.pay_month 는 'YYYY-MM' 문자열이다.
- 결과는 사람이 읽을 집계여야 한다(최대 50행). 개인별 원본 행을 그대로 나열하지 않는다.
- 컬럼 별칭은 한국어로 짧게 쓴다(예: 인원, 인건비).

JSON 으로만 답한다:
{"sql": "...",
 "tables": ["읽은 테이블"],
 "filters": ["적용한 조건을 한국어로"],
 "metrics_used": ["schema.metrics 의 name 그대로"],
 "note": "어떻게 셌는지 한 문장"}"""


def _call_gemini(system: str, user: dict) -> dict:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise AskError("GEMINI_API_KEY 가 설정되어 있지 않습니다.", 500)
    model = os.environ.get("GEMINI_MODEL", "").strip() or DEFAULT_MODEL
    payload = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": json.dumps(user, ensure_ascii=False)}]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
    }
    req = urllib.request.Request(
        API_URL.format(model=model),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise AskError(f"Gemini 호출 실패({e.code}): {detail}", 502)
    except urllib.error.URLError as e:
        raise AskError(f"Gemini 에 연결하지 못했습니다: {e.reason}", 502)
    try:
        text = "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"])
        return json.loads(text)
    except (KeyError, IndexError, json.JSONDecodeError):
        raise AskError("Gemini 응답을 JSON 으로 읽지 못했습니다.", 502)


def _step_sql(body: dict) -> dict:
    question = str(body.get("question", "")).strip()
    schema = body.get("schema")
    if not question:
        raise AskError("질문이 비어 있습니다.")
    if not isinstance(schema, dict) or not schema.get("tables"):
        raise AskError("테이블 설명(schema)이 없습니다.")
    out = _call_gemini(SQL_SYSTEM, {"question": question, "schema": schema})
    sql = str(out.get("sql", "")).strip().rstrip(";").strip()
    out["sql"] = sql
    out["blocked"] = check_sql(sql)  # AI가 쓴 SQL도 같은 검사. 브라우저가 실행 전에 한 번 더 검사한다
    return out


DRILL_SYSTEM = """너는 인사 데이터 분석가다. 질문에 대한 본 SQL과 그 집계 결과를 보고, 원인을 한 단계 더 찾기 위해
결과를 한 번 더 쪼개는 DuckDB SQL 한 문장을 쓴다.

쪼개는 방향(예)
- 인건비 · 인건비 증감 → 급여 항목(pay_item)별 × 부서(employees.dept)별
- 인원 · 퇴사자 수 → 부서별 · 직급별 · 퇴사 사유별
- 초과근로 → 부서별 · 직무별
- 채용 기간 → 공고 유형별 · 부서별
질문이 쪼갤 기준을 말하면 그 기준을 따른다.

규칙
- schema 의 테이블 · 컬럼만 쓴다. 지표는 schema.metrics 정의를 그대로 따른다.
- SELECT 또는 WITH 로 시작하는 읽기 전용 SQL 한 문장. 세미콜론 · 주석 · 파일 함수 금지.
- 결과 컬럼 = 쪼갠 기준 컬럼(문자) 몇 개 + 크기를 나타내는 숫자 컬럼 하나(measure_column).
  비교·증감 질문이면 measure_column 은 증감액(나중 값 − 이전 값)이고, 비교 전·후 값 컬럼을 함께 넣어도 된다.
- measure_column 의 절댓값이 큰 순서로 정렬하고 최대 50행.
- 숫자 결론은 쓰지 않는다. 가장 큰 덩어리와 비중은 브라우저가 결과에서 직접 계산한다.

JSON 으로만 답한다:
{"drill_sql": "...",
 "split_by": ["쪼갠 기준 컬럼 별칭"],
 "measure_column": "크기 숫자 컬럼 별칭",
 "tables": ["읽은 테이블"],
 "reason": "왜 이렇게 쪼개는지 한 문장"}"""


def _step_drill(body: dict) -> dict:
    question = str(body.get("question", "")).strip()
    sql = str(body.get("sql", "")).strip()
    schema = body.get("schema")
    if not question or not sql:
        raise AskError("질문과 본 SQL이 필요합니다.")
    if not isinstance(schema, dict) or not schema.get("tables"):
        raise AskError("테이블 설명(schema)이 없습니다.")
    user = {"question": question, "sql": sql, "schema": schema}
    if body.get("result") is not None:
        user["result"] = body["result"]  # 집계 결과 최대 50행(handle 에서 상한 검사)
    out = _call_gemini(DRILL_SYSTEM, user)
    drill_sql = str(out.get("drill_sql", "")).strip().rstrip(";").strip()
    out["drill_sql"] = drill_sql
    out["blocked"] = check_sql(drill_sql)
    return out


STEPS = {"sql": _step_sql, "drill": _step_drill}


def handle(raw: bytes) -> tuple[int, dict]:
    """HTTP 본문을 받아 (상태 코드, 응답 JSON)을 돌려준다."""
    try:
        if len(raw) > MAX_BODY:
            raise AskError("요청이 너무 큽니다.", 413)
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise AskError("요청 본문이 JSON 이 아닙니다.")
        result = body.get("result")
        if result is not None and (not isinstance(result, dict)
                                   or len(result.get("rows") or []) > MAX_RESULT_ROWS):
            raise AskError(f"결과는 최대 {MAX_RESULT_ROWS}행까지만 보낼 수 있습니다.")
        step = STEPS.get(body.get("step", "sql"))
        if step is None:
            raise AskError("알 수 없는 단계입니다.")
        return 200, step(body)
    except AskError as e:
        return e.status, {"error": str(e)}
