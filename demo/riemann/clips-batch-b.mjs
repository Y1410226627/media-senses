/**
 * 黎曼猜想科普片 · Batch B 镜头（s07 / s08）。
 *
 * 每个镜头是 `{ seconds, code }`，code 是 window.renderAt(t) 的函数体；
 * 绘图工具全部来自 kit.mjs 内联的 KIT 源码，字幕卡由 buildHtml 以 CARDS 注入。
 *
 * 设计约束（与 kit.mjs / clips.mjs 一致）：
 *  - 全片同一套「深夜蓝 + 墨白 + 冰蓝 + 金」色板，不换色；
 *  - 所有运动只由 t 决定，禁 Math.random / Date.now / performance.now；
 *  - 缓动只用 easeOutQuint / easeInOutCubic，没有弹跳；
 *  - 字号只用四档：76（节标题）/ 40–48（标签、正文）/ 24–28（注解）/ 120–160（关键数字）；
 *  - 主色 C.cyan，关键词用 C.gold；每帧最后先 vignette 再 drawCards。
 *
 * 时间轴：两段的视觉节拍跟着 CARDS 的实际排期走（cardT(i)），而不是写死秒数，
 * 这样即使字幕卡时长微调，「字幕说什么画面演什么」也仍然成立。
 */

/** s07 的六个里程碑：触发卡序号、年份、标签（字号/颜色按四档规格）。 */
const TIMELINE_MILESTONES = [
  {
    card: 1,
    year: 1896,
    labels: [
      { text: '阿达马 · 德·拉·瓦莱·普桑', size: 28, color: 'inkDim', dy: -252 },
      { text: '素数定理', size: 40, color: 'gold', dy: -208 },
    ],
  },
  {
    card: 4,
    year: 1914,
    labels: [
      { text: '哈代', size: 28, color: 'inkDim', dy: -152 },
      { text: '临界线上有无穷多零点', size: 40, color: 'cyan', dy: -108 },
    ],
  },
  {
    card: 7,
    year: 1942,
    labels: [
      { text: '塞尔伯格', size: 28, color: 'inkDim', dy: -252 },
      { text: '正比例的零点在线上', size: 40, color: 'cyan', dy: -208 },
    ],
  },
  {
    card: 8,
    year: 1974,
    labels: [
      { text: '莱文森', size: 28, color: 'inkDim', dy: -152 },
      { text: '1/3', size: 40, color: 'gold', dy: -108 },
    ],
  },
  {
    card: 9,
    year: 1989,
    labels: [
      { text: '康瑞', size: 28, color: 'inkDim', dy: -252 },
      { text: '2/5', size: 40, color: 'gold', dy: -208 },
    ],
  },
  {
    card: 10,
    year: 2020,
    labels: [
      { text: '2020 · 5/12', size: 28, color: 'inkDim', dy: -314 },
      { text: '41.6%', size: 120, color: 'gold', dy: -176 },
    ],
  },
]

/** 随机矩阵对照用的 14 根柱子（同一组形状，两边共用，用来「叠合」）。 */
const MATRIX_BARS = [0.18, 0.42, 0.72, 0.95, 0.86, 0.66, 0.5, 0.38, 0.28, 0.2, 0.15, 0.1, 0.07, 0.05]

/* ======================================================================== *
 * s07 · timeline-170 · 98s · 一百七十年的接力
 * ======================================================================== */
const TIMELINE_170 = String.raw`
  // ---- 节拍助手：优先读 CARDS 的真实排期，没有卡片时退回均分 --------------
  const CL = (typeof CARDS !== 'undefined' && Array.isArray(CARDS)) ? CARDS : [];
  const TOTAL = 98;
  function cardT(i) {
    if (CL.length === 0) return (TOTAL * i) / 29;
    if (i >= CL.length) return TOTAL;
    return CL[i].t;
  }
  function win(a, b, fade) {
    fade = fade || 0.8;
    return clamp01((t - a) / fade) * clamp01((b - t) / fade);
  }
  function rrect(x, y, w, h, r, fill, stroke, lw) {
    cx.beginPath();
    cx.moveTo(x + r, y);
    cx.lineTo(x + w - r, y); cx.quadraticCurveTo(x + w, y, x + w, y + r);
    cx.lineTo(x + w, y + h - r); cx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    cx.lineTo(x + r, y + h); cx.quadraticCurveTo(x, y + h, x, y + h - r);
    cx.lineTo(x, y + r); cx.quadraticCurveTo(x, y, x + r, y);
    cx.closePath();
    if (fill) { cx.fillStyle = fill; cx.fill(); }
    if (stroke) { cx.strokeStyle = stroke; cx.lineWidth = lw || 2; cx.stroke(); }
  }
  function colorOf(key) {
    const map = { ink: C.ink, inkDim: C.inkDim, cyan: C.cyan, gold: C.gold, slate: C.slate };
    return map[key] || C.ink;
  }

  clear(C.bg);
  dotGrid(0.03);

  // ---- 时间轴几何：1859 → 2026，横贯画面 ---------------------------------
  const AX0 = 170, AX1 = 1750, AXY = 560;
  const YEAR0 = 1859, YEAR1 = 2026;
  function xOfYear(y) { return AX0 + ((y - YEAR0) / (YEAR1 - YEAR0)) * (AX1 - AX0); }

  // ---- 各阶段透明度：里程碑 → 比例条 → 计算 → 算子 → 随机矩阵 → 全景 ----
  const ratioA = win(cardT(8) - 0.7, cardT(14), 1.0);
  const compA = win(cardT(11) - 0.1, cardT(14), 0.8);
  const opA = win(cardT(14), cardT(19), 0.9);
  const matrixA = win(cardT(19), cardT(24), 0.9);
  const panoA = clamp01((t - cardT(24)) / 1.2);
  const dimA = clamp01(Math.max(opA, matrixA) * (1 - panoA));
  const axisA = 1 - 0.65 * dimA;
  const labelDim = 1 - 0.85 * compA;

  // ---- 标题与章节标签 ----------------------------------------------------
  const titleIn = easeOutQuint(seg(t, 0.25, 1.6));
  text('一百七十年的接力', 132, 168 + (1 - titleIn) * 22, { size: 76, weight: '300', alpha: titleIn, letterSpacing: 2 });
  text('A 167-YEAR RELAY', 136, 214 + (1 - titleIn) * 22, { size: 24, color: C.cyan, alpha: titleIn * 0.8, letterSpacing: 6 });
  hline(132, 132 + 260 * titleIn, 248, { color: C.cyan, width: 2, alpha: titleIn * 0.45 });
  chapter('七 · 一百七十年的接力', 0.85);

  // ---- 时间轴起形 --------------------------------------------------------
  const grow = easeOutQuint(seg(t, 0.5, 3.6));
  const axisEnd = AX0 + (AX1 - AX0) * grow;
  hline(AX0, axisEnd, AXY, { color: C.grid, width: 2, alpha: axisA });
  const TICKS = [1859, 1900, 1950, 2000, 2026];
  for (let i = 0; i < TICKS.length; i++) {
    const yr = TICKS[i];
    const tx = xOfYear(yr);
    if (tx > axisEnd + 1) continue;
    const big = yr === YEAR0 || yr === YEAR1;
    vline(AXY - (big ? 13 : 9), AXY + (big ? 13 : 9), tx, {
      color: big ? C.cyan : C.slate, width: big ? 2 : 1.5, alpha: axisA * (big ? 0.9 : 0.6),
    });
    text(String(yr), tx, AXY + 44, {
      size: big ? 40 : 24, align: 'center', color: big ? C.cyan : C.slate, alpha: axisA * (big ? 0.95 : 0.75),
    });
  }

  // ---- 里程碑：光点落下 → 扩散 → 留下 ------------------------------------
  const MS = ${JSON.stringify(TIMELINE_MILESTONES)};
  for (let k = 0; k < MS.length; k++) {
    const m = MS[k];
    const dropT = cardT(m.card);
    if (t < dropT) continue;
    const mx = xOfYear(m.year);
    const drop = easeInOutCubic(seg(t, dropT, dropT + 0.55));
    const spread = easeOutQuint(seg(t, dropT + 0.35, dropT + 1.15));
    const labelIn = easeOutQuint(seg(t, dropT + 0.5, dropT + 1.35));
    if (drop < 1) {
      const fy = AXY - 200 * (1 - drop);
      glow(mx, fy, 40, 'rgba(127,209,255,0.5)', 0.8 * axisA);
      circle(mx, fy, 4, { fill: C.ink, alpha: axisA });
    }
    if (spread > 0 && spread < 1) {
      circle(mx, AXY, 8 + 48 * spread, { stroke: C.cyan, width: 2, alpha: axisA * 0.55 * (1 - spread) });
    }
    glow(mx, AXY, 30, 'rgba(255,200,87,0.35)', axisA * 0.55 * labelIn);
    circle(mx, AXY, 6.5, { fill: m.year === 2020 ? C.gold : C.cyan, alpha: axisA });
    // 引线 + 标签块（尽量左右错高，避开右端的 1974/1989/2020 拥挤）
    // 算子/矩阵阶段旧标签必须让位（dimA），否则会和新的图叠在一起。
    const la = axisA * labelIn * labelDim * (1 - 0.95 * dimA);
    const firstLabel = m.labels[0];
    vline(AXY - 8, AXY + firstLabel.dy - 18, mx, { color: C.cyanDim, width: 1.5, alpha: la * 0.6 });
    for (let li = 0; li < m.labels.length; li++) {
      const lab = m.labels[li];
      text(lab.text, mx, AXY + lab.dy, {
        size: lab.size, align: 'center', color: colorOf(lab.color), alpha: la * (li === 0 ? 0.95 : 1),
      });
    }
  }

  // ---- 1914 之后：临界线上「住着人」的注解 -------------------------------
  const infA = win(cardT(5) + 0.2, cardT(7) - 0.3, 0.7) * labelDim * (1 - 0.95 * dimA);
  if (infA > 0.01) {
    const hx = xOfYear(1914);
    vline(AXY - 46, AXY - 10, hx, { color: C.gold, width: 2, alpha: axisA * infA });
    text('无穷多个', hx + 18, AXY - 34, { size: 28, color: C.gold, alpha: axisA * infA });
  }

  // ---- 1896 之后两张卡：证明用的是 ζ 函数 --------------------------------
  const zetaA = win(cardT(2) + 0.15, cardT(4) - 0.1, 0.7) * labelDim * (1 - 0.95 * dimA);
  if (zetaA > 0.01) {
    text('ζ(s)', 1160, AXY - 366, { size: 76, font: MATH, italic: true, align: 'center', color: C.cyan, alpha: axisA * zetaA });
    text('素数定理的证明，用的正是 ζ 函数', 1160, AXY - 314, { size: 28, align: 'center', color: C.inkDim, alpha: axisA * zetaA * 0.9 });
  }

  // ---- 比例进度条：0 → 1/3 → 2/5 → 41.6%，金色虚线补到 100% -------------
  if (ratioA > 0.01) {
    const BX0 = 300, BX1 = 1620, BY = 706;
    let ratio = 0;
    if (t >= cardT(8)) ratio = lerp(0, 1 / 3, easeOutQuint(seg(t, cardT(8), cardT(8) + 1.0)));
    if (t >= cardT(9)) ratio = lerp(1 / 3, 2 / 5, easeOutQuint(seg(t, cardT(9), cardT(9) + 1.0)));
    if (t >= cardT(10)) ratio = lerp(2 / 5, 0.416, easeOutQuint(seg(t, cardT(10), cardT(10) + 1.2)));
    const a = ratioA;
    text('已证明：非平凡零点落在临界线上的比例', BX0, BY - 22, { size: 28, color: C.inkDim, alpha: a });
    hline(BX0, BX1, BY, { color: C.grid, width: 8, alpha: a * 0.9 });
    const fillX = BX0 + (BX1 - BX0) * ratio;
    cx.save();
    cx.globalAlpha = a * 0.9;
    cx.fillStyle = C.cyan;
    cx.fillRect(BX0, BY - 4, Math.max(0, fillX - BX0), 8);
    cx.restore();
    if (ratio > 0.005) {
      path([[fillX, BY], [BX1, BY]], { color: C.gold, width: 2, dash: [7, 7], alpha: a * 0.85 });
    }
    text('已证 ' + (ratio * 100).toFixed(1) + '%', BX0, BY + 46, { size: 40, color: C.cyan, alpha: a });
    text('还差 ' + ((1 - ratio) * 100).toFixed(1) + '%', BX1, BY + 46, { size: 40, align: 'right', color: C.gold, alpha: a });
    // 三个比例刻度：2/5 与 41.6% 在横轴上只差 21px，标签必须错行
    const marks = [[1 / 3, '1/3', 82], [2 / 5, '2/5', 112], [0.416, '41.6%', 82]];
    for (let i = 0; i < marks.length; i++) {
      if (ratio < marks[i][0] - 0.004) continue;
      const markX = BX0 + (BX1 - BX0) * marks[i][0];
      vline(BY - 12, BY + 12, markX, { color: C.gold, width: 1.5, alpha: a * 0.8 });
      text(marks[i][1], markX, BY + marks[i][2], { size: 24, align: 'center', color: C.gold, alpha: a * 0.8 });
    }
  }

  // ---- 另一条战线：计算验证 ---------------------------------------------
  if (compA > 0.01) {
    const PX = 1180, PY = 176, PW = 610, PH = 214;
    cx.save();
    cx.globalAlpha = compA * 0.94;
    rrect(PX, PY, PW, PH, 12, 'rgba(8,12,22,0.92)', C.cyanDim, 1.5);
    cx.restore();
    text('另一条战线：计算', PX + 28, PY + 54, { size: 40, color: C.cyan, alpha: compA });
    const r1 = easeOutQuint(seg(t, cardT(12), cardT(12) + 0.8));
    text('2004 · 验证前 10 万亿个零点', PX + 28, PY + 112, { size: 28, color: C.inkDim, alpha: compA * r1 });
    const big1 = easeOutQuint(seg(t, cardT(12) + 0.55, cardT(12) + 1.6));
    text('10¹³', PX + PW - 28, PY + 106, { size: 76, align: 'right', color: C.gold, alpha: compA * big1 });
    text('全部在线', PX + PW - 28, PY + 150, { size: 24, align: 'right', color: C.gold, alpha: compA * big1 * 0.85 });
    const r2 = easeOutQuint(seg(t, cardT(13), cardT(13) + 0.8));
    text('2021 · 高度 3 × 10¹² 内全部成立', PX + 28, PY + 192, { size: 28, color: C.inkDim, alpha: compA * r2 });
  }

  // ---- 更疯狂的路：存在一个算子，特征值就是零点 --------------------------
  if (opA > 0.01) {
    const SX0 = 560, SX1 = 1360, SY = 430;
    hline(SX0, SX1, SY, { color: C.cyanDim, width: 2, alpha: opA * 0.8 });
    const l1 = easeOutQuint(seg(t, cardT(15), cardT(15) + 0.9));
    text('希尔伯特 · 波利亚：也许存在一个算子', 960, 220, { size: 40, align: 'center', color: C.cyan, alpha: opA * l1 });
    const l2 = easeOutQuint(seg(t, cardT(16), cardT(16) + 0.9));
    text('H 的特征值  =  零点的虚部 γₙ', 960, 312, { size: 48, align: 'center', color: C.ink, font: MATH, italic: true, alpha: opA * l2 });
    const l3 = easeOutQuint(seg(t, cardT(17), cardT(17) + 0.9));
    text('自伴算子的谱，全是实数', 960, 378, { size: 40, align: 'center', color: C.inkDim, alpha: opA * l3 });
    const reveal = easeOutQuint(seg(t, cardT(16) + 0.4, cardT(18)));
    const snap = easeOutQuint(seg(t, cardT(17) + 0.4, cardT(17) + 1.6));
    for (let i = 0; i < 11; i++) {
      const appear = clamp01(reveal * 11 - i);
      if (appear <= 0) continue;
      const px = SX0 + (SX1 - SX0) * (0.06 + i * 0.088);
      const dy = (i % 2 === 0 ? 1 : -1) * 30 * (1 - snap) * (0.6 + (i % 3) * 0.2);
      glow(px, SY + dy, 22, 'rgba(127,209,255,0.3)', opA * appear * 0.5);
      circle(px, SY + dy, 6.5, { fill: C.cyan, alpha: opA * appear });
    }
    const l4 = easeOutQuint(seg(t, cardT(18), cardT(18) + 0.9));
    text('找到了，零点全在线上，就顺理成章', 960, 528, { size: 40, align: 'center', color: C.gold, alpha: opA * l4 });
  }

  // ---- 随机矩阵对照：两张直方图叠合 -------------------------------------
  if (matrixA > 0.01) {
    const BARS = ${JSON.stringify(MATRIX_BARS)};
    const baseY = 700, barW = 30, gap = 10;
    const leftX0 = 380, rightX0 = 1020;
    const merge = easeInOutCubic(seg(t, cardT(20) + 0.3, cardT(21) + 1.8));
    const failA = easeOutQuint(seg(t, cardT(22), cardT(22) + 0.8));
    const keepA = 1 - failA;
    const shift = 640 * merge;
    for (let i = 0; i < BARS.length; i++) {
      const p = easeOutQuint(seg(t, cardT(19) + 0.3 + i * 0.04, cardT(19) + 1.2 + i * 0.04));
      const barH = BARS[i] * 230 * p;
      cx.save();
      cx.globalAlpha = matrixA * keepA * 0.85;
      cx.fillStyle = C.cyan;
      cx.fillRect(leftX0 + i * (barW + gap), baseY - barH, barW, barH);
      if (merge > 0) {
        cx.globalAlpha = matrixA * keepA * 0.7;
        cx.fillStyle = C.gold;
        cx.fillRect(rightX0 + i * (barW + gap) - shift, baseY - barH, barW, barH);
      }
      cx.restore();
    }
    hline(leftX0, leftX0 + BARS.length * (barW + gap), baseY, { color: C.slate, width: 1.5, alpha: matrixA * keepA * 0.7 });
    text('零点间距的统计', leftX0 + 230, 452, { size: 40, align: 'center', color: C.cyan, alpha: matrixA * keepA * (1 - merge * 0.55) });
    if (merge < 0.6) {
      text('重原子核能级间距（GUE）', rightX0 + 230, 452, {
        size: 40, align: 'center', color: C.gold, alpha: matrixA * keepA * ((0.6 - merge) / 0.6) * 0.9,
      });
    }
    const sameA = easeOutQuint(seg(t, cardT(21), cardT(21) + 1.2)) * matrixA * keepA;
    text('统计上无法区分', 960, 368, { size: 40, align: 'center', color: C.gold, alpha: sameA });
    if (failA > 0.01) {
      text('这条路线，至今没有走通', 960, 368, { size: 40, align: 'center', color: C.inkDim, alpha: matrixA * failA });
      cx.save();
      cx.strokeStyle = 'rgba(255,200,87,' + (0.55 * matrixA * failA) + ')';
      cx.lineWidth = 2;
      cx.setLineDash([5, 5]);
      cx.beginPath();
      cx.arc(960, 470, 26, 0, Math.PI * 2);
      cx.stroke();
      cx.restore();
      text('?', 960, 482, { size: 40, align: 'center', color: C.gold, alpha: matrixA * failA * 0.8 });
    }
  }

  // ---- 另一个世界：有限域上的 RH（最强的旁证） --------------------------
  if (panoA > 0.01) {
    const PX = 1040, PY = 620, PW = 700, PH = 236;
    cx.save();
    cx.globalAlpha = panoA * 0.9;
    rrect(PX, PY, PW, PH, 12, 'rgba(8,12,22,0.72)', C.cyanDim, 1.5);
    cx.restore();
    const fIn = easeOutQuint(seg(t, cardT(24) + 0.2, cardT(24) + 1.1));
    text('另一个世界：有限域上的黎曼猜想', PX + 28, PY + 56, { size: 40, color: C.cyan, alpha: panoA * fIn });
    const weilA = easeOutQuint(seg(t, cardT(25), cardT(25) + 0.8));
    text('1948 · 韦伊 证明（曲线情形）', PX + 28, PY + 118, { size: 28, color: C.inkDim, alpha: panoA * weilA });
    const deligneA = easeOutQuint(seg(t, cardT(26), cardT(26) + 0.8));
    text('1974 · 德利涅 推广到高维', PX + 28, PY + 164, { size: 28, color: C.inkDim, alpha: panoA * deligneA });
    const proofA = easeOutQuint(seg(t, cardT(27), cardT(27) + 0.9));
    text('最强的旁证：这类猜想是对的', PX + 28, PY + 214, { size: 40, color: C.gold, alpha: panoA * proofA });
  }

  // ---- 2026：留一个未点亮的空位（暗示还没写完） --------------------------
  if (grow > 0.985) {
    const pulse = 0.45 + 0.3 * Math.sin(t * 1.6);
    cx.save();
    cx.globalAlpha = axisA * pulse;
    cx.strokeStyle = C.gold;
    cx.lineWidth = 2;
    cx.setLineDash([4, 6]);
    cx.beginPath();
    cx.arc(AX1, AXY, 12, 0, Math.PI * 2);
    cx.stroke();
    cx.restore();
    text('?', AX1, AXY - 30, { size: 28, align: 'center', color: C.gold, alpha: axisA * 0.6 });
  }

  // 全域极淡的扫光：给每个阶段一个持续的环境运动，避免画面长时间完全静止
  // （确定性：位置只由 t 决定；0.04 的透明度不会压过任何文字）。
  const sweepX = ((t * 90) % (W + 520)) - 260;
  const sweepG = cx.createLinearGradient(sweepX - 260, 0, sweepX + 260, 0);
  sweepG.addColorStop(0, 'rgba(127,209,255,0)');
  sweepG.addColorStop(0.5, 'rgba(127,209,255,0.04)');
  sweepG.addColorStop(1, 'rgba(127,209,255,0)');
  cx.save();
  cx.fillStyle = sweepG;
  cx.fillRect(0, 0, W, H);
  cx.restore();

  vignette(0.5);
  drawCards(t, CARDS);
`

/* ======================================================================== *
 * s08 · consequences · 66s · 如果被证明，或者被推翻
 * ======================================================================== */
const CONSEQUENCES = String.raw`
  // ---- 节拍助手 ----------------------------------------------------------
  const CL = (typeof CARDS !== 'undefined' && Array.isArray(CARDS)) ? CARDS : [];
  const TOTAL = 66;
  function cardT(i) {
    if (CL.length === 0) return (TOTAL * i) / 20;
    if (i >= CL.length) return TOTAL;
    return CL[i].t;
  }
  function win(a, b, fade) {
    fade = fade || 0.8;
    return clamp01((t - a) / fade) * clamp01((b - t) / fade);
  }
  function rise(a, fade) { return clamp01((t - a) / (fade || 0.8)); }
  function rrect(x, y, w, h, r, fill, stroke, lw) {
    cx.beginPath();
    cx.moveTo(x + r, y);
    cx.lineTo(x + w - r, y); cx.quadraticCurveTo(x + w, y, x + w, y + r);
    cx.lineTo(x + w, y + h - r); cx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    cx.lineTo(x + r, y + h); cx.quadraticCurveTo(x, y + h, x, y + h - r);
    cx.lineTo(x, y + r); cx.quadraticCurveTo(x, y, x + r, y);
    cx.closePath();
    if (fill) { cx.fillStyle = fill; cx.fill(); }
    if (stroke) { cx.strokeStyle = stroke; cx.lineWidth = lw || 2; cx.stroke(); }
  }

  clear(C.bg);
  dotGrid(0.03);

  // ---- 四个阶段：证明的世界 → 密码学 → 推翻的世界 → 悬赏规则 ------------
  const proofA = 1 - clamp01((t - (cardT(3) - 0.4)) / 1.0);
  const cryptoA = win(cardT(3), cardT(10), 0.9);
  const overturnA = win(cardT(10), cardT(17), 0.9);
  const bountyA = rise(cardT(17) - 0.3, 0.9);

  // ---- 标题与章节标签 ----------------------------------------------------
  const titleIn = easeOutQuint(seg(t, 0.25, 1.6));
  text('如果被证明，或者被推翻', 132, 168 + (1 - titleIn) * 22, { size: 76, weight: '300', alpha: titleIn, letterSpacing: 2 });
  text('IF PROVEN, OR REFUTED', 136, 214 + (1 - titleIn) * 22, { size: 24, color: C.cyan, alpha: titleIn * 0.8, letterSpacing: 6 });
  hline(132, 132 + 300 * titleIn, 248, { color: C.cyan, width: 2, alpha: titleIn * 0.45 });
  chapter('八 · 如果被证明，或者被推翻', 0.85);

  // ======================================================================
  // 阶段一 · 证明的世界：误差包络 x → √x，条件命题翻成定理
  // ======================================================================
  if (proofA > 0.01) {
    const a = proofA;
    // 左：两条误差包络（同一原点出发，一条陡一条平）
    const EX0 = 210, EX1 = 920, EY = 700;
    const plotA = easeOutQuint(seg(t, 0.4, 2.2));
    hline(EX0, EX0 + (EX1 - EX0) * plotA, EY, { color: C.slate, width: 1.5, alpha: a * 0.7 });
    vline(EY - 250, EY, EX0, { color: C.slate, width: 1.5, alpha: a * 0.7 });
    text('误差', EX0 - 18, EY - 262, { size: 24, align: 'right', color: C.slate, alpha: a * 0.8 });
    text('x', EX1 + 6, EY + 34, { size: 24, align: 'center', color: C.slate, alpha: a * 0.8 });
    const nSamples = 90;
    const bigEnv = [];
    const rootEnv = [];
    for (let i = 0; i < nSamples; i++) {
      const u = i / (nSamples - 1);
      const px = EX0 + (EX1 - EX0) * u;
      bigEnv.push([px, EY - u * u * 236]);
      rootEnv.push([px, EY - Math.sqrt(u) * 236 * 0.62]);
    }
    path(bigEnv, { color: C.slate, width: 2, alpha: a * 0.75, progress: easeOutQuint(seg(t, 0.6, 2.4)) });
    text('最坏情况 O(x)', EX1 - 6, EY - 244, { size: 28, align: 'right', color: C.slate, alpha: a * 0.85 });
    const rhA = easeOutQuint(seg(t, cardT(1) - 0.3, cardT(1) + 1.4));
    path(rootEnv, { color: C.cyan, width: 3, alpha: a * 0.95, progress: rhA });
    text('√x', EX1 - 6, EY - 118, { size: 40, align: 'right', color: C.gold, alpha: a * rhA });
    text('误差被压到 √x 的量级', EX0, EY - 292, { size: 40, color: C.gold, alpha: a * rhA });

    // 右：条件命题清单，cardT(2) 起逐条从「条件」翻成「定理」
    const RX = 1080;
    const listIn = easeOutQuint(seg(t, 0.7, 1.8));
    text('条件命题清单', RX, 292, { size: 40, color: C.cyan, alpha: a * listIn });
    const claims = [
      '素数间隙的界',
      'π(x) 的显式误差',
      '相邻零点的间距下界',
      '算术级数中的素数分布',
      '几乎所有数论估计的常数',
    ];
    for (let i = 0; i < claims.length; i++) {
      const rowA = easeOutQuint(seg(t, 0.9 + i * 0.22, 1.7 + i * 0.22)) * a;
      const flip = easeOutQuint(seg(t, cardT(2) + 0.15 + i * 0.28, cardT(2) + 1.0 + i * 0.28));
      const ry = 372 + i * 78;
      circle(RX + 12, ry - 10, 5, { fill: flip > 0.5 ? C.gold : C.slate, alpha: rowA });
      text('若 RH 成立 → ' + claims[i], RX + 40, ry, { size: 28, color: C.inkDim, alpha: rowA * (1 - flip * 0.35) });
      // 标签：条件 → 定理
      const pillFill = flip > 0.5 ? 'rgba(255,200,87,0.14)' : 'rgba(91,107,140,0.16)';
      cx.save();
      cx.globalAlpha = rowA;
      rrect(RX + 560, ry - 32, 116, 40, 8, pillFill, flip > 0.5 ? C.gold : C.slate, 1.5);
      cx.restore();
      const condA = rowA * (1 - flip);
      const thmA = rowA * flip;
      text('条件', RX + 618, ry - 4, { size: 24, align: 'center', color: C.slate, alpha: condA });
      text('定理', RX + 618, ry - 4, { size: 24, align: 'center', color: C.gold, alpha: thmA });
    }
  }

  // ======================================================================
  // 阶段二 · 密码学：一把锁保持完整不动，强调「几乎没有影响」
  // ======================================================================
  if (cryptoA > 0.01) {
    const a = cryptoA;
    // 锁：出现后不再移动（用透明度淡入，不做任何位移/缩放）
    const lockIn = easeOutQuint(seg(t, cardT(3) + 0.3, cardT(3) + 1.3));
    const lx = 520, ly = 520;
    cx.save();
    cx.globalAlpha = a * lockIn;
    cx.strokeStyle = C.cyan;
    cx.lineWidth = 6;
    cx.beginPath();
    cx.arc(lx, ly - 52, 58, Math.PI, 0);
    cx.stroke();
    cx.restore();
    cx.save();
    cx.globalAlpha = a * lockIn;
    rrect(lx - 92, ly - 14, 184, 142, 14, 'rgba(127,209,255,0.05)', C.cyan, 3);
    cx.restore();
    circle(lx, ly + 38, 13, { fill: C.gold, alpha: a * lockIn });
    cx.save();
    cx.globalAlpha = a * lockIn;
    cx.fillStyle = C.gold;
    cx.fillRect(lx - 3, ly + 38, 6, 38);
    cx.restore();
    // 环境呼吸：锁本身完全不动（不位移、不缩放），只有背后的光和虚线环缓慢变化，
    // 这样「强调锁的稳定性」和「画面不能长时间静止」可以同时成立。
    const breathe = 0.5 + 0.5 * Math.sin(t * 1.9);
    glow(lx, ly + 50, 210 + 18 * breathe, 'rgba(127,209,255,0.10)', a * lockIn);
    cx.save();
    cx.globalAlpha = a * lockIn * 0.22;
    cx.strokeStyle = C.cyanDim;
    cx.lineWidth = 1.5;
    cx.setLineDash([6, 12]);
    cx.lineDashOffset = -t * 14;
    cx.beginPath();
    cx.arc(lx, ly + 50, 168, 0, Math.PI * 2);
    cx.stroke();
    cx.restore();
    // 「完整 · 不受影响」徽章
    const badgeA = easeOutQuint(seg(t, cardT(5), cardT(5) + 0.9)) * a;
    cx.save();
    cx.globalAlpha = badgeA;
    rrect(lx - 122, ly + 158, 244, 46, 10, 'rgba(94,224,160,0.10)', C.green, 1.5);
    cx.restore();
    text('完整 · 不受影响', lx, ly + 190, { size: 24, align: 'center', color: C.green, alpha: badgeA });
    // 一记不打扰锁的金色脉冲（只扩散，不改变锁）
    const pulse = easeOutQuint(seg(t, cardT(5) + 0.2, cardT(5) + 1.8));
    if (pulse > 0 && pulse < 1) {
      circle(lx, ly + 40, 150 + 70 * pulse, { stroke: C.gold, width: 1.5, alpha: a * 0.35 * (1 - pulse) });
    }

    // 右：结论文字
    const bigA = easeOutQuint(seg(t, cardT(4), cardT(4) + 0.9)) * a;
    text('几乎没有影响', 1030, 330, { size: 76, color: C.gold, alpha: bigA });
    const formulaA = easeOutQuint(seg(t, cardT(6), cardT(6) + 0.9)) * a;
    const rsaW = measure('RSA', 48, MATH, 'italic');
    text('RSA', 1030, 424, { size: 48, font: MATH, italic: true, color: C.cyan, alpha: formulaA });
    text(' ← 大数难分解', 1030 + rsaW + 10, 424, { size: 40, color: C.ink, alpha: formulaA });
    text('不依赖黎曼猜想', 1030, 486, { size: 40, color: C.inkDim, alpha: formulaA });
    const noHelpA = easeOutQuint(seg(t, cardT(7), cardT(7) + 0.9)) * a;
    text('RH 的证明本身，不会让分解变简单', 1030, 560, { size: 28, color: C.inkDim, alpha: noHelpA });
    // 「除非附带一个高效算法」→ 幽灵框，随后被划掉
    const ghostA = easeOutQuint(seg(t, cardT(8), cardT(8) + 0.9)) * a;
    if (ghostA > 0.01) {
      cx.save();
      cx.globalAlpha = ghostA * 0.8;
      cx.strokeStyle = C.cyanDim;
      cx.lineWidth = 1.5;
      cx.setLineDash([6, 6]);
      rrect(1030, 596, 330, 52, 8, null, C.cyanDim, 1.5);
      cx.restore();
      text('高效算法 ？', 1060, 632, { size: 28, color: C.cyanDim, alpha: ghostA });
      const crossA = easeOutQuint(seg(t, cardT(9), cardT(9) + 0.7)) * ghostA;
      if (crossA > 0.01) {
        path([[1042, 648], [1344, 596]], { color: C.gold, width: 2.5, alpha: crossA * 0.9 });
        text('目前没有任何迹象', 1030, 700, { size: 28, color: C.gold, alpha: crossA });
      }
    }
  }

  // ======================================================================
  // 阶段三 · 推翻的世界：一根特别响的波、走形的台阶、模型碎裂后重组
  // ======================================================================
  if (overturnA > 0.01) {
    const a = overturnA;
    // 模型卡阶段要比波浪早一点退场，把画面让给「天不会塌」
    const modelA = win(cardT(14), cardT(16) + 0.2, 0.8) * a;
    const worldA = a * (1 - modelA * 0.85);
    const PX0 = 250, PX1 = 1670;
    const waveBase = function (x) { return 690 - (x - PX0) * 0.10; };
    // 主项直线（素数定理的「天不会塌」）：全程保留
    const lineIn = easeOutQuint(seg(t, cardT(10) + 0.2, cardT(10) + 1.6));
    path([[PX0, waveBase(PX0)], [PX1, waveBase(PX1)]], { color: C.cyan, width: 3, alpha: a * lineIn * 0.9 });
    text('主项：素数大概有多少', PX0, waveBase(PX0) - 216, { size: 28, color: C.cyanDim, alpha: worldA * lineIn });

    // 上：一组小波叠在直线上；cardT(12) 起插入一根特别响的波
    const tallA = easeOutQuint(seg(t, cardT(12), cardT(12) + 1.4)) * worldA;
    const smallPts = [];
    const tallPts = [];
    for (let i = 0; i <= 240; i++) {
      const x = PX0 + (PX1 - PX0) * (i / 240);
      const small = 16 * Math.sin(x * 0.011 + 0.4) + 9 * Math.sin(x * 0.023 + 1.7) + 5 * Math.sin(x * 0.041 + 3.1);
      const tall = tallA * 150 * Math.sin(x * 0.0062 + 3.6);
      smallPts.push([x, waveBase(x) + small]);
      tallPts.push([x, waveBase(x) + small + tall]);
    }
    path(smallPts, { color: C.cyanDim, width: 2, alpha: worldA * 0.85, progress: lineIn });
    if (worldA > 0.01 && tallA > 0.005) {
      path(tallPts, { color: C.gold, width: 2.6, alpha: worldA * 0.9 });
      const peakX = PX0 + (PX1 - PX0) * 0.62;
      glow(peakX, waveBase(peakX) - 120, 46, 'rgba(255,200,87,0.35)', worldA * tallA * 0.6);
      text('有一根波，特别响', peakX + 26, waveBase(peakX) - 132, { size: 40, color: C.gold, alpha: worldA * tallA });
    }

    // 下：素数台阶；波一变响，锯齿台阶开始走形
    const stairTop = 768;
    const disturb = easeInOutCubic(seg(t, cardT(12) + 0.4, cardT(13) + 1.0)) * worldA;
    const steps = 24;
    let prevY = stairTop - 4;
    for (let i = 0; i < steps; i++) {
      const x0 = PX0 + (PX1 - PX0) * (i / steps);
      const x1 = PX0 + (PX1 - PX0) * ((i + 1) / steps);
      // 越往后越偏：一半抖动、一半系统性漂移，台阶才真的「走形」
      const wobble = (Math.sin(i * 0.85 + 0.3) * 18 + i * 0.55) * disturb;
      const y = stairTop + i * 5.2 + wobble;
      const col = Math.abs(wobble) > 6 ? C.gold : C.slate;
      const lineA = worldA * (0.65 + Math.abs(wobble) / 30);
      vline(prevY, y, x0, { color: col, width: 2, alpha: lineA });
      hline(x0, x1, y, { color: col, width: 2, alpha: lineA });
      prevY = y;
    }
    text('素数台阶：锯齿开始走形', PX0, 746, { size: 28, color: C.inkDim, alpha: worldA * disturb });
    const biasA = easeOutQuint(seg(t, cardT(13), cardT(13) + 0.9)) * worldA;
    text('系统性偏差', PX1, stairTop + 40, { size: 40, color: C.gold, align: 'right', alpha: biasA });

    // cardT(14)：随机模型卡片碎裂；cardT(15)：重组 → cardT(16) 让位给「天不会塌」
    if (modelA > 0.01) {
      const shatter = easeOutQuint(seg(t, cardT(14), cardT(14) + 0.9));
      const regather = easeInOutCubic(seg(t, cardT(15), cardT(15) + 1.2));
      text('所有「素数像随机数」的模型', 960, 330, { size: 40, align: 'center', color: C.inkDim, alpha: modelA * (1 - regather * 0.6) });
      const cardW = 158, cardH = 64, gap = 20;
      const totalW = 5 * cardW + 4 * gap;
      const startX = 960 - totalW / 2;
      for (let i = 0; i < 5; i++) {
        const bx = startX + i * (cardW + gap);
        const by = 470;
        const dirX = (i % 2 === 0 ? 1 : -1) * (18 + (i % 3) * 10) * shatter * (1 - regather);
        const dirY = (i < 3 ? -1 : 1) * (16 + (i % 2) * 12) * shatter * (1 - regather);
        cx.save();
        cx.globalAlpha = modelA * 0.9;
        rrect(bx + dirX, by + dirY, cardW, cardH, 6, 'rgba(127,209,255,0.05)', C.cyanDim, 1.2);
        cx.restore();
        text('随机模型 ' + (i + 1), bx + dirX + cardW / 2, by + dirY + 40, { size: 24, align: 'center', color: C.inkDim, alpha: modelA * 0.85 });
      }
      const rewriteA = easeOutQuint(seg(t, cardT(15) + 0.3, cardT(15) + 1.2)) * modelA;
      text('重写', 960, 590, { size: 40, align: 'center', color: C.gold, alpha: rewriteA });
    }
    const stillA = easeOutQuint(seg(t, cardT(15) + 0.8, cardT(15) + 1.8)) * a;
    text('素数定理 π(x) ~ x / ln x 依然成立', 960, 760, { size: 40, align: 'center', color: C.ink, alpha: stillA });
    const calmA = easeOutQuint(seg(t, cardT(16), cardT(16) + 1.0)) * a;
    text('天不会塌', 960, 470, { size: 76, align: 'center', color: C.ink, alpha: calmA });
  }

  // ======================================================================
  // 阶段四 · 悬赏规则：发表 → 满两年 → 社区接受 → 100 万美元
  // ======================================================================
  if (bountyA > 0.01) {
    const a = bountyA;
    const nodes = [
      { x: 320, label: '发表' },
      { x: 720, label: '满两年' },
      { x: 1120, label: '社区接受' },
      { x: 1520, label: '$1,000,000' },
    ];
    const CY = 430;
    text('千禧年大奖难题 · 悬赏规则', 320, 330, { size: 40, color: C.cyan, alpha: a });
    // 链条
    hline(nodes[0].x, nodes[nodes.length - 1].x, CY, { color: C.grid, width: 2, alpha: a * 0.8 });
    for (let i = 0; i < nodes.length; i++) {
      const lit = easeOutQuint(seg(t, cardT(17) + 0.6 + i * 0.7, cardT(17) + 1.3 + i * 0.7));
      const node = nodes[i];
      const gold = i === nodes.length - 1;
      glow(node.x, CY, 52, gold ? 'rgba(255,200,87,0.35)' : 'rgba(127,209,255,0.3)', a * lit * 0.8);
      circle(node.x, CY, 54, { stroke: lit > 0.05 ? (gold ? C.gold : C.cyan) : C.slate, width: 2.5, alpha: a * (0.5 + lit * 0.5) });
      circle(node.x, CY, 46, { fill: 'rgba(5,7,13,0.85)', alpha: a });
      text(String(i + 1), node.x, CY + 12, { size: 40, align: 'center', color: lit > 0.05 ? (gold ? C.gold : C.cyan) : C.slate, alpha: a });
      if (!gold) text(node.label, node.x, CY + 106, { size: 40, align: 'center', color: C.inkDim, alpha: a * (0.5 + lit * 0.5) });
    }
    // 100 万美元：数字滚动出现
    const amountA = easeOutQuint(seg(t, cardT(17) + 0.6, cardT(17) + 2.2)) * a;
    const amount = 1000000 * easeOutQuint(seg(t, cardT(17) + 0.6, cardT(17) + 2.2));
    text('$' + group(amount), nodes[3].x, CY + 190, { size: 120, align: 'center', color: C.gold, alpha: amountA });
    // cardT(18)：条件苛刻——「满两年」被特别点亮并注明
    const strictA = easeOutQuint(seg(t, cardT(18), cardT(18) + 0.9)) * a;
    if (strictA > 0.01) {
      circle(nodes[1].x, CY, 64, { stroke: C.gold, width: 2, alpha: strictA * 0.8 });
      text('满两年，且被数学界普遍接受', nodes[1].x, CY + 150, { size: 28, align: 'center', color: C.gold, alpha: strictA });
    }
    // cardT(19)：稿子寄不过去——信封在「满两年」这一环被拦下
    const envA = easeOutQuint(seg(t, cardT(19), cardT(19) + 0.8)) * a;
    if (envA > 0.01) {
      const fly = easeInOutCubic(seg(t, cardT(19), cardT(19) + 1.2));
      const ex = lerp(nodes[0].x + 70, nodes[1].x - 54, fly);
      const ey = CY - 160 * Math.sin(Math.PI * fly) - 40;
      cx.save();
      cx.globalAlpha = envA;
      rrect(ex - 26, ey - 17, 52, 34, 4, 'rgba(244,247,255,0.10)', C.ink, 1.5);
      path([[ex - 26, ey - 17], [ex, ey + 4], [ex + 26, ey - 17]], { color: C.ink, width: 1.5, alpha: envA });
      cx.restore();
      const stopA = easeOutQuint(seg(t, cardT(19) + 1.1, cardT(19) + 1.8)) * a;
      if (stopA > 0.01) {
        text('×', nodes[1].x - 54, CY - 74, { size: 40, align: 'center', color: C.red, alpha: stopA });
        text('稿子寄不过去', nodes[1].x, CY + 196, { size: 28, align: 'center', color: C.gold, alpha: stopA });
      }
    }
  }

  // 全域极淡的扫光：给每个阶段一个持续的环境运动，避免画面长时间完全静止
  // （确定性：位置只由 t 决定；0.04 的透明度不会压过任何文字）。
  const sweepX = ((t * 90) % (W + 520)) - 260;
  const sweepG = cx.createLinearGradient(sweepX - 260, 0, sweepX + 260, 0);
  sweepG.addColorStop(0, 'rgba(127,209,255,0)');
  sweepG.addColorStop(0.5, 'rgba(127,209,255,0.04)');
  sweepG.addColorStop(1, 'rgba(127,209,255,0)');
  cx.save();
  cx.fillStyle = sweepG;
  cx.fillRect(0, 0, W, H);
  cx.restore();

  vignette(0.5);
  drawCards(t, CARDS);
`

/** 交付：两个镜头，秒数与 beats.mjs 一致。 */
export const CLIPS = {
  'timeline-170': { seconds: 98, code: TIMELINE_170 },
  consequences: { seconds: 66, code: CONSEQUENCES },
}

export default { CLIPS }
