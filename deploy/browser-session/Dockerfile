# syntax=docker/dockerfile:1
#
# The browser-session machine image.
#
# WHAT THIS IS
#   A webrain worker — the Rust engine, exposed as MCP over HTTP, with a
#   rendering browser bundled — adapted to the exact contract `arachnefly`
#   deploys a machine with (`infrastructure/routines/global.go`,
#   `BuildConfigMap`). It is a thin adapter around webrain's own image. webrain
#   is never rebuilt, forked or patched here: invariant I1 is "build the
#   scheduler, never the browser".
#
# WHY AN ADAPTER IS NEEDED AT ALL — four mismatches, each read out of source
#   `BuildConfigMap` hard-codes a contract that webrain's image does not meet.
#   Nothing below is assumed; every claim has a file behind it.
#
#   1. PORT.  `internal_port` is the `PORT` env var, defaulting to 11235.
#      webrain listens on `--http <port>` — 9223 in its own Dockerfile — so
#      with no env sent (and `BrowserMachineRequest` sends none) nothing would
#      answer on 11235.
#   2. ENTRYPOINT.  The config sets `processes[0].entrypoint = ["app"]`, which
#      Fly documents as "the process that will run". webrain's image declares
#      ENTRYPOINT `webrain`, and no executable called `app` exists in it, so an
#      unmodified webrain image never starts. Hence this image ships one.
#   3. HEALTH CHECK.  The config asks Fly to `GET /` on that port. webrain
#      answers `/health` and its source says why that is the only extra route:
#      "Deliberately the ONLY extra route." Everything else reaches MCP
#      dispatch, which answers 401 once a token is set. A failing check makes
#      flyd restart the machine forever, so `/` has to answer 2xx. nginx does.
#   4. AUTH.  The machine's services publish on the PUBLIC ports 80/443 plus
#      the routed port, and Fly load-balances across identically-configured
#      machines — so a public request can land on another tenant's session.
#      webrain authenticates only when `WEBRAIN_HTTP_TOKEN` is set, so the
#      entrypoint refuses to start without it. Invariant I2 makes exclusivity
#      the safety boundary, and that boundary only holds while the machine is
#      not openly addressable.
#
#   The alternative is teaching `BuildConfigMap` the right health path and to
#   stop overriding the entrypoint. That changes a service carrying live
#   traffic for the manual deploy path, which is a decision rather than a side
#   effect — so this image adapts instead. Rationale: docs/ENV_CONFIG_MATRIX.md.
#
# PORT: 11235 is ASSERTED, not configured. `nginx.conf` listens on it and the
# entrypoint refuses to start on any other `PORT`, so a future change to the
# default fails loudly instead of leaving every session silently unreachable.
#
# ENGINES ARE BAKED IN, AND THEY HAVE TO BE. `BuildConfigMap` sets no `mounts`,
# so a session machine has no volume to persist into, and Fly resets a stopped
# machine's root filesystem to its original state. Anything webrain would
# download on demand is therefore re-downloaded by every single cold start.
# Lightpanda (~123 MB) and Obscura are installed at build time instead: the
# image is the cache. See `docs/ENV_CONFIG_MATRIX.md`.
#
# BUILD — `WEBRAIN_IMAGE` is deliberately required, with no default:
#   docker build -t browser-session:<pinned-tag> \
#     --build-arg WEBRAIN_IMAGE=ghcr.io/prokopis3/webrain:<pinned-tag> \
#     deploy/browser-session
#
# No default because a floating tag here would silently change which engine
# every future session runs — the same reasoning that gives
# `BROWSER_MACHINE_IMAGE` no default on the platform side.

ARG WEBRAIN_IMAGE
FROM ${WEBRAIN_IMAGE}

# THE BASE MUST BE GLIBC, AND THIS RUN IS THE ASSERTION.
#
# Obscura's Linux release binaries are built for `x86_64-unknown-linux-gnu` on
# Ubuntu 22.04 (its `.github/workflows/release.yml`), which needs glibc >= 2.35;
# obscura's own image runs them on `distroless/cc-debian12`, which is glibc.
# On a musl base (Alpine) `webrain install obscura` *succeeds* — the tarball
# downloads and extracts — and then the binary fails at exec, because
# `/lib64/ld-linux-x86-64.so.2` does not exist. That failure surfaces the first
# time a live session needs Obscura, not at build time, which is the worst
# possible moment to learn it.
#
# So there is no `apk` path here. `apt-get` fails the build immediately on a
# musl base instead of shipping an image that breaks per session. Verified
# against the release: 20 assets, `obscura-x86_64-linux{,-stealth,-no-render,
# -no-render-stealth}.tar.gz` among them, each holding `obscura` **and
# `obscura-worker`** — the worker model is shipped, not a doc claim.
#
# This is the same one-line base change webrain's own Dockerfile needs anyway:
# it pins `rust:1.85-alpine` while its lockfile requires rustc 1.88, so it
# cannot build. Moving it to `rust:1.88-slim-bookworm` fixes the rustc pin, the
# missing glibc, and the package manager in a single edit.
#
# nginx is the only listener on the routed port: it answers the health check
# and enforces a bearer header before anything reaches webrain. ~2 MB, and
# every alternative (a Python shim, a second Rust binary) is larger or is a
# new thing to maintain. `ca-certificates` is not optional: engines fetch
# HTTPS pages and fail opaquely without a trust store.
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Bake the two engines that are not already in the image. `CHROME` arrives as
# `chromium` in webrain's own base layer, so only these are missing. Obscura's
# default package is the RENDER build, which is the one live view needs: the
# no-render build silently serves no frames, and `--no-render` must not be
# passed here.
RUN webrain install obscura && webrain install lightpanda

# Engines must EXEC here, at BUILD time -- not at the first session.
#
# This is the lesson the image chain taught the hard way: on a musl base
# `webrain install obscura` SUCCEEDED, and the binary only failed when a session
# tried to start it -- per session, in production, never in the build. Asserting
# execution here turns that entire class of failure into a red build.
#
# `find` rather than a hard-coded `obscura-v0.2.3/` path: the version directory
# changes with every install, and a stale path would silently assert nothing.
#
# `lightpanda` takes `version`, NOT `--version` -- the latter exits fatal with a
# `did_you_mean`, which is exactly the kind of detail a guess gets wrong.
RUN set -eux; \
    chromium --version; \
    obscura_bin="$(find /root/.cache/webrain/browsers -type f -name obscura | head -n 1)"; \
    lightpanda_bin="$(find /root/.cache/webrain/browsers -type f -name lightpanda | head -n 1)"; \
    test -n "$obscura_bin"; \
    test -n "$lightpanda_bin"; \
    "$obscura_bin" --version; \
    "$lightpanda_bin" version

COPY nginx.conf /etc/nginx/nginx.conf
# The executable name is not cosmetic: arachnefly sets the machine's process
# entrypoint to `app`, so this file must be reachable as `app` on PATH.
COPY entrypoint.sh /usr/local/bin/app
RUN chmod +x /usr/local/bin/app

EXPOSE 11235

# Only used by a plain `docker run` for local probing. On Fly the entrypoint is
# replaced by `processes[0].entrypoint = ["app"]`, which resolves to the same
# file.
ENTRYPOINT ["/usr/local/bin/app"]
