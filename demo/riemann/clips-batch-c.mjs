/**
 * 批次 C 镜头：s09 `two-tracks`（2026 年 11 月，全片情绪最高点）+ s10 `spirit-closing`（我们必须知道）。
 *
 * 每个镜头是 `{ seconds, code }`，code 是 window.renderAt(t) 的函数体，由
 * demo/riemann/kit.mjs 的 buildHtml() 内联；可用 KIT 的 C / text / hline / circle /
 * path / glow / countUp / group / dotGrid / vignette / drawCards 等工具。
 *
 * 硬性约定（与 kit.mjs / 其它批次一致）：
 *  - 完全确定性：只依赖 t 与常量表，不读时钟、不用 Math.random，缓动只用
 *    easeOutQuint / easeInOutCubic（闪烁只用定频 sin，不引入随机）；
 *  - 每帧最后 vignette(0.5) → drawCards(t, CARDS)，字幕不被压暗；
 *  - 字号分档：76（栏目标题）/ 40–48（台词与人物）/ 24–28（注释）/ 120–160（关键数字与字标）；
 *  - 数据用 C.cyan，关键结论用 C.gold；留白大，每 8–12 秒换一次构图。
 *
 * 字幕卡时间由 beats.mjs 的 scheduleCards() 等权排布；本文件的视觉节拍严格对齐这些卡：
 *  s09 31 张卡 ≈ 每 3.10s 一张；s10 27 张卡 ≈ 每 2.89s 一张。
 */

/* ================================================================== *
 * S09 · 两条轨道（96s）
 * 0–8 日期牌 → 8–34 左右双轨（AI 轻/人力重）→ 34–52 收敛到 ζ
 * → 52–76 证据台阶 → 76–88 940 vs 6 周 → 88–96 一个呼吸光点
 * ================================================================== */
const TWO_TRACKS_SHADER = String.raw`
  clear(C.bg);
  dotGrid(t > 50 && t < 78 ? 0.02 : 0.03);

  const midX = W / 2;
  const floorY = 846;

  /* ================================================================
   * 0–8s：日期牌 2026.11.20 落定，背景极暗
   * ================================================================ */
  const dateIn = easeOutQuint(seg(t, 0.5, 2.5));
  const dateOut = easeInOutCubic(seg(t, 7.0, 8.4));
  const dateA = dateIn * (1 - dateOut);
  if (dateA > 0.001) {
    const drop = (1 - dateIn) * 26;
    glow(midX, 540, 640, 'rgba(127,209,255,0.05)', dateA);
    // 极淡的牌子：细边 + 左上角金色刻度
    cx.save();
    cx.globalAlpha = dateA * 0.16;
    cx.strokeStyle = C.cyan;
    cx.lineWidth = 1.5;
    cx.strokeRect(midX - 430, 540 - 150 + drop, 860, 300);
    cx.restore();
    text('九 · 二零二六年十一月', midX, 300, {
      size: 28, align: 'center', color: C.slate, letterSpacing: 8, alpha: dateA * 0.95,
    });
    text('2026.11.20', midX, 560 + drop, {
      size: 160, weight: '200', align: 'center', color: C.ink, letterSpacing: 12, alpha: dateA,
    });
    const rule = easeOutQuint(seg(t, 1.8, 3.2));
    hline(midX - 360 * rule, midX + 360 * rule, 616 + drop, {
      color: C.gold, width: 2, alpha: dateA * rule * 0.7,
    });
    const placeA = easeOutQuint(seg(t, 2.6, 3.9));
    text('BERKELEY · 当地时间', midX, 686 + drop, {
      size: 26, align: 'center', color: C.inkDim, letterSpacing: 7, alpha: dateA * placeA * 0.8,
    });
  }

  /* ================================================================
   * 8–34s：左右双轨同时起跑。左轻快细，右厚重粗。
   * ================================================================ */
  const trackIn = easeOutQuint(seg(t, 7.8, 10.2));
  const trackOut = 1 - easeInOutCubic(seg(t, 33.0, 35.2));
  const trackA = trackIn * trackOut;
  if (trackA > 0.001) {
    const lx = 500, rx = 1420;

    // ---- 左轨：AI 协作。细线、轻点、快爬升。 ----
    text('AI 协作', lx, 430, { size: 40, weight: '300', align: 'center', color: C.ink, alpha: trackA * 0.9, letterSpacing: 4 });
    const aiCount = Number(countUp(6, t, 11.6, 5.4));
    text(String(Math.round(aiCount)), lx - 26, 590, {
      size: 120, weight: '200', align: 'center', color: C.cyan, alpha: trackA * 0.95,
    });
    text('周', lx + 62, 590, { size: 40, weight: '300', align: 'left', color: C.cyan, alpha: trackA * 0.8 });
    const aiSub = easeOutQuint(seg(t, 12.2, 14.0));
    text('Claude 协助 · 找到证明思路', lx, 660, {
      size: 24, align: 'center', color: C.inkDim, alpha: trackA * aiSub * 0.75, letterSpacing: 2,
    });
    // 快速爬升的折线（数据线）
    const rise = easeOutQuint(seg(t, 8.6, 16.4));
    const pts = [[lx - 220, 818], [lx - 150, 806], [lx - 80, 784], [lx - 10, 762], [lx + 60, 736], [lx + 130, 714], [lx + 200, 696]];
    path(pts, { progress: rise, color: C.cyan, width: 1.5, alpha: trackA * 0.85 });
    for (let i = 0; i < pts.length; i += 1) {
      const at = easeOutQuint(seg(t, 8.6 + i * 0.55, 9.3 + i * 0.55));
      circle(pts[i][0], pts[i][1], i === pts.length - 1 ? 4 : 2.2, { fill: C.cyan, alpha: trackA * at * 0.8 });
    }
    // 左轨的完成拍：约 18.5s 打卡「已成形」，给 8–34s 长段一次中段升级
    const doneA = easeOutQuint(seg(t, 18.4, 19.8)) * trackA;
    if (doneA > 0.001) {
      hline(lx + 208, lx + 208 + 74 * easeOutQuint(seg(t, 18.4, 19.2)), 706, {
        color: C.gold, width: 1.5, alpha: doneA * 0.55,
      });
      text('已成形', lx + 286, 714, {
        size: 24, align: 'left', color: C.gold, alpha: doneA * 0.75, letterSpacing: 2,
      });
    }
    // 轻基线
    hline(lx - 250, lx + 250, floorY, { color: C.cyan, width: 1.5, alpha: trackA * 0.22 });

    // ---- 右轨：纯人力。厚页堆、粗基线、缓慢累积。 ----
    text('纯人力', rx, 430, { size: 40, weight: '500', align: 'center', color: C.ink, alpha: trackA * 0.92, letterSpacing: 4 });
    const pageCount = Number(countUp(940, t, 9.0, 22.0));
    text(group(pageCount), rx - 10, 590, {
      size: 140, weight: '300', align: 'center', color: C.gold, alpha: trackA * 0.95, letterSpacing: 2,
    });
    text('页', rx + 120, 590, { size: 40, weight: '300', align: 'left', color: C.gold, alpha: trackA * 0.8 });
    const huSub = easeOutQuint(seg(t, 10.0, 12.2));
    text('12 年 · 一个人 · 没有 AI', rx, 660, {
      size: 24, align: 'center', color: C.inkDim, alpha: trackA * huSub * 0.78, letterSpacing: 2,
    });
    // 940 落定的一记金色脉冲（约 31s），把「厚重」推到段落顶点
    const landPulse = Math.sin(Math.PI * seg(t, 30.6, 32.4));
    if (landPulse > 0.01) {
      glow(rx - 10, 556, 300, 'rgba(255,200,87,0.14)', landPulse * trackA);
    }
    // 手稿堆叠：每层一块厚页，越叠越高（重、慢、实）
    const stackP = easeInOutCubic(seg(t, 8.8, 31.8));
    const layers = Math.floor(stackP * 13);
    for (let i = 0; i < layers; i += 1) {
      const ly = 812 - i * 10;
      cx.save();
      cx.globalAlpha = trackA * (i % 2 === 0 ? 0.16 : 0.10);
      cx.fillStyle = i % 2 === 0 ? 'rgba(255,200,87,0.9)' : 'rgba(244,247,255,0.75)';
      cx.fillRect(rx - 200, ly, 400, 8);
      cx.restore();
    }
    // 粗基线与左侧厚书脊：与左轨形成重量差
    hline(rx - 250, rx + 250, floorY, { color: C.inkDim, width: 8, alpha: trackA * 0.16 });
    const spineIn = easeOutQuint(seg(t, 9.0, 11.0));
    vline(812 - layers * 10, floorY, rx - 206, { color: C.gold, width: 8, alpha: trackA * spineIn * 0.32 });
    // 右侧的「进度」是一个缓慢移动的短标记，速度远低于左轨
    const huMark = easeInOutCubic(seg(t, 9.0, 31.8));
    circle(rx + 250 * huMark - 250, floorY - 4, 3, { fill: C.inkDim, alpha: trackA * 0.5 });
  }

  /* ================================================================
   * 34–52s：两侧收敛到中央的 ζ，中间一行小字「同一个问题」
   * ================================================================ */
  const conv = easeInOutCubic(seg(t, 34.0, 41.0));
  if (conv > 0.001 && t < 53.0) {
    // 两条细轨迹从两侧滑向中心，像两条轨道合流
    const leftX = lerp(500, midX - 90, conv);
    const rightX = lerp(1420, midX + 90, conv);
    const convA = (1 - easeInOutCubic(seg(t, 50.0, 52.2))) * (1 - conv * 0.2);
    hline(300, leftX - 24, 680 - 40 * conv, { color: C.cyan, width: 1.5, alpha: convA * 0.5 });
    hline(rightX + 24, 1620, 680 - 40 * conv, { color: C.inkDim, width: 5, alpha: convA * 0.18 });
    circle(leftX - 30, 680 - 40 * conv, 2.5, { fill: C.cyan, alpha: convA * 0.8 });
    circle(rightX + 30, 680 - 40 * conv, 2.5, { fill: C.gold, alpha: convA * 0.7 });
  }
  const zetaIn = easeOutQuint(seg(t, 35.5, 38.8));
  const zetaOut = 1 - easeInOutCubic(seg(t, 50.0, 52.0));
  const zetaA = zetaIn * zetaOut;
  if (zetaA > 0.001) {
    glow(midX, 552, 300, 'rgba(255,200,87,0.10)', zetaA);
    text('ζ', midX, 590, {
      size: 150, align: 'center', color: C.gold, alpha: zetaA, italic: true, font: MATH, weight: '400',
    });
    // 一个缓慢展开的细环，把 ζ 收成「同一个问题」
    const ringP = easeOutQuint(seg(t, 37.0, 42.0));
    circle(midX, 540, 180 * ringP, { stroke: C.gold, width: 1.2, alpha: zetaA * 0.18 });
    const sameA = easeOutQuint(seg(t, 40.2, 42.8)) * zetaOut;
    text('同一个问题', midX, 672, {
      size: 26, align: 'center', color: C.inkDim, alpha: sameA * 0.85, letterSpacing: 6,
    });
  }

  /* ================================================================
   * 52–76s：证据台阶（整屏只留这一组元素）
   * 宣布 → 预印本 → 形式化 → 同行评审 → 社区接受
   * ================================================================ */
  const stairIn = easeOutQuint(seg(t, 52.6, 55.6));
  const stairOut = 1 - easeInOutCubic(seg(t, 84.5, 87.6));
  const stairA = stairIn * stairOut;
  const stairNames = ['宣布', '预印本', '形式化', '同行评审', '社区接受'];
  const stairStatus = ['已公开', '已公开', '据称已通过', '尚未完成', ''];
  const litTime = [55.2, 58.8, 62.4, 72.8, 999];
  if (stairA > 0.001) {
    for (let i = 0; i < 5; i += 1) {
      const sw = 210, sh = 58;
      const sx = 300 + i * 230;
      const top = 764 - i * 78;
      const lit = i < 3 ? easeOutQuint(seg(t, litTime[i], litTime[i] + 1.5)) : 0;
      // 同行评审：停在半亮（明显低于已点亮级），并在「还没有完成」几句上闪一下
      let half = 0;
      if (i === 3) {
        half = easeOutQuint(seg(t, 72.6, 74.2)) * 0.30;
        if (t > 73.4 && t < 76.6) {
          half += 0.09 * Math.sin((t - 73.4) * Math.PI * 2 * 1.35);
          if (half < 0.14) half = 0.14;
        }
      }
      const level = Math.max(lit, half);
      const blockA = stairA * (0.55 + 0.45 * easeOutQuint(seg(t, 52.6 + i * 0.35, 54.4 + i * 0.35)));
      // 台体
      cx.save();
      cx.globalAlpha = blockA;
      cx.fillStyle = 'rgba(244,247,255,' + (0.03 + level * 0.13).toFixed(3) + ')';
      cx.fillRect(sx, top, sw, sh);
      cx.globalAlpha = blockA * (0.24 + level * 0.62);
      cx.strokeStyle = i === 4 ? C.slate : (i === 3 ? C.inkDim : C.cyan);
      cx.lineWidth = 1.5;
      if (i === 4) cx.setLineDash([6, 6]);
      cx.strokeRect(sx, top, sw, sh);
      cx.restore();
      // 台阶编号 + 名称
      const labelA = blockA * (i === 4 ? 0.28 : 0.92);
      text(String(i + 1), sx + 22, top + 37, {
        size: 24, align: 'left', color: i < 3 ? C.cyan : C.slate, alpha: labelA * 0.8, font: MONO,
      });
      text(stairNames[i], sx + 54, top + 38, {
        size: 40, weight: '300', align: 'left', color: i === 3 ? C.inkDim : C.ink, alpha: labelA,
      });
      // 状态：前两级标「已公开」（弱），形式化标「据称已通过」（金），同行评审标「未完成」，社区接受保持暗
      if (i < 2 && lit > 0.2) {
        text('已公开', sx + sw - 16, top - 16, {
          size: 24, align: 'right', color: C.inkDim, alpha: stairA * 0.34,
        });
      } else if (i === 2 && lit > 0.2) {
        text(stairStatus[i], sx + sw - 16, top - 16, {
          size: 24, align: 'right', color: C.gold, alpha: stairA * easeOutQuint(seg(t, 63.4, 64.3)) * 0.95,
        });
      } else if (i === 3 && half > 0.2) {
        text(stairStatus[i], sx + sw - 16, top - 16, {
          size: 24, align: 'right', color: C.inkDim, alpha: stairA * 0.7,
        });
      } else if (i === 4 && t > 60) {
        text('—', sx + sw - 16, top - 16, { size: 24, align: 'right', color: C.slate, alpha: blockA * 0.5 });
      }
      // 台面高光线只给已点亮的三级
      if (i < 3 && lit > 0.01) {
        hline(sx, sx + sw, top + 1, { color: C.gold, width: 1.5, alpha: blockA * lit * 0.55 });
      }
    }
    // 地面基准线
    hline(250, 1680, 864, { color: C.grid, width: 1, alpha: stairA * 0.6 });
  }

  /* ================================================================
   * 76–88s：台阶右侧的 940 vs 6 周
   * ================================================================ */
  const cmpIn = easeOutQuint(seg(t, 76.6, 79.4));
  const cmpA = cmpIn * stairOut;
  if (cmpA > 0.001) {
    const cxr = 1600;
    const pages = Number(countUp(940, t, 76.8, 2.6));
    text(group(pages), cxr, 480, {
      size: 140, weight: '300', align: 'center', color: C.gold, alpha: cmpA * 0.95, letterSpacing: 2,
    });
    text('页 · 纯人力 · 12 年', cxr, 528, {
      size: 24, align: 'center', color: C.inkDim, alpha: cmpA * 0.8, letterSpacing: 2,
    });
    const weeks = Number(countUp(6, t, 77.4, 1.6));
    text(String(Math.round(weeks)), cxr - 16, 660, {
      size: 120, weight: '200', align: 'center', color: C.cyan, alpha: cmpA * 0.95,
    });
    text('周', cxr + 62, 660, { size: 40, weight: '300', align: 'left', color: C.cyan, alpha: cmpA * 0.8 });
    text('AI 协作', cxr, 706, {
      size: 24, align: 'center', color: C.inkDim, alpha: cmpA * 0.8, letterSpacing: 3,
    });
  }

  /* ================================================================
   * 88–96s：几乎全黑，只剩一个缓慢呼吸的光点
   * ================================================================ */
  const dark = easeInOutCubic(seg(t, 86.0, 89.8));
  if (dark > 0.001) {
    cx.save();
    cx.globalAlpha = dark;
    cx.fillStyle = C.bg;
    cx.fillRect(0, 0, W, H);
    cx.restore();
  }
  const pointA = easeOutQuint(seg(t, 88.6, 91.2));
  if (pointA > 0.001) {
    const breath = 0.6 + 0.22 * Math.sin((t - 88.6) * Math.PI * 2 / 3.6);
    const highlight = easeInOutCubic(seg(t, 92.4, 94.0));
    const r = 2.2 + 0.7 * Math.sin((t - 88.6) * Math.PI * 2 / 3.6) + highlight * 1.2;
    glow(midX, 540, 110, 'rgba(127,209,255,0.16)', pointA * breath * 0.8);
    glow(midX, 540, 46, 'rgba(255,200,87,0.10)', pointA * highlight * 0.6);
    circle(midX, 540, r, { fill: C.ink, alpha: pointA * breath });
  }

  vignette(0.5);
  drawCards(t, CARDS);
`

/* ================================================================== *
 * S10 · 我们必须知道（78s）
 * 0–16 论文页 → 16–30 遗稿细线 → 30–44 火炬接力 → 44–58 六个金字
 * → 58–70 光点连线向画外延伸 → 70–78 全黑只剩极小光点
 * ================================================================== */
const SPIRIT_CLOSING_SHADER = String.raw`
  clear(C.bg);
  dotGrid(0.03);

  const midX = W / 2;
  const names = ['欧拉', '黎曼', '哈达马', '哈代', '塞尔伯格', '康瑞', '2026'];
  const xs = names.map(function (_, i) { return 300 + i * 205 });
  const litTimes = [30.6, 33.0, 35.4, 37.8, 40.2, 42.6, 45.0];

  /* ================================================================
   * 0–16s：1859 年论文页（更暗、更旧），德文原句逐行淡入
   * ================================================================ */
  const pageIn = easeOutQuint(seg(t, 0.6, 2.6));
  const pageOut = easeInOutCubic(seg(t, 15.6, 18.6));
  const pageA = pageIn * (1 - pageOut);
  if (pageA > 0.001) {
    const pw = 720, ph = 960;
    const px = midX - pw / 2, py = 540 - ph / 2;
    glow(midX, 540, 560, 'rgba(255,200,87,0.035)', pageA);
    cx.save();
    cx.globalAlpha = pageA * 0.9;
    cx.fillStyle = 'rgba(255,200,120,0.022)';
    cx.fillRect(px, py, pw, ph);
    cx.strokeStyle = 'rgba(255,200,120,0.16)';
    cx.lineWidth = 1.5;
    cx.strokeRect(px, py, pw, ph);
    cx.strokeStyle = 'rgba(255,200,120,0.07)';
    cx.strokeRect(px + 16, py + 16, pw - 32, ph - 32);
    cx.restore();
    // 纸上的旧排版痕迹（只在页眉留两行，避免压住标题与德文正文）
    cx.save();
    cx.globalAlpha = pageA * 0.10;
    cx.fillStyle = C.inkDim;
    cx.fillRect(px + 90, py + 78, 300, 5);
    cx.fillRect(px + 90, py + 104, 240, 5);
    cx.restore();
    text('1859', midX, 250, {
      size: 76, weight: '200', align: 'center', color: C.ink, letterSpacing: 8, alpha: pageA * 0.9,
    });
    text('BERLIN · 论文结尾', midX, 306, {
      size: 24, align: 'center', color: C.cyan, letterSpacing: 6, alpha: pageA * 0.55,
    });
    // 德文原句逐行淡入（每句两行，与 s10 前四张字幕卡对齐）
    const german = [
      { t0: 4.6, lines: ['Es ist sehr wahrscheinlich,', 'dass alle Wurzeln reell sind.'] },
      { t0: 8.2, lines: ['Hiervon wäre allerdings ein', 'strenger Beweis zu wünschen.'] },
      { t0: 11.2, lines: ['Ich habe nach einigen flüchtigen', 'vergeblichen Versuchen'] },
      { t0: 14.0, lines: ['diesen Gegenstand vorläufig', 'bei Seite gelassen.'] },
    ];
    for (let g = 0; g < german.length; g += 1) {
      const block = german[g];
      const a = easeOutQuint(seg(t, block.t0, block.t0 + 1.2)) * pageA;
      if (a <= 0.001) continue;
      const baseY = 396 + g * 128;
      for (let li = 0; li < block.lines.length; li += 1) {
        text(block.lines[li], midX, baseY + li * 44, {
          size: 40, align: 'center', color: 'rgba(232,226,210,0.88)', alpha: a * 0.9,
          italic: true, font: MATH, letterSpacing: 0.5,
        });
      }
    }
  }

  /* ================================================================
   * 16–30s：纸页淡出，只剩手写体暗示的细线（遗稿纸条）
   * ================================================================ */
  const paperDark = easeInOutCubic(seg(t, 15.4, 18.8));
  if (paperDark > 0.001 && paperDark < 0.999) {
    cx.save();
    cx.globalAlpha = paperDark;
    cx.fillStyle = C.bg;
    cx.fillRect(0, 0, W, H);
    cx.restore();
  }
  const notesIn = easeOutQuint(seg(t, 17.2, 19.4));
  const notesOut = 1 - easeInOutCubic(seg(t, 28.8, 31.6));
  const notesA = notesIn * notesOut;
  if (notesA > 0.001) {
    for (let i = 0; i < 8; i += 1) {
      const appear = easeOutQuint(seg(t, 17.6 + i * 0.85, 18.4 + i * 0.85));
      if (appear <= 0.001) continue;
      const lineY = 350 + i * 46;
      const wide = i === 2 || i === 5 ? 0.62 : 0.92;
      const x0 = 560 + (i % 3) * 10;
      const x1 = x0 + (1360 - 560) * wide;
      const pts = [];
      const n = 26;
      for (let k = 0; k <= n; k += 1) {
        const u = k / n;
        const wob = Math.sin(u * Math.PI * (3 + (i % 3)) + i * 0.7) * 5 + Math.sin(u * 17 + i) * 2.2;
        pts.push([x0 + (x1 - x0) * u, lineY + wob]);
      }
      path(pts, {
        progress: appear, color: i === 3 ? C.gold : 'rgba(232,226,210,0.75)', width: i === 3 ? 2 : 1.4,
        alpha: notesA * (i === 3 ? 0.55 : 0.34),
      });
    }
    const zettelA = easeOutQuint(seg(t, 20.6, 22.4)) * notesA;
    text('遗稿 · Zettel', 560, 328, {
      size: 24, align: 'left', color: C.gold, alpha: zettelA * 0.6, letterSpacing: 4,
    });
    // 关于 ζ 的那一行（字幕卡 10–11：来自一个表达式 / 没能化简）在遗稿里亮起
    const zetaA = easeOutQuint(seg(t, 26.2, 28.2)) * notesOut;
    if (zetaA > 0.001) {
      glow(960, 350 + 3 * 46 - 6, 120, 'rgba(255,200,87,0.10)', zetaA);
      text('ζ', 1370, 350 + 3 * 46 + 12, {
        size: 40, align: 'left', color: C.gold, alpha: zetaA * 0.75, italic: true, font: MATH,
      });
    }
  }

  /* ================================================================
   * 30–44s：火炬接力。7 个光点，一个把光传给下一个（暗淡 → 复燃）
   * ================================================================ */
  const relayIn = easeOutQuint(seg(t, 29.6, 31.4));
  const relayShift = easeInOutCubic(seg(t, 43.2, 46.4)); // 44–58 时整排下移，给金字让位
  const rowY = 620 + relayShift * 180;
  const lineA = relayIn * (1 - easeInOutCubic(seg(t, 68.6, 71.8)));
  if (lineA > 0.001) {
    hline(250, 1670, rowY, { color: C.grid, width: 1, alpha: lineA * 0.7 });
    // 每个点的状态：未点亮是暗灰小点；被点亮后保持金色；传递瞬间给光者短暂暗淡、受光者复燃
    for (let i = 0; i < names.length; i += 1) {
      const isLit = t >= litTimes[i];
      let lit = 0;
      if (i === 0) {
        lit = easeOutQuint(seg(t, litTimes[0], litTimes[0] + 1.2));
      } else if (isLit) {
        const arrive = litTimes[i];
        const dim = 0.22 + 0.78 * easeOutQuint(seg(t, arrive - 0.05, arrive + 0.55));
        lit = relayIn * dim;
      }
      // 给光者：在传递窗内 Alpha 短暂下探再回到稳定值
      let giveDim = 0;
      const next = litTimes[i + 1];
      if (next !== undefined && t > next - 0.45 && t < next + 0.85) {
        giveDim = 0.55 * Math.sin(Math.PI * (t - (next - 0.45)) / 1.3);
      }
      const dotA = Math.max(0, lit * (1 - giveDim)) * lineA;
      const isFinal = i === names.length - 1;
      if (isLit || i === 0) {
        circle(xs[i], rowY, isFinal ? 7 : 6, {
          fill: C.gold, alpha: dotA * (isFinal ? 0.95 : 0.85),
        });
        if (dotA > 0.02) {
          circle(xs[i], rowY, 18, { stroke: C.gold, width: 1.2, alpha: dotA * 0.22 });
          glow(xs[i], rowY, 46, 'rgba(255,200,87,0.16)', dotA * 0.7);
        }
      } else {
        circle(xs[i], rowY, 3, { fill: C.slate, alpha: lineA * 0.5 });
      }
      const nameA = isLit
        ? lineA * (0.38 + 0.52 * easeOutQuint(seg(t, litTimes[i], litTimes[i] + 0.9)))
        : lineA * 0.26;
      text(names[i], xs[i], rowY + 58, {
        size: 28, align: 'center', color: isFinal ? C.ink : C.inkDim, alpha: nameA * 0.85, letterSpacing: 2,
      });
    }
    // 传递中的光珠：在两点之间匀速滑过
    for (let j = 1; j < names.length; j += 1) {
      const passStart = litTimes[j] - 0.45;
      const passEnd = litTimes[j] + 0.15;
      if (t < passStart || t > passEnd) continue;
      const u = easeInOutCubic(seg(t, passStart, passEnd));
      const bx = lerp(xs[j - 1], xs[j], u);
      glow(bx, rowY, 34, 'rgba(255,200,87,0.30)', lineA * 0.9);
      circle(bx, rowY, 3, { fill: C.ink, alpha: lineA * 0.9 });
    }
  }

  /* ================================================================
   * 44–58s：光点上方浮出六个字「我们必须知道 / 我们将会知道」，金色、有重量
   * ================================================================ */
  const wordOut = 1 - easeInOutCubic(seg(t, 57.4, 59.8));
  const word1A = easeOutQuint(seg(t, 44.8, 46.8)) * wordOut;
  if (word1A > 0.001) {
    const rise = (1 - easeOutQuint(seg(t, 44.8, 46.8))) * 26;
    glow(midX, 398, 520, 'rgba(255,200,87,0.08)', word1A);
    text('我们必须知道', midX, 430 + rise, {
      size: 128, weight: '700', align: 'center', color: C.gold, alpha: word1A, letterSpacing: 12,
    });
  }
  const word2A = easeOutQuint(seg(t, 48.8, 50.8)) * wordOut;
  if (word2A > 0.001) {
    const rise = (1 - easeOutQuint(seg(t, 48.8, 50.8))) * 26;
    glow(midX, 552, 520, 'rgba(255,200,87,0.08)', word2A);
    text('我们将会知道', midX, 584 + rise, {
      size: 128, weight: '700', align: 'center', color: C.gold, alpha: word2A, letterSpacing: 12,
    });
  }

  /* ================================================================
   * 58–70s：光点连成一条线，线向右延伸出画面
   * ================================================================ */
  const lineGrow = easeInOutCubic(seg(t, 58.2, 64.0));
  const extend = easeInOutCubic(seg(t, 62.4, 70.0));
  if (lineGrow > 0.001) {
    const inner0 = xs[0];
    const inner1 = lerp(xs[0], xs[names.length - 1], lineGrow);
    hline(inner0, inner1, rowY, { color: C.gold, width: 2, alpha: lineA * 0.7 });
    if (extend > 0) {
      const tip = lerp(xs[names.length - 1], 2360, extend);
      hline(xs[names.length - 1], tip, rowY, { color: C.gold, width: 2, alpha: lineA * 0.55 });
      glow(tip, rowY, 40, 'rgba(255,200,87,0.22)', lineA * 0.8);
      circle(tip, rowY, 2.5, { fill: C.ink, alpha: lineA * 0.8 });
    }
    // 沿线的细小脉冲，暗示还在继续
    const pulse = (t * 0.9) % 1;
    const pulseX = lerp(xs[0], W + 120, pulse);
    if (pulseX > xs[0]) {
      glow(pulseX, rowY, 26, 'rgba(127,209,255,0.16)', lineA * 0.6);
    }
  }

  /* ================================================================
   * 70–78s：全黑，只剩一个极小的光点（继续问下去）
   * ================================================================ */
  const dark = easeInOutCubic(seg(t, 68.6, 71.8));
  if (dark > 0.001) {
    cx.save();
    cx.globalAlpha = dark;
    cx.fillStyle = C.bg;
    cx.fillRect(0, 0, W, H);
    cx.restore();
  }
  const tinyA = easeOutQuint(seg(t, 71.4, 73.6));
  if (tinyA > 0.001) {
    const breath = 0.55 + 0.25 * Math.sin((t - 71.4) * Math.PI * 2 / 4.2);
    glow(midX, 548, 80, 'rgba(255,200,87,0.10)', tinyA * breath * 0.8);
    glow(midX, 548, 30, 'rgba(127,209,255,0.12)', tinyA * breath * 0.5);
    circle(midX, 548, 2, { fill: C.ink, alpha: tinyA * breath });
  }

  vignette(0.5);
  drawCards(t, CARDS);
`

export const CLIPS = {
  'two-tracks': {
    seconds: 96,
    code: TWO_TRACKS_SHADER,
  },
  'spirit-closing': {
    seconds: 78,
    code: SPIRIT_CLOSING_SHADER,
  },
}

export default CLIPS
