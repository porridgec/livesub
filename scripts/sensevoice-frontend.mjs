#!/usr/bin/env node
// SenseVoice 前端原型：Kaldi fbank(80) + LFR(7/6) + CMVN + CTC 贪心解码。
// 用 onnxruntime-node 跑 sherpa-onnx 的 SenseVoice int8 ONNX，用于验证「纯 JS 前端 + ort-web」可行性。
import ort from 'onnxruntime-node'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODEL_DIR = process.env.SV_MODEL || '/tmp/sherpa/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
const CMVN_PATH = process.env.SV_CMVN || '/tmp/sherpa/sv-cmvn.json'
const CMVN = JSON.parse(readFileSync(CMVN_PATH, 'utf8'))
const TOKENS = readFileSync(join(MODEL_DIR, 'tokens.txt'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const i = l.lastIndexOf(' ')
    return [Number(l.slice(i + 1)), l.slice(0, i)]
  })
  .reduce((m, [i, t]) => ((m[i] = t), m), {})

function readWavF32(path) {
  const buf = readFileSync(path)
  let off = 12
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') {
      const n = Math.floor(size / 2)
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768
      return out
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('no data')
}

// ---------- FFT ----------
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
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

// ---------- Kaldi fbank ----------
const SR = 16000
const FRAME_LEN = 400
const FRAME_SHIFT = 160
const NFFT = 512
const NBINS = 80
const LOW_FREQ = 20
const HIGH_FREQ = 7600
const PREEMPH = 0.97

const mel = (f) => 1127 * Math.log(1 + f / 700)
const hamming = Array.from({ length: FRAME_LEN }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1)))

const melWeights = (() => {
  const nFftBins = NFFT / 2
  const melLow = mel(LOW_FREQ)
  const melHigh = mel(HIGH_FREQ)
  const delta = (melHigh - melLow) / (NBINS + 1)
  const bins = []
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

function fbank(samples) {
  // samples: int16 量级的 Float32（normalize_samples=false）
  const numFrames = Math.floor((samples.length + FRAME_SHIFT / 2) / FRAME_SHIFT)
  const out = new Float32Array(numFrames * NBINS)
  const re = new Float64Array(NFFT)
  const im = new Float64Array(NFFT)
  for (let f = 0; f < numFrames; f++) {
    const mid = f * FRAME_SHIFT + FRAME_SHIFT / 2
    let start = mid - FRAME_LEN / 2
    const frame = new Float64Array(FRAME_LEN)
    for (let i = 0; i < FRAME_LEN; i++) {
      let s = start + i
      if (s < 0) s = -s - 1
      if (s >= samples.length) s = 2 * samples.length - 1 - s
      frame[i] = samples[s]
    }
    // remove DC
    let mean = 0
    for (let i = 0; i < FRAME_LEN; i++) mean += frame[i]
    mean /= FRAME_LEN
    for (let i = 0; i < FRAME_LEN; i++) frame[i] -= mean
    // preemphasis（x[0] 不变）
    for (let i = FRAME_LEN - 1; i > 0; i--) frame[i] -= PREEMPH * frame[i - 1]
    // window + FFT
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < FRAME_LEN; i++) re[i] = frame[i] * hamming[i]
    fft(re, im)
    const power = new Float64Array(NFFT / 2)
    for (let k = 0; k < NFFT / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k]
    for (let b = 0; b < NBINS; b++) {
      let e = 0
      const w = melWeights[b]
      for (let k = 0; k < NFFT / 2; k++) e += w[k] * power[k]
      out[f * NBINS + b] = Math.log(Math.max(e, 1e-10))
    }
  }
  return { out, numFrames }
}

function applyLfr(flat, numFrames, dim) {
  const m = CMVN.lfr_m
  const n = CMVN.lfr_n
  const outFrames = Math.ceil(numFrames / n)
  const padLeft = Math.floor((m - 1) / 2)
  const padded = []
  for (let i = 0; i < padLeft; i++) padded.push(flat.subarray(0, dim))
  for (let i = 0; i < numFrames; i++) padded.push(flat.subarray(i * dim, (i + 1) * dim))
  const last = flat.subarray((numFrames - 1) * dim, numFrames * dim)
  for (let i = 0; i < m; i++) padded.push(last)
  const odim = dim * m
  const out = new Float32Array(outFrames * odim)
  for (let i = 0; i < outFrames; i++) {
    for (let j = 0; j < m; j++) {
      out.set(padded[i * n + j], i * odim + j * dim)
    }
  }
  return { out, outFrames, odim }
}

function applyCmvn(flat, dim) {
  for (let i = 0; i < flat.length; i++) {
    const d = i % dim
    flat[i] = (flat[i] + CMVN.neg_mean[d]) * CMVN.inv_stddev[d]
  }
}

async function main() {
  const session = await ort.InferenceSession.create(join(MODEL_DIR, 'model.int8.onnx'))
  const files = process.argv.slice(2)
  for (const file of files) {
    const pcm = readWavF32(file)
    const scaled = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) scaled[i] = pcm[i] * 32768
    const { out, numFrames } = fbank(scaled)
    const { out: lfr, outFrames, odim } = applyLfr(out, numFrames, NBINS)
    applyCmvn(lfr, odim)
    const feeds = {
      x: new ort.Tensor('float32', lfr, [1, outFrames, odim]),
      x_length: new ort.Tensor('int32', Int32Array.from([outFrames]), [1]),
      language: new ort.Tensor('int32', Int32Array.from([CMVN.lang_ja]), [1]),
      text_norm: new ort.Tensor('int32', Int32Array.from([CMVN.with_itn]), [1]),
    }
    const t0 = Date.now()
    const res = await session.run(feeds)
    const ms = Date.now() - t0
    const logits = res.logits
    const [, T, V] = logits.dims
    const data = logits.data
    let prev = -1
    const ids = []
    for (let t = 0; t < T; t++) {
      let best = 0
      let bestV = -Infinity
      const base = t * V
      for (let v = 0; v < V; v++) {
        const x = data[base + v]
        if (x > bestV) { bestV = x; best = v }
      }
      if (best !== 0 && best !== prev) ids.push(best)
      prev = best
    }
    const text = ids.slice(4).map((id) => TOKENS[id] ?? '').join('').replace(/▁/g, ' ')
    console.log(JSON.stringify({ file, frames: outFrames, ms, text }))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
