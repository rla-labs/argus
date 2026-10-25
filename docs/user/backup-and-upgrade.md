# Backup, restore and upgrades

## Backup and restore

What is backed up, what is not, and how to restore.

### What is covered

```
   ${DATA_DIR}/
   ├── ops.sqlite          ← the database: runs, requests, usage, audit, approvals
   │                          backed up ONLINE, via SQLite's own backup API
   ├── sessions/           ← every session transcript
   ├── projects/           ← every project workspace
   ├── state/              ← per-project memory (MEMORY.md), instructions (INSTRUCTIONS.md)
   │                          and skills (skills/)
   │   └── <id>/snapshots.git ← the /undo snapshots           ← EXCLUDED from the archive
   ├── extensions/         ← installed extensions and lock.yaml (.staging/ EXCLUDED)
   ├── memory/             ← the global USER.md
   ├── config/             ← ops.yaml, projects/*.yaml and templates/*.yaml
   ├── dsh-home/           ← the composed profile, dsh's own state, and the keys
   │                          saved with /key (.credentials.yaml)
   ├── scratch/            ← ad-hoc task folders          ← EXCLUDED from the archive
   └── backups/            ← the backups themselves       ← EXCLUDED (not recursive)
```

One command produces **two artifacts**:

```sh
./deploy/scripts/backup.sh
```

| Artifact | Contents | Method |
|---|---|---|
| `ops-<stamp>.sqlite` | The database | SQLite's **online** backup API |
| `data-<stamp>.tar.gz` | Everything else | `tar`, excluding `scratch/`, the `/undo` snapshots and the database |

#### Why the database is separate

Copying a live SQLite file with `cp` can capture a torn page — the file is being written
while it is read, and the copy can contain a page from before a transaction and a page
from after. SQLite's `.backup` takes a **consistent snapshot** of a running database,
which is what makes a nightly backup safe without an outage.

The archive therefore **excludes** the database: a `tar` of a live SQLite file has
exactly the problem the online backup exists to avoid.

#### Why `scratch/` is excluded

It holds ad-hoc task folders and downloaded attachments. Nothing depends on it: a
project's own files are in `projects/`, and a task's folder is disposable by definition.
Including it would make every backup carry whatever a one-off task happened to download.

#### Why the `/undo` snapshots are excluded

They are a short history, kept for days (`snapshots.keep_days`), of folders the backup
already has as they are now. Including them would make each backup carry every version of
every file from the last two weeks. A restored server starts with no snapshots: the
next run records a new one.

#### What a backup does NOT cover

| Not covered | Where it lives | What to do |
|---|---|---|
| The image | The registry | Re-pull it; the tag identifies it |
| `.env` | `deploy/compose/.env` | **Back it up yourself.** It holds the bot token. |
| The host | — | A host-level backup |
| A provider's own state | The provider | — |

**`.env` is not in the data directory**, so `backup.sh` does not see it. Losing it means
losing the bot token and the provider keys set there. Keep a copy in your password manager.

**The keys saved with `/key` are in the backup** (`dsh-home/.credentials.yaml`), so a
backup restores them, and a backup is as secret as your keys: keep it where you would
keep them, and encrypt it when it leaves the machine.

### Running it

```sh
# Default: into <data>/backups, keeping 7 sets.
./deploy/scripts/backup.sh

# Somewhere else, keeping 30.
./deploy/scripts/backup.sh --output /mnt/backups --keep 30

# See what it would do.
./deploy/scripts/backup.sh --dry-run
```

| Option | Default | Meaning |
|---|---|---|
| `--output DIR` | `${DATA_DIR}/backups` | Where the artifacts go. |
| `--keep N` | `7` | How many backup **sets** to keep. |
| `--dry-run` | — | Show the plan; write nothing. |

It prints the artifact paths on **stdout** (progress goes to stderr), so a caller can
capture them:

```sh
BACKUP=$(./deploy/scripts/backup.sh)
```

The database artifact is verified with `PRAGMA integrity_check` before the script
succeeds. A backup nobody verified is a hope, and a corrupt one is discovered at the
worst possible moment.

#### Retention

`--keep` counts **sets**, and a set is one database plus one archive. Counting each kind
independently would eventually leave a database with no matching archive.

**Rotation deletes only names it created** — `ops-<date>.sqlite` and
`data-<stamp>.tar.gz`. A file you put in that directory by hand is never touched.

#### Scheduling it

`ops-health` already runs a backup daily at `health.backup_time` (`03:30` by default),
inside the container, rotating to `health.backup_keep`.

`backup.sh` is for the **off-machine copy** and for backups taken before an upgrade:

```cron
# Every night at 04:00, after the in-container backup, copied off the machine.
0 4 * * * cd /opt/argus-agent && ./deploy/scripts/backup.sh --keep 14 >> /var/log/argus-agent-backup.log 2>&1
30 4 * * * rsync -a --delete /srv/argus-agent/data/backups/ backup@elsewhere:/backups/argus-agent/
```

**A backup on the same machine is not a backup.** The disk that fails takes the backup
with it — which is why the second line exists.

### Restoring

```sh
# See what is available.
./deploy/scripts/restore.sh --list

# Restore the newest pair.
./deploy/scripts/restore.sh

# Restore specific artifacts.
./deploy/scripts/restore.sh --db /mnt/backups/ops-20261003-031500.sqlite \
                            --data /mnt/backups/data-20261003-031500.tar.gz
```

| Option | Meaning |
|---|---|
| `--from DIR` | Where the backups are. Default: `${DATA_DIR}/backups`. |
| `--db FILE` | The database artifact. |
| `--data FILE` | The archive. |
| `--list` | List what is available; restore nothing. |
| `--dry-run` | Show the plan; change nothing. |

#### What it does, in order

1. **Verify the artifact first.** `PRAGMA integrity_check` on the database and a
   readability check on the archive — **before** anything is destroyed. Discovering a
   corrupt backup after the restore would be discovering it too late.
2. **Stop the service**, and wait for it to actually exit. Restoring under a running
   SQLite means two writers on one file.
3. **Move the current data aside** to `${DATA_DIR}-pre-restore-<stamp>/`. **Not
   deleted**: the most common reason to restore is a bad upgrade, and the data from that
   state is what an investigation needs.
4. **Extract the archive**, then **copy the database** and remove the stale
   `-wal`/`-shm` sidecars.
5. **Start, and verify through the running service** — the health report's `opsStore`
   entry. A particular verification: a migration failure or a version mismatch shows up
   here and nowhere earlier.

#### Why the stale WAL matters

```
   before:  ops.sqlite  +  ops.sqlite-wal   ← writes not yet checkpointed
                              │
   restore: replaces ops.sqlite, but the old -wal remains
                              │
            SQLite applies the OLD wal to the NEW database → corruption
```

The sidecars belong to a **different** database and must not survive the restore.

#### After a restore

A restore **rewinds the system**:

- Every message sent, run started, schedule fired or approval decided after the backup
  did **not happen**, and will not happen on its own.
- The meter's counters return to the backed-up values.
- Interrupted runs from before the backup remain interrupted.

Send `/status` and check Telegram to see what the system believes.

Once you have confirmed it works:

```sh
sudo rm -rf /srv/argus-agent/data-pre-restore-<stamp>
```

### Verifying a backup without restoring it

```sh
# The schema and the row counts.
sqlite3 ops-20261003-031500.sqlite 'PRAGMA integrity_check;'
sqlite3 ops-20261003-031500.sqlite 'SELECT COUNT(*) FROM runs;'

# What is in the archive.
tar tzf data-20261003-031500.tar.gz | head -30

# Does the archive hold the projects?
tar tzf data-20261003-031500.tar.gz | grep '^./projects/' | head
```

### A worked round trip

The test `test/deploy/backup-restore.test.ts` does exactly this, against real files:

```
  1. Create a data directory with a real SQLite database, a session, a project
     workspace, a memory file, a config and a scratch file.
  2. Run backup.sh.
        → two artifacts, the database passing integrity_check
  3. Modify everything: new rows, changed files, a deleted file.
  4. Run restore.sh.
        → the original rows are back, the modified file is the original, the
          deleted file is restored, scratch/ is untouched
  5. Assert the previous data was moved aside, not deleted.
```

Run it:

```sh
pnpm vitest run --project deploy
```

### Disaster recovery, from nothing

On a brand-new host with only a backup directory:

```sh
# 1. Install, but do not let it initialize the data.
git clone https://github.com/rla-labs/argus.git && cd argus
./deploy/scripts/install.sh          # answer the prompts; it will write a config

# 2. Restore over it.
./deploy/scripts/restore.sh --from /mnt/backups

# 3. Restore .env from your password manager, then restart.
cd deploy/compose && $EDITOR .env
docker compose up -d --force-recreate

# 4. Verify.
./deploy/scripts/smoke.sh
```

**Restoring replaces `ops.yaml` too**, so a configuration changed since the backup is
reverted. That is usually what you want after a disaster, and worth knowing when it is
not.

---

## Upgrading

Upgrading Argus Agent, with rollback when it fails.

```sh
./deploy/scripts/upgrade.sh --to ghcr.io/rla-labs/argus:0.2.0
```

### Upgrading from dsh-ops (before the rename)

The project was called **dsh-ops** until 0.1.0. A deployment installed under that name
upgrades in place:

- **Docker.** `upgrade.sh` renames the `DSH_OPS_*` keys in `.env` to `ARGUS_AGENT_*`
  (keeping `.env.pre-argus`), finds the running image in the old `dsh-ops` container,
  and keeps using `/srv/dsh-ops/data` when `/srv/argus-agent/data` does not exist. The
  compose service is still `ops`, so `compose up` replaces the old container with the
  new `argus-agent` one rather than running both.
- **Native.** The scripts default to `/opt/argus-agent`, `/srv/argus-agent` and
  `argus-agent.service`. Either point them at the old layout
  (`ARGUS_AGENT_APP_DIR=/opt/dsh-ops ARGUS_AGENT_HOME=/srv/dsh-ops`), or move it: back
  up, `systemctl disable --now dsh-ops`, move the directories, remove
  `/etc/systemd/system/dsh-ops.service`, then run `install-native.sh`. Never leave
  both units enabled — the second refuses to start (the data directory is locked), and
  restarts in a loop until the first is stopped.
- The service itself still reads `DSH_OPS_CONFIG` and `DSH_OPS_DATA_DIR` when the new
  names are unset.

### The sequence

```
   1. BACK UP            before anything changes
        │
   2. RECORD the running image tag   (from the CONTAINER, not from .env)
        │
   3. PULL or BUILD the new image
        │
   4. SWITCH, then restart
        │
   5. SMOKE TEST
        │
   6. ROLL BACK on failure — the image always, the database only if migrations ran
```

#### Why the backup comes first

A backup taken after the upgrade is a backup of the broken state. The script runs
`backup.sh` before it touches anything, and refuses to continue past an unverified
backup without an explicit confirmation.

#### Why the tag is read from the container

`.env` holds the *configured* image; the container holds the *running* one. After a
rollback the two differ, and the container is what must be restored. Reading `.env`
would roll back to a tag that was never running.

#### Why migrations decide the database

```
   schema changed?   ──── yes ────▶  restore the database too
        │                            (an older image cannot read a newer schema —
        │                             it would fail again immediately)
        └──────── no ──────────────▶  KEEP the database
                                     (discarding a day of runs to undo an image
                                      change is the worse outcome)
```

The comparison is on `meta.schema_version` before and after. That is the only reliable
signal: a migration that merely adds an index succeeds, and rolling back onto it is
still a mismatch.

### Options

| Option | Effect |
|---|---|
| `--to IMAGE` | The image to upgrade to. Default: the tag in `.env`; when that is the running one (and not `latest`), the script stops and prints the command to upgrade. |
| `--build` | Build from this checkout instead of pulling. |
| `--no-backup` | Skip the pre-upgrade backup. **Not recommended.** |
| `--force-rollback` | Fail after upgrading, to exercise the rollback path. |
| `--dry-run` | Show the plan; change nothing. |

### Testing the rollback

The rollback path only runs when something breaks, which means it would otherwise only
ever run in production. `--force-rollback` fails **after** the upgrade succeeds:

```sh
./deploy/scripts/upgrade.sh --to ghcr.io/rla-labs/argus:0.2.0 --force-rollback
```

Expected: the upgrade completes, the smoke test passes, then the script reports a
forced failure, restores the previous tag, starts it, and exits **1** with the previous
version healthy.

Run this **before** you need it. A rollback that has never been executed is a plan, not
a procedure.

### What the output means

**Success** — exit 0:

```
  from    ghcr.io/rla-labs/argus:0.1.0  (version 0.1.0)
  to      ghcr.io/rla-labs/argus:0.2.0
  schema  3 → 4
  backup  /srv/argus-agent/data/backups/ops-20261003-031500.sqlite
```

**Failure with a successful rollback** — exit 1:

```
UPGRADE FAILED: the smoke test failed on the new version
rolling back to ghcr.io/rla-labs/argus:0.1.0
  the image tag was restored
  the schema changed: 3 → 4
  restoring the pre-upgrade database
  rolled back to ghcr.io/rla-labs/argus:0.1.0; the deployment is healthy again
```

**Failure with a failed rollback** — exit 1, and the output names the backup paths and
the manual command. This is the case that needs a person.

### Version pinning

**Pin a tag in production. Never `latest`.**

```yaml
ARGUS_AGENT_IMAGE=ghcr.io/rla-labs/argus:0.7.4
```

With `latest`, an upgrade happens on the next `docker compose up` — a restart becomes a
version change, and a restart is something you do when something is wrong. Pinning makes
an upgrade a decision.

### Migrations

Migrations run at startup, inside the transaction that opens the database. They are
**forward-only**: there is no down-migration.

**That is why rollback restores the database.** An older image against a newer schema
would fail again on the next start, and each attempt would leave the database in the
same unusable state. Restoring is the only rollback that produces a working system.

#### Before a significant upgrade

```sh
# 1. A backup, and copy it OFF the machine.
./deploy/scripts/backup.sh
rsync -av /srv/argus-agent/data/backups/ you@elsewhere:/backups/argus-agent/

# 2. Record what you are running.
docker inspect argus-agent --format '{{.Config.Image}}'
docker exec argus-agent curl -s http://127.0.0.1:3090/health | head -20

# 3. Note the schema version.
docker exec argus-agent node -e '
  const D = require("better-sqlite3");
  const db = new D("/data/ops.sqlite", { readonly: true });
  console.log(db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version"));
'
```

### Upgrading to 0.7.4

Nothing to do by hand. What changes for you:

- **One database migration** (0007): the mail outbox, and triggers. It runs at the first start and is
  in the backup `argus upgrade` takes first.
- **`mail.max_per_day` counts recipients**, not mails. Raise it if a project writes to
  several people at once.

### Upgrading to 0.7.3

Nothing to do by hand. What changes for you:

- **One database migration** (0006): a column for each user's interface language. It
  runs at the first start and is in the backup `argus upgrade` takes first.
- **The web looks and works differently**: projects first, settings for everything.
  An old address (`#projects/site-firma`) still opens the right place.
- **A one-off task is a session**: you can go on with it for a day after its last
  message (`/session`), then its agent and its folder go. Before, a task's agent stayed
  until the restart; its folder stayed for good, and folders left over are now removed
  after a day.
- **`/restart` and Restart now** restart Argus once the runs in progress finish, where
  something starts it again: the image says so (`ARGUS_SUPERVISED=docker`); on a native
  install, a service systemd started is recognised, and a later upgrade also writes
  `ARGUS_SUPERVISED=systemd` into its unit.
- **Sign in with Tailscale** is off until you turn it on (`web.tailscale_identity`) and
  link a login (`/users tailscale`).

### Upgrading to 0.7.2

Nothing to do by hand, and no database migration. What changes for you:

- **Every local MCP server now runs confined**, the ones you added yourself as well as
  an extension's: it reads the system and the project's folder, and keeps its files in
  `state/<project>/mcp/<server>/`. Without the sandbox it does not start. **A server
  whose program lives outside `/usr` or `/opt` no longer starts**: run it through
  `npx` or `uvx`, or package it as an extension. A server that kept a login in the
  shared home signs in again once; `/mcp reset <project> <server>` empties its home.
- **An extension's server may name in its `env` only the secrets it declares** in
  `requires.secrets`, `${EXTENSION_DIR}` and `${ARGUS_EGRESS_PROXY}`. A manifest that
  names anything else is refused at install; a third-party extension may need a new
  version.
- **Remote MCP servers can sign in with OAuth.** A server with an `oauth:` block waits
  for `/mcp connect <project> <server>`, which needs the web interface and its
  `public_url`; until then its tools answer that the admin must connect it
  ([Configuration](configuration.md)).
- `ARGUS_OAUTH_…` is a reserved prefix: `/key` refuses it, and an MCP server's `${NAME}`
  and an extension's `requires.secrets` may not use it.
- **The Docker image is about 8 MB larger:** the libraries Chromium loads and
  `fonts-liberation`, for the `browser` extension and `office`'s screenshots. A native
  install that wants them installs them with apt
  ([Native install](install-native.md#1-what-you-need)).

### Upgrading to 0.7.1

Nothing to do by hand, and no database migration. What changes for you:

- **A changed setting reaches a running project** at its next message, without `/reset`:
  its agent is rebuilt between runs and resumes the same conversation. `/model` now
  writes the project's file, like `/set <project> model`; before, it reached no agent.
- **Web search stays on DeepSeek** until you set `web_search.provider` in `ops.yaml`
  (`tavily`, `brave`, `serper` or `searxng`, then restart). Each search is still charged
  to the project that searched, now at the provider's own price
  ([Configuration](configuration.md#web_search--who-answers-the-agents-searches)).
- **Mail is off until you set an account.** A new tool group, `mail` (`send_mail`), is
  `ask` in a project and `off` in a task, and can never be `allow`. Nothing is sent until
  you run `/mail set` and list recipients in the project's `mail.allowed_recipients`
  ([Configuration](configuration.md#mail--who-a-project-may-write-to)).
- **The Docker image is about 15 MB larger:** five system libraries and a font, for the
  `images` extension. A native install that wants `images` installs them with apt
  ([Extensions](extensions.md#the-first-party-ones)).
- `ARGUS_MAIL_…` is a reserved prefix: `/key` refuses it, and an MCP server's `${NAME}`
  and an extension's `requires.secrets` may not use it.

### Upgrading to 0.7.0

Nothing to do by hand, and no database migration. What changes for you:

- **A new tool group, `git`** (`git_clone`, `git_pull`, `git_push`), `ask` by default. A
  project has these tools only once it declares a remote (`/git remote`); its token is
  set per project and per remote with `/git token`
  ([Configuration](configuration.md#git--remotes-argus-clones-pulls-and-pushes)).
- **Web searches count in the budget.** dsh never reported what a DeepSeek search cost;
  each is now charged an upper bound, about a cent with DeepSeek V4 Flash. A project that
  searches a lot shows more spending than before. `/tools` says when `web_search` has no
  DeepSeek key to run with.
- **Files:** a file sent in the chat that has the name of one already in `inbox/` is saved
  as `name (2).ext`, instead of replacing it. A file the agent `present`s, and one too big
  for the chat, now reach you (the second as a one-time link to the web).
- **New in `ops.yaml`, with defaults:** `web.max_upload_mb` (2048) and
  `web.download_link_hours` (24).
- **Extensions may bring programs** (`bin`). The first-party `office` and `media` are
  installed with `/ext install` ([Extensions](extensions.md#the-first-party-ones)).
- `ARGUS_GIT_…` is a reserved prefix: `/key` refuses it, and an MCP server's `${NAME}` may
  not use it.

### Upgrading to 0.6.2

Nothing to do by hand. What changes for you:

- **No more checkpoints.** A run is no longer paused every 60 steps or 45 minutes to ask
  Continue or Stop. It goes on until it finishes, its budget runs out, it reaches
  `limits.max_steps_total`, or a loop check stops it. `max_steps_per_run`,
  `max_wallclock_min`, `judge`, `judge_extend_steps` and `judge_max_extensions` are
  ignored where a file still has them; remove them when you next edit it.
- **The judge is now a loop checker**, off unless a project sets
  `limits.loop_check_steps`; `limits.on_loop` says what a loop does (`stop`, `notify`,
  `ask`). Its model is still `judge.model`. A `site` project checks every 50 steps and
  notifies, once a model is set ([Configuration](configuration.md#limits)).

### Upgrading to 0.6.0

Nothing to do by hand, and no database migration. What changes for you:

- **A project's own limits apply.** `limits:` in a project file, or in its template
  (`devops` sets 80 steps), was read and ignored before: `ops.yaml`'s applied to every
  project. The first start of 0.6 lists, in the startup report, the projects this
  changes; `/tools <project>` shows the limits in force.
- **The step limit asks instead of stopping.** At `max_steps_per_run` steps (60 by
  default) or `max_wallclock_min` minutes, a run waits for **Continue** or **Stop** in the
  chat or on the web; no answer within the approvals timeout stops it, and a scheduled run
  stops and says how to go on. No run passes `limits.max_steps_total` (1000 by default;
  the built-in templates set their own). See [Configuration](configuration.md#limits).
- **Loops are judged by results**, and a run that brings nothing new for 25 steps
  (`limits.stall_steps`) stops. Long work that keeps changing files or getting new
  results is never stopped by either.
- **New, off by default:** a judge model at the checkpoint (`/defaults judge`,
  `limits.judge`).

### Upgrading to 0.5.0

Nothing to do by hand, and no database migration. Your project files are read as they
are: a project made before 0.5.0 keeps every setting it has. What changes for you:

- **Before each run, a project's folder is recorded** for [`/undo`](commands.md#undo-project-id-list----run-id),
  in `state/<id>/snapshots.git` (left out of the backups). The native install needs
  `git` for it (`argus doctor` says if it is missing); the Docker image has it.
- **Scheduled runs no longer wait for an answer**: what they would ask about is refused at
  once, and the chat gets the rule that would allow it. To keep them asking, set
  [`approvals.unattended_timeout_s`](configuration.md#approvals).
- **Skills in a project's folder are no longer read** (`.agents/skills`, `.dsh/skills`). If
  you put one there, add it again with [`/skill add`](commands.md#skill-project-id--add-project-id-name-text--remove-project-id-name).
- **The commands that only read** (`ls`, `cat`, `grep`, …) **stop asking**, and the
  `site` template runs commands unasked; projects already made from it keep the settings
  written in their file.
- **New:** [extensions](extensions.md), `/template`, `/rule`, `/skill`.
- **Docker:** run `git pull` in your checkout before `argus upgrade`, so the backup script
  leaves the snapshots and the extensions' staging area out.

### Upgrading to 0.4.0

Nothing to do by hand. At the first start the database gains its users (migrations 2 to
5): the admin in `access.admin` and every allowed user, `/allow` ones included, become
users with their Telegram identities, the same roles as before. Four things to know:

- **The web has its own sign-in.** `/web` still works; once in, set a password in
  **Settings → Web password** and the link is no longer needed. Sessions survive a
  restart.
- **Approvals and notices reach you on every channel you use**, and an approval
  answered on one is closed on the others.
- **Telegram is optional now.** A token can be added or changed from the chat
  (`/key telegram`) with no restart; `access.admin` is no longer needed for a new
  install (the [setup link](web.md#without-telegram-the-setup-link) creates the admin).
- **Docker:** run `git pull` in your checkout before `argus upgrade`, for the new
  `argus setup-link` command and the [public mode](web.md#public-mode) overlay.

### Upgrading to 0.3.0

Nothing to migrate. A project file without a `tools` block gets the defaults: reading
its own folder runs, writing, commands, the web and any other tool ask, delegation is
hidden. Four things to know:

- **Roles.** A user other than the admin becomes an **operator**: they can no longer run
  `/new`, `/model`, `/allow-free`, change a budget or remove memory
  ([who may run what](commands.md#who-may-run-what)).
- **Delegation is off by default.** A project does not see `subagent`, `workflow`,
  `ralph` and the other `agents` tools (nor the new `ask_project`) until
  `tools.agents` is `ask` or `allow`.
- **The web interface.** On Docker, run `git pull` in your checkout before
  `argus upgrade`, so the compose file publishes the web port (on the host's
  `127.0.0.1:3091` only). Then follow [the web interface](web.md). A native install
  serves it on `127.0.0.1:3091` without a change.
- **`argus doctor`** now also warns about a project that allows both `web` and `shell`
  unasked.

### Reading the changelog

Each release on [GitHub](https://github.com/rla-labs/argus/releases) lists what changed.
For an upgrade, the parts that matter are **Changed** and **Fixed** between your version
and the new one.

### If an upgrade goes wrong

```sh
# Which version is running?
docker inspect argus-agent --format '{{.Config.Image}}'

# What does it say?
docker exec argus-agent curl -s http://127.0.0.1:3090/health
docker compose -f deploy/compose/docker-compose.yml logs --tail=100

# Go back by hand.
./deploy/scripts/upgrade.sh --to <the-previous-tag>

# Or restore, if the database is the problem.
./deploy/scripts/restore.sh --list
./deploy/scripts/restore.sh
```

See [Troubleshooting](troubleshooting.md).
