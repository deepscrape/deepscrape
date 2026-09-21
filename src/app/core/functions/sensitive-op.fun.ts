/**
 * Helpers for Firebase's "sensitive operation" gate.
 *
 * Identity Toolkit refuses a handful of operations — enrolling or removing a second factor,
 * deleting an account, changing a password — unless the user authenticated recently, and it
 * reports the refusal as CREDENTIAL_TOO_OLD_LOGIN_AGAIN. The session itself outlives that
 * window, so a user can be fully signed in and still refused.
 *
 * These live outside AuthService so the decision and the retry can be tested directly: the
 * service spec harness replaces AuthService with a stub, so constructing the real service
 * there pulls in the whole Firebase surface.
 */

/**
 * Whether the SDK is reporting that the session is too old for the operation.
 *
 * The server code arrives two ways: mapped by the SDK to `auth/requires-recent-login`, or as
 * the raw CREDENTIAL_TOO_OLD_LOGIN_AGAIN text inside a message — both are checked.
 *
 * @param {*} error Error thrown by the SDK.
 * @return {boolean} Whether a fresh authentication is required.
 */
export function isStaleCredentialError(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code || '').toLowerCase()
  const message = String((error as { message?: unknown } | null)?.message || '').toUpperCase()
  return code === 'auth/requires-recent-login' || message.includes('CREDENTIAL_TOO_OLD_LOGIN_AGAIN')
}

/**
 * Run an operation, re-authenticating exactly once if the session is refused as stale.
 *
 * One retry only: `refresh` is expected to open a provider popup, so looping would keep
 * reopening it. When `refresh` reports it could not re-authenticate — a password or phone
 * account needs a typed credential, and a passkey session has no provider to re-authenticate
 * against — the original error is surfaced instead of being swallowed.
 *
 * @param {*} operation The sensitive call to attempt.
 * @param {*} refresh Re-authenticates; resolves true when the session was refreshed.
 * @return {Promise<T>} The operation result.
 */
export async function retryOnceAfterFreshCredential<T>(
  operation: () => Promise<T>,
  refresh: () => Promise<boolean>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!isStaleCredentialError(error)) {
      throw error
    }

    const refreshed = await refresh()
    if (!refreshed) {
      throw error
    }

    return await operation()
  }
}
