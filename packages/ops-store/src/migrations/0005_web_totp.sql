-- == ARGUS AGENT PROJECT ==
-- Migration 0005: a second factor for the web sign-in (TOTP, RFC 6238).
--
-- Required in public mode (`web.public`), optional otherwise. A user without a web
-- password (one who signs in with `/web` links) may have one too, so it is a table
-- of its own rather than columns of `web_logins`.

CREATE TABLE web_totp (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  -- The shared secret, base32, as the authenticator app has it.
  secret     TEXT NOT NULL,
  -- The unused recovery codes: a JSON array of their sha-256, hex.
  recovery   TEXT NOT NULL,
  -- The last 30-second step a code was accepted for: a code works once.
  last_step  INTEGER NOT NULL DEFAULT 0,
  enabled_at INTEGER NOT NULL
);
