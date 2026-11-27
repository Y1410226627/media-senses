/**
 * 批次 A 镜头：s01 `sieve`（素数有没有规律）+ s02 `atom-rsa`（素数为什么重要）。
 *
 * 每个镜头是 `{ seconds, code }`，code 是 window.renderAt(t) 的函数体，
 * 可直接被 demo/riemann/kit.mjs 的 buildHtml() 内联。全部确定性：
 * 只依赖 t 与初始化时算好的常量表，不读时钟、不用 Math.random，缓动只用
 * easeOutQuint / easeInOutCubic，不做弹跳。
 *
 * 字幕统一在窗口底部：每条字幕卡由 beats.mjs 的 scheduleCards() 排好时间后，
 * 以 CARDS 常量注入页面；本文件只在每帧最后调用 drawCards(t, CARDS)，
 * 放在 vignette 之后，保证字幕不被压暗。
 */

const SIEVE_SHADER = `
  clear(C.bg);
  dotGrid(0.03);

  /* ================================================================
   * 一次性预计算：素数表、数阵布局、间隔表、π(x) / li(x) / x·lnx 采样
   * ================================================================ */
  if (!window.__sieveCache) {
    const LIMIT = 200;
    const sieve = new Uint8Array(LIMIT + 1).fill(1);
    sieve[0] = 0; sieve[1] = 0;
    for (let i = 2; i * i <= LIMIT; i += 1) {
      if (sieve[i]) for (let j = i * i; j <= LIMIT; j += i) sieve[j] = 0;
    }
    const primes = [];
    for (let n = 2; n <= LIMIT; n += 1) if (sieve[n]) primes.push(n);
    const rank = new Int16Array(LIMIT + 1).fill(-1);
    for (let i = 0; i < primes.length; i += 1) rank[primes[i]] = i;

    const COLS = 16;
    const STEP_X = 100;
    const STEP_Y = 46;
    const STRIKE_P = [2, 3, 5, 7];
    const cells = [];
    for (let n = 2, index = 0; n <= LIMIT; n += 1, index += 1) {
      const strikes = [];
      for (let si = 0; si < STRIKE_P.length; si += 1) {
        const p = STRIKE_P[si];
        if (n > p && n % p === 0) {
          const total = Math.floor(LIMIT / p) - 1;
          strikes.push({ index: si, order: n / p - 2, total });
        }
      }
      cells.push({
        n,
        col: index % COLS,
        row: Math.floor(index / COLS),
        prime: sieve[n] === 1,
        rank: rank[n],
        strikes,
      });
    }

    const gaps = [];
    for (let i = 1; i < primes.length; i += 1) gaps.push({ from: primes[i - 1], gap: primes[i] - primes[i - 1] });

    const piTable = new Int16Array(LIMIT + 1);
    let running = 0;
    for (let x = 0; x <= LIMIT; x += 1) { if (sieve[x]) running += 1; piTable[x] = running; }

    // li(x) = li(2) + ∫₂ˣ dt/ln t，Simpson 累积；li(2) 取标准主值。
    const liTable = new Float64Array(LIMIT + 1);
    liTable[2] = 1.045163780117493;
    let integral = 0;
    for (let x = 3; x <= LIMIT; x += 1) {
      const a = x - 1;
      const b = x;
      const STEPS = 160;
      let sum = 0;
      for (let k = 0; k <= STEPS; k += 1) {
        const u = a + (b - a) * k / STEPS;
        const w = (k === 0 || k === STEPS) ? 1 : (k % 2 === 0 ? 2 : 4);
        sum += w / Math.log(u);
      }
      integral += (b - a) / 3 / STEPS * sum;
      liTable[x] = 1.045163780117493 + integral;
    }

    const xlnxTable = new Float64Array(LIMIT + 1);
    for (let x = 2; x <= LIMIT; x += 1) xlnxTable[x] = x / Math.log(x);

    window.__sieveCache = { LIMIT, sieve, primes, rank, cells, gaps, piTable, liTable, xlnxTable, COLS, STEP_X, STEP_Y };
  }
  const D = window.__sieveCache;

  /* ================================================================
   * 全局时间相位（与 beats.mjs 的 26 张字幕卡对齐）
   * ================================================================ */
  const gridIn = easeOutQuint(seg(t, 0.2, 1.6));
  const gridOut = 1 - easeOutQuint(seg(t, 20.8, 22.0));
  const gridEnd = 1 - easeOutQuint(seg(t, 52.8, 54.0));
  const gridAlpha = gridIn * gridOut * gridEnd;

  const statsIn = easeOutQuint(seg(t, 21.0, 22.4));
  const statsOut = 1 - easeOutQuint(seg(t, 34.2, 35.2));
  const statsAlpha = statsIn * statsOut;

  const gapIn = easeOutQuint(seg(t, 35.2, 36.4));
  const gapOut = 1 - easeOutQuint(seg(t, 40.6, 41.6));
  const gapAlpha = gapIn * gapOut;

  const twinIn = easeOutQuint(seg(t, 41.2, 42.2));
  const twinOut = 1 - easeOutQuint(seg(t, 46.2, 47.2));
  const twinAlpha = twinIn * twinOut;

  const maxIn = easeOutQuint(seg(t, 46.7, 47.5));
  const maxOut = 1 - easeOutQuint(seg(t, 49.6, 50.4));
  const maxAlpha = maxIn * maxOut;

  const splitIn = easeOutQuint(seg(t, 50.0, 51.0));
  const splitOut = 1 - easeOutQuint(seg(t, 52.2, 53.1));
  const splitAlpha = splitIn * splitOut;

  const formulaIn = easeOutQuint(seg(t, 52.9, 53.9));
  const formulaOut = 1 - easeOutQuint(seg(t, 58.0, 59.0));
  const formulaAlpha = formulaIn * formulaOut;

  const graphIn = easeOutQuint(seg(t, 58.9, 60.1));
  const graphAlpha = graphIn;

  /* ================================================================
   * 阶段一：数阵 + 素数逐个亮起（0–20.5s）
   * ================================================================ */
  if (gridAlpha > 0.002) {
    const baseX = 178;
    const baseY = 250;

    // 开场标题：先给这段一个问题，再让数阵回答
    const openTitle = easeOutQuint(seg(t, 0.5, 1.6)) * (1 - easeOutQuint(seg(t, 5.6, 6.8)));
    if (openTitle > 0.01) {
      text('素数有没有规律', 132, 150, { size: 76, weight: '300', alpha: gridAlpha * openTitle, letterSpacing: 2 });
    }

    // 阶段一的强调：素数逐个点亮；17.6s 后剩下的素数轻轻浮起。
    const lift = easeOutQuint(seg(t, 18.3, 19.8));

    for (const cell of D.cells) {
      const px = baseX + cell.col * D.STEP_X;
      const py = baseY + cell.row * D.STEP_Y - (cell.prime ? lift * 6 : 0);

      // 被筛掉的进度（多种筛法取最大）
      let struck = 0;
      let leaving = null;
      for (const strike of cell.strikes) {
        const start = 8.9 + strike.index * 2.9;
        const reveal = clamp01((t - start) / 1.7) * strike.total;
        const frac = clamp01(reveal - strike.order);
        if (frac > struck) struck = frac;
        if (frac > 0 && frac < 1) leaving = { frac, index: strike.index };
      }

      const primeP = cell.prime && cell.rank >= 0
        ? easeOutQuint(seg(t, 1.4 + cell.rank * 0.105, 2.1 + cell.rank * 0.105))
        : 0;

      const alive = 1 - 0.86 * struck;
      const alpha = gridAlpha * (0.42 + 0.58 * primeP) * (cell.prime ? 1 : 0.72) * Math.max(0.14, alive);

      // 素数光晕
      if (cell.prime && primeP > 0) {
        glow(px + 30, py - 8, 26, 'rgba(127,209,255,0.30)', gridAlpha * primeP * (0.25 + 0.45 * lift));
      }

      // 数字本体
      text(String(cell.n), px + 30, py, {
        size: 28,
        align: 'center',
        color: cell.prime ? C.cyan : C.inkDim,
        alpha,
      });

      // 删除线：划掉 2/3/5/7 的倍数
      if (struck > 0) {
        cx.save();
        cx.globalAlpha = gridAlpha * 0.5 * Math.min(1, struck * 1.2);
        cx.strokeStyle = C.slate;
        cx.lineWidth = 1.4;
        const half = cell.n >= 100 ? 26 : 20;
        cx.beginPath();
        cx.moveTo(px + 30 - half, py - 8);
        cx.lineTo(px + 30 - half + half * 2 * Math.min(1, struck), py - 8);
        cx.stroke();
        cx.restore();
      }

      // 正在被划掉的那一下：给倍数一个短暂的发亮
      if (leaving !== null) {
        glow(px + 30, py - 8, 18, 'rgba(127,209,255,0.32)', gridAlpha * (1 - leaving.frac) * 0.8);
      }
    }

    // 筛子的四个「筛眼」：2、3、5、7 各在开始时被圈一下
    const STRIKE_P = [2, 3, 5, 7];
    for (let si = 0; si < STRIKE_P.length; si += 1) {
      const start = 8.9 + si * 2.9;
      const ring = seg(t, start, start + 0.35) * (1 - seg(t, start + 1.2, start + 1.8));
      if (ring <= 0) continue;
      const cell = D.cells[STRIKE_P[si] - 2];
      const px = baseX + cell.col * D.STEP_X;
      const py = baseY + cell.row * D.STEP_Y;
      circle(px + 30, py - 8, 26, { stroke: C.ink, width: 2, alpha: gridAlpha * ring * 0.85 });
    }

    // 从第 20.5s 起，数阵随字幕淡出，交接给「越稀」的统计
    const hintIn = easeOutQuint(seg(t, 18.4, 19.6)) * (1 - easeOutQuint(seg(t, 20.4, 21.2)));
    if (hintIn > 0.01) {
      text('筛不掉的，是素数', 178, 862, { size: 40, color: C.inkDim, alpha: gridAlpha * hintIn * 0.9 });
    }
  }

  /* ================================================================
   * 阶段二：素数越来越稀（21–34s）——四个统计数字
   * ================================================================ */
  if (statsAlpha > 0.002) {
    const stats = [
      { at: 22.9, value: 4, label: '10 以内', unit: '个' },
      { at: 25.9, value: 25, label: '100 以内', unit: '个' },
      { at: 28.9, value: 168, label: '1000 以内', unit: '个' },
      { at: 31.7, value: 5, label: '10 亿以内', unit: '', suffix: '%', gold: true },
    ];
    const titleIn = easeOutQuint(seg(t, 21.2, 22.3));
    text('越往后，素数越稀', 132, 150, { size: 76, weight: '300', alpha: statsAlpha * titleIn, letterSpacing: 2 });

    for (let index = 0; index < stats.length; index += 1) {
      const stat = stats[index];
      const appear = easeOutQuint(seg(t, stat.at, stat.at + 1.1));
      if (appear <= 0) continue;
      // 2×2 四宫格，避免大数字与下一行标签挤在一起
      const col = index % 2;
      const row = Math.floor(index / 2);
      const rowX = 132 + col * 820;
      const rowY = 430 + row * 380;
      const shown = stat.value * appear;
      const display = stat.suffix ? Math.round(shown) + stat.suffix : String(Math.round(shown));
      const colour = stat.gold ? C.gold : C.cyan;

      hline(rowX, rowX + 120 * appear, rowY - 190, { color: C.grid, width: 1.5, alpha: statsAlpha * appear });
      text(stat.label, rowX, rowY - 152, { size: 40, color: C.inkDim, alpha: statsAlpha * appear });
      text(display, rowX, rowY, { size: 140, weight: '300', color: colour, alpha: statsAlpha * appear });
      const numberWidth = measure(display, 140, SANS, '300');
      text(stat.unit, rowX + numberWidth + 18, rowY, { size: 40, color: C.inkDim, alpha: statsAlpha * appear * 0.85 });

      // 右侧一条对数轴，提示「密度」在变稀（示意，不是精确刻度）
      const axisX = 1560;
      const axisTop = 300;
      const axisBottom = 830;
      vline(axisTop, axisBottom, axisX, { color: C.grid, width: 1.5, alpha: statsAlpha * 0.7 });
      const markerY = axisBottom - (axisBottom - axisTop) * (index / (stats.length - 1 + 0.35));
      circle(axisX, markerY, 6, {
        fill: colour,
        alpha: statsAlpha * appear,
      });
      if (index === 0) {
        text('密度', axisX + 20, axisTop + 6, { size: 24, color: C.slate, alpha: statsAlpha * 0.8 });
        text('对数尺度示意', axisX + 20, axisTop + 38, { size: 24, color: C.slate, alpha: statsAlpha * 0.55 });
      }
    }
  }

  /* ================================================================
   * 阶段三：平均间隔 ≈ ln x（34–41.5s）——间隔柱 + 对数曲线
   * ================================================================ */
  if (gapAlpha > 0.002) {
    const GL = 220;
    const GR = 1700;
    const GTOP = 320;
    const GBOT = 800;
    const maxGap = D.gaps.reduce((best, entry) => Math.max(best, entry.gap), 0);
    const toGX = (x) => GL + (x - 2) / 198 * (GR - GL);
    const toGY = (gap) => GBOT - (gap / maxGap) * (GBOT - GTOP);

    const axisIn = easeOutQuint(seg(t, 34.2, 35.2));
    hline(GL, GL + (GR - GL) * axisIn, GBOT, { color: C.grid, width: 1.5, alpha: gapAlpha });
    for (const x of [2, 50, 100, 150, 200]) {
      vline(GBOT, GBOT + 10, toGX(x), { color: C.grid, width: 1.2, alpha: gapAlpha * axisIn * 0.8 });
      text(String(x), toGX(x), GBOT + 40, { size: 24, align: 'center', color: C.slate, alpha: gapAlpha * axisIn * 0.8 });
    }
    text('相邻素数的间隔', 132, 260, { size: 40, color: C.inkDim, alpha: gapAlpha * axisIn });

    // 每两个相邻素数之间画一根柱子
    for (let index = 0; index < D.gaps.length; index += 1) {
      const entry = D.gaps[index];
      const barIn = easeOutQuint(seg(t, 34.4 + index * 0.035, 35.2 + index * 0.035));
      if (barIn <= 0) continue;
      const bx = toGX(entry.from);
      const top = toGY(entry.gap * barIn);
      cx.save();
      cx.globalAlpha = gapAlpha * 0.8;
      cx.fillStyle = entry.gap >= 12 ? C.inkDim : C.cyanDim;
      cx.fillRect(bx - 9, top, 18, GBOT - top);
      cx.restore();
    }

    // ln x 曲线：平均间隔应该长成的样子
    const curveIn = easeOutQuint(seg(t, 35.0, 36.4));
    if (curveIn > 0) {
      const pts = [];
      for (let x = 10; x <= 200; x += 2) pts.push([toGX(x), toGY(Math.log(x))]);
      path(pts, { color: C.inkDim, width: 2.4, dash: [9, 9], alpha: gapAlpha * curveIn * 0.9, progress: curveIn });
      text('ln x', toGX(200) + 16, toGY(Math.log(200)) + 8, { size: 28, color: C.inkDim, alpha: gapAlpha * curveIn });
    }

    // 「平均」两个字 + 均值线；卡 13 起强调它没用
    const avgIn = easeOutQuint(seg(t, 36.0, 37.2));
    const meanGap = D.gaps.reduce((sum, entry) => sum + entry.gap, 0) / D.gaps.length;
    if (avgIn > 0) {
      const avgY = toGY(meanGap);
      hline(GL, GR, avgY, { color: C.slate, width: 1.5, dash: [4, 8], alpha: gapAlpha * avgIn * 0.8 });
      text('平均 ' + meanGap.toFixed(1), GL + 8, avgY - 12, { size: 26, color: C.slate, alpha: gapAlpha * avgIn * 0.9 });
    }
    const uselessIn = easeOutQuint(seg(t, 38.1, 39.0));
    if (uselessIn > 0) {
      text('平均之外，全是起伏', 132, 862, { size: 40, color: C.inkDim, alpha: gapAlpha * uselessIn * 0.9 });
    }
  }

  /* ================================================================
   * 阶段四：局部极不规则（41.2–50.3s）
   * 4a 孪生素数；4b 已知最大间隙 1854（断轴压缩）
   * ================================================================ */
  if (twinAlpha > 0.002) {
    const lineY = 470;
    const N0 = 2;
    const N1 = 34;
    const LX = 480;
    const RX = 1440;
    const toX = (n) => LX + (n - N0) / (N1 - N0) * (RX - LX);

    text('有些素数，贴得极近', 132, 260, { size: 40, color: C.inkDim, alpha: twinAlpha * easeOutQuint(seg(t, 41.4, 42.4)) });
    const lineIn = easeOutQuint(seg(t, 41.4, 42.6));
    hline(LX, LX + (RX - LX) * lineIn, lineY, { color: C.grid, width: 1.5, alpha: twinAlpha });

    for (let n = N0; n <= N1; n += 1) {
      const px = toX(n);
      const appears = easeOutQuint(seg(t, 41.6 + (n - N0) * 0.02, 42.0 + (n - N0) * 0.02));
      if (appears <= 0) continue;
      if (D.sieve[n] === 1) {
        circle(px, lineY, 7, { fill: C.cyan, alpha: twinAlpha * appears });
        text(String(n), px, lineY - 34, { size: 24, align: 'center', color: C.inkDim, alpha: twinAlpha * appears * 0.9 });
      } else {
        circle(px, lineY, 2.5, { fill: C.slate, alpha: twinAlpha * appears * 0.55 });
      }
    }

    // 11–13、17–19 两对括号
    const bracketIn = easeOutQuint(seg(t, 43.8, 44.8));
    if (bracketIn > 0) {
      const pairs = [[11, 13], [17, 19]];
      for (let pi = 0; pi < pairs.length; pi += 1) {
        const a = toX(pairs[pi][0]);
        const b = toX(pairs[pi][1]);
        const y = lineY + 44;
        hline(a, b, y, { color: C.gold, width: 2, alpha: twinAlpha * bracketIn });
        vline(lineY + 14, y, a, { color: C.gold, width: 1.5, alpha: twinAlpha * bracketIn });
        vline(lineY + 14, y, b, { color: C.gold, width: 1.5, alpha: twinAlpha * bracketIn });
        text('差 2', (a + b) / 2, y + 34, { size: 26, align: 'center', color: C.gold, alpha: twinAlpha * bracketIn });
      }
      glow(toX(11), lineY, 60, 'rgba(255,200,87,0.18)', twinAlpha * bracketIn);
      glow(toX(17), lineY, 60, 'rgba(255,200,87,0.18)', twinAlpha * bracketIn);
    }
  }

  if (maxAlpha > 0.002) {
    const y = 560;
    const value = Math.round(1854 * easeOutQuint(seg(t, 46.9, 48.3)));
    text('已知最大素数间隙', 132, 260, { size: 40, color: C.inkDim, alpha: maxAlpha });
    // 断轴：左右两段 + 中间断开，标明横轴非等比
    hline(180, 760, y, { color: C.slate, width: 2, alpha: maxAlpha * 0.85 });
    hline(1160, 1740, y, { color: C.slate, width: 2, alpha: maxAlpha * 0.85 });
    for (const bx of [760, 1160]) {
      for (let k = -1; k <= 1; k += 2) {
        cx.save();
        cx.globalAlpha = maxAlpha * 0.85;
        cx.strokeStyle = C.slate;
        cx.lineWidth = 2.5;
        cx.beginPath();
        cx.moveTo(bx + k * 12 - 10, y - 26);
        cx.lineTo(bx + k * 12 + 10, y + 26);
        cx.stroke();
        cx.restore();
      }
    }
    text('…', 300, y - 20, { size: 40, color: C.slate, alpha: maxAlpha * 0.8 });
    text('…', 1660, y - 20, { size: 40, color: C.slate, alpha: maxAlpha * 0.8 });
    text(String(value), 960, 520, { size: 160, weight: '300', align: 'center', color: C.gold, alpha: maxAlpha });
    text('两个相邻素数之间，可以空出这么远', 960, 640, { size: 40, align: 'center', color: C.inkDim, alpha: maxAlpha * 0.9 });
    text('横轴断裂，非等比；数字为已知最大间隙的素数对', 960, 700, { size: 26, align: 'center', color: C.slate, alpha: maxAlpha * 0.8 });
  }

  /* ================================================================
   * 阶段五：稀疏和聚集同时存在（49.9–53.1s）
   * ================================================================ */
  if (splitAlpha > 0.002) {
    const inA = easeOutQuint(seg(t, 50.0, 50.9));
    text('聚集', 480, 330, { size: 40, align: 'center', color: C.cyan, alpha: splitAlpha * inA });
    text('素数可以两个挨着', 480, 380, { size: 26, align: 'center', color: C.slate, alpha: splitAlpha * inA * 0.9 });
    const clusterX = [140, 175, 240, 268, 300, 380];
    for (let i = 0; i < clusterX.length; i += 1) {
      const p = easeOutQuint(seg(t, 50.1 + i * 0.06, 50.7 + i * 0.06));
      circle(480 + (clusterX[i] - 260), 500, 6, { fill: C.cyan, alpha: splitAlpha * p });
    }
    hline(360, 600, 540, { color: C.grid, width: 1.2, alpha: splitAlpha * inA * 0.8 });

    text('稀疏', 1320, 330, { size: 40, align: 'center', color: C.gold, alpha: splitAlpha * inA });
    text('也可以隔很远', 1320, 380, { size: 26, align: 'center', color: C.slate, alpha: splitAlpha * inA * 0.9 });
    const sparseX = [1080, 1180, 1470];
    for (let i = 0; i < sparseX.length; i += 1) {
      const p = easeOutQuint(seg(t, 50.2 + i * 0.12, 50.8 + i * 0.12));
      circle(sparseX[i], 500, 6, { fill: C.gold, alpha: splitAlpha * p });
    }
    hline(1040, 1600, 540, { color: C.grid, width: 1.2, alpha: splitAlpha * inA * 0.8 });
    text('…', 1290, 512, { size: 26, align: 'center', color: C.slate, alpha: splitAlpha * inA * 0.8 });
  }

  /* ================================================================
   * 阶段六：能不能写一个公式？（52.9–59s）
   * ================================================================ */
  if (formulaAlpha > 0.002) {
    const ask = easeOutQuint(seg(t, 52.9, 53.9));
    text('能不能写一个公式？', 960, 330, { size: 76, weight: '300', align: 'center', alpha: formulaAlpha * ask, letterSpacing: 1 });

    const inChip = easeOutQuint(seg(t, 54.2, 55.2));
    if (inChip > 0) {
      const boxY = 470;
      // 输入 → π(x) → 输出
      cx.save();
      cx.globalAlpha = formulaAlpha * inChip;
      cx.strokeStyle = C.cyanDim;
      cx.lineWidth = 1.5;
      cx.strokeRect(430, boxY, 280, 140);
      cx.strokeRect(810, boxY - 30, 300, 200);
      cx.strokeRect(1210, boxY, 280, 140);
      cx.restore();
      text('输入 x', 570, boxY + 82, { size: 40, align: 'center', color: C.inkDim, alpha: formulaAlpha * inChip });
      text('π(x)', 960, boxY + 85, { size: 76, align: 'center', color: C.cyan, alpha: formulaAlpha * inChip, font: MATH, italic: true });
      text('素数的个数', 1350, boxY - 24, { size: 26, align: 'center', color: C.slate, alpha: formulaAlpha * inChip * 0.9 });
      const arrow1 = easeOutQuint(seg(t, 54.8, 55.4));
      const arrow2 = easeOutQuint(seg(t, 55.0, 55.6));
      hline(716, 716 + 88 * arrow1, boxY + 70, { color: C.cyan, width: 2, alpha: formulaAlpha * arrow1 });
      hline(1116, 1116 + 88 * arrow2, boxY + 70, { color: C.cyan, width: 2, alpha: formulaAlpha * arrow2 });
      text(String(D.piTable[200]), 1350, boxY + 105, { size: 140, align: 'center', color: C.cyan, alpha: formulaAlpha * easeOutQuint(seg(t, 55.4, 56.4)) });
    }

    const noteIn = easeOutQuint(seg(t, 56.2, 57.2));
    if (noteIn > 0) {
      text('x = 200 时，π(200) = 46', 960, 690, { size: 40, align: 'center', color: C.inkDim, alpha: formulaAlpha * noteIn * 0.9 });
    }
  }

  /* ================================================================
   * 阶段七：π(x) 的阶梯 vs x/ln x vs li(x)（58.9–76s）
   * ================================================================ */
  if (graphAlpha > 0.002) {
    const LIMIT = D.LIMIT;
    const GL = 220;
    const GR = 1700;
    const GTOP = 330;
    const GBOT = 850;
    const YMAX = 55;
    const toX = (x) => GL + (x - 2) / (LIMIT - 2) * (GR - GL);
    const toY = (value) => GBOT - (value / YMAX) * (GBOT - GTOP);

    // 坐标轴
    const axisIn = easeOutQuint(seg(t, 59.0, 60.2));
    hline(GL, GL + (GR - GL) * axisIn, GBOT, { color: C.grid, width: 1.5, alpha: graphAlpha });
    vline(GBOT, GBOT - (GBOT - GTOP) * axisIn, GL, { color: C.grid, width: 1.5, alpha: graphAlpha });
    for (let value = 0; value <= YMAX; value += 10) {
      hline(GL, GR, toY(value), { color: C.grid, width: 1, alpha: graphAlpha * axisIn * 0.25 });
      text(String(value), GL - 18, toY(value) + 7, { size: 24, align: 'right', color: C.slate, alpha: graphAlpha * axisIn * 0.8 });
    }
    for (const x of [2, 50, 100, 150, 200]) {
      text(String(x), toX(x), GBOT + 38, { size: 24, align: 'center', color: C.slate, alpha: graphAlpha * axisIn * 0.8 });
    }
    text('x', GR + 70, GBOT + 38, { size: 26, color: C.slate, alpha: graphAlpha * axisIn });
    text('个数', GL - 18, GTOP - 20, { size: 26, align: 'right', color: C.slate, alpha: graphAlpha * axisIn });
    text('π(x)：x 以内有多少个素数', 132, 160, { size: 76, weight: '300', alpha: graphAlpha * easeOutQuint(seg(t, 58.9, 60.0)), letterSpacing: 1 });

    // 真实的 π(x)：阶梯
    const stepIn = easeOutQuint(seg(t, 59.4, 63.2));
    if (stepIn > 0) {
      const points = [];
      for (let x = 2; x < LIMIT; x += 1) {
        points.push([toX(x), toY(D.piTable[x])]);
        points.push([toX(x + 1), toY(D.piTable[x])]);
      }
      points.push([toX(LIMIT), toY(D.piTable[LIMIT])]);
      path(points, { color: C.cyan, width: 2.4, alpha: graphAlpha * 0.95, progress: stepIn });
    }

    // x / ln x：最粗的近似
    const xlnxIn = easeOutQuint(seg(t, 64.3, 66.2));
    if (xlnxIn > 0) {
      const points = [];
      for (let x = 10; x <= LIMIT; x += 1) points.push([toX(x), toY(D.xlnxTable[x])]);
      path(points, { color: C.inkDim, width: 2.2, dash: [10, 8], alpha: graphAlpha * xlnxIn * 0.9, progress: xlnxIn });
      text('x / ln x', toX(LIMIT) + 14, toY(D.xlnxTable[LIMIT]) + 8, { size: 26, color: C.inkDim, alpha: graphAlpha * xlnxIn });
    }

    // li(x)：更准的那个
    const liIn = easeOutQuint(seg(t, 67.2, 69.0));
    if (liIn > 0) {
      const points = [];
      for (let x = 2; x <= LIMIT; x += 1) points.push([toX(x), toY(D.liTable[x])]);
      path(points, { color: C.gold, width: 2.4, alpha: graphAlpha * liIn * 0.95, progress: liIn });
      text('li(x)', toX(LIMIT) + 14, toY(D.liTable[LIMIT]) - 6, { size: 26, color: C.gold, alpha: graphAlpha * liIn });
    }

    // 图例
    const legendIn = easeOutQuint(seg(t, 68.6, 69.6));
    if (legendIn > 0) {
      const legendY = 260;
      const items = [
        { label: 'π(x) 真实阶梯', color: C.cyan },
        { label: 'x / ln x 粗略', color: C.inkDim },
        { label: 'li(x) 更准', color: C.gold },
      ];
      for (let i = 0; i < items.length; i += 1) {
        const lx = 1050 + i * 240;
        hline(lx, lx + 28, legendY, { color: items[i].color, width: 2.5, alpha: graphAlpha * legendIn });
        text(items[i].label, lx + 38, legendY + 8, { size: 26, color: C.slate, alpha: graphAlpha * legendIn });
      }
    }

    // 「差的那一点」：在 x = 199 处量出 li 与 π 的距离
    const diffIn = easeOutQuint(seg(t, 70.2, 71.6));
    if (diffIn > 0) {
      const xEnd = 199;
      const piValue = D.piTable[xEnd];
      const liValue = D.liTable[xEnd];
      const px = toX(xEnd);
      const yPi = toY(piValue);
      const yLi = toY(liValue);
      cx.save();
      cx.globalAlpha = graphAlpha * diffIn;
      cx.strokeStyle = C.gold;
      cx.lineWidth = 2.5;
      cx.beginPath();
      cx.moveTo(px, yPi);
      cx.lineTo(px, yLi);
      cx.stroke();
      cx.beginPath();
      cx.moveTo(px - 7, yPi);
      cx.lineTo(px + 7, yPi);
      cx.moveTo(px - 7, yLi);
      cx.lineTo(px + 7, yLi);
      cx.stroke();
      cx.restore();
      text('li(199) = ' + liValue.toFixed(1), px - 14, 300, { size: 26, align: 'right', color: C.gold, alpha: graphAlpha * diffIn });
      text('π(199) = ' + piValue, px - 14, 338, { size: 26, align: 'right', color: C.cyan, alpha: graphAlpha * diffIn });
      text('差 = ' + (liValue - piValue).toFixed(1), px - 14, 376, { size: 26, align: 'right', color: C.gold, alpha: graphAlpha * diffIn * 0.9 });
    }

    const focusIn = easeOutQuint(seg(t, 73.0, 74.2));
    if (focusIn > 0) {
      // 最后 3 秒：只留金色光晕与量出的差值，文字交给字幕卡
      glow(toX(199), toY(D.liTable[199]), 90, 'rgba(255,200,87,0.20)', graphAlpha * focusIn);
    }
  }

  /* ================================================================
   * 收尾：暗角 → 字幕（字幕必须在最后，不被压暗）
   * ================================================================ */
  vignette(0.5);
  drawCards(t, CARDS);
`

const ATOM_RSA_SHADER = `
  clear(C.bg);
  dotGrid(0.03);

  /* ================================================================
   * 一次性预计算：因子树节点、RSA 数字、代价条形图数据
   * ================================================================ */
  if (!window.__rsaCache) {
    window.__rsaCache = {
      factor360: [2, 2, 2, 3, 3, 5],
      factor84: [2, 2, 3, 7],
      primes: [2, 3, 5, 7, 11, 13, 17, 19],
      rsa: {
        p: '61 位',
        q: '61 位',
        n: '122 位',
        bars: [
          { id: 'RSA-250', digits: 250, cost: 2700, unit: '个处理器年', ratio: 0.34 },
          { id: 'RSA-260', digits: 260, cost: 4900, unit: '张显卡 × 一天', note: '约 40 万美元', ratio: 0.60 },
          { id: 'RSA-2048', digits: 617, cost: null, unit: '至今未被分解', ratio: 1.55 },
        ],
      },
    };
  }
  const D = window.__rsaCache;

  /* ================================================================
   * 全局相位（与 s02 的 16 张字幕卡对齐）
   * ================================================================ */
  const atomIn = easeOutQuint(seg(t, 0.6, 2.2));
  const atomOut = 1 - easeOutQuint(seg(t, 6.8, 8.0));
  const atomAlpha = atomIn * atomOut;

  const treeIn = easeOutQuint(seg(t, 7.3, 8.6));
  const treeOut = 1 - easeOutQuint(seg(t, 17.4, 18.6));
  const treeAlpha = treeIn * treeOut;

  const noteIn = easeOutQuint(seg(t, 18.2, 19.2)) * (1 - easeOutQuint(seg(t, 21.0, 21.9)));
  const urlIn = easeOutQuint(seg(t, 21.9, 23.1)) * (1 - easeOutQuint(seg(t, 25.6, 26.8)));
  const urlZoom = easeInOutCubic(seg(t, 25.8, 28.6));

  const rsaIn = easeOutQuint(seg(t, 28.9, 30.0)) * (1 - easeOutQuint(seg(t, 40.2, 41.2)));
  const rsaAlpha = rsaIn;

  const compareIn = easeOutQuint(seg(t, 40.9, 41.9)) * (1 - easeOutQuint(seg(t, 46.2, 47.2)));
  const compareAlpha = compareIn;

  const barsIn = easeOutQuint(seg(t, 46.9, 48.1));
  const barsAlpha = barsIn;

  const closeIn = easeOutQuint(seg(t, 55.6, 56.8));

  /* ================================================================
   * 阶段一：数的原子（0–8s）
   * ================================================================ */
  if (atomAlpha > 0.002) {
    const atomR = 120;
    const atomX = 960;
    const atomY = 470;
    const pop = easeOutQuint(seg(t, 0.8, 2.4));
    // 整数 360 是一个发光的整体
    glow(atomX, atomY, 220, 'rgba(127,209,255,0.10)', atomAlpha * pop);
    circle(atomX, atomY, atomR * pop, { stroke: C.cyan, width: 2, alpha: atomAlpha * pop });
    text('360', atomX, atomY + 22, { size: 76, align: 'center', color: C.ink, alpha: atomAlpha * pop, font: MATH });
    text('一个整数', atomX, atomY + 92, { size: 28, align: 'center', color: C.slate, alpha: atomAlpha * pop * 0.85 });

    // 拆成素数的「原子」
    const split = easeOutQuint(seg(t, 3.6, 5.2));
    if (split > 0) {
      const positions = [
        [atomX - 380, atomY - 90], [atomX - 260, atomY + 120], [atomX - 140, atomY - 150],
        [atomX + 40, atomY + 150], [atomX + 180, atomY - 140], [atomX + 330, atomY + 60],
      ];
      for (let i = 0; i < D.factor360.length; i += 1) {
        const node = D.factor360[i];
        const tx = positions[i][0];
        const ty = positions[i][1];
        const nx = lerp(atomX, tx, split);
        const ny = lerp(atomY, ty, split);
        circle(nx, ny, 20, { fill: 'rgba(127,209,255,0.10)', alpha: atomAlpha });
        circle(nx, ny, 20, { stroke: C.cyan, width: 1.5, alpha: atomAlpha });
        text(String(node), nx, ny + 8, { size: 28, align: 'center', color: C.cyan, alpha: atomAlpha });
      }
      text('素数是数的原子', 960, 860, { size: 40, align: 'center', color: C.inkDim, alpha: atomAlpha * split * 0.9 });
    }
  }

  /* ================================================================
   * 阶段二：因子树与唯一性（7.3–18.6s）
   * ================================================================ */
  if (treeAlpha > 0.002) {
    // 两条不同的拆法路径，最终落到同一组素数上
    const paths = [
      { label: '2 × 180', nodes: [[500, 330], [380, 470], [620, 470]] },
      { label: '3 × 120', nodes: [[1420, 330], [1300, 470], [1540, 470]] },
    ];
    const build = easeOutQuint(seg(t, 7.4, 8.8));

    text('360 = ?', 960, 300, { size: 76, align: 'center', color: C.ink, alpha: treeAlpha * build, font: MATH });

    // 左路径与右路径
    for (let pi = 0; pi < paths.length; pi += 1) {
      const pathData = paths[pi];
      const appear = easeOutQuint(seg(t, 7.6 + pi * 0.5, 8.8 + pi * 0.5));
      if (appear <= 0) continue;
      const originX = pi === 0 ? 500 : 1420;
      // 从 360 引出的两条拆法线
      cx.save();
      cx.globalAlpha = treeAlpha * appear * 0.8;
      cx.strokeStyle = C.cyanDim;
      cx.lineWidth = 1.5;
      cx.beginPath();
      cx.moveTo(960, 330);
      cx.lineTo(originX, 392);
      cx.stroke();
      cx.restore();
      text(pathData.label, originX, 430, { size: 40, align: 'center', color: C.inkDim, alpha: treeAlpha * appear });
    }

    // 合并成唯一分解式（10.9s 出现，对齐字幕卡）
    const equationIn = easeOutQuint(seg(t, 10.9, 12.0));
    if (equationIn > 0) {
      // 两条路径收拢
      const gather = easeInOutCubic(seg(t, 10.0, 11.4));
      hline(500, lerp(500, 760, gather), 520, { color: C.cyanDim, width: 1.5, alpha: treeAlpha * 0.8 });
      hline(1420, lerp(1420, 1160, gather), 520, { color: C.cyanDim, width: 1.5, alpha: treeAlpha * 0.8 });
      // 六个原子排成一行
      const atoms = D.factor360;
      const startX = 960 - (atoms.length - 1) * 52;
      for (let i = 0; i < atoms.length; i += 1) {
        const ax = startX + i * 104;
        const appear = easeOutQuint(seg(t, 10.9 + i * 0.08, 11.4 + i * 0.08));
        circle(ax, 620, 22, { stroke: C.cyan, width: 1.5, alpha: treeAlpha * appear });
        text(String(atoms[i]), ax, 628, { size: 28, align: 'center', color: C.cyan, alpha: treeAlpha * appear });
      }
      text('360 = 2³ × 3² × 5', 960, 730, { size: 76, align: 'center', color: C.gold, alpha: treeAlpha * equationIn, font: MATH });

      // 对照：84 的分解（同一性质的第二个例子）
      const secondIn = easeOutQuint(seg(t, 14.5, 15.6)) * (1 - easeOutQuint(seg(t, 17.2, 18.2)));
      if (secondIn > 0) {
        text('84 = 2² × 3 × 7', 960, 872, { size: 40, align: 'center', color: C.inkDim, alpha: treeAlpha * secondIn * 0.8 });
      }
    }

    // 「基石」：原子排成一条稳稳的基座
    const baseIn = easeOutQuint(seg(t, 16.2, 17.4));
    if (baseIn > 0) {
      hline(560, 1360, 860, { color: C.cyan, width: 2, alpha: treeAlpha * baseIn * 0.7 });
    }
  }

  /* ================================================================
   * 阶段三：实用 —— 地址栏的小锁（18.2–28.9s）
   * ================================================================ */
  if (noteIn > 0.002) {
    text('而这种执着，其实非常实用', 960, 360, { size: 40, align: 'center', color: C.inkDim, alpha: noteIn });
    hline(760, 1160, 410, { color: C.grid, width: 1.5, alpha: noteIn * 0.8 });
  }

  if (urlIn > 0.002) {
    const barW = 900;
    const barH = 76;
    const barX = 960 - barW / 2;
    const barY = 360;
    cx.save();
    cx.globalAlpha = urlIn;
    cx.strokeStyle = C.cyanDim;
    cx.lineWidth = 1.5;
    cx.beginPath();
    cx.roundRect(barX, barY, barW, barH, 38);
    cx.stroke();
    cx.restore();
    text('https://shop.example', barX + 120, barY + 50, { size: 40, color: C.inkDim, alpha: urlIn * 0.9, font: MONO });

    // 锁：锁体 + 锁梁
    const lockX = barX + 56;
    const lockY = barY + 38;
    const lockScale = lerp(1, 2.6, urlZoom);
    cx.save();
    cx.globalAlpha = urlIn;
    cx.translate(lockX, lockY);
    cx.scale(lockScale, lockScale);
    cx.strokeStyle = C.gold;
    cx.lineWidth = 2.2;
    cx.beginPath();
    cx.arc(0, -10, 12, Math.PI, 0);
    cx.stroke();
    cx.strokeRect(-16, -10, 32, 26);
    cx.restore();

    // 锁背后站着的素数（小原子点）
    const primes = D.primes;
    for (let i = 0; i < primes.length; i += 1) {
      const angle = (i / primes.length) * Math.PI * 2 + t * 0.12;
      const radius = 150 + 30 * Math.sin(t * 0.6 + i);
      const px = lockX + Math.cos(angle) * radius;
      const py = lockY + Math.sin(angle) * radius;
      const appear = easeOutQuint(seg(t, 22.4 + i * 0.08, 23.2 + i * 0.08));
      if (appear <= 0) continue;
      circle(px, py, 14, { stroke: C.cyan, width: 1.5, alpha: urlIn * appear * 0.85 });
      text(String(primes[i]), px, py + 7, { size: 24, align: 'center', color: C.cyan, alpha: urlIn * appear * 0.9 });
    }
  }

  /* ================================================================
   * 阶段四：RSA 的原理（28.9–46.4s）
   * ================================================================ */
  if (rsaAlpha > 0.002) {
    const titleIn = easeOutQuint(seg(t, 29.0, 30.0));
    text('RSA：一把公开的锁', 132, 160, { size: 76, weight: '300', alpha: rsaAlpha * titleIn, letterSpacing: 1 });

    // p、q 两个大素数
    const gather = easeInOutCubic(seg(t, 33.0, 34.6));
    const pStart = [560, 500];
    const qStart = [1360, 500];
    const pX = lerp(pStart[0], 700, gather);
    const qX = lerp(qStart[0], 1220, gather);
    const circleR = 70;
    const pAppear = easeOutQuint(seg(t, 29.4, 30.6));
    const qAppear = easeOutQuint(seg(t, 29.8, 31.0));
    circle(pX, 500, circleR, { stroke: C.cyan, width: 2, alpha: rsaAlpha * pAppear });
    text('p', pX, 488, { size: 48, align: 'center', color: C.cyan, alpha: rsaAlpha * pAppear, font: MATH, italic: true });
    text(D.rsa.p, pX, 600, { size: 26, align: 'center', color: C.slate, alpha: rsaAlpha * pAppear * 0.85 });
    circle(qX, 500, circleR, { stroke: C.gold, width: 2, alpha: rsaAlpha * qAppear });
    text('q', qX, 488, { size: 48, align: 'center', color: C.gold, alpha: rsaAlpha * qAppear, font: MATH, italic: true });
    text(D.rsa.q, qX, 600, { size: 26, align: 'center', color: C.slate, alpha: rsaAlpha * qAppear * 0.85 });
    const bigPrimeIn = easeOutQuint(seg(t, 30.4, 31.4)) * (1 - easeOutQuint(seg(t, 34.6, 35.6)));
    if (bigPrimeIn > 0) {
      text('两个大素数', 960, 300, { size: 40, align: 'center', color: C.inkDim, alpha: rsaAlpha * bigPrimeIn * 0.9 });
    }

    // 相乘 → 公开的 n
    const multiplyIn = easeOutQuint(seg(t, 34.6, 36.0));
    if (multiplyIn > 0) {
      text('×', 960, 528, { size: 76, align: 'center', color: C.inkDim, alpha: rsaAlpha * multiplyIn, font: MATH });
      const boxW = 300 * multiplyIn;
      const boxH = 140 * multiplyIn;
      cx.save();
      cx.globalAlpha = rsaAlpha * multiplyIn;
      cx.strokeStyle = C.cyan;
      cx.lineWidth = 2;
      cx.strokeRect(960 - boxW / 2, 430 - boxH / 2, boxW, boxH);
      cx.restore();
      text('n = p × q', 960, 446, { size: 48, align: 'center', color: C.ink, alpha: rsaAlpha * multiplyIn, font: MATH });
      const publicIn = easeOutQuint(seg(t, 35.8, 36.8));
      if (publicIn > 0) {
        text('公开', 960, 620, { size: 40, align: 'center', color: C.cyan, alpha: rsaAlpha * publicIn });
        text('n 的位数：' + D.rsa.n, 960, 676, { size: 26, align: 'center', color: C.slate, alpha: rsaAlpha * publicIn * 0.85 });
      }
    }

    // 拆回去：难
    const attackIn = easeOutQuint(seg(t, 36.6, 37.8));
    if (attackIn > 0) {
      const cut = easeInOutCubic(seg(t, 37.2, 38.6));
      cx.save();
      cx.globalAlpha = rsaAlpha * attackIn * 0.9;
      cx.strokeStyle = C.slate;
      cx.lineWidth = 2;
      cx.setLineDash([8, 8]);
      cx.beginPath();
      cx.moveTo(960, 430 - 70 * cut);
      cx.lineTo(960, 430 + 70 * cut);
      cx.stroke();
      cx.restore();
      text('拆回 p 和 q？', 960, 730, { size: 40, align: 'center', color: C.gold, alpha: rsaAlpha * attackIn });
      text('?', 960, 350, { size: 76, align: 'center', color: C.slate, alpha: rsaAlpha * attackIn * 0.8, font: MATH });
    }
  }

  /* ================================================================
   * 阶段五：乘法一秒 vs 分解登天（39.9–47.2s）
   * ================================================================ */
  if (compareAlpha > 0.002) {
    const splitX = 960;
    vline(240, 840, splitX, { color: C.grid, width: 1.5, alpha: compareAlpha * 0.8 });

    text('乘法', 480, 260, { size: 40, align: 'center', color: C.cyan, alpha: compareAlpha });
    text('1 秒', 480, 360, { size: 76, align: 'center', color: C.cyan, alpha: compareAlpha * easeOutQuint(seg(t, 40.6, 41.4)) });

    // 乘法：两个小圆瞬间并成一个方框
    const merge = easeOutQuint(seg(t, 40.0, 40.7));
    const aX = lerp(360, 480, merge);
    const bX = lerp(600, 480, merge);
    circle(aX, 500, lerp(40, 24, merge), { stroke: C.cyan, width: 2, alpha: compareAlpha });
    circle(bX, 500, lerp(40, 24, merge), { stroke: C.cyan, width: 2, alpha: compareAlpha });
    if (merge > 0.96) {
      cx.save();
      cx.globalAlpha = compareAlpha * 0.9;
      cx.strokeStyle = C.cyan;
      cx.lineWidth = 2;
      cx.strokeRect(420, 460, 120, 80);
      cx.restore();
      text('n', 480, 512, { size: 40, align: 'center', color: C.cyan, alpha: compareAlpha });
    }

    text('分解', 1440, 260, { size: 40, align: 'center', color: C.gold, alpha: compareAlpha });
    const noAlgoIn = easeOutQuint(seg(t, 42.4, 43.4));
    if (noAlgoIn > 0) {
      text('?', 1440, 440, { size: 160, weight: '300', align: 'center', color: C.gold, alpha: compareAlpha * noAlgoIn, font: MATH });
      text('没有已知的高效算法', 1440, 700, { size: 26, align: 'center', color: C.slate, alpha: compareAlpha * noAlgoIn * 0.9 });
    }

    // 分解进度条：怎么走都走不动
    const barX = 1180;
    const barY = 500;
    const barW = 520;
    const barH = 12;
    hline(barX, barX + barW, barY, { color: C.grid, width: barH, alpha: compareAlpha * 0.9 });
    const crawl = easeOutQuint(seg(t, 40.4, 46.2)) * 0.004;
    hline(barX, barX + barW * Math.max(0.004, crawl), barY, { color: C.gold, width: barH, alpha: compareAlpha });
    text('≈ 0%', 1440, 560, { size: 26, align: 'center', color: C.slate, alpha: compareAlpha * easeOutQuint(seg(t, 41.0, 41.8)) });
    text('…', 1440, 620, { size: 40, align: 'center', color: C.slate, alpha: compareAlpha * easeOutQuint(seg(t, 43.4, 44.2)) });
  }

  /* ================================================================
   * 阶段六：代价对比（对数尺度）与 617 位（46.9–58s）
   * ================================================================ */
  if (barsAlpha > 0.002) {
    const titleIn = easeOutQuint(seg(t, 47.0, 48.0));
    text('破解的代价（对数尺度 · 示意）', 132, 160, { size: 76, weight: '300', alpha: barsAlpha * titleIn, letterSpacing: 1 });

    const axisX = 300;
    const axisY = 830;
    const axisTop = 260;
    vline(axisTop, axisY, axisX, { color: C.grid, width: 1.5, alpha: barsAlpha });
    hline(axisX, 1780, axisY, { color: C.grid, width: 1.5, alpha: barsAlpha });

    const bars = D.rsa.bars;
    for (let index = 0; index < bars.length; index += 1) {
      const bar = bars[index];
      const appear = easeOutQuint(seg(t, 47.3 + index * 3.4, 48.5 + index * 3.4));
      if (appear <= 0) continue;
      const barH = 34;
      const y = 250 + index * 220;
      const maxLen = 1440;
      const len = bar.ratio * maxLen * appear;
      const colour = index === 0 ? C.cyan : index === 1 ? C.inkDim : C.gold;

      cx.save();
      cx.globalAlpha = barsAlpha * appear;
      if (index === 2) {
        // 2048：条形冲出画面右缘，用半透明 + 虚线表示「量级未知/未被分解」
        cx.fillStyle = 'rgba(255,200,87,0.12)';
        cx.fillRect(axisX, y, len, barH);
        cx.strokeStyle = C.gold;
        cx.lineWidth = 1.5;
        cx.setLineDash([9, 7]);
        cx.strokeRect(axisX, y, len, barH);
      } else {
        cx.fillStyle = index === 1 ? 'rgba(159,176,204,0.55)' : C.cyan;
        cx.fillRect(axisX, y, Math.min(len, 1780 - axisX), barH);
      }
      cx.restore();

      text(bar.id, axisX, y - 18, { size: 40, color: colour, alpha: barsAlpha * appear });
      text(String(bar.digits) + ' 位十进制', axisX + 220, y - 18, { size: 26, color: C.slate, alpha: barsAlpha * appear * 0.9 });

      // 数值标签放在条形下方，避免压住条形
      if (bar.cost === null) {
        text('?', 1720, y + 74, { size: 140, weight: '300', align: 'right', color: C.gold, alpha: barsAlpha * easeOutQuint(seg(t, 54.4, 55.4)) });
        text(bar.unit, axisX + 220, y + 118, { size: 40, color: C.gold, alpha: barsAlpha * easeOutQuint(seg(t, 54.8, 55.8)) });
      } else {
        text(String(bar.cost), axisX + 220, y + 112, { size: 76, color: colour, alpha: barsAlpha * appear });
        text(bar.unit, axisX + 220 + measure(String(bar.cost), 76) + 20, y + 112, { size: 40, color: C.slate, alpha: barsAlpha * appear * 0.9 });
        if (bar.note) {
          text(bar.note, axisX + 220, y + 140, { size: 26, color: C.slate, alpha: barsAlpha * appear * 0.85 });
        }
      }
    }

    // 收束：素数原子重新浮现，呼应开头的「数的原子」
    if (closeIn > 0.002) {
      cx.save();
      cx.globalAlpha = closeIn * 0.72;
      cx.fillStyle = C.bg;
      cx.fillRect(0, 0, W, H);
      cx.restore();
      const centreX = 960;
      const centreY = 430;
      circle(centreX, centreY, 92, { stroke: C.cyan, width: 1.5, alpha: closeIn * 0.5 });
      for (let i = 0; i < 6; i += 1) {
        const angle = -Math.PI / 2 + (i * Math.PI) / 3 + t * 0.04;
        const radius = 210;
        const px = centreX + Math.cos(angle) * radius;
        const py = centreY + Math.sin(angle) * radius;
        const appear = easeOutQuint(seg(t, 55.8 + i * 0.06, 56.6 + i * 0.06));
        cx.save();
        cx.globalAlpha = closeIn * appear * 0.22;
        cx.strokeStyle = C.cyan;
        cx.lineWidth = 1;
        cx.beginPath();
        cx.moveTo(centreX + Math.cos(angle) * 92, centreY + Math.sin(angle) * 92);
        cx.lineTo(px, py);
        cx.stroke();
        cx.restore();
        circle(px, py, 5, { fill: C.cyan, alpha: closeIn * appear * 0.85 });
        text(String(D.primes[i]), px, py - 16, {
          size: 24, align: 'center', color: C.cyan, alpha: closeIn * appear * 0.7,
        });
      }
      circle(centreX, centreY, 8, { fill: C.cyan, alpha: closeIn * 0.9 });
      text('数的原子', 960, 680, { size: 40, align: 'center', color: C.inkDim, alpha: closeIn * 0.9 });
    }
  }

  /* ================================================================
   * 收尾：暗角 → 字幕（字幕必须在最后，不被压暗）
   * ================================================================ */
  vignette(0.5);
  drawCards(t, CARDS);
`

export const CLIPS = {
  sieve: {
    seconds: 76,
    code: SIEVE_SHADER,
  },
  'atom-rsa': {
    seconds: 58,
    code: ATOM_RSA_SHADER,
  },
}

export default CLIPS
