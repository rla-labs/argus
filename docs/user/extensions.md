# Extensions

An extension adds to what Argus's agents can do: **tools** (an MCP server), **programs**
the agent runs from its shell, **skills** (how-tos an agent loads when a task calls for
one) and a few lines of **instructions**.
The admin installs it once, from a git repository, and it is kept outside every
project, where no agent can change it.

## The first-party ones

| Extension | What a project gets | Install |
|---|---|---|
| **office** | `officecli` ([OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) 1.0.158): create, read, check and edit `.docx`, `.xlsx` and `.pptx`, existing documents included; screenshots of the pages, so the agent checks its layout; `office-pdf` for a PDF (the preview's layout, not Word's own export); its skill. About 320 MB, with its own headless Chrome; on a native install, Chromium's libraries ([install-native](install-native.md#1-what-you-need)). | `/ext install https://github.com/rla-labs/argus-extensions#office` |
| **media** | `ffmpeg` and `ffprobe` 7.0.2 (static, GPL): cut, join, convert, compress, extract audio, thumbnails, GIFs, subtitles; a skill of recipes, with long renders in the background. About 160 MB. | `/ext install https://github.com/rla-labs/argus-extensions#media` |
| **diagrams** | `render-mermaid`, `batch-mermaid`, `list-mermaid-themes` ([Pretty Mermaid](https://github.com/imxv/Pretty-mermaid-skills)): flowcharts, sequence, state, class, ER and XY charts from Mermaid to SVG, PNG or text, in 15 themes, no browser. About 22 MB; needs `node` and `npm`, which Argus has. | `/ext install https://github.com/rla-labs/argus-extensions#diagrams` |
| **pdf** | `pdftool` (info, text, merge, split, pages, rotate, to-png, compress, encrypt, decrypt, metadata, and from-html / from-md to make a PDF with diacritics right in the text and the bookmarks) and `qpdf` for anything else. Native, about 30 MB. No OCR. 2.0.0 drops `pdf-python`. | `/ext install https://github.com/rla-labs/argus-extensions#pdf` |
| **browser** | A headless Chromium driven with [Playwright MCP](https://github.com/microsoft/playwright-mcp) (tools `mcp__browser__…`): pages built by JavaScript, clicks, forms, the page as an accessibility tree, screenshots and PDFs into the project's folder; its skill. It reaches the **public internet only**, through Argus's egress proxy; no cookies or logins kept. Reading the page runs unasked, acting on it asks, code in the page and uploads are refused. About 290 MB; on a native install, Chromium's libraries ([install-native](install-native.md#1-what-you-need)). | `/ext install https://github.com/rla-labs/argus-extensions#browser` |
| **images** | `magick` ([ImageMagick](https://imagemagick.org) 7.1.2) under a restrictive security policy: resize, crop, convert, compress for the web, watermark, contact sheets, whole folders. About 77 MB. **x64 only**; on a native install it needs five system libraries ([install-native](install-native.md#1-what-you-need)). | `/ext install https://github.com/rla-labs/argus-extensions#images` |

Each downloads its program at install from its publisher, pinned to one version and
checked against a sha-256 the extension records, so what runs is exactly what was
reviewed. Then `/ext enable <project> office`; the button it offers (`officecli *`,
`ffprobe *`) lets the program run without asking.


## Installing one

```
/ext install https://github.com/rla-labs/argus-extensions#office
/ext install https://github.com/rla-labs/argus-extensions#office@v1.2.0
/ext install https://github.com/someone/argus-office
/ext install /srv/argus-agent/data/ext-src/office
```

The source is an `https://` git URL, or the absolute path of a git repository on the
server (with Docker, a path inside the data directory, which is all the container sees).
`#` and a folder picks an extension in a repository that holds several (the first-party
ones are all in [rla-labs/argus-extensions](https://github.com/rla-labs/argus-extensions));
only that folder is installed. `@` and a branch, tag or commit picks a version; without
one, the default branch.

Argus then:

1. **fetches it**, pinned to one commit. Git runs with no system or user configuration,
   over `https` or from a local path only, and without submodules.
2. **shows what it brings, and asks:**

   ```
   Install office 1.2.0 (3f9c2a1) from https://github.com/rla-labs/argus-extensions#office?
   Create and edit Word, Excel and PowerPoint files

   Tools (MCP servers, run confined to the project's folder):
     office: node server/index.js, access allow
   Skills: skills/office-docs
   Secrets it reads: none
   Network: not needed
   Runs now, in the sandbox (only its own folder, with the network):
     npm ci --omit=dev
   Adds to the instructions of a project that enables it:
     For .docx, .xlsx and .pptx files, use the office tools; never write them by hand.
   [ Yes ]  [ No ]
   ```

3. **runs its `install` commands in the command sandbox**: they can read the system and
   write only in the extension's own folder. They cannot read the database, the keys,
   `ops.yaml`, the conversations or any project. They do have the network, since
   `npm ci` must download packages. Without the sandbox (no Landlock), nothing is
   installed.
4. **installs it read-only** in `<data_dir>/extensions/<name>/<version>-<commit>/`, and
   records it in `<data_dir>/extensions/lock.yaml`: the source, the commit, a sha-256 of
   every installed file, who installed it and when.

**At every start, each installed extension is checked against its hash.** One whose files
changed is not used, and `argus doctor` says so; `/ext update <name>` or `/ext remove
<name>` fixes it.

## Enabling one in a project

```
/ext enable site-firma office
/ext disable site-firma office
```

`enable` adds it to the project's [`extensions`](configuration.md#extensions--tools-skills-and-instructions-installed-once)
list. From the project's next message, in the same conversation, its agent has (a run in
progress finishes first):

- **its tools.** Each MCP server is started **confined**: it reads the system and the
  extension's folder, reads and writes the project's folder (its working directory) and a
  home of its own (`state/<project>/mcp/<server>/`, out of the agent's reach), and nothing else; not the database, the keys, the conversations or
  another project. Its environment holds the secrets it declares, set with `/key`.
  Without the command sandbox it does not start. Its access is the one you saw at
  install, with its rules per tool if it has any (`browser_snapshot allow`);
  `/tools <project>` shows them, and `/set <project> mcp.<server>.access ask` or
  `/set <project> mcp.<server>.tools.<tool> deny` changes them for that project.
- **its programs**, by name in the agent's shell (`officecli`, `ffmpeg`): only the ones the
  extension names, run like any command of the project's (confined to its folder, and
  asking unless a rule allows them). A project that did not enable the extension cannot
  run them, not even by their path. Its variables (`env`) are set for those commands.
  `enable` offers the rules the extension suggests (`officecli *`) as buttons; nothing is
  allowed unasked until you press one.
- **its skills**, beside the project's own (`/skill`).
- **its instructions**, in its prompt after the project's.

`disable` takes all three away, and the project's settings for its servers with them.
Other projects, `/task` and the front desk never see an extension they did not enable.
Enabling and disabling are the admin's; on the web, a project's page has an
**Extensions** section that does the same.

## Updating and removing

```
/ext                     # what is installed, and whether it is intact
/ext update office       # its source again, same ref (or: office@v1.3.0)
/ext remove office
```

An update or a removal reaches the projects at their next message; a project that
still lists a removed extension runs without it, and `argus doctor` says so.

`update` fetches the same source and shows the same question, plus **what changes in what
it may do**: a tool added, an access widened, a new secret, the network. Nothing changes
until you say yes. `remove` asks first, then deletes its files.

Seeing the extensions is anyone's; installing, updating and removing are the admin's.

## Writing one

An extension is a git repository with `extension.yaml` at its root, or a folder of one
(`<repository>#<folder>`) with `extension.yaml` in it; its paths are then relative to
that folder:

```yaml
name: office                    # lowercase letters, digits and dashes
version: 1.2.0
summary: Create and edit Word, Excel and PowerPoint files
install:                        # run once, at install, in the sandbox, with network
  - npm ci --omit=dev
skills: [skills/office-docs]    # folders inside the repository, each with a SKILL.md
mcp:
  office:
    command: node               # a local program, run in the project's folder
    args: ["${EXTENSION_DIR}/server/index.js"]   # ${EXTENSION_DIR}: the installed extension
    access: allow               # the access the admin is asked to accept: deny, ask, allow
    tools:                      # optional, per tool (a name or a glob with * and ?)
      delete_*: ask
    timeout_s: 60
requires:
  secrets: []                   # NAMES its server reads; the admin sets them with /key
  network: false                # shown at install
bin: [bin/officecli]            # programs a project's shell runs by name (files made by install)
env:                            # set for the project's commands; never a secret
  OFFICECLI_SKIP_UPDATE: "1"
rules: ["officecli *"]          # offered as buttons at /ext enable, never applied by themselves
instructions: |                 # added to a project's instructions while it is enabled
  For .docx, .xlsx and .pptx files, use the office tools; never write them by hand.
```

| Key | Rules |
|---|---|
| `name` | 2 to 41 characters; also its folder |
| `version` | Any short version string; shown and recorded |
| `install` | Shell lines, run in order in the extension's folder; one that fails stops the install. Ten minutes in all. |
| `skills` | Paths inside the repository; each must hold a `SKILL.md` once `install` has run. A skill is read through its parent folder, so keep an extension's skills side by side (`skills/<name>/`). |
| `mcp` | Local servers only (`command`), with `args`, `env`, `access`, `tools`, `timeout_s`, and optionally `host` and `network` ([below](#the-host-channel)). The server runs in the project's folder; `${EXTENSION_DIR}` in `command`, `args` and `env` is the extension's own folder. In `env`, `${NAME}` may name only a secret in `requires.secrets`, or `${ARGUS_EGRESS_PROXY}` (the [egress proxy](configuration.md#mcp--external-tools-through-mcp-servers)'s address). |
| `requires.secrets` | `NAMES_LIKE_THIS` |
| `bin` | Paths inside the repository, each an executable file once `install` has run (not a link); their names must differ. A project gets them, and only them, on its shell's `PATH`. |
| `env` | `NAMES_LIKE_THIS` to strings; `${EXTENSION_DIR}` is the extension's folder. Not a secret (a name with KEY, TOKEN, SECRET, PASSWORD… is refused; secrets go in `requires.secrets`), and not `PATH`, `HOME`, `TMPDIR` or `LD_*`. |
| `rules` | Command rules (`officecli *`: plain words, optionally ending in `*`), offered at enable. |
| `instructions` | Up to 8 KB |

A key that is not in this list is refused, with the others named.

### The host channel

A server that runs another agent (Claude Code, for example) can ask Argus about what that
agent does, as Argus asks about what a project's own agent does. It declares it:

```yaml
mcp:
  cc:
    command: node
    args: ["${EXTENSION_DIR}/server.js"]
    host: [approvals, steps, usage]   # what it may do through Argus; the install shows it
    network: proxy                    # open (the default) or proxy: only through Argus's proxy
```

The admin sees it at install ("may ask for approvals of what it does, reports its steps,
reports its usage") and in an update's changes. A project's file cannot set either key.

`network: proxy` holds the server, and everything it starts, to Argus's egress proxy:
`HTTPS_PROXY` and `HTTP_PROXY` point at it, TCP connections reach only its port, and there
is no UDP. A program that ignores the proxy variables cannot connect at all, and neither
can one that talks to a server on its own machine (a test's dev server). See
[Security](security.md#extensions) for what it holds and where it cannot be enforced.

Such a server gets, in its environment, `ARGUS_HOST_SOCKET` (a Unix socket in a folder of
its own, which it can read but not change) and `ARGUS_HOST_TOKEN`. It speaks one JSON
object per line; each request has an `id`, which its answer carries back:

```text
→ {"id":1,"type":"hello","token":"<ARGUS_HOST_TOKEN>"}
← {"id":1,"ok":true,"project":"site","server":"cc","host":["approvals","steps","usage"]}
→ {"id":2,"type":"ask", …}
← {"id":2,"ok":false,"error":{"code":"HOST_NO_RUN","message":"site has no run in progress"}}
← {"type":"stop","reason":"cancelled"}      (from Argus, at any time: stop what you are doing)
```

- The first message must be `hello` with the token, or the connection is closed.
- The project and the run come from the socket, never from a message.
- `ask`, `step` and `usage` need `approvals`, `steps` and `usage` in `host`, and a run
  in progress in the project.
- `ask` asks whether the agent the server runs may make one tool call, judged as if
  the project's own agent made it: the project's `tools:` groups, `web_hosts`, its
  approval rules, a question to a person with the same buttons, run grants, the record.
  `tool` is the agent's own name for it, shown in the question; `as` the equivalent
  Argus tool (`bash`, `read`, `write`, `edit`, `web_fetch`, `web_search`, `todo_write`;
  anything else is asked about as `other`); `arguments` in that tool's shape. What the
  arguments hold decides: a `command` is a shell command whatever `as` says.

  ```text
  → {"id":3,"type":"ask","tool":"Bash","as":"bash","arguments":{"command":"npm test"}}
  ← {"id":3,"ok":true,"decision":"allow","reason":"allow-listed …"}
  ```

  The answer may take as long as the project's approvals timeout; anything but
  `"decision":"allow"` (a refusal, an error, no answer) means the call does not run.
- `hello`'s answer also carries what the server enforces itself, from the project's
  [`delegate`](configuration.md#delegate--an-agent-an-extension-runs-for-the-project)
  block: `limits: {max_turns, max_minutes}`, and `approval_timeout_s`, so its own
  timeouts sit above a question's.
- `step` reports one step the agent took, after it ran: `tool`, `arguments`, `ok`,
  `result` (its text, cut to a few KB). Argus watches the steps for loops and answers
  `{"continue": true}`, or `{"continue": false, "reason": "…"}`: stop the agent now (a
  loop, an exhausted budget, the run stopping) and tell the project's agent the reason.
- `usage` reports one turn of the agent: `model`, `input_tokens`, `cached_tokens`,
  `output_tokens`, and `notional_micros`, what it would have cost at the API's list prices
  (an integer, micro-USD). Argus records it against the run and the project at cost 0
  (a subscription; budgets untouched) with the notional cost beside, and counts it against
  the project's `delegate.day_turns`: past it, the answer is `{"continue": false, …}`.
- `stop` from Argus (`{"type":"stop","reason":"cancelled"}` or `"the run ended"`) means
  the same: stop the agent and everything it started.
- A message is at most 64 KB; at most 50 a second; one connection at a time.
- A refused message answers `ok: false` with a code: `HOST_MESSAGE_REFUSED`,
  `HOST_NO_RUN`, or the one of the service that refused it.
