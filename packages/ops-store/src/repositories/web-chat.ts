// == ARGUS AGENT PROJECT ==
/**
 * The `web_chat` and `web_chat_files` repository: the web chat's history.
 *
 * Storage only: what an entry means, and the cap, are `ops-web`'s.
 *
 * @module @argus-agent/store/repositories/web-chat
 */
import type { DatabaseHandle } from '../connection.js'
import type { WebChatFileRow, WebChatRow } from '../types.js'

/** A new entry. */
export interface WebChatInput {
  readonly id: string
  readonly chat_id: string
  readonly at: number
  readonly sender: 'you' | 'argus'
  readonly text: string
  readonly buttons_json?: string | null
  readonly question_id?: string | null
}

/** A file offered with a new entry. */
export type WebChatFileInput = Omit<WebChatFileRow, 'entry_id' | 'chat_id'>

/** The `web_chat` and `web_chat_files` repository. */
export class WebChatRepository {
  private readonly insertStmt
  private readonly insertFileStmt
  private readonly trimStmt
  private readonly entryStmt
  private readonly updateStmt
  private readonly deleteStmt
  private readonly historyStmt
  private readonly chatFilesStmt
  private readonly fileStmt
  private readonly markReadStmt
  private readonly unreadStmt
  private readonly expireStmt

  constructor(private readonly db: DatabaseHandle) {
    this.insertStmt = db.prepare(`
      INSERT INTO web_chat (id, chat_id, at, sender, text, buttons_json, question_id)
      VALUES (@id, @chat_id, @at, @sender, @text, @buttons_json, @question_id)
    `)
    this.insertFileStmt = db.prepare(`
      INSERT INTO web_chat_files (id, entry_id, chat_id, name, mime_type, path, bytes)
      VALUES (@id, @entry_id, @chat_id, @name, @mime_type, @path, @bytes)
    `)
    this.trimStmt = db.prepare(`
      DELETE FROM web_chat WHERE chat_id = @chat_id AND seq <= (
        SELECT seq FROM web_chat WHERE chat_id = @chat_id ORDER BY seq DESC LIMIT 1 OFFSET @keep
      )
    `)
    this.entryStmt = db.prepare('SELECT * FROM web_chat WHERE id = ?')
    this.updateStmt = db.prepare(`
      UPDATE web_chat SET text = COALESCE(@text, text), answered = COALESCE(@answered, answered), note = COALESCE(@note, note)
      WHERE id = @id
    `)
    this.deleteStmt = db.prepare('DELETE FROM web_chat WHERE id = ?')
    this.historyStmt = db.prepare('SELECT * FROM web_chat WHERE chat_id = ? ORDER BY seq')
    this.chatFilesStmt = db.prepare('SELECT id, entry_id, name FROM web_chat_files WHERE chat_id = ?')
    this.fileStmt = db.prepare('SELECT * FROM web_chat_files WHERE id = ? AND chat_id = ?')
    this.markReadStmt = db.prepare("UPDATE web_chat SET read_at = ? WHERE chat_id = ? AND sender = 'argus' AND read_at IS NULL")
    this.unreadStmt = db.prepare("SELECT COUNT(*) AS count FROM web_chat WHERE chat_id = ? AND sender = 'argus' AND read_at IS NULL")
    this.expireStmt = db.prepare("UPDATE web_chat SET answered = 'timeout' WHERE question_id IS NOT NULL AND answered IS NULL")
  }

  /**
   * Add an entry and its files, then drop the chat's oldest past `keep`.
   * @param entry the entry.
   * @param files the files it offers.
   * @param keep how many entries the chat keeps.
   */
  append(entry: WebChatInput, files: readonly WebChatFileInput[], keep: number): void {
    this.db.transaction(() => {
      this.insertStmt.run({ buttons_json: null, question_id: null, ...entry })
      for (const file of files) this.insertFileStmt.run({ ...file, entry_id: entry.id, chat_id: entry.chat_id })
      this.trimStmt.run({ chat_id: entry.chat_id, keep })
    })()
  }

  /**
   * One entry.
   * @param id the entry id.
   * @returns the row, or `undefined`.
   */
  entry(id: string): WebChatRow | undefined {
    return this.entryStmt.get(id) as WebChatRow | undefined
  }

  /**
   * Change an entry's text, answer or note; an omitted field is kept.
   * @param id the entry id.
   * @param patch the fields to change.
   */
  update(id: string, patch: { text?: string; answered?: string; note?: string }): void {
    this.updateStmt.run({ id, text: patch.text ?? null, answered: patch.answered ?? null, note: patch.note ?? null })
  }

  /**
   * Remove an entry and its files.
   * @param id the entry id.
   */
  delete(id: string): void {
    this.deleteStmt.run(id)
  }

  /**
   * A chat, oldest first, with the names of its files.
   * @param chatId the Argus user id.
   * @returns the rows, each with its files.
   */
  history(chatId: string): Array<{ row: WebChatRow; files: Array<{ id: string; name: string }> }> {
    const files = new Map<string, Array<{ id: string; name: string }>>()
    for (const file of this.chatFilesStmt.all(chatId) as Array<{ id: string; entry_id: string; name: string }>) {
      files.set(file.entry_id, [...(files.get(file.entry_id) ?? []), { id: file.id, name: file.name }])
    }
    return (this.historyStmt.all(chatId) as WebChatRow[]).map((row) => ({ row, files: files.get(row.id) ?? [] }))
  }

  /**
   * A file a chat offered.
   * @param chatId the Argus user id; a file is only its chat's.
   * @param fileId the file id.
   * @returns the row, or `undefined`.
   */
  file(chatId: string, fileId: string): WebChatFileRow | undefined {
    return this.fileStmt.get(fileId, chatId) as WebChatFileRow | undefined
  }

  /**
   * Mark everything Argus said in a chat as seen.
   * @param chatId the Argus user id.
   * @param now the current time.
   * @returns how many entries were marked.
   */
  markRead(chatId: string, now: number): number {
    return this.markReadStmt.run(now, chatId).changes
  }

  /**
   * How many entries from Argus a chat has not seen.
   * @param chatId the Argus user id.
   */
  unread(chatId: string): number {
    return (this.unreadStmt.get(chatId) as { count: number }).count
  }

  /**
   * Close every question still open: after a restart nobody waits for them.
   * @returns how many were closed.
   */
  expireOpenQuestions(): number {
    return this.expireStmt.run().changes
  }
}
