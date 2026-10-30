import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {ledgerCollectionPath, validateCreditTransfer} from "./billing-credits"

/**
 * The pure half of the org-wallet transfer.
 *
 * The transaction around it needs an emulator, but the REFUSALS do not — and the
 * refusals are what a customer sees. These pin the three answers: move it, there
 * is nothing to move, there is not enough to move it.
 */
describe("validateCreditTransfer", () => {
  it("allows an amount the member can cover", () => {
    assert.deepEqual(
      validateCreditTransfer({amount: 40, available: 100}),
      {ok: true, amount: 40},
    )
  })

  it("allows spending the whole available balance", () => {
    assert.deepEqual(
      validateCreditTransfer({amount: 100, available: 100}),
      {ok: true, amount: 100},
    )
  })

  it("refuses more than the available balance", () => {
    assert.deepEqual(
      validateCreditTransfer({amount: 101, available: 100}),
      {ok: false, reason: "insufficient"},
    )
  })

  it("refuses zero and negative amounts as nothing to move", () => {
    assert.deepEqual(
      validateCreditTransfer({amount: 0, available: 100}),
      {ok: false, reason: "not_positive"},
    )
    assert.deepEqual(
      validateCreditTransfer({amount: -5, available: 100}),
      {ok: false, reason: "not_positive"},
    )
  })

  it("floors a fraction rather than moving part of a credit", () => {
    assert.deepEqual(
      validateCreditTransfer({amount: 10.9, available: 100}),
      {ok: true, amount: 10},
    )
  })

  it("treats a non-finite amount as nothing to move", () => {
    assert.deepEqual(
      validateCreditTransfer({amount: Number.NaN, available: 100}),
      {ok: false, reason: "not_positive"},
    )
  })

  it("treats a negative available balance as nothing available", () => {
    // Reserved credits can exceed the balance on a wallet that was just drained.
    assert.deepEqual(
      validateCreditTransfer({amount: 1, available: -10}),
      {ok: false, reason: "insufficient"},
    )
  })
})

/**
 * Which ledger a report or a charge reads.
 *
 * The two namespaces cannot be one: `users/{orgId}` would collide with a real user
 * id and be owner-scoped by the rules. This is the single place that decides, so the
 * cost report and the charge cannot read different collections.
 */
describe("ledgerCollectionPath", () => {
  it("reads the person's ledger when no workspace pays", () => {
    assert.equal(ledgerCollectionPath("uid_1"), "users/uid_1/credits_ledger")
  })

  it("reads the workspace's ledger when one pays", () => {
    assert.equal(
      ledgerCollectionPath("uid_1", "org_1"),
      "orgs/org_1/credits_ledger",
    )
  })
})
