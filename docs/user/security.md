# Security

What this deployment must do, and what it cannot do for you.

## The threat model, in one table

What this deployment defends against, and what it explicitly does not.

| Threat | In scope | Control |
|---|---|---|
| A stranger messaging the bot | **Yes** | The allowlist (the admin, `allowed_users`, and users added with `/allow`), checked on every inbound path. Nobody until an admin is set. |
| An allowed user's mistake | **Partly** | Approvals (`ask` by default), per-project budgets, sandbox modes. |
| A prompt-injected agent | **Partly** | Sandbox per call, approvals, the allowlist is unaffected — but an approved command does what it does. |
| A leaked bot token | **Partly** | Revoke with BotFather. The token grants the bot's identity, not the host. |
| A compromised provider | **No** | Every prompt and file the agent sends reaches the provider. |
| A local attacker with root | **No** | Root reads `/data` and the secrets. Nothing here defends against root. |
| A malicious project workspace | **Partly** | A project asks before it reads outside its own folder (another project's files, the database, the keys); code it runs is confined by the sandbox mode. |
| Losing the host | **Partly** | Backups. **Copy them off the machine** — a backup on the same disk is not a backup. |

**The honest summary: this system runs code a model asked for.** The controls bound the
damage — a non-root user, a sandbox mode per call, an approval for anything risky, a
budget on everything — and none of them make it safe to hand an untrusted person a bot
token.

## Network exposure

Exactly three outbound destinations, and **no inbound ports**.

```
   Argus Agent container
        │
        ├──▶ api.telegram.org          long polling: OUTBOUND only
        ├──▶ <provider> API            the model
        └──▶ registry                  the image pull, at install/upgrade
```

| Surface | Exposed? | Why |
|---|---|---|
| The health endpoint (3090) | **No** | Bound to `127.0.0.1` inside the container. The Docker healthcheck calls it there; an operator tunnels. |
| The Web UI (3080) | **No** | The same. The tunnel is the authentication. |
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

- In the environment, never in a file that gets committed.
- Referenced in `ops.yaml` as `${TELEGRAM_BOT_TOKEN}`, so the composition file holds
  the variable name rather than the value.
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
- **Not a boundary against the agents.** Their commands run as the same user, so a
  command could read the credentials file, just as it could read the environment.
  The approvals on shell commands are what stand in the way.

### Per-project secrets

```
/data/state/<project-id>/secrets.env      # outside every project's cwd
```

**Outside the workspace, deliberately.** A project's agent has file tools and runs
with its `cwd` as the workspace root; a secret inside that directory is a secret the
agent can read, print, and include in a model request. Putting them under
`/data/state/<id>/` keeps them out of reach of the file tools, and they are injected
only into the processes that need them.

| Rule | Why |
|---|---|
| One file per project | A project cannot read another's secrets even if it escapes its own directory. |
| `0600`, owned by the service user | Nothing else on the host reads them. |
| Never in a project's `cwd` | The agent's file tools reach the whole workspace. |
| Never in `ops.yaml` | The composition file is committed and shared. |
| Never at info level | A secret in a log is a leaked secret. |

## The web UI

The dsh web UI must listen on **`127.0.0.1` only**. Access is through an SSH tunnel:

```sh
ssh -N -L 3080:127.0.0.1:3080 user@host
# then open http://127.0.0.1:3080 locally
```

**Never bind it to `0.0.0.0`.** It has no authentication of its own — the tunnel is
the authentication — and a publicly reachable agent UI is a remote code execution
surface with a chat window.

## Sandbox

`ctx.sandbox` confines a project's processes. Modes are carried **per call**:

| Mode | Means |
|---|---|
| `read-only` | Only the required sinks, such as `/dev/null`. |
| `workspace-write` | The workspace, plus a backend-defined temp area. |
| `danger-full-access` | No confinement. |

**`workspace-write` for every project, with the project's `cwd` as the root.** That
is what the plan requires: an agent works inside its own folder and cannot read
another project's files or the host's.

### Without a backend, dsh fails closed

A sandbox provider with no backend **refuses to run** the process
(`SANDBOX_UNAVAILABLE`) rather than running it unconfined. So a missing backend
breaks work loudly instead of silently removing confinement — the right failure.

Set it up if you can:

| Platform | Backend |
|---|---|
| Linux | Landlock, which needs a kernel with it enabled |
| Inside Docker | A backend may be unavailable; see below |

### Inside Docker

**The container is the primary barrier.** Two consequences:

1. **A sandbox backend may be unavailable inside a container** — a Landlock-capable
   kernel is not guaranteed, and a container's own seccomp profile can block the
   syscall the backend needs. When that happens, dsh refuses to run confined
   processes rather than running them unconfined.
2. **The container's isolation is what remains.** So it must be real:

```yaml
services:
  ops:
    read_only: true
    tmpfs: ['/tmp:size=1G']
    volumes:
      - /srv/argus-agent/data:/data          # the data tree, rw
      - /srv/argus-agent/state:/data/state   # secrets, rw, NOT under a project cwd
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    user: '1000:1000'
    ports:
      - '127.0.0.1:3080:3080'            # loopback, for the SSH tunnel
```

**Mount the data tree, not the host's home.** A container that mounts `/home` or
`/` has given every project the host's files, and no per-process confinement is
going to take them back.

**The honest summary:** with a backend, a project's processes are confined to its
`cwd`. Without one, the container is the boundary and dsh will not run the process
at all. Neither is a substitute for the other, and the approval allowlist is a convenience,
not a sandbox.

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
- **Authenticate the web UI.** The tunnel is the authentication.
