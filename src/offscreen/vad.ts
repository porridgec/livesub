// 能量 VAD：自适应噪声底 + 静音拖尾断句 + 最大段长强制切断。
// 输出完整话语段的 16kHz Float32 PCM。

export interface SegmentCallback {
  (pcm: Float32Array, endedAtMs: number): void
}

const PRE_ROLL_S = 0.3 // 话语起点前保留的音频
const HANGOVER_S = 0.6 // 静音多久判定一句话结束
const MIN_SEG_S = 0.35 // 短于此的段丢弃（噪声毛刺）
const MAX_SEG_S = 5 // 单段上限，超过强制切断（延迟与字幕长度控制）

function rmsOf(chunk: Float32Array): number {
  let s = 0
  for (let i = 0; i < chunk.length; i++) s += chunk[i] * chunk[i]
  return Math.sqrt(s / chunk.length)
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

export class Vad {
  private readonly sr: number
  private readonly onSegment: SegmentCallback
  private mult = 2.0 // 阈值 = max(噪声底 * mult, 0.0025)
  private floor = 0.003
  private inSpeech = false
  private segParts: Float32Array[] = []
  private segLen = 0
  private silenceLen = 0
  private preRoll: Float32Array[] = []
  private preRollLen = 0
  private readonly preRollMax: number

  constructor(opts: { sampleRate: number; sensitivity: number; onSegment: SegmentCallback }) {
    this.sr = opts.sampleRate
    this.onSegment = opts.onSegment
    this.preRollMax = Math.round(PRE_ROLL_S * opts.sampleRate)
    this.setSensitivity(opts.sensitivity)
  }

  /** 1（最不敏感）~ 5（最敏感） */
  setSensitivity(s: number): void {
    this.mult = 3.4 - 0.6 * clamp(s, 1, 5)
  }

  push(chunk: Float32Array): void {
    const rms = rmsOf(chunk)
    const th = Math.max(this.floor * this.mult, 0.0025)

    if (!this.inSpeech) {
      // 静音期持续跟踪噪声底（快升慢降）
      this.floor = clamp(this.floor * 0.98 + rms * 0.02, 1e-4, 0.08)
      this.preRoll.push(chunk)
      this.preRollLen += chunk.length
      while (this.preRollLen - this.preRoll[0].length >= this.preRollMax) {
        this.preRollLen -= this.preRoll[0].length
        this.preRoll.shift()
      }
      if (rms > th) {
        this.inSpeech = true
        this.segParts = [...this.preRoll, chunk]
        this.segLen = this.preRollLen
        this.silenceLen = 0
        this.preRoll = []
        this.preRollLen = 0
      }
      return
    }

    this.segParts.push(chunk)
    this.segLen += chunk.length
    if (rms < th) this.silenceLen += chunk.length
    else this.silenceLen = 0

    if (this.silenceLen >= HANGOVER_S * this.sr) {
      this.emit()
    } else if (this.segLen - this.silenceLen > MAX_SEG_S * this.sr) {
      // 连续说话超过上限：切掉当前块，结算后把它作为新段起点重新评估
      const last = this.segParts.pop()!
      this.segLen -= last.length
      this.silenceLen = 0
      this.emit()
      this.push(last)
    }
  }

  /** 当前正在说的这一段（用于边说边出临时字幕） */
  snapshot(): Float32Array | null {
    if (!this.inSpeech || !this.segParts.length) return null
    let total = 0
    for (const p of this.segParts) total += p.length
    const pcm = new Float32Array(total)
    let off = 0
    for (const p of this.segParts) {
      pcm.set(p, off)
      off += p.length
    }
    return pcm
  }

  /** 流结束时强制结算未完的话语 */
  flush(): void {
    if (this.inSpeech) this.emit()
  }

  private emit(): void {
    const parts = this.segParts
    const dur = this.segLen / this.sr
    this.inSpeech = false
    this.segParts = []
    this.segLen = 0
    this.silenceLen = 0
    this.preRoll = []
    this.preRollLen = 0
    if (dur < MIN_SEG_S) return

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
}
