#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# Restore an Argus Agent deployment from a backup.
#
# The order matters, and it is the reverse of the backup's:
#
#   1. STOP the service. Restoring under a running process means two writers on the
#      same SQLite file, and the outcome is a corrupt database rather than a
#      restored one.
#   2. Move the CURRENT data aside. A restore that overwrites is a restore that
#      destroys the thing it was meant to protect — and the most common reason to
#      restore is a bad upgrade, where the "bad" data is still worth inspecting.
#   3. Restore the archive, then the database.
#   4. START, and VERIFY. A restore nobody verified is a hope.
#
# Usage:
#   restore.sh [--db FILE] [--data FILE] [--from DIR] [--list] [--dry-run]
#
# Environment:
#   ARGUS_AGENT_DATA_PATH   the data directory (default /srv/argus-agent/data)
#   ASSUME_YES=1        do not prompt

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

readonly SCRIPT_NAME="restore.sh"
reexec_as_root "$@"
DB_FILE=""
DATA_FILE=""
FROM_DIR=""
LIST_ONLY=0
DRY_RUN=0

usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME} [options]

  --from DIR     the directory holding the backups (default: <data>/backups)
  --db FILE      the database artifact to restore
  --data FILE    the archive to restore
  --list         list what is available, restore nothing
  --dry-run      show what would happen, change nothing
  --help         this message

With no --db/--data, the newest pair in the backup directory is used.

WARNING: this replaces the database and the data directory. The current data is
moved to <data>-pre-restore-<stamp>/ rather than deleted, so a mistaken restore is
recoverable.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --from)    FROM_DIR="${2:?--from needs a directory}"; shift 2 ;;
    --db)      DB_FILE="${2:?--db needs a file}"; shift 2 ;;
    --data)    DATA_FILE="${2:?--data needs a file}"; shift 2 ;;
    --list)    LIST_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

FROM_DIR="${FROM_DIR:-${DATA_PATH}/backups}"

[ -d "${FROM_DIR}" ] || die "the backup directory ${FROM_DIR} does not exist"

# ── newest-first listing ───────────────────────────────────────────────────────
#
# The filenames carry a UTC timestamp, so a lexical sort is chronological.

newest_of() {
  find "${FROM_DIR}" -maxdepth 1 -name "$1" -type f 2>/dev/null | sort -r | head -n 1
}

if [ "${LIST_ONLY}" = "1" ]; then
  info "backups in ${FROM_DIR}"
  log ""
  log "Database artifacts:"
  if find "${FROM_DIR}" -maxdepth 1 -name 'ops-*.sqlite' -type f | grep -q .; then
    find "${FROM_DIR}" -maxdepth 1 -name 'ops-*.sqlite' -type f | sort -r | while IFS= read -r f; do
      # `log`, not `printf`: the listing is a REPORT, and its headings are on stderr. A
      # printf here would put the rows on stdout and the titles on stderr, splitting one
      # report across two streams — which is how the rows appeared to be missing.
      log "$(printf '  %-44s %10s  %s' "$(basename "${f}")" \
        "$(human_size "$(stat -c%s "${f}" 2>/dev/null || echo 0)")" \
        "$(date -u -r "${f}" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null || echo '')")"
    done
  else
    log "  (none)"
  fi
  log ""
  log "Data archives:"
  if find "${FROM_DIR}" -maxdepth 1 -name 'data-*.tar.gz' -type f | grep -q .; then
    find "${FROM_DIR}" -maxdepth 1 -name 'data-*.tar.gz' -type f | sort -r | while IFS= read -r f; do
      log "$(printf '  %-44s %10s  %s' "$(basename "${f}")" \
        "$(human_size "$(stat -c%s "${f}" 2>/dev/null || echo 0)")" \
        "$(date -u -r "${f}" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null || echo '')")"
    done
  else
    log "  (none)"
  fi
  exit 0
fi

[ -n "${DB_FILE}" ]   || DB_FILE="$(newest_of 'ops-*.sqlite')"
[ -n "${DATA_FILE}" ] || DATA_FILE="$(newest_of 'data-*.tar.gz')"

[ -n "${DB_FILE}" ]   || die "no database artifact found in ${FROM_DIR}. Run backup.sh first, or pass --db."
[ -n "${DATA_FILE}" ] || die "no data archive found in ${FROM_DIR}. Run backup.sh first, or pass --data."

[ -f "${DB_FILE}" ]   || die "the database artifact ${DB_FILE} does not exist"
[ -f "${DATA_FILE}" ] || die "the archive ${DATA_FILE} does not exist"

# Sets COMPOSE: without it every `compose stop/start` below is a silent no-op, and a
# restore against a running service waits for a stop that never comes.
require_docker
require_matching_container

# ── the plan, stated before anything happens ───────────────────────────────────

info "restore plan"
log "  database   $(basename "${DB_FILE}")  ($(human_size "$(stat -c%s "${DB_FILE}")"))"
log "  data       $(basename "${DATA_FILE}")  ($(human_size "$(stat -c%s "${DATA_FILE}")"))"
log "  into       ${DATA_PATH}"
if service_running; then
  log "  the service will be STOPPED, then started again"
else
  log "  the service is not running"
fi
log ""

# ── verify the database BEFORE destroying anything ─────────────────────────────
#
# Checking the artifact first means a corrupt backup is discovered while the current
# data is still in place. Checking after the restore would be checking a copy of the
# thing that was already broken.

# THREE levels, strongest first. The header check alone is weak: a file corrupted in
# place keeps its header, so only a real integrity check catches it — and a weak check
# that passes is worse than no check, because it is believed.
VERIFIED=0

if command -v sqlite3 >/dev/null 2>&1; then
  check="$(sqlite3 "${DB_FILE}" 'PRAGMA integrity_check' 2>/dev/null | head -n 1 || true)"
  if [ "${check}" != "ok" ]; then
    die "the database artifact fails its integrity check (${check:-no output}). Restoring it would replace working data with a corrupt file."
  fi
  ok "the database artifact passes its integrity check (sqlite3)"
  VERIFIED=1
fi

# No sqlite3 on the HOST — but the container exists and always has better-sqlite3, so
# the artifact is copied in and checked there. This is the path that actually runs on a
# minimal VPS, where sqlite3 is usually absent.
if [ "${VERIFIED}" = "0" ] && service_running; then
  TMP_CHECK="/tmp/.argus-agent-verify-$$.sqlite"
  # Streamed through `docker exec -i`, not `docker cp`: /tmp is a tmpfs in the
  # compose file, and `docker cp` cannot write into a tmpfs mount.
  if docker exec -i "${CONTAINER_NAME}" sh -c "cat > '${TMP_CHECK}'" < "${DB_FILE}" 2>/dev/null; then
    check="$(docker exec -w /app/packages/ops-store "${CONTAINER_NAME}" node -e '
      try {
        const Database = require("better-sqlite3");
        const db = new Database(process.argv[1], { readonly: true });
        const row = db.prepare("PRAGMA integrity_check").get();
        db.close();
        console.log(row ? Object.values(row)[0] : "no output");
      } catch (error) { console.log("ERROR: " + (error && error.message ? error.message : String(error))); }
    ' "${TMP_CHECK}" 2>/dev/null || true)"
    docker exec "${CONTAINER_NAME}" rm -f "${TMP_CHECK}" >/dev/null 2>&1 || true

    if [ "${check}" = "ok" ]; then
      ok "the database artifact passes its integrity check (through the container)"
      VERIFIED=1
    else
      die "the database artifact fails its integrity check (${check:-no output}). Restoring it would replace working data with a corrupt file."
    fi
  fi
fi

if [ "${VERIFIED}" = "0" ]; then
  # Last resort, with no sqlite3 and no running container. A header check catches a
  # truncated or empty file; it does NOT catch corruption in place, and the warning says
  # so rather than letting the check be trusted for more than it does.
  if [ "$(head -c 15 "${DB_FILE}")" != "SQLite format 3" ]; then
    die "the database artifact is not a SQLite database (bad header). Refusing to restore it."
  fi
  warn "the database artifact has a valid SQLite header, but only a HEADER check was possible"
  warn "(no sqlite3 on this host and the service is not running). A file corrupted in"
  warn "place would pass this check. Start the service first, or install sqlite3."
  if ! confirm "Restore with only a header check?"; then
    die "aborted: start the service or install sqlite3 to verify the artifact properly"
  fi
fi

# The archive must at least be readable, or the restore would empty the data
# directory and fail.
if ! tar tzf "${DATA_FILE}" >/dev/null 2>&1; then
  die "the archive ${DATA_FILE} is not readable. Refusing to restore it."
fi
ok "the archive is readable"

log ""
confirm "Replace the data at ${DATA_PATH} with these backups?" || die "aborted"

if [ "${DRY_RUN}" = "1" ]; then
  log "dry run: nothing was changed"
  exit 0
fi

# ── 1. stop ────────────────────────────────────────────────────────────────────

STOPPED=0
if service_running; then
  info "stopping the service"
  compose stop "${COMPOSE_SERVICE}" >/dev/null 2>&1 || compose stop >/dev/null 2>&1 || true
  # Wait for it to actually exit: restoring under a process that is still flushing
  # its WAL is the failure this whole order exists to avoid.
  elapsed=0
  while service_running && [ "${elapsed}" -lt 60 ]; do
    sleep 1
    elapsed=$((elapsed + 1))
  done
  if service_running; then
    die "the service did not stop within 60s. Stop it manually, then re-run."
  fi
  STOPPED=1
  ok "stopped"
fi

# ── 2. move the current data aside ─────────────────────────────────────────────
#
# NOT deleted. The most common reason to restore is a bad migration, and the data
# from that state is exactly what an investigation needs.

SAFETY_DIR="${DATA_PATH}-pre-restore-$(timestamp)"
info "preserving the current data at ${SAFETY_DIR}"
mkdir -p "${SAFETY_DIR}"

# Move the CONTENTS, not the directory: DATA_PATH may be a mount point, and moving
# a mount point either fails or unmounts it.
#
# TWO THINGS ARE LEFT IN PLACE, and both matter:
#
#   backups/  the artifacts being restored FROM — moving them would be moving the
#             source out from under the operation.
#   scratch/  disposable ad-hoc work that the backup deliberately EXCLUDES. Preserving
#             it is not an oversight in the archive: deleting a task's files because
#             someone restored the database would be destroying work the operator
#             never asked to lose.
# A move that fails must stop the restore HERE. Extracting over a half-moved tree
# mixes the old state with the restored one, and the operator would be told it
# was preserved.
NOT_MOVED=()
shopt -s dotglob nullglob
for entry in "${DATA_PATH}"/*; do
  base="$(basename "${entry}")"
  case "${base}" in
    backups|scratch) continue ;;
  esac
  mv "${entry}" "${SAFETY_DIR}/" 2>/dev/null || NOT_MOVED+=("${base}")
done
shopt -u dotglob nullglob
if [ "${#NOT_MOVED[@]}" -gt 0 ]; then
  err "could not move aside: ${NOT_MOVED[*]} — nothing was restored"
  err "What did move is at ${SAFETY_DIR}. Put it back with:"
  err "  mv ${SAFETY_DIR}/* ${DATA_PATH}/"
  err "then re-run as a user that can write ${DATA_PATH} (usually: sudo)."
  [ "${STOPPED}" = "1" ] && err "The service was stopped; start it with: docker compose start"
  exit 1
fi
ok "preserved (backups/ and scratch/ left in place)"

# ── 3. restore ─────────────────────────────────────────────────────────────────

info "restoring the data directory"
ensure_data_layout
# `--overwrite` because the layout directories were just created, and the archive
# legitimately contains empty ones.
tar xzf "${DATA_FILE}" -C "${DATA_PATH}" --overwrite 2>/dev/null || {
  err "failed to extract ${DATA_FILE}"
  err "The previous data is at ${SAFETY_DIR}. Recover it with:"
  err "  rm -rf ${DATA_PATH}/* && mv ${SAFETY_DIR}/* ${DATA_PATH}/"
  exit 1
}
ok "data directory restored"

info "restoring the database"
cp -p "${DB_FILE}" "${DATA_PATH}/ops.sqlite"
# A stale WAL from the pre-restore database would be applied to the restored file and
# corrupt it. The sidecars are from a DIFFERENT database and must not survive.
rm -f "${DATA_PATH}/ops.sqlite-wal" "${DATA_PATH}/ops.sqlite-shm"
chmod 0644 "${DATA_PATH}/ops.sqlite" 2>/dev/null || true
ok "database restored"

# The restored files belong to whoever made the artifacts — root, or the operator —
# and the service runs as the data directory's owner (uid 10001 in the image). A
# database it cannot write fails at boot with "attempt to write a readonly database".
DATA_OWNER="$(stat -c '%u:%g' "${DATA_PATH}")"
if chown -R "${DATA_OWNER}" "${DATA_PATH}" 2>/dev/null; then
  ok "ownership set to ${DATA_OWNER}"
else
  warn "could not chown the restored data to ${DATA_OWNER}; the service may not be able to write it."
  warn "Run: sudo chown -R ${DATA_OWNER} ${DATA_PATH}"
fi

# ── 4. start and verify ────────────────────────────────────────────────────────

if [ "${STOPPED}" = "1" ]; then
  info "starting the service"
  compose start "${COMPOSE_SERVICE}" >/dev/null 2>&1 || compose start >/dev/null 2>&1 || true

  if ! wait_for_health 180; then
    err "the service did not become healthy after the restore"
    err "The data from before the restore is at ${SAFETY_DIR}"
    err "To put it back: stop the service, then"
    err "  rm -rf ${DATA_PATH}/* && mv ${SAFETY_DIR}/* ${DATA_PATH}/ && docker compose start"
    exit 1
  fi

  # A real verification: the restored database must be readable THROUGH the running
  # service, not merely present on disk. A migration failure or a version mismatch
  # shows up here and nowhere earlier.
  body="$(container_health || true)"
  if [ -n "${body}" ]; then
    if printf '%s' "${body}" | grep -q '"opsStore"'; then
      # The report is pretty-printed JSON; sed reads line by line, so the newlines go
      # first or "opsStore" and its "status" are never on the same line.
      store_status="$(printf '%s' "${body}" | tr -d '\n' | sed -n 's/.*"opsStore"[^}]*"status"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -n 1)"
      if [ "${store_status}" = "ok" ] || [ "${store_status}" = "degraded" ]; then
        ok "the restored database is readable through the service (opsStore: ${store_status})"
      else
        err "opsStore reports '${store_status}' after the restore — the database may not be compatible with this build"
        err "The pre-restore data is at ${SAFETY_DIR}"
        exit 1
      fi
    fi
  fi
else
  dim "the service was not running, so it was not started"
  dim "start it with: docker compose -f deploy/compose/docker-compose.yml up -d"
fi

# ── 5. report ──────────────────────────────────────────────────────────────────

log ""
ok "restore complete"
log ""
log "  restored from   $(basename "${DB_FILE}")"
log "                  $(basename "${DATA_FILE}")"
log "  into            ${DATA_PATH}"
log "  previous data   ${SAFETY_DIR}"
log ""
log "Once you have confirmed everything works, remove the preserved copy:"
dim "  sudo rm -rf ${SAFETY_DIR}"
log ""
log "A restore rewinds the system: any message sent, run started or schedule fired"
log "after the backup was taken did NOT happen and will not happen on its own."
