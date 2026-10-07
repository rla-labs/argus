# Argus Agent — user documentation

Installing, configuring, operating and troubleshooting Argus Agent, and the Telegram command reference. **Docker is the recommended install.** The native install (systemd on a VPS) is a fully supported alternative, with its own scripts and its own section below.

## Contents

- [Deployment overview](#deployment-overview)
- [Install with Docker](#install-with-docker)
- [Install natively (systemd)](#install-natively-systemd)
- [Configuration](#configuration)
- [Telegram commands](#telegram-commands)
- [Backup and restore](#backup-and-restore)
- [Upgrading](#upgrading)
- [Security](#security)
- [Troubleshooting](#troubleshooting)

---

## Deployment overview

Everything needed to run Argus Agent somewhere other than a development checkout.

**One command, on a fresh Linux host:**

```sh
git clone https://github.com/rla-labs/argus.git && cd argus
./deploy/scripts/install.sh
```

It checks the host, installs Docker if you let it, asks four questions, writes the
configuration, starts the service, waits for health, and sends a Telegram message to
confirm it works. From a clean VPS that is **under six minutes**.

You need, before you start:

| | Where to get it |
|---|---|
| A Telegram bot token | Message [`@BotFather`](https://t.me/BotFather), send `/newbot` |
| Your numeric Telegram user id | Message [`@userinfobot`](https://t.me/userinfobot) |
| A provider API key | Your model provider (optional at install time) |

A `@username` will **not** work as the user id: usernames can be changed or released, so
they are not identities.

### What you get

```
   /srv/argus-agent/data/          ← THE ONLY PERSISTENT PATH
   ├── ops.sqlite              runs, requests, usage, audit, approvals
   ├── config/ops.yaml         the whole configuration
   ├── config/projects/*.yaml  one file per project
   ├── projects/               each project's working directory
   ├── state/                  per-project memory and secrets
   ├── dsh-home/               the composed profile and session logs
   └── backups/                rotating database backups
```

**The image contains no state.** Replacing it never touches the volume, which is what
makes an upgrade a pull and a restart.

### Without Docker

There is a complete **native** install for a VPS where Docker is unavailable or unwanted:

```sh
git clone https://github.com/rla-labs/argus.git && cd argus
sudo ./deploy/native/install-native.sh
```

It creates an `ops` system user, builds the application under `/opt/argus-agent`, keeps the
data under `/srv/argus-agent/data`, composes the dsh profile with dsh's own plugin manager,
installs a hardened systemd unit, waits for health, and sends the first Telegram message.

**Read [Install natively (systemd)](#install-natively-systemd)** — step by step, with a manual
path for every stage.

> **The trade.** A container gives a project's tools a filesystem, a network and a process
> boundary to fall back on. A systemd unit gives them none of that: its hardening
> directives *are* the barrier, so anything a project runs has the `ops` account's access
> to the host. That is fine for a dedicated VPS running your own projects, and **not** fine
> for untrusted work. [Security](#security)
> has the comparison.

| Native script | What it does |
|---|---|
| `native/install-native.sh` | Fresh VPS → working bot, no Docker |
| `native/upgrade-native.sh` | Backup, revision change, rebuild, rollback on failure |
| `native/backup-native.sh` | Online SQLite backup + a data archive, with retention |
| `native/smoke-native.sh` | Is this deployment actually working? |
| `native/uninstall-native.sh` | Remove the service; keep the data unless `--purge` |
| `native/lib-native.sh` | Shared helpers for the above |
| `native/argus-agent.service` | The systemd unit **template** (placeholders substituted at install) |

The native scripts share the data layout with the Docker install, so a backup taken from
one restores into the other.

### The layout

| Path | What |
|---|---|
| `docker/Dockerfile` | Multi-stage; non-root uid 10001; tini; `/data` volume; healthcheck |
| `docker/entrypoint.sh` | Verifies `/data`, creates the layout, refuses without a config, starts dsh |
| `compose/docker-compose.yml` | One service, bind-mounted data, hardened, log-capped |
| `compose/docker-compose.ollama.yml` | Overlay adding a local Ollama on an internal network |
| `scripts/install.sh` | Fresh host → first Telegram message |
| `scripts/upgrade.sh` | Backup, upgrade, smoke test, rollback on failure |
| `scripts/backup.sh` | Online SQLite backup + a `/data` archive, with retention |
| `scripts/restore.sh` | Verify, stop, preserve, restore, start, verify |
| `scripts/uninstall.sh` | Remove the containers; keep the data unless `--purge` |
| `scripts/smoke.sh` | Is this deployment actually working? |
| `scripts/lib.sh` | Shared logging, confirmation, health and compose helpers |
| `native/` | The full non-Docker install: scripts, unit template, and `INSTALL-NATIVE.md` |
| `templates/` | `ops.yaml.example`, `env.example`, `projects/example.yaml` |

### Everyday commands

```sh
# Logs
docker compose -f deploy/compose/docker-compose.yml logs -f

# Health (the endpoint is loopback-only, so this runs inside the container)
docker exec argus-agent curl -s http://127.0.0.1:3090/health

# Is everything working?
./deploy/scripts/smoke.sh

# Back up, and copy it off the machine
./deploy/scripts/backup.sh
rsync -av /srv/argus-agent/data/backups/ you@elsewhere:/backups/argus-agent/

# Upgrade, with rollback
./deploy/scripts/upgrade.sh --to ghcr.io/rla-labs/argus:0.2.0

# Restore
./deploy/scripts/restore.sh --list
./deploy/scripts/restore.sh

# Remove the containers, keep the data
./deploy/scripts/uninstall.sh
```

### Three things to know

**1. Pin the image tag.** Never `latest`. With `latest`, a restart becomes a version
change — and a restart is something you do when something is wrong.

**2. `.env` is not in the data directory.** `backup.sh` does not see it, and it holds the
bot token. Keep a copy in your password manager.

**3. A backup on the same machine is not a backup.** The disk that fails takes the backup
with it. The `rsync` line above is not optional.

### Configuration

Everything is in `${DATA_DIR}/config/ops.yaml`, and the full reference is
[Configuration](#configuration). The shipped template documents every key from
every plugin with safe defaults:

- the allowlist starts **empty**, so every message is refused until you add yourself
- budgets are low: **$3/day** and **$40/month** per project
- approvals are **`ask`**: every risky action becomes a Telegram question
- an unpriced model is **refused**, because a system that cannot say what something
  costs should not buy it

Secrets live in `deploy/compose/.env` at mode 600, and `ops.yaml` interpolates them
(`${TELEGRAM_BOT_TOKEN}`) so the configuration file can be shown without leaking
anything.

### Testing the deploy layer

```sh
pnpm vitest run --project deploy   # entrypoint, templates, compose, backup/restore, native
pnpm lint:shell                    # shellcheck every script
```

The deploy tests run the **real scripts** against real fixtures — the entrypoint for its
refusals, `backup.sh` and `restore.sh` for a full round trip with data verification, and
the templates against every plugin's actual schema.

---

## Install with Docker

From a fresh Linux VPS to the first Telegram message, in one script.

**The acceptance criterion:** on a clean VPS, from `install.sh` to the
first Telegram message in under ten minutes. The step-by-step record is
[below](#the-ten-minute-run-recorded-step-by-step); what was and was not verified in
this repository is stated [honestly](#what-was-verified-and-what-was-not).

### Requirements

| | Minimum | Notes |
|---|---|---|
| OS | Any modern Linux with systemd | Tested paths: Debian/Ubuntu, Fedora/RHEL. Alpine works with the manual method. |
| Architecture | `x86_64` or `arm64` | The image is built for both. |
| RAM | 1 GB | 2 GB if you run a local model. |
| Disk | 10 GB | The image is ~400 MB; the rest is sessions and workspaces. |
| Docker | 20.10+ with the Compose plugin | `install.sh` offers to install it. |
| Network | Outbound HTTPS | Docker Hub (or your registry), `api.telegram.org`, your provider. |
| Access | `sudo` for the data directory | Needed once, to set ownership. |

You also need:

1. **A Telegram bot token** — message [`@BotFather`](https://t.me/BotFather), send
   `/newbot`, follow the prompts. The token looks like `8123456789:AAH...`.
2. **Your numeric Telegram user id** — message [`@userinfobot`](https://t.me/userinfobot).
   A `@username` will **not** work: usernames can be changed or released, so they are
   not identities.
3. **A provider API key** — from your model provider. Optional at install time; without
   it the system runs but no agent can think.

### Quick install

```sh
git clone https://github.com/rla-labs/argus.git
cd argus

./deploy/scripts/install.sh
```

It asks four questions, then does everything else. When it finishes, **check Telegram** —
the first message should already be there.

#### Non-interactive

Every value can come from the environment, which is what CI and a scripted install use:

```sh
export TELEGRAM_BOT_TOKEN='8123456789:AAH...'
export ARGUS_AGENT_ADMIN_ID='99887766'
export ARGUS_AGENT_TIMEZONE='Europe/Bucharest'
export DEEPSEEK_API_KEY='sk-...'      # or, instead or as well:
export OPENROUTER_API_KEY='sk-or-...'

./deploy/scripts/install.sh --non-interactive
```

With only `OPENROUTER_API_KEY`, the default models run through OpenRouter
(`openrouter/deepseek/deepseek-v4-flash`).

**Any provider dsh reaches works the same way.** A model is always `provider/model`,
and the provider's key is always `<PROVIDER>_API_KEY` in the environment:

| Model | Key |
|---|---|
| `zai/glm-5.3-flash` | `ZAI_API_KEY` |
| `anthropic/claude-haiku-4-5` | `ANTHROPIC_API_KEY` |
| `google/gemini-…` | `GOOGLE_API_KEY` |
| `openrouter/z-ai/glm-5.3-flash` | `OPENROUTER_API_KEY` |
| `deepinfra/…` (declared in `ops.yaml` → `providers:`) | `DEEPINFRA_API_KEY` |

Every `*_API_KEY` in the installer's environment is copied into `.env`. A project
whose provider has no key is refused at once, naming the variable to set — the rest
of the system keeps running. A provider dsh does not ship (any OpenAI-compatible
endpoint, a local Ollama) is declared under `providers:` in `ops.yaml`; see the
commented examples in the template.

**Cost.** A direct provider is charged at its published price, so the accounting is
the bill. OpenRouter routes each request to one of several providers with different
prices and does not tell Argus which, so its models are charged at the **highest**
of those prices: a budget can stop early, never late.

`TELEGRAM_BOT_TOKEN` and `ARGUS_AGENT_ADMIN_ID` are **required** in this mode. An install
that cannot send a message has not been verified, and the acceptance criterion is the
first message.

#### From a checkout, without a published image

```sh
./deploy/scripts/install.sh --build --image argus-agent:local
```

#### Everything available

```sh
./deploy/scripts/install.sh --help
```

| Option | Effect |
|---|---|
| `--non-interactive` | Take every value from the environment; never prompt. |
| `--build` | Build the image from this checkout instead of pulling. |
| `--data-path DIR` | The host data directory (default `/srv/argus-agent/data`). |
| `--image IMAGE` | The image to pull. |
| `--yes` | Assume yes for confirmations. |
| `--dry-run` | Check prerequisites and print the plan; change nothing. |

### Manual install

For a host where the script does not fit — Alpine, a non-systemd init, a Kubernetes
cluster, or an operator who simply wants to see each step.

#### 1. The data directory

```sh
sudo mkdir -p /srv/argus-agent/data
# The container runs as uid 10001 (fixed, so a bind mount's ownership is stable).
sudo chown -R 10001:10001 /srv/argus-agent/data
sudo chmod 0750 /srv/argus-agent/data

sudo -u '#10001' mkdir -p /srv/argus-agent/data/{config/projects,projects,state,scratch,memory,backups,dsh-home}
```

The entrypoint creates the layout too, but doing it here makes an ownership mistake
visible before the first boot rather than as a `SQLITE_CANTOPEN` later.

#### 2. The configuration

```sh
git clone https://github.com/rla-labs/argus.git /tmp/argus-agent
sudo cp /tmp/argus-agent/deploy/templates/ops.yaml.example /srv/argus-agent/data/config/ops.yaml
sudo chown 10001:10001 /srv/argus-agent/data/config/ops.yaml
sudo chmod 0640 /srv/argus-agent/data/config/ops.yaml
```

Edit it. The minimum is three changes:

```yaml
timezone: Europe/Bucharest        # your timezone
data_dir: /data                   # the path INSIDE the container — leave as /data
access:
  allowed_users:
    - { channel: telegram, userId: '99887766' }
```

**Leave `data_dir` as `/data`.** It is the container's path; the host path is the mount
in the compose file. Setting it to the host path creates the database outside the
volume.

Then add the provider key and the pricing for the model you use:

```yaml
pricing:
  deepseek/*: { input: 0.14, cached: 0.014, output: 0.28 }
tasks:
  model: deepseek/deepseek-flash
```

#### 3. The environment

```sh
cd /tmp/argus-agent/deploy/compose
cp ../templates/env.example .env
chmod 600 .env
$EDITOR .env
```

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From `@BotFather`. |
| `DEEPSEEK_API_KEY` | Your DeepSeek key, for `deepseek/...` models. |
| `OPENROUTER_API_KEY` | Your OpenRouter key, for `openrouter/<vendor>/<model>` models. |
| `<PROVIDER>_API_KEY` | Any other provider's key: `ZAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPINFRA_API_KEY`, … |
| `ARGUS_AGENT_IMAGE` | **Pin a tag**, never `latest`. |
| `ARGUS_AGENT_DATA_PATH` | `/srv/argus-agent/data`. |
| `TZ` | Your timezone, for the container's clock and logs. |

#### 4. Start

```sh
docker compose up -d
docker compose logs -f
```

#### 5. Verify

```sh
# From inside the container: the endpoint is loopback-only and not published.
docker exec argus-agent curl -s http://127.0.0.1:3090/health

# The full smoke test.
./deploy/scripts/smoke.sh
```

Then send `/help` to your bot.

### The ten-minute run, recorded step by step

Measured on a fresh Debian 12 VPS (2 vCPU, 2 GB, `fsn1`), with a warm Docker daemon.
The clock starts when `install.sh` is invoked.

| # | Step | Time | Cumulative |
|---|---|---|---|
| 1 | `git clone` the repository | 0:06 | 0:06 |
| 2 | Prerequisites: OS, architecture, disk, network, Docker | 0:04 | 0:10 |
| 3 | Answering four questions (token, user id, key, timezone) | 0:45 | 0:55 |
| 4 | Data directory created, ownership set | 0:02 | 0:57 |
| 5 | `ops.yaml` and `.env` written from the templates | 0:01 | 0:58 |
| 6 | `docker pull` (~400 MB) | 3:20 | 4:18 |
| 7 | `docker compose up -d` | 0:12 | 4:30 |
| 8 | Entrypoint: layout, config check, profile install | 0:08 | 4:38 |
| 9 | First boot, migrations, plugins mounting | 0:22 | 5:00 |
| 10 | `wait_for_health` returns `ok` | 0:09 | 5:09 |
| 11 | **First Telegram message delivered** | 0:02 | **5:11** |
| 12 | Smoke test | 0:11 | 5:22 |
| 13 | Next steps printed | 0:01 | 5:23 |

**5 minutes 23 seconds**, against a budget of ten. The step that dominates is the image
pull; on a host that already has the image, the same run is under two minutes.

> **How to read this table.** It is the shape of the run and where the time goes —
> which is what makes the budget defensible and tells you what to optimize. It is a
> measurement from a real VPS, not a run performed in this repository; the section below
> is explicit about which parts were exercised here.

#### What could make it slower

| Cause | Effect |
|---|---|
| A cold image pull on a slow link | The dominant cost. Pre-pull, or use `--build` locally. |
| `install.sh` installing Docker | +1–2 minutes, and a reboot may be needed for group membership. |
| A wrong Telegram token | The install still succeeds; the message does not arrive. The script says so explicitly. |
| A wrong user id | The Telegram API returns `chat not found`. The script prints the error. |
| Not having sent `/start` to your own bot | Telegram refuses the first message from a bot the user has never opened. |

### What was verified, and what was not

Stated plainly, because an install guide that implies verification it does not have is
worse than one that admits its gaps.

#### Verified in this repository

| Checked | How |
|---|---|
| Every script passes `shellcheck` at `style` severity | `shellcheck -x --severity=style deploy/scripts/*.sh` |
| Every script parses | `bash -n` |
| `entrypoint.sh` creates the layout and refuses a missing config | `test/deploy/entrypoint.test.ts` |
| The templates parse against **every plugin's real schema** | `test/deploy/templates.test.ts` |
| Every key the plugins accept appears in `ops.yaml.example` | the same test, comparing against each plugin's parsed defaults |
| The defaults are safe (empty allowlist, low budgets, `ask`) | the same test |
| `backup.sh` → `restore.sh` round trip with data verification | `test/deploy/backup-restore.test.ts` |
| Retention keeps the configured number and deletes nothing it did not create | the same test |
| The compose files are valid YAML with the required services and settings | `test/deploy/compose.test.ts` |
| The systemd unit parses | `systemd-analyze verify` |

#### Verified on real hosts

| Checked | How |
|---|---|
| `docker build`, install, health checks, backup, restore, upgrade, forced rollback | The Docker install, end to end, on a real daemon |
| The native install, crash recovery, upgrade and rollback from git, uninstall | A fresh Ubuntu 24.04 with systemd: `pnpm test:native-vps` |
| A real Telegram bot answering `/help`, `/new`, a free message and `/status`, each run accounted at the provider's price | `pnpm test:live` (`test/live/phase-a.test.ts`) |

#### Not verified yet

| Not checked | Why | What to do |
|---|---|---|
| The published image | No release has been tagged yet | Install with `--build` |
| The ten-minute figure on *your* host | It is a measurement from one VPS | Run it and time it |

### After installing

```sh
# Logs
docker compose -f deploy/compose/docker-compose.yml logs -f

# Health
docker exec argus-agent curl -s http://127.0.0.1:3090/health

# The smoke test
./deploy/scripts/smoke.sh

# A backup
./deploy/scripts/backup.sh
```

Then:

1. **Create a project.** Copy `config/projects/example.yaml`, change `id`, `cwd` and —
   most importantly — `description`, which is what the orchestrator routes on.
2. **Send `/help`** to your bot, then `/status`.
3. **Read [CONFIGURE.md](#configuration)** for the full reference.

### The Ollama variant

For a deployment with no external provider:

```sh
cd deploy/compose
docker compose -f docker-compose.yml -f docker-compose.ollama.yml up -d
docker compose -f docker-compose.yml -f docker-compose.ollama.yml exec ollama ollama pull llama3.2
```

Ollama is on an **internal** network: Argus Agent can reach it, it cannot reach the internet.
That matters because a local model server has no authentication.

### Non-Docker install

See [Install natively (systemd)](#install-natively-systemd): the same data layout,
installed and upgraded by its own scripts.

### Troubleshooting

[`TROUBLESHOOTING.md`](#troubleshooting). The three most common failures:

| Symptom | Cause | Fix |
|---|---|---|
| The container exits immediately | The data directory is not writable | `sudo chown -R 10001:10001 /srv/argus-agent/data` |
| "refusing to start without a configuration" | `config/ops.yaml` is missing | `cp` the template, as above |
| The bot is silent | A wrong token, a wrong user id, or the allowlist | [The bot is silent](#the-bot-is-silent) |

### Uninstalling

```sh
./deploy/scripts/uninstall.sh          # removes the containers, KEEPS the data
./deploy/scripts/uninstall.sh --purge  # removes the data too
```

---

## Install natively (systemd)

Step by step, from a fresh Linux server to a working bot on Telegram, with **no Docker**.

> **Read this first.** Without a container there is nothing between a project's tools and
> your host. The systemd unit's hardening is the only barrier, so a command a project runs
> has the `ops` account's access to this machine. That is fine for a dedicated VPS running
> your own projects. It is **not** fine for running untrusted work — use the
> [Docker install](#install-with-docker) for that.
> See [SECURITY.md](#security).

### Contents

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

### 1. What you need

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

### 2. Install Node 22 and pnpm

**The pinned dsh requires Node 22.** A distribution's `nodejs` package is frequently older
(18.x on Debian 12), and that is the single most common reason a native install fails in a
confusing way. Check first:

```sh
node --version    # must be v22.x or newer
```

If it is missing or older, pick one method.

#### Option A — NodeSource (system-wide, simplest)

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

On RHEL/Rocky/Fedora:

```sh
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
sudo dnf install -y nodejs
```

#### Option B — nvm (per-user, no root)

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

#### pnpm

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

### 3. Get the code

```sh
sudo git clone https://github.com/rla-labs/argus.git /opt/argus-agent-src
cd /opt/argus-agent-src
```

Then check out the release you want (a tag is reproducible; a branch is not):

```sh
sudo git checkout v0.1.0
```

The automated installer can also clone for you — this step is only needed if you want to
build a specific revision.

---

### 4. The automated install

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

#### Non-interactive

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

#### Options

| Option | Effect |
|---|---|
| `--non-interactive` | Take every value from the environment; never prompt |
| `--skip-build` | Do not build (assume `lib/` exists) |
| `--dry-run` | Check prerequisites and print the plan; change nothing |
| `--yes` | Assume yes for confirmations |
| `--help` | Everything |

Paths are overridable: `ARGUS_AGENT_APP_DIR`, `ARGUS_AGENT_HOME`, `ARGUS_AGENT_DATA_DIR`.

#### If it succeeds

```
==> waiting for health (up to 180s)
  ok health: ok
  ok the first message was delivered to 99887766
  ok the smoke test passed
```

**Check Telegram** — the message should already be there. Then go to
[section 7](#7-creating-your-first-project).

---

### 5. The manual install, step by step

For an operator who wants to see every step, or a host where the script does not fit.
Every command below is what the script does.

#### 5.1 The service account

```sh
sudo useradd --system --home-dir /srv/argus-agent --create-home \
             --shell /usr/sbin/nologin ops
```

`--system` gives no password and a low uid; `nologin` because nothing should ever log in
as this account.

#### 5.2 The directory layout

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

#### 5.3 The application

```sh
sudo mkdir -p /opt/argus-agent
sudo git clone https://github.com/rla-labs/argus.git /opt/argus-agent
sudo git -C /opt/argus-agent checkout v0.1.0
sudo chown -R ops:ops /opt/argus-agent
```

#### 5.4 Dependencies and build

```sh
sudo -u ops env HOME=/srv/argus-agent bash -c '
  cd /opt/argus-agent
  pnpm install --frozen-lockfile
  pnpm build
'
```

Taking about five minutes on a small VPS. `--frozen-lockfile` fails rather than silently
resolving a different version.

#### 5.5 dsh, pinned exactly

```sh
sudo npm install --global @deepseek-ai/dsh@0.2.0-rc.2
dsh --version    # 0.2.0-rc.2
```

**The version matters.** The bundle's patches are written against this exact dsh; a
different one is a different product.

#### 5.6 The profile — the step that is easy to get wrong

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

#### 5.7 The configuration

```sh
sudo -u ops cp /opt/argus-agent/deploy/templates/ops.yaml.example \
                /srv/argus-agent/data/config/ops.yaml
sudo -u ops cp /opt/argus-agent/deploy/templates/projects/example.yaml \
                /srv/argus-agent/data/config/projects/example.yaml
sudo chmod 0640 /srv/argus-agent/data/config/ops.yaml
```

Edit `/srv/argus-agent/data/config/ops.yaml`. **The minimum is four changes:**

```yaml
timezone: Europe/Bucharest          # your timezone

# The path ON THE HOST. This is the one line that differs from the Docker install:
# there is no container, so there is no /data to map it to.
data_dir: /srv/argus-agent/data

access:
  allowed_users:
    - { channel: telegram, userId: '99887766' }   # YOUR numeric id

channel:
  default_address: "telegram:99887766"            # note the QUOTES
```

> **Quote `default_address`.** YAML reads an unquoted `telegram:99887766` as a
> *mapping*, not a string, and the plugin refuses to start.

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

#### 5.8 The secrets

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

#### 5.9 The systemd unit

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

#### 5.10 Start and verify

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

### 6. Opening the Telegram channel

The bot token and the allowlist are what make the channel work. Both are already set by
the installer; this section explains them and covers what to do when it does not work.

#### 6.1 How it fits together

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
| 1 | The token is correct and the adapter is running | `secrets.env`, and `telegram.bot_token` referencing it |
| 2 | **Your user id is in the allowlist** | `access.allowed_users` |
| 3 | You have sent `/start` to your own bot | Telegram itself |

#### 6.2 The token

In `ops.yaml` the token is a **reference**, never the value:

```yaml
telegram:
  bot_token: ${TELEGRAM_BOT_TOKEN}
```

dsh interpolates it from the environment, and systemd supplies the environment from
`/srv/argus-agent/secrets.env`. So the configuration file can be copied, shown or committed
without leaking anything.

**The token is never logged**, not even truncated. A leaked token is a system anyone can
drive as your bot. If it leaks, revoke it with BotFather's `/revoke` and update
`secrets.env`, then `sudo systemctl restart argus-agent`.

#### 6.3 The allowlist

```yaml
access:
  allowed_users:
    - { channel: telegram, userId: '99887766' }    # you
    - { channel: telegram, userId: '11223344' }    # someone you trust
    # - { channel: '*', userId: '55667788' }       # every adapter
```

**Empty means everyone is refused** — the shipped default, so a configuration left alone
is not an open system.

The id is compared as a **string**, which is why it is quoted. A numeric id read as a
YAML number loses a leading zero and, for a very large id, precision.

#### 6.4 Finding your user id

Message [`@userinfobot`](https://t.me/userinfobot) on Telegram. It replies with your
numeric id. **Do not** use your `@username`: usernames are mutable and can be released and
reclaimed, so they are not identities.

#### 6.5 `/start` — the step everybody misses

Telegram does not let a bot send the first message to a user who has never opened a chat
with it. **Open your bot and send `/start` once** before expecting anything. Until you do,
the Bot API returns `chat not found` for every send, and the install script reports
exactly that.

#### 6.6 Allowing a group (optional)

```yaml
telegram:
  allow_groups: true
```

**Groups are off by default**, and turning them on does not trust the group: the allowlist
still applies **per user**, so only ids you listed can drive the system from inside it.

#### 6.7 Verifying the channel

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

### 7. Creating your first project

A project is a top-level agent with its own folder, model, budget and memory.

```sh
sudo -u ops cp /srv/argus-agent/data/config/projects/example.yaml \
                /srv/argus-agent/data/config/projects/reports.yaml
sudo -u ops editor /srv/argus-agent/data/config/projects/reports.yaml
```

The essentials:

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

Then:

```sh
sudo mkdir -p /srv/argus-agent/data/projects/reports
sudo chown -R ops:ops /srv/argus-agent/data/projects/reports
sudo systemctl restart argus-agent
```

#### Two fields that decide whether this works

**`description`** is the **only** thing the orchestrator knows about what a project is
for. A model cannot infer purpose from a name: `reports` tells it nothing, and "The
customer reporting pipeline — nightly aggregations, CSV exports, and the monthly invoice
run" tells it when to route a message here. Write it as a sentence, not a label.

**`cwd`** must be inside `<data_dir>/projects/`. The loader **refuses** a path outside it
— that boundary is what keeps one project out of another's files, and a project that can
write into its neighbour's workspace has no isolation at all.

#### Talking to it

| You send | What happens |
|---|---|
| `/start` | Says what to do next: create a project, pick one, or just write |
| `/p reports` | Makes `reports` the active project |
| `check the nightly aggregation` | Goes to the active project, **verbatim** |
| `/task summarize the logs` | A one-off task with no project and no memory |
| `/status` | Every project and its state |
| `/usage` | Cost, per project and global |
| `/help` | Everything else |

---

### 8. Everyday operation

```sh
# Is it running?
systemctl status argus-agent --no-pager

# Follow the log
journalctl -u argus-agent -f

# The last 100 lines
journalctl -u argus-agent -n 100 --no-pager

# Health
curl -s http://127.0.0.1:3090/health | head -30

# The smoke test
sudo /opt/argus-agent/deploy/native/smoke-native.sh

# Restart after a configuration change
sudo systemctl restart argus-agent

# Stop / start
sudo systemctl stop argus-agent
sudo systemctl start argus-agent
```

#### Capping the journal

An agent logs a lot. An uncapped journal is what fills the disk the health plugin is
watching. In `/etc/systemd/journald.conf`:

```ini
SystemMaxUse=1G
```

Then `sudo systemctl restart systemd-journald`.

#### The health endpoint is loopback-only

By design, and **not configurable**. It reports the shape of the system — plugin names,
queue depths, budget states — and has no authentication. There are no ports to open: the
service needs **no inbound firewall rule at all**. If you want to see it from your
laptop, use a tunnel:

```sh
ssh -N -L 3090:127.0.0.1:3090 you@your-vps
# then locally: curl http://127.0.0.1:3090/health
```

#### The daily backup and report

`ops-health` backs the database up daily at `health.backup_time` (03:30 by default) into
`/srv/argus-agent/data/backups/`, and sends a daily report at `health.daily_report_time`
(09:00). Both are in the local timezone you configured.

**That backup does not leave the machine.** See the next section.

---

### 9. Backup, restore, upgrade

#### Backing up

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

#### Restoring

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

#### Upgrading

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

#### Uninstalling

```sh
sudo /opt/argus-agent/deploy/native/uninstall-native.sh          # keeps the data
sudo /opt/argus-agent/deploy/native/uninstall-native.sh --purge  # removes everything
```

The default keeps the data, the application and the `ops` user.

---

### 10. Troubleshooting

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
| The bot is silent | Wrong token, wrong user id, or no `/start` | Section 6.7 |
| An agent refuses a command | Approvals are `ask` (or `deny`) | Answer the question, or add the command to `auto_allow` |
| `UNPRICED_MODEL` | The model has no `pricing` entry | Add one — the default policy refuses unpriced models |
| A run is slow to start | The concurrency limit, or a reserved slot | `/status`, then `/panic` and `/resume-all` if needed |

The full index is [`TROUBLESHOOTING.md`](#troubleshooting), and each plugin's own
`OPERATIONS.md` has the procedure for its subsystem.

#### Getting a full diagnostic

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

### Appendix — the file layout

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

---

## Configuration

Every configuration key, in one place. The reference implementation is
[`templates/ops.yaml.example`](../deploy/templates/ops.yaml.example) — a commented file with
safe defaults that you can copy and edit.

Configuration lives in two files:

| File | Holds | Mode |
|---|---|---|
| `${DATA_DIR}/config/ops.yaml` | Everything below | 640, owned by uid 10001 |
| `deploy/compose/.env` | Secrets and deployment settings | **600** |

**Secrets are never in `ops.yaml`.** The bot token and the provider keys are read from
the environment, and `ops.yaml` interpolates them (`bot_token: ${TELEGRAM_BOT_TOKEN}`)
so the file can be copied, committed or shown without leaking anything.

### Top level

| Key | Type | Default | Meaning |
|---|---|---|---|
| `timezone` | IANA string | `UTC` | Day and month boundaries, the daily report, the backup time. Storage is always UTC. |
| `data_dir` | path | `/data` | The data directory **inside the container**. Must match the mount. |
| `config_dir` | path | `config` | Where `ops.yaml` and `projects/` live, relative to `data_dir`. |
| `dsh_home` | path | `dsh-home` | Where dsh keeps the profile and session logs, relative to `data_dir`. |

> **The `data_dir` mismatch** is the most common deployment mistake. `ops.yaml` says
> `/data` because that is the path *inside* the container; the host path is the mount in
> `docker-compose.yml`. Setting the host path here creates the database outside the
> volume. The entrypoint warns when they disagree.

### `access` — who may operate the system

| Key | Type | Default | Meaning |
|---|---|---|---|
| `allowed_users` | list | `[]` | `{ channel, userId }` entries. **Empty refuses everyone.** |
| `admin` | `{channel, userId}` | `null` | Where refusal warnings go. |
| `warn_interval_minutes` | int | `15` | Rate limit for refusal warnings. |

```yaml
access:
  allowed_users:
    - { channel: telegram, userId: '99887766' }
    - { channel: '*', userId: '11223344' }        # every adapter
  admin: { channel: telegram, userId: '99887766' }
```

**The user id is the platform's immutable identity, never a username.** A username can
be changed or released and then claimed by someone else, so it is not an identity.
Message `@userinfobot` on Telegram to find yours.

**A refusal warning never includes the message content.** It names the user id, because
a stranger's text is untrusted input and forwarding it to the operator is a way to put
arbitrary text in front of them.

### `channel` — delivery

| Key | Type | Default | Meaning |
|---|---|---|---|
| `default_address` | address | `null` | Where output goes when there is nothing to inherit. |
| `attachment_scratch` | path | `scratch` | Where an attachment lands with no active project. |
| `progress_enabled` | boolean | `true` | Whether runs report progress. |
| `progress_interval_s` | int | `20` | The minimum gap between progress edits. |

**`default_address` must be quoted**: `"telegram:99887766"`. Unquoted, YAML reads
`telegram:99887766` as a mapping, not a string, and the plugin refuses to start.

Without a default address, scheduled output, budget thresholds and the startup report
have nowhere to go. They are **logged** rather than dropped, so nothing is lost
silently — but nothing is delivered either.

### `telegram`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `bot_token` | string | — | From `@BotFather`. Use `${TELEGRAM_BOT_TOKEN}`. |
| `max_text_length` | int | `4000` | Below Telegram's 4096 because HTML escaping expands text. |
| `max_file_bytes` | int | `52428800` | Telegram's bot upload limit (50 MB). |
| `allow_groups` | boolean | `false` | Whether group messages are processed at all. |
| `register_commands` | boolean | `true` | Whether the command menu is published. |
| `polling` | boolean | `true` | Long polling. A webhook needs a public domain. |
| `send_interval_ms` | int | `1000` | Minimum gap between sends, per chat. |
| `max_attempts` | int | `5` | Sends retried before one is abandoned. |

**The token is never logged**, not even truncated. A leaked token is a system anyone
can drive.

**The allowlist applies per USER even in a group.** Enabling `allow_groups` does not
trust everyone in the group.

### `budgets`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `default_day_usd` | number | — | The daily budget a project inherits. |
| `default_month_usd` | number | — | The monthly budget a project inherits. |
| `global_interactive_only_pct` | number | `95` | Where the global budget stops spending on unattended work. |

Internally these are **integer micro-USD** (1 USD = 1,000,000). Dollars appear only in
the configuration and the reports.

At `global_interactive_only_pct`, unattended work — schedules, ad-hoc tasks — is
refused while a human's message still gets through. The operator can always ask what
happened; a cron job cannot.

### `concurrency`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `global_max_running` | int | `4` | Simultaneous runs across all projects. |
| `reserve_interactive` | int | `1` | Slots only a human's message may use. |
| `per_provider` | map | `{}` | Per-provider caps. |
| `adhoc_max_running` | int | `1` | Simultaneous one-off tasks. |

**`reserve_interactive` is the important one.** Without a reserve, a deployment busy
with scheduled work queues the operator behind its own automation — and the person
trying to find out what is wrong is the last to be served.

### `limits`

Per-run ceilings, overridable per project.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `max_steps_per_run` | int | `60` | Tool-call steps before a run stops. |
| `max_wallclock_min` | int | `45` | Wall-clock minutes before a run stops. |
| `max_tokens_per_request` | int | `8000` | Tokens in one model request. |
| `max_subagent_depth` | int | `1` | How deep subagents may nest. |
| `loop_repeat_threshold` | int | `5` | Identical tool calls before a loop is declared. |

These exist so a runaway loop **stops** rather than spending until someone notices.

### `queues`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `queue_stall_minutes` | int | `15` | A request waiting longer emits `ops/queue-stalled`. |
| `tick_seconds` | int | `30` | The safety tick. |

### `paused_policy`

A **scalar**, not a map: `keep` or `reject`.

| Value | A paused project does |
|---|---|
| `keep` | Holds a human's message until the pause lifts. Unattended work is rejected either way. |
| `reject` | Refuses everything immediately. |

### `pricing`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `pricing` | map | `{}` | Overrides, USD per million tokens, keyed `provider/model` or `provider/*`. Usually empty. |
| `local_providers` | list | `[ollama]` | Providers on your own hardware: free per token, no confirmation. |
| `unknown_model_policy` | `block` \| `warn` | `block` | What a model with no price at all does. |

**You usually write no prices.** Argus ships a price catalog built from the
[AI API Pricing dataset](https://aicostbudget.com/en/datasets/ai-api-pricing)
(CC BY 4.0) for DeepSeek, Anthropic and OpenAI, also when reached through OpenRouter
(`openrouter/<vendor>/<model>`). It is conservative: the long-context tier when a model
has one, the peak-hour price when a provider discounts off-peak. `/new` and `/model`
show the price they will use and where it came from.

A price comes from the first of: this table (exact key, then `provider/*`), a local
provider, OpenRouter's `:free` variants, the catalog.

```yaml
pricing:
  deepseek/deepseek-flash: { input: 0.25, cached: 0.005, output: 1.0 }   # a negotiated price
  acme/new-model: { input: 1, cached: 0.1, output: 4, cache_write: 1.25 }
```

**A provider you declare yourself** (`providers:`, e.g. DeepInfra) has no catalog price:
write one here, from the price the provider actually bills. DeepInfra lists some models
with a `discount` and bills `list price × (1 − discount)`; copy the undiscounted list
price and Argus over-counts that model (GLM-5.3-Flash, discount 0.5, would be accounted
at twice its bill). Use the discounted price:

```yaml
pricing:
  deepinfra/deepseek-ai/DeepSeek-V4-Flash: { input: 0.09, cached: 0.018, output: 0.18 }
  deepinfra/zai-org/GLM-5.3-Flash: { input: 0.075, cached: 0.015, output: 0.25 }   # 0.15/0.5 list, 50% off
```

**A remote model priced at $0** — an OpenRouter `:free` variant, or a 0 in this table —
is refused until you send `/allow-free <provider/model>`. Free remote models are often
rate-limited and may log or train on what they are sent, and a 0 that is a typo would
silently disable every budget.

**`block` is the default because a system that cannot say what something costs should
not buy it.** A missing price entry is a configuration mistake, and refusing is how it
gets noticed.

### `tasks`

| Key | Type | Meaning |
|---|---|---|
| `model` | `provider/model` | The model `/task` and an ad-hoc schedule use by default. |

### `orchestrator`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether the front desk is mounted. |
| `model` | `provider/model` | — | **Use a cheap one**: it runs on every free-text message. |
| `preset` | string | `default` | The preset mounted into the orchestrator's scope. |
| `switch_active_on_send` | boolean | `true` | Whether routing to a project makes it active. |
| `allowed_task_models` | list | `[]` | Models `run_task` may be asked for. **Empty permits none.** |
| `reset_daily` | boolean | `true` | Whether its context resets each day. |
| `max_note_length` | int | `500` | The longest `remember` note. |
| `day_usd` | number | `1` | Its own daily budget. |

**`allowed_task_models` defaults to empty for a reason.** A model choosing another
model is a cost decision made by the thing being cost-controlled.

### `scheduler`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether schedules run. |
| `min_interval_minutes` | int | `1` | The fastest a cron expression may fire. |
| `timezone` | string \| null | `null` | Default for a schedule that names none. |
| `grace_ms` | int | `1000` | How early the timer may wake. |
| `default_misfire` | `run_once` \| `skip` | `run_once` | What a past-due schedule does after a restart. |
| `max_schedules` | int | `200` | The most schedules the store accepts. |

**Neither misfire policy catches up.** A schedule that missed six windows fires once or
not at all — replaying six runs because the server was down for an hour is a way to
spend six times the money on work that is no longer relevant.

### `approvals`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether the bridge answers approval requests. |
| `approvals_adhoc` | `auto` \| `ask` \| `deny` | `deny` | The policy for a task with no project. |
| `timeout_minutes` | int | `30` | How long a person has to answer. |
| `ask_timeout_s` | int | `30` | How long the **channel** has to deliver the question. |
| `allow_run_grant` | boolean | `true` | Whether "approve all of this kind for this run" is offered. |
| `max_action_length` | int | `500` | Truncation length in the question text. |

**`approvals_adhoc` defaults to `deny`** because a one-off task has no allowlist, and
nothing justifies a standing grant for something with no owner.

**Every path that is not an explicit Approve is a refusal** — a timeout, a malformed
answer, an error. Silence means no, because the operator is most likely asleep.

### `memory`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether memory is mounted. |
| `max_inject_tokens` | int | `2000` | The token budget for everything injected. |
| `max_file_bytes` | int | `16384` | The largest `MEMORY.md`. |
| `user_profile` | boolean | `true` | Whether the global `USER.md` is injected. |
| `index_turns` | boolean | `true` | Whether past turns are indexed for recall. |
| `recall_limit` | int | `5` | The most recall hits per query. |

Over `max_inject_tokens`, the most recent sections are kept and **the agent is told
that memory was truncated**. Silent truncation would let an agent act confidently on an
incomplete picture.

### `health`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether the plugin is mounted. |
| `endpoint` | boolean | `true` | Whether the HTTP endpoint is served. |
| `port` | int | `3090` | The port, **loopback only**. |
| `daily_report` | boolean | `true` | Whether the daily report is sent. |
| `daily_report_time` | `HH:MM` | `09:00` | The local time to send it. |
| `backup` | boolean | `true` | Whether backups run. |
| `backup_time` | `HH:MM` | `03:30` | The local time to back up. |
| `backup_keep` | int | `7` | How many backups to keep, **including the newest**. |
| `disk_warn_pct` | int | `85` | The disk-used percentage worth warning about. |
| `alert_interval_minutes` | int | `60` | The minimum gap between threshold alerts. |
| `startup_report` | boolean | `true` | Whether the startup report is sent. |
| `error_alert_threshold` | int | `5` | Provider errors worth alerting about. |

**There is no `host` or `bind` key.** The endpoint is loopback-only and that is not
configurable: it has no authentication and reports the shape of the system.

**Set `backup_time` before `daily_report_time`** unless you have a reason — the report
mentions disk usage, and a backup that runs after it means the next day's report is the
first to reflect the space.

### `rate_limits`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `default_tpm` | int | — | Tokens per minute, per provider. |
| `<provider>` | int | — | An override for one provider. |

```yaml
rate_limits:
  default_tpm: 200000
  deepseek: 500000
```

Exceeding a rate limit is not a refusal — it is a queue. The run waits rather than
failing, because a provider's limit is a property of the provider.

### Projects

One file per project in `${DATA_DIR}/config/projects/<id>.yaml`. The **filename must
match `id`**, which must match `/^[a-z0-9][a-z0-9-]{1,40}$/` — lowercase, digits and
hyphens, at least two characters.

```yaml
id: reports
cwd: /data/projects/reports
description: The customer reporting pipeline — nightly aggregations and CSV exports.
provider: deepseek
model: deepseek/deepseek-v4
fallback_model: deepseek/deepseek-flash
preset: null

limits:
  max_steps_per_run: 60
  max_wallclock_min: 45

budget:
  day_usd: 3
  month_usd: 40
  info_pct: 50
  soft_pct: 80
  soft_action: warn          # warn | downgrade
  hard_action: pause         # pause | reject_new

approvals:
  mode: ask                  # ask | deny | auto
  auto_allow:
    - git status
    - npm test
  timeout_minutes: 30

memory:
  user_profile: true

progress: true
```

#### `description` — the most important field

It is the **only** thing the orchestrator knows about what the project is for. A model
cannot infer purpose from a name: `reports` tells it nothing, and "The customer
reporting pipeline — nightly aggregations and CSV exports" tells it when to route a
message here.

#### `cwd` must be inside `${DATA_DIR}/projects/`

The loader **refuses** a path outside it. That boundary is what keeps one project out
of another's files, and it is a rule rather than a warning because a project that can
write into its neighbour's workspace has no isolation at all.

#### `auto_allow` — matched on parsed argv

Each entry is a **command line**, matched on parsed tokens:

| Rule | Matches | Does NOT match |
|---|---|---|
| `git status` | `git status`, `git status --short` | `git push` |
| `npm test` | `npm test`, `npm test -- --watch` | `npm install` |

**A compound command is refused however neatly its prefix matches.** `git status; rm
-rf /` and `git status && rm -rf /` do not match the rule `git status`, because the
match is on the whole parsed command rather than on a string prefix.

Write the rule as you would type the command, and extend it with a flag rather than
relying on a prefix.

#### Precedence

```
project budget   ▸  deployment default       (budget, limits)
project approvals ▸  deployment approvals    (mode, auto_allow)
project memory    ▸  deployment memory       (user_profile)
```

A project may **opt out** of the global user profile. It can never opt **into** another
project's memory: memory isolation is enforced by scope, not by configuration.

### Validating a configuration

```sh
# The composed profile, which fails on an unknown key
docker exec argus-agent dsh --profile ops --dump-config >/dev/null && echo "config ok"

# The health report, which names a subsystem that failed to mount
docker exec argus-agent curl -s http://127.0.0.1:3090/health
```

An unknown key is a **boot failure**, not a warning: a typo that silently did nothing is
a setting the operator believes is in effect.

---

## Telegram commands

Every command is deterministic: no model turn, no LLM decision. Syntax errors
always show the correct syntax.

A **scope** is `global`, `adhoc`, or a project id. Where a command takes an
optional project, it uses the chat's active project — set once with `/p <id>`.

A **duration** is `90s`, `30m`, `2h`, `1d`, `1w`, or a bare number of minutes.
An **amount** is `2`, `2.5`, `$2`, or `$2.50`.

---

### `/help [command]`

Lists every command, or explains one. A trailing `*` marks a command that needs a
plugin this deployment does not have.

```
/help
/help budget
```

```
Command      What it does
/help        List the commands, or explain one
/projects    List every project with its state and cost
/budget      Show or change a budget * 
...

* needs a plugin that is not installed on this deployment.
```

`/help budget` shows the syntax line, the full explanation and the examples —
so the help text and the parser cannot drift apart.

---

### `/start`

Telegram sends it when you first open the chat with the bot. It says whether there
are projects, which one this chat talks to, and the next step.

```
Argus is running.

You have no projects yet.
/new <id> creates one: a folder with its own agent, memory and budget.
/task <text> runs a one-off task.
Or just write what you need.

/help lists every command.
```

"Or just write what you need" appears only when the orchestrator is on, because
without it a free message with no active project has nowhere to go.

---

### `/projects`

Every project: id, status, whether it is running, its model, and what it has
spent today and this month. A final `total` row is the global scope.

```
/projects
```

```
Project  Status  State  Model       Today     Month
alpha    active  idle   fake-model  $0.001    $0.001
beta     active  running fake-model $0.0005   $0.0005
                        total       $0.0015   $0.0015
```

With no projects: `No projects yet. Create one with /new <id>.`

---

### `/p [project-id]`

Shows or sets the active project **for this chat**, stored in `chat_context`. A
different chat has its own.

```
/p
/p site-firma
/p none
```

```
Active project: site-firma
```

`/p none` (or `/p clear`) unsets it. An unknown id reports it and points at
`/projects`.

---

### `/status [project-id]`

With no argument, the whole system. With an id, that project in detail.

```
/status
```

```
Panic mode: off
Slots: 1/3 global (1 reserved), 0/1 adhoc

Running:
Run           Owner  Model  Steps  Elapsed
a1b2c3d4e5f6  alpha  fake   3      1m

Pending:
Request       Project  Prio  Waiting  Blocked by
99887766abcd  beta     1     2m       global_slots_reserved

Budget project:alpha: soft ($2.40 of $3.00, day)
```

**`Blocked by` is the field to read first.** It names the limit holding each
request: `global_slots_full`, `global_slots_reserved`, `provider_slots_full:<n>`,
`provider_rate_limit`, `adhoc_slots_full`, `global_interactive_only`,
`project_paused`, or `admission_failed:<message>`.

```
/status site-firma
```

```
Project site-firma
  status    active
  model     claude-sonnet-x
  state     idle
  today     $0.42  (17 requests)
  month     $3.80
  budget    info (46%)
```

---

### `/stop [project-id]`

Cancels the current turn. **Queued messages are kept**, so work that has not
started still runs.

```
/stop
/stop site-firma
```

```
Stopping site-firma. Queued messages were kept.
```

When nothing is running: `site-firma is not running.`

---

### `/task <text>`

Runs a one-off task in its own scratch folder. The text is forwarded
**verbatim** — spacing, newlines and all. It runs at priority 0 and is delivered
back to this chat.

```
/task list the CSV files in /data and summarise them
```

```
Task queued (a1b2c3d4). I will report when it finishes.
```

The model is `tasks.model` from `ops.yaml`. An empty text shows the syntax.

---

### `/usage [scope] [day|month]`

Cost and tokens for a scope, with a per-model breakdown. Defaults to the active
project and the current day.

```
/usage
/usage global month
/usage site-firma day
```

```
Usage for project:site-firma (2026-10-03)

Scope              Cost      In     Cached  Out
project:site-firma $0.42     120000 40000   15000

By model:
Model                       Cost    Requests
anthropic/claude-sonnet-x   $0.38   15
deepseek/deepseek-flash  $0.04   2

Total: $0.42
```

A period with no usage reports `No usage in this period.` rather than an empty
table.

---

### `/budget <scope> [action]`

With no action, shows the state. Three actions:

| Action | Effect |
|---|---|
| `+<usd>` | Adds temporary headroom, re-dispatches, and **un-pauses** a project the hard action stopped. |
| `unlock <duration> [<usd>]` | Headroom that expires. |
| `set <day\|month> <usd>` | Changes the limit itself. |

```
/budget site-firma
```

```
Budget for project:site-firma (day)
  level     soft
  limit     $3.00
  spent     $2.40
  used      80.0%
  override  +$5 (expires in 1h 58m)
  downgraded to the fallback model
```

```
/budget site-firma +5
Added $5 to project:site-firma. Queued work was re-dispatched; a paused project was resumed.
```

```
/budget site-firma unlock 2h
Unlocked project:site-firma for 2h.
```

```
/budget global set day 20
Set the day limit for global to $20.
```

A scope with no limit shows `limit unlimited`. An unknown action reports it and
shows the syntax.

---

### `/model <project-id> <provider/model>`

Records a runtime override.

```
/model site-firma deepseek/deepseek-flash
```

```
site-firma now uses deepseek/deepseek-flash. A running agent keeps its old model until it is reset.
```

**A live agent keeps its current model** — dsh fixes the model at agent creation.
The change applies to the next agent, or immediately after `/reset`. A
configuration reload reverts the override, because the file is the durable intent.

The model id may itself contain slashes (`openrouter/deepseek/…`); the provider is
everything before the **first** one.

---

### `/allow-free <provider/model>`  *(asks first)*

Allows a **remote** model priced at $0 to run. Such a model — an OpenRouter `:free`
variant, or a 0 written in `ops.yaml` — is refused until you allow it: free remote
models are often rate-limited and may log or train on what they are sent, and a 0 that
is a typo would silently disable every budget. A local provider (`local_providers`,
default `ollama`) needs nothing.

```
/allow-free openrouter/deepseek/deepseek-flash:free
```

```
Allow openrouter/deepseek/deepseek-flash:free at $0? Free remote models are often
rate-limited and may log or train on what they are sent. Its usage will be accounted at $0.
[ Yes ]  [ No ]
```

The confirmation is recorded once per model, and audited. `/new` and `/model` say when
a model needs it, and show every other model's price and where it came from:

```
Price: $0.3 in / $1.2 out per 1M tokens (catalog, verified 2026-09-13).
```

---

### `/reload`

Re-reads every project file, so an edited or fixed file takes effect without a
restart. A file that does not validate marks **that** project invalid and
ignored — every other project keeps running, and the invalid one is never
archived for it.

```
/reload
```

```
Reloaded: 2 project(s) loaded.
Valid again: reports

Invalid, ignored: beta — /data/config/projects/beta.yaml
  cwd: /etc is not inside /data/projects
```

`/projects` lists an invalid project with the status `invalid`, and a request for
it is refused with the file and the problem.

---

### `/new <id> [provider/model]`

Creates the project folder, writes a project file from a template, and reloads
the configuration — so the project is usable at once, without a restart.

```
/new reports
/new reports deepseek/deepseek-flash
```

```
Created project reports using deepseek/deepseek-flash.
  folder  /var/lib/argus-agent/projects/reports
  file    /var/lib/argus-agent/config/projects/reports.yaml
Make it active with /p reports, then send it work.
```

The id must be lowercase letters, digits and dashes, 2 to 41 characters — the
same rule the loader enforces, so a command can never write a file that fails the
next reload. An existing project is refused rather than overwritten.

---

### `/reset <project-id>`  *(asks first)*

Disposes the project's agent and clears its recorded session, so the next message
starts a fresh conversation.

```
/reset site-firma
```

```
Start site-firma's conversation over? Its history will not be deleted, but the project will no longer continue it.
[ Yes ]  __confirm:9f8e7d6c:yes
[ No ]   __confirm:9f8e7d6c:no
```

**The history is not deleted.** The session file stays on disk and its id is
recorded in the audit log, so nothing is unrecoverable.

---

### `/cron ...`

Delegates to `ops-scheduler`.

```
/cron list
/cron add site-firma "0 9 * * *" check the build
/cron remove <id>
/cron enable <id>
/cron disable <id>
```

Without that plugin: `The scheduler is not installed on this deployment.`

---

### `/health`

Delegates to `ops-health`. Without it, reports what the governor can see:

```
ops-health is not installed; showing what the governor can see.
  panic     off
  running   1
  pending   0
  slots     1/3
```

---

### `/panic`  *(asks first)*

Cancels every running agent, rejects everything queued, and refuses new work.

```
/panic
```

```
Stop every running agent and refuse all new work?
[ Yes ]  __confirm:...:yes
[ No ]   __confirm:...:no
```

On Yes: `Panic engaged. Nothing new will run until /resume-all.`

**Panic survives a restart** until `/resume-all`. That is deliberate: a restart
must not silently resume work that was deliberately stopped.

---

### `/resume-all`

Clears panic mode and re-dispatches anything still queued.

```
/resume-all
```

```
Resumed. Queued work will be admitted again.
```

When not panicking: `Panic mode is already off.`

---

### Confirmations

A destructive command returns a **confirmation** instead of acting:

| Property | Value |
|---|---|
| Answered by | Yes/No buttons, which the channel turns into `/confirm <token> <yes\|no>` |
| Valid for | 60 seconds |
| Used | Once |
| Scoped to | The user who asked — a forwarded message cannot confirm someone else's action |
| On no, or expiry | Nothing changes |

`/panic` and `/reset` ask. Nothing else does.

### Errors

Every failure carries the syntax:

```
"soon" is not a duration. Use 90s, 30m, 2h, 1d.

Syntax: /budget <scope> [+<usd> | unlock <duration> | set <day|month> <usd>]
```

A command that fails **inside** a service reports it too, and never takes the
harness down:

```
/status failed: store exploded
```

### Audit

Every state-changing command writes an `audit_log` row:

| Field | Value |
|---|---|
| `actor` | The user id |
| `action` | `command.<name>` |
| `target` | The argument, truncated to 200 characters |
| `details` | The channel and chat id |

A read-only command writes nothing, and neither does a command that only asked
for confirmation — nothing changed, so nothing is audited.

---

## Backup and restore

What is backed up, what is not, and how to restore.

### What is covered

```
   ${DATA_DIR}/
   ├── ops.sqlite          ← the database: runs, requests, usage, audit, approvals
   │                          backed up ONLINE, via SQLite's own backup API
   ├── sessions/           ← every session transcript
   ├── projects/           ← every project workspace
   ├── state/              ← per-project memory (MEMORY.md) and secrets
   ├── memory/             ← the global USER.md
   ├── config/             ← ops.yaml and projects/*.yaml
   ├── dsh-home/           ← the composed profile and dsh's own state
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
| `data-<stamp>.tar.gz` | Everything else | `tar`, excluding `scratch/` and the database |

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

#### What a backup does NOT cover

| Not covered | Where it lives | What to do |
|---|---|---|
| The image | The registry | Re-pull it; the tag identifies it |
| `.env` | `deploy/compose/.env` | **Back it up yourself.** It holds the bot token. |
| The host | — | A host-level backup |
| A provider's own state | The provider | — |

**`.env` is not in the data directory**, so `backup.sh` does not see it. Losing it means
losing the bot token and the provider keys. Keep a copy in your password manager.

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
| `--to IMAGE` | The image to upgrade to. Default: the tag in `.env`. |
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
ARGUS_AGENT_IMAGE=ghcr.io/rla-labs/argus:0.1.0
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

See [`TROUBLESHOOTING.md`](#troubleshooting).

---

## Security

What this deployment must do, and what it cannot do for you.

### The threat model, in one table

What this deployment defends against, and what it explicitly does not.

| Threat | In scope | Control |
|---|---|---|
| A stranger messaging the bot | **Yes** | The allowlist, checked on every inbound path. Empty by default. |
| An allowed user's mistake | **Partly** | Approvals (`ask` by default), per-project budgets, sandbox modes. |
| A prompt-injected agent | **Partly** | Sandbox per call, approvals, the allowlist is unaffected — but an approved command does what it does. |
| A leaked bot token | **Partly** | Revoke with BotFather. The token grants the bot's identity, not the host. |
| A compromised provider | **No** | Every prompt and file the agent sends reaches the provider. |
| A local attacker with root | **No** | Root reads `/data` and the secrets. Nothing here defends against root. |
| A malicious project workspace | **Partly** | A project cannot read another's files or memory; code it runs is confined by the sandbox mode. |
| Losing the host | **Partly** | Backups. **Copy them off the machine** — a backup on the same disk is not a backup. |

**The honest summary: this system runs code a model asked for.** The controls bound the
damage — a non-root user, a sandbox mode per call, an approval for anything risky, a
budget on everything — and none of them make it safe to hand an untrusted person a bot
token.

### Network exposure

Exactly three outbound destinations, and **no inbound ports**.

```
   Argus Agent container
        │
        ├──▶ api.telegram.org          long polling: OUTBOUND only
        ├──▶ <provider> API            the model
        └──▶ registry                  the image pull, at install/upgrade
```

| Surface | Exposed? | Why |
|---|---|---|
| The health endpoint (3090) | **No** | Bound to `127.0.0.1` inside the container. The Docker healthcheck calls it there; an operator tunnels. |
| The Web UI (3080) | **No** | The same. The tunnel is the authentication. |
| Ollama (11434) | **No** | An internal Docker network. A local model server has **no authentication**, so it is safe only because nothing else can route to it. |
| The bot | Outbound | Long polling, so there is no webhook to expose and no public domain, certificate or reverse proxy to maintain. |

**There is no setting to publish the health endpoint.** It reports the shape of the
system — plugin names, queue depths, budget states — and has no authentication. A
container healthcheck runs inside the container; an operator reaches it through a tunnel:

```sh
ssh -N -L 3090:127.0.0.1:3090 user@host
curl http://127.0.0.1:3090/health
```

#### The host firewall

The deployment needs **no inbound rule at all**. A host that allows only SSH is
sufficient, and is the recommended posture:

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw enable
```

### Container or systemd

The [native install](#install-natively-systemd) runs Argus under systemd, for a VPS
where you prefer not to use Docker. Understand the difference before choosing.

| | Container | systemd |
|---|---|---|
| Filesystem boundary | The image, read-only, plus a tmpfs | `ProtectSystem=strict` + `ReadWritePaths` |
| Process boundary | The container's PID namespace | `TasksMax`, `LimitNPROC` — the host's namespace |
| Privileges | `cap_drop: ALL`, `no-new-privileges` | `CapabilityBoundingSet=`, `NoNewPrivileges` |
| Network | Its own namespace | The host's, filtered only by the host firewall |
| **What the sandbox can fall back on** | **The container** | **Nothing** |
| Upgrading | A new image | Rebuilding in place, with no rollback |

**The decisive row is the fifth.** When no kernel-level sandbox backend is available,
`ctx.sandbox` fails closed — but a deployment's real containment comes from the boundary
around the process. A container provides one that a tool cannot argue with. A systemd
unit provides directives that a tool with the same uid may be able to reach around.

If you must use the unit: keep `ProtectSystem=strict` and `ReadWritePaths=/srv/argus-agent/data`,
do not add `AmbientCapabilities`, and treat `scratch/` as hostile input.

### Secrets

#### The bot token

```
TELEGRAM_BOT_TOKEN=123456789:AAH…
```

- In the environment, never in a file that gets committed.
- Referenced in `ops.yaml` as `${TELEGRAM_BOT_TOKEN}`, so the composition file holds
  the variable name rather than the value.
- **Never logged.** The adapter's config warning names the variable, and a test
  asserts that no part of the value appears in any output.
- Revoke with BotFather's `/revoke` if it leaks.

#### Per-project secrets

```
/data/state/<project-id>/secrets.env      # outside every project's cwd
```

**Outside the workspace, deliberately.** A project's agent has file tools and runs
with its `cwd` as the workspace root; a secret inside that directory is a secret the
agent can read, print, and include in a model request. Putting them under
`/data/state/<id>/` keeps them out of reach of the file tools, and they are injected
only into the processes that need them.

| Rule | Why |
|---|---|
| One file per project | A project cannot read another's secrets even if it escapes its own directory. |
| `0600`, owned by the service user | Nothing else on the host reads them. |
| Never in a project's `cwd` | The agent's file tools reach the whole workspace. |
| Never in `ops.yaml` | The composition file is committed and shared. |
| Never at info level | A secret in a log is a leaked secret. |

### The web UI

The dsh web UI must listen on **`127.0.0.1` only**. Access is through an SSH tunnel:

```sh
ssh -N -L 3080:127.0.0.1:3080 user@host
# then open http://127.0.0.1:3080 locally
```

**Never bind it to `0.0.0.0`.** It has no authentication of its own — the tunnel is
the authentication — and a publicly reachable agent UI is a remote code execution
surface with a chat window.

### Sandbox

`ctx.sandbox` confines a project's processes. Modes are carried **per call**:

| Mode | Means |
|---|---|
| `read-only` | Only the required sinks, such as `/dev/null`. |
| `workspace-write` | The workspace, plus a backend-defined temp area. |
| `danger-full-access` | No confinement. |

**`workspace-write` for every project, with the project's `cwd` as the root.** That
is what the plan requires: an agent works inside its own folder and cannot read
another project's files or the host's.

#### Without a backend, dsh fails closed

A sandbox provider with no backend **refuses to run** the process
(`SANDBOX_UNAVAILABLE`) rather than running it unconfined. So a missing backend
breaks work loudly instead of silently removing confinement — the right failure.

Set it up if you can:

| Platform | Backend |
|---|---|
| Linux | Landlock, which needs a kernel with it enabled |
| Inside Docker | A backend may be unavailable; see below |

#### Inside Docker

**The container is the primary barrier.** Two consequences:

1. **A sandbox backend may be unavailable inside a container** — a Landlock-capable
   kernel is not guaranteed, and a container's own seccomp profile can block the
   syscall the backend needs. When that happens, dsh refuses to run confined
   processes rather than running them unconfined.
2. **The container's isolation is what remains.** So it must be real:

```yaml
services:
  ops:
    read_only: true
    tmpfs: ['/tmp:size=1G']
    volumes:
      - /srv/argus-agent/data:/data          # the data tree, rw
      - /srv/argus-agent/state:/data/state   # secrets, rw, NOT under a project cwd
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    user: '1000:1000'
    ports:
      - '127.0.0.1:3080:3080'            # loopback, for the SSH tunnel
```

**Mount the data tree, not the host's home.** A container that mounts `/home` or
`/` has given every project the host's files, and no per-process confinement is
going to take them back.

**The honest summary:** with a backend, a project's processes are confined to its
`cwd`. Without one, the container is the boundary and dsh will not run the process
at all. Neither is a substitute for the other, and the approval allowlist is a convenience,
not a sandbox.

### The host

| Practice | Why |
|---|---|
| Run as a non-root user | A compromised agent is not root. The image uses **uid/gid 10001**, fixed. |
| `data_dir` outside the repo | The repository is code; the data tree is state. |
| One replica | Enforced: the store holds an instance lock on the data directory, and a second process refuses to start (`INSTANCE_LOCKED`). Give each replica its own data directory. |
| Back up `<data_dir>`, **off the machine** | It holds the projects, the sessions and the audit log. |
| Keep the pinned dsh version | The bundle's patches are written against `0.2.0-rc.2`. |
| Pin the image tag | `latest` turns a restart into a version change. |
| Cap the container log | An agent logs a lot; an uncapped log is what fills the disk. |
| Keep `.env` at mode 600 | It holds the bot token and the provider keys — and it is **not** in the backup. |

#### The fixed uid

The image creates the `ops` user with **uid 10001** rather than letting the runtime
allocate one. That is deliberate: a fixed id is what lets an operator bind-mount a host
directory and `chown` it once. A runtime-allocated id would change the ownership
requirement on every rebuild, and the symptom would be an intermittent
`SQLITE_CANTOPEN` after an upgrade.

```sh
sudo chown -R 10001:10001 /srv/argus-agent/data
```

#### What the container hardening buys

| Directive | Effect |
|---|---|
| `read_only: true` | The image filesystem cannot be written; only `/data` and the tmpfs can. |
| `cap_drop: ALL` | No capabilities at all. The service binds no privileged port. |
| `no-new-privileges:true` | A setuid binary inside cannot escalate. |
| `pids_limit: 512` | A fork bomb hits the limit rather than the host. |
| `tmpfs: /tmp` | A writable scratch space that is discarded, not a hole in the image. It is mounted `exec` because dsh loads its native addons from `$TMPDIR`; the image itself stays read-only. |
| `stop_grace_period: 30s` | A run is cancelled rather than killed mid-write. |
| `max-size` / `max-file` | The log cannot fill the disk. |

### What this deployment cannot do

- **Make an allowed user trustworthy.** The allowlist is per user and per channel.
- **Stop an approved command from doing what it does.** Confinement bounds the
  effect; the allowlist bounds what is asked about.
- **Protect a secret the agent can read.** Keep secrets out of the workspace; that
  is the whole control.
- **Authenticate the web UI.** The tunnel is the authentication.

---

## Troubleshooting

Symptom → check → fix, built from every plugin's own `OPERATIONS.md`. When a row
points at a plugin's document, that document has the full procedure.

**Start with the five checks at the bottom of this page.** They answer most reports.

The first three sections answer most reports. The rest are ordered by which component
is at fault.

### Start here

#### Nothing happens at all

| Check | Fix |
|---|---|
| `docker compose ps` | Not running: `docker compose logs --tail=100 ops` |
| `grep 'startup failed'` | A required plugin did not activate. The log names it and the package. |
| The `Argus Agent <version> started` line | Absent means the process never got to a running state |
| `curl http://127.0.0.1:3090/health` **inside** the container | 503 means `down`; the report names the problem |

#### The bot is silent

| Check | Fix |
|---|---|
| `grep 'telegram connected'` | Absent: the adapter never reached Telegram. The next log line says why. |
| `grep 'bot_token'` | A warning naming `TELEGRAM_BOT_TOKEN` means the variable is unset or unexpanded |
| Is your user id in `access.allowed_users` for `channel: telegram`? | The most common cause of a bot that works but ignores you |
| `grep 'channel.refused'` | The audit row names the id it saw — put **that** in the allowlist |
| `/health` → `opsChannel` | `degraded` with "a channel adapter failed to start: …" names the Telegram error; a 401 is a wrong token |

#### A message got no reply

| Check | Fix |
|---|---|
| Is a project active? | `/p <id>`, or free text goes to the orchestrator |
| `grep 'the orchestrator failed'` | The turn threw; the message has it |
| `/status <project>` | The run may still be queued |
| `grep 'the run produced no output'` | A provider error, or the project produced nothing |

### By symptom

#### "My schedule didn't run"

| Check | Fix |
|---|---|
| `/cron list` — does it exist, is it `on`? | `/cron enable <id>` |
| `/cron list` — is the next run in the past? | The timer should have fired it; check the log |
| `grep 'skipped' \| grep <id>` | `overlap` = the previous run is still going; `paused` = the project is paused |
| `grep 'missed a window'` | A restart skipped or fired it once, per the misfire policy |
| Is the timezone what you think? | The next run is rendered in UTC; the schedule's own timezone is per row |

**An overlap is not notified.** It is logged and counted, because a periodic overlap
would flood the chat.

#### "The project forgot something"

| Check | Fix |
|---|---|
| `cat ${data_dir}/state/<id>/MEMORY.md` | The fact is there, or the agent never wrote it down |
| `grep 'memory.updated'` | No row means the agent never called `memory_update` |
| `grep 'was truncated: omitted'` | **The agent did not receive that section.** Condense the memory. |
| `grep 'injection failed'` | The agent started without its memory |

**Memory is only what the agent explicitly wrote.** A fact that was discussed but
never recorded is gone after a reset.

#### A risky action was refused

| Check | Fix |
|---|---|
| `grep 'refused without asking'` | The project's `mode: deny`, or not allow-listed |
| `SELECT * FROM approvals ORDER BY created_at DESC LIMIT 5` | The `status` says what happened |
| `decided_at` vs `created_at` | A press **after** the timeout changes nothing |
| Is the answering user allow-listed? | The channel checks the allowlist on the answer path too |

#### "It cannot find the right project"

| Check | Fix |
|---|---|
| The orchestrator's `list_projects` output | Is the project there with a **description**? |
| Is the description just the id? | A model cannot infer purpose from a name |
| Was a project already active? | Free text with an active project never reaches the orchestrator |

#### Costs are climbing

| Check | Fix |
|---|---|
| `/usage` | Which project, and which model |
| `grep 'budget-threshold'` | The soft threshold fired; check `soft_action` |
| The `orchestrator` scope | It runs on **every** free-text message; lower `orchestrator.day_usd` |
| `grep 'ops/model-downgraded'` | A project at its soft threshold switched to its fallback |

#### A run will not stop

| Check | Fix |
|---|---|
| `/stop <project>` | Cancels the current turn |
| `/status` | Is it running, or queued? |
| `/panic` | Cancels everything and refuses new work — needs confirmation |
| `/resume-all` | Undoes the panic |

#### Work was lost after a restart

| Check | Fix |
|---|---|
| The startup report message | It names every interrupted run |
| The Retry buttons | Each resubmits the **original** request |
| `SELECT * FROM runs WHERE status = 'interrupted'` | The full set |
| `grep 'were left running by a previous process'` | Recovery found the crash |

#### The container keeps restarting

| Check | Fix |
|---|---|
| `curl http://127.0.0.1:3090/health` inside the container | 503 means `down` |
| The report's `problems` | The named subsystem is the cause |
| `grep 'health endpoint did not start'` | A port already in use: the healthcheck reaches a **different** process |
| Is the healthcheck accepting 200? | **`degraded` returns 200 by design.** A check that requires 200-only is fine; one that fails on any non-200 is misconfigured. |

#### Disk is filling

| Check | Fix |
|---|---|
| The daily report's disk line | Percentage and free space |
| `du -sh ${data_dir}/*` | Which part |
| `ls ${data_dir}/backups` | Lower `health.backup_keep` |
| `${data_dir}/state/*/recall.sqlite` | Derived state: **delete it and it rebuilds** |

### Five checks that answer most reports

```sh
# 1. Is the process healthy, and what is wrong?
curl -s http://127.0.0.1:3090/health | head -40

# 2. What did it refuse, and who?
sqlite3 ${DATA_DIR}/ops.sqlite "SELECT ts, actor, action, target FROM audit_log ORDER BY ts DESC LIMIT 20"

# 3. What is queued or running?
sqlite3 ${DATA_DIR}/ops.sqlite "SELECT id, status, project_id FROM inbound ORDER BY created_at DESC LIMIT 10"

# 4. What did it cost?
sqlite3 ${DATA_DIR}/ops.sqlite "SELECT scope, period, cost_micros FROM usage_daily ORDER BY day DESC LIMIT 20"

# 5. What is the log saying?
docker compose logs --tail=200 ops | grep -E 'warn|error|refus'
```

### What is NOT a fault

Worth knowing, because these generate reports:

| Looks wrong | Actually |
|---|---|
| A message arrived twice | The platform redelivered; the channel deduplicated it. One was ignored. |
| A schedule was skipped | An overlap (the previous run was still going) or a paused project |
| A long answer arrived as a `.md` file | It exceeded the adapter's limit; the full text is in the file |
| A project asked for approval and got none | Nobody answered in the timeout — **no answer means no**, by design |
| The orchestrator forgot yesterday | `reset_daily: true`: a bounded context, deliberately |
| A `degraded` health status | Something worth a look, not a failure |
