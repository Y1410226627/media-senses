/**
 * Local speech synthesis for the media-senses plugin.
 *
 * Windows ships a decent offline TTS stack, and this plugin must stay
 * dependency-free, so speech is produced through PowerShell + System.Speech
 * (`SpeechSynthesizer`). That gives us `Microsoft Huihui Desktop` (zh-CN) and
 * `Microsoft Zira Desktop` (en-US) on a stock Chinese Windows install.
 *
 * Why PowerShell scripts + JSON config files instead of `-Command` strings:
 * the narration text and the output path routinely contain Chinese characters,
 * and round-tripping those through command-line quoting is where this kind of
 * code usually breaks. Instead:
 *
 *   - the `.ps1` script is pure ASCII and takes a UTF-8 JSON config path
 *   - the narration text lives in its own UTF-8 file, read with
 *     `[System.IO.File]::ReadAllText(path, UTF8)` so no BOM/codepage guessing
 *   - the script prints one compact JSON line that JS parses
 *
 * Output is always 16 kHz / 16-bit / mono WAV (the format System.Speech's
 * `SpeechAudioFormatInfo` advertises and ffmpeg reads without resampling), and
 * the returned duration is measured with ffprobe rather than estimated.
 *
 * `synthesizeSpeech` never throws on synthesis failures: callers (notably
 * `buildVideo`) degrade to "no narration" and collect a warning. Truly
 * programmer-level errors (missing output path, empty text) also come back as
 * `ok: false`.
 */
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { probe, run, tailLines } from './ffmpeg.js'

const isWindows = process.platform === 'win32'

/** Sample format requested from SAPI. Public contract: 16 kHz mono 16-bit. */
const SAMPLE_RATE = 16_000
const BITS = 16
const CHANNELS = 1

/**
 * PowerShell helper. ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1
 * without a BOM using the ANSI codepage, so non-ASCII source would corrupt).
 *
 * Modes:
 *   list  -> prints {ok, voices:[{name,culture,gender}]}
 *   synth -> reads the JSON config, speaks `textPath` into `outputPath`
 */
const PS_SCRIPT = [
  'param([string]$Mode, [string]$ConfigPath)',
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Speech',
  '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'function Emit($obj) { $obj | ConvertTo-Json -Compress -Depth 6 }',
  'if ($Mode -eq "list") {',
  '  $voices = @()',
  '  foreach ($v in $synth.GetInstalledVoices()) {',
  '    if (-not $v.Enabled) { continue }',
  '    $vi = $v.VoiceInfo',
  '    $voices += [pscustomobject]@{ name = [string]$vi.Name; culture = [string]$vi.Culture.Name; gender = [string]$vi.Gender.ToString() }',
  '  }',
  '  $synth.Dispose()',
  '  Emit ([pscustomobject]@{ ok = $true; voices = @($voices) })',
  '  exit 0',
  '}',
  '$json = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8)',
  '$cfg = $json | ConvertFrom-Json',
  '$voiceName = "$($cfg.voiceName)"',
  '$textPath = "$($cfg.textPath)"',
  '$outputPath = "$($cfg.outputPath)"',
  'if ($voiceName -ne "") {',
  '  try { $synth.SelectVoice($voiceName) } catch { }',
  '}',
  'if ($cfg.rate -ne $null) { $synth.Rate = [int]$cfg.rate }',
  'if ($cfg.volume -ne $null) { $synth.Volume = [int]$cfg.volume }',
  '$text = [System.IO.File]::ReadAllText($textPath, [System.Text.Encoding]::UTF8)',
  '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(' + SAMPLE_RATE + ', [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
  '$synth.SetOutputToWaveFile($outputPath, $fmt)',
  '$synth.Speak($text)',
  '$synth.SetOutputToNull()',
  '$actual = $synth.Voice.Name',
  '$synth.Dispose()',
  'Emit ([pscustomobject]@{ ok = $true; voice = $actual })',
].join('\n')

/** Extract the last JSON object/array printed by the helper. */
function parseHelperJson(stdout) {
  const lines = `${stdout}`.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line.startsWith('{') && !line.startsWith('[')) continue
    try {
      return JSON.parse(line)
    } catch {
      // Some PowerShell builds prepend a warning to the JSON line; keep looking.
    }
  }
  return null
}

/** Normalise a run() failure into a short human-readable reason. */
function reasonOf(result) {
  const tail = tailLines(result.stderr, 6)
  return tail.length > 0 ? tail : `exit code ${result.code}`
}

/** Locate a usable PowerShell executable. */
function powershellCandidates() {
  const candidates = []
  if (isWindows) {
    const root = process.env.SystemRoot ?? process.env.WINDIR
    if (typeof root === 'string' && root.length > 0) {
      candidates.push(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    }
    candidates.push('powershell.exe')
  }
  candidates.push('pwsh', 'pwsh.exe', 'powershell')
  return [...new Set(candidates)]
}

/** Cached installed-voice list (PowerShell startup costs ~2 s per call). */
let voicesPromise = null
/** Cached resolved PowerShell executable. */
let shellPromise = null

/** Run the helper script once and return { shell, result } or throw. */
async function invokeHelper(mode, { workDir, signal, config, tag }) {
  const shell = await resolveShell()
  const scriptPath = join(workDir, `${tag}.ps1`)
  await writeFile(scriptPath, PS_SCRIPT, 'utf8')
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Mode', mode]
  if (config !== undefined) {
    const configPath = join(workDir, `${tag}.json`)
    await writeFile(configPath, JSON.stringify(config), 'utf8')
    args.push('-ConfigPath', configPath)
  }
  const result = await run(shell, args, { cwd: workDir, signal, timeoutMs: 180_000 })
  return { shell, result }
}

/** Resolve the first PowerShell variant that actually starts. */
async function resolveShell() {
  if (shellPromise !== null) return shellPromise
  shellPromise = (async () => {
    let lastError = null
    for (const candidate of powershellCandidates()) {
      try {
        const result = await run(candidate, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
          timeoutMs: 30_000,
        })
        if (result.code === 0) return candidate
        lastError = new Error(`${candidate} exited with code ${result.code}`)
      } catch (error) {
        lastError = error
      }
    }
    shellPromise = null
    throw new Error(`no PowerShell executable found for speech synthesis${lastError ? `: ${lastError.message}` : ''}`)
  })()
  return shellPromise
}

/**
 * List the SAPI voices installed on this machine.
 *
 * @param {{tools?: object}} [options] accepted for API symmetry (unused)
 * @returns {Promise<Array<{name: string, culture: string, gender: string}>>}
 */
export async function listVoices(options = {}) {
  void options
  if (!isWindows) return []
  try {
    if (voicesPromise === null) {
      voicesPromise = (async () => {
        const workDir = join(tmpdir(), 'media-senses-tts')
        await mkdir(workDir, { recursive: true })
        const tag = `voices-${process.pid}-${Date.now().toString(36)}`
        try {
          const { result } = await invokeHelper('list', { workDir, tag })
          if (result.code !== 0) return []
          const parsed = parseHelperJson(result.stdout)
          const raw = parsed?.voices
          const list = Array.isArray(raw) ? raw : raw !== null && raw !== undefined ? [raw] : []
          return list
            .filter((voice) => typeof voice?.name === 'string' && voice.name.length > 0)
            .map((voice) => ({
              name: voice.name,
              culture: typeof voice.culture === 'string' ? voice.culture : 'unknown',
              gender: typeof voice.gender === 'string' ? voice.gender : 'unknown',
            }))
        } finally {
          await rm(join(workDir, `${tag}.ps1`), { force: true }).catch(() => {})
        }
      })()
      voicesPromise.catch(() => {
        voicesPromise = null
      })
    }
    return await voicesPromise
  } catch {
    voicesPromise = null
    return []
  }
}

/**
 * Pick the concrete SAPI voice name for a language alias or explicit name.
 *
 * @returns {{name: string|null, warnings: string[]}}
 */
function resolveVoiceName(voices, requested) {
  const warnings = []
  const value = typeof requested === 'string' && requested.trim().length > 0 ? requested.trim() : 'zh'
  const lower = value.toLowerCase()
  const exact = voices.find((voice) => voice.name.toLowerCase() === lower)
  if (exact !== undefined) return { name: exact.name, warnings }
  const partial = voices.find((voice) => voice.name.toLowerCase().includes(lower))
  if (partial !== undefined) return { name: partial.name, warnings }

  const language = lower.startsWith('en') ? 'en' : lower.startsWith('zh') ? 'zh' : null
  if (language === null) {
    warnings.push(`unknown voice alias "${value}"; using the system default voice`)
    return { name: null, warnings }
  }
  const preferred = voices.find((voice) => voice.culture.toLowerCase().startsWith(language))
  if (preferred !== undefined) return { name: preferred.name, warnings }
  const other = voices.find((voice) => voice.culture.toLowerCase().startsWith(language === 'zh' ? 'en' : 'zh'))
  if (other !== undefined) {
    warnings.push(`no ${language === 'zh' ? 'zh-CN' : 'en-US'} voice installed; fell back to ${other.name} (${other.culture})`)
    return { name: other.name, warnings }
  }
  if (voices.length > 0) {
    warnings.push(`no ${language === 'zh' ? 'zh-CN' : 'en-US'} voice installed; using ${voices[0].name} (${voices[0].culture})`)
    return { name: voices[0].name, warnings }
  }
  warnings.push('no SAPI voices are installed; asking System.Speech for its default voice')
  return { name: null, warnings }
}

/** Clamp a finite number into [min, max], falling back to `fallback`. */
function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Synthesize one piece of text to a 16 kHz mono WAV file.
 *
 * @param {{
 *   tools?: {ffmpeg: string, ffprobe: string},
 *   text: string,
 *   outputPath: string,
 *   voice?: string,
 *   rate?: number,
 *   volume?: number,
 *   workDir?: string,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{ok: boolean, path: string|null, seconds: number, voice: string|null, warnings: string[]}>}
 */
export async function synthesizeSpeech(options = {}) {
  const warnings = []
  const text = typeof options.text === 'string' ? options.text.trim() : ''
  const outputPath = typeof options.outputPath === 'string' && options.outputPath.trim().length > 0
    ? resolve(options.outputPath.trim())
    : null
  const report = (ok, seconds, voice) => ({ ok, path: outputPath, seconds, voice, warnings })

  if (!isWindows) {
    warnings.push('speech synthesis requires Windows SAPI; this platform is unsupported')
    return report(false, 0, null)
  }
  if (text.length === 0) {
    warnings.push('speech synthesis skipped: text is empty')
    return report(false, 0, null)
  }
  if (outputPath === null) {
    warnings.push('speech synthesis skipped: outputPath is required')
    return report(false, 0, null)
  }

  const rate = clampNumber(options.rate, 0.1, 3, 1)
  const volume = clampNumber(options.volume, 0, 1, 1)
  // SAPI rate is an integer -10..10 where 0 is the natural pace.
  const sapiRate = Math.max(-10, Math.min(10, Math.round((rate - 1) * 10)))
  const sapiVolume = Math.max(0, Math.min(100, Math.round(volume * 100)))

  let voices = []
  try {
    voices = await listVoices()
  } catch {
    voices = []
  }
  const resolved = resolveVoiceName(voices, options.voice)
  warnings.push(...resolved.warnings)

  let workDir = typeof options.workDir === 'string' && options.workDir.trim().length > 0
    ? resolve(options.workDir)
    : dirname(outputPath)
  try {
    await mkdir(workDir, { recursive: true })
  } catch {
    workDir = join(tmpdir(), 'media-senses-tts')
    await mkdir(workDir, { recursive: true })
  }
  const tag = `tts-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`
  const textPath = join(workDir, `${tag}.txt`)
  const scriptPath = join(workDir, `${tag}.ps1`)
  const configPath = join(workDir, `${tag}.json`)

  try {
    await mkdir(dirname(outputPath), { recursive: true })
    await rm(outputPath, { force: true }).catch(() => {})
    await writeFile(textPath, text, 'utf8')
    const config = {
      textPath,
      outputPath,
      voiceName: resolved.name ?? '',
      rate: sapiRate,
      volume: sapiVolume,
    }
    const { result } = await invokeHelper('synth', { workDir, signal: options.signal, config, tag })
    if (result.code !== 0) {
      warnings.push(`System.Speech synthesis failed: ${reasonOf(result)}`)
      return report(false, 0, resolved.name)
    }
    const parsed = parseHelperJson(result.stdout)
    const actualVoice = typeof parsed?.voice === 'string' && parsed.voice.length > 0 ? parsed.voice : resolved.name

    let bytes = 0
    try {
      bytes = (await stat(outputPath)).size
    } catch {
      bytes = 0
    }
    if (bytes <= 44) {
      warnings.push('System.Speech produced no audio samples')
      return report(false, 0, actualVoice)
    }

    let seconds = 0
    const tools = options.tools
    if (tools !== undefined && typeof tools.ffprobe === 'string') {
      try {
        const probed = await probe(tools, outputPath, { signal: options.signal })
        seconds = Number.parseFloat(probed?.format?.duration ?? '0') || 0
      } catch (error) {
        warnings.push(`cannot probe synthesized wav: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!(seconds > 0) && options.signal?.aborted !== true) {
      warnings.push('synthesized wav has no measurable duration')
      return report(false, 0, actualVoice)
    }
    return report(true, round2(seconds), actualVoice)
  } catch (error) {
    warnings.push(`speech synthesis failed: ${error instanceof Error ? error.message : String(error)}`)
    return report(false, 0, resolved.name)
  } finally {
    await rm(textPath, { force: true }).catch(() => {})
    await rm(scriptPath, { force: true }).catch(() => {})
    await rm(configPath, { force: true }).catch(() => {})
  }
}

/** Round to 2 decimals (contract: seconds rounded to 0.01). */
function round2(value) {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}

export default { listVoices, synthesizeSpeech }
