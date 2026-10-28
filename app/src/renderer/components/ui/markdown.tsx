import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react'
import type { HighlighterCore } from 'shiki/core'
import { isOpenFence, splitBlocks } from '@shared/answerBlocks'
import { cn } from './cn'

/**
 * False while a code block's fence is still streaming (revision 5 D4): the code shows as
 * plain text in its frame and is highlighted once, when the fence closes or the answer ends.
 */
const CodeSettled = createContext(true)

// Shiki with the JavaScript regex engine (no wasm, so it passes the CSP) and a
// css-variables theme whose colours come from the glass-code-* tokens.
let highlighter: Promise<HighlighterCore> | null = null
function getHighlighter() {
  highlighter ??= (async () => {
    const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ])
    return createHighlighterCore({
      themes: [createCssVariablesTheme({ name: 'tokens', variablePrefix: '--shiki-', fontStyle: true })],
      langs: [
        import('shiki/langs/csharp.mjs'),
        import('shiki/langs/typescript.mjs'),
        import('shiki/langs/javascript.mjs'),
        import('shiki/langs/python.mjs'),
        import('shiki/langs/java.mjs'),
        import('shiki/langs/sql.mjs'),
        import('shiki/langs/json.mjs'),
        import('shiki/langs/bash.mjs'),
        import('shiki/langs/cpp.mjs'),
        import('shiki/langs/go.mjs'),
        import('shiki/langs/html.mjs'),
        import('shiki/langs/css.mjs'),
      ],
      engine: createJavaScriptRegexEngine(),
    })
  })()
  return highlighter
}

const LANG_LABEL: Record<string, string> = { csharp: 'C#', cs: 'C#', ts: 'TypeScript', typescript: 'TypeScript', js: 'JavaScript', javascript: 'JavaScript', sql: 'SQL', py: 'Python', python: 'Python', cpp: 'C++' }

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const settled = useContext(CodeSettled)
  // Highlighted HTML belongs to the exact code it was made from; anything else is stale.
  const [hl, setHl] = useState<{ code: string; html: string | null } | null>(null)
  const runs = useRef(0)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // The long-code collapse waits for the closing fence, so the frame never shrinks mid-stream.
  const long = settled && code.split('\n').length > 17
  useEffect(() => {
    if (!settled) return
    let alive = true
    runs.current++
    getHighlighter()
      .then((h) => {
        const l = h.getLoadedLanguages().includes(lang) ? lang : 'text'
        const out = l === 'text' ? null : h.codeToHtml(code, { lang: l, theme: 'tokens' })
        if (alive) setHl({ code, html: out })
      })
      .catch(() => alive && setHl({ code, html: null }))
    return () => {
      alive = false
    }
  }, [code, lang, settled])
  const html = hl && hl.code === code ? hl.html : null
  const label = LANG_LABEL[lang] ?? (lang || 'code')
  return (
    <figure
      className="code-block group not-prose overflow-hidden rounded-md border border-glass-border bg-glass-code-bg text-glass-code-text"
      aria-label={`${label} code`}
      data-streaming={settled ? undefined : 'true'}
      data-highlight-runs={runs.current}
    >
      <figcaption className="flex h-7 items-center justify-between border-b border-glass-border/60 pr-1 pl-3">
        <span className="text-2xs font-medium text-glass-code-label">{label}</span>
        <button
          type="button"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={() => {
            void navigator.clipboard?.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          className="on-glass flex h-6 items-center gap-1 rounded-sm px-1.5 text-2xs text-glass-code-label hover:text-glass-code-text"
        >
          {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.75} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <div className={cn('scroll-thin overflow-x-auto p-3', long && !expanded && 'max-h-80 overflow-y-auto')}>
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre>
            <code>{code}</code>
          </pre>
        )}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="on-glass flex h-7 w-full items-center justify-center gap-1 border-t border-glass-border/60 text-2xs text-glass-code-label hover:text-glass-code-text"
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {expanded ? 'Collapse' : 'Show all'}
        </button>
      )}
    </figure>
  )
}

const MD_COMPONENTS: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className: cls, children }) => {
    const m = /language-(\w+)/.exec(cls ?? '')
    const raw = String(children ?? '')
    if (m || raw.includes('\n')) return <CodeBlock code={raw.replace(/\n$/, '')} lang={m?.[1] ?? 'text'} />
    return <code>{children as ReactNode}</code>
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
}

/** One top-level block. Memoized: a finished block keeps its DOM while later text streams. */
const Block = memo(function Block({ text, lead, settled }: { text: string; lead: boolean; settled: boolean }) {
  return (
    <CodeSettled.Provider value={settled}>
      <div className={cn('md-block', lead && 'md-lead font-medium')}>
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={MD_COMPONENTS}>
          {text}
        </ReactMarkdown>
      </div>
    </CodeSettled.Provider>
  )
})

/**
 * Markdown rendered block by block (architecture.md revision 5 D4). Only the last block
 * re-renders while an answer streams. `lead` is `leadEnd()` of the text: when it's > 0
 * the direct-answer paragraph is its own first block, styled as the lead.
 */
export const Markdown = memo(function Markdown({ text, className, streaming, lead }: { text: string; className?: string; streaming?: boolean; lead?: number | null }) {
  const blocks = useMemo(() => splitBlocks(text, lead ?? null), [text, lead])
  return (
    <div className={cn('md', streaming && 'caret', className)}>
      {blocks.map((b, i) => (
        <Block key={i} text={b} lead={i === 0 && !!lead && lead > 0} settled={!streaming || i < blocks.length - 1 || !isOpenFence(b)} />
      ))}
    </div>
  )
})
