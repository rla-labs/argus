#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# Smoke test for a NATIVE Argus Agent deployment: is it actually WORKING?
#
# The same checks as the Docker version, minus the container: the process is running,
# the endpoint answers, the status is not `down`, every required service mounted, the
# database is readable, and the data directory is writable.
#
# It exists separately from `../scripts/smoke.sh` because almost every step differs:
# there is no `docker exec`, health is read from the host, and "is it running" is
# `systemctl` rather than `docker inspect`.
#
# Usage:
#   smoke-native.sh [--json] [--quiet]
#
# Exit: 0 when the deployment works, 1 otherwise. The report is printed either way.

# shellcheck source=lib-native.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-native.sh"

JSON_OUT=0
QUIET=0
CHECKS_PASSED=0
CHECKS_FAILED=0
FAILURES=()

while [ $# -gt 0 ]; do
  case "$1" in
    --json)  JSON_OUT=1; shift ;;
    --quiet) QUIET=1; shift ;;
    --help|-h) printf 'Usage: smoke-native.sh [--json] [--quiet]\n'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

check_pass() {
  CHECKS_PASSED=$((CHECKS_PASSED + 1))
  [ "${QUIET}" = "1" ] || ok "$1"
}

check_fail() {
  CHECKS_FAILED=$((CHECKS_FAILED + 1))
  FAILURES+=("$1")
  err "$1"
  [ -n "${2:-}" ] && dim "     $2"
  return 0
}

# The summary and exit, defined before anything can call it.
finish() {
  log ""
  if [ "${CHECKS_FAILED}" -eq 0 ]; then
    ok "smoke test passed (${CHECKS_PASSED} check(s))"
    [ "${JSON_OUT}" = "1" ] && printf '{"ok":true,"passed":%d,"failed":0,"failures":[]}\n' "${CHECKS_PASSED}"
    exit 0
  fi
  err "smoke test FAILED (${CHECKS_FAILED} of $((CHECKS_PASSED + CHECKS_FAILED)) check(s))"
  log ""
  log "Failures:"
  for f in "${FAILURES[@]}"; do log "  - ${f}"; done
  log ""
  log "  journalctl -u ${SERVICE_NAME} -n 80 --no-pager"
  log "  docs/user-docs.md#troubleshooting"
  if [ "${JSON_OUT}" = "1" ]; then
    printf '{"ok":false,"passed":%d,"failed":%d,"failures":[' "${CHECKS_PASSED}" "${CHECKS_FAILED}"
    first=1
    for f in "${FAILURES[@]}"; do
      [ "${first}" = "1" ] || printf ','
      first=0
      printf '"%s"' "$(printf '%s' "${f}" | sed 's/"/\\"/g')"
    done
    printf ']}\n'
  fi
  exit 1
}

# ── 1. is the service running ──────────────────────────────────────────────────

if ! systemd_available; then
  check_fail "systemd is not available" "this deployment is managed by a systemd unit"
  finish
fi

if service_running; then
  check_pass "the service is running"
else
  check_fail "the service is not running" "start it with: systemctl start ${SERVICE_NAME}"
  finish
fi

# ── 2. does health answer ──────────────────────────────────────────────────────

HEALTH_BODY="$(native_health || true)"
if [ -z "${HEALTH_BODY}" ]; then
  check_fail "the health endpoint did not answer on 127.0.0.1:${HEALTH_PORT:-3090}" \
    "journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
  finish
fi
check_pass "the health endpoint answers"

# ── 3. the status ──────────────────────────────────────────────────────────────

STATUS="$(printf '%s' "${HEALTH_BODY}" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -n 1)"
case "${STATUS}" in
  ok)       check_pass "health status: ok" ;;
  degraded) check_pass "health status: degraded (running; something wants attention)" ;;
  down)
    check_fail "health status: down" "the report names the problem"
    finish
    ;;
  *) check_fail "health status is unreadable: '${STATUS}'" "the endpoint answered with something unexpected" ;;
esac

# ── 4. every required service mounted ──────────────────────────────────────────
#
# A `degraded` system is usable; one MISSING a service is not. This is what catches a
# partially-mounted tree, which a profile or bundle change can introduce.

MISSING=()
for service in opsStore opsProjects opsMeter opsGovernor opsChannel; do
  if ! printf '%s' "${HEALTH_BODY}" | grep -q "\"${service}\""; then
    MISSING+=("${service}")
  fi
done

if [ "${#MISSING[@]}" -eq 0 ]; then
  check_pass "all required services are present"
else
  check_fail "services missing from the health report: ${MISSING[*]}" \
    "a partially-mounted tree — check the journal for 'did not activate'"
fi

# ── 5. the database is readable and complete ───────────────────────────────────
#
# A real read of the file the service has open. This proves the schema migrated, which a
# health endpoint can report as fine while being wrong.

if [ -f "${DATA_DIR}/ops.sqlite" ]; then
  TABLES=""
  if command -v sqlite3 >/dev/null 2>&1; then
    TABLES="$(sqlite3 "${DATA_DIR}/ops.sqlite" \
      "SELECT name FROM sqlite_master WHERE type='table'" 2>/dev/null || true)"
  elif app_sqlite_available; then
    # No sqlite3 binary: the application's own better-sqlite3 reads it just as well.
    TABLES="$(app_sqlite 'for (const r of new Database(process.argv[1], { readonly: true }).prepare("SELECT name FROM sqlite_master WHERE type = ?").all("table")) console.log(r.name)' "${DATA_DIR}/ops.sqlite" 2>/dev/null || true)"
  fi
  if [ -n "${TABLES}" ]; then
    MISSING_TABLES=()
    for table in inbound runs usage_events audit_log projects; do
      printf '%s' "${TABLES}" | grep -qx "${table}" || MISSING_TABLES+=("${table}")
    done
    if [ "${#MISSING_TABLES[@]}" -eq 0 ]; then
      check_pass "the database is open and its schema is complete"
    else
      check_fail "the database is missing tables: ${MISSING_TABLES[*]}" "a migration did not run"
    fi
  else
    # No sqlite3 on the host. The header is a weak check, and it is labelled as one.
    if [ "$(head -c 15 "${DATA_DIR}/ops.sqlite" 2>/dev/null)" = "SQLite format 3" ]; then
      check_pass "the database file is a SQLite database (header check only; install sqlite3 for more)"
    else
      check_fail "the database file is not readable as SQLite" "${DATA_DIR}/ops.sqlite"
    fi
  fi
else
  check_fail "no database at ${DATA_DIR}/ops.sqlite" "the service may not have started yet"
fi

# ── 6. the data directory is writable by the service account ───────────────────

if su -s /bin/bash "${SERVICE_USER}" -c "touch '${DATA_DIR}/.smoke-write' && rm -f '${DATA_DIR}/.smoke-write'" 2>/dev/null; then
  check_pass "the data directory is writable by ${SERVICE_USER}"
else
  check_fail "the data directory is not writable by ${SERVICE_USER}" \
    "chown -R ${SERVICE_USER}:${SERVICE_USER} ${DATA_DIR}"
fi

# ── 7. the profile is composed ─────────────────────────────────────────────────

# Counted from the COMPOSED tree, as dsh resolves it — the bundle's rows plus the user's
# patch. A profile can name its bundles and still mount nothing if the bundle does not
# resolve, which is what a packed bundle without its plugins looked like.
if [ -f "${PROFILE_DIR}/package.json" ]; then
  ROWS="$(profile_ops_rows | tr -dc '0-9')"
  if [ "${ROWS:-0}" -ge 12 ]; then
    check_pass "the profile composes (${ROWS} Argus Agent rows)"
  else
    check_fail "the profile composes only ${ROWS:-0} Argus Agent rows" "re-run install-native.sh, or check the journal"
  fi
else
  check_fail "no profile at ${PROFILE_DIR}" "re-run install-native.sh, or check the journal"
fi

finish
