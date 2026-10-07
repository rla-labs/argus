# Argus Agent — user documentation

Installing Argus, running it day to day from Telegram, and keeping it healthy.
**Docker is the recommended install.** The native install (systemd on a VPS) is a fully
supported alternative.

## Where to start

| If you want to | Read |
|---|---|
| Install it, with Docker | [Install with Docker](install-docker.md) |
| Install it on a VPS without Docker | [Install natively (systemd)](install-native.md) |
| Learn how to use it well, day to day | [Working with Argus every day](daily-use.md) |
| Look up one command | [Telegram commands](commands.md) |
| Change a setting | [Configuration](configuration.md) |
| Back up, restore, or upgrade | [Backup, restore and upgrades](backup-and-upgrade.md) |
| Know what it protects you from, and what it does not | [Security](security.md) |
| Fix something | [Troubleshooting](troubleshooting.md) |

## Before you install

| You need | Where to get it |
|---|---|
| A Telegram bot token | Message [`@BotFather`](https://t.me/BotFather), send `/newbot` |
| Your numeric Telegram user id | Message [`@userinfobot`](https://t.me/userinfobot) |
| A provider API key | Your model provider (DeepSeek, OpenRouter, Anthropic, ...) |
| A Linux host | Docker with the Compose plugin, or Node 22 and systemd for the native install |

A `@username` will **not** work as the user id: usernames can be changed or released, so
they are not identities.

```sh
git clone https://github.com/rla-labs/argus.git && cd argus
./deploy/scripts/install.sh --build          # Docker
sudo ./deploy/native/install-native.sh       # or: native
```

The installer asks four questions, writes a short `ops.yaml`, starts the service and sends
you a first Telegram message. Then open the chat with the bot and send `/start`.

## Where everything lives

```
   /srv/argus-agent/data/          ← THE ONLY PERSISTENT PATH
   ├── ops.sqlite              runs, requests, usage, audit, approvals
   ├── config/ops.yaml         the whole configuration
   ├── config/projects/*.yaml  one file per project
   ├── projects/               each project's working directory
   ├── state/                  per-project memory
   ├── dsh-home/               the composed profile and session logs
   └── backups/                rotating database backups
```

Back up that directory, off the machine, and the deployment can be rebuilt from nothing.
The secrets (`.env` for Docker, `secrets.env` for native) live outside it. Keep a copy of
them in your password manager.
