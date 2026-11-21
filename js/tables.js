// 테이블 탭: 올라와 있는 테이블의 이름 · 출처 · 행 수 · 컬럼 · 타입, 펼치면 처음 20행
import * as db from "./db.js";
import { esc } from "./explain.js";
import { renderTable } from "./ask.js";

const $ = (id) => document.getElementById(id);

function render() {
  const list = [...db.registry.values()];
  if (!list.length) {
    $("table-list").innerHTML = '<p class="hint">아직 올라온 테이블이 없습니다.</p>';
    return;
  }
  $("table-list").innerHTML = list
    .map((t) => {
      const same = t.fileRows === t.rows;
      return `
      <details class="card table-card" data-table="${esc(t.name)}">
        <summary>
          <b>${esc(t.name)}</b>
          <span>${t.rows.toLocaleString()}행</span>
          <span class="badge ${t.kind === "upload" ? "warn" : "ok"}">${t.kind === "upload" ? "올린 파일" : "기본 데이터"}</span>
          <span class="hint">${esc(t.source)} · 파일 ${t.fileRows.toLocaleString()}행 ${same ? "✓" : "✕"}</span>
        </summary>
        <p class="hint">컬럼 ${t.columns.length}개 · 올린 시각 ${t.loadedAt.toLocaleTimeString("ko-KR")}</p>
        <div class="cols">${t.columns.map((c) => `<span><b>${esc(c.name)}</b> ${esc(c.type)}</span>`).join("")}</div>
        <div class="preview"></div>
      </details>`;
    })
    .join("");
  $("table-list").querySelectorAll("details").forEach((el) => {
    el.addEventListener("toggle", async () => {
      const box = el.querySelector(".preview");
      if (!el.open || box.dataset.done) return;
      box.dataset.done = "1";
      try {
        const res = await db.run(`SELECT * FROM ${db.quoteIdent(el.dataset.table)} LIMIT 20`);
        box.innerHTML = `<p class="hint">처음 20행</p>${renderTable(res, 20)}`;
      } catch (e) {
        box.innerHTML = `<p class="msg error">${esc(e.message)}</p>`;
      }
    });
  });
}

export function setup() {
  window.addEventListener("tables-changed", render);
  render();
}
