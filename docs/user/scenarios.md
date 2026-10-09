# Three scenarios

Three ways people use Argus, each set up from the chat in a few minutes. They assume
the [Getting started](getting-started.md) steps are done. The commands are the real
ones; the replies are shortened.

- [A website the agent looks after](#a-website-the-agent-looks-after)
- [A report every morning](#a-report-every-morning)
- [A one-off task on a file you send](#a-one-off-task-on-a-file-you-send)

---

## A website the agent looks after

A project that knows your site, fixes what you ask, and checks every morning that it
still builds.

**1. Create it, and say what it is for.**

```
/new site
/set site description The company website: an Astro site, its blog and its contact form
```

**2. Put the code in its folder.** The folder is
`/srv/argus-agent/data/projects/site/` on the server. Copy the site there:

```sh
sudo cp -r ~/company-site/. /srv/argus-agent/data/projects/site/
sudo chown -R 10001:10001 /srv/argus-agent/data/projects/site   # Docker; `ops:ops` for native
```

The Docker image has Node, npm and curl, but not git. On the native install the
project uses the server's own tools, git included.

**3. Let it learn the project.** One message, once:

```
/p site
Read this project. Write in your memory how to install, build and test it, and the conventions you see in the code.
```

It answers, and `/memory site` shows what it wrote. Every later session starts from
these notes, so you do not explain the project twice.

**4. Stop the harmless commands from asking.** Building and testing change nothing
outside the folder:

```
/set site approvals.auto_allow [npm ci, npm run build, npm test]
```

Anything else, such as deleting files or a command you did not expect, still asks.

**5. Give it work.** Say what is wrong, what you expect, and what you want back:

```
The contact form returns 500 since yesterday. Find the cause, fix it, run the tests, and tell me which files you changed.
```

Each file it changes asks for your approval. **Approve all of this kind for this run**
covers the rest of that task. `/log site` shows afterwards every command it ran and every
file it touched. `/get site <path>`
sends you a file to review.

**6. A morning check:**

```
/cron add site "0 8 * * 1-5" run npm ci and npm run build; if either fails, say what failed and what you think the cause is; if both pass, say nothing
```

Deploying stays with you: Argus does not hold your hosting credentials. The project
prepares the change. You publish it.

---

## A report every morning

A project that checks three websites at 07:30 and reports how they are. It shows the
pattern for any report that runs with nobody watching: the agent writes a script once,
you read it, and the schedule runs that script without asking you anything.

**1. Create it.**

```
/new monitor
/set monitor description Checks that our public websites answer, how fast, and when their certificates expire
/p monitor
```

**2. Have it write the check as a script.**

```
Write a Node script check.mjs, with no dependencies, that checks https://example.com, https://shop.example.com and https://blog.example.com: whether each answers, the response time, and the days until its TLS certificate expires. It prints a markdown table, and also writes it to reports/<today's date>.md. Do not run it yet.
```

Writing the file asks for your approval. Then read the script before anything runs it:

```
/get monitor check.mjs
```

**3. Allow that one command.** A rule allows a command exactly as written, plus extra
options (words that start with `-`). A rule for `curl -s` would therefore not cover
`curl -s https://example.com`. A rule naming the script is exact, and it covers every run:

```
/set monitor approvals.auto_allow [node check.mjs]
```

**4. Say once what "the report" means, and try it:**

```
When I ask for "the report": run node check.mjs, then reply with one line per site, and a warning for any site that is down or whose certificate expires within 14 days. Save this in your memory as "Daily report".
```

```
the report
```

**5. Schedule it:**

```
/cron add monitor "30 7 * * *" the report
```

Each morning the summary arrives in this chat, and `/files monitor reports` keeps the
history. Nothing asks for approval, because the only command is the one you allowed.
To change what is checked, ask the project to change the script, then read it again.

**Keep it cheap.** Running a script and reading its output is a small job.
`/set monitor model <provider/model>` puts it on a small model, and
`/usage monitor month` shows what it costs.

---

## A one-off task on a file you send

A spreadsheet, a log or a PDF that needs one answer, with no project for it.

**1. Make sure no project is active**, so the message goes to the front desk:

```
/p none
```

**2. Send the file with the question as its caption:**

> 📎 `sales-2026.csv`
> Total per month, the best and worst month, and anything that looks wrong in the data

The front desk sees there is no project for this and runs it as a one-off task. The file
is copied into the task's own folder, and the task is told where it is. The answer comes
back in this chat. A long answer arrives as a `.md` file.

A one-off task can read the file and search the web, but it runs no commands, writes
no files and reads nothing outside its own folder: it has no project to ask approval
for, so `approvals_adhoc: deny` refuses them. A question
answered by reading is the right size for it. Work that needs a script goes to a project.

**Send it to a project instead** when the file belongs to ongoing work: with
`/p reports` active, the same file goes to that project's `inbox/` folder, and the
answer can be kept in the project (say "save the result as `analysis/sales-2026.md`",
then `/get reports analysis/sales-2026.md`). A one-off task's folder is scratch. It is
not backed up, and `/get` does not reach it.

Telegram lets a bot download files up to 20 MB. A photo works the same way; the largest
size is taken.

---

## What the three have in common

- **The description routes the work.** Write what the project is for, as a sentence.
- **The memory holds what you would otherwise repeat:** how to build, what a report
  looks like. Ask the project to write it down.
- **The allowlist removes the noise** of approving harmless commands. Keep it to
  commands that change nothing important. For unattended work, allow one reviewed
  script rather than a general command.
- **A schedule is a message that sends itself.** Try the message by hand first, then
  `/cron add` it.

[Working with Argus every day](daily-use.md) goes further on each of these.
