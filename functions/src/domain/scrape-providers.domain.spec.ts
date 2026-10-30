/* eslint-disable max-len */
/**
 * The provider-selection rules.
 *
 * These are the rules that decide where a paying customer's traffic goes and,
 * more importantly, which of them can be refused. Getting one wrong is either a
 * free user reaching a paid worker or a paid user being silently downgraded, and
 * both are invisible in a green build — so they are pinned here rather than
 * exercised only through Firestore.
 *
 * Pure functions, no Firestore: every plan/route combination is cheap to assert.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  FALLBACK_PROVIDER,
  SCRAPE_PROVIDERS,
  isPaidAccess,
  isScrapeProviderId,
  platformDefaultProvider,
  providerDescriptor,
  resolveProvider,
  selectableProviders,
} from "./scrape-providers.domain"

describe("scrape provider catalogue", () => {
  it("has unique ids", () => {
    const ids = SCRAPE_PROVIDERS.map((provider) => provider.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  it("every provider serves at least one route and carries a label key", () => {
    for (const provider of SCRAPE_PROVIDERS) {
      assert.ok(provider.routes.length > 0, `${provider.id} serves no route`)
      assert.ok(provider.labelKey.length > 0, `${provider.id} has no i18n key`)
    }
  })

  it("jina is not offered for the crawl route", () => {
    // It is a synchronous single-URL reader. Offering it for /api/crawl would
    // promise a job pipeline it does not have.
    assert.equal(providerDescriptor("jina").routes.includes("crawl"), false)
  })

  it("webrain is the only provider that reports gates", () => {
    const withChallenge = SCRAPE_PROVIDERS.filter((provider) => provider.capabilities.challenge)
    assert.deepEqual(withChallenge.map((provider) => provider.id), ["webrain"])
  })

  it("only a provider the caller brings a credential for is BYOK", () => {
    // The invariant the provider-wide key store depends on, and the reason `jina` is described
    // here rather than in the AI vendor catalogue: its credential is CHOSEN BY THIS CATALOGUE.
    //
    // `crawl4ai` and `webrain` are our own deployments -- their secret is platform-to-worker,
    // and a caller has nothing to bring -- so marking one BYOK would offer a key input the route
    // never reads. `jina`'s upstream is the one that accepts a per-caller credential.
    const byok = SCRAPE_PROVIDERS.filter((provider) => provider.byok)
    assert.deepEqual(byok.map((provider) => provider.id), ["jina"])
  })

  it("the fallback provider is real and free-selectable", () => {
    assert.ok(isScrapeProviderId(FALLBACK_PROVIDER))
    assert.equal(providerDescriptor(FALLBACK_PROVIDER).minAccess, "free")
  })
})

describe("isPaidAccess", () => {
  it("treats only 'free' and absent as unpaid", () => {
    // Anything that is not explicitly free counts as paid, so a new access mode
    // added by billing cannot accidentally read as a free user.
    assert.equal(isPaidAccess("free"), false)
    assert.equal(isPaidAccess(undefined), false)
    assert.equal(isPaidAccess(""), false)

    assert.equal(isPaidAccess("plan"), true)
    assert.equal(isPaidAccess("credits"), true)
    assert.equal(isPaidAccess("grace"), true)
    assert.equal(isPaidAccess("admin"), true)
  })
})

describe("selectableProviders", () => {
  it("offers a free user the engine the platform actually runs", () => {
    // `crawl4ai` used to be the free option and `webrain` the paid one. With
    // `crawl4ai` retired this list is the whole answer to "which engine will
    // run my crawl", so it must never come back empty.
    assert.deepEqual(
      selectableProviders("free", "crawl").map((provider) => provider.id),
      ["webrain"],
    )
  })

  it("offers a paid user nothing extra, because webrain is not gated", () => {
    assert.deepEqual(
      selectableProviders("plan", "crawl").map((provider) => provider.id),
      ["webrain"],
    )
  })

  it("never offers a retired provider, whatever the plan", () => {
    for (const accessMode of ["free", "plan", "admin"]) {
      assert.ok(
        !selectableProviders(accessMode, "crawl")
          .some((provider) => provider.id === "crawl4ai"),
        `crawl4ai was offered to ${accessMode}`,
      )
    }
  })

  it("offers jina only on the jina route, for anyone", () => {
    assert.deepEqual(
      selectableProviders("free", "jina").map((provider) => provider.id),
      ["jina"],
    )
  })
})

describe("resolveProvider", () => {
  it("falls back to the platform default when nothing is stored", () => {
    const resolution = resolveProvider(undefined, "plan")
    assert.equal(resolution.provider, platformDefaultProvider("crawl"))
    assert.equal(resolution.source, "platform")
    assert.equal(resolution.rejected, undefined)
  })

  it("honours a stored provider the plan is entitled to", () => {
    const resolution = resolveProvider("webrain", "plan")
    assert.equal(resolution.provider, "webrain")
    assert.equal(resolution.source, "user")
  })

  it("honours webrain for a FREE user, because it is not gated", () => {
    // The `entitlement` branch is unreachable from this catalogue today: no
    // crawl-route provider is paid. What still matters is the consequence —
    // a free caller gets the same engine as everyone else rather than an empty
    // list.
    const resolution = resolveProvider("webrain", "free")
    assert.equal(resolution.provider, "webrain")
    assert.equal(resolution.source, "user")
    assert.equal(resolution.rejected, undefined)
  })

  it("refuses a RETIRED provider, and says 'retired' rather than 'upgrade'", () => {
    // A stored `crawl4ai` is the case that matters: the document exists in
    // production, its pipeline is gone, and reporting `entitlement` would send
    // a paying caller to the pricing page instead of to the engine picker.
    for (const accessMode of ["free", "plan", "admin"]) {
      const resolution = resolveProvider("crawl4ai", accessMode)
      assert.equal(resolution.provider, platformDefaultProvider("crawl"))
      assert.equal(resolution.source, "platform")
      assert.equal(resolution.rejected?.reason, "retired")
      assert.equal(resolution.rejected?.value, "crawl4ai")
    }
  })

  it("refuses a provider that does not serve the route", () => {
    const resolution = resolveProvider("jina", "plan", "crawl")
    assert.equal(resolution.rejected?.reason, "route")
  })

  it("refuses an unrecognised stored value instead of trusting it", () => {
    const resolution = resolveProvider("some-future-provider", "plan")
    assert.equal(resolution.provider, platformDefaultProvider("crawl"))
    assert.equal(resolution.rejected?.reason, "unknown")
  })

  it("never returns a provider outside the catalogue, whatever is stored", () => {
    // A hand-edited or stale document must not be able to route traffic anywhere
    // the platform does not know about.
    const junk = [null, "", 0, false, "WEBRAIN", "crawl4ai ", "web rain", {}, [], "jina"]
    for (const stored of junk) {
      const resolution = resolveProvider(stored, "plan", "crawl")
      assert.ok(
        isScrapeProviderId(resolution.provider),
        `resolveProvider returned an unknown provider for ${JSON.stringify(stored)}`,
      )
    }
  })
})
