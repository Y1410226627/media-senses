# media-senses — engine contract

This file is the interface contract between the plugin shell (Lead-owned) and the
two analysis engines (teammate-owned). Read `lib/ffmpeg.js` and `lib/png.js` first;
they are finished and tested infrastructure.

## Hard constraints

- ESM only, **zero runtime dependencies** (no npm install). Node >= 20 APIs only.
- Every file is plain `.js`/`.mjs`. Run `node --check <file>` before reporting done.
- No writes outside your owned files. Do not touch `index.js`, `lib/ffmpeg.js`,
  `lib/png.js`, `package.json`, `cordis.patch.yml`, `locale/`, `icon.svg`.
- Analysis must be **deterministic** and **JSON-serializable** (plain objects,
  numbers rounded to sensible precision, no `NaN`/`Infinity`/`undefined`).
  Round: seconds 0.01, Hz 1, ratios 3, percentages 1.
- Everything must degrade: a missing audio stream, a 5 s clip, a silent file, or a
  corrupt probe must return a report with `warnings: [...]` instead of throwing
  (throw only when the input file itself is unusable).
- Progress-free, synchronous-ish work is fine; throw on abort via the passed signal.
- All user-facing strings in the returned data stay **English keys**; the Lead
  renders Chinese prose in `lib/render.js`. You may include English prose fields
  (e.g. `timbre.description`) — the renderer will use them.

## ffmpeg location

`resolveTools()` in `lib/ffmpeg.js` finds ffmpeg/ffprobe automatically. In this
machine it resolves to
`C:\Users\湮貉\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\`
(ffmpeg 9.0.2 full build, has `whisper`, `signalstats`, `scdet`, `showspectrumpic`,
`ebur128`, `aspectralstats`, `astats`, `freezedetect`, `blackdetect`).

**Windows filtergraph rule (already proven):** never put a `C:/...` absolute path
inside a filter option (`-vf`, `-af`, `-filter_complex`). Run ffmpeg with
`cwd = workDir` (via the `cwd` option of `run`) and use relative file names inside
the graph. Absolute paths are fine for `-i` / `-map` / ordinary args.
`drawtext` font file must be `C\:/Windows/Fonts/arial.ttf` (escaped) or you can
copy/omit the font — plain `tile` without drawtext is an acceptable fallback.

Validated telemetry recipe (video), for reference:

```js
const frames = await readFrameMetadata(tools, file, {
  filter: 'scale=160:-2,signalstats,scdet=t=10',
  workDir,
})
// -> [{ frame, pts, ptsTime, meta: { 'lavfi.signalstats.YAVG': '69.36', 'lavfi.scd.mafd': '0.98', ... } }]
```

## Shared types

```ts
type Warning = string

interface AudioAnalysis {
  kind: 'audio'
  duration: number                  // container duration, seconds
  analyzed: { start: number, seconds: number, sampleRate: number }
  format: { codec: string, container: string, bitRate: number, channels: number, sampleRate: number }
  loudness: {
    peakDbfs: number                // true-ish peak (sample peak)
    rmsDbfs: number
    lufsIntegrated: number | null   // EBU R128 integrated (null when unavailable)
    loudnessRangeLu: number | null  // LRA
    dynamicRangeDb: number          // p95 - p10 of short-term loudness
    clippingRatio: number           // share of samples at/near full scale
    silenceRatio: number            // share of 1s windows below -50 dBFS
  }
  tempo: {
    bpm: number | null              // tempo octave-folded into [60, 190]
    bpmCandidates: number[]         // up to 3 raw autocorrelation peaks, descending
    confidence: number              // 0..1
    beatCount: number
    beatTimes: number[]             // first ≤ 64 beats, seconds
    timeSignatureGuess: number      // 3 or 4 (heuristic)
    regularity: number              // 0..1 beat interval consistency
  }
  key: {
    tonic: string                   // 'C', 'C#', ... 'B'
    mode: 'major' | 'minor'
    name: string                    // e.g. 'C major' / 'A minor'
    confidence: number              // 0..1 (margin over runner-up)
    candidates: Array<{ name: string, score: number }>   // top 3
    tuned: number                   // estimated tuning offset in cents
  } | null
  chroma: { mean: number[], labels: string[] }           // 12 values 0..1, labels C..B
  timbre: {
    centroidHz: number
    rolloffHz: number
    flatness: number
    zeroCrossRate: number
    brightness: 'dark' | 'warm' | 'neutral' | 'bright'
    description: string             // one short English clause
  }
  spectrum: { lowRatio: number, midRatio: number, highRatio: number }   // <200Hz, 200-2000Hz, >2000Hz energy share
  rhythm: { onsetRate: number, onsetsPerSecond: number, percussionDensity: 'sparse'|'moderate'|'dense' }
  sections: Array<{
    start: number, end: number, duration: number
    label: string                   // 'intro' | 'verse' | 'chorus' | 'break' | 'outro' | 'section N'
    energy: number                  // 0..1 relative
    bpm: number | null
    note: string                    // short English description
  }>
  chords: { progression: Array<{ start: number, end: number, name: string, confidence: number }>, uniqueNames: string[], rate: number } | null
  energyCurve: Array<{ t: number, rms: number, low: number, high: number }>   // ≤ 240 points
  vocals: { present: boolean, confidence: number, note: string }
  mood: { arousal: number, valence: number, labels: string[], note: string }  // both 0..1
  transcript: { text: string, audioSeconds: number } | null
  artifacts: { waveform?: string, spectrogram?: string, chromaChart?: string, energyChart?: string }
  warnings: Warning[]
}

interface VideoAnalysis {
  kind: 'video'
  duration: number
  stream: { codec: string, width: number, height: number, fps: number, bitRate: number, rotation: number, pixelFormat: string }
  format: { container: string, bitRate: number, sizeBytes: number }
  global: {
    shotCount: number
    cutRate: number                 // cuts per minute
    avgBrightness: number           // 0..1  (YAVG/255)
    brightnessVariety: number       // stddev of per-second brightness, 0..1 scale
    avgSaturation: number           // 0..1
    colorfulness: number            // 0..100 Hasler-Süsstrunk-ish
    dominantHues: Array<{ name: string, share: number, hex: string }>   // top 3, share 0..1
    avgMotion: number               // 0..100 mean mafd
    peakMotion: number
    aspectRatio: string             // '16:9'
  }
  shots: Array<{
    index: number
    start: number, end: number, duration: number
    brightness: number              // 0..1
    saturation: number              // 0..1
    hueName: string                 // 'red' | 'orange' | ...
    hueHex: string                  // '#aabbcc'
    motion: number                  // 0..100
    palette: Array<{ hex: string, share: number }>    // up to 4
    keyframe?: string               // absolute path of a saved JPEG for this shot
    ascii?: string                  // ~44x20 luminance art of this shot's keyframe
    hueMap?: string                 // ~44x20 hue-letter art (R O Y G C B M/P for grey)
    layout?: string                 // 'top-dark / bottom-bright' style one-liner
  }>
  timeline: Array<{ t: number, brightness: number, saturation: number, motion: number }>  // ≤ 300 points, 1/s
  audio: AudioAnalysis | null       // reused engine result for the soundtrack, null when absent
  transcript: { text: string, audioSeconds: number } | null
  flags: {
    frozen: Array<{ start: number, end: number }>
    black: Array<{ start: number, end: number }>
    silent: Array<{ start: number, end: number }>
    likelyTextHeavy: boolean         // high edge density + low motion → slides/screens
    likelyTalkingHead: boolean       // low motion + speech present
  }
  artifacts: { contactSheet?: string, keyframesDir?: string, waveform?: string, spectrogram?: string }
  warnings: Warning[]
}
```

## Module 1 — `lib/audio.js` + `lib/dsp.js` (owner: audio-engine)

```js
export async function analyzeAudio({ tools, file, workDir, options = {}, signal })
  // tools: { ffmpeg, ffprobe } from resolveTools()
  // file: absolute path
  // workDir: absolute scratch dir (exists, writable)
  // options: {
  //   start?: number, duration?: number, maxSeconds?: number = 900,
  //   wantArtifacts?: boolean = true, wantChords?: boolean = true,
  //   wantStructure?: boolean = true, sampleRate?: number = 22050,
  //   asr?: boolean = false, language?: string = 'auto', whisperModelPath?: string|null,
  // }
  // returns AudioAnalysis
```

Required technique (proven numbers from the research pass):

1. Decode: `ffmpeg -v error -i <file> -ss <start> -t <dur> -vn -ac 1 -ar 22050 -f f32le pcm.f32`
   with `cwd=workDir` (use a relative output name), then read the file into a
   `Float32Array`. Guard total size; cap with `maxSeconds`.
2. STFT: Hann window, `n_fft=2048`, `hop=512` for chroma/tonal work; a cheaper
   `n_fft=1024, hop=512` pass for the onset envelope is fine. FFT in `lib/dsp.js`
   (radix-2, iterative, in-place; ~60 lines).
3. Onset envelope = half-wave rectified log-mel spectral flux (40 mel bands).
   Tempo = autocorrelation of the onset envelope over 40..200 BPM with a
   log-normal prior around 120 BPM; octave-fold to [60, 190]; confidence from
   peak prominence. Beat times by peak-picking the envelope with a dynamic
   programme (or a simpler minimum-interval picker — document the choice).
4. Chroma: map FFT bins to MIDI pitch (f = 440·2^((m−69)/12)) with tuning estimate
   (max over ±50 cents of chroma sharpness), fold to 12 pitch classes,
   L2-normalise, median-filter 3 frames.
5. Key: Pearson correlation of the mean chroma against 12 rotations × {major,
   minor} of **Krumhansl-Kessler** `[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,
   2.39,3.66,2.29,2.88]` / `[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,
   3.34,3.17]`; also compute Temperley CBMS and report the KK result with the
   runner-up margin as confidence. Optional: majority vote over 30 s windows.
6. Structure: beat-synchronous chroma (or 1 s frames) → cosine self-similarity
   matrix → Foote checkerboard novelty → peak pick with ≥ 8 s spacing; label
   segments by relative RMS/onset density into intro/verse/chorus/break/outro.
7. Chords: 24 triad templates (12 major, 12 minor) cosine-matched per beat,
   Viterbi-smoothed; collapse repeated chords into a progression.
8. Loudness: decode a 1-channel 22050 stream, compute sample peak/RMS, and run
   `ffmpeg -nostats -i <file> -af ebur128=peak=true -f null -` and parse the
   `I:` (integrated) / `LRA:` / `Peak:` summary lines from stderr; when parsing
   fails fall back to `astats`-derived numbers and set the LUFS fields to null.
9. Artifacts (when `wantArtifacts`): `showspectrumpic=s=1000x320:legend=0`,
   `showwavespic=s=1000x220:split_channels=0:colors=#5ec8ff`, plus JS charts from
   `lib/png.js` (`chromaChart` heat map, `energyChart` line chart).
10. Vocals: heuristic only (band energy 300–3400 Hz prominence + 4–8 Hz modulation
    energy + harmonic-to-percussive ratio). Say "heuristic" in `note`.
11. Mood: arousal from z-scored BPM/RMS/onset-rate, valence from mode + centroid +
    flatness; English `labels` like `['energetic','bright','happy']`.
12. `asr`: optional, only when `options.asr === true` and a whisper model path is
    given. Transcode to 16 kHz mono WAV in `workDir` (relative name), then
    `-af whisper=model=<relative model>:language=<lang>:use_gpu=0:format=text:destination=<relative>.txt`
    with `model`/`destination` **relative to workDir** (copy the model into
    workDir if needed). Return `{ text, audioSeconds }`. Never fail the analysis
    when ASR is unavailable — add a warning instead.

`lib/dsp.js` must export reusable pure functions (fft, hann, melFilterbank,
chromaFromSpectrum, autocorrelation, noveltyCurve, …) with no I/O so the Lead can
unit-test them. Include a `selfTest()` helper in `test/audio-engine.test.mjs`.

Ground-truth fixture (`test/make-audio-fixture.mjs`, you own it): synthesize a
WAV/MP3 in pure Node (write PCM, then `ffmpeg -i out.wav out.mp3`) that is
**120 BPM, key C major**, 4/4, 24 s: kick on beats 1/3, snare on 2/4, hats on
8ths, a bass line on C/G/A/F roots, and a melody with C-E-G notes. Assert:
bpm within ±3 of 120, key tonic C with mode major, ≥ 3 sections, beatCount ≥ 30,
loudness fields finite, chroma peaks at C/E/G. Also test a silent file, a 1 s
clip, and a file with no audio stream (use a video with `-an`) → warnings, no throw.

## Module 2 — `lib/video.js` (owner: video-engine)

```js
export async function analyzeVideo({ tools, file, workDir, options = {}, signal, analyzeAudio })
  // options: {
  //   maxSeconds?: number = 1800, start?: number,
  //   sceneThreshold?: number = 0.3, maxKeyframes?: number = 40,
  //   analysisHeight?: number = 160, densityFloorSeconds?: number = 25,
  //   wantContactSheet?: boolean = true, wantFrames?: boolean = true,
  //   wantAudio?: boolean = true, asr?: boolean = false, language?: string,
  //   whisperModelPath?: string|null, artifactDir: string,
  // }
  // analyzeAudio: the imported analyzeAudio from './audio.js' (injected so the
  //               Lead controls the cycle); call it with its own workDir.
  // returns VideoAnalysis
```

Required technique:

1. `probe()` + `summariseProbe()` from `lib/ffmpeg.js` for stream facts.
2. **Telemetry pass** (one ffmpeg run, fast): downscale to height 160, apply
   `signalstats,scdet=t=10`, `metadata=print:file=<relative>`, parse with
   `readFrameMetadata`. From `lavfi.signalstats.YAVG|SATAVG|HUEMED|YDIF|YMIN|YMAX`
   and `lavfi.scd.mafd|score` build per-frame brightness/saturation/hue/motion.
3. **Cut pass**: `-vf "select='gt(scene,<T>)',metadata=print:file=<relative>"` gives
   `lavfi.scene_score` + `pts_time`. Merge hits within 0.5 s. Always add a density
   floor (a cut every `densityFloorSeconds`) so static slides get frames too, then
   dedupe by comparing downscaled grayscale of neighbours when cheap.
4. **Per-shot keyframe**: extract one JPEG per shot (`-ss t -frames:v 1 -q:v 4`,
   scaled so the longest side is ≤ 640) into `artifactDir/keyframes/`. Also decode
   that frame at ~44×20 as rawvideo (`-vf scale=44:20,format=rgb24 -f rawvideo -`)
   to render `ascii` (luminance ramp ` .:-=+*#%@`) and `hueMap` (R O Y G C B M/P),
   plus a 4-colour palette and a `layout` one-liner (e.g. `top brighter than
   bottom`, `left-right symmetric`, `high contrast centre`). Keep `ascii` ≤ 20 rows.
5. **Contact sheet**: one ffmpeg run, select the same keyframe times, scale to a
   grid, `tile=4x3:padding=4:margin=4`, one PNG. Try `drawtext` with the escaped
   arial path to burn `pts\hms`; if it fails, retry without drawtext and record the
   cell→time mapping in `warnings`-free data (`contactSheet` + `shots[].start`).
   Grid must cover ≤ 12 cells per sheet; if more keyframes, tile into sheets
   `sheet-1.png`, `sheet-2.png` and return them as a comma list in `contactSheet`.
6. **Health flags**: add `freezedetect=n=0.001:d=2` and
   `blackdetect=d=2:pic_th=0.98:pix_th=0.10` as a second metadata run (they emit
   `lavfi.freezedetect.freeze_start|freeze_duration|freeze_end` and
   `lavfi.blackdetect.*`), or run them in the same chain if the metadata keys do
   not collide. Silence flags come from `silencedetect=n=-50dB:d=2` on audio.
7. `likelyTextHeavy`: high mean edge density proxy — use `lavfi.signalstats.YDIF`
   low + `SATAVG` low + `YMAX-YMIN` high is too weak; a cheap Sobel proxy is
   acceptable: one extra pass with `-vf "scale=160:-2,sobel,signalstats"` and mean
   YAVG over all frames; document the heuristic. `likelyTalkingHead`:
   `avgMotion < 3` and transcript present.
8. Audio: when the file has an audio stream and `wantAudio`, call the injected
   `analyzeAudio({ tools, file, workDir: audioWorkDir, options: { asr, language,
   whisperModelPath, wantArtifacts: true } })` in a fresh sub-directory of
   `workDir`, and surface its `artifacts` under `artifacts.waveform/spectrogram`.
   Surface `transcript` from it. If the audio stream is absent, `audio: null`.
9. Timeline downsample to ≤ 300 points (1/s) for the model.

Ground-truth fixture (`test/make-video-fixture.mjs`, you own it): build
`test/fixtures/scenes.mp4` with ffmpeg: 3 visually distinct scenes of 4 s each
(dark red flat + white centred text, bright blue flat + yellow text, `testsrc2`
motion) at 640×360/25 fps, plus a 440 Hz sine soundtrack. Use a single
`filter_complex` with `concat` or three temp clips + concat demuxer (either is
fine). Assert: `shots.length === 3` (±1 merged/split tolerance), total duration
≈ 12 s, scene 1 brightness < scene 2 brightness, `audio !== null`,
`global.shotCount >= 2`, contact sheet PNG exists with non-trivial size,
`ascii` strings present for every shot. Also test: a 1 s single-colour clip
(no crash), a video without audio (`audio === null`), and a `-an` file.

## Testing

Each owner ships a runnable script, executed with the workspace `node`:

```
node test/audio-engine.test.mjs
node test/video-engine.test.mjs
```

Both must print `PASS`/`FAIL` per assertion and exit non-zero on failure. Use
`assert` from `node:assert/strict`, `mkdtemp` for scratch dirs, and clean up.
Report: files created, test output summary, and any contract deviations.
