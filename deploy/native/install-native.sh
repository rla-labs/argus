#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# Install Argus Agent DIRECTLY on a Linux host, without Docker.
#
# What "without Docker" changes, and why it matters more than the mechanics:
#
#   * There is no container to confine a project's tools. The systemd unit's own
#     hardening (ProtectSystem, CapabilityBoundingSet, ReadWritePaths) IS the barrier, and
#     a tool a project runs has the service account's access. Read
#     `docs/user-docs.md#security` before putting anything sensitive on the host.
#   * There is no image, so there is no atomic rollback to a previous version. An upgrade
#     rebuilds in place; `upgrade-native.sh` restores the git revision and the database.
#   * The health endpoint is read from the HOST rather than through `docker exec`, which
#     is simpler — it is loopback-only, and the host is where an operator is.
#
# THE SHAPE OF THE INSTALL, and why each part is where it is:
#
#   /opt/argus-agent                          the application — code, replaceable, rebuildable
#   /srv/argus-agent/data                     THE DATA — the only thing that must be backed up
#   /srv/argus-agent/data/dsh-home/profiles/ops   the composed profile dsh boots
#   /srv/argus-agent/secrets.env              secrets, 600, owned by ops
#   /etc/systemd/system/argus-agent.service   the unit
#
# The profile is a directory under the data directory, because that is where dsh looks
# (`$DSH_HOME/profiles/<name>`). Its bundle is a LINK to the built application, so the
# bundle reaches every ops-* plugin through the application's node_modules; the user's
# `cordis.patch.yml` in it survives reinstalls and upgrades.
#
# Usage:
#   install-native.sh [options]
#
# Environment (used instead of prompting, and required with --non-interactive):
#   TELEGRAM_BOT_TOKEN, ARGUS_AGENT_ADMIN_ID, ARGUS_AGENT_TIMEZONE, DEEPSEEK_API_KEY, OPENROUTER_API_KEY,
#   ARGUS_AGENT_DAY_BUDGET_USD, ARGUS_AGENT_MONTH_BUDGET_USD, ARGUS_AGENT_REPO_URL

# shellcheck source=lib-native.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-native.sh"

NON_INTERACTIVE=0
SKIP_BUILD=0
DRY_RUN=0

V_TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
V_ADMIN_ID="${ARGUS_AGENT_ADMIN_ID:-}"
V_TIMEZONE="${ARGUS_AGENT_TIMEZONE:-}"
V_DEEPSEEK_KEY="${DEEPSEEK_API_KEY:-}"
V_OPENROUTER_KEY="${OPENROUTER_API_KEY:-}"
V_DAY_BUDGET="${ARGUS_AGENT_DAY_BUDGET_USD:-3}"
V_MONTH_BUDGET="${ARGUS_AGENT_MONTH_BUDGET_USD:-40}"

usage() {
  cat <<EOF
Usage: install-native.sh [options]

  --non-interactive   take every value from the environment; never prompt
  --skip-build        do not build the TypeScript (assume lib/ is present)
  --dry-run           check prerequisites and print the plan; change nothing
  --yes               assume yes for confirmations
  --help              this message

Paths (overridable through the environment):
  ARGUS_AGENT_APP_DIR     the application directory    (default ${APP_DIR})
  ARGUS_AGENT_HOME        the service account's home   (default ${SERVICE_HOME})
  ARGUS_AGENT_DATA_DIR    the data directory           (default ${DATA_DIR})

Values (also available as flags through the environment):
  TELEGRAM_BOT_TOKEN          required
  ARGUS_AGENT_ADMIN_ID            required — your NUMERIC Telegram user id
  ARGUS_AGENT_TIMEZONE            default UTC
  DEEPSEEK_API_KEY            optional, but no agent can run without a provider key
  OPENROUTER_API_KEY          or/and an OpenRouter key; with only this one, the
                              default models run through OpenRouter
  ARGUS_AGENT_DAY_BUDGET_USD      default 3
  ARGUS_AGENT_MONTH_BUDGET_USD    default 40

What it does:
  1. checks root, the OS, Node ${REQUIRED_NODE_MAJOR}.x and pnpm
  2. creates the ${SERVICE_USER} system user and the data layout
  3. obtains the application (this checkout, or a clone)
  4. installs dependencies and builds
  5. installs the pinned dsh and composes the ops profile with dsh's own plugin manager
  6. writes config/ops.yaml and secrets.env (mode 600)
  7. installs and starts the systemd unit
  8. waits for /health
  9. sends "Argus Agent is online" to Telegram
 10. prints what to do next
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --skip-build)      SKIP_BUILD=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --yes|-y)          ASSUME_YES=1; export ASSUME_YES; shift ;;
    --help|-h)         usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ── 1. prerequisites ───────────────────────────────────────────────────────────

require_root

info "checking prerequisites"

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  OS_ID="$(. /etc/os-release && printf '%s' "${ID:-unknown}")"
  OS_NAME="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-unknown}")"
  case "${OS_ID}" in
    ubuntu|debian|raspbian|linuxmint|pop|fedora|rhel|centos|rocky|almalinux|amzn)
      ok "${OS_NAME}" ;;
    alpine)
      warn "${OS_NAME} — this script assumes systemd; Alpine usually uses OpenRC"
      warn "The manual steps in INSTALL-NATIVE.md work, but the unit will not." ;;
    *)
      warn "${OS_NAME} is untested. See INSTALL-NATIVE.md for the manual steps." ;;
  esac
else
  warn "cannot identify the OS (/etc/os-release is missing)"
fi

# systemd is not optional here: it is what restarts the service after a crash, and the
# health plugin's recovery pass only runs at startup — so a restart IS the recovery
# mechanism, not merely a retry.
if systemd_available; then
  ok "systemd is available"
else
  die "systemd is required. This script installs a systemd unit; without it there is
nothing to restart the service after a crash. Use the Docker install instead, or read
INSTALL-NATIVE.md for the manual steps with another supervisor."
fi

ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|aarch64|arm64) ok "architecture ${ARCH}" ;;
  *) warn "architecture ${ARCH} is untested" ;;
esac

check_node
check_pnpm
require_command git "Install it with: apt-get install git (or your distribution's equivalent)"
require_command curl "Install it with: apt-get install curl"
require_command tar "Install it with: apt-get install tar"

# Disk: the checkout, node_modules and a first database need room. A warning rather than
# a failure, because only the operator knows what else the host does.
AVAIL_KB="$(df -Pk "${SERVICE_HOME%/*}" 2>/dev/null | awk 'NR==2 {print $4}' || echo 0)"
if [ -n "${AVAIL_KB}" ] && [ "${AVAIL_KB}" -lt 5242880 ] 2>/dev/null; then
  warn "less than 5 GB free at ${SERVICE_HOME%/*} — node_modules and the database need room"
fi

if curl --max-time 5 --silent --output /dev/null https://api.telegram.org 2>/dev/null; then
  ok "network reachable"
else
  warn "could not reach api.telegram.org — check the firewall and any proxy"
fi

# ── 2. the values ──────────────────────────────────────────────────────────────

info "collecting configuration"

if [ "${NON_INTERACTIVE}" = "1" ]; then
  [ -n "${V_TELEGRAM_TOKEN}" ] || die "TELEGRAM_BOT_TOKEN is required with --non-interactive"
  [ -n "${V_ADMIN_ID}" ]      || die "ARGUS_AGENT_ADMIN_ID is required with --non-interactive"
  [ -n "${V_TIMEZONE}" ]      || V_TIMEZONE="UTC"
  ok "non-interactive: values taken from the environment"
else
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

  if [ -z "${V_TELEGRAM_TOKEN}" ]; then
    log "The bot token comes from @BotFather on Telegram: send /newbot and follow it."
    while [ -z "${V_TELEGRAM_TOKEN}" ]; do
      printf 'Telegram bot token: ' >&2
      read -r V_TELEGRAM_TOKEN
      [ -n "${V_TELEGRAM_TOKEN}" ] || warn "the token is required — without it nothing can be delivered"
    done
  fi

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
    log "The provider API key. Leave empty to configure it later — the service will"
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

V_ADMIN_ID="$(printf '%s' "${V_ADMIN_ID}" | tr -d '[:space:]')"
case "${V_ADMIN_ID}" in
  ''|*[!0-9]*) die "the admin user id must be numeric, got '${V_ADMIN_ID}'" ;;
esac

if [ -f /usr/share/zoneinfo/"${V_TIMEZONE}" ]; then
  ok "timezone ${V_TIMEZONE}"
else
  warn "timezone '${V_TIMEZONE}' is not in /usr/share/zoneinfo — it may be invalid"
fi

# ── the plan ───────────────────────────────────────────────────────────────────

log ""
info "install plan"
log "  application      ${APP_DIR}"
log "  data directory   ${DATA_DIR}"
log "  service user     ${SERVICE_USER}"
log "  dsh version      ${DSH_VERSION} (pinned)"
log "  timezone         ${V_TIMEZONE}"
log "  admin user id    ${V_ADMIN_ID}"
log "  budgets          \$${V_DAY_BUDGET}/day, \$${V_MONTH_BUDGET}/month per project"
log "  approvals        ask (every risky action becomes a Telegram question)"
log "  provider key     $(
  if [ -n "${V_DEEPSEEK_KEY}" ]; then printf 'DeepSeek%s' "$([ -n "${V_OPENROUTER_KEY}" ] && printf ' + OpenRouter')"
  elif [ -n "${V_OPENROUTER_KEY}" ]; then printf 'OpenRouter (default models: openrouter/deepseek/...)'
  else printf 'NOT SET — no agent can run until it is'; fi)"
log ""
log "  Note: without Docker there is no container confining a project's tools."
log "        The systemd unit's hardening is the barrier — see docs/user-docs.md#security."
log ""

if [ "${DRY_RUN}" = "1" ]; then
  log "dry run: prerequisites and plan only; nothing was created or started"
  exit 0
fi

confirm "Proceed?" || die "aborted"

# ── 3. the service account and the layout ──────────────────────────────────────

ensure_service_user

info "creating ${DATA_DIR}"
mkdir -p "${SERVICE_HOME}"
ensure_data_layout
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${SERVICE_HOME}"
# 0750: the data holds session transcripts and project code. Nothing outside the service
# account needs to read it.
chmod 0750 "${SERVICE_HOME}" "${DATA_DIR}"
ok "layout created"

# ── 4. the application ─────────────────────────────────────────────────────────

# Reuse a checkout already at APP_DIR, reuse the one this script lives in when it IS the
# checkout, and otherwise clone. The order matters: an operator who ran the script from
# their own clone expects THAT code to be installed.
if [ -f "${APP_DIR}/package.json" ]; then
  ok "using the existing application at ${APP_DIR}"
elif [ -f "${REPO_ROOT}/package.json" ] && [ -d "${REPO_ROOT}/packages" ]; then
  info "copying this checkout to ${APP_DIR}"
  mkdir -p "${APP_DIR}"
  # `--exclude` rather than a bare copy: the data directory and any local tooling cache
  # must not be copied into the application tree.
  tar -C "${REPO_ROOT}" \
      --exclude='./.git' --exclude='./node_modules' --exclude='./.tooling' --exclude='./cache' \
      --exclude='./lib' --exclude='*/lib' --exclude='./data' \
      -cf - . | tar -C "${APP_DIR}" -xf -
  ok "copied"
else
  REPO_URL="${ARGUS_AGENT_REPO_URL:-https://github.com/rla-labs/argus.git}"
  info "cloning ${REPO_URL} into ${APP_DIR}"
  rm -rf "${APP_DIR}"
  git clone --depth 1 "${REPO_URL}" "${APP_DIR}" || die "the clone failed"
  ok "cloned"
fi

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"

# ── 5. dependencies and build ──────────────────────────────────────────────────

# The build runs as the service account, and pnpm needs a writable HOME and store. The
# store under the service home keeps the application tree clean and survives a rebuild.
export HOME="${SERVICE_HOME}"
export npm_config_store_dir="${SERVICE_HOME}/.pnpm-store"

info "installing dependencies (this takes a few minutes)"
if ! su -s /bin/bash "${SERVICE_USER}" -c "cd '${APP_DIR}' && pnpm install --frozen-lockfile"; then
  die "pnpm install failed in ${APP_DIR}"
fi
ok "dependencies installed"

if [ "${SKIP_BUILD}" = "1" ]; then
  dim "skipping the build (--skip-build)"
  [ -d "${APP_DIR}/packages/argus-agent/lib" ] || die "--skip-build was given but ${APP_DIR}/packages/argus-agent/lib does not exist"
else
  info "building"
  if ! su -s /bin/bash "${SERVICE_USER}" -c "cd '${APP_DIR}' && pnpm build"; then
    die "the build failed in ${APP_DIR}"
  fi
  ok "built"
fi

# ── 6. dsh and the profile ─────────────────────────────────────────────────────

# dsh is installed GLOBALLY, as root, so the service account does not need a package
# manager to boot. Pinned exactly: the bundle's patches are written for this version.
if command -v dsh >/dev/null 2>&1 && dsh --version 2>/dev/null | grep -q "${DSH_VERSION}"; then
  ok "dsh ${DSH_VERSION} is installed"
else
  info "installing dsh ${DSH_VERSION}"
  npm install --global "@deepseek-ai/dsh@${DSH_VERSION}" || die "could not install dsh ${DSH_VERSION}"
  ok "dsh $(dsh --version 2>/dev/null || echo installed)"
fi

DSH_BIN="$(command -v dsh)"
[ -n "${DSH_BIN}" ] || die "dsh is not on PATH after installation"

# The profile lives under the DATA directory's dsh-home, which is what the unit sets as
# DSH_HOME. It links the bundle to the built application (see `compose_profile`).
info "composing the ops profile"
compose_profile

# Verify the profile COMPOSES before the service is ever started. This is the cheapest
# possible check and it catches the most expensive failure: a profile that cannot boot,
# discovered only after the unit is enabled and the operator has walked away.
COMPOSED="$(profile_ops_rows)"
COMPOSED="$(printf '%s' "${COMPOSED}" | tr -dc '0-9')"
if [ -z "${COMPOSED}" ] || [ "${COMPOSED}" -lt 12 ]; then
  die "the profile composed only ${COMPOSED:-0} Argus Agent rows (expected at least 12).
Check that ${APP_DIR}/packages/argus-agent built successfully, then re-run."
fi
ok "profile composes (${COMPOSED} Argus Agent rows)"

# ── 7. configuration and secrets ───────────────────────────────────────────────

info "writing ${CONFIG_FILE}"

TEMPLATE="${DEPLOY_DIR}/templates/ops.yaml.example"
[ -f "${TEMPLATE}" ] || die "the template ${TEMPLATE} is missing. This is a broken checkout."

if [ -f "${CONFIG_FILE}" ] && data_is_initialized; then
  warn "${CONFIG_FILE} already exists"
  if ! confirm "Replace it?"; then
    dim "  keeping the existing configuration"
    REPLACED_CONFIG=0
  else
    REPLACED_CONFIG=1
  fi
else
  REPLACED_CONFIG=1
fi

if [ "${REPLACED_CONFIG}" = "1" ]; then
  # The template is copied and edited with sed rather than regenerated, so every comment
  # survives — the file an operator opens is the documented one.
  TMP_YAML="${CONFIG_FILE}.tmp"
  cp "${TEMPLATE}" "${TMP_YAML}"

  sed -i "s|^timezone: .*|timezone: ${V_TIMEZONE}|" "${TMP_YAML}"
  # data_dir points at the HOST path here: there is no container to map /data from. This
  # is the one line that differs from the Docker install.
  sed -i "s|^data_dir: .*|data_dir: ${DATA_DIR}|" "${TMP_YAML}"
  sed -i "s|^  allowed_users: \[\]|  allowed_users:\n    - { channel: telegram, userId: '${V_ADMIN_ID}' }|" "${TMP_YAML}"
  # Quoted, because YAML reads an unquoted `telegram:123` as a MAPPING rather than a string.
  sed -i "s|^  default_address: null|  default_address: \"telegram:${V_ADMIN_ID}\"|" "${TMP_YAML}"
  sed -i "s|^  default_day_usd: .*|  default_day_usd: ${V_DAY_BUDGET}|" "${TMP_YAML}"
  sed -i "s|^  default_month_usd: .*|  default_month_usd: ${V_MONTH_BUDGET}|" "${TMP_YAML}"
  # Only an OpenRouter key: the default models run through OpenRouter.
  if [ -z "${V_DEEPSEEK_KEY}" ] && [ -n "${V_OPENROUTER_KEY}" ]; then
    sed -i "s|^  model: deepseek/deepseek-flash|  model: openrouter/deepseek/deepseek-v4-flash|" "${TMP_YAML}"
  fi

  mv "${TMP_YAML}" "${CONFIG_FILE}"
  ok "ops.yaml written (allowlist: ${V_ADMIN_ID}, budgets \$${V_DAY_BUDGET}/\$${V_MONTH_BUDGET})"

  if [ -f "${DEPLOY_DIR}/templates/projects/example.yaml" ]; then
    # The template is written for the container, where the data is at /data. Here it
    # is DATA_DIR, and a project whose cwd is outside DATA_DIR/projects is rejected —
    # which stops ops-projects, and every plugin after it, from starting.
    sed "s|/data/|${DATA_DIR}/|g" "${DEPLOY_DIR}/templates/projects/example.yaml" \
      > "${DATA_DIR}/config/projects/example.yaml"
    if [ -z "${V_DEEPSEEK_KEY}" ] && [ -n "${V_OPENROUTER_KEY}" ]; then
      sed -i -e "s|^provider: deepseek|provider: openrouter|" -e "s|^model: deepseek-v4-pro|model: deepseek/deepseek-v4-pro|" \
        -e "s|^fallback_model: deepseek/deepseek-flash|fallback_model: openrouter/deepseek/deepseek-v4-flash|" \
        "${DATA_DIR}/config/projects/example.yaml"
    fi
    dim "  an example project was placed at config/projects/example.yaml — edit or delete it"
  fi
fi

info "writing ${SECRETS_FILE}"
# A fresh file rather than a sed of the template: the template's comments are useful in
# the repository and noise in a 600-mode secrets file.
OLD_UMASK="$(umask)"
umask 077   # created unreadable by anyone else, before any secret is written
cat > "${SECRETS_FILE}" <<EOF
# Argus Agent secrets. GENERATED by install-native.sh.
# Mode 600, owned by ${SERVICE_USER}. Holds secrets. Never commit this file.
#
# systemd reads this as EnvironmentFile=. It must NOT be group- or world-readable:
# systemd refuses such a file, and a readable secrets file is a leaked secrets file.

TELEGRAM_BOT_TOKEN=${V_TELEGRAM_TOKEN}
DEEPSEEK_API_KEY=${V_DEEPSEEK_KEY}
OPENROUTER_API_KEY=${V_OPENROUTER_KEY}
# Any other provider: <PROVIDER>_API_KEY, taken from the installer's environment.
$(env | grep -E '^[A-Z0-9_]+_API_KEY=' | grep -vE '^(DEEPSEEK|OPENROUTER)_API_KEY=' | sort)
EOF
umask "${OLD_UMASK}"
chown "${SERVICE_USER}:${SERVICE_USER}" "${SECRETS_FILE}"
chmod 0600 "${SECRETS_FILE}"
ok "secrets.env written (mode 600)"

# The configuration is read by the service account and by nobody else.
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}"
chmod 0640 "${CONFIG_FILE}"
ok "the data tree is owned by ${SERVICE_USER}"

# ── 8. the unit ────────────────────────────────────────────────────────────────

info "installing the systemd unit"

UNIT_SOURCE="${NATIVE_DIR}/argus-agent.service"
[ -f "${UNIT_SOURCE}" ] || die "the unit template ${UNIT_SOURCE} is missing"

# The unit is templated for the paths the operator chose, so a non-default install works.
# `@VAR@` placeholders are substituted rather than the unit being regenerated, so the
# checked-in file stays the readable, commented source of truth.
sed -e "s|@APP_DIR@|${APP_DIR}|g" \
    -e "s|@SERVICE_USER@|${SERVICE_USER}|g" \
    -e "s|@SERVICE_HOME@|${SERVICE_HOME}|g" \
    -e "s|@DATA_DIR@|${DATA_DIR}|g" \
    -e "s|@DSH_HOME@|${DSH_HOME_DIR}|g" \
    -e "s|@CONFIG_FILE@|${CONFIG_FILE}|g" \
    -e "s|@SECRETS_FILE@|${SECRETS_FILE}|g" \
    -e "s|@DSH_BIN@|${DSH_BIN}|g" \
    "${UNIT_SOURCE}" > "${UNIT_PATH}"
chmod 0644 "${UNIT_PATH}"

systemctl daemon-reload || die "systemctl daemon-reload failed"
ok "unit installed at ${UNIT_PATH}"

# ── 9. start ───────────────────────────────────────────────────────────────────

info "starting the service"
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || warn "could not enable ${SERVICE_NAME} at boot"
systemctl restart "${SERVICE_NAME}" || die "could not start ${SERVICE_NAME}. See: journalctl -u ${SERVICE_NAME} -n 50"
ok "service started"

if ! wait_for_health 180; then
  err ""
  err "The service started but never became healthy."
  err "The most common causes, in order:"
  err "  1. a missing or invalid ${CONFIG_FILE}"
  err "  2. node_modules not readable by ${SERVICE_USER}"
  err "  3. an invalid Telegram token (the log names it, never its value)"
  err ""
  err "  journalctl -u ${SERVICE_NAME} -n 80 --no-pager"
  err "  docs/user-docs.md#troubleshooting"
  exit 1
fi

# ── 10. the first message ──────────────────────────────────────────────────────

info "sending the first message"

# Sent through the Bot API directly rather than through an Argus Agent command, because this
# tests the one thing that matters — that the token works and the operator is reachable —
# without depending on a plugin being mounted.
SENT=0
if [ -n "${V_TELEGRAM_TOKEN}" ]; then
  HOSTNAME_S="$(hostname 2>/dev/null || echo unknown)"
  MESSAGE="Argus Agent is online.

Host: ${HOSTNAME_S}
Install: native (systemd), no Docker
Timezone: ${V_TIMEZONE}
Budgets: \$${V_DAY_BUDGET}/day, \$${V_MONTH_BUDGET}/month per project

Send /help to see the commands, or /status to see the system."

  RESPONSE="$(curl --silent --max-time 20 \
    --request POST \
    --data-urlencode "chat_id=${V_ADMIN_ID}" \
    --data-urlencode "text=${MESSAGE}" \
    "https://api.telegram.org/bot${V_TELEGRAM_TOKEN}/sendMessage" 2>/dev/null || true)"

  if printf '%s' "${RESPONSE}" | grep -q '"ok":true'; then
    ok "the first message was delivered to ${V_ADMIN_ID}"
    SENT=1
  else
    DESCRIPTION="$(printf '%s' "${RESPONSE}" | sed -n 's/.*"description":"\([^"]*\)".*/\1/p' | head -n 1)"
    warn "could not deliver the first message: ${DESCRIPTION:-no response from the Telegram API}"
    log ""
    log "The SERVICE is running and will answer /health. The token or the user id is the"
    log "problem. Check:"
    log "  - the token is complete (the part after the colon is long)"
    log "  - you have sent /start to your own bot at least once"
    log "  - the user id is YOURS and is numeric (message @userinfobot)"
    log ""
    log "After fixing ${SECRETS_FILE}: systemctl restart ${SERVICE_NAME}"
  fi
else
  dim "  no token was configured, so no message was sent"
fi

# ── 11. smoke test ─────────────────────────────────────────────────────────────

info "running the smoke test"
if bash "${NATIVE_DIR}/smoke-native.sh" --quiet; then
  ok "the smoke test passed"
else
  warn "the smoke test reported problems (see above)"
fi

# ── 12. next steps ─────────────────────────────────────────────────────────────

cat >&2 <<EOF

${C_GREEN}${C_BOLD}Argus Agent is installed (native, systemd).${C_RESET}

  application      ${APP_DIR}
  data directory   ${DATA_DIR}
  configuration    ${CONFIG_FILE}
  secrets          ${SECRETS_FILE}   (mode 600)
  unit             ${UNIT_PATH}
  logs             journalctl -u ${SERVICE_NAME} -f
  health           curl -s http://127.0.0.1:3090/health
  restart          systemctl restart ${SERVICE_NAME}

EOF

if [ "${SENT}" = "1" ]; then
cat >&2 <<EOF
  ${C_GREEN}Check Telegram — the first message should already be there.${C_RESET}

EOF
fi

if [ -z "${V_DEEPSEEK_KEY}" ] && [ -z "${V_OPENROUTER_KEY}" ]; then
cat >&2 <<EOF
  ${C_YELLOW}No provider key was set.${C_RESET} The service runs, but no agent can think.
  Add it and restart:
    \$EDITOR ${SECRETS_FILE}      # DEEPSEEK_API_KEY=... or OPENROUTER_API_KEY=...
    systemctl restart ${SERVICE_NAME}

EOF
fi

cat >&2 <<EOF
  ${C_YELLOW}Without Docker there is no container around a project's tools.${C_RESET}
  The unit's hardening is the barrier. Read docs/user-docs.md#container-or-systemd
  before running anything you would not run by hand.

  Next:
    1. Edit ${DATA_DIR}/config/projects/example.yaml, or copy it to make a
       real project. The 'description' field is what the orchestrator routes on.
    2. Send /help to your bot, then /status.
    3. Read docs/user-docs.md#configuration for the full reference.

  Back up regularly:
    ${NATIVE_DIR}/backup-native.sh

  Keep the bot token secret. Anyone with it can drive this service as the bot.

EOF
