/* eslint-disable max-len */
/**
 * "The customer cannot pay" has to be distinguishable from "the write failed once".
 *
 * Both arrive as a rejected promise from `applyBillingCreditMutation`, and the callers
 * must react in opposite ways: the first is PERMANENT until a top-up, so retrying it
 * forever is how an empty wallet kept a browser machine alive while it billed compute
 * nobody was paying for. The second is transient, so ending the session on it would
 * punish a customer for a Firestore blip.
 *
 * The dangerous direction is therefore the SECOND one — a transient failure classified
 * as a refusal kills sessions that were being paid for — so most of these cases pin
 * what must NOT match.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {isInsufficientCreditsError} from "./billing-credits"

const refusal = (message: string) => new Error(message)

describe("insufficient-credits classification", () => {
  it("recognises a consume the balance cannot cover", () => {
    assert.equal(
      isInsufficientCreditsError(
        refusal("Billing credit mutation would make purchased balance negative"),
      ),
      true,
    )
  })

  it("recognises a reservation larger than the balance", () => {
    assert.equal(
      isInsufficientCreditsError(
        refusal("Billing credit mutation would reserve more included credits than available"),
      ),
      true,
    )
  })

  it("does not mistake a transient write failure for a refusal", () => {
    for (const message of [
      "The service is currently unavailable.",
      "Deadline exceeded",
      "Transaction lock timeout",
      "UNAVAILABLE: failed to connect",
    ]) {
      assert.equal(isInsufficientCreditsError(refusal(message)), false, message)
    }
  })

  it("does not mistake a negative-reservation bug for a refusal", () => {
    // A reserved count driven below zero is a caller error, not a wallet that is
    // empty. Ending the session for it would hide the bug behind a plausible stop.
    assert.equal(
      isInsufficientCreditsError(
        refusal("Billing credit mutation would make purchased reserved credits negative"),
      ),
      false,
    )
  })

  it("classifies a non-Error rejection by its text and tolerates nothing", () => {
    assert.equal(
      isInsufficientCreditsError(
        "Billing credit mutation would make purchased balance negative",
      ),
      true,
    )
    assert.equal(isInsufficientCreditsError(undefined), false)
    assert.equal(isInsufficientCreditsError(null), false)
  })
})
