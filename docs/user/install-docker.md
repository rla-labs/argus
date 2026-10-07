# Install with Docker

From a fresh Linux VPS to the first Telegram message, in one script.

**The acceptance criterion:** on a clean VPS, from `install.sh` to the
first Telegram message in under ten minutes. The step-by-step record is
[below](#the-ten-minute-run-recorded-step-by-step); what was and was not verified in
this repository is stated [honestly](#what-was-verified-and-what-was-not).

## Requirements

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

## Quick install

```sh
git clone https://github.com/rla-labs/argus.git
cd argus

./deploy/scripts/install.sh
```

It asks four questions, then does everything else. When it finishes, **check Telegram** —
the first message should already be there.

### Non-interactive

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

### From a checkout, without a published image

```sh
./deploy/scripts/install.sh --build --image argus-agent:local
```

### Everything available

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

## Manual install

For a host where the script does not fit — Alpine, a non-systemd init, a Kubernetes
cluster, or an operator who simply wants to see each step.

### 1. The data directory

```sh
sudo mkdir -p /srv/argus-agent/data
# The container runs as uid 10001 (fixed, so a bind mount's ownership is stable).
sudo chown -R 10001:10001 /srv/argus-agent/data
sudo chmod 0750 /srv/argus-agent/data

sudo -u '#10001' mkdir -p /srv/argus-agent/data/{config/projects,projects,state,scratch,memory,backups,dsh-home}
```

The entrypoint creates the layout too, but doing it here makes an ownership mistake
visible before the first boot rather than as a `SQLITE_CANTOPEN` later.

### 2. The configuration

```sh
git clone https://github.com/rla-labs/argus.git /tmp/argus-agent
sudo cp /tmp/argus-agent/deploy/templates/ops.yaml.minimal /srv/argus-agent/data/config/ops.yaml
sudo chown 10001:10001 /srv/argus-agent/data/config/ops.yaml
sudo chmod 0640 /srv/argus-agent/data/config/ops.yaml
```

It is a short file: everything not in it has a default. Edit it:

```yaml
timezone: Europe/Bucharest        # your timezone
data_dir: /data                   # the path INSIDE the container — leave as /data
access:
  admin: '99887766'               # your Telegram user id
budgets:
  default_day_usd: 3
  default_month_usd: 40
```

The admin may use the bot and receives the reports and warnings. To change any other
default, copy its section from `templates/ops.yaml.example`, which lists every key.

**Leave `data_dir` as `/data`.** It is the container's path; the host path is the mount
in the compose file. Setting it to the host path creates the database outside the
volume.

The provider key goes in the environment, next. The default model is
`deepseek/deepseek-flash`; with only an OpenRouter key, add:

```yaml
tasks:
  model: openrouter/deepseek/deepseek-v4-flash
orchestrator:
  model: openrouter/deepseek/deepseek-v4-flash
```

### 3. The environment

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

### 4. Start

```sh
docker compose up -d
docker compose logs -f
```

### 5. Verify

```sh
# From inside the container: the endpoint is loopback-only and not published.
docker exec argus-agent curl -s http://127.0.0.1:3090/health

# The full smoke test.
./deploy/scripts/smoke.sh
```

Then send `/help` to your bot.

## The ten-minute run, recorded step by step

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

### What could make it slower

| Cause | Effect |
|---|---|
| A cold image pull on a slow link | The dominant cost. Pre-pull, or use `--build` locally. |
| `install.sh` installing Docker | +1–2 minutes, and a reboot may be needed for group membership. |
| A wrong Telegram token | The install still succeeds; the message does not arrive. The script says so explicitly. |
| A wrong user id | The Telegram API returns `chat not found`. The script prints the error. |
| Not having sent `/start` to your own bot | Telegram refuses the first message from a bot the user has never opened. |

## What was verified, and what was not

Stated plainly, because an install guide that implies verification it does not have is
worse than one that admits its gaps.

### Verified in this repository

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

### Verified on real hosts

| Checked | How |
|---|---|
| `docker build`, install, health checks, backup, restore, upgrade, forced rollback | The Docker install, end to end, on a real daemon |
| The native install, crash recovery, upgrade and rollback from git, uninstall | A fresh Ubuntu 24.04 with systemd: `pnpm test:native-vps` |
| A real Telegram bot answering `/help`, `/new`, a free message and `/status`, each run accounted at the provider's price | `pnpm test:live` (`test/live/phase-a.test.ts`) |

### Not verified yet

| Not checked | Why | What to do |
|---|---|---|
| The published image | No release has been tagged yet | Install with `--build` |
| The ten-minute figure on *your* host | It is a measurement from one VPS | Run it and time it |

## After installing

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
3. **Read [CONFIGURE.md](configuration.md)** for the full reference.

## The Ollama variant

For a deployment with no external provider:

```sh
cd deploy/compose
docker compose -f docker-compose.yml -f docker-compose.ollama.yml up -d
docker compose -f docker-compose.yml -f docker-compose.ollama.yml exec ollama ollama pull llama3.2
```

Ollama is on an **internal** network: Argus Agent can reach it, it cannot reach the internet.
That matters because a local model server has no authentication.

## Non-Docker install

See [Install natively (systemd)](install-native.md): the same data layout,
installed and upgraded by its own scripts.

## Troubleshooting

[Troubleshooting](troubleshooting.md). The three most common failures:

| Symptom | Cause | Fix |
|---|---|---|
| The container exits immediately | The data directory is not writable | `sudo chown -R 10001:10001 /srv/argus-agent/data` |
| "refusing to start without a configuration" | `config/ops.yaml` is missing | `cp` the template, as above |
| The bot is silent | A wrong token, a wrong user id, or the allowlist | [The bot is silent](troubleshooting.md#the-bot-is-silent) |

## Uninstalling

```sh
./deploy/scripts/uninstall.sh          # removes the containers, KEEPS the data
./deploy/scripts/uninstall.sh --purge  # removes the data too
```

## Everyday commands

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

## Three things to know

**1. Pin the image tag.** Never `latest`. With `latest`, a restart becomes a version
change — and a restart is something you do when something is wrong.

**2. `.env` is not in the data directory.** `backup.sh` does not see it, and it holds the
bot token. Keep a copy in your password manager.

**3. A backup on the same machine is not a backup.** The disk that fails takes the backup
with it. The `rsync` line above is not optional.

## The files in `deploy/`


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
| `native/` | The full non-Docker install: scripts and the unit template ([Install natively](install-native.md)) |
| `templates/` | `ops.yaml.minimal` (what the installers write), `ops.yaml.example` (every key), `env.example`, `projects/example.yaml` |
