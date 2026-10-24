-- == ARGUS AGENT PROJECT ==
-- Migration 0007: the mail outbox, and triggers.
--
-- A mail that needs a person's approval waits here instead of holding its run: the
-- mail itself (its fields and copies of its attachments) is kept in the project's
-- state folder, under outbox/<id>/; the row says where it stands. `status` moves once,
-- from 'waiting', to 'sent', 'refused' (denied, or no longer allowed), 'expired' (no
-- answer in time, or Argus restarted) or 'failed' (the mail server refused it).

CREATE TABLE mail_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT    NOT NULL,
  run_id      TEXT,
  created_at  INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'sent', 'refused', 'expired', 'failed')),
  recipients  INTEGER NOT NULL,
  digest      TEXT    NOT NULL,
  why         TEXT,
  decided_by  TEXT,
  decided_at  INTEGER,
  note        TEXT
);

CREATE INDEX mail_outbox_by_status ON mail_outbox(status, created_at);
CREATE INDEX mail_outbox_by_project ON mail_outbox(project_id, created_at);

-- Triggers: a source checked in code (0.7.4: new mail in a folder of a project's
-- mailbox), a filter, and a run started in the project for each match. `config_json`
-- holds the source's filter, the prompt and the limits; `cursor_json` where the source
-- stopped (for mail: the folder's UIDVALIDITY and the last UID seen); `runs_json` the
-- times of the last hour's runs, for `max_runs_per_hour`.
CREATE TABLE triggers (
  id             TEXT    PRIMARY KEY,
  project_id     TEXT    NOT NULL,
  source         TEXT    NOT NULL,
  config_json    TEXT    NOT NULL,
  reply_chat     TEXT    NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  cursor_json    TEXT,
  runs_json      TEXT    NOT NULL DEFAULT '[]',
  next_check_at  INTEGER NOT NULL,
  last_check_at  INTEGER,
  last_match_at  INTEGER,
  last_error     TEXT,
  failures       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE INDEX triggers_due ON triggers(enabled, next_check_at);
