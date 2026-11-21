// 정기 리포트 탭: questions/prepared.json 의 검증된 SQL을 «조회»로 지금 올라와 있는 데이터에 실행한다.
// SQL · 검증 기록은 JSON 그대로 쓰고, 화면 표시명만 아래 REPORT_META 로 붙인다.
// AI는 부르지 않는다. 파일을 올려도 자동으로 다시 계산하지 않는다(«데이터 변경» 표시만).
import * as db from "./db.js";
import { esc, biggestChunk, chunkSentence, metricList } from "./explain.js";
import { renderTable } from "./ask.js";
import { getSchema } from "./api.js";

const $ = (id) => document.getElementById(id);

/** 화면 표시명. SQL과 계산 기준은 prepared.json 그대로다. */
const REPORT_META = {
  "monthly-headcount-cost": { title: "월별 인원 및 인건비 현황" },
  "monthly-overtime": { title: "월별 1인당 초과근로시간 현황" },
  "monthly-leavers": { title: "월별 퇴사자 추이" },
  "time-to-hire": { title: "공고 유형별 평균 채용 소요기간" },
};
const titleOf = (q) => REPORT_META[q.id]?.title || q.question;

let questions = [];
let selected = null;
let ready = false;
/** id → {status: idle|running|done|error, at, res, drill, drillError, error, stamp, sources, uploaded} */
const state = new Map();

const stamp = (tables) =>
  tables.map((t) => {
    const r = db.registry.get(t);
    return r ? `${t}:${r.source}:${r.rows}:${r.loadedAt.getTime()}` : `${t}:없음`;
  }).join("|");

const sourcesOf = (tables) =>
  tables.map((t) => {
    const r = db.registry.get(t);
    return r ? { table: t, source: r.source, rows: r.rows, upload: r.kind === "upload" } : { table: t, source: "없음", rows: 0, upload: false };
  });

const isStale = (q, s) => s && s.status === "done" && s.stamp !== stamp(q.tables);
const timeOf = (d) => d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** 검증 기록 문자열 "날짜 · 내용" 을 나눈다. */
function parseVerified(v) {
  const s = String(v || "");
  const i = s.indexOf(" · ");
  const recordedRows = (s.match(/(\d+)\s*행/) || [])[1];
  return i < 0 ? { date: "", text: s, recordedRows } : { date: s.slice(0, i), text: s.slice(i + 3), recordedRows };
}

// ── 목록 ──────────────────────────────────────────────
function statusCell(q) {
  const s = state.get(q.id);
  if (!s || s.status === "idle") return '<span class="st-idle">조회 전</span>';
  if (s.status === "running") return '<span class="st-run">조회 중…</span>';
  if (s.status === "error") return '<span class="st-error">오류</span>';
  if (isStale(q, s)) return `<span class="st-stale">데이터 변경 · 재조회 필요</span><span class="small">이전 조회 ${timeOf(s.at)}</span>`;
  const tag = s.uploaded ? '<span class="tag warn">업로드 데이터</span>' : '<span class="tag">기준 데이터</span>';
  return `<span class="st-done">완료 · ${s.res.rows.length.toLocaleString()}행 · ${timeOf(s.at)}</span> ${tag}`;
}

function renderList() {
  if (!questions.length) {
    $("saved-list").innerHTML = '<p class="empty">등록된 정기 리포트가 없습니다.</p>';
    return;
  }
  const rows = questions.map((q) => {
    const s = state.get(q.id);
    const canDetail = s && (s.status === "done" || s.status === "error");
    return `
    <tr class="${selected === q.id ? "selected" : ""}" data-id="${esc(q.id)}">
      <td class="name">${esc(titleOf(q))}</td>
      <td data-label="주요 지표">${esc(q.metrics_used.join(", "))}</td>
      <td data-label="조회 기준">${esc(q.filters.join(" · "))}<span class="small">${esc(q.tables.join(", "))}</span></td>
      <td data-label="결과 상태">${statusCell(q)}</td>
      <td class="actions">
        <button type="button" class="btn small rerun" data-id="${esc(q.id)}" ${ready && s?.status !== "running" ? "" : "disabled"}>조회</button>
        <button type="button" class="btn small link show" data-id="${esc(q.id)}" ${canDetail ? "" : "disabled"}>상세 보기</button>
      </td>
    </tr>`;
  }).join("");
  $("saved-list").innerHTML = `
    <div class="table-scroll auto stack-wrap"><table class="grid stack">
      <thead><tr><th>리포트명</th><th>주요 지표</th><th>조회 기준</th><th>결과 상태</th><th class="num">작업</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// ── KPI ──────────────────────────────────────────────
function prevMonth(m) {
  const [y, mo] = String(m).split("-").map(Number);
  if (!y || !mo) return null;
  const d = new Date(y, mo - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
const n = (v, d = 0) => Number(v).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v, d = 0) => (v > 0 ? "+" : v < 0 ? "−" : "±") + n(Math.abs(v), d);

/** 리포트 결과에서 월 행을 찾는다. 결과에 '월' 컬럼이 없으면 null. */
function rowsByMonth(id) {
  const s = state.get(id);
  if (!s || s.status !== "done" || !s.res.columns.some((c) => c.name === "월")) return null;
  return { s, map: new Map(s.res.rows.map((r) => [r["월"], r])), last: s.res.rows[s.res.rows.length - 1] };
}

function kpiItem({ label, title, id, month, col, unit, digits = 0, scale = 1 }) {
  const q = questions.find((x) => x.id === id);
  const data = q && rowsByMonth(id);
  const row = data && (month ? data.map.get(month) : data.last);
  if (!data || !row || typeof row[col] !== "number") {
    const why = data && month && !row ? `${month} 결과 없음` : "조회 전";
    return `<div class="kpi-item" title="${esc(title)}"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">—</div><div class="kpi-sub">${why}</div></div>`;
  }
  const m = row["월"];
  const prev = data.map.get(prevMonth(m));
  const val = row[col] / scale;
  const delta = prev && typeof prev[col] === "number" ? ` · 전월 대비 ${signed(val - prev[col] / scale, digits)}` : "";
  const stale = isStale(q, data.s);
  const sub = stale ? `${m} · 데이터 변경 · 재조회 필요` : `${m}${delta}${data.s.uploaded ? " · 업로드 데이터" : ""}`;
  return `<div class="kpi-item${stale ? " stale" : ""}" title="${esc(title)}">
    <div class="kpi-label">${esc(label)}</div>
    <div class="kpi-value">${n(val, digits)}<small>${esc(unit)}</small></div>
    <div class="kpi-sub">${esc(sub)}</div></div>`;
}

async function renderKpi() {
  const schema = await getSchema();
  const def = (name) => (schema.metrics || []).find((m) => m.name === name)?.definition || "";
  // 기준월 = 인원 · 인건비 리포트의 마지막 월. 퇴사자는 같은 월의 행을 쓴다.
  const hc = rowsByMonth("monthly-headcount-cost");
  const baseMonth = hc?.last?.["월"];
  $("kpi").innerHTML = [
    kpiItem({ label: "월 인원", title: `월 인원: ${def("월 인원")}`, id: "monthly-headcount-cost", col: "인원", unit: "명" }),
    kpiItem({ label: "월 인건비", title: `인건비: ${def("인건비")}`, id: "monthly-headcount-cost", col: "인건비", unit: "백만원", digits: 1, scale: 1e6 }),
    kpiItem({ label: "월 퇴사자 수", title: `퇴사자 수: ${def("퇴사자 수")}`, id: "monthly-leavers", month: baseMonth, col: "퇴사자수", unit: "명" }),
    kpiItem({ label: "1인당 초과근로시간", title: `1인당 초과근로: ${def("1인당 초과근로")}`, id: "monthly-overtime", col: "일인당_초과근로", unit: "시간", digits: 2 }),
  ].join("");
}

// ── 상세 ──────────────────────────────────────────────
async function renderDetail() {
  const q = questions.find((x) => x.id === selected);
  const box = $("report-detail");
  const s = q && state.get(q.id);
  if (!q || !s || s.status === "idle") {
    box.innerHTML = "";
    return;
  }
  const schema = await getSchema();
  if (s.status === "running") {
    box.innerHTML = `<section class="detail"><div class="detail-head"><h2>${esc(titleOf(q))}</h2><span class="meta">조회 중…</span></div></section>`;
    return;
  }
  const stale = isStale(q, s);
  const head = `<div class="detail-head"><h2>${esc(titleOf(q))}</h2>
    <span class="meta">${s.status === "done" ? `조회 ${s.at.toLocaleString("ko-KR")} · ${s.res.rows.length.toLocaleString()}행` : "조회 실패"}${stale ? " · 이후 데이터가 변경됨" : ""}</span></div>`;

  if (s.status === "error") {
    box.innerHTML = `<section class="detail">${head}
      <p class="msg error">${s.error.blocked ? "실행 전에 차단했습니다" : "실행 오류"}: ${esc(s.error.message)}</p>
      <details class="sql"><summary>SQL 보기</summary><pre>${esc(q.sql)}</pre></details></section>`;
    return;
  }

  const src = s.sources.map((x) => `${esc(x.table)} — ${esc(x.source)} (${x.rows.toLocaleString()}행)${x.upload ? ' <span class="tag warn">업로드</span>' : ""}`).join("<br>");
  let drillHtml = "";
  if (q.drill) {
    drillHtml = s.drillError
      ? `<tr><th>원인 분석</th><td>${esc(q.drill.title)}<p class="msg error">${esc(s.drillError)}</p></td></tr>`
      : `<tr><th>원인 분석</th><td>${esc(q.drill.title)}
          <p class="finding"><b>최대 기여 항목</b>${esc(chunkSentence(biggestChunk(s.drill, q.drill.measure_column, q.drill.split_by)))}</p>
          ${renderTable(s.drill, 50)}</td></tr>`;
  }

  const v = parseVerified(q.verified);
  let verdict;
  if (s.uploaded) {
    verdict = '<span class="tag warn">미검증</span> 업로드한 데이터로 조회했습니다. 이 결과는 별도로 검증되지 않았습니다.';
  } else if (v.recordedRows && Number(v.recordedRows) !== s.res.rows.length) {
    verdict = `<span class="tag warn">확인 필요</span> 기준 데이터로 조회했지만 행 수(${s.res.rows.length})가 검증 기록(${v.recordedRows}행)과 다릅니다.`;
  } else {
    verdict = `<span class="tag ok">기준 데이터</span> 검증 기록과 같은 기준 데이터(data/)로 조회했습니다.${v.recordedRows ? ` 행 수 ${s.res.rows.length}행이 기록과 같습니다.` : ""}`;
  }

  box.innerHTML = `
    <section class="detail">
      ${head}
      <h3 class="sec">조회 결과</h3>
      ${renderTable(s.res, 500, { tall: true })}

      <section class="block">
        <h3 class="sec">계산 기준 및 해석</h3>
        <table class="kv"><tbody>
          <tr><th>사용 데이터</th><td>${src}</td></tr>
          <tr><th>조회 조건</th><td>${esc(q.filters.join(" · "))}</td></tr>
          <tr><th>지표 정의</th><td>${metricList(q.metrics_used, schema)}</td></tr>
          ${drillHtml}
        </tbody></table>
      </section>

      <section class="block">
        <h3 class="sec">검증 정보</h3>
        <table class="kv"><tbody>
          <tr><th>이번 조회</th><td>${verdict}</td></tr>
          <tr><th>검증일</th><td>${esc(v.date || "—")}</td></tr>
          <tr><th>검증 기록</th><td>${esc(v.text || "—")}</td></tr>
        </tbody></table>
      </section>

      <details class="sql"><summary>SQL 보기</summary>
        <pre>${esc(q.sql)}</pre>
        ${q.drill ? `<p class="note">원인 분석 SQL — ${esc(q.drill.title)}</p><pre>${esc(q.drill.sql)}</pre>` : ""}
      </details>
    </section>`;
}

function renderAll() {
  renderList();
  renderKpi();
  renderDetail();
}

// ── 조회 ──────────────────────────────────────────────
async function rerun(q, { show = true } = {}) {
  if (show) selected = q.id;
  state.set(q.id, { ...(state.get(q.id) || {}), status: "running" });
  renderAll();
  const next = { status: "done", at: new Date(), stamp: stamp(q.tables), sources: sourcesOf(q.tables) };
  next.uploaded = next.sources.some((x) => x.upload);
  try {
    next.res = await db.run(q.sql);
    next.at = new Date();
    if (q.drill) {
      try {
        next.drill = await db.run(q.drill.sql);
      } catch (e) {
        next.drillError = `${e.blocked ? "실행 전에 차단했습니다" : "실행 오류"}: ${e.message}`;
      }
    }
  } catch (e) {
    next.status = "error";
    next.error = e;
  }
  state.set(q.id, next);
  renderAll();
}

async function runAll() {
  $("run-all").disabled = true;
  try {
    for (const q of questions) await rerun(q, { show: false });
    if (!selected && questions.length) selected = questions[0].id;
    renderAll();
  } finally {
    $("run-all").disabled = !ready;
  }
}

export async function setup() {
  const res = await fetch("questions/prepared.json");
  questions = res.ok ? await res.json() : [];
  $("saved-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-id]");
    if (!btn) return;
    const q = questions.find((x) => x.id === btn.dataset.id);
    if (btn.classList.contains("rerun")) rerun(q);
    else if (btn.classList.contains("show")) {
      selected = q.id;
      renderAll();
      $("report-detail").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
  $("run-all").addEventListener("click", runAll);
  window.addEventListener("tables-changed", renderAll); // 표시만 갱신, 재계산 없음
  renderAll();
}

export function setReady(r) {
  ready = r;
  $("run-all").disabled = !r;
  renderList();
}
