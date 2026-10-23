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
  setup-link the one-time link that creates the admin on the web; with
             --admin, a sign-in link for the admin who lost the password
             (restarts the service)
  tailscale  put the web interface on your Tailscale network: installs Tailscale
             (asks first), signs the server in, runs tailscale serve
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

# As root, through sudo when not root already.
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

# The link the service wrote to state/setup-link. With --admin, ask for the admin's
# sign-in link first: a request file, read by the service when it starts.
setup_link() {
  local admin=0 waited=0
  [ "${1:-}" = "--admin" ] && admin=1
  if [ "${MODE}" = native ]; then
    local state
    state="$(sed -n 's/^Environment=ARGUS_AGENT_DATA_DIR=//p' "${UNIT_FILE}" | head -n 1)/state"
    read_link() { as_root cat "${state}/setup-link" 2>/dev/null; }
    ask() { as_root rm -f "${state}/setup-link" && as_root touch "${state}/admin-link.request"; }
    restart() { as_root systemctl restart argus-agent; }
  else
    read_link() { docker exec "${CONTAINER}" cat /data/state/setup-link 2>/dev/null; }
    ask() { docker exec "${CONTAINER}" sh -c 'rm -f /data/state/setup-link && touch /data/state/admin-link.request'; }
    restart() { docker restart "${CONTAINER}" >/dev/null; }
  fi
  if [ "${admin}" = 1 ]; then
    ask || { echo "argus: could not reach the service's data directory" >&2; exit 1; }
    restart
    until read_link; do
      waited=$((waited + 2))
      [ "${waited}" -le 120 ] || { echo "argus: the service did not write the link; see 'argus logs'" >&2; exit 1; }
      sleep 2
    done
    echo "One use, valid an hour. Then set a new password in Settings."
    return 0
  fi
  if read_link; then
    echo "One use, valid an hour. Open it through your tunnel (see docs/user/web.md)."
    return 0
  fi
  echo "There is no setup link: the admin exists already (or the service is not running)." >&2
  echo "Lost the admin's password? 'argus setup-link --admin' makes a sign-in link (restarts the service)." >&2
  exit 1
}

# Tailscale: install it (its official script, after asking), sign this server in to the
# tailnet, and publish the web interface on it with HTTPS. Nothing is opened to the
# internet. --yes installs without asking.
tailscale_setup() {
  local port="${ARGUS_AGENT_WEB_PORT:-3091}" answer="" name=""
  if ! command -v tailscale >/dev/null 2>&1; then
    if [ "${1:-}" != "--yes" ]; then
      printf 'Tailscale is not installed. Install it with its official script (https://tailscale.com/install.sh)? [y/N] ' >&2
      read -r answer || true
      case "${answer}" in y|Y|yes) ;; *) echo "Not installed. Install it yourself, then run 'argus tailscale' again." >&2; exit 1 ;; esac
    fi
    curl -fsSL https://tailscale.com/install.sh | as_root sh
  fi
  if ! as_root tailscale status >/dev/null 2>&1; then
    echo "Sign this server in to your Tailscale account: open the link below." >&2
    as_root tailscale up
  fi
  as_root tailscale serve --bg "${port}"
  name="$(as_root tailscale status --json | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -n 1)"
  cat >&2 <<EOF

Argus is on your tailnet: https://${name}
  1. Open it from a device signed in to the same Tailscale account (the Tailscale app
     on a phone or laptop).
  2. In Argus, Settings > Web access: set the public address to https://${name}
     and turn on sign-in with Tailscale.
  3. Settings > Users: link each person's Tailscale login, then they need no password.
EOF
}

case "${COMMAND}" in
  setup-link) setup_link "$@" ;;
  tailscale) tailscale_setup "$@" ;;
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
