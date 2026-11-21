// AudioWorklet：把上下文的原始采样率（通常 48k）降采样到 16kHz，按 ~64ms 一块上报。
// 低通滤波（避免降采样混叠）+ 线性插值，支持任意输入/输出采样率比。
// 独立纯 JS 文件，由 offscreen 页通过 addModule(chrome.runtime.getURL(...)) 加载。
class PcmCollector extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opt = (options && options.processorOptions) || {}
    this.targetRate = opt.targetSampleRate || 16000
    this.frameSize = opt.frameSize || 1024
    this.ratio = sampleRate / this.targetRate

    // 只对降采样做低通；截止取目标奈奎斯特的 0.9，Q=1/√2（Butterworth 二阶）
    this.biquad = null
    if (this.ratio > 1.05) {
      const fc = Math.min(this.targetRate * 0.45, sampleRate * 0.45)
      const w0 = (2 * Math.PI * fc) / sampleRate
      const cos = Math.cos(w0)
      const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
      const a0 = 1 + alpha
      this.biquad = {
        b0: (1 - cos) / 2 / a0,
        b1: (1 - cos) / a0,
        b2: (1 - cos) / 2 / a0,
        a1: (-2 * cos) / a0,
        a2: (1 - alpha) / a0,
        x1: 0,
        x2: 0,
        y1: 0,
        y2: 0,
      }
    }

    this.inBuf = new Float32Array(8192)
    this.inLen = 0
    this.pos = 0 // 输入缓冲里的分数读位置
    this.outBuf = new Float32Array(this.frameSize)
    this.outLen = 0
  }

  _filter(x) {
    const f = this.biquad
    if (!f) return x
    const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2
    f.x2 = f.x1
    f.x1 = x
    f.y2 = f.y1
    f.y1 = y
    return y
  }

  _append(ch) {
    if (this.inLen + ch.length > this.inBuf.length) {
      let cap = this.inBuf.length
      while (cap < this.inLen + ch.length) cap *= 2
      const next = new Float32Array(cap)
      next.set(this.inBuf.subarray(0, this.inLen))
      this.inBuf = next
    }
    for (let i = 0; i < ch.length; i++) this.inBuf[this.inLen + i] = this._filter(ch[i])
    this.inLen += ch.length
  }

  _emit(sample) {
    this.outBuf[this.outLen++] = sample
    if (this.outLen === this.outBuf.length) {
      this.port.postMessage(this.outBuf.slice(0))
      this.outLen = 0
    }
  }

  _resample() {
    // 需要 pos+1 才能插值，末尾留 1 个样本到下一轮
    while (this.pos + 1 < this.inLen) {
      const i = this.pos | 0
      const frac = this.pos - i
      const a = this.inBuf[i]
      const b = this.inBuf[i + 1]
      this._emit(a + (b - a) * frac)
      this.pos += this.ratio
    }
    // 丢弃已消费的整数部分，避免缓冲无限增长
    const drop = Math.min(this.inLen - 1, this.pos | 0)
    if (drop > 0) {
      this.inBuf.copyWithin(0, drop, this.inLen)
      this.inLen -= drop
      this.pos -= drop
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) {
      this._append(ch)
      this._resample()
    }
    return true
  }
}

registerProcessor('pcm-collector', PcmCollector)
