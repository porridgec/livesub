// 各上下文（popup / sw / offscreen / content）共享的类型与默认设置
// 注意：content script 不能有运行时 import，只允许 `import type` 引用本文件

export type SourceLang = 'auto' | 'ja' | 'en' | 'zh'
export type SubtitleMode = 'bilingual' | 'original' | 'translated'
export type AsrModel = 'sensevoice' | 'base' | 'tiny'

export interface SubtitleStyle {
  /** 字号 = 视频宽度 * fontScale */
  fontScale: number
  /** 字幕底部距视频底部比例（0~0.3） */
  bottomOffset: number
  /** 字幕底色不透明度 0~1 */
  bgOpacity: number
  /** 同屏最多显示几组（一组 = 原文 + 译文） */
  maxLines: number
}

export interface Settings {
  sourceLang: SourceLang
  subtitleMode: SubtitleMode
  asrModel: AsrModel
  /** 1（最不敏感）~ 5（最敏感） */
  vadSensitivity: number
  subtitleStyle: SubtitleStyle
}

export const DEFAULT_SETTINGS: Settings = {
  sourceLang: 'auto',
  subtitleMode: 'bilingual',
  asrModel: 'sensevoice',
  vadSensitivity: 3,
  subtitleStyle: { fontScale: 0.028, bottomOffset: 0.14, bgOpacity: 0.6, maxLines: 2 },
}

/** 设置合并：老版本存储里可能缺字段，逐层兜底 */
export function mergeSettings(partial: Partial<Settings> | undefined): Settings {
  const p = partial ?? {}
  return {
    ...DEFAULT_SETTINGS,
    ...p,
    subtitleStyle: { ...DEFAULT_SETTINGS.subtitleStyle, ...(p.subtitleStyle ?? {}) },
  }
}

// —— 消息协议（target 决定接收方，避免多页面互相误处理）——
// 'sw'        → service worker（popup 发起）
// 'offscreen' → offscreen 文档（sw 发起）
// 'event'     → offscreen 广播的事件，popup 直接消费，sw 负责转发到内容脚本
// 'tab' 消息走 chrome.tabs.sendMessage，不经 runtime

export type OffscreenState = 'idle' | 'starting' | 'loading-model' | 'capturing' | 'error'

export interface Stats {
  /** 每句识别耗时 ms */
  asr: number[]
  /** 每句翻译耗时 ms */
  trans: number[]
  /** 话语结束 → 译文上屏 总延迟 ms */
  total: number[]
  segments: number
}

export interface LastLine {
  id: string
  original: string
  translated?: string
  lang: string
  asrMs: number
}

export interface Snapshot {
  capturing: boolean
  tabId: number | null
  offscreen: OffscreenState
  detail?: string
  engine?: string
  /** 自动检测/用户指定后实际使用的语种 */
  sourceResolved?: string
  /** 音频去向：native=页面原生声音（音画同步）/ replay=扩展回放 / muted=页面被静音 */
  audioMode?: string
  lastLines: LastLine[]
  stats: Stats
}

export interface RuntimeMsg {
  target: 'sw' | 'offscreen' | 'event'
  type: string
  [k: string]: unknown
}
