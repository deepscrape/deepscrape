/* eslint-disable max-len */
import {DecodedIdToken} from "firebase-admin/auth"

export type OrgRole = "owner" | "admin" | "member" | "viewer"
export type EffectiveRole = OrgRole | "self"

export type AuthorizationSubject = {
    uid: string
    isPlatformAdmin: boolean
    memberships: Record<string, OrgRole>
    claims?: DecodedIdToken
}

export type AuthorizationContext = {
    now: number
}

type AuthResources = {
    ai: {
        dataType: { orgId?: string; ownerId?: string }
        action: "execute"
    }
    crawl: {
        dataType: { orgId?: string; ownerId?: string }
        action: "execute" | "read"
    }
    machine: {
        dataType: { orgId?: string; ownerId?: string }
        action: "read" | "deploy" | "update" | "delete"
    }
    billing: {
        dataType: { orgId?: string; ownerId?: string }
        action: "read" | "manage"
    }
    organization: {
        dataType: { orgId?: string; ownerId?: string }
        action: "read" | "manage" | "invite"
    }
    /**
     * The account itself: suspension and erasure.
     *
     * Deliberately scoped by `ownerId` and granted to no org role. A tenant admin
     * removing someone from their org is `organization:manage` on a membership — it
     * must never reach here. Deleting the human is between that human and the
     * platform; an org admin holds no consent to destroy a third party's data, which
     * may also span orgs the admin cannot see.
     *
     * `suspend` is granted to no role at all: it resolves true only through the
     * platform-admin short-circuit in `canPerform`, which is the intent.
     */
    account: {
        dataType: { ownerId?: string }
        action: "read" | "suspend" | "delete"
    }
    /**
     * Platform configuration: the webrain MCP token and the egress pool.
     *
     * Admin-only by construction, exactly like `account:suspend`: no role in
     * POLICIES is granted `platform`, so the only path through `canPerform` is
     * the platform-admin short-circuit. `read` is the status route; `write` is a
     * credential rotation or a pool replacement.
     */
    platform: {
        dataType: { orgId?: string; ownerId?: string }
        action: "read" | "write"
    }
    /**
     * Stored artifacts: the shared URL cache and the caller's own objects.
     *
     * Granted to `self` only, and that IS the isolation: the routes derive an
     * object's namespace from the caller's VERIFIED uid, and `self` is the role
     * that resolves only when the request's ownerId equals that uid. No org
     * role is granted either action, because "my org's admin may read the files
     * I downloaded while signed in" is not a rule anyone agreed to.
     */
    storage: {
        dataType: { orgId?: string; ownerId?: string }
        action: "read" | "write"
    }
}

type PermissionCheck<Key extends keyof AuthResources> =
    | boolean
    | ((subject: AuthorizationSubject, data: AuthResources[Key]["dataType"], context: AuthorizationContext) => boolean)

type RolePolicies = {
    [R in EffectiveRole]: Partial<{
        [Key in keyof AuthResources]: Partial<{
            [Action in AuthResources[Key]["action"]]: PermissionCheck<Key>
        }>
    }>
}

const POLICIES = {
  owner: {
    ai: {execute: true},
    crawl: {execute: true, read: true},
    machine: {read: true, deploy: true, update: true, delete: true},
    billing: {read: true, manage: true},
    organization: {read: true, manage: true, invite: true},
  },
  admin: {
    ai: {execute: true},
    crawl: {execute: true, read: true},
    machine: {read: true, deploy: true, update: true, delete: true},
    billing: {read: true, manage: true},
    organization: {read: true, invite: true},
  },
  member: {
    ai: {execute: true},
    crawl: {execute: true, read: true},
    machine: {read: true, deploy: true, update: true},
    billing: {read: true},
    organization: {read: true},
  },
  viewer: {
    crawl: {read: true},
    machine: {read: true},
    billing: {read: true},
    organization: {read: true},
  },
  // Backward-compat mode for existing single-tenant user-owned resources.
  self: {
    ai: {execute: true},
    crawl: {execute: true, read: true},
    machine: {read: true, deploy: true, update: true, delete: true},
    billing: {read: true, manage: true},
    organization: {read: true, manage: true},
    // `suspend` is intentionally absent — see the resource comment above.
    account: {read: true, delete: true},
    // Personal artifacts. Present here (the uid-scoped compat role) and absent
    // from every org role, which is what keeps one member's stored objects out
    // of another member's reach.
    storage: {read: true, write: true},
  },
} as const satisfies RolePolicies

/**
 * resolveEffectiveRoles
 * @param {*} subject
 * @param {*} data
 * @return {*}
 */
function resolveEffectiveRoles(subject: AuthorizationSubject, data?: { orgId?: string; ownerId?: string }): EffectiveRole[] {
  const roles: EffectiveRole[] = []

  if (data?.ownerId && data.ownerId === subject.uid) {
    roles.push("self")
  }

  if (data?.orgId) {
    const orgRole = subject.memberships[data.orgId]
    if (orgRole) {
      roles.push(orgRole)
    }
  }

  return roles
}

/**
 * canPerform
 * @param {*} subject
 * @param {*} resource
 * @param {*} action
 * @param {*} data
 * @param {*} context
 * @return {*}
 */
export function canPerform<Resource extends keyof AuthResources>(
  subject: AuthorizationSubject,
  resource: Resource,
  action: AuthResources[Resource]["action"],
  data?: AuthResources[Resource]["dataType"],
  context: AuthorizationContext = {now: Date.now()}
): boolean {
  if (subject.isPlatformAdmin) {
    return true
  }

  const roles = resolveEffectiveRoles(subject, data)
  if (!roles.length) {
    return false
  }

  return roles.some((role) => {
    const permission = (POLICIES as RolePolicies)[role][resource]?.[action]
    if (permission == null) {
      return false
    }

    if (typeof permission === "boolean") {
      return permission
    }

    return data != null && permission(subject, data, context)
  })
}

export type AuthResource = keyof AuthResources
export type AuthAction<Resource extends AuthResource> = AuthResources[Resource]["action"]
export type AuthData<Resource extends AuthResource> = AuthResources[Resource]["dataType"]
