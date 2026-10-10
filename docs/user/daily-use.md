# Working with Argus every day

This guide covers using Argus once it is installed, from the chat. It does not repeat
the [command reference](commands.md). It explains which command fits which moment,
the habits that keep the bill low and the agents useful, and what to do when something
looks wrong.

- [The mental model](#the-mental-model)
- [A day with Argus](#a-day-with-argus)
- [Talking to projects](#talking-to-projects)
- [One-off tasks and the front desk](#one-off-tasks-and-the-front-desk)
- [Keeping costs under control](#keeping-costs-under-control)
- [Approvals without the noise](#approvals-without-the-noise)
- [Scheduled work](#scheduled-work)
- [Memory, files and history](#memory-files-and-history)
- [Changing a project](#changing-a-project)
- [When something goes wrong](#when-something-goes-wrong)
- [Sharing the bot](#sharing-the-bot)
- [Commands by situation](#commands-by-situation)
- [Habits that pay off](#habits-that-pay-off)

---

## The mental model

Three kinds of work, three ways in:

| Kind | What it is | How you start it |
|---|---|---|
| **A project** | A long-lived agent with its own folder, model, memory, budget and conversation | `/new <id>` once; then make it active with `/p <id>` and write to it |
| **A one-off task** | A throw-away agent in a scratch folder, no memory | `/task <text>` |
| **A schedule** | A project prompt or a task that fires on a cron expression | `/cron add ...` |

Two rules explain most of the behaviour:

1. **A slash command is code; anything else goes to an agent.** `/status`, `/stop`,
   `/budget` and the rest never call a model. They answer instantly, cost nothing, and
   still work when a provider is down. A message without a slash is given to an agent
   word for word.
2. **Every chat has an active project.** Set it with `/p <id>`. Plain messages go to it,
   and every command that takes an optional project uses it. With no active project, a
   plain message goes to the front desk (when one is installed), which routes it.

---

## A day with Argus

**In the morning,** the daily report arrives at `health.daily_report_time` (09:00 by
default, in your `timezone`). A quiet day is four lines. Read three things in it:

- **Cost today:** the total, and the projects that spent it.
- **Runs:** a run that ended in `error` is worth a `/runs <project>`.
- **The "All clear" line,** or the sections that replace it: a budget near its limit, a
  schedule that was skipped, errors from a provider.

When a line needs a closer look:

```
/status                 what is running and what is queued, right now
/usage global day       the cost of the day, by project and by model
/runs site-firma        what that project did and how each run ended
/log site-firma         the latest run, step by step: what it ran, what it replied
```

**During the day,** work happens in whichever project the chat points at:

```
/p site-firma
the contact form returns a 500 since this morning, find out why and fix it
```

The answer comes back to the same chat, prefixed with `[site-firma]` so you always know
which project is speaking (`[task]` for a one-off task). While the agent works, any action that needs approval arrives as a
question with buttons. If you send a second message before the first one finishes, it
is queued and the agent reads it next. It does not interrupt.

**Before leaving it alone,** check two things: `/approvals` (nothing should be left
waiting), and `/status` (nothing unexpected running). Approvals left unanswered are
refused when they time out, so leaving one open is safe; the work just stops at that
step.

---

## Talking to projects

**Switch with `/p`, not by naming the project in the message.** `/p reports` and then
`summarize last week` is unambiguous. `reports: summarize last week` with another
project active goes to the active project, verbatim, and that project gets a message
about a project it has never heard of.

**Your words reach the agent unchanged.** Nothing rewrites or "improves" what you send,
so write the instruction you mean: the outcome you want, the constraint that matters,
and how you will judge it done.

| Instead of | Write |
|---|---|
| `fix the site` | `the contact form returns 500 since this morning; find the cause, fix it, and tell me what you changed` |
| `check stuff` | `check that the nightly export ran and that the CSV has today's rows` |
| `make the report` | `write the weekly report as reports/week-41.md, in the same format as last week's` |

**Attach files by sending them.** A document or photo sent while a project is active is
saved in the project's `inbox/` folder, and the agent is told where it is.

**A long answer arrives as a `.md` file,** with a one-line summary in the chat. Nothing
is cut short.

**Start over with `/reset <project>`** when a conversation has gone in circles or has
grown long enough to slow each turn. The project keeps its memory, its files and its
history. Only the conversation starts fresh. That is cheaper than repeating context in
every message, because a long conversation is re-read, and paid for, on every turn.

---

## One-off tasks and the front desk

**`/task` is for work that does not belong to a project:** "convert this CSV", "what
does this error mean", "summarise this page". It runs in a scratch folder on
`tasks.model`, a cheap model by default, and reports back when it finishes. It
remembers nothing afterwards, which is what you want for one-off work.

**The front desk** (the orchestrator) answers plain messages when the chat has no active
project. It forwards your message, unchanged, to the project whose `description` fits,
answers questions about the system itself ("what is running?", "what did we spend this
week?"), and asks which project you mean when it cannot tell. It has no shell and no
files, so it never does project work itself. Two habits make routing reliable:

- Give every project a one-sentence `description` that says what it is responsible for.
  Change it with `/set <project> description ...`.
- For work that clearly belongs to one project, prefer `/p`. Routing is a guess made by
  a model, and `/p` is not.

---

## Keeping costs under control

Every project has a daily and a monthly budget, `budgets.default_day_usd` and
`default_month_usd` unless the project sets its own. As spending grows:

| At | What happens |
|---|---|
| 50% (`info_pct`) | A note in the chat |
| 80% (`soft_pct`) | A warning, or a switch to `fallback_model` when the soft action is `downgrade` |
| 100% | The project **pauses**: running work stops, queued work waits |

**When a project pauses,** decide whether the work is worth more money:

```
/budget site-firma              where it stands
/budget site-firma +2           $2 more today; the queued work runs at once
/budget site-firma unlock 2h    no limit for two hours, then back to normal
/budget site-firma set day 5    a new daily limit, kept from now on
```

**Habits that keep the bill predictable:**

- **Pick the model by the job.** A flash-class model for routine work (checks, reports,
  small fixes). A stronger one only for the projects that need it. `/set <project> model
  provider/model` changes it in the project's file. Every time you choose a model, its
  price is shown.
- **Give a project a `fallback_model`** and `budget.soft_action downgrade`. Near the limit
  it continues on the cheaper model rather than stopping.
- **Reset long conversations** (see above). Cost grows with the length of the
  conversation, not just with the length of your message.
- **Watch `/usage global month` once a week.** The per-model breakdown shows which model
  is costing the most.
- **Free remote models need `/allow-free`.** They are often rate-limited and may log what
  they are sent, so Argus asks before using one.

---

## Approvals without the noise

By default, a project asks before it:

- runs a command;
- writes or edits a file;
- fetches a web page or searches the web;
- reads or searches anything outside its own folder (the database and `config/`, with
  your keys, are outside it);
- uses any other tool, including one a later version of dsh adds.

Reading and searching its own folder, and keeping its own to-do list, never ask.
Delegating to other agents is off: the project does not see those tools. Each project
can change this per group; see [what a project may use](#what-a-project-may-use). Each
question becomes:

| Button | Effect |
|---|---|
| **Approve** | This one action runs |
| **Deny** | It does not; the agent is told and continues without it |
| **Approve all of this kind for this run** | Every action of the same kind runs until this run ends |

No answer before `approvals.timeout_minutes` means **no**.

If the same harmless command keeps asking, put it on the project's allowlist instead
of approving it every time:

```
/set site-firma approvals.auto_allow [git status, git diff, npm test]
```

A rule matches the command and its flags (`git status --short`), never something
chained onto it (`git status; rm -rf /` does not match). Keep the list to read-only and
test commands. Anything that deletes, pushes or deploys is worth one tap.

`/approvals` shows what is waiting and the last decisions, including those the
allowlist took for you (`policy`).

### What a project may use

`/tools site-firma` shows the groups (`read`, `write`, `shell`, `web`, `agents`,
`other`) and what each is set to: `off` (not even offered to the agent), `deny`,
`ask` or `allow`. A news project that only reads a few sites, for example:

```
/set news tools.web_hosts [news.ycombinator.com, substack.com]
```

Those sites are fetched without asking; any other still asks. Or, for a project you
trust on the web:

```
/set news tools.web allow
```

A read or write outside the project's folder asks whatever the setting. The full
table is in [configuration](configuration.md#tools--what-the-agent-may-use).

---

## Scheduled work

```
/cron add site-firma "0 9 * * 1-5" check that the site is up and the form works
/cron add "0 18 * * 5" summarise this week's commits in github.com/acme/site
/cron list
/cron run <id>          fire it now, to test it
/cron disable <id>      pause it without losing it
```

With a project, the prompt goes to that project, with its memory and its folder. Without
one, it runs as a one-off task. The result is delivered to the chat the schedule was
created from.

A schedule fires **once** per due time, even across a restart. A run that is still going
when the next one is due is skipped, and the skip is counted in the daily report. If a
schedule runs on a project with a tight budget, pausing the project also skips its
schedules. That is deliberate: you are told about it, but it does not start new work.

Write a scheduled prompt so it can run with nobody watching: say what to check, what
counts as a problem, and what to report. "Report only if something is wrong" keeps the
chat quiet on good days.

---

## Memory, files and history

| Question | Command |
|---|---|
| What does the project know about itself? | `/memory site-firma` |
| What did it produce? | `/files site-firma`, then `/files site-firma reports` |
| Send me that file | `/get site-firma reports/week-41.md`, or ask: "send me reports/week-41.md" |
| What did it do today, and what did it cost? | `/runs site-firma` |
| What exactly did that run do? | `/log site-firma`, or `/log site-firma 3` for the third in `/runs` |
| What did it ask permission for? | `/approvals` |

**Memory is the project's own notes,** kept outside its folder and surviving `/reset`.
The agent writes to it as it learns: conventions, decisions, where things are. Read it
from time to time. If it has written down something wrong, tell the project so in a
message. The agent edits its memory itself. To remove a whole section yourself,
`/forget site-firma` lists them and `/forget site-firma <section>` removes one.

**An agent can send you files itself** with its `send_file` tool, from its own folder to
the chat the work came from, as an attachment. One file goes as it is; several files, or a
folder ("send me the site"), arrive as one zip the tool makes, with nothing to approve.
Projects and one-off tasks both have it. The size limit is the channel's, and applies to
the zip: 50 MB on Telegram.

**Ask for results as files** when you will want to keep them ("write it to
`reports/…`"). A file in the project folder outlives the chat, and `/get` brings it back
later.

---

## Changing a project

Settings change from the chat (admin only), without touching the server:

```
/set site-firma budget.day_usd 5
/set site-firma limits.max_steps_per_run 100
/set site-firma approvals.mode ask
/set site-firma description The company website: pages, blog and the contact form
/set site-firma model deepseek/deepseek-v4-flash
```

The setting is written into the project's file and checked by the same rules as at
startup. A value that does not validate is not written, and the reply says why. A
misspelt key is refused with the list of real ones.

A project you no longer need is archived, not deleted: `/archive site-firma`. Its
folder, memory and history stay, and moving its file back plus `/reload` restores it.

For a project's full file (every key, with comments) see
[Configuration → Projects](configuration.md#projects).

---

## When something goes wrong

| You see | Do |
|---|---|
| A project is working on the wrong thing | `/stop <project>`: the current turn stops, queued messages stay |
| Something is spending fast, or acting strangely, and you are not sure where | `/panic`: everything stops and nothing new starts until `/resume-all` |
| A project stopped with `budget_stopped` | `/budget <project>`, then `+<usd>` or wait until tomorrow |
| A run ended in `error` | `/runs <project>` for when, `/log <project>` for the step that failed; the daily report's Errors section for the provider error |
| `UNPRICED_MODEL` | The model has no price. Pick another, or add it under `pricing` in `ops.yaml` |
| The bot does not answer at all | On the host: `argus status`, then `argus logs`. Then [The bot is silent](troubleshooting.md#the-bot-is-silent) |
| After a restart: "run(s) were interrupted" | Press **Retry** on the ones you still want |
| A project file was edited by hand and broke | The project is ignored and you are told why; fix the file, then `/reload` |
| `/health` says `degraded` | It names the subsystem; [Troubleshooting](troubleshooting.md) has the fix |

`/panic` is safe to press. It cancels and refuses, deletes nothing, and survives a
restart until you send `/resume-all`.

---

## Sharing the bot

The admin (`access.admin`) can let someone else in from the chat:

```
/allow 123456789          after a confirmation
/allow                    who was added
/allow remove 123456789
```

The id is their numeric Telegram id (they get it from `@userinfobot`). An added user can
talk to every project, run commands and spend the budgets. They cannot run `/set`,
`/archive` or `/allow`. Add only people you would give the budget to.

---

## Commands by situation

| Situation | Commands |
|---|---|
| Opening the chat | `/start`, `/help`, `/help <command>` |
| Choosing where messages go | `/p`, `/p <id>`, `/p none`, `/projects` |
| Seeing what is happening | `/status`, `/status <project>`, `/approvals`, `/health` |
| Money | `/usage`, `/usage global month`, `/budget <scope>`, `/budget <scope> +<usd>` |
| What a project did | `/runs`, `/log`, `/memory`, `/forget`, `/files`, `/get` |
| Starting work | a plain message, `/task <text>`, `/cron add ...` |
| Stopping work | `/stop`, `/panic`, `/resume-all` |
| Changing things (admin) | `/new`, `/set`, `/model`, `/reset`, `/archive`, `/reload`, `/allow`, `/allow-free` |

Every command, with its syntax and examples: [Telegram commands](commands.md).

---

## Habits that pay off

1. **One project per responsibility.** A project per site, per report, per repository.
   Small projects have short memories, clear descriptions and budgets that mean something.
2. **Set `/p` once per conversation.** Most mistakes come from writing to the wrong
   project.
3. **Say what "done" looks like** in every instruction. An agent without a finish line
   spends steps looking for one.
4. **Keep results in files,** and fetch them with `/get`.
5. **Reset when a conversation drifts,** and let memory carry what matters.
6. **Allow-list the harmless, approve the rest.** A shorter question list makes each
   question count.
7. **Read the daily report.** It is short on quiet days, so a line that is out of place
   stands out.
8. **Back up off the machine.** See [Backup and restore](backup-and-upgrade.md#backup-and-restore).
