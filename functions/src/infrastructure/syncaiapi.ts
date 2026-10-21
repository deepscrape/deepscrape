/* eslint-disable object-curly-spacing */
/* eslint-disable indent */
/* eslint-disable new-cap */
/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable max-len */
import { NextFunction, Request, Response, Router } from "express"
import {
    anthropicAICore, chatCompletionsCore, jinaAICrawl,
    arachnefly, scrapeMiddleware, webrainJobs, webrainSerp,
    webrainScrape, webrainSearch, webrainExtract, webrainPdf,
    monitorCreate, monitorList, monitorUpdate, monitorDelete,
    monitorChecks,
    getWebrainConfig, setWebrainToken, setWebrainProxies,
    storageGetSettings, storageList, storagePresign, storageSave,
    storageSetSettings,
} from "../handlers"
import { auth, db } from "../app/config"
import { BillingSnapshot, getBillingAccessMode, isChargeableAccessMode, resolveBillingPricingPolicy } from "../domain"
// Not in the domain barrel, so imported from the module itself -- the shape
// `bff/api.ts` already uses for the same type.
import { aiVendorDescriptor, resolveAiKeySource, type ProviderKeyId } from "../domain/user-ai-settings.domain"
import { isScrapeProviderId } from "../domain/scrape-providers.domain"
import { API_KEY_INDEX_COLLECTION, apiKeyIndexId, isPlatformApiKey } from "../domain/api-key-index.domain"
import { consumeBillingCredits, releaseBillingCredits, reserveBillingCredits } from "../app/billing-credits"
import { requirePermission } from "./authz.middleware"
import { authErrorCode as getAuthErrorCode } from "./auth-error"

type BillingChargeContext = {
    uid: string
    amount: number
    bucket: "purchased" | "included"
    action: string
    idempotencyBase: string
}

type OrganizationRole = "owner" | "admin" | "member" | "viewer"

const ORG_ROLE_INVITE_CAP: Record<OrganizationRole, readonly OrganizationRole[]> = {
    owner: ["owner", "admin", "member", "viewer"],
    admin: ["member", "viewer"],
    member: [],
    viewer: [],
}

const getMembershipDocId = (userId: string, orgId: string): string => `${userId}_${orgId}`

const getOrganizationMembership = async (
    userId: string,
    orgId: string
): Promise<{id: string; orgId?: string; userId?: string; role?: OrganizationRole} | null> => {
    const membershipSnap = await db.collection("memberships").doc(getMembershipDocId(userId, orgId)).get()

    if (!membershipSnap.exists) {
        return null
    }

    return {
        id: membershipSnap.id,
        ...(membershipSnap.data() || {}),
    } as {id: string; orgId?: string; userId?: string; role?: OrganizationRole}
}

const canInviteOrganizationRole = (
    actorRole: OrganizationRole | undefined,
    requestedRole: OrganizationRole
): boolean => {
    if (!actorRole) {
        return false
    }

    return ORG_ROLE_INVITE_CAP[actorRole]?.includes(requestedRole) === true
}

const randomSuffix = (): string => Math.random().toString(36).slice(2, 10)

const isPlatformAdminRequest = (req: Request): boolean => {
    const role = typeof req.user?.role === "string" ? req.user.role.trim().toLowerCase() : ""
    return role === "admin"
}

/**
 * ReverseAPIProxy
 */
class ReverseAPIProxy {
    public router: Router

    /**
     * callback
     */
    constructor() {
        this.router = Router()
        this.httpRoutesGets()
        this.httpRoutesPosts()
        this.httpRoutesPut()
        this.httpRoutesDelete()
    }

    // ------------------- Node JS Security -------------------
    // Middleware to verify Firebase JWT
    /**
     * isJwtAuth
     * @param {*} req
     * @param {*} res
     * @param {*} next
     */
    async isJwtAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
        const authHeader = req.headers["authorization"] as string

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            res.status(401).json({ error: "Unauthorized: Missing or invalid token" })
            return
        }

        const token = authHeader.split(" ")[1]

        // A platform key rather than a Firebase ID token. Resolved through the same
        // index `createMyApiKey` writes, and shaped into `req.user` so every
        // `perm(...)` and `paid` guard downstream applies UNCHANGED -- one
        // authorization model, not a second one that has to be kept in step.
        //
        // Deliberately not a second middleware: `guard()` puts `jwt` first on every
        // route, so teaching this function about keys makes all of them accept one,
        // including routes added later.
        if (isPlatformApiKey(token)) {
            try {
                const entry = await db
                    .doc(`${API_KEY_INDEX_COLLECTION}/${apiKeyIndexId(token)}`)
                    .get()
                const uid = entry.data()?.["uid"]

                // One response for "never a key" and "deleted key". Whether a given
                // string was ever valid is not something an unauthenticated caller
                // should be able to learn, and deletion is exactly what revokes a key:
                // the index entry is the only thing that authenticated it.
                if (!entry.exists || typeof uid !== "string" || uid.length === 0) {
                    res.status(401).json({
                        error: "Unauthorized: Invalid token",
                        code: "invalid_token",
                    })
                    return
                }

                // Narrowed to the one field the guards read. Anything else a decoded
                // token carries (`email`, `admin`, custom claims) is absent rather than
                // invented, so a key FAILS CLOSED on every check that reads one -- it
                // is not an admin and carries no claims.
                //
                // `req.authToken` is deliberately NOT set: `handlers/machines.ts` and
                // the heartbeat forward that raw value to other services as an identity
                // token, and a platform key must not travel onward wearing that hat.
                req.user = { uid } as unknown as typeof req.user
                next()
            } catch (error) {
                console.error("API key verification failed:", error)
                res.status(500).json({ error: "internal", code: "internal" })
            }
            return
        }

        try {
            const decodedToken = await auth.verifyIdToken(token, true)
            if (decodedToken) {
                req.user = decodedToken
                // Per-REQUEST. `req.app.locals` is the Express application's locals
                // object — process-wide and shared by every concurrent request — so
                // `req.app.locals["user"] = token` published this caller's Firebase
                // ID token to whichever request read it next. The readers are the
                // two relays that need the raw token: `handlers/machines.ts` (to
                // Arachnefly) and `heartbeat` (identity fallback).
                req.authToken = token
                next()
            } else {
                throw new Error("Invalid token")
            }
        } catch (error) {
            console.error("JWT Verification Error:", error)

            const code = getAuthErrorCode(error)
            if (code === "auth/id-token-revoked") {
                res.status(401).json({ error: "Unauthorized: Session revoked", code: "session_revoked" })
                return
            }

            res.status(401).json({ error: "Unauthorized: Invalid token", code: "invalid_token" })
        }
    }

    /**
     * resolveAccess
     *
     * Resolves `req.accessMode` for an authenticated caller WITHOUT requiring a
     * paid plan, so one route can serve both tiers and let the per-tool
     * allowlist (`decideWebrainTool`) make the real decision.
     *
     * Why this has to exist rather than a route that simply omits `paid`:
     * `requirePaidAccess` is the only place `req.accessMode` is ever populated,
     * and it 402s a free caller before reaching that assignment. Omitting it
     * therefore leaves `accessMode` undefined, which fails CLOSED at
     * `webrainTierFor` (undefined -> "free" -> strictest allowlist) — safe, but
     * it also means a genuinely PAYING caller gets served the free tier and
     * silently loses tools they paid for. Resolving here keeps the entitlement
     * decision in one place instead of resting on whether each route remembered
     * to gate.
     *
     * Authorization is untouched: the permission layer already admits free
     * users (`POLICIES.self` grants `ai.execute` and `crawl.execute`), so this
     * only removes the billing block. Scope stays with `perm(...)` in the
     * route's own guard.
     *
     * Charges nothing. The tools this fronts are stateless, and their cost does
     * not scale with payload, so there is no credit to reserve. A route that
     * SHOULD bill a paid caller composes the charge path explicitly rather than
     * inheriting it from here.
     * @param {*} req
     * @param {*} res
     * @param {*} next
     */
    async resolveAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
        const uid = req.user?.uid
        if (!uid) {
            res.status(401).json({ error: "unauthorized", code: "unauthorized" })
            return
        }

        if (isPlatformAdminRequest(req)) {
            // Same as the paid path: one decision, shared with whatever runs
            // after it, so the scrape-provider resolver cannot disagree.
            req.accessMode = "admin"
            next()
            return
        }

        try {
            const billingSnap = await db.doc(`users/${uid}/billing/current`).get()

            // `data()` is undefined for a missing document, and
            // `getBillingAccessMode` accepts undefined and reads it as free —
            // which is what a fresh account is. Calling it the same way the
            // paid path does is what keeps the two from disagreeing about
            // "free".
            const billing = billingSnap.data() as BillingSnapshot | undefined

            req.accessMode = getBillingAccessMode(billing)
            next()
        } catch (error) {
            console.error("Access resolution failed:", error)
            res.status(500).json({ error: "internal", code: "internal" })
        }
    }

    /**
     * requirePaidAccess
     * @param {*} req
     * @param {*} res
     * @param {*} next
     */
    async requirePaidAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
        const uid = req.user?.uid
        if (!uid) {
            res.status(401).json({ error: "unauthorized", code: "unauthorized" })
            return
        }

        if (isPlatformAdminRequest(req)) {
            res.setHeader("x-billing-bypass", "platform_admin")
            // Stashed so the scrape-provider resolver reads the SAME access decision
            // rather than re-reading billing and potentially disagreeing with it.
            req.accessMode = "admin"
            next()
            return
        }

        try {
            const billingRef = db.doc(`users/${uid}/billing/current`)
            const billingSnap = await billingRef.get()

            const now = Date.now()
            if (billingSnap.exists) {
                const billing = billingSnap.data() as BillingSnapshot
                const accessMode = getBillingAccessMode(billing, now)

                // Same reason as the admin branch above: one read, one decision,
                // shared with the middleware that runs after this one.
                req.accessMode = accessMode

                if (accessMode !== "free") {
                    const policy = resolveBillingPricingPolicy(req.method, req.path)
                    const shouldCharge = policy.credits > 0 && isChargeableAccessMode(accessMode)

                    let chargeContext: BillingChargeContext | null = null

                    if (shouldCharge) {
                        const bucket: "purchased" | "included" = accessMode === "credits" ? "purchased" : "included"
                        const idempotencyBase = `${uid}:${req.method}:${req.path}:${now}:${randomSuffix()}`

                        await reserveBillingCredits({
                            uid,
                            amount: policy.credits,
                            bucket,
                            ledger: {
                                source: "syncaiapi",
                                reason: `reserve:${policy.action}`,
                                metadata: {
                                    action: policy.action,
                                    method: req.method,
                                    path: req.path,
                                },
                                idempotencyKey: `${idempotencyBase}:reserve`,
                            },
                        })

                        chargeContext = {
                            uid,
                            amount: policy.credits,
                            bucket,
                            action: policy.action,
                            idempotencyBase,
                        }

                        res.setHeader("x-billing-credits-reserved", String(policy.credits))
                        res.setHeader("x-billing-action", policy.action)
                    }

                    let settled = false
                    const settleCharge = async (shouldConsume: boolean): Promise<void> => {
                        if (settled || !chargeContext) {
                            return
                        }

                        settled = true

                        try {
                            if (shouldConsume) {
                                await consumeBillingCredits({
                                    uid: chargeContext.uid,
                                    amount: chargeContext.amount,
                                    bucket: chargeContext.bucket,
                                    releaseReserved: true,
                                    ledger: {
                                        source: "syncaiapi",
                                        reason: `consume:${chargeContext.action}`,
                                        metadata: {
                                            action: chargeContext.action,
                                            method: req.method,
                                            path: req.path,
                                            statusCode: res.statusCode,
                                        },
                                        idempotencyKey: `${chargeContext.idempotencyBase}:consume`,
                                    },
                                })
                                return
                            }

                            await releaseBillingCredits({
                                uid: chargeContext.uid,
                                amount: chargeContext.amount,
                                bucket: chargeContext.bucket,
                                ledger: {
                                    source: "syncaiapi",
                                    reason: `release:${chargeContext.action}`,
                                    metadata: {
                                        action: chargeContext.action,
                                        method: req.method,
                                        path: req.path,
                                        statusCode: res.statusCode,
                                    },
                                    idempotencyKey: `${chargeContext.idempotencyBase}:release`,
                                },
                            })
                        } catch (settlementError) {
                            console.error("Billing credit settlement failed:", settlementError)
                        }
                    }

                    /**
                     * finish
                     */
                    res.once("finish", () => {
                        const success = res.statusCode >= 200 && res.statusCode < 400
                        // RETURNED rather than `void`ed so a host that awaits its
                        // listeners commits the ledger before answering. The BFF's
                        // bridge does await them; Cloud Run can freeze an instance
                        // the moment the response goes out, and a settlement still
                        // in flight then is simply lost — leaving the reservation
                        // standing and the customer short of credits.
                        return settleCharge(success)
                    })

                    /**
                     * close
                     */
                    res.once("close", () => {
                        if (!res.writableEnded) {
                            return settleCharge(false)
                        }

                        return undefined
                    })

                    next()
                    return
                }
            }

            res.status(402).json({
                error: "payment_required",
                code: "payment_required",
                message: "Payment required to access this endpoint",
            })
        } catch (error) {
            console.error("Payment gate check failed:", error)
            res.status(500).json({ error: "internal", code: "internal" })
        }
    }

    /**
     * requirePaidOrByok
     *
     * Admits a PAID caller exactly as `requirePaidAccess` does, and admits a FREE
     * caller only when they have stored their own key for this vendor.
     *
     * Why the entitlement guard and not the handler: the decision has to run before
     * the handler, and the one thing this gate was missing is that a free caller
     * bringing their own key costs the platform nothing. `user-ai-settings.domain.ts`
     * has said so all along — `resolveAiKeySource` answers `source: "user"` for a
     * free caller with a key — the route table simply never asked. Fixing it on the
     * route leaves every other `paid` route untouched.
     *
     * The paid path is DELEGATED, not re-implemented. Pricing and credit reservation
     * live in `requirePaidAccess`, and a second copy here is how the two drift — one
     * route charging 2 credits and its neighbour charging none.
     *
     * What this does NOT decide is which key is used. `keyFor` owns that and refuses
     * the platform fallback for a free caller, so a key that vanishes between this
     * check and the read is an error rather than free credit.
     *
     * ponytail: a paid caller reads the billing document twice, once here and once in
     * the delegated `requirePaidAccess`. Stash the snapshot on `req` and reuse it
     * there if AI-call volume ever makes that one read matter.
     * @param {*} vendor
     * @return {*}
     */
    requirePaidOrByok(vendor: ProviderKeyId) {
        return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            const uid = req.user?.uid
            if (!uid) {
                res.status(401).json({ error: "unauthorized", code: "unauthorized" })
                return
            }

            if (isPlatformAdminRequest(req)) {
                await this.requirePaidAccess(req, res, next)
                return
            }

            try {
                const now = Date.now()
                const billingSnap = await db.doc(`users/${uid}/billing/current`).get()
                const accessMode = getBillingAccessMode(
                    billingSnap.data() as BillingSnapshot | undefined,
                    now,
                )

                // A READER is not a chat vendor, so it has no plan entitlement to resolve: the
                // scrape catalogue's `byok` is the whole rule.
                //
                // This branch has to come FIRST, and that is not a style choice --
                // `aiVendorDescriptor` THROWS for anything absent from `AI_VENDORS`. `jina`
                // was in that catalogue for exactly this reason, which is the defect the
                // branch closes: a reader was described as a chat vendor so that this call
                // would not throw.
                if (isScrapeProviderId(vendor)) {
                    const keysSnap = await db.doc(`users/${uid}/private/ai`).get()
                    const stored = (keysSnap.data() ?? {})[vendor]
                    const hasKey =
                        stored !== undefined && stored !== null && stored !== ""

                    if (!hasKey) {
                        // `jina` is BYOK because its upstream accepts a per-caller credential
                        // rather than requiring one, so a caller without a key has nothing to
                        // call it with. There is no platform route to fall back to.
                        res.status(402).json({
                            error: "payment_required",
                            code: "payment_required",
                            message: "Your own key is required for this provider",
                        })
                        return
                    }

                    req.accessMode = accessMode
                    next()
                    return
                }

                // Past this point `vendor` is an `AiVendorId`: the branch above returned for
                // every scrape provider, and TypeScript narrows on the guard.
                //
                // A vendor the platform holds NO key for cannot be served by a plan, so a
                // paid caller is checked for their own key exactly like a free one.
                // Delegating that case to `requirePaidAccess` would admit them and then hand
                // `keyFor` an empty platform key, which surfaces as the vendor's own 401: a
                // plan upgrade buying a broken request, and precisely the confusion
                // `resolveAiKeySource` exists to prevent.
                const platformFunded = aiVendorDescriptor(vendor).internalKey

                if (accessMode !== "free" && platformFunded) {
                    await this.requirePaidAccess(req, res, next)
                    return
                }

                // The branch below asks the DOMAIN rather than restating its rule. That is
                // the whole point: the defect this fixes was the guard holding one opinion
                // and `resolveAiKeySource` holding another, so the verdict comes from the
                // resolver and the guard only enacts it. It now runs for a free caller AND
                // for a paid caller on a BYOK-only vendor, which is why the plan is no
                // longer what selects it.
                //
                // Presence only, and deliberately loose about the entry's SHAPE: the
                // authoritative read is `readUserAiKey`, and re-deriving its legacy
                // migration here would be a second opinion on the document layout.
                const keysSnap = await db.doc(`users/${uid}/private/ai`).get()
                const stored = (keysSnap.data() ?? {})[vendor as string]
                const hasUserKey =
                    stored !== undefined && stored !== null && stored !== ""

                const resolution = resolveAiKeySource(vendor, accessMode, hasUserKey)

                if (!resolution.allowed) {
                    res.status(402).json({
                        error: "payment_required",
                        code: "payment_required",
                        message:
                            "A paid plan, or your own key for this vendor, is required",
                    })
                    return
                }

                // The caller's REAL mode, not the literal `"free"`. `keyFor` reads this to
                // decide whether the platform may pay, and a paid caller now reaches here on
                // a BYOK-only vendor -- labelling them free would be a lie told to the one
                // function that acts on it.
                //
                // No credit is charged on this path, deliberately: the platform pays nothing
                // for a call made with the caller's own key, so billing for it would be
                // charging them for someone else's quota.
                req.accessMode = accessMode
                next()
            } catch (error) {
                console.error("Paid-or-Byok gate check failed:", error)
                res.status(500).json({ error: "internal", code: "internal" })
            }
        }
    }

    /**
     * callback
     * @param {*} req
     * @param {*} res
     */
    private listOrganizations = async (req: Request, res: Response): Promise<void> => {
        const uid = req.user?.uid
        if (!uid) {
            res.status(401).json({ error: "unauthorized", code: "unauthorized" })
            return
        }

        try {
            const membershipsSnap = await db.collection("memberships")
                .where("userId", "==", uid)
                .limit(100)
                .get()

            const memberships = membershipsSnap.docs
                .map((membershipDoc) => membershipDoc.data() as { orgId?: string; role?: string })
                .filter((membership): membership is { orgId: string; role?: string } => Boolean(membership.orgId))

            if (memberships.length === 0) {
                res.status(200).json({ organizations: [] })
                return
            }

            // One `getAll` instead of a `get` per membership. The old shape paid a whole
            // round trip per org, and this route runs on every load of the org picker.
            // `getAll` rejects a repeated reference, so the refs are de-duplicated first --
            // two membership documents can name the same org and the old loop simply
            // returned that org twice.
            const roleByOrgId = new Map<string, string | undefined>()
            for (const membership of memberships) {
                if (!roleByOrgId.has(membership.orgId)) {
                    roleByOrgId.set(membership.orgId, membership.role)
                }
            }

            const orgSnaps = await db.getAll(
                ...[...roleByOrgId.keys()].map((orgId) => db.collection("organizations").doc(orgId)),
            )

            const organizations = orgSnaps
                .filter((orgSnap) => orgSnap.exists)
                .map((orgSnap) => ({
                    id: orgSnap.id,
                    ...(orgSnap.data() || {}),
                    membership: {
                        role: roleByOrgId.get(orgSnap.id) || "member",
                    },
                }))

            res.status(200).json({ organizations })
        } catch (error) {
            console.error("Failed to list organizations:", error)
            res.status(500).json({ error: "internal", code: "internal" })
        }
    }

    /**
     * Second line of defence for handlers that read tenant data with the Admin SDK.
     *
     * ponytail: requirePermission is the authoritative gate, but everything in this
     * class reads Firestore through the ADMIN SDK, which bypasses firestore.rules
     * entirely — so a route registered without the middleware would expose the data
     * with no other check at all. Requiring the middleware's subject to be present
     * makes that mistake fail CLOSED rather than open, and costs zero extra reads:
     * requirePermission already computed the subject and its membership map into
     * res.locals.
     *
     * hasOwnProperty rather than a truthy lookup: memberships is a plain object, so
     * `memberships["constructor"]` resolves to Object's constructor and would read as
     * a membership for an org literally named `constructor`.
     *
     * ponytail: ceiling — this accepts ANY membership in the org, not the specific
     * action role (rename is owner-only, invitations are owner/admin). It is a
     * backstop for a missing middleware, not a re-implementation of the policy;
     * requirePermission still decides. Give it allowedRoles if it ever has to stand
     * on its own.
     * @param {*} res
     * @param {*} orgId
     * @return {*}
     */
    private isOrgAuthorized = (res: Response, orgId: string): boolean => {
        const subject = res.locals?.authzSubject as {
            isPlatformAdmin?: boolean
            memberships?: Record<string, string>
        } | undefined

        if (!subject) {
            return false
        }

        return subject.isPlatformAdmin === true ||
            Object.prototype.hasOwnProperty.call(subject.memberships || {}, orgId)
    }

    /**
     * callback
     * @param {*} req
     * @param {*} res
     */
    private getOrganization = async (req: Request, res: Response): Promise<void> => {
        const orgId = req.params.orgId
        if (!orgId) {
            res.status(400).json({ error: "bad_request", code: "bad_request" })
            return
        }

        if (!this.isOrgAuthorized(res, orgId)) {
            res.status(403).json({ error: "forbidden", code: "forbidden" })
            return
        }

        try {
            const orgSnap = await db.collection("organizations").doc(orgId).get()
            if (!orgSnap.exists) {
                res.status(404).json({ error: "not_found", code: "not_found" })
                return
            }

            res.status(200).json({ id: orgSnap.id, ...(orgSnap.data() || {}) })
        } catch (error) {
            console.error("Failed to get organization:", error)
            res.status(500).json({ error: "internal", code: "internal" })
        }
    }

    /**
     * callback
     * @param {*} req
     * @param {*} res
     */
    private createOrganization = async (req: Request, res: Response): Promise<void> => {
        const uid = req.user?.uid
        if (!uid) {
            res.status(401).json({ error: "unauthorized", code: "unauthorized" })
            return
        }

        const name = typeof req.body?.name === "string" ? req.body.name.trim() : ""
        if (!name) {
            res.status(400).json({ error: "bad_request", code: "bad_request", message: "name is required" })
            return
        }

        const orgId = `org_${uid}_${Date.now().toString(36)}`
        const membershipId = `${uid}_${orgId}`

        try {
            const batch = db.batch()
            batch.set(db.collection("organizations").doc(orgId), {
                id: orgId,
                name,
                slug: orgId,
                ownerId: uid,
                billingOwnerUid: uid,
                plan: "free",
                createdAt: new Date(),
                updatedAt: new Date(),
            }, { merge: true })

            batch.set(db.collection("memberships").doc(membershipId), {
                id: membershipId,
                orgId,
                userId: uid,
                role: "owner",
                addedBy: uid,
                createdAt: new Date(),
                updatedAt: new Date(),
            }, { merge: true })

            await batch.commit()
            res.status(201).json({ id: orgId })
        } catch (error) {
            console.error("Failed to create organization:", error)
            res.status(500).json({ error: "internal", code: "internal" })
        }
    }

    /**
     * callback
     * @param {*} req
     * @param {*} res
     */
    private createInvitation = async (req: Request, res: Response): Promise<void> => {
        const uid = req.user?.uid
        const orgId = req.params.orgId
        const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : ""
        const role = typeof req.body?.role === "string" ? req.body.role as OrganizationRole : "member"

        if (!uid) {
            res.status(401).json({ error: "unauthorized", code: "unauthorized" })
            return
        }

        if (!orgId || !email) {
            res.status(400).json({ error: "bad_request", code: "bad_request", message: "orgId and email are required" })
            return
        }

        const allowedRoles = new Set(["owner", "admin", "member", "viewer"])
        if (!allowedRoles.has(role)) {
            res.status(400).json({ error: "bad_request", code: "bad_request", message: "invalid invitation role" })
            return
        }

        try {
            const actorMembership = await getOrganizationMembership(uid, orgId)
            const actorRole = actorMembership?.role

            if (!actorMembership || !canInviteOrganizationRole(actorRole, role)) {
                res.status(403).json({ error: "forbidden", code: "forbidden", message: "inviter cannot assign that organization role" })
                return
            }

            const existingInvite = await db.collection("invitations")
                .where("orgId", "==", orgId)
                .where("email", "==", email)
                .where("status", "==", "pending")
                .limit(1)
                .get()

            if (!existingInvite.empty) {
                res.status(200).json({ id: existingInvite.docs[0].id, deduplicated: true })
                return
            }

            const inviteRef = db.collection("invitations").doc()
            await inviteRef.set({
                id: inviteRef.id,
                orgId,
                email,
                role,
                invitedBy: uid,
                status: "pending",
                createdAt: new Date(),
                updatedAt: new Date(),
            }, { merge: true })

            res.status(201).json({ id: inviteRef.id })
        } catch (error) {
            console.error("Failed to create invitation:", error)
            res.status(500).json({ error: "internal", code: "internal" })
        }
    }

    /**
     * callback
     * @param {*} req
     * @param {*} res
     */
    private listOrganizationMembers = async (req: Request, res: Response): Promise<void> => {
        const orgId = req.params.orgId
        if (!orgId) {
            res.status(400).json({ error: "bad_request", code: "bad_request" })
            return
        }

        // ponytail: the middleware is the authoritative gate; this is the belt to its
        // braces. This query has no uid filter — it returns EVERY membership for the
        // org — and it runs on the Admin SDK, so firestore.rules never sees it. If
        // requirePermission is ever dropped from this route, fail closed here instead
        // of handing over the roster.
        if (!this.isOrgAuthorized(res, orgId)) {
            res.status(403).json({ error: "forbidden", code: "forbidden" })
            return
        }

        try {
            const membershipsSnap = await db.collection("memberships")
                .where("orgId", "==", orgId)
                .limit(200)
                .get()

            /**
             * callback
             * @param {*} doc
             */
            const members = membershipsSnap.docs.map((doc) => ({
                id: doc.id,
                ...(doc.data() || {}),
            }))

            res.status(200).json({ members })
        } catch (error) {
            console.error("Failed to list organization members:", error)
            res.status(500).json({ error: "internal", code: "internal" })
        }
    }

    /**
     * callback
     * @param {*} req
     * @param {*} res
     */
    private removeOrganizationMember = async (req: Request, res: Response): Promise<void> => {
        const actorUid = req.user?.uid
        const orgId = req.params.orgId
        const memberUid = req.params.userId
        if (!actorUid || !orgId || !memberUid) {
            res.status(400).json({ error: "bad_request", code: "bad_request" })
            return
        }

        try {
            // Neither lookup feeds the other, and the route needs both before it can decide.
            const [actorMembership, memberMembership] = await Promise.all([
                getOrganizationMembership(actorUid, orgId),
                getOrganizationMembership(memberUid, orgId),
            ])

            if (!actorMembership?.role || !memberMembership?.role) {
                res.status(404).json({ error: "not_found", code: "not_found" })
                return
            }

            if (memberMembership.role === "owner" && actorMembership.role !== "owner") {
                res.status(403).json({ error: "forbidden", code: "forbidden", message: "Only an owner can remove another owner" })
                return
            }

            if (actorUid === memberUid && actorMembership.role === "owner") {
                const ownersSnap = await db.collection("memberships")
                    .where("orgId", "==", orgId)
                    .where("role", "==", "owner")
                    .limit(2)
                    .get()

                if (ownersSnap.size <= 1) {
                    res.status(409).json({ error: "conflict", code: "last_owner", message: "Cannot remove the last owner from the organization" })
                    return
                }
            }

            const membershipId = `${memberUid}_${orgId}`
            await db.collection("memberships").doc(membershipId).delete()
            res.status(204).send()
        } catch (error) {
            console.error("Failed to remove organization member:", error)
            res.status(500).json({ error: "internal", code: "internal" })
        }
    }

    /**
     * callback
     * @param {*} req
     * @param {*} res
     */
    private listOrgInvitations = async (req: Request, res: Response): Promise<void> => {
        const uid = req.user?.uid
        const orgId = req.params.orgId
        if (!uid) {
            res.status(401).json({ error: "unauthorized", code: "unauthorized" })
            return
        }
        if (!orgId) {
            res.status(400).json({ error: "bad_request", code: "bad_request", message: "orgId is required" })
            return
        }

        // ponytail: belt to the middleware's braces — pending invitations expose
        // invitee emails, and this query runs on the Admin SDK where rules are not
        // evaluated. Fail closed if requirePermission is ever dropped from the route.
        if (!this.isOrgAuthorized(res, orgId)) {
            res.status(403).json({ error: "forbidden", code: "forbidden" })
            return
        }

        try {
            const invitesSnap = await db.collection("invitations")
                .where("orgId", "==", orgId)
                .where("status", "==", "pending")
                .limit(100)
                .get()

            const orgSnap = await db.collection("organizations").doc(orgId).get()
            const orgName = orgSnap.exists ? (orgSnap.data()?.name || orgId) : orgId

            /**
             * callback
             * @param {*} doc
             */
            const invitations = invitesSnap.docs.map((doc) => ({
                id: doc.id,
                orgName,
                ...(doc.data() || {}),
            }))

            res.status(200).json({ invitations })
        } catch (error) {
            console.error("Failed to list org invitations:", error)
            res.status(500).json({ error: "internal", code: "internal" })
        }
    }

    /**
     * callback
     * @param {*} req
     * @param {*} res
     */
    private listMyInvitations = async (req: Request, res: Response): Promise<void> => {
        const uid = req.user?.uid
        if (!uid) {
            res.status(401).json({ error: "unauthorized", code: "unauthorized" })
            return
        }

        try {
            const tokenEmail = req.user?.email?.toLowerCase()
            const userRecord = tokenEmail ? null : await auth.getUser(uid)
            const userEmail = tokenEmail || userRecord?.email?.toLowerCase()

            if (!userEmail) {
                res.status(400).json({ error: "bad_request", code: "bad_request", message: "user email unavailable" })
                return
            }

            const invitesSnap = await db.collection("invitations")
                .where("email", "==", userEmail)
                .where("status", "==", "pending")
                .limit(200)
                .get()

            // Fetch org details for enrichment
            const orgIds = new Set<string>()
            invitesSnap.docs.forEach((doc) => {
                const data = doc.data()
                if (data?.orgId) {
                    orgIds.add(data.orgId)
                }
            })

            const orgMap: Record<string, string> = {}
            for (const orgId of orgIds) {
                try {
                    const orgSnap = await db.collection("organizations").doc(orgId).get()
                    orgMap[orgId] = orgSnap.exists ? (orgSnap.data()?.name || orgId) : orgId
                } catch (e) {
                    orgMap[orgId] = orgId
                }
            }

            /**
             * callback
             * @param {*} doc
             * @return {*}
             */
            const invitations = invitesSnap.docs.map((doc) => {
                const data = doc.data()
                return {
                    id: doc.id,
                    orgName: orgMap[data?.orgId] || data?.orgId,
                    ...(data || {}),
                }
            })

            res.status(200).json({ invitations })
        } catch (error) {
            console.error("Failed to list invitations:", error)
            res.status(500).json({ error: "internal", code: "internal" })
        }
    }

    /**
     * callback
     * @param {*} req
     * @param {*} res
     */
    private acceptInvitation = async (req: Request, res: Response): Promise<void> => {
        const uid = req.user?.uid
        const invitationId = req.params.invitationId
        if (!uid || !invitationId) {
            res.status(400).json({ error: "bad_request", code: "bad_request" })
            return
        }

        try {
            const inviteRef = db.collection("invitations").doc(invitationId)
            const inviteSnap = await inviteRef.get()

            if (!inviteSnap.exists) {
                res.status(404).json({ error: "not_found", code: "not_found" })
                return
            }

            const invitation = inviteSnap.data() as {
                email?: string
                orgId?: string
                role?: string
                status?: string
            }

            if (!invitation.orgId || !invitation.email) {
                res.status(400).json({ error: "bad_request", code: "bad_request", message: "invalid invitation payload" })
                return
            }

            if (invitation.status !== "pending") {
                res.status(409).json({ error: "conflict", code: "invitation_not_pending" })
                return
            }

            const tokenEmail = req.user?.email?.toLowerCase()
            const userRecord = tokenEmail ? null : await auth.getUser(uid)
            const userEmail = tokenEmail || userRecord?.email?.toLowerCase()

            if (!userEmail || userEmail !== invitation.email.toLowerCase()) {
                res.status(403).json({ error: "forbidden", code: "invitation_email_mismatch" })
                return
            }

            const role = (invitation.role || "member") as OrganizationRole
            const membershipId = `${uid}_${invitation.orgId}`

            const existingMembership = await getOrganizationMembership(uid, invitation.orgId)
            if (existingMembership) {
                res.status(409).json({ error: "conflict", code: "already_member" })
                return
            }

            const batch = db.batch()
            batch.set(db.collection("memberships").doc(membershipId), {
                id: membershipId,
                orgId: invitation.orgId,
                userId: uid,
                role,
                addedBy: invitation.orgId,
                createdAt: new Date(),
                updatedAt: new Date(),
            }, { merge: true })

            batch.set(inviteRef, {
                status: "accepted",
                acceptedBy: uid,
                acceptedAt: new Date(),
                updatedAt: new Date(),
            }, { merge: true })

            batch.set(db.collection("users").doc(uid), {
                defaultOrgId: invitation.orgId,
                updated_At: new Date(),
            }, { merge: true })

            await batch.commit()

            res.status(200).json({
                invitationId,
                orgId: invitation.orgId,
                role,
                accepted: true,
            })
        } catch (error) {
            console.error("Failed to accept invitation:", error)
            res.status(500).json({ error: "internal", code: "internal" })
        }
    }

    /**
     * callback
     * @param {*} req
     * @param {*} res
     */
    private renameOrganization = async (req: Request, res: Response): Promise<void> => {
        const orgId = req.params.orgId
        const name = typeof req.body?.name === "string" ? req.body.name.trim() : ""

        if (!orgId || name.length < 2 || name.length > 64) {
            res.status(400).json({ error: "bad_request", code: "bad_request", message: "name must be between 2 and 64 characters" })
            return
        }

        // ponytail: belt to the middleware's braces. This is a WRITE to
        // organizations/{orgId} via the Admin SDK — the exact operation
        // firestore.rules denies clients (`allow create, update, delete: if false`),
        // which is why the middleware, not the rules, was the only thing standing
        // between an authenticated user and another tenant's org. Fail closed.
        if (!this.isOrgAuthorized(res, orgId)) {
            res.status(403).json({ error: "forbidden", code: "forbidden" })
            return
        }

        try {
            await db.collection("organizations").doc(orgId).set({
                name,
                updatedAt: new Date(),
            }, { merge: true })
            res.status(204).send()
        } catch (error) {
            console.error("Failed to rename organization:", error)
            res.status(500).json({ error: "internal", code: "internal" })
        }
    }

    // ------------------- Node JS Routes -------------------

    /**
     * https Router Gets
     */

    /**
     * httpRoutesGets
     */
    private httpRoutesGets(): void {
        this.router.get("/orgs", requirePermission("organization", "read"), this.listOrganizations)
        this.router.get("/orgs/:orgId", requirePermission("organization", "read"), this.getOrganization)
        this.router.get("/orgs/:orgId/members", requirePermission("organization", "read"), this.listOrganizationMembers)
        this.router.get("/orgs/invitations/me", requirePermission("organization", "read"), this.listMyInvitations)
        this.router.get("/orgs/:orgId/invitations", requirePermission("organization", "invite"), this.listOrgInvitations)

        /**
         * Monitors — `GET /monitor/list` and `GET /monitor/checks`.
         *
         * `resolveAccess`, not `requirePaidAccess`: see the POST block below for
         * why the whole monitor surface is free-resolving. `crawl.execute` is
         * granted to `self` (domain/authz.domain.ts), so this removes the billing
         * block and not the scope check.
         */
        this.router.get("/monitor/list", this.resolveAccess, requirePermission("crawl", "execute"), monitorList)
        this.router.get("/monitor/checks", this.resolveAccess, requirePermission("crawl", "execute"), monitorChecks)

        /* Jina AI */
        this.router.get("/jina/:url", this.requirePaidAccess, requirePermission("ai", "execute"), jinaAICrawl)

        /**
         * Machines by Arachnefly
         */

        // Get Machine Details
        this.router.get("/machines/machine/:id", this.requirePaidAccess, requirePermission("machine", "read"), arachnefly.getMachine)

        // Check if the image is deployable
        this.router.get("/machines/check-image", this.requirePaidAccess, requirePermission("machine", "read"), arachnefly.checkImageDeployability)

        // wait for a machine to stabilize a specific state and return the machine details
        this.router.get("/machines/machine/waitforstate/:machineId", this.requirePaidAccess, requirePermission("machine", "read"), arachnefly.waitForState)

        /**
         * The webrain configuration — platform admin only.
         *
         * `requirePermission("platform", ...)` IS the admin gate: no role in
         * `POLICIES` is granted `platform`, so the only path through
         * `canPerform` is the platform-admin short-circuit. No billing gate
         * belongs here — the route spends no credits, it reads a credential the
         * platform owns. The handler reports presence, never the value.
         */
        this.router.get("/webrain/config", requirePermission("platform", "read"), getWebrainConfig)


        /**
         * Crawler by crawlagent
         */

        /**
         * The job surface — playground, `/operations`, crawl packs.
         *
         * All four verbs are registered together because they are one surface
         * backed by one store, and splitting them across the method groups is how
         * the earlier version ended up with `job` and `stream` transposed between
         * the client and the server. Each route is registered twice: the path the
         * client calls today, and the transposed path the old comment block
         * intended, so any older client keeps working.
         *
         * Every route is paid-gated and permission-gated exactly as `/crawl` is —
         * a job is the same capability spent in a batch.
         */
        this.router.post("/crawl/stream/job", this.requirePaidAccess, requirePermission("crawl", "execute"), webrainJobs.multiCrawlEnqueue)
        // The seeder's enqueue only; its status/results/cancel are the crawl
        // job's routes (the client rewrites `/seeder` to `/job`).
        this.router.post("/seeder/stream/job/multi-research", this.requirePaidAccess, requirePermission("crawl", "execute"), webrainJobs.multiSeedEnqueue)

        this.router.get("/job/stream/status/:taskId", this.requirePaidAccess, requirePermission("crawl", "execute"), webrainJobs.getTaskStatus)
        this.router.get("/crawl/stream/job/status/:taskId", this.requirePaidAccess, requirePermission("crawl", "execute"), webrainJobs.getTaskStatus)

        this.router.get("/job/stream/:taskId", this.requirePaidAccess, requirePermission("crawl", "execute"), webrainJobs.streamTaskResults)
        this.router.get("/crawl/stream/job/:taskId", this.requirePaidAccess, requirePermission("crawl", "execute"), webrainJobs.streamTaskResults)

        /**
         * Stored artifacts — the shared URL cache and the caller's own objects.
         *
         * No `requirePaidAccess` and no `resolveAccess`: this surface spends no
         * credit and reads no billing document, so it must not require an
         * entitlement to resolve. The gate is `storage.read`/`storage.write`,
         * granted to `self` ONLY (domain/authz.domain.ts) — and
         * `requirePermission` derives ownerId from the VERIFIED token, which is
         * what keeps one caller's objects out of another caller's list.
         *
         * Which tier an object goes to is NOT decided here: the handler asks
         * `decideStorageScope` once and returns the chosen scope in the
         * response, so the same answer is produced on both hosts.
         */
        this.router.get("/storage/list", requirePermission("storage", "read"), storageList)
        this.router.get("/storage/settings", requirePermission("storage", "read"), storageGetSettings)

        this.router.put("/job/:taskId/cancel", this.requirePaidAccess, requirePermission("crawl", "execute"), webrainJobs.cancelTask)
        this.router.put("/crawl/job/:tempTaskId/cancel", this.requirePaidAccess, requirePermission("crawl", "execute"), webrainJobs.cancelTask)
    }

    /**
     * https Router Post
     */

    /**
     * httpRoutesPosts
     */
    private httpRoutesPosts(): void {
        this.router.post("/orgs", requirePermission("organization", "manage"), this.createOrganization)
        this.router.post("/orgs/:orgId/invitations", requirePermission("organization", "invite"), this.createInvitation)
        this.router.post("/orgs/invitations/:invitationId/accept", requirePermission("organization", "read"), this.acceptInvitation)

        this.router.post("/anthropic/messages", this.requirePaidAccess, requirePermission("ai", "execute"), anthropicAICore) // Search for Markets
        // The two vendor cores became one factory. This table is the LEGACY registration
        // set and is not mounted (the live one is `bff/api.ts`, which also carries the
        // BYOK-only vendors and `requirePaidOrByok`); it is kept compiling rather than
        // expanded, so there is one place that decides what the platform actually serves.
        this.router.post("/openai/chat/completions", this.requirePaidAccess, requirePermission("ai", "execute"), chatCompletionsCore("openai"))
        this.router.post("/groq/chat/completions", this.requirePaidAccess, requirePermission("ai", "execute"), chatCompletionsCore("groq"))

        /**
         * Crawler Management by crawlagent
        */

        // `scrapeMiddleware` picks the provider from SCRAPE_PROVIDER, so this route
        // no longer names crawl4ai — switching to webrain is config, not an edit here.
        this.router.post("/crawl", this.requirePaidAccess, requirePermission("crawl", "execute"), scrapeMiddleware)

        /**
         * Free-tier structured search (`webrain_serp`).
         *
         * `resolveAccess`, NOT `requirePaidAccess`, and that is the whole point:
         * `requirePaidAccess` is the only place `req.accessMode` is otherwise
         * populated, and it 402s a free caller before reaching that assignment.
         * Resolving here lets one route serve both tiers and leaves the per-tool
         * decision to `decideWebrainTool`'s allowlist inside the call — the
         * free/paid boundary lives in domain/webrain-tools.domain.ts, not in a
         * route guard, deliberately.
         *
         * Authorization is unchanged: the router is mounted behind `isJwtAuth`,
         * and `crawl.execute` is granted to `self` (domain/authz.domain.ts), which
         * is what a normal user resolves to. This removes the billing block, not
         * the scope check.
         */
        this.router.post("/serp", this.resolveAccess, requirePermission("crawl", "execute"), webrainSerp)

        /**
         * The other four free-tier webrain routes.
         *
         * Same guard as `/serp`, for the same reason: `resolveAccess` populates
         * `req.accessMode` without 402-ing a free caller, and the per-tool
         * decision stays with `decideWebrainTool`'s allowlist
         * (domain/webrain-tools.domain.ts) rather than being duplicated into a
         * route guard. Each handler refuses the worker arguments that are not the
         * worker's (`limit` on search, `url` on extract and pdf) with a 400 that
         * names the real field.
         */
        this.router.post("/scrape", this.resolveAccess, requirePermission("crawl", "execute"), webrainScrape)
        this.router.post("/search", this.resolveAccess, requirePermission("crawl", "execute"), webrainSearch)
        this.router.post("/extract", this.resolveAccess, requirePermission("crawl", "execute"), webrainExtract)
        this.router.post("/pdf", this.resolveAccess, requirePermission("crawl", "execute"), webrainPdf)

        /**
         * Monitors — create, update, delete.
         *
         * Free-resolving on purpose. A monitor is one bounded, infrequent read of
         * one page, the same cost class as a search, and `requirePaidAccess` is
         * the ONLY place `req.accessMode` is otherwise set — gating here would
         * 402 a free caller before the entitlement was resolved at all. What
         * bounds a free account is `MONITOR_MAX_PER_USER`, enforced in the
         * handler, because the resource being protected is the shared worker pool
         * rather than revenue.
         *
         * `update` and `delete` are POSTs rather than PUT/DELETE because the
         * surface is registered identically on the Elysia host, where the client
         * already speaks these four paths.
         */
        this.router.post("/monitor/create", this.resolveAccess, requirePermission("crawl", "execute"), monitorCreate)
        this.router.post("/monitor/update", this.resolveAccess, requirePermission("crawl", "execute"), monitorUpdate)
        this.router.post("/monitor/delete", this.resolveAccess, requirePermission("crawl", "execute"), monitorDelete)

        // Enqueue a stream Crawl Task
        // this.router.post("/crawl/stream/job", crawlagent.multiCrawlEnqueue)

        /* Machines by Arachnefly */

        // Deploy a new Machine
        this.router.post("/machines/deploy", this.requirePaidAccess, requirePermission("machine", "deploy"), arachnefly.deployMachine)
        // this.router.post('/api/machines/logs', receiveLogs)

        /**
         * The webrain configuration writes — platform admin only, the same
         * `platform` gate as the GET above. Both go through
         * `saveWebrainConfig`, which drops the store's 30s cache, so a rotation
         * or a pool swap is visible on the next request rather than the next
         * deploy. A token is echoed ONLY when this call minted it.
         */
        this.router.post("/webrain/config/token", requirePermission("platform", "write"), setWebrainToken)
        this.router.post("/webrain/config/proxies", requirePermission("platform", "write"), setWebrainProxies)

        /**
         * Stored artifacts — the writes. Same gate rationale as the GETs above:
         * no billing block, and `storage.write` resolves only through `self`,
         * which `requirePermission` derives from the verified token.
         *
         * `presign` carries `storage.read`, not `storage.write`: it mints a URL
         * for one object the caller may already read. It changes nothing.
         */
        this.router.post("/storage/save", requirePermission("storage", "write"), storageSave)
        this.router.post("/storage/presign", requirePermission("storage", "read"), storagePresign)
        this.router.post("/storage/settings", requirePermission("storage", "write"), storageSetSettings)
    }

    /**
       * https Router Put
       */

    /**
     * httpRoutesPut
     */
    private httpRoutesPut(): void {
        this.router.put("/orgs/:orgId", requirePermission("organization", "manage"), this.renameOrganization)

        /**
         * Machines by Arachnefly
         */

        // Start a Machine
        this.router.put("/machines/machine/:machineId/start", this.requirePaidAccess, requirePermission("machine", "update"), arachnefly.startMachine)

        // Suspend a Machine
        this.router.put("/machines/machine/:machineId/suspend", this.requirePaidAccess, requirePermission("machine", "update"), arachnefly.suspendMachine)

        // Stop a Machine
        this.router.put("/machines/machine/:machineId/stop", this.requirePaidAccess, requirePermission("machine", "update"), arachnefly.stopMachine)


        /**
         * Crawler Management by crawlagent
        */

        // Cancel a Crawl Task
        // this.router.put("/crawl/job/:tempTaskId/cancel", crawlagent.cancelTask)
    }

    /**
     * https Router Delete
     */

    /**
     * httpRoutesDelete
     */
    private httpRoutesDelete(): void {
        this.router.delete("/orgs/:orgId/members/:userId", requirePermission("organization", "manage"), this.removeOrganizationMember)

        /**
         * Machines by Arachnefly
         */
        // Destroy a Machine
        this.router.delete("/machines/machine/:machineId", this.requirePaidAccess, requirePermission("machine", "delete"), arachnefly.destroyMachine)
    }
}

// ---- Helpers (enumeration-safe) ----
// async function getOrCreateUserByEmail(email: string, profile = {}) {
//   try {
//     const user = await auth.getUserByEmail(email)
//     return user; // Do not reveal to client
//   } catch (e: any) {
//     if (e.code === "auth/user-not-found") {
//       // Create without revealing existence
//       return await auth.createUser({
//         email,
//         emailVerified: !!profile.emailVerified,
//         displayName: profile.displayName || undefined,
//         photoURL: profile.picture || undefined,
//       })
//     }
//     throw e
//   }
// }

export { ReverseAPIProxy }
