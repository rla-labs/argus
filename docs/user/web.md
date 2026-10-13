# The web interface

Everything the Telegram chat does, on one screen: your projects and what they are
doing, what you are spending, what is waiting for your approval, the schedule, the
settings, and a chat. It is built for **one person on a private network**.

## What is on it

| Page | What you see and do |
|---|---|
| **Overview** | Your projects around the front desk: which are running, which wait for you, how much of today's budget each used. Spending today and this month, with the last 14 days. The runs going on now (with a Stop button), the approvals waiting, the next 24 hours of schedules, and the latest actions. It updates by itself. |
| **Approvals** | Every pending approval, whichever chat asked it, with Approve, Deny and "All of this kind, this run". An answer here closes the question in Telegram: its buttons give way to who answered. ("Always allow" is offered in the chat.) |
| **Chat** | The same chat as Telegram: plain text goes to the active project or the front desk, `/commands` run, approval buttons and files appear in it. |
| **Settings** | The models for tasks and the front desk, the API keys (checked before they are saved), what each project may use (`read`, `write`, `shell`, `web`, `agents`, `other`, its MCP servers), and each project's [instructions](commands.md#instructions-project-id--project-id-text). |

The interface is in English and Romanian; the buttons at the top switch. It changes
nothing in its own way: each action runs the same command you would type in Telegram
(`/defaults`, `/key`, `/set`, `/stop`), so the checks and the audit log are the same.
It runs as you, with your role: what an operator may not do in Telegram, they may not
do here either. The chat is one of your channels: notices and approvals meant for you
arrive in it as they do in Telegram. The chat's
history is kept in memory: after a restart it starts empty (the projects remember, as
always).

## Reach it: Tailscale (recommended)

The interface listens only on the server itself (`127.0.0.1:3091`). Nothing is
opened to the internet, and it must stay that way: Argus can run commands on your
server. [Tailscale](https://tailscale.com) gives your own devices a private,
encrypted path to it.

1. Install Tailscale on the server and on your laptop or phone, signed in to the
   same account.
2. On the server:

   ```sh
   sudo tailscale serve --bg 3091
   ```

   It prints an address like `https://argus.tail1234.ts.net`. That address works
   only for devices on your tailnet, with a real HTTPS certificate.
3. Put that address in `ops.yaml`, so sign-in links point there, and restart:

   ```yaml
   web:
     public_url: https://argus.tail1234.ts.net
   ```

**Without Tailscale:** an SSH tunnel works from any computer that can SSH to the
server:

```sh
ssh -N -L 3091:127.0.0.1:3091 user@your-server
# then open the link /web gives you (http://127.0.0.1:3091/…)
```

Another VPN works the same way. Do **not** publish the port on a public address or
put it behind a public reverse proxy: that is not supported before Argus 0.4.0.

## Sign in

**The first time**, send **`/web`** to the bot. It answers with a link that works
**once, for ten minutes**. Open it on a device that reaches the server (above).

Then, in **Settings → Web password**, choose a login name and a password (at least 10
characters). From then on the page asks for them, and `/web` is no longer needed.

- You stay signed in for a day (`web.session_hours`), restarts of Argus included.
- **Changing the password** asks for the current one, and signs out your other
  browsers.
- **Forgot it?** Send `/web` again: for ten minutes after you open the link you can
  set a new password without the old one.
- **Five wrong passwords** lock the login for a quarter of an hour (and five failures
  from one address pause that address as long). A `/web` link still works.

Only the admin can ask for a link for now; the users page for the others comes later
in 0.4.

## Settings

```yaml
web:
  enabled: true            # false turns it off
  port: 3091
  public_url: https://argus.tail1234.ts.net
  session_hours: 24
```

See [configuration](configuration.md#web) for the details and
[security](security.md#the-web-interface) for what protects it.
