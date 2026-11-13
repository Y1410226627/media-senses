/**
 * Reports for the vision-specific tools (`media_frames`, `media_compare`).
 *
 * Kept separate from `render.js` / `render-v2.js` so the blind/vision dual-target
 * work there stays independent; these two tools only exist because a model can
 * look at pictures.
 */
import { formatTimecode } from './ffmpeg.js'
import { num, pct, tidy } from './render.js'

const VERDICT_ZH = { match: '一致', close: '接近', partly: '部分一致', diverge: '偏差大', unknown: '无数据' }

function verdictCell(verdict) {
  return VERDICT_ZH[verdict] ?? String(verdict ?? '—')
}

/**
 * Multi-frame strip report.
 *
 * @param {object} payload
 * @param {string} payload.file
 * @param {Array<{index:number,time:number,timecode:string}>} payload.cells
 * @param {number} [payload.width]
 * @param {number} [payload.height]
 * @param {number} [payload.tokenEstimate]
 * @param {string} [payload.target]
 * @param {Array<object>} [payload.imagePlan]
 * @param {Array<{index:number,time:number,timecode:string}>} [payload.cells]
 */
export function renderFramesReport(payload) {
  const cells = Array.isArray(payload.cells) ? payload.cells : []
  const vision = payload.target === 'vision'
  const lines = []
  lines.push(`# 多帧画面 · ${String(payload.file ?? '').split(/[\\/]/u).pop()}`)
  lines.push('')
  lines.push(`时间点: ${cells.map((cell) => cell.timecode).join(' · ') || '—'}`)
  if (Number.isFinite(Number(payload.width))) lines.push(`拼图: ${cells.length} 帧 · ${payload.width}×${payload.height}${Number.isFinite(Number(payload.tokenEstimate)) ? ` · 约 ${payload.tokenEstimate} token` : ''}`)
  lines.push('')
  if (cells.length > 0) {
    lines.push('## 帧序（左上→右下）')
    lines.push('| # | 时间码 |')
    lines.push('|---|--------|')
    cells.forEach((cell, index) => lines.push(`| ${index + 1} | ${cell.timecode ?? formatTimecode(cell.time ?? 0)} |`))
    lines.push('')
  }
  if (vision) {
    lines.push('## 用眼睛回答')
    lines.push('- 逐帧描述画面内容，并指出相邻两帧之间**具体**变了什么（主体/构图/文字/颜色）。')
    lines.push('- 如果这是同一段视频的连续采样，判断节奏：是缓慢推进还是跳变？')
    lines.push('- 某个细节看不清时，用 `media_frame` 指定 `time` 与 `region` 取局部放大。')
    lines.push('- 引用画面时用帧号或时间码，不要复述上面的表。')
  } else {
    lines.push('> 需要看具体画面时，用 `media_frame` 指定 time 取单帧（会给出亮度字符图与配色）。')
  }
  return tidy(lines.join('\n'))
}

/**
 * Reference-vs-replica comparison report.
 *
 * @param {object} payload
 * @param {string} payload.reference
 * @param {string} payload.produced
 * @param {{rows: Array<object>, summary: object, verdict: string}} payload.diff
 * @param {{path?: string, width?: number, height?: number, mode?: string}} [payload.compareImage]
 * @param {string} [payload.target]
 */
export function renderCompareReport(payload) {
  const diff = payload.diff ?? {}
  const rows = Array.isArray(diff.rows) ? diff.rows : []
  const vision = payload.target === 'vision'
  const lines = []
  lines.push('# 参考 vs 成片 · 对比')
  lines.push('')
  lines.push(`参考: \`${payload.reference ?? '—'}\``)
  lines.push(`成片: \`${payload.produced ?? '—'}\``)
  if (payload.compareImage?.path !== undefined) {
    lines.push(`对比图: ${payload.compareImage.width ?? '?'}×${payload.compareImage.height ?? '?'}（${payload.compareImage.mode === 'side' ? '左右' : '上下'}：参考在前）${Number.isFinite(Number(payload.compareImage.tokenEstimate)) ? ` · 约 ${payload.compareImage.tokenEstimate} token` : ''}`)
  }
  lines.push('')
  lines.push(`## 总体判定：${verdictCell(diff.verdict)}`)
  const summary = diff.summary ?? {}
  lines.push(`一致 ${summary.match ?? 0} 项 · 接近 ${summary.close ?? 0} 项 · 偏差 ${summary.diverge ?? 0} 项${(summary.unknown ?? 0) > 0 ? ` · 无数据 ${summary.unknown} 项` : ''}`)
  lines.push('')
  if (rows.length > 0) {
    lines.push('| 指标 | 参考 | 成片 | 差异 | 判定 |')
    lines.push('|------|------|------|------|------|')
    for (const row of rows) {
      lines.push(`| ${row.metric ?? '—'} | ${formatValue(row.ref)} | ${formatValue(row.built)} | ${formatValue(row.delta)} | ${verdictCell(row.verdict)} |`)
    }
    lines.push('')
  }
  if (vision) {
    lines.push('## 用眼睛判断')
    lines.push('- 先比构图与主体：两边的取景、景别、主体位置是否接近？')
    lines.push('- 再比调色与光线：冷暖、对比、饱和度差在哪？')
    lines.push('- 最后比"感觉"：如果只能改一处让成片更像参考，你会改什么？给出可执行的一句话。')
    lines.push('- 数值表只作参考，最终判断以上面的对比图为准。')
  } else {
    lines.push('## 下一步')
    lines.push('- 想看图时用 `media_frame` 分别取两边的关键帧；想改分镜就用 `media_build_video` 重渲。')
  }
  return tidy(lines.join('\n'))
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—'
    return Math.abs(value) >= 100 ? String(Math.round(value)) : String(Math.round(value * 100) / 100)
  }
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.join('、')
  return String(value)
}

export { pct }

