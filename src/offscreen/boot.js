// 经典脚本（无模块依赖），在引擎模块之前执行：
// 1) 捕获页面错误/未处理的 Promise 拒绝/库的 console.error，回传给 SW 存储
// 2) 在模块未就绪时代答 ping（pong-boot），让 SW 能区分「文档没起来」和「模块崩了」
;(function () {
  'use strict'

  var reported = 0
  function send(type, detail) {
    try {
      chrome.runtime.sendMessage({ target: 'event', type: type, detail: detail }, function () {
        void chrome.runtime.lastError
      })
    } catch (_) {
      /* SW 不在线时静默 */
    }
  }

  // fatal=true 的才会在 popup 上报为错误；库日志（onnxruntime/transformers 的
  // console 输出）仅存储供握手超时时引用，避免良性警告中断启动流程
  function report(detail, fatal) {
    if (reported >= 3) return
    reported++
    // 去掉 onnxruntime 日志的 ANSI 颜色码
    var clean = String(detail).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 500)
    send(fatal ? 'offscreen-boot-error' : 'offscreen-boot-log', clean)
  }

  window.addEventListener('error', function (e) {
    var msg = e.message || ('资源加载失败: ' + (e.filename || '?'))
    report(msg + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno + ':' + e.colno : ''), true)
  }, true)

  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason
    report('Promise 拒绝: ' + (r && r.message ? r.message : r), true)
  })

  var origError = console.error
  console.error = function () {
    try {
      report(
        Array.prototype.map
          .call(arguments, function (a) {
            return a instanceof Error ? a.message : String(a)
          })
          .join(' '),
        false,
      )
    } catch (_) {}
    return origError.apply(console, arguments)
  }

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg && msg.target === 'offscreen' && msg.type === 'ping') {
      // 模块已就绪时让引擎模块自己应答（pong）；未就绪时本脚本代答（pong-boot）
      if (!window.__livesubModuleReady) {
        sendResponse({ type: 'pong-boot' })
      }
    }
    return
  })
})()
