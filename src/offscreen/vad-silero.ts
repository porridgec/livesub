// Silero VAD（onnx-community/silero-vad, ONNX）在 offscreen 里做语音端点检测。
// 输入 512 samples(32ms)；state 跨窗口复用；比能量 VAD 更抗音乐/噪声，静音判定可以压到 ~0.3s。
import * as ort from 'onnxruntime-web'
import { configureOrt } from './ort-env'
import { runExclusive } from './ort-lock'

export interface Detector {
  push(chunk: Float32Array): void
  snapshot(): Float32Array | null
  flush(): void
  setSensitivity(s: number): void
}

const SR = 16000
const WIN = 512
const PRE_WINDOWS = 10 // ~0.32s 预卷
const MIN_SPEECH_WINDOWS = 8 // ~0.256s
const MIN_SILENCE_WINDOWS = 9 // ~0.288s
const MAX_SEG_WINDOWS = Math.round((5 * SR) / WIN) // 5s，和能量 VAD 保持一致

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

class SileroVad implements Detector {
  private state = new Float32Array(2 * 1 * 128)
  private pending = new Float32Array(0)
  private queue: Float32Array[] = []
  private draining = false
  private pre: Float32Array[] = []
  private seg: Float32Array[] = []
  private inSpeech = false
  private silence = 0
  private threshold = 0.5

  constructor(
    private readonly session: ort.InferenceSession,
    sensitivity: number,
    private readonly onSegment: (pcm: Float32Array, endedAt: number) => void,
  ) {
    this.setSensitivity(sensitivity)
  }

  setSensitivity(s: number): void {
    // 1(不敏感) → 0.55；5(敏感) → 0.35
    this.threshold = 0.35 + (5 - clamp(s, 1, 5)) * 0.05
  }

  push(chunk: Float32Array): void {
    if (!chunk.length) return
    const merged = new Float32Array(this.pending.length + chunk.length)
    merged.set(this.pending)
    merged.set(chunk, this.pending.length)
    let off = 0
    while (merged.length - off >= WIN) {
      this.queue.push(merged.slice(off, off + WIN))
      off += WIN
    }
    this.pending = merged.slice(off)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length) {
        const w = this.queue.shift()!
        const feeds: Record<string, ort.Tensor> = {
          input: new ort.Tensor('float32', w, [1, WIN]),
          state: new ort.Tensor('float32', this.state, [2, 1, 128]),
          sr: new ort.Tensor('int64', BigInt64Array.from([16000n]), [1]),
        }
        const out = await runExclusive(() => this.session.run(feeds))
        this.state = new Float32Array(out.stateN.data as Float32Array)
        const p = (out.output.data as Float32Array)[0]
        this.update(w, p)
      }
    } catch (e) {
      console.warn('[LiveSub] Silero VAD 推理失败：', e)
    } finally {
      this.draining = false
    }
  }

  private update(w: Float32Array, p: number): void {
    if (!this.inSpeech) {
      this.pre.push(w)
      while (this.pre.length > PRE_WINDOWS) this.pre.shift()
      if (p >= this.threshold) {
        this.inSpeech = true
        this.seg = [...this.pre]
        this.pre = []
        this.silence = 0
      }
      return
    }

    this.seg.push(w)
    if (p >= this.threshold) this.silence = 0
    else this.silence++

    if (this.seg.length >= MAX_SEG_WINDOWS) {
      this.emit(true)
      // 连续说话：当前窗口已结算，后续从下一个窗口继续
      this.inSpeech = true
      this.seg = []
      this.silence = 0
      return
    }
    if (this.silence >= MIN_SILENCE_WINDOWS) {
      this.emit(false)
      this.inSpeech = false
      this.seg = []
      this.silence = 0
    }
  }

  private emit(force: boolean): void {
    const parts = this.seg
    this.seg = []
    if (!parts.length) return
    if (!force && parts.length < MIN_SPEECH_WINDOWS) return
    let total = 0
    for (const p of parts) total += p.length
    const pcm = new Float32Array(total)
    let off = 0
    for (const p of parts) {
      pcm.set(p, off)
      off += p.length
    }
    this.onSegment(pcm, performance.now())
  }

  snapshot(): Float32Array | null {
    if (!this.inSpeech || !this.seg.length) return null
    let total = 0
    for (const p of this.seg) total += p.length
    const max = 4.5 * SR
    const pcm = new Float32Array(Math.min(total, max))
    let off = 0
    for (let i = 0; i < this.seg.length; i++) {
      const p = this.seg[i]
      if (off + p.length > max) {
        pcm.set(p.subarray(0, max - off), off)
        off = max
        break
      }
      pcm.set(p, off)
      off += p.length
    }
    return pcm
  }

  flush(): void {
    if (this.inSpeech) {
      this.emit(true)
      this.inSpeech = false
      this.silence = 0
    }
  }
}

/** 加载 Silero VAD；失败返回 null，由调用方回退到能量 VAD */
export async function createSileroVad(
  sensitivity: number,
  onSegment: (pcm: Float32Array, endedAt: number) => void,
): Promise<Detector | null> {
  try {
    configureOrt()
    const res = await fetch(chrome.runtime.getURL('models/vad/silero_vad.onnx'))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    const session = await runExclusive(() => ort.InferenceSession.create(buf, { executionProviders: ['wasm'] }))
    console.info('[LiveSub] Silero VAD 已加载')
    return new SileroVad(session, sensitivity, onSegment)
  } catch (e) {
    console.warn('[LiveSub] Silero VAD 不可用，回退能量 VAD：', e instanceof Error ? e.message : e)
    return null
  }
}
