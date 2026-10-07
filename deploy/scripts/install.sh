#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# Install Argus Agent on a fresh Linux host.
#
# The goal is the acceptance criterion: from this script to the first Telegram message
# in under ten minutes. That shapes every choice below — one script, one pass of
# questions, no manual editing.
#
# IDEMPOTENT. Running it again on an existing deployment upgrades it rather than
# destroying it: the data directory is never overwritten once it holds a
# configuration, and the operator is asked before anything is replaced.
#
# Interactive by default. Fully non-interactive when every value is in the
# environment (see --help), which is what CI and a scripted install use.
#
# Usage:
#   install.sh [--non-interactive] [--build] [--data-path DIR] [--yes] [--dry-run]

# --data-path is taken before lib.sh, which resolves DATA_PATH and makes it readonly.
_prev=""
for _arg in "$@"; do
  [ "${_prev}" = "--data-path" ] && export ARGUS_AGENT_DATA_PATH="${_arg}"
  _prev="${_arg}"
done
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

readonly SCRIPT_NAME="install.sh"

NON_INTERACTIVE=0
BUILD_FROM_SOURCE=0
DRY_RUN=0

# Collected values. Empty means "not supplied"; each is prompted for or defaulted.
V_TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
V_ADMIN_ID="${ARGUS_AGENT_ADMIN_ID:-}"
V_TIMEZONE="${ARGUS_AGENT_TIMEZONE:-}"
V_DEEPSEEK_KEY="${DEEPSEEK_API_KEY:-}"
V_OPENROUTER_KEY="${OPENROUTER_API_KEY:-}"
V_DAY_BUDGET="${ARGUS_AGENT_DAY_BUDGET_USD:-3}"
V_MONTH_BUDGET="${ARGUS_AGENT_MONTH_BUDGET_USD:-40}"
V_IMAGE="${ARGUS_AGENT_IMAGE:-ghcr.io/rla-labs/argus:0.1.0}"

usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME} [options]

  --non-interactive   take every value from the environment; never prompt
  --build             build the image from this checkout instead of pulling
  --data-path DIR     the host data directory (default ${DEFAULT_DATA_PATH})
  --image IMAGE       the image to pull (default ${V_IMAGE})
  --yes               assume yes for confirmations
  --dry-run           check prerequisites and print the plan; change nothing
  --help              this message

Environment (all optional; used instead of prompting):
  TELEGRAM_BOT_TOKEN      from @BotFather
  ARGUS_AGENT_ADMIN_ID        your numeric Telegram user id
  ARGUS_AGENT_TIMEZONE        an IANA timezone, e.g. Europe/Bucharest
  DEEPSEEK_API_KEY        the provider key
  OPENROUTER_API_KEY      or/and an OpenRouter key; with only this one, the
                          default models run through OpenRouter
  ARGUS_AGENT_DAY_BUDGET_USD      default 3
  ARGUS_AGENT_MONTH_BUDGET_USD    default 40
  ARGUS_AGENT_IMAGE           the image reference
  ARGUS_AGENT_DATA_PATH       the host data directory
  ASSUME_YES=1            assume yes

With --non-interactive, TELEGRAM_BOT_TOKEN and ARGUS_AGENT_ADMIN_ID are REQUIRED: an
install that cannot send a message has not been verified, and the acceptance
criterion is the first message.

What it does:
  1. checks the OS, Docker and the network (offers to install Docker, with consent)
  2. creates the data directory with the right ownership
  3. writes config/ops.yaml and .env (mode 600) from the templates
  4. pulls or builds the image
  5. starts the service and waits for /health
  6. sends "Argus Agent is online" to Telegram
  7. prints what to do next
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --build)           BUILD_FROM_SOURCE=1; shift ;;
    --data-path)       : "${2:?--data-path needs a directory}"; shift 2 ;;  # read before lib.sh
    --image)           V_IMAGE="${2:?--image needs a reference}"; shift 2 ;;
    --yes|-y)          ASSUME_YES=1; export ASSUME_YES; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --help|-h)         usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# `DATA_PATH` was resolved from the environment in lib.sh; --data-path overrides it.
readonly FINAL_DATA_PATH="${DATA_PATH}"

# ── 1. prerequisites ───────────────────────────────────────────────────────────

info "checking prerequisites"

# The OS. Docker runs on anything modern; the check exists to catch a host where the
# install path is genuinely different, not to be restrictive.
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  OS_ID="$(. /etc/os-release && printf '%s' "${ID:-unknown}")"
  OS_NAME="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-unknown}")"
  case "${OS_ID}" in
    ubuntu|debian|raspbian|linuxmint|pop)
      ok "${OS_NAME}" ;;
    fedora|rhel|centos|rocky|almalinux|amzn)
      ok "${OS_NAME}" ;;
    alpine)
      warn "${OS_NAME} — the official Docker install path differs; this script assumes systemd"
      ;;
    *)
      warn "${OS_NAME} is untested. Continuing, but see docs/user-docs.md#install-with-docker for the manual steps."
      ;;
  esac
else
  warn "cannot identify the OS (/etc/os-release is missing)"
fi

# Architecture, because an arm64 host cannot run an amd64 image.
ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|aarch64|arm64) ok "architecture ${ARCH}" ;;
  *) warn "architecture ${ARCH} is untested" ;;
esac

# Disk. The image plus a first database needs a few GB; the check is a warning rather
# than a failure because only the operator knows what else the host does.
AVAIL_KB="$(df -Pk "$(dirname "${FINAL_DATA_PATH}")" 2>/dev/null | awk 'NR==2 {print $4}' || echo 0)"
if [ -n "${AVAIL_KB}" ] && [ "${AVAIL_KB}" -lt 5242880 ] 2>/dev/null; then
  warn "less than 5 GB free at $(dirname "${FINAL_DATA_PATH}") — the image and the database need room"
fi

# The network, for the image pull and the Telegram API. A one-second probe, because a
# blocked egress port is a much more common cause of a failed install than anything
# else here.
if command -v curl >/dev/null 2>&1; then
  if curl --max-time 5 --silent --output /dev/null https://registry-1.docker.io/v2/ 2>/dev/null \
     || curl --max-time 5 --silent --output /dev/null https://api.telegram.org 2>/dev/null; then
    ok "network reachable"
  else
    warn "could not reach Docker Hub or api.telegram.org — check the firewall and the proxy"
  fi
fi

# Docker, offering to install it. The official convenience script is used with
# consent, and the manual path is described when consent is not given.
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok "docker $(docker --version | sed 's/Docker version //;s/,.*//')"
  else
    warn "docker is installed but the daemon is not reachable"
    if confirm "Try to start the Docker daemon?"; then
      sudo systemctl start docker 2>/dev/null || sudo service docker start 2>/dev/null || true
      sleep 2
      if docker info >/dev/null 2>&1; then
        ok "the daemon is up"
      else
        die "could not start Docker. Start it manually, then re-run."
      fi
    else
      die "Docker must be running. Start it, then re-run."
    fi
  fi
else
  warn "docker is not installed"
  if [ "${NON_INTERACTIVE}" = "1" ]; then
    die "docker is required. Install it first: https://docs.docker.com/engine/install/ (or run without --non-interactive to be offered the install)"
  fi
  log ""
  log "Docker can be installed with the official convenience script:"
  log "  curl -fsSL https://get.docker.com | sh"
  log ""
  log "It is a download-and-run script from the internet. The cautious alternative,"
  log "and what Docker actually recommends, is the per-distribution repository:"
  log "  https://docs.docker.com/engine/install/${OS_ID:-ubuntu}/"
  log ""
  if confirm "Run the official convenience script now?"; then
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh || die "could not download the installer"
    sudo sh /tmp/get-docker.sh || die "the Docker install failed. See docs/user-docs.md#install-with-docker."
    rm -f /tmp/get-docker.sh
    sudo systemctl enable --now docker 2>/dev/null || true
    ok "docker $(docker --version | sed 's/Docker version //;s/,.*//')"
  else
    die "Docker is required. Install it with the method above, then re-run this script."
  fi
fi

require_docker

# Compose, checked here rather than at first use so a missing plugin fails before the
# operator has answered six questions.
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing: https://docs.docker.com/compose/install/"

# ── 2. the values ──────────────────────────────────────────────────────────────

info "collecting configuration"

if [ "${NON_INTERACTIVE}" = "1" ]; then
  [ -n "${V_TELEGRAM_TOKEN}" ] || die "TELEGRAM_BOT_TOKEN is required with --non-interactive"
  [ -n "${V_ADMIN_ID}" ]      || die "ARGUS_AGENT_ADMIN_ID is required with --non-interactive"
  [ -n "${V_TIMEZONE}" ]      || V_TIMEZONE="UTC"
  ok "non-interactive: values taken from the environment"
else
  # The timezone: guessed from the host, which is right often enough to be the default.
  if [ -z "${V_TIMEZONE}" ]; then
    if [ -r /etc/timezone ]; then
      V_TIMEZONE="$(cat /etc/timezone)"
    elif command -v timedatectl >/dev/null 2>&1; then
      V_TIMEZONE="$(timedatectl show --property=Timezone --value 2>/dev/null || echo UTC)"
    fi
    V_TIMEZONE="${V_TIMEZONE:-UTC}"
  fi

  log ""
  log "Four values are needed. Press Enter to accept a default."
  log ""

  # The Telegram token. The single most important value: without it nothing arrives.
  if [ -z "${V_TELEGRAM_TOKEN}" ]; then
    log "The bot token comes from @BotFather on Telegram: send /newbot and follow it."
    while [ -z "${V_TELEGRAM_TOKEN}" ]; do
      printf 'Telegram bot token: ' >&2
      read -r V_TELEGRAM_TOKEN
      [ -n "${V_TELEGRAM_TOKEN}" ] || warn "the token is required — without it nothing can be delivered"
    done
  fi

  # The admin user id. Validated as digits because a @username will NOT work: usernames
  # are mutable and therefore not identities.
  if [ -z "${V_ADMIN_ID}" ]; then
    log ""
    log "Your numeric Telegram user id. Message @userinfobot to get it."
    log "A @username will NOT work: usernames can be changed or released, so they are"
    log "not identities, and the allowlist compares identities."
    while :; do
      printf 'Your Telegram numeric user id: ' >&2
      read -r V_ADMIN_ID
      case "${V_ADMIN_ID}" in
        ''|*[!0-9]*) warn "digits only, please (for example 99887766)" ;;
        *) break ;;
      esac
    done
  fi

  if [ -z "${V_DEEPSEEK_KEY}" ]; then
    log ""
    log "The provider API key. Leave empty to configure it later — the system will"
    log "start and answer /health, but no agent can run until a key is set."
    printf 'DeepSeek API key (optional): ' >&2
    read -r V_DEEPSEEK_KEY
  fi
  if [ -z "${V_DEEPSEEK_KEY}" ] && [ -z "${V_OPENROUTER_KEY}" ]; then
    printf 'OpenRouter API key instead (optional): ' >&2
    read -r V_OPENROUTER_KEY
  fi

  log ""
  V_TIMEZONE="$(ask "Timezone" "${V_TIMEZONE}")"
  V_DAY_BUDGET="$(ask "Daily budget per project, USD" "${V_DAY_BUDGET}")"
  V_MONTH_BUDGET="$(ask "Monthly budget per project, USD" "${V_MONTH_BUDGET}")"
fi

# Validate the timezone against the system's own database. A typo here shifts every
# budget boundary and silently, because nothing else would complain.
if [ -f /usr/share/zoneinfo/"${V_TIMEZONE}" ]; then
  ok "timezone ${V_TIMEZONE}"
else
  warn "timezone '${V_TIMEZONE}' is not in /usr/share/zoneinfo — it may be invalid"
  if [ "${NON_INTERACTIVE}" != "1" ]; then
    confirm "Use it anyway?" || die "aborted: set a valid timezone"
  fi
fi

V_ADMIN_ID="$(printf '%s' "${V_ADMIN_ID}" | tr -d '[:space:]')"

# Which provider the default models use: DeepSeek directly when its key is set,
# else the same DeepSeek models through OpenRouter.
provider_summary() {
  if [ -n "${V_DEEPSEEK_KEY}" ]; then printf 'DeepSeek%s' "$([ -n "${V_OPENROUTER_KEY}" ] && printf ' + OpenRouter')"
  elif [ -n "${V_OPENROUTER_KEY}" ]; then printf 'OpenRouter (default models: openrouter/deepseek/...)'
  else printf 'NOT SET — no agent can run until it is'
  fi
}

# ── what will happen ───────────────────────────────────────────────────────────

log ""
info "install plan"
log "  data directory   ${FINAL_DATA_PATH}"
log "  image            ${V_IMAGE}$([ "${BUILD_FROM_SOURCE}" = "1" ] && printf ' (built from %s)' "${REPO_ROOT}")"
log "  timezone         ${V_TIMEZONE}"
log "  admin user id    ${V_ADMIN_ID}"
log "  budgets          \$${V_DAY_BUDGET}/day, \$${V_MONTH_BUDGET}/month per project"
log "  approvals        ask (every risky action becomes a Telegram question)"
log "  provider key     $(provider_summary)"
log ""

if [ "${DRY_RUN}" = "1" ]; then
  log "dry run: prerequisites and plan only; nothing was created or started"
  exit 0
fi

confirm "Proceed?" || die "aborted"

# ── 3. the data directory ──────────────────────────────────────────────────────

if [ -d "${FINAL_DATA_PATH}" ] && data_is_initialized; then
  # Idempotency: an existing deployment is not re-initialized. Replacing ops.yaml
  # would discard the operator's edits, which is the worst thing an installer can do.
  warn "${FINAL_DATA_PATH} already holds a configuration"
  if confirm "Keep the existing config/ops.yaml and .env, and only (re)start the service?"; then
    KEEP_CONFIG=1
  else
    confirm "REPLACE the existing configuration?" || die "aborted"
    KEEP_CONFIG=0
  fi
else
  KEEP_CONFIG=0
fi

info "creating ${FINAL_DATA_PATH}"
sudo mkdir -p "${FINAL_DATA_PATH}" 2>/dev/null || mkdir -p "${FINAL_DATA_PATH}"

# Ownership: the container's uid is FIXED at 10001 (see the Dockerfile), so the host
# directory must be owned by it. A bind mount preserves the host's ownership, and a
# mismatch is the single most common install failure.
if [ "$(id -u)" = "0" ]; then
  chown -R 10001:10001 "${FINAL_DATA_PATH}"
else
  if ! sudo chown -R 10001:10001 "${FINAL_DATA_PATH}" 2>/dev/null; then
    warn "could not chown ${FINAL_DATA_PATH} to 10001:10001 (needs sudo)"
    warn "Without it the container cannot write and will refuse to start."
    warn "Run: sudo chown -R 10001:10001 ${FINAL_DATA_PATH}"
  fi
fi
chmod 0750 "${FINAL_DATA_PATH}" 2>/dev/null || true

for sub in "${DATA_SUBDIRS[@]}"; do
  mkdir -p "${FINAL_DATA_PATH}/${sub}" 2>/dev/null || sudo mkdir -p "${FINAL_DATA_PATH}/${sub}"
done
mkdir -p "${FINAL_DATA_PATH}/config/projects" 2>/dev/null || sudo mkdir -p "${FINAL_DATA_PATH}/config/projects"
ok "layout created"

# The ownership is re-applied AFTER the subdirectories, because creating them as the
# caller's uid can reset it.
if [ "$(id -u)" = "0" ]; then
  chown -R 10001:10001 "${FINAL_DATA_PATH}"
else
  sudo chown -R 10001:10001 "${FINAL_DATA_PATH}" 2>/dev/null || true
fi

# The compose .env must be readable by the caller, not by uid 10001: it is read by the
# Docker CLI on the HOST. It is chmod 600 because it holds the bot token.
ENV_FILE="${COMPOSE_DIR}/.env"

# ── 4. the configuration ───────────────────────────────────────────────────────

OPS_YAML="${FINAL_DATA_PATH}/config/ops.yaml"

if [ "${KEEP_CONFIG}" = "1" ]; then
  ok "keeping the existing ops.yaml and .env"
else
  info "writing ${OPS_YAML}"

  TEMPLATE="${DEPLOY_DIR}/templates/ops.yaml.minimal"
  [ -f "${TEMPLATE}" ] || die "the template ${TEMPLATE} is missing. This is a broken checkout."

  # The minimal template: only what differs per install. Every other key has a default,
  # documented in templates/ops.yaml.example.
  #
  # `TMP_YAML` is written beside the target because a cross-device `mv` fails, and the
  # target is often a different mount.
  TMP_YAML="${OPS_YAML}.tmp"
  cp "${TEMPLATE}" "${TMP_YAML}"

  # The timezone, including the commented example line so the file still explains it.
  sed -i "s|^timezone: .*|timezone: ${V_TIMEZONE}|" "${TMP_YAML}"
  # The data directory INSIDE the container, which is always /data: the host path is
  # the mount, and putting it here would be the mismatch the entrypoint warns about.
  sed -i "s|^data_dir: .*|data_dir: /data|" "${TMP_YAML}"
  # The admin: allowed to use the bot, and where reports and warnings go. Quoted
  # because a very large id read as a number would lose precision.
  sed -i "s|^  admin: null|  admin: '${V_ADMIN_ID}'|" "${TMP_YAML}"
  # The budgets.
  sed -i "s|^  default_day_usd: .*|  default_day_usd: ${V_DAY_BUDGET}|" "${TMP_YAML}"
  sed -i "s|^  default_month_usd: .*|  default_month_usd: ${V_MONTH_BUDGET}|" "${TMP_YAML}"
  # Only an OpenRouter key: the default models run through OpenRouter.
  if [ -z "${V_DEEPSEEK_KEY}" ] && [ -n "${V_OPENROUTER_KEY}" ]; then
    printf '\n# Only an OpenRouter key was given, so the defaults run through it.\ntasks:\n  model: openrouter/deepseek/deepseek-v4-flash\norchestrator:\n  model: openrouter/deepseek/deepseek-v4-flash\n' >> "${TMP_YAML}"
  fi

  # The container reads it as uid 10001, so it must be readable by it.
  mv "${TMP_YAML}" "${OPS_YAML}" 2>/dev/null || { cat "${TMP_YAML}" > "${OPS_YAML}"; rm -f "${TMP_YAML}"; }
  chmod 0640 "${OPS_YAML}" 2>/dev/null || sudo chmod 0640 "${OPS_YAML}"
  chown 10001:10001 "${OPS_YAML}" 2>/dev/null || sudo chown 10001:10001 "${OPS_YAML}" 2>/dev/null || true
  ok "ops.yaml written (admin: ${V_ADMIN_ID}, budgets \$${V_DAY_BUDGET}/\$${V_MONTH_BUDGET})"

  if [ -f "${DEPLOY_DIR}/templates/projects/example.yaml" ]; then
    cp "${DEPLOY_DIR}/templates/projects/example.yaml" "${FINAL_DATA_PATH}/config/projects/example.yaml"
    if [ -z "${V_DEEPSEEK_KEY}" ] && [ -n "${V_OPENROUTER_KEY}" ]; then
      sed -i -e "s|^provider: deepseek|provider: openrouter|" -e "s|^model: deepseek-v4-pro|model: deepseek/deepseek-v4-pro|" \
        -e "s|^fallback_model: deepseek/deepseek-flash|fallback_model: openrouter/deepseek/deepseek-v4-flash|" \
        "${FINAL_DATA_PATH}/config/projects/example.yaml"
    fi
    chown 10001:10001 "${FINAL_DATA_PATH}/config/projects/example.yaml" 2>/dev/null || true
    dim "  an example project was placed at config/projects/example.yaml — edit or delete it"
  fi

  # ── .env ──
  info "writing ${ENV_FILE}"
  # A fresh file rather than a sed of the template: the template's comments are useful
  # in the repository and noise in a 600-mode secrets file.
  OLD_UMASK="$(umask)"
  umask 077   # the file is created unreadable by anyone else, before any secret is written
  cat > "${ENV_FILE}" <<EOF
# Argus Agent deployment environment. GENERATED by install.sh.
# Mode 600. Holds secrets. Never commit this file.
#
# Regenerate with deploy/scripts/install.sh, or edit by hand and restart.

TELEGRAM_BOT_TOKEN=${V_TELEGRAM_TOKEN}
DEEPSEEK_API_KEY=${V_DEEPSEEK_KEY}
OPENROUTER_API_KEY=${V_OPENROUTER_KEY}
# Any other provider: <PROVIDER>_API_KEY, taken from the installer's environment.
$(env | grep -E '^[A-Z0-9_]+_API_KEY=' | grep -vE '^(DEEPSEEK|OPENROUTER)_API_KEY=' | sort)

ARGUS_AGENT_IMAGE=${V_IMAGE}
ARGUS_AGENT_DATA_PATH=${FINAL_DATA_PATH}
ARGUS_AGENT_CONFIG=/data/config/ops.yaml
TZ=${V_TIMEZONE}
EOF
  umask "${OLD_UMASK}"
  chmod 600 "${ENV_FILE}"
  ok ".env written (mode 600)"
fi

# ── 5. the image ───────────────────────────────────────────────────────────────

if [ "${BUILD_FROM_SOURCE}" = "1" ]; then
  info "building the image from ${REPO_ROOT}"
  ( cd "${REPO_ROOT}" && docker build -f deploy/docker/Dockerfile -t "${V_IMAGE}" . ) || die "the build failed"
  ok "image built: ${V_IMAGE}"
else
  info "pulling ${V_IMAGE}"
  if docker image inspect "${V_IMAGE}" >/dev/null 2>&1; then
    dim "  already present locally"
    ok "image present"
  else
    if ! ( cd "${COMPOSE_DIR}" && docker pull "${V_IMAGE}" ); then
      warn "could not pull ${V_IMAGE}"
      log ""
      log "Either the tag does not exist yet, or you are offline. To build from a"
      log "checkout instead:"
      log "  $0 --build --image argus-agent:local"
      die "no image to run"
    fi
    ok "image pulled"
  fi
fi

# ── 6. start ───────────────────────────────────────────────────────────────────

info "starting the service"
if using_ollama; then
  dim "  the Ollama overlay is active (OLLAMA_BASE_URL is set in .env)"
  compose_with_overlay down --remove-orphans >/dev/null 2>&1 || true
  compose_with_overlay up -d || die "docker compose failed. See: docker compose logs"
else
  compose down --remove-orphans >/dev/null 2>&1 || true
  compose up -d || die "docker compose failed. See: docker compose logs"
fi
ok "containers started"

if ! wait_for_health 180; then
  err ""
  err "The service started but never became healthy."
  err "The most common causes, in order:"
  err "  1. data directory ownership — run: sudo chown -R 10001:10001 ${FINAL_DATA_PATH}"
  err "  2. a missing or invalid config/ops.yaml — the log says which key"
  err "  3. an invalid Telegram token — the log names it (never its value)"
  err ""
  err "See docs/user-docs.md#troubleshooting"
  exit 1
fi

# ── 7. the first message ───────────────────────────────────────────────────────

info "sending the first message"

# Sent through the BOT API directly rather than through an Argus Agent command, because
# this tests the one thing the acceptance criterion is about — that the token works and
# the operator can be reached — without depending on a plugin being mounted.
SENT=0
if [ -n "${V_TELEGRAM_TOKEN}" ]; then
  HOSTNAME_S="$(hostname 2>/dev/null || echo unknown)"
  MESSAGE="Argus Agent is online.

Host: ${HOSTNAME_S}
Timezone: ${V_TIMEZONE}
Budgets: \$${V_DAY_BUDGET}/day, \$${V_MONTH_BUDGET}/month per project

Send /help to see the commands, or /status to see the system."

  # --data-urlencode for the body, so the text is escaped rather than interpolated
  # into a shell command. The token is in the URL, which is where Telegram puts it.
  RESPONSE="$(curl --silent --max-time 20 \
    --request POST \
    --data-urlencode "chat_id=${V_ADMIN_ID}" \
    --data-urlencode "text=${MESSAGE}" \
    "https://api.telegram.org/bot${V_TELEGRAM_TOKEN}/sendMessage" 2>/dev/null || true)"

  if printf '%s' "${RESPONSE}" | grep -q '"ok":true'; then
    ok "the first message was delivered to ${V_ADMIN_ID}"
    SENT=1
  else
    # The error description never contains the token; the response is safe to show.
    DESCRIPTION="$(printf '%s' "${RESPONSE}" | sed -n 's/.*"description":"\([^"]*\)".*/\1/p' | head -n 1)"
    warn "could not deliver the first message: ${DESCRIPTION:-no response from the Telegram API}"
    log ""
    log "The system IS running and will answer /health. The token or the user id is the"
    log "problem. Check:"
    log "  - the token is complete (the part after the colon is long)"
    log "  - you have sent /start to your own bot at least once"
    log "  - the user id is YOURS and is numeric (message @userinfobot)"
    log ""
    log "After fixing .env: docker compose -f ${COMPOSE_FILE} up -d --force-recreate"
  fi
else
  dim "  no token was configured, so no message was sent"
fi

# ── 8. smoke test ──────────────────────────────────────────────────────────────

info "running the smoke test"
if bash "${LIB_DIR}/smoke.sh" --quiet; then
  ok "the smoke test passed"
else
  warn "the smoke test reported problems (see above)"
  warn "The system is running, but not everything works. See docs/user-docs.md#troubleshooting"
fi

# ── 9. next steps ──────────────────────────────────────────────────────────────

cat >&2 <<EOF

${C_GREEN}${C_BOLD}Argus Agent is installed.${C_RESET}

  data directory   ${FINAL_DATA_PATH}
  configuration    ${FINAL_DATA_PATH}/config/ops.yaml
  environment      ${ENV_FILE}   (mode 600)
  logs             docker compose -f ${COMPOSE_FILE} logs -f
  health           docker exec ${CONTAINER_NAME} curl -s http://127.0.0.1:3090/health

EOF

if [ "${SENT}" = "1" ]; then
cat >&2 <<EOF
  ${C_GREEN}Check Telegram — the first message should already be there.${C_RESET}

EOF
fi

if [ -z "${V_DEEPSEEK_KEY}" ] && [ -z "${V_OPENROUTER_KEY}" ]; then
cat >&2 <<EOF
  ${C_YELLOW}No provider key was set.${C_RESET} The system runs, but no agent can think.
  Add it and restart:
    \$EDITOR ${ENV_FILE}      # DEEPSEEK_API_KEY=... or OPENROUTER_API_KEY=...
    docker compose -f ${COMPOSE_FILE} up -d --force-recreate

EOF
fi

cat >&2 <<EOF
  Next:
    1. Edit ${FINAL_DATA_PATH}/config/projects/example.yaml, or copy it to make
       a real project. The 'description' field is what the orchestrator routes on.
    2. Send /help to your bot, then /status.
    3. Read docs/user-docs.md#configuration for the full reference.

  Keep the bot token secret. Anyone with it can drive this system as the bot.

  Back up regularly:
    ${LIB_DIR}/backup.sh

EOF
