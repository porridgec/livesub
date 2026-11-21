// onnxruntime-web 的 package.json exports 没带 types 条件，bundler 解析拿不到类型；
// 这里按它自带的 types.d.ts 等价声明一次。
declare module 'onnxruntime-web' {
  export * from 'onnxruntime-common'
}
