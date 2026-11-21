// 字幕窗口：把「ASR 结果」和「渲染」解耦。
// 参考 YouTube 的两行滚动 + B 站 cue 的稳定显示：
// - 正式句子进入历史，最多保留 maxLines 个槽位；
// - 正在识别的 partial 占 1 个槽位，因此正式行只显示 maxLines-1 个；
// - partial 与上一次的公共前缀视为「稳定部分」，尾部用淡色显示，减少整行跳动。

export interface CaptionFinal {
  id: string
  original: string
  translated?: string
}

export interface CaptionPartial {
  text: string
  translated?: string
  lang?: string
  /** 与上一次 partial 的公共前缀长度（字符数） */
  stableLen: number
}

export interface CaptionSnapshot {
  finals: CaptionFinal[]
  partial: CaptionPartial | null
}

const MAX_HISTORY = 12

export class CaptionWindow {
  private finals: CaptionFinal[] = []
  private partialText = ''
  private partialTranslated: string | undefined
  private partialLang = ''
  private stableLen = 0
  private maxLines = 2

  setMaxLines(n: number): void {
    this.maxLines = Math.max(1, Math.min(6, Math.round(n) || 2))
  }

  addFinal(id: string, original: string, translated?: string): void {
    if (!id || !original) return
    if (this.finals.some((l) => l.id === id)) return
    this.finals.push({ id, original, translated })
    if (this.finals.length > MAX_HISTORY) this.finals = this.finals.slice(-MAX_HISTORY)
  }

  setTranslation(id: string, translated: string): void {
    const line = this.finals.find((l) => l.id === id)
    if (line) line.translated = translated
  }

  setPartial(text: string, translated?: string, lang?: string): void {
    if (!text) return
    if (text === this.partialText) {
      if (translated !== undefined) this.partialTranslated = translated
      if (lang) this.partialLang = lang
      return
    }
    const prev = this.partialText
    let i = 0
    while (i < prev.length && i < text.length && prev[i] === text[i]) i++
    // 只有足够长的公共前缀才当成稳定部分，避免第一个字抖动
    this.stableLen = i >= 2 ? i : 0
    this.partialText = text
    this.partialTranslated = translated
    this.partialLang = lang ?? this.partialLang
  }

  clearPartial(): void {
    this.partialText = ''
    this.partialTranslated = undefined
    this.partialLang = ''
    this.stableLen = 0
  }

  clear(): void {
    this.finals = []
    this.clearPartial()
  }

  /** 当前可渲染的内容：partial 存在时给正式行少留一个槽位 */
  snapshot(): CaptionSnapshot {
    const partial: CaptionPartial | null = this.partialText
      ? {
          text: this.partialText,
          translated: this.partialTranslated,
          lang: this.partialLang || undefined,
          stableLen: this.stableLen,
        }
      : null
    const slots = partial ? Math.max(0, this.maxLines - 1) : this.maxLines
    return { finals: slots > 0 ? this.finals.slice(-slots) : [], partial }
  }
}
