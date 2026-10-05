// == ARGUS AGENT PROJECT ==
/**
 * `@argus-agent/memory/recall` — the per-project FTS5 index.
 *
 * **This is not `ops-store`'s database.** ADR 0003 says `ops-store` is the only
 * plugin that touches *the* harness database, and that rule is about the shared,
 * long-lived store. This is a **per-project artifact** with a different lifetime:
 * it lives in the project's own state directory, it is rebuilt when memory is reset,
 * and losing it costs nothing but a re-index. Keeping it out of the shared store is
 * what makes per-project isolation a filesystem fact rather than a query filter.
 *
 * @module @argus-agent/memory/recall
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** One indexed turn. */
export interface RecallRow {
  readonly sessionId: string
  readonly turn: number
  readonly ts: number
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** One search result. */
export interface RecallHit {
  /** The matched text, trimmed to a useful length. */
  readonly text: string
  /** The role that produced it. */
  readonly role: string
  /** When it was said. */
  readonly ts: number
  /** The session it came from. */
  readonly sessionId: string
  /** The turn number. */
  readonly turn: number
  /** The BM25 score; lower is better, as SQLite's `bm25()` returns it. */
  readonly score: number
}

/**
 * A project's recall index.
 *
 * Opened lazily and held, because opening a SQLite file per query would be slower
 * than the query. Closed on unload.
 */
export class RecallIndex {
  private db: Database.Database | undefined

  constructor(private readonly path: string) {}

  /** Open the database, creating the schema on first use. */
  private open(): Database.Database {
    if (this.db !== undefined) return this.db
    mkdirSync(dirname(this.path), { recursive: true })
    const db = new Database(this.path)
    // WAL: a reader does not block the writer, which matters because indexing
    // happens at the end of a turn while a query may arrive from a tool.
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn       INTEGER NOT NULL,
        ts         INTEGER NOT NULL,
        role       TEXT NOT NULL,
        text       TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
        text,
        content='turns',
        content_rowid='id',
        tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO turns_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, turn);
    `)
    this.db = db
    return db
  }

  /**
   * Index one turn.
   *
   * A turn is written as **two rows**, the user's text and the assistant's final
   * text, so a query can prefer one or the other and the result says which it found.
   *
   * Empty text is skipped: indexing an empty string would match every query with a
   * meaningless hit.
   *
   * @param row the turn.
   */
  insert(row: RecallRow): void {
    if (row.text.trim().length === 0) return
    this.open()
      .prepare('INSERT INTO turns (session_id, turn, ts, role, text) VALUES (?, ?, ?, ?, ?)')
      .run(row.sessionId, row.turn, row.ts, row.role, row.text)
  }

  /**
   * Search the index.
   *
   * The query is tokenized into words and joined with `OR`, because `MATCH` treats
   * a bare string as a strict expression: `how do I build` would require all four
   * words, and a natural question would return nothing. `OR` with BM25 ranking is
   * what makes "build" rank a mention of building above an unrelated turn that
   * happens to contain "how".
   *
   * A query with no usable words returns nothing rather than everything.
   *
   * @param query the search text.
   * @param limit the maximum results.
   * @returns the hits, most relevant first.
   */
  search(query: string, limit = 5): RecallHit[] {
    const terms = tokenizeQuery(query)
    if (terms.length === 0) return []

    const match = terms.map((term) => `"${term}"`).join(' OR ')
    try {
      const rows = this.open()
        .prepare(
          `SELECT t.text, t.role, t.ts, t.session_id, t.turn, bm25(turns_fts) AS score
           FROM turns_fts
           JOIN turns t ON t.id = turns_fts.rowid
           WHERE turns_fts MATCH ?
           ORDER BY score
           LIMIT ?`,
        )
        .all(match, limit) as Array<Record<string, unknown>>

      return rows.map((row) => ({
        text: String(row['text']),
        role: String(row['role']),
        ts: Number(row['ts']),
        sessionId: String(row['session_id']),
        turn: Number(row['turn']),
        score: Number(row['score']),
      }))
    } catch {
      // A malformed MATCH expression must not throw into a tool call: an empty
      // result is a valid answer, and the tool's own message explains the syntax.
      return []
    }
  }

  /** How many turns are indexed. */
  count(): number {
    try {
      const row = this.open().prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number }
      return row.n
    } catch {
      return 0
    }
  }

  /** Delete everything, for a memory reset. */
  clear(): void {
    try {
      const db = this.open()
      db.exec('DELETE FROM turns')
    } catch {
      /* a missing database has nothing to clear */
    }
  }

  /** Close the database. */
  close(): void {
    this.db?.close()
    this.db = undefined
  }
}

/**
 * Split a query into indexable words.
 *
 * Drops punctuation and single characters, keeps everything else, and lowercases.
 * A query of only punctuation yields nothing, which the caller reads as "no
 * results" rather than "match everything".
 *
 * @param query the raw query.
 * @returns the terms.
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
}

/**
 * Trim a hit's text to a snippet around the useful part.
 *
 * A whole turn can be thousands of characters; a recall result is meant to remind,
 * not to reproduce. The start is kept, because a turn's opening states what it was
 * about.
 *
 * @param text the full text.
 * @param maxLength the maximum length.
 * @returns the snippet.
 */
export function snippet(text: string, maxLength = 400): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxLength) return collapsed
  return `${collapsed.slice(0, maxLength - 3)}...`
}
