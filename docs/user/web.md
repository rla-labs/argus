# The web interface

Everything the Telegram chat does, on one screen: your projects and what they are
doing, what you are spending, what is waiting for your approval, the schedule, the
settings, and a chat. It is built for **one person on a private network**.

## What is on it

| Place | What you see and do |
|---|---|
| **Projects** (the start page) | What waits for you first (approvals, a possible loop, a project paused by its budget or with settings that do not validate), answered in place. A box to ask for something: **Where** picks a project (the message goes to its conversation) or none (a one-off task). A card per project: its state, today's spend against its budget, what it did last, its next scheduled run; the ones that need you come first. **New project**: a name, what it is for, a template. |
| **A project's space** | Under a header with its state, model, today's spend and Stop: **Conversation** (its own thread; files dropped or attached go into `inbox/`; approvals answered in place; what it is doing now), **Schedules** (run now, on/off, remove; a new one from plain choices, hourly to monthly or a cron line, with its next five runs), **Files** (folders, a preview of text, images and PDFs, upload by drag and drop, download, a folder as a zip), **Activity** (its runs, with cost, steps and why each stopped) and **Settings** (below). |
| **Inbox** | Everything waiting for a decision, from every project, oldest first: approvals (Approve, Deny, "All of this kind, this run", and for the admin "Always allow" where the rule can be named), mails waiting in an outbox (shown whole, as they will go), possible loops (Continue, Stop) and alerts. An answer here closes the question on Telegram too. |
| **Sessions** | Conversations with no project, on the default model ([`/session`](commands.md#session-id-text--close-id)). Each remembers only while it is open and closes a day after its last message, with its folder. |
| **Schedules** | Every schedule, from every project, with the next 24 hours on a line. |
| **Costs** | Today and this month against the budgets, the last 14 days, this month by project (with its budget), and the recent runs. |
| **Settings** | Your account; and for the admin everything that is Argus's: web access, models and providers, keys and secrets, web search, extensions, templates, budgets, channels, users, security, language, system health, and every `ops.yaml` key under **Advanced**. |

**A project's settings**, in sections and plain words: General (what it is for, the
model picked from a list with prices, a fallback, standing instructions), Tools and
access (each group Off, Ask or Allowed; widening access says what it means before you
save), Extensions, Connections (MCP servers added by URL or command and signed in with
**Connect**; git remotes and their tokens; mail: the account and who it may write to, the trusted
addresses with what each used in the last 24 hours, the daily limits, pause and resume,
the outbox, and the mailbox it reads),
Budget and limits, Memory and history (forget a section, go back to a point), the
danger zone, and Advanced (every key of its file, marked when it no longer follows its
template). A change waits in a bar until **Save**.

**Nothing to write in a file.** Every setting has a form; what applies only after a
restart says so, and **Restart now** restarts Argus once the runs in progress finish
(under Docker or systemd). Each action runs the same command you could type in the
chat (`/set`, `/config`, `/key`, `/ext`, `/template`, `/cron`…), so the checks and the
audit log are the same, and a button your role may not use is not shown.

**Finding your way.** **Ctrl+K** (⌘K) searches projects, pages and actions. Every place
has its own address (`#/p/site-firma/settings/tools`), so the back button and a link
work. On a phone the menu is a bar at the bottom.

**Look and language.** Dark or light, as your system, or chosen in the account menu.
English and Romanian ship with Argus; the admin adds a language pack in **Settings →
Language** (a JSON file of the English texts, translated; what it lacks shows in
English). Each person's choice is kept for them, on every device. What Argus writes
itself (answers to commands, Telegram notices) stays in English for now.

## Large files

The chats have limits (Telegram takes 20 MB from you and sends 50 MB). The web has
none of them:

- **Upload** on a project's page (**Files** → **Upload to inbox/**): the file is written
  to the project's `inbox/` as it arrives, never held in memory, up to
  `web.max_upload_mb` (2 GB by default) and only while enough disk stays free. A name
  already there gets ` (2)`. Then tell the project in the chat where it is.
- **Download a folder as a zip** from the same section: a whole project, or the folder
  shown. `node_modules`, `.venv` and `dist` are left out; a link inside the folder stays
  a link, so nothing outside it is read through one.
- **A file too big for the chat** that an agent sends (`send_file`) arrives as a link
  instead: it opens only in a browser signed in to the web, works once, and expires
  after `web.download_link_hours` (24 by default). A link from before a restart no
  longer works; ask for the file again.

For a codebase, use [git](configuration.md#git--remotes-argus-clones-pulls-and-pushes)
rather than uploads: a project clones and pushes it itself.

## Reach it

Any install starts **private**: the interface listens only on the server
(`127.0.0.1:3091`), nothing is opened to the internet. Three ways in, each also in
**Settings → Web access**:

**Tailscale (recommended).** [Tailscale](https://tailscale.com) gives your own devices
a private, encrypted path to the server, with a real HTTPS certificate. On the server:

```sh
argus tailscale
```

It installs Tailscale (asking first; or install it yourself), signs the server in to
your account (open the link it prints), and publishes Argus on your tailnet with
`tailscale serve`. It prints the address, like `https://argus.tail1234.ts.net`. Then,
in **Settings → Web access**, set it as the public address. On your phone and laptop,
install the Tailscale app and sign in to the same account. A new install does all of
this with `argus init --tailscale`.

**No password on your own devices.** Turn on **Sign in with Tailscale**
(`web.tailscale_identity`) and link each person's Tailscale login in **Settings →
Users** (or `/users tailscale <user> you@github`). Opening Argus through
`tailscale serve` then signs them in. The login is trusted only from what `tailscale
serve` connects from (the server itself, or, in Docker, the container's gateway; more
with `web.trusted_proxies`), and never in public mode.

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
- **You are told of every new sign-in**, on Telegram and in the web chat (the person and
  the admin): how, from where, which browser. One that was not you: **Settings →
  Security** lists where you are signed in, ends any of them or all the others; then
  change the password.
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
  enabled: true              # false turns it off
  port: 3091
  public_url: https://argus.tail1234.ts.net
  session_hours: 24
  public: false              # true: public mode, behind a proxy with HTTPS
  idle_minutes: 30           # public mode: an unused session ends
  tailscale_identity: false  # true: a linked Tailscale login signs in, no password
  trusted_proxies: []        # where else a Tailscale identity is trusted from
```

All of them are in **Settings → Web access** and **Advanced**. See
[configuration](configuration.md#web) for the details and
[security](security.md#the-web-interface) for what protects it.
