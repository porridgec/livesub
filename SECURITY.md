# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private vulnerability reporting:
<https://github.com/porridgec/livesub/security/advisories/new>

Include:
- affected version/commit,
- reproduction steps or a proof of concept,
- impact (data exposure, permission abuse, code execution, …),
- any suggested fix.

You will get an acknowledgement within 7 days. We aim to publish a fix and a
GitHub Security Advisory within 90 days.

## Scope

In scope: the extension code in this repository (`src/`, `manifest.json`,
build scripts), its permission model, its local-only claims, and the model
download/supply-chain path.

Out of scope: the accuracy or content of third-party models, the behaviour of
websites the extension runs on, and vulnerabilities in dependencies that are
not reachable from the extension runtime (see `docs/security-audit.md`).

## Security properties (by design)

- **Local-only inference**: audio is captured in the tab, processed in the
  offscreen document, and never uploaded. There is no telemetry, no analytics,
  no remote logging, and no runtime request to non-extension origins.
- **No remote code**: all JavaScript and WASM is bundled in the extension.
  Runtime model files are loaded from the extension package, not the network.
- **No eval**: the extension CSP is
  `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.
  `wasm-unsafe-eval` is required by onnxruntime-web.
- **No externally_connectable**: web pages cannot message the extension.
  Runtime messages are only accepted from the extension's own contexts
  (popup, service worker, content scripts, offscreen document).
- **Pinned model artifacts**: `scripts/fetch-models.mjs` pins Hugging Face
  revisions and verifies SHA-256 for the SenseVoice and Silero VAD models.
- **Test-only hooks** (`start-test`, `start-element`) are reachable only from
  extension contexts, and `start-test` only accepts `127.0.0.1` / `localhost`
  media URLs or extension-internal paths.

## Permissions

| Permission | Why |
|---|---|
| `tabCapture` | Fallback audio capture when element capture is unavailable |
| `offscreen` | Run the audio graph and ONNX inference outside the service worker |
| `storage` | Persist user settings (`sync`) and short-lived capture state (`session`) |
| `scripting` | Inject the subtitle overlay into already-open tabs |
| `activeTab` | Required by Chrome for the `tabCapture` fallback |
| `host_permissions: <all_urls>` | Find and overlay the `<video>` on any video site |

See `README.md` → “安全与隐私” for details.

## Supported versions

The latest release on the `main` branch is supported. Older commits are not.
