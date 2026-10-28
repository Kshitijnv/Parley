// The non-live AI work: resume PDF -> Markdown and structured parse, call notes,
// the S09 preview, Ask AI about a past call, job link import and the mock
// interviewer. Every call goes through callModel()/streamModel() (revision 2 §11), so
// health and retry rules apply and nothing retries a used-up daily quota.
import { z } from 'zod'
import type { AnswerPrefs, Notes, ParsedResume, QuestionType } from '@shared/types'
import { all, get, run } from '../db/client'
import { answersFor, findResume, getSettings, notesFor, now, requireSession, reviewFor, segmentsFor, uuid } from '../db/repo'
import { changed, emit } from '../events'
import { AppError } from '../errors'
import { pdfText, readStored } from '../files'
import { callModel, streamModel } from './background'
import { blocked } from './health'
import {
  answerSystemPrompt,
  interviewerInstructions,
  JOB_EXTRACT,
  maxTokensFor,
  NOTES_CHUNK_INSTRUCTIONS,
  NOTES_INSTRUCTIONS,
  PREVIEW_QUESTIONS,
  RESUME_PARSE,
  RESUME_TO_MD,
  REVIEW_INSTRUCTIONS,
  splitReply,
  transcriptMessage,
} from './prompts'
import { ProviderError } from './provider'
import { firstAvailableModel, modelProviders } from './providers'
import { describe } from './run'

/** The model for background work: the default model if its provider has a key, else any keyed model. */
function workModelId(preferGoogle = false): string {
  const keys = modelProviders()
  const id = firstAvailableModel(keys, preferGoogle && keys.has('google') ? 'google:gemini-flash-lite' : getSettings().defaultModel)
  if (!id) throw new AppError('Add a Gemini API key in Settings first.', 'no_key')
  return id
}

const msg = (e: unknown) => (e instanceof AppError ? e.message : describe(e).message)

// ---------- resumes ----------

const converting = new Map<string, Promise<void>>()

/** One conversion per resume at a time: a second request waits for the one running. */
export function convertResume(id: string): Promise<void> {
  const running = converting.get(id)
  if (running) return running
  const p = doConvert(id).finally(() => converting.delete(id))
  converting.set(id, p)
  return p
}

async function doConvert(id: string): Promise<void> {
  const r = findResume(id)
  if (!r || !r.filePath) return
  run(`update resumes set md_status = 'converting', md_error = null, updated_at = ? where id = ?`, now(), id)
  emit('resumes:progress', { id, stage: 'converting' })
  changed('resumes')
  const buf = readStored(r.filePath)
  if (!buf) {
    run(`update resumes set md_status = 'failed', md_error = ?, updated_at = ? where id = ?`, 'The PDF file is missing from this PC. Upload it again.', now(), id)
    emit('resumes:progress', { id, stage: 'failed' })
    changed('resumes')
    return
  }
  let md = ''
  let method: 'ai' | 'text_extract' = 'ai'
  let aiProblem: string | null = null
  if (modelProviders().has('google')) {
    // At most 2 calls: Flash, then Flash-Lite only after an overload or a 404. Never
    // after a quota or auth error, and no per-call retries (revision 2 §11).
    for (const modelId of ['google:gemini-flash', 'google:gemini-flash-lite']) {
      if (blocked(modelId)) continue
      try {
        const res = await callModel({
          modelId,
          purpose: 'resume_convert',
          noRetry: true,
          system: RESUME_TO_MD,
          messages: [{ role: 'user', content: [{ type: 'file', data: buf, mediaType: 'application/pdf', filename: 'resume.pdf' }, { type: 'text', text: 'Convert this resume to Markdown.' }] }],
          totalMs: 60_000,
          maxOutputTokens: 8000,
        })
        md = res.text.trim().replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '').trim()
        if (md) break
      } catch (e) {
        aiProblem = msg(e)
        md = ''
        // A hung overloaded model (timeout) falls back like a 503 does.
        if (!(e instanceof ProviderError && (e.kind === 'overloaded' || e.kind === 'not_found' || e.kind === 'timeout'))) break
      }
    }
  }
  if (!md) {
    method = 'text_extract'
    try {
      md = await pdfText(buf)
    } catch {
      md = ''
    }
  }
  if (!findResume(id)) return
  if (!md) {
    const m = aiProblem
      ? `Couldn't convert this PDF: ${aiProblem} Local text extraction found no text either (it may be a scanned image).`
      : 'No text found in this PDF. It may be a scanned image: add a Gemini key and reconvert, or paste the text instead.'
    run(`update resumes set md_status = 'failed', md_error = ?, updated_at = ? where id = ?`, m, now(), id)
    emit('resumes:progress', { id, stage: 'failed' })
    changed('resumes')
    return
  }
  // The structured parse is on demand (S18), not a second call per upload.
  run(`update resumes set md_status = 'ready', md_method = ?, content_md = ?, md_error = null, parse_status = 'pending', parsed = null, updated_at = ? where id = ?`, method, md, now(), id)
  emit('resumes:progress', { id, stage: 'ready' })
  changed('resumes')
}

const parsedSchema = z.object({
  contact: z.object({ name: z.string(), headline: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable(), location: z.string().nullable() }),
  summary: z.string(),
  experience: z.array(z.object({ role: z.string(), company: z.string(), period: z.string(), highlights: z.array(z.string()) })),
  skills: z.array(z.object({ category: z.string(), items: z.array(z.string()) })),
  projects: z.array(z.object({ name: z.string(), description: z.string() })),
})

/** On demand: the first time the parsed view opens, or "Extract skills". */
export async function parseResume(id: string): Promise<void> {
  const r = findResume(id)
  if (!r || !r.contentMd.trim()) return
  if (r.parseStatus === 'parsing') return
  if (!modelProviders().size) {
    run(`update resumes set parse_status = 'skipped', parse_error = ?, updated_at = ? where id = ?`, 'Add an AI key in Settings to see parsed fields.', now(), id)
    changed('resumes')
    return
  }
  run(`update resumes set parse_status = 'parsing', parse_error = null, updated_at = ? where id = ?`, now(), id)
  changed('resumes')
  try {
    const res = await callModel<z.infer<typeof parsedSchema>>({ modelId: workModelId(true), purpose: 'resume_parse', system: RESUME_PARSE, messages: [{ role: 'user', content: r.contentMd.slice(0, 40_000) }], schema: parsedSchema, totalMs: 90_000 })
    const out = res.output!
    const parsed: ParsedResume = {
      contact: Object.fromEntries(Object.entries(out.contact).filter(([, v]) => v)) as ParsedResume['contact'],
      summary: out.summary,
      experience: out.experience,
      skills: Object.fromEntries(out.skills.filter((s) => s.items.length).map((s) => [s.category, s.items])),
      projects: out.projects,
    }
    if (!findResume(id)) return
    run(`update resumes set parse_status = 'ready', parsed = ?, parse_error = null, updated_at = ? where id = ?`, JSON.stringify(parsed), now(), id)
  } catch (e) {
    run(`update resumes set parse_status = 'failed', parse_error = ?, updated_at = ? where id = ?`, msg(e), now(), id)
  }
  changed('resumes')
}

// ---------- notes (S20) ----------

const notesSchema = z.object({
  company: z.string().nullable(),
  position: z.string().nullable(),
  summary: z.string(),
  questions: z.array(z.object({ question: z.string(), responseNote: z.string() })),
  nextSteps: z.array(z.string()),
})

const running = new Set<string>()

function setNotes(sessionId: string, status: Notes['status'], patch: Record<string, string | number | null> = {}) {
  const t = now()
  run(`insert or ignore into session_notes (id, session_id, status, created_at, updated_at) values (?, ?, 'pending', ?, ?)`, uuid(), sessionId, t, t)
  // Status and its fields in one statement: the table checks that a ready row has generated_at.
  const fields = { ...patch, status, updated_at: t }
  run(`update session_notes set ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} where session_id = ?`, ...Object.values(fields), sessionId)
  emit('notes:status', { sessionId, status })
  changed('notes')
}

export function queueNotes(sessionId: string) {
  setNotes(sessionId, 'pending')
  void runNotes(sessionId)
}

export async function runNotes(sessionId: string) {
  if (running.has(sessionId)) return
  running.add(sessionId)
  try {
    const s = requireSession(sessionId)
    const segs = segmentsFor(sessionId)
    if (!segs.length) {
      setNotes(sessionId, 'failed', { error: 'There is no transcript to write notes from.' })
      return
    }
    const modelId = workModelId()
    // While the model is cooling or out of quota, notes wait (pending) instead of spending a call.
    if (blocked(modelId)) {
      setNotes(sessionId, 'pending', { error: 'Waiting: the model is rate limited or its daily quota is used up. Notes retry at the next start.' })
      return
    }
    run('update session_notes set attempts = min(attempts + 1, 10), error = null where session_id = ?', sessionId)
    setNotes(sessionId, 'generating')
    const lines = segs.map((x) => `${x.speaker === 'you' ? 'You' : 'Them'}: ${x.text}`)
    const answered = answersFor(sessionId)
      .filter((a) => a.status === 'done' && a.question)
      .map((a) => `- ${a.question}`)
    // Map-reduce for long calls: summarise ~30k-character chunks, then write notes from those.
    let body = lines.join('\n')
    if (body.length > 40_000) {
      const parts: string[] = []
      let cur: string[] = []
      let size = 0
      for (const l of lines) {
        if (size + l.length > 30_000 && cur.length) {
          parts.push(cur.join('\n'))
          cur = []
          size = 0
        }
        cur.push(l)
        size += l.length
      }
      if (cur.length) parts.push(cur.join('\n'))
      const sums: string[] = []
      for (const [i, p] of parts.entries()) {
        sums.push(`Part ${i + 1}:\n${(await callModel({ modelId, purpose: 'notes_chunk', system: NOTES_CHUNK_INSTRUCTIONS, messages: [{ role: 'user', content: p }], totalMs: 90_000 })).text}`)
      }
      body = sums.join('\n\n')
    }
    const res = await callModel<z.infer<typeof notesSchema>>({
      modelId,
      purpose: 'notes',
      system: NOTES_INSTRUCTIONS,
      messages: [
        {
          role: 'user',
          content: `Company: ${s.companyName ?? 'unknown'}\nRole: ${s.roleTitle ?? 'unknown'}\nQuestions the user asked the assistant about:\n${answered.join('\n') || '(none)'}\n\nTranscript${body !== lines.join('\n') ? ' (summarised in parts)' : ''}:\n${body}`,
        },
      ],
      schema: notesSchema,
      totalMs: 120_000,
    })
    const out = res.output!
    setNotes(sessionId, 'ready', {
      details: JSON.stringify({ company: out.company ?? s.companyName, position: out.position ?? s.roleTitle }),
      summary: out.summary,
      questions: JSON.stringify(out.questions.slice(0, 15).map((q) => ({ question: q.question, response_note: q.responseNote }))),
      next_steps: JSON.stringify(out.nextSteps.slice(0, 6)),
      model: res.m.catalogId,
      error: null,
      generated_at: now(),
    })
  } catch (e) {
    if (!get('select 1 as x from sessions where id = ?', sessionId)) return
    // A quota or key problem isn't retried at the next start either (attempts are maxed).
    if (e instanceof ProviderError && (e.kind === 'quota_exhausted' || e.kind === 'auth')) run('update session_notes set attempts = 10 where session_id = ?', sessionId)
    setNotes(sessionId, 'failed', { error: msg(e) })
  } finally {
    running.delete(sessionId)
  }
}

export function pendingNotes(): string[] {
  return all<{ session_id: string }>(`select session_id from session_notes where status in ('pending','failed') and attempts < 3`).map((r) => r.session_id)
}

// ---------- S09 preview ----------

const previewCache = new Map<string, string>()

export async function preview(prefs: AnswerPrefs, questionType: QuestionType): Promise<{ previewId: string }> {
  const previewId = uuid()
  const settings = getSettings()
  const resume = get<{ id: string; content_md: string }>(`select id, content_md from resumes where md_status = 'ready' order by created_at desc limit 1`)
  const key = JSON.stringify([prefs, questionType, resume?.id ?? null, settings.defaultModel])
  void (async () => {
    const hit = previewCache.get(key)
    if (hit) {
      emit('prefs:previewDelta', { previewId, text: hit, done: true })
      return
    }
    const modelId = firstAvailableModel(modelProviders(), settings.defaultModel)
    // No call while the model is cooling or out of quota: the window shows "unavailable".
    if (!modelId || blocked(modelId)) {
      emit('prefs:previewDelta', { previewId, text: '', done: true })
      return
    }
    const q = PREVIEW_QUESTIONS[questionType]
    let acc = ''
    let last = 0
    try {
      const system = answerSystemPrompt({ type: 'interview', company: null, role: null, jobDescription: '', resumeMd: resume?.content_md ?? null, documents: [], instructions: '', prefs })
      await streamModel({
        modelId,
        purpose: 'preview',
        system,
        messages: [{ role: 'user', content: transcriptMessage(q.transcript) }],
        maxOutputTokens: maxTokensFor(prefs.length),
        onText: (d) => {
          acc += d
          if (Date.now() - last > 60) {
            last = Date.now()
            const r = splitReply(acc)
            if (r.ready) emit('prefs:previewDelta', { previewId, text: `**Question:** ${r.question ?? q.question}\n\n${r.answer}`, done: false })
          }
        },
      })
      const r = splitReply(acc, true)
      const text = `**Question:** ${r.question ?? q.question}\n\n${r.answer.trim()}`
      previewCache.set(key, text)
      emit('prefs:previewDelta', { previewId, text, done: true })
    } catch {
      emit('prefs:previewDelta', { previewId, text: '', done: true })
    }
  })()
  return { previewId }
}

// ---------- S23 Ask AI about a past call ----------

export async function askReview(sessionId: string, message: string): Promise<{ messageId: string }> {
  const s = requireSession(sessionId)
  const t = now()
  const userId = uuid()
  const replyId = uuid()
  run(`insert into review_messages (id, session_id, role, content, status, created_at, updated_at) values (?, ?, 'user', ?, 'done', ?, ?)`, userId, sessionId, message, t, t)
  run(`insert into review_messages (id, session_id, role, content, status, created_at, updated_at) values (?, ?, 'assistant', '', 'streaming', ?, ?)`, replyId, sessionId, t + 1, t + 1)
  void (async () => {
    let acc = ''
    try {
      const segs = segmentsFor(sessionId)
      const answers = answersFor(sessionId).filter((a) => a.status === 'done')
      const notes = notesFor(sessionId)
      const context = [
        `Call: ${s.companyName ?? 'untitled'}${s.roleTitle ? `, ${s.roleTitle}` : ''}`,
        notes?.summary ? `Notes summary: ${notes.summary}` : '',
        `Transcript:\n${segs.map((x) => `${x.speaker === 'you' ? 'You' : 'Them'}: ${x.text}`).join('\n').slice(-60_000) || '(no transcript saved)'}`,
        answers.length ? `Assistant answers during the call:\n${answers.map((a) => `Q: ${a.question}\nA: ${a.answerMd.slice(0, 1500)}`).join('\n\n').slice(-20_000)}` : '',
      ]
        .filter(Boolean)
        .join('\n\n')
      const prior = reviewFor(sessionId)
        .filter((x) => x.id !== userId && x.id !== replyId && x.status === 'done')
        .slice(-8)
        .map((x) => ({ role: x.role, content: x.content }) as const)
      let last = 0
      await streamModel({
        modelId: workModelId(),
        purpose: 'review',
        system: `${REVIEW_INSTRUCTIONS}\n\n${context}`,
        messages: [...prior, { role: 'user', content: message }],
        maxOutputTokens: 1200,
        onText: (d) => {
          acc += d
          if (Date.now() - last > 50) {
            last = Date.now()
            emit('review:delta', { messageId: replyId, text: acc, done: false })
          }
        },
      })
      run(`update review_messages set content = ?, status = 'done', updated_at = ? where id = ?`, acc, now(), replyId)
      emit('review:delta', { messageId: replyId, text: acc, done: true })
    } catch (e) {
      const m = msg(e)
      run(`update review_messages set content = ?, status = 'failed', updated_at = ? where id = ?`, acc || m, now(), replyId)
      emit('review:delta', { messageId: replyId, text: acc || m, done: true })
    }
  })()
  return { messageId: replyId }
}

// ---------- jobs:import ----------

const jobSchema = z.object({ company: z.string().nullable(), role: z.string().nullable(), description: z.string() })

function decodeEntities(s: string) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}

export function htmlToText(html: string) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<(br|\/p|\/div|\/h\d|\/li|\/ul|\/ol|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim()
}

/** schema.org JobPosting embedded by most job boards. */
function jsonLdJob(html: string): { company?: string; role?: string; description: string } | null {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]!)
      const items = (Array.isArray(data) ? data : data['@graph'] ?? [data]) as Array<Record<string, any>>
      const job = items.find((x) => x?.['@type'] === 'JobPosting')
      if (job?.description) {
        return { company: job.hiringOrganization?.name, role: job.title, description: htmlToText(String(job.description)) }
      }
    } catch {
      // not JSON
    }
  }
  return null
}

export async function importJob(url: string): Promise<{ company?: string; role?: string; description: string }> {
  const u = new URL(url)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new AppError('Paste a full link starting with https://', 'validation', 'url')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  let html = ''
  try {
    const res = await fetch(u, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Parley/0.1', accept: 'text/html' } })
    if (!res.ok) throw new AppError(`That page returned an error (${res.status}). It may be closed or need a login. Paste the description instead.`, 'unreadable')
    const reader = res.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (reader) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 2 * 1024 * 1024) {
        await reader.cancel()
        break
      }
      chunks.push(value)
    }
    html = Buffer.concat(chunks).toString('utf8')
  } catch (e) {
    if (e instanceof AppError) throw e
    throw ctrl.signal.aborted
      ? new AppError('That page took too long to load. Paste the description instead.', 'timeout')
      : new AppError('No connection, or the site refused the request. Paste the job description instead.', 'offline')
  } finally {
    clearTimeout(timer)
  }
  const ld = jsonLdJob(html)
  if (ld && ld.description.length > 200) return ld
  const text = htmlToText(html).slice(0, 30_000)
  if (text.length < 200) throw new AppError("We couldn't find a job post on that page. It may need a login. Paste the description instead.", 'unreadable')
  let modelId: string
  try {
    modelId = workModelId(true)
  } catch {
    throw new AppError('Add a Gemini key in Settings to read job pages, or paste the description instead.', 'no_key')
  }
  let out: z.infer<typeof jobSchema>
  try {
    out = (await callModel<z.infer<typeof jobSchema>>({ modelId, purpose: 'job_import', system: JOB_EXTRACT, messages: [{ role: 'user', content: `URL: ${u}\n\n${text}` }], schema: jobSchema, totalMs: 60_000 })).output!
  } catch (e) {
    throw new AppError(`${msg(e)} Paste the description instead.`, 'provider_error')
  }
  if (out.description.trim().length < 80) throw new AppError("We couldn't find a job post on that page. It may be closed or need a login. Paste the description instead.", 'unreadable')
  return { company: out.company ?? undefined, role: out.role ?? undefined, description: out.description.trim() }
}

// ---------- F08 mock interviewer ----------

const lastAsk = new Map<string, number>()

/** The AI interviewer's next question (F08). Needs a working model; debounced by 1.5 s. */
export async function nextInterviewQuestion(sessionId: string, asked: string[], lastAnswer: string): Promise<string> {
  const s = requireSession(sessionId)
  const t = performance.now()
  if (t - (lastAsk.get(sessionId) ?? -Infinity) < 1500) throw new AppError('One moment: the next question is on its way.', 'too_soon')
  lastAsk.set(sessionId, t)
  const id = firstAvailableModel(modelProviders(), s.model)
  if (!id) throw new AppError('Add an AI key in Settings to use the AI interviewer.', 'no_key')
  const resume = s.resumeId ? findResume(s.resumeId) : null
  let text: string
  try {
    text = (
      await callModel({
        modelId: id,
        purpose: 'interviewer',
        system: interviewerInstructions({ company: s.companyName, role: s.roleTitle, jobDescription: s.jobDescription, resumeMd: resume?.contentMd ?? null }),
        messages: [{ role: 'user', content: `Questions asked so far:\n${asked.map((q) => `- ${q}`).join('\n') || '(none yet)'}\n\nThe candidate's last answer:\n${lastAnswer || '(none yet)'}\n\nAsk the next question.` }],
        totalMs: 30_000,
        maxOutputTokens: 200,
      })
    ).text
  } catch (e) {
    throw new AppError(msg(e), 'provider_error')
  }
  const q = text.trim().replace(/^["']|["']$/g, '')
  if (!q) throw new AppError('The interviewer returned an empty question. Try again.', 'provider_error')
  return q
}
