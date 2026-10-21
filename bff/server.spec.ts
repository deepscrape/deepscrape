import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the app at a throwaway dir BEFORE importing it, so the test does not
// depend on a local `dist/` build.
const dir = mkdtempSync(join(tmpdir(), 'bff-'))
writeFileSync(
  join(dir, 'index.csr.html'),
  '<!DOCTYPE html><html><body><app-root></app-root></body></html>',
)
writeFileSync(join(dir, '404.html'), '<!DOCTYPE html><html><body>nope</body></html>')
process.env['SSR_BROWSER_DIR'] = dir

const { app, MISSING } = await import('./server')

const get = (path: string) => app.handle(new Request(`http://localhost${path}`))

describe('bff page serving', () => {
  test('an unknown page path serves the client shell with 200', async () => {
    const res = await get('/admin/settings')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<app-root')
  })

  test('a missing asset is 404 text/plain, never HTML', async () => {
    const res = await get('/nope-12345.js')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('text/plain')
    // HTML here is what makes the SPA render blank with no console error.
    expect(await res.text()).not.toContain('<app-root')
  })

  // Observed in production logs: `/.env` probes answered 404, but extensionless probes
  // like `/userfiles?path=../../.env` and every unregistered `/api/*` answered 200 + the
  // 86KB shell. A 200 tells a scanner to keep going, and tells a JSON client its typo'd
  // endpoint succeeded.
  test('an unregistered /api path is 404 JSON, never the shell', async () => {
    const res = await get('/api/fs/read?path=/app/.env')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.text()).not.toContain('<app-root')
  })

  // The live scanner burst: every one of these answered 200 + the shell before
  // the guard covered probe shapes, which is why the scan never stopped.
  test('probe shapes match the guard, real routes do not', () => {
    const probes = [
      '/wp-login.php',
      '/wp-filemanager1.php',
      '/hello-elementor-c.php',
      '/.well-known/1wvekeybd9it2di2vyipgr6Cdefault.php',
      '/database_backup.sql',
      '/user_secrets.yml',
      '/docker-compose.yml',
      '/server.key',
      '/backup.tar.gz',
      '/secrets.json',
      '/license.txt',
      '/.env',
      '/.git/HEAD',
      '/.ssh/id_rsa',
      '/.npmrc',
      '/.svn/wc.db',
    ]
    const pages = [
      '/',
      '/admin/settings',
      '/dashboard/reports',
      '/user/foo.bar',
      '/.well-known/acme-challenge/tok',
    ]

    // [path, matched] pairs, so a failure names the offending path.
    expect(probes.map((p) => [p, MISSING.test(p)])).toEqual(
      probes.map((p) => [p, true]),
    )
    expect(pages.map((p) => [p, MISSING.test(p)])).toEqual(
      pages.map((p) => [p, false]),
    )
  })

  test('a probe is 404 text/plain over HTTP, never the shell', async () => {
    const res = await get('/.env')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).not.toContain('<app-root')
  })
})

/**
 * The COMPOSED app, not a bare `new Elysia().use(api)` mount.
 *
 * Every `/api` spec mounted the router alone, so the global `onBeforeHandle`
 * never ran — which is why a CSRF hook that 403'd every QStash delivery, and a
 * cookie parse that 500'd on a stray `%`, both passed the suite.
 */
describe('bff composed app guards', () => {
  const post = (path: string, headers: Record<string, string> = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers,
        body: '{}',
      }),
    )

  test('a QStash delivery reaches its handler instead of being CSRF-403d', async () => {
    // QStash has no cookie jar, so there is no `csrf-token` header to echo. While
    // `/api/jobs/` was not exempt, every queued crawl burned its retries against a
    // 403 and the job sat `In Progress` for ever with the credits already taken.
    const res = await post('/api/jobs/crawl/worker')

    expect(res.status).toBe(401)
  })

  test('a malformed cookie is a 4xx, never a 500 on demand', async () => {
    // `decodeURIComponent('')` throws `URIError` on a stray `%`, and the parse
    // runs inside the global hook: one anonymous request used to break it.
    const res = await post('/api/orgs', { cookie: 'x=%' })

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})
