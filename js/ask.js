// 직접 조회 탭: 자연어 질의 → SQL 생성 → 실행 전 검사 → 브라우저에서 실행 → 결과표
//             → 산출 근거(SQL과 대조) → 원인 분석(세분화 SQL 실행 + 최대 기여 항목 계산)
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

/** 결과표. 숫자 컬럼은 오른쪽 정렬, 표 안에서 스크롤. */
export function renderTable({ columns, rows }, limit = 500, { tall = false } = {}) {
  if (!rows.length) return '<p class="empty">조회 결과가 없습니다.</p>';
  const numeric = columns.map((c) => {
    const vals = rows.map((r) => r[c.name]).filter((v) => v !== null && v !== undefined);
    return vals.length > 0 && vals.every((v) => typeof v === "number");
  });
  const head = columns.map((c, i) => `<th${numeric[i] ? ' class="num"' : ""}>${esc(c.name)}</th>`).join("");
  const body = rows
    .slice(0, limit)
    .map((r) => `<tr>${columns.map((c, i) => `<td${numeric[i] ? ' class="num"' : ""}>${fmt(r[c.name])}</td>`).join("")}</tr>`)
    .join("");
  const more = rows.length > limit ? `<p class="more">전체 ${rows.length.toLocaleString()}행 중 ${limit.toLocaleString()}행 표시</p>` : "";
  return `<div class="table-scroll${tall ? " tall" : ""}"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
}

function setMsg(text, kind = "") {
  const el = $("ask-msg");
  el.textContent = text;
  el.className = `msg ${kind}`;
  el.hidden = !text;
}

/** AI 호출 오류 → 안내 문구와 다시 시도 방법. 원래 오류 문장은 «오류 상세»에 그대로 둔다. */
function errorGuide(message) {
  const m = String(message || "");
  if (/GEMINI_API_KEY/.test(m)) return ["AI 서비스 키가 설정되어 있지 않습니다.", "관리자에게 GEMINI_API_KEY 설정을 요청하세요. 로컬에서는 .env 저장 후 서버를 다시 시작합니다."];
  if (/\(503\)/.test(m)) return ["AI 서비스가 일시적으로 혼잡합니다.", "1분 정도 후 다시 시도하세요."];
  if (/\(429\)/.test(m)) return ["AI 서비스 호출 한도를 초과했습니다.", "잠시 후 다시 시도하세요."];
  if (/\((400|401|403)\)/.test(m)) return ["AI 서비스 인증 또는 요청에 실패했습니다.", "API 키가 올바른지 관리자에게 확인을 요청하세요."];
  if (/\(404\)/.test(m) && /Gemini/.test(m)) return ["설정된 AI 모델을 찾을 수 없습니다.", "GEMINI_MODEL 설정을 관리자에게 확인하세요."];
  if (/연결하지 못했습니다|Failed to fetch|NetworkError|Load failed/i.test(m)) return ["AI 서비스에 연결하지 못했습니다.", "네트워크 연결을 확인한 뒤 다시 시도하세요."];
  if (/JSON/.test(m)) return ["AI 응답을 해석하지 못했습니다.", "다시 시도하거나 질의를 더 구체적으로 입력하세요."];
  if (/질문이 비어/.test(m)) return ["질의가 비어 있습니다.", "조회할 내용을 입력하세요."];
  return ["SQL을 생성하지 못했습니다.", "잠시 후 다시 시도하세요. 계속되면 아래 오류 상세를 관리자에게 전달하세요."];
}

function showAiError(e) {
  const [title, action] = errorGuide(e.message);
  const el = $("ask-msg");
  el.className = "msg";
  el.hidden = false;
  el.innerHTML = `
    <div class="alert" role="alert">
      <div class="alert-row"><span><b>${esc(title)}</b> ${esc(action)}</span>
        <button type="button" class="btn small" id="ask-retry">다시 시도</button></div>
      <details><summary>오류 상세</summary><code>${esc(e.message)}</code></details>
    </div>`;
  $("ask-retry").addEventListener("click", ask);
}

async function runMain() {
  const sql = $("ask-sql").value;
  $("ask-result").innerHTML = "";
  setMsg("");
  try {
    const t0 = performance.now();
    const res = await db.run(sql); // 실행 전 읽기 전용 검사 포함
    const ms = Math.round(performance.now() - t0);
    $("ask-result").innerHTML = `
      <section class="block">
        <h3 class="sec">조회 결과 <span class="sub">${res.rows.length.toLocaleString()}행 · ${ms}ms</span></h3>
        ${renderTable(res, 500, { tall: true })}
      </section>`;
    return { sql, res };
  } catch (e) {
    setMsg(e.blocked ? `실행 전에 차단했습니다: ${e.message}` : `실행 오류: ${e.message}`, "error");
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

const drillHead = '<h3 class="sec">원인 분석 <span class="sub">결과를 한 단계 더 세분화</span></h3>';

async function showDrill(question, sql, res) {
  const box = $("ask-drill");
  box.innerHTML = `<section class="block">${drillHead}<p class="msg">세분화 SQL을 생성하는 중…</p></section>`;
  let d;
  try {
    d = await askDrill(question, sql, res);
  } catch (e) {
    const [title, action] = errorGuide(e.message);
    box.innerHTML = `<section class="block">${drillHead}
      <div class="alert"><b>원인 분석을 생성하지 못했습니다.</b> ${esc(title)} ${esc(action)} 위 조회 결과와 산출 근거는 그대로 사용할 수 있습니다.
      <details><summary>오류 상세</summary><code>${esc(e.message)}</code></details></div></section>`;
    return;
  }
  const sqlBox = `<details class="sql"><summary>세분화 SQL 보기</summary>
    ${d.split_by?.length ? `<p class="note">세분화 기준: ${esc(d.split_by.join(", "))}</p>` : ""}<pre>${esc(d.drill_sql)}</pre></details>`;
  const reason = d.reason ? `<p class="desc">${esc(d.reason)}</p>` : "";
  try {
    const r = await db.run(d.drill_sql); // 원인 SQL도 같은 읽기 전용 검사
    const chunk = biggestChunk(r, d.measure_column, d.split_by);
    box.innerHTML = `<section class="block">${drillHead}${reason}
      <p class="finding"><b>최대 기여 항목</b>${esc(chunkSentence(chunk))}</p>
      <p class="note">최대 기여 항목과 비중은 아래 세분화 결과 ${r.rows.length.toLocaleString()}행에서 직접 계산한 값입니다.</p>
      ${renderTable(r, 50)}${sqlBox}</section>`;
  } catch (e) {
    const why = e.blocked ? `실행 전에 차단했습니다: ${e.message}` : `실행 오류: ${e.message}`;
    box.innerHTML = `<section class="block">${drillHead}${reason}<p class="msg error">${esc(why)}</p>${sqlBox}</section>`;
  }
}

async function ask() {
  const q = $("ask-q").value.trim();
  if (!q) return;
  const btn = $("ask-go");
  btn.disabled = true;
  setMsg("SQL을 생성하는 중…");
  for (const id of ["ask-result", "ask-basis", "ask-drill"]) $(id).innerHTML = "";
  lastAi = null;
  try {
    lastAi = await askSql(q);
    $("ask-sql").value = lastAi.sql || "";
    const main = await runMain();
    await showBasis($("ask-sql").value); // 본 SQL이 실패해도 근거는 보여 준다
    if (main) await showDrill(q, main.sql, main.res); // 원인 단계가 실패해도 위 내용은 그대로
  } catch (e) {
    showAiError(e);
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
