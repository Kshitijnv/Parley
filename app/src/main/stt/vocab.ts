// Custom vocabulary for cloud speech (architecture.md revision 7 S5): terms from the
// session's company, role, job description, resume and documents, so the recognizer
// writes "ASP.NET Core" rather than "ASP dot net core". Pure: no I/O, no logging of terms.
import { SAYINGS, TECH_TERMS } from './vocab-terms'

export interface VocabItem {
  content: string
  sounds_like?: string[]
}

export interface VocabSource {
  company: string | null
  role: string | null
  jobDescription: string
  resumeMd: string | null
  documents: Array<{ title: string }>
  instructions: string
}

export const VOCAB_MAX = 300

const KNOWN = new Map(TECH_TERMS.map((t) => [t.toLowerCase(), t]))
// Capitalised words that start sentences or are just English, never worth a vocab slot.
const STOP = new Set(
  'the a an and or but if then i we you he she they it this that these those my our your their in on at to for of with by from as is are was were be been have has had do did will would can could should may might must not no yes also about above after before over under into out up down all any each most more some such only own same so than too very just new senior junior lead principal staff team role job work company experience skills summary education projects responsibilities requirements years year month months day days monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december present remote hybrid india usa us uk engineer engineers developer developers software manager architect analyst intern consultant lead specialist officer director head'.split(' '),
)

// A term worth biasing: has a digit or one of . # + /, or a capital after its first letter (camelCase, acronyms).
const SHAPED = /[0-9.#+/]|^.+[A-Z]/
const TOKEN = /\.?[A-Za-z][\w.#+/-]*[\w#+]|[A-Za-z]/g
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
// Known terms with a space or punctuation are matched as a whole first ("ASP.NET Core", ".NET"), longest first.
const PHRASES = TECH_TERMS.filter((t) => /[\s.#+/()]/.test(t))
  .sort((a, b) => b.length - a.length)
  .map((t) => ({ term: t, re: new RegExp(`(?<![\\w.])${escape(t)}(?![\\w#+])`, 'gi') }))

/** Spelled-out letters for 2–5 letter acronyms: "AWS" → "A W S". */
function spelled(t: string): string[] | undefined {
  return /^[A-Z]{2,5}$/.test(t) ? [t.split('').join(' ')] : undefined
}

/** `names`: also keep capitalised words mid-sentence (product and company names). */
function candidates(text: string, names = true): string[] {
  const out: string[] = []
  let rest = text
  for (const p of PHRASES) {
    rest = rest.replace(p.re, () => {
      out.push(p.term)
      return ' '
    })
  }
  for (const sentence of rest.split(/(?<=[.!?:\n])\s+|\n/)) {
    const toks = sentence.match(TOKEN) ?? []
    toks.forEach((tok, i) => {
      const t = tok.replace(/[.-]+$/, '')
      if (t.length < 2 || STOP.has(t.toLowerCase())) return
      const known = KNOWN.get(t.toLowerCase())
      if (known) return void out.push(known)
      if (SHAPED.test(t)) return void out.push(t)
      // A capitalised word mid-sentence is probably a name (product, company, tool).
      if (names && i > 0 && /^[A-Z][a-z]{2,}$/.test(t)) out.push(t)
    })
  }
  return out
}

/** "Vocabulary: term, term" lines in the session instructions. */
function userTerms(instructions: string): string[] {
  return [...instructions.matchAll(/^\s*vocabulary\s*:\s*(.+)$/gim)].flatMap((m) => m[1]!.split(/[,;]/).map((t) => t.trim())).filter((t) => t.length > 1 && t.length <= 60)
}

/** Build the list: user terms first, then company and role, then the rest by frequency; capped at VOCAB_MAX. */
export function buildVocab(src: VocabSource): VocabItem[] {
  const ordered: string[] = [...userTerms(src.instructions)]
  if (src.company?.trim()) ordered.push(src.company.trim())
  // Titles are capitalised throughout, so only tech terms count from the role.
  if (src.role) ordered.push(...candidates(src.role, false))
  const counts = new Map<string, number>()
  const body = [src.jobDescription, src.resumeMd ?? '', ...src.documents.map((d) => d.title)].join('\n')
  for (const t of candidates(body)) counts.set(t, (counts.get(t) ?? 0) + 1)
  ordered.push(...[...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).map(([t]) => t))
  const seen = new Set<string>()
  const out: VocabItem[] = []
  for (const raw of ordered) {
    const content = raw.replace(/\s+/g, ' ').trim()
    const key = content.toLowerCase()
    if (!content || content.length > 60 || seen.has(key)) continue
    seen.add(key)
    const sounds = SAYINGS[KNOWN.get(key) ?? content] ?? spelled(content)
    out.push(sounds ? { content, sounds_like: sounds } : { content })
    if (out.length >= VOCAB_MAX) break
  }
  return out
}
