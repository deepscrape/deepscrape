import {
  OPERATIONS_REQUIREMENT,
  PLAYGROUND_MODES,
  RUN_SURFACE_REQUIREMENTS,
  gateStateFor,
  playgroundGateStates,
} from './feature-gate.policy'

/**
 * Pins the two axes the gate keeps apart: a `viewer` is refused by RBAC and a free
 * account is refused by plan. Collapsing them would let the UI offer an upgrade for a
 * denial an upgrade cannot clear.
 */
describe('feature gate policy', () => {
  const freeSelfUser = { permissions: { ai: true, crawl: true }, paid: false }
  const freeViewer = { permissions: { ai: false, crawl: false }, paid: false }
  const paidViewer = { permissions: { ai: false, crawl: false }, paid: true }
  const paidSelfUser = { permissions: { ai: true, crawl: true }, paid: true }

  it('allows the free-tier modes without a paid plan', () => {
    expect(gateStateFor(RUN_SURFACE_REQUIREMENTS.search, freeSelfUser).allowed).toBe(true)
    expect(gateStateFor(RUN_SURFACE_REQUIREMENTS.monitor, freeSelfUser).allowed).toBe(true)
  })

  it('refuses a paid mode on plan alone and offers the upgrade', () => {
    const state = gateStateFor(RUN_SURFACE_REQUIREMENTS.crawl, freeSelfUser)

    expect(state.allowed).toBe(false)
    expect(state.denial).toBe('plan')
    expect(state.showUpgrade).toBe(true)
    expect(state.titleKey).toBe('FEATURE_GATE.REQUIRES_PLAN_TITLE')
  })

  it('refuses a viewer on role even when the plan is paid, and never offers an upgrade', () => {
    const state = gateStateFor(RUN_SURFACE_REQUIREMENTS['llm-scrape'], paidViewer)

    expect(state.allowed).toBe(false)
    expect(state.denial).toBe('role')
    expect(state.showUpgrade).toBe(false)
    expect(state.bodyKey).toBe('FEATURE_GATE.REQUIRES_ROLE_BODY')
  })

  it('names both blockers when neither is held', () => {
    const state = gateStateFor(RUN_SURFACE_REQUIREMENTS.crawl, freeViewer)

    expect(state.denial).toBe('role-and-plan')
    expect(state.showUpgrade).toBe(false)
    expect(state.bodyKey).toBe('FEATURE_GATE.REQUIRES_ROLE_AND_PLAN_BODY')
  })

  it('fails closed on a permission it was not told about', () => {
    const state = gateStateFor(OPERATIONS_REQUIREMENT, { permissions: {}, paid: true })

    expect(state.allowed).toBe(false)
    expect(state.denial).toBe('role')
  })

  it('allows every mode for a paid self user and refuses every mode for a free viewer', () => {
    const allowed = playgroundGateStates(paidSelfUser)
    const refused = playgroundGateStates(freeViewer)

    for (const mode of PLAYGROUND_MODES) {
      expect(allowed[mode].allowed).withContext(mode).toBe(true)
      expect(refused[mode].allowed).withContext(mode).toBe(false)
    }
  })
})
