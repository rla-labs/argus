#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# Remove Argus Agent.
#
# THE DEFAULT KEEPS THE DATA. A container is replaceable in seconds; a database holds
# months of work. Removing containers is a routine operation, and destroying the data
# is not — so they are separate decisions, and only one of them is the default.
#
# Usage:
#   uninstall.sh [--purge] [--yes] [--dry-run]
#
# `--purge` removes the data directory, and requires an explicit confirmation unless
# ASSUME_YES is set — in which case it still requires the directory to be named, so a
# typo in an environment variable cannot delete a home directory.

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

readonly SCRIPT_NAME="uninstall.sh"
PURGE=0
DRY_RUN=0

usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME} [options]

  --purge      ALSO remove the data directory. Destructive; see the warning below.
  --yes        do not prompt (--purge still requires the path to be named)
  --dry-run    show what would be removed
  --help       this message

Without --purge: stops and removes the containers and the network. The data directory
(${DATA_PATH}) is LEFT ALONE, and the image is left on disk so a reinstall is fast.

With --purge: also deletes ${DATA_PATH} — the database, the sessions, every project
workspace, the memory and the configuration. This is not reversible except from a
backup.

  WARNING: take a backup first.   ${LIB_DIR}/backup.sh
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --purge)   PURGE=1; shift ;;
    --yes|-y)  ASSUME_YES=1; export ASSUME_YES; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

require_docker

# ── what is here ───────────────────────────────────────────────────────────────

log ""
info "uninstall plan"
log "  containers   stop and remove"
log "  network      remove"
if [ "${PURGE}" = "1" ]; then
  log "  data         ${C_RED}DELETE ${DATA_PATH}${C_RESET}"
  log "               (the database, sessions, workspaces, memory and configuration)"
else
  log "  data         ${DATA_PATH}  ${C_GREEN}KEPT${C_RESET}"
  log "               (reinstall with install.sh and nothing is lost)"
  log "  image        kept, so a reinstall needs no download"
fi
log ""

if [ "${DRY_RUN}" = "1" ]; then
  log "dry run: nothing was removed"
  exit 0
fi

# ── confirm ────────────────────────────────────────────────────────────────────

if [ "${PURGE}" = "1" ]; then
  # A purge is irreversible, so it takes two separate acts of consent. Even with
  # ASSUME_YES, the path must be NAMED — the point is that a scripted purge cannot
  # happen because `ARGUS_AGENT_DATA_PATH` was empty or misspelled.
  warn "This will DELETE ${DATA_PATH} and everything in it."
  log ""

  DB_SIZE="$(du -sh "${DATA_PATH}" 2>/dev/null | cut -f1 || echo unknown)"
  DB_COUNT="$(find "${DATA_PATH}" -name '*.sqlite' -type f 2>/dev/null | wc -l)"
  log "  size             ${DB_SIZE}"
  log "  database files   ${DB_COUNT}"
  log ""

  if [ -d "${DATA_PATH}/backups" ] && find "${DATA_PATH}/backups" -name '*.sqlite' -type f | grep -q .; then
    log "  The most recent backup here is:"
    NEWEST="$(find "${DATA_PATH}/backups" -name 'ops-*.sqlite' -type f 2>/dev/null | sort -r | head -n 1)"
    [ -n "${NEWEST}" ] && log "    ${NEWEST}"
    log ""
    warn "A backup INSIDE the directory being deleted is deleted with it."
    warn "Copy it elsewhere first if you might want it."
    log ""
  else
    warn "There are NO backups in ${DATA_PATH}/backups."
    log ""
  fi

  # The typed confirmation. Only when there is a terminal; a scripted purge must use
  # the environment variable below, which is explicit by construction.
  if [ -t 0 ] && [ "${ASSUME_YES:-0}" != "1" ]; then
    printf 'Type the data path to confirm deletion (%s): ' "${DATA_PATH}" >&2
    read -r TYPED
    if [ "${TYPED}" != "${DATA_PATH}" ]; then
      die "aborted: the path did not match"
    fi
  else
    if [ "${ARGUS_AGENT_PURGE_CONFIRM:-}" != "${DATA_PATH}" ]; then
      die "aborted: --purge without a terminal requires ARGUS_AGENT_PURGE_CONFIRM=${DATA_PATH} in the environment"
    fi
  fi
  ok "confirmed"
else
  confirm "Stop and remove the Argus Agent containers?" || die "aborted"
fi

# ── stop and remove ────────────────────────────────────────────────────────────

info "stopping the service"
if service_running || docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  compose down --remove-orphans 2>/dev/null || compose down 2>/dev/null || {
    # Compose can fail when `.env` is gone or the file changed; fall back to Docker's
    # own remove, which needs no compose file.
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  }
  # The Ollama overlay has its own container.
  docker rm -f "argus-agent-ollama" >/dev/null 2>&1 || true
  ok "containers removed"
else
  dim "  no containers to remove"
fi

# ── purge ──────────────────────────────────────────────────────────────────────

if [ "${PURGE}" = "1" ]; then
  info "removing ${DATA_PATH}"

  # A guard against the obvious catastrophe: refuse to delete a path that looks like
  # something other than an Argus Agent data directory.
  case "${DATA_PATH}" in
    /|/home|/root|/etc|/usr|/var|/data|/srv|/opt|/tmp)
      die "refusing to purge ${DATA_PATH}: that is a system directory, not a data directory. Set ARGUS_AGENT_DATA_PATH correctly." ;;
  esac
  if [ "${DATA_PATH}" = "${HOME}" ] || [ "${DATA_PATH}" = "${HOME}/" ]; then
    die "refusing to purge HOME"
  fi

  if [ -d "${DATA_PATH}" ]; then
    # `rm -rf` needs either ownership or sudo. The directory is owned by uid 10001.
    if ! rm -rf "${DATA_PATH}" 2>/dev/null; then
      warn "removing as the current user failed (the directory is owned by uid 10001)"
      if [ "$(id -u)" = "0" ]; then
        rm -rf "${DATA_PATH}"
      else
        sudo rm -rf "${DATA_PATH}" || die "could not remove ${DATA_PATH}. Remove it manually: sudo rm -rf ${DATA_PATH}"
      fi
    fi
    ok "data directory removed"
  else
    dim "  ${DATA_PATH} does not exist"
  fi
fi

# ── report ─────────────────────────────────────────────────────────────────────

log ""
ok "uninstall complete"
log ""
if [ "${PURGE}" = "1" ]; then
  log "  containers   removed"
  log "  data         DELETED"
  log ""
  log "To install again:"
  dim "  ${LIB_DIR}/install.sh"
else
  log "  containers   removed"
  log "  data         kept at ${DATA_PATH}"
  log ""
  log "Your data — the database, the sessions, the workspaces and the configuration —"
  log "is untouched. To install again:"
  dim "  ${LIB_DIR}/install.sh"
  log ""
  log "It will detect the existing configuration, keep it, and restart the service."
  log ""
  log "To remove the data as well:"
  dim "  ${LIB_DIR}/uninstall.sh --purge"
fi
log ""
if docker image inspect "$(configured_image)" >/dev/null 2>&1; then
  log "The image is still on disk. To reclaim the space:"
  dim "  docker rmi $(configured_image)"
fi
