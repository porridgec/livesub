import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// 多入口构建：
// - 三个 HTML 页面（popup / options / offscreen）路径保持 dist/src/...
// - SW 与 content script 打成 assets/*.js（content script 无运行时 import，输出等价普通脚本）
// - manifest、本地模型、onnxruntime wasm、audio worklet 静态拷贝
export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'chrome120',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: 'src/popup/popup.html',
        options: 'src/options/options.html',
        offscreen: 'src/offscreen/offscreen.html',
        sw: 'src/background/sw.ts',
        'subtitle-overlay': 'src/content/subtitle-overlay.ts',
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        format: 'es',
      },
    },
  },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: 'manifest.json', dest: '.' },
        { src: 'icons', dest: '.' },
        // 只打包实际用到的模型：whisper-tiny + en→zh + ja→en（NLLB-600M 不再默认带上，
        // 它能在 models/ 里留着做实验，但 870MB 放进扩展既拖慢构建也拖慢加载）
        { src: 'models/Xenova/whisper-tiny', dest: 'models/Xenova' },
        { src: 'models/Xenova/whisper-base', dest: 'models/Xenova' },
        { src: 'models/sensevoice', dest: 'models' },
        { src: 'models/vad', dest: 'models' },
        { src: 'models/Xenova/opus-mt-en-zh', dest: 'models/Xenova' },
        { src: 'models/Xenova/opus-mt-ja-en', dest: 'models/Xenova' },
        { src: 'src/offscreen/pcm-worklet.js', dest: '.' },
        { src: 'src/offscreen/boot.js', dest: 'src/offscreen' },
        { src: 'node_modules/@huggingface/transformers/dist/ort-*.wasm', dest: 'ort' },
        { src: 'node_modules/@huggingface/transformers/dist/ort-*.mjs', dest: 'ort' },
        { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.wasm', dest: 'ort' },
        { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.mjs', dest: 'ort' },
      ],
    }),
  ],
})
