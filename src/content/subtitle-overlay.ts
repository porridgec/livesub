// Content Script：把双语字幕覆盖在页面里最大的可见 <video> 上。
//
// 实现要点：
// - Shadow DOM 隔离样式，宿主用 Popover API 进入 top layer（全屏视频也压得住）
// - rAF 跟随 video 的 getBoundingClientRect（滚动/缩放/换清晰度重建都能跟上）
// - 只在"正在播放/可见面积最大"的 video 上显示；找不到就隐藏
// - 订阅 storage 设置，字号/位置/底色/行数/显示模式即时生效
// 注意：构建时会把本文件打成 IIFE，本地运行时 import 会被内联；不要在这里引用其他上下文。

import { CaptionWindow } from './caption-window'

interface StyleCfg {
  fontScale: number
  bottomOffset: number
  bgOpacity: number
  maxLines: number
}

type Mode = 'bilingual' | 'original' | 'translated'

const DEFAULT_STYLE: StyleCfg = { fontScale: 0.028, bottomOffset: 0.06, bgOpacity: 0.55, maxLines: 2 }
const HOST_ID = 'livesub-subtitle-host'

;(function () {
  const w = window as any
  // 动态注入 + manifest 注入可能同时发生，只装一次
  if (w.__livesubOverlayInstalled) return
  w.__livesubOverlayInstalled = true

  let style: StyleCfg = { ...DEFAULT_STYLE }
  let mode: Mode = 'bilingual'
  const caption = new CaptionWindow()
  let running = false

  let host: HTMLDivElement | null = null
  let boxEl: HTMLDivElement | null = null
  let panel: HTMLDivElement | null = null
  let listEl: HTMLDivElement | null = null
  let anchor: HTMLVideoElement | null = null
  let rafId = 0
  let lastLayout = ''
  let lastAnchorCheck = 0
  let lastRenderKey = ''
  let lastElementRestart = 0

  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

  // ---------- DOM ----------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .box {
      position: absolute; inset: 0;
      display: flex; align-items: flex-end; justify-content: center;
      padding: 0 3% var(--pad, 6%) 3%;
      overflow: hidden;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif;
      font-weight: 600; text-align: center; color: #fff;
      text-shadow: 0 1px 2px rgba(0,0,0,.95), 0 0 8px rgba(0,0,0,.8);
    }
    .panel {
      max-width: min(94%, 1100px);
      max-height: 100%;
      overflow: hidden;
      display: flex; flex-direction: column; gap: .14em;
      padding: .18em .6em .2em;
      border-radius: .35em;
      background: rgba(0, 0, 0, var(--bg, .55));
    }
    .group { display: flex; flex-direction: column; gap: .04em; }
    .orig, .trans { display: block; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.3; }
    .trans { color: #a9e8b6; font-size: .9em; }
    .trans:empty { display: none; }
    .partial { opacity: .72; }
    .partial .tail { opacity: .5; }
    .hidden { display: none !important; }
  `

  function buildHost(): void {
    if (host || !document.documentElement) return
    host = document.createElement('div')
    host.id = HOST_ID
    // Popover API：top layer，z-index 再高也压不住的"全屏 video"场景靠它
    host.setAttribute('popover', 'manual')
    host.style.cssText = [
      'position:fixed',
      'inset:auto',
      'left:0',
      'top:0',
      'width:0',
      'height:0',
      'margin:0',
      'padding:0',
      'border:0',
      'background:transparent',
      'overflow:hidden',
      'pointer-events:none',
      'display:none',
    ].join(';')

    const root = host.attachShadow({ mode: 'open' })
    const st = document.createElement('style')
    st.textContent = CSS
    root.appendChild(st)

    boxEl = document.createElement('div')
    boxEl.className = 'box'
    panel = document.createElement('div')
    panel.className = 'panel'
    listEl = document.createElement('div')
    listEl.className = 'panel-inner'
    panel.appendChild(listEl)
    boxEl.appendChild(panel)
    root.appendChild(boxEl)

    document.documentElement.appendChild(host)
    console.info('[LiveSub] 字幕覆盖层已注入')
  }

  function isPopoverOpen(): boolean {
    try {
      return !!host && host.matches(':popover-open')
    } catch {
      return false
    }
  }

  function showHost(): void {
    if (!host) buildHost()
    if (!host) return
    host.style.display = 'block'
    // 全屏时视频会进入 top layer，后入 DOM 的元素才在上面；重新 show 一次把字幕抬到最上
    try {
      if (!isPopoverOpen()) host.showPopover()
    } catch {
      // 老版本不支持 popover：退化为普通 fixed 元素
    }
  }

  function hideHost(): void {
    if (!host) return
    try {
      if (isPopoverOpen()) host.hidePopover()
    } catch {}
    host.style.display = 'none'
    lastLayout = ''
  }

  // ---------- 视频选择 ----------
  function visibleArea(r: DOMRect): number {
    const vw = document.documentElement.clientWidth || window.innerWidth
    const vh = document.documentElement.clientHeight || window.innerHeight
    const ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0))
    const iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))
    return ix * iy
  }

  function isUsableVideo(v: HTMLVideoElement): boolean {
    if (!v.isConnected || v.readyState === 0) return false
    const r = v.getBoundingClientRect()
    if (r.width < 160 || r.height < 90) return false
    const cs = getComputedStyle(v)
    if (cs.display === 'none' || cs.visibility === 'hidden') return false
    if (Number(cs.opacity) < 0.05) return false
    if (visibleArea(r) < r.width * r.height * 0.2) return false
    return true
  }

  function pickVideo(): HTMLVideoElement | null {
    const vids = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[]
    let best: HTMLVideoElement | null = null
    let bestScore = 0
    for (const v of vids) {
      if (!isUsableVideo(v)) continue
      const r = v.getBoundingClientRect()
      let score = visibleArea(r)
      if (!v.paused && !v.ended) score *= 1.6
      if (v === anchor) score *= 1.2 // 避免两个等大视频之间反复横跳
      if (score > bestScore) {
        bestScore = score
        best = v
      }
    }
    return best
  }


  // ---------- 页面内元素采集（首选路径） ----------
  // tabCapture 会把 tab 静音，回放又带来 100ms 级延迟；直接抓 <video>.captureStream() 的音轨，
  // 页面声音完全不受影响，音画天然同步，也不需要 activeTab 授权。
  let elCapture: {
    ctx: AudioContext
    stream: MediaStream
    video: HTMLVideoElement
    src: MediaStreamAudioSourceNode
    node?: AudioWorkletNode
    proc?: ScriptProcessorNode
    sink?: GainNode
  } | null = null

  // AudioWorklet 跑在音频线程，避免 ScriptProcessor 在主线程被 rAF/页面卡顿拖出爆音/丢帧
  const WORKLET_CODE = `
class PcmCollector extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opt = (options && options.processorOptions) || {}
    this.targetRate = opt.targetSampleRate || 16000
    this.frameSize = opt.frameSize || 1024
    this.ratio = sampleRate / this.targetRate
    this.biquad = null
    if (this.ratio > 1.05) {
      const fc = Math.min(this.targetRate * 0.45, sampleRate * 0.45)
      const w0 = (2 * Math.PI * fc) / sampleRate
      const cos = Math.cos(w0)
      const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
      const a0 = 1 + alpha
      this.biquad = { b0: (1 - cos) / 2 / a0, b1: (1 - cos) / a0, b2: (1 - cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 }
    }
    this.inBuf = new Float32Array(8192)
    this.inLen = 0
    this.pos = 0
    this.outBuf = new Float32Array(this.frameSize)
    this.outLen = 0
  }
  _filter(x) {
    const f = this.biquad
    if (!f) return x
    const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2
    f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y
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
    while (this.pos + 1 < this.inLen) {
      const i = this.pos | 0
      const frac = this.pos - i
      const a = this.inBuf[i]
      const b = this.inBuf[i + 1]
      this._emit(a + (b - a) * frac)
      this.pos += this.ratio
    }
    const drop = Math.min(this.inLen - 1, this.pos | 0)
    if (drop > 0) {
      this.inBuf.copyWithin(0, drop, this.inLen)
      this.inLen -= drop
      this.pos -= drop
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) { this._append(ch); this._resample() }
    return true
  }
}
registerProcessor('livesub-pcm', PcmCollector)
`

  async function createWorkletNode(ctx: AudioContext): Promise<AudioWorkletNode> {
    const blob = new Blob([WORKLET_CODE], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    return new AudioWorkletNode(ctx, 'livesub-pcm', {
      processorOptions: { targetSampleRate: 16000, frameSize: 1024 },
    })
  }

  function toBase64(pcm: Float32Array): string {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    let out = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const slice = bytes.subarray(i, i + CHUNK)
      let s = ''
      for (let j = 0; j < slice.length; j++) s += String.fromCharCode(slice[j])
      out += s
    }
    return btoa(out)
  }

  function sendPcm(pcm: Float32Array): void {
    try {
      chrome.runtime.sendMessage(
        { target: 'offscreen', type: 'element-pcm', pcm: toBase64(pcm) },
        () => {
          void chrome.runtime.lastError
        },
      )
    } catch {
      // offscreen 未就绪
    }
  }

  function stopElementCapture(): void {
    if (!elCapture) return
    const cap = elCapture
    elCapture = null
    try {
      if (cap.node) cap.node.port.onmessage = null
      if (cap.proc) cap.proc.onaudioprocess = null
      cap.node?.disconnect()
      cap.proc?.disconnect()
      cap.src.disconnect()
      cap.sink?.disconnect()
    } catch {}
    try {
      cap.stream.getTracks().forEach((t) => t.stop())
    } catch {}
    void cap.ctx.close().catch(() => {})
  }

  async function startElementCapture(): Promise<{ ok: boolean; error?: string }> {
    stopElementCapture()
    const video = pickVideo()
    if (!video) return { ok: false, error: 'no-video' }
    let stream: MediaStream
    try {
      const vAny = video as any
      if (typeof vAny.captureStream !== 'function') throw new Error('浏览器不支持 captureStream')
      stream = vAny.captureStream() as MediaStream
    } catch (e) {
      return { ok: false, error: `captureStream 失败：${e instanceof Error ? e.message : e}` }
    }
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop())
      return { ok: false, error: 'video 没有音轨' }
    }

    // 方案 A：AudioWorklet（音频线程降采样，最稳）
    let ctx: AudioContext | null = null
    try {
      ctx = new AudioContext()
      await ctx.resume().catch(() => {})
      if (ctx.state !== 'running') throw new Error(`AudioContext ${ctx.state}`)
      const node = await createWorkletNode(ctx)
      const src = ctx.createMediaStreamSource(stream)
      const sink = ctx.createGain()
      sink.gain.value = 0
      node.port.onmessage = (ev) => sendPcm(ev.data as Float32Array)
      src.connect(node)
      node.connect(sink)
      sink.connect(ctx.destination)
      elCapture = { ctx, stream, video, src, node, sink }
      setRunning(true)
      console.info('[LiveSub] 元素采集已启动（AudioWorklet，页面声音不受影响）')
      return { ok: true }
    } catch (e) {
      console.warn('[LiveSub] AudioWorklet 不可用，回退 ScriptProcessor：', e instanceof Error ? e.message : e)
      if (ctx) await ctx.close().catch(() => {})
    }

    // 方案 B：16k AudioContext + ScriptProcessorNode（老 API，兼容性兜底）
    try {
      ctx = new AudioContext({ sampleRate: 16000 })
      await ctx.resume().catch(() => {})
      if (ctx.state !== 'running') throw new Error(`AudioContext ${ctx.state}`)
      const src = ctx.createMediaStreamSource(stream)
      const proc = ctx.createScriptProcessor(1024, 1, 1)
      const sink = ctx.createGain()
      sink.gain.value = 0
      proc.onaudioprocess = (e) => sendPcm(new Float32Array(e.inputBuffer.getChannelData(0)))
      src.connect(proc)
      proc.connect(sink)
      sink.connect(ctx.destination)
      elCapture = { ctx, stream, video, src, proc, sink }
      setRunning(true)
      console.info('[LiveSub] 元素采集已启动（ScriptProcessor，页面声音不受影响）')
      return { ok: true }
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop())
      if (ctx) await ctx.close().catch(() => {})
      return { ok: false, error: `音频采集初始化失败：${e instanceof Error ? e.message : e}` }
    }
  }

  // ---------- 渲染 ----------
  function render(): void {
    if (!listEl || !host) return
    const snap = caption.snapshot()
    const partial = snap.partial
    const key =
      `${mode}|${style.maxLines}|p:${partial?.text ?? ''}:${partial?.stableLen ?? 0}:${partial?.translated?.length ?? 0}|` +
      snap.finals.map((l) => `${l.id}:${l.original.length}:${l.translated?.length ?? 0}`).join('~')
    if (key === lastRenderKey) return
    lastRenderKey = key

    const visible = snap.finals
    listEl.textContent = ''
    for (const l of visible) {
      const g = document.createElement('div')
      g.className = 'group'
      g.dataset.id = l.id
      if (mode !== 'translated') {
        const o = document.createElement('div')
        o.className = 'orig'
        o.textContent = l.original
        g.appendChild(o)
      }
      if (mode !== 'original') {
        const t = document.createElement('div')
        t.className = 'trans'
        // 译文还没到：显示原文占位（translated 模式下也能立刻看到东西）
        t.textContent = mode === 'translated' ? l.translated ?? l.original : l.translated ?? ''
        if (!t.textContent) t.classList.add('hidden')
        g.appendChild(t)
      }
      listEl.appendChild(g)
    }
    if (partial) {
      const g = document.createElement('div')
      g.className = 'group partial'
      const o = document.createElement('div')
      o.className = 'orig'
      if (partial.stableLen > 0 && partial.stableLen < partial.text.length) {
        o.appendChild(document.createTextNode(partial.text.slice(0, partial.stableLen)))
        const tail = document.createElement('span')
        tail.className = 'tail'
        tail.textContent = partial.text.slice(partial.stableLen)
        o.appendChild(tail)
      } else {
        o.textContent = partial.text
      }
      g.appendChild(o)
      if (partial.translated) {
        const t = document.createElement('div')
        t.className = 'trans'
        t.textContent = partial.translated
        g.appendChild(t)
      }
      listEl.appendChild(g)
    }
    const hasContent = visible.length > 0 || !!partial
    panel?.classList.toggle('hidden', !hasContent || !anchor)
  }

  function applyLayout(): void {
    if (!host || !anchor) return
    const r = anchor.getBoundingClientRect()
    const fontSize = clamp(r.width * style.fontScale, 11, 72)
    // 位置/尺寸/样式都没变就不写 DOM
    const signature = `${Math.round(r.left)},${Math.round(r.top)},${r.width.toFixed(1)},${r.height.toFixed(1)},${style.fontScale},${style.bottomOffset},${style.bgOpacity}`
    if (signature === lastLayout) return
    lastLayout = signature
    host.style.left = `${r.left}px`
    host.style.top = `${r.top}px`
    host.style.width = `${r.width}px`
    host.style.height = `${r.height}px`
    if (boxEl && panel) {
      // 至少留 60px：小窗口/原生控制条不会被字幕盖住；大视频按比例走
      const pad = Math.min(Math.max(r.height * style.bottomOffset, 60), r.height * 0.35)
      boxEl.style.setProperty('--pad', `${pad.toFixed(1)}px`)
      boxEl.style.setProperty('--bg', String(clamp(style.bgOpacity, 0, 1)))
      panel.style.fontSize = `${fontSize.toFixed(1)}px`
    }
  }

  function tick(): void {
    rafId = requestAnimationFrame(tick)
    if (!running || !host) return
    const now = performance.now()
    if (now - lastAnchorCheck > 500) {
      lastAnchorCheck = now
      const next = pickVideo()
      if (next !== anchor) {
        anchor = next
        lastLayout = ''
        render()
      }
      // 播放器换清晰度/换集后 video 元素会重建：把音轨切到新元素上
      if (elCapture && anchor && anchor !== elCapture.video && now - lastElementRestart > 3000) {
        lastElementRestart = now
        void startElementCapture()
      }
    }
    if (anchor && !anchor.isConnected) {
      anchor = null
      lastLayout = ''
      render()
    }
    if (!anchor) return
    applyLayout()
  }

  function startLoop(): void {
    if (rafId) return
    rafId = requestAnimationFrame(tick)
  }

  function setRunning(on: boolean): void {
    running = on
    if (on) {
      showHost()
      lastAnchorCheck = 0
      lastLayout = ''
      startLoop()
    } else {
      caption.clear()
      lastRenderKey = ''
      if (listEl) listEl.textContent = ''
      hideHost()
    }
    render()
  }

  function addOriginal(id: string, text: string, _lang: string): void {
    if (!running) setRunning(true)
    caption.addFinal(id, text)
    lastRenderKey = ''
    render()
  }

  function addTranslation(id: string, text: string): void {
    caption.setTranslation(id, text)
    lastRenderKey = ''
    render()
  }

  // ---------- 设置 ----------
  function applySettings(s: any): void {
    if (s?.subtitleStyle) style = { ...DEFAULT_STYLE, ...s.subtitleStyle }
    caption.setMaxLines(style.maxLines)
    if (s?.subtitleMode) mode = s.subtitleMode
    lastLayout = ''
    lastRenderKey = ''
    render()
  }

  void (async () => {
    try {
      const got = await chrome.storage.sync.get('settings')
      applySettings(got?.settings)
    } catch {}
  })()
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) applySettings(changes.settings.newValue)
  })

  // ---------- 消息 ----------
  chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (!msg) return
    switch (msg.type) {
      case 'livesub-ping':
        sendResponse({ ok: true })
        return
      case 'engine-state':
        setRunning(!!msg.running)
        return
      case 'subtitle-original':
        caption.clearPartial()
        if (msg.text) addOriginal(String(msg.id), String(msg.text), String(msg.lang ?? ''))
        return
      case 'subtitle-partial':
        if (!msg.text) return
        caption.setPartial(
          String(msg.text),
          msg.zh ? String(msg.zh) : undefined,
          String(msg.lang ?? ''),
        )
        lastRenderKey = ''
        if (!running) setRunning(true)
        render()
        return
      case 'subtitle-translation':
        if (msg.text) addTranslation(String(msg.id), String(msg.text))
        return
      case 'element-capture-start':
        void startElementCapture().then((res) => sendResponse(res))
        return true
      case 'element-capture-stop':
        stopElementCapture()
        sendResponse({ ok: true })
        return
      case 'subtitle-clear':
        caption.clear()
        lastRenderKey = ''
        render()
        return
    }
  })

  // 全屏切换：popover 需要重新 show 才能盖在 fullscreen 元素之上
  document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement
    console.info('[LiveSub] fullscreenchange fs=', fs, 'popoverOpen=', isPopoverOpen())
    if (!running) return
    lastLayout = ''
    if (host && fs) {
      try {
        if (isPopoverOpen()) host.hidePopover()
        host.showPopover()
        console.info('[LiveSub] fullscreen 重新 showPopover 成功')
      } catch (e) {
        console.warn('[LiveSub] fullscreen showPopover 失败:', e instanceof Error ? e.message : String(e))
      }
    }
    showHost()
    render()
  })

  // 页面卸载/刷新时捕获自然会断，content script 随之销毁，无需额外处理
  window.addEventListener('pagehide', () => {
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
    stopElementCapture()
  })

  // 自动恢复：SW 在 start 时也会发 engine-state，但页面刷新后 SW 可能不知道
  // content script 新实例存在；保持静默等待消息即可。
})()
