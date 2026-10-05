// == ARGUS AGENT PROJECT ==
/**
 * The `chat_context` repository.
 *
 * Which project a chat is currently working in. Per chat, not per user: two
 * chats from one person can work in two projects at once, which is the behavior
 * a person expects from a chat client.
 *
 * @module @argus-agent/store/repositories/chat-context
 */
import type { DatabaseHandle } from '../connection.js'
import type { ChatContextRow } from '../types.js'

/** The `chat_context` repository. */
export class ChatContextRepository {
  private readonly getStmt
  private readonly setStmt
  private readonly clearStmt
  private readonly listStmt

  constructor(private readonly db: DatabaseHandle) {
    this.getStmt = db.prepare('SELECT * FROM chat_context WHERE channel = ? AND chat_id = ?')
    this.setStmt = db.prepare(`
      INSERT INTO chat_context (channel, chat_id, active_project_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(channel, chat_id) DO UPDATE SET
        active_project_id = excluded.active_project_id,
        updated_at        = excluded.updated_at
    `)
    this.clearStmt = db.prepare('DELETE FROM chat_context WHERE channel = ? AND chat_id = ?')
    this.listStmt = db.prepare('SELECT * FROM chat_context ORDER BY channel, chat_id')
  }

  /**
   * Read a chat's context.
   * @param channel the adapter name.
   * @param chatId the platform chat id.
   * @returns the row, or `undefined` when the chat has no context yet.
   */
  get(channel: string, chatId: string): ChatContextRow | undefined {
    return this.getStmt.get(channel, chatId) as ChatContextRow | undefined
  }

  /**
   * Set the active project for a chat.
   * @param channel the adapter name.
   * @param chatId the platform chat id.
   * @param projectId the project, or null to clear the selection.
   * @param now the current time.
   */
  setActive(channel: string, chatId: string, projectId: string | null, now: number): void {
    this.setStmt.run(channel, chatId, projectId, now)
  }

  /**
   * Remove a chat's context.
   * @param channel the adapter name.
   * @param chatId the platform chat id.
   * @returns whether a row was deleted.
   */
  clear(channel: string, chatId: string): boolean {
    return this.clearStmt.run(channel, chatId).changes > 0
  }

  /**
   * Every chat's context.
   * @returns the rows.
   */
  list(): ChatContextRow[] {
    return this.listStmt.all() as ChatContextRow[]
  }
}
