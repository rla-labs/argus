#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# Upgrade a NATIVE Argus Agent deployment, with rollback.
#
# Different from the Docker upgrade in one fundamental way: there is no image to roll
# back to. The application is a git checkout built in place, so "roll back" means
# restoring the previous REVISION and rebuilding. That is slower and it is not atomic —
# which is exactly why the backup comes first and why the schema is compared.
#
#   1. BACK UP                     before anything changes
#   2. RECORD the git revision and the schema version
#   3. FETCH and check out the new revision
#   4. INSTALL and BUILD
#   5. RESOLVE the profile's bundle (the pinned dsh may have moved)
#   6. RESTART, wait for health, smoke test
#   7. ROLL BACK the revision on failure — and the DATABASE when migrations ran
#
# The dsh VERSION is pinned by this project. An upgrade moves the REVISION, not the dsh
# version; changing dsh is a deliberate act that re-runs the spikes (see
# docs/developer-docs.md#verified-dsh-facts), so it is not something an upgrade does implicitly.
#
# Usage:
#   upgrade-native.sh [--revision REF] [--no-backup] [--force-rollback] [--dry-run]
#
# `--force-rollback` fails AFTER a successful upgrade, which is how the rollback path is
# tested deliberately rather than only in production.

# shellcheck source=lib-native.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-native.sh"

TARGET_REVISION=""
SKIP_BACKUP=0
FORCE_ROLLBACK=0
DRY_RUN=0

usage() {
  cat <<EOF
Usage: upgrade-native.sh [options]

  --revision REF    the git revision to upgrade to (default: the current branch's origin)
  --no-backup       skip the pre-upgrade backup (NOT recommended)
  --force-rollback  fail after upgrading, to exercise the rollback path
  --dry-run         show the plan; change nothing
  --help            this message

Exit: 0 on a successful upgrade, 1 when it failed (whether or not the rollback worked).

The database is restored on rollback ONLY when migrations ran: an older build against a
newer schema fails again, so restoring is the only rollback that produces a working
service. When migrations did not run, the newer data is kept.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --revision)        TARGET_REVISION="${2:?--revision needs a ref}"; shift 2 ;;
    --no-backup)       SKIP_BACKUP=1; shift ;;
    --force-rollback)  FORCE_ROLLBACK=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --help|-h)         usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

require_root

[ -d "${APP_DIR}/.git" ] || die "${APP_DIR} is not a git checkout, so there is no revision to upgrade.
This deployment was installed from a copied tree. To upgrade it, install the new revision:
  ${NATIVE_DIR}/install-native.sh"

# ── what are we upgrading FROM ─────────────────────────────────────────────────

CURRENT_REVISION="$(app_git rev-parse HEAD 2>/dev/null || echo unknown)"
CURRENT_SHORT="$(app_git rev-parse --short HEAD 2>/dev/null || echo unknown)"
CURRENT_BRANCH="$(app_git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
# Without the current revision there is nothing to roll back to, so stop before changing
# anything rather than discover it after a failed upgrade.
[ "${CURRENT_REVISION}" != "unknown" ] || die "cannot read the current revision of ${APP_DIR}; refusing to upgrade without a rollback target.
Check: git -c safe.directory=${APP_DIR} -C ${APP_DIR} rev-parse HEAD"

# The schema version, read from the live database. Compared before and after, because it
# is the only reliable signal that a migration ran.
schema_version() {
  db_schema_version "${DATA_DIR}/ops.sqlite"
}

SCHEMA_BEFORE="$(schema_version)"

if [ -z "${TARGET_REVISION}" ]; then
  TARGET_REVISION="origin/${CURRENT_BRANCH}"
fi

log ""
info "upgrade plan"
log "  application   ${APP_DIR}"
log "  revision      ${CURRENT_SHORT} → ${TARGET_REVISION}"
log "  data          ${DATA_DIR}"
log "  backup        $([ "${SKIP_BACKUP}" = "1" ] && printf 'SKIPPED (--no-backup)' || printf 'first, before anything changes')"
log "  dsh version   ${DSH_VERSION} (pinned; an upgrade does not change it)"
log ""

if [ "${DRY_RUN}" = "1" ]; then
  log "dry run: nothing was changed"
  exit 0
fi

confirm "Proceed with the upgrade?" || die "aborted"

# ── 1. back up ─────────────────────────────────────────────────────────────────

BACKUP_DB=""
if [ "${SKIP_BACKUP}" = "1" ]; then
  warn "skipping the pre-upgrade backup (--no-backup). A failed upgrade can now lose data."
else
  info "backing up before the upgrade"
  BACKUP_OUTPUT="$(ASSUME_YES=1 bash "${NATIVE_DIR}/backup-native.sh" 2>&2 || true)"
  BACKUP_DB="$(printf '%s\n' "${BACKUP_OUTPUT}" | grep -E 'ops-.*\.sqlite$' | head -n 1)"
  if [ -n "${BACKUP_DB}" ] && [ -f "${BACKUP_DB}" ]; then
    ok "backed up: $(basename "${BACKUP_DB}")"
  else
    err "the pre-upgrade backup did not produce a database artifact"
    confirm "Continue WITHOUT a verified backup?" || die "aborted: fix the backup first (deploy/docs/BACKUP-RESTORE.md)"
  fi
fi

[ -n "${SCHEMA_BEFORE}" ] && dim "  schema version before: ${SCHEMA_BEFORE}"

# ── 2. fetch and check out ─────────────────────────────────────────────────────

info "fetching"
su -s /bin/bash "${SERVICE_USER}" -c "cd '${APP_DIR}' && git fetch --all --tags --prune" \
  || die "git fetch failed; nothing was changed"

info "checking out ${TARGET_REVISION}"
# `git checkout` fails on a dirty tree, which is a FEATURE here: an operator's local
# modification should not be silently discarded by an upgrade.
if ! su -s /bin/bash "${SERVICE_USER}" -c "cd '${APP_DIR}' && git checkout '${TARGET_REVISION}'"; then
  die "could not check out ${TARGET_REVISION}. A local modification may be blocking it:
  su -s /bin/bash ${SERVICE_USER} -c 'cd ${APP_DIR} && git status'"
fi
ok "checked out $(app_git rev-parse --short HEAD)"

# ── 3. install and build ───────────────────────────────────────────────────────

export HOME="${SERVICE_HOME}"
export npm_config_store_dir="${SERVICE_HOME}/.pnpm-store"

info "installing dependencies"
if ! su -s /bin/bash "${SERVICE_USER}" -c "cd '${APP_DIR}' && pnpm install --frozen-lockfile"; then
  err "pnpm install failed"
  ROLLBACK_REASON="pnpm install failed"
fi

if [ -z "${ROLLBACK_REASON:-}" ]; then
  info "building"
  if ! su -s /bin/bash "${SERVICE_USER}" -c "cd '${APP_DIR}' && pnpm build"; then
    err "the build failed"
    ROLLBACK_REASON="the build failed"
  fi
fi

# ── 4. refresh the profile ─────────────────────────────────────────────────────
#
# The profile LINKS the bundle to the application, so the rebuild above is already what
# the service will run. Recomposing is cheap, and repairs a profile that an older
# installer left as a packed copy — which would otherwise keep running stale code.

if [ -z "${ROLLBACK_REASON:-}" ]; then
  info "refreshing the profile"
  if ( compose_profile ); then
    ok "profile composed"
  else
    ROLLBACK_REASON="the profile could not be composed"
  fi
fi

# ── 5. restart and verify ──────────────────────────────────────────────────────

if [ -z "${ROLLBACK_REASON:-}" ]; then
  info "restarting"
  systemctl restart "${SERVICE_NAME}" || ROLLBACK_REASON="the service did not restart"
fi

UPGRADE_OK=1
[ -n "${ROLLBACK_REASON:-}" ] && UPGRADE_OK=0

if [ "${UPGRADE_OK}" = "1" ]; then
  if ! wait_for_health 180; then
    ROLLBACK_REASON="the new revision never became healthy"
    UPGRADE_OK=0
  fi
fi

if [ "${UPGRADE_OK}" = "1" ]; then
  info "running the smoke test"
  if ! bash "${NATIVE_DIR}/smoke-native.sh" --quiet; then
    ROLLBACK_REASON="the smoke test failed on the new revision"
    UPGRADE_OK=0
  fi
fi

# The forced-failure hook: fail AFTER the upgrade worked, so the rollback path is
# exercised against a working service rather than only when something is already broken.
if [ "${FORCE_ROLLBACK}" = "1" ] && [ "${UPGRADE_OK}" = "1" ]; then
  warn "--force-rollback: simulating a failure now that the upgrade succeeded"
  ROLLBACK_REASON="forced failure (--force-rollback)"
  UPGRADE_OK=0
fi

# ── 6. roll back ───────────────────────────────────────────────────────────────

if [ "${UPGRADE_OK}" = "1" ]; then
  NEW_SCHEMA="$(schema_version)"
  log ""
  ok "upgrade complete"
  log ""
  log "  revision  ${CURRENT_SHORT} → $(app_git rev-parse --short HEAD)"
  [ -n "${NEW_SCHEMA}" ] && log "  schema    ${SCHEMA_BEFORE:-?} → ${NEW_SCHEMA}"
  [ -n "${BACKUP_DB}" ] && log "  backup    ${BACKUP_DB}"
  log ""
  log "To go back to the previous revision:"
  dim "  ${NATIVE_DIR}/upgrade-native.sh --revision ${CURRENT_REVISION}"
  exit 0
fi

log ""
err "UPGRADE FAILED: ${ROLLBACK_REASON}"
log ""
info "rolling back to ${CURRENT_SHORT}"

su -s /bin/bash "${SERVICE_USER}" -c "cd '${APP_DIR}' && git checkout '${CURRENT_REVISION}'" \
  || err "could not check out the previous revision — the tree may now be in a mixed state"
ok "revision restored"

info "rebuilding the previous revision"
if su -s /bin/bash "${SERVICE_USER}" -c "cd '${APP_DIR}' && pnpm install --frozen-lockfile && pnpm build"; then
  ok "rebuilt"
  ( compose_profile ) || warn "could not recompose the profile for the previous revision"
else
  err "the rebuild failed. The service may not start — restore manually, see deploy/docs/UPGRADE.md"
fi

# Did migrations run? If the schema moved, an older build against the newer database
# fails again, so the backup must go back too. If it did not move, the newer data is kept.
SCHEMA_AFTER="$(schema_version)"
MIGRATED=0
if [ -n "${SCHEMA_BEFORE}" ] && [ -n "${SCHEMA_AFTER}" ] && [ "${SCHEMA_BEFORE}" != "${SCHEMA_AFTER}" ]; then
  MIGRATED=1
fi

if [ "${MIGRATED}" = "1" ]; then
  warn "the schema changed: ${SCHEMA_BEFORE} → ${SCHEMA_AFTER}"
  if [ -n "${BACKUP_DB}" ] && [ -f "${BACKUP_DB}" ]; then
    info "restoring the pre-upgrade database (the older build cannot read the newer schema)"
    systemctl stop "${SERVICE_NAME}" || true
    sleep 2
    cp -p "${BACKUP_DB}" "${DATA_DIR}/ops.sqlite"
    # Stale sidecars belong to a DIFFERENT database: applying them to the restored file
    # corrupts it.
    rm -f "${DATA_DIR}/ops.sqlite-wal" "${DATA_DIR}/ops.sqlite-shm"
    chown "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}/ops.sqlite"
    ok "database restored from $(basename "${BACKUP_DB}")"
  else
    err "the schema changed but there is no database backup to restore"
    err "The service may not start. See deploy/docs/BACKUP-RESTORE.md"
  fi
else
  dim "  the schema did not change, so the database is kept as it is"
fi

info "starting the previous revision"
systemctl restart "${SERVICE_NAME}" || systemctl start "${SERVICE_NAME}" || true

log ""
if wait_for_health 120; then
  ok "rolled back to ${CURRENT_SHORT}; the deployment is healthy again"
else
  err "the rollback did not restore health"
  err "Manual recovery:"
  [ -n "${BACKUP_DB}" ] && err "  the pre-upgrade database: ${BACKUP_DB}"
  err "  journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
  err "  deploy/docs/TROUBLESHOOTING.md"
  exit 1
fi

log ""
log "What happened:"
log "  the upgrade to ${TARGET_REVISION} FAILED (${ROLLBACK_REASON})"
log "  the revision was restored to ${CURRENT_SHORT}"
if [ "${MIGRATED}" = "1" ]; then
  log "  the schema had changed, so the database was restored from the backup"
  log "  work done by the new revision was DISCARDED"
else
  log "  the schema had not changed, so the database was left alone"
fi
log "  the service is running and healthy on the previous revision"
log ""
if [ -n "${BACKUP_DB}" ]; then
  log "The backup taken before this attempt is still there:"
  dim "  ${BACKUP_DB}"
fi

exit 1
