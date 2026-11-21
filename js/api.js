// /api/ask 호출. AI에는 질문 · 테이블 설명(schema.json + 올린 테이블) · 집계 결과(최대 50행)만 보낸다.
import { strip } from "./guard.js";
import { registry } from "./db.js";

export const MAX_RESULT_ROWS = 50;
let schemaCache = null;

async function baseSchema() {
  if (!schemaCache) {
    const res = await fetch("schema.json");
    if (!res.ok) throw new Error("schema.json 을 읽지 못했습니다.");
    schemaCache = await res.json();
  }
  return schemaCache;
}

/**
 * AI에 보낼 테이블 설명. schema.json 을 바탕으로 지금 올라와 있는 테이블의 행 수를 반영하고,
 * 올린 테이블은 이름 · 컬럼 이름 · 타입 · 행 수만 더한다(컬럼 뜻은 없으므로 보내지 않는다).
 * 기본 테이블과 같은 이름 · 같은 컬럼으로 올린 파일이면 데이터 사전의 뜻을 그대로 쓴다.
 */
export async function getSchema() {
  const base = await baseSchema();
  const byName = new Map(base.tables.map((t) => [t.name, t]));
  const tables = [];
  for (const r of registry.values()) {
    const known = byName.get(r.name);
    const sameCols = known && known.columns.map((c) => c.name).join(",") === r.columns.map((c) => c.name).join(",");
    if (sameCols) {
      tables.push({ ...known, rows: r.rows, ...(r.kind === "upload" ? { source: `사용자가 올린 파일 ${r.source}` } : {}) });
    } else {
      tables.push({
        name: r.name,
        source: r.kind === "upload" ? `사용자가 올린 파일 ${r.source} (컬럼 뜻 없음)` : r.source,
        rows: r.rows,
        columns: r.columns.map((c) => ({ name: c.name, type: c.type })),
      });
    }
  }
  return { ...base, tables: tables.length ? tables : base.tables };
}

async function post(body) {
  const res = await fetch("api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`api 응답을 읽지 못했습니다 (${res.status})`);
  }
  if (!res.ok) throw new Error(data.error || `api 오류 (${res.status})`);
  return data;
}

/** GROUP BY 나 집계 함수가 있는 SQL의 결과만 '집계 결과'로 본다. */
export function isAggregated(sql) {
  const s = strip(sql);
  return /\bGROUP\s+BY\b/i.test(s) ||
    /\b(count|sum|avg|mean|min|max|median|stddev\w*|variance|var_\w+|quantile\w*|percentile\w*|mode|string_agg|list)\s*\(/i.test(s);
}

/** AI에 보낼 결과: 집계 결과면 최대 50행, 아니면 행 없이 컬럼명 · 행 수만. */
export function resultForAi(sql, res) {
  const columns = res.columns.map((c) => c.name);
  if (!isAggregated(sql)) return { columns, row_count: res.rows.length, rows: [], note: "원본 행이라 보내지 않음" };
  return { columns, row_count: res.rows.length, rows: res.rows.slice(0, MAX_RESULT_ROWS) };
}

/** 질문 → {sql, tables, filters, metrics_used, note, blocked} */
export async function askSql(question) {
  return post({ step: "sql", question, schema: await getSchema() });
}

/** 질문 + 본 SQL + 본 결과 → {drill_sql, split_by, measure_column, tables, reason, blocked} */
export async function askDrill(question, sql, res) {
  return post({ step: "drill", question, sql, result: resultForAi(sql, res), schema: await getSchema() });
}
