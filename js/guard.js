// 읽기 전용 SQL 검사 — api/_sqlguard.py 와 같은 규칙. 둘을 고칠 때는 함께 고친다.
// AI가 쓴 SQL이든 내가 쓴 SQL이든 db.run() 이 실행 전에 이 검사를 부른다.

const FORBIDDEN = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "TRUNCATE",
  "CREATE", "DROP", "ALTER", "RENAME", "COMMENT",
  "COPY", "EXPORT", "IMPORT", "ATTACH", "DETACH", "USE",
  "INSTALL", "LOAD", "PRAGMA", "SET", "RESET", "CALL", "EXECUTE", "PREPARE", "DEALLOCATE",
  "CHECKPOINT", "VACUUM", "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "GRANT", "REVOKE",
];
// 파일 · URL · 외부 DB를 직접 읽는 함수
const FORBIDDEN_FUNCS =
  /\b(read_\w+|sniff_csv|parquet_\w+|glob|query_table|query|iceberg_\w+|delta_scan|sqlite_\w+|postgres_\w+|mysql_\w+|getenv|current_setting)\s*\(/i;

/** 주석과 문자열 리터럴을 지워 키워드 · 이름만 남긴다. */
export function strip(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/** 통과하면 null, 막으면 이유(한국어)를 돌려준다. */
export function checkSql(sql) {
  if (!sql || !sql.trim()) return "SQL이 비어 있습니다.";
  let body = strip(sql).trim().replace(/;\s*$/, "");
  if (body.includes(";")) return "한 번에 SQL 문장 하나만 실행할 수 있습니다.";
  if (body.replaceAll("''", "").includes("'") || body.includes("/*"))
    return "닫히지 않은 문자열이나 주석이 있습니다.";
  const first = body.match(/^\s*\(*\s*(\w+)/);
  if (!first || !["SELECT", "WITH"].includes(first[1].toUpperCase()))
    return "읽기(SELECT · WITH)만 실행할 수 있습니다.";
  for (const word of FORBIDDEN) {
    if (new RegExp(`\\b${word}\\b`, "i").test(body))
      return `읽기 전용이 아닌 명령(${word})이 들어 있습니다.`;
  }
  const m = body.match(FORBIDDEN_FUNCS);
  if (m) return `파일 · 외부 데이터를 직접 읽는 함수(${m[1]})는 쓸 수 없습니다. 올라와 있는 테이블만 쓰세요.`;
  return null;
}
