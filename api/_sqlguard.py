"""읽기 전용 SQL 검사 — js/guard.js 와 같은 규칙. 둘을 고칠 때는 함께 고친다."""

import re

FORBIDDEN = [
    "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "TRUNCATE",
    "CREATE", "DROP", "ALTER", "RENAME", "COMMENT",
    "COPY", "EXPORT", "IMPORT", "ATTACH", "DETACH", "USE",
    "INSTALL", "LOAD", "PRAGMA", "SET", "RESET", "CALL", "EXECUTE", "PREPARE", "DEALLOCATE",
    "CHECKPOINT", "VACUUM", "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "GRANT", "REVOKE",
]
# 파일 · URL · 외부 DB를 직접 읽는 함수
FORBIDDEN_FUNCS = re.compile(
    r"\b(read_\w+|sniff_csv|parquet_\w+|glob|query_table|query|iceberg_\w+|delta_scan|"
    r"sqlite_\w+|postgres_\w+|mysql_\w+|getenv|current_setting)\s*\(",
    re.IGNORECASE,
)


def _strip(sql: str) -> str:
    """주석과 문자열 리터럴을 지워 키워드만 남긴다."""
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    sql = re.sub(r"--[^\n]*", " ", sql)
    sql = re.sub(r"'(?:[^']|'')*'", "''", sql)
    sql = re.sub(r'"(?:[^"]|"")*"', '""', sql)
    return sql


def check(sql: str) -> str | None:
    """통과하면 None, 막으면 이유(한국어)를 돌려준다."""
    if not sql or not sql.strip():
        return "SQL이 비어 있습니다."
    body = _strip(sql).strip()
    body = re.sub(r";\s*$", "", body)
    if ";" in body:
        return "한 번에 SQL 문장 하나만 실행할 수 있습니다."
    if "'" in body.replace("''", "") or "/*" in body:
        return "닫히지 않은 문자열이나 주석이 있습니다."
    first = re.match(r"\s*\(*\s*(\w+)", body)
    if not first or first.group(1).upper() not in ("SELECT", "WITH"):
        return "읽기(SELECT · WITH)만 실행할 수 있습니다."
    for word in FORBIDDEN:
        if re.search(rf"\b{word}\b", body, re.IGNORECASE):
            return f"읽기 전용이 아닌 명령({word})이 들어 있습니다."
    m = FORBIDDEN_FUNCS.search(body)
    if m:
        return f"파일 · 외부 데이터를 직접 읽는 함수({m.group(1)})는 쓸 수 없습니다. 올라와 있는 테이블만 쓰세요."
    return None
