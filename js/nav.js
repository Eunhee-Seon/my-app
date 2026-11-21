// 탭 이동(URL 해시).
// 최상위 메뉴: 정기 리포트(#saved) · HR 모니터링(#monitor) · 직접 조회(#ask) · 데이터 구조(#tables) · 파일 업로드(#files)
// HR 모니터링 보조 메뉴: 운영 현황(#ops) · 검토 항목(#review) · 조치 현황(#actions) — 기존 해시 그대로 동작한다.
export const TOP = ["saved", "monitor", "ask", "tables", "files"];
export const SUBS = ["ops", "review", "actions"];
export const TABS = [...TOP, ...SUBS];
const listeners = new Set();
let lastSub = "ops";

/** 해시 이름 → 실제로 보일 화면 이름(보조 메뉴면 ops/review/actions) */
function resolve(name) {
  if (SUBS.includes(name)) return name;
  if (name === "monitor") return lastSub;
  return TOP.includes(name) ? name : "saved";
}

export function showTab(name) {
  const view = resolve(name);
  const top = SUBS.includes(view) ? "monitor" : view;
  if (SUBS.includes(view)) lastSub = view;
  document.querySelectorAll(".tabs button").forEach((btn) => btn.setAttribute("aria-selected", String(btn.dataset.tab === top)));
  document.querySelectorAll("#monitor-subnav button").forEach((btn) => btn.setAttribute("aria-selected", String(btn.dataset.sub === view)));
  TOP.forEach((t) => {
    const el = document.getElementById(`tab-${t}`);
    if (el) el.hidden = t !== top;
  });
  SUBS.forEach((s) => {
    const el = document.getElementById(`tab-${s}`);
    if (el) el.hidden = s !== view;
  });
  if (location.hash.slice(1) !== view) history.replaceState(null, "", `#${view}`);
  for (const fn of listeners) fn(view);
}
export const onTab = (fn) => listeners.add(fn);
export const currentTab = () => resolve(location.hash.slice(1));
