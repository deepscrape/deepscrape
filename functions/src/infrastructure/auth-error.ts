/**
 * Firebase Admin error codes, read from exactly one place.
 *
 * Why: this six-liner was copied into `handlers/fire_auth.ts`,
 * `handlers/phone_auth.ts`, `infrastructure/authproxy.ts` and
 * `infrastructure/syncaiapi.ts`. One of those copies had already drifted to
 * return `undefined` instead of `""` — behaviourally identical at every call
 * site today, which is exactly how that kind of drift survives review.
 */

/**
 * The `code` property of a Firebase/Google API error, or `""` when absent.
 * @param {unknown} error Caught value of unknown shape.
 * @return {string} Machine-readable error code.
 */
export const authErrorCode = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code?: unknown }).code || "")
  }

  return ""
}
