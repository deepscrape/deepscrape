/* eslint-disable object-curly-spacing */
/**
 * AI vendors, and where the key for a call comes from.
 *
 * The rule this file exists to state
 * ----------------------------------
 * There are two ways a request can be paid for, and they are not
 * interchangeable:
 *
 *   - the platform's own key, which costs the platform money and is therefore a
 *     PLAN ENTITLEMENT — a free account does not get it;
 *   - the user's own key (BYOK), which costs the platform nothing and is
 *     therefore available to anyone, including a free account, because there is
 *     no quota of ours to protect.
 *
 * Treating those as one switch is what produces the two bugs worth avoiding: a
 * free user spending platform credit, and a paying user being told they must
 * bring a key for a model their plan already covers. So the source of the key
 * is
 * resolved separately from whether the request is allowed at all, and both are
 * pure functions of (vendor, plan, has-user-key).
 *
 * What is deliberately absent
 * ---------------------------
 * No model list. Naming models in code dates the moment a vendor ships one, and
 * a hardcoded list turns "new model available" into a deploy. The model is a
 * bounded, validated string that belongs to the vendor; what the platform owns
 * is
 * which VENDOR a plan may call, and with whose key. Model discovery belongs in
 * the UI reading the vendor, not in a constant here.
 *
 * No key values, ever. This module names the environment variable that holds
 * the
 * platform key so the resolver can report what is MISSING, and never reads it.
 * User keys are write-only by construction: nothing in this file can return
 * one.
 */

/**
 * The vendors the platform integrates. Grounded in `AiApiService`'s four
 * endpoints.
 */
export type AiVendorId = "anthropic" | "openai" | "groq" | "jina"

export interface AiVendorDescriptor {
  id: AiVendorId
  /** i18n key for the display name, so this catalogue carries no English. */
  labelKey: string
  /**
   * Whether the platform holds its own credential for this vendor.
   *
   * `false` means the platform cannot serve this vendor at all — BYOK is the
   * only route, and a plan does not change that. Reporting it honestly is
   * what
   * lets the UI say "bring a key", instead of offering a plan-gated option
   * that
   * would fail at the vendor.
   */
  internalKey: boolean
  /** Minimum access mode required to spend the PLATFORM key. */
  minAccess: "free" | "paid"
  /** Whether a user-supplied key is accepted for this vendor. */
  byok: boolean
  /**
   * The env variable holding the platform key — a NAME, never a value.
   *
   * Named so the resolver can distinguish "you are not entitled to this" from
   * "this deployment has no key configured", which are different problems
   * with
   * different remedies and should not read as the same error.
   */
  envKeyName: string
  notes: string
}

/**
 * What the platform has integrated today.
 *
 * `anthropic`, `openai` and `groq` are plan entitlements: the platform holds a
 * key and pays for the call, so they are paid-only. `jina` is a reader rather
 * than a chat model and is reachable through the existing crawl path; it is
 * listed because a user may want to point it at their own quota.
 */
export const AI_VENDORS: readonly AiVendorDescriptor[] = [
  {
    id: "anthropic",
    labelKey: "AI_VENDOR.ANTHROPIC",
    internalKey: true,
    minAccess: "paid",
    byok: true,
    envKeyName: "CLAUDE_API_KEY",
    notes:
      "Chat and streaming completions. Platform key is a plan entitlement.",
  },
  {
    id: "openai",
    labelKey: "AI_VENDOR.OPENAI",
    internalKey: true,
    minAccess: "paid",
    byok: true,
    envKeyName: "OPENAI_API_KEY",
    notes:
      "Chat and streaming completions. Platform key is a plan entitlement.",
  },
  {
    id: "groq",
    labelKey: "AI_VENDOR.GROQ",
    internalKey: true,
    minAccess: "paid",
    byok: true,
    envKeyName: "GROQ_API_KEY",
    notes: "Low-latency completions. Platform key is a plan entitlement.",
  },
  {
    id: "jina",
    labelKey: "AI_VENDOR.JINA",
    internalKey: true,
    minAccess: "paid",
    byok: true,
    envKeyName: "JINAAI_API_KEY",
    notes: "Reader, not a chat model. Served through the crawl path.",
  },
] as const

/** Where the credential for a call came from. */
export type AiKeySource = "user" | "platform" | "none"

/** Why a vendor is unavailable, when it is. */
export type AiKeyRefusal =
  "unknown-vendor" | "plan-required" | "byok-required" | "unsupported"

export interface AiKeyResolution {
  vendor: AiVendorDescriptor | null
  source: AiKeySource
  allowed: boolean
  refusal?: AiKeyRefusal
}

/**
 * Anything that is not explicitly free counts as paid — see
 * `scrape-providers.domain.ts`.
 * @param {*} accessMode
 * @return {*}
 */
export const isPaidPlan = (accessMode: string | undefined): boolean => {
  if (!accessMode) {
    return false
  }
  return accessMode !== "free"
}

export const isAiVendorId = (value: unknown): value is AiVendorId =>
  typeof value === "string" && AI_VENDORS.some((vendor) => vendor.id === value)

export const aiVendorDescriptor = (id: AiVendorId): AiVendorDescriptor => {
  const vendor = AI_VENDORS.find((candidate) => candidate.id === id)
  if (!vendor) {
    throw new Error(`Unknown AI vendor: ${id}`)
  }
  return vendor
}

/**
 * The vendors a plan may use, and by which route.
 *
 * Returned for the settings UI so it can render the real options rather than a
 * list the user has to guess from. `source` here is what would be used IF the
 * user has a key for the vendors where that applies, so the caller passes
 * `mappedKeys` — the set of vendor ids the user has already stored a key for.
 * The set is ids only; no value crosses this boundary.
 * @param {*} accessMode
 * @param {*} mappedKeys
 * @return {*}
 */
export const availableVendors = (
  accessMode: string | undefined,
  mappedKeys: readonly AiVendorId[]
): AiKeyResolution[] =>
  AI_VENDORS.map((vendor) =>
    resolveAiKeySource(vendor.id, accessMode, mappedKeys.includes(vendor.id))
  )

/**
 * Resolves where the key for a call to `vendorId` would come from.
 *
 * Order matters and is the whole point: a user's own key is tried FIRST, so
 * someone on a paid plan who has brought a key spends their own quota rather
 * than
 * the platform's. That is what they asked for by supplying it, and it is also
 * the
 * behaviour that keeps the platform's spend predictable.
 * @param {*} vendorId
 * @param {*} accessMode
 * @param {*} hasUserKey
 * @return {*}
 */
export const resolveAiKeySource = (
  vendorId: unknown,
  accessMode: string | undefined,
  hasUserKey: boolean
): AiKeyResolution => {
  if (!isAiVendorId(vendorId)) {
    return {
      vendor: null,
      source: "none",
      allowed: false,
      refusal: "unknown-vendor",
    }
  }

  const vendor = aiVendorDescriptor(vendorId)

  if (hasUserKey) {
    if (!vendor.byok) {
      return { vendor, source: "none", allowed: false, refusal: "unsupported" }
    }
    return { vendor, source: "user", allowed: true }
  }

  if (vendor.internalKey && isPaidPlan(accessMode)) {
    return { vendor, source: "platform", allowed: true }
  }

  // Distinguish the two refusals: a vendor the platform never held a key for
  // cannot be fixed by upgrading, so telling the user to upgrade would be
  // wrong.
  if (!vendor.internalKey) {
    return { vendor, source: "none", allowed: false, refusal: "byok-required" }
  }

  return { vendor, source: "none", allowed: false, refusal: "plan-required" }
}

/**
 * Whether a stored BYOK key looks presentable at all.
 *
 * Deliberately a length floor and a whitespace rule, not a format guess: vendor
 * key formats change without notice, and a regex that rejects a valid new key
 * is
 * a support ticket with no workaround. The real test is the first call, which
 * fails with the vendor's own message.
 * @param {*} value
 * @return {*}
 */
export const isPlausibleApiKey = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length >= 16 &&
  value.trim().length <= 512
