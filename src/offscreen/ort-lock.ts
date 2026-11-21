// onnxruntime-web 的 wasm 后端不允许同时运行两次 session.run（会抛 "Session mismatch"），
// 而 Silero VAD、SenseVoice 正式识别、partial 识别会交错调用，这里统一串行化。
let chain: Promise<unknown> = Promise.resolve()

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn)
  chain = p.catch(() => {})
  return p
}
