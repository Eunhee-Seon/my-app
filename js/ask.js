// 묻기 탭: 질문 → AI가 SQL 작성 → 실행 전 검사 → 브라우저에서 실행 → 결과 표
//          → ① 산출 근거(SQL과 대조) → ② 원인 한 단계(쪼갠 SQL 실행 + 가장 큰 덩어리 계산)
import { askSql, askDrill, getSchema } from "./api.js";
import * as db from "./db.js";
import { esc, checkBasis, renderBasis, biggestChunk, chunkSentence } from "./explain.js";

const $ = (id) => document.getElementById(id);
let lastAi = null; // 마지막 AI 응답(sql 단계)

function fmt(v) {
  if (v === null || v === undefined) return '<span class="null">NULL</span>';
  if (typeof v === "number") return v.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  return esc(v);
}

export function renderTable({ columns, rows }, limit = 500) {
  if (!rows.length) return '<p class="hint">결과가 없습니다.</p>';
  const head = columns.map((c) => `<th>${esc(c.name)}</th>`).join("");
  const body = rows
    .slice(0, limit)
    .map((r) => `<tr>${columns.map((c) => `<td>${fmt(r[c.name])}</td>`).join("")}</tr>`)
    .join("");
  const more = rows.length > limit ? `<p class="hint">${rows.length.toLocaleString()}행 중 앞 ${limit}행만 표시</p>` : "";
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
}

function setMsg(text, kind = "") {
  const el = $("ask-msg");
  el.textContent = text;
  el.className = `msg ${kind}`;
  el.hidden = !text;
}

async function runMain() {
  const sql = $("ask-sql").value;
  $("ask-result").innerHTML = "";
  setMsg("");
  try {
    const t0 = performance.now();
    const res = await db.run(sql); // 실행 전 읽기 전용 검사 포함
    const ms = Math.round(performance.now() - t0);
    $("ask-result").innerHTML = `<p class="hint">${res.rows.length.toLocaleString()}행 · ${ms}ms</p>` + renderTable(res);
    return { sql, res };
  } catch (e) {
    setMsg(e.blocked ? `실행 전에 막았습니다: ${e.message}` : `실행 오류: ${e.message}`, "error");
    return null;
  }
}

async function showBasis(sql) {
  if (!lastAi) {
    $("ask-basis").innerHTML = "";
    return;
  }
  const check = checkBasis(lastAi, sql, await db.tableNames(), await getSchema());
  $("ask-basis").innerHTML = renderBasis(lastAi, check, await getSchema());
}

async function showDrill(question, sql, res) {
  const box = $("ask-drill");
  box.innerHTML = `<div class="card"><h3>② 원인 한 단계</h3><p class="hint">AI가 쪼개는 SQL을 쓰는 중…</p></div>`;
  let d;
  try {
    d = await askDrill(question, sql, res);
  } catch (e) {
    box.innerHTML = `<div class="card"><h3>② 원인 한 단계</h3><p class="msg error">쪼개는 SQL을 받지 못했습니다: ${esc(e.message)}</p></div>`;
    return;
  }
  const head = `
    <h3>② 원인 한 단계</h3>
    ${d.reason ? `<p>${esc(d.reason)}</p>` : ""}
    <details><summary>쪼갠 SQL${d.split_by?.length ? ` · 기준: ${esc(d.split_by.join(", "))}` : ""}</summary><pre>${esc(d.drill_sql)}</pre></details>`;
  try {
    const r = await db.run(d.drill_sql); // 원인 SQL도 같은 읽기 전용 검사
    const chunk = biggestChunk(r, d.measure_column, d.split_by);
    box.innerHTML = `<div class="card">${head}
      <p class="chunk">${esc(chunkSentence(chunk))}</p>
      <p class="hint">위 숫자는 AI가 아니라 브라우저가 아래 결과 ${r.rows.length.toLocaleString()}행에서 계산했습니다.</p>
      ${renderTable(r, 50)}</div>`;
  } catch (e) {
    const why = e.blocked ? `실행 전에 막았습니다: ${e.message}` : `실행 오류: ${e.message}`;
    box.innerHTML = `<div class="card">${head}<p class="msg error">${esc(why)}</p></div>`;
  }
}

async function ask() {
  const q = $("ask-q").value.trim();
  if (!q) return;
  const btn = $("ask-go");
  btn.disabled = true;
  setMsg("AI가 SQL을 쓰는 중…");
  for (const id of ["ask-result", "ask-basis", "ask-drill"]) $(id).innerHTML = "";
  lastAi = null;
  try {
    lastAi = await askSql(q);
    $("ask-sql").value = lastAi.sql || "";
    const main = await runMain();
    await showBasis($("ask-sql").value); // 본 SQL이 실패해도 근거는 보여 준다
    if (main) await showDrill(q, main.sql, main.res); // 원인 단계가 실패해도 위 내용은 그대로
  } catch (e) {
    setMsg(e.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function runEdited() {
  $("ask-drill").innerHTML = "";
  const main = await runMain();
  await showBasis($("ask-sql").value); // 고친 SQL과 AI 설명을 다시 대조
  return main;
}

export function setup() {
  $("ask-go").addEventListener("click", ask);
  $("ask-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) ask();
  });
  $("ask-run").addEventListener("click", runEdited);
  $("ask-sql").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runEdited();
  });
}

export function setReady(ready) {
  for (const id of ["ask-go", "ask-run"]) $(id).disabled = !ready;
}
