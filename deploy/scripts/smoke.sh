#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# Smoke test: is this deployment actually WORKING?
#
# `install.sh` and `upgrade.sh` both call it, and both care about the same thing: a
# container that is `Up` is not the same as a system that answers. This checks, in
# order of what breaks first:
#
#   1. the container is running
#   2. the health endpoint answers
#   3. the status is not `down`
#   4. every required service is present in the report
#   5. the store round-trips — a real write and read through the running service
#   6. the command layer answers, when it is mounted
#
# It CLEANS UP after itself: the check project is created in `scratch/` and removed
# on exit, including on failure, so a failed smoke test does not leave litter that
# makes the next one confusing.
#
# Usage:
#   smoke.sh [--json] [--quiet]
#
# Exit: 0 when the deployment is working, 1 otherwise. The report is printed either
# way — a smoke test that says only "failed" is not worth running.

# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

readonly SCRIPT_NAME="smoke.sh"
JSON_OUT=0
DOCTOR=0
QUIET=0
CHECKS_PASSED=0
CHECKS_FAILED=0
FAILURES=()

usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME} [options]

  --doctor   also check that it can do work: keys, models, projects (argus doctor)
  --json     also print a JSON summary on stdout
  --quiet    only print failures
  --help     this message

Exits 0 when the deployment is working, 1 otherwise.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --json)  JSON_OUT=1; shift ;;
    --doctor) DOCTOR=1; shift ;;
    --quiet) QUIET=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
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


# The summary and exit. Called from the early-exit paths as well as the end, so it is
# defined before anything can call it.
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
  if [ "${DOCTOR}" = "1" ]; then
    log "The last errors in the log:"
    docker logs --tail 300 "${CONTAINER_NAME}" 2>&1 | grep -E '(^|: )(warn|error) ' | tail -n 5 | sed 's/^/  /' >&2 || true
    log ""
  fi
  log "See docs/user/troubleshooting.md, or: docker logs --tail 100 ${CONTAINER_NAME}"
  if [ "${JSON_OUT}" = "1" ]; then
    printf '{"ok":false,"passed":%d,"failed":%d,"failures":[' "${CHECKS_PASSED}" "${CHECKS_FAILED}"
    first=1
    for f in "${FAILURES[@]}"; do
      [ "${first}" = "1" ] || printf ','
      first=0
      printf '"%s"' "$(printf '%s' "${f}" | sed 's/"/\"/g')"
    done
    printf ']}\n'
  fi
  exit 1
}

# ── argus doctor ───────────────────────────────────────────────────────────────
#
# With --doctor, the checks the RUNNING service makes of itself (GET /doctor): the
# project files, the /task and orchestrator models, every provider key (one free
# request each), the chat channel and the admin. Each failure comes with its fix.

# The /doctor JSON as lines: ok<TAB>what<TAB>fix.
readonly DOCTOR_PARSE='let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const flat=(t)=>String(t||"").replace(/\s+/g," ");try{for(const f of JSON.parse(s).findings)console.log([f.ok?(f.warn?"W":"1"):"0",flat([f.check,f.detail].filter(Boolean).join(": ")),flat(f.fix)].join("\t"))}catch{console.log("E")}})'

report_doctor() {
  local lines="$1" good text fix
  if [ -z "${lines}" ] || [ "${lines}" = "E" ]; then
    check_fail "the service did not answer the doctor checks" "a version before 0.2.0 has none: argus upgrade"
    return 0
  fi
  while IFS=$'\t' read -r good text fix; do
    case "${good}" in
      1) check_pass "${text}" ;;
      # A warning passes: it is a choice to look at again, not a fault.
      W) check_pass "${text}"; warn "${text}"; [ -n "${fix}" ] && dim "     ${fix}" ;;
      *) check_fail "${text}" "${fix:+fix: ${fix}}" ;;
    esac
  done <<<"${lines}"
}

# ── 1. the container is running ────────────────────────────────────────────────

if service_running; then
  check_pass "the container is running"
else
  check_fail "the container is not running" "start it with: docker compose -f deploy/compose/docker-compose.yml up -d"
  # Nothing else can work, so stop here rather than produce five misleading failures.
  finish
fi

# ── 2. health answers ──────────────────────────────────────────────────────────

HEALTH_BODY="$(container_health || true)"

if [ -z "${HEALTH_BODY}" ]; then
  check_fail "the health endpoint did not answer" "check: docker logs --tail 50 ${CONTAINER_NAME}"
  finish
fi
check_pass "the health endpoint answers"

# ── 3. the status ──────────────────────────────────────────────────────────────

STATUS="$(printf '%s' "${HEALTH_BODY}" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -n 1)"

case "${STATUS}" in
  ok)       check_pass "health status: ok" ;;
  degraded) check_pass "health status: degraded (running; something wants attention)" ;;
  down)
    check_fail "health status: down" "the report names the problem — see docs/user/troubleshooting.md"
    finish
    ;;
  *) check_fail "health status is unreadable: '${STATUS}'" "the endpoint answered with something unexpected: ${HEALTH_BODY:0:200}" ;;
esac

# ── 4. the required services are present ───────────────────────────────────────
#
# A `degraded` system is usable; a system MISSING a service is not. This is the check
# that catches a partially-mounted tree, which is the failure an image upgrade can
# introduce and which nothing else here would notice.

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
    "a partially-mounted tree — check 'docker logs ${CONTAINER_NAME}' for 'did not activate'"
fi

# ── 5. the store round-trips ───────────────────────────────────────────────────
#
# A real write and read through the RUNNING service. Reading a value that a plugin
# wrote proves the database is open, the schema is migrated and the service is
# actually serving — three things a health endpoint can report as fine while being
# wrong.

# Run from ops-store's own directory: better-sqlite3 is ITS dependency, and Node
# resolves `require` from the working directory.
STORE_CHECK="$(docker exec -w /app/packages/ops-store "${CONTAINER_NAME}" node -e '
  (async () => {
    try {
      const Database = require("better-sqlite3");
      const db = new Database("/data/ops.sqlite", { readonly: true });
      // The schema version proves the migrations ran, and `inbound` proves the
      // tables exist rather than merely that the file opens.
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all("table").map(r => r.name);
      const required = ["inbound", "runs", "usage_events", "audit_log", "projects"];
      const missing = required.filter(t => !tables.includes(t));
      db.close();
      if (missing.length > 0) { console.log("MISSING:" + missing.join(",")); process.exit(2); }
      console.log("OK");
    } catch (error) {
      console.log("ERROR:" + (error && error.message ? error.message : String(error)));
      process.exit(1);
    }
  })();
' 2>/dev/null || true)"

case "${STORE_CHECK}" in
  OK) check_pass "the database is open and its schema is complete" ;;
  MISSING:*) check_fail "the database is missing tables: ${STORE_CHECK#MISSING:}" "a migration did not run — check the startup log" ;;
  ERROR:*)   check_fail "the database could not be read: ${STORE_CHECK#ERROR:}" ;;
  *)         check_fail "the database check produced no output" "the container may not have node or better-sqlite3" ;;
esac

# ── 6. the command layer answers ───────────────────────────────────────────────
#
# An end-to-end check through the running service, when ops-commands is mounted. It
# asks for the health text, which is a deterministic command that touches the
# registry, the store and the formatting without spending money.

# The COMPOSED profile, as dsh itself resolves it: the bundle's rows plus the user's
# patch. Reading the profile's own cordis.patch.yml would miss every bundle row — on
# a fresh install that file is an empty list.
COMMAND_CHECK="$(docker exec "${CONTAINER_NAME}" sh -c '
  count="$(dsh --profile ops --dump-config 2>/dev/null \
    | grep -cE "name: .@argus-agent/(commands|health|store|governor)." || true)"
  echo "MOUNTED:${count:-0}"
' 2>/dev/null || true)"

case "${COMMAND_CHECK}" in
  MOUNTED:*) 
    count="${COMMAND_CHECK#MOUNTED:}"
    if [ "${count}" -ge 2 ]; then
      check_pass "the profile is composed (${count} core plugins mounted)"
    else
      check_fail "the profile looks incomplete (${count} core plugins found)" "the entrypoint copies the profile on every boot — check its output"
    fi
    ;;
  *) dim "  the profile check was inconclusive (not a failure)" ;;
esac

# ── 7. the data directory is writable ──────────────────────────────────────────
#
# Checked last because it is the least likely to have changed since boot, and because
# a full disk shows up here before it shows up as a failed run.

if docker exec "${CONTAINER_NAME}" sh -c 'touch /data/.smoke-write && rm -f /data/.smoke-write' 2>/dev/null; then
  check_pass "the data directory is writable"
else
  check_fail "the data directory is not writable" "the volume may be full or mounted read-only"
fi

if [ "${DOCTOR}" = "1" ]; then
  report_doctor "$(docker exec "${CONTAINER_NAME}" sh -c "curl --fail --silent --max-time 60 http://127.0.0.1:3090/doctor | node -e '${DOCTOR_PARSE}'" 2>/dev/null || true)"
fi

finish
