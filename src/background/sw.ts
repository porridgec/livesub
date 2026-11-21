// Service Worker：只做编排——tabCapture 取流、offscreen 文档生命周期、消息路由、内容脚本注入。
// 不持有 MediaStream、不做推理（MV3 SW 随时会被杀，且无 WebGPU）。
import { mergeSettings, type Settings, type Snapshot } from '../shared/types'

const OFFSCREEN_URL = 'src/offscreen/offscreen.html'
const OVERLAY_SCRIPT = 'assets/subtitle-overlay.js'

interface CapState {
  capturing: boolean
  tabId: number | null
}

const CAP_KEY = 'cap'
const CAP_DEFAULT: CapState = { capturing: false, tabId: null }

// 回调式广播：接收方（popup/SW）不在线不算错误，读 lastError 消掉警告
function broadcast(msg: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError
      resolve(res)
    })
  })
}

// 严格要求接收方在线的发送：lastError 会 reject（用于 offscreen 通信）
function sendToOffscreen(msg: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error(err.message))
      else resolve(res)
    })
  })
}

// offscreen 刚 createDocument 时模块可能还没加载完，消息会被静默丢弃——
// ping-pong 握手直到它响应为止；boot.js 黑匣子会让真实报错可见
async function waitOffscreenReady(timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let bootAlive = false
  while (Date.now() < deadline) {
    let res: any = null
    try {
      res = await sendToOffscreen({ target: 'offscreen', type: 'ping' })
    } catch {
      // 尚未就绪，稍后重试
    }
    if (res?.type === 'pong') return
    if (res?.type === 'pong-boot') {
      bootAlive = true
      break
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  if (bootAlive) {
    const got = await chrome.storage.session.get('offErr')
    const bootErr = got['offErr'] as string | undefined
    throw new Error(
      bootErr
        ? `offscreen 引擎模块崩溃：${bootErr}`
        : 'offscreen 引擎模块未在超时内完成加载（无捕获到错误详情）',
    )
  }
  throw new Error('offscreen 引擎文档未响应（可能加载失败，请检查扩展错误页）')
}

async function getCap(): Promise<CapState> {
  const got = await chrome.storage.session.get(CAP_KEY)
  return (got[CAP_KEY] as CapState) ?? CAP_DEFAULT
}

async function setCap(cap: CapState): Promise<void> {
  await chrome.storage.session.set({ [CAP_KEY]: cap })
}

// offscreen 文档里只有 chrome.runtime 可用（官方限制），设置须经 SW 中转
async function readSettings(): Promise<Settings> {
  const got = await chrome.storage.sync.get('settings')
  return mergeSettings(got['settings'] as Partial<Settings> | undefined)
}

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  })
  if (contexts.length === 0) {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: '采集当前标签页音频、回放声音并本地识别生成实时双语字幕',
      })
    } catch (e) {
      // 并发创建时可能撞上"仅允许一个文档"，该情况视为成功；其余真实报错要抛出
      if (!String(e).includes('single offscreen document')) throw e
    }
  }
}

async function trySendTab(tabId: number | null, msg: unknown): Promise<void> {
  if (tabId == null) return
  try {
    // 不带 frameId 时 Chrome 会把消息发给该 tab 的所有 frame（覆盖 iframe 里的视频）
    await chrome.tabs.sendMessage(tabId, msg)
  } catch {
    // 目标页没有内容脚本（如 chrome:// 页面），忽略
  }
}

/** 用户可能在上次加载扩展前就打开了页面：内容脚本不在时动态注入（脚本自身防重入） */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const res: any = await chrome.tabs.sendMessage(tabId, { type: 'livesub-ping' })
    if (res?.ok) return
  } catch {
    // 没有接收方，继续注入
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [OVERLAY_SCRIPT] })
  } catch (e) {
    console.warn('[LiveSub] 注入字幕覆盖层失败：', e instanceof Error ? e.message : e)
  }
}

// 类型库未提供 Promise 重载，手动包一层
function getMediaStreamId(options: { targetTabId: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId(options, (streamId: string) => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error(err.message))
      else resolve(streamId)
    })
  })
}

/** 找有可见 video 的 frame（取面积最大的那个；iframe 里的视频也能定位） */
async function findVideoFrame(tabId: number): Promise<number | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        let best = 0
        for (const v of Array.from(document.querySelectorAll('video'))) {
          const r = (v as HTMLVideoElement).getBoundingClientRect()
          const area = r.width * r.height
          if (area > best) best = area
        }
        return best
      },
    })
    let best: { frameId: number; area: number } | null = null
    for (const r of results) {
      const area = Number(r.result ?? 0)
      if (area > 0 && (!best || area > best.area)) best = { frameId: r.frameId, area }
    }
    return best?.frameId ?? null
  } catch (e) {
    console.warn('[LiveSub] 查找 video frame 失败：', e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * 首选路径：内容脚本直接抓 <video> 元素音轨（captureStream）。
 * 页面声音完全不受影响 → 没有 tabCapture 的静音/回放延迟，也不需要 activeTab。
 */
async function tryStartElementCapture(
  tabId: number,
  settings: Settings,
): Promise<{ ok: boolean; error?: string }> {
  const frameId = await findVideoFrame(tabId)
  if (frameId == null) {
    console.info('[LiveSub] 页面没有可见 video，元素采集不可用')
    return { ok: false, error: '页面没有可见的 video' }
  }
  await ensureContentScript(tabId)
  await ensureOffscreen()
  await waitOffscreenReady()
  await chrome.storage.session.remove('offErr').catch(() => {})
  // 先让 offscreen 进入元素模式（模型开始加载），内容的片段会在 offscreen 里排队
  await sendToOffscreen({ target: 'offscreen', type: 'start-element', tabId, settings })
  const res = await new Promise<any>((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'element-capture-start', settings }, { frameId }, (r) => {
      const err = chrome.runtime.lastError
      void err
      resolve(err ? null : r)
    })
  })
  if (!res?.ok) {
    console.warn('[LiveSub] 元素采集启动失败：', res?.error ?? '无响应')
    await sendToOffscreen({ target: 'offscreen', type: 'stop' }).catch(() => {})
    return { ok: false, error: String(res?.error ?? '内容脚本无响应') }
  }
  await setCap({ capturing: true, tabId })
  await trySendTab(tabId, { type: 'engine-state', running: true })
  return { ok: true }
}

async function getActiveCapturableTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id) throw new Error('找不到当前标签页')
  if (!/^https?:/i.test(tab.url ?? '')) {
    throw new Error('当前标签页无法采集音频：请切换到要翻译的视频页面，再点击扩展图标')
  }
  return tab
}

async function startCapture(pre?: {
  streamId?: string
  tabId?: number
}): Promise<{ ok: boolean; error?: string; needStream?: boolean }> {
  console.info('[LiveSub] startCapture', pre?.streamId ? 'tabCapture streamId' : '优先元素采集')
  try {
    const existing = await getCap()
    if (existing.capturing) await stopCapture()

    let tabId = pre?.tabId
    if (tabId == null) {
      // 热键路径：SW 收到 commands.onCommand 时自带本地手势
      const tab = await getActiveCapturableTab()
      tabId = tab.id!
    }
    const settings = await readSettings()

    // 1) 元素采集（音画同步，无静音）
    if (!pre?.streamId) {
      const el = await tryStartElementCapture(tabId, settings)
      if (el.ok) return { ok: true }
      if (pre?.tabId != null) {
        // popup 路径：元素采集不可用，请 popup 用用户手势取 tabCapture streamId 后重试
        return { ok: false, needStream: true, error: `元素采集不可用：${el.error ?? '未知原因'}` }
      }
    }

    // 2) 回退 tabCapture（页面会被静音，扩展回放，可能有音画延迟）
    let streamId = pre?.streamId
    if (!streamId) streamId = await getMediaStreamId({ targetTabId: tabId })
    await ensureOffscreen()
    await waitOffscreenReady()
    await chrome.storage.session.remove('offErr').catch(() => {})
    await sendToOffscreen({ target: 'offscreen', type: 'start', streamId, tabId, settings })
    await setCap({ capturing: true, tabId })
    await ensureContentScript(tabId)
    await trySendTab(tabId, { type: 'engine-state', running: true })
    return { ok: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.warn('[LiveSub] startCapture 失败:', error)
    await setCap(CAP_DEFAULT)
    // popup 靠 event 消息渲染状态，失败也要广播
    await broadcast({ target: 'event', type: 'status', state: 'error', detail: error })
    return { ok: false, error }
  }
}

/** 仅供测试/手动：只走元素采集路径 */
async function startElementOnly(): Promise<{ ok: boolean; error?: string }> {
  try {
    const existing = await getCap()
    if (existing.capturing) await stopCapture()
    const tab = await getActiveCapturableTab()
    const r = await tryStartElementCapture(tab.id!, await readSettings())
    return r.ok ? { ok: true } : { ok: false, error: `元素采集不可用：${r.error ?? '未知原因'}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function stopCapture(): Promise<{ ok: boolean }> {
  const cap = await getCap()
  try {
    await trySendTab(cap.tabId, { type: 'element-capture-stop' })
  } catch {
    // 忽略
  }
  try {
    await sendToOffscreen({ target: 'offscreen', type: 'stop' })
  } catch {
    // offscreen 可能已关闭
  }
  // offscreen 停掉 MediaStream 轨道即结束捕获（tabCapture 无独立 stop API）
  await setCap({ capturing: false, tabId: null })
  await trySendTab(cap.tabId, { type: 'engine-state', running: false })
  // popup 可能开着，同步状态
  await broadcast({ target: 'event', type: 'status', state: 'idle', detail: '' })
  return { ok: true }
}

/** 捕获中的 tab 被刷新/关闭时，capture 已随流结束，这里把扩展状态收干净 */
async function stopIfCaptureTab(tabId: number): Promise<void> {
  const cap = await getCap()
  if (!cap.capturing || cap.tabId !== tabId) return
  await stopCapture()
}

async function buildSnapshot(): Promise<Snapshot> {
  const cap = await getCap()
  const base: Snapshot = {
    capturing: cap.capturing,
    tabId: cap.tabId,
    offscreen: 'idle',
    lastLines: [],
    stats: { asr: [], trans: [], total: [], segments: 0 },
  }
  if (!cap.capturing) return base
  try {
    const off = (await sendToOffscreen({ target: 'offscreen', type: 'snapshot' })) as
      | Partial<Snapshot>
      | undefined
    return { ...base, ...off }
  } catch {
    // offscreen 无响应（可能刚被回收），下次 start 会重建
    await setCap({ capturing: false, tabId: cap.tabId })
    return { ...base, capturing: false }
  }
}

chrome.runtime.onMessage.addListener((msg: any, _sender, _sendResponse) => {
  if (msg?.target === 'sw') {
    switch (msg.type) {
      case 'start-capture':
        return startCapture({ streamId: msg.streamId, tabId: msg.tabId })
      case 'start-element':
        return startElementOnly()
      case 'stop-capture':
        return stopCapture()
      case 'get-snapshot':
        // popup 打开时顺带预热 offscreen，用户点击开始时可立即消费 streamId
        void ensureOffscreen().catch(() => {})
        return buildSnapshot()
    }
    return
  }
  if (msg?.target === 'event') {
    // offscreen 广播的事件：字幕相关转发给目标 tab
    void (async () => {
      const cap = await getCap()
      switch (msg.type) {
        case 'asr-final':
          await trySendTab(cap.tabId, {
            type: 'subtitle-original',
            id: msg.id,
            text: msg.text,
            lang: msg.lang,
          })
          break
        case 'asr-partial':
          await trySendTab(cap.tabId, { type: 'subtitle-partial', id: 'partial', text: msg.text, zh: msg.zh, lang: msg.lang })
          break
        case 'translation':
          await trySendTab(cap.tabId, { type: 'subtitle-translation', id: msg.id, text: msg.text })
          break
        case 'status':
          if (msg.state === 'capturing') {
            await trySendTab(cap.tabId, { type: 'engine-state', running: true })
          } else if (msg.state === 'error') {
            // 引擎挂了就别再显示"捕获中"，否则用户点不了开始
            await setCap(CAP_DEFAULT)
            await trySendTab(cap.tabId, { type: 'engine-state', running: false })
          }
          break
        case 'offscreen-boot-error':
          // 黑匣子：offscreen 模块崩溃的真实报错，存储供握手超时消息引用，并直接透传到 popup
          await chrome.storage.session.set({ offErr: msg.detail })
          await broadcast({ target: 'event', type: 'status', state: 'error', detail: `offscreen 模块崩溃：${msg.detail}` })
          break
        case 'offscreen-boot-log':
          // 库日志（onnxruntime/transformers 的 console 输出）：仅存储，不打断启动
          await chrome.storage.session.set({ offErr: msg.detail })
          break
        case 'ended':
          await setCap(CAP_DEFAULT)
          await trySendTab(msg.tabId ?? null, { type: 'engine-state', running: false })
          break
      }
    })()
  }
  // 其余（target 'offscreen' 等）与本上下文无关，不返回值
})

chrome.runtime.onInstalled.addListener(() => {
  void setCap(CAP_DEFAULT)
})

// 热键开关（manifest.commands：Ctrl+Shift+L）
chrome.commands.onCommand.addListener((command) => {
  console.info('[LiveSub] 收到热键命令:', command)
  if (command !== 'toggle-capture') return
  void (async () => {
    const cap = await getCap()
    if (cap.capturing) await stopCapture()
    else await startCapture()
  })()
})

// tab 刷新/关闭：tabCapture 流会断，主动收尾，避免 popup 一直显示"识别中"
chrome.tabs.onRemoved.addListener((tabId) => {
  void stopIfCaptureTab(tabId)
})
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') void stopIfCaptureTab(tabId)
})

// 启动自检：确认热键已注册
void chrome.commands.getAll().then((cs) => {
  console.info('[LiveSub] 已注册命令:', JSON.stringify(cs))
})

// 设置变更时转发给 offscreen（它自己读不到 storage）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.settings) return
  void sendToOffscreen({
    target: 'offscreen',
    type: 'settings',
    settings: mergeSettings(changes.settings.newValue),
  }).catch(() => {})
})
