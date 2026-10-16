#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# The command sandbox inside the REAL image, hardened as compose runs it (read-only root,
# no capabilities, no-new-privileges): what a project's shell may read and write.
#
#   pnpm test:docker-sandbox
#
# It builds the image, runs a throwaway container on a throwaway volume, and confines
# each probe through Argus's sandbox row exactly as an agent's `bash` is confined. It
# never touches an existing argus-agent container or volume, and removes all it created.
# It needs Docker and a kernel with Landlock. It is NOT part of `pnpm test`.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="argus-agent:sandbox-test"
VOLUME="argus-sandbox-test-$$"

cleanup() {
  docker volume rm -f "${VOLUME}" >/dev/null 2>&1 || true
  docker image rm -f "${IMAGE}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> building the image (a few minutes)"
docker build -q -f "${REPO}/deploy/docker/Dockerfile" -t "${IMAGE}" "${REPO}" >/dev/null

echo "==> probing, confined, in a hardened container"
docker volume create "${VOLUME}" >/dev/null
# A fresh volume belongs to root; the image runs as ops (10001).
docker run --rm -u 0 -v "${VOLUME}:/data" --entrypoint chown "${IMAGE}" 10001:10001 /data
docker run --rm -i -v "${VOLUME}:/data" \
  --read-only --tmpfs /tmp:size=64m,mode=1777,exec \
  --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 512 \
  --workdir /app/packages/argus-agent \
  --entrypoint node "${IMAGE}" --input-type=module - <<'EOF'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire('/app/packages/argus-agent/lib/sandbox-row.js')
const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
const { default: ArgusSandbox } = await import('/app/packages/argus-agent/lib/sandbox-row.js')

// The data as Argus lays it out, with a marker in each file a project must not read.
const alpha = '/data/projects/alpha'
mkdirSync(alpha, { recursive: true })
mkdirSync('/data/projects/beta', { recursive: true })
mkdirSync('/data/dsh-home/sessions', { recursive: true })
mkdirSync('/data/config', { recursive: true })
writeFileSync('/data/ops.sqlite', 'SECRET-DB')
writeFileSync('/data/projects/beta/notes.md', 'SECRET-BETA')
writeFileSync('/data/dsh-home/sessions/s1.jsonl', 'SECRET-SESSION')
writeFileSync('/data/dsh-home/.credentials.yaml', 'SECRET-KEYS')
writeFileSync('/data/config/ops.yaml', 'SECRET-CONFIG')

const sandbox = new ArgusSandbox(new Context())
let failed = 0
const check = (what, ok) => { console.log(`${ok ? '  ok' : ' err'} ${what}`); if (!ok) failed = 1 }
const run = async (command, mode = 'workspace-write') => {
  const { argv } = await sandbox.confine(['sh', '-c', command], { mode, workspaceRoot: alpha })
  const out = spawnSync(argv[0], argv.slice(1), { cwd: alpha, encoding: 'utf8' })
  return { code: out.status, text: `${out.stdout}${out.stderr}` }
}
const refused = async (what, command) => {
  const { code, text } = await run(command)
  check(what, code !== 0 && !text.includes('SECRET'))
}

check('Landlock is fully enforced', sandbox.doctor()[0].detail.startsWith('Landlock: '))
await refused('cannot read the database', 'cat /data/ops.sqlite')
await refused("cannot read another project's file", 'cat /data/projects/beta/notes.md')
await refused('cannot read a conversation', 'cat /data/dsh-home/sessions/s1.jsonl')
await refused('cannot read the credentials', 'cat /data/dsh-home/.credentials.yaml')
await refused('cannot read ops.yaml', 'cat /data/config/ops.yaml')
await refused('cannot list /data', 'ls /data')
await refused('cannot list the application', 'ls /app')
await refused('cannot write outside its folder', 'echo x > /data/projects/beta/planted.md')
check('nothing was planted', !existsSync('/data/projects/beta/planted.md'))
await refused('cannot write to /tmp outside its own area', 'echo x > /tmp/planted')

const own = await run('echo hello > out.txt && cat out.txt')
check('writes and reads its own folder', own.code === 0 && readFileSync(`${alpha}/out.txt`, 'utf8') === 'hello\n')
check('runs node', (await run('node -e "console.log(6*7)"')).text.includes('42'))
check('runs git in its folder', (await run('git init -q && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m x && git log --oneline')).code === 0)
check('runs uv', (await run('uv --version')).text.startsWith('uv '))
check('has a private temp folder', (await run('touch "$TMPDIR/x" && echo "$TMPDIR"')).text.includes('argus-sandbox'))
const readOnly = await run('echo x > ro.txt', 'read-only')
check('read-only mode cannot write its folder', readOnly.code !== 0 && !existsSync(`${alpha}/ro.txt`))

console.log()
console.log(failed ? 'docker sandbox test: FAILED' : 'docker sandbox test: PASSED')
process.exit(failed)
EOF
