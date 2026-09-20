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
