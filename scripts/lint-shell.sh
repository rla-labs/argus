#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# Lint every shell script in the repository with shellcheck.
#
# The deploy scripts are the ones that run as root, delete data and restore backups, so
# a quoting bug in one of them is more expensive than anywhere else in this codebase.
# They are part of `pnpm lint` for that reason.
#
# `-x` follows the `source=lib.sh` directives, so a warning in the shared library is
# reported against the scripts that use it.
# `--severity=style` is the strictest level, and the scripts are written to pass it.
#
# Usage:
#   ./scripts/lint-shell.sh             # lint everything
#   ./scripts/lint-shell.sh deploy/     # lint a path
#
# The shellcheck binary is fetched through npx on first use. Set SHELLCHECK_BIN to use
# a local one and skip the download.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

# The files to lint. Everything that is a script, found by shebang rather than by
# extension, because a `.sh` suffix is a convention and a shebang is a fact.
collect() {
  local dir="${1:-${REPO_ROOT}}"
  find "${dir}" \
    -type f \
    -name '*.sh' \
    -not -path '*/node_modules/*' \
    -not -path '*/.tooling/*' \
    -not -path '*/lib/*' \
    | sort
}

TARGET="${1:-${REPO_ROOT}}"
readonly TARGET

FILES=()
while IFS= read -r file; do
  FILES+=("${file}")
done < <(collect "${TARGET}")

if [ "${#FILES[@]}" -eq 0 ]; then
  printf 'lint-shell: no shell scripts found under %s\n' "${TARGET}"
  exit 0
fi

printf 'lint-shell: checking %d script(s)\n' "${#FILES[@]}"

# The shellcheck invocation.
#
# The npm package named "shellcheck" is a WRAPPER that downloads the upstream Haskell
# binary; its own version (4.x) is not the tool's. It is pinned so CI and a laptop agree
# — a new tool release occasionally adds a check that fires on existing code, and an
# unpinned wrapper would make that a surprise on someone else's machine.
#
# Set SHELLCHECK_BIN to a real `shellcheck` binary to skip the download entirely, which
# is what a distribution package or a CI image should do.
SHELLCHECK_WRAPPER="4.1.0"

run_shellcheck() {
  if [ -n "${SHELLCHECK_BIN:-}" ]; then
    "${SHELLCHECK_BIN}" "$@"
  else
    npx --yes "shellcheck@${SHELLCHECK_WRAPPER}" "$@" 2>/dev/null
  fi
}

FAILED=0
for file in "${FILES[@]}"; do
  relative="${file#"${REPO_ROOT}/"}"
  if output="$(run_shellcheck -x --severity=style --format=gcc "${file}" 2>&1)"; then
    printf '  ok   %s\n' "${relative}"
  else
    # Filter the one informational notice that is about shellcheck's own reach rather
    # than about the script: SC1091 cannot always resolve a dynamically-built path.
    filtered="$(printf '%s\n' "${output}" | grep -v 'SC1091' | grep -v '^$' || true)"
    if [ -z "${filtered}" ]; then
      printf '  ok   %s (SC1091 only)\n' "${relative}"
    else
      printf '  FAIL %s\n' "${relative}"
      printf '%s\n' "${filtered}" | sed 's/^/       /'
      FAILED=$((FAILED + 1))
    fi
  fi
done

if [ "${FAILED}" -gt 0 ]; then
  printf '\nlint-shell: %d script(s) failed\n' "${FAILED}"
  exit 1
fi

printf 'lint-shell: all clean\n'
