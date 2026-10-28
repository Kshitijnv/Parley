// Canned stand-in for the LLM. It follows the prompt contract in architecture.md:
// rewrite the noisy transcript into one clean question, answer in the first person,
// technical answers from general knowledge plus a resume tie-in where the resume
// supports it, behavioural answers only from resume facts (never invented).
import type { AnswerPrefs, ParsedResume, QuestionType } from '@shared/types'

export interface Ctx {
  resume: ParsedResume | null
  company: string | null
  role: string | null
}

interface Star {
  s: string
  t: string
  a: string
  r: string
}

interface Entry {
  id: string
  match: RegExp
  type: QuestionType
  question: string
  intro: (c: Ctx) => string
  points: (c: Ctx) => string[]
  more?: (c: Ctx) => string
  star?: (c: Ctx) => Star | null
  code?: { lang: string; src: string }
  math?: string
  tie?: (c: Ctx) => string | null
}

const has = (c: Ctx, skill: RegExp) =>
  !!c.resume && Object.values(c.resume.skills).flat().some((s) => skill.test(s))
const job = (c: Ctx, i = 0) => c.resume?.experience[i]
const years = (c: Ctx) => (c.resume?.summary.match(/(\w+(?: and a half)? years)/)?.[1] ?? null)

const ENTRIES: Entry[] = [
  {
    id: 'intro',
    match: /about yourself|introduce yourself|walk me through your (background|resume)|start(ed)? by telling/,
    type: 'introduction',
    question: 'Tell me about yourself',
    intro: (c) =>
      c.resume
        ? `I'm a ${c.resume.contact.headline?.toLowerCase() ?? 'software engineer'}${years(c) ? ` with about ${years(c)} of experience` : ''}. ${c.resume.summary.split('. ').slice(1).join('. ') || ''}`.trim()
        : "I'd keep this to a minute: who I am professionally, one or two results I'm proud of, and why this role fits.",
    points: (c) =>
      c.resume
        ? [
            ...c.resume.experience.slice(0, 2).map((e) => `At **${e.company}** (${e.period}): ${e.highlights[0]}.`),
            c.resume.projects[0] ? `Outside work I built **${c.resume.projects[0].name}**: ${c.resume.projects[0].description}` : '',
          ].filter(Boolean)
        : ['Add a resume to this session and I can fill this in with your real roles and results.'],
    more: (c) =>
      c.company ? `What draws me to ${c.company} is the chance to own features end to end${c.role ? ` as a ${c.role}` : ''}.` : 'I enjoy owning a feature from the database up to the UI.',
  },
  {
    id: 'delegates',
    match: /delegat/,
    type: 'technical',
    question: 'Explain delegates in C#',
    intro: () =>
      "A delegate is a type-safe reference to a method. It lets me treat a method like a value: store it in a variable, pass it to another method, and call it later.",
    points: () => [
      '**Signature-bound:** it can point at any method with a matching return type and parameters.',
      '**Multicast:** `+=` adds more methods, and one call runs them all in order.',
      '**Built-in types:** `Action<T>` for methods that return nothing and `Func<T, TResult>` for ones that return a value, so I rarely declare my own.',
      '**Events and callbacks** are built on top of delegates.',
    ],
    more: () =>
      'Lambdas compile to delegates too, and they can capture local variables as closures, which is handy but worth watching inside loops.',
    code: {
      lang: 'csharp',
      src: 'Func<int, int> square = x => x * x;\nAction<string> log = Console.WriteLine;\n\nlog($"9 squared is {square(9)}");\n\n// multicast\nAction notify = () => log("saved");\nnotify += () => log("audit written");\nnotify();',
    },
    tie: (c) =>
      has(c, /C#/) && job(c) ? `At ${job(c)!.company} I used \`Func<T, bool>\` filters so callers could plug in their own rules without touching the core query.` : null,
  },
  {
    id: 'di',
    match: /dependency injection|\bdi\b|inversion of control|ioc container/,
    type: 'technical',
    question: 'What is dependency injection and why use it?',
    intro: () =>
      'Dependency injection means a class receives the things it depends on from outside, usually through its constructor, instead of creating them itself.',
    points: () => [
      '**Loose coupling:** classes depend on interfaces, so I can swap an implementation without editing callers.',
      '**Testability:** in unit tests I pass a fake or a mock instead of the real database or HTTP client.',
      '**Lifetimes:** in ASP.NET Core a service is *transient*, *scoped* (one per request) or *singleton*.',
    ],
    more: () => 'The common mistake is injecting a scoped service into a singleton, which quietly keeps one request\'s state alive for the whole app.',
    code: {
      lang: 'csharp',
      src: 'builder.Services.AddScoped<IShipmentRepository, SqlShipmentRepository>();\n\npublic class ShipmentService(IShipmentRepository repo)\n{\n    public Task<Shipment?> Find(string id) => repo.GetAsync(id);\n}',
    },
    tie: (c) => (has(c, /ASP\.NET/) && job(c) ? `All of the ${job(c)!.company} API services are registered this way, which made the xUnit tests simple to write.` : null),
  },
  {
    id: 'async',
    match: /async|await|\btask\b|asynchronous/,
    type: 'technical',
    question: 'How do async and await work in C#?',
    intro: () =>
      '`async` and `await` let a method wait for slow work, like I/O, without blocking the thread. The compiler turns the method into a state machine that resumes when the awaited task completes.',
    points: () => [
      '**Frees threads:** while a database call is in flight, the request thread goes back to the pool.',
      '**Returns a `Task`:** callers can await it, combine it with `Task.WhenAll`, or cancel it with a `CancellationToken`.',
      '**Avoid `.Result` and `.Wait()`:** they block and can deadlock.',
    ],
    more: () => 'For CPU-bound work async does not help by itself; that is a job for `Task.Run` or a background worker.',
    code: {
      lang: 'csharp',
      src: 'public async Task<IReadOnlyList<Shipment>> LatestAsync(CancellationToken ct)\n{\n    var rows = await _db.Shipments\n        .OrderByDescending(s => s.UpdatedAt)\n        .Take(50)\n        .ToListAsync(ct);\n    return rows;\n}',
    },
    tie: (c) => (has(c, /Entity Framework/) ? 'Every EF Core query in my current API is async end to end, with the cancellation token passed down from the controller.' : null),
  },
  {
    id: 'index',
    match: /\bindex(es)?\b|slow query|query (is )?slow|optimi[sz]e .*(query|sql)/,
    type: 'technical',
    question: 'How would you speed up a slow SQL query?',
    intro: () =>
      'I start by measuring, not guessing: I look at the actual execution plan to see where the time goes, then fix the biggest cost first.',
    points: () => [
      '**Indexes:** add or adjust an index that matches the `WHERE` and `ORDER BY` columns; a covering index avoids key lookups.',
      '**Sargable filters:** no functions on indexed columns, so the index can actually be used.',
      '**Return less:** select only the columns needed and page the results.',
      '**Check statistics** and parameter sniffing if the same query is fast one day and slow the next.',
    ],
    code: {
      lang: 'sql',
      src: 'CREATE NONCLUSTERED INDEX IX_Shipments_Partner_Updated\n  ON Shipments (PartnerId, UpdatedAt DESC)\n  INCLUDE (Status, TrackingNo);',
    },
    tie: (c) => {
      const h = job(c)?.highlights.find((x) => /SQL|index/i.test(x))
      return h ? `That's how I approached it at ${job(c)!.company}: ${h.charAt(0).toLowerCase()}${h.slice(1)}.` : null
    },
  },
  {
    id: 'disagree',
    match: /disagree|conflict|push(ed)? back|difference of opinion|teammate/,
    type: 'behavioural',
    question: 'Describe a time you disagreed with a teammate on a technical choice',
    intro: (c) =>
      c.resume ? 'Yes, a good example is from my current role, where a teammate and I disagreed on how to fix slow lookups.' : 'Here is how I handle a technical disagreement.',
    points: (c) =>
      c.resume
        ? ['I measured both options on real traffic instead of arguing.', 'We picked the fix the data supported and wrote the decision down together.']
        : ['Agree on what "better" means first: latency, cost, risk.', 'Test both options cheaply, then decide on the data.', 'Write the decision down so it does not come back every sprint.'],
    star: (c) => {
      const j = job(c)
      const h = j?.highlights.find((x) => /SQL|index|load time|cache/i.test(x))
      if (!j || !h) return null
      return {
        s: `At ${j.company}, a teammate wanted to add a cache in front of a slow part of the system.`,
        t: 'I needed to fix the slowness without serving stale data to users.',
        a: 'I profiled both options against a copy of production traffic and found the real cause was the query itself, so I proposed fixing that first and caching only the hottest endpoint.',
        r: `${h}. We wrote the decision up together for the team.`,
      }
    },
  },
  {
    id: 'weakness',
    match: /weakness|area (of|for) improvement|improve on/,
    type: 'behavioural',
    question: 'What is your biggest weakness?',
    intro: () => 'Earlier on I tended to say yes to every request and then spread myself thin.',
    points: () => [
      'Now I write down what I am committing to each sprint and check new requests against it.',
      'If something new is urgent, I say which task will move so the trade-off is visible.',
    ],
    star: () => null,
  },
  {
    id: 'why',
    match: /why (do you want|are you interested|this (company|role))|why (us|join)/,
    type: 'behavioural',
    question: 'Why do you want to join us?',
    intro: (c) =>
      `${c.company ? `${c.company} is building` : 'This team is building'} the kind of product where the backend and the UI both matter, and that is the work I enjoy most.`,
    points: (c) => [
      c.role ? `The ${c.role} role lines up with what I do every day.` : 'The role lines up with what I do every day.',
      c.resume ? `I can bring my experience with ${Object.values(c.resume.skills).flat().slice(0, 3).join(', ')} from day one.` : 'I want a place where I can own features end to end.',
      'I am also looking for strong code review and mentoring, which I heard is part of the culture here.',
    ],
  },
  {
    id: 'twosum',
    match: /two sum|pair .*sum|target sum|add up to|coding (question|problem)|on (my|the) screen/,
    type: 'coding',
    question: 'Find two numbers in an array that add up to a target',
    intro: () => 'I would use a hash map so I only pass over the array once.',
    points: () => [
      '**Key step 1:** walk the array, and for each number compute `need = target - num`.',
      '**Key step 2:** if `need` is already in the map, return both indexes.',
      '**Key step 3:** otherwise store `num` with its index and continue.',
    ],
    more: () => 'Edge cases: duplicates (store the index after checking, not before), negative numbers (fine with a map), and no answer (return an empty result).',
    code: {
      lang: 'csharp',
      src: 'public static int[] TwoSum(int[] nums, int target)\n{\n    var seen = new Dictionary<int, int>();\n    for (int i = 0; i < nums.Length; i++)\n    {\n        int need = target - nums[i];\n        if (seen.TryGetValue(need, out int j))\n            return new[] { j, i };\n        seen[nums[i]] = i;\n    }\n    return Array.Empty<int>();\n}',
    },
    math: 'Time is $O(n)$ with one pass and $O(1)$ average lookups; space is $O(n)$ for the map, versus $O(n^2)$ time for checking every pair: $\\sum_{i=1}^{n-1} i = \\frac{n(n-1)}{2}$.',
  },
]

const FILLER = /\b(so|um+|uh+|okay|ok|like|la+|yeah|right|well|hmm+)\b[,.]?\s*/gi

export function pickEntry(text: string): Entry | null {
  const t = text.toLowerCase()
  return ENTRIES.find((e) => e.match.test(t)) ?? null
}

export function cleanQuestion(raw: string): string {
  const sentences = raw
    .replace(FILLER, '')
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(' ').length >= 3)
  const q = sentences.reverse().find((s) => s.endsWith('?')) ?? sentences[0] ?? raw.trim()
  const out = q.replace(/[.?!]+$/, '')
  return out.charAt(0).toUpperCase() + out.slice(1)
}

function formalise(s: string) {
  return s
    .replace(/\bI'm\b/g, 'I am')
    .replace(/\bdon't\b/g, 'do not')
    .replace(/\bit's\b/gi, 'it is')
    .replace(/\bI'd\b/g, 'I would')
    .replace(/\bcan't\b/g, 'cannot')
    .replace(/\bthat's\b/gi, 'that is')
    .replace(/\bhandy\b/g, 'useful')
}

export function compose(entry: Entry, prefs: AnswerPrefs, ctx: Ctx): string {
  const parts: string[] = []
  const star = prefs.star && entry.type === 'behavioural' && entry.star ? entry.star(ctx) : null
  let intro = entry.intro(ctx)
  if (prefs.filler_words) intro = `So, ${intro.charAt(0).toLowerCase()}${intro.slice(1)}`
  let points = entry.points(ctx)
  if (prefs.length === 'short') points = points.slice(0, 2)

  if (star) {
    parts.push(`**Situation:** ${star.s}`, `**Task:** ${star.t}`, `**Action:** ${star.a}`, `**Result:** ${star.r}`)
  } else if (entry.type === 'behavioural' && entry.star && !entry.star(ctx)) {
    parts.push(intro, "I don't have a matching example in the resume for this session, so here is how I'd approach it:", points.map((p) => `- ${p}`).join('\n'))
  } else if (prefs.format === 'full_script') {
    parts.push(intro, points.map((p) => p.replace(/^\*\*(.+?):\*\*\s*/, '$1: ')).join(' '))
  } else if (prefs.format === 'bullets') {
    parts.push(`- ${intro}\n${points.map((p) => `- ${p}`).join('\n')}`)
  } else {
    parts.push(intro, points.map((p) => `- ${p}`).join('\n'))
  }
  if (prefs.length === 'long' && entry.more) parts.push(entry.more(ctx))
  if (entry.code && prefs.length !== 'short') parts.push(`**Code**\n\n\`\`\`${entry.code.lang}\n${entry.code.src}\n\`\`\``)
  if (entry.math) parts.push(`**Complexity**\n\n${entry.math}`)
  const tie = entry.tie?.(ctx)
  if (tie) parts.push(tie)
  const md = parts.filter(Boolean).join('\n\n')
  return prefs.tone === 'formal' ? formalise(md) : md
}

export function genericAnswer(question: string, prefs: AnswerPrefs, ctx: Ctx): string {
  const lines = [
    `Good question. My short answer: I'd start by clarifying what "${question.toLowerCase()}" means for this team, then share how I've handled something similar.`,
    ctx.resume
      ? `- In my current role at **${ctx.resume.experience[0]?.company ?? 'my company'}** I'd lean on what I know best: ${Object.values(ctx.resume.skills).flat().slice(0, 4).join(', ')}.`
      : '- I would explain my reasoning step by step and keep the example concrete.',
    '- If I am unsure about a detail, I say so and explain how I would find out.',
  ]
  const md = prefs.length === 'short' ? lines.slice(0, 2).join('\n\n') : lines.join('\n')
  return prefs.tone === 'formal' ? formalise(md) : md
}

export function answerFor(excerpt: string, prefs: AnswerPrefs, ctx: Ctx, forced?: string): { question: string; md: string } {
  const entry = forced ? ENTRIES.find((e) => e.id === forced)! : pickEntry(excerpt)
  if (entry) return { question: entry.question, md: compose(entry, prefs, ctx) }
  const q = cleanQuestion(excerpt)
  return { question: q, md: genericAnswer(q, prefs, ctx) }
}

export function previewFor(type: QuestionType, prefs: AnswerPrefs, ctx: Ctx): { question: string; md: string } {
  const id = { behavioural: 'disagree', technical: 'delegates', coding: 'twosum', introduction: 'intro' }[type]
  return answerFor('', prefs, ctx, id)
}

/** Split text into ~40 ms batches the way main batches provider tokens. */
export function chunks(text: string): string[] {
  const out: string[] = []
  const words = text.split(/(\s+)/)
  for (let i = 0; i < words.length; i += 6) out.push(words.slice(i, i + 6).join(''))
  return out
}

// ---- notes, review, job import, company search ----

export function notesFor(questions: string[], company: string | null, role: string | null, theirLines: number) {
  const qs = questions.map((q) => {
    const e = pickEntry(q) ?? ENTRIES.find((x) => x.question === q)
    const note =
      e?.type === 'behavioural'
        ? 'Structured answer with a clear result. Keep the situation part to one sentence.'
        : e?.type === 'technical'
          ? 'Accurate core explanation. Add one real example from your work to make it stick.'
          : e?.type === 'coding'
            ? 'Right approach. Say the complexity out loud before writing code.'
            : 'Good overview. Lead with your strongest result.'
    return { question: q, responseNote: note }
  })
  return {
    details: { company, position: role },
    summary:
      questions.length > 0
        ? `The call covered ${questions.length} question${questions.length === 1 ? '' : 's'}${company ? ` with ${company}` : ''}, mixing ${[...new Set(qs.map((q) => (pickEntry(q.question)?.type ?? 'general')))].join(' and ')} topics. The other side spoke ${theirLines} time${theirLines === 1 ? '' : 's'}.`
        : 'The call was transcribed, but no questions were answered with the assistant, so this summary only covers the conversation itself.',
    questions: qs,
    nextSteps: [
      company ? `Send ${company} a short thank-you note within a day.` : 'Send a short thank-you note within a day.',
      qs.length ? `Practise a tighter version of "${qs[0].question}".` : 'Write down the questions you remember while they are fresh.',
      'Note anything you promised to follow up on.',
    ],
  }
}

export function reviewAnswer(message: string, transcript: string[], questions: string[]): string {
  const m = message.toLowerCase()
  if (/question|asked/.test(m) && questions.length) {
    return `They asked ${questions.length} question${questions.length === 1 ? '' : 's'} that you answered with the assistant:\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
  }
  if (/improve|better|feedback|how did i do/.test(m)) {
    return '- Lead with the result, then the detail.\n- Keep each answer under a minute when spoken.\n- Use one number per story; you did this well when you mentioned load times.'
  }
  if (/follow|email|thank/.test(m)) {
    return 'Here is a short follow-up you can adapt:\n\n> Thanks for the conversation today. I enjoyed talking about the team\'s API work and I\'m excited about the role. Happy to share more detail on anything we covered.'
  }
  const words = m.split(/\W+/).filter((w) => w.length > 3)
  const hit = transcript.find((l) => words.some((w) => l.toLowerCase().includes(w)))
  return hit
    ? `The closest moment in the transcript:\n\n> ${hit}\n\nAsk me something more specific about it if you like.`
    : "I couldn't find that in this call's transcript. Try asking about the questions, how you did, or a follow-up email."
}

const JD = (company: string, role: string) =>
  `${company} is hiring a ${role}.\n\nWhat you'll do:\n- Design, build and run backend services and the UI that uses them\n- Write clear APIs and own features from design to production\n- Review code and help the team improve its practices\n\nWhat we look for:\n- 2+ years of professional software development\n- Strong C# / .NET or a similar typed language, and a modern frontend framework\n- Solid SQL and an understanding of performance trade-offs\n- Clear written and spoken communication`

export function importJob(url: string): { company?: string; role?: string; description: string } {
  const u = new URL(url)
  const parts = u.pathname.split('/').filter(Boolean)
  const hostParts = u.hostname.replace(/^www\./, '').split('.')
  const boards = ['lever', 'greenhouse', 'workable', 'ashbyhq', 'linkedin', 'indeed', 'naukri', 'wellfound']
  const fromBoard = boards.some((b) => u.hostname.includes(b))
  const rawCompany = fromBoard ? parts[0] : hostParts[0] === 'careers' || hostParts[0] === 'jobs' ? hostParts[1] : hostParts[0]
  const company = rawCompany ? rawCompany.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : undefined
  const slug = parts.find((p) => /engineer|developer|manager|designer|analyst|scientist/i.test(p))
  const role = slug ? slug.replace(/[-_]/g, ' ').replace(/\d+/g, '').trim().replace(/\b\w/g, (c) => c.toUpperCase()) : 'Software Engineer'
  return { company, role, description: JD(company ?? 'The company', role) }
}

export { searchCompanies } from '@shared/companies'

export function convertedResumeMd(title: string, sample: string): string {
  const name = title.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').replace(/\b(resume|cv)\b/gi, '').trim() || 'Your name'
  return sample.replace(/^# .+$/m, `# ${name}`)
}
