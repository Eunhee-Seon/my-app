// 가벼운 SVG 차트: line · bar(묶음, 음수 가능) · hbar. 컨테이너 폭에 맞춰 그리고, 폭이 바뀌면 다시 그린다.
// 표시 규칙: 선 2px · 얇은 막대 · 옅은 격자 · 계열 2개 이상일 때만 범례 · 마우스를 올리면 값 표시.

export const COLORS = { primary: "#2b5c8a", secondary: "#c27c0e", compare: "#9ca3af", highlight: "#da291c", threshold: "#6b7280" };
const AXIS = "#667085", GRID = "#eef0f2", INK = "#222222";
const FS = 12; // 축 · 라벨 글자 크기
/** 대략적인 글자 폭(한글 12.5px, 그 외 7px) — 라벨이 잘리지 않게 여백을 잡는 데 쓴다 */
const textW = (s) => [...String(s)].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 12.5 : 7.2), 0);
const isYm = (l) => /^\d{4}-\d{2}$/.test(String(l));
const ymTip = (l) => (isYm(l) ? `${l.slice(0, 4)}년 ${Number(l.slice(5))}월` : String(l));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtNum = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: d }));

let tip = null;
function tooltip() {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    document.body.appendChild(tip);
    document.addEventListener("mouseover", (e) => {
      const t = e.target.closest("[data-tip]");
      if (!t) { tip.hidden = true; return; }
      tip.innerHTML = t.getAttribute("data-tip");
      tip.hidden = false;
    });
    document.addEventListener("mousemove", (e) => {
      if (tip.hidden) return;
      const w = tip.offsetWidth, h = tip.offsetHeight;
      let x = e.clientX + 12, y = e.clientY + 12;
      if (x + w > window.innerWidth - 8) x = e.clientX - w - 12;
      if (y + h > window.innerHeight - 8) y = e.clientY - h - 12;
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    });
    document.addEventListener("scroll", () => (tip.hidden = true), true);
  }
}

function niceTicks(min, max, count = 4) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || 10 * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}
const shortLabel = (l) => (/^\d{4}-\d{2}$/.test(l) ? `${l.slice(2, 4)}.${l.slice(5)}` : String(l));
const axisFmt = (v) => {
  const a = Math.abs(v);
  if (a >= 1e8) return `${fmtNum(v / 1e8, 1)}억`;
  if (a >= 1e4) return `${fmtNum(v / 1e4, 0)}만`;
  return fmtNum(v, 1);
};

/** 둥근 끝(데이터 쪽 4px)을 가진 막대 경로 */
function barPath(x, y, w, h, dir) {
  const r = Math.min(3, Math.abs(w) / 2, Math.abs(h));
  if (h <= 0 || w <= 0) return "";
  if (dir === "up") return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  if (dir === "down") return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`; // right
}

function legend(series) {
  if (series.length < 2) return "";
  return `<div class="chart-legend">${series.map((s) =>
    `<span><i style="background:${s.color}${s.dashed ? ";height:0;border-top:2px dashed " + s.color : ""}"></i>${esc(s.name)}</span>`).join("")}</div>`;
}

function render(el, spec) {
  const W = Math.max(280, el.clientWidth || 600);
  const H = spec.height || 250;
  if (spec.type === "hbar") return renderHbar(el, spec, W);
  const series = spec.series;
  const labels = spec.labels;
  const all = series.flatMap((s) => s.values).filter((v) => v !== null && v !== undefined);
  if (spec.threshold) all.push(spec.threshold.value);
  if (!labels.length || !all.length) { el.innerHTML = '<p class="empty">표시할 데이터가 없습니다.</p>'; return; }
  // Y축: 기본은 0부터. zeroBase:false 면 실제 범위에 맞추고 그 사실을 축 위에 표시한다.
  const zero = spec.zeroBase !== false;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (zero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  else { const pad = Math.max((hi - lo) * 0.25, Math.abs(hi) * 0.01, 1); lo -= pad; hi += pad; }
  const ticks = niceTicks(lo, hi);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const monthMode = labels.every(isYm);
  const ml = Math.max(40, ...ticks.map((t) => textW(axisFmt(t)))) + 10, mr = 14, mt = 22, mb = monthMode ? 42 : 30;
  const pw = W - ml - mr, ph = H - mt - mb;
  const sy = (v) => mt + ph - ((v - y0) / (y1 - y0)) * ph;
  const n = labels.length;
  const band = pw / n;
  const cx = (i) => ml + band * i + band / 2;
  const unit = spec.unit || "";
  const vf = spec.valueFmt || ((v) => `${fmtNum(v)}${unit}`);

  let g = "";
  const yUnit = spec.yUnit || unit;
  const axisNote = [yUnit ? `단위: ${yUnit}` : "", zero ? "" : `Y축은 ${axisFmt(y0)}부터 시작 (0 아님)`].filter(Boolean).join(" · ");
  if (axisNote) g += `<text x="${ml - 6}" y="${12}" font-size="${FS}" fill="${AXIS}">${esc(axisNote)}</text>`;
  for (const t of ticks) {
    g += `<line x1="${ml}" x2="${W - mr}" y1="${sy(t)}" y2="${sy(t)}" stroke="${t === 0 ? "#d1d5db" : GRID}"/>`;
    g += `<text x="${ml - 8}" y="${sy(t) + 4}" text-anchor="end" font-size="${FS}" fill="${AXIS}">${esc(axisFmt(t))}</text>`;
  }
  if (monthMode) {
    // 월 눈금: 폭에 맞춰 1 · 2 · 3 · 6 · 12개월 간격, 달력 기준(예: 3개월 → 1 · 4 · 7 · 10월)으로 정렬. 연도는 둘째 줄에.
    const step = [1, 2, 3, 6, 12].find((k) => band * k >= 46) || 12;
    let lastYear = null;
    labels.forEach((l, i) => {
      const y = l.slice(0, 4), m = Number(l.slice(5));
      if ((m - 1) % step !== 0) return;
      g += `<line x1="${cx(i)}" x2="${cx(i)}" y1="${mt + ph}" y2="${mt + ph + 4}" stroke="#d1d5db"/>`;
      g += `<text x="${cx(i)}" y="${mt + ph + 17}" text-anchor="middle" font-size="${FS}" fill="${AXIS}">${m}월</text>`;
      if (y !== lastYear) {
        g += `<text x="${cx(i)}" y="${mt + ph + 33}" text-anchor="middle" font-size="${FS}" font-weight="600" fill="${INK}">${y}</text>`;
        lastYear = y;
      }
    });
  } else {
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 52))));
    labels.forEach((l, i) => {
      if (i % every !== 0) return;
      g += `<text x="${cx(i)}" y="${mt + ph + 18}" text-anchor="middle" font-size="${FS}" fill="${AXIS}">${esc(shortLabel(l))}</text>`;
    });
  }

  let marks = "";
  if (spec.type === "line") {
    for (const s of series) {
      let d = "", open = false;
      s.values.forEach((v, i) => {
        if (v === null || v === undefined) { open = false; return; }
        d += `${open ? "L" : "M"}${cx(i)},${sy(v)}`;
        open = true;
      });
      marks += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dashed ? 'stroke-dasharray="5 4"' : ""} stroke-linejoin="round"/>`;
      if (n <= 24) s.values.forEach((v, i) => {
        if (v === null || v === undefined) return;
        const hl = spec.highlightIndex === i;
        marks += `<circle cx="${cx(i)}" cy="${sy(v)}" r="${hl ? 5 : 3.5}" fill="${s.color}" stroke="#fff" stroke-width="2"/>`;
      });
    }
  } else {
    const k = series.length;
    const gap = 2;
    const bw = Math.max(2, Math.min(28, (band * 0.7 - gap * (k - 1)) / k));
    series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        if (v === null || v === undefined) return;
        const x = cx(i) - (k * bw + (k - 1) * gap) / 2 + si * (bw + gap);
        const top = sy(Math.max(v, 0)), bot = sy(Math.min(v, 0));
        const fill = spec.highlightIndex === i && k === 1 ? COLORS.highlight : s.color;
        marks += `<path d="${barPath(x, top, bw, bot - top, v >= 0 ? "up" : "down")}" fill="${fill}"/>`;
      });
    });
  }
  if (spec.threshold) {
    const ty = sy(spec.threshold.value);
    marks += `<line x1="${ml}" x2="${W - mr}" y1="${ty}" y2="${ty}" stroke="${COLORS.threshold}" stroke-width="1.5" stroke-dasharray="4 4"/>`;
    marks += `<text x="${W - mr}" y="${ty - 5}" text-anchor="end" font-size="${FS}" fill="${INK}">${esc(spec.threshold.label)}</text>`;
  }
  // 마우스 영역(열 단위) — 정확한 연월과 값
  let hits = "";
  labels.forEach((l, i) => {
    const rows = series.map((s) => `<div><i style="background:${s.color}"></i>${esc(s.name)} <b>${esc(s.values[i] === null || s.values[i] === undefined ? "—" : vf(s.values[i]))}</b></div>`).join("");
    hits += `<g class="hit" data-tip="${esc(`<div class="tt-h">${esc(ymTip(l))}</div>${rows}`)}"><line x1="${cx(i)}" x2="${cx(i)}" y1="${mt}" y2="${mt + ph}"/><rect x="${ml + band * i}" y="${mt}" width="${band}" height="${ph}" fill="transparent"/></g>`;
  });
  el.innerHTML = `${legend(series)}<svg class="chart" width="${W}" height="${H}" role="img" aria-label="${esc(spec.title || "")}">${g}${marks}${hits}</svg>`;
}

function renderHbar(el, spec, W) {
  const items = spec.labels.map((l, i) => ({ l, v: spec.values[i] })).filter((x) => x.v !== null && x.v !== undefined);
  if (!items.length) { el.innerHTML = '<p class="empty">표시할 데이터가 없습니다.</p>'; return; }
  const row = 30, mt = 4;
  const unit = spec.unit || "";
  const vf = spec.valueFmt || ((v) => `${fmtNum(v)}${unit}`);
  // 부서명 · 값 라벨이 잘리지 않도록 글자 폭으로 여백을 잡는다
  const lw = Math.min(Math.round(W * 0.38), Math.max(56, ...items.map((x) => textW(x.l) + 14)));
  const vw = Math.max(48, ...items.map((x) => textW(vf(x.v)) + 12));
  const pw = Math.max(40, W - lw - vw - 6);
  const max = Math.max(...items.map((x) => x.v), spec.threshold ? spec.threshold.value : 0) || 1;
  const H = mt + items.length * row + 6;
  let s = "";
  items.forEach((x, i) => {
    const y = mt + i * row;
    const w = (x.v / max) * pw;
    const fill = spec.highlight && spec.highlight === x.l ? COLORS.highlight : spec.color || COLORS.primary;
    s += `<g class="hit-row" data-tip="${esc(`<div class="tt-h">${esc(x.l)}</div><b>${esc(vf(x.v))}</b>`)}">
      <rect x="0" y="${y}" width="${W}" height="${row}" fill="transparent"/>
      <text x="${lw - 8}" y="${y + row / 2 + 4}" text-anchor="end" font-size="${FS + 1}" fill="${INK}">${esc(x.l)}</text>
      <path d="${barPath(lw, y + 8, Math.max(w, 1), row - 16, "right")}" fill="${fill}"/>
      <text x="${lw + Math.max(w, 1) + 6}" y="${y + row / 2 + 4}" font-size="${FS + 1}" fill="${INK}">${esc(vf(x.v))}</text></g>`;
  });
  if (spec.threshold) {
    const tx = lw + (spec.threshold.value / max) * pw;
    s += `<line x1="${tx}" x2="${tx}" y1="${mt}" y2="${H - 4}" stroke="${COLORS.threshold}" stroke-dasharray="4 4" stroke-width="1.5"/>`;
  }
  el.innerHTML = `<svg class="chart" width="${W}" height="${H}" role="img" aria-label="${esc(spec.title || "")}">${s}</svg>${spec.threshold ? `<p class="note">점선: ${esc(spec.threshold.label)}</p>` : ""}`;
}

const observed = new WeakMap();
/** 차트를 그리고, 컨테이너 폭이 바뀌면 다시 그린다. */
export function chart(el, spec) {
  if (!el) return; // 화면이 이미 바뀐 경우
  tooltip();
  observed.set(el, spec);
  render(el, spec);
  if (!el._ro && "ResizeObserver" in window) {
    let w = el.clientWidth;
    el._ro = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - w) < 8) return;
      w = el.clientWidth;
      const sp = observed.get(el);
      if (sp) render(el, sp);
    });
    el._ro.observe(el);
  }
}
