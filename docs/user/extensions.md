# Extensions

An extension adds to what Argus's agents can do: **tools** (an MCP server), **skills**
(how-tos an agent loads when a task calls for one) and a few lines of **instructions**.
The admin installs it once, from a git repository, and it is kept outside every
project, where no agent can change it.

> **0.5.0, in progress.** Installing, updating and removing work. Enabling an extension
> in a project, which starts its tools and adds its skills there, is the next step.

## Installing one

```
/ext install https://github.com/rla-labs/argus-extensions-office
/ext install https://github.com/rla-labs/argus-extensions-office@v1.2.0
/ext install /srv/argus-agent/data/ext-src/office
```

The source is an `https://` git URL, or the absolute path of a git repository on the
server (with Docker, a path inside the data directory, which is all the container sees).
`@` and a branch, tag or commit picks a version; without one, the default branch.

Argus then:

1. **fetches it**, pinned to one commit. Git runs with no system or user configuration,
   over `https` or from a local path only, and without submodules.
2. **shows what it brings, and asks:**

   ```
   Install office 1.2.0 (3f9c2a1) from https://github.com/rla-labs/argus-extensions-office?
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

## Updating and removing

```
/ext                     # what is installed, and whether it is intact
/ext update office       # its source again, same ref (or: office@v1.3.0)
/ext remove office
```

`update` fetches the same source and shows the same question, plus **what changes in what
it may do**: a tool added, an access widened, a new secret, the network. Nothing changes
until you say yes. `remove` asks first, then deletes its files.

Seeing the extensions is anyone's; installing, updating and removing are the admin's.

## Writing one

An extension is a git repository with `extension.yaml` at its root:

```yaml
name: office                    # lowercase letters, digits and dashes
version: 1.2.0
summary: Create and edit Word, Excel and PowerPoint files
install:                        # run once, at install, in the sandbox, with network
  - npm ci --omit=dev
skills: [skills/office-docs]    # folders inside the repository, each with a SKILL.md
mcp:
  office:
    command: node               # a local program, run from the extension's folder
    args: [server/index.js]
    access: allow               # the access the admin is asked to accept: deny, ask, allow
    timeout_s: 60
requires:
  secrets: []                   # NAMES its server reads; the admin sets them with /key
  network: false                # shown at install
instructions: |                 # added to a project's instructions while it is enabled
  For .docx, .xlsx and .pptx files, use the office tools; never write them by hand.
```

| Key | Rules |
|---|---|
| `name` | 2 to 41 characters; also its folder |
| `version` | Any short version string; shown and recorded |
| `install` | Shell lines, run in order in the extension's folder; one that fails stops the install. Ten minutes in all. |
| `skills` | Paths inside the repository; each must hold a `SKILL.md` once `install` has run |
| `mcp` | Local servers only (`command`), with `args`, `env`, `access`, `timeout_s` |
| `requires.secrets` | `NAMES_LIKE_THIS` |
| `instructions` | Up to 8 KB |

A key that is not in this list is refused, with the others named.
