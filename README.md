# Argus Agent

![Argus Agent](img/argus-agent.jpeg)

**An operating system for AI agents: one you can leave running and trust.**

**Current release: [0.5.0](https://github.com/rla-labs/argus/releases/tag/v0.5.0)**
(image `ghcr.io/rla-labs/argus:0.5.0`). Self-hosted, controlled from its own web
interface, from Telegram, or both.

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

### Agents that do the work

- **Projects.** Long-running agents, each in its own folder, with its own model,
  instructions, memory and budget. Each one is a separate top-level agent, never a
  subagent of another.
- **Templates and instructions.** Start a project as a `site`, `research`, `reports`
  or `devops` project (or from a template of your own) and tell it how to work with
  `/instructions`. The instructions are in its prompt on every request, and only you
  can change them.
- **Memory.** Each project keeps durable notes that survive resets and compactions,
  stored outside its own folder, where its tools can't touch them.
- **One-off tasks** for a single job, accounted separately, and **scheduled work**:
  cron schedules that fire exactly once, even across restarts, with the result
  delivered to your chat.
- **Integrations through MCP.** A project can use the tools of MCP servers (GitHub, a
  database, a calendar). Each server is visible to that one project, its secrets stay
  out of the project's files, and its calls go through the same approvals.
- **Extensions and skills.** Tools (MCP servers) and skills the admin installs once from
  a git repository, pinned and checked at every start, and enables per project; their
  servers run confined to the project's folder. A project's own skills are added with
  `/skill`, outside its folder, so its agent cannot write itself one.
- **Projects that work together.** With delegation allowed, one project can ask
  another a question; the work is paid from the other project's budget and runs under
  its rules.

### You stay in control

- **Chat commands, on any channel.** Commands like `/status`, `/stop`, `/budget` and
  `/panic`, typed in the web chat or to the Telegram bot, are deterministic code, so
  they work without a model in the loop. Any other message
  goes to the active project, verbatim, or to a cheap "front desk" agent that routes it.
- **A web interface.** An overview of the projects, spending, live runs and schedules,
  the pending approvals, the settings, users and the same chat, in English or Romanian.
  Its own sign-in (a password, optionally an authenticator code), its own setup with no
  Telegram at all. Built for a private network (Tailscale, a VPN, an SSH tunnel); a
  [public mode](docs/user/web.md#public-mode) puts it behind Caddy with HTTPS and a
  required second factor.
- **Administration without SSH.** A project's runs, what each one did, its memory and
  files (`/runs`, `/log`, `/memory`, `/files`, `/get`); its settings (`/set`); API keys,
  checked with the provider before they are saved (`/key`); the default models
  (`/defaults`); who may use the bot (`/allow`). On the host, `argus doctor` checks keys,
  models and projects, and says how to fix what fails.
- **Two roles.** The admin decides what spends money, what agents may do and what is
  deleted; operators run, stop and approve work.

### Safety and cost

- **Per-project permissions.** Each project says what its agent may use (reading,
  writing, the shell, the web, delegation), each `off`, `deny`, `ask` or `allow`, with
  exceptions for single tools and a list of sites it may fetch.
- **Approvals.** A risky action becomes a question in Telegram or on the web:
  *Approve*, *Deny*, *Approve this kind for the rest of the run*, or *Always allow* this
  exact command. No answer means no. Commands that only read never ask, and a scheduled
  run never waits: it is refused what it would ask for, and you get the rule as a button.
- **Confined commands.** Every command an agent runs is confined by the kernel
  (Landlock): it reads and writes its own project's folder and nothing else of Argus's,
  not the database, not the other projects, not the conversations, not the keys.
- **Undo.** Before each run Argus records the project's folder; `/undo` puts it back as
  it was, and an undo can itself be undone.
- **Hard cost control.** Every execution passes through one governor, which enforces
  concurrency and budgets before anything starts and again at every step. Prices for
  DeepSeek, Anthropic and OpenAI models (direct or through OpenRouter) ship with Argus
  and refresh themselves; you are told when a model you use changes price, and a free
  remote model runs only after you allow it. Budgets warn, can downgrade the model, and
  pause a project at the limit. `/estimate` shows what a project's runs usually cost
  before you send a big one, and `/panic` stops everything in under five seconds.

### Reliability

- **Recovery.** Nothing is lost in a crash. Interrupted runs are reported, and you can
  retry them with one button.
- **One instance per data directory.** A second process on the same data refuses to
  start, so schedules can never fire twice. The lock is released by the operating
  system even after a hard crash.
- **Fault tolerance.** A broken project file sidelines that one project. The rest keeps
  running, you are told exactly what is wrong, and `/reload` brings it back once fixed.

## Coming in 0.6.0

Long work that cannot run away. Already on `main`, not yet released:

- **A project's own limits apply.** Its `limits:` (or its template's) were read and
  ignored before; `/tools` shows the ones in force.
- **Loops are judged by what changes.** The same call with the same result, or a cycle
  of 2–3 calls going nowhere, stops the run; the same call with a new result (tests run
  again after a fix) is progress.
- **A run that brings nothing new stops**: 25 steps with no new result and no file
  changed (`limits.stall_steps`).
- **A checkpoint instead of a kill.** Every 60 steps (or 45 minutes) the run asks, with
  what it did and **Continue / Stop** buttons; a scheduled run stops and says how to go
  on. A ceiling per project (`limits.max_steps_total`, 1000 by default, set by the
  templates) is never passed: a coding project may run for hundreds of steps, a short
  fixed job can be held to a dozen.
- **An optional judge at the checkpoint.** A model of your choice reads what Argus
  measured about the run, not what the agent says, and gives it more steps or stops it,
  within bounds set in code; then you decide. A scheduled run can go on this way too.

Still to come in 0.6.0: the `office` extension.

## New in 0.5.0

Autonomy with guard rails: fewer approvals, because more actions are safe by
construction. **`/undo`** takes any of a project's last runs back. **Precise rules**: the
commands that only read no longer ask, `docker logs *` allows one command's arguments,
`*.example.com` its subdomains only. **Layered templates**: a project made from a
template follows its improvements, and keeps what you changed. **Skills** per project,
kept where its agent cannot write. **Extensions**: tools and skills installed once from
git (`/ext install`), pinned and hashed, their install and their servers confined, enabled
per project. **Scheduled runs never wait**: what they would ask about is refused at once,
with the rule that would allow it as a button (`/rule`). The `site` template runs its
commands unasked, confined to its folder. Upgrading from 0.4 needs no manual step;
[what changes](docs/user/backup-and-upgrade.md#upgrading-to-050).

## New in 0.4.0

Channels that stand on their own: Telegram is optional. A person is a **user** of
Argus, with one role, on the web, on Telegram, or both (`/link`). The web has its own
passwords, a persistent chat and inbox, invitations (`/users`), every page Telegram's
commands offer, and a one-time **setup link** that creates the admin on an install with
no bot. Approvals are asked on every channel of the user and closed on the others.
**Public mode** for the web: an authenticator code for every sign-in, a Caddy overlay
with automatic HTTPS. A project's commands now run confined to its own folder. Upgrading
from 0.3 needs no manual step: the admin and the allowed users become users, with their
Telegram identities.

## New in 0.3.0

The web interface; per-project tool permissions; API keys and default models from the
chat; MCP servers; project templates and instructions; the admin and operator roles;
`/estimate`; projects asking each other; and the *Always allow* button. Upgrading from
0.2 needs no migration; [what changes](docs/user/backup-and-upgrade.md#upgrading-to-030)
for your users and projects is listed in the upgrade guide.

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
| **Separation.** A project is a top-level agent with its own folder, session, model, memory and budget. | Projects never share a conversation, a memory or a budget, and memory lives outside every workspace. An agent's commands run under Landlock: they read and write only their own project's folder, never the database, the other projects or the conversations. |

Each rule is enforced by tests, not only stated here.

## Status: an honest picture

**Early, and in use.** The foundation is done and heavily tested, and Argus runs day
to day on its author's own server, but nobody else has run it in production yet. dsh
itself is still a release candidate (`0.2.0-rc.2`).

What has been verified:

- **2,000+ automated tests.** They cover a `SIGKILL` crash in the middle of a
  run, a day-long outage of the scheduler, and every approval bypass we could
  think of.
- **The Docker install, end to end, on a real daemon:** install, health checks,
  backup, restore, upgrade, forced rollback, and upgrading a deployment that still
  uses the old dsh-ops names.
- **An upgrade from 0.2 to 0.3.0 on a real server** (a Docker host in a VM): every
  `argus doctor` check passes, and the web interface answers through an SSH tunnel.
- **The native install, end to end, on a fresh Ubuntu 24.04 with systemd:**
  install, crash recovery, upgrade and rollback from git, uninstall.
  `pnpm test:native-vps` repeats it on demand.
- **0.4.0 on the same fresh Ubuntu, and in the Docker image:** an install with no
  Telegram, the setup link creating the admin, the web chat answering, the admin's
  recovery link; and an upgrade from 0.3.2 that turns the admin and an allowed user
  into users with their Telegram identities (`pnpm test:native-vps --web-only`,
  `--upgrade`). Public mode (TOTP, Caddy) is covered by automated tests, not yet by a
  live deployment.
- **The command sandbox inside the real image**, hardened as compose runs it: a
  project's shell cannot read the database, another project, a conversation, the keys
  or the application, nor write outside its folder (`pnpm test:docker-sandbox`).
- **A live run with a real Telegram bot and real billed models.** `/help`, `/new`,
  a free message answered in the chat, and `/status`, with DeepSeek V4 Flash and
  GLM-5.3 Flash through OpenRouter, each run accounted at the provider's price.
  `pnpm test:live` repeats it.
- **0.5.0 in the real image and on a fresh Ubuntu:** an extension installed in the
  sandbox cannot read the keys, and its MCP server works in the project's folder but
  cannot read the database (`pnpm test:docker-sandbox`); an upgrade from 0.4.0 keeps the
  users and leaves an old project's file as it was (`pnpm test:native-vps --upgrade`).
- **`web_fetch` never reaches a private address:** the server itself, the private
  network and the cloud metadata service are refused, by IP or by name
  (`test/spikes/08-web-fetch-addresses.test.ts`).
- **Cost accounting against a provider's own bill.** Every request to DeepInfra
  matched DeepInfra's reported token counts (cached tokens included) and its
  billed cost to within 1 µUSD.

What is not verified yet:

- **Agents running shell tools under the native systemd hardening.**
- **The web interface through `tailscale serve`.** Reached so far through an SSH
  tunnel and on the local machine.
- **MCP servers in production.** Tested with a real stdio server in the test suite,
  not yet with the public servers (GitHub and the like).
- **Long-running use by others.** No deployment but the author's has run for weeks
  against real budgets.

## Where it is going

An Agent OS is more than a reliable core. Next on the road:

1. **Extensions to use** (0.6.0): a first-party `office` extension (Word, Excel,
   PowerPoint) and more, on the extension mechanism of 0.5.0.
2. **More channels and more people.** Slack or Discord, and more roles than admin and
   operator, so a team can share one Argus.
3. **Memory that finds meaning**, not only words, and **parallel work** inside one
   project.
4. **Operations:** metrics for an existing monitoring stack, and encrypted backups
   copied off the machine.

If any of this is something you need, an issue describing your use case is the
most helpful thing you can send.

## Try it

You need a Linux machine. For Docker you need Docker with the Compose plugin; for the
native install, **Node 22** and **pnpm 8.6.11**:

```sh
corepack enable && corepack prepare pnpm@8.6.11 --activate
```

Either way, you need an API key for your model provider. Telegram is optional: for it,
a bot token from [@BotFather](https://t.me/BotFather) and your numeric Telegram user id
from [@userinfobot](https://t.me/userinfobot). The installer asks.

### Docker (recommended)

```sh
git clone https://github.com/rla-labs/argus.git
cd argus
./deploy/scripts/install.sh
```

It pulls the published image (`ghcr.io/rla-labs/argus`); `--build` builds it from your
checkout instead. The container runs as a non-root user with a read-only filesystem and no
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
the health check and, with Telegram, sends your first message.

After either install: without Telegram, open the **setup link** the installer prints (it
creates the admin, then walks through the key, the models and a first project;
`argus setup-link` shows it again). With Telegram, open the chat with your bot and send
`/start`. On the host, one
command runs the rest, for both installs: `argus status`, `argus doctor`, `argus logs -f`,
`argus backup`, `argus restore`, `argus upgrade`.

For the web interface, open a private path to the server's port 3091 (on the server:
`sudo tailscale serve --bg 3091`; or from your computer:
`ssh -N -L 3091:127.0.0.1:3091 you@server`), then sign in, or send `/web` to the bot
for a sign-in link. Nothing is opened to the internet unless you choose
[public mode](docs/user/web.md#public-mode).

The user documentation starts at [`docs/user/`](docs/user/README.md):

- [Getting started](docs/user/getting-started.md): from an empty server to a working
  project and a schedule, in ten minutes
- [Three scenarios](docs/user/scenarios.md): a website, a daily report, a file you send
- [Working with Argus every day](docs/user/daily-use.md): the commands, by situation,
  and how to work well with them
- [The web interface](docs/user/web.md): reaching it privately, signing in
- [Chat commands](docs/user/commands.md), [Configuration](docs/user/configuration.md),
  [Extensions](docs/user/extensions.md),
  [Backup, restore and upgrades](docs/user/backup-and-upgrade.md),
  [Security](docs/user/security.md), [Troubleshooting](docs/user/troubleshooting.md)

## Development

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test

pnpm test:spikes        # the verified facts about dsh, as runnable tests
pnpm test:native-vps    # the native install on a throwaway Ubuntu + systemd container
                        # (needs Docker; runs a privileged container)
pnpm test:docker-sandbox  # what a project's shell may read and write, in the real image
```

```
packages/          one Cordis plugin per folder (ops-*, ops-web for the web interface),
                   plus the argus-agent bundle
profiles/ops/      the dsh profile that stacks the bundles
deploy/            Docker, compose, native systemd install, backup/upgrade scripts,
                   and the config templates (ops.yaml.minimal, ops.yaml.example, a project)
test/              spikes, end-to-end crash recovery, deploy tests
```

A change is done when the four commands above pass. The architecture rules in
[How it is built](#how-it-is-built) are checked by tests, so a change that breaks
one fails loudly.

## License

Argus is source-available under the [Sustainable Use License](LICENSE.md), the license
n8n uses. You may run it for yourself or for your own company, commercial work included,
and change it for that use. You may not offer it to others as a hosted or managed
service, and you may not sell or commercially distribute it, or a modified version.

## Acknowledgements

Argus stands on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
and Cordis. Their extension points made it possible to build an agent OS as a set
of plugins, without forking either.

Model prices come from the [AI API Pricing dataset](https://aicostbudget.com/en/datasets/ai-api-pricing)
by aicostbudget.com, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Argus keeps the token-priced models and, for each, the highest standard price that
can apply (see `packages/ops-meter/src/catalog-snapshot.ts`). Provider invoices remain
the final word on what you pay.
