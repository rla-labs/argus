-- == ARGUS AGENT PROJECT ==
-- Migration 0001: the initial Argus Agent schema.
--
-- Money is INTEGER micro-USD (1 USD = 1_000_000) in every column, never REAL:
-- a budget check that compares accumulated floats drifts, and the drift is real
-- money. See docs/developer-docs.md#data-model.
--
-- Timestamps are INTEGER UTC epoch milliseconds. Day boundaries are computed by
-- the caller in the configured timezone; the store never interprets a date.

CREATE TABLE projects (
  id             TEXT PRIMARY KEY,
  cwd            TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  fallback_model TEXT,
  preset         TEXT,
  description    TEXT,
  session_id     TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Written BEFORE any delivery, so a crash cannot lose a request.
CREATE TABLE inbound (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  project_id    TEXT,
  payload       TEXT NOT NULL,
  priority      INTEGER NOT NULL,
  status        TEXT NOT NULL,
  reject_reason TEXT,
  created_at    INTEGER NOT NULL,
  admitted_at   INTEGER,
  run_id        TEXT,
  reply_chat    TEXT
);

CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  inbound_id  TEXT REFERENCES inbound(id),
  project_id  TEXT,
  owner_key   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  status      TEXT NOT NULL,
  steps       INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  reply_chat  TEXT,
  stop_reason TEXT
);

CREATE TABLE usage_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  run_id        TEXT,
  project_id    TEXT,
  scope         TEXT NOT NULL,
  root_session  TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL,
  cost_micros   INTEGER NOT NULL
);

CREATE TABLE usage_daily (
  day           TEXT NOT NULL,
  scope         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope)
);

CREATE TABLE budgets (
  scope          TEXT NOT NULL,
  period         TEXT NOT NULL,
  limit_micros   INTEGER NOT NULL,
  info_pct       INTEGER NOT NULL DEFAULT 50,
  soft_pct       INTEGER NOT NULL DEFAULT 80,
  action_soft    TEXT NOT NULL DEFAULT 'warn',
  action_hard    TEXT NOT NULL DEFAULT 'pause',
  override_until INTEGER,
  override_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, period)
);

CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,
  cron            TEXT NOT NULL,
  timezone        TEXT NOT NULL,
  project_id      TEXT,
  prompt          TEXT NOT NULL,
  reply_chat      TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_at     INTEGER,
  next_run_at     INTEGER NOT NULL,
  misfire         TEXT NOT NULL DEFAULT 'run_once',
  last_request_id TEXT,
  model           TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE chat_context (
  channel           TEXT NOT NULL,
  chat_id           TEXT NOT NULL,
  active_project_id TEXT,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (channel, chat_id)
);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  target       TEXT,
  details_json TEXT
);

CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,
  run_id       TEXT,
  project_id   TEXT,
  request_json TEXT NOT NULL,
  status       TEXT NOT NULL,
  decided_by   TEXT,
  decided_at   INTEGER,
  created_at   INTEGER NOT NULL
);

-- Key/value state that must survive a restart but is not a domain entity:
-- governor panic mode, scheduler bookkeeping, health checkpoints.
CREATE TABLE runtime_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Indexes. Each serves one named access pattern; see docs/DATA.md.
CREATE INDEX usage_events_by_scope_ts ON usage_events(scope, ts);
CREATE INDEX usage_events_by_project_ts ON usage_events(project_id, ts);
CREATE INDEX usage_events_by_run ON usage_events(run_id);
CREATE INDEX inbound_dispatch ON inbound(status, priority, created_at);
CREATE INDEX runs_by_status ON runs(status);
CREATE INDEX runs_by_project_started ON runs(project_id, started_at);
CREATE INDEX runs_by_owner ON runs(owner_key, started_at);
CREATE INDEX schedules_due ON schedules(enabled, next_run_at);
CREATE INDEX audit_log_by_ts ON audit_log(ts);
CREATE INDEX audit_log_by_target ON audit_log(target, ts);
CREATE INDEX approvals_by_run ON approvals(run_id, status);
CREATE INDEX approvals_by_status ON approvals(status, created_at);
