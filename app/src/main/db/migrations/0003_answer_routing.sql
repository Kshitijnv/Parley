-- Migration 0003 (architecture.md "Answer reliability and latency (revision 4)" A5): the
-- model that served an answer after a fallback switch, why it switched, per-stage
-- timings (numbers only), and the opt-in answer routing settings (fallback off).
alter table answers add column served_model text;
alter table answers add column fallback_reason text check (fallback_reason is null or fallback_reason in
  ('slow_first_token','overloaded','rate_limited','auth','not_found'));
alter table answers add column timing text check (timing is null or json_valid(timing));

alter table settings add column answer_routing text not null default
  '{"fallbackModel":null,"fallbackAfterMs":6000,"switchOn":{"slowFirstToken":true,"overloaded":true,"rateLimited":true,"auth":true,"notFound":true},"stickyAfterSlow":2,"stickyWindowMs":120000}'
  check (json_valid(answer_routing));
