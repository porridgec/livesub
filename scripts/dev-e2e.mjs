#!/usr/bin/env node
// 端到端自测：用 Chrome for Testing（支持 --load-extension）加载 dist/，
// 打开本地测试页播放音频，以标签页形式打开 popup 并点击「开始字幕」，
// 验证：音频采集 → Whisper 识别 → 中文翻译 → 页面视频上出现双语覆盖层，并截图留证。
// 用法: node scripts/dev-e2e.mjs [--lang ja|en] [--dur 120] [--keep]
import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const ART = join(ROOT, 'test', 'artifacts')
const PORT = 8123
const DEBUG_PORT = 9223

const argv = process.argv.slice(2)
const getArg = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : def
}
const LANG = getArg('--lang', 'ja')
const DUR = Number(getArg('--dur', 120))
const MODE = getArg('--mode', 'file') // file: 绕过 tabCapture 喂本地音频；popup: 真实点击开始（需要真人授予 activeTab）
const MODEL = getArg('--model', 'sensevoice')
const GLOSSARY = getArg('--glossary', '')
const PAGE_URL = getArg('--url', `http://127.0.0.1:${PORT}/`)
const IS_LOCAL_PAGE = PAGE_URL.includes(`127.0.0.1:${PORT}`)
const KEEP = argv.includes('--keep')
if (!['ja', 'en'].includes(LANG)) throw new Error('--lang 只支持 ja / en')
if (!['file', 'popup', 'hotkey', 'element'].includes(MODE)) throw new Error('--mode 只支持 file / popup / hotkey / element')
if (!['sensevoice', 'tiny', 'base'].includes(MODEL)) throw new Error('--model 只支持 sensevoice / tiny / base')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[e2e]', ...a)
mkdirSync(ART, { recursive: true })

// ---------- 静态服务器（serves test/） ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.js': 'text/javascript',
  '.css': 'text/css',
}
const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let p = join(ROOT, 'test', pathname)
  let data = null
  try {
    data = readFileSync(p)
  } catch {
    // 目录请求回退 index.html
    try {
      p = join(p, 'index.html')
      data = readFileSync(p)
    } catch {
      res.writeHead(404)
      res.end('404')
      return
    }
  }
  // 注意：MIME 表的 key 带点（'.html'），直接取扩展名会漏掉 → Chrome 会把页面当下载
  const ext = '.' + p.split('.').pop().toLowerCase()
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' })
  res.end(data)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
log(`测试服务 http://127.0.0.1:${PORT}/`)

// ---------- CDP 助手 ----------
async function jsonList() {
  return (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
}

function attach(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  const handlers = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? rej(new Error(m.error.message)) : res(m.result)
    } else if (m.method) {
      for (const h of handlers) h(m)
    }
  }
  const ready = new Promise((res, rej) => {
    ws.onopen = () => res()
    ws.onerror = () => rej(new Error('ws error: ' + wsUrl))
  })
  ready.catch(() => {})
  const send = (method, params = {}, sessionId) => {
    const id = ++seq
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
    return new Promise((res, rej) => pending.set(id, { res, rej }))
  }
  return { ready, send, onEvent: (h) => handlers.push(h) }
}

async function attachRetry(wsUrl, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const t = attach(wsUrl)
    try {
      await t.ready
      return t
    } catch {
      await sleep(300)
    }
  }
  throw new Error('attach 失败: ' + wsUrl)
}

let browser = null
const sessionHandlers = new Map()
async function initBrowserSession() {
  const verInfo = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()
  browser = await attachRetry(verInfo.webSocketDebuggerUrl)
  browser.onEvent((m) => {
    if (m.sessionId && sessionHandlers.has(m.sessionId)) {
      for (const h of sessionHandlers.get(m.sessionId)) h(m)
    }
  })
}
async function attachSession(targetId, tries = 10) {
  if (!browser) await initBrowserSession()
  let sessionId = null
  for (let i = 0; i < tries; i++) {
    try {
      const r = await browser.send('Target.attachToTarget', { targetId, flatten: true })
      sessionId = r.sessionId
      break
    } catch (e) {
      if (i === tries - 1) throw new Error('attachToTarget 失败: ' + String(e).slice(0, 120))
      await sleep(300)
    }
  }
  sessionHandlers.set(sessionId, [])
  return {
    send(method, params = {}) {
      return browser.send(method, params, sessionId)
    },
    onEvent(h) {
      sessionHandlers.get(sessionId).push(h)
    },
  }
}

async function openTab(url) {
  if (!browser) await initBrowserSession()
  const r = await browser.send('Target.createTarget', { url })
  return { id: r.targetId }
}

async function findTarget(pred, tries = 80, delay = 250) {
  for (let i = 0; i < tries; i++) {
    const list = await jsonList()
    const t = list.find(pred)
    if (t) return t
    await sleep(delay)
  }
  return null
}

function strArgs(args) {
  return args
    .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
    .join(' ')
    .replace(/\x1b\[[0-9;]*m/g, '')
}

async function evaluate(session, expression, awaitPromise = true, userGesture = false) {
  try {
    const r = await session.send('Runtime.evaluate', { expression, awaitPromise, userGesture, returnByValue: true })
    return r?.result?.value
  } catch {
    return undefined
  }
}

// ---------- 启动 Chrome ----------
const profile = mkdtempSync(join(tmpdir(), 'livesub-e2e-'))
const cftRoot = join(ROOT, '.browser')
function findCftBinary() {
  if (!existsSync(cftRoot)) return null
  for (const channel of readdirSync(cftRoot)) {
    for (const ver of readdirSync(join(cftRoot, channel))) {
      const p = join(
        cftRoot,
        channel,
        ver,
        'chrome-mac-arm64',
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing',
      )
      if (existsSync(p)) return p
    }
  }
  return null
}
const chromeBin = process.env.CHROME_BIN || findCftBinary()
if (!chromeBin || !existsSync(chromeBin)) {
  log('未找到 Chrome for Testing（品牌版 Chrome 136+ 已禁用 --load-extension）。')
  log('执行: npx @puppeteer/browsers install chrome@stable --path .browser')
  process.exit(1)
}
log('使用浏览器:', chromeBin)
// 清理上次异常退出残留的实例
try {
  execSync(`pkill -f 'user-data-dir=${tmpdir()}/livesub-e2e-'`, { timeout: 3000 })
  await sleep(500)
} catch {}
const chrome = spawn(chromeBin, [
  `--user-data-dir=${profile}`,
  `--load-extension=${DIST}`,
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--window-size=1280,900',
  '--no-first-run',
  '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  'about:blank',
])
const cleanup = () => {
  try {
    chrome.kill('SIGTERM')
  } catch {}
  server.close()
  if (!KEEP) {
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {}
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(130))

// 等调试端口
let up = false
for (let i = 0; i < 60 && !up; i++) {
  try {
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    up = true
  } catch {
    await sleep(250)
  }
}
if (!up) {
  log('Chrome 调试端口未就绪，退出')
  process.exit(1)
}

// 找到扩展 SW，取扩展 id
const swTarget = await findTarget(
  (t) => (t.url || '').startsWith('chrome-extension://') && t.url.endsWith('/assets/sw.js'),
)
if (!swTarget) {
  log('FAIL: 扩展 service worker 未注册（--load-extension 未生效？）')
  process.exit(1)
}
const EXT_ID = new URL(swTarget.url).host
log('扩展 id:', EXT_ID)

const sw = await attachSession(swTarget.id)
await sw.send('Runtime.enable')
sw.onEvent((m) => {
  if (m.method === 'Runtime.consoleAPICalled') {
    const line = strArgs(m.params.args)
    if (line) log(`[sw:${m.params.type}]`, line)
  } else if (m.method === 'Runtime.exceptionThrown') {
    log('[sw:exception]', m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text)
  }
})

log('commands:', await evaluate(sw, `chrome.commands.getAll().then((c) => JSON.stringify(c))`))

// ---------- 测试页 ----------
const testTab = await openTab(PAGE_URL)
await sleep(1200)
const testTarget = await findTarget((t) => {
  if (t.type !== 'page') return false
  if (IS_LOCAL_PAGE) return (t.url || '').includes(`127.0.0.1:${PORT}`)
  try {
    return new URL(t.url).host === new URL(PAGE_URL).host
  } catch {
    return false
  }
}, 30, 300)
if (!testTarget) {
  log('FAIL: 测试页 target 未找到')
  process.exit(1)
}
// tabCapture 只能在「用户当前所在的 tab」上取流，必须先把测试页激活/置前
await browser.send('Target.activateTarget', { targetId: testTarget.id })
await sleep(600)
const activeInfo = await evaluate(
  sw,
  `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => JSON.stringify(t.map((x) => ({ id: x.id, url: x.url }))))`,
)
log('当前激活 tab:', activeInfo)

const testPage = await attachSession(testTarget.id)
await testPage.send('Runtime.enable')
testPage.onEvent((m) => {
  if (m.method === 'Runtime.consoleAPICalled') {
    const line = strArgs(m.params.args)
    if (line && line.includes('LiveSub')) log(`[page:${m.params.type}]`, line.slice(0, 300))
  }
})
const videoIndex = LANG === 'ja' ? 1 : 0
log(`测试语种: ${LANG}（${IS_LOCAL_PAGE ? `video[${videoIndex}]` : '页面最大视频'}）`)

const videoInfo = await evaluate(
  testPage,
  `(() => {
    const vids = [...document.querySelectorAll('video')]
    let v = ${IS_LOCAL_PAGE ? `vids[${videoIndex}]` : 'null'}
    if (!v) {
      v = vids.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
        return rb.width * rb.height - ra.width * ra.height
      })[0]
    }
    if (!v) return 'no-video'
    vids.forEach((x) => x.pause())
    v.scrollIntoView({ block: 'center' })
    v.loop = true
    v.muted = ${MODE === 'file' ? 'true' : 'false'}
    v.volume = 1
    if (${MODE === 'element' ? 'true' : 'false'}) {
      v.currentTime = 0
      return 'ready ' + (v.currentSrc || v.src).split('/').pop() + '（等采集就绪后播放）'
    }
    return v.play().then(() => 'playing ' + (v.currentSrc || v.src).split('/').pop()).catch((e) => 'ERR ' + e.message)
  })()`,
)
log('测试页播放:', videoInfo)
if (String(videoInfo).startsWith('ERR') || videoInfo === 'no-video') {
  log('FAIL: 测试视频无法播放')
  process.exit(1)
}

// ---------- popup（预热 offscreen；file 模式还用它发测试音源 / 停止） ----------
// chrome.action.openPopup 需要有一个激活的浏览器窗口；测试里先把 Chrome 置前
try {
  execSync(`osascript -e 'tell application "Google Chrome for Testing" to activate'`, { timeout: 5000 })
  await sleep(600)
} catch {}
let popup = null
let widget = null
if (MODE !== 'hotkey') {
  const popupOpen = await evaluate(sw, `chrome.action.openPopup().then(() => 'opened').catch((e) => 'REJECTED: ' + e.message)`)
  log('openPopup:', popupOpen)
  widget = await findTarget((t) => (t.url || '').includes('/src/popup/popup.html'), 16, 300)
  if (!widget) {
    log('FAIL: popup 弹窗 target 未出现')
    process.exit(1)
  }
  await sleep(600)
  popup = await attachSession(widget.id)
  await popup.send('Runtime.enable')
  popup.onEvent((m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      const line = strArgs(m.params.args)
      if (line) log(`[popup:${m.params.type}]`, line.slice(0, 200))
    }
  })
}

let badge = ''

async function readBadge() {
  const v = await evaluate(popup, `(() => { const s = document.getElementById('state'); return s ? s.className + ' | ' + s.textContent : 'no-popup' })()`)
  if (v && v !== badge) {
    badge = v
    log('[popup badge]', badge)
  }
}

async function clickInPopup(selector) {
  if (!popup) return false
  const rect = await evaluate(
    popup,
    `(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return null; const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled }) })()`,
  )
  if (!rect) return false
  const pos = JSON.parse(rect)
  if (pos.disabled) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await popup.send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  }
  return true
}

async function attachOffscreen() {
  const t = await findTarget((x) => (x.url || '').includes('offscreen.html'), 80, 250)
  if (!t) return null
  const s = await attachSession(t.id)
  await s.send('Runtime.enable')
  s.onEvent((m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      const line = strArgs(m.params.args)
      if (!line) return
      if (/Unable to (add|determine)|MarianTokenizer/.test(line)) return
      log(`[off:${m.params.type}]`, line.slice(0, 300))
    } else if (m.method === 'Runtime.exceptionThrown') {
      log('[off:exception]', (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 400))
    }
  })
  for (let i = 0; i < 80; i++) {
    if (await evaluate(s, '!!window.__livesubModuleReady')) break
    await sleep(250)
  }
  return s
}

let off = null
if (MODE !== 'hotkey') off = await attachOffscreen()
if (!off && MODE !== 'hotkey') {
  log('FAIL: offscreen 文档未创建（SW 预热失败？看上方 sw 日志）')
  process.exit(1)
}

await sleep(400)
if (MODE === 'popup') {
  if (!(await clickInPopup('#start'))) {
    log('FAIL: 开始按钮不可点击')
    process.exit(1)
  }
  log('已在真实 popup 中点击「开始字幕」')
} else if (MODE === 'element') {
  const r = await evaluate(
    popup,
    `chrome.runtime.sendMessage({ target: 'sw', type: 'start-element' }).then((r) => JSON.stringify(r)).catch((e) => 'ERR ' + e.message)`,
  )
  log('元素采集启动结果:', r)
  // 采集就绪后再开始播放，保证第一段就是完整句子（真实使用中点开始后视频继续播，第一句可能不完整）
  const playRes = await evaluate(
    testPage,
    `(async () => { const v = document.querySelectorAll('video')[${videoIndex}]; await v.play(); return 'playing ' + v.paused })()`,
  )
  log('元素采集后开始播放:', playRes)
} else if (MODE === 'hotkey') {
  // 真实用户手势：用 AppleScript 按下扩展快捷键，验证 tabCapture 完整链路
  try {
    execSync(`osascript -e 'tell application "Google Chrome for Testing" to activate'`, { timeout: 5000 })
    await sleep(700)
    execSync(`osascript -e 'tell application "System Events" to key code 37 using {command down, shift down}'`, { timeout: 5000 })
    log('已发送 Command+Shift+L')
  } catch (e) {
    log('FAIL: 无法发送快捷键:', String(e).slice(0, 200))
    process.exit(1)
  }
  off = await attachOffscreen()
  if (!off) {
    log('FAIL: offscreen 文档未创建（热键没触发 startCapture？）')
    process.exit(1)
  }
} else {
  // file 模式：CDP 合成点击拿不到 tabCapture 需要的 activeTab 授权，
  // 这里直接让 offscreen 解码本地音频喂同一套 VAD→ASR→翻译管线
  const startRes = await evaluate(
    popup,
    `(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      if (!tab?.id) return 'no-tab'
      await chrome.storage.session.set({ cap: { capturing: true, tabId: tab.id } })
      const got = await chrome.storage.sync.get('settings')
      const settings = { ...(got.settings ?? {}), asrModel: '${MODEL}', glossary: ${JSON.stringify(GLOSSARY)} }
      const url = 'http://127.0.0.1:${PORT}/media/${LANG}.m4a'
      const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start-test', url, tabId: tab.id, settings })
      return JSON.stringify({ tabId: tab.id, res })
    })()`,
  )
  log('文件音源启动:', startRes)
}
off.onEvent((m) => {
  if (m.method === 'Runtime.consoleAPICalled') {
    const line = strArgs(m.params.args)
    if (!line) return
    if (/Unable to (add|determine)|MarianTokenizer/.test(line)) return
    log(`[off:${m.params.type}]`, line.slice(0, 300))
  } else if (m.method === 'Runtime.exceptionThrown') {
    log(
      '[off:exception]',
      (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 400),
    )
  }
})

// ---------- 监控 ----------
const t0 = Date.now()
const saw = { capturing: false, rms: false, playback: false, native: false, text: false, trans: false, overlay: false, fullscreen: false }
let shotTaken = false
let stopped = false
let lastLineCount = 0

const overlayExpr = `(() => {
  const host = document.getElementById('livesub-subtitle-host')
  if (!host || !host.shadowRoot) return JSON.stringify({ found: false })
  const panel = host.shadowRoot.querySelector('.panel')
  const texts = [...host.shadowRoot.querySelectorAll('.orig,.trans')].map((e) => e.textContent).filter(Boolean)
  const r = host.getBoundingClientRect()
  const vids = [...document.querySelectorAll('video')].filter((x) => x.readyState > 0)
  const playing = vids.filter((x) => !x.paused && !x.ended)
  const pool = playing.length ? playing : vids
  const v = pool.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
    return rb.width * rb.height - ra.width * ra.height
  })[0] || document.querySelector('video')
  const vr = v ? v.getBoundingClientRect() : null
  return JSON.stringify({
    found: true,
    visible: getComputedStyle(host).display !== 'none' && !!panel && !panel.classList.contains('hidden'),
    texts,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    video: vr ? { x: Math.round(vr.x), y: Math.round(vr.y), w: Math.round(vr.width), h: Math.round(vr.height) } : null,
    fullscreen: !!document.fullscreenElement,
  })
})()`

async function capture(via, name) {
  try {
    const shot = await via.send('Page.captureScreenshot', { format: 'png' })
    const file = join(ART, name)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    log('截图:', file)
    return file
  } catch (e) {
    log('截图失败:', String(e).slice(0, 120))
    return null
  }
}

while (Date.now() - t0 < DUR * 1000) {
  await sleep(1500)
  await readBadge()
  const dbgRaw = await evaluate(off, 'window.__livesubDebug ? JSON.stringify(window.__livesubDebug()) : "no-hook"')
  const ovRaw = await evaluate(testPage, overlayExpr)
  let dbg = null
  let ov = null
  try {
    if (dbgRaw && dbgRaw !== 'no-hook') dbg = JSON.parse(dbgRaw)
  } catch {}
  try {
    if (ovRaw) ov = JSON.parse(ovRaw)
  } catch {}

  if (dbg?.state === 'capturing') saw.capturing = true
  if ((dbg?.peakRms ?? dbg?.lastRms ?? 0) > 0.001) saw.rms = true
  if (dbg?.playbackOk && (dbg?.playbackRms ?? 0) > 0.0005) saw.playback = true
  if (dbg?.state === 'capturing' && dbg?.audioMode === 'native') saw.native = true
  const lines = dbg?.lastLines ?? []
  if (lines.some((l) => l.original)) saw.text = true
  if (lines.some((l) => l.translated)) saw.trans = true
  if (ov?.visible && ov?.texts?.length) {
    // 覆盖层必须贴在视频区域上（误差 2px 内）
    const onVideo =
      ov.video &&
      Math.abs(ov.rect.x - ov.video.x) <= 2 &&
      Math.abs(ov.rect.y - ov.video.y) <= 2 &&
      Math.abs(ov.rect.w - ov.video.w) <= 2
    if (onVideo) saw.overlay = true
  }

  const newest = lines[0]
  log(
    `t+${Math.round((Date.now() - t0) / 1000)}s state=${dbg?.state} audio=${dbg?.audioMode ?? '?'} coi=${dbg?.crossOriginIsolated} threads=${dbg?.wasmThreads} ` +
      `rms=${dbg?.lastRms?.toFixed(4)} vad=${dbg?.vad} words=${dbg?.words} partials=${dbg?.partials}/${dbg?.partialsZh} lang=${dbg?.activeLang} segs=${dbg?.stats?.segments}`,
  )
  if (newest && lines.length > lastLineCount) {
    lastLineCount = lines.length
    log('  └ 最新:', JSON.stringify(newest))
  }
  if (ov?.found) log('  └ 覆盖层:', JSON.stringify({ visible: ov.visible, texts: ov.texts, rect: ov.rect }))

  if (!shotTaken && saw.text && saw.trans && saw.overlay && (dbg?.stats?.segments ?? 0) >= 2) {
    await capture(testPage, `overlay-${LANG}.png`)
    if (popup) await capture(popup, `popup-${LANG}.png`)
    shotTaken = true
  }

  if (saw.capturing && saw.rms && saw.playback && saw.text && saw.trans && saw.overlay) break
  if (dbg?.state === 'error') {
    log('引擎报错，停止等待:', dbg.stateDetail)
    break
  }
}

// ---------- 全屏覆盖层 ----------
if (shotTaken) {
  log('——— 全屏测试 ———')
  // 全屏需要文档有焦点 + 用户手势：激活页面后用 userGesture 的 evaluate 调 requestFullscreen
  await browser.send('Target.activateTarget', { targetId: testTarget.id })
  await sleep(500)
  const fsResult = await evaluate(
    testPage,
    `(() => { const v = [...document.querySelectorAll('video')].find((x) => !x.paused) || document.querySelector('video'); return v.requestFullscreen().then(() => 'ok').catch((e) => 'ERR ' + e.message) })()`,
    true,
    true,
  )
  log('requestFullscreen:', fsResult)
  if (fsResult !== 'ok') {
    log('全屏状态:', await evaluate(testPage, `document.getElementById('fs-state')?.textContent ?? ''`))
  }
  await sleep(1200)
  if (fsResult === 'ok') {
    const fsState = await evaluate(testPage, `JSON.stringify({ fullscreen: !!document.fullscreenElement, tag: document.fullscreenElement?.tagName ?? null })`)
    log('全屏状态:', fsState)
    const ovFsRaw = await evaluate(testPage, overlayExpr)
    if (ovFsRaw) {
      const ovFs = JSON.parse(ovFsRaw)
      log('全屏覆盖层:', JSON.stringify({ visible: ovFs.visible, texts: ovFs.texts, rect: ovFs.rect, video: ovFs.video }))
      saw.fullscreen = !!ovFs.fullscreen && !!ovFs.visible
      await capture(testPage, `fullscreen-${LANG}.png`)
    }
    await evaluate(testPage, `document.exitFullscreen ? document.exitFullscreen().catch(() => {}) : null`)
    await sleep(600)
  }
}

// ---------- 停止 ----------
if (saw.capturing) {
  if (MODE === 'hotkey') {
    try {
      execSync(`osascript -e 'tell application "Google Chrome for Testing" to activate'`, { timeout: 5000 })
      await sleep(500)
      execSync(`osascript -e 'tell application "System Events" to key code 37 using {command down, shift down}'`, { timeout: 5000 })
    } catch {}
    await sleep(1500)
    let dbgRaw = await evaluate(off, 'window.__livesubDebug ? JSON.stringify(window.__livesubDebug()) : "no-hook"')
    let dbg = null
    try { if (dbgRaw && dbgRaw !== 'no-hook') dbg = JSON.parse(dbgRaw) } catch {}
    if (dbg?.state !== 'idle') {
      // 快捷键没注册时回退到 popup 停止
      await evaluate(sw, `chrome.action.openPopup().then(() => 'opened').catch(() => 'fail')`)
      const w = await findTarget((t) => (t.url || '').includes('/src/popup/popup.html'), 10, 250)
      if (w) {
        popup = await attachSession(w.id)
        await popup.send('Runtime.enable')
        await sleep(500)
        await clickInPopup('#stop')
        await sleep(1200)
      }
    }
    const ovRaw = await evaluate(testPage, overlayExpr)
    let ov = null
    try { if (ovRaw) ov = JSON.parse(ovRaw) } catch {}
    dbgRaw = await evaluate(off, 'window.__livesubDebug ? JSON.stringify(window.__livesubDebug()) : "no-hook"')
    try { if (dbgRaw && dbgRaw !== 'no-hook') dbg = JSON.parse(dbgRaw) } catch {}
    stopped = dbg?.state === 'idle' && !(ov?.visible ?? false)
    log('停止后:', JSON.stringify({ state: dbg?.state, overlayVisible: ov?.visible ?? null }))
  } else {
  const reopened = await evaluate(sw, `chrome.action.openPopup().then(() => 'opened').catch((e) => 'fail ' + e.message)`)
  log('重开 popup 以停止:', reopened)
  widget = await findTarget((t) => (t.url || '').includes('/src/popup/popup.html'), 10, 250)
  if (widget) {
    popup = await attachSession(widget.id)
    await popup.send('Runtime.enable')
    await sleep(500)
    if (await clickInPopup('#stop')) {
      await sleep(1200)
      const dbgRaw = await evaluate(off, 'window.__livesubDebug ? JSON.stringify(window.__livesubDebug()) : "no-hook"')
      const ovRaw = await evaluate(testPage, overlayExpr)
      let dbg = null
      let ov = null
      try {
        if (dbgRaw && dbgRaw !== 'no-hook') dbg = JSON.parse(dbgRaw)
      } catch {}
      try {
        if (ovRaw) ov = JSON.parse(ovRaw)
      } catch {}
      stopped = dbg?.state === 'idle' && !(ov?.visible ?? false)
      log('停止后:', JSON.stringify({ state: dbg?.state, overlayVisible: ov?.visible ?? null }))
    }
  }
  }
}

// ---------- options 页面截图 ----------
try {
  const optUrl = `chrome-extension://${EXT_ID}/src/options/options.html`
  const r = await browser.send('Target.createTarget', { url: optUrl })
  const optTarget = await findTarget((t) => (t.url || '').includes('/src/options/options.html'), 20, 250)
  if (optTarget) {
    const optSession = await attachSession(optTarget.id)
    await optSession.send('Runtime.enable')
    await sleep(800)
    await capture(optSession, 'options.png')
  }
  await browser.send('Target.closeTarget', { targetId: r.targetId }).catch(() => {})
} catch (e) {
  log('options 截图失败:', String(e).slice(0, 120))
}

// ---------- 结论 ----------
log('——— 验收结论 ———')
const verdict = (ok, name) => log(`${ok ? '✓' : '✗'} ${name}`)
verdict(saw.capturing, '进入 capturing 状态')
verdict(saw.rms, '采集到音频能量')
verdict(saw.playback || saw.native || MODE === 'file', `音频有声音且不破坏页面播放（${saw.native ? '元素采集=页面原生，音画同步' : saw.playback ? 'tabCapture 回放' : 'file 模式不涉及'}）`)
verdict(saw.text, 'ASR 产出原文')
verdict(saw.trans, '翻译产出中文')
verdict(saw.overlay, '字幕覆盖层贴在视频区域上')
verdict(shotTaken, '已截图留证')
verdict(saw.fullscreen, '全屏时覆盖层仍可见（非必需）')
verdict(stopped, '点击停止后覆盖层隐藏、引擎回到 idle（非必需）')
const passed = saw.capturing && saw.rms && saw.text && saw.trans && saw.overlay && (MODE === 'file' || saw.playback || saw.native)
log(passed ? 'PASS' : 'FAIL（未达标项见上）')
process.exit(passed ? 0 : 2)
