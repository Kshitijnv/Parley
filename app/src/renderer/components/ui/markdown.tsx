import { memo, useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react'
import type { HighlighterCore } from 'shiki/core'
import { cn } from './cn'

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
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const long = code.split('\n').length > 17
  useEffect(() => {
    let alive = true
    getHighlighter()
      .then((h) => {
        const l = h.getLoadedLanguages().includes(lang) ? lang : 'text'
        const out = l === 'text' ? null : h.codeToHtml(code, { lang: l, theme: 'tokens' })
        if (alive) setHtml(out)
      })
      .catch(() => alive && setHtml(null))
    return () => {
      alive = false
    }
  }, [code, lang])
  const label = LANG_LABEL[lang] ?? (lang || 'code')
  return (
    <figure className="code-block group not-prose overflow-hidden rounded-md border border-glass-border bg-glass-code-bg text-glass-code-text" aria-label={`${label} code`}>
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

export const Markdown = memo(function Markdown({ text, className, streaming }: { text: string; className?: string; streaming?: boolean }) {
  return (
    <div className={cn('md', streaming && 'caret', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
