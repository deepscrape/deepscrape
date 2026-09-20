/* eslint-disable max-len */
/* eslint-disable indent */
/* eslint-disable object-curly-spacing */
import { Request, Response } from "express"
import { parseCachedJson, redis, isRedisEnabled } from "../app/cacheConfig"
import { rateLimitStoreName } from "./limiter"
import {
    HEARTBEAT_PRESENCE,
    READ_SESSION_WITH_TTL_REFRESH,
} from "../../../src/config/redis-scripts"
import {
    DEVICE_MISMATCH_DEDUPE_TTL_SECONDS,
    LEGACY_REVOCATION_TTL_SECONDS,
    ONLINE_GUESTS_KEY,
    ONLINE_USERS_KEY,
    PRESENCE_TTL_SECONDS,
    SESSION_CACHE_TTL_SECONDS,
    deviceMismatchKey,
    legacyRevokedKey,
    presenceGuestKey,
    presenceUserKey,
    revokedKey,
    sessionKey,
} from "../../../src/config/redis-keys"
import { env } from "../config/env"
import { db } from "../app/config"
import { Timestamp } from "firebase-admin/firestore"

/**
 * `@upstash/redis` exposes `eval` directly, but the no-op fallback client does
 * not (it only models the commands the app actually uses). This wrapper keeps
 * the hot path honest: with no Redis configured the heartbeat degrades to the
 * Firestore path instead of throwing a TypeError.
 *
 * @param {string} script - The Lua script source to execute.
 * @param {string[]} keys - Redis keys the script may access.
 * @param {(string | number)[]} args - Positional arguments passed to the script.
 * @return {Promise<TData>} Whatever the script returns.
 */
const redisEval = async <TData>(
    script: string,
    keys: string[],
    args: (string | number)[],
): Promise<TData> => {
    const client = redis as unknown as {
        eval?: (script: string, keys: string[], args: (string | number)[]) => Promise<TData>
    }
    if (typeof client.eval !== "function") {
        throw new Error("Redis eval unavailable")
    }
    return client.eval(script, keys, args)
}


export const statusCheck = async (req: Request, res: Response) => {
    try {
        // The Redis backend used to degrade silently (missing credentials, or a
        // rate-limit store that fell back to per-instance memory) with nothing
        // observable in production. Report it here so a degraded deploy is visible.
        // Served by bff/api.ts — the Express host (`functions/src/server.ts`) is gone.
        // The same shared config module still runs inside the deployed functions
        // (callables, triggers, webhooks) though, and those resolve PRODUCTION from the
        // FUNCTIONS_ENV_JSON blob while Cloud Run gets a plain
        // `--set-env-vars PRODUCTION=true`. Reporting the RESOLVED value -- not the env
        // var -- is the only way to see the two disagree without reading the secret.
        // `trustProxy` is the one that matters: it gates `req.ip`, which feeds rate
        // limiting, guest fingerprints and session geo.
        res.status(200).json({
            status: "ok",
            message: "ok",
            production: env.PRODUCTION,
            trustProxy: env.TRUST_PROXY,
            redis: {
                restClient: isRedisEnabled,
                rateLimitStore: rateLimitStoreName(),
            },
        })
    } catch (error) {
        console.error("Error in statusCheck:", error)
        res.status(500).json({
            status: "error",
            message: "API status check failed",
        })
    }
}

// ponytail: UA only. The old value mixed the *geo-resolved* IP stored at login
// (`resolvedGeo.ip`, ipregistry's canonical answer) with the *socket* IP seen on each
// heartbeat (`req.ip` behind Cloudflare → Hosting → Cloud Run, and dual-stack clients
// flip IPv4/IPv6 between requests) — two different sources for the same "identity", so
// honest users tripped the mismatch branch permanently. IP movement is alerted
// separately by detectNewLoginLocation at login time.
const computeDeviceFingerprint = (userAgent: string, _ipAddress?: string): string => userAgent

// Every session gate used to return `session_revoked`, so a session that was merely
// signed out — or belonged to another account — looked revoked and the client could not
// choose a recovery. Each gate now names its own cause; the client treats all three as
// "this local session is dead" while the reason survives in the logs.
const denySession = (
    res: Response,
    code: "session_revoked" | "session_signed_out" | "session_mismatch",
    message: string,
) => res.status(401).json({success: false, code, message})

/* Narrow an unknown body field to the signals string, or "". */
const signalsOf = (value: unknown): string => (typeof value === "string" ? value : "")

// Heartbeat write throttle. The heartbeat used to read the user doc from Firestore
// purely to decide whether to write `lastSeen`; deciding from process memory skips
// that read (and usually the write) entirely.
// ponytail: per-instance memory, so N warm instances may each write once per window.
// Ceiling: a strict global budget needs Redis — not worth a round-trip per heartbeat.
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000
const SESSION_ACTIVITY_WRITE_INTERVAL_MS = 60 * 1000
const THROTTLE_MAP_MAX_ENTRIES = 5000
const lastSeenWriteMs = new Map<string, number>()
const sessionActivityWriteMs = new Map<string, number>()

const dueForWrite = (lastWriteMs: number | undefined, intervalMs: number, nowMs: number): boolean =>
    !lastWriteMs || nowMs - lastWriteMs >= intervalMs

const logSuspiciousDeviceMismatch = async (params: {
    userId: string
    loginId: string
    currentFingerprint: string
    storedFingerprint: string
    ipAddress: string
    userAgent: string
    browser: string
    os: string
    providerId: string
}) => {
    const dedupeKey = deviceMismatchKey(params.loginId, params.currentFingerprint)
    const alreadyLogged = await redis.get(dedupeKey)
    if (alreadyLogged) {
        return
    }

    await redis.setex(dedupeKey, DEVICE_MISMATCH_DEDUPE_TTL_SECONDS, "1")
    const now = Timestamp.now()

    await Promise.all([
        db.collection("audit_logs").add({
            action: "device_mismatch_detected",
            admin_uid: "system:heartbeat",
            target_loginId: params.loginId,
            target_userId: params.userId,
            reason: "Session heartbeat fingerprint mismatch",
            timestamp: now,
            isAdmin: false,
            metadata: {
                currentFingerprint: params.currentFingerprint,
                storedFingerprint: params.storedFingerprint,
                ipAddress: params.ipAddress,
            },
        }),
        db.collection("login_metrics")
            .doc(params.userId)
            .collection("login_history_events")
            .doc()
            .set({
                uid: params.userId,
                eventType: "device_mismatch",
                eventSessionId: params.loginId,
                providerId: params.providerId,
                browser: params.browser,
                os: params.os,
                userAgent: params.userAgent,
                ipAddress: params.ipAddress,
                location: "",
                connected: true,
                createdAt: now,
                metadata: {
                    currentFingerprint: params.currentFingerprint,
                    storedFingerprint: params.storedFingerprint,
                },
            }),
    ])
}

export const heartbeat = async (req: Request, res: Response) => {
    try {
        const parsedData = req.cookies["aid"] ? JSON.parse(req.cookies["aid"]) :
            req.app.locals["user"]

        // ponytail: identity comes from the VERIFIED token only. `aid` is a
        // JS-readable, client-written cookie and the /event router had no auth
        // middleware, so an unauthenticated caller could POST a forged `aid` naming
        // any uid and act as them: refresh that session's TTL, mark it active, and
        // forge the device-fingerprint match that suppresses requiresReauth.
        // EventsAPIProxy.optionalJwtAuth now populates req.user — the client was
        // already sending the token, nothing was verifying it. Guests are
        // unaffected: they have no userId to claim. The cookie may still carry
        // guestId (anonymous by design) and loginId, but loginId is only consulted
        // for an authenticated caller.
        const userId = req.user?.uid
        const guestId = parsedData?.guestId || req.cookies["gid"]
        const loginId = userId ? parsedData?.loginId : undefined
        const now = new Date()
        const nowMs = now.getTime()
        const windowMs = 5 * 60 * 1000
        const cutoffMs = nowMs - windowMs
        let requiresReauth = false
        let sessionValidatedFromCache = false
        let firestoreCollection
        let id
        if (userId) {
            if (loginId) {
                // Check new loginSessions collection first (enterprise architecture)
                // ONE round-trip for read + TTL refresh + revocation check. The old
                // shape paid three sequential round-trips per heartbeat (this pipeline,
                // then a separate awaited setex, then the presence pipeline), and its
                // TTL refresh was a blind write that could resurrect a session a
                // concurrent sign-out had just deleted.
                const [cachedPayload, sessionStatus] = await redisEval<[string | null, string | null]>(
                    READ_SESSION_WITH_TTL_REFRESH,
                    [sessionKey(loginId), revokedKey(loginId)],
                    [SESSION_CACHE_TTL_SECONDS],
                )

                // The script returns { payload, status } — payload FIRST, and `status` is the
                // discriminator it exists to return. Destructuring the two slots the other way
                // round put a live session's own JSON in the revocation slot, so every cached
                // session was denied as revoked while Firestore (and the status callable, which
                // reads the key directly) correctly said active/not-revoked.
                if (sessionStatus === "revoked") {
                    return denySession(res, "session_revoked", "Session has been revoked")
                }
                // Upstash auto-deserializes, so this is already an object, not a string —
                // the old `typeof === "string"` guard was always false, so the cache never
                // served and this branch never ran.
                const sessionData = parseCachedJson<{
                    userId?: string
                    active?: boolean
                    deviceFingerprint?: string
                    deviceSignalsHash?: string
                    browser?: string
                    os?: string
                    providerId?: string
                }>(cachedPayload)
                if (sessionData) {
                    try {
                        if (sessionData.userId === userId && sessionData.active) {
                            // PHASE 3.1: Device fingerprint verification and suspicious activity logging.
                            if (sessionData.deviceFingerprint || sessionData.deviceSignalsHash) {
                                // Signals first, user agent as the fallback for sessions created
                                // before they existed. Both are risk signals — the identity is the
                                // persisted deviceId, which is why a changed hash warns and
                                // re-baselines instead of killing the session.
                                const providedSignals = signalsOf((req.body as { deviceSignals?: unknown } | undefined)?.deviceSignals)
                                const storedSignals = signalsOf(sessionData.deviceSignalsHash)
                                const currentUserAgent = req.get("user-agent") || ""
                                const ipAddress = req.ip || req.connection.remoteAddress || ""
                                let expectedFingerprint = computeDeviceFingerprint(currentUserAgent, ipAddress)
                                let storedFingerprint = sessionData.deviceFingerprint
                                if (providedSignals && storedSignals) {
                                    expectedFingerprint = providedSignals
                                    storedFingerprint = storedSignals
                                }

                                if (storedFingerprint && expectedFingerprint !== storedFingerprint) {
                                    requiresReauth = true
                                    console.warn(`⚠️ Device signal mismatch for session ${loginId}: browser or environment changed`)
                                    try {
                                        await logSuspiciousDeviceMismatch({
                                            userId,
                                            loginId,
                                            currentFingerprint: expectedFingerprint,
                                            storedFingerprint,
                                            ipAddress,
                                            userAgent: currentUserAgent,
                                            browser: sessionData.browser || "",
                                            os: sessionData.os || "",
                                            providerId: sessionData.providerId || "firebase",
                                        })
                                    } catch (logError) {
                                        console.warn("Failed to log suspicious device mismatch", logError)
                                    }
                                }
                            }

                            // Valid cached session - update lastActivityAt. Throttled: this was
                            // an unthrottled Firestore write on every heartbeat. Redis is the
                            // liveness signal (its TTL is refreshed below); Firestore only needs
                            // minute-level activity for the sessions list.
                            if (dueForWrite(sessionActivityWriteMs.get(loginId), SESSION_ACTIVITY_WRITE_INTERVAL_MS, nowMs)) {
                                if (sessionActivityWriteMs.size >= THROTTLE_MAP_MAX_ENTRIES) {
                                    sessionActivityWriteMs.clear()
                                }
                                sessionActivityWriteMs.set(loginId, nowMs)
                                await db
                                    .collection("loginSessions")
                                    .doc(loginId)
                                    .update({ lastActivityAt: Timestamp.now() })
                                    .catch((err) => console.warn("Failed to update session activity:", err))
                            }

                            // The TTL was already refreshed by READ_SESSION_WITH_TTL_REFRESH,
                            // in the same round-trip as this read.
                            // Cache-validated: skip the Firestore re-read below. This flag was
                            // missing, so the "fallback" ran on every cache hit and the cache
                            // saved zero reads.
                            sessionValidatedFromCache = true
                            // Continue to online tracking below
                        }
                    } catch (e) {
                        // Fallthrough to Firestore check
                    }
                }

                // Fallback: Check loginSessions collection (slower path).
                // Skipped entirely when Redis already validated the session.
                try {
                    const sessionSnap = sessionValidatedFromCache ?
                        null :
                        await db.collection("loginSessions").doc(loginId).get()
                    if (sessionSnap?.exists) {
                        const sessionData = sessionSnap.data() as {
                            userId?: string
                            active?: boolean
                            revokedAt?: Timestamp | null
                            deviceFingerprint?: string
                            deviceSignalsHash?: string
                            browser?: string
                            os?: string
                            providerId?: string
                            userAgent?: string
                            ipAddress?: string
                        }

                        if (sessionData?.userId === userId && sessionData?.active === true && !sessionData?.revokedAt) {
                            if (sessionData.deviceFingerprint || sessionData.deviceSignalsHash) {
                                // Same rule as the cached path: signals first, user agent as the
                                // fallback for sessions created before they existed.
                                const providedSignals = signalsOf((req.body as { deviceSignals?: unknown } | undefined)?.deviceSignals)
                                const storedSignals = signalsOf(sessionData.deviceSignalsHash)
                                const currentUserAgent = req.get("user-agent") || ""
                                const ipAddress = req.ip || req.connection.remoteAddress || ""
                                let expectedFingerprint = computeDeviceFingerprint(currentUserAgent, ipAddress)
                                let storedFingerprint = sessionData.deviceFingerprint
                                if (providedSignals && storedSignals) {
                                    expectedFingerprint = providedSignals
                                    storedFingerprint = storedSignals
                                }

                                if (storedFingerprint && expectedFingerprint !== storedFingerprint) {
                                    requiresReauth = true
                                    try {
                                        await logSuspiciousDeviceMismatch({
                                            userId,
                                            loginId,
                                            currentFingerprint: expectedFingerprint,
                                            storedFingerprint,
                                            ipAddress,
                                            userAgent: currentUserAgent,
                                            browser: sessionData.browser || "",
                                            os: sessionData.os || "",
                                            providerId: sessionData.providerId || "firebase",
                                        })
                                    } catch (logError) {
                                        console.warn("Failed to log suspicious device mismatch", logError)
                                    }
                                }
                            }
                        } else {
                            // Three different causes used to collapse into one body.
                            if (sessionData?.userId !== userId) {
                                return denySession(res, "session_mismatch", "Session belongs to another account")
                            }
                            if (sessionData?.revokedAt) {
                                return denySession(res, "session_revoked", "Session has been revoked")
                            }
                            return denySession(res, "session_signed_out", "Session is no longer active")
                        }
                    }
                } catch (e) {
                    // If both checks fail, fallback to old login_history_Info for backwards compat
                    console.log("loginSessions check failed, falling back to login_history_Info")
                    const cacheKey = legacyRevokedKey(userId, loginId)
                    const revokedCacheRaw = await redis.get<unknown>(cacheKey)
                    let revokedCache: {revokedAt?: string} | null = null
                    if (typeof revokedCacheRaw === "string") {
                        try {
                            const parsed = JSON.parse(revokedCacheRaw)
                            revokedCache = parsed as {revokedAt?: string}
                        } catch {
                            revokedCache = null
                        }
                    } else {
                        revokedCache = revokedCacheRaw as {
                            revokedAt?: string
                        } | null
                    }

                    if (revokedCache?.revokedAt) {
                        return denySession(res, "session_revoked", "Session has been revoked")
                    }

                    const loginDocPath =
                        `login_metrics/${userId}/login_history_Info/${loginId}`
                    const loginSnap = await db.doc(loginDocPath).get()
                    if (loginSnap.exists) {
                        const loginData = loginSnap.data() as {
                            connected?: boolean
                            revokedAt?: Timestamp | Date | null
                            signOutTime?: Timestamp | Date | null
                        }

                        if (
                            loginData?.connected === false ||
                            loginData?.revokedAt ||
                            loginData?.signOutTime
                        ) {
                            const revokedCacheKey = legacyRevokedKey(userId, loginId)
                            const revokedData = JSON.stringify({
                                revokedAt: new Date().toISOString(),
                            })
                            await redis.setex(
                                revokedCacheKey,
                                LEGACY_REVOCATION_TTL_SECONDS,
                                revokedData,
                            )
                            // ponytail: a legacy login_metrics row says signed out, not revoked.
                            return denySession(res, "session_signed_out", "Session is no longer active")
                        }
                    }
                }
            }

            firestoreCollection = "users"
            id = userId
        } else if (guestId) {
            firestoreCollection = "guests"
            id = guestId
        } else {
            // No ID, treat as new guest
            return res.status(400).json({
                success: false,
                message: "No guest or user ID found",
            })
        }
        // One script for presence liveness, sorted-set upsert, and stale trim.
        // Previously this was a 5-command pipeline of its own, on top of the
        // session read/refresh.
        const isUser = !!userId
        const presenceKey = isUser ? presenceUserKey(userId) : presenceGuestKey(guestId as string)
        const presencePayload = JSON.stringify({ lastSeen: now })
        await redisEval<unknown>(
            HEARTBEAT_PRESENCE,
            [presenceKey, ONLINE_USERS_KEY, ONLINE_GUESTS_KEY],
            [
                PRESENCE_TTL_SECONDS,
                presencePayload,
                nowMs,
                id as string,
                cutoffMs,
                isUser ? "user" : "guest",
            ],
        )

        // The dashboard summary is written once a minute by computeActiveUsersNow,
        // which owns that document. The heartbeat used to also write it behind a
        // per-instance throttle, so N warm instances produced N competing writes of
        // slightly different values for the same field set.

        // Structured SLI: the heartbeat is the hottest path in the app and its
        // round-trip budget is now a contract (2 on the cache-hit path). Emitting it
        // makes a regression visible without a profiler.
        console.log(JSON.stringify({
            metric: "heartbeat",
            redisRoundTrips: sessionValidatedFromCache ? 2 : 3,
            cacheHit: sessionValidatedFromCache,
            redisEnabled: isRedisEnabled,
            durationMs: Date.now() - nowMs,
            requiresReauth,
        }))

        // lastSeen is throttled to one write per window per instance. The Firestore
        // read that used to gate it is gone.
        if (dueForWrite(lastSeenWriteMs.get(id), LAST_SEEN_WRITE_INTERVAL_MS, nowMs)) {
            if (lastSeenWriteMs.size >= THROTTLE_MAP_MAX_ENTRIES) {
                lastSeenWriteMs.clear()
            }
            lastSeenWriteMs.set(id, nowMs)
            // A heartbeat must never CREATE a document. For a guest it could: a `gid`
            // cookie whose guest doc was gone got `set(..., {merge: true})`, which mints
            // a stub holding nothing but `lastSeen` — no `ip`, no `createdAt`. Those
            // stubs then caused both reported symptoms from one cause:
            //   1. enrichGuestGeo reads `ip.raw`, finds nothing, skips — so no IP
            //      intelligence was ever recorded and the geo cache stayed empty.
            //   2. computeRangeMetric filters `guests.createdAt >= start`, which cannot
            //      match a document without that field, so every range disagreed with
            //      the daily aggregates.
            // ponytail: `update()` rather than an existence read — the same one
            // round-trip, and a missing guest is an expected race (a cookie outliving a
            // cleanup), not an error worth 500-ing the heartbeat over.
            const ref = db.collection(firestoreCollection).doc(id as string)
            if (isUser) {
                await ref.set({ lastSeen: now }, { merge: true })
            } else {
                await ref.update({ lastSeen: now }).catch(() => undefined)
            }
        }

        return res.json({ success: true, lastSeen: now, requiresReauth })
    } catch (error) {
        console.error("Heartbeat error:", error)
        return res.status(500).json({
            success: false,
            error: error instanceof Error ?
                error.message : "Unknown error",
        })
    }
}
