/* eslint-disable object-curly-spacing */
/**
 * The browser-session decision layer.
 *
 * Pure: no I/O, no Firestore, no clock of its own, and the Fly token never
 * reaches this file. Every deadline is derived from a `lastUsedAt` argument,
 * so the layer is testable without a fake timer or a network.
 *
 * Why the caps are data: a number in a table is one edit and one failing test
 * away from being changed on purpose. A number in a branch is a hunt.
 */

import {TARGET_URL_MAX_LENGTH, isBlockedHost} from "./url-guard.domain"
import {type ComputeSource} from "./byo-compute.domain"

/** The engines the platform can drive. */
export type BrowserKind = "chrome" | "lightpanda" | "obscura"

/** `dedicated` leases a machine; `byo` attaches to the caller's own CDP URL. */
export type SessionMode = "dedicated" | "byo"

/**
 * Coarse on purpose: `credits`, `plan` and `grace` all bill, so they share one
 * cap set. Map `BillingAccessMode` down to this before calling `decideLease`.
 */
export type BrowserTier = "free" | "paid" | "admin"

/**
 * The valid kinds, as a value. The `BrowserKind` type is erased at the HTTP
 * boundary, so membership must be checked against something that survives to
 * runtime.
 */
export const BROWSER_KINDS: readonly BrowserKind[] = [
  "chrome",
  "lightpanda",
  "obscura",
]

/** Per-tier allowances, in one shape so a new cap is one field everywhere. */
export type TierCaps = {
  dedicated: number
  byo: number
  fps: number
  idleTtlMs: number
}

/**
 * `POSITIVE_INFINITY` means uncapped — a real value meaning "no ceiling", not
 * a sentinel for a missing one. `idleTtlMs: 0` means the tier has **no** idle
 * expiry; read `idleDeadlineFrom` before doing arithmetic on it.
 */
export const SESSION_CAPS: Record<BrowserTier, TierCaps> = {
  // Free gets no browser at all. None of its six tools needs one, so this is
  // honest rather than a restriction (roadmap 02, "Tier model").
  free: {dedicated: 0, byo: 0, fps: 0, idleTtlMs: 0},
  paid: {dedicated: 1, byo: 3, fps: 1, idleTtlMs: 15 * 60 * 1000},
  // Admin is unbounded in COUNT, but not in TIME. A session with no deadline is
  // a Fly machine with no end: `DecideReap` answers `no-deadline` and never
  // closes it, so a forgotten admin browser runs at $13.39/month forever and
  // every log line reads `considered=0`. Four idle hours is generous for
  // interactive work and still ends the runaway.
  admin: {
    dedicated: Number.POSITIVE_INFINITY,
    byo: Number.POSITIVE_INFINITY,
    fps: 4,
    idleTtlMs: 4 * 60 * 60 * 1000,
  },
}

/**
 * Every refusal reason, as a value as well as a type, so a caller can log one
 * without a cast and a new reason cannot be added to only half the surface.
 */
export const LEASE_REFUSALS = [
  "quota",
  "byo-not-allowed",
  "unsupported-kind",
  "cdp-url-refused",
] as const

/** The single reason a lease was refused. */
export type LeaseRefusal = (typeof LEASE_REFUSALS)[number]

/** A request to open one browser session. */
export type LeaseRequest = {
  tier: BrowserTier
  mode: SessionMode
  kind: BrowserKind
  /**
   * Sessions this caller holds IN THE REQUESTED `mode`, in any state but `closed`.
   *
   * The mode filter is load-bearing: this one number is compared against
   * `caps.byo` (3) on the BYO branch and `caps.dedicated` (1) below it, so an
   * unfiltered total let free BYO sessions hold the slot for the dedicated
   * machine the customer actually pays for.
   */
  liveSessions: number
  /** Whether the caller has a BYO CDP endpoint configured. */
  byoConfigured: boolean
}

/** Allowed, or the one reason it is not. */
export type LeaseDecision = {ok: true} | {ok: false; reason: LeaseRefusal}

/**
 * Decide whether a caller may open one more browser session.
 *
 * Checks run most-specific first so the reason names the real obstacle: an
 * engine we cannot drive is not a quota problem, and a missing BYO endpoint is
 * not one either — answering `quota` for both would send the caller to buy
 * credits that cannot help.
 * @param {LeaseRequest} request Tier, mode, kind, and current usage.
 * @return {LeaseDecision} Allowed, or the one reason it is not.
 */
/** The two fields the per-mode cap needs, and nothing a caller could over-read. */
type LiveSession = Pick<BrowserSessionPublic, "mode" | "state">

/**
 * How many live sessions a caller holds for ONE mode.
 *
 * The caps are per mode (`{dedicated: 1, byo: 3}`), so a combined total is the
 * wrong number to test them against: the pre-flight in `browserSessionCreate`
 * passed `listBrowserSessions(...).length`, which counts both modes — so three
 * free BYO sessions refused the dedicated machine the caller pays for.
 * `createBrowserSession` never had the bug because it counts inside the
 * transaction per mode; both now use this one rule.
 * @param {ReadonlyArray<LiveSession>} sessions The caller's sessions.
 * @param {SessionMode} mode The mode the request is for.
 * @return {number} Live sessions in that mode.
 */
export const countLiveForMode = (
  sessions: ReadonlyArray<LiveSession>,
  mode: SessionMode,
): number =>
  sessions.filter(
    (session) => session.state !== "closed" && session.mode === mode,
  ).length

export const decideLease = (request: LeaseRequest): LeaseDecision => {
  if (!BROWSER_KINDS.includes(request.kind)) {
    return {ok: false, reason: "unsupported-kind"}
  }

  const caps = SESSION_CAPS[request.tier]
  if (!caps) {
    return {ok: false, reason: "unsupported-kind"}
  }

  if (request.mode === "byo") {
    // A zero BYO cap cannot attach to anything, whatever is configured, so
    // this is a quota answer rather than a configuration one.
    if (caps.byo === 0) {
      return {ok: false, reason: "quota"}
    }
    // Checked for every tier, `admin` included: uncapped in *number*, and an
    // endpoint that does not exist cannot be attached to. Answering ok here
    // would move the failure far from its cause.
    if (!request.byoConfigured) {
      return {ok: false, reason: "byo-not-allowed"}
    }
    if (request.liveSessions < caps.byo) {
      return {ok: true}
    }
    return {ok: false, reason: "quota"}
  }

  if (request.liveSessions < caps.dedicated) {
    return {ok: true}
  }
  return {ok: false, reason: "quota"}
}

/**
 * The instant a session becomes idle.
 *
 * Only meaningful for a tier whose `idleTtlMs` is non-zero. Do **not** call it
 * with `0`: `lastUsedAt + 0` is a timestamp in the past, which reads to the
 * reaper as "expired long ago" and would close a session the tier never
 * intended to expire. Tiers with no idle expiry (`free`, `admin`) must omit
 * the deadline rather than compute one.
 * @param {number} lastUsedAt Epoch ms of the session's last activity.
 * @param {number} ttlMs The tier's idle TTL in ms, greater than zero.
 * @return {number} Epoch ms at which the session goes idle.
 */
export const idleDeadlineFrom = (
  lastUsedAt: number,
  ttlMs: number,
): number => lastUsedAt + ttlMs

/**
 * CDP endpoints are `ws(s)://`. `http(s)` is accepted too, because some
 * providers hand out an HTTP discovery URL for the same endpoint.
 */
const CDP_SCHEMES: ReadonlySet<string> = new Set([
  "ws:",
  "wss:",
  "http:",
  "https:",
])

/** A vetted BYO endpoint, or the refusal. */
export type CdpUrlDecision =
  {ok: true; url: string} | {ok: false; reason: "cdp-url-refused"}

/**
 * Vet a caller-supplied BYO CDP URL.
 *
 * This is the Phase 0.4 hole closed at the only point that matters: a BYO
 * endpoint is dialled from a worker, so a URL naming loopback, the cloud
 * metadata address, or a Fly internal host makes the caller an SSRF probe.
 *
 * Reuses `isBlockedHost` and `TARGET_URL_MAX_LENGTH` from the platform's one
 * URL guard rather than restating the host policy — a second copy is a second
 * answer to "is this safe?". Only the scheme rule is added, because
 * `isSafeTargetUrl` takes `http(s)` only and would reject every `wss://`.
 * @param {unknown} raw The untrusted value.
 * @return {CdpUrlDecision} The trimmed URL, or `cdp-url-refused`.
 */
export const decideCdpUrl = (raw: unknown): CdpUrlDecision => {
  if (typeof raw !== "string") {
    return {ok: false, reason: "cdp-url-refused"}
  }
  const candidate = raw.trim()
  if (!candidate || candidate.length > TARGET_URL_MAX_LENGTH) {
    return {ok: false, reason: "cdp-url-refused"}
  }

  try {
    const parsed = new URL(candidate)
    if (!CDP_SCHEMES.has(parsed.protocol)) {
      return {ok: false, reason: "cdp-url-refused"}
    }
    if (isBlockedHost(parsed.hostname)) {
      return {ok: false, reason: "cdp-url-refused"}
    }
    return {ok: true, url: candidate}
  } catch {
    // Unparseable is refused rather than passed through: a URL the platform
    // cannot understand is not one it can vouch for.
    return {ok: false, reason: "cdp-url-refused"}
  }
}

/** The lifecycle a stored session moves through. */
export const SESSION_STATES = [
  "starting",
  "ready",
  "suspended",
  "closed",
] as const

/** Where a session is in its lifecycle. */
export type SessionState = (typeof SESSION_STATES)[number]

/**
 * A stored session.
 *
 * This type does **not** leave the server. `machineId` is an internal Fly id,
 * `cdpSecretPath` points at a credential, so neither belongs in a response;
 * routes answer `BrowserSessionPublic` instead.
 */
export type BrowserSessionRecord = {
  id: string
  mode: SessionMode
  kind: BrowserKind
  state: SessionState
  tier: BrowserTier
  /**
   * Whose wallet pays for this session's metered time.
   *
   * Absent means the caller's own, which is correct for every session opened before a
   * workspace could pay. Stored at CREATION and never re-resolved, for the same reason
   * `computeSource` is: the caller's active workspace changes, and a meter that
   * re-read it would move an hour of already-billed compute to somebody else's balance.
   */
  orgId?: string
  /**
   * Present only for `dedicated`, and only once a machine has been attached.
   */
  machineId?: string
  /**
   * Whose Fly organization supplied the machine.
   *
   * Absent reads as `platform`, and that is correct rather than lax: a record
   * written before this field existed WAS platform compute, because no path
   * existed that could put a machine in a caller's own app.
   *
   * Stored at CREATION and never re-resolved. The machine's app is fixed when it
   * is provisioned, so a later read of the caller's settings could describe an
   * organization the running machine is not in — and the meter would then price
   * a machine by a fact that has stopped being true.
   *
   * This is NOT the same axis as `mode`. `mode: "byo"` means the caller brought a
   * CDP URL, which provisions no machine at all; `computeSource: "byo"` means
   * their Fly organization ran the machine we provisioned. A session can be
   * `dedicated` on BYO compute, and that is the case `machineId` alone cannot
   * describe.
   */
  computeSource?: ComputeSource
  /** Present only for `byo`. A Secret Manager path, never the URL itself. */
  cdpSecretPath?: string
  createdAt: number
  lastUsedAt: number
  /**
   * Absent for a tier with no idle expiry (`free`, `admin`). Deliberately not
   * `lastUsedAt + 0`: that is a past instant, and the reaper would read it as
   * "expired long ago".
   */
  idleDeadline?: number
  minutesBilled: number
}

/**
 * What a route may answer.
 *
 * No field a credential or an internal id could occupy, so "did we leak the CDP
 * URL or the Fly machine id?" is answered by the type rather than by review.
 */
export type BrowserSessionPublic = {
  id: string
  mode: SessionMode
  kind: BrowserKind
  state: SessionState
  createdAt: number
  /** The idle deadline, under the name the routes use for it. */
  expiresAt?: number
  /**
   * The frame cadence this session's tier allows, in ms.
   *
   * Sent rather than left for the client to derive: the client used to poll at a
   * hardcoded 1000ms, which is the PAID cap, so an admin tier that allows 4 fps was
   * still shown one frame a second and the cap was decorative. A mirrored copy of
   * `SESSION_CAPS` in the browser would drift the first time a cap moved.
   */
  frameIntervalMs: number
}

/**
 * Project a stored session down to what a caller may see.
 *
 * Built field by field rather than deleting from the record, so a field added
 * to `BrowserSessionRecord` later is exposed only when it is named here.
 * @param {BrowserSessionRecord} session The stored record.
 * @return {BrowserSessionPublic} The public shape.
 */
export const toPublicSession = (
  session: BrowserSessionRecord,
): BrowserSessionPublic => {
  const projected: BrowserSessionPublic = {
    id: session.id,
    mode: session.mode,
    kind: session.kind,
    state: session.state,
    createdAt: session.createdAt,
    frameIntervalMs: frameIntervalMs(session.tier),
  }
  if (session.idleDeadline !== undefined) {
    projected.expiresAt = session.idleDeadline
  }
  return projected
}

/**
 * The idle deadline for a tier, or undefined when that tier has no expiry.
 *
 * Exists so the `idleTtlMs === 0` case cannot become `lastUsedAt + 0` by a
 * caller that only thought about the arithmetic.
 * @param {BrowserTier} tier The caller's tier.
 * @param {number} lastUsedAt Epoch ms of the last activity.
 * @return {number | undefined} The deadline, or undefined for no expiry.
 */
export const idleDeadlineForTier = (
  tier: BrowserTier,
  lastUsedAt: number,
): number | undefined => {
  const ttl = SESSION_CAPS[tier]?.idleTtlMs ?? 0
  return ttl > 0 ? idleDeadlineFrom(lastUsedAt, ttl) : undefined
}

/**
 * The state a freshly created session starts in.
 *
 * `byo` is ready at once — the endpoint already exists and nothing has to be
 * provisioned. `dedicated` is `starting`, because a machine still has to be
 * created and become serviceable.
 * @param {SessionMode} mode The requested mode.
 * @return {SessionState} The initial state.
 */
export const initialStateFor = (mode: SessionMode): SessionState =>
  mode === "byo" ? "ready" : "starting"

/**
 * The Secret Manager id for a caller's BYO CDP endpoint.
 *
 * Derived from the uid, so a save and a later read agree without the name being
 * stored twice — the same property `byobSecretId` and `aiKeySecretId` rely on.
 * Per user rather than per session: the endpoint is the caller's configuration,
 * and one secret per session would multiply credentials holding one value.
 * @param {string} uid The verified caller uid.
 * @return {string} The secret id.
 */
export const cdpSecretId = (uid: string): string => `browser-cdp-${uid}`

/**
 * The HTTP status each refusal answers with.
 *
 * Split rather than collapsed to one code, because the client reaction
 * differs: 400 means the request was wrong, 403 and 429 mean it was understood
 * and refused. None is 402 — a free caller asking for a browser gets a named
 * reason, which is the point of gating these routes on `access` rather than
 * `paid`.
 */
export const BROWSER_REFUSAL_STATUS: Record<LeaseRefusal, number> = {
  "quota": 429,
  "byo-not-allowed": 403,
  "unsupported-kind": 400,
  "cdp-url-refused": 400,
}

/** One sentence per refusal, so a client has something to show. */
export const BROWSER_REFUSAL_MESSAGE: Record<LeaseRefusal, string> = {
  "quota": "You already hold as many browser sessions as your plan allows",
  "byo-not-allowed": "Configure a CDP endpoint before opening a BYO session",
  "unsupported-kind": "That browser engine is not one this platform can drive",
  "cdp-url-refused": "That CDP endpoint is not acceptable",
}

/** A refusal, ready to answer with: status, machine-readable code, sentence. */
export type BrowserRefusal = {
  status: number
  code: string
  error: string
}

/**
 * The answer for a named refusal reason.
 *
 * One function rather than three table lookups at each call site, so the status
 * and the code cannot be taken from different rows.
 * @param {LeaseRefusal} reason The named reason.
 * @return {BrowserRefusal} The status, code and sentence.
 */
export const refusalFor = (reason: LeaseRefusal): BrowserRefusal => ({
  status: BROWSER_REFUSAL_STATUS[reason],
  code: reason,
  error: BROWSER_REFUSAL_MESSAGE[reason],
})

/** A create request that passed validation. */
export type CreateRequest = {
  mode: SessionMode
  kind: BrowserKind
  cdpUrl?: string
  // What the session is FOR, which decides the machine preset. Not the engine:
  // `kind` already names that, and a code session can still drive a browser.
  workload: SessionWorkload
}

/** A parsed create request, or the refusal to answer it with. */
export type CreateRequestDecision =
  | {ok: true; request: CreateRequest}
  | {ok: false; refusal: BrowserRefusal}

/**
 * Parse and validate a create-session body.
 *
 * Pure, and separate from the handler on purpose. The handler's module imports
 * the Firestore client directly (`db` from `../app/config`) and calls it inside
 * the store functions, so exercising a handler path needs an emulator or an
 * injection seam. Every decision it makes before that I/O — which request is
 * valid, which refusal a caller sees — lives here, where a plain test can pin
 * it. (Importing the handler itself is fine: measured 2026-10-21, it loads
 * under `tsx` with no credentials. It is the I/O that needs the emulator.)
 *
 * `kind` is checked against `BROWSER_KINDS` at RUNTIME, because `BrowserKind`
 * is erased by the time JSON arrives — a cast alone would let an unknown
 * string straight through to the store.
 * @param {unknown} body The parsed request body.
 * @return {CreateRequestDecision} The request, or the refusal.
 */
export const parseCreateRequest = (body: unknown): CreateRequestDecision => {
  const source =
    body && typeof body === "object" ?
      (body as Record<string, unknown>) :
      {}

  const mode = source.mode
  if (mode !== "dedicated" && mode !== "byo") {
    return {
      ok: false,
      refusal: {
        status: 400,
        code: "unsupported-mode",
        error: "mode must be dedicated or byo",
      },
    }
  }

  const kind = source.kind
  if (typeof kind !== "string" ||
    !BROWSER_KINDS.includes(kind as BrowserKind)) {
    return {ok: false, refusal: refusalFor("unsupported-kind")}
  }

  const raw = source.cdpUrl
  const cdpUrl =
    typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined

  const request: CreateRequest = {
    mode: mode,
    kind: kind as BrowserKind,
    // Anything that is not exactly "code" is a browser session, deliberately: an
    // unrecognised value must never buy a machine smaller than the caller needs.
    workload: source.workload === "code" ? "code" : "browser",
  }
  if (cdpUrl !== undefined) {
    request.cdpUrl = cdpUrl
  }

  return {ok: true, request: request}
}

/**
 * The guest size every browser machine is asked for.
 *
 * A constant, not a per-request field. A caller that chose its own CPU count
 * would be choosing its own bill, and `decideLease` — which owns what a tier
 * may have — knows nothing about machine size, so a size in the request would
 * be a limit nobody checks. Sized for a headless browser with no display.
 * Raise it here, once, with the cost in mind.
 */
export const BROWSER_MACHINE_SIZE = {
  cpuCores: 2,
  cpuType: "shared",
  memory: 2048,
} as const

/** A Fly machine preset: the three fields `BrowserMachineRequest` takes. */
export type MachineSize = {
  cpuCores: number
  cpuType: "shared" | "performance"
  memory: number
}

/** What the session is for. Not an engine kind: `BROWSER_KINDS` names engines. */
export type SessionWorkload = "browser" | "code"

/**
 * Fly bills the preset while a machine RUNS, so the preset is a real per-minute
 * cost: `shared-cpu-2x`/2 GB is $13.39/mo against $3.69/mo for 1x/512 MB. A code
 * session paying the browser preset is a 3.6x overspend on every active minute,
 * and code sessions are the ones that run longest.
 */
export const MACHINE_SIZE_BY_WORKLOAD: Record<SessionWorkload, MachineSize> = {
  browser: BROWSER_MACHINE_SIZE,
  code: {cpuCores: 1, cpuType: "shared", memory: 512},
}

/**
 * Anything unrecognised resolves to the BROWSER preset, deliberately: undersizing
 * a session that turns out to need a renderer fails as an out-of-memory browser,
 * which is far harder to attribute than paying for RAM nobody used.
 *
 * @param {unknown} workload The requested workload, from an untrusted body.
 * @return {MachineSize} The preset to deploy, never smaller than the browser one
 * for an unrecognised value.
 */
export const sizeForWorkload = (workload: unknown): MachineSize =>
  workload === "code" ? MACHINE_SIZE_BY_WORKLOAD.code : BROWSER_MACHINE_SIZE

/** The body arachnefly's `POST /api/deploy` expects. */
export type BrowserMachineRequest = {
  imageOption: "default"
  defaultImage: string
  machineName: string
  region: string
  cpuCores: number
  cpuType: string
  memory: number
  autoStart: boolean
  autoStop: string
}

/**
 * The Fly machine name for a session.
 *
 * Derived from the session id, never random, and that is the point: Fly
 * requires a name to be unique within an app, so the name doubles as the
 * idempotency key — a deploy retried for the same session is refused by Fly
 * rather than creating a second machine the platform would go on paying for.
 * It also means a machine seen in the Fly dashboard traces back to the session
 * that owns it, which the reaper's logs depend on. The `bs-` prefix keeps the
 * name starting with a letter, which Fly requires and a bare UUID does not
 * always satisfy.
 * @param {string} sessionId The session id.
 * @return {string} The name to deploy the machine under.
 */
export const machineNameFor = (sessionId: string): string => `bs-${sessionId}`

/**
 * The machine a session asks arachnefly to deploy.
 *
 * Takes the id rather than the record, so this stays callable from the route
 * before the session has been read back, and so the decision cannot depend on
 * a field a caller controls.
 *
 * `autoStop: "suspend"` is the pair to the reaper. Without it Fly keeps an idle
 * machine running, which is exactly the cost §1.5 exists to stop; with it, an
 * idle machine suspends and stops billing compute, and `autoStart` brings it
 * back with no redeploy. Both are set explicitly because Fly's default is to
 * keep running.
 * @param {string} sessionId The session id.
 * @param {string} image The container image to run.
 * @param {string} region The Fly region to place it in.
 * @param {MachineSize} size The CPU/RAM preset; the browser one when omitted.
 * @return {BrowserMachineRequest} The deploy body.
 */
export const machineRequestFor = (
  sessionId: string,
  image: string,
  region: string,
  // Defaulted so every existing caller keeps the browser preset: the size is a
  // cost decision, and a missing one must not silently make a browser smaller.
  size: MachineSize = BROWSER_MACHINE_SIZE,
): BrowserMachineRequest => ({
  imageOption: "default",
  defaultImage: image,
  machineName: machineNameFor(sessionId),
  region: region,
  cpuCores: size.cpuCores,
  cpuType: size.cpuType,
  memory: size.memory,
  autoStart: true,
  autoStop: "suspend",
})

/**
 * The price of one action, as the pricing table states it.
 *
 * Structurally what `BillingPricingPolicy` is, stated separately on purpose:
 * this layer takes "an action and a price" as data, so it needs no import from
 * the billing domain and stays free of anything that reads configuration.
 */
export type ActionPrice = {
  action: string
  credits: number
}

/** What attaching a machine costs a caller, and from which pot. */
export type MachineCharge = {
  amount: number
  bucket: "purchased" | "included"
  action: string
}

/**
 * Whether this caller pays to attach a machine, and if so from which bucket.
 *
 * The decision lives here rather than in the route for the same reason
 * `decideLease` does: it is the part that costs money, and the route
 * imports the store, so nothing reachable from it can be tested without an
 * emulator.
 *
 * `free` cannot be charged even in principle — `decideLease` refuses a
 * `dedicated` session before this is asked, because
 * `SESSION_CAPS.free.dedicated` is 0 — so no path reaches a machine without
 * passing this. `admin` is the platform bypass, and `grace` keeps access
 * without being billed, because the pricing table's own charge gate names
 * only `credits` and `plan`.
 *
 * The amount is a PARAMETER, never a literal: the deploy action is priced once
 * in `billing-pricing.domain.ts`, and a second number here is how a browser
 * machine and a manual deploy come to cost different amounts for the same Fly
 * machine.
 * @param {string | undefined} accessMode The mode `resolveAccess` resolved.
 * @param {ActionPrice} price The price of the deploy action.
 * @return {MachineCharge | null} What to charge, or null to charge nothing.
 */
export const machineChargeFor = (
  accessMode: string | undefined,
  price: ActionPrice,
): MachineCharge | null => {
  if (accessMode !== "credits" && accessMode !== "plan") {
    return null
  }
  if (!Number.isFinite(price.credits) || price.credits <= 0) {
    return null
  }

  return {
    amount: price.credits,
    bucket: accessMode === "credits" ? "purchased" : "included",
    action: price.action,
  }
}

/**
 * The image type the BYTES are, when it is one we can recognise.
 *
 * The engine reports the mime it was ASKED for. `BrowserBackend::screenshot_fmt`
 * has a default implementation that ignores the requested format and calls
 * `screenshot()`, so a backend with no lossy encoder answers with PNG while still
 * reporting `image/webp`. Serving PNG labelled webp is a frame the browser refuses
 * to paint: a black live view, a 200 in the log, and nothing to grep for.
 *
 * Undefined when the header is not one of the three, so a caller falls back to the
 * reported type rather than inventing one.
 * @param {Uint8Array} bytes The frame body.
 * @return {string | undefined} The mime the bytes actually are.
 */
export const sniffImageType = (bytes: Uint8Array): string | undefined => {
  if (bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png"
  }
  if (bytes.length >= 3 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"
  }
  // "RIFF" .... "WEBP"
  if (bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 &&
    bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp"
  }
  return undefined
}

/**
 * The pause a tier must leave between two frames, in milliseconds.
 *
 * The inverse of `SESSION_CAPS[tier].fps`, so the cap is written down in one
 * place and cannot drift from the table above. `Infinity` when the tier has no
 * browser at all, which lets a caller test one value rather than carry a
 * separate `fps === 0` branch.
 * @param {BrowserTier} tier The caller's tier.
 * @return {number} The minimum interval, or Infinity when there is no browser.
 */
export const frameIntervalMs = (tier: BrowserTier): number => {
  const fps = SESSION_CAPS[tier].fps
  return fps > 0 ? Math.ceil(1000 / fps) : Number.POSITIVE_INFINITY
}

/**
 * Whether a frame request arrives too soon to be served.
 *
 * A pure decision, so the arithmetic is testable without a clock: the caller
 * reports how long it has been since the last frame IT served, and `null` for a
 * first frame.
 *
 * The first frame is never early. A live view should paint the moment it is
 * opened rather than wait out an interval for an image it has not shown yet;
 * the interval exists to pace the frames that follow.
 *
 * A tier with no browser (`SESSION_CAPS.free`) refuses EVERY frame, the first
 * one included — "no browser" is not a pace, and answering the first request
 * with a frame would be the one mistake this predicate could make. So the
 * no-browser case is checked before the first-frame case, not after it.
 * @param {BrowserTier} tier The caller's tier.
 * @param {number | null} sinceLastMs Ms since the last frame, or null.
 * @return {boolean} True when the request must be refused.
 */
export const frameTooSoon = (
  tier: BrowserTier,
  sinceLastMs: number | null,
): boolean => {
  const interval = frameIntervalMs(tier)
  if (!Number.isFinite(interval)) {
    return true
  }
  return sinceLastMs !== null && sinceLastMs < interval
}
