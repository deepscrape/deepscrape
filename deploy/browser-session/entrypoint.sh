#!/bin/sh
# The process a browser-session machine runs.
#
# Named `app` because arachnefly's `BuildConfigMap` sets the machine's process
# entrypoint to exactly that string, and Fly runs it as "the process that will
# run". A webrain image has no such executable, so this image ships one. The
# name is part of the contract, not a style choice.
#
# It supervises three children:
#   obscura  — the browser the engine drives, on loopback only. Started FIRST,
#              so `CDP_URL` is exported before webrain reads it.
#   webrain  — the engine, on loopback only
#   nginx    — the only listener on the routed port, answering the health check
#              Fly is told to call and gating the proxy behind a bearer header
#
# POSIX sh only: the base is Debian bookworm, whose /bin/sh is dash, not bash.
# `wait -n` is not available there, hence the poll loop at the bottom. The rule
# outlives the base — it has to stay glibc (see the Dockerfile), and glibc bases
# are not all bash either.
set -eu

# `BuildConfigMap` derives `internal_port` from this variable and defaults it
# to 11235 when unset — and `BrowserMachineRequest` sends no env at all, so the
# unset path is the normal one. nginx is compiled to listen on 11235.
#
# Asserted rather than templated: if the default ever moves, this fails loudly
# at boot instead of leaving every session silently unreachable on a port
# nothing is listening on. A silent mismatch here is a machine that appears
# healthy and answers nothing.
PORT="${PORT:-11235}"
if [ "$PORT" != "11235" ]; then
  echo "browser-session: PORT=$PORT, but this image only listens on 11235." >&2
  echo "  arachnefly sets internal_port from PORT and defaults to 11235, so the" >&2
  echo "  two agree only at 11235. Change nginx.conf and this check together." >&2
  exit 64
fi

# Refuse to serve without authentication. The machine's services are published
# on the public ports 80/443 plus this one, and Fly load-balances across
# identically-configured machines — so an unauthenticated session machine is
# reachable by, and can be mistaken for, another tenant's. Exclusivity is the
# safety boundary (invariant I2) and it only holds while this is enforced.
#
# The value arrives as a Fly APP SECRET, not as machine env: machine env is
# echoed by `GET /v1/apps/{app}/machines/{id}`, and app secrets are injected
# into every machine in the app without appearing there.
if [ -z "${WEBRAIN_HTTP_TOKEN:-}" ]; then
  echo "browser-session: WEBRAIN_HTTP_TOKEN is not set — refusing to start." >&2
  echo "  A session machine is publicly addressable and must authenticate." >&2
  echo "  Set it as a Fly app secret on the orchestrator's app, e.g." >&2
  echo "    fly secrets set WEBRAIN_HTTP_TOKEN=<value> -a <fly-app>" >&2
  exit 78
fi

# Loopback on purpose. webrain's own fail-closed check allows a loopback bind
# without a token, and binding it here means the engine is not reachable even
# over 6PN — nginx is the only way in. The token is still set, so webrain
# enforces it; that is the check nginx cannot make.
WEBRAIN_HTTP_ADDR="127.0.0.1:9223"
export WEBRAIN_HTTP_ADDR

# -- The browser --------------------------------------------------------------
#
# Started here because NOTHING ELSE DOES, and its absence is silent. webrain's
# CDP backend attaches lazily through `CDP_URL`; with no browser listening, every
# browser-backed tool answers `-32000 Cannot connect to browser: CDP endpoint not
# reachable`, so the session looks healthy and can screenshot nothing. Live view
# needs this, and so does every navigate / observe / interact call.
#
# Obscura rather than chromium, on measured grounds rather than preference: it
# RENDERS. v0.2.3 painted two different pages to two different PNGs -- 65,994 and
# 109,107 bytes, different SHA256s -- so it is not a placeholder the way
# Lightpanda's fixed 10,704-byte image is. It is also far lighter than a full
# Chrome and serves parallel tabs, which is what the batch tools want. chromium
# is still baked into the image for a session that needs SPA rendering or a
# challenge solver; starting both would double the footprint for one session.
#
# Loopback, matching `launch_obscura` in webrain-core/src/launch.rs exactly
# (`serve --host 127.0.0.1 --port N --stealth`). That bind is deliberate there and
# here: the CDP endpoint is unauthenticated, so binding it anywhere reachable
# would hand any peer full control of a tenant's browser, and nginx on the routed
# port stays the only way in from outside. The token is still set, so webrain
# enforces it; that is the check nginx cannot make. These three args are the one
# place the platform duplicates webrain's launcher, and only because going
# through the `webrain obscura` CLI verb would put a keep-alive process layer
# between this supervisor and the browser it has to restart as a unit.
obscura_bin="$(find /root/.cache/webrain/browsers -type f -name obscura | head -n 1)"
if [ -z "$obscura_bin" ]; then
  echo "browser-session: no obscura binary finds under /root/.cache/webrain/browsers." >&2
  echo "  The image installs it at build time and asserts it EXECUTES there, so" >&2
  echo "  this means the image is wrong. Refusing to start: a machine with no" >&2
  echo "  browser answers -32000 for every tool that needs one, which reads as a" >&2
  echo "  broken session rather than a broken image." >&2
  exit 69
fi

"$obscura_bin" serve --host 127.0.0.1 --port 9224 --stealth &
obscura_pid=$!

# Exported BEFORE webrain starts, because webrain reads it when it attaches.
# Same URL `launch_obscura` hands back.
CDP_URL="ws://127.0.0.1:9224/devtools/browser"
export CDP_URL

echo "browser-session: starting obscura at ${CDP_URL}, webrain on ${WEBRAIN_HTTP_ADDR}, nginx on ${PORT}" >&2
webrain mcp --http 9223 &
webrain_pid=$!

nginx -g 'daemon off;' &
nginx_pid=$!

# Propagate a shutdown to every child. Fly sends SIGTERM on scale-in and on
# rolling deploys, and webrain drains in-flight requests when it receives one.
shutdown() {
  kill -TERM "$obscura_pid" "$webrain_pid" "$nginx_pid" 2>/dev/null || true
}
trap shutdown TERM INT

# Let the browser bind before anything can ask it for a page. A fixed sleep
# rather than a readiness probe because this image ships no curl or wget and
# dash has no /dev/tcp; obscura binds in well under a second, and the cost of
# being wrong is one call that retries, never a wrong answer. The liveness check
# after it is the part that matters: a browser that died at boot must stop the
# machine rather than leave it serving -32000.
sleep 2

if ! kill -0 "$obscura_pid" 2>/dev/null; then
  echo "browser-session: obscura exited during boot — stopping the machine so it restarts" >&2
  shutdown
  exit 1
fi

# Exit as soon as ANY child does, so Fly's `restart.policy: always` restarts the
# machine as a unit. Serving with the engine gone, with no browser, or with no
# listener on the routed port is worse than a restart: it looks like a live
# session that answers nothing. Fly's `processes` contract says the machine stops
# when a process exits, so this aligns with the platform rather than fighting it.
while kill -0 "$obscura_pid" 2>/dev/null && kill -0 "$webrain_pid" 2>/dev/null && kill -0 "$nginx_pid" 2>/dev/null; do
  sleep 2
done


echo "browser-session: a child process exited — stopping the machine so it restarts" >&2
shutdown
exit 1
