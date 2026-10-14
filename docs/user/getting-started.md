# Getting started

From an empty server to a project that works, in about ten minutes. Every step after
the install happens in Telegram or in the [web interface](web.md); you do not edit a file.

## 1. What you need

- A Linux server with Docker. The [native install](install-native.md) works without it.
- Optionally, Telegram: a bot token (message [`@BotFather`](https://t.me/BotFather) and send
  `/newbot`) and your numeric Telegram id (message [`@userinfobot`](https://t.me/userinfobot)).
  Without them you use Argus on the web.
- An API key for a model provider, such as DeepSeek or OpenRouter.

## 2. Install

```sh
git clone https://github.com/rla-labs/argus.git && cd argus
./deploy/scripts/install.sh
```

The installer asks whether to use Telegram (then the token and your id), the API key,
your timezone, and a daily and monthly budget for each project. It starts the service
and sends you a first message on Telegram.

**Without Telegram**, it ends with a one-time setup link instead. Open it through an SSH
tunnel or Tailscale ([how](web.md#reach-it-tailscale-recommended)): the page creates
your admin account, then asks for the API key, the models and a first project
([the setup link](web.md#without-telegram-the-setup-link)). The steps below work the
same in the web's **Chat**.

If the message does not arrive, or something fails, run:

```sh
argus doctor
```

It checks the key with your provider, the models, the bot and the projects. It says what
to fix for each failure. A key can also be sent later from the chat, by the admin:
`/key deepseek <key>` (the message is deleted at once). See [Install with Docker](install-docker.md)
for the details, and [Install natively](install-native.md) for a server without Docker.

## 3. Say hello

Open the chat with your bot and send `/start`:

```
Argus is running.

You have no projects yet.
/new <id> creates one: a folder with its own agent, memory and budget.
/task <text> runs a one-off task.
Or just write what you need.
```

## 4. Your first project

A project is an agent with its own folder, instructions, memory, model and budget.
`/new` alone lists the templates (`site`, `research`, `reports`, `devops`); one sets what
the project may use and gives it its first instructions. Name it, then say in one
sentence what it is for, and how you want it to work:

```
/new notes research
/set notes description Research notes: summaries of articles and papers I send
/instructions notes Answer in English, in short paragraphs. Always cite the source.
/p notes
```

The description is what the front desk routes on; the instructions are in the agent's
prompt on every request (`/instructions notes` shows them).

`/p notes` makes this chat talk to it. Now write to it as you would to a colleague:

```
Make a file ideas.md with three ideas for a blog post about home automation, one paragraph each
```

The project works in its folder and answers in the chat. A long answer arrives as a
file.

When it wants to do something it may not do unasked (with `research`: reading outside
its folder; without a template, also writing, running a command or using the web), you
get a question with **Approve** and **Deny** buttons. Nothing happens before you answer.
A command you trust offers **Always allow**, so it does not ask again.
`/tools notes` shows what asks, what runs, and what is refused;
[approvals without the noise](daily-use.md#approvals-without-the-noise) has more.

## 5. See what it did, and what it cost

```
/files notes            what is in its folder
/get notes ideas.md     send me that file
/log notes              the last run: what it ran, what it answered, what it cost
/usage                  today's spending, per project
/estimate notes         what its runs usually cost, before a big one
```

The budget you gave the installer applies to every project. A project that reaches its
daily budget stops and tells you; `/budget notes +2` gives it two more dollars for today.

## 6. A schedule

```
/cron add notes "0 8 * * 1-5" list the files you added yesterday, one line each; say nothing if there are none
/cron list
/cron run <id>
```

The time is in the timezone you gave the installer. `/cron run` fires a schedule now,
which is how to try one without waiting for 08:00.

## 7. One-off work

Not everything needs a project:

```
/task what is the difference between cron and systemd timers? Short answer.
```

A task runs once in a scratch folder, with no memory, on the cheap model in `tasks.model`.
You can also write without a command when no project is active (`/p none`). The front
desk answers questions about the system itself, and sends work to the project it fits,
or runs it as a task.

## 8. Optional: a browser

Everything above also works from a browser: an overview of the projects and the
spending, the approvals, the settings and the chat. It stays on a private network: with
[Tailscale](https://tailscale.com) on the server, `sudo tailscale serve --bg 3091`, then
send `/web` for a sign-in link. [The web interface](web.md) has the steps.

## Where next

- [Three scenarios](scenarios.md): a website, a daily report, a file you send.
- [Working with Argus every day](daily-use.md): habits that keep it useful and cheap.
- [Telegram commands](commands.md): every command.
- [Troubleshooting](troubleshooting.md), when something does not work. Start with `argus doctor`.
