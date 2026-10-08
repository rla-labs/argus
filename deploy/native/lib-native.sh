#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# Shared functions for a NATIVE (non-Docker) Argus Agent deployment.
#
# Sourced, never executed. Separate from `../scripts/lib.sh` on purpose: that library
# assumes a container it can `docker exec` into, and almost nothing here is the same.
# A native deployment has no container to read health from, no image to roll back to,
# and a service account that is a real system user rather than a fixed uid.
#
# The layout it manages:
#
#   /opt/argus-agent            the application (a git checkout, built in place)
#   /srv/argus-agent            the service account's home
#   /srv/argus-agent/data       THE DATA — database, sessions, workspaces, memory
#   /srv/argus-agent/data/dsh-home/profiles/ops    the composed profile
#   /srv/argus-agent/secrets.env                   mode 600, owned by ops
#   /etc/systemd/system/argus-agent.service        the unit

# shellcheck shell=bash

set -euo pipefail

NATIVE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly NATIVE_DIR
DEPLOY_DIR="$(cd "${NATIVE_DIR}/.." && pwd)"
readonly DEPLOY_DIR
REPO_ROOT="$(cd "${DEPLOY_DIR}/.." && pwd)"
readonly REPO_ROOT
export REPO_ROOT
readonly SERVICE_USER="ops"
readonly SERVICE_NAME="argus-agent"
readonly UNIT_PATH="/etc/systemd/system/argus-agent.service"

# ── paths, overridable for a test ──────────────────────────────────────────────
#
# Every path is an environment variable with a production default, so the whole
# installer can be exercised against a scratch tree without touching the host. That is
# how `test/deploy/native-install.test.ts` runs it.

APP_DIR="${ARGUS_AGENT_APP_DIR:-/opt/argus-agent}"
readonly APP_DIR
export APP_DIR
SERVICE_HOME="${ARGUS_AGENT_HOME:-/srv/argus-agent}"
readonly SERVICE_HOME
export SERVICE_HOME
DATA_DIR="${ARGUS_AGENT_DATA_DIR:-${SERVICE_HOME}/data}"
readonly DATA_DIR
export DATA_DIR
SECRETS_FILE="${ARGUS_AGENT_SECRETS_FILE:-${SERVICE_HOME}/secrets.env}"
readonly SECRETS_FILE
export SECRETS_FILE
CONFIG_FILE="${ARGUS_AGENT_CONFIG:-${DATA_DIR}/config/ops.yaml}"
# A native deployment resolves config from the ENVIRONMENT, because the unit sets
# ARGUS_AGENT_CONFIG explicitly and the loader row reads it from there.
readonly DSH_HOME_DIR="${DATA_DIR}/dsh-home"
readonly PROFILE_DIR="${DSH_HOME_DIR}/profiles/ops"
export PROFILE_DIR

# The dsh version the whole project is built against. Pinned exactly: the bundle's
# patches are written for this version, and a different one is a different product.
readonly DSH_VERSION="0.2.0-rc.2"
export DSH_VERSION
readonly REQUIRED_NODE_MAJOR="22"

# ── logging ────────────────────────────────────────────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  readonly C_RESET=$'\033[0m' C_DIM=$'\033[2m' C_RED=$'\033[31m'
  readonly C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BLUE=$'\033[34m' C_BOLD=$'\033[1m'
else
  readonly C_RESET='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_BOLD=''
fi

log()  { printf '%s\n' "$*" >&2; }
info() { printf '%s==>%s %s\n' "${C_BLUE}${C_BOLD}" "${C_RESET}" "$*" >&2; }
ok()   { printf '%s  ok%s %s\n' "${C_GREEN}" "${C_RESET}" "$*" >&2; }
warn() { printf '%swarn%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
err()  { printf '%s err%s %s\n' "${C_RED}" "${C_RESET}" "$*" >&2; }
dim()  { printf '%s%s%s\n' "${C_DIM}" "$*" "${C_RESET}" >&2; }
die()  { err "$*"; exit 1; }

# ── privileges ─────────────────────────────────────────────────────────────────
#
# A native install writes to /opt, /srv and /etc, so it needs root. Rather than
# sprinkling `sudo` (which fails in a container without it, and prompts unpredictably),
# the scripts require root and say so once.

require_root() {
  if [ "$(id -u)" != "0" ]; then
    # The invocation is reconstructed from the SCRIPT's own path and the caller's
    # arguments, so the suggestion is copy-pasteable rather than a bare `$0`.
    die "this must run as root: it creates a system user and writes to ${APP_DIR}, ${SERVICE_HOME} and /etc.
Re-run it with:
  sudo ${NATIVE_DIR}/$(basename "${BASH_SOURCE[1]:-install-native.sh}") $*"
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed. ${2:-}"
}

# ── confirmation ───────────────────────────────────────────────────────────────
#
# The same contract as the Docker installer: `ASSUME_YES=1` answers yes, and with no
# TTY and no ASSUME_YES the answer is NO.

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

# ── the service account ────────────────────────────────────────────────────────

service_user_exists() {
  id -u "${SERVICE_USER}" >/dev/null 2>&1
}

# Create the system user, once. `--system` gives no password and a low uid; the shell is
# `nologin` because nothing should ever log in as this account. The home is the data
# root's parent so the tree has one owner.
ensure_service_user() {
  if service_user_exists; then
    ok "the ${SERVICE_USER} user exists"
    return 0
  fi
  info "creating the ${SERVICE_USER} system user"
  useradd --system --home-dir "${SERVICE_HOME}" --create-home \
          --shell /usr/sbin/nologin "${SERVICE_USER}" \
    || die "could not create the ${SERVICE_USER} user"
  ok "created ${SERVICE_USER}"
}

# ── the data layout ────────────────────────────────────────────────────────────
#
# The SAME subdirectories the Docker entrypoint creates, listed once. A native
# deployment must produce an identical tree, or a backup taken from one could not be
# restored into the other.

readonly DATA_SUBDIRS=(config projects state scratch memory backups dsh-home)

ensure_data_layout() {
  mkdir -p "${DATA_DIR}"
  local sub
  for sub in "${DATA_SUBDIRS[@]}"; do
    mkdir -p "${DATA_DIR}/${sub}"
  done
  mkdir -p "${DATA_DIR}/config/projects"
}

data_is_initialized() {
  [ -f "${CONFIG_FILE}" ]
}

# ── systemd ────────────────────────────────────────────────────────────────────

unit_installed() { [ -f "${UNIT_PATH}" ]; }

systemd_available() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

# Is the service running, according to systemd?
service_running() {
  systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null
}

# ── the profile ────────────────────────────────────────────────────────────────
#
# dsh boots `$DSH_HOME/profiles/ops`: a `package.json` naming the bundles, the user's
# `cordis.patch.yml`, and a `node_modules` the bundles resolve from. The bundle is a
# LINK to the built application, not a packed copy: a packed bundle carries none of the
# ops-* plugins it lists as workspace peers, and dsh then mounts a tree in which every
# plugin row fails to import. Through the link, the bundle reaches each plugin through
# the application's own node_modules — the same layout the Docker image uses.
#
# The user's patch layer is kept: it is the one file in the profile an operator edits.

compose_profile() {
  local src="${APP_DIR}/profiles/ops"
  [ -f "${src}/package.json" ] || die "the profile is missing from ${src}. This is a broken checkout."
  [ -d "${APP_DIR}/packages/argus-agent/lib" ] || die "the bundle is not built: ${APP_DIR}/packages/argus-agent/lib is missing"
  mkdir -p "${PROFILE_DIR}"
  # A profile left by an older installer was a pnpm project of its own; its
  # node_modules would shadow the link below.
  rm -rf "${PROFILE_DIR}/node_modules" "${PROFILE_DIR}/pnpm-lock.yaml" "${PROFILE_DIR}/pnpm-workspace.yaml"
  cp "${src}/package.json" "${PROFILE_DIR}/package.json"
  if [ ! -f "${PROFILE_DIR}/cordis.patch.yml" ]; then
    cp "${src}/cordis.patch.yml" "${PROFILE_DIR}/cordis.patch.yml"
  fi
  mkdir -p "${PROFILE_DIR}/node_modules/@argus-agent"
  ln -sfn "${APP_DIR}/packages/argus-agent" "${PROFILE_DIR}/node_modules/@argus-agent/argus-agent"
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DSH_HOME_DIR}"
}

# How many ops rows the composed profile mounts, as dsh itself resolves it. 0 when it
# does not compose at all.
profile_ops_rows() {
  local dsh_bin
  dsh_bin="$(command -v dsh 2>/dev/null || true)"
  [ -n "${dsh_bin}" ] || { printf '0'; return; }
  su -s /bin/bash "${SERVICE_USER}" -c \
    "export HOME='${SERVICE_HOME}' DSH_HOME='${DSH_HOME_DIR}'; '${dsh_bin}' --profile ops --dump-config 2>/dev/null" \
    | grep -cE "name: .@argus-agent/" || true
}

# ── git on the application tree ────────────────────────────────────────────────
#
# The tree belongs to the service account, and these scripts run as root. Git refuses a
# repository owned by another user ("dubious ownership") since 2.35.2, so a plain
# `git -C` here returns nothing — and an upgrade that cannot read the current revision
# has nothing to roll back to. The exception is granted for this one tree, per command.

app_git() {
  git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" "$@"
}

# ── SQLite without a sqlite3 binary ────────────────────────────────────────────
#
# The application ships better-sqlite3 (ops-store's dependency), so a native host can
# read and back up the database with Node alone. The script runs from ops-store's
# directory because Node resolves `require` from there. Arguments after the script are
# `process.argv[1..]`.

app_sqlite_available() {
  [ -d "${APP_DIR}/packages/ops-store/node_modules/better-sqlite3" ] && command -v node >/dev/null 2>&1
}

app_sqlite() {
  local script="$1"
  shift
  ( cd "${APP_DIR}/packages/ops-store" && node -e "const Database = require('better-sqlite3'); ${script}" "$@" )
}

# The schema version: the highest migration ops-store recorded. Empty when unknown.
db_schema_version() {
  local db="${1:-${DATA_DIR}/ops.sqlite}"
  [ -f "${db}" ] || return 0
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "${db}" "SELECT MAX(version) FROM schema_migrations" 2>/dev/null | tr -d '[:space:]' || true
  elif app_sqlite_available; then
    app_sqlite 'const r = new Database(process.argv[1], { readonly: true }).prepare("SELECT MAX(version) AS v FROM schema_migrations").get(); console.log(r && r.v !== null ? r.v : "")' "${db}" 2>/dev/null | tr -d '[:space:]' || true
  fi
}

# ── health, WITHOUT a container ────────────────────────────────────────────────
#
# The container installer reads health with `docker exec`. Here there is no container, so
# the endpoint — which is loopback-only by design — is read directly from the host. That
# is the one thing that is EASIER natively.

native_health() {
  curl --fail --silent --max-time 8 "http://127.0.0.1:${HEALTH_PORT:-3090}/health" 2>/dev/null
}

native_health_status() {
  local body
  body="$(native_health || true)"
  [ -n "${body}" ] || return 0
  printf '%s' "${body}" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -n 1
}

# Wait until health answers. `degraded` counts as up: it means the process is serving
# and something wants attention, which is not a reason to declare the install failed.
wait_for_health() {
  local timeout="${1:-120}" elapsed=0 status
  info "waiting for health (up to ${timeout}s)"
  while [ "${elapsed}" -lt "${timeout}" ]; do
    status="$(native_health_status || true)"
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
  log "The last 40 journal lines:"
  journalctl -u "${SERVICE_NAME}" -n 40 --no-pager >&2 2>&1 || true
  return 1
}

# ── node ───────────────────────────────────────────────────────────────────────
#
# The pinned dsh requires Node 22. A distribution's `nodejs` package is frequently
# older, so the version is CHECKED rather than assumed — an 18.x node is the most common
# reason a native install fails in a confusing way.

node_major() {
  command -v node >/dev/null 2>&1 || { printf '0'; return; }
  node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

check_node() {
  local major
  major="$(node_major)"
  if [ "${major}" = "0" ]; then
    die "node is not installed. dsh requires Node ${REQUIRED_NODE_MAJOR}.x — see INSTALL-NATIVE.md, section 2."
  fi
  if [ "${major}" -lt "${REQUIRED_NODE_MAJOR}" ]; then
    die "node $(node --version) is too old: dsh requires Node ${REQUIRED_NODE_MAJOR}.x.
Install it with nvm or NodeSource — see INSTALL-NATIVE.md, section 2.
(A distribution 'nodejs' package is often older than this.)"
  fi
  ok "node $(node --version)"
}

check_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    ok "pnpm $(pnpm --version)"
    return 0
  fi
  if command -v corepack >/dev/null 2>&1; then
    info "enabling pnpm through corepack"
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@8.6.11 --activate >/dev/null 2>&1 || true
    if command -v pnpm >/dev/null 2>&1; then
      ok "pnpm $(pnpm --version) (via corepack)"
      return 0
    fi
  fi
  die "pnpm is not available. Install it: corepack enable && corepack prepare pnpm@8.6.11 --activate
Or: npm install --global pnpm@8.6.11"
}

# What the unit expects: DSH_HOME and the config path.
unit_environment() {
  printf 'DSH_HOME=%s\nARGUS_AGENT_CONFIG=%s\nARGUS_AGENT_DATA_DIR=%s\n' \
    "${DSH_HOME_DIR}" "${CONFIG_FILE}" "${DATA_DIR}"
}

# A human size, without `bc` (which a minimal host may not have).
human_size() {
  local bytes="${1:-0}"
  if   [ "${bytes}" -ge 1073741824 ]; then LC_ALL=C awk -v b="${bytes}" 'BEGIN{printf "%.1f GB", b/1073741824}'
  elif [ "${bytes}" -ge 1048576 ];    then LC_ALL=C awk -v b="${bytes}" 'BEGIN{printf "%.1f MB", b/1048576}'
  elif [ "${bytes}" -ge 1024 ];       then LC_ALL=C awk -v b="${bytes}" 'BEGIN{printf "%.1f KB", b/1024}'
  else printf '%s B' "${bytes}"
  fi
}

# Link `argus` into the PATH. A failure is only a warning: every script still runs by
# its own path.
link_argus() {
  local bin="${ARGUS_AGENT_BIN_DIR:-/usr/local/bin}"
  if ln -sfn "$1" "${bin}/argus" 2>/dev/null || sudo ln -sfn "$1" "${bin}/argus" 2>/dev/null; then
    ok "linked ${bin}/argus"
  else
    warn "could not link ${bin}/argus; run $1 by its path instead"
  fi
}

# Remove the `argus` link, when it is ours.
unlink_argus() {
  local link="${ARGUS_AGENT_BIN_DIR:-/usr/local/bin}/argus"
  case "$(readlink "${link}" 2>/dev/null || true)" in
    */deploy/argus.sh) rm -f "${link}" 2>/dev/null || sudo rm -f "${link}" 2>/dev/null || true ;;
  esac
}

timestamp() { date -u '+%Y%m%d-%H%M%S'; }
