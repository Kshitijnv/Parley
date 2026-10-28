-- Migration 0000: replica/schema.sql without the connection pragmas (client.ts sets those).
-- Schema: ParakeetAI clone (single-user Windows desktop app)
-- Engine: SQLite (better-sqlite3), file at %APPDATA%\<app>\data\app.db
-- This is migration 0000. Drizzle schema in app/src/main/db/schema.ts must match it.
--
-- Conventions (SQLite adaptation of the Postgres rules):
--   ids         text UUID v4, generated in the data layer with crypto.randomUUID()
--               (SQLite has no gen_random_uuid). Exceptions: settings (single row, id = 1)
--               and secrets (keyed by provider).
--   times       integer, Unix epoch milliseconds, UTC. Rendered in local time in the UI.
--   booleans    integer 0/1 with a check.
--   json        text with json_valid() check.
--   updated_at  set by the data layer on every write (Drizzle $onUpdate), not by triggers.
--   owner       no user_id / org_id columns: one user, one local database, no accounts.
-- Access rules: data-layer checks. The renderer never opens the database. It calls typed
-- IPC handlers in the main process, which validate every input with zod and are the only
-- code that reads or writes these tables. API keys never leave the main process.


-- ---------------------------------------------------------------------------
-- settings: one row. Defaults for new sessions plus overlay window state. (S04, S09 Set default)
-- ---------------------------------------------------------------------------
create table settings (
  id integer primary key check (id = 1),
  theme text not null default 'system'
    check (theme in ('light','dark','system')),
  zoom real not null default 1.0
    check (zoom between 0.5 and 2.0),
  private_mode integer not null default 1
    check (private_mode in (0,1)),
  overlay_opacity real not null default 0.88
    check (overlay_opacity between 0.78 and 1.0),  -- below 0.78 glass text fails AA over white pages (design/tokens.json)
  default_language text not null default 'en-US',
  default_model text not null default 'google:gemini-flash-lite',  -- "<provider>:<model id>"
  vision_model text not null default 'google:gemini-flash',
  stt_provider text not null default 'local'
    check (stt_provider in ('local','deepgram')),
  default_answer_prefs text not null default
    '{"format":"script_bullets","star":true,"filler_words":false,"length":"balanced","tone":"simple"}'
    check (json_valid(default_answer_prefs)),
  hotkeys text not null default
    '{"answer":"Control+Enter","screenshot":"Control+Shift+Enter","chat":"Control+Shift+Space","clear_transcript":"Control+Shift+Backspace","clear_answer":"Control+Backspace","history_prev":"Control+Left","history_next":"Control+Right","move_up":"Control+Shift+Up","move_down":"Control+Shift+Down","move_left":"Control+Shift+Left","move_right":"Control+Shift+Right"}'
    check (json_valid(hotkeys)),
  overlay_bounds text check (overlay_bounds is null or json_valid(overlay_bounds)),
  last_backup_at integer,
  created_at integer not null,
  updated_at integer not null
);

-- ---------------------------------------------------------------------------
-- secrets: provider API keys, encrypted with Electron safeStorage (Windows DPAPI).
-- The plain key is only ever held in the main process.
-- ---------------------------------------------------------------------------
create table secrets (
  provider text primary key
    check (provider in ('google','openai','anthropic','groq','deepgram','logodev')),
  ciphertext blob not null,
  last4 text not null check (length(last4) = 4),
  verified_at integer,          -- last successful keys:test
  created_at integer not null,
  updated_at integer not null
);

-- ---------------------------------------------------------------------------
-- resumes (F02, S16-S18, S25)
-- ---------------------------------------------------------------------------
create table resumes (
  id text primary key,
  title text not null check (length(title) between 1 and 200),
  source text not null check (source in ('pdf','text')),
  file_path text,                              -- relative to the app files dir; null for pasted text
  file_size integer check (file_size is null or file_size between 1 and 10485760),  -- 10 MB cap
  content_hash text not null,                  -- sha256 of the file or text, to warn on duplicates
  content_md text not null default '',         -- the resume as Markdown: what the AI reads, editable on S18
  md_status text not null default 'pending'
    check (md_status in ('pending','converting','ready','failed')),
  md_method text
    check (md_method is null or md_method in ('ai','text_extract','manual')),
    -- ai = PDF sent to the model and returned as Markdown (default, handles scans and columns)
    -- text_extract = local pdf.js text, fallback when no key / offline
    -- manual = text the user typed or edited
  md_error text,
  parse_status text not null default 'pending'
    check (parse_status in ('pending','parsing','ready','failed','skipped')),
  parsed text check (parsed is null or json_valid(parsed)),
    -- {contact:{name,headline,email,phone,location}, summary, experience:[], skills:{category:[skill]}, projects:[]}
  parse_error text,
  created_at integer not null,
  updated_at integer not null,
  check ((source = 'pdf') = (file_path is not null))
);
create index resumes_created_at on resumes (created_at desc);
create index resumes_content_hash on resumes (content_hash);
create index resumes_md_status on resumes (md_status) where md_status in ('pending','converting','failed');
create index resumes_parse_status on resumes (parse_status) where parse_status in ('pending','parsing');

-- ---------------------------------------------------------------------------
-- documents: extra context files (S21, S07 Documents multi-select)
-- ---------------------------------------------------------------------------
create table documents (
  id text primary key,
  title text not null check (length(title) between 1 and 200),
  source text not null check (source in ('pdf','text','markdown')),
  file_path text,
  file_size integer check (file_size is null or file_size between 1 and 10485760),
  content_hash text not null,
  raw_text text not null default '',
  text_status text not null default 'pending'
    check (text_status in ('pending','ready','empty','failed')),
  created_at integer not null,
  updated_at integer not null,
  check ((source = 'text') = (file_path is null))
);
create index documents_created_at on documents (created_at desc);
create index documents_content_hash on documents (content_hash);

-- ---------------------------------------------------------------------------
-- sessions (F01, S03, S07, S08, S13, S26)
-- ---------------------------------------------------------------------------
create table sessions (
  id text primary key,
  type text not null default 'interview'
    check (type in ('interview','regular','mock')),
  company_name text check (company_name is null or length(company_name) <= 200),
  company_domain text,
  role_title text check (role_title is null or length(role_title) <= 200),
  job_url text,
  job_description text not null default '' check (length(job_description) <= 50000),
  resume_id text references resumes (id) on delete set null,  -- past sessions survive a deleted resume
  language text not null default 'en-US',
  model text not null,                                        -- "<provider>:<model id>"
  answer_prefs text not null check (json_valid(answer_prefs)), -- copied from settings, editable mid-call
  instructions text not null default '' check (length(instructions) <= 20000),
  auto_generate integer not null default 0 check (auto_generate in (0,1)),
  save_transcript integer not null default 1 check (save_transcript in (0,1)),
  status text not null default 'draft'
    check (status in ('draft','live','left','ended')),
  started_at integer,              -- first time it went live
  ended_at integer,
  active_ms integer not null default 0 check (active_ms >= 0),  -- live time summed across rejoins
  transcript_cursor_at integer,    -- "Clear transcript": answers only read segments after this
  created_at integer not null,
  updated_at integer not null,
  check (status = 'draft' or started_at is not null),
  check (status <> 'ended' or ended_at is not null),
  check (ended_at is null or ended_at >= started_at)
);
-- One live session at a time: two overlays fighting over the same audio is a database error,
-- not a UI bug.
create unique index sessions_one_live on sessions (status) where status = 'live';
create index sessions_resume_id on sessions (resume_id);
create index sessions_created_at on sessions (created_at desc);
create index sessions_company_name on sessions (company_name collate nocase);
create index sessions_status on sessions (status);

-- n-n: sessions <-> documents
create table session_documents (
  session_id text not null references sessions (id) on delete cascade,
  document_id text not null references documents (id) on delete cascade,
  created_at integer not null,
  primary key (session_id, document_id)
);
create index session_documents_document_id on session_documents (document_id);

-- ---------------------------------------------------------------------------
-- transcript_segments: final speech-to-text lines only. Partials live in memory and IPC events.
-- Not written when sessions.save_transcript = 0.
-- ---------------------------------------------------------------------------
create table transcript_segments (
  id text primary key,
  session_id text not null references sessions (id) on delete cascade,
  seq integer not null check (seq >= 0),       -- assigned by the main process, single writer
  speaker text not null check (speaker in ('you','them')),
  text text not null check (length(text) > 0),
  start_ms integer not null check (start_ms >= 0),   -- monotonic offset from session start
  end_ms integer not null,
  spoken_at integer not null,                  -- wall clock, UTC epoch ms
  created_at integer not null,
  updated_at integer not null,
  check (end_ms >= start_ms),
  unique (session_id, seq)
);
create index transcript_segments_session_spoken on transcript_segments (session_id, spoken_at);

-- ---------------------------------------------------------------------------
-- answers (S14, history paging, S19 answer cards)
-- ---------------------------------------------------------------------------
create table answers (
  id text primary key,
  session_id text not null references sessions (id) on delete cascade,
  seq integer not null check (seq >= 0),
  trigger text not null check (trigger in ('answer','screenshot','chat','auto')),
  status text not null default 'streaming'
    check (status in ('streaming','done','cancelled','failed')),
  transcript_excerpt text not null default '',  -- the raw words sent, partial line included
  user_prompt text,                             -- typed text for trigger = 'chat'
  screenshot_path text,                         -- relative path, trigger = 'screenshot'
  question text,                                -- clean question rewritten by the model
  answer_md text not null default '',
  model text not null,
  answer_prefs text not null check (json_valid(answer_prefs)),  -- the prefs this answer used
  error text,
  first_token_ms integer,
  latency_ms integer,
  input_tokens integer,
  output_tokens integer,
  created_at integer not null,
  updated_at integer not null,
  unique (session_id, seq),
  check (trigger <> 'chat' or user_prompt is not null),
  check (trigger <> 'screenshot' or screenshot_path is not null),
  check (status <> 'failed' or error is not null)
);
create index answers_session_created on answers (session_id, created_at);
create index answers_streaming on answers (status) where status = 'streaming';  -- crash recovery

-- ---------------------------------------------------------------------------
-- session_notes: AI notes after the call (S20). One per session.
-- ---------------------------------------------------------------------------
create table session_notes (
  id text primary key,
  session_id text not null unique references sessions (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','generating','ready','failed')),
  details text check (details is null or json_valid(details)),       -- {company, position}
  summary text,
  questions text check (questions is null or json_valid(questions)), -- [{question, response_note}]
  next_steps text check (next_steps is null or json_valid(next_steps)), -- [string]
  model text,
  attempts integer not null default 0 check (attempts between 0 and 10),
  error text,
  generated_at integer,
  created_at integer not null,
  updated_at integer not null,
  check (status <> 'ready' or generated_at is not null)
);
create index session_notes_pending on session_notes (status) where status in ('pending','generating','failed');

-- ---------------------------------------------------------------------------
-- review_messages: "Ask AI" chat about a past call (S23, could-have)
-- ---------------------------------------------------------------------------
create table review_messages (
  id text primary key,
  session_id text not null references sessions (id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  status text not null default 'done' check (status in ('streaming','done','failed')),
  created_at integer not null,
  updated_at integer not null
);
create index review_messages_session_created on review_messages (session_id, created_at);
