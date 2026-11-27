/**
 * 镜头库：每个镜头是一个 `{ seconds, code }`，code 是 window.renderAt(t) 的函数体。
 * 全部确定性：只依赖 t 与常量表，不读时钟、不用 Math.random。
 */

const ZEROS = [
  14.134725142, 21.022039639, 25.010857580, 30.424876126, 32.935061588,
  37.586178159, 40.918719012, 43.327073281, 48.005150881, 49.773832478,
  52.970321478, 56.446247697, 59.347044003, 60.831778525, 65.112544048,
  67.079810529, 69.546401711, 72.067157674, 75.704690699, 77.144840069,
  79.337375020, 82.910380854, 84.735492981, 87.425274613, 88.809111208,
  92.491899271, 94.651344041, 95.870634228, 98.831194218, 101.317851006,
]

export const CLIPS = {
  /* ------------------------------------------------------------------ *
   * S00 · 开场：1859 年那张论文
   * ------------------------------------------------------------------ */
  'title-open': {
    seconds: 40,
    code: `
  clear(C.bg);
  dotGrid(0.035);
  // 纸页：一个缓慢呼吸的矩形，带极细的边线与纸张纹理感
  const pIn = easeOutQuint(seg(t, 0.2, 2.2));
  const pageW = 760, pageH = 980;
  const px = W/2 - pageW/2, py = H/2 - pageH/2 + (1-pIn)*40;
  cx.save();
  cx.globalAlpha = pIn * 0.92;
  cx.fillStyle = 'rgba(238,242,250,0.045)';
  cx.fillRect(px, py, pageW, pageH);
  cx.strokeStyle = 'rgba(127,209,255,0.22)';
  cx.lineWidth = 1.5;
  cx.strokeRect(px, py, pageW, pageH);
  cx.restore();
  // 纸上的假文字行（不是真内容，只是版式暗示）
  cx.save();
  cx.globalAlpha = pIn * 0.16;
  cx.fillStyle = C.inkDim;
  for (let i = 0; i < 22; i++) {
    const ly = py + 90 + i * 38;
    const lw = 300 + ((i * 137) % 260);
    cx.fillRect(px + 70, ly, lw, 7);
  }
  cx.restore();
  // 顶部：年份与标题
  const yIn = easeOutQuint(seg(t, 0.6, 2.0));
  text('1859', W/2, 150, { size: 132, weight: '200', align: 'center', alpha: yIn*0.9, color: C.ink, letterSpacing: 8 });
  text('BERLIN · AKADEMIE DER WISSENSCHAFTEN', W/2, 226, { size: 22, align: 'center', alpha: yIn*0.55, color: C.cyan, letterSpacing: 5 });
  // 德文论文标题逐字浮现（真实标题）
  const titleZh = 'Über die Anzahl der Primzahlen unter einer gegebenen Grösse';
  const shown = typed(titleZh, t, 2.2, 0.035);
  text(shown, W/2, H - 250, { size: 34, align: 'center', alpha: 0.85, italic: true, font: MATH });
  if (shown.length > 10) {
    const sub = easeOutQuint(seg(t, 4.4, 5.6));
    text('论小于给定值的素数个数', W/2, H - 196, { size: 30, align: 'center', alpha: sub*0.7, color: C.inkDim });
    text('八页 · 柏林科学院月报', W/2, H - 152, { size: 22, align: 'center', alpha: sub*0.5, color: C.slate, letterSpacing: 2 });
  }
  // 一束极淡的光扫过纸面
  const sweep = seg(t, 5.2, 8.2);
  if (sweep > 0 && sweep < 1) {
    const gx = px - 200 + sweep * (pageW + 400);
    const g = cx.createLinearGradient(gx-160, 0, gx+160, 0);
    g.addColorStop(0, 'rgba(127,209,255,0)');
    g.addColorStop(0.5, 'rgba(127,209,255,0.10)');
    g.addColorStop(1, 'rgba(127,209,255,0)');
    cx.save();
    cx.globalCompositeOperation = 'lighter';
    cx.fillStyle = g;
    cx.fillRect(px, py, pageW, pageH);
    cx.restore();
  }
  // ---- 第二页（22–40s）：纸页隐去，问题浮现 ----
  const coverA = easeInOutCubic(seg(t, 22, 25));
  if (coverA > 0) {
    cx.save(); cx.globalAlpha = coverA; cx.fillStyle = C.bg; cx.fillRect(0, 0, W, H); cx.restore();
  }
  const qA = easeOutQuint(seg(t, 25, 27.5));
  if (qA > 0) {
    glow(W/2, 520, 460, 'rgba(127,209,255,0.10)', qA);
    text('素数的出现', W/2, 470, { size: 96, align: 'center', alpha: qA, weight: '300', letterSpacing: 6 });
    text('到底有没有规律？', W/2, 614, { size: 96, align: 'center', alpha: easeOutQuint(seg(t, 27, 29.5)), weight: '300', color: C.gold, letterSpacing: 6 });
    const uA = easeOutQuint(seg(t, 30, 32.5));
    hline(W/2 - 240 * uA, W/2 + 240 * uA, 694, { color: C.cyan, width: 2, alpha: uA * 0.65 });
    text('167 年后，这个问题仍然没有答案', W/2, 772, { size: 28, align: 'center', color: C.inkDim, alpha: easeOutQuint(seg(t, 32, 34.5)) });
  }
  vignette(0.6);
  drawCards(t, CARDS);
`,
  },

  /* ------------------------------------------------------------------ *
   * S06 · 核心：零点的波如何叠出素数台阶的残差
   * 真实的显式公式计算（不是画出来的假曲线）
   * 四个页：公式 → 叠加 → 振幅 → 调音台
   * ------------------------------------------------------------------ */
  'money-explicit': {
    seconds: 96,
    code: `
  clear(C.bg);
  dotGrid(0.03);

  // ---- 预计算（只算一次）----
  if (!window.__cache) {
    const XMIN = 10, XMAX = 200, NP = 1200;
    const Z = ${JSON.stringify(ZEROS)};
    const sieve = new Uint8Array(XMAX + 1).fill(1); sieve[0] = sieve[1] = 0;
    for (let i = 2; i * i <= XMAX; i++) if (sieve[i]) for (let j = i*i; j <= XMAX; j += i) sieve[j] = 0;
    const jump = new Float64Array(XMAX + 2);
    for (let p = 2; p <= XMAX; p++) { if (sieve[p]) for (let q = p; q <= XMAX; q *= p) jump[q] += Math.log(p); }
    const psi = new Float64Array(XMAX + 2);
    let acc = 0;
    for (let x = 0; x <= XMAX; x++) { acc += jump[x]; psi[x] = acc; }
    const xs = [];
    for (let i = 0; i < NP; i++) xs.push(XMIN + (XMAX - XMIN) * i / (NP - 1));
    const psiAt = (x) => psi[Math.min(XMAX, Math.round(x))];
    const approx = (x, count, beta) => {
      const lg = Math.log(x);
      let s = x;
      for (let i = 0; i < count && i < Z.length; i++) {
        const g = Z[i], d = beta*beta + g*g;
        // 一般实部 beta 时：Re(x^{beta+i gamma} / rho) 的闭式
        const amp = Math.pow(x, beta);
        s -= 2 * amp * ((beta*Math.cos(g*lg) + g*Math.sin(g*lg)) / d);
      }
      return s - Math.log(2*Math.PI) - 0.5*Math.log(1 - 1/(x*x));
    };
    const resid = xs.map((x) => psiAt(x) - x);
    const approxResid = {};
    for (const c of [0,1,2,3,5,8,12,20,30]) approxResid['h'+c] = xs.map((x) => approx(x, c, 0.5) - x);
    for (const c of [1,3,10]) approxResid['b'+c] = xs.map((x) => approx(x, c, 0.8) - x);
    window.__cache = { xs, resid, approxResid };
  }
  const D = window.__cache;

  // ---- 布局 ----
  const L = 210, R = W - 210, TOP = 330, BOT = 880;
  const xMin = 10, xMax = 200, yRange = 9;
  const toX = (x) => L + (x - xMin) / (xMax - xMin) * (R - L);
  const toY = (v) => (TOP + BOT)/2 - (v / yRange) * ((BOT - TOP)/2);

  // ---- 页 1：公式（0–14s）----
  const p1 = clamp01(1 - seg(t, 12, 14));
  if (p1 > 0) {
    cx.save(); cx.globalAlpha = p1;
    text('显式公式', 132, 150, { size: 76, weight: '300', alpha: easeOutQuint(seg(t,0.3,1.6)), letterSpacing: 2 });
    text('THE EXPLICIT FORMULA', 136, 196, { size: 22, color: C.cyan, alpha: easeOutQuint(seg(t,0.6,1.8))*0.9, letterSpacing: 6 });
    // 公式分段浮现
    const parts = [
      { s: 'ψ(x)', at: 2.0, c: C.ink },
      { s: '  =  x', at: 3.0, c: C.cyan },
      { s: '  −  Σ  x^ρ / ρ', at: 4.4, c: C.gold },
      { s: '  −  log 2π', at: 6.4, c: C.inkDim },
      { s: '  −  ½ log(1 − x⁻²)', at: 7.6, c: C.inkDim },
    ];
    let fx = 132, fy = 420;
    for (const part of parts) {
      const a = easeOutQuint(seg(t, part.at, part.at + 0.9));
      if (a <= 0) continue;
      cx.save(); cx.globalAlpha = p1 * a;
      cx.font = '56px ' + MATH;
      cx.fillStyle = part.c;
      cx.textAlign = 'left';
      cx.fillText(part.s, fx, fy + (1-a)*14);
      cx.restore();
      fx += measure(part.s, 56, MATH);
    }
    // 中文注释逐条
    const notesP1 = [
      { at: 4.6, zh: '主项：素数大概有多少', color: C.cyan },
      { at: 6.0, zh: '每个零点贡献一根波', color: C.gold },
      { at: 9.2, zh: '这些是修正项，很小', color: C.inkDim },
    ];
    let ny = 520;
    for (const n of notesP1) {
      const a = easeOutQuint(seg(t, n.at, n.at + 0.8)) * p1;
      if (a <= 0) continue;
      text(n.zh, 138, ny, { size: 34, color: n.color, alpha: a });
      ny += 62;
    }
    // 一句总纲
    const g = easeOutQuint(seg(t, 10.2, 11.4)) * p1;
    text('素数计数 = 主项 + 每一个零点贡献的一根波', 132, 800, { size: 40, color: C.ink, alpha: g });
    cx.restore();
  }

  // ---- 页 2/3：残差与叠加（12–74s）----
  const p2 = clamp01(seg(t, 12.5, 14.5)) * clamp01(1 - seg(t, 72, 74.5));
  if (p2 > 0) {
    cx.save(); cx.globalAlpha = p2;
    const axisIn = easeOutQuint(seg(t, 13, 14.6));
    hline(L, L + (R-L)*axisIn, toY(0), { color: C.grid, width: 1.5 });
    for (const v of [-8,-4,0,4,8]) {
      hline(L, L + (R-L)*axisIn, toY(v), { color: C.grid, width: 1, alpha: 0.32 });
      text((v>0?'+':'') + v, L - 22, toY(v) + 7, { size: 22, align: 'right', color: C.slate, alpha: axisIn*0.8 });
    }
    for (const x of [10, 50, 100, 150, 200]) {
      text(String(x), toX(x), toY(-8) - 16, { size: 22, align: 'center', color: C.slate, alpha: axisIn*0.7 });
    }
    text('x', R + 34, toY(0) + 8, { size: 24, color: C.slate, alpha: axisIn });
    text('ψ(x) − x', L - 22, toY(8) - 20, { size: 24, align: 'right', color: C.slate, alpha: axisIn });

    const exactPts = D.xs.map((x, i) => [toX(x), toY(D.resid[i])]);
    path(exactPts, { color: C.cyan, width: 2.4, alpha: easeOutQuint(seg(t,14,16))*0.95, progress: easeOutQuint(seg(t,14,16.5)) });

    // 零点数随时间递增（14–62s）
    const grow = clamp01((t - 17) / 45);
    const seq = [0,0,1,1,2,2,3,3,5,5,8,8,12,12,20,20,30,30];
    const fi = Math.min(seq.length - 1, Math.floor(grow * seq.length));
    const Nnow = seq[fi], Nprev = seq[Math.max(0, fi - 1)];
    const localP = easeInOutCubic((grow * seq.length) - fi);
    if (t > 17) {
      const a1 = D.approxResid['h'+Nnow], a0 = D.approxResid['h'+Nprev];
      const pts = D.xs.map((x, i) => [toX(x), toY(lerp(a0[i], a1[i], localP))]);
      path(pts, { color: C.gold, width: 2.2, alpha: 0.92, progress: easeOutQuint(seg(t,17,18)) });
      text('已叠加零点：', W - 520, 150, { size: 28, align: 'right', color: C.slate, alpha: clamp01((t-17)/0.8) });
      text(String(Nnow), W - 420, 152, { size: 54, color: C.gold, weight: '300', alpha: clamp01((t-17)/0.8) });
      text('γ = 14.13, 21.02, 25.01, 30.42 …', W - 420, 206, { size: 22, color: C.cyanDim, alpha: clamp01((t-17)/0.8)*0.9, font: MATH, italic: true });
    }
    text('显式公式：每一根波，都是一个零点', 132, 150, { size: 52, weight: '300', alpha: easeOutQuint(seg(t,13,14.4)), letterSpacing: 1 });
    text('ψ(x) = x  −  Σ  x^ρ/ρ  −  …', 132, 212, { size: 32, color: C.cyan, alpha: easeOutQuint(seg(t,13.4,14.8))*0.85, font: MATH, italic: true });

    // 页 3：σ 决定振幅（62–74s）
    const p3 = clamp01(seg(t, 60, 62));
    if (p3 > 0) {
      cx.save(); cx.globalAlpha = p3 * 0.95;
      cx.fillStyle = 'rgba(5,7,13,0.86)';
      cx.fillRect(132, 250, W - 264, 620);
      cx.restore();
      text('零点的实部 σ，决定这根波有多响', 172, 320, { size: 40, alpha: p3 });
      // 两条同频不同振幅的波
      const y0 = 470, amp1 = 60, amp2 = 150;
      const ampA = easeOutQuint(seg(t, 62.5, 64.5));
      const wave1 = [], wave2 = [];
      for (let i = 0; i <= 260; i++) {
        const px = 200 + i * 6.2;
        wave1.push([px, y0 + amp1 * Math.sin(i * 0.12) * ampA]);
        wave2.push([px, y0 + amp2 * Math.sin(i * 0.12 + 0.6) * ampA]);
      }
      path(wave1, { color: C.cyan, width: 3 });
      path(wave2, { color: C.gold, width: 3, progress: easeOutQuint(seg(t,63.6,65)) });
      text('σ = 1/2', 200, 700, { size: 30, color: C.cyan, alpha: p3 });
      text('振幅 ~ √x', 200, 742, { size: 24, color: C.inkDim, alpha: p3 });
      text('σ = 0.8', 1440, 700, { size: 30, color: C.gold, alpha: p3 });
      text('振幅 ~ x⁰·⁸', 1440, 742, { size: 24, color: C.inkDim, alpha: p3 });
      text('σ 越大，波越响，误差越大', 172, 820, { size: 34, color: C.ink, alpha: p3 });
    }
    cx.restore();
  }

  // ---- 页 4：调音台（74–96s）----
  const p4 = clamp01(seg(t, 74.5, 76.5));
  if (p4 > 0) {
    cx.save(); cx.globalAlpha = p4;
    text('零点的位置，就是素数分布的调音台', W/2, 250, { size: 58, align: 'center', alpha: easeOutQuint(seg(t,75,77)), weight: '300' });
    // 8 个竖向推子：高度 = 该零点贡献的振幅，最终全部落到同一水平线
    const n = 8;
    const baseY = 780;
    const settle = easeInOutCubic(seg(t, 78, 86));
    for (let i = 0; i < n; i++) {
      const px = W/2 + (i - (n-1)/2) * 130;
      const wild = 90 + 150 * (0.5 + 0.5 * Math.sin(i * 2.7 + 1.3));
      const h = lerp(wild, 150, settle);
      vline(baseY, baseY - 260, px, { color: C.grid, width: 2, alpha: 0.6 });
      const g = cx.createLinearGradient(0, baseY, 0, baseY - h);
      g.addColorStop(0, 'rgba(127,209,255,0.15)');
      g.addColorStop(1, C.cyan);
      cx.save(); cx.globalAlpha = p4;
      cx.fillStyle = g;
      cx.fillRect(px - 16, baseY - h, 32, h);
      cx.restore();
      circle(px, baseY - h, 10, { fill: i % 2 ? C.gold : C.cyan, alpha: p4 });
      text('γ' + (i+1), px, baseY + 44, { size: 22, align: 'center', color: C.slate, alpha: p4 });
    }
    // 同一高度线
    const lineA = easeOutQuint(seg(t, 84, 86.5)) * p4;
    hline(W/2 - 560, W/2 + 560, baseY - 150, { color: C.gold, width: 2.5, alpha: lineA, dash: [10, 8] });
    text('全部 σ = 1/2：振幅被压在同一个量级', W/2, baseY - 186, { size: 34, align: 'center', color: C.gold, alpha: lineA });
    // 误差包络收敛
    const envA = easeOutQuint(seg(t, 88, 91)) * p4;
    if (envA > 0) {
      text('误差上界：x^β log x   →   √x log x', W/2, 900, { size: 38, align: 'center', color: C.ink, alpha: envA, font: MATH });
    }
    cx.restore();
  }

  vignette(0.5);
  drawCards(t, CARDS);
`,
  },

  /* ------------------------------------------------------------------ *
   * S05 · 正式陈述：复平面、临界带、临界线
   * ------------------------------------------------------------------ */
  'critical-strip': {
    seconds: 60,
    code: `
  clear(C.bg);
  dotGrid(0.03);

  // 复平面：Re 与 Im 用不同比例尺（Im 的零点跑到 14，Re 只到 3）
  const ox = 860, oy = 560, uRe = 150, uIm = 21;
  const px = (re) => ox + re * uRe;
  const py = (im) => oy - im * uIm;

  const axis = easeOutQuint(seg(t, 0.4, 2.2));
  hline(150, W - 150, oy, { color: C.grid, width: 1.5, alpha: axis });
  vline(170, H - 170, ox, { color: C.grid, width: 1.5, alpha: axis });
  text('Re(s)', W - 156, oy + 42, { size: 24, color: C.slate, alpha: axis });
  text('Im(s)', ox + 20, 196, { size: 24, color: C.slate, alpha: axis });
  for (let i = -2; i <= 3; i++) {
    if (i === 0) continue;
    vline(oy - 8, oy + 8, px(i), { color: C.slate, width: 1.5, alpha: axis * 0.7 });
    text(String(i), px(i), oy + 42, { size: 22, align: 'center', color: C.slate, alpha: axis * 0.7 });
  }

  // 临界带 0 < Re < 1
  const bandA = easeOutQuint(seg(t, 4.5, 6.5));
  if (bandA > 0) {
    cx.save();
    cx.globalAlpha = bandA;
    const g = cx.createLinearGradient(px(0), 0, px(1), 0);
    g.addColorStop(0, 'rgba(127,209,255,0.03)');
    g.addColorStop(0.5, 'rgba(127,209,255,0.10)');
    g.addColorStop(1, 'rgba(127,209,255,0.03)');
    cx.fillStyle = g;
    cx.fillRect(px(0), 200, px(1) - px(0), H - 400);
    cx.restore();
    text('临界带  0 < Re(s) < 1', px(1) + 28, 240, { size: 28, color: C.cyanDim, alpha: bandA });
  }

  // 临界线 Re = 1/2
  const lineA = easeOutQuint(seg(t, 8, 10));
  if (lineA > 0) {
    vline(200, H - 200, px(0.5), { color: C.gold, width: 2.5, alpha: lineA, dash: [12, 9] });
    text('临界线  Re(s) = 1/2', px(0.5) - 18, 240, { size: 28, align: 'right', color: C.gold, alpha: lineA });
  }

  // 平凡零点：负偶数
  const trivA = easeOutQuint(seg(t, 12, 14));
  if (trivA > 0) {
    for (const re of [-2, -4, -6]) circle(px(re), oy, 7, { stroke: C.slate, width: 2, alpha: trivA * 0.8 });
    text('平凡零点：负偶数', px(-6) - 20, oy + 76, { size: 24, align: 'center', color: C.slate, alpha: trivA * 0.9 });
    text('（它们不编码素数信息）', px(-6) - 20, oy + 112, { size: 20, align: 'center', color: C.slate, alpha: trivA * 0.6 });
  }

  // 非平凡零点：临界线上的一排
  const GAMMAS = [14.134725, 21.022040, 25.010858, 30.424876, 32.935062, 37.586178, 40.918719, 43.327073];
  const zeroA = easeOutQuint(seg(t, 16, 18));
  if (zeroA > 0) {
    for (let i = 0; i < GAMMAS.length; i++) {
      const appear = easeOutQuint(seg(t, 16 + i * 0.35, 17 + i * 0.35));
      if (appear <= 0) continue;
      const yy = py(GAMMAS[i]);
      glow(px(0.5), yy, 42 * appear, 'rgba(255,200,87,0.55)', appear * 0.55);
      circle(px(0.5), yy, 8 * appear, { fill: C.gold });
      if (i < 4) text('γ = ' + GAMMAS[i].toFixed(2), px(0.5) + 26, yy + 8, { size: 21, color: C.inkDim, alpha: appear * 0.85, font: MATH });
    }
    text('非平凡零点', px(0.5) + 26, py(37.586178) + 8, { size: 26, color: C.gold, alpha: zeroA * 0.9 });
  }

  // 正式陈述
  const stA = clamp01(seg(t, 30, 32)) * clamp01(1 - seg(t, 46, 48));
  if (stA > 0) {
    cx.save();
    cx.globalAlpha = stA * 0.92;
    cx.fillStyle = 'rgba(5,7,13,0.88)';
    cx.fillRect(120, 300, W - 240, 380);
    cx.restore();
    text('黎曼猜想', W/2, 400, { size: 30, align: 'center', color: C.slate, alpha: stA, letterSpacing: 8 });
    text('ζ 函数所有非平凡零点', W/2, 510, { size: 66, align: 'center', color: C.ink, alpha: stA, weight: '300' });
    text('都落在  Re(s) = 1/2  上', W/2, 610, { size: 66, align: 'center', color: C.gold, alpha: stA, weight: '300' });
    text('就这一句。没有例外条款。', W/2, 700, { size: 30, align: 'center', color: C.inkDim, alpha: stA * 0.85 });
  }

  // 已验证范围（48–60）
  const verA = easeOutQuint(seg(t, 48, 50));
  if (verA > 0) {
    const baseY = 800, x0 = 210, x1 = W - 210;
    hline(x0, x1, baseY, { color: C.grid, width: 2, alpha: verA });
    const frac = easeOutQuint(seg(t, 50, 55));
    const barW = (x1 - x0) * frac;
    const g = cx.createLinearGradient(x0, 0, x0 + Math.max(1, barW), 0);
    g.addColorStop(0, C.cyanDim);
    g.addColorStop(1, C.cyan);
    cx.save(); cx.globalAlpha = verA;
    cx.fillStyle = g;
    cx.fillRect(x0, baseY - 26, barW, 26);
    cx.restore();
    text('已检验', x0, baseY - 48, { size: 24, color: C.cyan, alpha: verA });
    text('3 × 10¹² 高度内，1.2363 × 10¹³ 个零点', x0 + barW + 18, baseY - 8, { size: 26, color: C.ink, alpha: verA });
    const infA = easeOutQuint(seg(t, 55, 58)) * verA;
    text('但没有证明——零点有无穷多个，无穷不能被有限的检查说服。', x0, baseY + 76, { size: 30, color: C.gold, alpha: infA });
  }

  vignette(0.5);
  drawCards(t, CARDS);
`,
  },

  /* ------------------------------------------------------------------ *
   * S03 · 从欧拉到黎曼：ζ(2) 收敛、欧拉乘积、s=1 的墙、升维
   * ------------------------------------------------------------------ */
  'zeta-euler': {
    seconds: 82,
    code: `
  clear(C.bg);
  dotGrid(0.03);

  // ---------- 页 A（0–30s）：ζ(2) 部分和收敛 ----------
  const pA = clamp01(seg(t, 0.3, 1.5)) * clamp01(1 - seg(t, 28, 30));
  if (pA > 0) {
    cx.save(); cx.globalAlpha = pA;
    text('ζ(s) = 1 + 1/2ˢ + 1/3ˢ + 1/4ˢ + …', 132, 200, { size: 46, alpha: easeOutQuint(seg(t,0.5,1.8)), font: MATH, italic: true });
    text('取 s = 2，把每一项都算出来', 136, 258, { size: 26, color: C.slate, alpha: easeOutQuint(seg(t,1.2,2.4)) });

    const x0 = 150, baseY = 720, barW = 34, gap = 6;
    const appear = seg(t, 2.2, 8.5);
    const nMax = 14;
    const shown = Math.max(1, Math.floor(appear * nMax));
    for (let n = 1; n <= shown; n++) {
      const v = 1 / (n * n);
      const h = v * 360;
      const bx = x0 + (n - 1) * (barW + gap);
      const a = n === shown ? (appear * nMax - shown + 1) : 1;
      cx.save(); cx.globalAlpha = pA * clamp01(a);
      const g = cx.createLinearGradient(0, baseY, 0, baseY - h);
      g.addColorStop(0, 'rgba(127,209,255,0.2)');
      g.addColorStop(1, C.cyan);
      cx.fillStyle = g;
      cx.fillRect(bx, baseY - h, barW, h);
      cx.restore();
      if (n <= 6) text(String(n), bx + barW/2, baseY + 34, { size: 22, align: 'center', color: C.slate, alpha: pA });
    }
    text('1/n²', x0 - 24, baseY + 34, { size: 22, align: 'right', color: C.slate, alpha: pA });

    const sumPts = [];
    let acc = 0;
    for (let n = 1; n <= 60; n++) {
      acc += 1 / (n * n);
      if (seg(t, 2.2 + n * 0.12, 8.5) <= 0) break;
      sumPts.push([x0 + (n - 1) * 16, baseY - acc * 360]);
    }
    path(sumPts, { color: C.gold, width: 3, alpha: pA * 0.95 });
    const targetA = easeOutQuint(seg(t, 10, 12)) * pA;
    hline(x0, x0 + 60 * 16, baseY - 1.644934 * 360, { color: C.gold, width: 1.5, alpha: targetA * 0.6, dash: [8, 8] });
    text('π²/6 ≈ 1.6449', x0 + 60 * 16 + 10, baseY - 1.644934 * 360 + 8, { size: 30, color: C.gold, alpha: targetA, font: MATH });
    text('和趋近一个数，但永远差最后一点点', 136, baseY + 110, { size: 32, color: C.ink, alpha: easeOutQuint(seg(t, 14, 16)) * pA });
    cx.restore();
  }

  // ---------- 页 B（28–52s）：欧拉乘积 ----------
  const pB = clamp01(seg(t, 28.5, 30)) * clamp01(1 - seg(t, 50, 52.5));
  if (pB > 0) {
    cx.save(); cx.globalAlpha = pB;
    text('对全体整数求和  =  只对素数求积', W/2, 190, { size: 46, align: 'center', alpha: easeOutQuint(seg(t,29,30.6)) });
    const LN = 1180, RP = 1000;
    for (let i = 0; i < 12; i++) {
      const a = easeOutQuint(seg(t, 30 + i * 0.12, 30.6 + i * 0.12));
      text(String(i + 1) + (i < 11 ? ' ·' : ' …'), LN, 280 + i * 44, { size: 32, color: C.inkDim, alpha: a * 0.9, font: MONO });
    }
    text('所有整数', LN, 244, { size: 26, color: C.slate, alpha: pB });
    const primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37];
    for (let i = 0; i < primes.length; i++) {
      const a = easeOutQuint(seg(t, 32 + i * 0.18, 32.6 + i * 0.18));
      text(String(primes[i]) + (i < 11 ? ' ·' : ' …'), RP, 280 + i * 44, { size: 32, color: C.cyan, alpha: a });
    }
    text('只有素数', RP, 244, { size: 26, color: C.cyan, alpha: pB });
    const eqA = easeOutQuint(seg(t, 36, 38));
    text('=', W/2, 600, { size: 120, align: 'center', color: C.gold, alpha: eqA, font: MATH, weight: '200' });
    glow(W/2, 560, 190, 'rgba(255,200,87,0.16)', eqA * 0.9);
    text('Σ 1/nˢ   =   ∏ 1/(1 − p⁻ˢ)', W/2, 730, { size: 52, align: 'center', color: C.ink, alpha: easeOutQuint(seg(t, 40, 42)) * pB, font: MATH });
    text('素数是乘法的原子，而这把钥匙能撬动整条数轴', W/2, 812, { size: 32, align: 'center', color: C.gold, alpha: easeOutQuint(seg(t, 44, 46)) * pB });
    cx.restore();
  }

  // ---------- 页 C（50–64s）：s = 1 的墙 ----------
  const pC = clamp01(seg(t, 50.5, 52)) * clamp01(1 - seg(t, 62, 64));
  if (pC > 0) {
    cx.save(); cx.globalAlpha = pC;
    text('s = 1 时：调和级数', 132, 220, { size: 52, alpha: easeOutQuint(seg(t,51,52.4)) });
    text('1 + 1/2 + 1/3 + 1/4 + …', 136, 292, { size: 44, alpha: pC, font: MATH, italic: true });
    const grow = easeInOutCubic(seg(t, 52, 61));
    const baseY = 880;
    for (let n = 1; n <= 40; n++) {
      const h = Math.log(n) * 120 * grow + 12;
      const bx = 150 + (n - 1) * 40;
      cx.save(); cx.globalAlpha = pC * clamp01(grow * 1.4);
      cx.fillStyle = n > 30 ? C.red : C.cyanDim;
      cx.fillRect(bx, baseY - h, 30, h);
      cx.restore();
    }
    text('它发散到无穷', 132, 372, { size: 40, color: C.red, alpha: easeOutQuint(seg(t, 57, 60)) * pC });
    text('这恰好又证明了：素数有无穷多个', W/2, 200, { size: 40, align: 'center', color: C.gold, alpha: easeOutQuint(seg(t, 60, 62.5)) * pC });
    cx.restore();
  }

  // ---------- 页 D（62–82s）：升维 ----------
  const pD = clamp01(seg(t, 62.5, 64));
  if (pD > 0) {
    cx.save(); cx.globalAlpha = pD;
    const tf = easeInOutCubic(seg(t, 64, 71));
    const cy0 = 560;
    if (tf < 1) {
      cx.save(); cx.globalAlpha = pD * (1 - tf);
      hline(180, W - 180, cy0, { color: C.cyan, width: 2.5 });
      for (let i = -3; i <= 3; i++) {
        const px2 = W/2 + i * 180;
        vline(cy0 - 8, cy0 + 8, px2, { color: C.cyan, width: 2, alpha: 0.8 });
        text(String(i), px2, cy0 + 46, { size: 24, align: 'center', color: C.inkDim });
      }
      text('实数轴 · 一维', W/2, cy0 - 70, { size: 30, align: 'center', color: C.cyan });
      cx.restore();
    }
    if (tf > 0) {
      cx.save(); cx.globalAlpha = pD * tf;
      const g2 = plane(W/2, cy0, 180);
      for (let i = -4; i <= 4; i++) {
        vline(220, 900, g2.x(i), { color: C.grid, width: 1, alpha: 0.6 });
        hline(180, W - 180, g2.y(i), { color: C.grid, width: 1, alpha: 0.6 });
      }
      hline(180, W - 180, cy0, { color: C.cyan, width: 2, alpha: 0.9 });
      vline(220, 900, W/2, { color: C.cyan, width: 2, alpha: 0.9 });
      text('实数轴', W - 200, cy0 + 40, { size: 24, align: 'right', color: C.cyan, alpha: 0.9 });
      text('虚轴', W/2 + 16, 240, { size: 24, color: C.cyan, alpha: 0.9 });
      text('复平面 · 二维', W/2, 196, { size: 34, align: 'center', color: C.gold });
      const ptA = easeOutQuint(seg(t, 71, 73.5));
      const sx = g2.x(0.5), sy = g2.y(1.4);
      glow(sx, sy, 60, 'rgba(255,200,87,0.5)', ptA * 0.8);
      circle(sx, sy, 9, { fill: C.gold, alpha: ptA });
      text('s = σ + it', sx + 26, sy - 12, { size: 32, color: C.gold, alpha: ptA, font: MATH });
      cx.restore();
    }
    text('如果 s 不只是一个数，而是一个复数呢？', W/2, 965, { size: 42, align: 'center', color: C.ink, alpha: easeOutQuint(seg(t, 73, 76)) * pD });
    cx.restore();
  }

  vignette(0.5);
  drawCards(t, CARDS);
`,
  },

  /* ------------------------------------------------------------------ *
   * S04 · 解析延拓：收敛域生长、s=1 的洞、唯一性、−1/12、零点被挤进带子
   * ------------------------------------------------------------------ */
  'continuation': {
    seconds: 92,
    code: `
  clear(C.bg);
  dotGrid(0.03);

  const ox = W/2, oy = 560, unit = 150;
  const px = (re) => ox + re * unit;
  const py = (im) => oy - im * unit;

  // 复平面底（贯穿全片）
  const planeA = easeOutQuint(seg(t, 0.3, 2));
  for (let i = -5; i <= 5; i++) {
    vline(200, 940, px(i), { color: C.grid, width: 1, alpha: planeA * 0.5 });
  }
  for (let j = -2; j <= 2; j++) {
    hline(180, W - 180, py(j), { color: C.grid, width: 1, alpha: planeA * 0.5 });
  }
  hline(180, W - 180, oy, { color: C.grid, width: 1.5, alpha: planeA * 0.8 });
  vline(200, 940, ox, { color: C.grid, width: 1.5, alpha: planeA * 0.8 });
  for (let i = -4; i <= 4; i++) {
    if (i === 0) continue;
    text(String(i), px(i), oy + 40, { size: 21, align: 'center', color: C.slate, alpha: planeA * 0.7 });
  }
  text('Re', W - 160, oy + 44, { size: 24, color: C.slate, alpha: planeA });
  text('Im', ox + 16, 216, { size: 24, color: C.slate, alpha: planeA });

  // ---- 0–14：收敛区 σ > 1 ----
  const regA = easeOutQuint(seg(t, 2.5, 4.5));
  if (regA > 0) {
    cx.save(); cx.globalAlpha = regA;
    cx.fillStyle = 'rgba(127,209,255,0.10)';
    cx.fillRect(px(1), 210, px(5) - px(1), 730);
    cx.restore();
    vline(210, 940, px(1), { color: C.cyan, width: 2, alpha: regA, dash: [10, 8] });
    text('σ > 1：收敛', px(1) + 20, 240, { size: 28, color: C.cyan, alpha: regA });
    text('再往左，级数发散', px(-4), 900, { size: 28, color: C.red, alpha: easeOutQuint(seg(t, 8, 10)) * regA });
  }

  // ---- 14–32：交错级数把收敛区推到 σ > 0 ----
  const growA = easeInOutCubic(seg(t, 14, 28));
  if (growA > 0) {
    const leftEdge = lerp(px(1), px(0), growA);
    cx.save(); cx.globalAlpha = 0.16 * clamp01(seg(t,14,16));
    cx.fillStyle = C.cyan;
    cx.fillRect(leftEdge, 210, px(5) - leftEdge, 730);
    cx.restore();
    vline(210, 940, leftEdge, { color: C.gold, width: 2.5, alpha: 0.9, dash: [10, 8] });
    if (growA > 0.95) {
      text('交错级数把它推到 σ > 0', px(0) + 20, 240, { size: 28, color: C.gold, alpha: easeOutQuint(seg(t, 27, 29)) });
    }
    text('1 − 1/2ˢ + 1/3ˢ − 1/4ˢ + …', 132, 172, { size: 34, color: C.cyan, alpha: clamp01(seg(t,15,17)) * 0.9, font: MATH, italic: true });
  }

  // ---- 32–46：推到整个平面，只留 s=1 的洞 ----
  const fullA = easeInOutCubic(seg(t, 32, 42));
  if (fullA > 0) {
    cx.save(); cx.globalAlpha = 0.13 * fullA;
    cx.fillStyle = C.cyan;
    cx.fillRect(px(-5), 210, px(5) - px(-5), 730);
    cx.restore();
    // s = 1 的洞
    const holeA = easeOutQuint(seg(t, 36, 39));
    if (holeA > 0) {
      circle(px(1), oy, 44, { fill: C.bg, alpha: holeA });
      circle(px(1), oy, 44, { stroke: C.red, width: 2.5, alpha: holeA });
      glow(px(1), oy, 90, 'rgba(255,107,107,0.35)', holeA * 0.8);
      text('极点  s = 1', px(1) + 62, oy + 10, { size: 30, color: C.red, alpha: holeA });
      text('对应「素数有无穷多个」', px(1) + 62, oy + 50, { size: 22, color: C.inkDim, alpha: holeA * 0.9 });
    }
    text('解析延拓到整个平面（除 s = 1）', 132, 172, { size: 34, color: C.gold, alpha: fullA });
  }

  // ---- 46–58：唯一性 ----
  const uniqA = clamp01(seg(t, 46, 48)) * clamp01(1 - seg(t, 56, 58));
  if (uniqA > 0) {
    cx.save(); cx.globalAlpha = uniqA * 0.93;
    cx.fillStyle = 'rgba(5,7,13,0.9)';
    cx.fillRect(120, 300, W - 240, 320);
    cx.restore();
    text('解析延拓是唯一的', W/2, 400, { size: 56, align: 'center', color: C.gold, alpha: uniqA, weight: '300' });
    text('不是拟合，不是外推，也不是猜', W/2, 480, { size: 32, align: 'center', color: C.inkDim, alpha: uniqA });
    text('条件一旦给定，函数在别处的值就被锁死', W/2, 552, { size: 36, align: 'center', color: C.ink, alpha: easeOutQuint(seg(t, 50, 52)) * uniqA });
  }

  // ---- 58–72：−1/12 的澄清 ----
  const dA = clamp01(seg(t, 58, 60)) * clamp01(1 - seg(t, 70, 72));
  if (dA > 0) {
    cx.save(); cx.globalAlpha = dA;
    text('1 + 2 + 3 + 4 + …', W/2, 360, { size: 72, align: 'center', color: C.ink, alpha: dA, font: MATH, italic: true });
    const eqA = easeOutQuint(seg(t, 60, 62));
    text('= −1/12', W/2, 470, { size: 72, align: 'center', color: C.red, alpha: eqA, font: MATH });
    const strike = easeOutQuint(seg(t, 62, 64));
    if (strike > 0) {
      hline(W/2 - 150, W/2 - 150 + 300 * strike, 448, { color: C.red, width: 4, alpha: strike });
    }
    const corr = easeOutQuint(seg(t, 64, 67)) * dA;
    text('严格说：这不是这个级数的和', W/2, 600, { size: 40, align: 'center', color: C.ink, alpha: corr });
    text('而是 ζ(−1) 的值。级数本身照样发散。', W/2, 668, { size: 36, align: 'center', color: C.gold, alpha: easeOutQuint(seg(t, 66, 69)) * dA });
    cx.restore();
  }

  // ---- 72–92：平凡零点 + 非平凡零点被挤进带子 ----
  const zA = easeOutQuint(seg(t, 72, 74.5));
  if (zA > 0) {
    for (const re of [-2, -4, -6, -8]) {
      circle(px(re), oy, 8, { stroke: C.slate, width: 2, alpha: zA * 0.85 });
    }
    text('平凡零点：−2, −4, −6, …', px(-8) - 10, oy + 82, { size: 26, align: 'center', color: C.slate, alpha: zA });
    const bandA = easeOutQuint(seg(t, 76, 79));
    if (bandA > 0) {
      cx.save(); cx.globalAlpha = bandA * 0.9;
      cx.fillStyle = 'rgba(255,200,87,0.10)';
      cx.fillRect(px(0), 210, px(1) - px(0), 730);
      cx.restore();
      vline(210, 940, px(0), { color: C.gold, width: 2, alpha: bandA });
      vline(210, 940, px(1), { color: C.gold, width: 2, alpha: bandA });
      vline(210, 940, px(0.5), { color: C.gold, width: 2.5, alpha: bandA, dash: [12, 9] });
      text('真正有意思的零点，全被挤在这条带子里', px(1) + 26, 260, { size: 26, color: C.gold, alpha: bandA });
    }
  }

  vignette(0.5);
  drawCards(t, CARDS);
`,
  },
}
