#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# End-to-end test of the NATIVE install on a fresh "VPS": an Ubuntu container with systemd
# as PID 1, where install-native.sh runs exactly as an operator would run it as root.
#
#   pnpm test:native-vps
#
# It needs Docker and runs the container --privileged, because systemd and the unit's own
# hardening (namespaces, syscall filters) need it. It is NOT part of `pnpm test`.
# Everything it creates is removed at the end, pass or fail.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="argus-vps-test"
NAME="argus-vps-test-$$"
TOKEN="123456789:FAKE-TOKEN-FOR-TESTING"
FAILED=0

pass() { printf '  ok %s\n' "$*"; }
fail() { printf ' err %s\n' "$*"; FAILED=1; }
vps()  { docker exec "${NAME}" "$@"; }
# check "what" command...: pass when the command succeeds.
check() { local what="$1"; shift; if "$@"; then pass "${what}"; else fail "${what}"; fi; }

cleanup() { docker rm -f "${NAME}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> building the VPS image"
docker build -q -t "${IMAGE}" "${REPO}/test/deploy/vps" >/dev/null

echo "==> booting it"
docker run -d --name "${NAME}" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  -v "${REPO}:${REPO}:ro" "${IMAGE}" >/dev/null
for _ in $(seq 1 30); do
  state="$(vps systemctl is-system-running 2>/dev/null || true)"
  case "${state}" in running|degraded) break ;; esac
  sleep 1
done

echo "==> install-native.sh (this builds the workspace; a few minutes)"
if docker exec -e TELEGRAM_BOT_TOKEN="${TOKEN}" -e ARGUS_AGENT_ADMIN_ID=123456789 "${NAME}" \
     bash "${REPO}/deploy/native/install-native.sh" --non-interactive --yes >/tmp/argus-vps-install.log 2>&1; then
  pass "installed"
else
  fail "the install failed — see /tmp/argus-vps-install.log"
  tail -30 /tmp/argus-vps-install.log
  exit 1
fi

check "the unit is active" vps systemctl is-active --quiet argus-agent

health="$(vps curl -s http://127.0.0.1:3090/health || true)"
for service in opsStore opsProjects opsMeter opsGovernor opsChannel opsScheduler opsMemory opsApprovals opsOrchestrator; do
  printf '%s' "${health}" | grep -q "\"${service}\"" || fail "health does not report ${service}"
done
check "health names the rejected bot token" grep -q 'failed to start: .*401' <<<"${health}"

check "smoke-native.sh passes" vps bash -c 'bash /opt/argus-agent/deploy/native/smoke-native.sh --quiet >/dev/null 2>&1'

check "backup-native.sh works without sqlite3" vps bash -c '! command -v sqlite3 >/dev/null && bash /opt/argus-agent/deploy/native/backup-native.sh >/dev/null 2>&1'

old="$(vps systemctl show -p MainPID --value argus-agent)"
vps kill -9 "${old}"
recovered=0
for _ in $(seq 1 40); do
  new="$(vps systemctl show -p MainPID --value argus-agent)"
  if [ "${new}" != "0" ] && [ "${new}" != "${old}" ] && vps curl -sf http://127.0.0.1:3090/health >/dev/null 2>&1; then
    recovered=1; break
  fi
  sleep 1
done
check "restarted and healthy after kill -9" test "${recovered}" = "1"

docker exec -e ASSUME_YES=1 "${NAME}" bash /opt/argus-agent/deploy/native/uninstall-native.sh >/dev/null 2>&1 || true
check "uninstall removes the unit and keeps the data" \
  vps bash -c 'test -f /srv/argus-agent/data/ops.sqlite && ! test -f /etc/systemd/system/argus-agent.service'

echo
if [ "${FAILED}" = "0" ]; then echo "native VPS test: PASSED"; else echo "native VPS test: FAILED"; exit 1; fi
