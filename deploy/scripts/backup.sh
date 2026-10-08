#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# Back up an Argus Agent deployment.
#
# Two artifacts, because the deployment has two kinds of state and they need
# different treatment:
#
#   1. `ops-<stamp>.sqlite` — the database, via SQLite's ONLINE backup API. Copying
#      the file with `cp` while the service runs risks a torn read; `.backup` takes a
#      consistent snapshot of a live database.
#   2. `data-<stamp>.tar.gz` — everything else under the data directory: the session
#      transcripts, the project workspaces, the memory state tree and the
#      configuration.
#
# The archive EXCLUDES `scratch/`, which holds ad-hoc task folders and attachments
# that nothing depends on, and any `*.sqlite-wal`/`*.sqlite-shm` sidecars, which are
# meaningless without the process that wrote them.
#
# Usage:
#   backup.sh [--output DIR] [--keep N] [--dry-run]
#
# Environment:
#   ARGUS_AGENT_DATA_PATH   the data directory (default /srv/argus-agent/data)
#   BACKUP_OUTPUT_DIR   where the artifacts go (default <data>/backups)
#   BACKUP_KEEP         how many to keep (default 7)
#   ASSUME_YES=1        do not prompt
#
# Prints the artifact paths on stdout, one per line, so a caller can capture them.

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

readonly SCRIPT_NAME="backup.sh"
reexec_as_root "$@"
OUTPUT_DIR="${BACKUP_OUTPUT_DIR:-${DATA_PATH}/backups}"
KEEP="${BACKUP_KEEP:-7}"
DRY_RUN=0

usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME} [options]

  --output DIR   where to write the artifacts (default: ${OUTPUT_DIR})
  --keep N       how many backup SETS to keep (default: ${KEEP})
  --dry-run      show what would happen, write nothing
  --help         this message

Backs up the database with SQLite's online backup API and archives the rest of the
data directory, excluding scratch/ and any WAL sidecars.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --output)  OUTPUT_DIR="${2:?--output needs a directory}"; shift 2 ;;
    --keep)    KEEP="${2:?--keep needs a number}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

case "${KEEP}" in
  ''|*[!0-9]*) die "--keep must be a positive integer, got '${KEEP}'" ;;
esac
[ "${KEEP}" -ge 1 ] || die "--keep must be at least 1: keeping zero backups is not a backup policy"

# ── what are we backing up ─────────────────────────────────────────────────────

[ -d "${DATA_PATH}" ] || die "the data directory ${DATA_PATH} does not exist. Set ARGUS_AGENT_DATA_PATH."
require_matching_container

if ! data_is_initialized; then
  warn "${DATA_PATH}/config/ops.yaml is missing — this does not look like an initialized deployment."
  confirm "Back it up anyway?" || die "aborted"
fi

STAMP="$(timestamp)"
DB_ARTIFACT="${OUTPUT_DIR}/ops-${STAMP}.sqlite"
DATA_ARTIFACT="${OUTPUT_DIR}/data-${STAMP}.tar.gz"

info "backing up ${DATA_PATH} → ${OUTPUT_DIR}"

if [ "${DRY_RUN}" = "1" ]; then
  log "  would write ${DB_ARTIFACT}"
  log "  would write ${DATA_ARTIFACT}"
  log "  would keep the newest ${KEEP} backup sets of each kind"
  exit 0
fi

mkdir -p "${OUTPUT_DIR}"

# ── 1. the database, online ────────────────────────────────────────────────────
#
# SQLite's `.backup` is used from INSIDE the container when the service is running,
# because that is the only process with the file open and the right client. When the
# service is stopped the file can be copied directly — but the online path is used
# whenever it is available, since "the service happened to be stopped" is not
# something a backup script should depend on.

DB_PATH="${DATA_PATH}/ops.sqlite"
DB_BACKED_UP=0

if service_running; then
  dim "  the service is running: using SQLite's online backup"
  # A temporary file left by an interrupted backup would make VACUUM INTO refuse.
  docker exec "${CONTAINER_NAME}" rm -f /data/backups/.tmp-backup.sqlite 2>/dev/null || true
  if docker exec "${CONTAINER_NAME}" sh -c \
       "command -v sqlite3 >/dev/null 2>&1 && sqlite3 /data/ops.sqlite '.backup /data/backups/.tmp-backup.sqlite'" 2>/dev/null; then
    # Move it out of the volume into the output directory, with the right name.
    if docker cp "${CONTAINER_NAME}:/data/backups/.tmp-backup.sqlite" "${DB_ARTIFACT}" 2>/dev/null; then
      docker exec "${CONTAINER_NAME}" rm -f /data/backups/.tmp-backup.sqlite 2>/dev/null || true
      DB_BACKED_UP=1
    fi
  fi
  if [ "${DB_BACKED_UP}" = "0" ]; then
    # No `sqlite3` in the image: VACUUM INTO through node, which is always present.
    dim "  sqlite3 is unavailable in the image: using VACUUM INTO through node"
    if docker exec -w /app/packages/ops-store "${CONTAINER_NAME}" node -e '
      const Database = require("better-sqlite3");
      const db = new Database("/data/ops.sqlite", { readonly: true });
      db.exec("VACUUM INTO \x27/data/backups/.tmp-backup.sqlite\x27");
      db.close();
    ' 2>/dev/null && docker cp "${CONTAINER_NAME}:/data/backups/.tmp-backup.sqlite" "${DB_ARTIFACT}" 2>/dev/null; then
      docker exec "${CONTAINER_NAME}" rm -f /data/backups/.tmp-backup.sqlite 2>/dev/null || true
      DB_BACKED_UP=1
    fi
  fi
fi

if [ "${DB_BACKED_UP}" = "0" ]; then
  if [ -f "${DB_PATH}" ]; then
    if service_running; then
      # Running but neither method worked. A copy of the live file is NOT a backup:
      # recent writes live in the WAL beside it, and a copy without them is a valid,
      # silently older database (seen on a fresh install: an empty one).
      die "could not take an online backup of the running database. Stop the service and run the backup again."
    fi
    cp -p "${DB_PATH}" "${DB_ARTIFACT}"
    DB_BACKED_UP=1
  else
    warn "no database at ${DB_PATH} — nothing to back up yet"
  fi
fi

if [ "${DB_BACKED_UP}" = "1" ]; then
  # An integrity check on the artifact, because a backup nobody verified is a hope.
  if command -v sqlite3 >/dev/null 2>&1; then
    CHECK="$(sqlite3 "${DB_ARTIFACT}" 'PRAGMA integrity_check' 2>/dev/null | head -n 1 || true)"
    if [ "${CHECK}" = "ok" ]; then
      ok "database: $(basename "${DB_ARTIFACT}") ($(human_size "$(stat -c%s "${DB_ARTIFACT}" 2>/dev/null || echo 0)")) — integrity ok"
    else
      err "database: integrity check FAILED (${CHECK:-no output})"
      err "This backup is not usable. Do not delete an older one until this is resolved."
      exit 1
    fi
  else
    ok "database: $(basename "${DB_ARTIFACT}")"
    dim "  install sqlite3 on the host to have backups verified automatically"
  fi
fi

# ── 2. everything else ─────────────────────────────────────────────────────────
#
# The database is copied separately, so it is EXCLUDED here rather than duplicated —
# a tar of a live SQLite file has exactly the torn-read problem the online backup
# exists to avoid.

dim "  archiving the data directory (excluding scratch/ and the database)"

TAR_EXCLUDES=(
  --exclude='./scratch'
  --exclude='./ops.sqlite'
  --exclude='./ops.sqlite-wal'
  --exclude='./ops.sqlite-shm'
  --exclude='./backups'
  --exclude='./.tmp-backup.sqlite'
  --exclude='*.tmp'
)

# `--warning=no-file-changed` because the service writes while this runs, and a file
# that changed mid-read is expected rather than a failure. The alternative — stopping
# the service — would make a nightly backup an outage.
if tar czf "${DATA_ARTIFACT}" \
     "${TAR_EXCLUDES[@]}" \
     --warning=no-file-changed \
     -C "${DATA_PATH}" . 2>/dev/null; then
  ok "data: $(basename "${DATA_ARTIFACT}") ($(human_size "$(stat -c%s "${DATA_ARTIFACT}" 2>/dev/null || echo 0)"))"
else
  rc=$?
  # tar exits 1 for "some files changed while reading", which is not an error here.
  if [ "${rc}" = "1" ] && [ -s "${DATA_ARTIFACT}" ]; then
    ok "data: $(basename "${DATA_ARTIFACT}") (with expected warnings: the service was writing)"
  else
    die "failed to archive the data directory (tar exited ${rc})"
  fi
fi

# ── 3. retention ───────────────────────────────────────────────────────────────
#
# Retention counts SETS, and a set is one database plus one archive. Counting each
# kind independently would eventually leave a database with no matching archive.

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
  # Newest first. The filenames carry a UTC timestamp, so a lexical sort is a
  # chronological one.
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

prune_kind 'ops-[0-9]{8}-[0-9]{6}\.sqlite'   "${KEEP}"
prune_kind 'data-[0-9]{8}-[0-9]{6}\.tar\.gz' "${KEEP}"

# A stray temp file from an interrupted run.
rm -f "${OUTPUT_DIR}/.tmp-backup.sqlite" 2>/dev/null || true

# ── 4. report ──────────────────────────────────────────────────────────────────

TOTAL_SIZE=0
while IFS= read -r f; do
  TOTAL_SIZE=$((TOTAL_SIZE + $(stat -c%s "${f}" 2>/dev/null || echo 0)))
done < <(find "${OUTPUT_DIR}" -maxdepth 1 \( -name 'ops-*.sqlite' -o -name 'data-*.tar.gz' \) -type f)

log ""
ok "backup complete — $(find "${OUTPUT_DIR}" -maxdepth 1 -name 'ops-*.sqlite' | wc -l) database(s), $(find "${OUTPUT_DIR}" -maxdepth 1 -name 'data-*.tar.gz' | wc -l) archive(s), $(human_size "${TOTAL_SIZE}") total"
dim "  in ${OUTPUT_DIR}"

# The caller may capture these. On stdout, so the progress above does not interfere.
[ "${DB_BACKED_UP}" = "1" ] && printf '%s\n' "${DB_ARTIFACT}"
printf '%s\n' "${DATA_ARTIFACT}"

# A backup that is never copied off the machine is not a backup: the disk that fails
# takes the backup with it.
log ""
dim "Copy these somewhere else — a backup on the same disk is not a backup:"
dim "  rsync -av ${OUTPUT_DIR}/ you@elsewhere:/backups/argus-agent/"
