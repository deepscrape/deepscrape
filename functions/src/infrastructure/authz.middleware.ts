/* eslint-disable max-len */
import {NextFunction, Request, Response} from "express"
import {db} from "../app/config"
import {redis} from "../app/cacheConfig"
import {MEMBERSHIPS_CACHE_TTL_SECONDS, membershipsKey} from "../../../src/config/redis-keys"
import {
  AuthAction,
  AuthData,
  AuthResource,
  AuthorizationSubject,
  OrgRole,
  canPerform,
} from "../domain/authz.domain"
import {env} from "../config"

type RequirePermissionOptions<Resource extends AuthResource> = {
    getData?: (req: Request) => Partial<AuthData<Resource>>
}

type LocalsWithAuthz = {
    authzSubject?: AuthorizationSubject
    authzDecisionEvent?: AuthorizationDecisionEvent
}

const AUTHZ_STRICT_ORG_MODE = env.AUTHZ_STRICT_ORG_MODE === "true"

type AuthorizationDecisionEvent = {
    version: "v1"
    timestamp: number
    correlationId: string
    subjectUid: string
    isPlatformAdmin: boolean
    resource: string
    action: string
    result: "allow" | "deny"
    reasonCode: string
    orgId?: string
    ownerId?: string
    source: "middleware"
    mode: "strict" | "compat"
}

/**
 * getCorrelationId
 * @param {*} req
 * @return {*}
 */
function getCorrelationId(req: Request): string {
  const requestId = req.headers["x-request-id"]
  if (typeof requestId === "string" && requestId.trim().length > 0) {
    return requestId.trim()
  }

  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * buildDecisionEvent
 * @param {*} req
 * @param {*} subject
 * @param {*} resource
 * @param {*} action
 * @param {*} data
 * @param {*} result
 * @param {*} reasonCode
 * @return {*}
 */
function buildDecisionEvent<Resource extends AuthResource>(
  req: Request,
  subject: AuthorizationSubject,
  resource: Resource,
  action: AuthAction<Resource>,
  data: AuthData<Resource>,
  result: "allow" | "deny",
  reasonCode: string
): AuthorizationDecisionEvent {
  return {
    version: "v1",
    timestamp: Date.now(),
    correlationId: getCorrelationId(req),
    subjectUid: subject.uid,
    isPlatformAdmin: subject.isPlatformAdmin,
    resource,
    action,
    result,
    reasonCode,
    orgId: data.orgId,
    ownerId: data.ownerId,
    source: "middleware",
    mode: AUTHZ_STRICT_ORG_MODE ? "strict" : "compat",
  }
}

/**
 * emitAuthorizationDecision
 * @param {*} event
 */
function emitAuthorizationDecision(event: AuthorizationDecisionEvent): void {
  console.info("[authz-decision]", JSON.stringify(event))
}

/**
 * Rebuild a memberships map from its cached JSON.
 *
 * The null prototype is not decorative: `canPerform` indexes this map with an
 * attacker-supplied `orgId`, and on a plain object `"constructor"` resolves to a
 * prototype member. `JSON.parse` hands back a normal object, so the map is rebuilt
 * rather than returned directly.
 *
 * @param {unknown} raw Cached JSON, or whatever the cache returned on a miss.
 * @return {Record<string, OrgRole> | null} The map, or null when nothing usable is cached.
 */
export function parseCachedMemberships(raw: unknown): Record<string, OrgRole> | null {
  if (typeof raw !== "string" || !raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object") {
      return null
    }

    const memberships: Record<string, OrgRole> = Object.create(null)
    for (const [orgId, role] of Object.entries(parsed)) {
      if (typeof role === "string") {
        memberships[orgId] = role as OrgRole
      }
    }

    return memberships
  } catch {
    return null
  }
}

/**
 * loadMemberships
 * @param {*} uid
 */
async function loadMemberships(uid: string): Promise<Record<string, OrgRole>> {
  const cacheKey = membershipsKey(uid)

  try {
    const cached = parseCachedMemberships(await redis.get(cacheKey))
    if (cached) {
      return cached
    }
  } catch (error) {
    console.warn("authz: membership cache read failed, using Firestore", error)
  }

  const snapshot = await db.collection("memberships")
    .where("userId", "==", uid)
    .limit(100)
    .get()

  // ponytail: null-prototype map. With `{}`, a request carrying orgId "constructor"
  // (or "toString"/"valueOf") resolved memberships[orgId] to an Object.prototype
  // member — truthy — so canPerform indexed POLICIES[<function>][resource], threw a
  // TypeError, and the middleware turned it into a 500. An untrusted key must never
  // reach a plain object.
  const memberships: Record<string, OrgRole> = Object.create(null)

  for (const doc of snapshot.docs) {
    const data = doc.data() as { orgId?: string; role?: OrgRole }
    if (!data.orgId || !data.role) {
      continue
    }

    memberships[data.orgId] = data.role
  }

  // The empty map is cached too on purpose: an account with no memberships is the
  // common case, and that query still bills a read on every request.
  // ponytail: 60s TTL, no write-through invalidation — a removed role keeps working
  // for up to a minute. Add invalidation on the membership write paths if a
  // revocation ever has to bite immediately.
  try {
    await redis.setex(cacheKey, MEMBERSHIPS_CACHE_TTL_SECONDS, JSON.stringify(memberships))
  } catch (error) {
    console.warn("authz: membership cache write failed", error)
  }

  return memberships
}

/**
 * getOrgIdFromRequest
 * @param {*} req
 * @return {*}
 */
function getOrgIdFromRequest(req: Request): string | undefined {
  if (typeof req.params?.orgId === "string" && req.params.orgId.trim().length > 0) {
    return req.params.orgId.trim()
  }

  const headerOrgId = req.headers["x-org-id"]
  if (typeof headerOrgId === "string" && headerOrgId.trim().length > 0) {
    return headerOrgId.trim()
  }

  if (typeof req.body?.orgId === "string" && req.body.orgId.trim().length > 0) {
    return req.body.orgId.trim()
  }

  if (typeof req.query?.orgId === "string" && req.query.orgId.trim().length > 0) {
    return req.query.orgId.trim()
  }

  return undefined
}

// ponytail: a getOwnerIdFromRequest() used to live here and read ownerId from
// params/body/query. It was applied even when an orgId was present, so an
// attacker sending `?ownerId=<own-uid>` to an org route was granted the "self"
// role on top of the (failing) org check, and canPerform's roles.some() let that
// satisfy `organization:read` / `organization:manage` — cross-tenant roster read
// and org rename. Ownership is derived server-side only now: see the ownerId
// fallback in requirePermission. Do not reintroduce a request-sourced ownerId.

/**
 * buildSubject
 * @param {*} req
 * @param {*} res
 */
async function buildSubject(req: Request, res: Response): Promise<AuthorizationSubject | null> {
  const uid = req.user?.uid
  if (!uid) {
    return null
  }

  const locals = res.locals as LocalsWithAuthz
  if (locals.authzSubject) {
    return locals.authzSubject
  }

  const role = (req.user as Record<string, unknown> | undefined)?.["role"]
  const subject: AuthorizationSubject = {
    uid,
    isPlatformAdmin: role === "admin",
    memberships: await loadMemberships(uid),
    claims: req.user,
  }

  locals.authzSubject = subject
  return subject
}

/**
 * requirePermission
 * @param {*} resource
 * @param {*} action
 * @param {*} options
 * @return {*}
 */
export function requirePermission<Resource extends AuthResource>(
  resource: Resource,
  action: AuthAction<Resource>,
  options: RequirePermissionOptions<Resource> = {}
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const subject = await buildSubject(req, res)
      const locals = res.locals as LocalsWithAuthz
      if (!subject) {
        res.status(401).json({error: "unauthorized", code: "unauthorized"})
        return
      }

      const inferredOrgId = getOrgIdFromRequest(req)

      const inferredData: Partial<AuthData<Resource>> = {
        orgId: inferredOrgId,
        // ponytail: server-derived only. Owner-scoped resources (no orgId in the
        // request) stay single-tenant, keyed by the caller's own uid; anything
        // carrying an orgId is authorised by org membership alone. Never read
        // ownerId from the request — see the note above requirePermission.
        ownerId: inferredOrgId ? undefined : subject.uid,
      } as Partial<AuthData<Resource>>

      const extraData = options.getData?.(req) ?? {}
      const data = {
        ...inferredData,
        ...extraData,
      } as AuthData<Resource>

      const allowed = canPerform(subject, resource, action, data)
      locals.authzDecisionEvent = buildDecisionEvent(
        req,
        subject,
        resource,
        action,
        data,
        allowed ? "allow" : "deny",
        allowed ? "policy_allow" : "policy_deny",
      )
      emitAuthorizationDecision(locals.authzDecisionEvent)

      if (!allowed) {
        res.status(403).json({error: "forbidden", code: "forbidden"})
        return
      }

      next()
    } catch (error) {
      console.error("Authorization middleware failed:", error)
      res.status(500).json({error: "internal", code: "internal"})
    }
  }
}
