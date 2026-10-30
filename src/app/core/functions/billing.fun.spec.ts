import { isDunning } from './billing.fun'

describe('isDunning', () => {
  it('treats an ended agreement as dunning whatever its casing', () => {
    expect(isDunning('unpaid')).toBeTrue()
    expect(isDunning(' UNPAID ')).toBeTrue()
    expect(isDunning('canceled')).toBeTrue()
    expect(isDunning('incomplete_expired')).toBeTrue()
  })

  // `past_due` is Stripe retrying, and the server still grants the plan for it.
  it('leaves a retrying subscription alone', () => {
    expect(isDunning('past_due')).toBeFalse()
    expect(isDunning('active')).toBeFalse()
    expect(isDunning('trialing')).toBeFalse()
  })

  it('says nothing about a record with no status', () => {
    expect(isDunning(undefined)).toBeFalse()
    expect(isDunning(null)).toBeFalse()
    expect(isDunning('')).toBeFalse()
  })
})
