import { staticPlugin } from '@elysiajs/static'
import { Elysia } from 'elysia'
import { join, resolve } from 'node:path'
import { api } from './api'
import { eventRoutes } from './event'
import { guestTrackerPlugin } from './guest-tracker'
import { limitFunction } from './limiter'
import { oauthRoutes } from './oauth'
import { security } from './security'
import { trafficCounterPlugin } from './traffic-counter'

/**
 * Bun + Elysia replacement for the `deepscrape` Express HTTPS function.
 *
 * Step A: static assets, the missing-asset guard, and the CSR shell only.
 * No Angular engine — pages are served as the client-rendered shell, which is
 * what the Express function already fell back to for `RenderMode.Server` routes.
 *
 * Firebase Hosting priority is reserved -> redirects -> exact-match static ->
 * rewrites -> 404, so in production this service only ever receives paths with
 * no static file behind them: the six private route prefixes and genuine 404s.
 */

const browserDir = resolve(
  process.env['SSR_BROWSER_DIR'] ?? 'dist/deepscrape/browser',
)
// index.csr.html is the empty client shell. Do NOT use index.html: that is the
// 370KB prerendered home page, and serving it for every unknown path would
// return the landing page for /admin, /dashboard, etc.
const shellPath = join(browserDir, process.env['SSR_SHELL'] ?? 'index.csr.html')
const notFoundPath = join(browserDir, '404.html')

/**
 * A path that never had a page behind it. Two shapes, one answer.
 *
 * Missing asset: a hashed bundle answered with HTML makes the SPA render blank
 * with no 404 and no console error, because the browser refuses to execute a
 * script served as text/html. Ported from the Express static guard, extended
 * with the probe extensions below.
 *
 * Probe: `/wp-login.php`, `/database_backup.sql`, `/server.key` and the dotfile
 * paths (`/.env`, `/.git/HEAD`, `/.ssh/id_rsa`) have no page here — but no
 * extension in the original list either, so they fell through to the shell and
 * answered 200. A 200 tells the scanner there is something to find, so it never
 * stops, and `zzcanary-<hex>` is the wildcard probe it uses to confirm that.
 *
 * ponytail: shape-matching, not a path denylist — it cannot enumerate every
 * framework probe (`/actuator/heapdump`, `/open/visitors/info/gets`) and is not
 * meant to. Add a prefix check only if a specific scanner costs real money.
 * `.well-known` is excluded because ACME challenges are extensionless and
 * security.txt / assetlinks.json live there.
 */
const MISSING =
  /(?:\.(?:js|mjs|cjs|css|map|json|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|webmanifest|txt|xml|php\d?|phtml|asp|aspx|jsp|jspx|sql|ya?ml|key|pem|crt|cer|log|ini|conf|cfg|bak|old|orig|swp|sh|zip|tar|gz|tgz|db|env)$)|(?:(?:^|\/)\.(?!well-known(?:\/|$)))/i

const app = new Elysia({ aot: true })
  /**
   * Elysia answers an unrecognized throw with the raw `error.message` — the catch
   * block sets `c.code = error.code ?? error[ERROR_CODE] ?? "UNKNOWN"` and the
   * unknown path returns `mapResponse(error.message, set)`
   * (`compose.js` -> `adapter.web-standard.unknownError`).
   *
   * That is the leak `functions/src/handlers/phone_auth.ts` deleted its
   * `getErrorMessage()` for: upstream / Firestore / Redis error text reaching the
   * caller. Log it here, answer a fixed body.
   *
   * Guarded on `error.status`, not on `code`: a thrown Firestore or Node error
   * carries its own `code` (`5`, `"auth/user-not-found"`, `"ENOENT"`), so `code`
   * is never a reliable "unknown error" marker — but Elysia derives the response
   * status from `error.status || 500`, which is exactly the line between "the
   * handler chose this 4xx and its message" and "something blew up".
   */
  .onError(({ error, request, set }) => {
    const status = (error as { status?: number }).status

    // Deliberate 4xx: the billing gate's 402, authz 401/403, parse 400,
    // validation 422, Elysia's own 404. Contract, not accident — leave them.
    if (status && status < 500) {
      return
    }

    console.error(`[bff] unhandled ${new URL(request.url).pathname}`, error)
    set.status = 500

    return { error: 'Internal Server Error' }
  })
  .use(security)
  // After security: the function issues CSRF cookies, then tracks the guest.
  .use(guestTrackerPlugin)
  // Consent-free level counting. Reads nothing `guestTracker` reads and needs no
  // ordering: it exists for the visitors the gate above is required to skip.
  .use(trafficCounterPlugin())
  .use(eventRoutes)
  .use(oauthRoutes)
  .use(api)
  // ponytail: Hosting serves exact-match static content before rewrites, so this
  // only serves direct .run.app hits. Kept so the service is runnable and
  // debuggable on its own.
  .use(
    staticPlugin({
      assets: browserDir,
      prefix: '',
      alwaysStatic: true,
      maxAge: 31536000,
    }),
  )
  .onAfterHandle(({ request, set }) => {
    if (request.url.includes('ngsw')) {
      set.headers['Service-Worker-Allowed'] = '/'
    }
  })
  .get('*', async (ctx) => {
    const { request } = ctx
    const { pathname } = new URL(request.url)

    // Parity with the Express catch-all, which mounted `upstashFunctionLimiter`
    // here. Scoped to this route on purpose: the function limited the page
    // catch-all only, not `*.*` static or the API groups (they have their own).
    const blocked = await limitFunction(ctx)
    if (blocked) {
      return blocked
    }

    if (MISSING.test(pathname)) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    const shell = Bun.file(shellPath)
    if (await shell.exists()) {
      return new Response(shell, { headers: { 'Content-Type': 'text/html' } })
    }

    return new Response(Bun.file(notFoundPath), {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    })
  })

// Only listen when run directly, so tests can import the app without binding a port.
if (import.meta.main) {
  // `?? 8080` is not enough: an ambient non-numeric PORT sets the variable, so the
  // fallback never applies and Number() yields NaN — Bun.serve then throws
  // "options.port is out of range ... Received NaN" and the server never binds.
  // Containers set PORT=8080 numerically, which is why this only bites on a dev
  // machine whose shell exports PORT for something else.
  const configured = Number(process.env['PORT'])
  const port = Number.isInteger(configured) && configured > 0 ? configured : 8080

  app.listen(
    {
      port,
      hostname: '0.0.0.0',
      // Bun.serve() closes a connection after 10s with no bytes in either
      // direction — and that includes an in-flight request whose handler has not
      // written its first byte yet, and mid-response on a stream that goes quiet.
      // The AI/crawl routes in ./api wait on upstreams that can exceed that on
      // time-to-first-byte, so the default was resetting them. 255 is Bun's max.
      // ponytail: global, not per-route. `server.timeout(req, 0)` is the precise
      // tool if one route ever needs more than 255s (a quiet SSE stream).
      idleTimeout: 255,
      // Bun's default is 128MB per request, and this instance runs on 512Mi —
      // one unauthenticated POST to a public route (/csrf-token, /event/*,
      // /services/contact) is an OOM lever. Nothing here needs that much: uploads
      // go straight to Firebase Storage from the browser
      // (firestore.service.uploadString), so the only bodies this server sees are
      // JSON prompts and event payloads. 8MB is ~20x the largest plausible prompt.
      // ponytail: raise it if a client ever posts base64 media through /api.
      maxRequestBodySize: 8 * 1024 * 1024,
    },
    () => {
      console.log(`[bff] elysia listening on 0.0.0.0:${port}`)
      console.log(`[bff] static=${browserDir} shell=${shellPath}`)
    },
  )

  // Cloud Run sends SIGTERM on every revision change and SIGKILLs shortly after.
  // Bun exits on SIGTERM by default, dropping whatever is in flight — a long AI
  // stream included. stop() closes the listener and lets those requests finish.
  process.on('SIGTERM', () => void app.stop())
}

// MISSING is exported for its spec: the regex is the whole guard, and asserting
// it directly is instant where a request through the Elysia stack is ~500ms.
export { app, MISSING }
