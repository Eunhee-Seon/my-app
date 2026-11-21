// 조치 현황: 조치 목록 · 후속 점검 · 검토 기준 · 저장 범위. 조치는 HR 담당자가 기록하며 시스템이 자동 집행하지 않는다.
import * as db from "./db.js";
import * as M from "./metrics.js";
import { renderTable } from "./ask.js";
import { esc } from "./explain.js";
import { detect, lastResult, missingTables } from "./detect.js";
import { getCriteria, updateCriterion, paramsText, CRITERIA_TYPES, STATUSES, getActions, statusOf, storage, exportAll, importAll, calcRules } from "./store.js";
import { showTab, onTab } from "./nav.js";
import { openItem, statusTag } from "./review.js";

const $ = (id) => document.getElementById(id);
let sub = "list";
let ready = false;
let editing = null;
let listFilter = { status: "", owner: "" };

const OT_RULES = ["ot_over", "ot_spike", "ot_consec", "ot_dept_outlier"];
const n1 = (v, d = 1) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: d }));

async function ensureDetect() {
  if (lastResult()) return lastResult();
  if (missingTables().length) return null;
  try { return await detect(); } catch { return null; }
}

function render() {
  document.querySelectorAll("#act-subnav button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.sub === sub)));
  if (sub === "list") renderList();
  else if (sub === "follow") renderFollow();
  else if (sub === "criteria") renderCriteria();
  else renderStorage();
}

// ── 조치 목록 ─────────────────────────────────────────
async function renderList() {
  const box = $("act-body");
  const det = await ensureDetect();
  const recs = Object.values(getActions());
  const detected = det ? det.items : [];
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const it of detected) counts[statusOf(it.id)]++;
  const orphan = recs.filter((r) => !detected.some((i) => i.id === r.itemId));
  for (const r of orphan) counts[r.status]++;
  const owners = [...new Set(recs.map((r) => r.owner).filter(Boolean))].sort();
  const list = recs.filter((r) => (!listFilter.status || r.status === listFilter.status) && (!listFilter.owner || r.owner === listFilter.owner))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  box.innerHTML = `
    <div class="kpi status-kpi">${STATUSES.map((s) => `<div class="kpi-item"><div class="kpi-label">${s}</div><div class="kpi-value">${counts[s].toLocaleString()}<small>건</small></div></div>`).join("")}</div>
    <p class="note">현재 계산된 검토 항목 ${detected.length.toLocaleString()}건 기준이며, 기록이 없는 항목은 '미확인'입니다.${orphan.length ? ` 현재 기준으로는 더 이상 탐지되지 않지만 기록이 남아 있는 항목 ${orphan.length}건을 포함합니다.` : ""}</p>
    <div class="filters">
      <label>상태<select id="al-status"><option value="">전체</option>${STATUSES.map((s) => `<option ${s === listFilter.status ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label>담당자<select id="al-owner"><option value="">전체</option>${owners.map((o) => `<option ${o === listFilter.owner ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></label>
    </div>
    ${list.length ? `<div class="table-scroll tall"><table class="grid">
      <thead><tr><th>검토 항목 ID</th><th>직원 ID / 조직</th><th>탐지 유형</th><th>최초 탐지일</th><th class="num">실제값</th><th>기준값</th><th>담당자</th><th>확인한 원인</th><th>조치 필요</th><th>조치 내용</th><th>조치 예정일</th><th>완료일</th><th>후속 점검일</th><th>검토 상태</th><th>최종 판단 근거</th><th></th></tr></thead>
      <tbody>${list.map((r) => `<tr>
        <td class="mono">${esc(r.itemId)}</td><td class="name">${esc(r.target)}</td><td>${esc(r.ruleName)}<span class="small">${esc(r.category)} · ${esc(r.period)}</span></td>
        <td>${esc(r.firstDetected)}</td><td class="num">${esc(n1(r.actual))}${esc(r.unit || "")}</td><td>${esc(r.threshold)}${esc(r.unit || "")}<span class="small">기준 v${esc(r.criterion?.version ?? "—")}</span></td>
        <td>${esc(r.owner || "—")}</td><td class="reason">${esc(r.cause || "—")}</td><td>${esc(r.needAction)}</td><td class="reason">${esc(r.actionText || "—")}</td>
        <td>${esc(r.plannedDate || "—")}</td><td>${esc(r.doneDate || "—")}</td><td>${esc(r.followupDate || "—")}</td><td>${statusTag(r.status)}</td>
        <td class="reason">${esc(r.finalBasis || "—")}${r.closeReason ? `<span class="small">${esc(r.closeReason)}</span>` : ""}</td>
        <td class="actions"><button type="button" class="btn small link go-item" data-id="${esc(r.itemId)}">상세 보기</button></td></tr>`).join("")}</tbody>
    </table></div>` : '<p class="empty">아직 조치 기록이 없습니다. 검토 항목의 상세 화면에서 기록을 시작하세요.</p>'}`;
  $("al-status").addEventListener("change", (e) => { listFilter.status = e.target.value; renderList(); });
  $("al-owner").addEventListener("change", (e) => { listFilter.owner = e.target.value; renderList(); });
  box.querySelectorAll(".go-item").forEach((b) => b.addEventListener("click", () => goItem(b.dataset.id)));
}

async function goItem(id) {
  await ensureDetect();
  openItem(id);
  showTab("review");
}

// ── 후속 점검 ─────────────────────────────────────────
async function followUp(r, det, workdays) {
  const after = r.followupDate && r.followupDate.slice(0, 7) > r.period ? r.followupDate.slice(0, 7) : /^\d{4}-\d{2}$/.test(r.period) ? M.addMonths(r.period, 1) : null;
  const out = { before: r.actual, after: null, afterMonth: after, recur: "—", note: "" };
  const wdB = workdays.get(r.period), wdA = workdays.get(after);
  if (wdB && wdA) out.note = `회사 근무일수 ${r.period} ${wdB}일 → ${after} ${wdA}일`;
  if (!after) return out;
  const items = det ? det.items : [];
  const empId = String(r.itemId).split("|")[1];
  if (OT_RULES.includes(r.rule)) {
    const res = await db.run(M.sqlEmpMonthOt(empId, after));
    const row = res.rows[0];
    out.after = row && row.work_days > 0 ? row.ot : null;
    if (out.after === null) out.note = `${after} 근태 기록 없음 — 데이터를 올린 뒤 다시 확인하세요. ${out.note}`;
    out.recur = out.after === null ? "확인 불가" : items.some((i) => i.rule === r.rule && i.empId === empId && i.ym === after) ? "재발 (같은 조건 다시 탐지)" : "같은 조건 미탐지";
  } else if (r.rule === "dept_attrition") {
    const res = await db.run(`WITH a AS (${M.sqlAttritionRolling(calcRules())}) SELECT 퇴사율_pct FROM a WHERE 부서 = '${String(r.target).replace(/'/g, "''")}' AND 월 = '${after}'`);
    out.after = res.rows[0]?.퇴사율_pct ?? null;
    out.recur = out.after === null ? "확인 불가" : items.some((i) => i.rule === r.rule && i.target === r.target && i.ym === after) ? "재발 (같은 조건 다시 탐지)" : "같은 조건 미탐지";
    if (out.after === null) out.note = `${after} 데이터 없음`;
  } else if (r.rule === "pay_change") {
    const res = await db.run(`WITH t AS (${M.sqlPayTrend()}) SELECT 전월대비_pct FROM t WHERE 월 = '${after}'`);
    out.after = res.rows[0]?.전월대비_pct ?? null;
    out.recur = out.after === null ? "확인 불가" : items.some((i) => i.rule === r.rule && i.ym === after) ? "재발 (같은 조건 다시 탐지)" : "같은 조건 미탐지";
  } else {
    // 데이터 품질: 같은 항목이 지금도 탐지되는지 재검증
    out.afterMonth = "현재 데이터 재검증";
    const still = items.some((i) => i.id === r.itemId);
    out.after = still ? r.actual : 0;
    out.recur = still ? "여전히 발견됨" : "해소됨 (현재 데이터에서 미발견)";
  }
  return out;
}

async function renderFollow() {
  const box = $("act-body");
  box.innerHTML = '<p class="msg">불러오는 중…</p>';
  const det = await ensureDetect();
  const recs = Object.values(getActions()).filter((r) => ["조치 완료", "종결"].includes(r.status) || r.followupDate);
  let workdays = new Map();
  try { workdays = new Map((await db.run(M.sqlWorkdays())).rows.map((r) => [r["월"], r["근무일수"]])); } catch { /* 없음 */ }
  const rows = [];
  for (const r of recs) {
    let f;
    try { f = await followUp(r, det, workdays); } catch (e) { f = { before: r.actual, after: null, afterMonth: "—", recur: "오류", note: e.message }; }
    const change = f.after !== null && f.before !== null && typeof f.before === "number" ? Math.round((f.after - f.before) * 10) / 10 : null;
    rows.push(`<tr><td class="name">${esc(r.target)}</td><td>${esc(r.ruleName)}<span class="small">${esc(r.period)}</span></td>
      <td class="num">${esc(n1(f.before))}${esc(r.unit || "")}</td><td class="num">${esc(n1(f.after))}${f.after === null ? "" : esc(r.unit || "")}<span class="small">${esc(f.afterMonth || "—")}</span></td>
      <td class="num">${change === null ? "—" : `${change > 0 ? "+" : ""}${n1(change)}${esc(r.unit || "")}`}</td>
      <td>${esc(r.followupDate || "—")}</td><td>${esc(f.recur)}</td><td class="reason">${esc(r.evaluation || "—")}</td><td>${statusTag(r.status)}</td>
      <td class="reason">${esc(f.note || "—")}</td>
      <td class="actions"><button type="button" class="btn small link go-item" data-id="${esc(r.itemId)}">상세 보기</button></td></tr>`);
  }
  box.innerHTML = `
    <p class="notice">전후 수치가 달라졌더라도 조치의 효과라고 단정하지 않습니다. 프로젝트 종료 · 계절성 · 근무일수 변화 · 입사와 퇴사 · 휴가 등 다른 원인이 있을 수 있습니다.</p>
    <p class="note">조치 후 지표: 후속 점검일이 있으면 그 달, 없으면 대상 기간의 다음 달 값입니다. 데이터 품질 항목은 현재 데이터에서 같은 문제가 다시 발견되는지 재검증합니다.</p>
    ${rows.length ? `<div class="table-scroll tall"><table class="grid">
      <thead><tr><th>직원 ID / 조직</th><th>탐지 유형</th><th class="num">조치 전 지표</th><th class="num">조치 후 지표</th><th class="num">변화량</th><th>후속 점검일</th><th>재발 여부</th><th>HR 담당자 평가</th><th>상태</th><th>참고 (다른 원인)</th><th></th></tr></thead>
      <tbody>${rows.join("")}</tbody></table></div>` : '<p class="empty">후속 점검 대상이 없습니다. 조치 완료 · 종결이거나 후속 점검일이 있는 기록이 여기에 나타납니다.</p>'}`;
  box.querySelectorAll(".go-item").forEach((b) => b.addEventListener("click", () => goItem(b.dataset.id)));
}

// ── 검토 기준 ─────────────────────────────────────────
function renderCriteria() {
  const box = $("act-body");
  const list = getCriteria();
  const hist = list.flatMap((c) => c.history.map((h) => ({ ...h, name: c.name, c }))).sort((a, b) => String(b.changedAt).localeCompare(String(a.changedAt)));
  const ed = editing && list.find((c) => c.id === editing);
  box.innerHTML = `
    <p class="note">모든 기본 기준은 <b>시범 기준</b>입니다. 법정 기준이나 회사 규정으로 확정된 값이 아니며, 기준을 바꾸면 버전이 올라가고 이력이 남습니다. 각 검토 항목과 조치 기록에는 발견 당시의 기준 버전이 함께 기록됩니다.</p>
    <div class="table-scroll auto"><table class="grid">
      <thead><tr><th>기준명</th><th>기준 유형</th><th>적용 지표</th><th>비교 방식</th><th>기준값</th><th>적용 대상</th><th>적용 시작일</th><th>버전</th><th>변경 사유</th><th></th></tr></thead>
      <tbody>${list.map((c) => `<tr class="${c.id === editing ? "selected" : ""}">
        <td class="name">${esc(c.name)} ${c.pilot ? '<span class="tag">시범 기준</span>' : '<span class="tag ok">확정</span>'}</td><td>${esc(c.type)}</td>
        <td class="reason">${esc(c.metric)}</td><td class="reason">${esc(c.compare)}</td><td>${esc(paramsText(c))}</td><td class="reason">${esc(c.target)}</td>
        <td>${esc(c.startDate)}</td><td class="num">v${c.version}</td><td class="reason">${esc(c.reason)}</td>
        <td class="actions">${c.paramDefs.length ? `<button type="button" class="btn small edit-c" data-id="${c.id}">변경</button>` : ""}</td></tr>`).join("")}</tbody>
    </table></div>
    ${ed ? `<form id="crit-form" class="act-form">
      <p class="wide cols-head">기준 변경 — ${esc(ed.name)} (현재 v${ed.version}: ${esc(paramsText(ed))})</p>
      ${ed.paramDefs.map((d) => `<label>${esc(d.label)}${d.unit ? ` (${esc(d.unit)})` : ""}<input type="number" step="${d.step}" min="0" name="p_${d.key}" value="${esc(ed.params[d.key])}" required></label>`).join("")}
      <label>적용 시작일<input type="date" name="startDate" value="${new Date().toISOString().slice(0, 10)}" required></label>
      <label class="check"><input type="checkbox" name="pilot" ${ed.pilot ? "checked" : ""}> 시범 기준 (회사 미확정)</label>
      <label class="wide">변경 사유 (필수)<textarea name="reason" rows="2" required></textarea></label>
      <div class="wide form-foot"><button type="submit" class="btn primary">변경 저장</button><button type="button" class="btn" id="crit-cancel">취소</button><span id="crit-msg" class="msg"></span></div>
      <p class="wide note">저장하면 운영 현황 · 검토 항목에 '기준 변경 — 다시 계산' 표시가 뜹니다. 이미 기록된 조치는 기록 당시의 기준 버전을 그대로 유지합니다.</p>
    </form>` : ""}
    <h3 class="sec-title">기준 변경 이력</h3>
    <div class="table-scroll"><table class="grid">
      <thead><tr><th>변경 시각</th><th>기준명</th><th class="num">버전</th><th>기준값</th><th>적용 시작일</th><th>구분</th><th>변경 사유</th></tr></thead>
      <tbody>${hist.map((h) => `<tr><td>${esc(new Date(h.changedAt).toLocaleString("ko-KR"))}</td><td>${esc(h.name)}</td><td class="num">v${h.version}</td>
        <td>${esc(paramsText(h.c, h.params))}</td><td>${esc(h.startDate)}</td><td>${h.pilot ? "시범 기준" : "확정"}</td><td class="reason">${esc(h.reason)}</td></tr>`).join("")}</tbody>
    </table></div>
    <p class="note">기준 유형: ${CRITERIA_TYPES.join(" · ")}</p>`;
  box.querySelectorAll(".edit-c").forEach((b) => b.addEventListener("click", () => { editing = b.dataset.id; renderCriteria(); $("crit-form")?.scrollIntoView({ block: "nearest" }); }));
  $("crit-cancel")?.addEventListener("click", () => { editing = null; renderCriteria(); });
  $("crit-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const params = {};
    for (const d of ed.paramDefs) params[d.key] = fd.get(`p_${d.key}`);
    try {
      updateCriterion(ed.id, { params, startDate: fd.get("startDate"), reason: fd.get("reason"), pilot: fd.get("pilot") === "on" });
      editing = null;
      renderCriteria();
    } catch (err) {
      $("crit-msg").textContent = err.message;
      $("crit-msg").className = "msg error";
    }
  });
}

// ── 저장 범위 · 운영 설계 ─────────────────────────────
function renderStorage() {
  const box = $("act-body");
  const n = Object.keys(getActions()).length;
  box.innerHTML = `
    <h3 class="sec">현재 저장 구조 (코드에서 확인한 사실)</h3>
    <table class="kv"><tbody>
      <tr><th>인증 · 권한</th><td>없음. 누구나 같은 화면을 쓰며, 담당자 이름은 입력값일 뿐 본인 확인을 하지 않습니다.</td></tr>
      <tr><th>서버 저장</th><td>없음. 서버 함수는 자연어 질의용 <code class="inline">api/ask</code> 하나뿐이며 조치 기록 · 기준은 서버로 보내지 않습니다.</td></tr>
      <tr><th>조치 기록 · 기준 저장 위치</th><td>${storage.persistent ? "이 브라우저의 localStorage (키: hr.actions.v1 · hr.criteria.v1 · hr.firstSeen.v1)" : "저장소를 쓸 수 없어 메모리에만 있음 — 탭을 닫으면 사라짐"}. 현재 조치 기록 ${n}건.</td></tr>
      <tr><th>한계</th><td>다른 PC · 다른 브라우저 · 다른 담당자와 공유되지 않습니다. 브라우저 데이터 삭제 시 사라집니다. 수정 이력은 같은 브라우저 안의 로그일 뿐 변조를 막지 못합니다.</td></tr>
      <tr><th>인사 데이터</th><td>CSV는 브라우저 안에서만 읽습니다. 조치 기록에는 사번 · 지표 값 · 입력한 메모가 들어갑니다. 개인별 급여 금액은 기록하지 않습니다.</td></tr>
      <tr><th>용도</th><td>가상 데이터 기반 로컬 데모입니다. 실제 직원 데이터로 인사 조치나 불이익을 결정하는 데 쓰지 마세요.</td></tr>
    </tbody></table>
    <div class="input-row" style="margin-top:12px">
      <button type="button" class="btn" id="st-export">JSON 내보내기</button>
      <label class="btn" for="st-import">JSON 가져오기</label><input id="st-import" type="file" accept=".json,application/json" hidden>
      <span id="st-msg" class="msg"></span>
    </div>
    <h3 class="sec-title">실제 운영에 필요한 구성 (설계안 요약)</h3>
    <table class="kv"><tbody>
      <tr><th>DB</th><td>사내 DB(예: PostgreSQL)에 review_items(탐지 결과 스냅샷) · actions(조치) · action_events(변경 이력, 추가만 가능) · criteria · criteria_versions 테이블</td></tr>
      <tr><th>인증</th><td>사내 SSO(OIDC/SAML) 로그인. 담당자는 로그인한 사용자 ID로 자동 기록</td></tr>
      <tr><th>권한</th><td>HR 관리자(기준 변경 · 종결 승인) · HR 담당자(배정된 항목 처리) · 조직장(자기 조직 집계만 열람) · 감사(읽기 전용)</td></tr>
      <tr><th>감사 · 보존</th><td>모든 변경을 action_events 에 시각 · 사용자 · 이전 값 · 이후 값으로 남기고 수정 · 삭제 불가. 보존 기간과 파기 절차를 규정</td></tr>
      <tr><th>데이터 보호</th><td>원본 인사 데이터는 사내망에서만 처리, 공개 배포 금지. API 키는 서버 환경 변수, 로그에 사번 · 급여 · 파일 내용을 남기지 않음</td></tr>
    </tbody></table>
    <p class="note">전체 설계안: <a href="docs/운영_설계안.md" target="_blank" rel="noopener">docs/운영_설계안.md</a></p>`;
  $("st-export").addEventListener("click", () => {
    const blob = new Blob([exportAll()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `hr-actions-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("st-import").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      importAll(await f.text());
      $("st-msg").textContent = "가져왔습니다.";
      $("st-msg").className = "msg";
    } catch (err) {
      $("st-msg").textContent = err.message;
      $("st-msg").className = "msg error";
    }
    e.target.value = "";
  });
}

export function setup() {
  document.querySelectorAll("#act-subnav button").forEach((b) => b.addEventListener("click", () => { sub = b.dataset.sub; render(); }));
  window.addEventListener("actions-changed", () => { if (!$("tab-actions").hidden) render(); });
  window.addEventListener("criteria-changed", () => { if (!$("tab-actions").hidden) render(); });
  onTab((t) => { if (t === "actions" && ready) render(); });
}
export function setReady(r, activeTab) {
  ready = r;
  if (r && activeTab === "actions") render();
}
