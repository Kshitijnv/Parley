// Time-to-first-token bench (architecture.md revision 6 M7). Development builds only:
// `PARLEY_BENCH=<out.json> electron .` runs it with the user's saved keys and quits
// (scripts/ttft-bench.mjs does this). It sends the app's real live-answer prompt with a
// fictional resume, so no user data is sent. It prints model ids, numbers and status
// codes only, never response text.
import { writeFileSync } from 'node:fs'
import { DEFAULT_PREFS, providerOf } from '@shared/catalog'
import type { Provider } from '@shared/types'
import { getKey, providersWithKeys } from '../secrets'
import { answerSystemPrompt, maxTokensFor, transcriptMessage, type AnswerContext } from './prompts'
import { ProviderError } from './provider'
import { providerModelId } from './providers'
import { sdkProvider } from './sdk'
import { providerFetch, type Transport } from './transport'

type SdkProvider = Exclude<Provider, 'deepgram' | 'logodev'>

interface Cell {
  model: string
  provider: SdkProvider
  thinking: 'minimum' | 'default'
  context: 'full' | 'small'
  transport: Transport
}

interface Sample {
  ttftMs: number | null
  totalMs: number
  inputTokens?: number | null
  cachedTokens?: number | null
  reasoningTokens?: number | null
  outputTokens?: number | null
  error?: string
}

const QUESTIONS = [
  'Them: What is the difference between a process and a thread?',
  'Them: Can you explain how garbage collection works in .NET?',
  'Them: Tell me about a time you improved the performance of an API.',
  'Them: Why would you choose a message queue over direct HTTP calls?',
  'Them: How would you design a rate limiter for a public API?',
]

const RESUME = `# Asha Verma
Backend engineer · Pune, India

## Summary
Backend engineer with 4 years of experience building .NET APIs.

## Experience
### Software Engineer, Lumen Freight (2022 – present)
- Built a shipment tracking API in ASP.NET Core serving 2 million requests a day.
- Cut report load time from 9 s to 1.2 s with covering indexes in SQL Server.
- Moved nightly batch jobs to Azure Functions with Service Bus triggers.

### Junior Developer, Orbit Retail (2020 – 2022)
- Maintained an inventory service in C# and Entity Framework Core.

## Skills
C#, ASP.NET Core, Entity Framework Core, SQL Server, Azure, Docker, React`

// Filler that is the size of a long job description and two documents, to measure what a
// large context costs. The words don't matter, the token count does.
const filler = (label: string, chars: number) => {
  const line = `${label}: the team owns services for tracking, billing and reporting, works in two-week sprints, reviews every pull request, and runs on Azure with SQL Server and Service Bus.\n`
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars)
}

function context(size: Cell['context']): AnswerContext {
  return {
    type: 'interview',
    company: 'Lumen Freight',
    role: 'Senior Backend Engineer',
    jobDescription: size === 'full' ? filler('Job', 12_000) : 'Senior backend engineer for .NET services on Azure.',
    resumeMd: RESUME,
    documents: size === 'full' ? [{ title: 'Team handbook', text: filler('Handbook', 15_000) }, { title: 'Architecture notes', text: filler('Architecture', 15_000) }] : [],
    instructions: '',
    prefs: DEFAULT_PREFS,
  }
}

const SPACING_MS = 6500
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  return Math.round(a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]!)
}

/** What a Gemini alias points to, and the Flash-Lite ids this key can call (metadata only). */
async function geminiInfo(key: string) {
  const get = async (path: string) => {
    const r = await providerFetch(`https://generativelanguage.googleapis.com/v1beta/${path}`, { headers: { 'x-goog-api-key': key } })
    return r.ok ? ((await r.json()) as Record<string, unknown>) : { status: r.status }
  }
  const pick = (m: Record<string, unknown>) => ({ name: m['name'], version: m['version'], displayName: m['displayName'], thinking: m['thinking'] })
  const aliases: Record<string, unknown> = {}
  for (const id of ['gemini-flash-lite-latest', 'gemini-flash-latest']) aliases[id] = pick(await get(`models/${id}`))
  const list = (await get('models?pageSize=1000')) as { models?: Array<Record<string, unknown>> }
  const flash = (list.models ?? []).map(pick).filter((m) => /flash/i.test(String(m.name)))
  return { aliases, flash }
}

async function runCell(cell: Cell, key: string, stopped: Set<string>): Promise<Sample[]> {
  process.env['PARLEY_FETCH'] = cell.transport
  const p = sdkProvider(cell.provider, key, () => false)
  const system = answerSystemPrompt(context(cell.context))
  const out: Sample[] = []
  for (const q of QUESTIONS) {
    if (stopped.has(cell.provider)) break
    const t0 = performance.now()
    let first: number | null = null
    const s: Sample = { ttftMs: null, totalMs: 0 }
    try {
      const messages = [{ role: 'user' as const, content: transcriptMessage(q) }]
      for await (const ev of p.stream({ model: cell.model, system, messages, maxOutputTokens: maxTokensFor('balanced'), thinking: cell.thinking }, AbortSignal.timeout(60_000))) {
        if (ev.type === 'text' && first === null) first = performance.now()
        if (ev.type === 'finish') {
          s.inputTokens = ev.usage?.input
          s.outputTokens = ev.usage?.output
          s.cachedTokens = ev.usage?.cached
          s.reasoningTokens = ev.usage?.reasoning
        }
      }
    } catch (e) {
      s.error = e instanceof ProviderError ? `${e.kind}${e.status ? `:${e.status}` : ''}` : (e as Error).name
      // A 429 or a rejected key ends this provider's runs: the bench never retries.
      if (e instanceof ProviderError && (e.kind === 'rate_limited' || e.kind === 'quota_exhausted' || e.kind === 'auth')) stopped.add(cell.provider)
    }
    s.ttftMs = first === null ? null : Math.round(first - t0)
    s.totalMs = Math.round(performance.now() - t0)
    out.push(s)
    console.log(`  ${cell.model} thinking=${cell.thinking} context=${cell.context} fetch=${cell.transport}  ttft=${s.ttftMs ?? '-'} ms  total=${s.totalMs} ms  in=${s.inputTokens ?? '-'} cached=${s.cachedTokens ?? '-'} think=${s.reasoningTokens ?? '-'}${s.error ? `  error=${s.error}` : ''}`)
    await sleep(SPACING_MS)
  }
  return out
}

export async function runBench(outFile: string) {
  const keys = providersWithKeys()
  const report: Record<string, unknown> = { at: new Date().toISOString(), providers: [...keys] }
  const cells: Cell[] = []
  const cell = (catalogOrRaw: string, c: Omit<Cell, 'model' | 'provider'>) => {
    const provider = providerOf(catalogOrRaw) as SdkProvider
    const model = catalogOrRaw.includes('/') ? catalogOrRaw.split('/')[1]! : providerModelId(catalogOrRaw, 'live')
    if (keys.has(provider)) cells.push({ model, provider, ...c })
  }
  const only = process.env['PARLEY_BENCH_ONLY']
  if (keys.has('google')) {
    const key = (await getKey('google'))!
    report['gemini'] = await geminiInfo(key)
    console.log('Gemini aliases and Flash models:', JSON.stringify(report['gemini'], null, 1))
    if (only === 'info') return writeFileSync(outFile, JSON.stringify(report, null, 2))
    cell('google:gemini-flash-lite', { thinking: 'default', context: 'full', transport: 'net' })
    cell('google:gemini-flash-lite', { thinking: 'minimum', context: 'full', transport: 'net' })
    cell('google:gemini-flash-lite', { thinking: 'minimum', context: 'small', transport: 'net' })
    cell('google:gemini-flash-lite', { thinking: 'minimum', context: 'full', transport: 'node' })
  }
  // Extra ids to compare, as "<provider>:<catalog id>" or "<provider>:x/<provider model id>".
  for (const id of (process.env['PARLEY_BENCH_MODELS'] ?? '').split(',').filter(Boolean)) cell(id, { thinking: 'minimum', context: 'full', transport: 'net' })
  cell('groq:llama-instant', { thinking: 'default', context: 'full', transport: 'net' })
  cell('openai:gpt-mini', { thinking: 'default', context: 'full', transport: 'net' })

  const stopped = new Set<string>()
  const results: Array<Cell & { samples: Sample[]; p50: number | null; p90: number | null }> = []
  for (const c of cells) {
    const key = await getKey(c.provider)
    if (!key) continue
    const samples = await runCell(c, key, stopped)
    const t = samples.map((s) => s.ttftMs).filter((x): x is number => x !== null)
    results.push({ ...c, samples, p50: pct(t, 50), p90: pct(t, 90) })
    writeFileSync(outFile, JSON.stringify({ ...report, results }, null, 2))
  }
  console.log('\nSummary (ttft ms):')
  for (const r of results) console.log(`  ${r.model.padEnd(36)} thinking=${r.thinking.padEnd(7)} context=${r.context.padEnd(5)} fetch=${r.transport.padEnd(4)} p50=${r.p50 ?? '-'} p90=${r.p90 ?? '-'} n=${r.samples.length}`)
  writeFileSync(outFile, JSON.stringify({ ...report, results }, null, 2))
}
