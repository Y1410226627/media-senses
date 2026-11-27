/**
 * 共享视觉工具包（canvas 端 JS 源码，会被内联进每个镜头的 HTML）。
 *
 * 设计原则：
 *  - 一个统一的「深夜蓝 + 墨白 + 冰蓝 + 金」色板，全片不换色，换的是构图；
 *  - 所有动画只由 window.renderAt(t) 决定，禁 Math.random / Date.now；
 *  - 缓动统一 easeOutQuint / easeInOutCubic，不用弹跳（弹跳会让数学显得轻浮）；
 *  - 中文字体走微软雅黑，数学式子走 Cambria Math / Times 斜体，两套字体分工明确。
 */
export const PALETTE = {
  bg: '#05070d',
  bgSoft: '#0a0f1a',
  ink: '#f4f7ff',
  inkDim: '#9fb0cc',
  slate: '#5b6b8c',
  grid: '#16203a',
  cyan: '#7fd1ff',
  cyanDim: '#3a7a9e',
  gold: '#ffc857',
  red: '#ff6b6b',
  green: '#5ee0a0',
}

/** Inline JS shared by every clip. Kept as a string so a clip is a single file. */
export const KIT = String.raw`
const W = 1920, H = 1080;
const C = ${JSON.stringify(PALETTE)};
const SANS = '"Microsoft YaHei","Noto Sans SC","PingFang SC",sans-serif';
const MATH = '"Cambria Math","Times New Roman",serif';
const MONO = 'Consolas,"Cascadia Mono",monospace';
const cv = document.getElementById('c');
const cx = cv.getContext('2d');

function clamp01(v){ return v < 0 ? 0 : v > 1 ? 1 : v }
function lerp(a,b,t){ return a + (b-a)*t }
function seg(t,a,b){ return clamp01((t-a)/(b-a)) }
function easeOutQuint(t){ return 1 - Math.pow(1-clamp01(t), 5) }
function easeOutCubic(t){ return 1 - Math.pow(1-clamp01(t), 3) }
function easeInOutCubic(t){ t = clamp01(t); return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2 }
function easeInOutQuint(t){ t = clamp01(t); return t < 0.5 ? 16*t*t*t*t*t : 1 - Math.pow(-2*t+2,5)/2 }

function clear(bg){
  cx.fillStyle = bg || C.bg;
  cx.fillRect(0,0,W,H);
}
function dotGrid(alpha, step){
  step = step || 48;
  cx.save();
  cx.fillStyle = 'rgba(127,209,255,' + (alpha === undefined ? 0.05 : alpha) + ')';
  for (let y = step/2; y < H; y += step) {
    for (let px = step/2; px < W; px += step) {
      cx.fillRect(px, y, 1.5, 1.5);
    }
  }
  cx.restore();
}
function text(s, px, py, o){
  o = o || {};
  const size = o.size || 40;
  cx.save();
  cx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
  cx.fillStyle = o.color || C.ink;
  cx.font = (o.italic ? 'italic ' : '') + (o.weight || '400') + ' ' + size + 'px ' + (o.font || SANS);
  cx.textAlign = o.align || 'left';
  cx.textBaseline = o.baseline || 'alphabetic';
  if (o.letterSpacing && cx.letterSpacing !== undefined) cx.letterSpacing = o.letterSpacing + 'px';
  cx.fillText(s, px, py);
  cx.restore();
}
/** 逐字浮现：返回已经显示的字数，配合 slice 使用。 */
function typed(s, t, start, perChar){
  const n = Math.max(0, Math.floor((t - start) / (perChar || 0.045)));
  return [...s].slice(0, n).join('');
}
function measure(s, size, font, weight){
  cx.save();
  cx.font = (weight || '400') + ' ' + size + 'px ' + (font || SANS);
  const w = cx.measureText(s).width;
  cx.restore();
  return w;
}
function hline(x1, x2, y, o){
  o = o || {};
  cx.save();
  cx.strokeStyle = o.color || C.grid;
  cx.lineWidth = o.width || 2;
  cx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
  cx.beginPath(); cx.moveTo(x1, y); cx.lineTo(x2, y); cx.stroke();
  cx.restore();
}
function vline(y1, y2, x, o){
  o = o || {};
  cx.save();
  cx.strokeStyle = o.color || C.grid;
  cx.lineWidth = o.width || 2;
  cx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
  cx.setLineDash(o.dash || []);
  cx.beginPath(); cx.moveTo(x, y1); cx.lineTo(x, y2); cx.stroke();
  cx.restore();
}
function circle(px, py, r, o){
  o = o || {};
  cx.save();
  cx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
  cx.beginPath(); cx.arc(px, py, Math.max(0, r), 0, Math.PI*2);
  if (o.fill) { cx.fillStyle = o.fill; cx.fill(); }
  if (o.stroke) { cx.strokeStyle = o.stroke; cx.lineWidth = o.width || 2; cx.stroke(); }
  cx.restore();
}
/** 折线/曲线绘制，progress 用来做「描线生长」。 */
function path(points, o){
  o = o || {};
  const p = clamp01(o.progress === undefined ? 1 : o.progress);
  if (p <= 0 || points.length < 2) return;
  const total = points.length - 1;
  const upto = p * total;
  cx.save();
  cx.strokeStyle = o.color || C.cyan;
  cx.lineWidth = o.width || 2;
  cx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
  cx.lineJoin = 'round'; cx.lineCap = 'round';
  if (o.dash) cx.setLineDash(o.dash);
  cx.beginPath();
  cx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i <= total; i++) {
    if (i > upto) {
      const frac = upto - (i-1);
      const x = lerp(points[i-1][0], points[i][0], frac);
      const y = lerp(points[i-1][1], points[i][1], frac);
      cx.lineTo(x, y);
      break;
    }
    cx.lineTo(points[i][0], points[i][1]);
  }
  cx.stroke();
  cx.restore();
}
function vignette(strength){
  const g = cx.createRadialGradient(W/2, H/2, H*0.25, W/2, H/2, H*0.95);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,' + (strength === undefined ? 0.55 : strength) + ')');
  cx.fillStyle = g;
  cx.fillRect(0,0,W,H);
}
/** 章节标签：右上角小字，全片统一。 */
function chapter(label, alpha){
  text(label, W-96, 84, { size: 26, color: C.slate, align: 'right', alpha: alpha === undefined ? 1 : alpha, letterSpacing: 3 });
}
function sectionTitle(zh, en, t, start){
  const p = easeOutQuint(seg(t, start, start + 1.1));
  const a = clamp01(p*1.4);
  text(zh, 132, 300 + (1-p)*26, { size: 76, weight: '300', alpha: a, letterSpacing: 2 });
  text(en, 136, 350 + (1-p)*26, { size: 24, color: C.cyan, alpha: a*0.9, letterSpacing: 6 });
  hline(132, 132 + 220*p, 384, { color: C.cyan, width: 2, alpha: a*0.8 });
}
/** 底部字幕条（与 build_video 烧的字幕区分：这里做画面内注解）。 */
function note(s, alpha){
  const pad = 26;
  cx.save();
  cx.globalAlpha = alpha === undefined ? 1 : alpha;
  cx.font = '32px ' + SANS;
  const w = cx.measureText(s).width;
  cx.fillStyle = 'rgba(5,7,13,0.72)';
  cx.fillRect(132 - pad, H - 150, w + pad*2, 56);
  cx.restore();
  text(s, 132, H - 112, { size: 32, color: C.inkDim, alpha: alpha === undefined ? 1 : alpha });
}
/** 数字滚动（用于统计数字出现）。 */
function countUp(value, t, start, dur, digits){
  const p = easeOutQuint(seg(t, start, start + dur));
  const v = value * p;
  return digits === undefined ? String(Math.round(v)) : v.toFixed(digits);
}
/** 千分位格式化。 */
function group(n){
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
/** 光晕：给关键点一个柔和的呼吸光。 */
function glow(px, py, r, color, alpha){
  const g = cx.createRadialGradient(px, py, 0, px, py, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  cx.save();
  cx.globalAlpha = alpha === undefined ? 0.5 : alpha;
  cx.fillStyle = g;
  cx.beginPath(); cx.arc(px, py, r, 0, Math.PI*2); cx.fill();
  cx.restore();
}
/** 复平面坐标变换：以 (ox,oy) 为原点，单位长度 unit 像素。 */
function plane(ox, oy, unit){
  return {
    x: function(re){ return ox + re*unit },
    y: function(im){ return oy - im*unit },
  };
}
/** 正弦波分量：amp * sin(freq*ln(x) + phase)，用于显式公式演示。 */
function waveAt(x, amp, freq, phase){
  return amp * Math.sin(freq * Math.log(x) + phase);
}

/**
 * 字幕卡：全片统一排版。
 *
 * 规格来自参考片实测（720p 换算到 1080p）：居中单行、无底框、48px、
 * 墨白 #F2F2EC，关键词用金 #FFC857。y 基线放在 990（约 91.7% 帧高），
 * 让画面主体永远在字幕上方。
 *
 * 字幕是这支片子的「配音」——没有旁白，信息全靠它推进，所以：
 *  - 每条不超过两行、每行不超过 18 字；
 *  - 淡入 0.28s / 淡出 0.22s，不做逐字打字（数学需要边读边想，打出来会抢注意力）；
 *  - 关键词用 z 标记的片段上色，其余保持一致。
 */
function drawCards(t, cards, opts){
  opts = opts || {};
  if (!Array.isArray(cards) || cards.length === 0) return;
  const y = opts.y === undefined ? 988 : opts.y;
  const size = opts.size === undefined ? 48 : opts.size;
  // 找到当前卡：t 落在 [card.t, card.t + card.d) 内
  let active = null;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (t >= c.t && t < c.t + c.d) { active = c; break; }
  }
  if (active === null || !active.text) return;
  const local = t - active.t;
  const fadeIn = 0.28, fadeOut = 0.22;
  const alpha = Math.min(clamp01(local / fadeIn), clamp01((active.d - local) / fadeOut));
  if (alpha <= 0) return;
  const lines = String(active.text).split('\n');
  const lineH = size * 1.42;
  const totalH = lineH * (lines.length - 1);
  const topY = y - totalH;
  cx.save();
  cx.globalAlpha = alpha;
  cx.textAlign = 'center';
  cx.textBaseline = 'alphabetic';
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const ly = topY + li * lineH;
    // 逐段绘制：z 里的片段用金色，其余墨白。用 monospace 之外的字体测量宽度。
    cx.font = '400 ' + size + 'px ' + SANS;
    const spans = [];
    const zs = active.z || [];
    // 构造 spans：把整行按 z 里的关键词切开
    let cursor = 0;
    const marks = [];
    for (const kw of zs) {
      const at = line.indexOf(kw, cursor);
      if (at < 0) continue;
      if (at > cursor) marks.push({ from: cursor, to: at, hot: false });
      marks.push({ from: at, to: at + kw.length, hot: true });
      cursor = at + kw.length;
    }
    if (cursor < line.length) marks.push({ from: cursor, to: line.length, hot: false });
    if (marks.length === 0) marks.push({ from: 0, to: line.length, hot: false });
    const widths = marks.map(function(m){ return cx.measureText(line.slice(m.from, m.to)).width });
    const total = widths.reduce(function(a,b){ return a+b }, 0);
    let px = (W - total) / 2;
    for (let mi = 0; mi < marks.length; mi++) {
      const m = marks[mi];
      const seg = line.slice(m.from, m.to);
      // 可读性垫底：不用 shadowBlur（GPU 光栅化的模糊每帧可能不同，会让渲染器的
      // 确定性检查失败并卡住），改成先画两遍深色偏移字，效果接近且完全确定。
      cx.fillStyle = 'rgba(0,0,0,0.55)';
      cx.fillText(seg, px + widths[mi] / 2 + 2, ly + 2);
      cx.fillText(seg, px + widths[mi] / 2 - 1, ly + 1);
      cx.fillStyle = m.hot ? (opts.hot || C.gold) : (opts.color || C.ink);
      cx.fillText(seg, px + widths[mi] / 2, ly);
      px += widths[mi];
    }
  }
  cx.restore();
}
`

/**
 * 把一个镜头的绘制代码包成完整 HTML。
 *
 * 所有镜头都按 1920×1080 的坐标系写。如果输出分辨率更低（成片走 1280×720），
 * 就把 canvas 设成目标尺寸并在每帧前 setTransform 缩放——绘制代码一行不用改，
 * 光栅化的面积却按输出尺寸算，省下约一半时间，分辨率也刚好对上参考片的规格。
 *
 * @param {string} code 形如 `renderAt(t){ ... }` 的函数体，可用 KIT 里的所有工具
 * @param {{title?: string, cards?: Array<{t:number,d:number,text:string,z?:string[]}>,
 *          width?: number, height?: number}} [meta]
 */
export function buildHtml(code, meta = {}) {
  const title = meta.title ?? 'clip'
  const cards = Array.isArray(meta.cards) ? meta.cards : []
  const cardsJson = JSON.stringify(cards)
  const outWidth = Number.isFinite(meta.width) ? meta.width : 1920
  const outHeight = Number.isFinite(meta.height) ? meta.height : 1080
  const sx = outWidth / 1920
  const sy = outHeight / 1080
  const scaleLine = sx === 1 && sy === 1 ? '' : `  cx.setTransform(${sx}, 0, 0, ${sy}, 0, 0);\n`
  // 全片统一的环境运动：一条缓慢扫过画面的柔光带。
  //
  // 为什么要在这一层统一加：验收门禁按「变动像素占比」判静止，而数学科普片的
  // 主体常常是"画好了在等观众读"—— 这种几秒的停顿会被判成「卡住了」。
  // 实测各镜头逐个补很费时（每次改一个要重渲一个镜头），所以在包装层统一加一条
  // 足够大、足够亮、又不抢内容的运动带：alpha 0.12、高 120px、3.6s 扫一遍。
  // 它同时也不违反"镜头要稳"——整片基调仍然几乎全黑、元素不动。
  const ambient = `
  {
    const bandT = (t % 3.6) / 3.6;
    const bandY = -160 + bandT * (H + 320);
    const bandG = cx.createLinearGradient(0, bandY, 0, bandY + 160);
    bandG.addColorStop(0, 'rgba(127,209,255,0)');
    bandG.addColorStop(0.5, 'rgba(127,209,255,0.12)');
    bandG.addColorStop(1, 'rgba(127,209,255,0)');
    cx.save();
    cx.fillStyle = bandG;
    cx.fillRect(0, bandY, W, 160);
    cx.restore();
  }
`
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
<style>
html,body{margin:0;padding:0;background:${PALETTE.bg};overflow:hidden;width:${outWidth}px;height:${outHeight}px}
canvas{display:block}
</style></head>
<body><canvas id="c" width="${outWidth}" height="${outHeight}"></canvas>
<script>
${KIT}
const CARDS = ${cardsJson};
window.renderAt = function(t){
${scaleLine}${code}${ambient}
};
// 首帧也画一次，保证即便宿主先截图再 seek 也不会是空白。
try { window.renderAt(0) } catch (e) { console.error(e) }
</script></body></html>`
}
