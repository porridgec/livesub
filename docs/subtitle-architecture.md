# LiveSub 字幕系统架构（学习 YouTube / B 站）

- 日期：2026-11-22
- 背景：平台字幕是服务端流水线，模型/服务不能直接搬进浏览器；但它们的**分层、时间轴、显示和上下文定制**可以本地复刻。
- 本文记录这次架构调整：把「ASR 结果」与「字幕窗口」解耦，并补上词级时间戳、稳定 partial、术语表。

## 1. 分层

```text
┌────────────────────────────────────────────────────────────┐
│ 1. 采集：<video>.captureStream / tabCapture                 │
│ 2. 检测：Silero VAD（0.29s 静音判定）+ 5s 上限              │
│ 3. 识别：SenseVoice CTC（整段 + 0.8s partial）              │
│ 4. 时间：CTC token 时间戳（60ms/帧）                        │
│ 5. 组装：CaptionWindow（稳定前缀/两行滚动/槽位）            │
│ 6. 翻译：opus-mt（按行，缓存/可预取）                       │
│ 7. 渲染：Shadow DOM 覆盖层（原文/译文/partial 淡色）        │
│ 8. 来源：平台 cue track（未来）→ 同一渲染层                 │
└────────────────────────────────────────────────────────────┘
```

关键原则：**ASR 只负责出文本/时间；字幕窗口负责什么时候显示、显示几行；渲染层只画画。**
平台（YouTube/B 站）也是这么分的：ASR → 后处理/时间轴 → 字幕轨 → 播放器渲染。

## 2. 对照平台

| 层 | YouTube | Bilibili | LiveSub 现在 |
|---|---|---|---|
| ASR | 服务端 Google/Gemini | 2023 E2E-CTC Conformer；2026 Index-ASR（Qwen3-8B） | SenseVoice CTC（本地） |
| 时间 | 词级（json3 `tOffsetMs` / VTT `<c>`） | cue 级（from/to），CTC 时间戳内部有但不公开 | cue 级 + **新增 token 时间戳** |
| 分段 | 服务端断句 + 两行滚动 | 服务端 cue | VAD 0.29s/5s + 0.8s partial |
| 定制 | 无用户热词 | 动态解码器/LM；Index-ASR hotword prompt | **术语表后处理**（第一版） |
| 翻译 | Google NMT（tlang） | 服务端 AI 翻译轨 | opus-mt 本地 |
| 渲染 | 两行滚动、词级 | cue 列表、CC 样式 | **两行滚动窗口**（partial 占一槽） |

## 3. 这次实现的四件事

### 3.1 CTC token 时间戳

`src/offscreen/sensevoice.ts`：

- 解码时记录每个非 blank token 的**输出帧号**；
- 输出帧 ≈ `LFR_N × 10ms = 60ms`，得到 `words: [{text,start,end}]`；
- `asr-final` 事件带上 `words`，后续可用于：
  - 词级高亮/卡拉OK（学 YouTube）；
  - 和视频 `currentTime` 对齐的字幕轨；
  - 平台 cue 的校验/合并。

注意：SenseVoice 是整段非流式，词级时间来自 CTC 后验，边界是近似值（B 站文章也提到 CTC 时间戳有尖峰）；用于显示足够，不用于强制对齐。

### 3.2 CaptionWindow：稳定 partial + 两行滚动

`src/content/caption-window.ts`：

- 正式句子进历史，最多 `maxLines` 个槽位；
- partial 占 1 个槽位，所以有 partial 时正式行只显示 `maxLines - 1` 个（默认 2 → 上一条正式 + 当前 partial）；
- partial 与上一次的**最长公共前缀**作为稳定部分，尾部用 `.tail` 淡色显示，减少整行跳动；
- 正式句子到达后清 partial，替换为正式行 + 译文。

这是对 YouTube「两行滚动」和 B 站「cue 稳定显示」的本地化：
不需要服务端，也不需要等整段结束才显示。

### 3.3 术语表 / 纠错

- 设置页新增「术语表 / 纠错」，每行 `错=对`（例如 `盛り明=森保`）；
- offscreen 在 ASR 输出后、翻译前替换；partial 也生效；
- 这是 B 站「动态解码器 + 热词」的**第一层**（后处理），不是真正的 CTC 热词偏置；
- 真正的热词偏置需要把术语编码成 token 序列、在 beam search 中加分（B 站动态解码器 / Index-ASR prompt），列为下一步。

### 3.4 平台 cue 复用同一渲染层（预留）

`CaptionWindow` 只接受「文本 + 可选译文」，不关心文本来自 SenseVoice 还是平台轨。
未来平台字幕解析成 `CaptionFinal[]` 后直接喂给同一个窗口即可，不需要重写覆盖层。

## 4. 与平台的差距 / 下一步

| 差距 | 影响 | 计划 |
|---|---|---|
| 没有真正的流式 ASR | 直播/连续讲话仍靠 VAD 分段 + partial | P3：streaming zipformer/paraformer，本地 WASM；或平台字幕 |
| partial 只是整段重跑 | 首字延迟 ~0.8–1.2s | P1：词级增量/稳定前缀；P3 流式 |
| 术语表只是后处理 | 错得离谱时替换不了 | P2：CTC token 热词偏置 / beam search + LM |
| 翻译逐句 | 长句译文慢 | P5：cue 预取 2–3 条 + 缓存 |
| 没有平台 cue 源 | 有字幕的视频仍走 ASR | P4：B 站 dm-view / YouTube DOM 接入 `CaptionWindow` |

## 5. 代码地图

```text
src/offscreen/sensevoice.ts     # CTC 解码 + token 时间戳
src/offscreen/offscreen.ts      # VAD/队列/partial/术语表/事件
src/content/caption-window.ts   # 稳定 partial + 两行滚动槽位
src/content/subtitle-overlay.ts # 渲染层（Shadow DOM）
src/options/*                   # 术语表设置
```

## 6. 设计取舍

- **不引入 8B Index-ASR / 云 API**：保持本地、零费用、音频不出设备；8B 也不支持日语/浏览器。
- **不照搬服务端批处理**：VOD 可以做整轨预翻译，但我们的输入是实时 tab 音频，必须保留 partial。
- **先做显示/时间轴，再换模型**：字幕窗口和词级时间不会破坏现有 ASR；换流式模型是独立的大工程。
