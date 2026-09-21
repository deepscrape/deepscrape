/**
 * Sizing harness: index N synthetic `operations` documents and report what one instance costs.
 *
 * This exists so the sizing claims in docs/ADR-2026-09-SEARCH-INDEXING.md are reproducible
 * rather than asserted. Run it against a memory-bounded container to get an answer that means
 * something for a real deployment:
 *
 *   docker run -d --name meili-bench -p 127.0.0.1:7700:7700 --memory=2g \
 *     -e MEILI_ENV=development -e MEILI_MAX_INDEXING_MEMORY=1200Mb \
 *     -v "$env:TEMP\meili-bench:/meili_data" getmeili/meilisearch:latest
 *   bun deploy/meilisearch/setup.ts
 *   bun deploy/meilisearch/bench-1m.ts
 *
 * Environment:
 *   MEILI_HOST    default http://127.0.0.1:7700
 *   BENCH_COUNT   documents to index, default 1000000
 *   BENCH_BATCH   documents per request, default 5000
 *
 * The document shape is deliberately medium-sized (~700 bytes, comparable to a crawl operation
 * with a summary): sizing driven by tiny documents flatters the result.
 */

const host = (process.env['MEILI_HOST'] || 'http://127.0.0.1:7700').replace(/\/+$/, '')
const count = Number(process.env['BENCH_COUNT'] || 1_000_000)
const batchSize = Number(process.env['BENCH_BATCH'] || 5_000)
const indexUid = 'operations'

const STATUSES = ['completed', 'running', 'failed', 'queued']
const SUMMARY =
  'Crawled the product listing pages, followed pagination to the end, retried three URLs that ' +
  'returned a transient 503 and extracted title, price and availability from each card. '

const headers: Record<string, string> = { 'Content-Type': 'application/json' }
if (process.env['MEILI_MASTER_KEY']) {
  headers['Authorization'] = `Bearer ${process.env['MEILI_MASTER_KEY']}`
}

type Task = { taskUid: number; status: string; error?: { code?: string } }

async function waitForTask(taskUid: number): Promise<void> {
  for (let attempt = 0; attempt < 3600; attempt++) {
    const response = await fetch(`${host}/tasks/${taskUid}`, { headers })
    const task = (await response.json()) as Task
    if (task.status === 'succeeded') return
    if (task.status === 'failed' || task.status === 'canceled') {
      throw new Error(`Task ${taskUid} ${task.status}: ${task.error?.code || ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Task ${taskUid} never finished`)
}

function makeDocument(i: number): Record<string, unknown> {
  return {
    id: `op-${i}`,
    userId: `user-${i % 1000}`,
    status: STATUSES[i % STATUSES.length],
    url: `https://example${i % 500}.com/catalogue/products/page/${i}`,
    note: SUMMARY,
    createdAt: 1_758_400_000_000 - i * 1000,
  }
}

async function main(): Promise<void> {
  const version = await fetch(`${host}/version`).then((r) => r.json() as Promise<{ pkgVersion: string }>)
  const batchCount = Math.ceil(count / batchSize)
  console.log(`Meilisearch ${version.pkgVersion} · indexing ${count.toLocaleString()} documents in ${batchCount} batches`)

  const started = Date.now()
  let lastTaskUid = 0
  let payloadBytes = 0

  for (let batch = 0; batch < batchCount; batch++) {
    const from = batch * batchSize
    const documents = Array.from({ length: Math.min(batchSize, count - from) }, (_, offset) =>
      makeDocument(from + offset)
    )
    const body = JSON.stringify(documents)
    payloadBytes += body.length

    const response = await fetch(`${host}/indexes/${indexUid}/documents`, {
      method: 'POST',
      headers,
      body,
    })

    if (!response.ok) {
      throw new Error(`Batch ${batch} rejected: ${response.status} ${await response.text()}`)
    }

    lastTaskUid = ((await response.json()) as Task).taskUid
    if (batch % 20 === 0 || batch === batchCount - 1) {
      const pct = Math.round(((batch + 1) / batchCount) * 100)
      console.log(`  sent ${pct}% (${((Date.now() - started) / 1000).toFixed(0)}s)`)
    }
  }

  const sentAt = Date.now()
  console.log(`All batches queued in ${((sentAt - started) / 1000).toFixed(1)}s; waiting for the indexer…`)
  await waitForTask(lastTaskUid)
  const indexedAt = Date.now()

  const stats = (await fetch(`${host}/indexes/${indexUid}/stats`, { headers }).then((r) => r.json())) as {
    numberOfDocuments: number
    rawDocumentDbSize: number
    avgDocumentSize: number
  }

  const queries = ['produt', 'product listing', 'retry', 'availability', 'catalogue pagination']
  const latencies: number[] = []
  for (let i = 0; i < 25; i++) {
    const query = queries[i % queries.length]
    const t0 = Date.now()
    const result = (await fetch(`${host}/indexes/${indexUid}/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ q: query, limit: 20, filter: 'userId = "user-7"' }),
    }).then((r) => r.json())) as { hits: unknown[] }
    latencies.push(Date.now() - t0)
    if (i === 0) {
      // Deliberately misspelled ("produt" for "product", which the generated `note` contains):
      // if this returns hits, typo tolerance is working on the full index, not just a toy one.
      console.log(`  first query "produt" -> ${result.hits.length} hits (filtered to one user)`)
    }
  }
  latencies.sort((a, b) => a - b)

  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
  console.log('')
  console.log(`documents           ${stats.numberOfDocuments.toLocaleString()}`)
  console.log(`avg document size   ${stats.avgDocumentSize} bytes`)
  console.log(`payload sent        ${mb(payloadBytes)} MB`)
  console.log(`index on disk       ${mb(stats.rawDocumentDbSize)} MB`)
  console.log(`index wall time     ${((indexedAt - sentAt) / 1000).toFixed(1)}s`)
  console.log(`throughput          ${Math.round(count / ((indexedAt - started) / 1000)).toLocaleString()} docs/sec`)
  console.log(`search latency      median ${latencies[Math.floor(latencies.length / 2)]}ms, ` +
    `p95 ${latencies[Math.floor(latencies.length * 0.95)]}ms (filtered, limit 20)`)
}

await main()
