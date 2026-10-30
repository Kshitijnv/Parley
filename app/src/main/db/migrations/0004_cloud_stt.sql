-- Migration 0004 (architecture.md "Cloud speech with Speechmatics (revision 7)" S4, S7):
-- up to 5 cloud speech keys tried in the user's order, each encrypted like `secrets`,
-- with its state and Parley's own count of streamed audio; and the cloud speech settings
-- (off until the user turns it on and accepts the consent text).
create table speech_keys (
  id text primary key,
  provider text not null default 'speechmatics' check (provider in ('speechmatics')),
  label text not null default '' check (length(label) <= 40),
  ciphertext blob not null,
  last4 text not null check (length(last4) = 4),
  position integer not null check (position between 1 and 5),
  state text not null default 'unchecked'
    check (state in ('unchecked','ok','rate_limited','quota_exhausted','auth_failed')),
  state_until integer,
  last_error_type text,
  used_ms integer not null default 0 check (used_ms >= 0),
  used_total_ms integer not null default 0 check (used_total_ms >= 0),
  used_month text not null,
  budget_ms integer check (budget_ms is null or budget_ms > 0),
  verified_at integer,
  created_at integer not null,
  updated_at integer not null
);
create index speech_keys_position on speech_keys (provider, position);

alter table settings add column cloud_stt text not null default
  '{"enabled":false,"consentedAt":null,"maxDelayS":1.0,"eouSilenceS":0.5,"vocab":true,"minLeftMin":60}'
  check (json_valid(cloud_stt));
