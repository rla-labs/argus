#!/usr/bin/env bash
# == ARGUS AGENT PROJECT ==
#
# First-party extensions in the REAL image, hardened as compose runs it: each one is
# installed from its folder of the repository, as /ext install does (its install confined, with the
# network), enabled in a project, and its own test/smoke.sh run in that project's
# folder, confined, as the project's shell runs its programs. A project that did not
# enable it must not reach its programs.
#
#   pnpm test:docker-extensions [repository]
#
# Without an argument it tests ../argus-extensions, every folder in it with an
# extension.yaml. It never touches an existing argus-agent container or volume, and
# removes all it created. It needs Docker, the network and a kernel with Landlock. It is
# NOT part of `pnpm test`.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="argus-agent:extensions-test"
VOLUME="argus-extensions-test-$$"

extensions="${1:-${REPO}/../argus-extensions}"
if [[ ! -d "${extensions}/.git" ]]; then
  echo "no extensions repository at ${extensions}" >&2
  exit 2
fi
extensions="$(cd "${extensions}" && pwd)"

cleanup() {
  docker volume rm -f "${VOLUME}" >/dev/null 2>&1 || true
  docker image rm -f "${IMAGE}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> building the image (a few minutes)"
docker build -q -f "${REPO}/deploy/docker/Dockerfile" -t "${IMAGE}" "${REPO}" >/dev/null

docker volume create "${VOLUME}" >/dev/null
docker run --rm -u 0 -v "${VOLUME}:/data" --entrypoint chown "${IMAGE}" 10001:10001 /data

echo "==> installing and running, confined, in a hardened container"
docker run --rm -i -v "${VOLUME}:/data" -v "${extensions}:/src:ro" \
  --read-only --tmpfs /tmp:size=256m,mode=1777,exec \
  --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 512 \
  --workdir /app/packages/argus-agent \
  -v "${REPO}/scripts/extension-check.mjs:/check.mjs:ro" \
  --entrypoint node "${IMAGE}" /check.mjs /app /data /src
