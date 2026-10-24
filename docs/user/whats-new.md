# What's new

What each release brought, newest first, and what has been verified. For the steps to
upgrade, see [Backup, restore and upgrades](backup-and-upgrade.md).

## 0.7.4 (in progress)

- **A project reads its mailbox.** `/mail set <project> imaps://…` gives it `mail_list`,
  `mail_read`, `mail_save_attachment` and `mail_mark_read` on the folders its file names
  (`mail.read_folders`, `INBOX` by default). It cannot delete, move or send through the
  mailbox, and a mail reaches it as information from outside, never as your instructions.

## 0.7.3

**The web interface, first-class.**

- **Projects first.** The start page is your projects, the ones that need you first,
  with what waits for a decision answered in place and a box to ask for something in a
  project or as a one-off task. A project opens on its own space: its conversation,
  schedules, files, activity and settings.
- **Every setting in the web, nothing to write in a file.** A project's settings in
  sections and plain words; Argus's own (web access, models and providers, keys and
  secrets, web search, extensions, templates, budgets, users, language…), and every
  `ops.yaml` key under Advanced. What applies only after a restart says so, and
  **Restart now** restarts Argus once the runs finish. The chat gets the same:
  `/config`, `/restart`, `/template set|new|remove`, `/session`.
- **A conversation per project, and sessions.** A project's conversation is its own
  thread in the web. A one-off task is a session you can go on with for a day after its
  last message (`/session`); before, a task's agent stayed until the restart.
- **Schedules from plain choices** (weekdays at 9, the 1st of the month…) with their
  next runs; **files** with a preview, drag and drop and a zip; **costs** by project.
- **Reach it without SSH.** `argus tailscale` (or `argus init --tailscale`) puts the
  web on your Tailscale network; with **sign in with Tailscale**, a person whose login
  is linked comes in with no password. Private stays the default.
- **Public mode, safer.** Every new sign-in is told to the person and the admin; you
  see where you are signed in and end the rest.
- **A new look** (dark and light), its own fonts, Ctrl+K to jump anywhere, a menu at the
  bottom on a phone, and English, Romanian or a language pack you add.

[What changes](backup-and-upgrade.md#upgrading-to-073).

## 0.7.2

**A browser, MCP servers that sign in, and per-tool access.**

- **Access per MCP tool.** `mcp.<server>.tools` gives a tool, or a glob such as
  `read_*`, its own `allow`, `ask` or `deny`; the most specific match wins, and the
  server's `access` covers the rest. An extension can ship such rules as defaults.
- **Every local MCP server runs confined**, the ones you add as well as an extension's:
  it reads the system and the project's folder, and keeps its logins and caches in a
  home of its own that the agent's shell cannot read. `/mcp reset` empties it. A server
  whose program is outside `/usr` or `/opt` no longer starts: see the upgrade notes.
- **MCP servers that sign in with OAuth** (Notion, Linear, Google Workspace, Slack…):
  `/mcp connect <project> <server>` signs the server in through the web, per project and
  per server. Argus keeps the grant and refreshes it; the agent reaches the server
  through a local proxy and never sees a token. A provider that needs a client of yours
  (Google, Slack) gets it under `oauth_clients` in `ops.yaml`.
- **A browser**, the `browser` extension: a headless Chromium driven with Playwright
  MCP. It reaches the public internet only, through Argus's new egress proxy, which
  refuses the server, its network and the cloud's metadata service; reading a page runs
  unasked, acting on it asks. The Docker image gains Chromium's libraries (about 8 MB).
- **`office` 1.1.0:** screenshots of documents, so the agent checks its layout, and
  `office-pdf` for a PDF.

[What changes](backup-and-upgrade.md#upgrading-to-072).

## 0.7.1

**Settings that apply at once, web search from the provider you choose, three more
extensions, and mail.**

- **A changed setting applies without `/reset`.** Enabling an extension, changing a
  project's model, tools or MCP servers reaches its agent at the next message, in the
  same conversation; a run in progress finishes first. `/model` now writes the project's
  file, like `/set <project> model`; before, it did not reach the agent at all.
- **`/budget <project> set` resumes** a project the budget paused, when the new limit is
  above what it spent, as `+<usd>` already did.
- **`/tools <project>` lists the extensions' programs.**
- **Web search through the provider you choose.** `web_search.provider` in `ops.yaml`:
  Tavily, Brave, Serper, a private SearXNG next to Argus (a new compose overlay), or
  DeepSeek as before (the default). Each search is charged its price to the project
  that searched; `/key tavily <key>` and the others check a key with one search.
- **Three new extensions** in
  [rla-labs/argus-extensions](https://github.com/rla-labs/argus-extensions):
  **diagrams** (Mermaid to SVG, PNG or text, no browser), **pdf** (`pdftool`: text,
  merge, split, pages, rotate, render, compress, passwords) and **images** (ImageMagick
  7, x64). The Docker image gains the five libraries and the font `images` needs.
- **A project can send mail** with `send_mail`, done by Argus: the account is the admin's
  (`/mail set <project|default> smtps://…`), never the agent's. Every mail is shown whole
  first, with Approve and Deny only, and what goes is what was shown. Recipients must be
  listed in the project's `mail.allowed_recipients`; a daily limit and an attachment size
  limit apply. A new tool group, `mail` (`ask`, never `allow`).

[What changes](backup-and-upgrade.md#upgrading-to-071).

## 0.7.0

**Files in and out, and the first practical tools.**

- **Git, done by Argus.** A project clones, pulls and pushes its repositories through
  Argus, with a token per project and per remote that only the admin sets and that never
  reaches the agent, its shell or the conversation. A push asks first, showing its
  commits and the files they change, and sends that commit or nothing; `main` and
  `master` are protected, and nothing is force-pushed. Two projects can work on
  repositories of two different accounts.
- **Large files through the web.** Upload up to 2 GB into a project's `inbox/`, download
  any folder as a zip, and get a one-time link for a file too big for the chat.
- **Extensions with programs.** An extension can put programs in a project's shell,
  confined like any other command. Two first-party ones: **office** (OfficeCLI: Word,
  Excel and PowerPoint, existing documents edited in place) and **media** (ffmpeg and
  ffprobe), both in [rla-labs/argus-extensions](https://github.com/rla-labs/argus-extensions):
  `/ext install https://github.com/rla-labs/argus-extensions#office`. A repository can
  now hold several extensions, one per folder (`#folder`).
- **Web searches are in the budget**, and `/tools` says when there is no DeepSeek key to
  search with.

[What changes](backup-and-upgrade.md#upgrading-to-070).

## 0.6.2

**Long runs are not interrupted.** A run is no longer paused every 60 steps or 45
minutes to ask Continue or Stop. The budget, the step ceiling and the loop checks hold
it.

- **An optional loop checker** replaces the checkpoint and the judge. With
  `limits.loop_check_steps` set, a model reads the run every so many steps and says
  whether it goes in circles. It reads what Argus measured, not what the agent claims.
- **You choose what a loop does** (`limits.on_loop`): `stop` the run, `notify` you while
  it goes on, or `ask` you with the checker's reason. A scheduled run is never asked.
- **The `site` template** checks every 50 steps and notifies, as an example.
- The loop and no-progress checks in code stay as they were.

[What changes](backup-and-upgrade.md#upgrading-to-062).

## 0.6.1

**Prices for any provider, without writing them.** A provider you declare under
`providers:` (DeepInfra, Together, Fireworks, Groq…) is priced from lists refreshed
daily: DeepInfra's own price list, which is what it bills, and models.dev for about
230 others. You write no `pricing:` entry, and the price follows the provider's
changes ([details](configuration.md#pricing)).

Upgrading from 0.6.0 needs no manual step. A price you wrote under `pricing:` still
wins; remove it to follow the provider's list.

## 0.6.0

Long work that cannot run away. A project can now work for hundreds of steps, and a run
that goes nowhere stops early and says why.

- **A checkpoint instead of a kill.** Every 60 steps or 45 minutes, a run asks
  **Continue** or **Stop**, in the chat or on the web. It shows what it did, the files
  it changed and its cost. A scheduled run stops and tells you how to go on. Each
  project has a ceiling it never passes (`limits.max_steps_total`, 1000 by default, set
  by the templates).
- **Loops are judged by what changes.** The same call with the same result stops the
  run, and so does a cycle of 2 or 3 calls. The same call with a new result counts as
  progress, for example tests run again after a fix. Times, ids and key order do not
  fool it.
- **A run that brings nothing new stops** after 25 steps with no new result and no file
  changed.
- **An optional judge.** A model of your choice reads what Argus measured about the run,
  not what the agent says. It gives the run more steps or stops it, within bounds set in
  code, and then you decide.
- **A project's own limits apply.** Before 0.6.0 they were read and ignored. The upgrade
  tells you which projects this changes
  ([what changes](backup-and-upgrade.md#upgrading-to-060)).

## 0.5.0

Fewer approvals, because more actions are safe by construction.

- **`/undo`** takes back any of a project's last runs.
- **Precise rules.** Commands that only read no longer ask. `docker logs *` allows the
  arguments of one command, and `*.example.com` covers only the subdomains.
- **Layered templates.** A project made from a template follows the template's
  improvements and keeps what you changed.
- **Skills per project**, kept where the project's agent cannot write.
- **Extensions:** tools and skills installed once from git (`/ext install`), pinned and
  hashed, confined, and enabled per project.
- **Scheduled runs never wait.** An action that would need approval is refused at once,
  and you get the rule that would allow it as a button (`/rule`).
- **The `site` template** runs its commands without asking, confined to its folder.

[What changes](backup-and-upgrade.md#upgrading-to-050).

## 0.4.0

Telegram became optional.

- **Users.** A person is a user of Argus, with one role, on the web, on Telegram, or
  both (`/link`).
- **A complete web interface.** It has its own passwords, a persistent chat and inbox,
  invitations (`/users`), and every page that Telegram's commands offer. A one-time
  **setup link** creates the admin on an install with no bot.
- **Approvals on every channel.** A question goes to every channel of the user, and an
  answer on one closes it on the others.
- **Public mode** for the web, with an authenticator code for every sign-in and a Caddy
  overlay for HTTPS.
- **Confined commands.** A project's commands run confined to its own folder.

## 0.3.0

- The web interface.
- Per-project tool permissions.
- API keys and default models set from the chat.
- MCP servers.
- Project templates and instructions.
- The admin and operator roles.
- `/estimate`.
- Projects asking each other questions.
- The *Always allow* button.

[What changes](backup-and-upgrade.md#upgrading-to-030).

## What has been verified

- **More than 2,000 automated tests.** They include a `SIGKILL` in the middle of a run,
  a day-long outage of the scheduler, and approval bypass attempts.
- **The Docker install, end to end, on a real daemon.** This covers install, health
  checks, backup, restore, upgrade and forced rollback.
- **The native install, end to end, on a fresh Ubuntu 24.04 with systemd.** This covers
  install, crash recovery, upgrade and rollback from git, and uninstall
  (`pnpm test:native-vps`).
- **Every upgrade, 0.2 to 0.7, in the image and on a fresh Ubuntu.** An older project's
  file is left as it was, and users carry over (`pnpm test:native-vps --upgrade`).
- **The command sandbox in the real image.** A project's shell cannot read the database,
  another project, a conversation, the keys or the application, nor write outside its
  folder. The same holds for an extension's install and its MCP server
  (`pnpm test:docker-sandbox`).
- **A real Telegram bot with real billed models**, DeepSeek V4 Flash and GLM-5.3 Flash
  through OpenRouter (`pnpm test:live`).
- **Cost accounting against a provider's own bill.** Every request to DeepInfra matched
  its reported tokens and its billed cost to within 1 µUSD.
- **0.6.0's limits:** ten scripted long runs through the real governor. They include one
  run per loop pattern and a run of 150 steps that is never cut off. The judge was also
  tested against two real models, and both stop an agent that claims progress it did
  not make.
- **0.6.2's loop checker:** every `on_loop` (stop, notify, ask, and a scheduled run
  under ask) through the real governor and the chat, and its prompt against two real
  models: both find the loop in a run that only claims progress, and both let 150 steps
  of real progress go on.
- **0.7.0's git:** a real git server over HTTPS and the real command sandbox; a hostile
  repository (ten hooks, `fsmonitor`, filters, `insteadOf`, alternates into another
  project) runs nothing with Argus's rights, and another project's commits never leave.
  The token is nowhere in the project's folder, the conversation or the audit.
- **0.7.0's extensions:** `office` and `media` installed and run, confined, in the real
  image (`pnpm test:docker-extensions`) and on a fresh Ubuntu with systemd
  (`pnpm test:native-vps`).
- **0.7.2's browser:** installed and run, confined, in the real image and on a fresh
  Ubuntu; through the egress proxy it reaches a public page and is refused loopback,
  the private network, the metadata service, a name that resolves to loopback and a
  redirect to it. The agent's shell cannot read an MCP server's home.
- **0.7.2's OAuth** end to end against a fake authorization server and a fake MCP
  server: sign-in, a refresh in the middle of a run, a refused grant, revocation.
  Notion, Slack and Google have not been signed in to yet.
- **`web_fetch` never reaches a private address**: the server itself, the private
  network and the cloud metadata service are refused.

**Not verified yet:**

- Agents running shell tools under the native systemd hardening.
- The web interface through `tailscale serve`. So far it has been reached through an SSH
  tunnel.
- Public mode on a live deployment. It is covered by automated tests only.
- Public MCP servers, such as GitHub's.
- Long-running use by anyone but the author.
