#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# Back up a NATIVE Argus Agent deployment.
#
# Simpler than the Docker version in one way and stricter in another:
#
#   * Simpler: there is no container, so the database file and the rest of the data
#     directory are both reachable directly. No `docker exec`, no `docker cp`.
#   * Stricter: the database is backed up with SQLite's ONLINE backup, which requires a
#     `sqlite3` binary. The Docker image always has one; a minimal host may not — and
#     copying a live SQLite file with `cp` can capture a torn page. When `sqlite3` is
#     absent the script says so and refuses to pretend the copy is consistent, unless
#     you insist.
#
# Two artifacts, as in the Docker install:
#
#   ops-<stamp>.sqlite     the database, taken ONLINE
#   data-<stamp>.tar.gz    everything else, excluding scratch/ and the database
#
# Usage:
#   backup-native.sh [--output DIR] [--keep N] [--dry-run] [--yes] [--force-copy]

# shellcheck source=lib-native.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-native.sh"

OUTPUT_DIR="${BACKUP_OUTPUT_DIR:-${DATA_DIR}/backups}"
KEEP="${BACKUP_KEEP:-7}"
DRY_RUN=0
FORCE_COPY=0

usage() {
  cat <<EOF
Usage: backup-native.sh [options]

  --output DIR   where to write the artifacts (default: ${OUTPUT_DIR})
  --keep N       how many backup SETS to keep (default: ${KEEP})
  --force-copy   copy the database even without sqlite3 (NOT consistent — see below)
  --dry-run      show what would happen, write nothing
  --yes          answer yes to every confirmation
  --help         this message

The database is backed up with SQLite's online backup API — through sqlite3 when it
is installed, otherwise through the application's own better-sqlite3. If neither is
available, the script STOPS rather than copying a live database: a plain file copy of
a database being written can capture a torn page, and a backup that is silently
inconsistent is worse than no backup. Pass --force-copy only if you accept that risk.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --output)     OUTPUT_DIR="${2:?--output needs a directory}"; shift 2 ;;
    --keep)       KEEP="${2:?--keep needs a number}"; shift 2 ;;
    --force-copy) FORCE_COPY=1; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --yes|-y)     ASSUME_YES=1; export ASSUME_YES; shift ;;
    --help|-h)    usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

case "${KEEP}" in
  ''|*[!0-9]*) die "--keep must be a positive integer, got '${KEEP}'" ;;
esac
[ "${KEEP}" -ge 1 ] || die "--keep must be at least 1: keeping zero backups is not a backup policy"

[ -d "${DATA_DIR}" ] || die "the data directory ${DATA_DIR} does not exist. Set ARGUS_AGENT_DATA_DIR."

if ! data_is_initialized; then
  warn "${CONFIG_FILE} is missing — this does not look like an initialized deployment."
  confirm "Back it up anyway?" || die "aborted"
fi

STAMP="$(timestamp)"
DB_ARTIFACT="${OUTPUT_DIR}/ops-${STAMP}.sqlite"
DATA_ARTIFACT="${OUTPUT_DIR}/data-${STAMP}.tar.gz"

info "backing up ${DATA_DIR} → ${OUTPUT_DIR}"

if [ "${DRY_RUN}" = "1" ]; then
  log "  would write ${DB_ARTIFACT}"
  log "  would write ${DATA_ARTIFACT}"
  log "  would keep the newest ${KEEP} backup sets of each kind"
  exit 0
fi

mkdir -p "${OUTPUT_DIR}"

# ── 1. the database, online ────────────────────────────────────────────────────
#
# `.backup` takes a consistent snapshot of a database that is being written, which is
# what makes this safe to run against a live service.

DB_PATH="${DATA_DIR}/ops.sqlite"
DB_BACKED_UP=0

if [ -f "${DB_PATH}" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    dim "  using sqlite3's online backup"
    # A temporary name, then a rename: a backup interrupted half-written must never sit
    # under the real name, where it would look valid to a later restore.
    if sqlite3 "${DB_PATH}" ".backup '${DB_ARTIFACT}.partial'" 2>/dev/null; then
      mv "${DB_ARTIFACT}.partial" "${DB_ARTIFACT}"
      DB_BACKED_UP=1
    else
      rm -f "${DB_ARTIFACT}.partial"
      warn "sqlite3's .backup failed"
    fi
  fi

  # No sqlite3 binary: the application's better-sqlite3 has the same online backup API,
  # so a minimal VPS still gets a consistent snapshot.
  if [ "${DB_BACKED_UP}" = "0" ] && app_sqlite_available; then
    dim "  using SQLite's online backup through the application's better-sqlite3"
    # The copy keeps the live database's WAL mode; switching it to DELETE makes the
    # artifact one self-contained file, with no -wal/-shm left beside it by a later read.
    if app_sqlite 'new Database(process.argv[1], { readonly: true }).backup(process.argv[2]).then(() => { const c = new Database(process.argv[2]); c.pragma("journal_mode = DELETE"); c.close() }).catch((e) => { console.error(e.message); process.exit(1) })' \
        "${DB_PATH}" "${DB_ARTIFACT}.partial" 2>/dev/null; then
      mv "${DB_ARTIFACT}.partial" "${DB_ARTIFACT}"
      DB_BACKED_UP=1
    else
      rm -f "${DB_ARTIFACT}.partial"
      warn "the online backup through better-sqlite3 failed"
    fi
  fi

  if [ "${DB_BACKED_UP}" = "0" ]; then
    if [ "${FORCE_COPY}" != "1" ]; then
      err "neither sqlite3 nor the application's better-sqlite3 could back up the database,"
      err "so it cannot be backed up CONSISTENTLY while the service runs."
      err ""
      err "  Install sqlite3:  apt-get install sqlite3    (or your distribution's)"
      err "  Or stop the service first:  systemctl stop ${SERVICE_NAME}"
      err "  Or accept an inconsistent copy:  $0 --force-copy"
      err ""
      err "A copy of a live SQLite file can contain a torn page. A backup believed to be"
      err "good and is not is worse than no backup at all."
      exit 1
    fi
    warn "copying the database WITHOUT sqlite3 (--force-copy): the copy may be inconsistent"
    warn "verify it before relying on it:  sqlite3 ${DB_ARTIFACT} 'PRAGMA integrity_check'"
    cp -p "${DB_PATH}" "${DB_ARTIFACT}"
    DB_BACKED_UP=1
  fi
else
  warn "no database at ${DB_PATH} — nothing to back up yet"
fi

if [ "${DB_BACKED_UP}" = "1" ]; then
  CHECK=""
  if command -v sqlite3 >/dev/null 2>&1; then
    CHECK="$(sqlite3 "${DB_ARTIFACT}" 'PRAGMA integrity_check' 2>/dev/null | head -n 1 || true)"
  elif app_sqlite_available; then
    CHECK="$(app_sqlite 'console.log(new Database(process.argv[1], { readonly: true }).pragma("integrity_check", { simple: true }))' "${DB_ARTIFACT}" 2>/dev/null | head -n 1 || true)"
  fi
  if [ -n "${CHECK}" ]; then
    if [ "${CHECK}" = "ok" ]; then
      ok "database: $(basename "${DB_ARTIFACT}") ($(human_size "$(stat -c%s "${DB_ARTIFACT}" 2>/dev/null || echo 0)")) — integrity ok"
    else
      err "database: integrity check FAILED (${CHECK:-no output})"
      err "This backup is not usable. Do not delete an older one until this is resolved."
      exit 1
    fi
  else
    ok "database: $(basename "${DB_ARTIFACT}")"
  fi
fi

# ── 2. everything else ─────────────────────────────────────────────────────────
#
# The database is copied separately, so it is EXCLUDED here rather than duplicated.

dim "  archiving the data directory (excluding scratch/ and the database)"

TAR_EXCLUDES=(
  --exclude='./scratch'
  --exclude='./ops.sqlite'
  --exclude='./ops.sqlite-wal'
  --exclude='./ops.sqlite-shm'
  --exclude='./backups'
  --exclude='*.tmp'
  --exclude='*.partial'
)

# `--warning=no-file-changed` because the service writes while this runs, and a file that
# changed mid-read is expected rather than a failure.
if tar czf "${DATA_ARTIFACT}" \
     "${TAR_EXCLUDES[@]}" \
     --warning=no-file-changed \
     -C "${DATA_DIR}" . 2>/dev/null; then
  ok "data: $(basename "${DATA_ARTIFACT}") ($(human_size "$(stat -c%s "${DATA_ARTIFACT}" 2>/dev/null || echo 0)"))"
else
  rc=$?
  if [ "${rc}" = "1" ] && [ -s "${DATA_ARTIFACT}" ]; then
    ok "data: $(basename "${DATA_ARTIFACT}") (with expected warnings: the service was writing)"
  else
    die "failed to archive the data directory (tar exited ${rc})"
  fi
fi

chown "${SERVICE_USER}:${SERVICE_USER}" "${DB_ARTIFACT}" "${DATA_ARTIFACT}" 2>/dev/null || true

# ── 3. retention ───────────────────────────────────────────────────────────────
#
# A set is one database plus one archive; counting each kind independently would
# eventually leave a database with no matching archive. Only names this script creates
# are considered, so a file an operator put here is never deleted.

# Rotation considers ONLY the names this script creates: `ops-<YYYYMMDD>-<HHMMSS>.sqlite`
# and `data-<YYYYMMDD>-<HHMMSS>.tar.gz`.
#
# A GLOB IS NOT ENOUGH, and this was a real bug: `ops-*.sqlite` also matches a hand-made
# `ops-manual.sqlite`, which sorts AFTER every dated name because "m" > "2". Rotation then
# counted that file as the newest backup and pruned every real one — leaving an operator
# with a single backup and a stray file treated as the latest. The pattern is anchored to
# the exact date format instead.
prune_kind() {
  local pattern="$1" keep="$2" count=0 file
  while IFS= read -r file; do
    count=$((count + 1))
    if [ "${count}" -gt "${keep}" ]; then
      dim "  pruning $(basename "${file}")"
      rm -f "${file}"
    fi
  # `-regextype posix-extended` so the date format is expressed exactly rather than as a
  # glob that a differently-named file can satisfy.
  done < <(find "${OUTPUT_DIR}" -maxdepth 1 -type f -regextype posix-extended \
             -regex ".*/${pattern}" | sort -r)
}

prune_kind 'ops-[0-9]{8}-[0-9]{6}\.sqlite'  "${KEEP}"
prune_kind 'data-[0-9]{8}-[0-9]{6}\.tar\.gz' "${KEEP}"

rm -f "${OUTPUT_DIR}"/*.partial 2>/dev/null || true

# ── 4. report ──────────────────────────────────────────────────────────────────

TOTAL_SIZE=0
while IFS= read -r f; do
  TOTAL_SIZE=$((TOTAL_SIZE + $(stat -c%s "${f}" 2>/dev/null || echo 0)))
done < <(find "${OUTPUT_DIR}" -maxdepth 1 \( -name 'ops-*.sqlite' -o -name 'data-*.tar.gz' \) -type f)

log ""
ok "backup complete — $(find "${OUTPUT_DIR}" -maxdepth 1 -name 'ops-*.sqlite' | wc -l) database(s), $(find "${OUTPUT_DIR}" -maxdepth 1 -name 'data-*.tar.gz' | wc -l) archive(s), $(human_size "${TOTAL_SIZE}") total"
dim "  in ${OUTPUT_DIR}"

[ "${DB_BACKED_UP}" = "1" ] && printf '%s\n' "${DB_ARTIFACT}"
printf '%s\n' "${DATA_ARTIFACT}"

log ""
dim "Copy these somewhere else — a backup on the same disk is not a backup:"
dim "  rsync -av ${OUTPUT_DIR}/ you@elsewhere:/backups/argus-agent/"
log ""
dim "The application is NOT backed up: it is a git checkout, rebuildable with"
dim "  ${NATIVE_DIR}/install-native.sh"
dim "The SECRETS are not either: ${SECRETS_FILE} — keep a copy in a password manager."
