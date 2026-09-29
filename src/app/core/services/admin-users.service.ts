import { Injectable, inject } from '@angular/core'
import { FirestoreService } from './firestore.service'

/** Which slice of accounts the console is showing. */
export type AdminUserFilter = 'all' | 'banned' | 'deleted' | 'admins'

/** One row in the account list. Deliberately PII-minimal: no phone, IP or device data. */
export type AdminUserListItem = {
  uid: string
  email: string | null
  username: string | null
  role: string
  plan: string
  status: string | null
  created_At: string | null
  isBanned: boolean
  banReason: string | null
  banExpires: string | null
  isDeleted: boolean
  deletedAt: string | null
  /** Erasure deadline, set once deletion is confirmed. Null until then. */
  purgeAfter: string | null
  /** Set once the account has actually been erased. */
  purgedAt: string | null
  deletedBy: string | null
  deletionId: string | null
}

export type AdminUserListResponse = {
  items: AdminUserListItem[]
  hasMore: boolean
  nextLastDocId: string | null
  pageSize: number
}

/** Past action recorded against an account. */
export type AdminAuditEntry = {
  id: string
  action: string | null
  actorUid: string | null
  actorType: string | null
  reason: string | null
  at: string | null
  purgeAfter: string | null
  purgedAt: string | null
  sessionsRevoked: number | null
}

export type AdminUserOverview = {
  uid: string
  email: string | null
  username: string | null
  role: string
  plan: string
  status: string | null
  created_At: string | null
  /** Auth-disabled is the authoritative lockout signal, unlike the Firestore flags. */
  authDisabled: boolean | null
  authLastSignIn: string | null
  activeSessions: number
  profileStatus: (Record<string, unknown> & {
    isBanned?: boolean
    isDeleted?: boolean
    banReason?: string | null
    deleteReason?: string | null
    banExpires?: string | null
    deletedAt?: string | null
    purgeAfter?: string | null
    purgedAt?: string | null
    deletedBy?: string | null
    deletionId?: string | null
  }) | null
  history: AdminAuditEntry[]
}

export type AdminSuspendResult = {
  success: boolean
  auditId: string
  sessionsRevoked: number
  banExpires: string | null
}

export type AdminScheduleDeletionResult = {
  success: boolean
  deletionId: string
  purgeAfter: string
  sessionsRevoked: number
}

/**
 * Platform-admin account controls.
 *
 * Every method here maps to a callable that resolves the caller's role **fresh** (no
 * cached role resolution) and re-checks it through the shared authorization policy, so a
 * just-demoted admin cannot use this surface. The server is the gate; this service is
 * only the transport.
 *
 * Nothing here erases data. `scheduleDeletion` locks the account and sets a deadline;
 * the nightly purger does the erasing, which is what makes an admin's mistake
 * recoverable and the audit trail complete.
 */
@Injectable({
  providedIn: 'root',
})
export class AdminUsersService {
  private readonly firestoreService = inject(FirestoreService)

  /**
   * One page of accounts.
   *
   * @param {object} args Filter, search term and cursor.
   * @return {Promise<AdminUserListResponse>} The page and its cursor.
   */
  listUsers(args: {
    search?: string
    pageSize?: number
    lastDocId?: string | null
    filter?: AdminUserFilter
  } = {}): Promise<AdminUserListResponse> {
    return this.firestoreService.callFunction<typeof args, AdminUserListResponse>(
      'adminListUsers',
      args,
    )
  }

  /**
   * One account with its live session count and recent audit history.
   *
   * @param {string} userId The account to load.
   * @return {Promise<AdminUserOverview>} The account overview.
   */
  getUserOverview(userId: string): Promise<AdminUserOverview> {
    return this.firestoreService.callFunction<{ userId: string }, AdminUserOverview>(
      'adminGetUserOverview',
      { userId },
    )
  }

  /**
   * Disable an account and sign it out everywhere. Reversible.
   *
   * @param {object} args Target, reason and optional duration in days.
   * @return {Promise<AdminSuspendResult>} Audit id and revoke count.
   */
  suspendUser(args: { userId: string; reason: string; days?: number }): Promise<AdminSuspendResult> {
    return this.firestoreService.callFunction<typeof args, AdminSuspendResult>(
      'adminSuspendUser',
      args,
    )
  }

  /**
   * Re-enable a suspended account.
   *
   * @param {object} args Target and optional reason.
   * @return {Promise<{ success: boolean; auditId: string }>} Audit id.
   */
  unsuspendUser(args: { userId: string; reason?: string }): Promise<{ success: boolean; auditId: string }> {
    return this.firestoreService.callFunction<typeof args, { success: boolean; auditId: string }>(
      'adminUnsuspendUser',
      args,
    )
  }

  /**
   * Lock the account and schedule erasure after the grace window.
   *
   * @param {object} args Target and a required reason.
   * @return {Promise<AdminScheduleDeletionResult>} Deletion id and purge deadline.
   */
  scheduleAccountDeletion(args: { userId: string; reason: string }): Promise<AdminScheduleDeletionResult> {
    return this.firestoreService.callFunction<typeof args, AdminScheduleDeletionResult>(
      'adminScheduleAccountDeletion',
      args,
    )
  }

  /**
   * Restore an account before its purge deadline. Fails once erased, by design.
   *
   * @param {object} args Target and optional reason.
   * @return {Promise<object>} Audit id and the masked restored address.
   */
  cancelAccountDeletion(args: {
    userId: string
    reason?: string
  }): Promise<{ success: boolean; auditId: string; restoredEmail: string | null }> {
    return this.firestoreService.callFunction<
      typeof args,
      { success: boolean; auditId: string; restoredEmail: string | null }
    >('adminCancelAccountDeletion', args)
  }
}
