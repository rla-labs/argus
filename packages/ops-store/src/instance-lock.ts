// == ARGUS AGENT PROJECT ==
/**
 * One Argus Agent per data directory.
 *
 * Two processes on one database double-fire every schedule and race every
 * admission: neither the scheduler nor the governor can coordinate with a twin
 * they do not know exists. It happens in real life — a manual start next to the
 * service, a second container on the same volume, an upgrade from dsh-ops that
 * left the old unit enabled — so the store refuses to open a data directory that
 * another process is using.
 *
 * The lock is a separate SQLite file held in an EXCLUSIVE transaction for the
 * life of the process. That choice is deliberate:
 *
 * - the operating system releases it when the process dies, `SIGKILL` included,
 *   so there is never a stale lock to clean up — unlike a PID file, whose PID a
 *   new container can reuse;
 * - it works across containers that bind-mount the same directory, because the
 *   lock lives in the shared kernel, not in either process;
 * - it is not `ops.sqlite`, so backups and health checks that read the database
 *   are never blocked by it.
 *
 * @module @argus-agent/store/instance-lock
 */
import Database from 'better-sqlite3'
import { OpsError } from '@argus-agent/types'

/** The lock file's name, inside the data directory. */
export const INSTANCE_LOCK_FILE = 'instance.lock'

/** A held lock. Release it on shutdown; the OS releases it on a crash. */
export class InstanceLock {
  private constructor(
    private readonly db: Database.Database,
    /** The lock file. */
    readonly path: string,
  ) {}

  /**
   * Take the lock, or refuse.
   *
   * @param path the lock file.
   * @returns the held lock.
   * @throws {OpsError} `INSTANCE_LOCKED` when another process holds it.
   */
  static acquire(path: string): InstanceLock {
    const db = new Database(path)
    try {
      db.pragma('busy_timeout = 0')
      db.pragma('locking_mode = EXCLUSIVE')
      db.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      db.close()
      if ((error as { code?: string }).code === 'SQLITE_BUSY') {
        throw new OpsError(
          'INSTANCE_LOCKED',
          `another Argus Agent process is already using this data directory (${path} is locked). ` +
            'Two processes on one database double-fire schedules and race admissions. Stop the ' +
            'other one — `systemctl stop argus-agent`, or `docker compose down` — then start this one.',
          { path },
        )
      }
      throw error
    }
    return new InstanceLock(db, path)
  }

  /** Release the lock. Idempotent. */
  release(): void {
    if (!this.db.open) return
    try {
      this.db.exec('ROLLBACK')
    } catch {
      // Nothing was written; closing releases the lock either way.
    }
    this.db.close()
  }
}
