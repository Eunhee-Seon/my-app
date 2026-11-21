// DuckDB-WASM: 브라우저 안에서만 데이터를 읽는다.
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";
import { checkSql } from "./guard.js";

export const BASE_TABLES = ["employees", "attendance", "payroll", "job_openings", "applicants", "reviews"];

let conn = null;
let dbInstance = null;

/** 올라와 있는 테이블 목록: name → {name, source, kind: 'base'|'upload', fileRows, rows, columns:[{name,type}], loadedAt} */
export const registry = new Map();

async function start() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  // CDN 워커는 다른 출처라 blob 으로 감싸서 띄운다
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
  );
  const worker = new Worker(workerUrl);
  dbInstance = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await dbInstance.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  conn = await dbInstance.connect();
}

export const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;
const quoteStr = (s) => `'${String(s).replaceAll("'", "''")}'`;
const rowsOf = (result) => result.toArray().map((r) => r.toJSON());

/** CSV 텍스트의 데이터 행 수(머리글 제외, 빈 줄 제외). 따옴표 안의 줄바꿈은 한 행으로 센다. */
export function countCsvRows(text) {
  let rows = 0, inQuote = false, hasContent = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote && ch === "\n") {
      if (hasContent) rows++;
      hasContent = false;
    } else if (ch !== "\r" && !(ch === " " || ch === "\t") && ch !== "\n") {
      hasContent = true;
    }
  }
  if (hasContent) rows++;
  return Math.max(0, rows - 1);
}

/**
 * CSV 텍스트를 테이블로 올린다. 같은 이름이면 바꾼다. (내부 적재용 — 사용자 SQL 아님)
 * 컬럼 이름의 공백은 밑줄로 바꾸고, 바꾼 목록을 돌려준다.
 */
export async function loadCsvText(table, text, { source, kind = "upload" } = {}) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 앞의 BOM 무시
  const fileRows = countCsvRows(text);
  const file = `__upload_${Date.now()}_${Math.random().toString(36).slice(2)}.csv`;
  await dbInstance.registerFileText(file, text);
  try {
    const src = `read_csv_auto(${quoteStr(file)}, header = true)`;
    const cols = rowsOf(await conn.query(`DESCRIBE SELECT * FROM ${src}`)).map((r) => r.column_name);
    const used = new Set();
    const renamed = [];
    const select = cols.map((c) => {
      let n = c.trim().replace(/\s+/g, "_") || "column";
      while (used.has(n.toLowerCase())) n += "_";
      used.add(n.toLowerCase());
      if (n !== c) renamed.push({ from: c, to: n });
      return `${quoteIdent(c)} AS ${quoteIdent(n)}`;
    });
    const existed = registry.has(table) || (await tableNames()).includes(table);
    await conn.query(`CREATE OR REPLACE TABLE ${quoteIdent(table)} AS SELECT ${select.join(", ")} FROM ${src}`);
    const info = await describeTable(table);
    const entry = { name: table, source, kind, fileRows, ...info, loadedAt: new Date() };
    registry.set(table, entry);
    window.dispatchEvent(new CustomEvent("tables-changed", { detail: { table } }));
    return { ...entry, renamed, replaced: existed };
  } finally {
    await dbInstance.dropFile(file);
  }
}

async function describeTable(table) {
  const columns = rowsOf(await conn.query(`DESCRIBE ${quoteIdent(table)}`)).map((r) => ({ name: r.column_name, type: r.column_type }));
  const n = rowsOf(await conn.query(`SELECT count(*) AS n FROM ${quoteIdent(table)}`))[0].n;
  return { columns, rows: Number(n) };
}

/** DB를 띄우고 data/ 의 CSV 6개를 올린다. */
export async function init(onProgress = () => {}) {
  onProgress("DuckDB 시작 중…");
  await start();
  for (const t of BASE_TABLES) {
    onProgress(`${t} 올리는 중…`);
    const res = await fetch(`data/${t}.csv`);
    if (!res.ok) throw new Error(`data/${t}.csv 를 읽지 못했습니다 (${res.status})`);
    await loadCsvText(t, await res.text(), { source: `data/${t}.csv`, kind: "base" });
  }
}

/** 지금 올라와 있는 테이블 이름 (내부 조회용). */
export async function tableNames() {
  const r = await conn.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY 1");
  return rowsOf(r).map((x) => x.table_name);
}

// Arrow 값 → 화면 · 계산용 JS 값. SUM(BIGINT) 같은 결과는 Decimal 객체로 오므로 숫자로 바꾼다.
function converter(type) {
  const t = String(type);
  if (t.startsWith("Decimal")) {
    const scale = type.scale || 0;
    return (v) => (v === null || v === undefined ? v : Number(String(v)) / 10 ** scale);
  }
  if (t.startsWith("Date")) {
    return (v) => (v === null || v === undefined ? v : new Date(Number(v)).toISOString().slice(0, 10));
  }
  if (t.startsWith("Timestamp")) {
    return (v) => (v === null || v === undefined ? v : new Date(Number(v)).toISOString().replace("T", " ").slice(0, 19));
  }
  return (v) => (typeof v === "bigint" ? Number(v) : v);
}

/** 읽기 전용 검사를 통과한 SQL만 실행한다. (AI SQL · 직접 쓴 SQL · 원인 SQL · 준비된 질문 · 미리보기 모두) */
export async function run(sql) {
  const blocked = checkSql(sql);
  if (blocked) {
    const err = new Error(blocked);
    err.blocked = true;
    throw err;
  }
  const result = await conn.query(sql);
  const fields = result.schema.fields;
  const columns = fields.map((f) => ({ name: f.name, type: String(f.type) }));
  const conv = fields.map((f) => converter(f.type));
  const rows = result.toArray().map((r) => {
    const o = r.toJSON();
    fields.forEach((f, i) => (o[f.name] = conv[i](o[f.name])));
    return o;
  });
  return { columns, rows };
}
