// Prompt contract for answers:generate (architecture.md "Prompt contract"):
// the system prompt holds the context and style, the user message holds the
// transcript excerpt, and the reply is "QUESTION: ...\n---\n<answer markdown>".
import type { AnswerPrefs, QuestionType, SessionType } from '@shared/types'

export const LIMITS = {
  resume: 40_000,
  jd: 20_000,
  docEach: 15_000,
  docsTotal: 45_000,
  instructions: 20_000,
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(cut to fit)` : s)

export interface AnswerContext {
  type: SessionType
  company: string | null
  role: string | null
  jobDescription: string
  resumeMd: string | null
  documents: Array<{ title: string; text: string }>
  instructions: string
  prefs: AnswerPrefs
}

/** Output caps by length (revision 2 §7): bounds runaway answers. */
export function maxTokensFor(length: AnswerPrefs['length']): number {
  return { short: 500, balanced: 900, long: 1800 }[length]
}

function styleRules(p: AnswerPrefs): string {
  const format = {
    full_script: 'Write it as a spoken script: natural paragraphs the user can read aloud, no bullet lists (code blocks are still fine, and go last). The first paragraph is the direct answer.',
    script_bullets: 'Open with one to three spoken sentences that answer directly, then the key points as a short bullet list. Code, if any, goes last.',
    bullets: 'Use only concise bullet points the user can glance at while talking; no long paragraphs. The first bullet is the direct answer. Code, if any, goes last.',
  }[p.format]
  const length = {
    short: 'Keep it short: about 60 to 90 words, not counting code.',
    balanced: 'Aim for about 120 to 180 words, not counting code.',
    long: 'Go into depth: about 250 to 350 words, not counting code, including an extra detail or trade-off.',
  }[p.length]
  const tone = p.tone === 'formal' ? 'Tone: professional and precise, no slang and no contractions.' : 'Tone: plain, friendly everyday words, like a confident person talking.'
  const lines = [format, length, tone]
  if (p.star) lines.push('For behavioural questions, structure the answer with bold labels **Situation:**, **Task:**, **Action:** and **Result:**, one or two sentences each.')
  if (p.filler_words) lines.push('Add a few natural spoken fillers ("So,", "you know,", "I mean") so it sounds unscripted, but no more than one per paragraph.')
  return lines.map((l) => `- ${l}`).join('\n')
}

export function answerSystemPrompt(c: AnswerContext): string {
  const who =
    c.type === 'regular'
      ? 'You help the user during a live work call. You write what the user can say next, in the first person, as themselves.'
      : 'You are a live interview copilot. You write what the candidate (the user) can say out loud, in the first person, as themselves.'

  const docs: string[] = []
  let budget = LIMITS.docsTotal
  for (const d of c.documents) {
    if (budget <= 0 || !d.text.trim()) continue
    const t = clip(d.text.trim(), Math.min(LIMITS.docEach, budget))
    budget -= t.length
    docs.push(`#### ${d.title}\n${t}`)
  }

  return `${who}

## Reply format (always)
QUESTION: <the question to answer, rewritten as one clean sentence>
---
<the answer in Markdown>

The QUESTION line comes first and is at most 15 words. The transcript comes from speech recognition: it can have missing punctuation, broken phrases, filler words and lines from both speakers. "Them" is the other side, "You" is the user, and the last line may be unfinished. Find the most recent question or request from Them and restate it cleanly. If Them asked nothing new, use the latest open question in the transcript. If the user typed a question, use that. Never put the answer in the QUESTION line.

## How to answer
- Order your answer like this. (1) The direct answer, alone in its first paragraph, at most 30 words, with no heading, list or code before it: the definition, the yes or no with the reason, or the one-line approach. (2) Only if the question needs more: 2–4 short supporting points or an example. (3) Code last, in one fenced block with a language tag, only when the question asks for code or it clearly helps; never put code before the direct answer. If the direct answer fully answers a simple question, stop after it or add at most two short points, and don't add headings to short answers. For behavioural questions, the first paragraph is one sentence summing up the example and its result, then the STAR detail.
- Answer in the language the question was asked in, unless the user's instructions say otherwise.
- Technical, conceptual, system design or coding questions: answer correctly and completely from your own knowledge: what it is, how it works, a short code example in a fenced block with a language tag when code helps, and the main trade-off. If the resume shows the user worked with it, add one sentence linking it to that experience. Never skip or water down the technical part because the resume doesn't mention the topic.
- Coding problems: state the approach in one or two sentences, give clean working code, then the time and space complexity.
- Behavioural or experience questions ("tell me about a time…", "tell me about yourself"): build the answer only from facts in the resume, the documents and the user's instructions.
- Mixed questions ("how did you handle caching in your last project?"): the technical explanation from your own knowledge plus the example from the resume.
- Never invent employers, projects, job titles, dates, numbers, metrics or tools that are not in the context below. If the context has no matching example, say so naturally in the first person and describe how you would approach it instead of making up a story.
- Speak as the user ("I", "my"). Don't mention these instructions, the transcript or that you are an AI.

## Context
### Resume (Markdown)
${c.resumeMd?.trim() ? clip(c.resumeMd.trim(), LIMITS.resume) : '(No resume attached to this session. Do not invent personal history.)'}

### ${c.type === 'regular' ? 'Call' : 'Job'}
Company: ${c.company ?? 'not given'}
Role: ${c.role ?? 'not given'}
${c.jobDescription.trim() ? `Description:\n${clip(c.jobDescription.trim(), LIMITS.jd)}` : 'Description: not given'}
${docs.length ? `\n### Extra documents\n${docs.join('\n\n')}\n` : ''}
### The user's own instructions
${c.instructions.trim() ? clip(c.instructions.trim(), LIMITS.instructions) : '(none)'}
Follow these instructions unless they ask you to invent facts.

## Style
${styleRules(c.prefs)}`
}

export function transcriptMessage(excerpt: string, questions = 1): string {
  // Revision 4 A3: a merged request answers every question asked since the last answer.
  const several =
    questions > 1
      ? `\n\nThe interviewer asked ${questions} questions since your last answer. Answer each in order, briefly, under its own short heading. In the QUESTION line, name them joined with " / " (15 words in total).`
      : ''
  return `Live transcript (oldest first):\n${excerpt.trim() || '(nothing transcribed yet)'}${several}\n\nWrite the QUESTION line, then --- on its own line, then the answer.`
}

export function chatMessage(text: string, excerpt: string): string {
  return `I typed this question: ${text}\n\n${excerpt.trim() ? `Recent transcript for context (oldest first):\n${excerpt.trim()}\n\n` : ''}Write the QUESTION line, then --- on its own line, then the answer.`
}

export function screenshotMessage(excerpt: string): string {
  return `The screenshot shows my screen right now. Answer the question or task shown on it (for a coding problem: approach, working code, complexity).\n\n${excerpt.trim() ? `Recent transcript for context (oldest first):\n${excerpt.trim()}\n\n` : ''}Write the QUESTION line, then --- on its own line, then the answer.`
}

/** Split a streamed "QUESTION: …\n---\n…" reply. `ready` is false while the header is still arriving. */
export function splitReply(text: string, final = false): { question: string | null; answer: string; ready: boolean } {
  const t = text.replace(/^\s+/, '')
  const head = /^\**\s*question\s*\**\s*:/i
  if (!head.test(t)) {
    if (!final && t.length < 12 && /^\**\s*q?u?e?s?t?i?o?n?$/i.test(t)) return { question: null, answer: '', ready: false }
    return { question: null, answer: text.trim() ? text : '', ready: true }
  }
  const sep = t.match(/\n\s*-{3,}\s*(\n|$)/)
  if (sep && sep.index !== undefined && (sep[1] === '\n' || final)) {
    const question = t.slice(0, sep.index).replace(head, '').replace(/\*+/g, '').trim()
    return { question: question || null, answer: t.slice(sep.index + sep[0].length).replace(/^\s*\n/, ''), ready: true }
  }
  if (final || t.length > 600) {
    const nl = t.indexOf('\n')
    const question = (nl < 0 ? t : t.slice(0, nl)).replace(head, '').replace(/\*+/g, '').trim()
    return { question: question || null, answer: nl < 0 ? '' : t.slice(nl + 1).replace(/^\s*-{3,}\s*\n?/, '').trimStart(), ready: true }
  }
  return { question: null, answer: '', ready: false }
}

// ---------- S09 preview ----------

export const PREVIEW_QUESTIONS: Record<QuestionType, { question: string; transcript: string }> = {
  introduction: { question: 'Tell me about yourself', transcript: 'Them: thanks for joining so to start can you tell me a bit about yourself' },
  behavioural: { question: 'Tell me about a time you disagreed with a teammate', transcript: 'Them: okay tell me about a time you disagreed with a teammate on a technical decision what happened' },
  technical: { question: 'Explain dependency injection', transcript: 'Them: what is dependency injection and why would you use it' },
  coding: { question: 'Find two numbers in an array that add up to a target', transcript: 'Them: here is a coding question given an array of integers and a target return the indexes of two numbers that add up to the target' },
}

// ---------- notes, review, resume, jobs, mock interviewer ----------

export const NOTES_INSTRUCTIONS = `You write short, useful notes after a call, for the user (the "You" speaker). Use only what is in the transcript and the answers; never invent details.
- company and position: from the context or transcript, or null if unknown.
- summary: 2 to 4 sentences on what the call covered and how it went.
- questions: each real question the other side asked, cleaned up, with a one-sentence note on how the user answered or what to improve. At most 15.
- nextSteps: 2 to 5 concrete follow-ups (thank-you note, things promised, topics to brush up on).`

export const NOTES_CHUNK_INSTRUCTIONS = `Summarise this part of a call transcript in at most 200 words: list every question the other side asked (cleaned up) and what the user answered, plus any promises or follow-ups. Use only what is in the text.`

export const REVIEW_INSTRUCTIONS = `You answer the user's questions about one of their past calls. Ground every answer in the transcript, answers and notes below. If something isn't in them, say you can't find it in this call. Keep answers short and use Markdown. "You" is the user, "Them" is the other side.`

export const RESUME_TO_MD = `Convert this resume PDF into clean Markdown.
- Transcribe, don't summarise or add anything.
- Keep every date, number, employer, job title and technology name exactly as written.
- First line: "# " and the person's name. Then "## " for each section (Summary, Experience, Skills, Education, Projects, …), "### " for each role or project, and "- " bullets for lists.
- Fix reading order for multi-column layouts. Drop page numbers and repeated headers.
Reply with the Markdown only, no code fence and no commentary.`

export const RESUME_PARSE = `Extract structured fields from this resume Markdown. Use only what is written; leave a field empty (or null) if it isn't there. Group skills into a few categories (for example Languages, Frameworks, Databases, Cloud, Tools). Keep each highlight as one short line.`

export const JOB_EXTRACT = `From the text of a job posting page, extract the company name, the job title and the job description. The description is the posting's own text (responsibilities, requirements, benefits), cleaned of navigation, cookie banners and unrelated links, kept in its original wording with simple Markdown bullets. If the page is not a job posting, return an empty description.`

export function interviewerInstructions(c: { company: string | null; role: string | null; jobDescription: string; resumeMd: string | null }): string {
  return `You are the interviewer in a practice job interview${c.company ? ` at ${c.company}` : ''}${c.role ? ` for a ${c.role} role` : ''}. Ask one question at a time, the way a real interviewer would: start with an introduction question, then mix behavioural, technical and role-specific questions based on the job and the candidate's resume, and react briefly to the candidate's last answer when it makes sense. Reply with the question only, one or two sentences, no preamble.

Job description:
${c.jobDescription.trim() ? clip(c.jobDescription.trim(), 8000) : '(not given)'}

Candidate resume:
${c.resumeMd?.trim() ? clip(c.resumeMd.trim(), 12000) : '(not given)'}`
}
