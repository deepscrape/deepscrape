/* eslint-disable object-curly-spacing */
/**
 * The scrape-provider catalogue and the rule for choosing one.
 *
 * This is the "system behind the platform": which providers the platform has
 * integrated, who may select which, and what a user's stored preference is
 * allowed to override.
 *
 * Why it is a catalogue and not an env flag
 * ----------------------------------------
 * `SCRAPE_PROVIDER` started as a single environment value, which cannot express
 * any of the things this feature needs:
 *
 *   - a paying user chooses their own provider, and the choice must survive
 *     between sessions;
 *   - not every provider serves every route (`jina` is a synchronous single-URL
 *     reader, so it can serve `/jina/:url` but never the crawl job route);
 *   - a provider may be integrated but not entitled for a given plan;
 * - the UI must offer only what actually exists, and say why the rest does not.
 *
 * So the env var is demoted to what it can correctly be: the PLATFORM DEFAULT,
 * used when nothing is stored and nothing is overridden. Everything else is
 * derived here, in pure functions, so the rules are testable without Firestore.
 *
 * Deliberately no Firestore in this file. Storage lives in
 * `infrastructure/scrape-provider.store.ts`; keeping the rules separate is what
 * lets the gating be tested for every plan/route combination cheaply.
 */
import { env } from "../config/env"

export type ScrapeProviderId = "crawl4ai" | "jina" | "webrain"

/** Routes a provider can actually serve. */
export type ScrapeRoute = "crawl" | "jina"

/** How a caller gets a result out of the provider. */
export type ScrapeJobModel = "sync" | "job" | "mcp"

export interface ScrapeProviderDescriptor {
  id: ScrapeProviderId
  /** i18n key for the display name, so the catalogue carries no English. */
  labelKey: string
  /**
   * Routes this provider can serve. A provider absent from a route is
   * not offered for it.
   */
  routes: readonly ScrapeRoute[]
  /** Minimum access mode required to SELECT it. */
  minAccess: "free" | "paid"
  /**
   * True when this platform no longer serves the provider, whatever a caller
   * chose.
   *
   * A retired entry STAYS in the catalogue rather than being deleted. Stored
   * preferences, task documents and historical records all name it, and
   * removing it would turn a real value into an unknown id — a data repair
   * presented as a typo. It is instead never selectable and never resolvable:
   * `selectableProviders` hides it, `platformDefaultProvider` will not adopt
   * it, and `resolveProvider` reports the stored value as rejected instead of
   * routing to a pipeline that does not answer.
   *
   * This is the difference between "we stopped developing it" and "requests
   * must not land on it". The `notes` field records the former; this flag
   * enforces the latter.
   */
  retired: boolean
  jobModel: ScrapeJobModel
  /**
   * Whether a caller may point this provider at their own quota with their own key.
   *
   * `true` for `jina` only. It is the one provider whose upstream accepts a per-caller
   * credential -- `r.jina.ai` reads a public URL for free and raises the rate limit when a
   * key is supplied, so a key is a choice rather than a requirement.
   *
   * `crawl4ai` and `webrain` are OUR deployments: the credential is a shared secret between
   * this platform and a worker we run, and a user has nothing of their own to bring. Marking
   * them BYOK would offer an input the route would never read.
   */
  byok: boolean
  /**
   * What it can do, so the UI offers only what works.
   *
   * `stateful` means "can log in and keep a session" — the difference between
   * reading a public page and reading an account. It is the axis the
   * free/paid
   * split turns on, because a shared worker must not hold anyone's session.
   */
  capabilities: {
    batch: boolean
    stateful: boolean
    profiles: boolean
    /** Reports an anti-bot gate as a first-class signal. */
    challenge: boolean
    /** Returns typed JSON rather than markup to parse. */
    typedJson: boolean
  }
  notes: string
}

/**
 * What the platform has integrated today.
 *
 * `webrain` is the engine this platform serves: the embedded MCP engine, the
 * platform default, and the only provider that reports anti-bot gates and typed
 * JSON. `jina` is an external reader on its own route. `crawl4ai` (the
 * `crawlagent` service) is RETIRED — installed, no longer developed, and no
 * longer reachable by a caller. It stays listed so that a stored `crawl4ai`
 * preference resolves to a visible rejection rather than to an unknown id.
 *
 * `challenge` is `false` for every provider except webrain. That is not a gap
 * in
 * the catalogue but a fact about the sources: `crawl4ai`'s result shape has no
 * gate field, and `jina` is a reader. `browser.rs:23` in webrain is where that
 * signal lives.
 */
export const SCRAPE_PROVIDERS: readonly ScrapeProviderDescriptor[] = [
  {
    id: "crawl4ai",
    labelKey: "SCRAPE_PROVIDER.CRAWL4AI",
    routes: ["crawl"],
    minAccess: "free",
    // Retired. Its job pipeline is disabled at the route table (see the ADR
    // §10), so a request that resolved here would not answer at all — the worst
    // kind of gap, because the caller sees a hang and not a refusal.
    retired: true,
    jobModel: "job",
    byok: false,
    capabilities: {
      batch: true,
      stateful: true,
      profiles: true,
      challenge: false,
      typedJson: false,
    },
    notes:
      "Retired. Async job pipeline (temp_task_id -> Celery task_id -> SSE).",
  },
  {
    id: "jina",
    labelKey: "SCRAPE_PROVIDER.JINAAI",
    routes: ["jina"],
    minAccess: "free",
    retired: false,
    jobModel: "sync",
    byok: true,
    capabilities: {
      batch: false,
      stateful: false,
      profiles: false,
      challenge: false,
      typedJson: false,
    },
    notes: "External reader, one URL per request, server-held key.",
  },
  {
    id: "webrain",
    labelKey: "SCRAPE_PROVIDER.WEBRAIN",
    routes: ["crawl"],
    // Free-selectable, because it is the only engine left on this route. It was
    // a paid perk while `crawl4ai` was also selectable; keeping that would give
    // a free caller an EMPTY engine list while their requests were already
    // going to webrain as the platform default. The offer has to match what the
    // platform actually does.
    minAccess: "free",
    retired: false,
    jobModel: "mcp",
    byok: false,
    capabilities: {
      batch: true,
      stateful: true,
      profiles: true,
      challenge: true,
      typedJson: true,
    },
    notes:
      "Embedded MCP engine. Only provider that reports gates and typed JSON.",
  },
] as const

/**
 * The provider used when nothing is stored, and when a stored choice cannot be
 * honoured.
 *
 * `webrain` is the platform's engine. `crawl4ai` must NOT be the fallback: it
 * is `retired`, so its pipeline does not answer, which makes a fallback that
 * lands there a fallback that fails.
 */
export const FALLBACK_PROVIDER: ScrapeProviderId = "webrain"

export const isScrapeProviderId = (value: unknown): value is ScrapeProviderId =>
  typeof value === "string" &&
  SCRAPE_PROVIDERS.some((provider) => provider.id === value)

export const providerDescriptor = (
  id: ScrapeProviderId
): ScrapeProviderDescriptor =>
  // Every id comes from the catalogue, so this cannot miss; the non-null
  // assertion keeps callers free of an impossible `| undefined`.
  SCRAPE_PROVIDERS.find(
    (provider) => provider.id === id
  ) as ScrapeProviderDescriptor

/**
 * The platform default: `SCRAPE_PROVIDER` when it names a real, non-retired
 * provider that serves the route, otherwise the fallback.
 *
 * Validation matters here. The env var used to be read as "webrain if it equals
 * webrain, else crawl4ai", which silently accepted a typo as crawl4ai. A
 * misconfigured default is now visible as a rejected value rather than being
 * indistinguishable from the intended one.
 *
 * A retired name is ignored for the same reason a typo is. This value is set by
 * hand, so a stale `SCRAPE_PROVIDER=crawl4ai` left over from before the
 * retirement would otherwise keep sending every defaulted request to a pipeline
 * whose routes are gone — the exact failure this file exists to prevent.
 * @param {*} route
 * @return {*}
 */
export const platformDefaultProvider = (
  route: ScrapeRoute = "crawl"
): ScrapeProviderId => {
  const configured = env.SCRAPE_PROVIDER
  if (
    isScrapeProviderId(configured) &&
    !providerDescriptor(configured).retired &&
    providerDescriptor(configured).routes.includes(route)
  ) {
    return configured
  }
  return FALLBACK_PROVIDER
}

/** True when the access mode is anything other than free.
 * @param {*} accessMode
 * @return {*}
 */
export const isPaidAccess = (accessMode: string | undefined): boolean =>
  typeof accessMode === "string" && accessMode !== "" && accessMode !== "free"

/** The descriptors a caller may choose from on a route, given their access.
 *
 * A `retired` provider is never offered, whatever the plan. Offering one is
 * what let a caller select `crawl4ai` after its job pipeline had been removed
 * from the route table: the setting was accepted, echoed back as stored, and
 * then every run failed. An empty list is a worse-looking answer than a wrong
 * one, but it is the honest one.
 * @param {*} accessMode
 * @param {*} route
 * @return {*}
 */
export const selectableProviders = (
  accessMode: string | undefined,
  route: ScrapeRoute = "crawl"
): ScrapeProviderDescriptor[] =>
  SCRAPE_PROVIDERS.filter(
    (provider) =>
      !provider.retired &&
      provider.routes.includes(route) &&
      (provider.minAccess === "free" || isPaidAccess(accessMode))
  )

export interface ProviderResolution {
  provider: ScrapeProviderId
  /**
   * Where the answer came from, for the UI to explain and for logs to
   * trace.
   */
  source: "user" | "platform"
  /**
   * Set when a stored preference existed but could not be honoured — the
   * provider is `retired`, does not serve this route, or the plan is not
   * entitled to it. The caller should surface this: silently downgrading is how
   * a user concludes the product ignored their setting.
   *
   * `retired` is distinct from `entitlement` on purpose. They lead a caller to
   * opposite actions: one says "choose another engine", the other says "upgrade"
   * and upgrading would change nothing.
   */
  rejected?: {
    value: unknown
    reason: "unknown" | "route" | "retired" | "entitlement"
  }
}

/**
 * The one place a provider is chosen.
 *
 * Order: the user's stored preference wins, but only if it names a real
 * provider
 * that serves this route AND the caller is entitled to select it. Otherwise the
 * platform default is used — never the raw stored value, so a stale or
 * hand-edited
 * document cannot route traffic to something the catalogue does not recognise.
 * @param {*} stored
 * @param {*} accessMode
 * @param {*} route
 * @return {*}
 */
export const resolveProvider = (
  stored: unknown,
  accessMode: string | undefined,
  route: ScrapeRoute = "crawl"
): ProviderResolution => {
  if (stored === undefined || stored === null || stored === "") {
    return { provider: platformDefaultProvider(route), source: "platform" }
  }

  if (!isScrapeProviderId(stored)) {
    return {
      provider: platformDefaultProvider(route),
      source: "platform",
      rejected: { value: stored, reason: "unknown" },
    }
  }

  const descriptor = providerDescriptor(stored)

  // Checked BEFORE the route and the plan, because neither can make a retired
  // provider answer. The reason has to describe the provider's state rather
  // than the caller's entitlement, or support reads "not on your plan" and
  // sells an upgrade that changes nothing -- and the request still fails.
  if (descriptor.retired) {
    return {
      provider: platformDefaultProvider(route),
      source: "platform",
      rejected: { value: stored, reason: "retired" },
    }
  }

  if (!descriptor.routes.includes(route)) {
    return {
      provider: platformDefaultProvider(route),
      source: "platform",
      rejected: { value: stored, reason: "route" },
    }
  }

  if (descriptor.minAccess === "paid" && !isPaidAccess(accessMode)) {
    return {
      provider: platformDefaultProvider(route),
      source: "platform",
      rejected: { value: stored, reason: "entitlement" },
    }
  }

  return { provider: stored, source: "user" }
}
