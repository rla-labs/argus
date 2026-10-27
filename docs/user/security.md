# Security

What this deployment must do, and what it cannot do for you.

## The threat model, in one table

What this deployment defends against, and what it explicitly does not.

| Threat | In scope | Control |
|---|---|---|
| A stranger messaging the bot | **Yes** | The users (the admin, `allowed_users`, users added with `/allow`, `/users` or `/link`), checked on every inbound path. Nobody until an admin is set. The one message accepted from a stranger is `/link <code>`, with a code a user asked for in the last 10 minutes; five wrong codes pause that account. |
| An allowed user spending or widening access | **Yes** | Two roles: operators run and stop work and answer approvals; spending (`/new`, `/model`, budgets, free models), permissions (`/set`, `/key`, `/allow`, instructions) and deletion are the admin's ([configuration](configuration.md#access--who-may-operate-the-system)). |
| An allowed user's mistake | **Partly** | Approvals (`ask` by default), per-project budgets, sandbox modes. |
| A prompt-injected agent | **Partly** | Sandbox per call, approvals, the allowlist is unaffected — but an approved command does what it does. |
| A leaked bot token | **Partly** | Revoke with BotFather. The token grants the bot's identity, not the host. |
| A compromised provider | **No** | Every prompt and file the agent sends reaches the provider. |
| A local attacker with root | **No** | Root reads `/data` and the secrets. Nothing here defends against root. |
| A malicious project workspace | **Partly** | A project asks before its file tools read outside its own folder; the commands it runs cannot read outside it at all ([Sandbox](#sandbox)). |
| A web page steering the agent's commands | **Partly** | `web` and `shell` ask by default; `argus doctor` warns about a project that allows both unasked. |
| An MCP server, or what it returns | **Partly** | Off until the admin adds it to one project; its tools ask until allowed. A local one runs in the command sandbox ([below](#mcp-servers)). |
| One project steering another | **Partly** | `ask_project` is off by default; a question runs as ordinary work in the other project, on its budget and rules, and a project answering cannot ask in turn. |
| An approval rule that grows too wide | **Partly** | "Always allow" saves one exact command or one site, and only on the admin's press. |
| Losing the host | **Partly** | Backups. **Copy them off the machine** — a backup on the same disk is not a backup. |

**The honest summary: this system runs code a model asked for.** The controls bound the
damage — a non-root user, a sandbox mode per call, an approval for anything risky, a
budget on everything — and none of them make it safe to hand an untrusted person a bot
token.

## Network exposure

**No inbound ports**, and these outbound destinations:

```
   Argus Agent container
        │
        ├──▶ api.telegram.org          long polling: OUTBOUND only
        ├──▶ <provider> API            the model
        ├──▶ registry                  the image pull, at install/upgrade
        ├──▶ your git hosts            a project's remotes, by Argus, with their tokens
        ├──▶ your mail server          a project's approved mail, by Argus (SMTP over TLS)
        ├──▶ your mailbox              what a project reads, by Argus (IMAP over TLS)
        └──▶ what you add              an MCP server's URL, the npm registry when `npx`
                                       fetches one, an extension's download at install,
                                       the sites a project fetches
```

Nothing else leaves the server: dsh's own telemetry, which would send a session only
after explicit feedback, is switched off as well (`DSH_TELEMETRY_DISABLED=1`, in the
image and the systemd unit).

| Surface | Exposed? | Why |
|---|---|---|
| The health endpoint (3090) | **No** | Bound to `127.0.0.1` inside the container. The Docker healthcheck calls it there; an operator tunnels. |
| Argus's web interface (3091) | **No** (yes only in [public mode](web.md#public-mode), through Caddy on 443) | Loopback only (Docker publishes it on the host's `127.0.0.1`). Reached through `tailscale serve`, a VPN or a tunnel; signed in with a password or a `/web` link, plus a code in public mode. |
| The dsh Web UI (3080) | **No** | The same. The tunnel is the authentication. |
| Ollama (11434) | **No** | An internal Docker network. A local model server has **no authentication**, so it is safe only because nothing else can route to it. |
| The bot | Outbound | Long polling, so there is no webhook to expose and no public domain, certificate or reverse proxy to maintain. |

**There is no setting to publish the health endpoint.** It reports the shape of the
system — plugin names, queue depths, budget states — and has no authentication. A
container healthcheck runs inside the container; an operator reaches it through a tunnel:

```sh
ssh -N -L 3090:127.0.0.1:3090 user@host
curl http://127.0.0.1:3090/health
```

### The host firewall

The deployment needs **no inbound rule at all**. A host that allows only SSH is
sufficient, and is the recommended posture:

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw enable
```

## Container or systemd

The [native install](install-native.md) runs Argus under systemd, for a VPS
where you prefer not to use Docker. Understand the difference before choosing.

| | Container | systemd |
|---|---|---|
| Filesystem boundary | The image, read-only, plus a tmpfs | `ProtectSystem=strict` + `ReadWritePaths` |
| Process boundary | The container's PID namespace | `TasksMax`, `LimitNPROC` — the host's namespace |
| Privileges | `cap_drop: ALL`, `no-new-privileges` | `CapabilityBoundingSet=`, `NoNewPrivileges` |
| Network | Its own namespace | The host's, filtered only by the host firewall |
| **What the sandbox can fall back on** | **The container** | **Nothing** |
| Upgrading | A new image | Rebuilding in place, with no rollback |

**The decisive row is the fifth.** When no kernel-level sandbox backend is available,
`ctx.sandbox` fails closed — but a deployment's real containment comes from the boundary
around the process. A container provides one that a tool cannot argue with. A systemd
unit provides directives that a tool with the same uid may be able to reach around.

If you must use the unit: keep `ProtectSystem=strict` and `ReadWritePaths=/srv/argus-agent/data`,
do not add `AmbientCapabilities`, and treat `scratch/` as hostile input.

## Secrets

### The bot token

```
TELEGRAM_BOT_TOKEN=123456789:AAH…
```

- In the environment, or saved with `/key telegram` in dsh's credentials store
  (`0600`); never in a file that gets committed. `ops.yaml` names at most the variable,
  never the value.
- **Never logged.** The adapter's config warning names the variable, and a test
  asserts that no part of the value appears in any output.
- Revoke with BotFather's `/revoke` if it leaks.

### Model provider keys

- In the server's environment (`.env`, `secrets.env` natively), or in dsh's credentials
  store (`<dsh home>/.credentials.yaml`, `0600`), where `/key` saves them. The
  environment wins.
- `/key <provider> <key>` deletes the message that carried the key, checks the key
  before saving it, and confirms with its last four characters. The audit log keeps
  the provider's name only.
- **A key pasted as ordinary text never reaches a model.** `ops-channel` checks every
  message for key shapes before routing it; a match is deleted and not routed.
- Telegram keeps a message on its servers until it is deleted, and chats with bots
  are not end-to-end encrypted. Deleting at once shortens that window; it does not
  close it. If that matters, set the key in `.env` on the server instead.
- **Out of the agents' reach.** Their commands run in the [command sandbox](#sandbox):
  the credentials file is outside what they may read, and the keys are not in their
  environment.

### Secrets a project needs

A project gets a secret (a GitHub token, a database password) only through one of its
[MCP servers](#mcp-servers). Its `mcp` block names the secret as `${NAME}`; the value
comes from `/key NAME value` (dsh's credentials store, like the provider keys) or the
server's `.env`, and is filled in only when the project's agent starts that server.

| Rule | Why |
|---|---|
| Never in a project's folder | The agent's file tools reach the whole folder, and what it reads can end up in a model request. |
| Never in the project file or `ops.yaml` | The agent can read the first; the second is shared and copied. |
| Only the server's process is given it | dsh starts a local server with a scrubbed environment plus its `env`. A value saved with `/key` reaches no other process; one set in `.env` is in the service's environment, like the provider keys. |
| Never logged | The log and the audit keep the name, never the value. |

As for the provider keys, the agent's commands cannot read the credentials store: the
[command sandbox](#sandbox) keeps it out of their reach.

**A git token is the exception: no process of the project ever gets it.** It is kept per
project and per remote under a name `/key` and `${NAME}` refuse (`ARGUS_GIT_…`), and only
Argus's own git uses it, as a header for that remote's host, on a copy of the repository
kept outside the project's folder (`state/<id>/remotes/`). Only git bundles, which are
plain data, cross between that copy and the project:

| What | Why it holds |
|---|---|
| The project's repository is read only by a confined process, with the project read-only | Its hooks, config (`core.fsmonitor`, `include.path`, `insteadOf`…), filters, alternates or a `.git` that points elsewhere run or resolve only under Landlock, where they reach nothing outside the project. |
| The process with the token never opens the project's repository | Nothing the agent wrote can run beside the token. |
| HTTPS only, no redirect followed, no prompt, no user or system git config | The token goes to the remote's host and nowhere else. |
| A push is a fast-forward of the commit the person approved | A branch that moved after the question is not pushed; nothing is force-pushed; protected branches are refused. |
| Archiving a project forgets its tokens | A project that no longer runs holds nothing. |

**A mail account is the same kind of exception.** It is kept under `ARGUS_MAIL_…`, which
`/key`, `${NAME}` and an extension's secrets refuse, and only Argus's own `send_mail`
uses it, over TLS with the server's certificate checked. Mail is the easiest way to send
data out, so: every mail is shown whole to a person, with Approve and Deny only (no run
grant, no "always", no rule that skips it), unless every recipient is one of the few
exact addresses the admin trusts (`mail.trusted_recipients`, never a domain), each
within its own daily count and all within a total; the recipients must be in the
project's file; the attachments must be files in the project's folder, and one that
changes after the question is not sent; a daily ceiling of recipients applies to every
mail. Mails are marked as automatic, and a mail that is itself automatic, from a list or
from a no-reply address is never answered, so no mail loop can start. `/mail pause`
stops unasked mail at once, and 3 failures in a row pause it by themselves. A mail that
waits for a person waits in an outbox, with copies of its attachments: nothing the agent
changes afterwards reaches it, and its run does not wait.

**A mailbox is read the same way.** Its account (`imaps://`) is kept under
`ARGUS_MAIL_IMAP_…`, and only Argus's mailbox tools use it. A project reads only the
folders its file lists; it can save an attachment into its folder (written through the
command sandbox, so a link cannot lead it out) and mark a mail as read, nothing else. A
mail is where instructions from strangers arrive: it reaches the model framed as
information from outside, and nothing in it widens what the project may do; above all,
`send_mail` still writes only to the project's recipients, and a reply goes only to the
mail's sender.

The tests plant each of these in a project's repository and check that nothing ran
with Argus's rights and that another project's commits never left.

The project's own state directory (`state/<id>/`, outside its folder) holds its memory
and its instructions, which the agent reads in its prompt but cannot write.

## MCP servers

A project's [MCP servers](configuration.md#mcp--external-tools-through-mcp-servers) are
tools from other systems, and as trusted as the programs behind them:

| What | Why it matters |
|---|---|
| A local server runs **in the command sandbox**, or not at all | It reads the system and the project's folder, writes the project's folder and a home of its own; not the database, the keys, the conversations or another project. It has the network. |
| Its home (`state/<project>/mcp/<server>/`) is its own | Logins and caches it keeps there are out of the agent's reach: the agent's shell cannot read outside the project's folder. |
| A remote server that signs in (OAuth): Argus holds the grant | Per project and per server, in the credentials store. The agent reaches the server through a proxy on `127.0.0.1` that adds the token; no token is in its tools, shell, prompt or conversation. `ARGUS_OAUTH_…` is reserved: `/key` refuses it, and no server's `${NAME}` may use it. |
| The sign-in starts only from the admin | `/mcp connect`'s link works once, ten minutes, in an admin's web session; the provider's answer is accepted only with the one-time `state` that link made, and its PKCE verifier. |
| It gets only the variables in its `env` | dsh drops every inherited variable that looks like a key, token or password. |
| Its tools follow `access` (default `ask`) | Every call is a question until you allow the server. |
| What it returns goes to the model | A server that reads e-mail or web pages can carry instructions in its answers; keep `access: ask` for such a server unless the project's other tools are harmless. |
| It belongs to one project | Another project, a `/task` and the front desk never see it. |

## Extensions

[Extensions](extensions.md) are code from other people. What stands between it and your
data:

| What | Why it matters |
|---|---|
| Only the admin installs one, after seeing its tools, skills, secrets and install commands | Nothing arrives unasked. |
| It is pinned to a commit, and its files are hashed | At every start a changed file is caught; that extension is not used. |
| Its `install` commands run in the command sandbox, writing only in its folder | A hostile package script cannot read the keys, the database or a project. It **can** use the network, and send what is in its own folder. |
| Nothing is installed without the sandbox | No Landlock, no install. |
| Its folder is read-only and outside every project | No agent can change it. |
| Its MCP server runs in the command sandbox: the system and its folder to read, the project's folder to work in | It cannot read the database, the keys, the conversations or another project. Without the sandbox it does not start. It has the network, unless it declares `network: proxy`. |
| `route: anthropic` (an agent such as Claude Code) | Its model requests go through a route in Argus that adds the subscription's token or the API key. Neither is in its environment, where its own shell commands could read it (`env`, or `/proc/<pid>/environ` of the agent itself, which is how it was found). The route is a random path that ends with the server: holding it lets a process use the credential through Argus, not read it. One thing its commands can read: the server's own `ARGUS_HOST_TOKEN`, from `/proc` (the server is their ancestor, under the same user and sandbox). It opens nothing: the channel takes one connection, the server's, and its messages only ask, or report steps and turns. |
| `route: openai` (Codex) | The same for OpenAI: Argus's API key is added on the way, never in Codex's environment; and Argus reads what each request used from OpenAI's own answer and may refuse the next one (budget, day's turns), so the extension cannot under-report it. |
| `network: proxy` (an agent such as Claude Code) | Its TCP connections reach only the [egress proxy](#web_fetch-reaches-the-public-web-only)'s port, which refuses private addresses; it has no UDP or raw sockets; everything it starts inherits that. So the private network, the cloud's metadata service and Argus's own ports are out of reach. Landlock names a **port**, not an address: a public host listening on that same random port number is reachable, as the public internet is through the proxy anyway. It also cannot connect to a server it starts on its own machine (a dev server for tests). Needs Landlock with TCP rules (kernel 6.7+) and `argus-netlock` (built with the image; natively, with a C compiler); without them it runs with the network, and `argus doctor` warns. |
| Its programs (`bin`) run as the project's own commands | Confined to the project's folder, with the project's approvals. Only the programs it names are on the `PATH`, and only in a project that enabled it: another project cannot run them by their path. Its `env` cannot hold a secret or change `PATH`. |
| A project gets it only when the admin enables it there | Every other project, `/task` and the front desk never see it. |

## The browser

The [`browser` extension](extensions.md#the-first-party-ones) gives an agent a headless
Chromium. Playwright says plainly that a browser is not a security boundary, so:

| What | Why it matters |
|---|---|
| Its MCP server and Chromium run in the command sandbox | They read the system and the extension's folder and write the project's folder and the server's own home; not the database, the keys or another project. |
| Every request goes through Argus's egress proxy, loopback included | A page, a redirect or a link cannot steer the browser to the server, its network or the cloud's metadata service: the proxy resolves the name and refuses anything not public. WebRTC is limited to proxied UDP. |
| A clean profile each session | No cookies or logins to steal or reuse. |
| Reading a page runs unasked; acting on it asks; page code and uploads are refused | A page that carries instructions cannot make the agent click, type or run code without you seeing it. The rules are per tool (`/tools <project>`). |
| `file://` is refused | The browser cannot open the project's or the system's files as pages. |

The agent's own shell is not behind the proxy: a `curl` there is the `shell`
approval's job, as before.

## Skills

A skill is a how-to an agent reads when a task calls for it; the agent sees each skill's
name and first line in every session. That makes it a lasting part of the prompt, so who
may write one matters.

| What | Why it matters |
|---|---|
| A project's skills are in `<data_dir>/state/<id>/skills/`, outside its folder | Its agent cannot write itself a skill: the command sandbox gives it no access there. |
| Skills in the project folder are **not read** (`.agents/skills`, `.dsh/skills`) | dsh reads them by default; Argus turns that off, since an agent that writes in its folder could otherwise leave itself instructions nobody reviewed. |
| Only the admin adds or removes one, with [`/skill`](commands.md#skill-project-id--add-project-id-name-text--remove-project-id-name) | Everyone can see them. |
| A skill belongs to one project | Another project, a `/task` and the front desk never see it. |

## The web interface

Argus's own interface (the dashboard, approvals, settings and chat) is for a
**private network** by default; [public mode](web.md#public-mode) is an explicit choice:

- It listens on the server's `127.0.0.1:3091` (in Docker, the container publishes it
  on the host's loopback only). Reach it with `tailscale serve`, a VPN or an SSH
  tunnel; see [the web interface](web.md). On the internet only in public mode (below).
- **It has its own sign-in even so**: a login name and a password, or a `/web` link
  that works once, for ten minutes, and is also how a first password is
  set or a forgotten one reset.
  - Passwords are stored as scrypt hashes, each with its own salt; at least 10
    characters.
  - An invitation or an admin's password reset is a link valid 24 hours, once; it
    lives in memory, so a restart cancels it.
  - Five wrong passwords lock the login for 15 minutes; five failed sign-ins from
    one address pause that address as long. A wrong name and a wrong password get the
    same answer.
  - A sign-in becomes a session cookie that scripts cannot read (`HttpOnly`), that
    another site cannot send (`SameSite=Strict`), and that travels only over HTTPS when
    `web.public_url` is `https://`. The database keeps a hash of it, not the cookie, so
    a copy of the database signs nobody in. Sessions survive a restart; changing the
    password ends the others.
- **Sign in with Tailscale** (`web.tailscale_identity`, off by default) takes the
  login `tailscale serve` adds to a request (`Tailscale-User-Login`) as a sign-in, for a
  user the admin linked to it. It is trusted only from what `tailscale serve` connects
  from: the server itself, the container's gateway under Docker, or an address in
  `web.trusted_proxies`; never in public mode, where a proxy in front of the internet
  could pass anything. Someone with a shell on the server could forge the header;
  that person controls the server already.
- **Every sign-in is in the audit log** (`web.signin`: how, the address, the browser);
  in public mode the person and the admin are also told at once. **Settings → Security**
  lists a user's sessions and ends any of them, or all but the one in use.
- **Files a project made are shown so that nothing in them runs in the page**: they
  come with a sandboxing CSP, HTML and SVG as text, never sniffed, and a link outside the
  project's folder is refused.
- **An authenticator code (TOTP, RFC 6238)** may follow the password or the link:
  optional on a private network, required for everyone in public mode. A code works
  once; ten recovery codes, stored as hashes, work once each.
- **Public mode** (`web.public: true`) also makes the cookie always `Secure`, sends
  HSTS, ends a session unused for `web.idle_minutes` (30), and counts failed sign-ins
  by the client's address from the proxy's `X-Forwarded-For`. `argus doctor` fails
  while `public_url` is not `https://` or the admin has no code. Docker uses the Caddy
  overlay (`docker-compose.caddy.yml`), which proxies this interface and nothing else.
- Every change it makes is a command run as you, with the same checks and audit as
  in Telegram. Every POST needs a header a cross-site form cannot send, and the page
  runs under a strict content security policy.

### Files through the web

Argus writes and reads a project's files with its own rights, in a folder the agent
controls, so it never follows a link the agent made:

| What | How |
|---|---|
| An upload, or a file sent in the chat | Written only into an `inbox/` that is a real folder inside the project, as a new file (never through a link, never over another file). An inbox the agent turned into a link is refused. |
| A folder as a zip | Made in the command sandbox, read-only; a link stays a link (`zip -y`), so nothing outside the folder is read through one. |
| A download link | Needs a signed-in browser, works once, expires (`web.download_link_hours`). A file swapped for a link after the link was made is not served. |
| An upload's size | At most `web.max_upload_mb`, refused before anything is written, and only while 512 MB of disk stay free. Every upload is in the audit log (`web.upload`). |

## The dsh web UI

dsh's own web UI must listen on **`127.0.0.1` only**. Access is through an SSH tunnel:

```sh
ssh -N -L 3080:127.0.0.1:3080 user@host
# then open http://127.0.0.1:3080 locally
```

**Never bind it to `0.0.0.0`.** It has no authentication of its own — the tunnel is
the authentication — and a publicly reachable agent UI is a remote code execution
surface with a chat window.

## Sandbox

Every command an agent runs (its `bash`) runs under **Landlock**, the Linux kernel's
file-access sandbox. Argus grants each command exactly this, and nothing else:

| What | Access |
|---|---|
| The project's own folder (a task's scratch folder) | read and write |
| A private home and temp folder for that project, outside its folder | read and write |
| The system: `/usr`, `/bin`, `/lib`, `/etc`, `/opt`, `/proc`, `/sys`, `/dev`, and Node | read |
| **The data directory**: the database, the other projects, the conversations, the configuration, the keys | **none** |
| **The application** (`/app`) | **none** |

So a command cannot read another project's files or the conversations, even if the
agent was talked into trying, and cannot write anywhere but its own folder. The keys are
not in a command's environment either, and Landlock refuses a command another process's
environment (`/proc/<pid>/environ`).

**What it does not confine: the network.** A command can reach whatever the server can.
The approvals for `shell` and `web` are what stand between an agent and the internet.

**The `site` template runs its commands unasked** (`tools.shell: allow`), on the strength
of this boundary: a command can harm only the project's own folder, which `/undo` puts
back, and can send out only what is in it. Its `web` still asks, so a page the agent
reads cannot steer the commands it runs next without you seeing the page first. For a
project whose folder holds something that must not leave the server, set
`tools.shell: ask`.

Because of this boundary, the commands that only read (`ls`, `cat`, `grep`, `find`,
`df`, `ps`, …, a fixed list in Argus's code) count as reads and run unasked where
reading is allowed: they can read only what the agent's own file tools can. Their forms
that write or run something else (`find -exec`, a redirection) still ask, and `git` is
not on the list, because it runs what the repository's own configuration names.

### `web_fetch` reaches the public web only

`web_fetch` refuses every address that is not public: the server itself (`localhost`,
`127.0.0.1`, Argus's own ports), the private network (`10.x`, `172.16–31.x`,
`192.168.x`), link-local addresses and the cloud metadata service (`169.254.169.254`),
and their IPv6 forms. It resolves the name once, refuses the whole answer if any address
is not public, and connects only to the addresses it checked, so a name that changes its
answer between the check and the connection (DNS rebinding) cannot slip through. A
redirect to another site is refused. This is dsh's fetch backend, and Argus keeps it;
`test/spikes/08-web-fetch-addresses.test.ts` checks it. A shell command (`curl`) is not
covered: that is the `shell` approval's job.

### Without Landlock, commands do not run

On a kernel without Landlock (older than 5.13, or with it switched off), Argus **refuses
to run** commands (`SANDBOX_UNAVAILABLE`) rather than running them unconfined.
`argus doctor` says which it is:

```
  ok the command sandbox: Landlock: a project reads and writes only its own folder
```

Landlock works inside the Docker container with the settings the compose file ships
(`read_only`, `cap_drop: ALL`, `no-new-privileges`); it needs no capability.

### The container is a second wall

In a Docker install the container is the outer boundary, so it must be real. The shipped
compose file does this; keep it that way:

```yaml
services:
  ops:
    read_only: true
    tmpfs: ['/tmp:size=256m,mode=1777,exec']
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    ports:
      - '127.0.0.1:3091:3091'            # loopback only
```

**Mount the data tree, not the host's home.** A container that mounts `/home` or `/`
has given the agents' commands everything the container can read.

**The honest summary:** a project's commands are confined to its folder by the kernel;
the container bounds the rest; the approvals decide the network. The approval allowlist
is a convenience, not a sandbox.

## The host

| Practice | Why |
|---|---|
| Run as a non-root user | A compromised agent is not root. The image uses **uid/gid 10001**, fixed. |
| `data_dir` outside the repo | The repository is code; the data tree is state. |
| One replica | Enforced: the store holds an instance lock on the data directory, and a second process refuses to start (`INSTANCE_LOCKED`). Give each replica its own data directory. |
| Back up `<data_dir>`, **off the machine** | It holds the projects, the sessions and the audit log. |
| Keep the pinned dsh version | The bundle's patches are written against `0.2.0-rc.2`. |
| Pin the image tag | `latest` turns a restart into a version change. |
| Cap the container log | An agent logs a lot; an uncapped log is what fills the disk. |
| Keep `.env` at mode 600 | It holds the bot token and the provider keys — and it is **not** in the backup. |

### The fixed uid

The image creates the `ops` user with **uid 10001** rather than letting the runtime
allocate one. That is deliberate: a fixed id is what lets an operator bind-mount a host
directory and `chown` it once. A runtime-allocated id would change the ownership
requirement on every rebuild, and the symptom would be an intermittent
`SQLITE_CANTOPEN` after an upgrade.

```sh
sudo chown -R 10001:10001 /srv/argus-agent/data
```

### What the container hardening buys

| Directive | Effect |
|---|---|
| `read_only: true` | The image filesystem cannot be written; only `/data` and the tmpfs can. |
| `cap_drop: ALL` | No capabilities at all. The service binds no privileged port. |
| `no-new-privileges:true` | A setuid binary inside cannot escalate. |
| `pids_limit: 512` | A fork bomb hits the limit rather than the host. |
| `tmpfs: /tmp` | A writable scratch space that is discarded, not a hole in the image. It is mounted `exec` because dsh loads its native addons from `$TMPDIR`; the image itself stays read-only. |
| `stop_grace_period: 30s` | A run is cancelled rather than killed mid-write. |
| `max-size` / `max-file` | The log cannot fill the disk. |

## What this deployment cannot do

- **Make an allowed user trustworthy.** The allowlist is per user and per channel.
- **Stop an approved command from doing what it does.** Confinement bounds the
  effect; the allowlist bounds what is asked about.
- **Protect a secret the agent can read.** Keep secrets out of the workspace; that
  is the whole control.
- **Authenticate the dsh web UI.** The tunnel is its authentication. (Argus's own web
  interface signs you in, and is still meant for a private network only.)
- **Make an MCP server trustworthy.** It is a program you chose to run; Argus decides
  which project sees it and whether its calls ask.
