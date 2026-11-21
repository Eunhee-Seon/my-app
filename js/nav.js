// 탭 이동(URL 해시). 기존 해시(#saved #ask #tables #files)는 그대로이고, #ops #review #actions 를 더한다.
export const TABS = ["ops", "saved", "ask", "review", "actions", "tables", "files"];
const listeners = new Set();

export function showTab(name) {
  if (!TABS.includes(name)) name = "ops";
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.setAttribute("aria-selected", String(btn.dataset.tab === name));
  });
  TABS.forEach((t) => {
    const el = document.getElementById(`tab-${t}`);
    if (el) el.hidden = t !== name;
  });
  if (location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
  for (const fn of listeners) fn(name);
}
export const onTab = (fn) => listeners.add(fn);
export const currentTab = () => (TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "ops");
