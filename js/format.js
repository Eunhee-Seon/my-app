// 화면 표시용 숫자 형식. 계산은 바꾸지 않고 읽기 쉬운 단위로만 보여 준다. (payroll.amount 단위 = 원)

const nf = (v, d = 0) => Number(v).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });

/** 금액(원) → '약 26.76억 원' · '468만 원' · '9,500원' */
export function won(v, { approx = true } = {}) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e8) return `${approx ? "약 " : ""}${s}${nf(a / 1e8, 2)}억 원`;
  if (a >= 1e4) return `${s}${nf(Math.round(a / 1e4))}만 원`;
  return `${s}${nf(a)}원`;
}
/** 금액 증감 → '+4,193만 원' · '−1.20억 원' (단위 항상 표시) */
export function wonDelta(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  if (v === 0) return "±0원";
  return (v > 0 ? "+" : "−") + won(Math.abs(v), { approx: false });
}
/** 숫자 + 단위, 증감 부호 */
export const withUnit = (v, unit, d = 0) => (v === null || v === undefined ? "—" : `${nf(v, d)}${unit}`);
export const signedUnit = (v, unit, d = 0) =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${nf(Math.abs(v), d)}${unit}`;
/** 'YYYY-MM' → '2025년 7월' */
export const ymText = (m) => (/^\d{4}-\d{2}$/.test(String(m)) ? `${m.slice(0, 4)}년 ${Number(m.slice(5))}월` : String(m ?? ""));
