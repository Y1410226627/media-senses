/**
 * Run every test suite and report the real totals.
 *
 * Written as a script rather than a shell loop because the suites print their
 * summaries in three different shapes ("N passed, M failed", "N passed / M
 * failed", "capability: N passed") and a shell regex quietly skipped one.
 */
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const dir = 'test'
const files = (await readdir(dir)).filter((name) => name.endsWith('.test.mjs')).sort()

let totalPassed = 0
let totalFailed = 0
const rows = []

for (const name of files) {
  const output = await new Promise((resolve) => {
    execFile(process.execPath, [join(dir, name)], { maxBuffer: 64 * 1024 * 1024, timeout: 1_800_000 }, (_error, stdout, stderr) => {
      resolve(`${stdout}\n${stderr}`)
    })
  })
  const lines = output.split(/\r?\n/u)
  // Take the last line that reads "<n> passed" in any of the suite flavours.
  let passed = null
  let failed = null
  for (const line of lines) {
    const match = /(\d+)\s+passed(?:,\s*(\d+)\s+failed|\s*\/\s*(\d+)\s+failed)?/u.exec(line)
    if (match !== null) {
      passed = Number(match[1])
      failed = Number(match[2] ?? match[3] ?? 0)
    }
  }
  if (passed === null) {
    rows.push({ name, passed: '?', failed: '?', note: 'no summary line' })
    continue
  }
  totalPassed += passed
  totalFailed += failed
  rows.push({ name, passed, failed })
}

const width = Math.max(...rows.map((row) => row.name.length))
for (const row of rows) {
  const note = row.note === undefined ? '' : `  <-- ${row.note}`
  console.log(`${row.name.padEnd(width)}  ${String(row.passed).padStart(3)} passed  ${String(row.failed).padStart(2)} failed${note}`)
}
console.log('')
console.log(`suites: ${rows.length}   assertions: ${totalPassed} passed, ${totalFailed} failed`)
if (totalFailed > 0) process.exitCode = 1
