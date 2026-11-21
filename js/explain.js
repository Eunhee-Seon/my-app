// 왜 패널: ① 산출 근거(AI 설명을 SQL과 대조) ② 원인 한 단계(가장 큰 덩어리는 브라우저가 계산)
import { strip } from "./guard.js";

export function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

const unquote = (n) => n.replace(/^"|"$/g, "").replace(/""/g, '"');
const IDENT = String.raw`("(?:[^"]|"")+"|[A-Za-z_가-힣][\w가-힣]*)`;

/** SQL 안에서 실제로 읽는 테이블 이름(올라와 있는 테이블만, CTE 이름 제외). */
export function tablesInSql(sql, knownTables) {
  const s = strip(sql);
  const known = new Map(knownTables.map((t) => [t.toLowerCase(), t]));
  const ctes = new Set();
  for (const m of s.matchAll(new RegExp(`${IDENT}\\s+AS\\s*(?:NOT\\s+)?(?:MATERIALIZED\\s*)?\\(`, "gi")))
    ctes.add(unquote(m[1]).toLowerCase());
  const found = new Set();
  const add = (name) => {
    const key = unquote(name).toLowerCase();
    if (!ctes.has(key) && known.has(key)) found.add(known.get(key));
  };
  // FROM a / JOIN a, 그리고 FROM a x, b y 같은 쉼표 나열
  for (const m of s.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+${IDENT}((?:\\s*(?:AS\\s+)?${IDENT})?(?:\\s*,\\s*${IDENT}(?:\\s+(?:AS\\s+)?${IDENT})?)*)`, "gi"))) {
    add(m[1]);
    for (const c of (m[2] || "").matchAll(new RegExp(`,\\s*${IDENT}`, "g"))) add(c[1]);
  }
  return [...found];
}

/** AI가 말한 근거와 SQL을 대조한다. issues 가 비어 있으면 일치. */
export function checkBasis(ai, sql, knownTables, schema) {
  const issues = [];
  const inSql = tablesInSql(sql, knownTables);
  const said = (ai.tables || []).map(String);
  const lower = (a) => new Set(a.map((x) => x.toLowerCase()));
  const sqlSet = lower(inSql), saidSet = lower(said);
  const notInSql = said.filter((t) => !sqlSet.has(t.toLowerCase()));
  const notSaid = inSql.filter((t) => !saidSet.has(t.toLowerCase()));
  if (notInSql.length) issues.push(`AI는 읽었다고 했지만 SQL에 없는 테이블: ${notInSql.join(", ")}`);
  if (notSaid.length) issues.push(`SQL이 읽지만 AI 설명에 없는 테이블: ${notSaid.join(", ")}`);
  if (!inSql.length) issues.push("SQL에서 올라와 있는 테이블을 찾지 못했습니다.");
  const metricNames = new Set((schema.metrics || []).map((m) => m.name));
  const unknown = (ai.metrics_used || []).filter((m) => !metricNames.has(m));
  if (unknown.length) issues.push(`데이터 사전에 없는 지표 이름: ${unknown.join(", ")}`);
  return { inSql, issues };
}

export function renderBasis(ai, check, schema) {
  const defs = new Map((schema.metrics || []).map((m) => [m.name, m.definition]));
  const metrics = (ai.metrics_used || []).length
    ? `<ul>${ai.metrics_used.map((m) => `<li><b>${esc(m)}</b> — ${esc(defs.get(m) || "데이터 사전에 없음")}</li>`).join("")}</ul>`
    : '<span class="hint">AI가 지표 정의를 밝히지 않았습니다.</span>';
  const badge = check.issues.length
    ? `<span class="badge warn">확인 필요</span>`
    : `<span class="badge ok">SQL과 일치</span>`;
  const issues = check.issues.length ? `<ul class="issues">${check.issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "";
  return `
    <div class="card">
      <h3>① 산출 근거 ${badge}</h3>
      ${issues}
      <dl class="meta">
        <div><dt>읽은 테이블 (AI)</dt><dd>${esc((ai.tables || []).join(", ") || "—")}</dd></div>
        <div><dt>SQL 속 테이블</dt><dd>${esc(check.inSql.join(", ") || "—")}</dd></div>
        <div><dt>조건</dt><dd>${esc((ai.filters || []).join(" · ") || "—")}</dd></div>
        <div><dt>지표 정의</dt><dd>${metrics}</dd></div>
        ${ai.note ? `<div><dt>AI 메모</dt><dd>${esc(ai.note)}</dd></div>` : ""}
      </dl>
    </div>`;
}

const isNumCol = (rows, name) => {
  const vals = rows.map((r) => r[name]).filter((v) => v !== null && v !== undefined);
  return vals.length > 0 && vals.every((v) => typeof v === "number" && Number.isFinite(v));
};

/** 결과 테이블에서 절댓값이 가장 큰 행과 전체(합) 대비 비중을 계산한다. */
export function biggestChunk(res, measureColumn, splitBy = []) {
  const { columns, rows } = res;
  if (!rows.length) return null;
  const names = columns.map((c) => c.name);
  const numeric = names.filter((n) => isNumCol(rows, n));
  const measure = numeric.includes(measureColumn) ? measureColumn : numeric[numeric.length - 1];
  if (!measure) return null;
  let labels = (splitBy || []).filter((n) => names.includes(n) && n !== measure);
  if (!labels.length) labels = names.filter((n) => !numeric.includes(n));
  let top = null, total = 0, pos = 0, neg = 0;
  for (const r of rows) {
    const v = r[measure];
    if (typeof v !== "number") continue;
    total += v;
    if (v > 0) pos++; else if (v < 0) neg++;
    if (!top || Math.abs(v) > Math.abs(top[measure])) top = r;
  }
  if (!top) return null;
  return {
    measure,
    label: labels.map((n) => top[n]).join(" · ") || "(첫 행)",
    value: top[measure],
    total,
    share: total !== 0 ? top[measure] / total : null,
    mixedSigns: pos > 0 && neg > 0,
    rowCount: rows.length,
  };
}

const n0 = (v) => v.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const signed = (v) => (v > 0 ? "+" : "") + n0(v);

export function chunkSentence(c) {
  if (!c) return "결과에서 크기를 나타내는 숫자 컬럼을 찾지 못해 가장 큰 덩어리를 계산하지 않았습니다.";
  const share = c.share === null ? "전체 합이 0이라 비중 계산 불가" : `전체 ${signed(c.total)}의 ${(c.share * 100).toFixed(1)}%`;
  const mixed = c.mixedSigns ? " (늘어난 덩어리와 줄어든 덩어리가 섞여 있어 비중은 순합계 기준)" : "";
  return `가장 큰 덩어리: ${c.label} — ${c.measure} ${signed(c.value)} · ${share}${mixed}`;
}
