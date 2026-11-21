# YouTube / Bilibili 字幕方案调研

- 日期：2026-11-22
- 目的：判断 LiveSub 能否直接复用平台已有字幕，绕开本地 ASR 的延迟/准确率瓶颈
- 实测环境：macOS + Chrome for Testing（未登录、全新 profile）+ Python/urllib；网络为香港出口
- 结论：**平台字幕值得做，但要「平台优先、本地 ASR 兜底」；B 站可先做，YouTube 的访问受 token 保护，先做 DOM 镜像更稳。**

## 0. TL;DR

| 平台 | 字幕来源 | 可取性 | 建议 |
|---|---|---|---|
| YouTube | 人工 CC + 自动 ASR（2026 已是 `variant=gemini`，词级时间轴） | 页面里的 `baseUrl` 直接 fetch 返回 **200/0 字节**；yt-dlp 用 TV/visionOS client 可拿到完整 json3/VTT | 先做**播放器字幕 DOM 镜像**；完整轨道抓取作为实验开关 |
| Bilibili | 人工 CC + AI 字幕（ai-zh / ai-en / …） | `x/player/v2` 匿名空列表（登录门控）；`x/v2/dm/view` 匿名有轨道，正文 URL 带 `auth_key`，实测可取 | **优先做**：dm-view + 归属校验 + 本地翻译 |

平台字幕的 VOD 延迟是 **0（不含翻译）**，准确率通常高于本地小模型；缺点是「有才有」、API 会漂、涉及 ToS。

---

## A. 他们是怎么做的（架构）

### A.1 共同 pipeline

```text
音频 → VAD/分段 → ASR → 标点/ITN → 时间戳/断句 → 翻译（可选）→ 存储/CDN → 播放器渲染
```

人工 CC 则是「创作者上传 → 平台转成内部 timedtext/cue → CDN → 渲染」。
两家的差异主要在 ASR 引擎、时间粒度、访问控制和渲染方式。

### A.2 YouTube

- **人工 CC**：创作者在 Studio 上传字幕，平台转成 timedtext 的 srv1/2/3、json3、vtt 等格式，走 CDN。
- **自动字幕**：服务端 ASR，不需要用户设备算力；2026 年这条视频的轨道参数带 `variant=gemini`，
  说明新版自动字幕有 Gemini 参与/标记（Google 没有公开具体模型和解码器细节）。
- **时间与断句**：输出词级时间（json3 的 `tOffsetMs`、VTT 的 `<c>`），播放器按 `wWinId`/`aAppend`
  做「两行滚动」；标点、大小写、`[鼻息]` 一类声音标注由后处理产生。
- **翻译**：`tlang=zh-Hans` 走 Google 的机器翻译，生成另一条 timedtext 轨道。
- **直播**：服务端流式 ASR，播放器实时滚动；没有公开 API。
- **渲染**：底部居中 1–2 行，词级高亮/追加，CC 样式可配；这就是我们看到的「像自己长出来」的效果。

可观测到的：轨道列表、词级时间、两行滚动、翻译轨、`variant=gemini`。
不可观测到的：声学模型、语言模型、解码器、Gemini 的具体用法。

### A.3 Bilibili

B 站 2023 年公开过一篇《语音识别技术在 B 站的落地实践》（作者邓威，B 站语音识别负责人），
把 AI 字幕的底座讲得比较清楚：

- **场景**：音视频内容安全审核、AI 字幕（C 端、必剪、S12 直播）、视频理解/全文检索。
- **模型**：端到端 **E2E-CTC（Conformer）**，中文按字 + 英文 BPE 建模；AED + CTC 多任务训练后只保留 CTC；
  再做 lattice-free MMI 区分性训练；解码用动态 beam-search + 语言模型融合（便于热词/业务定制）。
- **数据**：用 UP 主投稿的 CC 字幕做筛选/时间对齐（字幕时间戳不准、文本和语音不完全对应、数字写法不一致），
  再用 NST 半监督训练（约 40k 小时自动标注 + 15k 小时标注），精度相对提升约 15%。
- **部署**：F16 + FasterTransformer + Triton，单张 T4 一小时可转写约 3000 小时长音频。
- **时间戳**：文章明确说端到端 CTC 的时间戳比 AED 准，但仍有「尖峰」、每个字持续时长不准；
  区分性训练后边界会更平滑——这也是 B 站 AI 字幕正文只有 cue 级 `from/to`、没有词级时间的原因之一。
- **流式**：文章把「结合流式 ASR，支持游戏/体育赛事实时字幕」列为后续方向；S12 直播用了 ASR，但不是今天这种通用实时字幕 API。

2025/2026 年 B 站公开了 **Index-ASR** 技术报告（arXiv:2601.00890；社区文章称已开源，模型发布以官方仓库为准）：

- 架构：Conformer audio encoder + adapter + **Qwen3-8B** LLM decoder；
- 能力：中文/英文，强噪声鲁棒，支持 **hotword/context**（用户给术语表/摘要，显著提升专有名词）；
- 限制：**只支持中英文**、**非流式**、8B 参数；
- 另外还有 **Index-Translate**（Qwen3.5-based 多语翻译），同样是 LLM/GPU 侧模型。

B 站 AI 字幕的**产物**是 cue 级 JSON（`from/to/content`），由服务端生成，放 CDN、带短期签名，
播放器按 cue 渲染；没有公开的词级时间。

### A.4 两家共同点

- 都是**服务端批处理/流式 ASR**，模型和算力不落在用户设备上；
- 都有人工 CC + 自动 ASR 两条线；
- 都有「ASR → 后处理（标点/数字/断句）→ 时间轴 → 翻译 → CDN → 播放器」的完整流水线；
- 都把「时间轴」和「可读性」当成独立工程问题（不是 ASR 出什么就直接显示什么）。

---

## B. 我们能复用哪一层

| 层 | 能不能用 | 说明 |
|---|---|---|
| 他们的云端 ASR/翻译服务 | ❌ | YouTube 不对外开放任意视频的 ASR；B 站 AI 字幕/必剪是内部/风控接口；官方 API 需要视频所有权或登录 |
| 他们的 Index 模型 | ⚠️ 技术上能，产品上不行 | Index-ASR 是 Qwen3-8B、中文/英文、非流式、GPU（发布状态以官方仓库为准）；Index-Translate 同样是 LLM；浏览器/日语场景都不合适 |
| 他们的字幕产物 | ✅ 有条件下 | B 站 `dm-view` 匿名可拿；YouTube 只能 DOM/TV client，见下文 |
| 他们的 pipeline 架构 | ✅ 部分 | 我们已有 VAD + CTC（SenseVoice）+ 翻译 + 覆盖层；缺词级时间、热词、两行滚动、流式 |
| 他们的 UX | ✅ | 两行滚动、词级高亮、CC 样式、翻译预取/缓存 |

结论：

1. **不能把他们的 ASR 引擎搬进浏览器。** YouTube 的模型闭源；B 站开源的 Index-ASR 是 8B LLM，
   且只支持中英文、非流式；他们的线上服务也没有对外的「任意音频转字幕」API。
2. **能复用的是架构和产物。** 平台字幕（B 站 API / YouTube DOM）可以直接用；
   词级时间、两行滚动、热词/上下文、翻译预取这些工程做法可以本地复刻。
3. **我们其实已经走在他们 2023 年那条 CTC 路线上**：SenseVoice 也是非自回归 CTC，
   所以我们有和 B 站类似的「快、可流式、易定制」底座；差的是后处理和时间轴工程。
4. **最实际的三个改进**：
   - 用 SenseVoice 的 CTC token 后验做词级时间戳 → 两行滚动/逐词高亮（学 YouTube）；
   - 加术语表/热词偏置或后处理纠错（学 B 站 dynamic decoder / Index-ASR hotword）；
   - 平台字幕优先 + 本地 ASR 兜底（用他们的产物，补我们的覆盖率和延迟）。
5. **不建议**为了「用他们的方案」引入 8B 模型或云 API：会破坏本地、零费用、低延迟的前提；
   如果确实要最高中文准确率，可以做一个**可选的自托管 Index-ASR 服务模式**（GPU），默认不开。

### B.1 为什么不能直接抄 Index-ASR

- 8B 参数：fp16 约 16GB，int8 也约 8GB，浏览器 WASM/WebGPU 都放不下；
- 只支持中文/英文，没有日语；
- 非流式，和我们的实时字幕目标不一致；
- 需要 GPU 服务端，和「音频不出设备」冲突。

### B.2 可以抄的部分（按性价比）

1. **CTC 时间戳**：SenseVoice 输出 CTC logits，取每个 token 的峰值/区间，得到词级时间；
   用于两行滚动、逐词高亮、字幕不整段跳变。B 站文章也提到 CTC 时间戳可用但需平滑。
2. **热词/上下文**：B 站用动态解码器 + LM，Index-ASR 用 prompt 注入 hotwords；
   我们可以先做「术语表后处理纠错」（简单），再评估 CTC 热词偏置（复杂）。
3. **两行滚动渲染**：YouTube 的 `wWinId`/`aAppend`/`tOffsetMs` 语义可以直接借鉴；
   我们的 partial 字幕已经有「先说后定稿」，再加两行滚动会更接近平台体验。
4. **翻译预取/缓存**：B 站/YouTube 都是整轨翻译，不逐句等；我们可以在 cue 模式下预取后续 2–3 条。
5. **流式 ASR**：他们的直播字幕是流式；我们当前是 VAD 分段 + partial。真要追平，需要换 streaming 模型，
   这是下一个大台阶，不是靠调 VAD 能解决的。

### B.3 参考

- B 站 ASR 落地实践（2023，SpeechHome 转载）：
  https://www.speechhome.com/blogs/news/1633301196309663744
- Index-ASR 技术报告（arXiv:2601.00890）：
  https://arxiv.org/abs/2601.00890
- Index-Translate：
  https://github.com/bilibili/Index-Translate
- YouTube 自动字幕帮助：
  https://support.google.com/youtube/answer/6373554

---

## 1. YouTube

### 1.1 字幕类型

- **人工 CC**：`captionTracks[].kind` 不存在，创作者/社区上传，质量最高，常有多种语言。
- **自动字幕**：`kind: "asr"`，`vssId: "a.ja"`；2026 年的轨道 URL 带 `variant=gemini`，是 Gemini 生成的自动字幕，带标点、词级时间轴。
- **自动翻译**：`isTranslatable: true`，在 timedtext URL 加 `tlang=zh-Hans` 可拿平台翻译。
- **直播字幕**：平台侧实时 ASR；没有公开 API，播放器渲染在 DOM 里（是否可用取决于直播和账号）。

### 1.2 数据与格式（实测 Qm8X7pbCngA，927s 日文访谈）

`ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[0]`：

```json
{"languageCode":"ja","kind":"asr","isTranslatable":true,"vssId":"a.ja",
 "baseUrl":"https://www.youtube.com/api/timedtext?...&kind=asr&lang=ja&variant=gemini"}
```

从 yt-dlp 成功拿到的 `fmt=json3`（246KB，792 events）：

```json
{"tStartMs":100,"dDurationMs":3700,"wWinId":1,
 "segs":[{"utf8":"内田"},{"utf8":"さん","tOffsetMs":300},{"utf8":"と","tOffsetMs":600}, ...]}
{"tStartMs":1990,"dDurationMs":1810,"wWinId":1,"aAppend":1,"segs":[{"utf8":"\n"}]}
```

- **词级时间**：`tStartMs + tOffsetMs`，可以做逐词高亮。
- **append/newline 语义**：`aAppend:1` + `utf8:"\n"` 表示「在当前字幕窗里换行」，不是新 cue；播放器会把同一 `wWinId` 的片段累积成两行滚动显示。
- **VTT 形态**（151KB）：每个 cue 里既有上一行、也有当前行，例如：

```text
00:05:04.194 --> 00:05:06.584
あのサッカーと向き合ってるあのチームの
価値<00:05:04.494><c>を</c><00:05:04.594><c>上げ</c>...
```

要自己渲染，需要按 `wWinId`/`aAppend` 重建两行滚动，或者取 VTT 每个 cue 的**最后一行**作为当前文本。

内容质量：这段 300–310s 的平台字幕是
`あのサッカーと向き合ってるあのチームの価値を上げたい選手の価値を上げたいっていうで…`，
专有名词正确；同段 Whisper base 出现「1位も引いて…」这类错误，SenseVoice 基本正确但少了「あの」。
**平台字幕至少不弱于本地 SenseVoice，且没有推理延迟。**

### 1.3 访问路径（关键）

| 路径 | 结果 |
|---|---|
| 页面 `ytInitialPlayerResponse` 的 `baseUrl` + `fmt=json3`，Node 直接请求 | HTTP 200，**0 字节**（text/html） |
| 同上，带 `Origin`/`Referer`/`Sec-Fetch-*`/`Cookie: CONSENT` | 仍 0 字节 |
| 页面上下文 `fetch(baseUrl + '&fmt=json3', {credentials:'include'})`（headless/headful Chrome for Testing，未登录） | 仍 **200/0 字节** |
| yt-dlp（`tv`/`visionos` InnerTube client） | 成功，246KB json3 / 151KB VTT |
| YouTube Data API `captions.download` | 需要视频所有者 OAuth，第三方视频不可用 |
| 播放器 CC 按钮 + DOM `.ytp-caption-segment` | 在全新 profile 里按钮存在，但播放器没渲染出字幕（拿不到轨道） |

结论：

- 页面里的 `baseUrl` **不是**一个可直接复用的公开字幕 API；web client 现在受 PO token/风控保护。
- yt-dlp 的 TV/visionOS client 目前能绕过，但这是 **undocumented InnerTube 抓取**，扩展要复刻请求且随时可能失效，ToS 风险也更高。
- 对 LiveSub 最稳的是 **DOM 镜像**：用户能在播放器里看到字幕时，直接读 `.ytp-caption-segment`；拿不到就回退本地 ASR。
- 如果需要完整轨道（预翻译/全文），再做 **实验开关**：TV client 抓取或 MAIN-world 拦截播放器的 timedtext 响应，并明确标注非官方。

### 1.4 显示行为

- 底部居中、1–2 行、白字黑边；自动字幕按词追加，Gemini 轨道有标点。
- 人工 CC 通常是整句 cue；自动字幕是滚动/追加，直接抓 DOM 会得到播放器当前显示的两行。
- 有 `[鼻息]` 一类声音标注；做字幕时可以保留或过滤。

### 1.5 合规

YouTube ToS 禁止未经授权的抓取/下载；「读取用户自己播放器里已经显示的字幕」比「服务端抓 timedtext」更接近正常观看，但仍有解释空间。不要提供下载/再分发功能。

---

## 2. Bilibili

### 2.1 字幕类型

- **人工 CC**：`lan: "zh-CN"/"zh-Hans"/"en-US"`，`ai_status: 0`，`type: 0`；创作者上传。
- **AI 字幕**：`lan: "ai-zh"`，`lan_doc: "中文（自动生成）"`，`ai_status: 2`；B 站服务端 ASR。
- **自动翻译**：`ai-en`/`ai-ja`/`ai-es`/…，由 AI 字幕再翻译。
- **直播字幕**：没有稳定的公开接口；播放器侧能力有限，主要靠本地 ASR。

### 2.2 接口与登录门控

`GET https://api.bilibili.com/x/player/v2?bvid=<BV>&cid=<CID>`

- 匿名：`code 0`，`data.subtitle.subtitles: []` —— **空列表 ≠ 没字幕**，是 `need_login_subtitle` 登录门控。
- 登录：返回 `id / lan / lan_doc / subtitle_url / type / ai_type / ai_status`。
- ⚠️ 未签名，风控降级时可能返回 **属于其他视频** 的字幕（社区已复现，`ymt200120/bili-subtitle` 因此把它降级为诊断探针）。**不可作为唯一来源。**

匿名字幕通道（实测可用）：

`GET https://api.bilibili.com/x/v2/dm/view?aid=<AID>&oid=<CID>&type=1`

- 与 `player/v2` 同构的 `data.subtitle.subtitles[]`，但**不做 need_login_subtitle 门控**。
- 2026-11-19 的公开实测（96 个榜单视频）：58 条 `ai-zh` 可匿名取到，正文可下载。
- 本次实测 12 个榜单视频：7 个有轨道（其中 6 个带 ai-zh，1 个仅 zh+en 人工 CC；带 ai-zh 的其中一个同时提供 8 个语种），5 个为空。

登录后的新版路径（更稳，但复杂）：

- `x/player/wbi/v2`（WBI 签名，aid/cid 绑定）
- `x/v2/subtitle/web/view`（Protobuf 二进制，字段 3 = 轨道）
- 播放器资源捕获（`PerformanceObserver`，需要 URL 归属校验）

### 2.3 字幕正文

`subtitle_url` 形如：

```text
https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/<aid><cid><hash>?auth_key=...
https://aisubtitle.hdslb.com/bfs/subtitle/<sha1>.json?auth_key=...
```

- **必须带完整 `auth_key`**；只取路径会 403（本次实测：截断 query 的 URL 返回 403/238B；完整 URL 返回 200/21KB）。
- 签名短期有效；403/404 要重新取 metadata，**不要缓存签名 URL**。
- 正文 JSON：

```json
{"body":[
  {"from":2.36,"to":5.58,"sid":1,"location":2,"content":"…","music":0.0},
  {"from":5.58,"to":8.70,"sid":2,"location":2,"content":"…"}
]}
```

- 本次样本 135 条 cue，覆盖 2.36–645.16s；**只有 cue 级时间，没有词级时间**。
- `location` 是位置提示；`music` 是音乐/非语音标记。

### 2.4 归属校验（必须）

`ai-*` 的 URL 路径开头是 `aid` 与 `cid` 的十进制拼接，后接定长摘要。实测：

```text
prod/117640815250085 43727326650 c2f9e...
       aid=117640815250085  cid=43727326650
```

- 按摘要长度切出数字前缀，要求**恰好等于 `aid + cid`**；否则丢弃（可能是其他分 P/其他视频）。
- 无 id 的自动翻译/CC 文件只能做「查询绑定」（请求里的 `oid` 绑定），风险更高；建议只保留，不优先。
- **fail closed**：宁可提示无法确认归属，也不显示可能来自其他视频的字幕。

### 2.5 播放器 UI

- 新版 `.bpx-player-ctrl-subtitle` 存在；本次匿名测试点开后菜单为空（与 `need_login_subtitle` 一致）。
- 登录后播放器会显示「中文（自动生成）」等轨道；此时 DOM 镜像可行，但匿名场景只能走 `dm-view`。
- 结论：B 站优先用 API（匿名可拿），DOM 作为登录用户的兜底。

### 2.6 合规

B 站服务条款/版权规则同样限制抓取与再分发；只处理当前用户有权访问的字幕，不提供下载/批量导出；签名 URL 不落盘、不日志。

---

## 3. 对比

| 维度 | YouTube | Bilibili |
|---|---|---|
| 自动字幕覆盖率 | 很高（大多数视频有 ASR 轨） | 中（热门/新视频较多，长尾/老视频少） |
| 人工 CC | 有，质量高 | 有，但比例低 |
| 时间轴 | 词级（json3/VTT `<c>`） | cue 级（from/to） |
| 匿名可取 | 页面 URL 被 token 保护；TV client 可 | `dm-view` 可；正文需完整签名 URL |
| 登录需求 | 播放器 CC 可能受 session/PO token 影响 | 播放器 UI 需要；API 匿名可 |
| 主要风险 | PO token/接口漂移/ToS | 登录门控/跨视频 bug/风控/ToS |
| 显示 | 1–2 行滚动，词级更新 | 单行/多行 cue，可配样式 |
| 对 LiveSub 的优先级 | 中（先 DOM 镜像） | **高（先 API）** |

---

## 4. 对 LiveSub 的建议

### 4.1 总体架构：平台优先，本地 ASR 兜底

```text
视频页
  ├─ 平台字幕可用？
  │    ├─ Bilibili：dm-view → 归属校验 → 正文 → cues
  │    └─ YouTube：播放器 DOM 镜像（用户已开 CC）
  │         → 本地翻译（非中文轨）→ 覆盖层按 currentTime 渲染
  └─ 不可用/直播/其他站点
       → 现有 Silero VAD + SenseVoice + 本地翻译
```

- 新增 `SubtitleTrack` 抽象：`{source, lang, cues:[{start,end,text}]}`。
- 覆盖层增加「定时 cue 模式」：按 `video.currentTime` 找当前 cue，处理 `seeking`/`pause`/倍速；不再走 ASR 队列。
- 设置项：「字幕来源：自动（平台优先）/ 平台 / 本地识别」；popup 显示来源 badge（YouTube CC / B站 AI / 本地识别）。
- 翻译：只翻非中文轨；按 cue 文本 hash 缓存；预取后续 2–3 条 cue，避免逐条等待。
- 回退：平台轨为空/403/解析失败/明显不同步 → 自动启动 ASR，并提示一次。

### 4.2 阶段

**Phase 1：Bilibili（建议先做，1–2 天）**

1. 内容脚本从 `__INITIAL_STATE__` / URL 拿 `bvid/aid/cid`；SPA 切换时重新解析。
2. offscreen/SW 请求 `x/v2/dm/view?aid&oid&type=1`（`credentials:'include'`，`Referer` 当前视频页）。
3. 校验 `subtitle_url` 的 `prod/<aid><cid>` 前缀；不匹配丢弃；无 id 的轨道仅作低优先级。
4. 用完整 URL 取正文；403/404 重新取 metadata 一次；不缓存签名 URL。
5. 解析 `body` → cues；按源语言选轨（优先原声，其次 ai-zh）；本地翻译。
6. 覆盖层定时渲染；无轨/失败回退 ASR。
7. 单测：归属校验（前缀碰撞、跨视频、其他分 P）、403 重取、cue 解析；用合成 JSON，不把平台字幕内容入库。

**Phase 2：YouTube DOM 镜像（1 天 + 真实浏览器验证）**

1. 内容脚本检测 YouTube；点击/确认 CC 按钮（`aria-pressed=true`）。
2. `MutationObserver` 监听 `.ytp-caption-window-container`，读 `.ytp-caption-segment` 的两行文本。
3. 过滤 `[鼻息]` 等声音标注；按行去重；本地翻译；覆盖层显示。
4. 可选隐藏原生字幕（CSS），避免双份；提供开关。
5. 风险：播放器 DOM 改版；未登录/无 CC 时不可用 → 回退 ASR。

**Phase 3：YouTube 完整轨道（实验，需评估 ToS）**

- 方案 A：MAIN-world hook `fetch`/XHR 捕获播放器实际 timedtext 响应（需要用户先开 CC；不伪造请求）。
- 方案 B：复刻 yt-dlp 的 TV/visionOS InnerTube 请求，拿完整 json3/VTT；默认关闭，明确标注非官方。
- 解析 json3 的 `wWinId`/`aAppend`/`tOffsetMs`，或 VTT 的最后一行；支持预翻译。
- 这一步的收益是「未播放也能预翻译/全文」，但稳定性和合规性最差，放在最后。

### 4.3 不建议

- 不要把 `x/player/v2` 的未签名结果当唯一来源（跨视频张冠李戴）。
- 不要把 YouTube `ytInitialPlayerResponse.baseUrl` 当稳定 API（实测 200/0）。
- 不要读取/导出/日志 Cookie、SESSDATA、`auth_key`、`w_rid`。
- 不要提供字幕下载/批量导出/再分发。

---

## 5. 实测记录

```text
YouTube:
  captionTracks: [{lang:ja, kind:asr, variant:gemini}]
  json3: 792 events, 0–905.1s, word-level tOffsetMs
  VTT: 151KB, rolling two-line cues with <c> word timings
  page baseUrl fetch: HTTP 200, 0 bytes (Node & page context, fresh profile)
  yt-dlp TV/visionOS client: 246KB json3, 151KB VTT

Bilibili:
  player/v2 anonymous: 0 tracks (need_login_subtitle)
  dm/view anonymous (12 ranking videos): 7 with tracks; ai-zh 6
  ai-zh body: HTTP 200, 21KB, 135 cues, 2.36–645.16s
  truncated auth_key: 403/238B → full signed URL required
```

### 参考

- `ymt200120/bili-subtitle` 的协议笔记（WBI、dm-view、Protobuf、归属校验、未签名接口跨视频风险）：
  https://github.com/ymt200120/bili-subtitle/blob/main/docs/PROTOCOL.md
- `ccBilly-aipm/bilibili-ai-subtitle`（Protobuf 字段、登录态）：
  https://github.com/ccBilly-aipm/bilibili-ai-subtitle
- YouTube timedtext 为未公开接口；yt-dlp 的 TV/visionOS client 行为仅用于调研对比。
