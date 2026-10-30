// Seed data for the mock layer. Every person and company here is fictional.
import { DEFAULT_ANSWER_ROUTING, DEFAULT_AUTO_POLICY, DEFAULT_CLOUD_STT, DEFAULT_HOTKEYS, DEFAULT_PREFS } from '@shared/catalog'
import type { Answer, Notes, ParsedResume, Segment, Settings } from '@shared/types'
import type { Db, DocumentStored, ResumeRowStored, SessionRow } from './store'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const SAMPLE_RESUME_MD = `# Riya Sharma
Software Engineer · Pune, India · riya.sharma@example.com · +91 90000 00000

## Summary
Software engineer with two and a half years building web applications on C#, .NET and Angular. Comfortable across the stack, from SQL Server schemas to Angular components, and focused on clean APIs and fast pages.

## Experience
### Software Engineer, Brightline Logistics (Jan 2024 – present)
- Built the shipment tracking API in ASP.NET Core 8 used by 40+ partner integrations
- Cut the dispatch dashboard load time from 4.1 s to 1.3 s by moving filtering to indexed SQL views
- Introduced background jobs with Hangfire for nightly reconciliation, replacing a fragile cron script
- Mentored two interns on code review and unit testing with xUnit

### Associate Software Engineer, Quillsoft (Jun 2023 – Dec 2023)
- Maintained an Angular 15 billing portal; migrated 30 components to standalone components
- Wrote REST endpoints in .NET 6 with Entity Framework Core and SQL Server

## Skills
- **Frontend:** Angular, TypeScript, RxJS, HTML, SCSS
- **Backend:** C#, .NET 8, ASP.NET Core, Entity Framework Core, Hangfire
- **Database:** SQL Server, PostgreSQL, Redis
- **Security & messaging:** JWT, OAuth 2.0, RabbitMQ
- **Tools & testing:** Git, Azure DevOps, Docker, xUnit, Postman
- **Architecture & practices:** REST, clean architecture, SOLID, CI/CD

## Projects
- **FleetPulse:** a real-time vehicle map using SignalR and Angular, showing 2,000 vehicles at 1 s refresh
- **ExpenseLens:** a receipt-scanning side project with Azure Form Recognizer and .NET minimal APIs

## Education
B.E. Computer Engineering, Savitribai Phule Pune University, 2023
`

export const SAMPLE_PARSED: ParsedResume = {
  contact: {
    name: 'Riya Sharma',
    headline: 'Software Engineer',
    email: 'riya.sharma@example.com',
    phone: '+91 90000 00000',
    location: 'Pune, India',
  },
  summary:
    'Software engineer with two and a half years building web applications on C#, .NET and Angular, focused on clean APIs and fast pages.',
  experience: [
    {
      role: 'Software Engineer',
      company: 'Brightline Logistics',
      period: 'Jan 2024 – present',
      highlights: [
        'Shipment tracking API in ASP.NET Core 8 for 40+ partner integrations',
        'Dashboard load time cut from 4.1 s to 1.3 s with indexed SQL views',
        'Nightly reconciliation moved to Hangfire background jobs',
      ],
    },
    {
      role: 'Associate Software Engineer',
      company: 'Quillsoft',
      period: 'Jun 2023 – Dec 2023',
      highlights: ['Angular 15 billing portal: 30 components moved to standalone', 'REST endpoints in .NET 6 with EF Core'],
    },
  ],
  skills: {
    Frontend: ['Angular', 'TypeScript', 'RxJS', 'HTML', 'SCSS'],
    Backend: ['C#', '.NET 8', 'ASP.NET Core', 'Entity Framework Core', 'Hangfire'],
    Database: ['SQL Server', 'PostgreSQL', 'Redis'],
    'Security & messaging': ['JWT', 'OAuth 2.0', 'RabbitMQ'],
    'Tools & testing': ['Git', 'Azure DevOps', 'Docker', 'xUnit', 'Postman'],
    'Architecture & practices': ['REST', 'Clean architecture', 'SOLID', 'CI/CD'],
  },
  projects: [
    { name: 'FleetPulse', description: 'Real-time vehicle map with SignalR and Angular, 2,000 vehicles at 1 s refresh.' },
    { name: 'ExpenseLens', description: 'Receipt scanning with Azure Form Recognizer and .NET minimal APIs.' },
  ],
}

const SAMPLE_DOC = `# Brightline: system design notes

- Tracking API: ASP.NET Core 8, SQL Server, Redis cache in front of shipment lookups (5 min TTL)
- Partner webhooks are retried with exponential backoff, max 6 attempts
- Biggest incident: a missing index on Shipments(PartnerId, UpdatedAt) caused 30 s timeouts during peak; fixed with a covering index
- Questions to ask them: team size, on-call rota, how they review PRs
`

function settings(t: number): Settings {
  return {
    autoPolicy: { ...DEFAULT_AUTO_POLICY },
    answerRouting: { ...DEFAULT_ANSWER_ROUTING, switchOn: { ...DEFAULT_ANSWER_ROUTING.switchOn } },
    cloudStt: { ...DEFAULT_CLOUD_STT },
    theme: 'system',
    zoom: 1,
    privateMode: true,
    overlayOpacity: 0.88,
    defaultLanguage: 'en-US',
    defaultModel: 'google:gemini-flash-lite',
    visionModel: 'google:gemini-flash',
    sttProvider: 'local',
    defaultAnswerPrefs: { ...DEFAULT_PREFS },
    hotkeys: { ...DEFAULT_HOTKEYS },
    overlayBounds: null,
    lastBackupAt: t - 6 * HOUR,
    updatedAt: t,
  }
}

export function emptyDb(): Db {
  const t = Date.now()
  return {
    version: 1,
    settings: settings(t),
    keys: [],
    // First run: the speech model is not installed yet (Settings › Speech models).
    sttModelReady: false,
    resumes: [],
    documents: [],
    sessions: [],
    segments: [],
    answers: [],
    notes: [],
    review: [],
  }
}

export function seedDb(): Db {
  const t = Date.now()
  const resume: ResumeRowStored = {
    id: 'res-riya',
    title: 'Riya Sharma – Software Engineer',
    source: 'text',
    filePath: null,
    fileSize: null,
    contentHash: 'seed-riya',
    contentMd: SAMPLE_RESUME_MD,
    mdStatus: 'ready',
    mdMethod: 'manual',
    mdError: null,
    parseStatus: 'ready',
    parsed: SAMPLE_PARSED,
    parseError: null,
    createdAt: t - 5 * DAY,
    updatedAt: t - 5 * DAY,
  }
  const doc: DocumentStored = {
    id: 'doc-notes',
    title: 'Brightline system design notes',
    source: 'text',
    filePath: null,
    fileSize: null,
    contentHash: 'seed-doc',
    rawText: SAMPLE_DOC,
    textStatus: 'ready',
    createdAt: t - 4 * DAY,
    updatedAt: t - 4 * DAY,
  }

  const s1Start = t - 2 * DAY - 3 * HOUR
  const s1: SessionRow = {
    id: 'ses-northwind',
    type: 'interview',
    companyName: 'Northwind Systems',
    companyDomain: 'northwind.example',
    roleTitle: 'Full Stack Developer (.NET / Angular)',
    jobUrl: null,
    jobDescription:
      'We are hiring a full stack developer to build internal tools on .NET 8 and Angular. You will design REST APIs, write SQL Server queries and own features end to end. 2+ years of C# experience required.',
    resumeId: resume.id,
    documentIds: [doc.id],
    language: 'en-US',
    model: 'google:gemini-flash-lite',
    answerPrefs: { ...DEFAULT_PREFS },
    instructions: 'Keep answers under a minute when spoken. Mention Brightline examples where they fit.',
    autoGenerate: false,
    saveTranscript: true,
    status: 'ended',
    startedAt: s1Start,
    endedAt: s1Start + 7 * MIN + 33_000,
    activeMs: 7 * MIN + 33_000,
    liveSince: null,
    transcriptCursorAt: null,
    createdAt: s1Start - 4 * MIN,
    updatedAt: s1Start + 7 * MIN + 33_000,
  }

  const lines: Array<[number, 'you' | 'them', string]> = [
    [5, 'them', 'Hi Riya, thanks for joining. Can you start by telling me a little about yourself?'],
    [14, 'you', 'Sure. Thanks for having me.'],
    [95, 'them', 'Great. So what do you know about delegates in C sharp?'],
    [190, 'them', 'Okay. Tell me about a time you disagreed with a teammate on a technical choice.'],
    [300, 'you', 'Yes, that happened on the tracking API.'],
    [380, 'them', 'Good. That is all from my side. Do you have any questions for us?'],
    [400, 'you', 'What does the on-call rota look like for the team?'],
  ]
  const segments: Segment[] = lines.map(([sec, speaker, text], i) => ({
    id: `seg-nw-${i}`,
    sessionId: s1.id,
    seq: i,
    speaker,
    text,
    startMs: sec * 1000,
    endMs: sec * 1000 + 3500,
    spokenAt: s1Start + sec * 1000,
  }))

  const ans = (seq: number, sec: number, question: string, md: string): Answer => ({
    id: `ans-nw-${seq}`,
    sessionId: s1.id,
    seq,
    trigger: 'answer',
    status: 'done',
    transcriptExcerpt: lines.find(([s]) => s < sec && s > sec - 120)?.[2] ?? '',
    userPrompt: null,
    screenshotPath: null,
    question,
    answerMd: md,
    model: s1.model,
    answerPrefs: { ...DEFAULT_PREFS },
    error: null,
    firstTokenMs: 820,
    latencyMs: 3900,
    createdAt: s1Start + sec * 1000,
  })
  const answers: Answer[] = [
    ans(
      0,
      12,
      'Tell me about yourself',
      "I'm a software engineer with about two and a half years on C#, .NET and Angular.\n\n- At **Brightline Logistics** I build the shipment tracking API in ASP.NET Core 8 that 40+ partners integrate with.\n- I cut our dispatch dashboard load from **4.1 s to 1.3 s** by moving filtering into indexed SQL views.\n- Before that, at **Quillsoft**, I maintained an Angular billing portal and moved 30 components to standalone components.\n\nI enjoy owning a feature from the database up to the UI, which is why this full stack role caught my eye.",
    ),
    ans(
      1,
      100,
      'Explain delegates in C#',
      "A delegate is a **type-safe reference to a method**. It lets me pass a method around like a value: store it, hand it to another method, and call it later.\n\n- **Signature-bound:** a delegate can point at any method with a matching return type and parameters.\n- **Multicast:** `+=` adds more methods, and invoking the delegate calls them in order.\n- **Built in:** I mostly use `Action<T>` and `Func<T, TResult>` instead of declaring my own.\n- **Events** are built on delegates.\n\n```csharp\nFunc<int, int> square = x => x * x;\nAction<string> log = Console.WriteLine;\nlog($\"9 squared is {square(9)}\");\n```\n\nAt Brightline I used `Func<Shipment, bool>` filters so partners could plug in their own rules without touching the core query.",
    ),
    ans(
      2,
      195,
      'Describe a time you disagreed with a teammate on a technical choice',
      '**Situation:** On the tracking API, a teammate wanted to cache every shipment lookup in Redis.\n\n**Task:** I had to make sure we fixed the slow lookups without serving stale delivery status to partners.\n\n**Action:** I measured both options against a copy of production traffic. The real cause was a missing index on `Shipments(PartnerId, UpdatedAt)`, so I proposed the index first and a short 5 minute cache only for the hottest endpoint.\n\n**Result:** Lookups dropped from 30 s timeouts at peak to under 200 ms, and we kept the data fresh. My teammate and I wrote the decision up together for the team wiki.',
    ),
  ]

  const notes: Notes = {
    sessionId: s1.id,
    status: 'ready',
    details: { company: 'Northwind Systems', position: 'Full Stack Developer (.NET / Angular)' },
    summary:
      'A short first-round call. The interviewer covered an introduction, one C# fundamentals question and one behavioural question about disagreement, then left time for your questions.',
    questions: [
      { question: 'Tell me about yourself', responseNote: 'Clear and specific; the 4.1 s to 1.3 s number landed well.' },
      { question: 'Explain delegates in C#', responseNote: 'Solid definition. You could have mentioned events and closures in one line each.' },
      {
        question: 'Describe a time you disagreed with a teammate',
        responseNote: 'Good STAR structure. The result had numbers; keep the situation part shorter.',
      },
    ],
    nextSteps: [
      'Send a thank-you note mentioning the on-call question.',
      'Review async/await and dependency injection before the technical round.',
      'Prepare one more conflict story that is not about performance.',
    ],
    error: null,
    generatedAt: s1.endedAt! + 40_000,
  }

  const s2Start = t - 1 * DAY - 2 * HOUR
  const s2: SessionRow = {
    ...s1,
    id: 'ses-fabrikam',
    type: 'regular',
    companyName: 'Fabrikam Labs',
    companyDomain: 'fabrikam.example',
    roleTitle: 'Client sync: API migration',
    jobDescription: '',
    documentIds: [],
    instructions: '',
    status: 'left',
    startedAt: s2Start,
    endedAt: null,
    activeMs: 3 * MIN + 12_000,
    createdAt: s2Start - 2 * MIN,
    updatedAt: s2Start + 3 * MIN,
  }
  const seg2: Segment[] = [
    [8, 'them', 'Can you walk us through how the migration to version two of the API will work?'],
    [60, 'you', 'Yes. We run both versions side by side for a month.'],
  ].map(([sec, speaker, text], i) => ({
    id: `seg-fb-${i}`,
    sessionId: s2.id,
    seq: i,
    speaker: speaker as 'you' | 'them',
    text: text as string,
    startMs: (sec as number) * 1000,
    endMs: (sec as number) * 1000 + 3000,
    spokenAt: s2Start + (sec as number) * 1000,
  }))

  return {
    ...emptyDb(),
    settings: settings(t),
    keys: [{ provider: 'google', last4: 'x9Qa', verifiedAt: t - 5 * DAY }],
    // The seeded demo user already installed the speech model.
    sttModelReady: true,
    resumes: [resume],
    documents: [doc],
    sessions: [s2, s1],
    segments: [...segments, ...seg2],
    answers,
    notes: [notes],
    review: [],
  }
}
