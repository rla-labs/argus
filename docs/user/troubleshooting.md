# Troubleshooting

Symptom → check → fix.

**Start with [the five checks](#five-checks-that-answer-most-reports)** at the bottom
of this page: they answer most reports. After them, [Start here](#start-here) covers
the system that does nothing at all, and [By symptom](#by-symptom) the rest.

## Start here

### Nothing happens at all

| Check | Fix |
|---|---|
| `docker compose ps` | Not running: `docker compose logs --tail=100 ops` |
| `grep 'startup failed'` | A required plugin did not activate. The log names it and the package. |
| The `Argus Agent <version> started` line | Absent means the process never got to a running state |
| `curl http://127.0.0.1:3090/health` **inside** the container | 503 means `down`; the report names the problem |

### The bot is silent

| Check | Fix |
|---|---|
| `grep 'telegram connected'` | Absent: the adapter never reached Telegram. The next log line says why. |
| `grep 'bot_token'` | A warning naming `TELEGRAM_BOT_TOKEN` means the variable is unset or unexpanded |
| Is your user id `access.admin`, or in `access.allowed_users` for `channel: telegram`? | The most common cause of a bot that works but ignores you |
| `grep 'channel.refused'` | The audit row names the id it saw — put **that** in the allowlist |
| `/health` → `opsChannel` | `degraded` with "a channel adapter failed to start: …" names the Telegram error; a 401 is a wrong token |

### A message got no reply

| Check | Fix |
|---|---|
| Is a project active? | `/p <id>`, or free text goes to the orchestrator |
| `grep 'the orchestrator failed'` | The turn threw; the message has it |
| `/status <project>` | The run may still be queued |
| `grep 'the run produced no output'` | A provider error, or the project produced nothing |

## By symptom

### "My schedule didn't run"

| Check | Fix |
|---|---|
| `/cron list` — does it exist, is it `on`? | `/cron enable <id>` |
| `/cron list` — is the next run in the past? | The timer should have fired it; check the log |
| `grep 'skipped' \| grep <id>` | `overlap` = the previous run is still going; `paused` = the project is paused |
| `grep 'missed a window'` | A restart skipped or fired it once, per the misfire policy |
| Is the timezone what you think? | The next run is rendered in UTC; the schedule's own timezone is per row |

**An overlap is not notified.** It is logged and counted, because a periodic overlap
would flood the chat.

### "The project forgot something"

| Check | Fix |
|---|---|
| `cat ${data_dir}/state/<id>/MEMORY.md` | The fact is there, or the agent never wrote it down |
| `grep 'memory.updated'` | No row means the agent never called `memory_update` |
| `grep 'was truncated: omitted'` | **The agent did not receive that section.** Condense the memory. |
| `grep 'injection failed'` | The agent started without its memory |

**Memory is only what the agent explicitly wrote.** A fact that was discussed but
never recorded is gone after a reset.

### A risky action was refused

| Check | Fix |
|---|---|
| `grep 'refused without asking'` | The project's `mode: deny`, or not allow-listed |
| `SELECT * FROM approvals ORDER BY created_at DESC LIMIT 5` | The `status` says what happened |
| `decided_at` vs `created_at` | A press **after** the timeout changes nothing |
| Is the answering user allow-listed? | The channel checks the allowlist on the answer path too |

### "It cannot find the right project"

| Check | Fix |
|---|---|
| The orchestrator's `list_projects` output | Is the project there with a **description**? |
| Is the description just the id? | A model cannot infer purpose from a name |
| Was a project already active? | Free text with an active project never reaches the orchestrator |

### Costs are climbing

| Check | Fix |
|---|---|
| `/usage` | Which project, and which model |
| `grep 'budget-threshold'` | The soft threshold fired; check `soft_action` |
| The `orchestrator` scope | It runs on **every** free-text message; lower `orchestrator.day_usd` |
| `grep 'ops/model-downgraded'` | A project at its soft threshold switched to its fallback |

### A run will not stop

| Check | Fix |
|---|---|
| `/stop <project>` | Cancels the current turn |
| `/status` | Is it running, or queued? |
| `/panic` | Cancels everything and refuses new work — needs confirmation |
| `/resume-all` | Undoes the panic |

### Work was lost after a restart

| Check | Fix |
|---|---|
| The startup report message | It names every interrupted run |
| The Retry buttons | Each resubmits the **original** request |
| `SELECT * FROM runs WHERE status = 'interrupted'` | The full set |
| `grep 'were left running by a previous process'` | Recovery found the crash |

### The container keeps restarting

| Check | Fix |
|---|---|
| `curl http://127.0.0.1:3090/health` inside the container | 503 means `down` |
| The report's `problems` | The named subsystem is the cause |
| `grep 'health endpoint did not start'` | A port already in use: the healthcheck reaches a **different** process |
| Is the healthcheck accepting 200? | **`degraded` returns 200 by design.** A check that requires 200-only is fine; one that fails on any non-200 is misconfigured. |

### Disk is filling

| Check | Fix |
|---|---|
| The daily report's disk line | Percentage and free space |
| `du -sh ${data_dir}/*` | Which part |
| `ls ${data_dir}/backups` | Lower `health.backup_keep` |
| `${data_dir}/state/*/recall.sqlite` | Derived state: **delete it and it rebuilds** |

## Five checks that answer most reports

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

## What is NOT a fault

Worth knowing, because these generate reports:

| Looks wrong | Actually |
|---|---|
| A message arrived twice | The platform redelivered; the channel deduplicated it. One was ignored. |
| A schedule was skipped | An overlap (the previous run was still going) or a paused project |
| A long answer arrived as a `.md` file | It exceeded the adapter's limit; the full text is in the file |
| A project asked for approval and got none | Nobody answered in the timeout — **no answer means no**, by design |
| The orchestrator forgot yesterday | `reset_daily: true`: a bounded context, deliberately |
| A `degraded` health status | Something worth a look, not a failure |
