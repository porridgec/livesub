# 原始字幕 ASR 调研与实测（2026-11）

目标：**低延迟 + 高准确**的本地语音识别，先解决原文准确率，再谈翻译。
测试素材：YouTube `Qm8X7pbCngA`（日文新闻访谈，927s，只有 YouTube 自动生成的日文字幕）。
参考字幕：`yt-dlp --write-auto-subs` 的 json3，按 word timestamp 去滚动重复后作为「参考文本」。
评测片段：300–420s（连续、无掌声/串场），10s 窗口 × 12；另用前 300s 做过全局对比。

> 注意：YouTube 自动字幕本身也有错字和滚动显示重复，CER 不是绝对真值；这里用于**同一参考下的横向比较**。

## 1. 结论先行

| 方案 | 日文 CER（300–420s，中位/加权） | 推理速度（CPU，10s 音频） | 浏览器可行性 | 结论 |
|---|---|---|---|---|
| Whisper tiny（现状可选） | 比 base 更差 | ~0.3–0.5s | ✅ 已在用 | 快，但准确率不够 |
| Whisper base（现状默认） | **39% / 82%**（有 1 次循环） | ~0.6s（RTF 0.057） | ✅ 已在用 | 日文名字/同音词错误多 |
| Whisper small | **37% / 44%** | ~1.2–1.5s（RTF 0.13） | ✅ 可打包（238MB q8） | 准确率提升有限，速度慢 2–3× |
| **SenseVoiceSmall int8 2024-07-17** | **15% / 14%** | **0.13–0.4s/10s（RTF 0.012）** | ✅ 用 ort-web + JS fbank 已验证 | **明显胜出：更准 + 快一个数量级** |
| SenseVoice int8 2025-09-09 | 输出乱码（模型版本不兼容当前 sherpa/导出） | — | — | 不用 |
| Kotoba-Whisper / ReazonSpeech / Parakeet-ja | 预期更好 | 模型 400MB–1.5GB，需 sherpa/新 runtime | ⚠️ 重 | 暂不作为浏览器默认 |
| Moonshine | 只支持英文 | 快 | ✅ | 不适合日语 |
| 云端 ASR | 最好 | 网络往返 | ❌ 违背本地/零费用前提 | 仅作为可选后备 |

**推荐：把默认 ASR 换成 SenseVoiceSmall int8（228MB ONNX），用现有 onnxruntime-web 跑，
前端（Kaldi fbank + LFR + CMVN + CTC 解码）用 JS 实现。** 不需要引入 sherpa-onnx WASM/SDK。

另外一个已经落地的优化：扩展页开启 COOP/COEP 后 `crossOriginIsolated=true`，
ort-web 用到 4 个 WASM 线程，**Whisper base 在浏览器里从 ~2.9s/4.7s 降到 ~1.1s**（约 2.5×）。
（manifest 里已加 `cross_origin_embedder_policy` / `cross_origin_opener_policy`。）

## 2. 实测数据

### 2.1 Whisper（项目现有模型，Node CPU / q8）

评测：300–420s，10s 窗口，参考为 word-timed 自动字幕。

| 模型 | 中位 CER | 加权 CER | 平均 ASR 时间 | RTF | 备注 |
|---|---|---|---|---|---|
| base | 39.3% | 81.7% | 672ms/10s | 0.067 | 出现 1 次重复循环，循环直接毁掉加权值 |
| small | 37.5% | 43.75% | 1226ms/10s | 0.123 | 不用循环控制会有 2 次 loop；专有名词仍错（森保→盛り明 等） |

Whisper 的问题不是速度，而是**日语专有名词/同音词**：
`サッカー→作家`、`森保→盛り明/森圧`、`散歩→参考`、`引退を惜しむ声→インターホシーム声`。
这是 Whisper base/small 的日文能力上限，继续加 VAD/上下文也很难到可用水平。

### 2.2 SenseVoice（sherpa-onnx 官方 int8，2024-07-17）

同一参考、同一 12 个 10s 窗口：

| 指标 | 数值 |
|---|---|
| 中位 CER | **14.9%** |
| 加权 CER | **13.9%** |
| 推理耗时（macOS CPU，4 threads） | 10s 音频 ~0.13–0.4s；30s 音频 0.37s |
| RTF | **0.012** |
| 模型大小 | ONNX int8 228MB（下载 tar 155MB） |
| 语言 | zh / en / ja / ko / yue（+ auto） |
| 结构 | 非自回归 CTC，**不会出现 Whisper 的重复循环** |

样例（300–310s）：
- 参考：`私があのサッカーと向き合ってるあのチームの価値を上げたい選手の価値を上げたいっていうで勝ちたいという思いで`
- SenseVoice：`私がサッカーと向き合ってるチームの価値を上げたい、選手の価値を上げたいっていうで勝ちたいという思いで。`（CER 12.5%）

### 2.3 前端可移植性验证（关键）

SenseVoice 的 ONNX 输入是 **fbank(80) + LFR(7/6) + CMVN** 的 560 维特征，不是原始 PCM。
我用 **纯 JS** 实现了 Kaldi fbank（hamming、25ms/10ms、20–7600Hz、snip_edges=false、反射填充）、
LFR 和 CMVN，并用 `onnxruntime-node` 跑同一模型：

- `/tmp` 原型：`scripts/sensevoice-frontend.mjs`
- JS 输出：`私があのサッカーと向き合ってるあのチームの価値を上げたい、選手の価値を上げたいっていうで勝ちたいという思いでまあい。`
- sherpa 官方 CLI 输出：`私がサッカーと 向き 合っているチームの 価値を上げ たい、選手の 価値を 上げ たい っていうで勝ちたいという思いで。`

两者几乎一致 → **不依赖 sherpa 的 C++/WASM，用现有 ort-web 就能跑 SenseVoice**。
这个前端只需要额外打包：ONNX（228MB）、`tokens.txt`（308KB）、CMVN/语言 id（~10KB JSON，取自 ONNX metadata）。

## 2.4 进一步降延迟：Silero VAD + 双语临时字幕（已实施）

最终 ASR 已经压到 0.2–0.4s/5s，剩下的大头是「等一句话说完」。做了两件事：

1. **Silero VAD**（2.1MB ONNX，512 sample/32ms 一窗）：抗音乐/噪声更好，静音判定从能量 VAD 的
   0.6s 压到 **~0.29s**；能量 VAD 保留为后备。
2. **双语临时字幕**：Silero VAD 在说话过程中每 ~0.8s 把当前段最近 4.5s 音频交给 offscreen；
   SenseVoice 出原文，翻译链已热时同时出中文；覆盖层淡色显示，正式句子到达后清掉替换。
   正式句子优先（`draining`/队列非空时跳过 partial，`partialGen` 作废旧结果）。

实测（Chrome for Testing，4 线程）：
- ASR 197–345ms / 段
- 45s 测试产生 ~35 次 partial（原文+中文），约 0.85/s
- popup p50：识别 210ms、**话语结束→译文 401ms**
- 首条双语临时字幕在说话开始后约 0.8–1.2s

注意：Silero VAD、SenseVoice、翻译都跑在同一个 onnxruntime-web 实例上，ORT wasm 不允许并发 `session.run`
（会抛 `Session mismatch`），所以用 `src/offscreen/ort-lock.ts` 把所有 ORT 调用串行化。

## 3. 关键结论：为什么 SenseVoice 能同时拿低延迟和高准确

- **非自回归 CTC**：一次前向出整段 token，没有逐 token 解码，速度快一个数量级，也没有重复循环；
- **多语种统一模型**：ja/en/zh/ko/yue，一个模型替代 Whisper 的语言处理；
- **CTC + 语言 query token**：语言/情感/事件作为输入 token，不需要单独的语种检测模型；
- **int8 量化**：228MB，单次推理在 CPU 上 0.1s 级；WASM 线程化后预计 0.2–0.5s/5s 音频；
- 对日语新闻/访谈的实际准确率明显高于 Whisper base/small（CER 15% vs 37–50%）。

## 4. 建议的落地路径

### 阶段 1（已完成 ✅）：SenseVoice 替换 Whisper 默认引擎
1. 下载并打包 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`（ONNX + tokens）；
2. `src/offscreen/asr-sensevoice.ts`：移植 `scripts/sensevoice-frontend.mjs` 的 fbank/LFR/CMVN/CTC，
   用 `@huggingface/transformers` 里现成的 `onnxruntime-web`（或直接 `onnxruntime-web`）创建 session；
3. 接口保持 `initAsr()` / `transcribe(pcm, lang)` 不变，增加 `engine: 'sensevoice' | 'whisper'`；
4. 设置页/模型选择：SenseVoice（默认）+ Whisper base/tiny（后备）；
5. VAD 段长度维持 5s，SenseVoice 推理后总延迟预计 ~1–1.5s（VAD 0.6s + ASR 0.3s + 翻译 0.3s）；
6. 保留 Whisper 作为模型加载失败/旧模型兼容的后备。

**落地结果（2026-11-21）**：
- `src/offscreen/sensevoice.ts` + `sensevoice-config.json`（CMVN/LFR/语言 id）；模型在 `models/sensevoice/`
- `src/offscreen/vad-silero.ts`；Silero VAD 模型在 `models/vad/silero_vad.onnx`
- 元素采集改为把 16k PCM 原样发给 offscreen（`element-pcm`），VAD/partial 统一在 offscreen 做
- 浏览器（Chrome for Testing，4 线程 WASM）实测：**355–490ms / 5s 音频**
- e2e 总延迟（话语结束 → 译文上屏）：**约 831ms**（popup p50）
- 日文测试句识别：`今日はとても良い天気ですね一緒に散歩しませんか`（不再出现 `点気/参考` 一类错误）
- ITN 策略：日语/中文/韩语关闭 ITN（否则会出现「で、すね」这种错误标点），英语开启
- 翻译侧加了重复折叠，避免 opus-mt 偶发复读刷屏
- Whisper base/tiny 保留为可选/后备

风险与对策：
| 风险 | 对策 |
|---|---|
| ort-web 加载 228MB 模型慢/占内存 | 只在首次加载，常驻；加载进度显示；失败回退 Whisper |
| WASM 线程/SharedArrayBuffer | 已加 COOP/COEP；仍可单线程跑（SenseVoice 够快） |
| fbank 与 Kaldi 完全一致 | 已用 JS 原型与 sherpa CLI 对齐；集成后跑同一批 wav 回归 |
| 中文/英文质量 | SenseVoice 本身支持；保留语言参数 |
| 模型太大（dist +228MB） | 可选下载（首次启动引导），或提供 Whisper 轻量模式 |

### 阶段 2：VAD / 流式体验
- 用 **Silero VAD**（~2MB ONNX）替代能量 VAD：更准的语音边界、抗音乐/掌声，减少半句截断；
- 可选 **partial 字幕**：每个 VAD 段内每 1s 用 SenseVoice 跑一次当前累积音频，先上「临时字幕」，
  段结束再定稿（SenseVoice 很快，代价可接受）；
- 允许把最大段长从 5s 调到 3s（延迟更低）并用 SenseVoice 的准确率兜底。

### 阶段 3：翻译
原文稳定后再优化翻译链（ja→en→zh 的误差会被 ASR 错误放大）；可考虑直译模型或上下文提示。

## 5. 复现实验

```bash
# 1) 抓音频 + 官方字幕
/tmp/yt-dlp --no-playlist -f bestaudio -o audio.%(ext)s "https://www.youtube.com/watch?v=Qm8X7pbCngA"
/tmp/yt-dlp --no-playlist --skip-download --write-auto-subs --sub-langs ja --sub-format json3 -o sub "..."
ffmpeg -i audio.webm -ar 16000 -ac 1 audio16.wav
# 2) 参考字幕：按 word timestamp 去滚动重复（脚本见 /tmp/livesub-yt）
# 3) Whisper 对比
node scripts/bench-asr.mjs --model base  --win 10 --ref /tmp/livesub-yt/refW-10s-300-420.json --limit 12
node scripts/bench-asr.mjs --model small --win 10 --ref /tmp/livesub-yt/refW-10s-300-420.json --limit 12
# 4) SenseVoice：sherpa-onnx CLI + 纯 JS 前端
node scripts/sensevoice-frontend.mjs /tmp/livesub-yt/w00.wav
```
