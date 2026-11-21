// Whisper 语音识别管线（transformers.js）。
// 模型从扩展包内 models/ 读取（env.localModelPath），优先 WebGPU，失败回退 WASM。
//
// 两个关键点：
// 1) transformers.js 3.x 没有实现 Whisper 的语种自动检测，不传 language 会强制按英语解码。
//    这里直接用 encoder + 一步 decoder 读取 <|lang|> token 的 logits 做检测（与官方 detect_language 同思路）。
// 2) 模型加载与推理解耦：initAsr 用同一个 Promise 去重，offscreen 在就绪前不会把音频送进识别。
import { Tensor, pipeline } from '@huggingface/transformers'
import { cleanTranscript } from './text'
type WhisperModel = 'tiny' | 'base'

const REPO: Record<WhisperModel, string> = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
}

let cache: { key: string; pipe: any } | null = null
let device = 'wasm'
let initKey = ''
let initPromise: Promise<string> | null = null

// 目前固定走 WASM。实测：
// - q8 权重在 WebGPU 上会产出多语种乱码，且单句 18s
// - base 的 fp16 权重在 WebGPU 上加载正常，但首个真实片段 75s 内都没推理完
// 等 onnxruntime-web 的 WebGPU EP 成熟后再开放；现在 WASM(q8) 单句约 1.3s(tiny) / 2.9s(base)。
const USE_WEBGPU = false

export function webgpuAvailable(): boolean {
  return USE_WEBGPU && typeof navigator !== 'undefined' && 'gpu' in navigator
}

export function asrDevice(): string {
  return device
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} 超时（${ms}ms）`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/**
 * 加载（或复用缓存的）识别管线。并发调用共享同一个 Promise，避免重复加载/抢显存。
 * @returns 实际使用的推理设备 'webgpu' | 'wasm'
 */
export function initAsr(model: WhisperModel, onProgress?: (pct: number, file: string) => void): Promise<string> {
  const want = webgpuAvailable() ? 'webgpu' : 'wasm'
  const key = `${model}:${want}`
  if (cache?.key === key) return Promise.resolve(device)
  if (initPromise && initKey === key) return initPromise

  initKey = key
  initPromise = (async () => {
    const progress = (data: any) => {
      if (data?.status === 'progress' && data.total) {
        onProgress?.(Math.round((data.loaded / data.total) * 100), String(data.file ?? ''))
      }
    }

    cache = null
    if (want === 'webgpu') {
      try {
        const pipe = await withTimeout(
          pipeline('automatic-speech-recognition', REPO[model], {
            device: 'webgpu',
            dtype: { encoder_model: 'fp16', decoder_model_merged: 'fp16' },
            progress_callback: progress,
          }),
          60_000,
          'WebGPU 模型初始化',
        )
        // 冒烟测试：静音片段跑一次真推理，捕获建管成功但运行时挂死/报错的情况
        await withTimeout(
          pipe(new Float32Array(16000), { task: 'transcribe', language: 'en' }),
          40_000,
          'WebGPU 冒烟推理',
        )
        cache = { key, pipe }
        device = 'webgpu'
        return device
      } catch (e) {
        console.warn('[LiveSub] WebGPU 不可用，回退 WASM：', e instanceof Error ? e.message : e)
      }
    }
    cache = {
      key: `${model}:wasm`,
      pipe: await pipeline('automatic-speech-recognition', REPO[model], {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: progress,
      }),
    }
    device = 'wasm'
    return device
  })()

  // 失败后允许下次重试（例如先启动、后下载模型）
  initPromise.catch(() => {
    initPromise = null
    initKey = ''
  })
  return initPromise
}

export function modelReady(): boolean {
  return cache !== null
}

/** 识别一段 16kHz Float32 PCM。language 用 Whisper 的两位语种码（'ja' / 'en' / …） */
export async function transcribe(pcm: Float32Array, language: string): Promise<{ text: string; lang: string }> {
  if (!cache) throw new Error('ASR 未初始化')
  const out: any = await cache.pipe(pcm, { task: 'transcribe', language })
  return { text: cleanTranscript(String(out?.text ?? '')), lang: language }
}

// ---------- 语种自动检测 ----------
// Whisper 官方做法：喂 encoder 前 30s 特征，decoder 以 <|startoftranscript|> 起步，
// 第一个位置的 logits 在语言 token 上的 argmax 就是语种。
const DETECT_MAX_SAMPLES = 16000 * 5

export async function detectLanguage(pcm: Float32Array): Promise<{ code: string; margin: number } | null> {
  const pipe = cache?.pipe
  if (!pipe) return null
  try {
    const model = pipe.model
    const sessions = model.sessions
    const enc = sessions.model ?? sessions.encoder_model
    const dec = sessions.decoder_model_merged ?? sessions.decoder_model
    const cfg = model.config
    const gen = model.configs?.generation_config ?? {}
    const langToId: Record<string, number> = gen.lang_to_id ?? {}
    if (!enc || !dec || !cfg || !Object.keys(langToId).length) return null

    const audio = pcm.length > DETECT_MAX_SAMPLES ? pcm.subarray(0, DETECT_MAX_SAMPLES) : pcm
    const features = await pipe.processor(audio)
    const encoded = await enc.run({ input_features: features.input_features.ort_tensor })

    const start = cfg.decoder_start_token_id
    const inputIds = new Tensor('int64', BigInt64Array.from([BigInt(start)]), [1, 1])
    const feed: Record<string, unknown> = {
      input_ids: inputIds.ort_tensor,
      encoder_hidden_states: encoded.last_hidden_state,
    }
    // merged decoder 要求所有 past_key_values 输入都在场；首步用长度为 0 的空张量（use_cache_branch=false 分支不会用到）
    const dHeads = cfg.decoder_attention_heads ?? 6
    const eHeads = cfg.encoder_attention_heads ?? 6
    const dModel = cfg.d_model ?? 384
    for (const name of dec.inputNames as string[]) {
      if (!name.startsWith('past_key_values.')) continue
      const heads = name.includes('.encoder.') ? eHeads : dHeads
      const dims = [1, heads, 0, dModel / heads]
      feed[name] = new Tensor('float32', new Float32Array(0), dims).ort_tensor
    }
    if ((dec.inputNames as string[]).includes('use_cache_branch')) {
      feed.use_cache_branch = new Tensor('bool', Uint8Array.from([0]), [1]).ort_tensor
    }

    const out: any = await dec.run(feed)
    const logits: any = out.logits ?? Object.values(out)[0]
    const dims: number[] = logits.dims
    const vocab = dims[dims.length - 1]
    const data: Float32Array = logits.data
    const base = data.length - vocab

    let best = { code: '', v: -Infinity }
    let second = -Infinity
    for (const [token, id] of Object.entries(langToId)) {
      const v = data[base + (id as number)]
      if (v > best.v) {
        second = best.v
        best = { code: token.replace(/^<\|([a-z]{2})\|>$/, '$1'), v }
      } else if (v > second) {
        second = v
      }
    }
    if (!best.code || !Number.isFinite(best.v)) return null
    return { code: best.code, margin: best.v - second }
  } catch (e) {
    console.warn('[LiveSub] 语种检测失败：', e instanceof Error ? e.message : e)
    return null
  }
}
