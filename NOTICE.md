# NOTICE / Third-party components

This repository contains original code licensed under the MIT License
(see `LICENSE`). It depends on and interoperates with third-party software and
model weights. Model weights are **not** committed to this repository; they are
downloaded by `npm run fetch-models` or built locally.

## Runtime libraries

| Component | Version | License | Link |
|---|---|---|---|
| @huggingface/transformers | 3.8.x | Apache-2.0 | https://github.com/huggingface/transformers.js |
| onnxruntime-web / onnxruntime-common | 1.22.0-dev | MIT | https://github.com/microsoft/onnxruntime |
| Silero VAD (model + reference code) | 2024 | MIT | https://github.com/snakers4/silero-vad |

## Models downloaded by `npm run fetch-models`

| Model | Source | License | Usage |
|---|---|---|---|
| Xenova/whisper-tiny | Hugging Face | Apache-2.0 (OpenAI Whisper: MIT) | ASR (fallback) |
| Xenova/whisper-base | Hugging Face | Apache-2.0 (OpenAI Whisper: MIT) | ASR (fallback) |
| Xenova/opus-mt-en-zh | Hugging Face | Apache-2.0 (Helsinki-NLP OPUS-MT) | EN→ZH translation |
| Xenova/opus-mt-ja-en | Hugging Face | Apache-2.0 (Helsinki-NLP OPUS-MT) | JA→EN translation (pivot) |
| SenseVoiceSmall int8 | sherpa-onnx release (converted from FunAudioLLM/SenseVoice) | MIT per upstream FunASR/SenseVoice repositories; the Hugging Face card marks it “other” — review upstream before redistribution | ASR (default) |
| Silero VAD | onnx-community/silero-vad | MIT | Voice activity detection |

Model download revisions and SHA-256 checksums are pinned in
`scripts/fetch-models.mjs`.

## Visual assets

- `docs/overlay-real.png`: the video frame is from **Big Buck Bunny**
  (© Blender Foundation, CC BY 3.0), via the public W3Schools HTML5 video
  example. The screenshot was cropped to remove page/sidebar content.
- Extension icons in `icons/` are original artwork for this project.
- `docs/popup-ja.png`, `docs/options.png`, `docs/overlay-ja.png` are screenshots
  of this extension running against locally generated TTS test audio.

## Development-only tools

`scripts/dev-e2e.mjs`, `scripts/bench-asr.mjs`, and
`scripts/sensevoice-frontend.mjs` are development utilities. They use
Chrome for Testing / yt-dlp / ffmpeg at the developer's discretion; none of
these tools or any downloaded media is shipped with the extension or this
repository.
