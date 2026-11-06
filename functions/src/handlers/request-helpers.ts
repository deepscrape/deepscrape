/* eslint-disable object-curly-spacing */
/**
 * The two helpers every handler in this directory used to define for itself.
 *
 * Why they live here now
 * ----------------------
 * `uidOf` was written out in EIGHT files and `errorLabel` in FOUR, and the
 * copies had already drifted before they were consolidated:
 *
 *   - the uid rule appeared as both `uid.length` and `uid.length > 0`, two
 *     spellings of one predicate;
 *   - the twelve docblocks said the same thing seven different ways.
 *
 * Identical behaviour today is not the argument for this file. Two reasons are.
 *
 * `errorLabel` is a SECURITY control
 * ----------------------------------
 * A caught error's MESSAGE can quote the resource path it failed on, and for a
 * Secret Manager access that path is the one field a credential could ride in —
 * an error string is exactly the sort of value that ends up in a log, a bug
 * report or a stack trace. So the rule is: log the class NAME, never the message.
 *
 * Written out four times, that rule held only as long as nobody edited one copy.
 * A single debugging edit adding `error.message` to the file being investigated
 * would have leaked a path while the other three stayed safe, and NO gate would
 * have caught it: `tsc` cannot see it, lint has no rule for it, and the suite
 * does not assert log content. One definition is the enforcement.
 *
 * `uidOf` decides what "authenticated" means
 * ------------------------------------------
 * Eight independent definitions of that predicate is eight answers that can
 * disagree. An edit that dropped the `typeof` check in one file would leave that
 * handler treating a non-string uid as a caller while the other seven refused it,
 * and every gate would stay green. Both members of the family are now the kind
 * of question with one answer.
 *
 * What deliberately did NOT come along
 * ------------------------------------
 * `bodyOf` and `fail` are also duplicated across handlers, and they are NOT here
 * because they are not equivalent: `browser-sessions.ts` returns raw `unknown`
 * from `bodyOf` while `monitors.ts` and `storage.ts` normalise absent/null to
 * `{}`, and `fail` takes `code` in one file and `error` in another. Unifying
 * either would CHANGE BEHAVIOUR, which is a decision rather than a refactor. See
 * `references/performance-and-efficiency.md` §7.
 */
import { Request } from "express"

/**
 * The caller's uid, or undefined when the token carried none.
 *
 * `req.user` is populated by the auth middleware; a request that reached a
 * handler without it is unauthenticated, and `undefined` is the answer that
 * makes the caller choose a status rather than assume one. The `typeof` check is
 * load-bearing rather than defensive: `req.user` is typed loosely, and without
 * it a non-string value would be returned as a uid and used to build a document
 * path.
 *
 * `uid.length > 0` rather than a bare `uid.length`, because a truthiness test on
 * a number is the kind of thing a reader has to stop and evaluate. The two are
 * equivalent; one of them says what it means.
 * @param {Request} req The request.
 * @return {string | undefined} The verified uid.
 */
export const uidOf = (req: Request): string | undefined => {
  const uid = req.user?.uid
  return typeof uid === "string" && uid.length > 0 ? uid : undefined
}

/**
 * The error class name, never its message.
 *
 * See this file's header for why the rule exists. The `typeof` fallback covers a
 * thrown non-Error (a rejected string, a number), which has no class name to
 * give — reporting its type is the most that can be said without quoting it.
 * @param {unknown} error The thrown value.
 * @return {string} A safe label for a log line.
 */
export const errorLabel = (error: unknown): string => {
  // `name` alone is almost always just "Error", which is a log line that costs
  // something and says nothing: `storage: list failed: Error` took a Cloud Logging
  // excavation to explain. The message is the only part that names the cause, and a
  // storage/SDK failure carries a bucket or permission answer, never a credential.
  if (!(error instanceof Error)) {
    return typeof error
  }

  return `${error.name}: ${error.message}`.slice(0, 300)
}

/**
 * The request body as a record, `{}` when absent.
 *
 * One definition rather than three. `monitors.ts` and `storage.ts` carried this
 * function verbatim, and `browser-sessions.ts` carried a THIRD that returned raw
 * `unknown` — so "the body" meant two different things depending on which route
 * answered. Two identical copies is duplication; the third was drift, and it is
 * the one that mattered: a route whose body is `undefined` and one whose body is
 * `{}` take different branches in every validator.
 *
 * The NORMALISING contract wins, and it is not merely the majority vote.
 * `parseCreateRequest(body: unknown)` already treats a missing field as missing,
 * so `{}` reaches the same validation and answers the same class of 400 — while
 * `undefined` forced each caller to carry its own guard. Normalising is also
 * what stops a body of `null` becoming `null.foo` at a call site that assumed
 * an object.
 * @param {Request} req The request.
 * @return {Record<string, unknown>} The body as a record, `{}` when absent.
 */
export const bodyOf = (req: Request): Record<string, unknown> => {
  const body = req.body as unknown
  return body && typeof body === "object" ?
    (body as Record<string, unknown>) :
    {}
}

/**
 * The anti-bot challenge a browser tool reported, or null.
 *
 * One definition rather than two. `scrape.ts` and `webrain-jobs.ts` carried
 * this verbatim, and both routes can surface the same gate, so the rule that
 * decides whether one exists was stated twice.
 *
 * Only `navigate` / `observe(what=state)` / `search` report one; `scrape` and
 * `batch` carry no such field in webrain-core/src/browser.rs, so `null` here
 * means "this provider does not answer that question", not "the page was
 * clean". The value is rendered back to the caller as the reason their scrape
 * was blocked, so only a non-empty string counts.
 * @param {unknown} data The tool's typed JSON, or anything else.
 * @return {string | null} The challenge, or null when there is none.
 */
export const challengeOf = (data: unknown): string | null => {
  if (!data || typeof data !== "object") {
    return null
  }
  const value = (data as Record<string, unknown>)["challenge"]
  return typeof value === "string" && value.length > 0 ? value : null
}
