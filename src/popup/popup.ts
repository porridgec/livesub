// Popup：开始/停止、语言快选、实时电平、最近识别结果与延迟统计。
import { DEFAULT_SETTINGS, mergeSettings, type Settings, type Snapshot } from '../shared/types'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const stateEl = $('state')
const startBtn = $<HTMLButtonElement>('start')
const stopBtn = $<HTMLButtonElement>('stop')
const langSel = $('lang') as unknown as HTMLSelectElement
const meterBar = $('meter-bar')
const linesEl = $('lines')
const statsEl = $('stats')
const engineEl = $('engine')
const detectedEl = $('detected')
const audioEl = $('audio')
const hintEl = $('hint')

const LANG_LABEL: Record<string, string> = { ja: '日语', en: '英语', zh: '中文', ko: '韩语' }

let settings: Settings = structuredClone(DEFAULT_SETTINGS)

function setStateBadge(cls: string, text: string): void {
  stateEl.className = `badge ${cls}`
  stateEl.textContent = text
  stateEl.title = text
}

function setHint(text: string): void {
  hintEl.textContent = text
  hintEl.classList.toggle('hidden', !text)
}

function setDetected(lang: string | undefined): void {
  detectedEl.textContent = lang ? `语种: ${LANG_LABEL[lang] ?? lang}` : ''
}

const AUDIO_LABEL: Record<string, string> = {
  native: '页面原生',
  replay: '扩展回放',
  muted: '页面已静音',
  none: '测试音源',
}
const AUDIO_TITLE: Record<string, string> = {
  native: '直接采集 video 元素音轨，页面声音完全不受影响，音画同步',
  replay: '该站点无法元素采集，回退 tabCapture：页面被静音后由扩展回放，可能有约 100ms 音画延迟',
  muted: '这个标签页本来就被静音了，扩展不会替它出声',
  none: '自动化测试音源',
}

function setAudioMode(mode: string | undefined): void {
  if (!mode) return
  audioEl.textContent = AUDIO_LABEL[mode] ? `音频: ${AUDIO_LABEL[mode]}` : ''
  audioEl.title = AUDIO_TITLE[mode] ?? ''
}

function rmsToWidth(rms: number): number {
  if (rms <= 0) return 0
  // rms → dB（满刻度 0dB），-50dB 以下视为静音
  const db = 20 * Math.log10(rms)
  return Math.min(100, Math.max(0, ((db + 50) / 50) * 100))
}

function addLine(id: string, text: string, lang: string, asrMs: number): void {
  if (linesEl.classList.contains('empty')) {
    linesEl.textContent = ''
    linesEl.classList.remove('empty')
  }
  if (linesEl.childElementCount >= 8) linesEl.lastElementChild?.remove()
  const div = document.createElement('div')
  div.className = 'line'
  div.dataset.id = id
  div.innerHTML = `
    <div class="orig"></div>
    <div class="trans"></div>
    <div class="meta"></div>`
  ;(div.querySelector('.orig') as HTMLElement).textContent = text
  ;(div.querySelector('.meta') as HTMLElement).textContent = `${lang} · ${Math.round(asrMs)}ms`
  linesEl.prepend(div)
}

function fillLine(id: string, zh: string): void {
  const div = linesEl.querySelector(`[data-id="${id}"]`)
  if (div) (div.querySelector('.trans') as HTMLElement).textContent = zh
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return NaN
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

function paintStats(stats: Snapshot['stats']): void {
  if (!stats.total.length && !stats.asr.length) {
    statsEl.textContent = '延迟 —'
    return
  }
  const t = stats.total.length
    ? `总延迟 p50=${Math.round(percentile(stats.total, 50))}ms p95=${Math.round(percentile(stats.total, 95))}ms`
    : ''
  const a = stats.asr.length ? `识别 p50=${Math.round(percentile(stats.asr, 50))}ms` : ''
  statsEl.textContent = `${stats.segments} 句 · ${a}${t ? ' · ' + t : ''}`
}

function paintSnapshot(s: Snapshot): void {
  startBtn.disabled = s.capturing
  stopBtn.disabled = !s.capturing
  setDetected(s.sourceResolved)
  setAudioMode(s.audioMode)
  if (s.engine) engineEl.textContent = `engine: ${s.engine}`
  if (!s.capturing) {
    if (s.offscreen === 'error') setStateBadge('error', `错误：${s.detail ?? ''}`)
    else setStateBadge('idle', '空闲')
    return
  }
  switch (s.offscreen) {
    case 'loading-model':
      setStateBadge('loading-model', s.detail || '模型加载中…')
      break
    case 'capturing':
      setStateBadge('capturing', '识别中')
      break
    case 'error':
      setStateBadge('error', `错误：${s.detail ?? ''}`)
      break
    default:
      setStateBadge('idle', '启动中…')
  }
  if (s.lastLines.length) {
    linesEl.classList.remove('empty')
    linesEl.textContent = ''
    for (const l of [...s.lastLines].reverse()) {
      addLine(l.id, l.original, l.lang, l.asrMs)
      if (l.translated) fillLine(l.id, l.translated)
    }
  }
  paintStats(s.stats)
}

// —— 事件 ——
let startWatchdog: ReturnType<typeof setTimeout> | undefined

function clearWatchdog(): void {
  if (startWatchdog !== undefined) {
    clearTimeout(startWatchdog)
    startWatchdog = undefined
  }
}

function startFail(detail: string): void {
  clearWatchdog()
  setStateBadge('error', detail)
  startBtn.disabled = false
  stopBtn.disabled = true
}

/** 只能采集"用户当前所在"的视频页：tabCapture 依赖 activeTab 授予，换 tab 就必须重新点扩展 */
async function pickActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id) throw new Error('找不到当前标签页')
  if (!/^https?:/i.test(tab.url ?? '')) {
    throw new Error('当前页面无法采集：请切换到要翻译的视频页面，再点击扩展')
  }
  return tab.id
}

/** 在 popup 本地（用户手势所在上下文）取 streamId，不依赖跨上下文手势传播 */
function getMediaStreamId(targetTabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (id) => {
      const err = chrome.runtime.lastError
      if (err || !id) reject(new Error(err?.message ?? '未取得 streamId'))
      else resolve(id)
    })
  })
}

startBtn.addEventListener('click', () => {
  console.info('[LiveSub popup] 点击开始')
  startBtn.disabled = true
  setStateBadge('idle', '启动中…')
  setHint('')
  // 看门狗：长时间收不到任何状态事件，提示去检查扩展错误页
  clearWatchdog()
  startWatchdog = setTimeout(() => {
    setStateBadge('error', '启动超时：请到 chrome://extensions 查看 LiveSub 是否报错，重载扩展后重试')
    startBtn.disabled = false
    stopBtn.disabled = true
  }, 60000)
  void (async () => {
    try {
      const tabId = await pickActiveTabId()
      // 先走页面元素采集（页面声音不受影响、音画同步、不需要 activeTab）；
      // 不可用时再回退 tabCapture（需要用户手势取 streamId）
      let res: any = await chrome.runtime.sendMessage({ target: 'sw', type: 'start-capture', tabId })
      if (res?.needStream) {
        console.info('[LiveSub popup] 元素采集不可用，回退 tabCapture：', res.error)
        const streamId = await getMediaStreamId(tabId)
        console.info('[LiveSub popup] 取到 streamId, tab=', tabId)
        res = await chrome.runtime.sendMessage({ target: 'sw', type: 'start-capture', streamId, tabId })
      }
      if (!res?.ok) startFail(res?.error ?? '启动失败')
    } catch (e) {
      console.warn('[LiveSub popup] 启动失败:', e instanceof Error ? e.message : String(e))
      startFail(e instanceof Error ? e.message : String(e))
    }
  })()
})

stopBtn.addEventListener('click', () => {
  void chrome.runtime.sendMessage({ target: 'sw', type: 'stop-capture' })
})

langSel.addEventListener('change', () => {
  settings.sourceLang = langSel.value as Settings['sourceLang']
  void chrome.storage.sync.set({ settings })
})

$('open-options').addEventListener('click', (e) => {
  e.preventDefault()
  void chrome.runtime.openOptionsPage()
})

// —— 事件 ——
chrome.runtime.onMessage.addListener((msg: any) => {
  if (msg?.target !== 'event') return
  switch (msg.type) {
    case 'level':
      meterBar.style.width = `${rmsToWidth(msg.rms)}%`
      break
    case 'status':
      switch (msg.state) {
        case 'starting':
          clearWatchdog()
          setStateBadge('idle', msg.detail || '启动中…')
          startBtn.disabled = true
          stopBtn.disabled = false
          if (msg.detail && /静音|suspended|未运行/.test(msg.detail)) setHint(msg.detail)
          break
        case 'loading-model':
          clearWatchdog()
          setStateBadge('loading-model', msg.detail || '模型加载中…')
          startBtn.disabled = true
          stopBtn.disabled = false
          break
        case 'capturing':
          clearWatchdog()
          setStateBadge('capturing', '识别中')
          startBtn.disabled = true
          stopBtn.disabled = false
          setDetected(msg.lang)
          break
        case 'error':
          clearWatchdog()
          setStateBadge('error', msg.detail || '错误')
          startBtn.disabled = false
          stopBtn.disabled = true
          break
        case 'idle':
          clearWatchdog()
          setStateBadge('idle', '空闲')
          startBtn.disabled = false
          stopBtn.disabled = true
          meterBar.style.width = '0%'
          setDetected(undefined)
          setAudioMode(undefined)
          break
      }
      if (msg.detail?.startsWith('engine=')) {
        const m = /^engine=(\S+)(?:\s+audio=(\S+))?/.exec(msg.detail)
        if (m) {
          engineEl.textContent = `engine: ${m[1]}`
          if (m[2]) setAudioMode(m[2])
          else if (msg.detail.includes('test-source')) setAudioMode('none')
        }
      }
      break
    case 'asr-final':
      addLine(msg.id, msg.text, msg.lang, msg.asrMs)
      setDetected(msg.lang)
      linesEl.classList.remove('empty')
      break
    case 'translation':
      fillLine(msg.id, msg.text)
      break
    case 'stats':
      paintStats(msg.stats)
      break
    case 'detected-lang':
      setDetected(msg.lang)
      break
    case 'audio-mode':
      setAudioMode(msg.mode)
      break
    case 'ended':
      setStateBadge('idle', `已结束：${msg.reason}`)
      startBtn.disabled = false
      stopBtn.disabled = true
      meterBar.style.width = '0%'
      setDetected(undefined)
      break
  }
})

// —— 初始化 ——
void (async () => {
  const got = await chrome.storage.sync.get('settings')
  settings = mergeSettings(got.settings as Partial<Settings> | undefined)
  langSel.value = settings.sourceLang

  const snap = (await chrome.runtime.sendMessage({ target: 'sw', type: 'get-snapshot' })) as Snapshot
  if (snap) paintSnapshot(snap)
})()
