#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# `argus`: one entry point for running a deployment, Docker or native.
#
# The work is done by the scripts next to this one; this only picks the right one. The
# installers link it as /usr/local/bin/argus, so it runs from anywhere.
#
# Which install this is: a systemd unit at /etc/systemd/system/argus-agent.service means
# native, anything else means Docker. `--docker` or `--native` overrides it, and is how
# `argus init --native` chooses the native install on a fresh host.
#
# Usage:
#   argus [--docker|--native] <command> [options passed to the script]

set -euo pipefail

ARGUS_DEPLOY="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
UNIT_FILE="${ARGUS_AGENT_UNIT_PATH:-/etc/systemd/system/argus-agent.service}"
CONTAINER="argus-agent"

usage() {
  cat <<'EOF'
Usage: argus [--docker|--native] <command> [options]

  init       install, or reinstall over an existing deployment
  status     is it running, and is it healthy
  doctor     the smoke test, plus: keys, models and projects, each with its fix
  logs       the service log (add -f to follow)
  backup     back up the database and the data
  restore    restore from a backup
  upgrade    upgrade, rolling back if the new version does not start

Options after the command go to the script that does the work, e.g.
`argus init --build` or `argus backup --keep 30`. `argus <command> --help`
shows them.

Install type: native when argus-agent.service is installed, Docker otherwise.
Docs: docs/user/README.md
EOF
}

MODE=""
case "${1:-}" in
  --docker) MODE=docker; shift ;;
  --native) MODE=native; shift ;;
esac
if [ -z "${MODE}" ]; then
  if [ -f "${UNIT_FILE}" ]; then MODE=native; else MODE=docker; fi
fi

COMMAND="${1:-}"
[ $# -gt 0 ] && shift

# Run one of the deploy scripts, for this install type.
script() {
  local docker="$1" native="$2"
  shift 2
  if [ "${MODE}" = native ]; then
    exec bash "${ARGUS_DEPLOY}/native/${native}" "$@"
  fi
  exec bash "${ARGUS_DEPLOY}/scripts/${docker}" "$@"
}

# The status word in a health report: ok, degraded or down.
health_word() {
  sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -n 1
}

status() {
  local state health
  if [ "${MODE}" = native ]; then
    state="$(systemctl is-active argus-agent 2>/dev/null || true)"
    health="$(curl --fail --silent --max-time 8 "http://127.0.0.1:${HEALTH_PORT:-3090}/health" 2>/dev/null || true)"
    printf 'install   native (systemd)\nservice   %s\n' "${state:-unknown}"
  else
    state="$(docker inspect --format '{{.State.Status}}' "${CONTAINER}" 2>/dev/null || true)"
    health=""
    [ "${state}" = running ] && health="$(docker exec "${CONTAINER}" curl --fail --silent --max-time 8 http://127.0.0.1:3090/health 2>/dev/null || true)"
    printf 'install   docker\ncontainer %s\n' "${state:-not found}"
    [ -n "${state}" ] && printf 'image     %s\n' "$(docker inspect --format '{{.Config.Image}}' "${CONTAINER}" 2>/dev/null || true)"
  fi
  local word
  word="$(printf '%s' "${health}" | health_word)"
  printf 'health    %s\n' "${word:-no answer}"
  case "${word}" in
    ok) return 0 ;;
    degraded) echo "Something wants attention: run 'argus doctor'."; return 0 ;;
    *) echo "Not healthy: run 'argus doctor', then 'argus logs'."; return 1 ;;
  esac
}

case "${COMMAND}" in
  init)    script install.sh install-native.sh "$@" ;;
  doctor)  script smoke.sh smoke-native.sh --doctor "$@" ;;
  backup)  script backup.sh backup-native.sh "$@" ;;
  upgrade) script upgrade.sh upgrade-native.sh "$@" ;;
  restore)
    if [ "${MODE}" = native ]; then
      echo "argus restore is not automated for the native install yet. The steps are in" >&2
      echo "docs/user/install-native.md#restoring (stop, move the data aside, restore, start)." >&2
      exit 1
    fi
    script restore.sh - "$@" ;;
  status)  status ;;
  logs)
    if [ "${MODE}" = native ]; then
      exec journalctl -u argus-agent -n 100 "$@"
    fi
    exec docker logs --tail 100 "$@" "${CONTAINER}" ;;
  help|-h|--help) usage ;;
  "") usage; exit 1 ;;
  *) echo "argus: unknown command '${COMMAND}'" >&2; usage >&2; exit 1 ;;
esac
