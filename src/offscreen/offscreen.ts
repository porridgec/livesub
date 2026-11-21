// Offscreen Document 主入口：持有 tab 音频流 + WebAudio 采集 + VAD + Whisper + 翻译。
// 所有推理在这里串行执行（单队列），避免 WebGPU 显存竞争。
//
// 音频有两条支路（同一个设备原生采样率的 AudioContext）：
//   source → destination                    ← 把被 tabCapture 静音的页面声音放出来
//   source → worklet(48k→16k) → gain(0)     ← 给 Whisper 的 PCM
import { env } from '@huggingface/transformers'
import { DEFAULT_SETTINGS, mergeSettings, type LastLine, type OffscreenState, type Settings, type Stats } from '../shared/types'
import { collapseRepeats } from './text'
import { Vad } from './vad'
import { createSileroVad, type Detector } from './vad-silero'
import { asrDevice, detectLanguage, initAsr, modelReady, transcribe } from './asr'
import { initSenseVoice, svDevice, svReady, transcribeSenseVoice } from './sensevoice'
import { translateText, translationSupported, translatorReady, warmTranslator } from './translate'

// 全部模型本地加载，运行时零外网请求
env.allowLocalModels = true
env.allowRemoteModels = false
env.localModelPath = chrome.runtime.getURL('models/')
const wasmBackend = (env.backends as any)?.onnx?.wasm
if (wasmBackend) {
  wasmBackend.wasmPaths = chrome.runtime.getURL('ort/')
  // manifest 里声明了 COOP/COEP，扩展页是 crossOriginIsolated 的，ort-web 可以用多线程 WASM
  if (typeof SharedArrayBuffer !== 'undefined') {
    wasmBackend.numThreads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))
  }
}

// 回调式广播：popup/SW 不在线不算错误，读 lastError 消掉警告
const send = (msg: unknown) => {
  chrome.runtime.sendMessage(msg, () => {
    void chrome.runtime.lastError
  })
}

// ---------- 状态 ----------
type Engine = 'sensevoice' | 'whisper'
let engine: Engine = 'sensevoice'
let settings: Settings = structuredClone(DEFAULT_SETTINGS)
let state: OffscreenState = 'idle'
let stateDetail = ''
let running = false
let starting = false
let tabId: number | null = null
let segSeq = 0

let mediaStream: MediaStream | null = null
let audioCtx: AudioContext | null = null
let workletNode: AudioWorkletNode | null = null
let analyser: AnalyserNode | null = null
let playbackGain: GainNode | null = null
let detector: Detector | null = null
let vadKind: 'silero' | 'energy' | 'none' = 'none'
// 音频去向由 SW 探测 tab 静音状态后决定：
// native = tab 原生声音已恢复（音画同步）；replay = 必须由扩展回放；muted = 用户自己静音了 tab
type AudioMode = 'pending' | 'native' | 'replay' | 'muted' | 'none'
let audioMode: AudioMode = 'pending'

let queue: { pcm: Float32Array; endedAt: number }[] = []
let draining = false

// 模型就绪前不把音频送进识别（否则会抛「ASR 未初始化」）
let asrReady = false
// 本次采集实际使用的语种：用户指定 or 音频自动检测
let activeLang: string | null = null
let detectTries = 0
// 音频回放是否真的在跑（tabCapture 会把页面静音，这里没跑起来用户就听不到声音）
let playbackOk = false

const stats: Stats = { asr: [], trans: [], total: [], segments: 0 }
let lastLines: LastLine[] = []
let feedRms = 0
let fedSamples = 0

function setState(s: OffscreenState, detail = ''): void {
  state = s
  stateDetail = detail
  send({ target: 'event', type: 'status', state: s, detail, lang: activeLang ?? undefined })
}

async function initEngine(onProgress: (detail: string) => void): Promise<void> {
  if (engine === 'sensevoice') {
    try {
      await initSenseVoice(onProgress)
      return
    } catch (e) {
      // 模型没下载/加载失败时回退 Whisper，保证扩展仍可用
      console.warn('[LiveSub] SenseVoice 加载失败，回退 Whisper：', e instanceof Error ? e.message : e)
      engine = 'whisper'
    }
  }
  const model: 'tiny' | 'base' = settings.asrModel === 'tiny' ? 'tiny' : 'base'
  await initAsr(model, (pct) => onProgress(`加载 Whisper-${model}… ${pct}%`))
}

function engineDeviceLabel(): string {
  return engine === 'sensevoice' ? `sensevoice(${svDevice()})` : asrDevice()
}

function applyGlossary(text: string): string {
  const raw = settings.glossary.trim()
  if (!raw || !text) return text
  let out = text
  for (const line of raw.split('\n')) {
    const item = line.trim()
    const eq = item.indexOf('=')
    if (eq < 0) continue
    const from = item.slice(0, eq).trim()
    const to = item.slice(eq + 1).trim()
    if (!from || from === to) continue
    out = out.split(from).join(to)
  }
  return out
}

function engineReady(): boolean {
  return engine === 'sensevoice' ? svReady() : modelReady()
}

// 注意：offscreen 文档只有 chrome.runtime 可用（chrome.storage 等 API 不可用），
// 设置由 SW 随 start 消息传入、变更时经 'settings' 消息转发
function applySettings(partial: Partial<Settings> | undefined): void {
  const prevLang = settings.sourceLang
  settings = mergeSettings(partial)
  engine = settings.asrModel === 'sensevoice' ? 'sensevoice' : 'whisper'
  detector?.setSensitivity(settings.vadSensitivity)
  if (settings.sourceLang !== 'auto') {
    activeLang = settings.sourceLang
  } else if (prevLang !== 'auto') {
    // 只有从"指定语种"切回"自动"才需要重新检测；改字号等设置不能把语种打回 null
    activeLang = null
    detectTries = 0
    pendingSegs = []
    detectBuf = []
    detectLen = 0
    bestDet = null
  }
}

function resetSession(): void {
  queue = []
  transQueue = []
  stats.asr = []
  stats.trans = []
  stats.total = []
  stats.segments = 0
  lastLines = []
  activeLang = settings.sourceLang === 'auto' ? null : settings.sourceLang
  detectTries = 0
  pendingSegs = []
  detectBuf = []
  detectLen = 0
  bestDet = null
  asrReady = false
  playbackOk = false
  peakRms = 0
  lastPartialAt = 0
  lastPartialCheck = 0
  lastPartialText = ''
  partialGen++
  partialBusy = false
  partialsSent = 0
  partialsZh = 0
  lastWords = 0
}

function segmentHandler(pcm: Float32Array, endedAt: number): void {
  if (!running || !asrReady) return
  queue.push({ pcm, endedAt })
  void drain()
}

/** 优先 Silero VAD；模型/推理不可用时回退能量 VAD */
async function createDetector(): Promise<Detector> {
  const silero = await createSileroVad(settings.vadSensitivity, segmentHandler)
  if (silero) {
    vadKind = 'silero'
    return silero
  }
  vadKind = 'energy'
  return new Vad({ sampleRate: 16000, sensitivity: settings.vadSensitivity, onSegment: segmentHandler })
}

// ---------- 音频管线 ----------
async function start(msg: { streamId: string; tabId: number; settings?: Partial<Settings> }): Promise<void> {
  if (starting) return
  starting = true
  try {
    await teardown()
    tabId = msg.tabId
    running = true
    applySettings(msg.settings)
    resetSession()
    // tabCapture 会把 tab 静音且无法可靠解除，这里固定用扩展回放保证有声音；
    // 音画同步请走元素采集路径（默认优先）。
    audioMode = 'replay'

    // 1) 用 streamId 拿到 tab 音频流
    setState('starting', '连接标签页音频…')
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId },
        } as MediaTrackConstraints,
        video: false,
      })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      console.warn('[LiveSub] offscreen getUserMedia 失败:', m)
      return fail(`获取标签页音频失败：${m}`)
    }
    const audioTrack = mediaStream.getAudioTracks()[0]
    if (!audioTrack) return fail('获取到的音频流没有音轨')
    audioTrack.addEventListener('ended', () => end('音频流已结束（页面刷新或跳转？）'))

    // 2) 用设备原生采样率的 AudioContext：回放要尽量保真，16k 降采样交给 worklet
    setState('starting', '初始化音频管线…')
    try {
      const ctx = new AudioContext()
      audioCtx = ctx
      await Promise.race([
        ctx.resume(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('AudioContext resume 超时')), 3000)),
      ]).catch((e) => console.warn('[LiveSub] AudioContext resume 失败：', String(e)))
      playbackOk = ctx.state === 'running'
      if (!playbackOk) console.warn('[LiveSub] 音频回放上下文未运行，页面可能没声音：state=', ctx.state)

      const source = ctx.createMediaStreamSource(mediaStream)
      // 先静音：等 SW 探测 tab 是否还能原生出声，再决定要不要扩展回放（回放会有 100ms 级延迟）
      playbackGain = ctx.createGain()
      playbackGain.gain.value = 1
      source.connect(playbackGain).connect(ctx.destination)
      analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      source.connect(analyser)

      await ctx.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'))
      workletNode = new AudioWorkletNode(ctx, 'pcm-collector', {
        processorOptions: { targetSampleRate: 16000, frameSize: 1024 },
      })
      workletNode.port.onmessage = (ev) => onPcm(ev.data as Float32Array)
      const sink = ctx.createGain()
      sink.gain.value = 0
      source.connect(workletNode).connect(sink).connect(ctx.destination)
    } catch (e) {
      return fail(`音频管线初始化失败：${e instanceof Error ? e.message : e}`)
    }

    // 3) VAD（优先 Silero）；模型就绪前 onPcm 会丢弃音频
    setState('starting', '加载 VAD…')
    detector = await createDetector()

    // 4) 模型（首次加载较慢，之后常驻缓存）
    setState('loading-model', '加载识别模型…')
    try {
      await initEngine((detail) => setState('loading-model', detail))
    } catch (e) {
      return fail(`模型加载失败：${e instanceof Error ? e.message : e}（是否执行过 npm run fetch-models？）`)
    }
    if (!running) return
    // 翻译模型也放进"加载模型"阶段：否则第一句要等 6s 翻译模型加载；
    // auto 视作主力场景（日语/英语），两条链都预载。
    if (settings.sourceLang !== 'zh') {
      setState('loading-model', '加载翻译模型…')
      await warmTranslator('en').catch((e) => console.warn('[LiveSub] 翻译模型加载失败：', e))
      if (settings.sourceLang === 'auto' || settings.sourceLang === 'ja') {
        await warmTranslator('ja').catch((e) => console.warn('[LiveSub] 翻译模型加载失败：', e))
      }
    }
    if (!running) return
    asrReady = true
    setState('capturing', `engine=${engineDeviceLabel()} audio=${audioMode}`)
  } finally {
    starting = false
  }
}

function setAudioMode(mode: AudioMode): void {
  audioMode = mode
  if (playbackGain) playbackGain.gain.value = mode === 'replay' ? 1 : 0
  send({ target: 'event', type: 'audio-mode', mode })
  // 状态详情补上音频模式，popup 一眼能看到是原生还是回放
  if (state === 'capturing') setState('capturing', `engine=${engineDeviceLabel()} audio=${mode}`)
}

async function teardown(): Promise<void> {
  running = false
  asrReady = false
  audioMode = 'pending'
  playbackGain = null
  if (workletNode) {
    workletNode.port.onmessage = null
    try {
      workletNode.disconnect()
    } catch {}
    workletNode = null
  }
  analyser = null
  if (audioCtx) {
    await audioCtx.close().catch(() => {})
    audioCtx = null
  }
  if (mediaStream) {
    for (const t of mediaStream.getTracks()) t.stop()
    mediaStream = null
  }
  detector = null
  vadKind = 'none'
  queue = []
  transQueue = []
  pendingSegs = []
  detectBuf = []
  detectLen = 0
  bestDet = null
  lastPartialAt = 0
  lastPartialCheck = 0
  lastPartialText = ''
  partialGen++
  partialBusy = false
  partialsSent = 0
  partialsZh = 0
  lastWords = 0
  draining = false
  translating = false
  playbackOk = false
}

async function stop(): Promise<void> {
  await teardown()
  setState('idle')
}

function fail(detail: string): void {
  void teardown().then(() => setState('error', detail))
}

function end(reason: string): void {
  send({ target: 'event', type: 'ended', reason, tabId })
  void teardown().then(() => setState('idle'))
}

// ---------- PCM 处理：电平上报 + VAD ----------
let lastLevelAt = 0
let lastRms = 0
let peakRms = 0
let lastPartialCheck = 0
let lastPartialAt = 0
let lastPartialText = ''
let partialBusy = false
let partialsSent = 0
let partialsZh = 0
let lastWords = 0
// 正式句子一出来就作废还在跑的 partial，避免旧临时字幕盖住正式字幕
let partialGen = 0

function onPcm(chunk: Float32Array): void {
  if (!running) return
  let s = 0
  for (let i = 0; i < chunk.length; i++) s += chunk[i] * chunk[i]
  const rms = Math.sqrt(s / chunk.length)
  lastRms = rms
  if (rms > peakRms) peakRms = rms
  const now = performance.now()
  if (now - lastLevelAt >= 100) {
    lastLevelAt = now
    send({ target: 'event', type: 'level', rms })
  }
  // 模型没就绪前丢弃（VAD 状态从零开始，避免把加载期间的音频拼成超长句）
  if (!asrReady || !detector) return
  detector.push(chunk)
  // VAD 在 offscreen：边说边出临时字幕
  if (engine === 'sensevoice' && now - lastPartialCheck >= 400) {
    lastPartialCheck = now
    void maybePartial(detector.snapshot())
  }
}

async function maybePartial(pcm: Float32Array | null): Promise<void> {
  if (!pcm || !pcm.length || !running || !asrReady || engine !== 'sensevoice' || partialBusy) return
  // 正式句子优先，别让 partial 抢推理
  if (draining || queue.length > 0) return
  const now = performance.now()
  if (now - lastPartialAt < 500) return
  lastPartialAt = now
  partialBusy = true
  const gen = partialGen
  // 只取最近 4.5s 做临时字幕
  const maxPartial = 4.5 * 16000
  const input = pcm.length > maxPartial ? pcm.subarray(pcm.length - maxPartial) : pcm
  try {
    const runLang = settings.sourceLang === 'auto' ? (activeLang ?? 'auto') : settings.sourceLang
    const res = await transcribeSenseVoice(input, runLang)
    if (!running || gen !== partialGen || !res.text) return
    const rawText = applyGlossary(res.text)
    if (rawText === lastPartialText) return
    // 临时字幕也补中文（翻译模型已热时才做，避免拖慢）
    const lineLang = res.lang || activeLang || ''
    let zh = ''
    if (lineLang && translationSupported(lineLang) && translatorReady(lineLang) && !translating && !transQueue.length) {
      try {
        zh = collapseRepeats(await translateText(rawText, lineLang)).trim()
      } catch {
        zh = ''
      }
    }
    if (!running || gen !== partialGen) return
    lastPartialText = rawText
    partialsSent++
    if (zh) partialsZh++
    send({ target: 'event', type: 'asr-partial', text: rawText, zh: zh || undefined, lang: lineLang || undefined })
  } catch {
    // partial 失败不影响正式字幕
  } finally {
    partialBusy = false
  }
}

// ---------- 识别 + 翻译 ----------
// 两条独立串行队列：ASR 串行；翻译可与 ASR 并行，避免翻译模型首次加载把后续字幕识别堵住。
function cap(arr: number[]): void {
  if (arr.length > 100) arr.splice(0, arr.length - 100)
}

// 自动语种检测需要足够长的语音：先攒 2s 再判断，短片段判错会把整场字幕带进沟里
let detectBuf: Float32Array[] = []
let detectLen = 0
let bestDet: { code: string; margin: number } | null = null
let pendingSegs: { pcm: Float32Array; endedAt: number }[] = []
// 元素采集模式下，模型还没加载完时先攒片段（页面声音不受影响，不需要等）

function concatPcm(parts: Float32Array[]): Float32Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Float32Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function lockLanguage(code: string): void {
  activeLang = code
  send({ target: 'event', type: 'detected-lang', lang: code, margin: bestDet?.margin ?? 0 })
  if (translationSupported(code)) void warmTranslator(code).catch(() => {})
}

/** 返回是否已经锁定语种 */
async function resolveLanguage(pcm: Float32Array): Promise<boolean> {
  detectBuf.push(pcm)
  detectLen += pcm.length
  if (detectLen < 16000 * 2) return false
  const all = concatPcm(detectBuf)
  const det = await detectLanguage(all.subarray(0, Math.min(all.length, 16000 * 5)))
  detectTries++
  if (det && (!bestDet || det.margin > bestDet.margin)) bestDet = det
  // 置信度足够高，或已经攒了 4 次仍无结论 → 定下来
  if (det && (det.margin >= 1 || detectTries >= 4)) {
    lockLanguage(det.code)
    return true
  }
  if (detectTries >= 4) {
    lockLanguage(bestDet?.code ?? 'en')
    return true
  }
  return false
}

function emitLine(
  text: string,
  lang: string,
  endedAt: number,
  asrMs: number,
  words?: { text: string; start: number; end: number }[],
): void {
  lastWords = words?.length ?? 0
  partialGen++
  lastPartialText = ''
  const id = `seg-${segSeq++}`
  lastLines.unshift({ id, original: text, lang, asrMs })
  lastLines = lastLines.slice(0, 8)
  send({ target: 'event', type: 'asr-final', id, text, lang, asrMs, words })
  send({ target: 'event', type: 'stats', stats: snapshotStats() })
  // 原文已上屏，译文丢进独立队列异步补齐
  if (lang !== 'zh' && translationSupported(lang)) {
    transQueue.push({ id, text, lang, endedAt })
    void drainTranslations()
  }
}

async function processSegment(item: { pcm: Float32Array; endedAt: number }): Promise<void> {
  if (!running || !activeLang) return
  const lang = activeLang
  const t0 = performance.now()
  const { text } = await transcribe(item.pcm, lang)
  const asrMs = performance.now() - t0
  if (!running) return
  stats.asr.push(asrMs)
  cap(stats.asr)
  stats.segments++
  if (!text) return
  emitLine(applyGlossary(text), lang, item.endedAt, asrMs)
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (queue.length && running) {
      const item = queue.shift()!

      // SenseVoice：非自回归 CTC，一次前向出文本，并且可以自己做语种判定
      if (engine === 'sensevoice') {
        const t0 = performance.now()
        // auto 模式首句让模型自检语种；检测到后固定用该语种（英语会因此启用 ITN 标点）
        const runLang = settings.sourceLang === 'auto' ? (activeLang ?? 'auto') : settings.sourceLang
        const res = await transcribeSenseVoice(item.pcm, runLang)
        const asrMs = performance.now() - t0
        if (!running) break
        stats.asr.push(asrMs)
        cap(stats.asr)
        stats.segments++
        if (!res.text) continue
        const lang = res.lang || (settings.sourceLang !== 'auto' ? settings.sourceLang : 'ja')
        if (settings.sourceLang === 'auto' && activeLang !== lang) {
          activeLang = lang
          send({ target: 'event', type: 'detected-lang', lang })
          if (translationSupported(lang)) void warmTranslator(lang).catch(() => {})
        }
        emitLine(applyGlossary(res.text), lang, item.endedAt, asrMs, res.words)
        continue
      }

      if (!activeLang) {
        pendingSegs.push(item)
        const locked = await resolveLanguage(item.pcm)
        if (!locked && pendingSegs.length < 6 && detectLen < 16000 * 12) continue
        if (!locked) lockLanguage(bestDet?.code ?? 'en')
        const batch = pendingSegs
        pendingSegs = []
        detectBuf = []
        detectLen = 0
        for (const p of batch) await processSegment(p)
        continue
      }

      await processSegment(item)
    }
  } catch (e) {
    console.error('[LiveSub] 推理失败：', e)
    setState('error', `推理失败：${e instanceof Error ? e.message : e}`)
  } finally {
    draining = false
    // 出错后队列可能还有积压，恢复后再试一次
    if (queue.length && running && state !== 'error') void drain()
  }
}

let transQueue: { id: string; text: string; lang: string; endedAt: number }[] = []
let translating = false

async function drainTranslations(): Promise<void> {
  if (translating) return
  translating = true
  try {
    while (transQueue.length && running) {
      const { id, text, lang, endedAt } = transQueue.shift()!
      const t1 = performance.now()
      let zh = ''
      try {
        zh = await translateText(text, lang)
      } catch (e) {
        console.warn('[LiveSub] 翻译失败：', e)
      }
      if (!zh || !running) continue
      zh = collapseRepeats(zh).trim()
      if (zh.length > 240) zh = zh.slice(0, 240) + '…'
      if (!zh) continue
      const transMs = performance.now() - t1
      stats.trans.push(transMs)
      cap(stats.trans)
      stats.total.push(performance.now() - endedAt)
      cap(stats.total)
      const line = lastLines.find((l) => l.id === id)
      if (line) line.translated = zh
      send({ target: 'event', type: 'translation', id, text: zh, transMs })
      send({ target: 'event', type: 'stats', stats: snapshotStats() })
    }
  } finally {
    translating = false
    // 翻译期间可能又来了新句子
    if (transQueue.length && running) void drainTranslations()
  }
}

function snapshotStats(): Stats {
  return {
    asr: [...stats.asr],
    trans: [...stats.trans],
    total: [...stats.total],
    segments: stats.segments,
  }
}

// ---------- 自动化测试入口（仅扩展内部上下文可发消息触发） ----------
// tabCapture 要求真实点击扩展图标授予 activeTab，CDP 合成点击拿不到；
// 自动化验证时改为直接解码本地音频喂同一套 VAD→ASR→翻译管线。
async function startTestFile(msg: { url: string; tabId: number; settings?: Partial<Settings> }): Promise<void> {
  if (starting) return
  starting = true
  try {
    await teardown()
    tabId = msg.tabId
    running = true
    applySettings(msg.settings)
    resetSession()
    setState('loading-model', '加载识别模型…')
    try {
      await initEngine((detail) => setState('loading-model', detail))
    } catch (e) {
      return fail(`模型加载失败：${e instanceof Error ? e.message : e}`)
    }
    if (!running) return
    if (settings.sourceLang !== 'zh') {
      setState('loading-model', '加载翻译模型…')
      await warmTranslator('en').catch(() => {})
      if (settings.sourceLang === 'auto' || settings.sourceLang === 'ja') await warmTranslator('ja').catch(() => {})
    }
    if (!running) return
    audioMode = 'none'
    asrReady = true
    detector = await createDetector()
    setState('capturing', `engine=${engineDeviceLabel()} (test-source)`)

    console.info('[LiveSub] 测试音源:', msg.url)
    // 测试钩子仅接受本地地址或扩展内资源，避免被当作任意 URL 抓取器
    if (/^https?:/i.test(msg.url) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(msg.url)) {
      return fail('测试音源只允许 http://127.0.0.1 或 http://localhost')
    }
    const url = /^https?:/i.test(msg.url) ? msg.url : chrome.runtime.getURL(msg.url)
    const res = await fetch(url)
    console.info('[LiveSub] 测试音源 fetch:', res.status)
    if (!res.ok) return fail(`测试音频下载失败：HTTP ${res.status}`)
    const raw = await res.arrayBuffer()
    const tmp = new AudioContext()
    const decoded = await tmp.decodeAudioData(raw)
    await tmp.close().catch(() => {})
    console.info('[LiveSub] 测试音源解码完成:', decoded.duration.toFixed(2), 's @', decoded.sampleRate)
    const sr = 16000
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * sr), sr)
    const src = offline.createBufferSource()
    src.buffer = decoded
    src.connect(offline.destination)
    src.start()
    const rendered = await offline.startRendering()
    const pcm = rendered.getChannelData(0)
    console.info('[LiveSub] 测试音源重采样:', pcm.length, 'samples')

    // 按真实速度喂 PCM（1024 samples ≈ 64ms），这样 总延迟 = ASR + 翻译 才接近真实值
    const chunk = 1024
    let s0 = 0
    for (let i = 0; i < pcm.length; i++) s0 += pcm[i] * pcm[i]
    feedRms = Math.sqrt(s0 / pcm.length)
    console.info('[LiveSub] 测试音源 rms:', feedRms.toFixed(4), 'running=', running)
    let fed = 0
    for (let i = 0; i < pcm.length && running; i += chunk) {
      onPcm(pcm.subarray(i, Math.min(pcm.length, i + chunk)))
      fed += chunk
      await new Promise((r) => setTimeout(r, 60))
    }
    fedSamples = fed
    console.info('[LiveSub] 测试音源喂完:', fed, 'samples, running=', running, 'queue=', queue.length, 'lastRms=', lastRms.toFixed(4))
    if (running) detector?.flush()
  } finally {
    starting = false
  }
}


function fromBase64(b64: string): Float32Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Float32Array(bytes.buffer)
}

// ---------- 元素采集模式：内容脚本直接抓 <video> 音轨，页面声音不受影响 ----------
async function startElement(msg: { tabId: number; settings?: Partial<Settings> }): Promise<void> {
  if (starting) return
  starting = true
  try {
    await teardown()
    tabId = msg.tabId
    running = true
    applySettings(msg.settings)
    resetSession()
    audioMode = 'native'
    setState('loading-model', '加载识别模型…')
    try {
      await initEngine((detail) => setState('loading-model', detail))
    } catch (e) {
      return fail(`模型加载失败：${e instanceof Error ? e.message : e}`)
    }
    if (!running) return
    if (settings.sourceLang !== 'zh') {
      setState('loading-model', '加载翻译模型…')
      await warmTranslator('en').catch((e) => console.warn('[LiveSub] 翻译模型加载失败：', e))
      if (settings.sourceLang === 'auto' || settings.sourceLang === 'ja') {
        await warmTranslator('ja').catch((e) => console.warn('[LiveSub] 翻译模型加载失败：', e))
      }
    }
    if (!running) return
    detector = await createDetector()
    asrReady = true
    setState('capturing', `engine=${engineDeviceLabel()} audio=native`)
  } finally {
    starting = false
  }
}

function playbackRms(): number {
  if (!analyser) return 0
  const buf = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(buf)
  let s = 0
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
  return Math.sqrt(s / buf.length)
}

// ---------- 消息处理 ----------
chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return
  switch (msg.type) {
    case 'ping':
      sendResponse({ type: 'pong' })
      return
    case 'start':
      void start(msg as { streamId: string; tabId: number; settings?: Partial<Settings> })
      sendResponse({ ok: true })
      return
    case 'start-element':
      void startElement(msg as { tabId: number; settings?: Partial<Settings> })
      sendResponse({ ok: true })
      return
    case 'element-pcm': {
      if (!running) {
        sendResponse({ ok: false })
        return
      }
      try {
        const pcm = fromBase64(String(msg.pcm ?? ''))
        if (pcm.length > 16000 * 10) {
          sendResponse({ ok: false })
          return
        }
        if (pcm.length) onPcm(pcm)
        sendResponse({ ok: true })
      } catch {
        sendResponse({ ok: false })
      }
      return
    }
    case 'start-test':
      // 仅供 scripts/dev-e2e.mjs 使用：绕过 tabCapture，直接喂本地音频文件
      void startTestFile(msg as { url: string; tabId: number; settings?: Partial<Settings> })
      sendResponse({ ok: true })
      return
    case 'settings':
      applySettings(msg.settings as Partial<Settings> | undefined)
      sendResponse({ ok: true })
      return
    case 'audio-mode':
      setAudioMode(msg.mode as AudioMode)
      sendResponse({ ok: true })
      return
    case 'stop':
      void stop()
      sendResponse({ ok: true })
      return
    case 'snapshot':
      sendResponse({
        offscreen: state,
        detail: stateDetail,
        engine: engineReady() ? engineDeviceLabel() : undefined,
        sourceResolved: activeLang ?? undefined,
        audioMode,
        lastLines: [...lastLines],
        stats: snapshotStats(),
      })
      return
  }
})

// 告知 boot.js 黑匣子：模块加载成功（此后 ping 由本模块应答）
;(window as any).__livesubModuleReady = true

// 调试钩子：自动化测试 / 手动排障时在 offscreen 上下文里读取内部状态
;(window as any).__livesubDebug = () => ({
  state,
  stateDetail,
  running,
  tabId,
  lastRms,
  peakRms,
  feedRms,
  fedSamples,
  playbackRms: playbackRms(),
  playbackOk,
  audioMode,
  playbackGain: playbackGain?.gain.value ?? null,
  crossOriginIsolated: (globalThis as any).crossOriginIsolated ?? null,
  sab: typeof SharedArrayBuffer !== 'undefined',
  wasmThreads: (wasmBackend as any)?.numThreads ?? null,
  baseLatency: audioCtx?.baseLatency ?? null,
  outputLatency: (audioCtx as any)?.outputLatency ?? null,
  audioState: audioCtx?.state ?? 'closed',
  asrReady,
  vad: vadKind,
  words: lastWords,
  activeLang,
  partials: partialsSent,
  partialsZh,
  queueLen: queue.length,
  transLen: transQueue.length,
  lastLines,
  stats: snapshotStats(),
})

console.info('[LiveSub] offscreen 引擎就绪，WebGPU =', 'gpu' in navigator)
