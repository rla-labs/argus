#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# End-to-end test of the NATIVE install on a fresh "VPS": an Ubuntu container with systemd
# as PID 1, where install-native.sh runs exactly as an operator would run it as root.
#
#   pnpm test:native-vps               a Telegram install: health, smoke, backup, the
#                                      first-party extensions next to this repository
#                                      (installed and run confined), kill -9
#   pnpm test:native-vps --web-only    no Telegram: the setup link creates the admin, the
#                                      web chat answers, `argus setup-link --admin` works
#   pnpm test:native-vps --upgrade [v] install v (default v0.4.0), then upgrade to
#                                      origin/main: the users are kept (from 0.3, the admin
#                                      and the allowed user become users), a project file
#                                      is left as it was, git is there for /undo
#
# It needs Docker and runs the container --privileged, because systemd and the unit's own
# hardening (namespaces, syscall filters) need it. It is NOT part of `pnpm test`.
# Everything it creates is removed at the end, pass or fail.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="argus-vps-test"
NAME="argus-vps-test-$$"
TOKEN="123456789:FAKE-TOKEN-FOR-TESTING"
MODE="${1:-}"
FROM="${2:-v0.4.0}"
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

# run_install <env...>: run install-native.sh non-interactively with those variables.
run_install() {
  local script="${REPO}/deploy/native/install-native.sh"
  [ "${MODE}" = "--upgrade" ] && script="/opt/argus-agent/deploy/native/install-native.sh"
  if docker exec "$@" "${NAME}" bash "${script}" --non-interactive --yes >/tmp/argus-vps-install.log 2>&1; then
    pass "installed"
  else
    fail "the install failed — see /tmp/argus-vps-install.log"
    tail -30 /tmp/argus-vps-install.log
    exit 1
  fi
}

# The web API inside the VPS: api METHOD PATH [JSON]; the cookie jar is /tmp/jar.
api() {
  vps curl -s -b /tmp/jar -c /tmp/jar -o /dev/stdout -w '\n%{http_code}' -X "$1" \
    -H 'content-type: application/json' -H 'x-argus: 1' ${3:+--data "$3"} "http://127.0.0.1:3091$2"
}

if [ "${MODE}" = "--web-only" ]; then
  echo "==> install-native.sh with no Telegram (this builds the workspace; a few minutes)"
  run_install
  check "the unit is active" vps systemctl is-active --quiet argus-agent
  link="$(vps argus setup-link 2>/dev/null | head -n 1 || true)"
  check "argus setup-link shows the one-time link" grep -q '/setup?token=' <<<"${link}"
  check "health is ok while it waits for the admin" bash -c "docker exec ${NAME} curl -s http://127.0.0.1:3090/health | grep -q 'waiting for the admin'"
  check "smoke-native.sh passes" vps bash -c 'bash /opt/argus-agent/deploy/native/smoke-native.sh --quiet >/dev/null 2>&1'
  token="${link##*token=}"
  check "the link creates the admin" grep -q '^204$' <<<"$(api POST /api/setup "{\"token\":\"${token}\",\"name\":\"Ana\",\"login\":\"ana\",\"password\":\"a long password\"}" | tail -n 1)"
  check "the admin is signed in" grep -q '"role":"admin"' <<<"$(api GET /api/me)"
  check "the link works once" grep -q '^401$' <<<"$(api POST /api/setup "{\"token\":\"${token}\",\"login\":\"eve\",\"password\":\"a long password\"}" | tail -n 1)"
  api POST /api/chat '{"text":"/status"}' >/dev/null
  answered=0
  for _ in $(seq 1 20); do
    api GET /api/chat | grep -q '"from":"argus"' && { answered=1; break; }
    sleep 1
  done
  check "the web chat answers a command" test "${answered}" = "1"
  health="$(vps curl -s http://127.0.0.1:3090/health || true)"
  # With no provider key yet it may be degraded, but not for want of a user.
  if grep -q 'waiting for the admin\|no enabled user' <<<"${health}"; then fail "health still waits for a user"; else pass "health no longer waits for a user"; fi
  grep -o '"status": *"[a-z]*"\|"reason": *"[^"]*"' <<<"${health}" | sort -u | sed 's/^/     /' || true
  recovery="$(vps argus setup-link --admin 2>/dev/null | head -n 1 || true)"
  check "argus setup-link --admin gives a sign-in link" grep -q '/login?token=' <<<"${recovery}"
  check "the admin's link signs in" grep -q '^303$' <<<"$(vps curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3091/login?token=${recovery##*token=}")"
  echo
  if [ "${FAILED}" = "0" ]; then echo "native VPS test (web only): PASSED"; else echo "native VPS test (web only): FAILED"; exit 1; fi
  exit 0
fi

if [ "${MODE}" = "--upgrade" ]; then
  echo "==> ${FROM} with install-native.sh (a few minutes)"
  vps git config --global --add safe.directory '*'
  # Through a bare copy the service account can read: the upgrade fetches as that account.
  vps git clone -q --bare "${REPO}" /srv/argus-src.git
  vps chmod -R a+rX /srv/argus-src.git
  vps git clone -q /srv/argus-src.git /opt/argus-agent
  vps git -C /opt/argus-agent checkout -q "${FROM}"
  run_install -e TELEGRAM_BOT_TOKEN="${TOKEN}" -e ARGUS_AGENT_ADMIN_ID=123456789
  # One more Telegram user, as 0.3 had them: allowed in ops.yaml.
  vps sed -i "s|^  admin: '123456789'|  admin: '123456789'\n  allowed_users:\n    - { channel: telegram, userId: '555' }|" /srv/argus-agent/data/config/ops.yaml
  # A project as the old version wrote them: every setting in its file, no template.
  vps bash -c 'mkdir -p /srv/argus-agent/data/projects/oldsite && printf "id: oldsite\ncwd: /srv/argus-agent/data/projects/oldsite\nprovider: openrouter\nmodel: deepseek/deepseek-v4-flash\ntools:\n  read: allow\n  write: allow\n  shell: ask\n  web: ask\napprovals:\n  auto_allow: [git status, git diff]\n" > /srv/argus-agent/data/config/projects/oldsite.yaml && chown -R ops:ops /srv/argus-agent/data/projects/oldsite /srv/argus-agent/data/config/projects/oldsite.yaml'
  before="$(vps sha256sum /srv/argus-agent/data/config/projects/oldsite.yaml)"
  vps chown -R ops:ops /srv/argus-src.git
  vps systemctl restart argus-agent
  echo "==> upgrade-native.sh to origin/main (a few minutes)"
  if docker exec "${NAME}" bash /opt/argus-agent/deploy/native/upgrade-native.sh --revision origin/main --yes >/tmp/argus-vps-upgrade.log 2>&1; then
    pass "upgraded"
  else
    fail "the upgrade failed — see /tmp/argus-vps-upgrade.log"
    tail -30 /tmp/argus-vps-upgrade.log
  fi
  check "the unit is active" vps systemctl is-active --quiet argus-agent
  users="$(vps su -s /bin/bash ops -c "cd /opt/argus-agent/packages/ops-store && node -e \"const D=require('better-sqlite3');const d=new D('/srv/argus-agent/data/ops.sqlite',{readonly:true});console.log(JSON.stringify(d.prepare('SELECT u.role, i.channel, i.external_id FROM users u JOIN identities i ON i.user_id=u.id ORDER BY i.external_id').all()))\"" 2>&1 || true)"
  check "the admin is a user with the Telegram identity" grep -q '"role":"admin","channel":"telegram","external_id":"123456789"' <<<"${users}"
  check "the allowed user is an operator" grep -q '"role":"operator","channel":"telegram","external_id":"555"' <<<"${users}"
  check "there is no setup link: the admin exists" vps bash -c '! test -f /srv/argus-agent/data/state/setup-link'
  check "smoke-native.sh passes" vps bash -c 'bash /opt/argus-agent/deploy/native/smoke-native.sh --quiet >/dev/null 2>&1'
  check "the old project's file is untouched" test "${before}" = "$(vps sha256sum /srv/argus-agent/data/config/projects/oldsite.yaml)"
  check "git is there, for the /undo snapshots" vps bash -c 'git --version >/dev/null'
  check "the upgrade brought 0.5 (extensions)" vps test -f /opt/argus-agent/packages/ops-projects/lib/extensions.js
  echo
  if [ "${FAILED}" = "0" ]; then echo "native VPS test (upgrade): PASSED"; else echo "native VPS test (upgrade): FAILED"; exit 1; fi
  exit 0
fi

echo "==> install-native.sh (this builds the workspace; a few minutes)"
run_install -e TELEGRAM_BOT_TOKEN="${TOKEN}" -e ARGUS_AGENT_ADMIN_ID=123456789

check "the unit is active" vps systemctl is-active --quiet argus-agent

health="$(vps curl -s http://127.0.0.1:3090/health || true)"
for service in opsStore opsProjects opsMeter opsGovernor opsChannel opsScheduler opsMemory opsApprovals opsOrchestrator; do
  printf '%s' "${health}" | grep -q "\"${service}\"" || fail "health does not report ${service}"
done
check "health names the rejected bot token" grep -q 'failed to start: .*401' <<<"${health}"

check "smoke-native.sh passes" vps bash -c 'bash /opt/argus-agent/deploy/native/smoke-native.sh --quiet >/dev/null 2>&1'

check "backup-native.sh works without sqlite3" vps bash -c '! command -v sqlite3 >/dev/null && bash /opt/argus-agent/deploy/native/backup-native.sh >/dev/null 2>&1'

# The first-party extensions next to this repository, as the service's user installs
# and runs them: confined, under the native install's Landlock.
if [ -d "${REPO}/../argus-extensions/.git" ]; then
  # What the images extension's README asks of a native install: ImageMagick's system libraries.
  vps bash -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends libx11-6 libfontconfig1 libfreetype6 libharfbuzz0b libfribidi0 fonts-dejavu-core libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 fonts-liberation' >/dev/null 2>&1
  docker cp "${REPO}/../argus-extensions" "${NAME}:/srv/argus-extensions"
  vps chown -R ops:ops /srv/argus-extensions
  docker cp "${REPO}/scripts/extension-check.mjs" "${NAME}:/tmp/extension-check.mjs"
  extensions="$(vps su -s /bin/bash ops -c 'node /tmp/extension-check.mjs /opt/argus-agent /srv/argus-agent/data /srv/argus-extensions' 2>&1 || true)"
  printf '%s\n' "${extensions}" | grep -E '^ +(ok|err) ' || true
  check "the first-party extensions install and run" grep -q 'extension check: PASSED' <<<"${extensions}"
fi

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
