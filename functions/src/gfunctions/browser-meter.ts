/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The meter that charges for platform browser time (roadmap `§1.6`).
 *
 * The rate lives in `domain/browser-meter.domain.ts` and is pure. This file is
 * only the IO around it: find the sessions, read each caller's wallet, apply the
 * keys the rate produced, advance the counter.
 *
 * Why a scheduled Function and not the reaper. The reaper is in arachnefly (Go)
 * and is the natural place — it already walks these records every minute. It
 * cannot charge: `FireAuthMiddleware` accepts only a Firebase **ID token**, and
 * a cron job has no session owner to authenticate as. That is the Phase 0 item 4
 * blocker, and it is why the money step lives here, on a comparable cadence, with
 * Firestore and the credit primitives in reach.
 *
 * Why the cadence is exactly 5 minutes. That IS the billing quantum, so a run
 * spans at most one block boundary and the sweep can never be more than one
 * block behind. Running it faster would not charge sooner — the rate has no
 * sub-block resolution — and running it slower would let a session accumulate
 * several blocks of unswept debt, which is the shape of an abandoned-invoice
 * surprise.
 *
 * Idempotence is the whole safety story, and it comes from the ledger rather
 * than from this file. `applyBillingCreditMutation` derives the ledger document
 * id from `idempotencyKey` and returns unchanged when that document already
 * exists, so a key of `bs-meter:<sessionId>:block:<n>` is applied **at most
 * once, ever**. A retry, an overlapping run, or a crash *between* the charge and
 * the counter write are therefore all safe, and the next sweep heals itself.
 */
import {onSchedule} from "firebase-functions/v2/scheduler"
import {logger} from "firebase-functions/logger"
import {
  billableMinutes,
  isMeterExhausted,
} from "../domain/browser-meter.domain"
import {
  chargeSessionMeter,
  meterWalletFor,
} from "../infrastructure/browser-meter-charge"
import {
  alertCapReached,
  capReached,
} from "../infrastructure/billing-spend.store"
import {
  expireMeteredSession,
  listMeterableSessions,
  type MeterableSession,
} from "../infrastructure/browser-session.store"

/**
 * Bucket the sessions by owner.
 *
 * A caller's wallet is one document, so reading it once per caller instead of
 * once per session keeps a sweep with several sessions for the same tenant from
 * performing the same read N times. Order within a caller is preserved, which
 * keeps a sweep deterministic for the same input.
 * @param {MeterableSession[]} sessions Every session the sweep will consider.
 * @return {Map<string, MeterableSession[]>} Sessions keyed by owning uid.
 */
const groupByOwner = (
  sessions: MeterableSession[],
): Map<string, MeterableSession[]> => {
  const grouped = new Map<string, MeterableSession[]>()
  for (const session of sessions) {
    const owned = grouped.get(session.uid)
    if (owned) {
      owned.push(session)
    } else {
      grouped.set(session.uid, [session])
    }
  }
  return grouped
}

/**
 * Charge every outstanding block of platform browser time.
 *
 * Reads the sessions first, then each owner's wallet, then applies one ledger
 * entry per unbilled block. A failure is contained to its own session: the
 * counter is advanced only after that session's charges all land, so a wallet
 * that refuses today is retried tomorrow rather than skipped, and the keyed
 * ledger makes the retry free of double-charging.
 *
 * Nothing is charged for a session the platform did not supply compute for. A
 * BYO session has no `machineId`, the free tier never receives a machine, and
 * `admin` is the operator — charging any of them would bill for compute the
 * platform never ran.
 *
 * `releaseReserved: false` is mandatory, not stylistic. `consumeBillingCredits`
 * defaults `reservedDelta` to `-amount` because it assumes a reservation was
 * taken earlier. A metered charge has no reservation behind it, so the default
 * would drive `reserved` below zero and corrupt the wallet's balance/reserved
 * pair.
 */
export const sweepBrowserMeter = onSchedule(
  {
    schedule: "*/5 * * * *",
    timeZone: "UTC",
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async () => {
    const now = Date.now()
    const sessions = await listMeterableSessions()
    if (sessions.length === 0) {
      return
    }

    let charged = 0
    let unbillable = 0
    let failed = 0
    let capped = 0

    for (const [uid, owned] of groupByOwner(sessions)) {
      // Resolved ONCE per caller: the wallet depends on the caller and not on
      // which session is being charged. `undefined` means there is no billable
      // wallet at all — free, admin, grace, or a zero-priced deploy action — and
      // the sweep must then charge nothing rather than pick a pot.
      const wallet = await meterWalletFor(uid, now)
      if (!wallet) {
        unbillable += owned.length
        continue
      }

      // The CUSTOMER's own cap, resolved ONCE per caller for the same reason the
      // wallet is: it depends on the caller, not on the session. Checked before
      // the loop so a tenant with several sessions costs two reads and not two
      // per session.
      //
      // The response is a STOP, not a refusal. `chargeSessionMeter` must still
      // collect for time already run — refusing the charge would leave a running
      // machine unpaid, which is strictly worse than the overspend it prevents.
      // So a reached cap does exactly what the platform's own 20-credit ceiling
      // does below: pull the idle deadline forward, which is how the Go reaper is
      // asked to suspend the machine, because a scheduled job cannot authenticate
      // as the owner.
      //
      // The cost of that choice, stated rather than hidden: a cap crossed DURING
      // this sweep is acted on by the NEXT one, up to five minutes later. The
      // ceiling has the same granularity, because the block size *is* the cadence.
      if (await capReached(uid, now)) {
        for (const {record} of owned) {
          await expireMeteredSession(uid, record.id, now)
        }
        // AFTER the stop, never before. The stop is the control and the alert is
        // a courtesy, so a notification that throws must not be able to leave a
        // session running. `alertCapReached` catches its own failures too, which
        // is belt-and-braces on purpose: this is on the path that has already
        // decided a customer is over budget.
        await alertCapReached(uid, now)
        capped += owned.length
        continue
      }

      for (const {record} of owned) {
        try {
          charged += await chargeSessionMeter(uid, record, wallet, now)

          // Past the ceiling the meter emits no further keys, so without this the
          // session keeps running and is billed nothing. That is the ceiling
          // capping the invoice but not the compute, which is the opposite of
          // cost control, and a caller looping `keepalive` would ride free.
          //
          // The window is computed with the SAME function the charge used and the
          // same `now`, so the two cannot disagree about how long the session ran.
          // A second call to a shared function, not a second copy of the rule.
          const minutes = billableMinutes(
            record.createdAt,
            now,
            record.idleDeadline,
          )
          if (isMeterExhausted(minutes)) {
            await expireMeteredSession(uid, record.id, now)
          }
        } catch (error) {
          // Contained on purpose: one caller's wallet must not stop the sweep
          // for everyone else. The counter is deliberately NOT advanced, so the
          // next run re-derives the same keys and retries. Because each key is
          // idempotent at the ledger, that retry cannot charge twice -- which is
          // the only reason leaving the counter behind is safe.
          failed += 1
          logger.error("browser meter charge failed", {
            uid,
            sessionId: record.id,
            error: String(error),
          })
        }
      }
    }

    logger.info("browser meter sweep complete", {
      sessions: sessions.length,
      charged,
      unbillable,
      failed,
      capped,
    })
  },
)
