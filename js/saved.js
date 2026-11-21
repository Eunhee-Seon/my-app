// 준비된 질문 탭: 검증한 질문을 SQL과 함께 두고, «다시 계산»으로 지금 올라와 있는 데이터로 다시 실행한다.
// AI는 부르지 않는다. 파일을 올려도 자동으로 다시 계산하지 않는다.
import * as db from "./db.js";
import { esc, biggestChunk, chunkSentence } from "./explain.js";
import { renderTable } from "./ask.js";

const $ = (id) => document.getElementById(id);
let questions = [];
const last = new Map(); // id → {at, rows, tableStamp}

const stamp = (tables) =>
  tables.map((t) => {
    const r = db.registry.get(t);
    return r ? `${t}:${r.source}:${r.rows}:${r.loadedAt.getTime()}` : `${t}:없음`;
  }).join("|");

function sources(tables) {
  return tables.map((t) => {
    const r = db.registry.get(t);
    return r ? `${t} = ${r.source} (${r.rows.toLocaleString()}행)` : `${t} = 없음`;
  }).join(" · ");
}

function card(q) {
  return `
  <div class="card saved" id="q-${esc(q.id)}">
    <h3>${esc(q.question)}</h3>
    <p class="hint">지표: ${esc(q.metrics_used.join(", "))} · 검증: ${esc(q.verified)}</p>
    <details><summary>SQL</summary><pre>${esc(q.sql)}</pre>${q.drill ? `<p class="hint">원인 한 단계: ${esc(q.drill.title)}</p><pre>${esc(q.drill.sql)}</pre>` : ""}</details>
    <div class="ask-row"><button class="rerun primary" data-id="${esc(q.id)}">다시 계산</button></div>
    <p class="calc-info hint">아직 계산하지 않았습니다.</p>
    <div class="out"></div>
  </div>`;
}

async function rerun(q) {
  const el = $(`q-${q.id}`);
  const info = el.querySelector(".calc-info");
  const out = el.querySelector(".out");
  const btn = el.querySelector(".rerun");
  btn.disabled = true;
  try {
    const res = await db.run(q.sql);
    const at = new Date();
    const prev = last.get(q.id);
    last.set(q.id, { at, rows: res.rows.length, tableStamp: stamp(q.tables) });
    const prevText = prev ? ` <span class="hint">(이전: ${prev.at.toLocaleTimeString("ko-KR")} · ${prev.rows.toLocaleString()}행)</span>` : "";
    info.innerHTML = `계산한 시각 <b>${at.toLocaleString("ko-KR")}</b> · 행 수 <b>${res.rows.length.toLocaleString()}</b>${prevText}<br>읽은 데이터: ${esc(sources(q.tables))}`;
    info.classList.remove("stale");
    let html = renderTable(res, 50);
    if (q.drill) {
      try {
        const d = await db.run(q.drill.sql);
        html += `<h4>원인 한 단계 — ${esc(q.drill.title)}</h4>
          <p class="chunk">${esc(chunkSentence(biggestChunk(d, q.drill.measure_column, q.drill.split_by)))}</p>
          ${renderTable(d, 50)}`;
      } catch (e) {
        html += `<p class="msg error">원인 SQL 실행 오류: ${esc(e.message)}</p>`;
      }
    }
    out.innerHTML = html;
  } catch (e) {
    info.innerHTML = `<span class="msg error">${e.blocked ? "실행 전에 막았습니다" : "실행 오류"}: ${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
}

/** 테이블이 바뀌면 이전 계산에 «데이터가 바뀜» 표시만 한다(자동 재계산 없음). */
function markStale() {
  for (const q of questions) {
    const prev = last.get(q.id);
    if (!prev || prev.tableStamp === stamp(q.tables)) continue;
    const info = $(`q-${q.id}`)?.querySelector(".calc-info");
    if (info && !info.classList.contains("stale")) {
      info.classList.add("stale");
      info.insertAdjacentHTML("beforeend", `<br><b>테이블이 바뀌었습니다 — «다시 계산»을 눌러 새 데이터로 계산하세요.</b>`);
    }
  }
}

export async function setup() {
  const res = await fetch("questions/prepared.json");
  questions = res.ok ? await res.json() : [];
  $("saved-list").innerHTML = questions.length ? questions.map(card).join("") : '<p class="hint">준비된 질문이 없습니다.</p>';
  $("saved-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".rerun");
    if (btn) rerun(questions.find((q) => q.id === btn.dataset.id));
  });
  window.addEventListener("tables-changed", markStale);
  setReady(false);
}

export function setReady(ready) {
  document.querySelectorAll("#saved-list .rerun").forEach((b) => (b.disabled = !ready));
}
