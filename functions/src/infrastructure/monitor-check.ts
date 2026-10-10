/* eslint-disable object-curly-spacing */
/**
 * One monitor check: call the worker, decide, persist.
 *
 * Why this is its own module
 * -------------------------
 * The scheduled drain must stay a loop over claimed monitors, and the HTTP
 * routes must stay HTTP. The piece in between — "ask webrain, then record what
 * came back" — is shared by nothing else, so it lives by itself and the drain
 * reads as a list of three statements.
 *
 * The tier is deliberately `undefined`
 * -----------------------------------
 * A scheduled check has no request behind it, so there is no `req.accessMode`
 * to forward. `webrainTool` takes the tier as a required second argument and
 * resolves `undefined` to the FREE tier, i.e. the strictest allowlist — which
 * is the correct answer here and cannot be wrong: `webrain_scrape` is in
 * `SHARED_POOL_TOOLS`, so every tier may call it, and a future tool that is not
 * shared will be refused rather than silently run at the platform's expense.
 *
 * A check never throws
 * -------------------
 * The drain calls this in a loop, one monitor per iteration, so a throw from
 * one monitor would abandon the rest of the batch. Every failure is therefore
 * turned into an ERROR ROW, which is also the more useful outcome: the owner
 * sees "error" on that monitor with the reason, instead of a monitor that
 * quietly stopped being checked.
 */
import {
  monitorCheckFromScrape,
  validatorsFromScrape,
  type MonitorCheckFields,
  type MonitorFields,
} from "../domain/monitors.domain"
import {
  webrainTool,
  type WebrainToolResult,
} from "./webrain-mcp"
import { recordCheck } from "./monitor.store"

/**
 * The check row for a call that never produced a payload.
 *
 * A refusal and an outage are separated for the same reason `/serp` separates
 * them: a refusal is a plan or configuration question that nothing retries, and
 * an outage is the worker being unreachable. Both end up as `status: "error"`,
 * but the stored message is what the owner reads.
 * @param {WebrainToolResult} call The normalised tool result.
 * @param {number} at When the check finished.
 * @param {number} ms How long it took.
 * @return {MonitorCheckFields} The row to write.
 */
const failureRow = (
  call: WebrainToolResult,
  at: number,
  ms: number
): MonitorCheckFields => {
  let message = call.error ?? "The check failed"
  if (call.transportError) {
    message = "The scraping worker is unreachable"
  } else if (call.noStateRefused) {
    message = "Needs a private worker; the shared pool holds no sessions"
  }

  return {
    at,
    status: "error",
    httpStatus: call.status,
    changed: false,
    ms,
    error: message,
  }
}

/**
 * Checks one monitor and records the outcome.
 *
 * The stored hash is compared, never the body — nothing here reads a page into
 * the platform, and `recordCheck` writes one row plus a summary.
 * @param {*} monitor The claimed monitor.
 * @return {Promise<void>} Resolves once the outcome has been recorded.
 */
export const checkMonitor = async (
  monitor: MonitorFields & { id: string }
): Promise<void> => {
  const started = Date.now()

  let call: WebrainToolResult
  try {
    call = await webrainTool("webrain_scrape", undefined, {
      url: monitor.url,
    })
  } catch (error) {
    // `webrainTool` is documented never to throw. The catch is the belt for
    // that brace, so a broken contract still produces a row rather than a dead
    // run.
    console.error(`monitor ${monitor.id}: check threw:`, error)
    call = {
      ok: false,
      text: "",
      error: "The scraping worker is unreachable",
      transportError: true,
      status: 0,
    }
  }

  const at = Date.now()
  const ms = at - started

  if (call.transportError || call.toolRefused || call.noStateRefused ||
    !call.ok) {
    await recordCheck(monitor, failureRow(call, at, ms))
    return
  }

  const outcome = monitorCheckFromScrape(call.json, monitor.lastHash)
  const row: MonitorCheckFields = {
    at,
    status: outcome.status,
    httpStatus: outcome.httpStatus,
    changed: outcome.changed,
    ms,
  }

  if (outcome.hash) {
    row.hash = outcome.hash
  }
  if (outcome.error) {
    row.error = outcome.error
  }

  await recordCheck(monitor, row, validatorsFromScrape(call.json))
}
