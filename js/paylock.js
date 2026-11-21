// 급여 상세 정보 시연용 잠금 — 가상 데이터 기반 데모용 화면 잠금일 뿐 보안 기능이 아니다.
// 비밀번호는 이 파일(브라우저에 내려가는 코드)에 들어 있고, 잠금 상태는 메모리에만 있어 새로고침하면 다시 잠긴다.
// 원본 CSV · 정기 리포트 · 직접 조회 · 브라우저 개발자 도구로 같은 데이터를 볼 수 있다.
const DEMO_PASSWORD = "edata9";
let unlocked = false;

export const isPayUnlocked = () => unlocked;

function emit() {
  const head = document.getElementById("paylock-head");
  if (head) head.hidden = !unlocked;
  window.dispatchEvent(new CustomEvent("paylock-changed", { detail: { unlocked } }));
}
export function lockPay() { unlocked = false; emit(); }

/** 잠금 안내 + 비밀번호 입력 HTML */
export function payLockPanel(what = "급여 상세 정보") {
  return `<form class="paylock" autocomplete="off">
    <p><b>${what}는 잠겨 있습니다.</b> 시연용 비밀번호를 입력하면 표시합니다.</p>
    <div class="input-row">
      <input type="password" name="pw" aria-label="급여 정보 비밀번호" placeholder="비밀번호">
      <button type="submit" class="btn primary">잠금 해제</button>
    </div>
    <p class="paylock-msg msg" role="alert"></p>
    <p class="note">가상 데이터 시연용 화면 잠금입니다. 실제 접근 통제가 아니며, 정기 리포트 · 직접 조회 · 원본 CSV로는 같은 데이터를 볼 수 있습니다.</p>
  </form>`;
}

// 화면 어디에 있든 잠금 해제 폼을 처리한다
document.addEventListener("submit", (e) => {
  const f = e.target.closest("form.paylock");
  if (!f) return;
  e.preventDefault();
  const pw = f.elements.pw.value;
  if (pw === DEMO_PASSWORD) {
    unlocked = true;
    emit();
  } else {
    const m = f.querySelector(".paylock-msg");
    m.textContent = "비밀번호가 일치하지 않습니다.";
    m.classList.add("error");
    f.elements.pw.select();
  }
});
document.addEventListener("click", (e) => {
  if (e.target.id === "paylock-lock") lockPay();
});
