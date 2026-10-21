/* eslint-disable max-len */
/**
 * The public pricing page and the plan catalog must agree.
 *
 * They are two hand-kept lists of the same tokens, and nothing failed when they disagreed:
 * the tokens still resolved, so a tier could advertise a feature it does not have and no
 * gate noticed. That is exactly how the public page came to sell "20,000 credits / month"
 * on a tier that had just been made unlimited.
 *
 * The landing page legitimately shows FEWER rows than `/plans` — it is a summary, and the
 * free-tier tools are listed once rather than repeated under every paid tier. So the rule is
 * a subset, not equality: everything the public page claims must exist on that tier.
 *
 * This reads the Angular source as text. That is a compromise, not a design: the catalog
 * lives in `functions/` and the component in the app, they are in different bundles, and
 * sharing one array at build time is more machinery than the risk warrants.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {existsSync, readFileSync} from "node:fs"
import {join} from "node:path"
import {billingPlanCatalog} from "./stripe"

const RELATIVE = "src/app/layout/landpage/pricing/landing-pricing.component.ts"

/** The tiers the public page renders. `trial` is an in-app offer, not a public card. */
const LANDING_TIERS = ["free", "starter", "pro", "enterprise"] as const

const landingSource = (): string => {
  const found = [join(process.cwd(), "..", RELATIVE), join(process.cwd(), RELATIVE)]
    .find((path) => existsSync(path))

  assert.ok(found, "landing pricing component not found; run the suite from functions/")
  return readFileSync(found, "utf8")
}

/**
 * The feature tokens one tier's block lists, in source order.
 * @param {string} source The landing component's source.
 * @param {string} tier The tier whose block to read.
 * @return {string[]} Lowercase tokens, ready to compare with the catalog.
 */
const tokensFor = (source: string, tier: string): string[] => {
  const start = source.indexOf(`tier: '${tier}'`)
  if (start < 0) {
    return []
  }

  const nextTier = source.indexOf("tier: '", start + 8)
  const block = source.slice(start, nextTier < 0 ? undefined : nextTier)

  return [...block.matchAll(/PRICING\.FEATURES\.([A-Z_]+)/g)].map((match) => match[1].toLowerCase())
}

describe("landing page pricing claims", () => {
  it("claims only features the plan actually carries", () => {
    const source = landingSource()

    for (const tier of LANDING_TIERS) {
      const plan = billingPlanCatalog.find((entry) => entry.id === tier)
      assert.ok(plan, `no catalog entry for ${tier}`)

      for (const token of tokensFor(source, tier)) {
        assert.ok(
          plan.features.includes(token),
          `the landing page shows "${token}" for ${tier}, but ${tier}.features does not include it`,
        )
      }
    }
  })

  it("lists at least one feature on every tier it renders", () => {
    // An empty block is the other silent failure: the card renders with no bullets at all
    // and no error, which reads as "this tier includes nothing".
    const source = landingSource()

    for (const tier of LANDING_TIERS) {
      assert.ok(tokensFor(source, tier).length > 0, `${tier} renders no features`)
    }
  })

  it("does not sell the unlimited tier as metered", () => {
    // The specific lie that started this: a paid tier advertising a membership it no longer
    // has. If any landing block ever shows a credits amount on a plan marked unlimited, the
    // two pages disagree about what is being sold.
    const source = landingSource()
    const enterprise = billingPlanCatalog.find((plan) => plan.id === "enterprise")

    assert.equal(enterprise?.unlimited, true)
    assert.ok(source.includes("priceMonthly: 'Custom'"), "the unlimited tier must not publish a list price")
  })
})
