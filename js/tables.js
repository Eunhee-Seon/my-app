// 데이터 구조 탭: 연결된 테이블의 이름 · 설명 · 행 수 · 컬럼 · 고유 식별자 · 연결 관계, 펼치면 처음 20행.
// 설명 · 식별자 · 관계는 schema.json 에 있는 것만 표시한다(없으면 '—').
import * as db from "./db.js";
import { esc } from "./explain.js";
import { renderTable } from "./ask.js";

const $ = (id) => document.getElementById(id);
let schema = { tables: [], relationships: [] };
const open = new Set();

/** schema.json 의 설명을 쓸 수 있는가: 이름과 컬럼 구성이 같을 때만. */
function knownOf(t) {
  const k = schema.tables.find((x) => x.name === t.name);
  if (!k) return null;
  return k.columns.map((c) => c.name).join(",") === t.columns.map((c) => c.name).join(",") ? k : null;
}

/** "employees.emp_id 1 : N attendance.emp_id" · "a.x → b.y (비고)" 를 나눈다. */
function parseRel(s) {
  const m = String(s).match(/^(\S+)\s+(1\s*:\s*N|→)\s+(\S+)(?:\s+\((.+)\))?$/);
  if (!m) return { from: s, kind: "", to: "", note: "" };
  return { from: m[1], kind: m[2].includes(":") ? "1 : N" : "참조", to: m[3], note: m[4] || "" };
}
const relsOf = (name) => (schema.relationships || []).map(parseRel)
  .filter((r) => r.from.split(".")[0] === name || r.to.split(".")[0] === name);

function relTable(rels) {
  if (!rels.length) return '<p class="empty">데이터 사전에 등록된 연결 관계가 없습니다.</p>';
  return `<div class="table-scroll auto"><table class="data"><thead><tr><th>기준 컬럼</th><th>관계</th><th>대상 컬럼</th><th>비고</th></tr></thead><tbody>
    ${rels.map((r) => `<tr><td>${esc(r.from)}</td><td>${esc(r.kind)}</td><td>${esc(r.to)}</td><td>${esc(r.note || "—")}</td></tr>`).join("")}
  </tbody></table></div>`;
}

function detailRow(t, k) {
  const desc = new Map((k?.columns || []).map((c) => [c.name, c]));
  const fmtEx = (ex) => (ex || []).filter((v) => v !== null).slice(0, 5).join(", ");
  const cols = t.columns.map((c) => {
    const d = desc.get(c.name);
    return `<tr><td>${esc(c.name)}</td><td>${esc(c.type)}</td><td>${esc(d?.desc || "—")}</td><td>${esc(d ? fmtEx(d.examples) || "—" : "—")}</td></tr>`;
  }).join("");
  return `<tr class="detail-row" data-for="${esc(t.name)}"><td colspan="6">
    <p class="cols-head">컬럼 ${t.columns.length}개</p>
    <div class="table-scroll auto"><table class="data"><thead><tr><th>컬럼</th><th>타입</th><th>설명</th><th>값 예</th></tr></thead><tbody>${cols}</tbody></table></div>
    ${k ? `<div class="rel"><p class="cols-head">연결 관계</p>${relTable(relsOf(t.name))}</div>` : ""}
    <button type="button" class="btn small preview-btn" data-table="${esc(t.name)}">처음 20행 보기</button>
    <div class="preview"></div>
  </td></tr>`;
}

function render() {
  const list = [...db.registry.values()];
  if (!list.length) {
    $("table-list").innerHTML = '<p class="empty">아직 연결된 테이블이 없습니다.</p>';
  } else {
    const rows = list.map((t) => {
      const k = knownOf(t);
      const isOpen = open.has(t.name);
      const src = t.kind === "upload" ? `업로드 · ${t.source}` : t.source;
      const desc = k ? k.grain : t.kind === "upload" ? "업로드 파일 · 설명 없음" : "—";
      return `<tr>
        <td><button type="button" class="row-toggle" aria-expanded="${isOpen}" data-table="${esc(t.name)}">${esc(t.name)}</button></td>
        <td>${esc(desc)}</td>
        <td class="num">${t.rows.toLocaleString()}</td>
        <td>${t.columns.length}개</td>
        <td>${esc(k ? k.key.join(" + ") : "—")}</td>
        <td>${esc(src)}${t.fileRows === t.rows ? "" : ' <span class="tag err">행 수 불일치</span>'}</td>
      </tr>${isOpen ? detailRow(t, k) : ""}`;
    }).join("");
    $("table-list").innerHTML = `<div class="table-scroll auto"><table class="grid">
      <thead><tr><th>테이블명</th><th>데이터 설명 (한 행 =)</th><th class="num">행 수</th><th>컬럼</th><th>고유 식별자</th><th>데이터 출처</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }
  $("relations").innerHTML = relTable((schema.relationships || []).map(parseRel));
}

export async function setup() {
  try {
    const res = await fetch("schema.json");
    if (res.ok) schema = await res.json();
  } catch { /* 설명 없이 표시 */ }
  $("table-list").addEventListener("click", async (e) => {
    const tog = e.target.closest(".row-toggle");
    if (tog) {
      const name = tog.dataset.table;
      open.has(name) ? open.delete(name) : open.add(name);
      render();
      return;
    }
    const pv = e.target.closest(".preview-btn");
    if (pv) {
      const box = pv.nextElementSibling;
      pv.disabled = true;
      try {
        const res = await db.run(`SELECT * FROM ${db.quoteIdent(pv.dataset.table)} LIMIT 20`);
        box.innerHTML = renderTable(res, 20);
      } catch (err) {
        box.innerHTML = `<p class="msg error">${esc(err.message)}</p>`;
      }
    }
  });
  window.addEventListener("tables-changed", render);
  render();
}
