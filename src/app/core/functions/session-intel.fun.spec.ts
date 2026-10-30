import {
  getSessionNetworkSummary,
  getSessionProxySummary,
  getSessionRiskLevel,
  getSessionRiskReason,
} from './session-intel.fun'

/**
 * `skipped` means `lookupGeoByIp` refused a non-routable address on purpose, so no
 * provider was ever asked. It used to fall through to `proxy.confidence ===
 * 'unknown'` and score `medium`, which painted "Needs review" on the user's own
 * local session.
 */
describe('session intel with a skipped lookup', () => {
  const skipped = { intelligenceStatus: 'skipped' } as never

  it('does not raise the risk level', () => {
    expect(getSessionRiskLevel(skipped)).toBe('low')
  })

  it('says the lookup does not apply rather than that it is incomplete', () => {
    expect(getSessionRiskReason(skipped)).toContain('Private or reserved address')
  })

  it('answers both summaries with the address class', () => {
    expect(getSessionProxySummary(skipped)).toBe('Private or reserved address')
    expect(getSessionNetworkSummary(skipped)).toBe('Private or reserved address')
  })
})

/**
 * `no-match` is the case where a provider WAS asked and had nothing. That one
 * stays a medium-risk unknown, because the answer is genuinely missing.
 */
describe('session intel with an answered-but-empty lookup', () => {
  const noMatch = { intelligenceStatus: 'no-match' } as never

  it('keeps the unknown proxy answer and the review flag', () => {
    expect(getSessionRiskLevel(noMatch)).toBe('medium')
    expect(getSessionProxySummary(noMatch)).toBe('Proxy status unknown')
    expect(getSessionNetworkSummary(noMatch)).toBe('Network intelligence unavailable')
  })
})

describe('session intel with resolved data', () => {
  const resolved = {
    intelligenceStatus: 'resolved',
    network: { asn: 'AS15169', as: 'Google LLC', usageType: 'Data Center' },
    proxy: { isProxy: false, confidence: 'high' },
  } as never

  it('reports the network but flags the data-centre usage', () => {
    expect(getSessionNetworkSummary(resolved)).toBe('AS15169 • Google LLC • Data Center')
    expect(getSessionProxySummary(resolved)).toBe('No open proxy detected')
    expect(getSessionRiskLevel(resolved)).toBe('medium')
  })
})
