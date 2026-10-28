declare module '*.sql?raw' {
  const sql: string
  export default sql
}

// sherpa-onnx-node ships JSDoc types only.
declare module 'sherpa-onnx-node' {
  const sherpa: { OnlineRecognizer: new (config: unknown) => any; readWave(path: string): { samples: Float32Array; sampleRate: number } }
  export default sherpa
}
