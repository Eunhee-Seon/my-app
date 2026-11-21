// 시작점: 탭 전환 → DB 준비(data/ CSV 6개) → 각 탭 연결
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
showTab(location.hash.slice(1));

const status = document.getElementById("db-status");
const setReady = (ready) => {
  askTab.setReady(ready);
  savedTab.setReady(ready);
  filesTab.setReady(ready);
};
askTab.setup();
tablesTab.setup();
filesTab.setup();
await savedTab.setup();
setReady(false);

db.init((msg) => (status.textContent = msg))
  .then(() => {
    status.textContent = `데이터 준비됨 · 테이블 ${db.registry.size}개`;
    status.classList.add("ok");
    setReady(true);
    window.addEventListener("tables-changed", () => (status.textContent = `데이터 준비됨 · 테이블 ${db.registry.size}개`));
  })
  .catch((e) => {
    status.textContent = `데이터 준비 실패: ${e.message}`;
    status.classList.add("error");
    console.error(e);
  });
