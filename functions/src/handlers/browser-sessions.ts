/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The browser-session surface — `/browser/session*`.
 *
 * Why this carries `resolveAccess` rather than `requirePaidAccess`
 * ---------------------------------------------------------------
 * `paid` would 402 a free caller before the domain saw the request, and the
 * point of the tier table is that the DOMAIN answers. Free is not "not entitled
 * to ask" here: free has a real, specific answer (`SESSION_CAPS.free` is zero
 * across the board), and a caller who gets `402 Payment Required` for asking
 * about a browser learns nothing about which limit they hit. So the route
 * admits, and `decideLease` refuses with a named reason.
 *
 * What that does NOT change: `paid` was never the quota. It is a billing gate,
 * and the quota lives in `SESSION_CAPS`. Removing it cannot widen anything —
 * the caps still return zero for free — it only changes which layer says no.
 *
 * Scope, the part that would be a breach if it were wrong
 * ------------------------------------------------------
 * The uid comes from the VERIFIED token (`req.user.uid`) and is passed to the
 * store, which reads only `users/{uid}/browserSessions`. The session id in the
 * path is therefore an ADDRESS, never a credential: a foreign id answers 404,
 * exactly like one that does not exist, matching `/monitor/*` and `/storage/*`.
 * Nothing here reads a uid from the body.
 *
 * A dedicated session IS charged, and that charge is composed here
 * --------------------------------------------------------------
 * `access` bills nothing, by design, so opening a session used to cost nothing
 * even when it attached a Fly machine. Attaching one is priced at the same
 * `machines.deploy` action and amount `/api/machines/deploy` uses, read from
 * `resolveBillingPricingPolicy` rather than restated here, so the two paths
 * cannot drift to different prices for the same machine. A `byo` session
 * provisions nothing and is never charged — the caller brought the compute.
 *
 * Reserve before the deploy, consume after it: the same shape
 * `requirePaidAccess` uses. A failure in between releases the reservation, so a
 * deploy that produced no machine cannot leave credits held, and the session
 * record is closed so it stops counting against the caller's quota.
 *
 * Not here: per-minute browser time. That needs a rate and a clock this route
 * does not own, and it belongs beside the reaper that measures the minutes
 * (§1.6). `computeSource` will decide whether it is billable at all.
 *
 * The request parsing and refusal mapping live in the domain, not here: this
 * module imports the store, which builds the Admin SDK on load, so anything
 * defined here cannot be imported by a test without an emulator.
 */
import {randomUUID} from "node:crypto"
import { Request, Response } from "express"

import { uidOf } from "./request-helpers"
import {
  consumeBillingCredits,
  releaseBillingCredits,
  reserveBillingCredits,
} from "../app/billing-credits"
import { env } from "../config"
import { arachneflyBaseUrl } from "../config/upstreams"
import {
  decideLease,
  frameTooSoon,
  machineChargeFor,
  parseCreateRequest,
  refusalFor,
  type BrowserRefusal,
  type BrowserTier,
} from "../domain/browser-session.domain"
import { resolveBillingPricingPolicy } from "../domain/billing-pricing.domain"
import {
  SESSION_TOOLS,
  isSessionTool,
  webrainTierFor,
} from "../domain/webrain-tools.domain"
import { withPlatformProxy } from "../domain/webrain-proxy.domain"
import { decideCallerSpend } from "../infrastructure/billing-spend.store"
import {
  chargeSessionMeter,
  meterWalletFor,
} from "../infrastructure/browser-meter-charge"
import {
  callMachineTool,
  deployBrowserMachine,
  observeMachineFrame,
  suspendBrowserMachine,
} from "../infrastructure/browser-session.provisioner"
import {
  attachMachine,
  closeBrowserSession,
  createBrowserSession,
  keepaliveBrowserSession,
  listBrowserSessions,
  readBrowserSessionRecord,
} from "../infrastructure/browser-session.store"

/**
 * The parsed request body, or an empty object.
 *
 * A request without a JSON body leaves `req.body` undefined, and every check
 * below already treats a missing field as missing, so normalising here keeps
 * the routes from each carrying their own guard.
 * @param {Request} req The request.
 * @return {unknown} The body, as supplied.
 */
const bodyOf = (req: Request): unknown => req.body

/**
 * The session id from the path, or an empty string.
 * @param {Request} req The request.
 * @return {string} The id segment.
 */
const sessionIdOf = (req: Request): string => {
  const params = req.params as Record<string, unknown> | undefined
  const id = params?.id
  return typeof id === "string" ? id : ""
}

/**
 * The single internal-error answer, so these routes cannot disagree.
 * @param {Response} res The response.
 * @param {string} what What failed, for the log.
 * @param {unknown} error The thrown value.
 */
const internal = (res: Response, what: string, error: unknown): void => {
  console.error(`browser-session: ${what} failed:`, error)
  res.status(500).json({error: "internal", code: "internal"})
}

/**
 * The 401 every route answers when the token carried no uid.
 * @param {Response} res The response.
 */
const unauthorized = (res: Response): void => {
  res.status(401).json({error: "unauthorized", code: "unauthorized"})
}

/**
 * The 404 for an id that is not this caller's, or does not exist.
 *
 * One body for both cases on purpose: a distinct answer for "exists but not
 * yours" would let this surface be used to enumerate other accounts' sessions.
 * @param {Response} res The response.
 */
const notFound = (res: Response): void => {
  res.status(404).json({error: "No such session", code: "not_found"})
}

/**
 * Answer a refusal with the status, code and sentence the domain chose.
 *
 * The three are read from one value so a status cannot be taken from one row
 * and a code from another.
 * @param {Response} res The response.
 * @param {BrowserRefusal} refusal The refusal to answer with.
 */
const respond = (res: Response, refusal: BrowserRefusal): void => {
  res.status(refusal.status).json({error: refusal.error, code: refusal.code})
}

/**
 * `POST /api/browser/session` — open one, and for `dedicated`, provision it.
 *
 * The domain decides, and it decides BEFORE anything is provisioned or charged:
 * the session document is written only once `decideLease` has allowed it, so a
 * refusal costs nothing but the read that produced the session count.
 *
 * After that the order is reserve, deploy, attach, consume. A failure at either
 * provisioning step closes the session and releases the reservation, so a caller
 * is never left holding credits for a machine that does not exist. The state
 * reaches `ready` only once the machine id is stored — so anything the caller
 * sees as ready is something the reaper can find.
 * @param {Request} req The request.
 * @param {Response} res The response.
 */
export const browserSessionCreate = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    unauthorized(res)
    return
  }

  try {
    const parsed = parseCreateRequest(bodyOf(req))
    if (!parsed.ok) {
      respond(res, parsed.refusal)
      return
    }

    const mode = parsed.request.mode
    const kind = parsed.request.kind
    const cdpUrl = parsed.request.cdpUrl

    // Read once. Resolving it twice would let the lease decision and the stored
    // record disagree about the tier if the two call sites ever drifted.
    const tier = webrainTierFor(req.accessMode)
    const live = await listBrowserSessions(uid)

    // A PRE-FLIGHT, not the enforcement. The cap that actually holds is enforced
    // inside `createBrowserSession`, which re-reads the count and writes the
    // session in a single transaction. This check on its own was a read followed
    // by a write with nothing between them, so two concurrent requests both saw
    // the same count, both passed, and both wrote — and a tier capped at one
    // dedicated session could hold several, each with its own Fly machine.
    //
    // It is kept for two reasons: it reports refusals in the order they have
    // always been reported in, and it avoids storing a BYO credential for a
    // request that is refused outright.
    //
    // The count cannot be handed down instead — a count read here was read before
    // the transaction, which is the race itself.
    const decision = decideLease({
      tier: tier,
      mode: mode,
      kind: kind,
      // `listBrowserSessions` already omits `closed`, which is exactly the set
      // `decideLease` counts as live — so the count needs no fixing up here.
      liveSessions: live.length,
      // The endpoint is configured BY this request when `mode` is `byo` and the
      // body carries one, so a first-time BYO caller is not refused for the
      // thing they are in the middle of supplying. `parseCreateRequest` has
      // already folded a blank string down to absent.
      byoConfigured: mode === "byo" && cdpUrl !== undefined,
    })

    if (!decision.ok) {
      respond(res, refusalFor(decision.reason))
      return
    }

    // The CUSTOMER's own cap, checked before anything is created. Ordering is
    // the whole feature -- a cap applied after the charge is a report, not a
    // limit -- and it has to sit HERE rather than beside the reservation below,
    // because a refusal after `createBrowserSession` would leave a session
    // record with no machine, which the reaper would then have to chase.
    //
    // A BYO session is skipped: it spends nothing, so it has no spend to cap.
    //
    // Only the deploy price is checked here. Per-minute browser time is billed
    // later by the meter, which STOPS a session that crosses the cap rather than
    // refusing its charge -- refusing there would leave a running machine
    // unpaid, which is strictly worse than the overspend it would prevent.
    //
    // Read once and reused below, so the cap and the charge cannot come to price
    // different actions.
    const deploy = mode === "dedicated" ? machineChargeFor(
      req.accessMode,
      resolveBillingPricingPolicy("POST", "/machines/deploy")
    ) : undefined

    if (mode === "dedicated") {
      const spend = await decideCallerSpend(uid, deploy?.amount ?? 0, Date.now())
      if (!spend.allowed) {
        res.status(402).json({
          status: "error",
          code: "budget",
          reason: spend.reason,
        })
        return
      }
    }

    // The store re-runs the decision against a count it reads itself, and re-vets
    // the URL rather than trusting the decision above: the check has to sit at
    // the credential boundary, where a future caller cannot skip it by forgetting
    // to ask first. A refusal from here is a `decideLease` reason like any other,
    // so it maps through the same `refusalFor` and the caller cannot tell which
    // of the two checks answered.
    const created = await createBrowserSession({
      uid: uid,
      tier: tier,
      mode: mode,
      kind: kind,
      cdpUrl: cdpUrl,
      now: Date.now(),
    })

    if (!created.ok) {
      respond(res, refusalFor(created.reason))
      return
    }

    const session = created.session

    // A BYO session already has an endpoint. Nothing is provisioned, so nothing
    // is charged: the caller brought the compute and this route only records the
    // lease. This is the one path that answers 201 without a charge.
    if (mode !== "dedicated") {
      res.status(201).json({status: "ok", session: session})
      return
    }

    // Read, never restated. `machines.deploy` is the action the manual deploy
    // route is priced under, and the amount is whatever that row says — a second
    // number here is how the two paths come to charge different prices for the
    // same Fly machine.
    const charge = machineChargeFor(
      req.accessMode,
      resolveBillingPricingPolicy("POST", "/machines/deploy")
    )
    const idempotencyBase = `${uid}:browser:machine:${randomUUID()}`

    if (charge) {
      await reserveBillingCredits({
        uid: uid,
        amount: charge.amount,
        bucket: charge.bucket,
        ledger: {
          source: "browser-session",
          reason: `reserve:${charge.action}`,
          sessionId: session.id,
          metadata: {
            action: charge.action,
            method: "POST",
            path: "/browser/session",
          },
          idempotencyKey: `${idempotencyBase}:reserve`,
        },
      })
    }

    // The caller's OWN token, relayed verbatim. Arachnefly re-verifies it and
    // stamps the machine with the uid it verified, so the platform can never
    // deploy under an identity the caller does not hold.
    const token = req.authToken
    const deployed = token ?
      await deployBrowserMachine({
        baseUrl: arachneflyBaseUrl(),
        token: token,
        sessionId: session.id,
        image: env.BROWSER_MACHINE_IMAGE,
        region: env.BROWSER_MACHINE_REGION,
      }) :
      {ok: false as const, error: "the request carried no token to relay"}

    if (!deployed.ok) {
      // A 429 from arachnefly means FLY refused the Create Machine. The Machines
      // API allows one create per second per APP with a burst of three, and every
      // tenant shares the app — so this is capacity, not a malformed request, and
      // the two are worth separating: 503 says "come back", where 502 says
      // "something is wrong here". Until arachnefly propagated the status this was
      // indistinguishable, and every capacity refusal read as a broken image.
      //
      // Either way the session is closed and the reservation released: nothing was
      // delivered, so nothing is owed, and a retry wants a fresh session anyway.
      const capacity = deployed.status === 429
      const failureStatus = capacity ? 503 : 502

      // No machine exists, so nothing needs reaping — but the record does.
      // `listBrowserSessions` counts everything that is not `closed`, so leaving it
      // would spend the caller's live-session quota on a session that never got a
      // machine, until they closed it by hand.
      await closeBrowserSession(uid, session.id, Date.now())
      if (charge) {
        await releaseBillingCredits({
          uid: uid,
          amount: charge.amount,
          bucket: charge.bucket,
          ledger: {
            source: "browser-session",
            reason: `release:${charge.action}`,
            sessionId: session.id,
            metadata: {
              action: charge.action,
              method: "POST",
              path: "/browser/session",
              statusCode: failureStatus,
            },
            idempotencyKey: `${idempotencyBase}:release`,
          },
        })
      }
      console.error(
        `browser-session: deploy failed for ${session.id} ` +
        `(status ${deployed.status ?? "none"}): ${deployed.error}`
      )
      res.status(failureStatus).json({
        error: capacity ?
          "No machine capacity right now; try again shortly" :
          "The machine could not be deployed",
        code: capacity ? "capacity_unavailable" : "deploy_failed",
      })
      return
    }

    const attached = await attachMachine(
      uid,
      session.id,
      deployed.machineId,
      Date.now()
    )

    if (!attached) {
      // The machine is real and now untracked, so it can be neither billed nor
      // reaped — the reaper reaches machines only through sessions. Name it in
      // the log rather than pretend this succeeded; the machine's name is
      // derived from the session id, so it is findable by hand.
      if (charge) {
        await releaseBillingCredits({
          uid: uid,
          amount: charge.amount,
          bucket: charge.bucket,
          ledger: {
            source: "browser-session",
            reason: `release:${charge.action}`,
            sessionId: session.id,
            metadata: {
              action: charge.action,
              method: "POST",
              path: "/browser/session",
              statusCode: 500,
              machineId: deployed.machineId,
            },
            idempotencyKey: `${idempotencyBase}:release`,
          },
        })
      }
      console.error(
        `browser-session: machine ${deployed.machineId} deployed for ` +
        `${session.id} but the session could not record it`
      )
      res.status(500).json({error: "internal", code: "internal"})
      return
    }

    if (charge) {
      await consumeBillingCredits({
        uid: uid,
        amount: charge.amount,
        bucket: charge.bucket,
        releaseReserved: true,
        ledger: {
          source: "browser-session",
          reason: `consume:${charge.action}`,
          sessionId: session.id,
          metadata: {
            action: charge.action,
            method: "POST",
            path: "/browser/session",
            statusCode: 201,
          },
          idempotencyKey: `${idempotencyBase}:consume`,
        },
      })
    }

    res.status(201).json({status: "ok", session: attached})
  } catch (error) {
    internal(res, "create", error)
  }
}

/**
 * `GET /api/browser/session` — the sessions this caller still holds.
 * @param {Request} req The request.
 * @param {Response} res The response.
 */
export const browserSessionList = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    unauthorized(res)
    return
  }

  try {
    const sessions = await listBrowserSessions(uid)
    res.status(200).json({status: "ok", sessions: sessions})
  } catch (error) {
    internal(res, "list", error)
  }
}

/**
 * `POST /api/browser/session/:id/keepalive` — record activity, push the deadline.
 *
 * A closed session is not revived: the store answers undefined for one, so this
 * answers 404 rather than silently reopening a record the caller already ended.
 * @param {Request} req The request.
 * @param {Response} res The response.
 */
export const browserSessionKeepalive = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    unauthorized(res)
    return
  }

  try {
    const id = sessionIdOf(req)
    if (!id) {
      notFound(res)
      return
    }

    const session = await keepaliveBrowserSession(uid, id, Date.now())
    if (!session) {
      notFound(res)
      return
    }

    res.status(200).json({status: "ok", session: session})
  } catch (error) {
    internal(res, "keepalive", error)
  }
}

/**
 * `POST /api/browser/session/:id/close` — end one, and release its machine.
 *
 * For a `dedicated` session the machine is suspended BEFORE the record is marked
 * closed, and that ordering is the whole point. The reaper releases the machines
 * it can see, and it skips `closed` sessions by design (`ReapReasonClosed`) — so
 * a session marked closed while its machine is still running is a VM nothing will
 * ever look at again, billing compute until somebody notices by hand. Closing
 * without releasing was exactly that bug.
 *
 * So when the release fails the session is deliberately LEFT OPEN and this
 * answers 502. That reads like the worse outcome and it is the safer one: the
 * session keeps its idle deadline, stays visible to the reaper, and gets
 * suspended at the deadline instead. A retry closes it for real. Marking it
 * closed on a failed release would trade a retryable error for a permanent leak.
 *
 * A BYO session has no machine of ours, so nothing is released and the close is
 * the same store call it always was. An already-closed session skips the release
 * and falls through to the idempotent store close, so a client retrying after a
 * dropped response gets the same body it missed. The BYO credential is NOT purged
 * — it is the caller's per-user endpoint and other sessions may still use it.
 * @param {Request} req The request.
 * @param {Response} res The response.
 */
export const browserSessionClose = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    unauthorized(res)
    return
  }

  try {
    const id = sessionIdOf(req)
    if (!id) {
      notFound(res)
      return
    }

    // Read as STORED, not as public: `machineId` is absent from
    // `BrowserSessionPublic`, so the projected read could not tell us there was
    // a machine to release in the first place.
    const record = await readBrowserSessionRecord(uid, id)
    if (!record) {
      notFound(res)
      return
    }

    const releasable =
      record.state !== "closed" &&
      record.mode === "dedicated" &&
      Boolean(record.machineId)

    if (releasable && record.machineId) {
      // The caller's OWN token: arachnefly's ownership middleware checks the
      // machine against the uid it verified, so this cannot release another
      // tenant's machine even if a machine id leaked.
      const token = req.authToken
      const released = token ?
        await suspendBrowserMachine({
          baseUrl: arachneflyBaseUrl(),
          token: token,
          machineId: record.machineId,
        }) :
        {ok: false as const, error: "the request carried no token to relay"}

      if (!released.ok) {
        // The session is deliberately LEFT OPEN on every failure, a 429 included:
        // it keeps its idle deadline, so the reaper suspends the machine at the
        // deadline instead. Closing it here would remove it from the reaper's view —
        // it skips `closed` by design — and write the machine off for good.
        //
        // A 429 is the ordinary case under load rather than an exceptional one, so
        // it answers 503 where a real failure answers 502.
        const capacity = released.status === 429
        console.error(
          `browser-session: close of ${id} could not release ` +
          `${record.machineId} (status ${released.status ?? "none"}): ` +
          `${released.error}`
        )
        res.status(capacity ? 503 : 502).json({
          error: capacity ?
            "No machine capacity right now; try again shortly" :
            "The machine could not be released",
          code: capacity ? "capacity_unavailable" : "release_failed",
        })
        return
      }
    }

    // Charge for the final block BEFORE the record is marked closed.
    //
    // The ordering is the whole point. The meter sweep's query excludes
    // `closed`, so a session that ends between two sweeps would never be billed
    // for its last block -- and because it is gone from the sweep's view the loss
    // would be permanent rather than merely late. That is the gap this closes.
    //
    // It runs AFTER the release above, so the machine is already suspended and
    // nothing further is accruing while we bill. And it runs BEFORE the close, so
    // a failed charge leaves the session OPEN and still visible to the sweep,
    // which retries every five minutes until it lands. The same philosophy as the
    // failed release above: a retryable error beats a permanent loss.
    //
    // Safe to repeat, which matters because a client may retry this route and the
    // sweep may have already billed the same blocks. Every block is charged under
    // a deterministic ledger key (`bs-meter:<id>:block:<n>`) and the ledger
    // treats a re-used key as already applied, so repeating this charges nothing.
    const now = Date.now()
    const wallet = await meterWalletFor(uid, now)
    if (wallet) {
      try {
        await chargeSessionMeter(uid, record, wallet, now)
      } catch (error) {
        console.error(
          `browser-session: close of ${id} could not charge its final ` +
          `block: ${String(error)}`
        )
        res.status(502).json({
          error: "The session could not be billed; try closing it again",
          code: "meter_failed",
        })
        return
      }
    }

    const session = await closeBrowserSession(uid, id, now)
    if (!session) {
      notFound(res)
      return
    }

    res.status(200).json({status: "ok", session: session})
  } catch (error) {
    internal(res, "close", error)
  }
}

/**
 * When each session last served a frame, so the tier's pace can be enforced.
 *
 * ponytail: per-INSTANCE and in memory, so N warm instances permit up to N times
 * the tier's fps. That is a real ceiling on a billing control -- `SESSION_CAPS.fps`
 * exists to bound how many screenshots one session costs -- and it is accepted
 * because the alternatives are a Redis round trip or a Firestore write on every
 * poll, against a route whose entire job is to serve an image cheaply. Move it to
 * the credit lease if the cap must ever be exact.
 *
 * Bounded, because a Map keyed by session id is otherwise a leak, and the OLDEST
 * entry is evicted rather than the map cleared: clearing forgets every pace at
 * once, which is the bug the heartbeat throttle in `home_handler.ts` had.
 */
const lastFrameAtMs = new Map<string, number>()
const LAST_FRAME_MAP_MAX_ENTRIES = 2000

/**
 * Whether this caller may have a frame now, recording it when they may.
 *
 * The DECISION is `frameTooSoon` in the domain, unmodified, so the fps table
 * stays the single source of truth and the free tier's refusal of even a first
 * frame is not restated here. This supplies only the one input that predicate
 * cannot compute: how long it has been since the last frame this session served.
 * @param {string} key The uid and session id, so two callers cannot share a pace.
 * @param {BrowserTier} tier The caller's tier.
 * @param {number} nowMs The current time.
 * @return {boolean} True when the frame must be refused as too soon.
 */
const frameRefused = (
  key: string,
  tier: BrowserTier,
  nowMs: number,
): boolean => {
  const last = lastFrameAtMs.get(key)
  const sinceLast = last === undefined ? null : nowMs - last

  if (frameTooSoon(tier, sinceLast)) {
    return true
  }

  // Stamped only when a frame will actually be attempted. Stamping a refused
  // request would push the next allowed frame further out and compound it.
  if (lastFrameAtMs.size >= LAST_FRAME_MAP_MAX_ENTRIES) {
    const oldest = lastFrameAtMs.keys().next().value
    if (oldest !== undefined) {
      lastFrameAtMs.delete(oldest)
    }
  }

  lastFrameAtMs.set(key, nowMs)
  return false
}

/**
 * `GET /api/browser/session/:id/frame` -- one screenshot of a session's machine.
 *
 * The one route on this surface that does not answer JSON, and that is the point:
 * `webrain_observe(what="screenshot")` returns a PNG, so wrapping it in the usual
 * envelope would buy an image codec for a content-type.
 *
 * It never uses the webrain POOL. A pooled `webrain_observe` would photograph
 * whatever page the previous tenant left on that worker -- a disclosure worse
 * than the `extract`/`pdf` case because it is an image of someone else's screen.
 * So this always asks the session's OWN machine, through arachnefly's
 * `POST /api/machine/mcp/:id`, which carries the ownership check.
 *
 * The caller's own token is relayed, and that is safe rather than merely
 * convenient: the middleware checks the machine id against the uid that token
 * carries, so a machine id from another account is a 404 upstream. `machineId`
 * therefore never leaves the server, which is why `BrowserSessionPublic` has no
 * field for it.
 * @param {Request} req The request.
 * @param {Response} res The response.
 */
export const browserSessionFrame = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    unauthorized(res)
    return
  }

  try {
    const id = sessionIdOf(req)
    if (!id) {
      notFound(res)
      return
    }

    // Owner-scoped, and BEFORE anything is captured: a session that is not this
    // caller's answers 404 without a machine ever being asked for a screenshot.
    const record = await readBrowserSessionRecord(uid, id)
    if (!record) {
      notFound(res)
      return
    }

    if (!record.machineId) {
      res.status(409).json({
        error: "This session has no machine to observe",
        code: "no_frame_source",
      })
      return
    }

    const token = req.authToken
    if (!token) {
      // Arachnefly authenticates the machine call with this token, so without it
      // the request cannot be made at all. 401 rather than 500: it is the
      // caller's credential that is missing, not ours.
      unauthorized(res)
      return
    }

    if (frameRefused(`${uid}:${id}`, webrainTierFor(req.accessMode), Date.now())) {
      res.status(429).json({
        error: "Frames are arriving faster than this plan allows",
        code: "frame_too_soon",
      })
      return
    }

    const frame = await observeMachineFrame({
      baseUrl: arachneflyBaseUrl(),
      token: token,
      machineId: record.machineId,
    })

    if (!frame.ok) {
      // Status only. `observeMachineFrame` already refuses to relay the upstream
      // body, because this is the path a caller reaches by guessing a machine id.
      console.error(`browser-session: frame for ${id} failed: ${frame.error}`)
      res.status(502).json({
        error: "The machine did not return a frame",
        code: "frame_failed",
      })
      return
    }

    // `no-store` because a cached frame is indistinguishable from a live one, and
    // a live view frozen on a stale image is worse than one showing nothing. The
    // client's per-poll nonce defends the same thing at the URL.
    res.set("Cache-Control", "no-store")
    res.status(200).type(frame.contentType).send(Buffer.from(frame.bytes))
  } catch (error) {
    internal(res, "frame", error)
  }
}

/**
 * `POST /api/browser/session/:id/tool` -- run one tool on the session's OWN machine.
 *
 * What this closes
 * ---------------
 * Before it, a session could be created, closed, kept alive and WATCHED, and not
 * driven: the frame route is the only caller of the machine transport, and it
 * hard-codes `webrain_observe(what=screenshot)`. So the platform sold a browser a
 * customer could look at and not use.
 *
 * Why this is not `webrainTool`
 * ---------------------------
 * The pool path resolves to a SHARED worker, where `webrain_interact` and
 * `webrain_observe` are refused on purpose (`EXCLUSIVE_PAID_TOOLS`) because one
 * caller would otherwise act on a page another left. This route never touches the
 * pool: it always asks the caller's OWN machine, where the lease -- not a tier
 * allowlist -- is what makes the call attributable to one tenant. That is also why
 * the three tools here need not be in `SHARED_POOL_TOOLS` to be legitimate.
 *
 * `SESSION_TOOLS` is a named set rather than a passthrough, because "the lease is
 * the boundary" is a claim about a MACHINE and not a licence to forward whatever
 * tool name a client invents. Anything outside the set is refused, with the set
 * named in the response so the refusal is actionable rather than mysterious.
 *
 * No rate cap, unlike frames. A frame costs a capture the caller did not ask for
 * one at a time; an action costs only the machine-minute they are already billed
 * for, so capping it would meter their own clicking.
 * @param {Request} req The request carrying `{tool, args}`.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const browserSessionTool = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    unauthorized(res)
    return
  }

  try {
    const id = sessionIdOf(req)
    if (!id) {
      notFound(res)
      return
    }

    // Owner-scoped, and BEFORE anything is driven: a session that is not this
    // caller's answers 404 without a machine ever being asked to act.
    const record = await readBrowserSessionRecord(uid, id)
    if (!record) {
      notFound(res)
      return
    }

    if (!record.machineId) {
      // A pool-backed session has no machine of its own, and the pool refuses
      // these tools. Saying so beats a confusing upstream refusal.
      res.status(409).json({
        error: "This session has no machine to drive",
        code: "no_session_machine",
      })
      return
    }

    const token = req.authToken
    if (!token) {
      unauthorized(res)
      return
    }

    // `bodyOf` answers `unknown` in THIS module (unlike the storage handler's,
    // which hands back a record), so the shape is narrowed once here rather than
    // asserted at every field.
    const input = bodyOf(req)
    const body: Record<string, unknown> =
      input && typeof input === "object" ?
        (input as Record<string, unknown>) :
        {}

    const tool = typeof body["tool"] === "string" ? body["tool"] : ""

    if (!isSessionTool(tool)) {
      res.status(400).json({
        error: "That tool cannot be run on a session's own machine",
        code: "tool_not_allowed",
        allowed: [...SESSION_TOOLS],
      })
      return
    }

    const raw = body["args"]
    if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
      res.status(400).json({
        error: "args must be an object",
        code: "bad_args",
      })
      return
    }

    // Egress is platform-owned on every path, and this one is no exception.
    // `withPlatformProxy` drops a caller-supplied `proxy` UNCONDITIONALLY and
    // attaches none from an empty pool -- which is correct here rather than a
    // shortcut: the machine's own address IS the egress the caller leased, and a
    // proxy they chose would decide where their traffic appears to come from.
    const args = withPlatformProxy(
      tool,
      req.accessMode,
      (raw ?? {}) as Record<string, unknown>,
      []
    )

    const call = await callMachineTool({
      baseUrl: arachneflyBaseUrl(),
      token: token,
      machineId: record.machineId,
      tool: tool,
      args: args,
    })

    if (!call.ok) {
      // Status only. `callMachineTool` already refuses to relay the upstream
      // body, because this is the path a caller reaches by guessing a machine id.
      console.error(`browser-session: tool ${tool} for ${id} failed: ${call.error}`)
      res.status(502).json({
        error: "The machine did not answer",
        code: "machine_call_failed",
      })
      return
    }

    res.status(200).json({tool: tool, result: call.json})
  } catch (error) {
    internal(res, "session tool", error)
  }
}
