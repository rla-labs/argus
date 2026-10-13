-- == ARGUS AGENT PROJECT ==
-- Migration 0004: the web chat's history.
--
-- A user's conversation in the web interface, kept across restarts and capped per
-- user by ops-web. `chat_id` is the Argus user id. `seq` gives the order.

CREATE TABLE web_chat (
  seq          INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  chat_id      TEXT NOT NULL,
  at           INTEGER NOT NULL,
  sender       TEXT NOT NULL CHECK (sender IN ('you', 'argus')),
  text         TEXT NOT NULL,
  -- JSON array of {value, label}, while the entry has buttons.
  buttons_json TEXT,
  question_id  TEXT,
  -- The button chosen; `timeout` when nobody did (or the process restarted).
  answered     TEXT,
  -- Who answered on another channel, and what.
  note         TEXT,
  -- When the user saw an entry from Argus.
  read_at      INTEGER
);

CREATE INDEX web_chat_by_chat ON web_chat(chat_id, seq);

-- Files the chat offered: a path that stays on disk, or the bytes themselves (text
-- made into a file on the spot).
CREATE TABLE web_chat_files (
  id        TEXT PRIMARY KEY,
  entry_id  TEXT NOT NULL REFERENCES web_chat(id) ON DELETE CASCADE,
  chat_id   TEXT NOT NULL,
  name      TEXT NOT NULL,
  mime_type TEXT,
  path      TEXT,
  bytes     BLOB
);

CREATE INDEX web_chat_files_by_entry ON web_chat_files(entry_id);
