// 本地翻译：opus-mt 小模型链。
// - en → zh：opus-mt-en-zh 直译
// - ja → zh：opus-mt-ja-en → opus-mt-en-zh 两段（没有现成 opus-mt ja→zh；
//   NLLB-600M 虽然质量略好，但 870MB / 单句数秒，实时场景不可用）
// - zh：源语言就是中文，不需要翻译
// 每个模型独立懒加载 + Promise 缓存，加载失败可重试；非支持语种返回空串（只显示原文）。
import { pipeline } from '@huggingface/transformers'
import { runExclusive } from './ort-lock'

const REPO: Record<string, string> = {
  'opus-mt-en-zh': 'Xenova/opus-mt-en-zh',
  'opus-mt-ja-en': 'Xenova/opus-mt-ja-en',
}

/** 源语种 → 翻译链（依次执行） */
const CHAINS: Record<string, string[]> = {
  en: ['opus-mt-en-zh'],
  ja: ['opus-mt-ja-en', 'opus-mt-en-zh'],
  zh: [],
}

const loading: Record<string, Promise<any>> = {}
const loaded: Record<string, any> = {}

function getTranslator(key: string): Promise<any> {
  if (loaded[key]) return Promise.resolve(loaded[key])
  if (!loading[key]) {
    loading[key] = runExclusive(() => pipeline('translation', REPO[key], { dtype: 'q8' }))
      .then((pipe: any) => {
        loaded[key] = pipe
        return pipe
      })
      .catch((e: unknown) => {
        delete loading[key]
        throw e
      })
  }
  return loading[key]
}

export function translationSupported(srcLang: string): boolean {
  return (CHAINS[srcLang]?.length ?? 0) > 0
}

/** 翻译链是否已全部加载（用于判断 partial 翻译会不会触发冷加载） */
export function translatorReady(srcLang: string): boolean {
  const chain = CHAINS[srcLang]
  return !!chain?.length && chain.every((k) => !!loaded[k])
}

/** 预热某语种的翻译链（后台执行，不阻塞字幕） */
export async function warmTranslator(srcLang: string): Promise<void> {
  const chain = CHAINS[srcLang]
  if (!chain) return
  for (const key of chain) {
    await getTranslator(key)
  }
}

export async function translateText(text: string, srcLang: string): Promise<string> {
  const chain = CHAINS[srcLang]
  if (!chain?.length) return ''
  let cur = text
  for (const key of chain) {
    const pipe = await getTranslator(key)
    const out: any = await runExclusive(() => pipe(cur, { max_new_tokens: 160 }))
    const first = Array.isArray(out) ? out[0] : out
    cur = String(first?.translation_text ?? '').trim()
    if (!cur) return ''
  }
  return cur
}
