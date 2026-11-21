// ASR 输出清理：去掉纯标点、Whisper 常见幻觉、重复循环和超长崩坏文本。
const HALLUCINATIONS = [
  /^ご視聴(ありがとうございました|いただき.*)$/,
  /^チャンネル登録.*(お願い|よろしく)/,
  /^thank(s| you) for watching/i,
  /^thanks? for (watching|listening)/i,
  /^subtitles? by/i,
  /^amara\.org/i,
  /^you ?tube/i,
]

/** 去掉中日文之间的空格（SenseVoice 的 BPE 会用 ▁ 分词） */
export function tidyCjkSpaces(text: string): string {
  return text
    .replace(/\s+(?=[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef])/g, '')
    .replace(/(?<=[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef])\s+/g, '')
    .trim()
}

/** 折叠连续重复片段（翻译模型偶尔会复读同一个字/词） */
export function collapseRepeats(text: string): string {
  let prev = ''
  let out = text
  // 反复折叠，直到不再变化（避免长串被拆成多段后仍有残留）
  for (let i = 0; i < 3; i++) {
    prev = out
    out = out.replace(/(.{1,12}?)\1{2,}/gu, '$1')
    if (out === prev) break
  }
  return out
}

export function cleanTranscript(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  text = text
    .replace(/^[\s.,!?;:、。，！？；：…—\-–~"'“”‘’]+/, '')
    .replace(/[\s.,!?;:、。，！？；：…—\-–~"'“”‘’]+$/, '')
  if (!text) return ''
  if (!/[0-9a-z\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/i.test(text)) return ''
  if (/^[[(（【].*[\])）】]$/.test(text)) return ''
  if (HALLUCINATIONS.some((re) => re.test(text))) return ''
  text = collapseRepeats(text)
  if (/^(.{1,4})\1{4,}$/u.test(text)) return ''
  for (let len = Math.min(Math.floor(text.length / 3), 40); len >= 6; len--) {
    if (text.endsWith(text.slice(0, len))) {
      text = text.slice(0, -len).trim()
      break
    }
  }
  if (!text) return ''
  if (text.length > 240) text = text.slice(0, 240) + '…'
  return text
}
