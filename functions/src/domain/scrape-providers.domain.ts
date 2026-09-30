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
  jobModel: ScrapeJobModel
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
 * `crawl4ai` (the `crawlagent` service) is the FROZEN provider: it stays
 * installed and keeps working, and it receives no new development. `jina` is an
 * external reader. `webrain` is the embedded engine — the one the platform is
 * moving to, and the only one that reports gates and typed JSON.
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
    jobModel: "job",
    capabilities: {
      batch: true,
      stateful: true,
      profiles: true,
      challenge: false,
      typedJson: false,
    },
    // Frozen: still installed and supported, no longer developed. Its job
    // pipeline is currently disabled at the route table (see the ADR §10).
    notes:
      "Frozen. Async job pipeline (temp_task_id -> Celery task_id -> SSE).",
  },
  {
    id: "jina",
    labelKey: "SCRAPE_PROVIDER.JINAAI",
    routes: ["jina"],
    minAccess: "free",
    jobModel: "sync",
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
    // Selecting it explicitly is a paid perk. Free traffic still reaches the
    // shared, stateless pool when the platform default is webrain — that is a
    // platform decision, not a user one.
    minAccess: "paid",
    jobModel: "mcp",
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
 * The provider used when nothing is stored. `crawl4ai` keeps today's
 * behaviour.
 */
export const FALLBACK_PROVIDER: ScrapeProviderId = "crawl4ai"

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
 * The platform default: `SCRAPE_PROVIDER` when it names a real provider that
 * serves the route, otherwise the fallback.
 *
 * Validation matters here. The env var used to be read as "webrain if it equals
 * webrain, else crawl4ai", which silently accepted a typo as crawl4ai. A
 * misconfigured default is now visible as a rejected value rather than being
 * indistinguishable from the intended one.
 * @param {*} route
 * @return {*}
 */
export const platformDefaultProvider = (
  route: ScrapeRoute = "crawl"
): ScrapeProviderId => {
  const configured = env.SCRAPE_PROVIDER
  if (
    isScrapeProviderId(configured) &&
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
   * Set when a stored preference existed but could not be honoured — either
   * the
   * provider does not serve this route or the plan is not entitled to it. The
   * caller should surface this: silently downgrading is how a user concludes
   * the
   * product ignored their setting.
   */
  rejected?: { value: unknown; reason: "unknown" | "route" | "entitlement" }
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
