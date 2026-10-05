#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# Remove a NATIVE Argus Agent deployment.
#
# THE DEFAULT KEEPS THE DATA, exactly as the Docker version does. Removing a service is
# routine; destroying the database, the sessions and every project workspace is not — so
# they are separate decisions, and only one of them is the default.
#
# Unlike the Docker uninstall there is a THIRD thing to decide: the `ops` SYSTEM USER. It
# is removed only with `--purge`, because its uid may own files elsewhere on a host that
# has been in service for a while.
#
# Usage:
#   uninstall-native.sh [--purge] [--yes] [--dry-run]

# shellcheck source=lib-native.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-native.sh"

PURGE=0
DRY_RUN=0

usage() {
  cat <<EOF
Usage: uninstall-native.sh [options]

  --purge      ALSO remove the data directory, the application and the ${SERVICE_USER} user
  --yes        do not prompt (--purge still requires the data path to be named)
  --dry-run    show what would be removed
  --help       this message

Without --purge: stops and disables the service and removes the unit. The data
directory (${DATA_DIR}), the application (${APP_DIR}) and the ${SERVICE_USER} user are
LEFT ALONE, so a reinstall loses nothing.

With --purge: also deletes ${DATA_DIR}, ${APP_DIR}, the secrets and the ${SERVICE_USER}
user. NOT reversible except from a backup.

  WARNING: take a backup first.   ${NATIVE_DIR}/backup-native.sh
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

require_root

# ── what is here ───────────────────────────────────────────────────────────────

log ""
info "uninstall plan"
log "  service      stop, disable and remove the unit"
if [ "${PURGE}" = "1" ]; then
  log "  application  ${C_RED}DELETE ${APP_DIR}${C_RESET}"
  log "  data         ${C_RED}DELETE ${DATA_DIR}${C_RESET}"
  log "  secrets      ${C_RED}DELETE ${SECRETS_FILE}${C_RESET}"
  log "  user         ${C_RED}DELETE ${SERVICE_USER}${C_RESET}  (its uid may own files elsewhere)"
else
  log "  application  ${APP_DIR}  ${C_GREEN}KEPT${C_RESET}"
  log "  data         ${DATA_DIR}  ${C_GREEN}KEPT${C_RESET}"
  log "  secrets      ${SECRETS_FILE}  ${C_GREEN}KEPT${C_RESET}"
  log "  user         ${SERVICE_USER}  ${C_GREEN}KEPT${C_RESET}"
  log "               (reinstall with install-native.sh and nothing is lost)"
fi
log ""

if [ "${DRY_RUN}" = "1" ]; then
  log "dry run: nothing was removed"
  exit 0
fi

# ── confirm ────────────────────────────────────────────────────────────────────

if [ "${PURGE}" = "1" ]; then
  # A purge is irreversible, so it takes two separate acts of consent. Even with
  # ASSUME_YES the path must be NAMED, so a scripted purge cannot happen because an
  # environment variable was empty or misspelled.
  warn "This will DELETE ${DATA_DIR} and everything in it."
  log ""

  SIZE="$(du -sh "${DATA_DIR}" 2>/dev/null | cut -f1 || echo unknown)"
  DBS="$(find "${DATA_DIR}" -name '*.sqlite' -type f 2>/dev/null | wc -l)"
  log "  size             ${SIZE}"
  log "  database files   ${DBS}"
  log ""

  if [ -d "${DATA_DIR}/backups" ] && find "${DATA_DIR}/backups" -name '*.sqlite' -type f | grep -q .; then
    NEWEST="$(find "${DATA_DIR}/backups" -name 'ops-*.sqlite' -type f 2>/dev/null | sort -r | head -n 1)"
    log "  The most recent backup here is:"
    [ -n "${NEWEST}" ] && log "    ${NEWEST}"
    log ""
    warn "A backup INSIDE the directory being deleted is deleted with it."
    warn "Copy it elsewhere first if you might want it."
    log ""
  else
    warn "There are NO backups in ${DATA_DIR}/backups."
    log ""
  fi

  if [ -t 0 ] && [ "${ASSUME_YES:-0}" != "1" ]; then
    printf 'Type the data path to confirm deletion (%s): ' "${DATA_DIR}" >&2
    read -r TYPED
    [ "${TYPED}" = "${DATA_DIR}" ] || die "aborted: the path did not match"
  else
    if [ "${ARGUS_AGENT_PURGE_CONFIRM:-}" != "${DATA_DIR}" ]; then
      die "aborted: --purge without a terminal requires ARGUS_AGENT_PURGE_CONFIRM=${DATA_DIR} in the environment"
    fi
  fi
  ok "confirmed"
else
  confirm "Stop and remove the Argus Agent service?" || die "aborted"
fi

# ── stop and remove the unit ───────────────────────────────────────────────────

info "stopping the service"
systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
systemctl disable "${SERVICE_NAME}" >/dev/null 2>&1 || true
ok "stopped and disabled"

if [ -f "${UNIT_PATH}" ]; then
  rm -f "${UNIT_PATH}"
  systemctl daemon-reload || true
  systemctl reset-failed "${SERVICE_NAME}" 2>/dev/null || true
  ok "unit removed"
else
  dim "  no unit at ${UNIT_PATH}"
fi

# ── purge ──────────────────────────────────────────────────────────────────────

if [ "${PURGE}" = "1" ]; then
  # A guard against the obvious catastrophe: refuse a path that looks like something
  # other than an Argus Agent tree.
  for path in "${DATA_DIR}" "${APP_DIR}" "${SERVICE_HOME}"; do
    case "${path}" in
      /|/home|/root|/etc|/usr|/var|/opt|/srv|/tmp|/data)
        die "refusing to purge ${path}: that is a system directory, not a deployment directory" ;;
    esac
    if [ "${path}" = "${HOME}" ]; then die "refusing to purge HOME"; fi
  done

  info "removing the secrets"
  rm -f "${SECRETS_FILE}"
  # The whole service home goes: it holds the pnpm store and the profile as well.
  info "removing ${SERVICE_HOME}"
  rm -rf "${SERVICE_HOME}" || die "could not remove ${SERVICE_HOME}"

  info "removing ${APP_DIR}"
  rm -rf "${APP_DIR}" || die "could not remove ${APP_DIR}"

  # The user last, and only if it still exists: `userdel` fails on a user with running
  # processes, and a failure here is not worth aborting the whole uninstall for.
  if service_user_exists; then
    info "removing the ${SERVICE_USER} user"
    if userdel "${SERVICE_USER}" 2>/dev/null; then
      ok "user removed"
    else
      warn "could not remove the ${SERVICE_USER} user (it may own files elsewhere, or have running processes)"
      warn "remove it later with: userdel ${SERVICE_USER}"
    fi
  fi
fi

# ── report ─────────────────────────────────────────────────────────────────────

log ""
ok "uninstall complete"
log ""
if [ "${PURGE}" = "1" ]; then
  log "  service      removed"
  log "  application  DELETED"
  log "  data         DELETED"
  log ""
  log "To install again:"
  dim "  ${NATIVE_DIR}/install-native.sh"
else
  log "  service      removed"
  log "  application  kept at ${APP_DIR}"
  log "  data         kept at ${DATA_DIR}"
  log ""
  log "Your data — the database, the sessions, the workspaces and the configuration —"
  log "is untouched. To install again:"
  dim "  ${NATIVE_DIR}/install-native.sh"
  log ""
  log "It will reuse the existing application and configuration and restart the service."
  log ""
  log "To remove the data and the user as well:"
  dim "  ${NATIVE_DIR}/uninstall-native.sh --purge"
fi
log ""
