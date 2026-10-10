# `browser-session` — the machine image adapter

This directory builds the image that `BROWSER_MACHINE_IMAGE` points at. It is an
**adapter**, not an engine: it takes webrain's image, adds nginx on 11235, and bakes
all three browsers in at build time.

Read this before changing the tag or the registry. Both have bitten us already.

---

## The two images, and why they need different registries

```
webrain  ──(BUILD input)──▶  browser-session  ──(RUNTIME input)──▶  Fly machine
  engine                        adapter                              FLY_APP
```

| Image | Role | Must be reachable from | Push to |
|---|---|---|---|
| `webrain` | the engine, built from webrain's `docker/Dockerfile` | **the build machine only** — the adapter `COPY --from`s it | `ghcr.io/prokopis3/webrain:<tag>` (what the Dockerfile documents) |
| `browser-session` | the adapter + nginx + chromium + obscura + lightpanda | **Fly**, which is a different cloud from GCP | **`registry.fly.io/…`** — see below |

The asymmetry is the point. The engine image is consumed at *build* time, so its registry
only has to be reachable while you build. The adapter is consumed at *run* time by Fly, so
its registry has to be one Fly can pull from unattended.

## Which registry — `registry.fly.io`, not Artifact Registry

**Push the adapter to Fly's own registry:**

```
BROWSER_MACHINE_IMAGE=registry.fly.io/deepscrape-browser-session:<git-sha>
```

Two reasons, and the first one is a correction of earlier advice in this repo:

1. **Artifact Registry needs credentials on the Fly side.** Firebase Hosting, Cloud Run
   and the BFF all sit in the same GCP project, so they pull
   `us-central1-docker.pkg.dev/libnet-d76db/deepscrape/…` for free. A Fly machine is a
   different cloud: pulling a *private* AR repo requires registry credentials configured
   on the Fly app, which is extra machinery that can rot silently and only fails when a
   customer starts a session. Fly's registry is scoped to your org, so `FLY_APP` pulls
   `registry.fly.io/…` with no extra configuration.
2. **This repo already does it that way.** `src/app/core/functions/global.fun.ts:287`
   lists `registry.fly.io/crawlagent:deployment-01JMCZMGQ5ZKXW2J65KHW15EXB`, and
   `docs/ENV_CONFIG_MATRIX.md:334` refers to "the `registry.fly.io/crawlagent` lineage".
   So a `registry.fly.io` image is a shape this platform already deploys.

### The org topology, and the app to push to (**verified 2026-10-04**)

This section previously said the org question was unverified, and cited `crawlagent` as
the precedent. Both are now settled:

- **`personal` = development, `softmind` = production.** Stated by the owner 2026-10-04.
  `CheckOrCreateApp` (`arachnefly/interfaces/handlers/fireAuth.go:101`) hard-codes
  `"org_slug": "softmind"`, so arachnefly auto-creates its machine app in **production** —
  dev work must target `personal` explicitly.
- **`crawlagent` is LEGACY.** Do not push new images to it. My first attempt tagged
  `registry.fly.io/crawlagent:…` on the strength of the precedent above; that was wrong.
  The precedent says the *registry shape* is right; it does not make that app the target.
- **The dev image target is `deepscrape-browser-session`** (org `personal`), created
  2026-10-04.

**Why a dedicated app, and why the choice is low-risk:** Fly's registry is **org-scoped**,
so a push to any app in the right org is pullable by any app in that org. The choice of
*push* app is therefore independent of whatever `FLY_APP` names — only the **org** has to
match. That matters because `FLY_APP` lives in arachnefly's untracked `.env` and is
deliberately not read from here.

**Production still needs its own push** to an app in `softmind`, and its own secret value.
Dev and prod do not share an image.

## Pushing — the sequence, and the timeout that will bite you

```bash
# once per attempt: the credential is short-lived (~9 min) and there is NO
# docker-credential-flyctl helper on this machine, so it cannot auto-renew
flyctl auth docker

# the 60 s default client timeout is too short for the ~1.14 GB webrain layer
export DOCKER_CLIENT_TIMEOUT=900      # PowerShell: $env:DOCKER_CLIENT_TIMEOUT = 900

docker tag browser-session:local \
  registry.fly.io/deepscrape-browser-session:browser-session-<date-or-sha>
docker push registry.fly.io/deepscrape-browser-session:browser-session-<date-or-sha>
```

`DOCKER_CLIENT_TIMEOUT` is a **CLI** env var, not a daemon setting, so it must be set in the
same shell as the push.

**How this failure presents, because it is invisible otherwise.** The push dies with
`net/http: timeout awaiting response headers` on the largest layer. The log tail is
thousands of `layer: Waiting` lines and Docker writes the failure as
`failed commit on ref …`, so a grep for `error|failed` finds **nothing** and the run just
exits 1. Filter it out instead:

```powershell
Get-Content $log | Where-Object { $_ -notmatch "Waiting$" } | Select-Object -Last 20
```

Already-pushed layers are skipped on retry, so a second attempt only re-uploads the layer
that failed.


## The tag must be a pinned tag, never `latest`

`BROWSER_MACHINE_IMAGE` currently reads `deepscrape/webrain:latest`, which is wrong twice
over (it names the *engine* rather than the adapter, and `latest` is mutable). Replace it.

`latest` is not a style objection here. The image **is the engine cache** — a machine has
no volume, so nothing is downloaded at runtime — which means a cold start on a floating
tag can run a *different* engine than the one you probed. The whole musl/glibc episode was
a runtime that fails per session at exec, never at build. Use the git SHA:

```
.../browser-session:$(git rev-parse --short HEAD)
```

The Dockerfile already refuses a default for `WEBRAIN_IMAGE` for exactly this reason:
*"a floating tag here would silently change which engine every future session runs"*.

---

## Deploying — the whole sequence

### 1. Build and push the engine (only when webrain changes)

In the **webrain** repo:

```bash
docker build -t webrain:<sha> -f docker/Dockerfile .
docker tag webrain:<sha> ghcr.io/prokopis3/webrain:<sha>
docker push ghcr.io/prokopis3/webrain:<sha>
```

Prove the packaging before you push — this is the check that catches the musl trap:

```bash
docker run --rm --entrypoint sh webrain:<sha> -c 'ldd --version; ls -l /lib64/ld-linux-x86-64.so.2'
```

glibc must be ≥ 2.35 and `/lib64/ld-linux-x86-64.so.2` must exist. On Alpine it does not,
and the failure appears per browser session at exec, never at build.

### 2. Build and push the adapter (when webrain, nginx or the engine set changes)

```bash
docker build -t browser-session:<sha> \
  --build-arg WEBRAIN_IMAGE=ghcr.io/prokopis3/webrain:<sha> \
  deploy/browser-session

docker tag browser-session:<sha> registry.fly.io/deepscrape-browser-session:<sha>
flyctl auth docker                                   # once per machine, gets registry.fly.io creds
docker push registry.fly.io/deepscrape-browser-session:<sha>
```

The build fetches Obscura and Lightpanda, and finishing it is **not** evidence the fix is
present if the layer is cached. `install.rs` compiles into the webrain binary, so a
webrain change needs a *webrain* rebuild first:

```bash
docker run --rm --entrypoint sh browser-session:<sha> \
  -c 'grep -ac WEBRAIN_FETCH_TIMEOUT_SECS /usr/local/bin/webrain'
# 1 = present. `strings` is absent from debian:12-slim, so a `strings | grep`
# that prints nothing is the tool missing, not the fix missing.
```

### 3. Point the platform at it — **once**, not per deploy

`BROWSER_MACHINE_IMAGE` has **no default, by policy** (`functions/src/config/env.ts:213`),
so a dedicated session refuses until it is set. Put it in the gitignored deploy secret:

```
# functions/.deploy-secrets.json   (gitignored — see functions/.gitignore:22)
{
  "BROWSER_MACHINE_IMAGE": "registry.fly.io/deepscrape-browser-session:<sha>"
}
```

Then push the secret:

```bash
firebase functions:secrets:set FUNCTIONS_ENV_JSON --data-file functions/.deploy-secrets.json
```

**You do not set this on every deploy.** It is a secret version, read at runtime by the
BFF (and by the Functions deployment via `FUNCTIONS_ENV_JSON`). Rotating the image is
therefore:

1. build + push a new tag,
2. edit the one line in `.deploy-secrets.json`,
3. re-run the `secrets:set` above,
4. restart the BFF so it re-reads the environment.

No code change, no rebuild. That is the whole point of the value living in a secret rather
than in a build configuration.

---

## Local development — the tag is local, and the variable stays empty

Local builds use a plain local tag, because nothing pulls them but you:

```bash
# in the webrain repo
docker build -t webrain:local -f docker/Dockerfile .

# here
docker build -t browser-session:local \
  --build-arg WEBRAIN_IMAGE=webrain:local \
  deploy/browser-session

# run it — both guards must refuse when misconfigured
docker run --rm -p 11235:11235 -e WEBRAIN_HTTP_TOKEN=local-dev-probe-secret \
  browser-session:local
```

Then point the platform at the *local container*, not at the image:

```
# functions/.env.local
WEBRAIN_MCP_URL=http://127.0.0.1:11235
BROWSER_MACHINE_IMAGE=
```

**`BROWSER_MACHINE_IMAGE` cannot be a local tag.** Fly pulls from a registry; a
`browser-session:local` image exists only on your disk, so a real Fly machine cannot see
it. Leaving the variable empty is the correct local state: with no value, §1.4 refuses a
dedicated session, and the `WEBRAIN_MCP_URL` path serves the shared `use-single` worker.
Everything except a dedicated leased session works locally.

---

## Facts that will bite

- **A machine has no volume.** `BuildConfigMap` sets no `mounts`, and Fly resets a stopped
  machine's root filesystem. This is why the engines are baked in rather than downloaded:
  the image *is* the cache. It is also why webrain's vault cannot outlive a machine, and
  therefore why profiles are not yet a durable feature.
- **PORT 11235 is asserted, not configured.** `nginx.conf` listens on it and the entrypoint
  refuses to start on any other `PORT` (exit 64), so a future change fails loudly instead
  of leaving every session silently unreachable.
- **No token means it refuses to serve** (exit 78). That is the guard, not a bug.
- **The image asserts all three engines EXECUTE at build time.** A musl base installed
  Obscura successfully and only failed when a session started it. Never trust an install
  you did not execute.
- **Supply-chain surface, separate from this image:** arachnefly's deploy path accepts an
  image string from the *caller* (`"url"` → `DecodeImageName`; see
  `references/ground-truth.md`). The session route is safe — it sends the server's
  `BROWSER_MACHINE_IMAGE` — but the general container console lets a caller choose an
  image, and that is an arbitrary-image-pull into the platform's Fly app.
