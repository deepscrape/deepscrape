/* eslint-disable object-curly-spacing */
/**
 * The job surface — playground, `/operations` and crawl packs — served by
 * webrain.
 *
 * Why this file exists
 * -------------------
 * `syncaiapi.ts` registers `/crawl` (one request, one result) and nothing else:
 * every job route was commented out, so the three Angular surfaces that need a
 * job — the playground runner (`app-crawl`), the operations tracker
 * (`operation-status.service`) and the domain seeder — had no server behind
 * them
 * for ANY provider. This supplies that surface for webrain.
 *
 * A synchronous provider behind a queue
 * -------------------------------------
 * webrain is MCP: one call, one answer. It has no queue and no task id, so the
 * queue is QStash's rather than the worker's. Enqueue writes `In Progress` and
 * publishes one message per target; each delivery scrapes its own target and
 * appends the result; the status is then DERIVED from what has landed, so no
 * worker has to know it was the last one.
 *
 * That is what makes `In Progress` reachable. It was not before: the whole
 * batch ran inline, so the job was terminal by the time the caller had its id
 * and `/operations` — which has handled a non-final status since it was written
 * — never saw one.
 *
 * The routes the client actually calls
 * ------------------------------------
 * These are taken from `CrawlAPIService`, not from the commented-out block:
 *
 *   enqueue  POST /crawl/stream/job
 *   status   GET  /job/stream/status/:taskId
 *   results  GET  /job/stream/:taskId
 *   cancel   PUT  /job/:taskId/cancel
 *
 * The old block registered `/crawl/stream/job/status/:taskId` and
 * `/crawl/stream/job/:taskId` — the `job` and `stream` segments transposed — so
 * even if it had been enabled the client could not have reached it. The paths
 * below are the ones on the wire.
 *
 * SSE is required, not decorative
 * ------------------------------
 * Both streaming methods on the client read progress from `partialText` on
 * `HttpEventType.DownloadProgress` and never look at the final response body. A
 * buffered reply therefore yields ZERO emissions and completes silently — a 200
 * that updates nothing. These handlers must stream, and any adapter in front of
 * them (see `bff/bridge.ts`) must forward writes instead of buffering.
 */
import { Request, Response } from "express"
import { randomUUID } from "node:crypto"
import { FieldValue } from "firebase-admin/firestore"
import { webrainTool } from "../infrastructure/webrain-mcp"
import { publishCrawlTarget } from "../infrastructure/qstash"
import { safeTargetUrls } from "../domain/url-guard.domain"
import { resolveProvider } from "../domain/scrape-providers.domain"
import { readStoredProvider } from "../infrastructure/scrape-provider.store"
import { db } from "../app/config"

/**
 * Mirrors `CrawlOperationStatus` in `src/app/core/enum/crawl.enum.ts`.
 *
 * Spelled out rather than imported: the enum lives in the Angular app, and the
 * functions package does not compile `src/`. The strings are the contract — the
 * dashboard compares them, so a typo here is a tracker that never advances.
 */
export type WebrainJobStatus =
  "In Progress" | "Completed" | "Failed" | "Canceled"

/** One target's outcome, in the shape the result view already renders. */
export interface WebrainJobItem {
  url: string
  status: "ok" | "error"
  message: string
  challenge: string | null
  data?: unknown
  tokens?: { chars?: number; est_tokens?: number }
  ms?: number
}

export interface WebrainJobRecord {
  id: string
  uid: string
  status: WebrainJobStatus
  message: string
  urls: string[]
  items: WebrainJobItem[]
  total: number
  failed: number
  createdAt: number
  updatedAt: number
}

const JOB_COLLECTION = "crawljobs"

const jobRef = (uid: string, taskId: string) =>
  db.collection("users").doc(uid).collection(JOB_COLLECTION).doc(taskId)

/**
 * The collection the `/operations` dashboard actually lists.
 *
 * Distinct from {@link JOB_COLLECTION}: the queue stores `crawljobs`, the
 * dashboard reads `operations`, and nothing on the job path ever wrote the
 * latter — which is why a job that ran perfectly was still invisible there.
 */
const OPERATIONS_COLLECTION = "operations"

const operationRef = (uid: string, taskId: string) =>
  db
    .collection("users")
    .doc(uid)
    .collection(OPERATIONS_COLLECTION)
    .doc(taskId)

/**
 * Reads `challenge` out of whatever shape the tool returned.
 *
 * Only `navigate` / `observe(what=state)` / `search` report one; `scrape` and
 * `batch` carry no such field in webrain-core/src/browser.rs, so `null` here
 * means
 * "this provider does not answer that question", not "the page was clean".
 * @param {*} data
 * @return {*}
 */
const challengeOf = (data: unknown): string | null => {
  if (!data || typeof data !== "object") {
    return null
  }
  const value = (data as Record<string, unknown>)["challenge"]
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * The message shown per target when a call fails, distinguishing a refusal from
 * an outage. A shared worker refusing a stateful tool is not "the site blocked
 * us", and saying so sends the user to the wrong remedy.
 * @param {*} result
 * @return {*}
 */
const failureMessage = (result: {
  error?: string
  noStateRefused?: boolean
  transportError?: boolean
}): string => {
  if (result.noStateRefused) {
    return "Needs a private worker (the shared pool holds no sessions)"
  }
  if (result.transportError) {
    return "The scraping worker is unreachable"
  }
  return result.error ?? "The provider returned no result"
}

const openSse = (res: Response): void => {
  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")
  // nginx and friends buffer by default, which would defeat the streaming these
  // two endpoints exist to provide.
  res.setHeader("X-Accel-Buffering", "no")
  res.flushHeaders()
}

/** One `data:` frame, parsed by the client's `slice(5|6).trim()` handling.
 * @param {*} res
 * @param {*} payload
 */
const sseSend = (res: Response, payload: unknown): void => {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const sseDone = (res: Response): void => {
  res.write("data: [DONE]\n\n")
  res.end()
}

/**
 * Resolves the provider for a job route, refusing anything but webrain.
 *
 * The job surface exists only for webrain: the crawl4ai pipeline is disabled at
 * the route table (ADR §10) and `jina` is a per-URL reader with no batch
 * concept. A 501 naming the reason is better than a 502 from a host that is not
 * deployed, which reads as an outage rather than as a decision.
 * @param {*} req
 * @param {*} res
 */
const requireWebrain = async (
  req: Request,
  res: Response
): Promise<boolean> => {
  const uid = req.user?.uid
  const stored = uid ? await readStoredProvider(uid) : undefined
  const resolution = resolveProvider(stored, req.accessMode)

  res.setHeader("x-scrape-provider", resolution.provider)
  res.setHeader("x-scrape-provider-source", resolution.source)

  if (resolution.provider === "webrain") {
    return true
  }

  res.status(501).json({
    error: "Job pipeline unavailable for this provider",
    provider: resolution.provider,
    message:
      "Jobs are served by the embedded engine only. Select it to use jobs.",
  })
  return false
}

/**
 * The job's status, derived from what has landed rather than written by the
 * workers.
 *
 * One message per target means workers finish out of order and no single write
 * knows it was last. Deriving on read removes the coordination entirely: no
 * counter, no transaction, and no race between two workers that each believe
 * they finished the job.
 * @param {*} record The stored job.
 * @return {*} The status the dashboard should show.
 */
export const deriveStatus = (
  record: Pick<WebrainJobRecord, "status" | "items" | "total">
): WebrainJobStatus => {
  if (record.status === "Canceled") {
    return "Canceled"
  }

  const landed = record.items?.length ?? 0
  if (landed < record.total) {
    return "In Progress"
  }

  const failed = record.items.filter((item) => item.status === "error").length
  return failed === record.total ? "Failed" : "Completed"
}

/**
 * Scrapes one target and records it. This is the queued unit of work.
 *
 * `arrayUnion` is the whole idempotency story: a redelivered message appends an
 * identical value, which Firestore discards, so a retry cannot double-count.
 * `failed` is deliberately NOT incremented — it is derived on read, because an
 * increment would double on precisely the redelivery this guards against.
 * @param {*} uid The owner.
 * @param {*} taskId The job.
 * @param {*} url One already-validated target.
 * @param {*} accessMode The entitlement resolved when the job was queued.
 */
export async function runCrawlTarget(
  uid: string,
  taskId: string,
  url: string,
  accessMode: string | undefined
): Promise<void> {
  const call = await webrainTool("webrain_scrape", accessMode, { url }, uid)

  // Transient by definition: the worker was unreachable. Nothing is recorded,
  // because a retry produces the real outcome — writing "the worker was down"
  // as this target's result would make the retry look like a duplicate.
  if (!call.ok && call.transportError) {
    throw new Error("crawl worker unreachable")
  }

  await jobRef(uid, taskId).set(
    {
      items: FieldValue.arrayUnion({
        url,
        status: call.ok ? "ok" : "error",
        message: call.ok ? "" : failureMessage(call),
        challenge: challengeOf(call.json),
        data: call.json,
        tokens: call.tokens,
        ms: call.ms,
      }),
      updatedAt: Date.now(),
    },
    { merge: true }
  )
}

/**
 * Records a target that will never land, so the job can settle.
 *
 * Called from QStash's failure callback once the retries are exhausted. The row
 * is an ordinary error item, which is what makes the arithmetic work: with it
 * the job reaches its total and `deriveStatus` returns Failed instead of
 * `In Progress` for ever.
 * @param {*} uid The owner.
 * @param {*} taskId The job.
 * @param {*} url The target that never landed.
 * @param {*} reason Why the delivery gave up.
 */
export async function recordCrawlFailure(
  uid: string,
  taskId: string,
  url: string,
  reason: string
): Promise<void> {
  await jobRef(uid, taskId).set(
    {
      items: FieldValue.arrayUnion({
        url,
        status: "error",
        message: reason,
        challenge: null,
      }),
      updatedAt: Date.now(),
    },
    { merge: true }
  )
}

/**
 * Writes the job, publishes one message per target, and answers.
 *
 * Shared by the playground and the seeder, which differ only in the field name
 * carrying their targets. Everything downstream — status, results, cancel — is
 * already one surface, so this is the only place the two have to agree.
 *
 * Publishes BEFORE answering: a task id handed out for messages that were never
 * queued is a job that never moves, so a publish failure marks the job Failed
 * and returns 502 rather than leaving the dashboard to wait for ever.
 * @param {*} uid The owner.
 * @param {*} urls Already-validated targets.
 * @param {*} operationId The caller's operation id, if it sent one.
 * @param {*} operationData The client's own operation row, reused as-is.
 * @param {*} accessMode The entitlement, carried through to the worker.
 * @param {*} res The response to answer on.
 */
const enqueueTargets = async (
  uid: string,
  urls: string[],
  operationId: string | undefined,
  operationData: unknown,
  accessMode: string | undefined,
  res: Response
): Promise<void> => {
  const taskId = randomUUID()

  // Written before publishing, and the id is only handed out once it exists:
  // the caller's very next `GET` must not race this write and report a job that
  // does not exist.
  await jobRef(uid, taskId).set({
    id: taskId,
    uid,
    status: "In Progress",
    message: `Queued ${urls.length} target(s)`,
    urls,
    items: [],
    total: urls.length,
    failed: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  // Also written to the collection `/operations` reads. It had writers on the
  // client and none on this path, so a queued job never appeared on that page.
  // The client already sends its own operation row, so it is reused rather
  // than rebuilt: only the fields the server owns are overridden.
  const supplied =
    operationData && typeof operationData === "object" ?
      (operationData as Record<string, unknown>) :
      {}
  const author =
    supplied["author"] && typeof supplied["author"] === "object" ?
      (supplied["author"] as Record<string, unknown>) :
      {}

  await operationRef(uid, taskId).set(
    {
      ...supplied,
      id: taskId,
      task_id: taskId,
      urls,
      // The path already binds the owner, so uid comes from the credential and
      // never from the body.
      author: { ...author, uid },
      name:
        typeof supplied["name"] === "string" ?
          supplied["name"] :
          `${urls.length} target(s)`,
      type:
        typeof supplied["type"] === "string" ? supplied["type"] : "operation",
      color:
        typeof supplied["color"] === "string" ? supplied["color"] : "#64748b",
      status: "In Progress",
      created_At: Date.now(),
    },
    { merge: true }
  )

  try {
    await Promise.all(
      urls.map((url) =>
        publishCrawlTarget({ taskId, uid, url, accessMode })
      )
    )
  } catch (error) {
    console.error("webrain-jobs: publish failed", error)
    await jobRef(uid, taskId).set(
      { status: "Failed", message: "Could not queue the job" },
      { merge: true }
    )
    res.status(502).json({
      error: "Could not queue the job",
      task_id: taskId,
    })
    return
  }

  res.status(200).json({
    task_id: taskId,
    operation_id: operationId ?? taskId,
    provider: "webrain",
    status: "In Progress",
    message: `Queued ${urls.length} target(s)`,
    total: urls.length,
    failed: 0,
  })
}

export const webrainJobs = {
  /**
   * `POST /seeder/stream/job/multi-research` — the domain seeder's enqueue.
   *
   * A separate route because the BODY differs, not the work: the seeder sends
   * `domains` as bare hostnames, the playground sends `urls`. Status, results
   * and cancel are already shared — the client rewrites `/seeder` to `/job` for
   * all three — so this exists only to accept the other field name.
   * @param {*} req
   * @param {*} res
   */
  async multiSeedEnqueue(req: Request, res: Response): Promise<void> {
    if (!(await requireWebrain(req, res))) {
      return
    }

    const uid = req.user?.uid
    if (!uid) {
      res.status(401).json({ error: "Missing user" })
      return
    }

    const body = req.body as
      | {
          domains?: unknown
          operation_data?: {
            id?: unknown
          }
        }
      | undefined

    const domains = body?.domains
    const raw = Array.isArray(domains) ? domains : []
    // Bare hostnames are not URLs, and the shared guard rejects anything it
    // cannot parse, so the scheme is added before it sees them.
    const urls = safeTargetUrls(
      raw
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => (/^https?:\/\//i.test(entry) ? entry : `https://${entry}`))
    )

    if (!urls.length) {
      res.status(400).json({ error: "Invalid target domains" })
      return
    }

    await enqueueTargets(
      uid,
      urls,
      typeof body?.operation_data?.id === "string" ?
        body.operation_data.id :
        undefined,
      body?.operation_data,
      req.accessMode,
      res
    )
  },
  /**
   * `POST /crawl/stream/job` — queue the batch and hand back a live job id.
   *
   * Publishes one message per target and returns immediately, leaving the job
   * `In Progress` rather than finished. The shared guard still caps the target
   * count, so the number of messages one request can create stays bounded.
   * @param {*} req
   * @param {*} res
   */
  async multiCrawlEnqueue(req: Request, res: Response): Promise<void> {
    if (!(await requireWebrain(req, res))) {
      return
    }

    const uid = req.user?.uid
    if (!uid) {
      res.status(401).json({ error: "Missing user" })
      return
    }

    const body = req.body as
      | {
          urls?: unknown
          operation_data?: {
            id?: unknown
          }
          operation_id?: unknown
        }
      | undefined
    const urls = safeTargetUrls(body?.urls)
    if (!urls.length) {
      res.status(400).json({ error: "Invalid target URLs" })
      return
    }

    const operationId =
      typeof body?.operation_data?.id === "string" ?
        body.operation_data.id :
        typeof body?.operation_id === "string" ?
          body.operation_id :
          undefined

    await enqueueTargets(
      uid,
      urls,
      operationId,
      body?.operation_data,
      req.accessMode,
      res
    )
  },

  /**
   * `GET /job/stream/status/:taskId` — one terminal frame.
   *
   * Emitted as SSE because that is what the client parses. The payload is the
   * shape it maps: `{status, result:{status, message}}`, with `status` drawn
   * from
   * the dashboard's own vocabulary.
   * @param {*} req
   * @param {*} res
   */
  async getTaskStatus(req: Request, res: Response): Promise<void> {
    const { taskId } = req.params
    const uid = req.user?.uid
    if (!uid) {
      res.status(401).json({ error: "Missing user" })
      return
    }
    if (!taskId) {
      res.status(400).json({ error: "Missing TaskId" })
      return
    }

    const snapshot = await jobRef(uid, taskId).get()
    openSse(res)

    if (!snapshot.exists) {
      // 404 cannot be sent through an already-opened SSE stream, so the absence
      // is
      // reported as the frame the client already knows how to read.
      sseSend(res, {
        status: "Failed",
        result: {
          status: "Failed",
          message: "Unknown task id for this account",
        },
        error: "Unknown task id",
      })
      sseDone(res)
      return
    }

    const record = snapshot.data() as WebrainJobRecord
    // Derived, not stored: the workers finish out of order and none of them
    // knows it was the last one.
    const status = deriveStatus(record)
    sseSend(res, {
      status,
      result: { status, message: record.message },
    })
    sseDone(res)
  },

  /**
   * `GET /job/stream/:taskId` — the results as batches.
   *
   * One batch per target, so a partial run renders target by target instead of
   * being withheld until the last one lands. `chunk_index` / `total_chunks` are
   * strings and drive the client's progress calculation.
   * @param {*} req
   * @param {*} res
   */
  async streamTaskResults(req: Request, res: Response): Promise<void> {
    const { taskId } = req.params
    const uid = req.user?.uid
    if (!uid) {
      res.status(401).json({ error: "Missing user" })
      return
    }
    if (!taskId) {
      res.status(400).json({ error: "Missing TaskId" })
      return
    }

    const snapshot = await jobRef(uid, taskId).get()
    openSse(res)

    if (!snapshot.exists) {
      sseSend(res, {
        status: "error",
        message: "Unknown task id for this account",
        type: "batch_chunk",
      })
      sseDone(res)
      return
    }

    const record = snapshot.data() as WebrainJobRecord
    const total = record.items.length

    record.items.forEach((item, index) => {
      const dump =
        typeof item.data === "string" ?
          item.data :
          JSON.stringify(item.data ?? null)
      sseSend(res, {
        status: item.status === "ok" ? "ok" : "error",
        message: item.message,
        url: item.url,
        dump,
        type: "batch_chunk",
        chunk_index: String(index + 1),
        total_chunks: String(total),
      })
    })

    const settled = deriveStatus(record)
    sseSend(res, {
      status:
        settled === "Canceled" ?
          "canceled" :
          settled === "Failed" ?
            "error" :
            "completed",
      message: record.message,
      type: "batch_chunk",
      chunk_index: String(total),
      total_chunks: String(total),
    })
    sseDone(res)
  },

  /**
   * `PUT /job/:taskId/cancel`.
   *
   * The job is already finished by the time this can be called — webrain has no
   * in-flight task to signal — so cancelling is a state change and nothing
   * more.
   * Reporting success for work that already completed would be a lie the
   * dashboard then displays, so the response says which of the two happened.
   * @param {*} req
   * @param {*} res
   */
  async cancelTask(req: Request, res: Response): Promise<void> {
    const { taskId } = req.params
    const uid = req.user?.uid
    if (!uid) {
      res.status(401).json({ error: "Missing user" })
      return
    }
    if (!taskId) {
      res.status(400).json({ error: "Missing TaskId" })
      return
    }

    const reference = jobRef(uid, taskId)
    const snapshot = await reference.get()
    if (!snapshot.exists) {
      res.status(404).json({ error: "Unknown task id", canceled: false })
      return
    }

    const record = snapshot.data() as WebrainJobRecord
    if (record.status === "Completed" || record.status === "Failed") {
      res.status(200).json({
        task_id: taskId,
        canceled: false,
        status: record.status,
        message:
          "The job had already finished; there was nothing in flight to stop",
      })
      return
    }

    await reference.set(
      {
        status: "Canceled",
        message: "Canceled by the user",
        updatedAt: Date.now(),
      },
      { merge: true }
    )
    res
      .status(200)
      .json({ task_id: taskId, canceled: true, status: "Canceled" })
  },
}
