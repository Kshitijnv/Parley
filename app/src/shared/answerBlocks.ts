// Progressive answer delivery (architecture.md revision 5 D3, D4): where the lead
// paragraph (the direct answer) ends, and how streamed Markdown splits into top-level
// blocks so finished blocks never re-render. Pure functions shared by main (timing
// diagnostics) and the renderer (display). They must agree with react-markdown on fences
// and blank lines; when unsure, they keep text together (today's single-tree rendering).

/** A lead longer than this is ordinary prose, not a definition. */
export const LEAD_MAX_CHARS = 400

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
// A line that starts a non-paragraph block: list, heading, fence, table, block quote.
const BLOCK_START = /^\s{0,3}([-*+]\s|\d{1,3}[.)]\s|#{1,6}\s|`{3,}|~{3,}|\||>)/

/**
 * End offset of the lead (the first paragraph) in streamed answer Markdown, or null
 * while it is still open. 0 when the answer doesn't start with a paragraph (it opens
 * with a list, heading or fence) or the "paragraph" is too long to be a lead.
 */
export function leadEnd(md: string, final: boolean): number | null {
  const start = md.length - md.trimStart().length
  if (start >= md.length) return final ? 0 : null
  const lines = md.slice(start).split('\n')
  if (BLOCK_START.test(lines[0] ?? '')) return 0
  let offset = start
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const isLast = i === lines.length - 1
    if (i > 0 && (line.trim() === '' || BLOCK_START.test(line))) {
      // A blank line or a new block only counts once its line is complete (or a new
      // block has started on it): a lone "-" still streaming could be "-ish" prose.
      if (line.trim() === '' && (!isLast || final)) return check(md, offset - 1, start)
      if (line.trim() !== '' && BLOCK_START.test(line)) return check(md, offset - 1, start)
    }
    offset += line.length + 1
    if (offset - 1 - start > LEAD_MAX_CHARS) return 0
  }
  if (final) return check(md, md.length, start)
  return null
}

function check(md: string, end: number, start: number): number {
  const lead = md.slice(start, end).trimEnd()
  if (!lead || lead.length > LEAD_MAX_CHARS) return 0
  return start + lead.length
}

/**
 * Split Markdown into top-level blocks at blank lines outside fenced code. Every block
 * but the last is complete; the last may still be streaming. When `lead` > 0 the lead
 * is always its own first block, even if a list follows it with no blank line.
 */
export function splitBlocks(md: string, lead: number | null = null): string[] {
  const head = lead && lead > 0 ? [md.slice(0, lead)] : []
  const rest = lead && lead > 0 ? md.slice(lead).replace(/^\s*\n/, '') : md
  const out: string[] = []
  let cur: string[] = []
  let fence: string | null = null
  for (const line of rest.split('\n')) {
    const m = FENCE.exec(line)
    if (fence) {
      cur.push(line)
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && line.trim() === m[1]) fence = null
      continue
    }
    if (m) fence = m[1]!
    if (line.trim() === '' && cur.length) {
      out.push(cur.join('\n'))
      cur = []
      continue
    }
    if (line.trim() !== '' || cur.length) cur.push(line)
  }
  if (cur.length) out.push(cur.join('\n'))
  return [...head, ...out]
}

/** True when a block is fenced code whose closing fence hasn't arrived yet. */
export function isOpenFence(block: string): boolean {
  const lines = block.split('\n')
  const m = FENCE.exec(lines[0] ?? '')
  if (!m) return false
  const fence = m[1]!
  for (let i = 1; i < lines.length; i++) {
    const c = FENCE.exec(lines[i]!)
    if (c && c[1]![0] === fence[0] && c[1]!.length >= fence.length && lines[i]!.trim() === c[1]) return false
  }
  return true
}
