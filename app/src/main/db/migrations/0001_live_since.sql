-- Migration 0001: remember when the current live stretch began, so crash recovery can
-- add the right amount to active_ms and the timer survives a renderer reload.
alter table sessions add column live_since integer;
