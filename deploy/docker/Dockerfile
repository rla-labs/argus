# syntax=docker/dockerfile:1.7
# == ARGUS AGENT PROJECT ==
#
# Argus Agent, packaged.
#
# Two stages: everything needed to BUILD in the first, everything needed to RUN in
# the second. The runtime stage carries no build tooling, no dev dependencies and no
# lockfile — a smaller image is a smaller attack surface, and this image runs an
# agent that has a shell inside it.
#
# THE IMAGE CONTAINS NO STATE. `/data` is the volume, and it holds the database, the
# sessions, the project workspaces, the memory and the configuration. Replacing the
# image must never touch any of it.

# ── build ──────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

# The pnpm version the lockfile was written with (`packageManager` in package.json;
# lockfileVersion 6.0). Pinned, because a different major resolves a different
# lockfile format.
ARG PNPM_VERSION=8.6.11
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable \
 && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /src

# Native builds need a toolchain: `better-sqlite3` compiles against libsqlite3, and a
# prebuilt binary is not published for every Node/platform pair.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The manifests first, so a source-only change reuses the dependency layer. The
# lockfile is required: an image built from floating ranges is not reproducible.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/ ./packages/
COPY profiles/ ./profiles/
COPY scripts/ ./scripts/
COPY tsconfig.base.json ./

# `--frozen-lockfile` fails the build rather than silently resolving something new.
RUN pnpm install --frozen-lockfile

# Build every package, then the profile is composed at RUNTIME: the profile lives in
# `$DSH_HOME/profiles`, which is inside the volume, so installing it here would make
# the image and the data disagree about which plugins are mounted.
RUN pnpm build

# Only what the runtime stage needs: the built packages, their manifests, the
# profile, and a production-only dependency tree. The workspace is reinstalled with
# `--prod` from the store the first install filled, so every plugin keeps the links
# to its own dependencies — the bundle reaches each ops-* plugin through them.
# (`pnpm deploy` is not used: it packs the bundle alone, without the plugins it
# lists as workspace peers.)
RUN rm -rf node_modules packages/*/node_modules profiles/*/node_modules \
 && pnpm install --prod --frozen-lockfile --offline \
 && mkdir -p /out \
 && cp -a package.json node_modules packages profiles /out/ \
 && rm -rf /out/profiles/*/node_modules \
 && find /out/packages -mindepth 2 -maxdepth 2 \( -name src -o -name test -o -name docs \) -prune -exec rm -rf {} + \
 && find /out/packages -name '*.test.*' -delete

# ── runtime ────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Argus Agent" \
      org.opencontainers.image.description="A self-hosted autonomous agent system on the DeepSeek Harness" \
      org.opencontainers.image.source="https://github.com/rla-labs/argus" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${ARGUS_AGENT_VERSION:-0.2.4}" \
      com.argus-agent.dsh-version="0.2.0-rc.2" \
      com.argus-agent.node="22"

ARG ARGUS_AGENT_VERSION=0.2.4
ENV ARGUS_AGENT_VERSION="$ARGUS_AGENT_VERSION"

# `tini` is the init. Node does not reap orphaned children or forward signals to a
# process group by default, and this container runs an agent that spawns shells: a
# `kill` that leaves the agent's subprocesses running is a leak, and a PID 1 that
# does not reap is a slow failure.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# The dsh launcher itself: the entrypoint execs `dsh --profile ops`. Pinned exactly,
# like every @deepseek-ai package in the workspace — the bundle's patches are
# written for this version.
ARG DSH_VERSION=0.2.0-rc.2
RUN npm install --global "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force \
 && dsh --version

# A FIXED UID/GID, documented. A fixed id is what lets an operator bind-mount a host
# directory and `chown` it once; a runtime-allocated id would change the ownership
# every rebuild.
ARG OPS_UID=10001
ARG OPS_GID=10001
RUN groupadd --gid "$OPS_GID" ops \
 && useradd --uid "$OPS_UID" --gid "$OPS_GID" --create-home --shell /usr/sbin/nologin ops

# The dsh home lives INSIDE the volume, so the composed profile and the data it
# describes travel together.
ENV DSH_HOME=/data/dsh-home
ENV ARGUS_AGENT_CONFIG=/data/config/ops.yaml
ENV NODE_ENV=production
ENV NODE_OPTIONS="--enable-source-maps"
# Never a `.npmrc` in the image: a registry token baked into a layer is a leaked token.
ENV HOME=/home/ops

WORKDIR /app
COPY --from=build --chown=ops:ops /out/ /app/
COPY --chown=ops:ops deploy/docker/entrypoint.sh /app/entrypoint.sh
COPY --chown=ops:ops deploy/templates/ /app/templates/
RUN chmod 0755 /app/entrypoint.sh

# The volume. Declared so `docker run` without `-v` still gets a writable tree, and
# so an operator reading `docker inspect` sees where the state is.
VOLUME ["/data"]

# 3090 is the ops health endpoint, on LOOPBACK inside the container. The port is
# EXPOSEd so a compose file can attach a healthcheck; it is not meant to be published
# to a host interface. See docs/user/security.md.
EXPOSE 3090

# The health check calls the same endpoint the operator does, so a failing check and
# a failing `curl` mean the same thing. `--start-period` covers the first boot, when
# migrations run.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl --fail --silent --max-time 8 http://127.0.0.1:3090/health >/dev/null || exit 1

USER ops

# tini reaps and forwards signals; `exec` in the entrypoint keeps the PID chain
# correct so `docker stop` reaches dsh rather than a wrapper.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD []
