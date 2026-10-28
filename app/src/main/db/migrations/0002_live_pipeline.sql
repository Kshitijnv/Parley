-- Migration 0002 (architecture.md "Live pipeline (revision 2)" §10): speech model
-- install state, answer lifecycle columns for the RequestGate, and the auto policy.
create table stt_models (
  id text primary key,
  language text check (language is null or language in ('en','hi')),
  engine text not null check (engine in ('streaming_transducer','offline_ctc','vad')),
  status text not null default 'absent'
    check (status in ('absent','downloading','installed','failed','corrupt')),
  bytes_total integer not null check (bytes_total > 0),
  bytes_done integer not null default 0 check (bytes_done >= 0),
  files_verified_at integer,
  recognition_verified_at integer,
  recognition_note text check (recognition_note is null or length(recognition_note) <= 200),
  error text,
  created_at integer not null,
  updated_at integer not null,
  check (status <> 'installed' or files_verified_at is not null)
);

alter table answers add column turn_id text;
alter table answers add column question_key text;
alter table answers add column attempts integer not null default 1 check (attempts between 1 and 3);
alter table answers add column end_reason text check (end_reason is null or end_reason in
  ('completed','user_cancel','superseded','session_end','timeout','interrupted',
   'rate_limited','quota_exhausted','overloaded','offline','auth','provider_error'));
alter table answers add column retry_of text references answers (id) on delete set null;
create index answers_session_question_key on answers (session_id, question_key);

alter table settings add column auto_policy text not null default
  '{"settleMs":1000,"settleQuestionMarkMs":400,"joinGapMs":2500,"minWords":4,"maxTurnChars":1200,"followupWindowMs":20000,"autoCooldownMs":8000,"autoMaxPerMinute":4,"autoMaxPerSession":100,"dedupeWindowMs":120000,"similarity":0.7,"manualMinIntervalMs":1500,"staleCandidateMs":20000}'
  check (json_valid(auto_policy));
