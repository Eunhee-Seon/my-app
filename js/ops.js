// 운영 현황: 인력 · 근태 · 인건비 지표와 검토 항목 요약. 사용 테이블은 employees · attendance · payroll.
// 개인별 급여 금액은 표시하지 않는다. 부서는 employees.dept(현재 부서) 기준이다.
import * as db from "./db.js";
import * as M from "./metrics.js";
import { chart, COLORS } from "./charts.js";
import { renderTable } from "./ask.js";
import { esc } from "./explain.js";
import { criterion, calcRules } from "./store.js";
import { detect, missingTables } from "./detect.js";
import { showTab, onTab } from "./nav.js";
import { openReviewWith } from "./review.js";

const $ = (id) => document.getElementById(id);
let months = [];
let base = null;
let lastKey = null;
let ready = false;
let busy = false;

const n0 = (v, d = 0) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: d }));
const signedPct = (v) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${n0(v, 1)}%`);
const dataKey = () => ["employees", "attendance", "payroll"].map((t) => {
  const r = db.registry.get(t);
  return r ? `${t}:${r.rows}:${r.loadedAt.getTime()}` : "-";
}).join("|") + JSON.stringify(calcRules()) + criterion("ot_over").version + criterion("dept_attrition").version;

function kpi(label, value, unit, sub, title = "") {
  return `<div class="kpi-item" title="${esc(title)}"><div class="kpi-label">${esc(label)}</div>
    <div class="kpi-value">${value}${value === "—" ? "" : `<small>${esc(unit)}</small>`}</div><div class="kpi-sub">${esc(sub || "")}</div></div>`;
}

function viz(id, title, sub, res, sql, note = "") {
  return `<section class="viz">
    <div class="viz-head"><h3>${esc(title)}</h3>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</div>
    <div class="chart-box" id="${id}"></div>
    ${note ? `<p class="note">${esc(note)}</p>` : ""}
    <details class="sql"><summary>표로 보기</summary>${res ? renderTable(res, 200) : ""}</details>
    <details class="sql"><summary>SQL 보기</summary><pre>${esc(sql)}</pre></details>
  </section>`;
}

const col = (res, name) => res.rows.map((r) => r[name]);
const rowOf = (res, month) => res.rows.find((r) => r["월"] === month);

async function compute() {
  if (busy) return;
  const box = $("ops-body");
  const miss = missingTables();
  if (miss.length) {
    box.innerHTML = `<p class="msg error">필요한 테이블이 없습니다: ${esc(miss.join(", "))}</p>`;
    return;
  }
  busy = true;
  $("ops-stale").hidden = true;
  box.innerHTML = '<p class="msg">계산 중…</p>';
  try {
    const calc = calcRules();
    const otC = criterion("ot_over"), atC = criterion("dept_attrition");
    months = col(await db.run(M.sqlMonths()), "월");
    if (!base || !months.includes(base)) base = months[months.length - 1];
    $("ops-month").innerHTML = months.map((m) => `<option ${m === base ? "selected" : ""}>${m}</option>`).join("");
    const from = months[Math.max(0, months.indexOf(base) - 11)];
    const S = {
      hc: M.sqlHeadcountTrend(calc), hl: M.sqlHiresLeaves(), dh: M.sqlDeptHeadcount(base, calc), et: M.sqlEmploymentType(base, calc),
      tn: M.sqlTenure(base, calc), attr: M.sqlAttritionRolling(calc), lr: M.sqlLeaveReasons(from, base),
      ot: M.sqlOtTrend({ otThreshold: otC.params.value }), dot: M.sqlDeptOt(base), hist: M.sqlOtHistogram(base), wh: M.sqlWorkHoursSummary(base),
      pay: M.sqlPayTrend(), pit: M.sqlPayItems(base), pitT: M.sqlPayItemsTrend(), dpay: M.sqlDeptPay(base), jc: M.sqlJoinChecks(),
    };
    const R = {};
    for (const [k, s] of Object.entries(S)) R[k] = await db.run(s);
    let det = null, detErr = null;
    try { det = await detect(); } catch (e) { detErr = e.message; }
    render(R, S, { calc, otC, atC, from, det, detErr });
    lastKey = dataKey();
  } catch (e) {
    box.innerHTML = `<p class="msg error">계산 오류: ${esc(e.message)}</p>`;
  } finally {
    busy = false;
  }
}

function render(R, S, { calc, otC, atC, from, det, detErr }) {
  const hc = rowOf(R.hc, base), hl = rowOf(R.hl, base), ot = rowOf(R.ot, base), pay = rowOf(R.pay, base);
  const attrAll = R.attr.rows.find((r) => r["월"] === base && r["부서"] === "전체");
  const attrDept = { columns: R.attr.columns.filter((c) => c.name !== "월"), rows: R.attr.rows.filter((r) => r["월"] === base && r["부서"] !== "전체").map(({ 월, ...x }) => x).sort((a, b) => (b.퇴사율_pct ?? -1) - (a.퇴사율_pct ?? -1)) };
  const isLatest = base === months[months.length - 1];
  const deptNote = `부서는 employees.dept(현재 부서, 퇴사자는 퇴사 시점 기록) 기준입니다. 조직 이동 이력이 없어 과거 월의 실제 소속과 다를 수 있습니다.${isLatest ? "" : " 기준월이 최근 월이 아니므로 특히 주의하세요."}`;
  const leaveRule = calc.includeLeaveDay ? "퇴사일 당일 재직 포함" : "퇴사일 당일 재직 미포함(데이터 사전 기준)";
  const nMonths = months.indexOf(base) - months.indexOf(from) + 1;

  // 검토 항목 요약(기준월)
  let summary = "";
  if (det) {
    const inMonth = det.items.filter((i) => i.ym === base);
    const byRule = new Map();
    for (const it of inMonth) byRule.set(it.rule, (byRule.get(it.rule) || 0) + 1);
    const dqAll = det.items.filter((i) => i.category === "데이터 품질").length;
    const rules = [["ot_over", "운영 기준 초과"], ["dept_attrition", "운영 기준 초과"], ["ot_spike", "통계적 이상치"], ["ot_consec", "통계적 이상치"], ["ot_dept_outlier", "통계적 이상치"], ["pay_change", "통계적 이상치"], ["att_dq", "데이터 품질"], ["pay_dq", "데이터 품질"]];
    summary = `<div class="table-scroll auto"><table class="grid"><thead><tr><th>검토 유형</th><th>검토 조건</th><th class="num">${esc(base)} 항목 수</th><th class="num">대상 직원 수</th><th></th></tr></thead><tbody>
      ${rules.map(([r, cat]) => {
        const c = criterion(r);
        const its = inMonth.filter((i) => i.rule === r);
        const emps = new Set(its.filter((i) => i.empId).map((i) => i.empId)).size;
        return `<tr><td>${esc(cat)}</td><td>${esc(c.name)}${c.pilot ? ' <span class="tag">시범 기준</span>' : ""}</td><td class="num">${n0(its.length)}</td><td class="num">${its.some((i) => i.empId) ? n0(emps) : "—"}</td>
          <td class="num"><button type="button" class="btn small link go-review" data-rule="${r}" ${its.length ? "" : "disabled"}>목록 보기</button></td></tr>`;
      }).join("")}
    </tbody></table></div>
    <p class="note">데이터 품질 항목은 전체 기간 ${n0(dqAll)}건입니다. ${Object.keys(det.errors).length ? `실행 오류: ${esc(Object.entries(det.errors).map(([k, v]) => `${k} — ${v}`).join(" / "))}` : ""}</p>`;
  } else {
    summary = `<p class="msg error">검토 항목을 계산하지 못했습니다: ${esc(detErr)}</p>`;
  }

  $("ops-body").innerHTML = `
    <h2 class="sec-title">검토 항목 요약 <span class="sub">${esc(base)} · 위반 판정이 아닌 검토 대상입니다</span></h2>
    ${summary}

    <h2 class="sec-title">인력 <span class="sub">기준일 ${esc(hc?.["기준일"] || M.monthEnd(base))} · ${esc(leaveRule)}</span></h2>
    <div class="kpi">
      ${kpi("월말 재직 인원", n0(hc?.["월말_재직인원"]), "명", base)}
      ${kpi("당월 입사자", n0(hl?.["입사자"]), "명", base)}
      ${kpi("당월 퇴사자", n0(hl?.["퇴사자"]), "명", base)}
      ${kpi("12개월 퇴사율 (전사)", attrAll ? n0(attrAll.퇴사율_pct, 1) : "—", "%", attrAll ? `${attrAll.퇴사자_12개월}명 ÷ 평균 ${n0(attrAll.평균_월말재직, 1)}명` : "12개월 데이터 부족")}
    </div>
    <div class="viz-grid">
      ${viz("c-hc", "월말 재직 인원", leaveRule, R.hc, S.hc)}
      ${viz("c-hl", "월별 입사 · 퇴사", "입사일 · 퇴사일 기준", R.hl, S.hl)}
      ${viz("c-dh", "부서별 재직 인원", `${base} 말 기준`, R.dh, S.dh, deptNote)}
      ${viz("c-lr", "퇴사 사유", `${from} ~ ${base} (${nMonths}개월)`, R.lr, S.lr)}
      ${viz("c-tn", "재직기간별 인원", `${base} 말 기준`, R.tn, S.tn)}
      ${viz("c-attr", "부서별 12개월 퇴사율", `${base} 기준 · 점선 ${atC.params.value}% (시범 기준)`, attrDept, S.attr,
        `퇴사율(%) = 최근 12개월 퇴사자 수 ÷ 같은 12개월 평균 월말 재직 인원 × 100. 12개월이 모두 있는 달만 계산합니다. ${deptNote}`)}
    </div>
    <h3 class="sec">고용 형태별 구성 <span class="sub">${esc(base)} 말 기준</span></h3>
    ${renderTable(R.et, 20)}

    <h2 class="sec-title">근태 <span class="sub">attendance 직원·월 집계 · 근무 기록이 없는 날은 결근으로 보지 않습니다</span></h2>
    <div class="kpi">
      ${kpi("1인당 초과근로", n0(ot?.["일인당_초과근로"], 2), "시간", `${base} · 근태 인원 ${n0(ot?.["근태_인원"])}명`, "그 달 overtime_hours 합 ÷ 그 달 attendance 에 나온 사번 수")}
      ${kpi(`기준(${otC.params.value}시간) 초과 인원`, n0(ot?.["기준초과_인원"]), "명", "시범 기준 · 법정 한도 아님")}
      ${kpi("초과근로 합계", n0(ot?.["초과근로_합"], 1), "시간", base)}
      ${kpi("근무시간 중앙값", n0(R.wh.rows[0]?.["총근무_중앙값"], 1), "시간", "정규 + 초과, 직원·월")}
    </div>
    <div class="viz-grid">
      ${viz("c-ot", "월별 1인당 초과근로시간", "초과근로 합 ÷ 근태 인원", R.ot, S.ot)}
      ${viz("c-over", "기준 초과 인원 추이", `월 ${otC.params.value}시간 초과 (시범 기준)`, R.ot, S.ot)}
      ${viz("c-dot", "부서별 1인당 초과근로시간", `${base}`, R.dot, S.dot, deptNote)}
      ${viz("c-hist", "직원별 월 초과근로시간 분포", `${base} · 5시간 구간`, R.hist, S.hist, `점선 대신 구간으로 표시: ${otC.params.value}시간 초과는 시범 기준입니다.`)}
    </div>
    <h3 class="sec">직원별 월 근무시간 분포 <span class="sub">${esc(base)} · 정규 + 초과 (시간)</span></h3>
    ${renderTable(R.wh, 5)}

    <h2 class="sec-title">인건비 <span class="sub">payroll.amount 합계 · 회사 부담 보험료 · 퇴직급여 등 파일에 없는 비용은 포함하지 않습니다</span></h2>
    <div class="kpi">
      ${kpi("월 급여 지급액", pay ? n0(pay["지급액"] / 1e6, 1) : "—", "백만원", base)}
      ${kpi("전월 대비", pay ? signedPct(pay["전월대비_pct"]) : "—", "", base)}
      ${kpi("1인당 평균 지급액", pay ? n0(pay["일인당_평균"] / 1e4, 0) : "—", "만원", `지급 인원 ${n0(pay?.["지급_인원"])}명`)}
      ${kpi("급여 항목 수", n0(R.pit.rows.length), "개", R.pit.rows.map((r) => r["급여항목"]).join(" · "))}
    </div>
    <div class="viz-grid">
      ${viz("c-pay", "월별 급여 지급액", "단위 원", R.pay, S.pay)}
      ${viz("c-paychg", "월별 지급액 증감률", "전월 대비 %", R.pay, S.pay, "데이터 사전 회사 규칙: 명절 상여(2024-09 · 2025-01 · 2025-10), 전년도 성과급(1월), 3월 정기 인상. 변화의 원인은 자동으로 확정하지 않습니다.")}
      ${viz("c-pit", "급여 항목별 구성", `${base}`, R.pit, S.pit)}
      ${viz("c-pcap", "월별 1인당 평균 지급액", "지급액 ÷ 지급 인원", R.pay, S.pay)}
      ${viz("c-dpay", "부서별 급여 지급액", `${base}`, R.dpay, S.dpay, deptNote)}
    </div>
    <h3 class="sec">급여 항목별 월 지급액</h3>
    ${renderTable(R.pitT, 60)}

    <h2 class="sec-title">데이터 연결 검증 <span class="sub">직원·월로 먼저 집계한 뒤 연결 — 연결 전후 행 수가 같아야 합니다</span></h2>
    ${renderTable(R.jc, 10)}
    <details class="sql"><summary>SQL 보기</summary><pre>${esc(S.jc)}</pre></details>
  `;

  const L = (res) => col(res, "월");
  chart($("c-hc"), { type: "line", title: "월말 재직 인원", labels: L(R.hc), series: [{ name: "월말 재직 인원", values: col(R.hc, "월말_재직인원"), color: COLORS.primary }], unit: "명", highlightIndex: L(R.hc).indexOf(base) });
  chart($("c-hl"), { type: "bar", title: "월별 입사 · 퇴사", labels: L(R.hl), series: [{ name: "입사자", values: col(R.hl, "입사자"), color: COLORS.primary }, { name: "퇴사자", values: col(R.hl, "퇴사자"), color: COLORS.secondary }], unit: "명" });
  chart($("c-dh"), { type: "hbar", title: "부서별 재직 인원", labels: col(R.dh, "부서"), values: col(R.dh, "재직인원"), unit: "명" });
  chart($("c-lr"), { type: "hbar", title: "퇴사 사유", labels: col(R.lr, "퇴사사유"), values: col(R.lr, "퇴사자"), unit: "명" });
  chart($("c-tn"), { type: "hbar", title: "재직기간별 인원", labels: col(R.tn, "재직기간"), values: col(R.tn, "재직인원"), unit: "명" });
  chart($("c-attr"), { type: "hbar", title: "부서별 12개월 퇴사율", labels: attrDept.rows.map((r) => r["부서"]), values: attrDept.rows.map((r) => r["퇴사율_pct"]), unit: "%", threshold: { value: atC.params.value, label: `시범 기준 ${atC.params.value}%` } });
  chart($("c-ot"), { type: "line", title: "월별 1인당 초과근로시간", labels: L(R.ot), series: [{ name: "1인당 초과근로", values: col(R.ot, "일인당_초과근로"), color: COLORS.primary }], unit: "시간", highlightIndex: L(R.ot).indexOf(base) });
  chart($("c-over"), { type: "bar", title: "기준 초과 인원 추이", labels: L(R.ot), series: [{ name: "기준 초과 인원", values: col(R.ot, "기준초과_인원"), color: COLORS.primary }], unit: "명", highlightIndex: L(R.ot).indexOf(base) });
  chart($("c-dot"), { type: "hbar", title: "부서별 1인당 초과근로", labels: col(R.dot, "부서"), values: col(R.dot, "일인당_초과근로"), unit: "시간" });
  chart($("c-hist"), { type: "bar", title: "직원별 초과근로 분포", labels: R.hist.rows.map((r) => `${r["구간_시작"]}~${r["구간_시작"] + 5}`), series: [{ name: "인원", values: col(R.hist, "인원"), color: COLORS.primary }], unit: "명" });
  chart($("c-pay"), { type: "bar", title: "월별 급여 지급액", labels: L(R.pay), series: [{ name: "지급액", values: col(R.pay, "지급액"), color: COLORS.primary }], valueFmt: (v) => `${n0(v / 1e6, 1)}백만원`, highlightIndex: L(R.pay).indexOf(base) });
  chart($("c-paychg"), { type: "bar", title: "월별 지급액 증감률", labels: L(R.pay), series: [{ name: "전월 대비", values: col(R.pay, "전월대비_pct"), color: COLORS.primary }], unit: "%" });
  chart($("c-pit"), { type: "hbar", title: "급여 항목별 구성", labels: col(R.pit, "급여항목"), values: col(R.pit, "비중_pct"), unit: "%" });
  chart($("c-pcap"), { type: "line", title: "월별 1인당 평균 지급액", labels: L(R.pay), series: [{ name: "1인당 평균", values: col(R.pay, "일인당_평균"), color: COLORS.primary }], valueFmt: (v) => `${n0(v / 1e4, 0)}만원` });
  chart($("c-dpay"), { type: "hbar", title: "부서별 급여 지급액", labels: col(R.dpay, "부서"), values: col(R.dpay, "지급액"), valueFmt: (v) => `${n0(v / 1e6, 1)}백만원` });

  $("ops-body").querySelectorAll(".go-review").forEach((b) => b.addEventListener("click", () => {
    openReviewWith({ ym: base, rule: b.dataset.rule });
    showTab("review");
  }));
}

function markStale() {
  if (lastKey && lastKey !== dataKey()) $("ops-stale").hidden = false;
}

export function setup() {
  $("ops-month").addEventListener("change", (e) => { base = e.target.value; compute(); });
  $("ops-refresh").addEventListener("click", () => compute());
  window.addEventListener("tables-changed", markStale);
  window.addEventListener("criteria-changed", markStale);
  onTab((t) => { if (t === "ops" && ready && !lastKey) compute(); });
}

export function setReady(r, activeTab) {
  ready = r;
  $("ops-refresh").disabled = !r;
  if (r && activeTab === "ops" && !lastKey) compute();
}
