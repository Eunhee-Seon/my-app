// 내 파일 탭: CSV · xlsx 를 브라우저 안에서 읽어 테이블로 올린다. 파일은 서버로 보내지 않는다.
import * as db from "./db.js";
import { esc } from "./explain.js";
import { renderTable } from "./ask.js";

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
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h3>${esc(file.name)}</h3><p class="hint">읽는 중…</p>`;
  $("file-results").prepend(card);
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
      <h3>${esc(file.name)} → 테이블 <code>${esc(table)}</code>
        <span class="badge ${r.replaced ? "warn" : "ok"}">${r.replaced ? "기존 테이블을 바꿈" : "새 테이블"}</span></h3>
      ${notes.length ? `<ul class="issues">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      <table class="counts"><tr>
        <td>파일에서 읽은 행 수 <b>${fileRows.toLocaleString()}</b></td>
        <td>테이블에 올라간 행 수 <b>${r.rows.toLocaleString()}</b></td>
        <td class="${same ? "ok" : "bad"}">${same ? "✓ 같음" : "✕ 다름 — 이 테이블의 결과는 믿지 마세요"}</td>
      </tr></table>
      <p class="hint">컬럼 ${r.columns.length}개: ${r.columns.map((c) => `${esc(c.name)} (${esc(c.type)})`).join(", ")}</p>
      <p class="hint">처음 20행</p>
      ${renderTable(preview, 20)}`;
  } catch (e) {
    card.innerHTML = `<h3>${esc(file.name)}</h3><p class="msg error">올리지 못했습니다: ${esc(e.message)}</p>`;
  }
}

async function handleFiles(list) {
  for (const f of list) await handleFile(f); // 한 번에 여러 개도 하나씩 차례로
}

export function setup() {
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
