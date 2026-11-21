// 시작점: 탭 전환(URL 해시) → DB 준비(data/ CSV 6개) → 각 탭 연결 → 헤더 정보
import * as db from "./db.js";
import * as askTab from "./ask.js";
import * as savedTab from "./saved.js";
import * as tablesTab from "./tables.js";
import * as filesTab from "./files.js";

const TABS = ["saved", "ask", "tables", "files"];

function showTab(name) {
  if (!TABS.includes(name)) name = "saved";
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.setAttribute("aria-selected", String(btn.dataset.tab === name));
  });
  TABS.forEach((t) => {
    document.getElementById(`tab-${t}`).hidden = t !== name;
  });
  history.replaceState(null, "", `#${name}`);
}

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
});
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
showTab(location.hash.slice(1));

const status = document.getElementById("db-status");
const setReady = (ready) => {
  askTab.setReady(ready);
  savedTab.setReady(ready);
  filesTab.setReady(ready);
};

/** 헤더: 연결 테이블 수, 급여 기준월(payroll 의 가장 최근 pay_month). 알 수 없으면 '—'. */
async function updateHeader() {
  document.getElementById("meta-tables").textContent = db.registry.size ? `${db.registry.size}개` : "—";
  let month = "—";
  if (db.registry.has("payroll")) {
    try {
      const r = await db.run("SELECT MAX(pay_month) AS m FROM payroll");
      const m = r.rows[0]?.m;
      if (typeof m === "string" && /^\d{4}-\d{2}$/.test(m)) month = m;
    } catch { /* 구조가 다른 payroll 이면 표시하지 않는다 */ }
  }
  document.getElementById("meta-month").textContent = month;
}

askTab.setup();
tablesTab.setup();
filesTab.setup();
await savedTab.setup();
setReady(false);

db.init((msg) => (status.textContent = `로딩 중 · ${msg.replace(/ 올리는 중…| 중…/g, "")}`))
  .then(async () => {
    status.textContent = "준비됨";
    status.classList.add("ok");
    setReady(true);
    await updateHeader();
    window.addEventListener("tables-changed", updateHeader);
  })
  .catch((e) => {
    status.textContent = `로딩 실패: ${e.message}`;
    status.classList.add("error");
    console.error(e);
  });
