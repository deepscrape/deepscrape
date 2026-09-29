import { Injectable, inject } from '@angular/core'
import { FirestoreService } from './firestore.service'

/** Result of asking for a deletion confirmation code. */
export type AccountDeletionRequestResult = {
  /** Masked address the code was sent to, e.g. `u***@example.com`. */
  email: string
  expiresAt: string
}

/** Result of confirming a deletion. The account is locked, not yet erased. */
export type AccountDeletionConfirmResult = {
  success: boolean
  deletionId: string
  purgeAfter: string
  sessionsRevoked: number
}

/**
 * Self-service account closure.
 *
 * Three steps on purpose — request a code, confirm it, or cancel — because the middle
 * one is irreversible from the user's side. The server sets a purge deadline rather than
 * erasing anything, so a mistake is recoverable by support for the grace window.
 *
 * Kept apart from `AdminUsersService`: that surface acts on *other* accounts and is
 * gated on platform-admin claims, while this acts only on the caller's own. Merging them
 * would put admin callables one import away from a settings page.
 */
@Injectable({
  providedIn: 'root',
})
export class AccountLifecycleService {
  private readonly firestoreService = inject(FirestoreService)

  /**
   * Send a confirmation code to the account's registered address.
   *
   * @param {string} reason Optional note stored with the request.
   * @return {Promise<AccountDeletionRequestResult>} Where the code went and when it expires.
   */
  requestDeletion(reason?: string): Promise<AccountDeletionRequestResult> {
    return this.firestoreService.callFunction<{ reason?: string }, AccountDeletionRequestResult>(
      'requestMyAccountDeletion',
      { reason },
    )
  }

  /**
   * Confirm with the emailed code. This disables the account and schedules erasure.
   *
   * @param {string} code The code from the confirmation email.
   * @param {string} reason Optional note stored with the deletion.
   * @return {Promise<AccountDeletionConfirmResult>} The deletion id and purge deadline.
   */
  confirmDeletion(code: string, reason?: string): Promise<AccountDeletionConfirmResult> {
    return this.firestoreService.callFunction<
      { code: string; reason?: string },
      AccountDeletionConfirmResult
    >('confirmMyAccountDeletion', { code, reason })
  }

  /**
   * Discard a pending request before it is confirmed.
   *
   * @return {Promise<{ success: boolean; cancelled: boolean }>} Whether a request was discarded.
   */
  cancelDeletion(): Promise<{ success: boolean; cancelled: boolean }> {
    return this.firestoreService.callFunction<void, { success: boolean; cancelled: boolean }>(
      'cancelMyAccountDeletion',
    )
  }
}
