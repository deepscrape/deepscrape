/**
 * Apply the Meilisearch index catalog to an instance.
 *
 * Idempotent: creates each index if it is missing, then PUTs its settings. Safe to re-run
 * against a fresh Fly volume or a live instance.
 *
 * Usage:
 *   bun deploy/meilisearch/setup.ts
 *   MEILI_HOST=https://deepscrape-search.fly.dev MEILI_MASTER_KEY=... bun deploy/meilisearch/setup.ts
 *
 * The catalog is deliberately small. Firestore has no subcollections in Meilisearch, so
 * `users/{uid}/crawlpack` is flattened into one `crawlpack` index whose documents carry an
 * explicit `userId`, and tenant isolation is enforced by filtering on that field (Meilisearch
 * tenant tokens are the production form of this — see docs/ADR-2026-09-SEARCH-INDEXING.md).
 *
 * Which indexes exist, and why only these two:
 *   - `crawlpack`  — users/{uid}/crawlpack, the product's core object.
 *   - `operations` — users/{uid}/operations. The operations page already has a search bar
 *                    that filters the loaded page client-side; this is what makes it real.
 * Admin-scoped indexes (`users`, `audit_logs`, `apikeys`, `guests`) are intentionally NOT
 * here yet: they contain PII, so they need the admin-only key path before they are worth
 * having. Add them when that path exists, not before.
 *
 * `filterableAttributes` must contain every field a tenant filter uses. It currently holds
 * only `userId`; `sortableAttributes` is left at its default until the sync layer fixes which
 * timestamp field it writes. Both are cheap to extend later — settings changes re-index.
 */

type IndexDefinition = {
  uid: string
  primaryKey: string
  source: string
  settings: Record<string, unknown>
}

const CATALOG: IndexDefinition[] = [
  {
    uid: 'crawlpack',
    primaryKey: 'id',
    source: 'users/{uid}/crawlpack',
    settings: {
      searchableAttributes: ['*'],
      filterableAttributes: ['userId'],
    },
  },
  {
    uid: 'operations',
    primaryKey: 'id',
    source: 'users/{uid}/operations',
    settings: {
      searchableAttributes: ['*'],
      filterableAttributes: ['userId'],
    },
  },
]

const host = (process.env['MEILI_HOST'] || 'http://127.0.0.1:7700').replace(/\/+$/, '')
const masterKey = (process.env['MEILI_MASTER_KEY'] || '').trim()

const headers: Record<string, string> = { 'Content-Type': 'application/json' }
if (masterKey) {
  headers['Authorization'] = `Bearer ${masterKey}`
}

type Task = {
  taskUid: number
  status: string
  error?: { code?: string; message?: string }
}

async function meili(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${host}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } })
}

/**
 * Wait for an indexing task to finish.
 *
 * Settings and index creation are asynchronous; without this a re-run can race the previous
 * one and report a stale state.
 *
 * @param {number} taskUid Task returned by the write call.
 * @return {Promise<void>} Resolves once the task succeeded; throws on failure.
 */
async function waitForTask(taskUid: number, tolerated: string[] = []): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await meili(`/tasks/${taskUid}`)
    if (!response.ok) {
      throw new Error(`Task ${taskUid} lookup failed: ${response.status} ${await response.text()}`)
    }

    const task = (await response.json()) as Task
    if (task.status === 'succeeded') return

    if (task.status === 'failed' || task.status === 'canceled') {
      // Meilisearch reports "this already exists" as a FAILED task rather than an HTTP error,
      // so idempotency has to be expressed here and not on the response status.
      if (task.error?.code && tolerated.includes(task.error.code)) return
      throw new Error(`Task ${taskUid} ${task.status}: ${task.error?.code || ''} ${task.error?.message || ''}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(`Task ${taskUid} did not finish in 30s`)
}

async function ensureIndex(definition: IndexDefinition): Promise<void> {
  const created = await meili('/indexes', {
    method: 'POST',
    body: JSON.stringify({ uid: definition.uid, primaryKey: definition.primaryKey }),
  })

  // Re-running is expected: Meilisearch accepts the request and then fails the *task* with
  // `index_already_exists`. Other versions answer 409 instead. Anything else is a real fault.
  if (!created.ok) {
    if (created.status !== 409) {
      throw new Error(`Creating ${definition.uid} failed: ${created.status} ${await created.text()}`)
    }
  } else {
    await waitForTask(((await created.json()) as Task).taskUid, ['index_already_exists'])
  }

  const settings = await meili(`/indexes/${definition.uid}/settings`, {
    method: 'PATCH',
    body: JSON.stringify(definition.settings),
  })

  if (!settings.ok) {
    throw new Error(`Settings for ${definition.uid} failed: ${settings.status} ${await settings.text()}`)
  }

  await waitForTask(((await settings.json()) as Task).taskUid)
  console.log(`  ${definition.uid.padEnd(12)} <- ${definition.source}`)
}

async function main(): Promise<void> {
  const version = await meili('/version')
  if (!version.ok) {
    throw new Error(`Cannot reach Meilisearch at ${host}: ${version.status} ${await version.text()}`)
  }

  const info = (await version.json()) as { pkgVersion: string }
  console.log(`Meilisearch ${info.pkgVersion} at ${host}${masterKey ? ' (authenticated)' : ' (unauthenticated)'}`)

  if (!masterKey) {
    console.log('WARNING: no MEILI_MASTER_KEY set - only acceptable for a local instance.')
  }

  for (const definition of CATALOG) {
    await ensureIndex(definition)
  }

  const stats = await meili('/stats')
  if (stats.ok) {
    const body = (await stats.json()) as { indexes?: Record<string, { numberOfDocuments: number }> }
    for (const [uid, value] of Object.entries(body.indexes || {})) {
      console.log(`  ${uid.padEnd(12)} ${value.numberOfDocuments} documents`)
    }
  }

  console.log('Catalog applied.')
}

await main()
