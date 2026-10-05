#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# The container's entrypoint.
#
# Three jobs, in order, and each one refuses loudly rather than starting a
# half-working system:
#
#   1. Verify `/data` is writable, and create the directory layout.
#   2. Refuse to start without a configuration, printing how to make one.
#   3. Install the composed profile into `$DSH_HOME` and exec dsh.
#
# The profile is installed HERE rather than baked into the image, because
# `$DSH_HOME` is inside the volume: baking it in would let the image and the data
# disagree about which plugins are mounted, and the disagreement would appear as a
# missing service rather than as a version mismatch.

set -euo pipefail

readonly DATA_DIR="${ARGUS_AGENT_DATA_DIR:-/data}"
readonly CONFIG_DIR="${DATA_DIR}/config"
readonly CONFIG_FILE="${CONFIG_DIR}/ops.yaml"
readonly DSH_HOME_DIR="${DSH_HOME:-${DATA_DIR}/dsh-home}"
readonly PROFILE_NAME="ops"
readonly LOG_PREFIX="argus-agent"

log()  { printf '%s: %s\n'  "${LOG_PREFIX}" "$*" >&2; }
warn() { printf '%s: warning: %s\n' "${LOG_PREFIX}" "$*" >&2; }
die()  { printf '%s: error: %s\n' "${LOG_PREFIX}" "$*" >&2; exit 1; }

# ── 1. the data directory ───────────────────────────────────────────────────
#
# A bind mount is owned by whoever created it on the host, which is frequently root
# and frequently not the container's uid. Failing here with a clear message is much
# better than failing later with `SQLITE_CANTOPEN` from inside a plugin.

if [ ! -d "${DATA_DIR}" ]; then
  die "${DATA_DIR} does not exist. Mount a volume there, or let Docker create it with 'docker run --volume argus-agent-data:/data'."
fi

if ! touch "${DATA_DIR}/.write-test" 2>/dev/null; then
  die "${DATA_DIR} is not writable by uid $(id -u). On a bind mount, run: sudo chown -R $(id -u):$(id -g) ${DATA_DIR}"
fi
rm -f "${DATA_DIR}/.write-test"

# The layout. Every one of these is created on first boot and never removed, so a
# restart finds the same tree.
#
#   config/    ops.yaml and projects/*.yaml
#   projects/  the project workspaces (each project's cwd)
#   state/     per-project memory and secrets, OUTSIDE every workspace
#   scratch/   ad-hoc task folders and the orchestrator's cwd
#   memory/    the global USER.md
#   backups/   the dated database copies
#   dsh-home/  the dsh home: the profile and the session logs
for sub in config projects state scratch memory backups dsh-home; do
  mkdir -p "${DATA_DIR}/${sub}"
done
mkdir -p "${CONFIG_DIR}/projects"

# ── 2. the configuration ────────────────────────────────────────────────────
#
# Refusing to start is deliberate. An Argus Agent without `ops.yaml` has no data
# directory, no budgets and no allowlist — every message refused, nothing runnable —
# and an operator who sees a running container will assume it works.

if [ ! -f "${CONFIG_FILE}" ]; then
  cat >&2 <<EOF
${LOG_PREFIX}: error: ${CONFIG_FILE} is missing.

Argus Agent will not start without a configuration. Create one:

  cp /app/templates/ops.yaml.example ${CONFIG_FILE}
  \$EDITOR ${CONFIG_FILE}

At minimum, set:
  timezone        your IANA timezone, e.g. Europe/Bucharest
  data_dir        ${DATA_DIR}
  access.allowed_users   at least one { channel, userId }, or every message is refused

Then set TELEGRAM_BOT_TOKEN in the environment or in a .env file, and restart.
The full reference is deploy/docs/CONFIGURE.md.
EOF
  exit 1
fi

# A `data_dir` that disagrees with the mount is the mistake that produces an empty
# system: the database is created at the configured path, and the volume holds
# nothing. Warning is better than failing, because a relative or unusual path can be
# legitimate — but silence is not.
CONFIGURED_DATA_DIR="$(sed -n 's/^[[:space:]]*data_dir:[[:space:]]*["'"'"']\{0,1\}\([^"'"'"'#]*\).*/\1/p' "${CONFIG_FILE}" | head -n 1 | sed 's/[[:space:]]*$//')"
if [ -n "${CONFIGURED_DATA_DIR}" ] && [ "${CONFIGURED_DATA_DIR}" != "${DATA_DIR}" ]; then
  warn "ops.yaml sets data_dir: ${CONFIGURED_DATA_DIR}, but the volume is mounted at ${DATA_DIR}."
  warn "The database will be created at ${CONFIGURED_DATA_DIR}, which is NOT the volume."
  warn "Unless that is intentional, set data_dir: ${DATA_DIR} in ${CONFIG_FILE}."
fi

# ── 3. the profile ──────────────────────────────────────────────────────────
#
# dsh resolves profiles under `$DSH_HOME/profiles/<name>`, and `$DSH_HOME` is in the
# volume. The image ships the profile at /app/profiles; it is copied in on every
# boot, so an image upgrade brings its own profile with it.

readonly PROFILE_SRC="/app/profiles/${PROFILE_NAME}"
readonly PROFILE_DST="${DSH_HOME_DIR}/profiles/${PROFILE_NAME}"

if [ ! -d "${PROFILE_SRC}" ]; then
  die "the profile is missing from the image at ${PROFILE_SRC}. This is a broken build."
fi

mkdir -p "${DSH_HOME_DIR}/profiles"
rm -rf "${PROFILE_DST}"
cp -r "${PROFILE_SRC}" "${PROFILE_DST}"

# The profile's `node_modules` must resolve to the image's packages. A symlink to
# the bundle in /app keeps the profile a pointer rather than a copy, so an upgrade
# replaces the code in one place. The bundle resolves every ops-* plugin through
# its own node_modules in /app.
mkdir -p "${PROFILE_DST}/node_modules/@argus-agent"
ln -sfn /app/packages/argus-agent "${PROFILE_DST}/node_modules/@argus-agent/argus-agent"

export DSH_HOME="${DSH_HOME_DIR}"
export ARGUS_AGENT_CONFIG="${CONFIG_FILE}"
export DATA_DIR

log "data ${DATA_DIR} · config ${CONFIG_FILE} · home ${DSH_HOME}"

# ── 4. run ──────────────────────────────────────────────────────────────────
#
# `exec` so dsh replaces this shell and receives signals directly. Without it,
# `docker stop` would signal the shell and dsh would keep running until the grace
# period expired and SIGKILL arrived.

cd /app
exec dsh --profile "${PROFILE_NAME}" "$@"
