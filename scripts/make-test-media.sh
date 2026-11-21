#!/usr/bin/env bash
# 生成本地测试音频（macOS TTS）→ test/media/*.m4a，配合 test/index.html 做端到端验证。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test/media

if ! say -v '?' 2>/dev/null | grep -qi 'Kyoko'; then
  echo "提示：未找到日语语音 Kyoko，将只生成英语测试音频。"
  echo "     可在 系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音 下载日语语音。"
  HAS_JA=0
else
  HAS_JA=1
fi

if [[ "$HAS_JA" == 1 ]]; then
  say -v Kyoko -o test/media/ja.aiff '今日はとても良い天気ですね。一緒に散歩しませんか。'
  afconvert -f m4af -d aac test/media/ja.aiff test/media/ja.m4a
  rm -f test/media/ja.aiff
fi

say -v Samantha -o test/media/en.aiff 'Language learning is a long journey, but every small step counts. Practice a little bit every day.'
afconvert -f m4af -d aac test/media/en.aiff test/media/en.m4a
rm -f test/media/en.aiff

echo "已生成：$(ls test/media)"
