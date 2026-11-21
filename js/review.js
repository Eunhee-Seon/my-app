// 검토 항목: 탐지된 항목 목록 · 필터 · 상세(검토 근거) · 조치 기록 입력.
// 이 화면은 검토 근거를 확인하는 용도이며, 성과평가나 인사상 결정을 위한 화면이 아니다.
import * as db from "./db.js";
import * as M from "./metrics.js";
import { chart, COLORS } from "./charts.js";
import { renderTable } from "./ask.js";
import { esc } from "./explain.js";
import { detect, isStale, lastResult, missingTables } from "./detect.js";
import { criterion, paramsText, STATUSES, getAction, statusOf, saveAction, firstSeen, storage, calcRules } from "./store.js";
import { onTab } from "./nav.js";
import { isPayUnlocked, payLockPanel } from "./paylock.js";

const $ = (id) => document.getElementById(id);
const PAGE = 50;
let ready = false;
let filter = { ym: "__latest__", dept: "", category: "", rule: "", status: "", q: "" };
let page = 0;
let selectedId = null;
let items = [];

const CATEGORIES = ["운영 기준 초과", "통계적 이상치", "데이터 품질"];
/** 목록에 쓰는 짧은 검토 유형명 (전체 조건명 · 분류는 상세에 표시) */
const SHORT = {
  ot_over: "초과근로 기준 초과", ot_spike: "초과근로 전월 대비 급증", ot_consec: "초과근로 연속 증가", ot_dept_outlier: "부서 내 초과근로 편차",
  dept_attrition: "부서 퇴사율 기준 초과", pay_change: "급여 지급액 급변", att_dq: "근태 데이터 품질", pay_dq: "급여 데이터 품질",
};
const OT_RULES = ["ot_over", "ot_spike", "ot_consec", "ot_dept_outlier"];

const PROCEDURES = {
  ot: ["업무 집중 기간(마감 · 시즌 등) 여부 확인", "관리자와 업무 배분 현황 점검", "근로시간 운영 및 승인 절차 확인", "필요한 경우 업무 재배분 검토", "다음 달 초과근로시간 재확인"],
  dept_attrition: ["조직별 퇴사 현황 확인", "퇴사 사유 분포 검토", "조직 운영상 공통 원인 존재 여부 확인", "필요 시 조직 차원의 개선 방안 검토"],
  pay_change: ["지급 일정 · 상여 반영 여부 확인 (데이터 사전 회사 규칙 참고)", "급여 항목별 증감 확인", "급여 담당자에게 지급 내역 확인 요청", "확인 결과와 재검증 결과 기록"],
  dq: ["원본 기록 확인", "데이터 입력 기준 점검", "담당자 확인 요청", "수정 이력 및 재검증 결과 기록"],
};
const UNKNOWN = {
  ot: ["실제 업무량 · 프로젝트 배정", "초과근로 사전 승인 여부", "업무 집중 기간(마감 · 시즌) 여부", "휴가 잔여일수", "개인의 건강 상태", "성과 · 근무 태도", "근무 일정(교대 · 탄력근무 등)", "과거 조직 이동 이력 (현재 부서만 있음)", "근무 기록이 없는 날의 사유 (휴일 · 휴가 · 휴직 구분 불가)"],
  dept_attrition: ["퇴사 면담 내용", "조직 개편 · 관리자 변경 이력", "보상 수준의 시장 비교", "퇴사자의 과거 소속 부서 (현재 기록만 있음)", "채용 · 충원 계획"],
  pay_change: ["급여 규정 · 지급 기준표", "회사 부담 보험료 · 퇴직급여 (파일에 없음)", "소급 지급 · 정산 여부", "개인별 지급 사유"],
  dq: ["원본 시스템의 입력 · 수정 이력", "입력 담당자 확인 결과", "근태 시스템과 급여 시스템의 연동 기준"],
};
const kindOf = (it) => (OT_RULES.includes(it.rule) ? "ot" : it.category === "데이터 품질" ? "dq" : it.rule);

function months() {
  return [...new Set(items.map((i) => i.ym))].filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();
}
function effectiveYm() {
  if (filter.ym !== "__latest__") return filter.ym;
  const ms = months();
  return ms[ms.length - 1] || "";
}
function filtered() {
  const ymSel = effectiveYm();
  const q = filter.q.trim().toUpperCase();
  return items.filter((it) =>
    (!ymSel || ymSel === "__all__" || it.ym === ymSel) &&
    (!filter.dept || it.dept === filter.dept) &&
    (!filter.category || it.category === filter.category) &&
    (!filter.rule || it.rule === filter.rule) &&
    (!filter.status || statusOf(it.id) === filter.status) &&
    (!q || String(it.target).toUpperCase().includes(q)));
}

/** 다른 화면에서 필터를 정해 들어올 때 */
export function openReviewWith(f) {
  filter = { ym: "__latest__", dept: "", category: "", rule: "", status: "", q: "", ...f };
  page = 0;
  selectedId = null;
  if (items.length) renderAll();
}
/** 조치 현황에서 항목 상세로 들어올 때 */
export function openItem(id) {
  selectedId = id;
  const it = items.find((x) => x.id === id);
  if (it) filter = { ym: it.ym, dept: "", category: "", rule: "", status: "", q: String(it.target) };
  const idx = filtered().findIndex((x) => x.id === id);
  page = idx > 0 ? Math.floor(idx / PAGE) : 0;
  if (items.length) renderAll();
}

async function compute(force = false) {
  const box = $("review-body");
  const miss = missingTables();
  if (miss.length) { box.innerHTML = `<p class="msg error">필요한 테이블이 없습니다: ${esc(miss.join(", "))}</p>`; return; }
  box.innerHTML = '<p class="msg">검토 항목을 계산하는 중…</p>';
  try {
    const r = await detect({ force });
    items = r.items;
    $("review-stale").hidden = true;
    renderAll();
  } catch (e) {
    box.innerHTML = `<p class="msg error">계산 오류: ${esc(e.message)}</p>`;
  }
}

function options(list, sel, all = "전체") {
  return `<option value="">${all}</option>` + list.map((v) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(v)}</option>`).join("");
}

function renderAll() {
  const res = lastResult();
  const ms = months();
  const ymSel = effectiveYm();
  const depts = [...new Set(items.map((i) => i.dept).filter((d) => d && d !== "—"))].sort();
  const rules = [...new Set(items.map((i) => i.rule))];
  const list = filtered();
  const empCount = new Set(list.filter((i) => i.targetType !== "조직" && i.empId).map((i) => i.empId)).size;
  const orgCount = list.filter((i) => i.targetType === "조직").length;
  const byCat = CATEGORIES.map((c) => `${c} ${list.filter((i) => i.category === c).length.toLocaleString()}`).join(" · ");
  const byStatus = STATUSES.map((s) => [s, list.filter((i) => statusOf(i.id) === s).length]).filter(([, n]) => n).map(([s, n]) => `${s} ${n.toLocaleString()}`).join(" · ");
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  if (page >= pages) page = pages - 1;
  const slice = list.slice(page * PAGE, page * PAGE + PAGE);
  if (selectedId && !slice.some((x) => x.id === selectedId)) selectedId = null; // 보이지 않는 항목의 상세는 접는다

  $("review-body").innerHTML = `
    <div class="filters">
      <label>기간<select id="f-ym"><option value="__all__" ${ymSel === "__all__" ? "selected" : ""}>전체 기간</option>${ms.slice().reverse().map((m) => `<option ${m === ymSel ? "selected" : ""}>${m}</option>`).join("")}${items.some((i) => i.ym === "날짜없음") ? '<option value="날짜없음">날짜없음</option>' : ""}</select></label>
      <label>부서<select id="f-dept">${options(depts, filter.dept)}</select></label>
      <label>유형<select id="f-cat">${options(CATEGORIES, filter.category)}</select></label>
      <label>검토 조건<select id="f-rule"><option value="">전체</option>${rules.map((r) => `<option value="${r}" ${r === filter.rule ? "selected" : ""}>${esc(criterion(r)?.name || r)}</option>`).join("")}</select></label>
      <label>상태<select id="f-status">${options(STATUSES, filter.status)}</select></label>
      <label>대상 검색<input id="f-q" type="text" value="${esc(filter.q)}" placeholder="사번 · 부서"></label>
    </div>
    <dl class="counts-line">
      <div><dt>검토 항목</dt><dd>${list.length.toLocaleString()}건</dd></div>
      <div><dt>대상 직원</dt><dd>${empCount.toLocaleString()}명</dd></div>
      <div><dt>조직 항목</dt><dd>${orgCount.toLocaleString()}건</dd></div>
      <div><dt>유형별</dt><dd>${byCat}</dd></div>
      <div><dt>상태별</dt><dd>${byStatus || "—"}</dd></div>
    </dl>
    <p class="note">계산 ${res ? res.ranAt.toLocaleString("ko-KR") : "—"} · 한 직원이 여러 조건에 해당하면 항목이 여러 건입니다. 검토 항목은 확인할 근거이며 위반이나 문제로 판정한 것이 아닙니다.</p>
    ${list.length ? `
    <div class="table-scroll auto"><table class="grid review-list">
      <colgroup><col class="c-target"><col class="c-dept"><col class="c-type"><col class="c-ym"><col class="c-actual"><col class="c-diff"><col class="c-status"></colgroup>
      <thead><tr><th>직원 ID / 대상</th><th>부서</th><th>검토 유형</th><th>대상 월</th><th class="num">실제값</th><th class="num">기준 대비 차이</th><th>처리 상태</th></tr></thead>
      <tbody>${slice.map((it) => {
        const open = it.id === selectedId;
        return `
        <tr class="row${open ? " open" : ""}" tabindex="0" data-id="${esc(it.id)}" aria-expanded="${open}" title="${esc(`${it.category} · ${it.ruleName}`)}">
          <td class="target">${esc(it.target)}</td>
          <td data-label="부서">${esc(it.dept || "—")}</td>
          <td class="type" data-label="검토 유형">${esc(SHORT[it.rule] || it.ruleName)}</td>
          <td data-label="대상 월">${esc(it.ym)}</td>
          <td class="num" data-label="실제값">${esc(it.actualText)}</td>
          <td class="num" data-label="기준 대비">${esc(it.diffText)}</td>
          <td data-label="처리 상태">${statusTag(statusOf(it.id))}</td>
        </tr>${open ? `<tr class="detail-row"><td colspan="7"><div id="review-detail"></div></td></tr>` : ""}`;
      }).join("")}</tbody>
    </table></div>
    <div class="pager">
      <button type="button" class="btn small" id="pg-prev" ${page === 0 ? "disabled" : ""}>이전</button>
      <span>${page + 1} / ${pages} 쪽 · ${(page * PAGE + 1).toLocaleString()}–${Math.min(list.length, (page + 1) * PAGE).toLocaleString()} / ${list.length.toLocaleString()}건</span>
      <button type="button" class="btn small" id="pg-next" ${page >= pages - 1 ? "disabled" : ""}>다음</button>
    </div>` : '<p class="empty">조건에 맞는 검토 항목이 없습니다.</p>'}`;

  const set = (k) => (e) => { filter[k] = e.target.value; page = 0; renderAll(); };
  $("f-ym").addEventListener("change", set("ym"));
  $("f-dept").addEventListener("change", set("dept"));
  $("f-cat").addEventListener("change", set("category"));
  $("f-rule").addEventListener("change", set("rule"));
  $("f-status").addEventListener("change", set("status"));
  $("f-q").addEventListener("change", set("q"));
  $("pg-prev")?.addEventListener("click", () => { page--; renderAll(); });
  $("pg-next")?.addEventListener("click", () => { page++; renderAll(); });
  // 행을 누르면 그 아래에 상세가 펼쳐지고, 같은 행을 다시 누르면 접힌다(한 번에 하나만)
  const toggle = (id) => {
    selectedId = selectedId === id ? null : id;
    renderAll();
    if (selectedId) document.querySelector("#review-body tr.row.open")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  $("review-body").querySelectorAll("tr.row").forEach((tr) => {
    tr.addEventListener("click", () => toggle(tr.dataset.id));
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(tr.dataset.id); } });
  });
  if (selectedId) renderDetail(items.find((x) => x.id === selectedId));
}

/** 처리 상태 표시: 배지 없이 글자색만 */
export function statusTag(s) {
  return `<span class="st st-${esc(String(s).replace(/\s/g, ""))}">${esc(s)}</span>`;
}

// ── 상세 ──────────────────────────────────────────────
let detailSeq = 0;
let flash = { id: null, text: "" };
async function renderDetail(it) {
  const seq = ++detailSeq; // 그리는 도중 다시 그려지면 앞선 작업은 버린다
  const box = $("review-detail");
  if (!box) return;
  if (!it) { box.innerHTML = ""; return; }
  box.innerHTML = '<p class="msg">상세 정보를 불러오는 중…</p>';
  const kind = kindOf(it);
  const c = criterion(it.rule);
  const seen = firstSeen(it.id);
  const parts = [];
  const charts = [];
  const flags = [it.subtype ? `분류: ${it.subtype}` : "", it.smallDept ? `소규모 부서(${it.dept_n}명) — 평균 · 분포 비교의 해석에 주의` : ""].filter(Boolean);
  parts.push(section("검토 조건 · 기준값 · 실제값 · 발견 사유", diffTable(it, c, seen) + (flags.length ? `<ul class="facts">${flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : "")));
  const payKind = it.rule === "pay_change" || it.rule === "pay_dq";

  if (payKind && !isPayUnlocked()) {
    parts.push(section("급여 관련 상세", payLockPanel("급여 관련 상세 정보")));
  } else if (it.empId && kind === "ot") {
    const emp = await db.run(M.sqlEmployee(it.empId));
    const from = M.addMonths(it.ym, -5);
    const win = await db.run(M.sqlEmpOtWindow(it.empId, from, it.ym));
    const dist = await db.run(M.sqlEmpDeptDist(it.empId, it.ym));
    const raw = await db.run(M.sqlEmpAttendanceRows(it.empId, it.ym));
    const d = dist.rows[0] || {};
    const related = items.filter((x) => x.empId === it.empId && x.ym >= from && x.ym <= it.ym && x.category !== "데이터 품질");
    parts.push(section(`최근 6개월 초과근로 추이 (${from} ~ ${it.ym})`, `<div class="chart-box" id="d-chart"></div><details class="sql"><summary>표로 보기</summary>${renderTable(win, 12)}</details>`, M.sqlEmpOtWindow(it.empId, from, it.ym), "근무기록일수가 다른 달과 크게 다르면(입사 · 퇴사 · 휴가) 월 합계를 그대로 비교하기 어렵습니다."));
    charts.push(() => chart($("d-chart"), {
      type: "line", title: "최근 6개월 초과근로", labels: win.rows.map((r) => r["월"]),
      series: [{ name: `${it.empId} (선택한 직원)`, values: win.rows.map((r) => r["본인_초과근로"]), color: COLORS.highlight },
               { name: "부서 평균", values: win.rows.map((r) => r["부서_평균"]), color: COLORS.compare, dashed: true }],
      unit: "시간", threshold: { value: criterion("ot_over").params.value, label: `시범 기준 ${criterion("ot_over").params.value}시간` },
    }));
    parts.push(section(`부서 평균 및 분포와 비교 (${it.ym})`, renderTable(dist, 1) +
      (d["부서_인원"] < criterion("ot_dept_outlier").params.smallN ? `<p class="msg error">부서 인원이 ${d["부서_인원"]}명으로 적어 평균 · 분포 비교의 해석에 주의가 필요합니다.</p>` : ""),
      M.sqlEmpDeptDist(it.empId, it.ym), "같은 부서(현재 부서) · 같은 월의 근태 기록이 있는 직원과 비교합니다."));
    parts.push(section("같은 기간에 탐지된 검토 조건", miniList(related)));
    parts.push(section("직원 ID와 기본 조직정보", kvTable(emp.rows[0] || {}), M.sqlEmployee(it.empId), "급여 금액은 이 화면에 표시하지 않습니다. 부서는 현재 기록 기준입니다."));
    parts.push(section(`관련 원본 데이터 (attendance · ${it.ym} · ${raw.rows.length}일)`, renderTable(raw, 40), M.sqlEmpAttendanceRows(it.empId, it.ym), "근무 기록이 없는 날은 결근으로 판단하지 않습니다(휴일 · 휴가 · 휴직 정보 부족)."));
  } else if (kind === "dept_attrition") {
    const trend = await db.run(`WITH a AS (${M.sqlAttritionRolling(calcRules())}) SELECT 월, 평균_월말재직, 퇴사자_12개월, 퇴사율_pct FROM a WHERE 부서 = '${it.dept.replace(/'/g, "''")}' ORDER BY 1`);
    const from = M.addMonths(it.ym, -11);
    const leaversSql = `SELECT emp_id AS 사번, job_family AS 직무, grade AS 직급, employment_type AS 고용형태, hire_date AS 입사일, leave_date AS 퇴사일, leave_reason AS 퇴사사유
FROM employees WHERE dept = '${it.dept.replace(/'/g, "''")}' AND leave_date BETWEEN strptime('${from}-01', '%Y-%m-%d')::DATE AND last_day(strptime('${it.ym}-01', '%Y-%m-%d')::DATE) ORDER BY leave_date`;
    const leavers = await db.run(leaversSql);
    const reasons = {};
    for (const r of leavers.rows) reasons[r["퇴사사유"] || "(사유 없음)"] = (reasons[r["퇴사사유"] || "(사유 없음)"] || 0) + 1;
    parts.push(section("대상 조직", kvTable({ 부서: it.dept, 대상_기간: `${from} ~ ${it.ym} (12개월)`, 산식: "12개월 퇴사자 수 ÷ 평균 월말 재직 인원 × 100", 한계: "employees.dept(현재 · 퇴사 시점 기록) 기준, 조직 이동 이력 없음" })));
    parts.push(section("12개월 퇴사율 추이", `<div class="chart-box" id="d-chart"></div><details class="sql"><summary>표로 보기</summary>${renderTable(trend, 24)}</details>`));
    charts.push(() => chart($("d-chart"), { type: "line", title: "12개월 퇴사율", labels: trend.rows.map((r) => r["월"]), series: [{ name: `${it.dept} 퇴사율`, values: trend.rows.map((r) => r["퇴사율_pct"]), color: COLORS.primary }], unit: "%", threshold: { value: c.params.value, label: `시범 기준 ${c.params.value}%` } }));
    parts.push(section("퇴사 사유 분포 (같은 12개월)", renderTable({ columns: [{ name: "퇴사사유" }, { name: "인원" }], rows: Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ 퇴사사유: k, 인원: v })) }, 10)));
    parts.push(section(`관련 원본 데이터 (employees · 퇴사자 ${leavers.rows.length}명)`, renderTable(leavers, 60), leaversSql));
  } else if (kind === "pay_change") {
    const prev = M.addMonths(it.ym, -1);
    const itemsSql = `SELECT pay_item AS 급여항목,
  SUM(amount) FILTER (WHERE pay_month = '${prev}') AS 전월_지급액, SUM(amount) FILTER (WHERE pay_month = '${it.ym}') AS 당월_지급액,
  SUM(amount) FILTER (WHERE pay_month = '${it.ym}') - SUM(amount) FILTER (WHERE pay_month = '${prev}') AS 증감
FROM payroll WHERE pay_month IN ('${prev}', '${it.ym}') GROUP BY 1 ORDER BY abs(증감) DESC`;
    const byItem = await db.run(itemsSql);
    const trend = await db.run(M.sqlPayTrend());
    const rules = (await (await fetch("schema.json")).json()).rules || [];
    parts.push(section("대상", kvTable({ 대상: "회사 전체 월 급여 지급액 (payroll 합계, 회사 부담분 미포함)", 대상_월: it.ym, 비교_월: prev })));
    parts.push(section("월별 지급액 증감률", `<div class="chart-box" id="d-chart"></div>`, M.sqlPayTrend()));
    charts.push(() => chart($("d-chart"), { type: "bar", title: "월별 지급액 증감률", labels: trend.rows.map((r) => r["월"]), series: [{ name: "전월 대비", values: trend.rows.map((r) => r["전월대비_pct"]), color: COLORS.primary }], unit: "%", highlightIndex: trend.rows.findIndex((r) => r["월"] === it.ym) }));
    parts.push(section("급여 항목별 증감 (회사 전체 합계)", renderTable(byItem, 10), itemsSql));
    parts.push(section("참고: 데이터 사전 회사 규칙", `<ul class="facts">${rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul><p class="note">규칙과 일치하는 달이라도 원인을 자동으로 확정하지 않습니다. 급여 담당자 확인이 필요합니다.</p>`));
  } else {
    // 데이터 품질
    const isAtt = it.rule === "att_dq";
    const rawSql = isAtt
      ? `SELECT work_date AS 근무일, work_type AS 근무유형, regular_hours AS 정규시간, overtime_hours AS 초과근로 FROM attendance WHERE emp_id = '${String(it.empId).replace(/'/g, "''")}'${/^\d{4}-\d{2}$/.test(it.ym) ? ` AND strftime(work_date, '%Y-%m') = '${it.ym}'` : ""} ORDER BY 1`
      : `SELECT pay_month AS 지급월, pay_item AS 급여항목, CASE WHEN amount IS NULL THEN '누락' WHEN amount < 0 THEN '음수' WHEN amount = 0 THEN '0원' ELSE '양수' END AS 금액_상태 FROM payroll WHERE emp_id = '${String(it.empId).replace(/'/g, "''")}' AND pay_month = '${String(it.ym).replace(/'/g, "''")}' ORDER BY 2`;
    let raw;
    try { raw = await db.run(rawSql); } catch (e) { raw = { columns: [], rows: [] }; }
    let emp = { rows: [] };
    try { emp = await db.run(M.sqlEmployee(it.empId)); } catch { /* 사번 형식 이상 */ }
    parts.push(section("대상", kvTable({ 사번: it.empId, 부서: it.dept, 대상_기간: it.ym, 검사: it.issue, 건수: it.actualText, ...(it.dates ? { 해당_날짜: it.dates } : {}) }) +
      (emp.rows[0] ? "" : '<p class="msg error">직원 목록(employees)에 이 사번이 없습니다.</p>')));
    parts.push(section(`관련 원본 데이터 (${isAtt ? "attendance" : "payroll — 금액은 상태로만 표시"})`, renderTable(raw, 40), rawSql));
  }

  if (seq !== detailSeq || !document.body.contains(box)) return;
  parts.push(section("데이터상 확인할 수 없는 사항", `<ul class="facts">${(UNKNOWN[kind] || UNKNOWN.dq).map((u) => `<li>${esc(u)}</li>`).join("")}</ul>`));
  parts.push(section("HR 검토 및 조치 기록", actionForm(it, kind)));

  box.innerHTML = `<section class="detail">
    <div class="detail-head"><h2>검토 근거 — ${esc(it.target)} · ${esc(it.ym)} · ${esc(it.ruleName)}</h2><span class="meta">${esc(it.category)} · 항목 ID ${esc(it.id)}</span></div>
    <p class="notice">이 화면은 검토 근거를 확인하는 용도입니다. 성과평가나 인사상 불이익을 결정하는 데 쓰지 않으며, 근태 변화만으로 업무 태도 · 성과 · 건강 · 퇴사 가능성을 판단하지 않습니다.</p>
    ${parts.join("")}
  </section>`;
  charts.forEach((fn) => fn());
  bindForm(it);
}

function section(title, body, sql, note) {
  return `<section class="block"><h3 class="sec">${esc(title)}</h3>${body}${note ? `<p class="note">${esc(note)}</p>` : ""}${sql ? `<details class="sql"><summary>SQL 보기</summary><pre>${esc(sql)}</pre></details>` : ""}</section>`;
}
function kvTable(obj) {
  return `<table class="kv"><tbody>${Object.entries(obj).map(([k, v]) => `<tr><th>${esc(k.replace(/_/g, " "))}</th><td>${v === null || v === undefined ? '<span class="null">—</span>' : esc(v)}</td></tr>`).join("")}</tbody></table>`;
}
function miniList(list) {
  if (!list.length) return '<p class="empty">없음</p>';
  return `<div class="table-scroll auto"><table class="data"><thead><tr><th>기간</th><th>검토 조건</th><th>기준값</th><th class="num">실제값</th><th class="num">차이</th><th>상태</th></tr></thead><tbody>
    ${list.sort((a, b) => a.ym.localeCompare(b.ym)).map((x) => `<tr><td>${esc(x.ym)}</td><td>${esc(x.ruleName)}</td><td>${esc(x.thresholdText)}</td><td class="num">${esc(x.actualText)}</td><td class="num">${esc(x.diffText)}</td><td>${statusTag(statusOf(x.id))}</td></tr>`).join("")}
  </tbody></table></div>`;
}
function diffTable(it, c, seen) {
  const rows = {
    검토_조건: `${it.ruleName} (${it.category})`,
    기준: `${paramsText(c)} — ${c.compare}`,
    기준_상태: `${c.pilot ? "시범 기준" : "확정 기준"} · 버전 ${c.version} · 적용 시작 ${c.startDate}`,
    실제값: it.actualText,
    기준값: it.thresholdText,
    기준_대비_차이: it.diffText,
    발견_사유: it.reason,
    최초_탐지: seen ? `${seen.date} (그때 기준 버전 ${seen.version})` : "—",
  };
  const rec = getAction(it.id);
  if (rec?.criterion && rec.criterion.version !== c.version) rows.조치_기록의_기준 = `기록 생성 당시 버전 ${rec.criterion.version} — 현재 기준과 다름`;
  return kvTable(rows);
}

function actionForm(it, kind) {
  const r = getAction(it.id) || {};
  const v = (k, d = "") => esc(r[k] ?? d);
  return `
    <div class="procedure"><p class="cols-head">권장 검토 절차 <span class="sub">참고용 — 원인을 확정하거나 조치를 자동 집행하지 않습니다</span></p>
      <ol>${(PROCEDURES[kind] || PROCEDURES.dq).map((p) => `<li>${esc(p)}</li>`).join("")}</ol></div>
    <form id="act-form" class="act-form" autocomplete="off">
      <label>검토 상태<select name="status">${STATUSES.map((s) => `<option ${s === (r.status || "미확인") ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label>담당자 (미확인 외 필수)<input type="text" name="owner" value="${v("owner")}" placeholder="이름 또는 부서"></label>
      <label>조치 필요 여부 (선택)<select name="needAction">${["", "필요", "불필요", ...(r.needAction === "미정" ? ["미정"] : [])].map((s) => `<option value="${s}" ${s === (r.needAction || "") ? "selected" : ""}>${s || "—"}</option>`).join("")}</select></label>
      <label>조치 예정일<input type="date" name="plannedDate" value="${v("plannedDate")}"></label>
      <label>완료일<input type="date" name="doneDate" value="${v("doneDate")}"></label>
      <label>후속 점검일<input type="date" name="followupDate" value="${v("followupDate")}"></label>
      <label class="wide">확인한 원인 (선택)<textarea name="cause" rows="2">${v("cause")}</textarea></label>
      <label class="wide">조치 내용 (선택)<textarea name="actionText" rows="2">${v("actionText")}</textarea></label>
      <label>종결 사유 (선택)<select name="closeReason">${["", "데이터 오류 확인 · 수정", "확인 결과 조치 불필요", "기타"].map((s) => `<option value="${s}" ${s === (r.closeReason || "") ? "selected" : ""}>${s || "—"}</option>`).join("")}</select></label>
      <label class="wide">최종 판단 근거 (선택)<textarea name="finalBasis" rows="2">${v("finalBasis")}</textarea></label>
      ${r.legacyStatus ? `<p class="wide note">이전 상태 '${esc(r.legacyStatus)}'를 4단계 상태 '${esc(r.status)}'로 자동 변환했습니다. 원래 값은 기록에 남아 있습니다.</p>` : ""}
      <label class="wide">HR 담당자 평가 (후속 점검)<textarea name="evaluation" rows="2">${v("evaluation")}</textarea></label>
      <div class="wide form-foot">
        <button type="submit" class="btn primary">저장</button>
        <span id="act-msg" class="msg" role="status">${flash.id === it.id ? esc(flash.text) : ""}</span>
      </div>
      <p class="wide note">${storage.persistent ? "로컬 데모: 이 브라우저의 저장소(localStorage)에만 저장됩니다. 다른 PC · 사용자와 공유되지 않고, 브라우저 데이터를 지우면 사라집니다." : "이 브라우저는 저장소를 쓸 수 없어 이 탭을 닫으면 기록이 사라집니다."} 담당자 인증 · 권한 · 수정 이력 보관은 구현되어 있지 않습니다.</p>
    </form>
    ${r.log?.length ? `<p class="cols-head">기록 이력</p><div class="table-scroll auto"><table class="data"><thead><tr><th>시각</th><th>입력한 담당자</th><th>상태</th><th>변경 항목</th></tr></thead><tbody>
      ${r.log.slice().reverse().map((l) => `<tr><td>${esc(new Date(l.at).toLocaleString("ko-KR"))}</td><td>${esc(l.by)}</td><td>${esc(l.status)}</td><td>${esc((l.changed || []).join(", ") || "—")}</td></tr>`).join("")}
    </tbody></table></div>` : ""}`;
}

function bindForm(it) {
  const f = $("act-form");
  if (!f) return;
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f).entries());
    try {
      saveAction(it, data);
      flash = { id: it.id, text: `저장했습니다 (${new Date().toLocaleTimeString("ko-KR")}).` };
      renderAll(); // 목록의 처리 상태가 바로 바뀐다
    } catch (err) {
      const m = $("act-msg");
      m.textContent = err.message;
      m.className = "msg error";
    }
  });
}

function markStale() {
  if (lastResult() && isStale()) $("review-stale").hidden = false;
}

export function setup() {
  $("review-refresh").addEventListener("click", () => compute(true));
  window.addEventListener("paylock-changed", () => {
    const it = selectedId && items.find((x) => x.id === selectedId);
    if (it && (it.rule === "pay_change" || it.rule === "pay_dq")) renderDetail(it);
  });
  window.addEventListener("tables-changed", markStale);
  window.addEventListener("criteria-changed", markStale);
  window.addEventListener("detect-done", () => { if (lastResult()) { items = lastResult().items; } });
  onTab((t) => {
    if (t !== "review" || !ready) return;
    if (!lastResult()) compute();
    else { items = lastResult().items; renderAll(); markStale(); }
  });
}

export function setReady(r, activeTab) {
  ready = r;
  $("review-refresh").disabled = !r;
  if (r && activeTab === "review") compute();
}

export const currentItems = () => items;
