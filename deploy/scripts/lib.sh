#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# Shared functions for the deploy scripts.
#
# Sourced, never executed. Every script that sources this gets the same logging,
# the same confirmation prompts and the same compose invocation, so an operator
# learns one set of behaviours rather than six.

# shellcheck shell=bash

set -euo pipefail

# ── where things are ───────────────────────────────────────────────────────────
#
# Resolved from this file's own location, so a script works from any cwd — including
# the one an operator happens to be in when they run it from a path.

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LIB_DIR
DEPLOY_DIR="$(cd "${LIB_DIR}/.." && pwd)"
readonly DEPLOY_DIR
readonly COMPOSE_DIR="${DEPLOY_DIR}/compose"
readonly COMPOSE_FILE="${COMPOSE_DIR}/docker-compose.yml"
readonly OLLAMA_COMPOSE_FILE="${COMPOSE_DIR}/docker-compose.ollama.yml"

# The project root, for a build-from-checkout. Exported so install.sh and upgrade.sh
# (which source this file) read it without re-deriving it.
REPO_ROOT="$(cd "${DEPLOY_DIR}/.." && pwd)"
readonly REPO_ROOT
export REPO_ROOT

# ── defaults ───────────────────────────────────────────────────────────────────

readonly DEFAULT_DATA_PATH="/srv/argus-agent/data"
readonly CONTAINER_NAME="argus-agent"
# The compose SERVICE, which is what `compose stop/start` take — not the container name.
# shellcheck disable=SC2034  # used by the scripts that source this file
readonly COMPOSE_SERVICE="ops"

# Before the rename the project was dsh-ops. These keep a deployment installed under
# that name upgradable: its container, its data path and its DSH_OPS_* variables.
readonly LEGACY_CONTAINER_NAME="dsh-ops"
readonly LEGACY_DATA_PATH="/srv/dsh-ops/data"

DATA_PATH="${ARGUS_AGENT_DATA_PATH:-${DSH_OPS_DATA_PATH:-}}"
if [ -z "${DATA_PATH}" ]; then
  DATA_PATH="${DEFAULT_DATA_PATH}"
  if [ ! -d "${DEFAULT_DATA_PATH}" ] && [ -d "${LEGACY_DATA_PATH}" ]; then
    DATA_PATH="${LEGACY_DATA_PATH}"
  fi
fi
readonly DATA_PATH

# ── logging ────────────────────────────────────────────────────────────────────
#
# Everything goes to stderr EXCEPT the output a caller may want to capture (a backup
# path, a JSON status). That way `BACKUP=$(backup.sh)` is usable while the progress
# is still visible.

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  readonly C_RESET=$'\033[0m' C_DIM=$'\033[2m' C_RED=$'\033[31m'
  readonly C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BLUE=$'\033[34m' C_BOLD=$'\033[1m'
else
  readonly C_RESET='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_BOLD=''
fi

log()     { printf '%s\n' "$*" >&2; }
info()    { printf '%s==>%s %s\n' "${C_BLUE}${C_BOLD}" "${C_RESET}" "$*" >&2; }
ok()      { printf '%s  ok%s %s\n' "${C_GREEN}" "${C_RESET}" "$*" >&2; }
warn()    { printf '%swarn%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
err()     { printf '%s err%s %s\n' "${C_RED}" "${C_RESET}" "$*" >&2; }
dim()     { printf '%s%s%s\n' "${C_DIM}" "$*" "${C_RESET}" >&2; }

die() { err "$*"; exit 1; }

# ── preconditions ──────────────────────────────────────────────────────────────

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed. $2"
}

require_docker() {
  require_command docker "Install it from https://docs.docker.com/engine/install/ or run install.sh, which offers to."
  # `docker info` is the honest check: the CLI can be installed while the daemon is
  # not running, and a `compose up` against a stopped daemon fails with a message
  # about a socket rather than about Docker.
  if ! docker info >/dev/null 2>&1; then
    die "the Docker daemon is not reachable. Start it (sudo systemctl start docker) or add $USER to the docker group."
  fi
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    die "docker compose is not available. Install the Compose plugin: https://docs.docker.com/compose/install/"
  fi
}

# `docker compose` with the project's file, from its own directory so relative paths
# in the compose file resolve the way the file's author intended.
compose() {
  ( cd "${COMPOSE_DIR}" && "${COMPOSE[@]}" -f "${COMPOSE_FILE}" "$@" )
}

# Compose with the Ollama overlay, when it is in use.
compose_with_overlay() {
  ( cd "${COMPOSE_DIR}" && "${COMPOSE[@]}" -f "${COMPOSE_FILE}" -f "${OLLAMA_COMPOSE_FILE}" "$@" )
}

# Whether the Ollama overlay is active, according to `.env`.
using_ollama() {
  [ -f "${COMPOSE_DIR}/.env" ] && grep -qE '^[[:space:]]*OLLAMA_BASE_URL=' "${COMPOSE_DIR}/.env" 2>/dev/null
}

# ── confirmation ───────────────────────────────────────────────────────────────

# Ask before doing something destructive.
#
# `ASSUME_YES=1` answers yes, which is what the non-interactive path uses. With no
# TTY and no ASSUME_YES the answer is NO, because a script that proceeds
# destructively because nobody was there to say no is the worst possible default.
confirm() {
  local prompt="$1"
  if [ "${ASSUME_YES:-0}" = "1" ]; then
    dim "${prompt} → yes (ASSUME_YES=1)"
    return 0
  fi
  if [ ! -t 0 ]; then
    warn "${prompt} → no (not a terminal; set ASSUME_YES=1 to proceed)"
    return 1
  fi
  local answer
  printf '%s [y/N] ' "${prompt}" >&2
  read -r answer
  case "${answer}" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# Ask for a value, with a default. Empty input takes the default.
ask() {
  local prompt="$1" default="${2:-}" answer
  if [ ! -t 0 ]; then
    printf '%s' "${default}"
    return 0
  fi
  if [ -n "${default}" ]; then
    printf '%s [%s] ' "${prompt}" "${default}" >&2
  else
    printf '%s ' "${prompt}" >&2
  fi
  read -r answer
  printf '%s' "${answer:-${default}}"
}

# ── the container ──────────────────────────────────────────────────────────────

# Whether the service is running, according to Docker.
service_running() {
  local state
  state="$(docker inspect --format '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null || echo false)"
  [ "${state}" = "true" ]
}

# The host directory bind-mounted at /data in the container; empty when there is none.
container_data_source() {
  docker inspect --format '{{range .Mounts}}{{if and (eq .Destination "/data") (eq .Type "bind")}}{{.Source}}{{end}}{{end}}' \
    "${CONTAINER_NAME}" 2>/dev/null || true
}

# Refuse to act on a RUNNING container that serves another data directory. Without
# this, a backup of DATA_PATH would read the container's database — a different
# deployment's — and a restore would stop and restart the wrong service.
require_matching_container() {
  service_running || return 0
  local source
  source="$(container_data_source)"
  [ -n "${source}" ] || return 0
  [ "$(realpath -m "${source}")" = "$(realpath -m "${DATA_PATH}")" ] && return 0
  die "the running ${CONTAINER_NAME} container serves ${source}, not ${DATA_PATH}. Set ARGUS_AGENT_DATA_PATH=${source}, or stop that container first."
}

# The health endpoint, read from INSIDE the container.
#
# From inside, deliberately: the endpoint is loopback-only and not published, so
# reading it from the host would test whether a port was forwarded rather than
# whether the system is healthy.
container_health() {
  docker exec "${CONTAINER_NAME}" curl --fail --silent --max-time 8 \
    "http://127.0.0.1:3090/health" 2>/dev/null
}

# The health status alone: ok, degraded or down. Empty when unreachable.
container_health_status() {
  local body
  body="$(container_health || true)"
  [ -n "${body}" ] || return 0
  printf '%s' "${body}" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -n 1
}

# Wait until the health endpoint answers at all.
#
# `degraded` counts as up: it means the system is running and something wants
# attention, which is not a reason to declare the install failed.
wait_for_health() {
  local timeout="${1:-120}" elapsed=0 status
  info "waiting for health (up to ${timeout}s)"
  while [ "${elapsed}" -lt "${timeout}" ]; do
    status="$(container_health_status || true)"
    if [ -n "${status}" ]; then
      case "${status}" in
        ok)       ok "health: ok"; return 0 ;;
        degraded) warn "health: degraded (running, but something wants attention)"; return 0 ;;
        down)     dim "  health: down, still waiting…" ;;
      esac
    fi
    sleep 2
    elapsed=$((elapsed + 2))
    if [ $((elapsed % 20)) -eq 0 ]; then dim "  still waiting (${elapsed}s)…"; fi
  done
  err "health did not come up within ${timeout}s"
  log ""
  log "The last 40 log lines:"
  docker logs --tail 40 "${CONTAINER_NAME}" >&2 2>&1 || true
  return 1
}

# ── the data directory ─────────────────────────────────────────────────────────

# The layout the entrypoint also creates. Duplicated HERE so `backup.sh` and
# `restore.sh` can tell an empty directory from a populated one without starting a
# container.
readonly DATA_SUBDIRS=(config projects state scratch memory backups dsh-home)

# Create the data directory and its layout.
ensure_data_layout() {
  mkdir -p "${DATA_PATH}"
  local sub
  for sub in "${DATA_SUBDIRS[@]}"; do
    mkdir -p "${DATA_PATH}/${sub}"
  done
  mkdir -p "${DATA_PATH}/config/projects"
}

# Whether the data directory holds an initialization worth keeping.
data_is_initialized() {
  [ -f "${DATA_PATH}/config/ops.yaml" ]
}

# ── misc ───────────────────────────────────────────────────────────────────────

# The current time, UTC, for filenames. Sorts lexicographically.
timestamp() { date -u '+%Y%m%d-%H%M%S'; }

# A human size.
human_size() {
  local bytes="${1:-0}"
  # awk under LC_ALL=C: printf's `%.1f` follows LC_NUMERIC, and a locale with a
  # decimal comma (ro_RO, de_DE, …) rejects the `.` that bc prints.
  if   [ "${bytes}" -ge 1073741824 ]; then LC_ALL=C awk -v b="${bytes}" 'BEGIN{printf "%.1f GB", b/1073741824}'
  elif [ "${bytes}" -ge 1048576 ];    then LC_ALL=C awk -v b="${bytes}" 'BEGIN{printf "%.1f MB", b/1048576}'
  elif [ "${bytes}" -ge 1024 ];       then LC_ALL=C awk -v b="${bytes}" 'BEGIN{printf "%.1f KB", b/1024}'
  else printf '%s B' "${bytes}"
  fi
}

# The image the deployment is running, from `.env`.
configured_image() {
  if [ -f "${COMPOSE_DIR}/.env" ]; then
    sed -n -E 's/^[[:space:]]*(ARGUS_AGENT|DSH_OPS)_IMAGE=(.*)/\2/p' "${COMPOSE_DIR}/.env" | head -n 1
  fi
}

# The image a RUNNING container is actually using — which can differ from `.env`
# after a rollback, and is why an upgrade records this rather than the setting.
running_image() {
  local name
  name="$(existing_container)"
  [ -n "${name}" ] || return 0
  docker inspect --format '{{.Config.Image}}' "${name}" 2>/dev/null || true
}

# The deployment's container: the current name, else the pre-rename `dsh-ops`.
# Empty when neither exists. Each name is checked on its own, because
# `docker inspect` prints an empty line for a missing container — chaining two
# inspects with `||` returned that blank line glued to the real answer.
existing_container() {
  local name
  for name in "${CONTAINER_NAME}" "${LEGACY_CONTAINER_NAME}"; do
    if docker inspect "${name}" >/dev/null 2>&1; then
      printf '%s\n' "${name}"
      return 0
    fi
  done
}

# The version label baked into an image.
image_version() {
  docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$1" 2>/dev/null || true
}
