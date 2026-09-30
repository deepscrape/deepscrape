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
 * A synchronous provider behind a job API
 * ---------------------------------------
 * webrain is MCP: one call, one answer. It has no queue and no task id, so
 * there
 * is nothing to poll. Rather than pretend otherwise, the work is done at
 * ENQUEUE
 * and the outcome is persisted immediately — the job is terminal by the time
 * the
 * caller has its id. `/operations` therefore shows real, finished work instead
 * of
 * a progress bar that would never move, which is what a fake queue would have
 * produced. The cost is honest and stated: enqueue is as slow as the batch, so
 * the
 * target list is capped by the shared guard rather than accepted without limit.
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
import { webrainTool } from "../infrastructure/webrain-mcp"
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
interface WebrainJobItem {
  url: string
  status: "ok" | "error"
  message: string
  challenge: string | null
  data?: unknown
  tokens?: { chars?: number; est_tokens?: number }
  ms?: number
}

interface WebrainJobRecord {
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

export const webrainJobs = {
  /**
   * `POST /crawl/stream/job` — run the batch now and hand back a finished job.
   *
   * Sequential on purpose: the shared pool caps concurrency per call, so
   * fanning
   * out is how one tenant starves the rest. The request is bounded by the
   * shared
   * guard's target cap, which is also what keeps this from becoming an
   * unbounded
   * inline job.
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

    const taskId = randomUUID()
    const operationId =
      typeof body?.operation_data?.id === "string" ?
        body.operation_data.id :
        typeof body?.operation_id === "string" ?
          body.operation_id :
          taskId

    const started = Date.now()
    const items: WebrainJobItem[] = []

    for (const url of urls) {
      const call = await webrainTool("webrain_scrape", req.accessMode, { url })
      items.push({
        url,
        status: call.ok ? "ok" : "error",
        message: call.ok ? "" : failureMessage(call),
        challenge: challengeOf(call.json),
        data: call.json,
        tokens: call.tokens,
        ms: call.ms,
      })
    }

    const failed = items.filter((item) => item.status === "error").length
    const record: WebrainJobRecord = {
      id: taskId,
      uid,
      status: failed === items.length ? "Failed" : "Completed",
      message:
        failed === 0 ?
          `${items.length} target(s) scraped` :
          `${items.length - failed} of ${items.length} target(s) scraped`,
      urls,
      items,
      total: items.length,
      failed,
      createdAt: started,
      updatedAt: Date.now(),
    }

    // Persisted before responding: the id the caller is about to receive has to
    // be
    // readable the moment it is handed out, or the very next `GET` races the
    // write
    // and reports a job that does not exist.
    await jobRef(uid, taskId).set(record)

    res.status(200).json({
      task_id: taskId,
      operation_id: operationId,
      provider: "webrain",
      status: record.status,
      message: record.message,
      total: record.total,
      failed: record.failed,
    })
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
    sseSend(res, {
      status: record.status,
      result: { status: record.status, message: record.message },
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

    sseSend(res, {
      status:
        record.status === "Canceled" ?
          "canceled" :
          record.failed === total ?
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
