// 검토 기준 · 조치 기록 저장소 — 로컬 데모용.
// 이 앱에는 인증 · 권한 · 서버 저장이 없다. 아래 데이터는 이 브라우저의 localStorage 에만 저장되며
// 다른 PC · 다른 브라우저 · 다른 사용자와 공유되지 않고, 브라우저 데이터를 지우면 사라진다.
// localStorage 를 쓸 수 없으면(사생활 보호 모드 등) 이 탭이 열려 있는 동안만 메모리에 둔다.

const KEYS = { criteria: "hr.criteria.v1", actions: "hr.actions.v1", seen: "hr.firstSeen.v1" };
const mem = {};
export const storage = { persistent: true };

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    storage.persistent = false;
    return key in mem ? mem[key] : fallback;
  }
}
function save(key, value) {
  mem[key] = value;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    storage.persistent = false;
  }
}
const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();

// ── 검토 기준 ─────────────────────────────────────────
export const CRITERIA_TYPES = ["운영 기준", "통계적 탐지 기준", "데이터 검증 기준"];

/** 기본 기준(모두 시범 기준 — 회사가 공식 확정한 기준이 아니다) */
const DEFAULT_CRITERIA = [
  { id: "ot_over", name: "월 초과근로시간 기준 초과", type: "운영 기준", category: "운영 기준 초과",
    metric: "직원별 월 초과근로시간 (attendance.overtime_hours 월 합계)", compare: "초과 (>)",
    params: { value: 30 }, paramDefs: [{ key: "value", label: "기준시간", unit: "시간", step: 0.5 }],
    target: "근태 기록이 있는 전 직원" },
  { id: "ot_spike", name: "전월 대비 초과근로 급증", type: "통계적 탐지 기준", category: "통계적 이상치",
    metric: "직원별 월 초과근로시간의 전월 대비 변화", compare: "증가시간 ≥ 최소시간 그리고 증가율 ≥ 기준 (전월 0시간이면 증가율 산정 불가로 별도 표시)",
    params: { rate: 50, minHours: 10 }, paramDefs: [{ key: "rate", label: "증가율", unit: "%", step: 5 }, { key: "minHours", label: "최소 증가시간", unit: "시간", step: 0.5 }],
    target: "바로 앞 달 근태 기록이 있는 직원" },
  { id: "ot_consec", name: "초과근로 연속 증가", type: "통계적 탐지 기준", category: "통계적 이상치",
    metric: "직원별 월 초과근로시간", compare: "연속 증가 횟수 ≥ 기준 (해당 기간 모든 월의 기록 필요)",
    params: { count: 3 }, paramDefs: [{ key: "count", label: "연속 증가 횟수", unit: "회", step: 1 }],
    target: "연속된 월의 근태 기록이 모두 있는 직원" },
  { id: "ot_dept_outlier", name: "부서 내 초과근로 편차", type: "통계적 탐지 기준", category: "통계적 이상치",
    metric: "같은 부서 · 같은 월 직원 대비 표준점수(z)", compare: "z ≥ 기준 그리고 부서 중앙값 초과",
    params: { z: 2, smallN: 10 }, paramDefs: [{ key: "z", label: "표준점수 기준", unit: "z", step: 0.1 }, { key: "smallN", label: "소규모 부서 주의 인원", unit: "명 미만", step: 1 }],
    target: "근태 기록이 있는 전 직원 (현재 부서 기준)" },
  { id: "dept_attrition", name: "부서 12개월 퇴사율 기준 초과", type: "운영 기준", category: "운영 기준 초과",
    metric: "최근 12개월 퇴사자 수 ÷ 같은 기간 평균 월말 재직 인원 × 100", compare: "초과 (>)",
    params: { value: 20 }, paramDefs: [{ key: "value", label: "퇴사율", unit: "%", step: 1 }],
    target: "부서 (employees.dept, 조직 이동 이력 없음)" },
  { id: "pay_change", name: "월 급여 지급액 급변", type: "통계적 탐지 기준", category: "통계적 이상치",
    metric: "회사 전체 월 급여 지급액(payroll.amount 합계)의 전월 대비 변화율", compare: "|변화율| ≥ 기준",
    params: { value: 20 }, paramDefs: [{ key: "value", label: "변화율", unit: "%", step: 1 }],
    target: "회사 전체" },
  { id: "att_dq", name: "근태 데이터 검증", type: "데이터 검증 기준", category: "데이터 품질",
    metric: "attendance 행 단위 검사 (중복 · 음수 · 시간 상한 · 주말 · 미등록 사번 · 재직기간 밖 · 유형-시간 불일치)", compare: "해당 시 1건 이상",
    params: { maxHours: 24 }, paramDefs: [{ key: "maxHours", label: "하루 근무시간 상한", unit: "시간", step: 1 }],
    target: "attendance 전체" },
  { id: "pay_dq", name: "급여 데이터 검증", type: "데이터 검증 기준", category: "데이터 품질",
    metric: "payroll 행 단위 검사 (항목 중복 · 누락 · 음수 · 미등록 사번 · 재직기간 밖 · 기본급여 누락 · 근태 없음)", compare: "해당 시 1건 이상",
    params: {}, paramDefs: [], target: "payroll 전체" },
  { id: "calc_rules", name: "집계 기준", type: "운영 기준", category: null,
    metric: "월말 재직 산정 · 증감 비교 대상", compare: "설정값",
    params: { includeLeaveDay: 0, excludePartial: 1 },
    paramDefs: [
      { key: "includeLeaveDay", label: "퇴사일 당일 재직 포함 (1=포함, 0=미포함)", unit: "", step: 1 },
      { key: "excludePartial", label: "입사·퇴사 월은 전월 대비 · 연속 증가 판정에서 제외 (1=제외)", unit: "", step: 1 },
    ],
    target: "운영 현황 · 검토 항목 전체" },
];

function initCriteria() {
  const start = today();
  return DEFAULT_CRITERIA.map((c) => ({
    ...c, version: 1, pilot: true, startDate: start,
    reason: c.id === "calc_rules"
      ? "데이터 사전 '재직자' 정의(퇴사일 이후만 재직)에 맞춘 초기값"
      : "시범 분석용 초기값 — 법정 기준 · 회사 규정으로 확정된 값이 아님",
    history: [{ version: 1, params: { ...c.params }, startDate: start, changedAt: nowIso(), reason: "초기 설정 (시범 기준)", pilot: true }],
  }));
}

export function getCriteria() {
  let list = load(KEYS.criteria, null);
  if (!Array.isArray(list) || !list.length) {
    list = initCriteria();
    save(KEYS.criteria, list);
  }
  // 새로 추가된 기본 기준이 있으면 보충
  for (const d of DEFAULT_CRITERIA) {
    if (!list.some((c) => c.id === d.id)) list.push(initCriteria().find((c) => c.id === d.id));
  }
  // 정의(문구 · 파라미터 설명)는 코드 기준, 값 · 이력은 저장된 것
  return list.map((c) => {
    const d = DEFAULT_CRITERIA.find((x) => x.id === c.id) || {};
    return { ...c, paramDefs: d.paramDefs || c.paramDefs, metric: d.metric || c.metric, compare: d.compare || c.compare, category: d.category ?? c.category };
  });
}
export const criterion = (id) => getCriteria().find((c) => c.id === id);

/** 기준 변경: 버전을 올리고 이력에 남긴다. 사유는 필수. */
export function updateCriterion(id, { params, startDate, reason, pilot }) {
  if (!String(reason || "").trim()) throw new Error("변경 사유를 입력하세요.");
  const list = getCriteria();
  const c = list.find((x) => x.id === id);
  if (!c) throw new Error("기준을 찾을 수 없습니다.");
  const clean = {};
  for (const def of c.paramDefs) {
    const v = Number(params[def.key]);
    if (!Number.isFinite(v)) throw new Error(`${def.label} 값이 숫자가 아닙니다.`);
    if (v < 0) throw new Error(`${def.label} 값은 0 이상이어야 합니다.`);
    clean[def.key] = v;
  }
  c.version += 1;
  c.params = clean;
  c.startDate = startDate || today();
  c.reason = reason.trim();
  c.pilot = !!pilot;
  c.history.push({ version: c.version, params: { ...clean }, startDate: c.startDate, changedAt: nowIso(), reason: c.reason, pilot: c.pilot });
  save(KEYS.criteria, list);
  window.dispatchEvent(new CustomEvent("criteria-changed", { detail: { id } }));
  return c;
}

export function paramsText(c, params = c.params) {
  return (c.paramDefs || []).map((d) => `${d.label} ${params[d.key]}${d.unit ? " " + d.unit : ""}`).join(" · ") || "—";
}

/** 집계 기준을 탐지 SQL용 값으로 */
export function calcRules() {
  const c = criterion("calc_rules");
  return { includeLeaveDay: Number(c.params.includeLeaveDay) === 1, excludePartial: Number(c.params.excludePartial) !== 0 };
}

// ── 최초 탐지일 (이 브라우저에서 처음 발견된 날짜와 그때의 기준 버전) ──
export function markSeen(items) {
  const seen = load(KEYS.seen, {});
  let changed = false;
  const d = today();
  for (const it of items) {
    if (!seen[it.id]) {
      seen[it.id] = { date: d, criterionId: it.criterionId, version: it.criterionVersion, params: it.criterionParams };
      changed = true;
    }
  }
  if (changed) save(KEYS.seen, seen);
  return seen;
}
export const firstSeen = (id) => load(KEYS.seen, {})[id] || null;

// ── 조치 기록 ─────────────────────────────────────────
export const STATUSES = ["미확인", "확인 중", "조치 예정", "조치 중", "조치 완료", "종결"];

export const getActions = () => load(KEYS.actions, {});
export const getAction = (itemId) => getActions()[itemId] || null;
export const statusOf = (itemId) => getAction(itemId)?.status || "미확인";

/**
 * 조치 기록 저장. 상태별 필수 항목을 검사하고, 변경마다 로그를 남긴다.
 * item 의 탐지 당시 값 · 기준 버전을 처음 저장할 때 함께 고정한다.
 */
export function saveAction(item, patch) {
  const all = getActions();
  const prev = all[item.id];
  const rec = {
    itemId: item.id,
    target: item.target, dept: item.dept, rule: item.rule, ruleName: item.ruleName, category: item.category,
    period: item.ym, actual: item.actual, threshold: item.threshold, diff: item.diff, unit: item.unit,
    firstDetected: prev?.firstDetected || firstSeen(item.id)?.date || today(),
    criterion: prev?.criterion || { id: item.criterionId, version: item.criterionVersion, params: item.criterionParams },
    owner: "", cause: "", needAction: "미정", actionText: "", plannedDate: "", doneDate: "", followupDate: "",
    status: "미확인", finalBasis: "", closeReason: "", evaluation: "", log: [],
    ...prev,
    ...patch,
  };
  if (!STATUSES.includes(rec.status)) throw new Error("알 수 없는 상태입니다.");
  if (rec.status !== "미확인" && !String(rec.owner).trim()) throw new Error("담당자를 입력하세요.");
  if (rec.status === "조치 예정" && !rec.plannedDate) throw new Error("조치 예정일을 입력하세요.");
  if (["조치 예정", "조치 중", "조치 완료"].includes(rec.status) && rec.needAction === "불필요")
    throw new Error("조치 필요 여부가 '불필요'이면 사유를 적고 '종결'로 처리하세요.");
  if (rec.status === "조치 완료" && (!String(rec.actionText).trim() || !rec.doneDate))
    throw new Error("조치 완료에는 조치 내용과 완료일이 필요합니다.");
  if (rec.status === "종결" && !String(rec.finalBasis).trim()) throw new Error("종결에는 최종 판단 근거가 필요합니다.");
  if (rec.status === "종결" && rec.needAction === "불필요" && !String(rec.closeReason).trim())
    throw new Error("조치 불필요로 종결할 때는 종결 사유를 선택하세요.");
  const changes = Object.keys(patch).filter((k) => k !== "log" && String(prev?.[k] ?? "") !== String(patch[k] ?? ""));
  rec.log = [...(prev?.log || []), { at: nowIso(), by: rec.owner || "-", status: rec.status, changed: changes }];
  rec.updatedAt = nowIso();
  all[item.id] = rec;
  save(KEYS.actions, all);
  window.dispatchEvent(new CustomEvent("actions-changed", { detail: { id: item.id } }));
  return rec;
}

/** 내보내기 / 가져오기 (JSON) — 다른 브라우저로 옮기거나 보관할 때 */
export function exportAll() {
  return JSON.stringify({ exportedAt: nowIso(), note: "HR 운영 리포트 로컬 데모 데이터 (가상 데이터 기반)", criteria: load(KEYS.criteria, []), actions: getActions(), firstSeen: load(KEYS.seen, {}) }, null, 2);
}
export function importAll(text) {
  const d = JSON.parse(text);
  if (!d || typeof d !== "object" || typeof d.actions !== "object") throw new Error("형식이 올바르지 않은 파일입니다.");
  if (Array.isArray(d.criteria) && d.criteria.length) save(KEYS.criteria, d.criteria);
  save(KEYS.actions, d.actions || {});
  if (d.firstSeen) save(KEYS.seen, d.firstSeen);
  window.dispatchEvent(new CustomEvent("criteria-changed"));
  window.dispatchEvent(new CustomEvent("actions-changed"));
}
