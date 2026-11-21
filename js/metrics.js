// 운영 현황 · 검토 항목에 쓰는 SQL. 사용하는 테이블은 employees · attendance · payroll 세 개뿐이다.
// 원칙: attendance · payroll 은 직원 · 월 단위로 먼저 집계(em · pm)한 뒤 employees(직원 1명 = 1행)에 연결한다.
// 모든 SQL은 SELECT/WITH 한 문장이며 db.run() 의 읽기 전용 검사를 거친다. 파라미터는 숫자 · 월 형식 검사 후에만 넣는다.

export const num = (v, name = "값") => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name}이(가) 숫자가 아닙니다.`);
  return n;
};
export const ym = (v) => {
  if (!/^\d{4}-\d{2}$/.test(String(v))) throw new Error(`월 형식이 아닙니다: ${v}`);
  return String(v);
};
const dateLit = (v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error(`날짜 형식이 아닙니다: ${v}`);
  return `DATE '${v}'`;
};

/** 'YYYY-MM' → 그 달 말일 'YYYY-MM-DD' */
export function monthEnd(m) {
  const [y, mo] = ym(m).split("-").map(Number);
  const d = new Date(Date.UTC(y, mo, 0));
  return d.toISOString().slice(0, 10);
}
/** 'YYYY-MM' 에 k개월 더하기 */
export function addMonths(m, k) {
  const [y, mo] = ym(m).split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + k, 1));
  return d.toISOString().slice(0, 7);
}

// ── 공통 CTE ───────────────────────────────────────────
/** 분석 월: attendance 의 근무월 ∪ payroll 의 지급월 */
export const MONTHS_CTE = `months AS (
  SELECT ym, strptime(ym || '-01', '%Y-%m-%d')::DATE AS m_start,
         last_day(strptime(ym || '-01', '%Y-%m-%d')::DATE) AS m_end
  FROM (SELECT DISTINCT strftime(work_date, '%Y-%m') AS ym FROM attendance
        UNION SELECT DISTINCT pay_month AS ym FROM payroll) u
)`;
/** 직원 · 월 근태 집계 (attendance 1행 = 직원 1명의 근무일 하루) */
export const EM_CTE = `em AS (
  SELECT emp_id, strftime(work_date, '%Y-%m') AS ym,
         SUM(overtime_hours) AS ot, SUM(regular_hours) AS reg, COUNT(*) AS work_days
  FROM attendance GROUP BY 1, 2
)`;
/** 직원 · 월 급여 집계 (payroll 1행 = 직원 1명의 한 달 급여 항목 1개) */
export const PM_CTE = `pm AS (
  SELECT emp_id, pay_month AS ym, SUM(amount) AS pay, COUNT(*) AS items
  FROM payroll GROUP BY 1, 2
)`;

/** 기준일 d 에 재직: hire_date ≤ d 이고 퇴사일이 없거나 d 이후(퇴사일 당일 포함 여부는 기준으로 관리) */
export const employedAt = (d, includeLeaveDay) =>
  `(e.hire_date <= ${d} AND (e.leave_date IS NULL OR e.leave_date ${includeLeaveDay ? ">=" : ">"} ${d}))`;

// ── 인력 ──────────────────────────────────────────────
export const sqlMonths = () => `WITH ${MONTHS_CTE} SELECT ym AS 월 FROM months ORDER BY 1`;

export const sqlHeadcountTrend = (p) => `WITH ${MONTHS_CTE}
SELECT m.ym AS 월, m.m_end AS 기준일, COUNT(e.emp_id) AS 월말_재직인원
FROM months m LEFT JOIN employees e ON ${employedAt("m.m_end", p.includeLeaveDay)}
GROUP BY 1, 2 ORDER BY 1`;

export const sqlHiresLeaves = () => `WITH ${MONTHS_CTE}
SELECT m.ym AS 월,
  (SELECT COUNT(*) FROM employees e WHERE e.hire_date BETWEEN m.m_start AND m.m_end) AS 입사자,
  (SELECT COUNT(*) FROM employees e WHERE e.leave_date BETWEEN m.m_start AND m.m_end) AS 퇴사자
FROM months m ORDER BY 1`;

export const sqlDeptHeadcount = (base, p) => `SELECT e.dept AS 부서, COUNT(*) AS 재직인원
FROM employees e WHERE ${employedAt(dateLit(monthEnd(base)), p.includeLeaveDay)}
GROUP BY 1 ORDER BY 2 DESC, 1`;

export const sqlEmploymentType = (base, p) => `SELECT e.employment_type AS 고용형태, COUNT(*) AS 재직인원,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS 비중_pct
FROM employees e WHERE ${employedAt(dateLit(monthEnd(base)), p.includeLeaveDay)}
GROUP BY 1 ORDER BY 2 DESC`;

export const sqlTenure = (base, p) => {
  const d = dateLit(monthEnd(base));
  return `WITH t AS (
  SELECT date_diff('day', e.hire_date, ${d}) / 365.25 AS yrs
  FROM employees e WHERE ${employedAt(d, p.includeLeaveDay)}
)
SELECT CASE WHEN yrs < 1 THEN '1년 미만' WHEN yrs < 3 THEN '1~3년' WHEN yrs < 5 THEN '3~5년'
            WHEN yrs < 10 THEN '5~10년' ELSE '10년 이상' END AS 재직기간,
       COUNT(*) AS 재직인원,
       MIN(CASE WHEN yrs < 1 THEN 1 WHEN yrs < 3 THEN 2 WHEN yrs < 5 THEN 3 WHEN yrs < 10 THEN 4 ELSE 5 END) AS 순서
FROM t GROUP BY 1 ORDER BY 순서`;
};

/** 분석 기간(시작월~기준월)의 퇴사 사유 */
export const sqlLeaveReasons = (from, to) => `SELECT COALESCE(leave_reason, '(사유 없음)') AS 퇴사사유, COUNT(*) AS 퇴사자
FROM employees
WHERE leave_date BETWEEN strptime('${ym(from)}-01', '%Y-%m-%d')::DATE AND last_day(strptime('${ym(to)}-01', '%Y-%m-%d')::DATE)
GROUP BY 1 ORDER BY 2 DESC, 1`;

/**
 * 부서별 12개월 퇴사율(월별 이동 계산). 퇴사율(%) = 최근 12개월 퇴사자 수 ÷ 같은 12개월의 평균 월말 재직 인원 × 100.
 * 부서는 employees.dept(현재 부서, 퇴사자는 퇴사 시점 기록)이며 조직 이동 이력은 반영하지 못한다.
 * 12개월이 다 차는 달만 계산한다. ALL 행은 회사 전체.
 */
export const sqlAttritionRolling = (p) => `WITH ${MONTHS_CTE},
hc AS (SELECT m.ym, e.dept FROM months m JOIN employees e ON ${employedAt("m.m_end", p.includeLeaveDay)}),
grid AS (SELECT m.ym, d.dept FROM months m CROSS JOIN (SELECT DISTINCT dept FROM employees UNION ALL SELECT '전체') d(dept)),
hcm AS (SELECT ym, dept, COUNT(*) AS n FROM hc GROUP BY 1, 2
        UNION ALL SELECT ym, '전체', COUNT(*) FROM hc GROUP BY 1),
lvm AS (SELECT strftime(leave_date, '%Y-%m') AS ym, dept, COUNT(*) AS n FROM employees WHERE leave_date IS NOT NULL GROUP BY 1, 2
        UNION ALL SELECT strftime(leave_date, '%Y-%m'), '전체', COUNT(*) FROM employees WHERE leave_date IS NOT NULL GROUP BY 1),
g AS (SELECT grid.ym, grid.dept, COALESCE(hcm.n, 0) AS hc, COALESCE(lvm.n, 0) AS lv
      FROM grid LEFT JOIN hcm USING (ym, dept) LEFT JOIN lvm USING (ym, dept)),
r AS (SELECT ym, dept, AVG(hc) OVER w AS avg_hc, SUM(lv) OVER w AS lv12, COUNT(*) OVER w AS months_in
      FROM g WINDOW w AS (PARTITION BY dept ORDER BY ym ROWS BETWEEN 11 PRECEDING AND CURRENT ROW))
SELECT ym AS 월, dept AS 부서, ROUND(avg_hc, 1) AS 평균_월말재직, lv12 AS 퇴사자_12개월,
       CASE WHEN avg_hc > 0 THEN ROUND(100.0 * lv12 / avg_hc, 1) END AS 퇴사율_pct
FROM r WHERE months_in = 12 ORDER BY 1, 2`;

// ── 근태 ──────────────────────────────────────────────
export const sqlOtTrend = (p) => `WITH ${EM_CTE}
SELECT ym AS 월, SUM(ot) AS 초과근로_합, COUNT(*) AS 근태_인원,
       ROUND(SUM(ot) / COUNT(*), 2) AS 일인당_초과근로,
       COUNT(*) FILTER (WHERE ot > ${num(p.otThreshold)}) AS 기준초과_인원
FROM em GROUP BY 1 ORDER BY 1`;

export const sqlDeptOt = (base) => `WITH ${EM_CTE}
SELECT e.dept AS 부서, COUNT(*) AS 근태_인원, ROUND(SUM(em.ot) / COUNT(*), 2) AS 일인당_초과근로,
       ROUND(median(em.ot), 1) AS 중앙값, MAX(em.ot) AS 최대
FROM em JOIN employees e ON e.emp_id = em.emp_id
WHERE em.ym = '${ym(base)}' GROUP BY 1 ORDER BY 3 DESC`;

export const sqlOtHistogram = (base) => `WITH ${EM_CTE}
SELECT CAST(floor(ot / 5) * 5 AS INTEGER) AS 구간_시작, COUNT(*) AS 인원
FROM em WHERE ym = '${ym(base)}' GROUP BY 1 ORDER BY 1`;

export const sqlWorkHoursSummary = (base) => `WITH ${EM_CTE}
SELECT COUNT(*) AS 인원,
  ROUND(quantile_cont(reg + ot, 0.25), 1) AS 총근무_p25, ROUND(median(reg + ot), 1) AS 총근무_중앙값,
  ROUND(quantile_cont(reg + ot, 0.75), 1) AS 총근무_p75, ROUND(quantile_cont(reg + ot, 0.9), 1) AS 총근무_p90,
  MAX(reg + ot) AS 총근무_최대, ROUND(median(ot), 1) AS 초과근로_중앙값, ROUND(quantile_cont(ot, 0.9), 1) AS 초과근로_p90
FROM em WHERE ym = '${ym(base)}'`;

/** 회사 전체 월별 근무일수(근태 기록이 있는 서로 다른 날짜 수) — 전후 비교의 참고값 */
export const sqlWorkdays = () => `SELECT strftime(work_date, '%Y-%m') AS 월, COUNT(DISTINCT work_date) AS 근무일수
FROM attendance GROUP BY 1 ORDER BY 1`;

// ── 인건비 (개인별 금액은 표시하지 않는다) ─────────────
export const sqlPayTrend = () => `WITH ${PM_CTE}
SELECT ym AS 월, SUM(pay) AS 지급액, COUNT(*) AS 지급_인원, ROUND(SUM(pay) / COUNT(*)) AS 일인당_평균,
       ROUND(100.0 * (SUM(pay) / LAG(SUM(pay)) OVER (ORDER BY ym) - 1), 1) AS 전월대비_pct
FROM pm GROUP BY 1 ORDER BY 1`;

export const sqlPayItems = (base) => `SELECT pay_item AS 급여항목, SUM(amount) AS 지급액,
  ROUND(100.0 * SUM(amount) / SUM(SUM(amount)) OVER (), 1) AS 비중_pct
FROM payroll WHERE pay_month = '${ym(base)}' GROUP BY 1 ORDER BY 2 DESC`;

export const sqlPayItemsTrend = () => `SELECT pay_month AS 월,
  SUM(amount) FILTER (WHERE pay_item = '기본급여') AS 기본급여,
  SUM(amount) FILTER (WHERE pay_item = '수당급여') AS 수당급여,
  SUM(amount) FILTER (WHERE pay_item = '기타급여') AS 기타급여,
  SUM(amount) FILTER (WHERE pay_item NOT IN ('기본급여', '수당급여', '기타급여')) AS 그외항목
FROM payroll GROUP BY 1 ORDER BY 1`;

export const sqlDeptPay = (base) => `WITH ${PM_CTE}
SELECT e.dept AS 부서, COUNT(*) AS 지급_인원, SUM(pm.pay) AS 지급액, ROUND(SUM(pm.pay) / COUNT(*)) AS 일인당_평균
FROM pm JOIN employees e ON e.emp_id = pm.emp_id
WHERE pm.ym = '${ym(base)}' GROUP BY 1 ORDER BY 3 DESC`;

// ── 연결 검증 (조인 전후 행 수) ─────────────────────────
export const sqlJoinChecks = () => `WITH ${EM_CTE}, ${PM_CTE}
SELECT '근태 직원·월 집계 → employees 연결' AS 검증,
       (SELECT COUNT(*) FROM em) AS 연결_전, (SELECT COUNT(*) FROM em JOIN employees e ON e.emp_id = em.emp_id) AS 연결_후,
       (SELECT COUNT(*) FROM em WHERE emp_id NOT IN (SELECT emp_id FROM employees)) AS 직원목록에_없음
UNION ALL
SELECT '급여 직원·월 집계 → employees 연결',
       (SELECT COUNT(*) FROM pm), (SELECT COUNT(*) FROM pm JOIN employees e ON e.emp_id = pm.emp_id),
       (SELECT COUNT(*) FROM pm WHERE emp_id NOT IN (SELECT emp_id FROM employees))
UNION ALL
SELECT 'employees 사번 중복 (행 수 − 고유 사번 수)', (SELECT COUNT(*) FROM employees), (SELECT COUNT(DISTINCT emp_id) FROM employees),
       (SELECT COUNT(*) - COUNT(DISTINCT emp_id) FROM employees)`;

// ── 탐지 규칙 SQL ─────────────────────────────────────
const prevYm = (col, k) => `strftime(strptime(${col} || '-01', '%Y-%m-%d') - INTERVAL ${k} MONTH, '%Y-%m')`;
const partial = (monthsCols) =>
  `(strftime(e.hire_date, '%Y-%m') IN (${monthsCols.join(", ")}) OR COALESCE(strftime(e.leave_date, '%Y-%m'), '') IN (${monthsCols.join(", ")}))`;

/** ① 월 초과근로시간 기준 초과 */
export const sqlRuleOtOver = (c) => `WITH ${EM_CTE}
SELECT em.emp_id, e.dept, em.ym, em.ot AS actual, ${num(c.value)} AS threshold
FROM em LEFT JOIN employees e ON e.emp_id = em.emp_id
WHERE em.ot > ${num(c.value)}
ORDER BY em.ym, em.emp_id`;

/** ② 전월 대비 급증: 전월 기록이 있고(바로 앞 달), 증가시간 ≥ 최소시간 AND 증가율 ≥ 기준. 전월 0시간은 증가율 산정 불가로 따로 표시 */
export const sqlRuleOtSpike = (c, excludePartial) => `WITH ${EM_CTE},
x AS (SELECT em.*, LAG(ym) OVER w AS ym1, LAG(ot) OVER w AS ot1 FROM em WINDOW w AS (PARTITION BY emp_id ORDER BY ym))
SELECT x.emp_id, e.dept, x.ym, x.ot AS actual, x.ot1 AS prev, x.ot - x.ot1 AS increase,
       CASE WHEN x.ot1 = 0 THEN NULL ELSE ROUND(100.0 * (x.ot - x.ot1) / x.ot1, 1) END AS rate_pct
FROM x LEFT JOIN employees e ON e.emp_id = x.emp_id
WHERE x.ym1 = ${prevYm("x.ym", 1)}
  AND x.ot - x.ot1 >= ${num(c.minHours)}
  AND (x.ot1 = 0 OR (x.ot - x.ot1) / x.ot1 >= ${num(c.rate) / 100})
  ${excludePartial ? `AND NOT ${partial(["x.ym", "x.ym1"])}` : ""}
ORDER BY x.ym, x.emp_id`;

/** ③ k회 연속 증가: k+1개월이 모두 연속해서 기록되어 있어야 한다(누락 월이 있으면 판정하지 않음) */
export function sqlRuleOtConsec(c, excludePartial) {
  const k = Math.max(2, Math.min(6, Math.round(num(c.count))));
  const lags = Array.from({ length: k }, (_, i) => `LAG(ym, ${i + 1}) OVER w AS ym${i + 1}, LAG(ot, ${i + 1}) OVER w AS ot${i + 1}`).join(", ");
  const cont = Array.from({ length: k }, (_, i) => `x.ym${i + 1} = ${prevYm("x.ym", i + 1)}`).join(" AND ");
  const inc = Array.from({ length: k }, (_, i) => `x.ot${i + 1} < ${i === 0 ? "x.ot" : `x.ot${i}`}`).join(" AND ");
  const monthsCols = ["x.ym", ...Array.from({ length: k }, (_, i) => `x.ym${i + 1}`)];
  return `WITH ${EM_CTE},
x AS (SELECT em.*, ${lags} FROM em WINDOW w AS (PARTITION BY emp_id ORDER BY ym))
SELECT x.emp_id, e.dept, x.ym, x.ot AS actual, x.ot${k} AS start_value, x.ym${k} AS start_ym,
       ${[...Array.from({ length: k }, (_, i) => `CAST(x.ot${k - i} AS VARCHAR)`), "CAST(x.ot AS VARCHAR)"].join(" || ' → ' || ")} AS path
FROM x LEFT JOIN employees e ON e.emp_id = x.emp_id
WHERE ${cont} AND ${inc}
  ${excludePartial ? `AND NOT ${partial(monthsCols)}` : ""}
ORDER BY x.ym, x.emp_id`;
}

/** ④ 부서 내 편차: 같은 부서 · 같은 월 직원 대비 z ≥ 기준 이고 중앙값보다 높음 */
export const sqlRuleOtDeptOutlier = (c) => `WITH ${EM_CTE},
d AS (SELECT em.emp_id, em.ym, em.ot, e.dept,
        AVG(em.ot) OVER g AS mu, median(em.ot) OVER g AS med, stddev_samp(em.ot) OVER g AS sd, COUNT(*) OVER g AS n
      FROM em JOIN employees e ON e.emp_id = em.emp_id
      WINDOW g AS (PARTITION BY e.dept, em.ym))
SELECT emp_id, dept, ym, ot AS actual, ROUND(mu, 2) AS dept_mean, med AS dept_median, ROUND(sd, 2) AS dept_sd, n AS dept_n,
       ROUND((ot - mu) / sd, 2) AS z
FROM d WHERE sd > 0 AND (ot - mu) / sd >= ${num(c.z)} AND ot > med
ORDER BY ym, emp_id`;

/** 부서 12개월 퇴사율 기준 초과 */
export const sqlRuleAttrition = (c, p) => `WITH a AS (${sqlAttritionRolling(p)})
SELECT 월 AS ym, 부서 AS dept, 퇴사율_pct AS actual, ${num(c.value)} AS threshold, 퇴사자_12개월 AS leavers, 평균_월말재직 AS avg_hc
FROM a WHERE 부서 <> '전체' AND 퇴사율_pct > ${num(c.value)} ORDER BY 1, 2`;

/** 월 급여 지급액 전월 대비 변화율 |%| ≥ 기준 */
export const sqlRulePayChange = (c) => `WITH t AS (${sqlPayTrend()})
SELECT 월 AS ym, 지급액 AS actual, 전월대비_pct AS change_pct FROM t
WHERE 전월대비_pct IS NOT NULL AND abs(전월대비_pct) >= ${num(c.value)} ORDER BY 1`;

/** 근태 데이터 검증: 사번 · 월별로 묶어 문제 건수를 센다 */
export const sqlRuleAttendanceDq = (c) => {
  const maxH = num(c.maxHours);
  return `WITH a AS (SELECT a.*, e.emp_id AS known, e.hire_date, e.leave_date,
                  COUNT(*) OVER (PARTITION BY a.emp_id, a.work_date) AS dup
           FROM attendance a LEFT JOIN employees e ON e.emp_id = a.emp_id),
chk AS (
  SELECT emp_id, work_date, '중복 기록 (같은 사번 · 같은 날짜)' AS issue FROM a WHERE dup > 1
  UNION ALL SELECT emp_id, work_date, '음수 근무시간' FROM a WHERE regular_hours < 0 OR overtime_hours < 0
  UNION ALL SELECT emp_id, work_date, '하루 근무시간 ${maxH}시간 초과' FROM a WHERE regular_hours + overtime_hours > ${maxH}
  UNION ALL SELECT emp_id, work_date, '근무시간 누락(NULL)' FROM a WHERE regular_hours IS NULL OR overtime_hours IS NULL
  UNION ALL SELECT emp_id, work_date, '날짜 누락(NULL)' FROM a WHERE work_date IS NULL
  UNION ALL SELECT emp_id, work_date, '주말 날짜 (데이터 사전: 주말 행 없음)' FROM a WHERE dayofweek(work_date) IN (0, 6)
  UNION ALL SELECT emp_id, work_date, '직원 목록에 없는 사번' FROM a WHERE known IS NULL
  UNION ALL SELECT emp_id, work_date, '재직기간 밖의 근무 기록' FROM a WHERE known IS NOT NULL AND (work_date < hire_date OR (leave_date IS NOT NULL AND work_date > leave_date))
  UNION ALL SELECT emp_id, work_date, '근무 유형과 시간 불일치 (데이터 사전 기준)' FROM a
    WHERE (work_type = '근무' AND regular_hours <> 8) OR (work_type IN ('연차', '병가') AND (regular_hours <> 0 OR overtime_hours <> 0))
  UNION ALL SELECT emp_id, work_date, '알 수 없는 근무 유형' FROM a WHERE work_type IS NULL OR work_type NOT IN ('근무', '연차', '병가')
)
SELECT emp_id, COALESCE(strftime(work_date, '%Y-%m'), '날짜없음') AS ym, issue, COUNT(*) AS cnt,
       string_agg(DISTINCT CAST(work_date AS VARCHAR), ', ') AS dates
FROM chk GROUP BY 1, 2, 3 ORDER BY 2, 1, 3`;
};

/** 급여 데이터 검증 */
export const sqlRulePayrollDq = () => `WITH p AS (SELECT p.*, e.emp_id AS known, e.hire_date, e.leave_date,
                  COUNT(*) OVER (PARTITION BY p.pay_month, p.emp_id, p.pay_item) AS dup
           FROM payroll p LEFT JOIN employees e ON e.emp_id = p.emp_id),
pm AS (SELECT emp_id, pay_month, COUNT(*) FILTER (WHERE pay_item = '기본급여') AS base_n FROM payroll GROUP BY 1, 2),
chk AS (
  SELECT emp_id, pay_month, '급여 항목 중복 (같은 월 · 사번 · 항목)' AS issue FROM p WHERE dup > 1
  UNION ALL SELECT emp_id, pay_month, '금액 누락(NULL)' FROM p WHERE amount IS NULL
  UNION ALL SELECT emp_id, pay_month, '음수 금액' FROM p WHERE amount < 0
  UNION ALL SELECT emp_id, pay_month, '기본급여 0원' FROM p WHERE pay_item = '기본급여' AND amount = 0
  UNION ALL SELECT emp_id, pay_month, '알 수 없는 급여 항목' FROM p WHERE pay_item IS NULL OR pay_item NOT IN ('기본급여', '수당급여', '기타급여')
  UNION ALL SELECT emp_id, pay_month, '직원 목록에 없는 사번' FROM p WHERE known IS NULL
  UNION ALL SELECT emp_id, pay_month, '재직기간 밖의 지급월' FROM p WHERE known IS NOT NULL
    AND (last_day(strptime(pay_month || '-01', '%Y-%m-%d')::DATE) < hire_date OR strptime(pay_month || '-01', '%Y-%m-%d')::DATE > COALESCE(leave_date, DATE '9999-12-31'))
  UNION ALL SELECT emp_id, pay_month, '기본급여 항목 누락' FROM pm WHERE base_n = 0
  UNION ALL SELECT pm.emp_id, pm.pay_month, '급여는 있으나 그 달 근태 기록 없음 (입사·퇴사일이 휴일이면 정상일 수 있음)' FROM pm
    WHERE NOT EXISTS (SELECT 1 FROM attendance a WHERE a.emp_id = pm.emp_id AND strftime(a.work_date, '%Y-%m') = pm.pay_month)
)
SELECT emp_id, pay_month AS ym, issue, COUNT(*) AS cnt FROM chk GROUP BY 1, 2, 3 ORDER BY 2, 1, 3`;

// ── 직원 상세 (개인 급여 금액은 조회하지 않는다) ─────────
const empLit = (id) => {
  if (!/^[\w가-힣.-]{1,40}$/.test(String(id))) throw new Error("사번 형식이 올바르지 않습니다.");
  return `'${id}'`;
};
export const sqlEmployee = (id) => `SELECT emp_id AS 사번, dept AS 부서, job_family AS 직무, grade AS 직급, position AS 직책,
  employment_type AS 고용형태, hire_date AS 입사일, hire_source AS 입사경로, leave_date AS 퇴사일
FROM employees WHERE emp_id = ${empLit(id)}`;

export const sqlEmpOtWindow = (id, from, to) => `WITH ${EM_CTE},
emp AS (SELECT dept FROM employees WHERE emp_id = ${empLit(id)}),
dm AS (SELECT em.ym, ROUND(SUM(em.ot) / COUNT(*), 2) AS dept_avg, ROUND(median(em.ot), 1) AS dept_median
       FROM em JOIN employees e ON e.emp_id = em.emp_id WHERE e.dept = (SELECT dept FROM emp) GROUP BY 1)
SELECT m.ym AS 월, em.ot AS 본인_초과근로, em.work_days AS 근무기록일수, dm.dept_avg AS 부서_평균, dm.dept_median AS 부서_중앙값
FROM (SELECT DISTINCT ym FROM em WHERE ym BETWEEN '${ym(from)}' AND '${ym(to)}') m
LEFT JOIN em ON em.ym = m.ym AND em.emp_id = ${empLit(id)}
LEFT JOIN dm ON dm.ym = m.ym ORDER BY 1`;

export const sqlEmpDeptDist = (id, month) => `WITH ${EM_CTE},
d AS (SELECT em.emp_id, em.ot FROM em JOIN employees e ON e.emp_id = em.emp_id
      WHERE em.ym = '${ym(month)}' AND e.dept = (SELECT dept FROM employees WHERE emp_id = ${empLit(id)}))
SELECT COUNT(*) AS 부서_인원, ROUND(AVG(ot), 2) AS 평균, ROUND(median(ot), 1) AS 중앙값,
  ROUND(quantile_cont(ot, 0.75), 1) AS p75, ROUND(quantile_cont(ot, 0.9), 1) AS p90, MAX(ot) AS 최대,
  (SELECT ot FROM d WHERE emp_id = ${empLit(id)}) AS 본인,
  ROUND(100.0 * COUNT(*) FILTER (WHERE ot < (SELECT ot FROM d WHERE emp_id = ${empLit(id)})) / COUNT(*), 1) AS 본인보다_낮은_비율_pct
FROM d`;

export const sqlEmpAttendanceRows = (id, month) => `SELECT work_date AS 근무일, work_type AS 근무유형, regular_hours AS 정규시간, overtime_hours AS 초과근로
FROM attendance WHERE emp_id = ${empLit(id)} AND strftime(work_date, '%Y-%m') = '${ym(month)}' ORDER BY 1`;

export const sqlEmpMonthOt = (id, month) => `SELECT COALESCE(SUM(overtime_hours), NULL) AS ot, COUNT(*) AS work_days
FROM attendance WHERE emp_id = ${empLit(id)} AND strftime(work_date, '%Y-%m') = '${ym(month)}'`;
