# Configuration

Every configuration key, in one place. The reference implementation is
[`templates/ops.yaml.example`](../../deploy/templates/ops.yaml.example) — a commented file with
every key at its default. The installers write the short
[`templates/ops.yaml.minimal`](../../deploy/templates/ops.yaml.minimal) instead: timezone,
data directory, admin and budgets. Copy a section from the reference to change it.

Configuration lives in these files:

| File | Holds | Mode |
|---|---|---|
| `${DATA_DIR}/config/ops.yaml` | Everything below, down to [Projects](#projects) | 640, owned by uid 10001 |
| `${DATA_DIR}/config/projects/<id>.yaml` | One [project](#projects) each | 640 |
| `${DATA_DIR}/config/templates/<name>.yaml` | Your own [project templates](#templates--your-own-kinds-of-project), optional | 640 |
| `${DATA_DIR}/state/<id>/INSTRUCTIONS.md` | A project's [instructions](#instructionsmd--what-the-project-is-told) | 600 |
| `deploy/compose/.env` (`secrets.env` on a native install) | Secrets and deployment settings | **600** |
| `.credentials.yaml` in the dsh home | Keys and secrets saved with `/key` | **600** |

**None of it needs an editor.** The web's **Settings** pages have a form for every key,
and the chat has the same commands: `/config` writes any `ops.yaml` key (checked
against the whole file; what applies only after a restart says so, and `/restart`
restarts Argus), `/set` a project's file, `/template set` a template, `/instructions` a
project's instructions, `/key` the credentials. Each keeps the file's comments.

**Secrets are never in `ops.yaml`.** The bot token (`TELEGRAM_BOT_TOKEN`) and the provider
keys (`<PROVIDER>_API_KEY`) are read from the environment or from dsh's credentials
store, where [`/key`](commands.md#key-provider-key--name-value--remove-providername--admin) saves them,
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
| `admin` | id or address | `null` | You, on Telegram. A bare id (`'99887766'`) is a Telegram chat. **Always allowed**; where reports, warnings and unaddressed output go. Left `null` on a web-only install: the admin is created with the [setup link](web.md#without-telegram-the-setup-link). |
| `allowed_users` | list | `[]` | More `{ channel, userId }` entries, made operators at the next start. **With no user at all, everyone is refused.** |
| `warn_interval_minutes` | int | `15` | Rate limit for refusal warnings. |

**Two roles.**

| Role | Who | May |
|---|---|---|
| **admin** | the one admin: `access.admin`, or the one created with the web setup link (anyone in the admin's chat, when it is a group) | everything |
| **operator** | every other user (`allowed_users`, `/allow`, a `/users invite`) | run work (free text, `/p`, `/task`, `/cron`), stop and reset it (`/stop`, `/reset`, `/panic`, `/resume-all`), answer approvals, and see everything |

What spends money, changes what the agents may do, or deletes is the admin's:
`/new`, `/model`, changing a budget (`/budget <scope> …`), `/allow-free`, `/forget` (removing),
`/set`, `/key`, `/defaults` (changing), `/instructions` (changing), `/archive`, `/allow`
and `/users`. An operator who tries is told so; seeing a budget, the defaults, the
instructions or the memory stays open to everyone.

On Argus's own web interface, commands run as the user who signed in, with that user's
role. From the dsh Web UI they run as the admin: only someone on the server reaches it.

**`admin` and `allowed_users` are where Argus starts from.** Argus keeps its users in its
database. At each start, an id here that Argus does not know yet becomes a user, and the
id in `admin` becomes the admin; the previous admin stays, as an operator. Deleting an
entry from `allowed_users` does **not** take the access away: `/allow remove <id>` does,
on every channel.

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
| `default_address` | address | the admin, on every channel they use | Where output goes when there is nothing to inherit: reports, budget warnings, scheduled output. Set it to send all of that to one chat instead (a group, say). |
| `attachment_scratch` | path | `scratch` | Where an attachment lands with no active project. |
| `progress_enabled` | boolean | `true` | Whether runs report progress. |
| `progress_interval_s` | int | `20` | The minimum gap between progress edits. |

**`default_address` must be quoted**: `"telegram:99887766"`. Unquoted, YAML reads
`telegram:99887766` as a mapping, not a string, and the plugin refuses to start.

With neither a default address nor an admin, scheduled output, budget thresholds and the
startup report have nowhere to go. They are **logged** rather than dropped, so nothing is lost
silently — but nothing is delivered either.

## `telegram`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `bot_token` | string | `TELEGRAM_BOT_TOKEN` | From `@BotFather`. Leave it unset: the token is then `TELEGRAM_BOT_TOKEN` from the environment or saved with `/key telegram`, and the bot starts, restarts or stops as it appears, changes or goes. Set (`${OTHER_VARIABLE}`), it is fixed until a restart. Never write the value here. Without any token, Telegram is simply off. |
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

Per-run ceilings. These are the defaults: a project's own `limits:` (or its template's)
wins, key by key, and `/tools <project>` shows the ones in force. A task and the front
desk use these.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `max_steps_total` | int | `1000` | The **ceiling**: steps one run never passes. Set it per project for the work it does: a coding project may need hundreds of steps, a project that renders and cuts a clip a dozen (leave room for a retry: 15–20). A run is never paused or asked anything for its length alone; the ceiling and the budget are what hold it. |
| `max_tokens_per_request` | int | `8000` | Tokens in one model request. |
| `max_subagent_depth` | int | `1` | **No effect.** dsh nests subagents at most one level deep for every agent; whether a project may use them at all is its `tools.agents`. Kept so existing files still load. |
| `loop_repeat_threshold` | int | `5` | How many times in a row the same call **with the same result** (or a cycle of 2–3 such calls, like read-edit-read-edit) may repeat before the run is stopped as a loop. The same call with a different result (tests run again after a fix) is progress. Times, durations, ids and temp paths are ignored in the comparison. |
| `stall_steps` | int | `25` | How many steps in a row may bring **nothing new** before the run is stopped as `stalled`: no tool result it has not had before in this run, and no file changed in the project's folder. This catches an agent going round in circles with varied calls, which the loop check cannot see. Long work that keeps producing new results or changing files is never stopped by it. `0` turns it off. |
| `loop_check_steps` | int | `0` | The **loop checker**: every this many steps a model (its model: [`judge`](#judge)) reads what code measured about the run (the request, steps, cost, files changed, new and repeated results, errors) and the agent's last message as untrusted data, and says whether the run goes in circles. Its requests are charged to the project. An answer it cannot give (an error, a timeout, a wrong shape) decides nothing: the run goes on, and three failures in a row are reported once. `0`, or no `judge.model`: no loop check. |
| `on_loop` | `stop` \| `notify` \| `ask` | `stop` | What a loop the checker finds does. `stop`: the run stops, and the chat says why. `notify`: the chat is told why, and the run goes on (`/stop` ends it). `ask`: the person it works for gets **Continue** / **Stop** with the checker's reason and what the run did; no answer within `approvals.timeout_minutes` stops it. A scheduled run is not asked: it is told about, as with `notify`. |

`loop_repeat_threshold` and `stall_steps` are code: free, and certain about what they
see. The loop checker is a model: it costs a request every `loop_check_steps` steps,
and sees what code cannot (a run busy with new results that lead nowhere). The `site`
template turns it on as an example, every 50 steps with `notify`.

Before 0.6, a project's own `limits:` were read but not applied (except
`max_tokens_per_request`): `ops.yaml`'s applied to every project. They apply now.

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

**A provider you declare yourself** (`providers:`) is priced too, from lists fetched
daily, by the provider's name: for `deepinfra`, DeepInfra's own price list (what it
bills, its discounts included); for any other, [models.dev](https://models.dev)
(MIT), which covers about 230 providers. Name the provider the way models.dev does
(`deepinfra`, `togetherai`, `fireworks-ai`, `groq`, `nebius`…) and you write no price.
models.dev gives list prices: when a provider discounts a model, Argus counts more than
you are billed, never less. A model on no list still needs a line here.

A price comes from the first of: this table (exact key, then `provider/*`), a local
provider, OpenRouter's `:free` variants, the catalog, the providers' lists.

```yaml
pricing:
  deepseek/deepseek-flash: { input: 0.25, cached: 0.005, output: 1.0 }   # a negotiated price
  acme/new-model: { input: 1, cached: 0.1, output: 4, cache_write: 1.25 }
```

**To correct a list price**, write the one you are billed: a negotiated rate, or a
models.dev price above a provider's discount:

```yaml
pricing:
  togetherai/deepseek-ai/DeepSeek-V4-Flash: { input: 0.09, cached: 0.018, output: 0.18 }
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
| `model` | `provider/model` | The model `/task` and an ad-hoc schedule use by default. `/defaults tasks` changes it from the chat. |

## `judge`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `model` | `provider/model` | — | The **loop checker's** model, for the projects with `limits.loop_check_steps` set. Without one, there is no loop check. A model different from the projects' own is best: it reads a short page of facts and answers one line, so it costs little. `/defaults judge` changes it from the chat. |
| `timeout_s` | int | `60` | How long it may take; no answer in time decides nothing, and the run goes on. |

## `orchestrator`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether the front desk is mounted. |
| `model` | `provider/model` | — | **Use a cheap one**: it runs on every free-text message. `/defaults frontdesk` changes it from the chat. |
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
| `unattended_timeout_s` | int | `0` | How long a **scheduled** run waits for an answer. `0`: nobody is asked; the action is refused at once and the chat is told, with the rule that would allow it. |

A question about a single command or a page fetch in a project also offers **Always
allow**: the admin's press adds that exact command to the project's
`approvals.auto_allow` (or the site to `tools.web_hosts`), through `/set`. Anyone
else's press approves once. When the same action was approved by someone twice already
in the last 7 days, the question says so. [`/rule`](commands.md#rule-project-id-command--host-host--admin)
adds such a rule by hand.
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

A project's [instructions](#instructionsmd--what-the-project-is-told) are separate: they
are in the system prompt, not in this budget, and have their own 8 KB limit.

## `snapshots` — undo

Before each run of a project Argus records its folder, so
[`/undo`](commands.md#undo-project-id-list----run-id) can put it back.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether a snapshot is taken before each run. Off, `/undo` is off. |
| `keep_days` | int | `14` | How long a snapshot is kept (1–365). |
| `max_file_mb` | int | `20` | Larger files are not recorded, and an undo leaves them alone. |

The snapshots live in `${DATA_DIR}/state/<project>/snapshots.git`, a git repository
outside the project's folder that the agent cannot reach. A file's content is stored
once however many snapshots have it, so a run that changes little costs little; the
daily report's disk line says how much they take. Never recorded: `node_modules`,
`.venv`, `dist`, what the project's `.gitignore` lists, and what an `.argusignore` file
in the project's folder lists (the same syntax). They are left out of the backups.
They need `git` (in the Docker image; a prerequisite of the native install).

## `web`

The [web interface](web.md).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether it is served. |
| `port` | int | `3091` | Its port, on the server's loopback (Docker publishes it on the host's `127.0.0.1` only). |
| `public_url` | string | `http://127.0.0.1:<port>` | The address you open it at, for the `/web` link: the `tailscale serve` address, for example. With `https://`, the session cookie is sent only over HTTPS. |
| `session_hours` | int | `24` | How long a sign-in lasts. |
| `public` | boolean | `false` | [Public mode](web.md#public-mode): behind a reverse proxy with HTTPS, every sign-in needs an authenticator code, the cookie is always `Secure`, HSTS is sent. `argus doctor` fails without an `https://` `public_url`. |
| `idle_minutes` | int | `30` | In public mode, how long an unused session lasts (5 to 1440). |
| `max_upload_mb` | int | `2048` | The largest file a project's page [uploads](web.md#large-files) into its `inbox/`. |
| `download_link_hours` | int | `24` | How long the link for a file too big for a chat stays valid (1 to 168). |
| `tailscale_identity` | boolean | `false` | [Sign in by Tailscale identity](web.md#reach-it): a request through `tailscale serve` carrying a Tailscale login linked to a user (`/users tailscale`) signs them in, no password. Ignored in public mode. |
| `trusted_proxies` | list of addresses | `[]` | Where a Tailscale identity is trusted from, besides the server itself and, in Docker, the container's gateway. |

## `web_search` — who answers the agents' searches

Which provider answers `web_search`, for every project, task and the front desk.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `deepseek`, `tavily`, `brave`, `serper` or `searxng` | `deepseek` | Who answers. Each but SearXNG needs its key: `/key tavily <key>`, `/key brave <key>`, `/key serper <key>`, `/key deepseek <key>`. |
| `searxng_url` | string | | SearXNG's address, for `provider: searxng`, e.g. `http://searxng:8080`. |
| `price_usd` | number | the provider's list price | What one search is charged in the budget: Tavily $0.008, Brave $0.005, Serper $0.001, SearXNG $0. Set `0` while you are inside a provider's free tier. |

```yaml
web_search:
  provider: tavily
  price_usd: 0   # inside Tavily's 1,000 free searches a month
```

- **DeepSeek** (the default) is charged by its tokens, an upper bound of about a cent a
  search with DeepSeek V4 Flash. It shares the key of DeepSeek's models.
- **Tavily** returns sources made for an agent, plus a short answer; 1,000 searches a
  month are free. **Brave** has its own index and $5 of free searches a month.
  **Serper** returns Google's results and is the cheapest per search.
- **SearXNG** is free and private: it runs next to Argus and asks the search engines
  itself. With Docker, add `SEARXNG_SECRET=<random>` (`openssl rand -hex 32`) to `.env`
  and set `searxng_url: http://searxng:8080`; `argus upgrade` then starts it
  (`deploy/compose/docker-compose.searxng.yml`). On a native install, point
  `searxng_url` at any SearXNG with `format: json` enabled. A busy search engine may
  refuse SearXNG for a while; it answers from the others.

A change takes effect after a restart (`docker restart argus-agent`, or `sudo systemctl
restart argus-agent` natively; with SearXNG newly added, `argus upgrade`). `/tools <project>` and
`argus doctor` say which provider answers and whether it can: a provider without its key
makes every search fail, with a message that says so.

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
  max_steps_total: 300
  loop_check_steps: 50       # 0: no loop check
  on_loop: notify            # stop | notify | ask

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
    - npm test
    - docker logs *
  timeout_minutes: 30

tools:
  read: allow                # off | deny | ask | allow
  write: ask
  shell: ask
  web: ask
  agents: off                # also ask_project
  other: ask                 # deny | ask | allow
  web_hosts: [news.ycombinator.com]
  exceptions:                # one tool over its group
    web_search: allow

mcp: {}                      # MCP servers, by name; see below

memory:
  user_profile: true

progress: true
```

`/new <id> <template>` writes such a file for you; the
[template](#templates--your-own-kinds-of-project) fills the `tools` and `approvals`.

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
| `npm test` | `npm test`, `npm test -- --watch` | `npm install`, `npm test src` |
| `docker logs *` | `docker logs web-1`, `docker logs web-1 --tail 50` | `docker rm web-1` |

Without `*`, a rule takes options after it (`--short`) but no further words: `npm test`
does not match `npm test src`. **A `*` at the end** takes any further arguments. It may
only end a rule; one anywhere else is refused when the project loads.

**A compound command is refused however neatly its prefix matches.** `npm test; rm -rf
/`, `npm test && rm -rf /` and `npm test` with `rm -rf /` on the next line do not match
the rule `npm test`, because the match is on the whole parsed command rather than on a
string prefix. Under `*`, an argument with a shell character glued to it (`x;rm`,
`x|sh`, `$(…)`) is refused too.

**Commands that only read need no rule.** `ls`, `pwd`, `date`, `stat`, `du`, `df`,
`wc`, `cat`, `head`, `tail`, `grep`, `find`, `uptime`, `free`, `ps`, `id`, `whoami` and
`uname` count as reads (the `read` group, `allow` by default), not as shell commands:
the [sandbox](security.md#sandbox) lets them read only the project's folder and the
system. Their forms that write or run something else (`find -delete`, `find -exec`,
`date -s`, a redirection `>`) are shell commands as before. `git` is not on the list:
even `git status` runs what the repository's own configuration names, and the agent
can write that.

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
| `read` | `read`, `read_image`, `glob`, `grep`, and the MCP resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) | `allow` |
| `write` | `write`, `edit` | `ask` |
| `shell` | `bash`, `pwsh`, `run_code` | `ask` |
| `web` | `web_fetch`, `web_search` (answered by the [`web_search`](#web_search--who-answers-the-agents-searches) provider, and charged to the project) | `ask` |
| `agents` | `subagent`, `workflow`, `ralph`, `send_message`, `interrupt_agent`, `list_agents`, `list_subagent_models`, `ask_project` | `off` |
| `git` | `git_clone`, `git_pull`, `git_push`, on the project's [remotes](#git--remotes-argus-clones-pulls-and-pushes) | `ask` |
| `mail` | `send_mail`, with the project's [mail account](#mail--who-a-project-may-write-to). `off`, `deny` or `ask`, never `allow`: a mail goes unasked only to [trusted recipients](#sending-unasked-to-trusted-recipients) within their counts; every other is shown to a person | `ask` (`off` in a one-off task) |
| `mail_read` | `mail_list`, `mail_read`, `mail_save_attachment`, `mail_mark_read`, in the project's [mailbox](#reading-a-mailbox-imap); shown only to a project that has one | `allow` (`off` in a one-off task) |
| `other` | any tool not listed: a newer dsh's, an integration's | `ask` (never `off`) |

**A read or write outside the project's folder asks even under `allow`**, and is
refused under `deny`. `web_hosts` lists sites `web_fetch` reaches unasked when `web` is
`ask`; an entry covers its subdomains, so `ycombinator.com` covers
`news.ycombinator.com`, and `*.substack.com` covers the subdomains only, not
`substack.com`. An entry that is not a host name (a URL, a `*` elsewhere) is refused
when the project loads. A search has no site, so it still asks.

**`web_fetch` never reaches a private address**, whatever the rules say: the server
itself (`localhost`, `127.0.0.1`), the private network (`10.x`, `192.168.x`, …), a cloud
metadata service (`169.254.169.254`) and their IPv6 forms are refused, by IP or by a name
that resolves to one, and a redirect cannot leave the site. So `web: allow` is safe for
reading the public web.

The bookkeeping tools (the agent's todo list, goals, background jobs, skills,
`present`) and `send_file` are always allowed; a file the agent `present`s is sent to the
chat as `send_file` sends it. A misspelt group is refused when the
project loads. A one-off task (`/task`) has no file: it reads, searches the web, and
nothing else; what would ask is refused while `approvals_adhoc` is `deny`.

**These are rules for tools, not a sandbox.** With `shell: allow`, or `curl` in
`auto_allow`, the agent reaches the network whatever `web` says. Allowing both `web` and
`shell` in one project also lets a page the agent read steer the commands it runs; do it
only for a project you trust with both. `argus doctor` warns about such a project.

**One tool can differ from its group.** `exceptions` names tools and their access, which
wins over the group, the always-allowed tools included:

```yaml
tools:
  web: ask
  exceptions:
    web_search: allow     # searching is fine; fetching a page still asks
    edit: deny            # it may write new files, never edit existing ones
    todo_write: off       # not even offered
```

`/tools <project>` shows a project's table; `/set <project> tools.web allow` changes it,
and `/set <project> tools.exceptions.web_search allow` sets one exception.

### `ask_project` — one project asks another

With `tools.agents` set to `ask` or `allow`, a project's agent can ask another project a
question and wait for the answer (`ask_project`): the research project asks the site
project which pages exist, the reports project asks devops for last night's disk usage.

- The question is an ordinary request to the other project: it waits for a slot, runs
  in that project's folder with its memory, and is paid from **that project's** budget.
  It is refused when the asking project's own budget is used up.
- The answer goes back to the asking agent, not to the chat; `/runs` and `/log` of the
  other project show it.
- A project that is answering a question cannot ask one, so two projects cannot keep
  each other busy.
- It waits at most 45 minutes for the answer.

With `agents: ask`, every question is an approval first.

### `mcp` — external tools through MCP servers

An [MCP](https://modelcontextprotocol.io) server gives the agent tools from another
system: GitHub issues, a database, a calendar, a browser. A project lists its servers by
name; each is a local program (`command`) or a remote one (`url`):

```yaml
mcp:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}"
    access: ask
  docs:
    url: https://mcp.example.com/mcp
    headers:
      Authorization: "Bearer ${DOCS_TOKEN}"
    access: ask
    tools:
      read_*: allow
      delete_*: deny
    timeout_s: 120
```

| Field | Meaning | Default |
|---|---|---|
| name (the key) | lowercase letters, digits and dashes, up to 32; the tools appear as `mcp__<name>__<tool>` | — |
| `command`, `args`, `env` | a local program, started in the project's folder | — |
| `url`, `headers` | a remote server (Streamable HTTP) | — |
| `oauth` | it signs in with OAuth: `client` (under `oauth_clients`; none when it registers Argus itself) and `scopes`; see [below](#a-remote-server-that-signs-in-oauth) | — |
| `access` | `deny`, `ask` or `allow` for every tool of the server that `tools` does not name | `ask` |
| `tools` | per tool: its name, or a glob with `*` and `?` (letters, digits, `_`, `-`), to `deny`, `ask` or `allow` | none |
| `timeout_s` | how long one call may take | `60` |

**Access per tool.** The most specific key of `tools` that matches a tool decides: its
exact name, then the glob with the most letters, then, on a tie, the stricter access.
Above, `read_doc` runs unasked, `delete_page` is refused, and anything else asks. The
order does not matter, so an extension's defaults and your own keys mix predictably.
`/set <project> mcp.docs.tools.update_doc allow` adds or changes one; `/tools <project>`
lists them, and a refusal or a question names the key that decided.

**Secrets are never written in the file.** Write `${NAME}` and save the value with
`/key NAME value` in the chat (your message is deleted at once), or set `NAME` in the
server's `.env`. A server whose secret is not set is left out, with a warning in the log;
the project runs without it.

The agent connects when it is built. After you add a server or change how to reach it,
the project's agent is rebuilt at its next message, in the same conversation (a run in
progress finishes first). A change of `access` or `tools` (`/set <project>
mcp.github.access allow`) applies to the next call. `/tools <project>` lists the servers. One-off tasks and the
front desk have no MCP servers.

**A local server runs confined**, in the command sandbox, or not at all:

- it reads the system (`/usr`, `/opt`, `/etc`…) and, for an extension's, the
  extension's folder; a program elsewhere (`/srv/…`, your home) cannot start. Install it
  under `/opt`, run it with `npx` or `uvx`, or ship it as an [extension](extensions.md);
- it reads and writes the project's folder, where it starts;
- it keeps what it stores (logins, caches, what `npx` and `uvx` download) in a home of
  its own, `state/<project>/mcp/<server>/`, which the agent's shell cannot read; `/mcp
  reset <project> <server>` empties it;
- it has the network;
- it gets only the variables in its `env` (dsh removes every inherited variable that
  looks like a key, token or password).

**`${ARGUS_EGRESS_PROXY}`** in a server's `env` is the address of Argus's egress proxy,
a proxy on `127.0.0.1` that reaches the public internet only: it refuses the server
itself, the private network, link-local addresses and the cloud's metadata service,
after resolving the name, as `web_fetch` does. A browser started with it as its proxy
(the [`browser` extension](extensions.md#the-first-party-ones) does) cannot be steered by
a page into your network.

In the Docker image `npx` and `uvx` are available.

#### A remote server that signs in (OAuth)

Notion, Linear, Atlassian, Google Workspace, Slack and others sign in with OAuth rather
than a fixed key. Give the server an `oauth:` block, then connect it once per project:

```yaml
mcp:
  notion:
    url: https://mcp.notion.com/mcp
    oauth: {}                    # Notion registers Argus itself: nothing else to set
  gdocs:
    url: https://docsmcp.googleapis.com/mcp/v1
    oauth:
      client: google             # a client you registered, under oauth_clients in ops.yaml
      scopes: [https://www.googleapis.com/auth/documents, https://www.googleapis.com/auth/drive.file]
    tools: { read_doc: allow }
```

`/mcp connect <project> <server>` answers with a link to the web. Open it signed in as the
admin: it goes to the provider, where you sign in with the account this project should
use, and back to `<web.public_url>/oauth/callback`. From the project's next message its
agent has the server's tools.

- **Argus holds the grant**, per project and per server, in the credentials store. The
  agent, its shell, its prompt and the conversation never see a token: dsh talks to a
  proxy on `127.0.0.1` that adds a fresh one to each request, and refreshes it when it
  expires, in the middle of a run too.
- **A refused grant** (revoked at the provider, a password changed) signs the server out:
  its tools tell the agent to ask you, Argus tells the admin, and `/mcp connect` again
  fixes it. `/tools <project>` and `argus doctor` show each server's state.
- **`/mcp disconnect <project> <server>`** revokes the grant at the provider when it says
  how, and forgets it.
- `scopes` are what the project may do; ask for the fewest. Without them, the provider's
  default applies.
- The `oauth:` block is for remote servers (`url`) only, and replaces an `Authorization`
  header. A local server that signs in by itself (`npx …`) keeps its login in its own
  home instead.

**When the provider needs a client of yours.** Google, Slack and Microsoft do not let a
client register itself. Register one there once, as a *web application*, with
`<web.public_url>/oauth/callback` among its redirect URIs, and declare it in `ops.yaml`:

```yaml
oauth_clients:
  google:
    preset: google               # Google gives a refresh token only when asked: this asks
    client_id: 1234-abc.apps.googleusercontent.com
    client_secret: ${GOOGLE_OAUTH_CLIENT_SECRET}   # /key GOOGLE_OAUTH_CLIENT_SECRET …
  slack:
    client_id: "123.456"
    client_secret: ${SLACK_OAUTH_CLIENT_SECRET}
  entra:                         # a provider that does not publish its endpoints
    client_id: …
    client_secret: ${ENTRA_CLIENT_SECRET}
    authorization_url: https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize
    token_url: https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
```

| Field | Meaning |
|---|---|
| `client_id` | the client's id |
| `client_secret` | `${NAME}`, the secret saved with `/key NAME …`; never written in the file |
| `preset` | `google` (asks for offline access, so the grant lasts) or `slack` |
| `authorization_url`, `token_url`, `revocation_url` | only for a provider that does not publish them; otherwise they are found from the server |

Google's Workspace servers are for Workspace accounts (not personal Gmail), in its
Developer Preview; Slack's need an app with MCP turned on. Neither has been checked live
with Argus yet: the flow is the MCP standard's, tested against a fake provider and live
with Notion.

### `git` — remotes Argus clones, pulls and pushes

```yaml
git:
  remotes:
    origin:
      url: https://github.com/acme/site.git
    mirror:
      url: https://gitlab.com/acme/site.git
      protected: []          # default [main, master]
```

A project's agent works on a repository in its folder like on any other files: `git
status`, `diff`, `commit` and `branch` are ordinary commands. **What needs the remote
and its token, Argus does**, when the agent asks:

| Tool | What happens |
|---|---|
| `git_clone` | The remote is cloned into the project's folder (`into`, default the repository's name). |
| `git_pull` | The remote's branches arrive as `refs/remotes/<remote>/*`; the agent merges or rebases them itself. |
| `git_push` | A branch goes to the remote, as a fast-forward. A **protected** branch is refused; so is a push that would overwrite someone else's commits (no force push). |

Each remote has **its own token**, which only the admin sets, with `/git token <project>
<remote> <token>` in the chat (the message is deleted at once) or on the project's
page on the web. It is never in the file, and it never reaches the agent, its commands
or the conversation: Argus uses it only for its own git process, as a header, for that
remote's host. Two projects can push to repositories of two different accounts, and no
project can use another's token. Use a token that can reach only that repository: a
GitHub fine-grained token, a GitLab project access token.

| Field | Meaning | Default |
|---|---|---|
| name (the key) | lowercase letters, digits and dashes, up to 32 | — |
| `url` | `https://` only, with no user or token in it | — |
| `protected` | branches `git_push` refuses | `[main, master]` |

**A push asks first** (the `git` group is `ask`), and the question shows exactly what
goes: the commits, their messages and the files changed. That commit is what is pushed,
or nothing: if the branch moved while the question waited, the push is refused and asked
again. `/set <project> tools.git allow` lets a project push unasked; `tools.exceptions.git_pull
allow` lets it pull unasked and still ask for pushes.

A public repository needs no token to clone or pull. Changing a remote's URL
(`/git remote`) forgets its token; archiving the project forgets all of them. `/undo`
puts the files back, not the commits or the pushes. A server with its own certificate
authority is trusted when the service has `GIT_SSL_CAINFO` set to its CA file.

### `mail` — who a project may write to

A project sends mail with `send_mail`, and Argus sends it: the account (an SMTP server,
its user and password) is set by the admin with [`/mail`](commands.md#mail), kept in
the credentials store, and never reaches the agent, its shell or the conversation. The
project's file says who it may write to and how much:

```yaml
mail:
  allowed_recipients: [ana@acme.ro, "@client.com"]   # an address, or anyone at a domain
  from: office@acme.ro        # default: the account's user
  max_per_day: 20             # recipients in any 24 hours, asked or not (1-500)
  max_attachment_mb: 20       # the attachments of one mail, together (1-50)
```

- **Nobody is allowed until you list them.** A recipient outside `allowed_recipients` and
  `trusted_recipients` (in `to`, `cc` or `bcc`) is refused before anyone is asked.
- **A mail is shown first**, whole, unless every recipient is
  [trusted](#sending-unasked-to-trusted-recipients) and within its count: from, to, cc,
  bcc, subject, the attachments with their sizes, and the text (cut after 3,000
  characters in the chat; the web shows all). The buttons are Approve and Deny only: no
  "for this run", no "always", and no rule or template makes `send_mail` run unasked.
- **An asked mail waits in the outbox; nothing waits for it.** `send_mail` answers at
  once ("it waits in the outbox as #12"), and the run goes on or ends, freeing its
  project and its slot, scheduled runs included. The question is asked where the run's
  answer goes, and in the web's inbox. Approve sends the mail; Deny, or no answer within
  the approvals timeout, drops it; either way you are told. A restart of Argus drops what
  waits (send it again). `/mail outbox <project>` shows what waits and what was decided.
- **Recipients are counted, not mails**: one mail to three people uses three of
  `max_per_day`, the ceiling for every mail, asked or not.
- **What goes is what was shown.** The outbox keeps a copy of the attachments as they
  were shown, so a file changed afterwards does not change the mail; and an approved mail
  is checked against the project's file again, so a recipient removed since is not
  written to.
- **Attachments are files in the project's folder**: not a link, not a file outside it.
- One account per project, or a default for all (`/mail set default …`); a project's own
  wins. TLS is required (`smtps://`, or `smtp://` with STARTTLS), with the server's
  certificate checked. Every send is in the audit log (`mail.send`), with its recipients,
  whether it went unasked or approved, and the attachments' names and sizes, never the
  text or the password.
- **Every mail is marked as automatic** (`Auto-Submitted: auto-generated`, and
  `X-Argus-Project`), so an auto-responder does not answer it.

#### Sending unasked to trusted recipients

For a mail that should go without a question, a daily report to you for instance, list
its recipients as trusted, each with how many mails a day it may get unasked:

```yaml
mail:
  trusted_recipients:         # exact addresses only, never a domain
    romeo@acme.ro: 2          # mails a day this address may get unasked (1-100)
    contabil@acme.ro: 1
  unattended_per_day: 10      # unasked recipients in any 24 hours, all together (1-500)
  on_limit: ask               # past a limit: ask (default), or block
```

- A mail goes unasked only when **every** recipient is trusted, each is under its own
  count, and the total stays under `unattended_per_day`. A mail with anyone else in it
  is asked about as usual.
- **Past a limit**, `on_limit: ask` asks a person (the question says which limit), and
  `block` refuses. `max_per_day` refuses whatever `on_limit` says.
- Counts are recipients over the last 24 hours, rolling. An approved mail uses
  `max_per_day`, not the trusted counts.
- **`/mail pause <project|all>`** stops unasked mail until `/mail resume`: each mail is
  asked about (or refused, with `block`). After **3 unasked mails in a row fail** at the
  mail server, the project pauses itself and the admin is told.

#### Replies

`send_mail` with `reply_to: INBOX:4521` answers a mail of the project's
[mailbox](#reading-a-mailbox-imap): it goes only to that mail's sender (who must be
allowed or trusted, as for any mail), with `Re:` and the thread's headers. A mail is
**never answered** when it was sent automatically (`Auto-Submitted`), by Argus, by a
mailing list (`List-Id`, `Precedence: bulk`), by a `noreply` or `mailer-daemon` address,
or from the project's own address, so two automatic senders never write to each other
without end.

#### Reading a mailbox (IMAP)

A project can also read a mailbox. The admin sets it like the SMTP account, with an
`imaps://` URL: `/mail set <project> imaps://comenzi%40acme.ro:…@mail.acme.ro:993`, or
`/mail set default imaps://…` for every project with none of its own. For Gmail or
Outlook, use an app password. The project's agent then has, from its next message:

| Tool | Does |
|---|---|
| `mail_list` | the newest mails of a folder: id (`INBOX:4521`), date, sender, subject, read or not, size, attachments; filters `unread_only`, `since`, `from`, up to 50 |
| `mail_read` | one mail: sender, recipients, subject, its text (HTML turned into text, cut after 50,000 characters), its attachments' names and sizes. Reading does not mark it as read |
| `mail_save_attachment` | one attachment into the project's folder, under `mail/<date>-<id>/` |
| `mail_mark_read` | marks a mail as read |

```yaml
mail:
  read_folders: [INBOX, Comenzi]   # the folders it may read (default: INBOX)
```

- **It cannot delete, move or send.** Reading, saving an attachment and marking as read
  are all it does; nothing else in the mailbox changes.
- **A mail is information, not instructions.** What a mail says reaches the agent inside
  a frame that tells it so: a mail asking it to send something somewhere is not your
  request, and `send_mail` still writes only to the project's recipients, with a person
  approving each mail that is not to a trusted one.
- **Only the listed folders**, and a mail larger than `max_attachment_mb` is not read.
- The password stays in the credentials store; Argus signs in over TLS (certificates
  checked) for each call and signs out. Each call is in the audit (`mail.read`: the tool,
  the folder, how many), never what a mail says.
- `tools.mail_read` is `allow` by default (a project with a mailbox may read it); `ask`
  or `off` like any group. A project without a mailbox does not see the tools.

### `extensions` — tools, skills and instructions installed once

```yaml
extensions: [office]
```

Each name is an [extension](extensions.md) the admin installed. The project's agent gets
its MCP servers (run confined to the project's folder), its skills and its instructions.
`/ext enable <project> <name>` and `/ext disable` write this list. Its servers appear under
`mcp` with the extension's access and tool rules; the project's file may set only their
`access`, `tools` and `timeout_s` (`/set <project> mcp.office.access ask`); a key of
`tools` it sets replaces the extension's same key, and the others stay. A name that is not installed, or
whose files changed, is left out, and `argus doctor` says so; the project still runs.
A template may list extensions too.

### `delegate` — an agent an extension runs for the project

```yaml
delegate:
  max_turns: 50     # turns one call may take
  max_minutes: 30   # minutes one call may take
  day_turns: 300    # turns all calls may take in a day, across the project
```

An extension such as `claude-code` runs another agent for the project when the project's
agent hands it a task. These are its limits, set by the admin (`/set <project>
delegate.max_turns 80`); the project's agent cannot raise them. Each of that agent's tool
calls is decided like the project agent's own (its `tools`, `web_hosts`,
`approvals.auto_allow`, the same questions); its steps are watched for loops with
`limits.loop_repeat_threshold`, and a loop stops it, not the run: the project's agent is
told why. A cancel, a stop or the run's end stops it too, and a question it still waits
for is withdrawn. It runs on your own subscription: its turns cost nothing against the
budgets, and the Costs page shows beside them what they would have cost at API prices.

### `INSTRUCTIONS.md` — what the project is told

What the project is for and how it should work, in your words: its role, the rules it
keeps, how to answer. They hold for every conversation and survive `/reset`; the
agent's own notes are its memory, which it writes itself.

They are in `<data_dir>/state/<id>/INSTRUCTIONS.md`, beside its
`MEMORY.md` and outside its folder, so its agent can read them in its prompt but not
change them. They are read on every request: edit them with
[`/instructions`](commands.md#instructions-project-id--project-id-text), on the web's
Settings page, or in the file, and the next request uses them. Up to 8 KB.

### Templates — your own kinds of project

`/new <id> <template>` starts a project from a template. Four are built in (`site`,
`research`, `reports`, `devops`, listed in
[`/new`](commands.md#new-id-template-providermodel)); a file
`<data_dir>/config/templates/<name>.yaml` adds one, or replaces a built-in of the
same name:

```yaml
summary: the online shop            # the line /new shows
description: Runs the online shop: products, orders and the newsletter.
instructions: |
  Answer in Romanian.
  Never change a price without asking.
tools:
  web: allow
approvals:
  auto_allow: ["ls"]
```

Everything other than `summary`, `description` and `instructions` is a project
setting, so any project setting can be in a template. `id`, `cwd`, `provider` and
`model` cannot: `/new` sets them. The description and the instructions are written once,
when the project is made; the instructions are the project's own from then on.

**A project made from a template follows it.** `/new` writes only this:

```yaml
id: shop-ro
cwd: /var/lib/argus-agent/projects/shop-ro
template: shop
description: Runs the online shop: products, orders and the newsletter.
provider: deepseek
model: deepseek-flash
```

Its settings are the template's, with whatever its own file sets over them:

- a block (`tools`, `limits`, `budget`, `approvals`, `mcp`, …) is merged key by key, so
  `tools: {shell: allow}` changes the shell and leaves the other groups to the template;
- anything else the file sets replaces the template's value, a list included: a
  project's own `approvals.auto_allow` or `tools.web_hosts` is the whole list, so it can
  drop a rule the template has.

What the file does not set follows later edits of the template, at the next `/reload`.
[`/tools`](commands.md#tools-project-id) marks the values that come from the template,
and [`/template <name>`](commands.md#template-name) shows a template and the projects
that follow it. `/set <id> template none` writes the template's settings into the file
and ends the link; the project behaves exactly as before.

A project whose `template:` names no template does not load (it is ignored, not
archived, until fixed). `argus doctor` names a template file that does not read, a value
no project could hold, and a key that is not a project setting. Projects made before
0.5.0 have no `template:` key and hold all their settings: they are unchanged.

### Precedence

```
project budget   ▸  deployment default       (budget, limits)
project approvals ▸  deployment approvals    (mode, auto_allow)
project tools     ▸  built-in defaults       (read, write, shell, web, agents, other)
project mcp       ▸  (none)                  (only a project has MCP servers)
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
