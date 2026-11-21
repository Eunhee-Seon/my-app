// 검토 항목 탐지: 검토 기준(store.js)으로 metrics.js 의 규칙 SQL을 실행해 항목 목록을 만든다.
// 항목은 «검토할 근거»이며 위반 · 문제 판정이 아니다. 원인을 확정하거나 조치를 집행하지 않는다.
import * as db from "./db.js";
import * as M from "./metrics.js";
import { getCriteria, calcRules, paramsText, markSeen } from "./store.js";

const REQUIRED = ["employees", "attendance", "payroll"];
let cache = null; // {key, result}

const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const fmtH = (v) => `${r1(v)}시간`;

/** 데이터 · 기준이 바뀌었는지 판단하는 키 */
export function currentKey() {
  const t = REQUIRED.map((n) => {
    const r = db.registry.get(n);
    return r ? `${n}:${r.source}:${r.rows}:${r.loadedAt.getTime()}` : `${n}:없음`;
  }).join("|");
  const c = getCriteria().map((x) => `${x.id}@${x.version}`).join(",");
  return `${t}#${c}`;
}
export const missingTables = () => REQUIRED.filter((n) => !db.registry.has(n));
export const lastResult = () => cache?.result || null;
export const isStale = () => !!cache && cache.key !== currentKey();

function base(c, extra) {
  return { criterionId: c.id, criterionVersion: c.version, criterionParams: { ...c.params }, criterionText: paramsText(c), ruleName: c.name, category: c.category, rule: c.id, ...extra };
}

/** 모든 규칙 실행 → {items, ranAt, errors, sql, key} */
export async function detect({ force = false } = {}) {
  const key = currentKey();
  if (!force && cache && cache.key === key) return cache.result;
  const missing = missingTables();
  if (missing.length) throw new Error(`필요한 테이블이 없습니다: ${missing.join(", ")}`);

  const cs = Object.fromEntries(getCriteria().map((c) => [c.id, c]));
  const calc = calcRules();
  const sql = {
    ot_over: M.sqlRuleOtOver(cs.ot_over.params),
    ot_spike: M.sqlRuleOtSpike(cs.ot_spike.params, calc.excludePartial),
    ot_consec: M.sqlRuleOtConsec(cs.ot_consec.params, calc.excludePartial),
    ot_dept_outlier: M.sqlRuleOtDeptOutlier(cs.ot_dept_outlier.params),
    dept_attrition: M.sqlRuleAttrition(cs.dept_attrition.params, calc),
    pay_change: M.sqlRulePayChange(cs.pay_change.params),
    att_dq: M.sqlRuleAttendanceDq(cs.att_dq.params),
    pay_dq: M.sqlRulePayrollDq(),
  };
  const items = [];
  const errors = {};
  const run = async (id, fn) => {
    try {
      const res = await db.run(sql[id]);
      for (const row of res.rows) items.push(fn(row, cs[id]));
    } catch (e) {
      errors[id] = e.message;
    }
  };

  await run("ot_over", (r, c) => base(c, {
    id: `ot_over|${r.emp_id}|${r.ym}`, targetType: "직원", target: r.emp_id, empId: r.emp_id, dept: r.dept, ym: r.ym,
    threshold: c.params.value, thresholdText: `${c.params.value}시간 초과`, actual: r.actual, actualText: fmtH(r.actual),
    diff: r1(r.actual - c.params.value), diffText: `+${r1(r.actual - c.params.value)}시간`, unit: "시간",
    reason: `월 초과근로 ${fmtH(r.actual)} — 시범 기준 ${c.params.value}시간 초과`,
  }));

  await run("ot_spike", (r, c) => {
    const zeroPrev = r.prev === 0;
    return base(c, {
      id: `ot_spike|${r.emp_id}|${r.ym}`, targetType: "직원", target: r.emp_id, empId: r.emp_id, dept: r.dept, ym: r.ym,
      threshold: c.params.rate, thresholdText: `증가율 ≥ ${c.params.rate}% · 증가 ≥ ${c.params.minHours}시간`,
      actual: r.actual, actualText: `${fmtH(r.prev)} → ${fmtH(r.actual)}`, prev: r.prev,
      diff: r1(r.increase), diffText: zeroPrev ? `+${r1(r.increase)}시간 (증가율 산정 불가)` : `+${r1(r.increase)}시간 · +${r.rate_pct}%`, unit: "시간",
      subtype: zeroPrev ? "전월 0시간" : null,
      reason: zeroPrev
        ? `전월 0시간에서 ${fmtH(r.actual)}로 증가 — 전월이 0시간이라 증가율은 계산하지 않음`
        : `전월 ${fmtH(r.prev)} → ${fmtH(r.actual)} (+${r1(r.increase)}시간, +${r.rate_pct}%)`,
    });
  });

  await run("ot_consec", (r, c) => base(c, {
    id: `ot_consec|${r.emp_id}|${r.ym}`, targetType: "직원", target: r.emp_id, empId: r.emp_id, dept: r.dept, ym: r.ym,
    threshold: c.params.count, thresholdText: `${c.params.count}회 연속 증가`, actual: r.actual, actualText: fmtH(r.actual),
    diff: r1(r.actual - r.start_value), diffText: `${r.start_ym} 대비 +${r1(r.actual - r.start_value)}시간`, unit: "시간",
    reason: `${r.start_ym}부터 ${String(r.path).split(" → ").map((v) => r1(Number(v))).join(" → ")}시간`,
  }));

  await run("ot_dept_outlier", (r, c) => {
    const small = r.dept_n < c.params.smallN;
    return base(c, {
      id: `ot_dept_outlier|${r.emp_id}|${r.ym}`, targetType: "직원", target: r.emp_id, empId: r.emp_id, dept: r.dept, ym: r.ym,
      threshold: c.params.z, thresholdText: `z ≥ ${c.params.z} · 부서 중앙값 초과`, actual: r.actual, actualText: `${fmtH(r.actual)} (z ${r.z})`,
      diff: r1(r.actual - r.dept_mean), diffText: `부서 평균 대비 +${r1(r.actual - r.dept_mean)}시간`, unit: "시간",
      smallDept: small, dept_mean: r.dept_mean, dept_median: r.dept_median, dept_n: r.dept_n,
      reason: `부서 평균 ${r.dept_mean}시간 · 중앙값 ${r.dept_median}시간 · ${r.dept_n}명 중 z=${r.z}${small ? " · 소규모 부서 — 해석 주의" : ""}`,
    });
  });

  await run("dept_attrition", (r, c) => base(c, {
    id: `dept_attrition|${r.dept}|${r.ym}`, targetType: "조직", target: r.dept, empId: null, dept: r.dept, ym: r.ym,
    threshold: c.params.value, thresholdText: `${c.params.value}% 초과`, actual: r.actual, actualText: `${r.actual}%`,
    diff: r1(r.actual - c.params.value), diffText: `+${r1(r.actual - c.params.value)}%p`, unit: "%",
    reason: `최근 12개월 퇴사 ${r.leavers}명 ÷ 평균 월말 재직 ${r.avg_hc}명 (현재 부서 기준)`,
  }));

  await run("pay_change", (r, c) => base(c, {
    id: `pay_change|회사 전체|${r.ym}`, targetType: "조직", target: "회사 전체", empId: null, dept: "회사 전체", ym: r.ym,
    threshold: c.params.value, thresholdText: `|변화율| ≥ ${c.params.value}%`, actual: r.change_pct, actualText: `${r.change_pct > 0 ? "+" : ""}${r.change_pct}%`,
    diff: r1(Math.abs(r.change_pct) - c.params.value), diffText: `기준 대비 ${r1(Math.abs(r.change_pct) - c.params.value)}%p`, unit: "%",
    reason: `월 급여 지급액 전월 대비 ${r.change_pct > 0 ? "+" : ""}${r.change_pct}%`,
  }));

  await run("att_dq", (r, c) => base(c, {
    id: `att_dq|${r.emp_id}|${r.ym}|${r.issue}`, targetType: "데이터", target: r.emp_id, empId: r.emp_id, dept: null, ym: r.ym,
    threshold: 0, thresholdText: "0건", actual: r.cnt, actualText: `${r.cnt}건`, diff: r.cnt, diffText: `+${r.cnt}건`, unit: "건",
    issue: r.issue, dates: r.dates, reason: `근태: ${r.issue}`,
  }));

  await run("pay_dq", (r, c) => base(c, {
    id: `pay_dq|${r.emp_id}|${r.ym}|${r.issue}`, targetType: "데이터", target: r.emp_id, empId: r.emp_id, dept: null, ym: r.ym,
    threshold: 0, thresholdText: "0건", actual: r.cnt, actualText: `${r.cnt}건`, diff: r.cnt, diffText: `+${r.cnt}건`, unit: "건",
    issue: r.issue, reason: `급여: ${r.issue}`,
  }));

  // 데이터 검증 항목의 부서는 employees 에서 붙인다(없는 사번이면 '—')
  const depts = new Map();
  try {
    const r = await db.run("SELECT emp_id, dept FROM employees");
    for (const x of r.rows) depts.set(x.emp_id, x.dept);
  } catch { /* 부서 없이 */ }
  for (const it of items) if (it.targetType === "데이터") it.dept = depts.get(it.empId) || "—";

  markSeen(items);
  const result = { items, ranAt: new Date(), errors, sql, key };
  cache = { key, result };
  window.dispatchEvent(new CustomEvent("detect-done"));
  return result;
}
