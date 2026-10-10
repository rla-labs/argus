# Configuration

Every configuration key, in one place. The reference implementation is
[`templates/ops.yaml.example`](../../deploy/templates/ops.yaml.example) — a commented file with
every key at its default. The installers write the short
[`templates/ops.yaml.minimal`](../../deploy/templates/ops.yaml.minimal) instead: timezone,
data directory, admin and budgets. Copy a section from the reference to change it.

Configuration lives in two files:

| File | Holds | Mode |
|---|---|---|
| `${DATA_DIR}/config/ops.yaml` | Everything below | 640, owned by uid 10001 |
| `deploy/compose/.env` | Secrets and deployment settings | **600** |

**Secrets are never in `ops.yaml`.** The bot token (`TELEGRAM_BOT_TOKEN`) and the provider
keys (`<PROVIDER>_API_KEY`) are read from the environment or from dsh's credentials
store, where [`/key`](commands.md#key-provider-key--remove-provider--admin) saves them,
so the file can be copied, committed or shown without leaking anything.

## Top level

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

## `access` — who may operate the system

| Key | Type | Default | Meaning |
|---|---|---|---|
| `admin` | id or address | `null` | You. A bare id (`'99887766'`) is a Telegram chat. **Always allowed**; where reports, warnings and unaddressed output go. |
| `allowed_users` | list | `[]` | More `{ channel, userId }` entries. **With no admin either, everyone is refused.** |
| `warn_interval_minutes` | int | `15` | Rate limit for refusal warnings. |

**The admin commands.** `/set`, `/archive` and `/allow` run only for the admin: the
`access.admin` user, or anyone in the admin's chat when `access.admin` is a group. From
the dsh Web UI they always run, because only someone on the server can reach it. Users
added with `/allow` are allowed on top of `allowed_users`.

```yaml
access:
  admin: '99887766'
  allowed_users:
    - { channel: '*', userId: '11223344' }        # every adapter
```

**The user id is the platform's immutable identity, never a username.** A username can
be changed or released and then claimed by someone else, so it is not an identity.
Message `@userinfobot` on Telegram to find yours.

**A refusal warning never includes the message content.** It names the user id, because
a stranger's text is untrusted input and forwarding it to the operator is a way to put
arbitrary text in front of them.

## `channel` — delivery

| Key | Type | Default | Meaning |
|---|---|---|---|
| `default_address` | address | the admin | Where output goes when there is nothing to inherit. |
| `attachment_scratch` | path | `scratch` | Where an attachment lands with no active project. |
| `progress_enabled` | boolean | `true` | Whether runs report progress. |
| `progress_interval_s` | int | `20` | The minimum gap between progress edits. |

**`default_address` must be quoted**: `"telegram:99887766"`. Unquoted, YAML reads
`telegram:99887766` as a mapping, not a string, and the plugin refuses to start.

Without a default address, scheduled output, budget thresholds and the startup report
have nowhere to go. They are **logged** rather than dropped, so nothing is lost
silently — but nothing is delivered either.

## `telegram`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `bot_token` | string | `TELEGRAM_BOT_TOKEN` | From `@BotFather`. Unset, read from the environment; never write the value here. |
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

## `budgets`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `default_day_usd` | number | `3` | The daily budget a project inherits. |
| `default_month_usd` | number | `40` | The monthly budget a project inherits. |
| `global_interactive_only_pct` | number | `95` | Where the global budget stops spending on unattended work. |

Internally these are **integer micro-USD** (1 USD = 1,000,000). Dollars appear only in
the configuration and the reports.

At `global_interactive_only_pct`, unattended work — schedules, ad-hoc tasks — is
refused while a human's message still gets through. The operator can always ask what
happened; a cron job cannot.

## `concurrency`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `global_max_running` | int | `4` | Simultaneous runs across all projects. |
| `reserve_interactive` | int | `1` | Slots only a human's message may use. |
| `per_provider` | map | `{}` | Per-provider caps. |
| `adhoc_max_running` | int | `1` | Simultaneous one-off tasks. |

**`reserve_interactive` is the important one.** Without a reserve, a deployment busy
with scheduled work queues the operator behind its own automation — and the person
trying to find out what is wrong is the last to be served.

## `limits`

Per-run ceilings, overridable per project.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `max_steps_per_run` | int | `60` | Tool-call steps before a run stops. |
| `max_wallclock_min` | int | `45` | Wall-clock minutes before a run stops. |
| `max_tokens_per_request` | int | `8000` | Tokens in one model request. |
| `max_subagent_depth` | int | `1` | How deep subagents may nest. |
| `loop_repeat_threshold` | int | `5` | Identical tool calls before a loop is declared. |

These exist so a runaway loop **stops** rather than spending until someone notices.

## `queues`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `queue_stall_minutes` | int | `15` | A request waiting longer emits `ops/queue-stalled`. |
| `tick_seconds` | int | `5` | The safety tick. |

## `paused_policy`

A **scalar**, not a map: `keep` or `reject`.

| Value | A paused project does |
|---|---|
| `keep` | Holds a human's message until the pause lifts. Unattended work is rejected either way. |
| `reject` | Refuses everything immediately. |

## `pricing`

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

## `tasks`

| Key | Type | Meaning |
|---|---|---|
| `model` | `provider/model` | The model `/task` and an ad-hoc schedule use by default. |

## `orchestrator`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether the front desk is mounted. |
| `model` | `provider/model` | — | **Use a cheap one**: it runs on every free-text message. |
| `preset` | string | `ops-orchestrator` | The preset mounted into the orchestrator's scope. Its own: no shell, files or web. |
| `switch_active_on_send` | boolean | `true` | Whether routing to a project makes it active. |
| `allowed_task_models` | list | `[]` | Models `run_task` may be asked for. **Empty permits none.** |
| `reset_daily` | boolean | `true` | Whether its context resets each day. |
| `max_note_length` | int | `500` | The longest `remember` note. |
| `day_usd` | number | `1` | Its own daily budget. |

**`allowed_task_models` defaults to empty for a reason.** A model choosing another
model is a cost decision made by the thing being cost-controlled.

## `scheduler`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether schedules run. |
| `min_interval_minutes` | int | `5` | The fastest a cron expression may fire. |
| `timezone` | string \| null | `null` | Default for a schedule that names none. |
| `grace_ms` | int | `1000` | How early the timer may wake. |
| `default_misfire` | `run_once` \| `skip` | `run_once` | What a past-due schedule does after a restart. |
| `max_schedules` | int | `200` | The most schedules the store accepts. |

**Neither misfire policy catches up.** A schedule that missed six windows fires once or
not at all — replaying six runs because the server was down for an hour is a way to
spend six times the money on work that is no longer relevant.

## `approvals`

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

## `memory`

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

## `health`

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

## `rate_limits`

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

## Projects

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

tools:
  read: allow                # off | deny | ask | allow
  write: ask
  shell: ask
  web: ask
  agents: off
  other: ask                 # deny | ask | allow
  web_hosts: [news.ycombinator.com]

memory:
  user_profile: true

progress: true
```

### `description` — the most important field

It is the **only** thing the orchestrator knows about what the project is for. A model
cannot infer purpose from a name: `reports` tells it nothing, and "The customer
reporting pipeline — nightly aggregations and CSV exports" tells it when to route a
message here.

### `cwd` must be inside `${DATA_DIR}/projects/`

The loader **refuses** a path outside it. That boundary is what keeps one project out
of another's files, and it is a rule rather than a warning because a project that can
write into its neighbour's workspace has no isolation at all.

### `auto_allow` — matched on parsed argv

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

### `tools` — what the agent may use

Each group takes one of four values:

| Value | Effect |
|---|---|
| `off` | The agent does not see the tools: they are not offered to the model at all |
| `deny` | A call is refused at once, without a question |
| `ask` | A call becomes an approval question (for `shell`, `approvals.auto_allow` still runs unasked) |
| `allow` | A call runs unasked |

| Group | Tools | Default |
|---|---|---|
| `read` | `read`, `read_image`, `glob`, `grep` | `allow` |
| `write` | `write`, `edit` | `ask` |
| `shell` | `bash`, `pwsh`, `run_code` | `ask` |
| `web` | `web_fetch`, `web_search` | `ask` |
| `agents` | `subagent`, `workflow`, `ralph`, `send_message`, `interrupt_agent`, `list_agents`, `list_subagent_models` | `off` |
| `other` | any tool not listed: a newer dsh's, an integration's | `ask` (never `off`) |

**A read or write outside the project's folder asks even under `allow`**, and is
refused under `deny`. `web_hosts` lists sites `web_fetch` reaches unasked when `web` is
`ask`; an entry covers its subdomains, so `ycombinator.com` covers
`news.ycombinator.com`. A search has no site, so it still asks.

The bookkeeping tools (the agent's todo list, goals, background jobs, skills,
`present`) and `send_file` are always allowed. A misspelt group is refused when the
project loads. A one-off task (`/task`) has no file: it reads, searches the web, and
nothing else; what would ask is refused while `approvals_adhoc` is `deny`.

**These are rules for tools, not a sandbox.** With `shell: allow`, or `curl` in
`auto_allow`, the agent reaches the network whatever `web` says. Allowing both `web` and
`shell` in one project also lets a page the agent read steer the commands it runs; do it
only for a project you trust with both.

`/tools <project>` shows a project's table; `/set <project> tools.web allow` changes it.

### Precedence

```
project budget   ▸  deployment default       (budget, limits)
project approvals ▸  deployment approvals    (mode, auto_allow)
project tools     ▸  built-in defaults       (read, write, shell, web, agents, other)
project memory    ▸  deployment memory       (user_profile)
```

A project may **opt out** of the global user profile. It can never opt **into** another
project's memory: memory isolation is enforced by scope, not by configuration.

## Validating a configuration

```sh
# The composed profile, which fails on an unknown key
docker exec argus-agent dsh --profile ops --dump-config >/dev/null && echo "config ok"

# The health report, which names a subsystem that failed to mount
docker exec argus-agent curl -s http://127.0.0.1:3090/health
```

An unknown key is a **boot failure**, not a warning: a typo that silently did nothing is
a setting the operator believes is in effect.
