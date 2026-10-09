# Install natively (systemd)

Step by step, from a fresh Linux server to a working bot on Telegram, with **no Docker**.

> **Read this first.** Without a container there is nothing between a project's tools and
> your host. The systemd unit's hardening is the only barrier, so a command a project runs
> has the `ops` account's access to this machine. That is fine for a dedicated VPS running
> your own projects. It is **not** fine for running untrusted work — use the
> [Docker install](install-docker.md) for that.
> See [Security](security.md).

## Contents

1. [What you need](#1-what-you-need)
2. [Install Node 22 and pnpm](#2-install-node-22-and-pnpm)
3. [Get the code](#3-get-the-code)
4. [The automated install](#4-the-automated-install)
5. [The manual install, step by step](#5-the-manual-install-step-by-step)
6. [Opening the Telegram channel](#6-opening-the-telegram-channel)
7. [Creating your first project](#7-creating-your-first-project)
8. [Everyday operation](#8-everyday-operation)
9. [Backup, restore, upgrade](#9-backup-restore-upgrade)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. What you need

| | Minimum | Notes |
|---|---|---|
| OS | Debian 12, Ubuntu 22.04+, Rocky 9, Fedora | **systemd is required** — check with `systemctl --version` |
| Architecture | `x86_64` or `arm64` | |
| RAM | 1 GB | 2 GB if you also run a local model |
| Disk | 5 GB | The checkout plus `node_modules` plus the database |
| Access | `root`, or `sudo` | The install creates a system user and writes to `/opt`, `/srv`, `/etc` |
| Network | Outbound HTTPS | `api.telegram.org`, your provider, npm |

Three things to collect before you start:

| | Where |
|---|---|
| **A Telegram bot token** | Message [`@BotFather`](https://t.me/BotFather) → `/newbot` → follow the prompts. Looks like `8123456789:AAH...` |
| **Your numeric Telegram user id** | Message [`@userinfobot`](https://t.me/userinfobot) |
| **A provider API key** | Your model provider. Optional at install time |

> **A `@username` will not work as the user id.** Usernames can be changed or released and
> then claimed by someone else, so they are not identities. The allowlist compares
> identities. Message `@userinfobot` and use the number it gives you.

---

## 2. Install Node 22 and pnpm

**The pinned dsh requires Node 22.** A distribution's `nodejs` package is frequently older
(18.x on Debian 12), and that is the single most common reason a native install fails in a
confusing way. Check first:

```sh
node --version    # must be v22.x or newer
```

If it is missing or older, pick one method.

### Option A — NodeSource (system-wide, simplest)

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

On RHEL/Rocky/Fedora:

```sh
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
sudo dnf install -y nodejs
```

### Option B — nvm (per-user, no root)

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
nvm alias default 22
```

> **A caveat with nvm.** `dsh` ends up under your home directory, and the systemd unit
> runs as `ops` with `ProtectHome=read-only`. The installer records dsh's absolute path,
> but if `dsh` lives under `/home/you`, the service may not be able to execute it.
> Prefer **Option A**, or install dsh globally as root afterwards (step 5.7 does this).

### pnpm

```sh
sudo corepack enable
sudo corepack prepare pnpm@8.6.11 --activate
```

If `corepack` is unavailable:

```sh
sudo npm install --global pnpm@8.6.11
```

Verify:

```sh
node --version    # v22.x
pnpm --version    # 8.6.11 — the version that wrote the lockfile
```

---

## 3. Get the code

```sh
sudo git clone https://github.com/rla-labs/argus.git /opt/argus-agent-src
cd /opt/argus-agent-src
```

Then check out the release you want (a tag is reproducible; a branch is not):

```sh
sudo git checkout v0.2.2
```

The automated installer can also clone for you — this step is only needed if you want to
build a specific revision.

---

## 4. The automated install

One command, then answer four questions:

```sh
cd /opt/argus-agent-src
sudo ./deploy/native/install-native.sh
```

It will:

1. Check root, the OS, Node 22, pnpm, git, curl and the network.
2. Create the `ops` system user and the data layout under `/srv/argus-agent`.
3. Copy this checkout to `/opt/argus-agent` (or reuse an existing one there).
4. Run `pnpm install --frozen-lockfile` and `pnpm build` as the `ops` user.
5. Install the pinned `dsh` globally and **compose the ops profile with dsh's own plugin
   manager** — including installing the `argus-agent` bundle into the profile.
6. Write `/srv/argus-agent/data/config/ops.yaml` and `/srv/argus-agent/secrets.env` (mode 600).
7. Install and enable `/etc/systemd/system/argus-agent.service` and start it.
8. Wait for `/health`.
9. Send **"Argus Agent is online"** to your Telegram user id.
10. Print what to do next.

### Non-interactive

Every value can come from the environment, which is what CI and a scripted install use:

```sh
sudo TELEGRAM_BOT_TOKEN='8123456789:AAH...' \
     ARGUS_AGENT_ADMIN_ID='99887766' \
     ARGUS_AGENT_TIMEZONE='Europe/Bucharest' \
     DEEPSEEK_API_KEY='sk-...' \
     ./deploy/native/install-native.sh --non-interactive
```

`TELEGRAM_BOT_TOKEN` and `ARGUS_AGENT_ADMIN_ID` are **required** in that mode: an install that
cannot send a message has not been verified.

### Options

| Option | Effect |
|---|---|
| `--non-interactive` | Take every value from the environment; never prompt |
| `--skip-build` | Do not build (assume `lib/` exists) |
| `--dry-run` | Check prerequisites and print the plan; change nothing |
| `--yes` | Assume yes for confirmations |
| `--help` | Everything |

Paths are overridable: `ARGUS_AGENT_APP_DIR`, `ARGUS_AGENT_HOME`, `ARGUS_AGENT_DATA_DIR`.

### If it succeeds

```
==> waiting for health (up to 180s)
  ok health: ok
  ok the first message was delivered to 99887766
  ok the smoke test passed
```

**Check Telegram** — the message should already be there. Then go to
[section 7](#7-creating-your-first-project).

---

## 5. The manual install, step by step

For an operator who wants to see every step, or a host where the script does not fit.
Every command below is what the script does.

### 5.1 The service account

```sh
sudo useradd --system --home-dir /srv/argus-agent --create-home \
             --shell /usr/sbin/nologin ops
```

`--system` gives no password and a low uid; `nologin` because nothing should ever log in
as this account.

### 5.2 The directory layout

```sh
sudo mkdir -p /srv/argus-agent/data/{config/projects,projects,state,scratch,memory,backups,dsh-home}
sudo chown -R ops:ops /srv/argus-agent
sudo chmod 0750 /srv/argus-agent /srv/argus-agent/data
```

| Directory | Holds |
|---|---|
| `config/` | `ops.yaml` and `projects/*.yaml` |
| `projects/` | each project's working directory |
| `state/` | per-project memory (`MEMORY.md`) and secrets — **outside** every workspace |
| `scratch/` | ad-hoc task folders and downloaded attachments |
| `memory/` | the global `USER.md` |
| `backups/` | the dated backups |
| `dsh-home/` | the composed profile and dsh's own state |

### 5.3 The application

```sh
sudo mkdir -p /opt/argus-agent
sudo git clone https://github.com/rla-labs/argus.git /opt/argus-agent
sudo git -C /opt/argus-agent checkout v0.2.2
sudo chown -R ops:ops /opt/argus-agent
```

### 5.4 Dependencies and build

```sh
sudo -u ops env HOME=/srv/argus-agent bash -c '
  cd /opt/argus-agent
  pnpm install --frozen-lockfile
  pnpm build
'
```

Taking about five minutes on a small VPS. `--frozen-lockfile` fails rather than silently
resolving a different version.

### 5.5 dsh, pinned exactly

```sh
sudo npm install --global @deepseek-ai/dsh@0.2.0-rc.2
dsh --version    # 0.2.0-rc.2
```

**The version matters.** The bundle's patches are written against this exact dsh; a
different one is a different product.

### 5.6 The profile — the step that is easy to get wrong

dsh boots a profile from **`$DSH_HOME/profiles/<name>`**: a `package.json` naming the
bundles, a `cordis.patch.yml` (your own patch layer), and a `node_modules` the bundles
resolve from. The Argus Agent bundle is **linked** to the built application rather than
installed as a copy:

```sh
P=/srv/argus-agent/data/dsh-home/profiles/ops
sudo -u ops mkdir -p "$P/node_modules/@argus-agent"
sudo -u ops cp /opt/argus-agent/profiles/ops/package.json "$P/"
# Only on the first install: this file is yours, and a reinstall keeps it.
[ -f "$P/cordis.patch.yml" ] || sudo -u ops cp /opt/argus-agent/profiles/ops/cordis.patch.yml "$P/"
sudo -u ops ln -sfn /opt/argus-agent/packages/argus-agent "$P/node_modules/@argus-agent/argus-agent"
```

> **Why a link and not `dsh plugin add` of a packed bundle.** The bundle lists every ops-*
> plugin as a workspace peer. A packed bundle carries none of them, so dsh composes the
> rows and then every plugin fails to import — the service starts and does nothing.
> Through the link, the bundle reaches each plugin through the application's own
> `node_modules`, exactly as in the Docker image. It also means an upgrade that rebuilds
> `/opt/argus-agent` is live on the next restart, with nothing to reinstall.

Verify the profile **composes** before going further. This is the cheapest check and it
catches the most expensive failure:

```sh
sudo -u ops env HOME=/srv/argus-agent DSH_HOME=/srv/argus-agent/data/dsh-home \
  dsh --profile ops --dump-config | grep -c "name: .@argus-agent/"
```

Expect at least **12** (one row per ops plugin, plus the bundle's own rows). Fewer means
the link is wrong or `/opt/argus-agent/packages/argus-agent/lib` was not built.

### 5.7 The configuration

```sh
sudo -u ops cp /opt/argus-agent/deploy/templates/ops.yaml.minimal \
                /srv/argus-agent/data/config/ops.yaml
sudo chmod 0640 /srv/argus-agent/data/config/ops.yaml
```

Edit `/srv/argus-agent/data/config/ops.yaml`. It is a short file: everything not in
it has a default.

```yaml
timezone: Europe/Bucharest          # your timezone

# The path ON THE HOST. This is the one line that differs from the Docker install:
# there is no container, so there is no /data to map it to.
data_dir: /srv/argus-agent/data

access:
  admin: '99887766'                 # YOUR numeric Telegram id

budgets:
  default_day_usd: 3
  default_month_usd: 40
```

The admin may use the bot and receives the reports and warnings. Every other key is
listed, with its default, in `deploy/templates/ops.yaml.example`.

Then tell it what your models cost and which one to use by default:

```yaml
pricing:
  deepseek/*: { input: 0.14, cached: 0.014, output: 0.28 }

tasks:
  model: deepseek/deepseek-flash
```

**An unpriced model is refused** under the default `unknown_model_policy: block`. That is
deliberate: a system that cannot say what something costs should not buy it. Add an entry
for every model you name.

### 5.8 The secrets

```sh
sudo install -m 600 -o ops -g ops /dev/null /srv/argus-agent/secrets.env
sudo -u ops tee /srv/argus-agent/secrets.env >/dev/null <<'EOF'
TELEGRAM_BOT_TOKEN=8123456789:AAH...
DEEPSEEK_API_KEY=sk-...
EOF
```

**Mode 600 and owned by `ops`, or systemd will refuse to read it** — which is a useful
safety net rather than an obstacle: it fails the start instead of leaking the token. If
you see `Failed to load environment files`, check the mode:

```sh
sudo ls -l /srv/argus-agent/secrets.env    # -rw------- 1 ops ops
sudo chmod 600 /srv/argus-agent/secrets.env
```

### 5.9 The systemd unit

The unit is a **template**: `deploy/native/argus-agent.service` contains `@PLACEHOLDER@`
values that must be substituted for the paths you chose. A unit with a literal
`@APP_DIR@` in it will not start.

```sh
sudo sed -e 's|@APP_DIR@|/opt/argus-agent|g' \
         -e 's|@SERVICE_USER@|ops|g' \
         -e 's|@SERVICE_HOME@|/srv/argus-agent|g' \
         -e 's|@DATA_DIR@|/srv/argus-agent/data|g' \
         -e 's|@DSH_HOME@|/srv/argus-agent/data/dsh-home|g' \
         -e 's|@CONFIG_FILE@|/srv/argus-agent/data/config/ops.yaml|g' \
         -e 's|@SECRETS_FILE@|/srv/argus-agent/secrets.env|g' \
         -e "s|@DSH_BIN@|$(command -v dsh)|g" \
         /opt/argus-agent/deploy/native/argus-agent.service \
    | sudo tee /etc/systemd/system/argus-agent.service >/dev/null

sudo systemctl daemon-reload
```

Check it before starting it — `systemd-analyze` catches a mistyped path:

```sh
sudo systemd-analyze verify /etc/systemd/system/argus-agent.service
```

### 5.10 Start and verify

```sh
sudo systemctl enable --now argus-agent
sudo systemctl status argus-agent --no-pager
sudo journalctl -u argus-agent -f
```

Then:

```sh
curl -s http://127.0.0.1:3090/health | head -30
sudo /opt/argus-agent/deploy/native/smoke-native.sh
```

---

## 6. Opening the Telegram channel

The bot token and the allowlist are what make the channel work. Both are already set by
the installer; this section explains them and covers what to do when it does not work.

### 6.1 How it fits together

```
   You (Telegram)
        │
        ▼
   api.telegram.org  ◀──── LONG POLLING (outbound only; no ports, no webhook,
        │                   no domain, no certificate)
        ▼
   ops-telegram   the adapter: token, message limits, retries
        │
        ▼
   ops-channel    THE ALLOWLIST — every inbound path passes through it
        │
        ├──▶ a command (/status, /task, …)  — deterministic, no model
        ├──▶ a project agent                — verbatim text, nothing rewritten
        └──▶ the orchestrator               — free text, when no project is active
```

Three things must all be true for a message to be answered:

| # | Requirement | Where |
|---|---|---|
| 1 | The token is correct and the adapter is running | `TELEGRAM_BOT_TOKEN` in `secrets.env` |
| 2 | **You are the admin, or on the allowlist** | `access.admin`, `access.allowed_users` |
| 3 | You have sent `/start` to your own bot | Telegram itself |

### 6.2 The token

The token is read from the `TELEGRAM_BOT_TOKEN` environment variable, which systemd
supplies from `/srv/argus-agent/secrets.env`. `ops.yaml` does not mention it, so the
configuration file can be copied, shown or committed without leaking anything. (To read
it from another variable, set `telegram.bot_token: ${OTHER_VARIABLE}`.)

**The token is never logged**, not even truncated. A leaked token is a system anyone can
drive as your bot. If it leaks, revoke it with BotFather's `/revoke` and update
`secrets.env`, then `sudo systemctl restart argus-agent`.

### 6.3 The allowlist

```yaml
access:
  admin: '99887766'                                 # you: always allowed
  allowed_users:
    - { channel: telegram, userId: '11223344' }    # someone you trust
    # - { channel: '*', userId: '55667788' }       # every adapter
```

**With neither, everyone is refused** — the shipped default, so a configuration left
alone is not an open system.

The id is compared as a **string**, which is why it is quoted. A numeric id read as a
YAML number loses a leading zero and, for a very large id, precision.

### 6.4 Finding your user id

Message [`@userinfobot`](https://t.me/userinfobot) on Telegram. It replies with your
numeric id. **Do not** use your `@username`: usernames are mutable and can be released and
reclaimed, so they are not identities.

### 6.5 `/start` — the step everybody misses

Telegram does not let a bot send the first message to a user who has never opened a chat
with it. **Open your bot and send `/start` once** before expecting anything. Until you do,
the Bot API returns `chat not found` for every send, and the install script reports
exactly that.

### 6.6 Allowing a group (optional)

```yaml
telegram:
  allow_groups: true
```

**Groups are off by default**, and turning them on does not trust the group: the allowlist
still applies **per user**, so only ids you listed can drive the system from inside it.

### 6.7 Verifying the channel

Once the service is up:

1. **Send `/help`** to your bot. You should get the command list.
2. **Send `/status`.** You should get the system state.
3. If nothing arrives, work down this table.

| Symptom | Cause | Fix |
|---|---|---|
| Nothing at all | The token is wrong or unset | `sudo journalctl -u argus-agent \| grep -i telegram` — the log names the variable, never its value |
| Nothing at all | The adapter is not mounted | `curl -s 127.0.0.1:3090/health` — `opsTelegram` missing means the plugin is not in the profile |
| `chat not found` when sending | You never sent `/start` | Open the bot and send `/start` |
| The bot ignores **you specifically** | Not in the allowlist | `sudo journalctl -u argus-agent \| grep 'channel.refused'` — it names the id it saw. Put **that** in the allowlist. |
| Works, then goes silent | A 409 conflict: a second poller | Only one poller per token. Check for another `dsh` or a leftover container. |
| `429 Too Many Requests` | A rate limit | The adapter backs off and retries; nothing to do unless it persists |

After changing `ops.yaml` or `secrets.env`:

```sh
sudo systemctl restart argus-agent
```

---

## 7. Creating your first project

A project is a top-level agent with its own folder, model, budget and memory. Create
it from the chat. `/new` makes the folder and the file, and `/set` changes a setting
without opening the server:

```
/new reports
/set reports description The customer reporting pipeline: nightly aggregations, CSV exports, and the monthly invoice run
```

[Getting started](getting-started.md) goes on from there. The project's file is
`/srv/argus-agent/data/config/projects/reports.yaml`, and you may also edit it by hand,
then send `/reload`. A complete file, every key with a comment, is
`deploy/templates/projects/example.yaml`. The essentials:

```yaml
id: reports                         # MUST match the filename
cwd: /srv/argus-agent/data/projects/reports
description: >
  The customer reporting pipeline — nightly aggregations, CSV exports, and the
  monthly invoice run.
provider: deepseek
model: deepseek/deepseek-v4
fallback_model: deepseek/deepseek-flash

budget:
  day_usd: 3
  month_usd: 40

approvals:
  mode: ask                         # every risky action becomes a question
  auto_allow: []                    # nothing runs unattended
```

### Two fields that decide whether this works

**`description`** is the **only** thing the orchestrator knows about what a project is
for. A model cannot infer purpose from a name: `reports` tells it nothing, and "The
customer reporting pipeline — nightly aggregations, CSV exports, and the monthly invoice
run" tells it when to route a message here. Write it as a sentence, not a label.

**`cwd`** (`/new` sets it) must be inside `<data_dir>/projects/`. The loader **refuses** a path outside it
— that boundary is what keeps one project out of another's files, and a project that can
write into its neighbour's workspace has no isolation at all.

### Talking to it

| You send | What happens |
|---|---|
| `/start` | Says what to do next: create a project, pick one, or just write |
| `/p reports` | Makes `reports` the active project |
| `check the nightly aggregation` | Goes to the active project, **verbatim** |
| `/task summarize the logs` | A one-off task with no project and no memory |
| `/status` | Every project and its state |
| `/usage` | Cost, per project and global |
| `/runs`, `/files`, `/get` | What it ran, and the files it made |
| `/help` | Everything else |

---

## 8. Everyday operation

`argus` runs the native scripts here, because the unit is installed
([all its commands](README.md#running-it-from-the-shell-argus)).

```sh
# Is it running, and healthy?
argus status

# Follow the log (the journal needs root, or the adm group)
sudo argus logs -f

# The smoke test
sudo argus doctor

# Backup and upgrade
sudo argus backup
sudo argus upgrade

# Restart after a configuration change
sudo systemctl restart argus-agent

# Stop / start
sudo systemctl stop argus-agent
sudo systemctl start argus-agent
```

### Capping the journal

An agent logs a lot. An uncapped journal is what fills the disk the health plugin is
watching. In `/etc/systemd/journald.conf`:

```ini
SystemMaxUse=1G
```

Then `sudo systemctl restart systemd-journald`.

### The health endpoint is loopback-only

By design, and **not configurable**. It reports the shape of the system — plugin names,
queue depths, budget states — and has no authentication. There are no ports to open: the
service needs **no inbound firewall rule at all**. If you want to see it from your
laptop, use a tunnel:

```sh
ssh -N -L 3090:127.0.0.1:3090 you@your-vps
# then locally: curl http://127.0.0.1:3090/health
```

### The daily backup and report

`ops-health` backs the database up daily at `health.backup_time` (03:30 by default) into
`/srv/argus-agent/data/backups/`, and sends a daily report at `health.daily_report_time`
(09:00). Both are in the local timezone you configured.

**That backup does not leave the machine.** See the next section.

---

## 9. Backup, restore, upgrade

### Backing up

```sh
sudo /opt/argus-agent/deploy/native/backup-native.sh
```

Two artifacts: the database, taken with SQLite's **online** backup, and an archive of
everything else excluding `scratch/`.

> **`sqlite3` is optional.** Without it the backup goes through the application's own
> better-sqlite3, which has the same online backup API. Only if neither works, the
> script STOPS rather than copying a live database: a plain copy of a database being
> written can capture a torn page, and a backup that is silently inconsistent is worse
> than no backup.

**Copy the backups off the machine.** A backup on the same disk is not a backup — the disk
that fails takes it with it:

```sh
# Nightly: back up, then copy away.
0 4 * * * /opt/argus-agent/deploy/native/backup-native.sh --keep 14 >> /var/log/argus-agent-backup.log 2>&1
30 4 * * * rsync -a --delete /srv/argus-agent/data/backups/ backup@elsewhere:/backups/argus-agent/
```

**Two things are not in the backup**, and both matter:

| Not backed up | Why | What to do |
|---|---|---|
| `/srv/argus-agent/secrets.env` | It is outside the data directory | Keep a copy in your password manager |
| `/opt/argus-agent` | It is a git checkout, rebuildable | Nothing — reinstall to recover it |

### Restoring

There is no `restore-native.sh`; the procedure is short enough to do deliberately, and
doing it deliberately is the point:

```sh
# 1. Stop the service. Restoring under a running SQLite means two writers.
sudo systemctl stop argus-agent

# 2. Preserve the current data, in case you are restoring the wrong thing.
sudo mv /srv/argus-agent/data /srv/argus-agent/data-before-restore-$(date -u +%Y%m%d-%H%M%S)

# 3. Recreate the layout and restore.
sudo mkdir -p /srv/argus-agent/data
sudo tar xzf /path/to/data-<stamp>.tar.gz -C /srv/argus-agent/data
sudo cp /path/to/ops-<stamp>.sqlite /srv/argus-agent/data/ops.sqlite

# 4. Remove the stale WAL. It belongs to a DIFFERENT database; applying it to the
#    restored file corrupts it.
sudo rm -f /srv/argus-agent/data/ops.sqlite-wal /srv/argus-agent/data/ops.sqlite-shm

# 5. Ownership and permissions.
sudo chown -R ops:ops /srv/argus-agent/data
sudo chmod 0640 /srv/argus-agent/data/config/ops.yaml

# 6. Start and verify.
sudo systemctl start argus-agent
sudo /opt/argus-agent/deploy/native/smoke-native.sh
```

**A restore rewinds the system.** Any message sent, run started or schedule fired after
the backup did **not** happen and will not happen on its own. Send `/status` to see what
the system believes.

Verify an artifact without restoring it:

```sh
sqlite3 ops-<stamp>.sqlite 'PRAGMA integrity_check;'
# without sqlite3:
cd /opt/argus-agent/packages/ops-store && node -e \
  "console.log(new (require('better-sqlite3'))(process.argv[1], { readonly: true }).pragma('integrity_check', { simple: true }))" \
  /srv/argus-agent/data/backups/ops-<stamp>.sqlite
tar tzf data-<stamp>.tar.gz | head -30
```

### Upgrading

```sh
sudo /opt/argus-agent/deploy/native/upgrade-native.sh
```

It backs up first, records the current git revision **and the schema version**, fetches
and checks out the new revision, rebuilds, reinstalls the bundle into the profile,
restarts, and runs the smoke test.

**On failure it rolls back** — the revision always, and the database **only if migrations
ran**, because an older build against a newer schema fails again:

```
UPGRADE FAILED: the smoke test failed on the new revision
rolling back to a1b2c3d
  the schema changed: 3 → 4
  restoring the pre-upgrade database
  rolled back to a1b2c3d; the deployment is healthy again
```

Test that path **before** you need it:

```sh
sudo /opt/argus-agent/deploy/native/upgrade-native.sh --force-rollback
```

Expected: the upgrade succeeds, the smoke test passes, then the script reports a forced
failure, restores the previous revision, and exits 1 with the service healthy.

> **An upgrade does not change the dsh version.** dsh is pinned exactly, because the
> bundle's patches are written for it. Changing dsh is a deliberate act that re-runs the
> spikes (`pnpm test:spikes`) against the new version.

### Uninstalling

```sh
sudo /opt/argus-agent/deploy/native/uninstall-native.sh          # keeps the data
sudo /opt/argus-agent/deploy/native/uninstall-native.sh --purge  # removes everything
```

The default keeps the data, the application and the `ops` user.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `this must run as root` | Not root | `sudo ./deploy/native/install-native.sh` |
| `node ... is too old` | Node 18 from the distribution | Section 2 — install Node 22 |
| `ENOENT … profiles/ops/./…tgz` | The tarball path was RELATIVE | `dsh plugin` runs pnpm from the profile directory — use an absolute path |
| The profile composes fewer than 12 Argus Agent rows | The bundle link is wrong, or the bundle is not built | Re-read 5.6; check `/opt/argus-agent/packages/argus-agent/lib` exists |
| `Failed to load environment files` | `secrets.env` is group- or world-readable | `sudo chmod 600 /srv/argus-agent/secrets.env` |
| The service starts and immediately exits | `ops.yaml` is missing a required key, or `data_dir` is wrong | `journalctl -u argus-agent -n 50` |
| `SQLITE_CANTOPEN` | The data directory is not owned by `ops` | `sudo chown -R ops:ops /srv/argus-agent/data` |
| Health never comes up | See the journal; the plugin that failed names itself | `journalctl -u argus-agent -n 80` |
| `status` is `degraded` | Something wants attention, not a failure | `curl -s 127.0.0.1:3090/health` — the report names it |
| `status` is `down` | Panic mode, or a required plugin missing | The report names it; check the journal |
| The bot is silent | Wrong token, wrong user id, or no `/start` | [The bot is silent](troubleshooting.md#the-bot-is-silent) |
| An agent refuses a command | Approvals are `ask` (or `deny`) | Answer the question, or add the command to `auto_allow` |
| `UNPRICED_MODEL` | The model has no `pricing` entry | Add one — the default policy refuses unpriced models |
| A run is slow to start | The concurrency limit, or a reserved slot | `/status`, then `/panic` and `/resume-all` if needed |

The full index is [Troubleshooting](troubleshooting.md).

### Getting a full diagnostic

```sh
{
  echo "=== service ==="; systemctl status argus-agent --no-pager
  echo "=== health ==="; curl -s http://127.0.0.1:3090/health
  echo "=== journal ==="; journalctl -u argus-agent -n 200 --no-pager
  echo "=== versions ==="; node --version; pnpm --version; dsh --version
  echo "=== profile ==="; sudo -u ops env DSH_HOME=/srv/argus-agent/data/dsh-home \
    dsh --profile ops --dump-config | grep -c '^- id:'
} > /tmp/argus-agent-diag.txt 2>&1
```

That file contains no secrets: the token and the keys are only ever in `secrets.env`, and
Argus Agent never logs them.

---

## Appendix — the file layout

```
/opt/argus-agent/                          the application (a git checkout, built in place)
  packages/                            the plugins
  deploy/native/                       these scripts

/srv/argus-agent/                          the service account's home
  secrets.env                          mode 600, owned by ops
  .pnpm-store/                         pnpm's store
  data/                                THE DATA — the only thing to back up
    config/ops.yaml                    the configuration
    config/projects/*.yaml             one file per project
    projects/<id>/                     each project's working directory
    state/<id>/MEMORY.md               per-project memory (outside the workspace)
    state/<id>/secrets.env             per-project secrets (outside the workspace)
    memory/USER.md                     the global user profile
    scratch/                           ad-hoc task folders (NOT backed up)
    backups/                           the dated backups
    dsh-home/                          $DSH_HOME
      profiles/ops/                    the composed dsh profile
        package.json                   its bundles
        node_modules/                  the installed plugins

/etc/systemd/system/argus-agent.service    the unit (rendered from the template)
```

**The image-versus-data split does not exist here** — there is no image. The equivalent
rule is that `/opt/argus-agent` is replaceable and `/srv/argus-agent/data` is not.

## The native scripts

| Native script | What it does |
|---|---|
| `argus.sh` | The `argus` command, linked at `/usr/local/bin/argus` |
| `native/install-native.sh` | Fresh VPS → working bot, no Docker |
| `native/upgrade-native.sh` | Backup, revision change, rebuild, rollback on failure |
| `native/backup-native.sh` | Online SQLite backup + a data archive, with retention |
| `native/smoke-native.sh` | Is this deployment actually working? |
| `native/uninstall-native.sh` | Remove the service; keep the data unless `--purge` |
| `native/lib-native.sh` | Shared helpers for the above |
| `native/argus-agent.service` | The systemd unit **template** (placeholders substituted at install) |

The native scripts share the data layout with the Docker install, so a backup taken from
one restores into the other.
