-- == ARGUS AGENT PROJECT ==
-- Migration 0007: the mail outbox.
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
