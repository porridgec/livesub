// Options：模型 / 语种 / VAD / 字幕样式等持久化设置，改动即时保存并同步预览。
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../shared/types'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const langSel = $('lang') as unknown as HTMLSelectElement
const modelSel = $('asr-model') as unknown as HTMLSelectElement
const vadRange = $('vad') as unknown as HTMLInputElement
const vadVal = $('vad-val')
const modeSel = $('subtitle-mode') as unknown as HTMLSelectElement
const fontRange = $('font-scale') as unknown as HTMLInputElement
const fontVal = $('font-scale-val')
const offsetRange = $('bottom-offset') as unknown as HTMLInputElement
const offsetVal = $('bottom-offset-val')
const bgRange = $('bg-opacity') as unknown as HTMLInputElement
const bgVal = $('bg-opacity-val')
const maxLinesSel = $('max-lines') as unknown as HTMLSelectElement
const savedEl = $('saved')
const preview = $('preview')
const previewStage = $('preview-stage')
const previewPanel = $('preview-panel')

let settings: Settings = structuredClone(DEFAULT_SETTINGS)
let saveTimer: ReturnType<typeof setTimeout> | undefined

function paint(): void {
  langSel.value = settings.sourceLang
  modelSel.value = settings.asrModel
  vadRange.value = String(settings.vadSensitivity)
  vadVal.textContent = String(settings.vadSensitivity)
  modeSel.value = settings.subtitleMode
  fontRange.value = String(settings.subtitleStyle.fontScale)
  fontVal.textContent = `${Math.round(settings.subtitleStyle.fontScale * 1000) / 10}%`
  offsetRange.value = String(settings.subtitleStyle.bottomOffset)
  offsetVal.textContent = `${Math.round(settings.subtitleStyle.bottomOffset * 100)}%`
  bgRange.value = String(settings.subtitleStyle.bgOpacity)
  bgVal.textContent = `${Math.round(settings.subtitleStyle.bgOpacity * 100)}%`
  maxLinesSel.value = String(settings.subtitleStyle.maxLines)
  paintPreview()
}

function paintPreview(): void {
  const w = preview.clientWidth || 640
  const h = preview.clientHeight || w * 0.5625
  previewPanel.style.fontSize = `${Math.max(10, w * settings.subtitleStyle.fontScale)}px`
  previewStage.style.paddingBottom = `${h * settings.subtitleStyle.bottomOffset}px`
  previewPanel.style.setProperty('--bg', String(settings.subtitleStyle.bgOpacity))
  const showOrig = settings.subtitleMode !== 'translated'
  const showTrans = settings.subtitleMode !== 'original'
  ;(previewPanel.querySelector('.p-orig') as HTMLElement).style.display = showOrig ? '' : 'none'
  ;(previewPanel.querySelector('.p-trans') as HTMLElement).style.display = showTrans ? '' : 'none'
  preview.style.aspectRatio = '16 / 9'
}

function readForm(): void {
  settings.sourceLang = langSel.value as Settings['sourceLang']
  settings.asrModel = modelSel.value as Settings['asrModel']
  settings.vadSensitivity = Number(vadRange.value)
  settings.subtitleMode = modeSel.value as Settings['subtitleMode']
  settings.subtitleStyle = {
    fontScale: Number(fontRange.value),
    bottomOffset: Number(offsetRange.value),
    bgOpacity: Number(bgRange.value),
    maxLines: Number(maxLinesSel.value),
  }
}

function save(): void {
  readForm()
  paint()
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void chrome.storage.sync.set({ settings })
    savedEl.textContent = '已保存 ✓'
    setTimeout(() => {
      if (savedEl.textContent === '已保存 ✓') savedEl.textContent = ''
    }, 1500)
  }, 150)
}

for (const el of [langSel, modelSel, vadRange, modeSel, fontRange, offsetRange, bgRange, maxLinesSel]) {
  el.addEventListener('input', save)
  el.addEventListener('change', save)
}

$('reset').addEventListener('click', () => {
  settings = structuredClone(DEFAULT_SETTINGS)
  paint()
  void chrome.storage.sync.set({ settings })
  savedEl.textContent = '已恢复默认 ✓'
  setTimeout(() => (savedEl.textContent = ''), 1500)
})

window.addEventListener('resize', paintPreview)

void (async () => {
  const got = await chrome.storage.sync.get('settings')
  settings = mergeSettings(got.settings as Partial<Settings> | undefined)
  paint()
})()
