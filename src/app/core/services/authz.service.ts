import { DestroyRef, inject, Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { User } from '@angular/fire/auth';
import { Observable } from 'rxjs/internal/Observable';
import { BehaviorSubject } from 'rxjs/internal/BehaviorSubject';
import { combineLatest } from 'rxjs';
import { map } from 'rxjs/internal/operators/map';
import { switchMap } from 'rxjs/internal/operators/switchMap';
import { AuthService } from './auth.service';
import { FirestoreService } from './firestore.service';
import { LocalStorage } from './storage.service';

type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';
type EffectiveRole = OrgRole | 'self';

type AuthResources = {
  ai: {
    dataType: { orgId?: string; ownerId?: string };
    action: 'execute';
  };
  crawl: {
    dataType: { orgId?: string; ownerId?: string };
    action: 'execute' | 'read';
  };
  machine: {
    dataType: { orgId?: string; ownerId?: string };
    action: 'read' | 'deploy' | 'update' | 'delete';
  };
  billing: {
    dataType: { orgId?: string; ownerId?: string };
    action: 'read' | 'manage';
  };
  organization: {
    dataType: { orgId?: string; ownerId?: string };
    action: 'read' | 'manage' | 'invite';
  };
};

type PermissionCheck<Key extends keyof AuthResources> =
  | boolean
  | ((subject: AuthorizationSubject, data: AuthResources[Key]['dataType']) => boolean);

type RolePolicies = {
  [R in EffectiveRole]: Partial<{
    [Key in keyof AuthResources]: Partial<{
      [Action in AuthResources[Key]['action']]: PermissionCheck<Key>;
    }>;
  }>;
};

type AuthorizationSubject = {
  uid: string;
  isPlatformAdmin: boolean;
  memberships: Record<string, OrgRole>;
};

type MembershipDoc = {
  orgId?: string;
  userId?: string;
  role?: OrgRole;
};

const ACTIVE_ORG_STORAGE_KEY = 'deepscrape.active_org_id';
const STRICT_ORG_MODE_STORAGE_KEY = 'deepscrape.authz_strict_org_mode';

const POLICIES = {
  owner: {
    ai: { execute: true },
    crawl: { execute: true, read: true },
    machine: { read: true, deploy: true, update: true, delete: true },
    billing: { read: true, manage: true },
    organization: { read: true, manage: true, invite: true },
  },
  admin: {
    ai: { execute: true },
    crawl: { execute: true, read: true },
    machine: { read: true, deploy: true, update: true, delete: true },
    billing: { read: true, manage: true },
    organization: { read: true, invite: true },
  },
  member: {
    ai: { execute: true },
    crawl: { execute: true, read: true },
    machine: { read: true, deploy: true, update: true },
    billing: { read: true },
    organization: { read: true },
  },
  viewer: {
    crawl: { read: true },
    machine: { read: true },
    billing: { read: true },
    organization: { read: true },
  },
  self: {
    ai: { execute: true },
    crawl: { execute: true, read: true },
    machine: { read: true, deploy: true, update: true, delete: true },
    billing: { read: true, manage: true },
    organization: { read: true, manage: true },
  },
} as const satisfies RolePolicies;

function resolveEffectiveRoles(
  subject: AuthorizationSubject,
  data?: { orgId?: string; ownerId?: string },
): EffectiveRole[] {
  const roles: EffectiveRole[] = [];

  if (data?.ownerId && data.ownerId === subject.uid) {
    roles.push('self');
  }

  if (data?.orgId) {
    const orgRole = subject.memberships[data.orgId];
    if (orgRole) {
      roles.push(orgRole);
    }
  }

  return roles;
}

function canPerform<Resource extends keyof AuthResources>(
  subject: AuthorizationSubject,
  resource: Resource,
  action: AuthResources[Resource]['action'],
  data?: AuthResources[Resource]['dataType'],
): boolean {
  if (subject.isPlatformAdmin) {
    return true;
  }

  const roles = resolveEffectiveRoles(subject, data);
  if (!roles.length) {
    return false;
  }

  return roles.some((role) => {
    const permission = (POLICIES as RolePolicies)[role][resource]?.[action];
    if (permission == null) {
      return false;
    }

    if (typeof permission === 'boolean') {
      return permission;
    }

    return data != null && permission(subject, data);
  });
}

@Injectable({
  providedIn: 'root',
})
export class AuthzService {
  private destroyRef = inject(DestroyRef);
  private authService = inject(AuthService);
  private firestoreService = inject(FirestoreService);
  private localStorage = inject(LocalStorage);

  private membershipsSubject = new BehaviorSubject<Record<string, OrgRole>>({});
  private membershipsReadySubject = new BehaviorSubject<boolean>(false);
  private activeOrgIdSubject = new BehaviorSubject<string | null>(
    this.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY),
  );
  private strictOrgModeSubject = new BehaviorSubject<boolean>(
    this.localStorage.getItem(STRICT_ORG_MODE_STORAGE_KEY) === 'true',
  );

  private membershipsLoadedForUid: string | null = null;
  private lastAuthenticatedUid: string | null = null;

  readonly memberships$ = this.membershipsSubject.asObservable();
  readonly membershipsReady$ = this.membershipsReadySubject.asObservable();
  readonly activeOrgId$ = this.activeOrgIdSubject.asObservable();
  readonly strictOrgMode$ = this.strictOrgModeSubject.asObservable();

  constructor() {
    this.authService.user$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((user) => {
        if (!user?.uid) {
          this.lastAuthenticatedUid = null;
          this.membershipsLoadedForUid = null;
          this.membershipsSubject.next({});
          this.membershipsReadySubject.next(false);
          this.setActiveOrgId(null);
          return;
        }

        // Account switched in same browser session: clear potentially stale org context.
        if (this.lastAuthenticatedUid && this.lastAuthenticatedUid !== user.uid) {
          this.membershipsLoadedForUid = null;
          this.membershipsSubject.next({});
          this.membershipsReadySubject.next(false);
          this.setActiveOrgId(user.defaultOrgId || null);
        }

        this.lastAuthenticatedUid = user.uid;

        const defaultOrgId = user.defaultOrgId || null;
        if (defaultOrgId && !this.activeOrgIdSubject.value) {
          this.setActiveOrgId(defaultOrgId);
        }

        if (this.membershipsLoadedForUid !== user.uid) {
          this.membershipsReadySubject.next(false);
          void this.refreshMemberships(user.uid, defaultOrgId);
          return;
        }

        this.membershipsReadySubject.next(true);
      });
  }

  get activeOrgId(): string | null {
    return this.activeOrgIdSubject.value;
  }

  setActiveOrgId(orgId: string | null): void {
    if (orgId) {
      this.localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, orgId);
    } else {
      this.localStorage.removeItem(ACTIVE_ORG_STORAGE_KEY);
    }

    this.activeOrgIdSubject.next(orgId);
  }

  setStrictOrgMode(enabled: boolean): void {
    if (enabled) {
      this.localStorage.setItem(STRICT_ORG_MODE_STORAGE_KEY, 'true');
    } else {
      this.localStorage.removeItem(STRICT_ORG_MODE_STORAGE_KEY);
    }

    this.strictOrgModeSubject.next(enabled);
  }

  isStrictOrgModeEnabled(): boolean {
    return this.strictOrgModeSubject.value;
  }

  can$<Resource extends keyof AuthResources>(
    resource: Resource,
    action: AuthResources[Resource]['action'],
    data?: Partial<AuthResources[Resource]['dataType']>,
  ): Observable<boolean> {
    return combineLatest([this.authService.user$, this.memberships$, this.activeOrgId$]).pipe(
      map(([user, memberships, activeOrgId]) => {
        if (!user?.uid) {
          return false;
        }

        const subject: AuthorizationSubject = {
          uid: user.uid,
          isPlatformAdmin: this.authService.isAdmin,
          memberships,
        };

        const mergedData = {
          orgId: data?.orgId || activeOrgId || undefined,
          // ponytail: must mirror requirePermission exactly, or the UI shows controls
          // the API then 403s. The server stopped reading ownerId from the request
          // (it was the cross-tenant IDOR in authz.middleware.ts), so a
          // template-supplied data.ownerId must not make the client predict `self`.
          // Org scope ⇒ no ownerId; otherwise the caller owns their own resources.
          ownerId: (data?.orgId || activeOrgId) ? undefined : user.uid,
        } as AuthResources[Resource]['dataType'];

        return canPerform(subject, resource, action, mergedData);
      }),
    );
  }

  hasPlatformAdminAccess$(): Observable<boolean> {
    return this.firestoreService.authState().pipe(
      switchMap(async (user: User | null) => {
        if (!user) {
          return false;
        }

        if (this.authService.isAdmin) {
          return true;
        }

        const tokenResult = await user.getIdTokenResult();
        if (tokenResult.claims?.['role'] === 'admin') {
          return true;
        }

        const userData = await this.firestoreService.getUserData(user.uid);
        const role = String(userData?.role || '').trim().toLowerCase();
        return role === 'admin';
      }),
    );
  }

  private async refreshMemberships(uid: string, defaultOrgId: string | null): Promise<void> {
    try {
      const db = this.firestoreService.getInstanceDB('easyscrape');
      const membershipsRef = this.firestoreService.collection(db, 'memberships');
      const membershipsQuery = this.firestoreService.query(
        membershipsRef,
        this.firestoreService.where('userId', '==', uid),
        this.firestoreService.limit(100),
      );
      const snapshot = await this.firestoreService.getDocs(membershipsQuery);

      const nextMemberships: Record<string, OrgRole> = {};
      snapshot.forEach((doc) => {
        const data = doc.data() as MembershipDoc;
        if (data.orgId && data.role) {
          nextMemberships[data.orgId] = data.role;
        }
      });

      this.membershipsLoadedForUid = uid;
      this.membershipsSubject.next(nextMemberships);
      this.membershipsReadySubject.next(true);

      const currentActiveOrgId = this.activeOrgIdSubject.value;
      const hasCurrentActiveOrg = !!currentActiveOrgId && !!nextMemberships[currentActiveOrgId];
      if (hasCurrentActiveOrg) {
        return;
      }

      if (defaultOrgId && nextMemberships[defaultOrgId]) {
        this.setActiveOrgId(defaultOrgId);
        return;
      }

      const firstMembershipOrgId = Object.keys(nextMemberships)[0] || null;
      this.setActiveOrgId(firstMembershipOrgId);
    } catch (error) {
      console.error('Failed to refresh org memberships:', error);
      this.membershipsLoadedForUid = uid;
      this.membershipsSubject.next({});
      this.membershipsReadySubject.next(true);
      if (!this.activeOrgIdSubject.value) {
        this.setActiveOrgId(defaultOrgId || null);
      }
    }
  }
}