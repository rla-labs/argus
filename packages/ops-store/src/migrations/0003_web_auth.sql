-- == ARGUS AGENT PROJECT ==
-- Migration 0003: the web interface's own sign-in.
--
-- A user may have a web login (a name and a password); a signed-in browser has a
-- session. Sessions are stored so a restart does not sign anyone out; the table
-- holds a hash of the cookie, never the cookie, so a copy of the database does not
-- sign anyone in.

CREATE TABLE web_logins (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  login         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- `scrypt$N$r$p$salt$hash`, salt and hash in base64url.
  password_hash TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER
);

CREATE TABLE web_sessions (
  -- sha-256 of the cookie's value, hex.
  id_hash      TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  -- How it was opened: a `/web` link may set a password without the current one
  -- for a few minutes; a password sign-in may not.
  via          TEXT NOT NULL CHECK (via IN ('link', 'password')),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT
);

CREATE INDEX web_sessions_by_user ON web_sessions(user_id);
