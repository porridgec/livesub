// SenseVoiceSmall（sherpa-onnx int8 2024-07-17）ONNX 推理。
// 用 onnxruntime-web 直接跑，前端（Kaldi fbank + LFR + CMVN + CTC 贪心解码）在 JS 里实现，
// 不依赖 sherpa-onnx 的 WASM/SDK。模型输入不是 PCM，而是 560 维 fbank 特征。
//
// 参考：sherpa-onnx/csrc/offline-sense-voice-*.cc、offline-recognizer-sense-voice-impl.h、
//       export-onnx.py（metadata: lfr_window_size/shift, neg_mean, inv_stddev, lang ids）
import * as ort from 'onnxruntime-web'
import cfg from './sensevoice-config.json'
import { cleanTranscript, collapseRepeats, tidyCjkSpaces } from './text'
import { configureOrt } from './ort-env'
import { runExclusive } from './ort-lock'

const MODEL_URL = 'models/sensevoice/model.int8.onnx'
const TOKENS_URL = 'models/sensevoice/tokens.txt'

const SR = 16000
const FRAME_LEN = 400 // 25ms
const FRAME_SHIFT = 160 // 10ms
const NFFT = 512
const NBINS = 80
const LOW_FREQ = 20
const HIGH_FREQ = 7600
const PREEMPH = 0.97
const LFR_M = cfg.lfr_m
const LFR_N = cfg.lfr_n
const NEG_MEAN = cfg.neg_mean
const INV_STDDEV = cfg.inv_stddev
const WITH_ITN = cfg.with_itn

const LANG_ID: Record<string, number> = {
  auto: cfg.lang_auto,
  zh: cfg.lang_zh,
  en: cfg.lang_en,
  ja: cfg.lang_ja,
  ko: cfg.lang_ko,
  yue: cfg.lang_yue,
}

let session: ort.InferenceSession | null = null
let tokensById: string[] = []
let initPromise: Promise<string> | null = null
let device = 'wasm'

export function svReady(): boolean {
  return session !== null
}

export function svDevice(): string {
  return device
}

function mel(f: number): number {
  return 1127 * Math.log(1 + f / 700)
}

const HAMMING = (() => {
  const w = new Float64Array(FRAME_LEN)
  for (let i = 0; i < FRAME_LEN; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1))
  return w
})()

const MEL_WEIGHTS = (() => {
  const nFftBins = NFFT / 2
  const melLow = mel(LOW_FREQ)
  const melHigh = mel(HIGH_FREQ)
  const delta = (melHigh - melLow) / (NBINS + 1)
  const bins: Float64Array[] = []
  for (let b = 0; b < NBINS; b++) {
    const left = melLow + b * delta
    const center = left + delta
    const right = center + delta
    const w = new Float64Array(nFftBins)
    for (let k = 0; k < nFftBins; k++) {
      const m = mel((k * SR) / NFFT)
      if (m > left && m < right) w[k] = m <= center ? (m - left) / (center - left) : (right - m) / (right - center)
    }
    bins.push(w)
  }
  return bins
})()

// 原地 radix-2 FFT
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j]
        const ui = im[i + j]
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr
        re[i + j] = ur + vr
        im[i + j] = ui + vi
        re[i + j + len / 2] = ur - vr
        im[i + j + len / 2] = ui - vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

// Kaldi fbank：hamming、25/10ms、snip_edges=false、反射填充、20–7600Hz
function fbank(samples: Float32Array): { data: Float32Array; frames: number } {
  const frames = Math.floor((samples.length + FRAME_SHIFT / 2) / FRAME_SHIFT)
  const out = new Float32Array(frames * NBINS)
  const re = new Float64Array(NFFT)
  const im = new Float64Array(NFFT)
  const frame = new Float64Array(FRAME_LEN)
  for (let f = 0; f < frames; f++) {
    const start = f * FRAME_SHIFT + FRAME_SHIFT / 2 - FRAME_LEN / 2
    for (let i = 0; i < FRAME_LEN; i++) {
      let s = start + i
      if (s < 0) s = -s - 1
      if (s >= samples.length) s = 2 * samples.length - 1 - s
      frame[i] = samples[s]
    }
    let mean = 0
    for (let i = 0; i < FRAME_LEN; i++) mean += frame[i]
    mean /= FRAME_LEN
    for (let i = 0; i < FRAME_LEN; i++) frame[i] -= mean
    for (let i = FRAME_LEN - 1; i > 0; i--) frame[i] -= PREEMPH * frame[i - 1]
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < FRAME_LEN; i++) re[i] = frame[i] * HAMMING[i]
    fft(re, im)
    const power = new Float64Array(NFFT / 2)
    for (let k = 0; k < NFFT / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k]
    for (let b = 0; b < NBINS; b++) {
      const w = MEL_WEIGHTS[b]
      let e = 0
      for (let k = 0; k < NFFT / 2; k++) e += w[k] * power[k]
      out[f * NBINS + b] = Math.log(Math.max(e, 1e-10))
    }
  }
  return { data: out, frames }
}

// LFR：左侧重复首帧、右侧重复末帧，输出 ceil(frames / LFR_N) 帧
function applyLfr(flat: Float32Array, frames: number): { data: Float32Array; outFrames: number; odim: number } {
  const outFrames = Math.ceil(frames / LFR_N)
  const padLeft = Math.floor((LFR_M - 1) / 2)
  const odim = NBINS * LFR_M
  const out = new Float32Array(outFrames * odim)
  const first = flat.subarray(0, NBINS)
  const last = flat.subarray((frames - 1) * NBINS, frames * NBINS)
  for (let i = 0; i < outFrames; i++) {
    const base = i * LFR_N - padLeft
    for (let j = 0; j < LFR_M; j++) {
      const src = base + j
      let row: Float32Array
      if (src < 0) row = first
      else if (src >= frames) row = last
      else row = flat.subarray(src * NBINS, (src + 1) * NBINS)
      out.set(row, i * odim + j * NBINS)
    }
  }
  for (let i = 0; i < out.length; i++) {
    const d = i % odim
    out[i] = (out[i] + NEG_MEAN[d]) * INV_STDDEV[d]
  }
  return { data: out, outFrames, odim }
}

function argmaxDecode(logits: ort.Tensor, vocab: number): number[] {
  const data = logits.data as Float32Array
  const dims = logits.dims
  const T = dims[dims.length - 2]
  const V = dims[dims.length - 1]
  const ids: number[] = []
  let prev = -1
  for (let t = 0; t < T; t++) {
    const base = t * V
    let best = 0
    let bestV = -Infinity
    for (let v = 0; v < V; v++) {
      const x = data[base + v]
      if (x > bestV) {
        bestV = x
        best = v
      }
    }
    if (best !== 0 && best !== prev) ids.push(best)
    prev = best
  }
  void vocab
  return ids
}

/** 加载（或复用）SenseVoice 模型。onProgress 只传人类可读的加载阶段。 */
export function initSenseVoice(onProgress?: (detail: string) => void): Promise<string> {
  if (session) return Promise.resolve(device)
  if (initPromise) return initPromise
  initPromise = (async () => {
    onProgress?.('加载 SenseVoice…')
    configureOrt()

    const tokRes = await fetch(chrome.runtime.getURL(TOKENS_URL))
    if (!tokRes.ok) throw new Error(`tokens.txt HTTP ${tokRes.status}`)
    const tokText = await tokRes.text()
    tokensById = []
    for (const line of tokText.split('\n')) {
      if (!line) continue
      const i = line.lastIndexOf(' ')
      if (i < 0) continue
      tokensById[Number(line.slice(i + 1))] = line.slice(0, i)
    }

    onProgress?.('读取 SenseVoice 模型（228MB）…')
    const modelRes = await fetch(chrome.runtime.getURL(MODEL_URL))
    if (!modelRes.ok) throw new Error(`模型 HTTP ${modelRes.status}`)
    const buf = new Uint8Array(await modelRes.arrayBuffer())
    onProgress?.('初始化 SenseVoice 推理引擎…')
    session = await runExclusive(() =>
      ort.InferenceSession.create(buf, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      }),
    )
    const usedThreads = ort.env.wasm.numThreads ?? 1
    device = usedThreads > 1 ? `wasm-${usedThreads}t` : 'wasm'
    return device
  })()
  initPromise.catch(() => {
    initPromise = null
    session = null
  })
  return initPromise
}

/** 识别一段 16k Float32 PCM；lang 支持 auto / ja / en / zh / ko / yue */
export async function transcribeSenseVoice(
  pcm: Float32Array,
  lang: string,
): Promise<{ text: string; lang: string }> {
  if (!session) throw new Error('SenseVoice 未初始化')
  if (pcm.length < FRAME_LEN) return { text: '', lang: '' }
  const scaled = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) scaled[i] = pcm[i] * 32768
  const fb = fbank(scaled)
  if (fb.frames < LFR_M) return { text: '', lang: '' }
  const lfr = applyLfr(fb.data, fb.frames)
  const langId = LANG_ID[lang] ?? LANG_ID.auto
  // ITN 对日语会把「ですね」拆成「で、すね」，所以只有英语用 ITN；其他语种关掉
  const textNorm = lang === 'en' ? WITH_ITN : cfg.without_itn
  const feeds: Record<string, ort.Tensor> = {
    x: new ort.Tensor('float32', lfr.data, [1, lfr.outFrames, lfr.odim]),
    x_length: new ort.Tensor('int32', Int32Array.from([lfr.outFrames]), [1]),
    language: new ort.Tensor('int32', Int32Array.from([langId]), [1]),
    text_norm: new ort.Tensor('int32', Int32Array.from([textNorm]), [1]),
  }
  const out = await runExclusive(() => session!.run(feeds))
  const logits = out.logits
  const vocab = logits.dims[logits.dims.length - 1]
  const ids = argmaxDecode(logits, vocab)
  if (!ids.length) return { text: '', lang: '' }

  const langTok = tokensById[ids[0]] ?? ''
  const m = /^<\|([a-z]{2})\|>$/.exec(langTok)
  const detected = m ? m[1] : lang !== 'auto' ? lang : ''
  if (langTok.includes('nospeech')) return { text: '', lang: detected }

  // 前 4 个 token 是 language/emotion/event/text_norm query，后面对应正文
  let text = collapseRepeats(
    ids
      .slice(4)
      .map((id) => tokensById[id] ?? '')
      .join('')
      .replace(/▁/g, ' '),
  )
  text = tidyCjkSpaces(text)
  // 英语 ITN 关闭时首字母是小写，补一下观感
  if (detected === 'en') text = text.replace(/^([a-z])/, (m) => m.toUpperCase())
  return { text: cleanTranscript(text), lang: detected }
}
