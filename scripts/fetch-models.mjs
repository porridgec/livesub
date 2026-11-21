#!/usr/bin/env node
// 从 HuggingFace 下载量化 ONNX 模型到 models/（构建时打包进扩展）。
// 用法：
//   npm run fetch-models                    # 默认：whisper-tiny + 两个翻译模型
//   npm run fetch-models whisper-base       # 追加下载 base 模型
// 国内网络可走镜像：HF_ENDPOINT=https://hf-mirror.com npm run fetch-models
import { mkdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'

const ENDPOINT = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '')

// 固定模型仓库 revision，避免上游 main 变动带来的供应链风险
const HF_REVISION = {
  'Xenova/whisper-tiny': '5332fcc35e32a33b86612b9a57a89be7906102b1',
  'Xenova/whisper-base': '64da57285918e20ea79ea5c88eed7197933abaa8',
  'Xenova/opus-mt-en-zh': '046f55aec303cdee3e0318604406d4df20f1e8ea',
  'Xenova/opus-mt-ja-en': '1a906cfaaf7c8f4193f67f5885c082aa6dbd9d16',
}
const SILERO_REVISION = 'e71cae966052b992a7eca6b17738916ce0eca4ec'
// 关键模型的 SHA256（下载后校验）
const SENSEVOICE_SHA256 = 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51'
const SENSEVOICE_TOKENS_SHA256 = 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc'
const SILERO_SHA256 = 'a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808'

const WHISPER_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
]
const OPUS_FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
]

const ALL = {
  'whisper-tiny': { repo: 'Xenova/whisper-tiny', files: WHISPER_FILES },
  'whisper-base': { repo: 'Xenova/whisper-base', files: WHISPER_FILES },
  // en→zh：opus-mt 小模型（q8 约 114MB）
  'opus-mt-en-zh': { repo: 'Xenova/opus-mt-en-zh', files: OPUS_FILES },
  // ja→en：日→中走「ja→en→zh」两段流水线，两个小模型都比 NLLB-600M 快一个数量级
  'opus-mt-ja-en': { repo: 'Xenova/opus-mt-ja-en', files: OPUS_FILES },
  // 默认 ASR：SenseVoiceSmall int8（sherpa-onnx 发布包，含 tokens.txt + ONNX）
  sensevoice: { special: 'sensevoice' },
  // Silero VAD（onnx-community）
  vad: { special: 'vad' },
  // 可选：质量更好但很重的多语种模型（不再默认打包，见 README）
  'nllb-600m': {
    repo: 'Xenova/nllb-200-distilled-600M',
    files: [
      'config.json',
      'generation_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx',
    ],
  },
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const sets = wanted.length
  ? wanted
  : ['sensevoice', 'vad', 'whisper-tiny', 'whisper-base', 'opus-mt-en-zh', 'opus-mt-ja-en']

for (const name of sets) {
  const spec = ALL[name]
  if (!spec) {
    console.error(`未知模型 ${name}，可选：${Object.keys(ALL).join(', ')}`)
    process.exit(1)
  }
  if (spec.special === 'sensevoice') {
    await fetchSenseVoice()
    continue
  }
  if (spec.special === 'vad') {
    await fetchVad()
    continue
  }
  for (const file of spec.files) {
    await download(spec.repo, file)
  }
}
console.log('完成。models/ 会在 npm run build 时打包进 dist/')

// SenseVoice 发布在 GitHub release tar 里（ONNX + tokens.txt）
const SENSEVOICE_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
const SENSEVOICE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${SENSEVOICE_DIR}.tar.bz2`

async function fetchVad() {
  const out = resolve('models/vad/silero_vad.onnx')
  if (existsSync(out)) {
    console.log('跳过（已存在） vad/silero_vad.onnx')
    return
  }
  const url = `${ENDPOINT}/onnx-community/silero-vad/resolve/${SILERO_REVISION}/onnx/model.onnx`
  process.stdout.write('下载 Silero VAD（约 2.1MB）… ')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, buf)
  await verifySha256(out, SILERO_SHA256)
  console.log(`${(buf.length / 1048576).toFixed(1)} MB`)
}

async function verifySha256(file, expected) {
  const hash = createHash('sha256').update(await readFile(file)).digest('hex')
  if (hash !== expected) {
    await rm(file, { force: true })
    throw new Error(`SHA256 校验失败：${file}\n  expected ${expected}\n  actual   ${hash}`)
  }
  console.log(`  SHA256 ✓ ${expected.slice(0, 12)}…`)
}

async function fetchSenseVoice() {
  const out = resolve('models/sensevoice')
  if (existsSync(resolve(out, 'model.int8.onnx')) && existsSync(resolve(out, 'tokens.txt'))) {
    console.log('跳过（已存在） sensevoice')
    return
  }
  const tar = resolve('models/.sensevoice.tar.bz2')
  if (!existsSync(tar)) {
    process.stdout.write('下载 SenseVoice（约 155MB）… ')
    const res = await fetch(SENSEVOICE_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status} ${SENSEVOICE_URL}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await writeFile(tar, buf)
    console.log(`${(buf.length / 1048576).toFixed(1)} MB`)
  }
  console.log('解压 SenseVoice…')
  execFileSync('tar', ['-xjf', tar, '-C', 'models'], { stdio: 'inherit' })
  const extracted = resolve('models', SENSEVOICE_DIR)
  await mkdir(out, { recursive: true })
  await rename(resolve(extracted, 'model.int8.onnx'), resolve(out, 'model.int8.onnx'))
  await rename(resolve(extracted, 'tokens.txt'), resolve(out, 'tokens.txt'))
  await verifySha256(resolve(out, 'model.int8.onnx'), SENSEVOICE_SHA256)
  await verifySha256(resolve(out, 'tokens.txt'), SENSEVOICE_TOKENS_SHA256)
  await rm(extracted, { recursive: true, force: true })
  await rm(tar, { force: true })
  console.log('SenseVoice 就绪：models/sensevoice/')
}

async function download(repo, file) {
  const out = resolve('models', repo, file)
  try {
    const s = await stat(out)
    if (s.size > 0) {
      console.log(`跳过（已存在） ${repo}/${file}`)
      return
    }
  } catch {
    // 不存在，继续下载
  }
  const rev = HF_REVISION[repo] ?? 'main'
  const url = `${ENDPOINT}/${repo}/resolve/${rev}/${file}`
  process.stdout.write(`下载 ${repo}/${file} … `)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  await mkdir(dirname(out), { recursive: true })
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(out, buf)
  console.log(`${(buf.length / 1048576).toFixed(1)} MB`)
}
