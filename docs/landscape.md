# 同类项目调研（2026-11）

- 目的：看有没有和 LiveSub 做同样事情的项目，以及各自的取舍
- 方法：GitHub 搜索 + README/源码核对 + 产品官网；star 数为 2026-11-22 查询结果，会变化
- 结论：**有大量相邻项目，但没有找到与 LiveSub 完全同构的**——
  「Chrome 扩展 + 浏览器内全本地 ASR + 全本地翻译 + 任意 HTML5 视频 + 双语覆盖层 + 开源」。
  最接近的是桌面端的 Tomoru / v2s / LiveTranslate，和浏览器端的 crx-live-translate / TabScribe。

## 1. 一张表看最接近的项目

| 项目 | 形态 | ASR | 翻译 | 本地 | 覆盖对象 | star / 许可 |
|---|---|---|---|---|---|---|
| **LiveSub（本项目）** | Chrome 扩展 | SenseVoice | opus-mt | ✅ 全部本地 | 任意 `<video>` 页面 | — / MIT |
| [Tomoru](https://github.com/ACAne0320/Tomoru) | 桌面（mac/win/linux） | SenseVoice / Qwen-ASR / Apple | Index-Translate / Hy-MT2 / 云 | ✅ 可选离线 | 任意应用/系统音频 | 284 / GPL-3.0 |
| [v2s](https://github.com/franklioxygen/v2s) | macOS 菜单栏 | Apple Speech | Apple Translation | ✅ 优先本地 | 任意 App 音频 | 515 / 以仓库为准 |
| [LiveTranslate](https://github.com/TheDeathDragon/LiveTranslate) | Windows 桌面 | faster-whisper / SenseVoice / FunASR / Anime-Whisper | OpenAI 兼容 LLM（可 Ollama） | ASR 本地；翻译可本地/云 | 系统音频 + 麦克风 | 923 / MIT |
| [crx-live-translate](https://github.com/botbahlul/crx-live-translate) | Chrome/Edge 扩展 | Web Speech API | Google Translate | ❌ 云 | 任意标签页音频（需虚拟声卡） | 127 / MIT |
| [TabScribe](https://github.com/ishaan-177013/TabScribe) | Chrome 扩展 + 本地 Python | faster-whisper | ❌ | ✅ | 标签页音频，20s 分块 | 9 / MIT |
| [vCaptions / bilibili-subtitle](https://github.com/IndieKKY/bilibili-subtitle) | Chrome/Edge 扩展 | ❌ 平台字幕 | LLM/翻译 | 取决于配置 | B 站/任意站点平台字幕 | 1.2k / MIT |
| [Language Reactor](https://www.languagereactor.com/) | Chrome 扩展 | ❌ 平台字幕 | AI | ❌ | Netflix/YouTube | 闭源 |
| [Trancy](https://www.trancy.org/) | Chrome 扩展 | ❌ 平台字幕 | AI | ❌ | YouTube/Netflix 等 | 闭源 |
| [asbplayer](https://github.com/asbplayer/asbplayer) | Chrome 扩展/播放器 | ❌ 字幕文件 | ❌ | ✅ | 字幕句法学习 | 1.5k / AGPL-3.0 |
| [Buzz](https://github.com/chidiwilliams/buzz) | 桌面 | Whisper | ✅ | ✅ | 文件/录音，非实时覆盖 | 23k / MIT |
| [VideoLingo](https://github.com/Huanshere/VideoLingo) | 桌面/服务 | Whisper 等 | LLM | 取决于配置 | 批量视频字幕/配音 | 19k / Apache-2.0 |
| Chrome 内置 Live Caption | 浏览器内置 | 端侧 | ❌ | ✅ | 浏览器媒体 | 闭源 |

## 2. 四类项目

### A. 系统级「任意应用」实时双语字幕

**Tomoru** 是功能上最接近的参考：

- 监听系统音频或单个应用；桌面悬浮双语字幕；
- ASR 可选 SenseVoice / Qwen-ASR / Apple；翻译可选 Index-Translate / Hy-MT2 / 云；
- 支持**边说边译**（先给前半句大意，句子结束再给完整翻译）——和我们的 partial 思路一致；
- 有 **scenes/glossaries**：按番剧/主播/游戏维护人名和术语，纠正误识别和误翻译；
- 本地/云可切换；GPL-3.0；macOS/Windows/Linux。

**v2s**：macOS 菜单栏，Apple Speech/Translation，Silero VAD，两行字幕；优先端侧，部分语言会走 Apple 服务器；只支持 macOS。

**LiveTranslate**：Windows，系统音频 + 麦克风；ASR 可选 faster-whisper/SenseVoice/FunASR/Anime-Whisper；翻译走 OpenAI 兼容 API（可本地 Ollama）；有 VAD、流式翻译显示、透明悬浮层；ASR 本地，翻译默认云。

**LiveCaptions-Translator**（4.1k）/ **LiveCaptions**（Linux，1.8k）：基于 Windows Live Captions / Linux 桌面字幕，再做翻译；不是浏览器方案。

共同点：覆盖「任何应用」，但需要安装桌面程序 / 系统权限；LiveSub 是浏览器内、零安装（除扩展）、直接贴视频。

### B. 浏览器里做「标签页音频 → 字幕」

- **crx-live-translate**：Chrome/Edge 扩展，用 `webkitSpeechRecognition`（Web Speech API）+ Google Translate；需要 Stereo Mix/虚拟声卡把系统音频送进麦克风；不是本地模型，依赖 Google 服务，准确率/隐私/语言受浏览器限制。它证明了「浏览器内实时翻译」有需求，但技术路线和 LiveSub 不同。
- **TabScribe**：Chrome 扩展 + 本地 Python `faster-whisper` 服务；`getDisplayMedia` 抓标签页音频，20s 分块转写，侧边栏文本，无翻译、无视频覆盖层。作者明确说 20s 分块是为了避免 Whisper 流式输出的闪烁——这和我们对 partial 稳定性的处理是同一个问题。
- **TabTongue / live-tab-translator**：更小的实验项目，本地 faster-whisper + NLLB 或 Web Speech + 翻译；形态接近，但成熟度/覆盖层/双语体验不如 LiveSub。

结论：浏览器内「抓 tab 音频 + 本地 ASR」有人做，但大多止步于转写，或需要本地 Python 服务；**把本地 ASR + 本地翻译 + 视频覆盖层做完整**的很少。

### C. 浏览器「平台字幕」增强

- **vCaptions（原 bilibili-subtitle）**：B 站/任意站点视频的字幕列表、点击跳转、下载、翻译、总结；用的是平台自带字幕，不是 ASR；1.2k star，MIT。
- **Language Reactor / Trancy / eJOY**：YouTube/Netflix 双语字幕、词典、句库、AI 翻译/口语；闭源，平台字幕为主，不处理「没有字幕的视频」。
- **asbplayer**：字幕播放器 + 句子挖掘（Anki），需要字幕文件/平台字幕；不做 ASR。
- 这类产品在「有字幕」的场景体验很好，但**没有字幕 / 小语种 / 任意站点**就覆盖不到——这正是 LiveSub 的 ASR 能补的位。

### D. 离线/批量字幕工具

- **Buzz**（23k）：桌面 Whisper 转写/翻译，文件级，不是实时视频覆盖。
- **VideoLingo**（19k）：批量字幕切割/翻译/对齐/配音，偏后期。
- **Video subtitle translator / Transub / dualsub**：批处理字幕翻译/双语字幕生成。
- 这些是「做完视频再处理」，和 LiveSub 的「边看边出」不同。

### E. 模型/运行时（可复用）

- **SenseVoice**（9.8k）：我们用的模型；同系列 **OmniSenseVoice**（897）提供词级时间戳，**streaming-sensevoice**（476）做伪流式 + 热词。
- **whisper-web**（3.3k）：浏览器内 Whisper 演示，证明 WASM/WebGPU 可行；没有翻译/覆盖层。
- **Silero VAD**：我们用在端点上；v2s 也用了它（Core ML 转换）。

## 3. 和 LiveSub 的差异

LiveSub 目前唯一比较明确的组合优势：

1. **完全本地**：音频不出浏览器，ASR + 翻译都不调 API；
2. **浏览器原生**：不用装桌面程序、不用虚拟声卡、不用本地 Python 服务；
3. **任意 HTML5 视频**：不依赖 YouTube/Netflix/B 站的字幕接口；
4. **日语优先**：SenseVoice 对日语专有名词明显好于 Whisper base/small；
5. **开源 MIT**：可审计、可改、可自托管；
6. **原生音轨**：元素采集不静音页面，音画同步（tabCapture 只做兜底）。

同时要承认的短板：

| 短板 | 对手 |
|---|---|
| 没有平台字幕（有字幕的视频还要 ASR） | vCaptions / Language Reactor / Trancy |
| 学习功能弱（词典、句库、Anki、复读） | Language Reactor / Trancy / asbplayer |
| 语言覆盖 5 种（SenseVoice），翻译只做中/英/日 | Tomoru / LiveTranslate / Buzz |
| 桌面/系统级覆盖（会议、游戏、任意 App） | Tomoru / v2s / LiveTranslate |
| 没有真流式 ASR / 词级高亮 | streaming-sensevoice / YouTube 自动字幕 |
| UI/商店分发/新手引导 | 成熟商业产品 |

## 4. 值得借鉴的点

- **Tomoru 的「translate ahead」**：partial 先给大意、final 再给完整翻译——我们已经有 partial 翻译，可以把「gist → full」做得更明确。
- **Tomoru 的 scenes/glossaries**：按番剧/主播维护术语；我们的术语表可以升级成「场景 + 术语 + 误识别纠正」。
- **LiveTranslate 的流式翻译显示**：字符级输出，减少等待感；我们的 partial 翻译可以做成渐进显示。
- **vCaptions/Language Reactor 的平台字幕能力**：有字幕时直接读，零 ASR 延迟；我们的 `CaptionWindow` 已经为 cue track 留了口。
- **TabScribe 的稳定性取舍**：宁可稍晚、不要闪烁；我们的稳定前缀/两行窗口是同一思路。
- **streaming-sensevoice / OmniSenseVoice**：热词、词级时间戳、伪流式——正好对应我们下一步。

## 5. 定位建议

- 不要和 Language Reactor/Trancy 比「学习功能大全」，也不要和 Tomoru 比「覆盖所有 App」；
- 主打：**浏览器内、完全本地、任意视频、日语准、开源**；
- 补两块就能明显增强竞争力：
  1. **平台字幕优先**（有字幕时零延迟，学 vCaptions/Language Reactor）；
  2. **术语表/热词 + 词级时间戳**（学 Tomoru/B 站，提升专有名词和显示体验）；
- 如果以后做桌面端，Tomoru 是最直接的对标；如果只做浏览器，LiveSub 的生态位是清楚的。

## 6. 参考

- Tomoru: https://github.com/ACAne0320/Tomoru
- v2s: https://github.com/franklioxygen/v2s
- LiveTranslate: https://github.com/TheDeathDragon/LiveTranslate
- crx-live-translate: https://github.com/botbahlul/crx-live-translate
- TabScribe: https://github.com/ishaan-177013/TabScribe
- vCaptions / bilibili-subtitle: https://github.com/IndieKKY/bilibili-subtitle
- asbplayer: https://github.com/asbplayer/asbplayer
- Buzz: https://github.com/chidiwilliams/buzz
- VideoLingo: https://github.com/Huanshere/VideoLingo
- OmniSenseVoice: https://github.com/lifeiteng/OmniSenseVoice
- streaming-sensevoice: https://github.com/pengzhendong/streaming-sensevoice
- whisper-web: https://github.com/xenova/whisper-web
- Language Reactor: https://www.languagereactor.com/
- Trancy: https://www.trancy.org/
