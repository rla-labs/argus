-- == ARGUS AGENT PROJECT ==
-- Migration 0002: users and their channel identities.
--
-- A person is a user of Argus; Telegram, the web (later Slack) are ways that user
-- reaches it. Access, roles and the audit's actor are by user id; a channel
-- identity only says which user a message comes from.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
  created_at  INTEGER NOT NULL,
  disabled_at INTEGER
);

-- Exactly one enabled admin. Handing the role over demotes the old admin in the
-- same transaction.
CREATE UNIQUE INDEX users_one_admin ON users(role) WHERE role = 'admin' AND disabled_at IS NULL;

-- `kind = 'chat'` is a group chat whose members act as the user (an admin group);
-- `channel = '*'` matches the id on every channel.
CREATE TABLE identities (
  channel     TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'chat')),
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (channel, external_id)
);

CREATE INDEX identities_by_user ON identities(user_id);
