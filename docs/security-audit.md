# 安全审计（开源发布前）

- 日期：2026-11-21
- 对象：LiveSub Chrome 扩展（MV3）源码、构建脚本、模型获取链路
- 方法：人工代码审查 + `npm audit` + 密钥扫描 + 外部 URL 扫描 + 权限/消息面审查 + 模型供应链固定
- 结论：**未发现可被网页利用的远程代码执行、数据外传或越权通道**。发现并修复了 5 类发布前问题（见下）。

## 1. 数据流与信任边界

```
页面 <video> 音轨（captureStream）
  → 内容脚本（隔离世界）→ offscreen（扩展页）
    → Silero VAD → SenseVoice → 本地翻译（opus-mt）
      → 字幕消息 → 内容脚本覆盖层

回退路径：chrome.tabCapture → offscreen 回放 + VAD/ASR
```

- 音频**不落盘、不上传**；没有 fetch 到非扩展来源的运行时请求。
- 页面不能调用扩展 API；扩展没有声明 `externally_connectable`，也没有
  `web_accessible_resources`。
- 内容脚本与页面的唯一接触点是 DOM（读取 `<video>`、创建 Shadow DOM 覆盖层），
  不读取页面表单/存储/网络内容。
- 字幕消息只通过 `chrome.tabs.sendMessage` 发给被捕获的 tab。

## 2. 发现与修复

| # | 发现 | 风险 | 处理 |
|---|---|---|---|
| 1 | `.zcode/plans/` 下的内部开发计划被 git 跟踪，含个人目标站点和会话 ID | 开源后暴露个人偏好/内部信息 | 从发布树移除，加入 `.gitignore`；公开仓库使用全新单提交历史，旧历史仅保留在本地 `dev-history` 分支 |
| 2 | `sharp`（@huggingface/transformers 的 Node 传递依赖）有 2 个 high 级 libvips/librsvg 漏洞 | 仅影响 Node 侧图片处理；扩展运行时不包含 sharp | 通过 `overrides` 固定 `sharp@0.35.5`，`npm audit` 已 0 漏洞；扩展 bundle 不引用 sharp |
| 3 | 模型下载使用 HF `resolve/main`，未固定 revision | 上游被篡改/漂移时可能拿到非预期权重 | 固定 whisper/opus 的 HF commit；SenseVoice/Silero 下载后校验 SHA-256 |
| 4 | 测试钩子 `start-test` 可以 fetch 任意 http(s) URL | 仅扩展上下文可触发，但仍是多余的 SSRF 面 | 限制为 `127.0.0.1` / `localhost` 或扩展内路径；`element-pcm` 限制单条 ≤10s 音频 |
| 5 | `docs/overlay-real.png` 包含第三方网页侧边广告 | 开源仓库出现无关广告内容 | 裁剪到视频画面；补充 Big Buck Bunny (CC BY 3.0) 署名 |

## 3. 已验证的安全属性

- **无密钥**：扫描 `sk-*`、AWS/GitHub token、私钥等，未发现。
- **无远程代码**：运行时无 CDN/远端脚本；模型与 WASM 均来自扩展包。
- **无危险 DOM 注入**：用户/模型文本全部走 `textContent`；popup 的 `innerHTML`
  只用于固定模板，随后用 `textContent` 填充。
- **CSP**：`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`；
  无 `unsafe-eval`、无 `unsafe-inline`。
- **消息面**：offscreen/SW/内容脚本都按 `target` 过滤；页面无法发送
  `chrome.runtime` 消息；`start-test` 仅限扩展上下文且 URL 受限。
- **跨域隔离**：manifest 启用 COOP/COEP（`cross_origin_isolated=true`），
  用于 WASM 多线程；不引入额外网络面。
- **依赖审计**：`npm audit` 0 vulnerabilities（含 dev 依赖）。

## 4. 权限最小化评审

| 权限 | 是否必要 | 说明 |
|---|---|---|
| `tabCapture` | 回退路径需要 | 元素采集不可用时抓 tab 音频 |
| `offscreen` | 需要 | 音频图 + ONNX 推理不能放 SW |
| `storage` | 需要 | 设置、采集状态 |
| `scripting` | 需要 | 对已打开页面动态注入覆盖层 |
| `activeTab` | 回退路径需要 | Chrome 对 tabCapture 的要求 |
| `host_permissions: <all_urls>` | 需要 | 任意视频站点上查找/覆盖 `<video>` |

`host_permissions` 较宽是产品性质决定的；扩展不读取/上传页面内容，审计未发现
将其用于数据收集的代码路径。

## 5. 残余风险

- **宽 host 权限**：用户需信任扩展不会把页面内容外传；代码中无此路径，但权限本身无法更窄。
- **模型供应链**：已固定 revision + 校验关键模型；上游模型仍可能被替换为“质量异常但格式合法”的权重。
  ONNX 权重是数据，不能直接执行代码，但不能排除错误输出。
- **测试钩子保留在发行包内**：仅扩展上下文可达，已限制 URL；如追求更小攻击面，可在
  release 构建中通过构建标志剔除。
- **元素采集的站点兼容性**：跨域/DRM 媒体可能失败并回退 tabCapture；回退路径会回放音频（可能有 ~100ms 延迟）。
- **依赖漏洞**：已加 `sharp` override；建议在 GitHub 开启 Dependabot 与私有安全公告。

## 6. 复现审计

```bash
npm ci
npm audit                 # 0 vulnerabilities（含 sharp override）
grep -rInE "sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|BEGIN .*PRIVATE KEY" \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=models .
grep -rInE "https?://" src manifest.json   # 运行时不应出现外部 URL
npx tsc --noEmit
```
