# Argus Agent — user documentation

Installing Argus, running it day to day from Telegram or a browser, and keeping it
healthy.
**Docker is the recommended install.** The native install (systemd on a VPS) is a fully
supported alternative.

## Where to start

| If you want to | Read |
|---|---|
| Go from an empty server to a working project in ten minutes | [Getting started](getting-started.md) |
| See it set up for real work: a website, a daily report, a file | [Three scenarios](scenarios.md) |
| Install it, with Docker | [Install with Docker](install-docker.md) |
| Install it on a VPS without Docker | [Install natively (systemd)](install-native.md) |
| Learn how to use it well, day to day | [Working with Argus every day](daily-use.md) |
| Use the dashboard, approvals and settings in a browser | [The web interface](web.md) |
| Look up one command | [Chat commands](commands.md) |
| Change a setting | [Configuration](configuration.md) |
| Add tools and skills from a git repository | [Extensions](extensions.md) |
| Back up, restore, or upgrade | [Backup, restore and upgrades](backup-and-upgrade.md) |
| Know what it protects you from, and what it does not | [Security](security.md) |
| Fix something | [Troubleshooting](troubleshooting.md) |
| See what each release brought, and what has been verified | [What's new](whats-new.md) |

## Before you install

| You need | Where to get it |
|---|---|
| A Telegram bot token | Message [`@BotFather`](https://t.me/BotFather), send `/newbot` |
| Your numeric Telegram user id | Message [`@userinfobot`](https://t.me/userinfobot) |
| A provider API key | Your model provider (DeepSeek, OpenRouter, Anthropic, ...). Later keys go in from the chat with `/key` |
| A Linux host | Docker with the Compose plugin, or Node 22 and systemd for the native install |

A `@username` will **not** work as the user id: usernames can be changed or released, so
they are not identities.

```sh
git clone https://github.com/rla-labs/argus.git && cd argus
./deploy/scripts/install.sh                  # Docker: pulls the published image (--build: from this checkout)
sudo ./deploy/native/install-native.sh       # or: native
```

The installer asks four questions, writes a short `ops.yaml`, starts the service and sends
you a first Telegram message. Then open the chat with the bot and send `/start`. From then
on, [`argus`](#running-it-from-the-shell-argus) runs everything on the host.

## Running it from the shell: `argus`

The installers link one command, `argus`, into `/usr/local/bin`. It works the same for
both installs: it runs the native scripts when the systemd unit `argus-agent.service` is
installed, and the Docker ones otherwise.

| Command | What it does |
|---|---|
| `argus status` | Is the service running, and what does its health check say. Exits 1 when it is not healthy. |
| `argus doctor` | The smoke test, then whether it can actually work: every provider key (one free request each, no tokens spent), the `/task` and orchestrator models, the project files, the chat channel and the admin. Every failure comes with its fix. |
| `argus logs [-f]` | The last 100 lines of the log; `-f` follows it. |
| `argus setup-link [--admin]` | The one-time link that creates the admin on the web, while there is none. `--admin`: a sign-in link for the admin who lost the password (restarts the service). [More](web.md#without-telegram-the-setup-link) |
| `argus backup` | Back up the database and the data directory. [More](backup-and-upgrade.md#running-it) |
| `argus restore` | Restore from a backup (Docker). On the native install it points to [the manual steps](install-native.md#restoring). |
| `argus upgrade` | Back up, upgrade, and roll back if the new version does not start. [More](backup-and-upgrade.md#upgrading) |
| `argus init` | Install, or reinstall over an existing deployment. `argus --native init` picks the native install. |

Options after the command go to the script that does the work: `argus backup --keep 30`,
`argus upgrade --to ghcr.io/rla-labs/argus:0.2.0`, `argus restore --list`.
`argus <command> --help` lists them. The native commands need root: `sudo argus ...`.

## Where everything lives

```
   /srv/argus-agent/data/          ← THE ONLY PERSISTENT PATH
   ├── ops.sqlite              runs, requests, usage, audit, approvals
   ├── config/ops.yaml         the whole configuration
   ├── config/projects/*.yaml  one file per project
   ├── config/templates/       your own project templates (optional)
   ├── projects/               each project's working directory
   ├── state/                  per-project memory and instructions
   ├── dsh-home/               the composed profile, session logs, and keys saved with /key
   └── backups/                rotating database backups
```

Back up that directory, off the machine, and the deployment can be rebuilt from nothing.
It includes the keys saved with `/key`, so keep the backup as safe as the keys. The
secrets set at install (`.env` for Docker, `secrets.env` for native) live outside it.
Keep a copy of them in your password manager.
