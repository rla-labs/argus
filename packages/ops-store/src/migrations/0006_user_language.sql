-- == ARGUS AGENT PROJECT ==
-- Migration 0006: the language a user reads the web interface in.
--
-- Chosen in the interface and kept with the user, so it is the same on every device;
-- NULL follows the browser's language.

ALTER TABLE users ADD COLUMN language TEXT;
