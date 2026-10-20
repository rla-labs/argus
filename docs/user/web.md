# The web interface

Everything the Telegram chat does, on one screen: your projects and what they are
doing, what you are spending, what is waiting for your approval, the schedule, the
settings, and a chat. It is built for **one person on a private network**.

## What is on it

| Page | What you see and do |
|---|---|
| **Overview** | Your projects around the front desk: which are running, which wait for you, how much of today's budget each used. Spending today and this month, with the last 14 days. The runs going on now (with a Stop button), the approvals waiting, the next 24 hours of schedules, and the latest actions. It updates by itself. |
| **Approvals** | Every pending approval, whichever chat asked it, with Approve, Deny, "All of this kind, this run" and, for the admin, "Always allow" where the rule can be named. An answer here closes the question in Telegram: its buttons give way to who answered. A run the loop checker found in a loop, under `on_loop: ask`, is here too, with its reason, Continue and Stop. |
| **Projects** | Every project: state, model, today's and this month's spending against its budget. **New project** (an id, a template, a model). A project's own page: its status with Stop, Reset and Archive; spending and its day/month budget; its model; what it may use (tools, MCP servers); its runs; its schedules; its instructions; its memory (and forgetting a section); its files, with a download; Undo; its [extensions](extensions.md) (Enable/Disable here). |
| **Tasks** | Run a one-off task, see what tasks have cost (Estimate), and the recent tasks with a Stop button for one that is running. |
| **Schedules** | Every schedule with its next run: Run now, Enable/Disable, Remove; and a form for a new one (a project or a task, a cron expression, the text). |
| **Runs & costs** | Spending today and this month for everything, tasks, the front desk and each project, against their budgets, with a form to set a limit; the recent runs; the audit log. |
| **Chat** | The same chat as Telegram: plain text goes to the active project or the front desk, `/commands` run, approval buttons and files appear in it. |
| **Users** (admin) | Every user: role, channels, web login. Invite someone (a 24-hour link to send them), reset a password, disable or enable. The same as [`/users`](commands.md#users-invite-name--remove-user--enable-user--reset-user--name-user-name--admin). |
| **Settings** | The models for tasks and the front desk, the API keys (checked before they are saved), what each project may use (`read`, `write`, `shell`, `web`, `agents`, `other`, its MCP servers), and each project's [instructions](commands.md#instructions-project-id--project-id-text). Your web password, and your channels (**Connect Telegram**). **System**: Panic and Resume all, allowing a free remote model, and the health report. |

The interface is in English and Romanian; the buttons at the top switch. It changes
nothing in its own way: each action runs the same command you would type in Telegram
(`/new`, `/model`, `/budget`, `/set`, `/stop`, `/get`…), so the checks and the audit log are the
same; a button for something your role may not do is not shown.
It runs as you, with your role: what an operator may not do in Telegram, they may not
do here either. The chat is one of your channels: notices and approvals meant for you
arrive in it as they do in Telegram. Its history (the last 500 messages, with their
files) survives a restart, and **Chat** in the menu shows how many messages from Argus
you have not seen yet. A question still waiting when Argus restarts shows "No answer
in time": ask again, or answer the new one.

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

Another VPN works the same way. Do **not** publish the port on a public address.
Putting the web on the internet is possible only in [public mode](#public-mode), behind
a reverse proxy with HTTPS.

## Public mode

A private network is the safer choice: whoever reaches this page can try to sign in to
something that runs commands on your server. If you need the web from anywhere without
a VPN, public mode adds what that takes:

- **A second factor for every sign-in:** a 6-digit code from an authenticator app
  (Aegis, Google Authenticator, 1Password…), after the password or the `/web` link.
  The first time each user signs in, the page asks them to set it up before anything
  else, and shows ten **recovery codes**, each good for one sign-in without the phone.
- **HTTPS only:** the cookie is always `Secure`, and the browser is told to use HTTPS
  from then on (HSTS).
- **An unused session ends after 30 minutes** (`web.idle_minutes`).
- The failed sign-in limits count the client's own address, from the proxy.
- `argus doctor` **fails** while `web.public_url` is not `https://` or the admin has no
  code yet.

The dsh Web UI is never proxied: it stays tunnel-only.

**Docker,** with the Caddy overlay (automatic HTTPS from Let's Encrypt):

1. Point a DNS name at the server (an A or AAAA record) and open ports 80 and 443.
2. In `deploy/compose/.env`: `ARGUS_DOMAIN=argus.example.com`
3. In `ops.yaml`:

   ```yaml
   web:
     public: true
     public_url: https://argus.example.com
   ```
4. Start it with the overlay:

   ```sh
   cd deploy/compose
   docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
   ```

   `argus upgrade` and the other scripts keep the overlay while `ARGUS_DOMAIN` is set.

**Native,** with the reverse proxy you install. Caddy:

```text
argus.example.com {
	reverse_proxy 127.0.0.1:3091
}
```

or nginx, with a certificate (certbot):

```nginx
server {
    listen 443 ssl;
    server_name argus.example.com;
    # ssl_certificate … (certbot adds these)
    location / {
        proxy_pass http://127.0.0.1:3091;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_buffering off;          # the page's live updates
        proxy_read_timeout 1h;
    }
}
```

Then the same `ops.yaml` change, and restart. Leave the web on `127.0.0.1`: only the
proxy reaches it.

**Lost the phone?** Sign in with a recovery code. Out of codes: the admin's
`/users reset <user>` removes a user's password and code; for the admin,
`argus setup-link --admin` on the server gives a sign-in link that removes the
admin's code, to set up again.

**On a private network** the code is optional: **Settings → Authenticator code**.

## Without Telegram: the setup link

An install without a Telegram bot has no admin yet. Argus then writes a **one-time setup
link** (valid an hour, renewed every hour until it is used), and the installer prints
it. To see it again, on the server:

```sh
argus setup-link
```

Open it through the tunnel or Tailscale (above). The page asks for the admin's name, a
login name and a password, signs you in, and then walks through the rest, each step a
command you could also type in the chat:

1. a model provider's API key ([`/key`](commands.md#key-provider-key--name-value--remove-providername--admin), checked with the provider);
2. the models for tasks and the front desk ([`/defaults`](commands.md#defaults-tasksfrontdeskjudge-providermodel));
3. optionally Telegram: the bot token (`/key telegram`, the bot starts at once), then
   **Connect Telegram** for your account;
4. a first project from a template ([`/new`](commands.md#new-id-template-providermodel)).

The timezone and the default budgets are shown there too; they are in `ops.yaml`
(`timezone`, `budgets`) and apply after a restart. Until there is a provider key and a
project, the Overview offers **Finish the setup**.

The link is never written to the log. It is in the file `state/setup-link` of the data
directory (mode 600), and disappears once used.

**The admin lost the password** and has no Telegram to send `/web` from:

```sh
argus setup-link --admin
```

It restarts the service and prints a one-time sign-in link for the admin, valid an
hour; within ten minutes of opening it, set a new password in **Settings → Web
password**, without the old one.

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

Every user can ask for a link with `/web`. Someone without Telegram gets theirs from
the admin: an invitation from the **Users** page, valid 24 hours.

**Connect Telegram.** In Settings → Your channels, **Connect Telegram** gives a code;
send `/link <code>` to the bot within 10 minutes. From then on Telegram and the web are
the same you.

## Settings

```yaml
web:
  enabled: true            # false turns it off
  port: 3091
  public_url: https://argus.tail1234.ts.net
  session_hours: 24
  public: false            # true: public mode, behind a proxy with HTTPS
  idle_minutes: 30         # public mode: an unused session ends
```

See [configuration](configuration.md#web) for the details and
[security](security.md#the-web-interface) for what protects it.
