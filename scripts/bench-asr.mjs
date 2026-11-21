#!/usr/bin/env node
// ASR 离线基准：对同一段音频 + YouTube 官方字幕参考，比较不同 Whisper 模型/CER/延迟。
// 用法:
//   node scripts/bench-asr.mjs --model base --win 30 --limit 10
//   node scripts/bench-asr.mjs --model small --win 5 --limit 49
// 参考字幕来自 yt-dlp --write-auto-subs（json3），由 /tmp/livesub-yt 下的脚本生成 ref-<win>s*.json
import { pipeline, env } from '@huggingface/transformers'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = process.env.YT_DATA || '/tmp/livesub-yt'

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : def
}
const MODEL = arg('--model', 'base')
const WIN = Number(arg('--win', 30))
const LIMIT = Number(arg('--limit', 0))
const AUDIO = arg('--audio', join(DATA, 'audio16.wav'))
const REF = arg('--ref', join(DATA, `ref-${WIN}s-300.json`))
const LANG = arg('--lang', 'japanese')
const SHIFT = Number(arg('--shift', 0))

env.allowLocalModels = true
env.allowRemoteModels = false
env.localModelPath = join(ROOT, 'models') + '/'

function readWavF32(path) {
  const buf = readFileSync(path)
  let off = 12
  let sampleRate = 16000
  let bits = 16
  let channels = 1
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10)
      sampleRate = buf.readUInt32LE(off + 12)
      bits = buf.readUInt16LE(off + 22)
    } else if (id === 'data') {
      const n = Math.floor(size / 2)
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768
      return { pcm: out, sampleRate, channels, bits }
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}

function normalize(s) {
  return s
    .normalize('NFKC')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[、。，．,.!?！？「」『』（）()【】〈〉《》・…:：;；\-—–~〜"'“”‘’\s]/g, '')
    .toLowerCase()
}

function editDistance(a, b) {
  // 滚动数组 Levenshtein
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  let prev = new Int32Array(n + 1)
  let cur = new Int32Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    const tmp = prev
    prev = cur
    cur = tmp
  }
  return prev[n]
}

const REPOS = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
  small: 'Xenova/whisper-small',
  medium: 'Xenova/whisper-medium',
}

const { pcm, sampleRate } = readWavF32(AUDIO)
if (sampleRate !== 16000) throw new Error(`需要 16k wav，当前 ${sampleRate}`)
const refs = JSON.parse(readFileSync(REF, 'utf8'))
const blocks = LIMIT > 0 ? refs.slice(0, LIMIT) : refs

console.log(`模型 ${MODEL} (${REPOS[MODEL]}) | 窗口 ${WIN}s | ${blocks.length} 块 | 语言 ${LANG}`)

const tLoad = Date.now()
const pipe = await pipeline('automatic-speech-recognition', REPOS[MODEL], { device: 'cpu', dtype: 'q8' })
console.log(`模型加载 ${Date.now() - tLoad}ms`)

let totalRef = 0
let totalErr = 0
let totalAudio = 0
let totalInfer = 0
const details = []
for (let i = 0; i < blocks.length; i++) {
  const b = blocks[i]
  const s0 = Math.max(0, Math.floor((b.t0 + SHIFT) * 16000))
  const s1 = Math.min(pcm.length, Math.ceil((b.t1 + SHIFT) * 16000))
  if (s1 - s0 < 8000) continue
  const chunk = pcm.subarray(s0, s1)
  const t0 = Date.now()
  const opts = { task: 'transcribe', language: LANG, max_new_tokens: Number(arg('--maxnew', 200)) }
  if (argv.includes('--norepeat')) {
    opts.no_repeat_ngram_size = 3
    opts.repetition_penalty = 1.1
  }
  const out = await pipe(chunk, opts)
  const ms = Date.now() - t0
  const hyp = normalize(String(out?.text ?? ''))
  const ref = normalize(b.text)
  if (!ref) continue
  const err = editDistance(ref, hyp)
  totalRef += ref.length
  totalErr += err
  totalAudio += chunk.length / 16000
  totalInfer += ms / 1000
  const cer = err / Math.max(1, ref.length)
  const loop = hyp.length > Math.max(40, ref.length * 2.2)
  details.push({ i, t0: b.t0, dur: +(chunk.length / 16000).toFixed(2), ms, cer, loop, refLen: ref.length, hypLen: hyp.length })
  console.log(
    `#${i} @${b.t0.toFixed(0)}s ${(chunk.length / 16000).toFixed(1)}s ${ms}ms CER=${(cer * 100).toFixed(1)}% refLen=${ref.length} hypLen=${hyp.length}${loop ? ' [LOOP]' : ''}`,
  )
  if (argv.includes('--show')) {
    console.log(`   ref: ${b.text}`)
    console.log(`   hyp: ${String(out?.text ?? '')}`)
  }
}

const cer = totalErr / Math.max(1, totalRef)
const rtf = totalInfer / Math.max(1, totalAudio)
const cers = details.map((d) => d.cer).sort((a, b) => a - b)
const median = cers.length ? cers[Math.floor(cers.length / 2)] : NaN
const loops = details.filter((d) => d.loop).length
console.log('\n=== 汇总 ===')
console.log(`块数 ${details.length}  中位 CER=${(median * 100).toFixed(2)}%  循环块 ${loops}`)
console.log(`模型: ${MODEL}  窗口: ${WIN}s  音频: ${totalAudio.toFixed(1)}s  推理: ${totalInfer.toFixed(1)}s  RTF=${rtf.toFixed(3)}`)
console.log(`参考字数: ${totalRef}  编辑距离: ${totalErr}  CER=${(cer * 100).toFixed(2)}%`)
console.log(`每 ${WIN}s 块的 ASR 平均耗时: ${((totalInfer / Math.max(1, details.length)) * 1000).toFixed(0)}ms（不含 VAD 静音等待）`)
console.log(JSON.stringify({ model: MODEL, win: WIN, cer, rtf, totalAudio, totalInfer, blocks: details.length }))
