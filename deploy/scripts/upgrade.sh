#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# Upgrade an Argus Agent deployment, with rollback.
#
# The sequence is deliberately conservative, because the failure it exists for — a new
# image that migrates the database and then fails — is the one where being careful
# matters most:
#
#   1. BACK UP first. Before anything changes. A backup taken after the upgrade is a
#      backup of the broken state.
#   2. RECORD the running image tag, read from the CONTAINER rather than from `.env`,
#      because a previous rollback may have left them different.
#   3. PULL or BUILD the new image.
#   4. STOP, migrate, START.
#   5. SMOKE TEST.
#   6. ROLL BACK the image on failure, and the DATABASE too when migrations ran.
#
# Usage:
#   upgrade.sh [--to IMAGE] [--build] [--no-backup] [--force-rollback] [--dry-run] [--yes]
#
# `--force-rollback` fails on purpose after the upgrade, which is how the rollback path
# itself is tested. Without it, the rollback code would only ever run in production.

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

readonly SCRIPT_NAME="upgrade.sh"
TARGET_IMAGE=""
BUILD_FROM_SOURCE=0
SKIP_BACKUP=0
FORCE_ROLLBACK=0
DRY_RUN=0
ENV_FILE="${COMPOSE_DIR}/.env"

usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME} [options]

  --to IMAGE        the image to upgrade to (default: the tag in .env)
  --build           build from this checkout instead of pulling
  --no-backup       skip the pre-upgrade backup (NOT recommended)
  --force-rollback  fail after upgrading, to exercise the rollback path
  --dry-run         show the plan; change nothing
  --yes             answer yes to every confirmation
  --help            this message

Exit: 0 on a successful upgrade, 1 when the upgrade failed (whether or not the
rollback succeeded).

The database is restored on rollback ONLY when migrations ran, because a rollback to
an older image against a newer schema fails again. When migrations did not run, the
newer data is kept — losing a day of runs to undo an image change would be worse than
the problem.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --to)              TARGET_IMAGE="${2:?--to needs an image reference}"; shift 2 ;;
    --build)           BUILD_FROM_SOURCE=1; shift ;;
    --no-backup)       SKIP_BACKUP=1; shift ;;
    --force-rollback)  FORCE_ROLLBACK=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --yes|-y)          ASSUME_YES=1; export ASSUME_YES; shift ;;
    --help|-h)         usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

require_docker

# A deployment installed before the rename has DSH_OPS_* keys in `.env`; compose now
# reads ARGUS_AGENT_*. Rename them once, keeping a copy, so the data mount and the
# image survive the upgrade.
if [ -f "${ENV_FILE}" ] && grep -qE '^[[:space:]]*DSH_OPS_' "${ENV_FILE}"; then
  cp "${ENV_FILE}" "${ENV_FILE}.pre-argus"
  sed -E 's/^([[:space:]]*)DSH_OPS_/\1ARGUS_AGENT_/' "${ENV_FILE}.pre-argus" > "${ENV_FILE}.tmp"
  mv "${ENV_FILE}.tmp" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}" 2>/dev/null || true
  ok "renamed the DSH_OPS_* keys in .env to ARGUS_AGENT_* (copy kept as .env.pre-argus)"
fi

[ -d "${DATA_PATH}" ] || die "the data directory ${DATA_PATH} does not exist. Is Argus Agent installed?"

# ── what are we upgrading FROM ─────────────────────────────────────────────────

# Read from the CONTAINER, not from `.env`. After a rollback the two differ, and the
# container is what is actually running.
CURRENT_IMAGE="$(running_image)"
if [ -z "${CURRENT_IMAGE}" ]; then
  # Not running: the configured tag is the best available answer.
  CURRENT_IMAGE="$(configured_image)"
  [ -n "${CURRENT_IMAGE}" ] || die "cannot determine the current image. Is Argus Agent installed? (no container and no ARGUS_AGENT_IMAGE in .env)"
  warn "the service is not running; using the configured image ${CURRENT_IMAGE}"
fi

CURRENT_VERSION="$(image_version "${CURRENT_IMAGE}")"

# The target: --to, else the tag in .env, else the current one.
if [ -z "${TARGET_IMAGE}" ]; then
  TARGET_IMAGE="$(configured_image)"
  TARGET_IMAGE="${TARGET_IMAGE:-${CURRENT_IMAGE}}"
fi

log ""
info "upgrade plan"
log "  from     ${CURRENT_IMAGE}${CURRENT_VERSION:+  (version ${CURRENT_VERSION})}"
log "  to       ${TARGET_IMAGE}"
log "  data     ${DATA_PATH}"
log "  backup   $([ "${SKIP_BACKUP}" = "1" ] && printf 'SKIPPED (--no-backup)' || printf 'first, before anything changes')"
log ""

if [ "${CURRENT_IMAGE}" = "${TARGET_IMAGE}" ] && [ "${BUILD_FROM_SOURCE}" = "0" ]; then
  warn "the target equals the current image — this will restart the same version"
  log "  Pass --to <image> to change version, or --build to rebuild from this checkout."
  log "  Pulling again is still useful: a moving tag like ':latest' may have been"
  log "  republished."
  log ""
fi

if [ "${DRY_RUN}" = "1" ]; then
  log "dry run: nothing was changed"
  exit 0
fi

confirm "Proceed with the upgrade?" || die "aborted"

# ── 1. back up ─────────────────────────────────────────────────────────────────

BACKUP_DB=""
BACKUP_DATA=""

if [ "${SKIP_BACKUP}" = "1" ]; then
  warn "skipping the pre-upgrade backup (--no-backup). A failed upgrade can now lose data."
else
  info "backing up before the upgrade"
  # The backup's stdout is the artifact paths, one per line; its progress went to
  # stderr.
  BACKUP_OUTPUT="$(ASSUME_YES=1 bash "${LIB_DIR}/backup.sh" 2>&2 || true)"
  BACKUP_DB="$(printf '%s\n' "${BACKUP_OUTPUT}" | grep -E 'ops-.*\.sqlite$' | head -n 1)"
  BACKUP_DATA="$(printf '%s\n' "${BACKUP_OUTPUT}" | grep -E 'data-.*\.tar\.gz$' | head -n 1)"

  if [ -z "${BACKUP_DB}" ] || [ ! -f "${BACKUP_DB}" ]; then
    err "the pre-upgrade backup did not produce a database artifact"
    if ! confirm "Continue WITHOUT a verified backup?"; then
      die "aborted: fix the backup first (docs/user/backup-and-upgrade.md#backup-and-restore)"
    fi
  else
    ok "backed up: $(basename "${BACKUP_DB}")"
  fi
fi

# ── 2. the schema version, before ──────────────────────────────────────────────
#
# Recorded so the rollback can tell whether migrations ran. Comparing schema versions
# is the only reliable signal: a migration that only added an index runs and succeeds,
# and rolling an older image back onto it is still a mismatch.

# `-w`: better-sqlite3 is ops-store's dependency, and `require` resolves from the
# working directory.
schema_version() {
  local container
  container="$(existing_container)"
  [ -n "${container}" ] || return 0
  docker exec -w /app/packages/ops-store "${container}" node -e '
    try {
      const Database = require("better-sqlite3");
      const db = new Database("/data/ops.sqlite", { readonly: true });
      // ops-store records every applied migration in `schema_migrations`; the
      // highest version is the schema version.
      const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
      db.close();
      console.log(row && row.v !== null ? String(row.v) : "");
    } catch { console.log(""); }
  ' 2>/dev/null | tr -d '[:space:]' || true
}

SCHEMA_BEFORE="$(schema_version)"
[ -n "${SCHEMA_BEFORE}" ] && dim "  schema version before: ${SCHEMA_BEFORE}"

# ── 3. get the new image ───────────────────────────────────────────────────────

if [ "${BUILD_FROM_SOURCE}" = "1" ]; then
  info "building ${TARGET_IMAGE} from ${REPO_ROOT}"
  ( cd "${REPO_ROOT}" && docker build -f deploy/docker/Dockerfile -t "${TARGET_IMAGE}" . ) \
    || die "the build failed; nothing was changed"
  ok "image built"
else
  info "pulling ${TARGET_IMAGE}"
  if ! ( cd "${COMPOSE_DIR}" && docker pull "${TARGET_IMAGE}" ); then
    die "could not pull ${TARGET_IMAGE}; nothing was changed"
  fi
  ok "image pulled"
fi

# ── 4. point the deployment at it and restart ──────────────────────────────────

info "switching to ${TARGET_IMAGE}"

# `.env` is the source of truth for the next start. It is edited with a temp file so a
# failure part-way cannot leave it truncated — losing `.env` would lose the bot token.
if [ -f "${ENV_FILE}" ]; then
  cp "${ENV_FILE}" "${ENV_FILE}.upgrade-backup"
  TMP_ENV="${ENV_FILE}.tmp"
  if grep -qE '^[[:space:]]*ARGUS_AGENT_IMAGE=' "${ENV_FILE}"; then
    sed "s|^[[:space:]]*ARGUS_AGENT_IMAGE=.*|ARGUS_AGENT_IMAGE=${TARGET_IMAGE}|" "${ENV_FILE}" > "${TMP_ENV}"
  else
    { cat "${ENV_FILE}"; printf 'ARGUS_AGENT_IMAGE=%s\n' "${TARGET_IMAGE}"; } > "${TMP_ENV}"
  fi
  mv "${TMP_ENV}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}" 2>/dev/null || true
  ok ".env now points at the new image"
else
  warn "${ENV_FILE} does not exist; compose will use its own default"
fi

info "restarting"
if using_ollama; then
  compose_with_overlay up -d --remove-orphans || {
    err "docker compose failed to start the new version"
    ROLLBACK_REASON="compose failed to start the new image"
  }
else
  compose up -d --remove-orphans || {
    err "docker compose failed to start the new version"
    ROLLBACK_REASON="compose failed to start the new image"
  }
fi

# ── 5. verify ──────────────────────────────────────────────────────────────────

ROLLBACK_REASON="${ROLLBACK_REASON:-}"
UPGRADE_OK=1

if [ -n "${ROLLBACK_REASON}" ]; then
  UPGRADE_OK=0
else
  if ! wait_for_health 180; then
    ROLLBACK_REASON="the new version never became healthy"
    UPGRADE_OK=0
  fi
fi

if [ "${UPGRADE_OK}" = "1" ]; then
  info "running the smoke test"
  if ! bash "${LIB_DIR}/smoke.sh" --quiet; then
    ROLLBACK_REASON="the smoke test failed on the new version"
    UPGRADE_OK=0
  fi
fi

# The forced-failure hook: fail AFTER the upgrade succeeded, so the rollback path runs
# against a working system — which is the only way to test it honestly.
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
  log "  from    ${CURRENT_IMAGE}${CURRENT_VERSION:+  (version ${CURRENT_VERSION})}"
  log "  to      ${TARGET_IMAGE}"
  [ -n "${NEW_SCHEMA}" ] && log "  schema  ${SCHEMA_BEFORE:-?} → ${NEW_SCHEMA}"
  [ -n "${BACKUP_DB}" ] && log "  backup  ${BACKUP_DB}"
  log ""
  log "The previous image is still on disk. To go back without a re-pull:"
  dim "  ${LIB_DIR}/upgrade.sh --to ${CURRENT_IMAGE}"
  log ""
  if [ -f "${ENV_FILE}.upgrade-backup" ]; then
    dim "  The previous .env is at ${ENV_FILE}.upgrade-backup"
  fi
  exit 0
fi

log ""
err "UPGRADE FAILED: ${ROLLBACK_REASON}"
log ""
info "rolling back to ${CURRENT_IMAGE}"

# Point `.env` back.
if [ -f "${ENV_FILE}.upgrade-backup" ]; then
  mv "${ENV_FILE}.upgrade-backup" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}" 2>/dev/null || true
else
  TMP_ENV="${ENV_FILE}.tmp"
  sed "s|^[[:space:]]*ARGUS_AGENT_IMAGE=.*|ARGUS_AGENT_IMAGE=${CURRENT_IMAGE}|" "${ENV_FILE}" > "${TMP_ENV}" && mv "${TMP_ENV}" "${ENV_FILE}"
fi
ok "the image tag was restored"

# Did migrations run? If the schema moved, an older image against the newer database
# fails again — so the backup must go back too. If it did not move, the new data is
# kept, because discarding a day of runs to undo an image change is the worse outcome.
SCHEMA_AFTER="$(schema_version)"
MIGRATED=0
if [ -n "${SCHEMA_BEFORE}" ] && [ -n "${SCHEMA_AFTER}" ] && [ "${SCHEMA_BEFORE}" != "${SCHEMA_AFTER}" ]; then
  MIGRATED=1
fi

if [ "${MIGRATED}" = "1" ]; then
  warn "the schema changed: ${SCHEMA_BEFORE} → ${SCHEMA_AFTER}"
  if [ -n "${BACKUP_DB}" ] && [ -f "${BACKUP_DB}" ]; then
    info "restoring the pre-upgrade database (the older image cannot read the newer schema)"
    # Stop first: restoring under a running SQLite is the corruption this avoids.
    compose stop >/dev/null 2>&1 || true
    sleep 3
    cp -p "${BACKUP_DB}" "${DATA_PATH}/ops.sqlite"
    rm -f "${DATA_PATH}/ops.sqlite-wal" "${DATA_PATH}/ops.sqlite-shm"
    ok "database restored from $(basename "${BACKUP_DB}")"
  else
    err "the schema changed but there is no database backup to restore"
    err "The deployment may not start. Restore manually — see docs/user/backup-and-upgrade.md#backup-and-restore"
  fi
else
  dim "  the schema did not change, so the database is kept as it is"
fi

info "starting the previous version"
if using_ollama; then
  compose_with_overlay up -d --remove-orphans || compose start >/dev/null 2>&1 || true
else
  compose up -d --remove-orphans || compose start >/dev/null 2>&1 || true
fi

log ""
if wait_for_health 120; then
  ok "rolled back to ${CURRENT_IMAGE}; the deployment is healthy again"
else
  err "the rollback did not restore health"
  err "Manual recovery:"
  [ -n "${BACKUP_DB}" ] && err "  the pre-upgrade database: ${BACKUP_DB}"
  [ -n "${BACKUP_DATA}" ] && err "  the pre-upgrade archive:  ${BACKUP_DATA}"
  err "  restore.sh --db ${BACKUP_DB} --data ${BACKUP_DATA}"
  err "See docs/user/troubleshooting.md"
  exit 1
fi

log ""
log "What happened:"
log "  the upgrade to ${TARGET_IMAGE} FAILED (${ROLLBACK_REASON})"
log "  the image tag was restored to ${CURRENT_IMAGE}"
if [ "${MIGRATED}" = "1" ]; then
  log "  the schema had changed, so the database was restored from the backup"
  log "  work done by the new version was DISCARDED"
else
  log "  the schema had not changed, so the database was left alone"
fi
log "  the deployment is running and healthy on the previous version"
log ""
if [ -n "${BACKUP_DB}" ]; then
  log "The backup taken before this attempt is still there:"
  dim "  ${BACKUP_DB}"
fi
log ""
log "Before retrying: read the failure above and docs/user/backup-and-upgrade.md#upgrading."

exit 1
