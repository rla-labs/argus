-- == ARGUS AGENT PROJECT ==
-- Migration 0008: the usage of an agent an extension runs for a project (Claude Code).
--
-- On a subscription it costs nothing per token (cost_micros 0, budgets untouched), but
-- what it would have cost at the API's list prices is kept beside, to show; and which
-- server's agent it was, so its turns can be counted against delegate.day_turns.

ALTER TABLE usage_events ADD COLUMN notional_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN delegated TEXT;
CREATE INDEX usage_events_delegated ON usage_events(project_id, ts) WHERE delegated IS NOT NULL;
