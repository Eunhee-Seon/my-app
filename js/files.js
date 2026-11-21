// 파일 업로드 탭: CSV · xlsx 를 브라우저 안에서 읽어 테이블로 올린다. 파일은 서버로 보내지 않는다.
import * as db from "./db.js";
import { esc } from "./explain.js";
import { renderTable } from "./ask.js";
import { isPayUnlocked, payLockPanel } from "./paylock.js";

const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
const $ = (id) => document.getElementById(id);
let XLSX = null;

/** 파일 이름(확장자 뺀 것) → 테이블 이름. 공백은 밑줄로. */
function tableNameOf(fileName) {
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  return base.replace(/\s+/g, "_") || "upload";
}

async function readCsv(file) {
  const buf = await file.arrayBuffer();
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), notes: [] };
  } catch {
    return { text: new TextDecoder("euc-kr").decode(buf), notes: ["UTF-8 이 아니어서 EUC-KR 로 읽었습니다. 글자가 깨졌다면 UTF-8 CSV 로 다시 저장해 올려 주세요."] };
  }
}

const pad = (n) => String(n).padStart(2, "0");
function cellText(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    const d = `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    const t = v.getHours() || v.getMinutes() || v.getSeconds() ? ` ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}` : "";
    return d + t;
  }
  return String(v);
}
const csvCell = (v) => {
  const s = cellText(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** xlsx 첫 시트 → CSV 텍스트. 첫 행이 컬럼 이름. */
async function readXlsx(file) {
  if (!XLSX) XLSX = await import(SHEETJS_URL);
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  const sheetName = wb.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, blankrows: false, defval: null });
  if (!aoa.length) throw new Error("첫 시트가 비어 있습니다.");
  const width = Math.max(...aoa.map((r) => r.length));
  const header = Array.from({ length: width }, (_, i) => {
    const h = cellText(aoa[0][i]).trim();
    return h || `column${i + 1}`;
  });
  const lines = [header, ...aoa.slice(1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null))]
    .map((r) => r.map(csvCell).join(","));
  const notes = wb.SheetNames.length > 1 ? [`시트 ${wb.SheetNames.length}개 중 첫 시트(«${sheetName}»)만 읽었습니다.`] : [];
  return { text: lines.join("\n"), notes, fileRows: aoa.length - 1 };
}

async function handleFile(file) {
  const tbody = resultsBody();
  const row = document.createElement("tr");
  row.innerHTML = `<td>${esc(file.name)}</td><td>—</td><td class="st-run">읽는 중…</td><td class="num">—</td><td class="num">—</td><td>—</td><td></td><td></td>`;
  tbody.prepend(row);
  const card = row; // 아래 결과 표시는 이 행을 채운다
  try {
    const ext = (file.name.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
    let parsed;
    if (ext === "csv") parsed = await readCsv(file);
    else if (ext === "xlsx") parsed = await readXlsx(file);
    else throw new Error("CSV 나 xlsx 파일만 올릴 수 있습니다.");

    const table = tableNameOf(file.name);
    const notes = [...parsed.notes];
    if (table !== file.name.replace(/\.[^.]+$/, "")) notes.push(`테이블 이름의 공백을 밑줄로 바꿨습니다: «${table}»`);

    const r = await db.loadCsvText(table, parsed.text, { source: file.name, kind: "upload" });
    const fileRows = parsed.fileRows ?? r.fileRows; // xlsx 는 시트에서 센 행 수
    r.fileRows = fileRows;
    db.registry.get(table).fileRows = fileRows;
    if (r.renamed.length)
      notes.push(`컬럼 이름의 공백을 밑줄로 바꿨습니다: ${r.renamed.map((x) => `«${x.from}» → ${x.to}`).join(", ")}`);

    const same = fileRows === r.rows;
    const preview = await db.run(`SELECT * FROM ${db.quoteIdent(table)} LIMIT 20`);
    card.innerHTML = `
      <td>${esc(file.name)}</td>
      <td><code class="inline">${esc(table)}</code></td>
      <td>${r.replaced ? "기존 테이블 교체" : "새 테이블"}</td>
      <td class="num">${fileRows.toLocaleString()}</td>
      <td class="num">${r.rows.toLocaleString()}</td>
      <td class="${same ? "res-ok" : "res-bad"}">${same ? "✓ 일치" : "✕ 불일치 — 이 테이블의 결과는 사용하지 마세요"}</td>
      <td>${notes.length ? `<ul class="issues">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : '<span class="null">—</span>'}</td>
      <td><button type="button" class="btn small link pv-toggle" aria-expanded="false">미리보기</button></td>`;
    const pv = document.createElement("tr");
    pv.className = "detail-row";
    pv.hidden = true;
    // payroll 은 직원별 급여 금액이 보이므로 시연용 잠금을 건다
    const isPay = table === "payroll";
    const paintPv = () => {
      pv.innerHTML = `<td colspan="8">
        <p class="cols-head">컬럼 ${r.columns.length}개 · 처음 20행</p>
        <p class="note">${r.columns.map((c) => `${esc(c.name)} (${esc(c.type)})`).join(", ")}</p>
        ${isPay && !isPayUnlocked() ? payLockPanel("직원별 급여 금액 미리보기") : renderTable(preview, 20)}</td>`;
    };
    paintPv();
    if (isPay) window.addEventListener("paylock-changed", paintPv);
    card.after(pv);
    card.querySelector(".pv-toggle").addEventListener("click", (e) => {
      pv.hidden = !pv.hidden;
      e.currentTarget.setAttribute("aria-expanded", String(!pv.hidden));
    });
  } catch (e) {
    card.innerHTML = `<td>${esc(file.name)}</td><td>—</td><td class="st-error" colspan="6">적용하지 못했습니다: ${esc(e.message)}</td>`;
  }
}

/** 적용 결과 표의 tbody(처음이면 만든다). */
function resultsBody() {
  let tbody = $("file-results").querySelector("tbody");
  if (!tbody) {
    $("file-results").innerHTML = `<div class="table-scroll auto"><table class="grid">
      <thead><tr><th>파일명</th><th>연결 테이블</th><th>처리</th><th class="num">파일 행 수</th><th class="num">적재 행 수</th><th>결과</th><th>안내</th><th></th></tr></thead>
      <tbody></tbody></table></div>`;
    tbody = $("file-results").querySelector("tbody");
  }
  return tbody;
}

/** 필요한 파일 목록: 기본 테이블 6개와 지금 적용된 데이터, 그 밖에 올린 테이블. */
function renderRequired() {
  const rows = db.BASE_TABLES.map((t) => {
    const r = db.registry.get(t);
    const state = !r ? '<span class="st-idle">로딩 전</span>'
      : r.kind === "upload" ? '<span class="tag warn">업로드 파일 적용</span>' : '<span class="tag">기본 데이터</span>';
    const check = r ? (r.fileRows === r.rows ? '<span class="res-ok">✓</span>' : '<span class="res-bad">✕</span>') : "";
    return `<tr><td>${esc(t)}.csv / ${esc(t)}.xlsx</td><td><code class="inline">${esc(t)}</code></td>
      <td>${r ? esc(r.source) : "—"}</td><td class="num">${r ? r.rows.toLocaleString() : "—"}</td><td>${state} ${check}</td></tr>`;
  });
  const extra = [...db.registry.values()].filter((r) => !db.BASE_TABLES.includes(r.name)).map((r) =>
    `<tr><td>(추가) ${esc(r.source)}</td><td><code class="inline">${esc(r.name)}</code></td><td>${esc(r.source)}</td>
      <td class="num">${r.rows.toLocaleString()}</td><td><span class="tag warn">추가 테이블</span> ${r.fileRows === r.rows ? '<span class="res-ok">✓</span>' : '<span class="res-bad">✕</span>'}</td></tr>`);
  $("file-required").innerHTML = `<div class="table-scroll auto"><table class="grid">
    <thead><tr><th>파일명</th><th>연결 테이블</th><th>현재 데이터</th><th class="num">행 수</th><th>상태</th></tr></thead>
    <tbody>${rows.concat(extra).join("")}</tbody></table></div>`;
}

async function handleFiles(list) {
  for (const f of list) await handleFile(f); // 한 번에 여러 개도 하나씩 차례로
}

export function setup() {
  window.addEventListener("tables-changed", renderRequired);
  renderRequired();
  const zone = $("drop-zone");
  const input = $("file-input");
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") input.click();
  });
  input.addEventListener("change", async () => {
    await handleFiles([...input.files]);
    input.value = "";
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    handleFiles([...e.dataTransfer.files]);
  });
}

export function setReady(ready) {
  $("drop-zone").classList.toggle("disabled", !ready);
  $("file-input").disabled = !ready;
}
