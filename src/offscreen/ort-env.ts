// 统一配置 onnxruntime-web：扩展页已开启 COOP/COEP，可用多线程 WASM。
import * as ort from 'onnxruntime-web'

let configured = false

export function configureOrt(): void {
  if (configured) return
  configured = true
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/')
  ort.env.wasm.simd = true
  if (typeof SharedArrayBuffer !== 'undefined') {
    ort.env.wasm.numThreads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))
  }
  ort.env.logLevel = 'error'
}
