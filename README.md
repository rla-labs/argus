# Argus Agent

![Argus Agent](img/argus-agent.jpeg)

**An operating system for AI agents: one you can leave running and trust.**

*Formerly **dsh-ops**. The plugins keep their `ops-*` names.*

---

## Why this exists

AI agents can already do real work: maintain a website, watch a build, write the
morning report, answer the question you would otherwise have looked up yourself.
Running them for days, though, is a different problem. Today an agent:

- **is fragile.** One bad configuration file, one crashed process, one network
  hiccup at boot, and everything stops — often silently.
- **is expensive in ways you can't see.** A loop at 3 a.m. spends money until
  someone notices.
- **is hard to keep in check.** A shell command you never approved, a task that
  has quietly been running for hours.
- **lives in a terminal.** To check on it you have to SSH in.

Argus is named after the hundred-eyed watchman of Greek myth, whose eyes never all
closed at once. We are building it to take those worries off you. The goal is an **Agent
OS**: a small, self-hosted layer that does for agents what an operating system
does for programs. It schedules them, isolates them, meters what they use,
enforces limits, recovers them when they crash, and gives you one calm place to
talk to all of them.

It should run on a modest VPS. It should keep running when something goes wrong.
And it should tell you, in plain words, what happened and what it needs from you.

## What it does today

- **Projects.** Long-running agents, each in its own folder, with its own model,
  memory and budget. Each one is a separate top-level agent, never a subagent of
  another.
- **One-off tasks.** Ephemeral agents for a single job, accounted separately.
- **Scheduled work.** Cron schedules that fire exactly once, including across
  restarts, with the result delivered to your chat.
- **Control from Telegram.** Commands like `/status`, `/stop`, `/budget` and
  `/panic` are deterministic code, so they work without a model in the loop. Any
  other message goes to the active project, verbatim, or to a cheap "front desk"
  agent that routes it.
- **Administration from the chat.** Read a project's runs, memory and files
  (`/runs`, `/memory`, `/files`, `/get`), change its settings (`/set`), archive it,
  and let someone else in (`/allow`), without opening SSH.
- **Hard cost control.** Every execution passes through one governor, which
  enforces concurrency and budgets before anything starts and again at every step.
  Prices for DeepSeek, Anthropic and OpenAI models (direct or through OpenRouter)
  ship with Argus and refresh themselves: weekly from a public pricing dataset,
  daily from OpenRouter. You are told when a model you use changes price, and a
  free remote model runs only after you allow it.
  Budgets have warning thresholds, can downgrade the model, and pause a project at
  the limit. `/panic` stops everything in under five seconds.
- **Approvals.** A risky action becomes a question in Telegram: *Approve*,
  *Deny*, or *Approve this kind for the rest of the run*. No answer means no.
- **Memory.** Each project has durable memory that survives resets and
  compactions. It is stored outside the project's own workspace, where its tools
  can't touch it.
- **Recovery.** Nothing is lost in a crash. Runs that were interrupted are
  reported, and you can retry them with one button.
- **One instance per data directory.** A second process on the same data refuses
  to start, so schedules can never fire twice. The lock is released by the
  operating system even after a hard crash, so there is nothing to clean up.
- **Fault tolerance.** A broken project file sidelines that one project. The rest
  of the system keeps running, you are told exactly what is wrong, and `/reload`
  brings the project back once the file is fixed.

## How it is built

Argus is a set of Cordis plugins on top of a pinned version of
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). It does
not patch dsh. Like an OS kernel, it rests on a few rules that are never bent:

| Rule | Why it matters |
|---|---|
| **One executor.** Only `ops-governor` starts work. | No path around the budget, the concurrency limits or `/panic`. |
| **One writer.** Only `ops-store` touches the database. | Admissions, usage and recovery are transactional; a crash leaves nothing half-written. |
| **Deterministic control.** Commands, schedules, budgets and cancellation are code. | The controls still work when a model is wrong, slow or offline. |
| **Your words, verbatim.** No component rewrites what you send a project. | An agent cannot be steered by a paraphrase it never asked for. |
| **Fail closed.** An unpriced model, an unanswered approval or an unknown user is a *no*. | Mistakes cost a retry, not money or a deleted file. |
| **Separation.** A project is a top-level agent with its own folder, session, model, memory and budget. | Projects never share a conversation, a memory or a budget, and memory lives outside every workspace. Filesystem confinement comes from the dsh sandbox, or from the container in a Docker install. |

Each rule is enforced by tests, not only stated here.

## Status: an honest picture

**Developer preview.** The foundation is done and heavily tested, but Argus has
not yet been run in production by anyone. dsh itself is still a release candidate
(`0.2.0-rc.2`).

What has been verified:

- **1,800+ automated tests.** They cover a `SIGKILL` crash in the middle of a
  run, a day-long outage of the scheduler, and every approval bypass we could
  think of.
- **The Docker install, end to end, on a real daemon:** install, health checks,
  backup, restore, upgrade, forced rollback, and upgrading a deployment that still
  uses the old dsh-ops names.
- **The native install, end to end, on a fresh Ubuntu 24.04 with systemd:**
  install, crash recovery, upgrade and rollback from git, uninstall.
  `pnpm test:native-vps` repeats it on demand.
- **A live run with a real Telegram bot and real billed models.** `/help`, `/new`,
  a free message answered in the chat, and `/status`, with DeepSeek V4 Flash and
  GLM-5.3 Flash through OpenRouter, each run accounted at the provider's price.
  `pnpm test:live` repeats it.
- **Cost accounting against a provider's own bill.** Every request to DeepInfra
  matched DeepInfra's reported token counts (cached tokens included) and its
  billed cost to within 1 µUSD.

What is not verified yet:

- **Agents running shell tools under the native systemd hardening.**
- **The published Docker image.** No release has been tagged yet, so
  `ghcr.io/rla-labs/argus` does not exist; install with `--build` until it does.
  The first release is planned for the end of the next phase.
- **Long-running use.** No deployment has run for weeks against real budgets.

## Where it is going

An Agent OS is more than a reliable core. Next on the road:

1. **First-run experience.** One command (`argus init`) that asks five questions
   and leaves you with a working bot, plus `argus doctor` for when something
   doesn't.
2. **A web dashboard.** Costs, the queue, live runs, approvals and schedules on
   one page.
3. **Integrations through MCP**, so agents can reach GitHub, mail, calendars and
   databases, with the same approvals and budgets.
4. **More channels and more people.** Slack, Discord or a web chat, plus roles,
   so a team can share one Argus.
5. **Project templates.** Start "a website maintainer" or "a daily researcher"
   without writing a prompt.

If any of this is something you need, an issue describing your use case is the
most helpful thing you can send.

## Try it

You need a Linux machine. For Docker you need Docker with the Compose plugin; for the
native install, **Node 22** and **pnpm 8.6.11**:

```sh
corepack enable && corepack prepare pnpm@8.6.11 --activate
```

Either way, you need a Telegram bot token from [@BotFather](https://t.me/BotFather), your
numeric Telegram user id from [@userinfobot](https://t.me/userinfobot), and an API
key for your model provider.

### Docker (recommended)

```sh
git clone https://github.com/rla-labs/argus.git
cd argus
./deploy/scripts/install.sh --build
```

`--build` builds the image from your checkout; a published image is not available
yet. The container runs as a non-root user with a read-only filesystem and no
capabilities. All state lives in one data directory, which is the only thing you
need to back up.

### Native install (a VPS without Docker)

```sh
git clone https://github.com/rla-labs/argus.git
cd argus
sudo ./deploy/native/install-native.sh
```

A fully supported alternative. The installer creates a service account, builds the
code and composes the dsh profile. It then installs a hardened systemd unit, waits for
the health check and sends your first Telegram message.

After either install, open the chat with your bot and send `/start`. On the host, one
command runs the rest, for both installs: `argus status`, `argus doctor`, `argus logs -f`,
`argus backup`, `argus restore`, `argus upgrade`. The user
documentation starts at [`docs/user/`](docs/user/README.md):

- [Working with Argus every day](docs/user/daily-use.md): the commands, by situation,
  and how to work well with them
- [Telegram commands](docs/user/commands.md), [Configuration](docs/user/configuration.md),
  [Backup, restore and upgrades](docs/user/backup-and-upgrade.md),
  [Security](docs/user/security.md), [Troubleshooting](docs/user/troubleshooting.md)

## Development

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test

pnpm test:spikes        # the verified facts about dsh, as runnable tests
pnpm test:native-vps    # the native install on a throwaway Ubuntu + systemd container
                        # (needs Docker; runs a privileged container)
```

```
packages/          one Cordis plugin per folder (ops-*), plus the argus-agent bundle
profiles/ops/      the dsh profile that stacks the bundles
deploy/            Docker, compose, native systemd install, backup/upgrade scripts,
                   and the config templates (ops.yaml.minimal, ops.yaml.example, a project)
test/              spikes, end-to-end crash recovery, deploy tests
```

A change is done when the four commands above pass. The architecture rules in
[How it is built](#how-it-is-built) are checked by tests, so a change that breaks
one fails loudly.

## Acknowledgements

Argus stands on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
and Cordis. Their extension points made it possible to build an agent OS as a set
of plugins, without forking either.

Model prices come from the [AI API Pricing dataset](https://aicostbudget.com/en/datasets/ai-api-pricing)
by aicostbudget.com, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Argus keeps the token-priced models and, for each, the highest standard price that
can apply (see `packages/ops-meter/src/catalog-snapshot.ts`). Provider invoices remain
the final word on what you pay.
