// Time-to-first-token bench (architecture.md revision 6 M7). Runs the built app in bench
// mode with your saved provider keys (close Parley first: one instance at a time), then
// prints p50/p90 per cell and writes the JSON report.
//
//   npm run build && node scripts/ttft-bench.mjs [out.json]
//   PARLEY_BENCH_ONLY=info node scripts/ttft-bench.mjs   (alias lookup only, no generation)
//   PARLEY_BENCH_MODELS=google:x/gemini-3.5-flash-lite node scripts/ttft-bench.mjs
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import electron from 'electron'

const out = resolve(process.argv[2] ?? `.smoke/ttft-bench-${Date.now()}.json`)
const env = { ...process.env, PARLEY_BENCH: out }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [resolve(import.meta.dirname, '..')], { env, stdio: 'inherit' })
child.on('exit', (code) => {
  console.log(`\nReport: ${out}`)
  process.exit(code ?? 0)
})
