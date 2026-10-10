# Telegram commands

Every command is deterministic: no model turn, no LLM decision. Syntax errors
always show the correct syntax.

A **scope** is `global`, `adhoc`, or a project id. Where a command takes an
optional project, it uses the chat's active project — set once with `/p <id>`.

A **duration** is `90s`, `30m`, `2h`, `1d`, `1w`, or a bare number of minutes.
An **amount** is `2`, `2.5`, `$2`, or `$2.50`.

For which command fits which moment, read
[Working with Argus every day](daily-use.md#commands-by-situation).

**Who may run what.**

| Role | Who | May |
|---|---|---|
| **admin** | `access.admin` (anyone in its chat, when it is a group) | everything |
| **operator** | every other allowed user (`allowed_users`, `/allow`) | run work (free text, `/p`, `/task`, `/cron`), stop and reset it (`/stop`, `/reset`, `/panic`, `/resume-all`), answer approvals, and see everything |

What spends money, changes what the agents may do, or deletes is the admin's:
`/new`, `/model`, changing a budget (`/budget <scope> …`), `/allow-free`, `/forget` (removing),
`/set`, `/key`, `/defaults` (changing), `/instructions` (changing), `/archive`, `/allow`
and `/web`. An operator who tries is told so; seeing a budget, the defaults, the
instructions or the memory stays open to everyone.

| Group | Commands |
|---|---|
| Getting around | [`/help`](#help-command) · [`/start`](#start) · [`/projects`](#projects) · [`/p`](#p-project-id) |
| What is happening | [`/status`](#status-project-id) · [`/usage`](#usage-scope-daymonth) · [`/runs`](#runs-project-id--all) · [`/log`](#log-project-id--all-) · [`/approvals`](#approvals) · [`/health`](#health) |
| A project's results | [`/memory`](#memory-project-id) · [`/instructions`](#instructions-project-id--project-id-text) · [`/forget`](#forget-project-id-section--asks-first) · [`/files`](#files-project-id-folder) · [`/get`](#get-project-id-path) · [`/tools`](#tools-project-id) |
| Work | [`/task`](#task-text) · [`/cron`](#cron-) · [`/stop`](#stop-project-id) · [`/panic`](#panic--asks-first) · [`/resume-all`](#resume-all) |
| Money | [`/budget`](#budget-scope-action) · [`/model`](#model-project-id-providermodel) · [`/defaults`](#defaults-tasksfrontdesk-providermodel) · [`/allow-free`](#allow-free-providermodel--asks-first) |
| Projects | [`/new`](#new-id-template-providermodel) · [`/reload`](#reload) · [`/reset`](#reset-project-id--asks-first) |
| Admin only (see the roles above) | [`/web`](#web--admin) · [`/set`](#set-project-id-key-value--admin) · [`/key`](#key-provider-key--name-value--remove-providername--admin) · [`/archive`](#archive-project-id--admin-asks-first) · [`/allow`](#allow-user-id--remove-user-id--admin) |

---

## `/help [command]`

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

## `/start`

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

## `/projects`

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

## `/p [project-id]`

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

## `/status [project-id]`

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

## `/stop [project-id]`

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

## `/task <text>`

Runs a one-off task in its own scratch folder. The text is forwarded
**verbatim** — spacing, newlines and all. It runs at priority 0 and is delivered
back to this chat.

```
/task list the CSV files in /data and summarise them
```

```
Task queued (a1b2c3d4). I will report when it finishes.
```

The model is `tasks.model` from `ops.yaml`; [`/defaults`](#defaults-tasksfrontdesk-providermodel)
shows and changes it. An empty text shows the syntax.

---

## `/usage [scope] [day|month]`

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

## `/runs [project-id | all]`

The last 10 runs: when each started, how it ended, its steps, how long it took and
what it cost. Defaults to the active project; with none set, or with `all`, it lists
every run, one-off tasks included.

```
/runs
/runs site-firma
/runs all
```

```
Recent runs: site-firma

#  Started   Status     Steps  Took   Cost
1  12m ago   completed  6      1m 4s  $0.0312
2  2h ago    error      2      9s     $0.004

What one did: /log site-firma <#>
```

The status is `running`, `completed`, `aborted` (`/stop` or `/panic`), `error`,
`budget_stopped`, `limit_stopped` (a step or time limit) or `interrupted` (cut off by a
restart; the startup report offers to retry it).

---

## `/log [project-id | all] [#]`

What one run did: the request, every tool it called, the approvals it asked for, the
start of its reply, and what it cost. `#` is the run's number in `/runs`, and `1`, the
latest, is the default. The project defaults the way `/runs` does.

```
/log
/log site-firma
/log site-firma 2
/log all 3
```

```
Run #1 of site-firma: completed
Started 12m ago, took 1m 4s, 6 step(s), openrouter/deepseek/deepseek-v4-flash, $0.0312

Asked: the footer shows last year, fix it

Tools (3):
1. read: src/components/Footer.astro
2. edit: src/components/Footer.astro
3. bash: npm run build ✗

Approvals:
- npm run build: granted

Reply:
The footer now takes the year from the build date. The build failed once …
```

`✗` marks a tool call that failed. The run keeps at most 40 calls, each argument cut to
100 characters, and the first 600 characters of the reply. The full conversation stays
in the session log on the server. A run from before 0.2.0 has no tools or reply to show.

---

## `/approvals`

The actions waiting for your approval, and the last five decisions. A waiting
action is answered with the buttons on its question; no answer by the timeout means
no.

```
Waiting for your answer (1):
Asked   Project     Action
2m ago  site-firma  rm -rf build
Answer with the buttons on the question. No answer by the timeout means no.

Last decisions:
When     Project     Action      Outcome  By
1h ago   site-firma  git push    granted  888878901
3h ago   site-firma  git status  granted  policy
```

`policy` means the project's approval rules decided, without asking.

---

## `/memory [project-id]`

What a project remembers: the notes it keeps across resets and compactions.
Defaults to the active project. A memory longer than 3,000 characters is sent as a
`.md` file.

```
/memory
/memory site-firma
```

---

## `/instructions [project-id] | <project-id> <text>`

What a project is told to do: its role, its rules, how to answer. They are in its
agent's system prompt on every request, so a change applies from the next one, with
no `/reset`. The agent cannot change them; its own notes are its [memory](#memory-project-id).

```
/instructions
/instructions site-firma
/instructions site-firma Answer in Romanian.
Never change anything under blog/ without asking.
/instructions site-firma clear
```

With a project and text, the text — every line after the id — replaces the
instructions. `clear` removes them. Up to 8 KB, since they go with every request.
Seeing them is anyone's; changing them is the admin's. A template sets the first ones;
the web's Settings page edits them too.

---

## `/forget <project-id> [section]`  *(asks first)*

A project's memory is a list of `##` sections (`## Build`, `## Conventions`, ...).
With no section, `/forget` lists them with their sizes. With a section, it removes that
section after a confirmation. The name is matched without regard to case.

```
/forget site-firma
/forget site-firma Deploy notes
```

Use it when the project learned something wrong, or something that is no longer true.
A running agent keeps what it already read until `/reset`; its next session does not
see the section. The removal is in the audit log as `memory.forgotten`.

---

## `/files [project-id] [folder]`

One folder of a project: subfolders first, then files, newest first, at most 40.
The folder is relative to the project's own; nothing outside it can be listed.

```
/files
/files site-firma
/files site-firma reports
```

```
site-firma/reports

Name          Size    Modified
archive/              3d ago
weekly.md     4.2 KB  10m ago
summary.pdf   88.0 KB 1d ago

/get site-firma reports/<name> sends a file.
```

---

## `/get <project-id> <path>`

Sends one file from a project's folder as an attachment. The path is relative to the
project's folder and may contain spaces. A path, or a link, that leads outside the
folder is refused. A file larger than Telegram can send (`telegram.max_file_bytes`,
50 MB) is named instead, so you can fetch it from the server.

```
/get site-firma reports/weekly.md
/get site-firma out/day 1.csv
```

---

## `/budget <scope> [action]`

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

## `/model <project-id> <provider/model>`

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

## `/allow-free <provider/model>`  *(asks first)*

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

## `/reload`

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

## `/new <id> [template] [provider/model]`

Creates the project folder, writes its project file, and reloads the configuration —
so the project is usable at once, without a restart.

```
/new
/new reports
/new market research
/new site-firma site deepseek/deepseek-flash
```

`/new` alone lists the templates. A template gives the project what a kind of work
needs: its description, its [tool settings](configuration.md#tools--what-the-agent-may-use),
a few commands that run unasked, and its first [instructions](#instructions-project-id--project-id-text):

| Template | For | Tools | Runs unasked |
|---|---|---|---|
| `site` | a website or web app | read, write; shell and web ask | `ls`, `pwd`, `date`, `git status`, `git diff`, `git log` |
| `research` | research on the web, written up as sourced notes | read, write, web; no shell | — |
| `reports` | recurring reports kept as dated files | read, write, web; shell asks | `ls`, `pwd`, `date` |
| `devops` | checking and running servers and services | read; write, shell and web ask; 80 steps a run | `ls`, `df`, `free`, `uptime`, `ps`, `systemctl status`, `journalctl`, `docker ps`, `docker logs`, ... |

Commands the agent could steer into running its own code (`npm run …`, `git commit`,
which runs hooks) still ask: add them with `/set <id> approvals.auto_allow [...]` if
you want them. Without a template the project asks before writing, running or browsing.
Your own templates go in `config/templates/<name>.yaml`; see
[configuration](configuration.md#templates--your-own-kinds-of-project).

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

## `/reset <project-id>`  *(asks first)*

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

## `/set <project-id> <key> <value>`  *(admin)*

Changes a project setting without opening the server. The setting is written into the
project's file, comments kept, and the project is reloaded, so the change is durable and
checked by the same rules as at startup. A value that does not validate is not written:
the file stays as it was and the reply says why.

```
/set site-firma budget.day_usd 5
/set site-firma limits.max_steps_per_run 100
/set site-firma approvals.mode auto
/set site-firma approvals.auto_allow [git status, npm test]
/set site-firma tools.web allow
/set site-firma tools.web_hosts [news.ycombinator.com]
/set site-firma description The company website and its blog
/set site-firma model openrouter/deepseek/deepseek-v4-flash
```

| Key | What it changes |
|---|---|
| `description` | The sentence the front desk routes on |
| `model` | `provider/model`; checked for a key and a price, like `/new` |
| `fallback_model` | The cheaper model a `downgrade` budget switches to |
| `budget.day_usd`, `budget.month_usd`, `budget.soft_action`, ... | The project's budget |
| `limits.max_steps_per_run`, `limits.max_wallclock_min`, ... | The per-run limits |
| `approvals.mode`, `approvals.auto_allow`, `approvals.timeout_minutes` | Approvals |
| `tools.read`, `tools.write`, `tools.shell`, `tools.web`, `tools.agents`, `tools.other`, `tools.web_hosts` | What the agent may use; see [`/tools`](#tools-project-id) |
| `mcp.<server>.access`, `mcp.<server>.timeout_s`, ... | An MCP server's settings; `access` applies to the next call, the rest after `/reset` |
| `memory.user_profile`, `progress`, `preset` | The rest |

A misspelt key is refused with the list of the real ones. `id` and `cwd` cannot be
changed: they are the project's identity and its folder. A number, `true`/`false`,
`null` and a `[list]` are read as such; anything else is the text as typed.

A change of `model`, `preset` or `fallback_model` reaches a running agent only after
`/reset`. Unlike `/model`, which lasts until the next reload, `/set model` is in the file.

---

## `/web`  *(admin)*

Sends a link that signs you in to the [web interface](web.md). It works once, for ten
minutes; the sign-in then lasts `web.session_hours`. Open it on a device that reaches
the server through Tailscale, a VPN or an SSH tunnel.

---

## `/defaults [tasks|frontdesk <provider/model>]`

Shows, and changes, the two models no project names: the one a `/task` runs on
(`tasks.model`) and the front desk's (`orchestrator.model`).

```
/defaults
/defaults tasks deepseek/deepseek-flash
/defaults frontdesk openrouter/z-ai/glm-5.3-flash
```

Changing one is the admin's. The model is checked like `/model` (a provider with a key,
a price), written to `ops.yaml` with its comments kept, and applied at once, with no
restart: the next task runs on it, and the front desk starts a fresh conversation on
it with your next message (a reply already being written finishes on the old one).

---

## `/key [provider [key] | NAME value | remove <provider|NAME>]`  *(admin)*

Manages the model providers' API keys, and the secrets of MCP servers, from the chat.

```
/key
/key openrouter sk-or-v1-…
/key GITHUB_TOKEN ghp_…
/key remove groq
```

- **`/key`** lists the providers that have a key, and where it comes from: saved here,
  or the server's environment (`.env`, `secrets.env` on a native install).
- **`/key <provider> <key>`** deletes your message at once, checks the key with the
  provider (the same free request `argus doctor` makes) and saves it only if it is
  accepted. The next request uses it, with no restart, and a project that was refused
  for want of a key loads. The reply names the key by its last four characters.
- **`/key NAME value`**, a name in capitals, saves a secret that a project's
  [MCP server](configuration.md#mcp--external-tools-through-mcp-servers) reads as
  `${NAME}`. Nothing can check it, so it is saved as given; the project's agent reads it
  when it next starts (`/reset <project>`).
- **`/key remove <provider>`** (or `NAME`) removes a saved key.

Keys are saved in dsh's credentials store (`.credentials.yaml` under the dsh home,
`0600`), never in `ops.yaml` or the database, and the audit log keeps only the
provider's name. **A key in the server's environment wins** over a saved one and cannot
be changed from here: delete its line from `.env` and restart once, then `/key`
manages it.

**A key sent as ordinary text is never passed to an agent.** Anything that looks like a
key (`sk-…`, `AIza…`, `gsk_…`, a bot token) is deleted from the chat and answered with
a pointer to `/key`.

---

## `/tools [project-id]`

Shows which tools a project may use, by group, with its setting: `off` (the agent does
not see them), `deny` (refused), `ask` (you are asked) or `allow` (runs unasked), and
the sites `web_fetch` reaches unasked. A read or write outside the project's folder asks
even under `allow`. Change a group with `/set <project> tools.<group> <value>`; the
groups are explained in [configuration](configuration.md#tools--what-the-agent-may-use).
The project's MCP servers follow, each with its `access`; change one with
`/set <project> mcp.<server>.access allow`.

```
/tools
/tools site-firma
```

---

## `/archive <project-id>`  *(admin, asks first)*

Stops a project taking work without deleting anything. Its file moves to
`config/projects/archived/`; its folder, memory, history and costs stay. A running
project must be stopped first.

```
/archive site-firma
```

```
site-firma is archived; its file is now /data/config/projects/archived/site-firma.yaml.
To bring it back, move that file to /data/config/projects/site-firma.yaml and send /reload.
```

---

## `/allow [<user-id> | remove <user-id>]`  *(admin)*

Lets someone else use the bot, without editing `ops.yaml`. Adding asks first; removing
does not. The user is allowed on the channel you send the command from.

```
/allow
/allow 123456789
/allow remove 123456789
```

An added user can do everything you can except the admin commands: run commands, spend
the budgets, talk to every project. The users added here are kept in the database
(and in a backup); the ones in `access.allowed_users` are changed in `ops.yaml`.

---

## `/cron ...`

Scheduled work, handled by `ops-scheduler`. The cron expression is quoted, because it
contains spaces. With a project, the prompt goes to it; without one, it runs as a
one-off task. The result is delivered to the chat the schedule was created from.

```
/cron list
/cron add site-firma "0 9 * * *" check the build
/cron add "0 18 * * 5" summarise the week
/cron run <id>
/cron remove <id>
/cron enable <id>
/cron disable <id>
```

`run` fires a schedule now, which is how to test one.

Without that plugin: `The scheduler is not installed on this deployment.`

---

## `/health`

Delegates to `ops-health`. Without it, reports what the governor can see:

```
ops-health is not installed; showing what the governor can see.
  panic     off
  running   1
  pending   0
  slots     1/3
```

---

## `/panic`  *(asks first)*

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

## `/resume-all`

Clears panic mode and re-dispatches anything still queued.

```
/resume-all
```

```
Resumed. Queued work will be admitted again.
```

When not panicking: `Panic mode is already off.`

---

## Confirmations

A destructive command returns a **confirmation** instead of acting:

| Property | Value |
|---|---|
| Answered by | Yes/No buttons, which the channel turns into `/confirm <token> <yes\|no>` |
| Valid for | 60 seconds |
| Used | Once |
| Scoped to | The user who asked — a forwarded message cannot confirm someone else's action |
| On no, or expiry | Nothing changes |

`/panic`, `/reset`, `/allow-free`, `/archive`, `/forget` and adding a user with `/allow` ask. Nothing else does.

## Errors

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

## Audit

Every state-changing command writes an `audit_log` row:

| Field | Value |
|---|---|
| `actor` | The user id |
| `action` | `command.<name>` |
| `target` | The argument, truncated to 200 characters |
| `details` | The channel and chat id |

A read-only command writes nothing, and neither does a command that only asked
for confirmation — nothing changed, so nothing is audited.
