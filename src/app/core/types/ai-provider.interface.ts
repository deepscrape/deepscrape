/**
 * The frontend mirror of `functions/src/domain/user-ai-settings.domain.ts`.
 *
 * Why a mirror and not a second model
 * ----------------------------------
 * The rules about whose credential pays for a call are a SERVER decision, and
 * the server already reports its answer: `getMySettings` returns, per vendor,
 * `allowed` / `source` / `refusal` / `hasKey`. Those values are what the UI
 * must render. What the mirror is for is the one question the server cannot
 * answer for a component that has not called it yet, and for stating the rule
 * in a place the template can read without a round trip.
 *
 * So the shape below is a port, not an invention. If the server's rules change,
 * this file is stale and the server's reply is still correct: `AiKeysService`
 * prefers the reported resolution whenever it has one, and falls back to
 * `resolveAiKeySource` only when it does not. That ordering is what makes the
 * mirror safe to keep.
 *
 * What is deliberately absent
 * ---------------------------
 * No `envKeyName`. The server's descriptor carries the NAME of the environment
 * variable holding the platform key, for the resolver to report what is
 * missing. The browser has no use for that name, and carrying it here would put
 * a list of platform secret names in a bundle for no consumer.
 *
 * No field for a key VALUE, anywhere in this file. A stored key is
 * write-only by construction: `AiVendorState` reports `hasKey`, the mutation
 * replies report `hasKey`, and no type here has a member that could hold key
 * material even if a caller tried to put one there.
 */

/**
 * The vendors the platform integrates.
 *
 * Kept as a union rather than `string` so a vendor added to the catalogue and
 * forgotten here fails the type check instead of rendering as an unlabelled
 * row.
 */
export type AiVendorId = 'anthropic' | 'openai' | 'groq' | 'jina';

export interface AiVendorDescriptor {
  id: AiVendorId;
  /** i18n key for the display name, so this catalogue carries no English. */
  labelKey: string;
  /**
   * Whether the platform holds its own credential for this vendor.
   *
   * `false` means BYOK is the only route and a plan does not change that, which
   * is what lets the UI say "bring a key" instead of offering a plan-gated
   * option that would fail at the vendor.
   */
  internalKey: boolean;
  /** Minimum access mode required to spend the PLATFORM key. */
  minAccess: 'free' | 'paid';
  /** Whether a user-supplied key is accepted for this vendor. */
  byok: boolean;
}

/** What the platform has integrated today. Mirrors `AI_VENDORS`. */
export const AI_VENDORS: readonly AiVendorDescriptor[] = [
  { id: 'anthropic', labelKey: 'AI_VENDOR.ANTHROPIC', internalKey: true, minAccess: 'paid', byok: true },
  { id: 'openai', labelKey: 'AI_VENDOR.OPENAI', internalKey: true, minAccess: 'paid', byok: true },
  { id: 'groq', labelKey: 'AI_VENDOR.GROQ', internalKey: true, minAccess: 'paid', byok: true },
  { id: 'jina', labelKey: 'AI_VENDOR.JINA', internalKey: true, minAccess: 'paid', byok: true },
];

/** Where the credential for a call came from. */
export type AiKeySource = 'user' | 'platform' | 'none';

/** Why a vendor is unavailable, when it is. */
export type AiKeyRefusal = 'unknown-vendor' | 'plan-required' | 'byok-required' | 'unsupported';

export interface AiKeyResolution {
  vendor: AiVendorDescriptor | null;
  source: AiKeySource;
  allowed: boolean;
  refusal?: AiKeyRefusal;
}

/**
 * Anything that is not explicitly free counts as paid, so an unrecognised mode
 * fails closed rather than handing out the platform key.
 * @param {string | undefined} accessMode The plan mode reported by the server.
 * @return {boolean} Whether the mode may spend the platform key.
 */
export const isPaidPlan = (accessMode: string | undefined): boolean => {
  if (!accessMode) {
    return false;
  }
  return accessMode !== 'free';
};

/**
 * The vendor descriptor for an id, or null when the id is not one of ours.
 *
 * Null-returning rather than throwing, because the call sites here are
 * rendering paths where an unknown id is a data problem to show, not an
 * exception to escape into a template.
 * @param {unknown} value The candidate id.
 * @return {AiVendorDescriptor | null} The descriptor, when the id is known.
 */
export const aiVendorDescriptor = (value: unknown): AiVendorDescriptor | null =>
  AI_VENDORS.find(vendor => vendor.id === value) ?? null;

export const isAiVendorId = (value: unknown): value is AiVendorId =>
  typeof value === 'string' && AI_VENDORS.some(vendor => vendor.id === value);

/**
 * Where the key for a call to `vendorId` would come from.
 *
 * Ported from the server, order included: a user's own key is tried FIRST, so
 * a paid user who brought a key spends their own quota rather than ours.
 * @param {unknown} vendorId The vendor the call targets.
 * @param {string | undefined} accessMode The plan mode.
 * @param {boolean} hasUserKey Whether the user has stored a key for this vendor.
 * @return {AiKeyResolution} The source, whether it is allowed, and why not.
 */
export const resolveAiKeySource = (
  vendorId: unknown,
  accessMode: string | undefined,
  hasUserKey: boolean
): AiKeyResolution => {
  const vendor = aiVendorDescriptor(vendorId);

  if (!vendor) {
    return { vendor: null, source: 'none', allowed: false, refusal: 'unknown-vendor' };
  }

  if (hasUserKey) {
    if (!vendor.byok) {
      return { vendor, source: 'none', allowed: false, refusal: 'unsupported' };
    }
    return { vendor, source: 'user', allowed: true };
  }

  if (vendor.internalKey && isPaidPlan(accessMode)) {
    return { vendor, source: 'platform', allowed: true };
  }

  // Two refusals, kept apart: a vendor the platform never held a key for cannot
  // be fixed by upgrading, so telling the user to upgrade would be wrong.
  if (!vendor.internalKey) {
    return { vendor, source: 'none', allowed: false, refusal: 'byok-required' };
  }

  return { vendor, source: 'none', allowed: false, refusal: 'plan-required' };
};

/**
 * Whether a candidate key is presentable at all.
 *
 * A length floor and a whitespace rule, not a format guess: vendor key formats
 * change without notice, and a regex that rejects a valid new key is a support
 * ticket with no workaround. The real test is the first call, which fails with
 * the vendor's own message.
 *
 * This is the client-side twin of the server's `isPlausibleApiKey`, used to
 * disable the save button. The server validates again and its answer wins; this
 * exists so the user is not offered a button that is certain to be rejected.
 * @param {unknown} value The candidate.
 * @return {boolean} Whether it looks like a key.
 */
export const isPlausibleApiKey = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length >= 16 && value.trim().length <= 512;

/**
 * One vendor's entry in the `getMySettings` reply.
 *
 * `id` and `labelKey` are nullable because the server types them that way:
 * a resolution for an unknown vendor has no descriptor to name. In practice
 * `availableVendors` only ever walks the catalogue, so a null id means the
 * catalogue itself changed under the client, and the row should be skipped
 * rather than rendered blank.
 *
 * There is no member holding key material, and no member holding a
 * last-updated time either: the server does not report one (see the SECURITY
 * note in `gfunctions/user-settings.ts`). The UI can therefore show PRESENCE
 * and nothing more.
 */
export interface AiVendorState {
  id: AiVendorId | null;
  labelKey: string | null;
  allowed: boolean;
  source: AiKeySource;
  refusal: AiKeyRefusal | null;
  hasKey: boolean;
}

/** One selectable scraping engine, as `getMySettings` reports it. */
export interface ScrapeProviderState {
  id: string;
  labelKey: string;
  /** The server's own description of the engine. English, because it is data. */
  notes: string;
  capabilities: {
    batch: boolean;
    stateful: boolean;
    profiles: boolean;
    challenge: boolean;
    typedJson: boolean;
  };
}

/** The `setMyScrapeProvider` request. */
export interface SetMyScrapeProviderRequest {
  provider: string;
}

/**
 * What `setMyScrapeProvider` answers.
 *
 * `stored` is echoed back rather than the request being assumed to have taken
 * effect: the server validates the choice against the same catalogue the crawl
 * path resolves from, so this value is the one a later crawl will really use.
 */
export interface ScrapeProviderMutationResponse {
  stored: string;
}

/**
 * The part of the `getMySettings` reply this surface consumes.
 *
 * BOTH halves are declared, and the `scrape` half is the one nobody read. The
 * server composes them into a single call so they cannot disagree about the
 * plan, so a client that consumed only `ai` was silently ignoring the engine
 * its own crawl traffic would route to.
 */
export interface MyAiSettings {
  accessMode: string;
  scrape: {
    stored: string | null;
    selectable: ScrapeProviderState[];
  };
  ai: {
    vendors: AiVendorState[];
  };
}

/** The `setMyAiKey` request. The key travels in the body and nowhere else. */
export interface SetMyAiKeyRequest {
  vendor: AiVendorId;
  key: string;
}

/** The `clearMyAiKey` request. */
export interface ClearMyAiKeyRequest {
  vendor: AiVendorId;
}

/**
 * What both mutation callables answer.
 *
 * Deliberately two fields and no key. A caller cannot use the write endpoint to
 * read back what it wrote, and a proxy or a log capturing the reply captures no
 * credential.
 */
export interface AiKeyMutationResponse {
  vendor: AiVendorId;
  hasKey: boolean;
}

/**
 * The model-dropdown `code` to the vendor it calls.
 *
 * The dropdown speaks in its own vocabulary (`claude`) while the vendor
 * catalogue speaks in vendor ids (`anthropic`), and the two are not the same
 * word. This maps the CODE; `isGroqModel` decides the ENDPOINT from a model NAME.
 * Two axes rather than two copies of one: a code answers "whose key does this
 * need" for the BYOK UI, a name answers "where does this request go" for the
 * transport.
 *
 * The note that previously sat here said this table should move beside the old
 * `switchModelApiEndpoint`. That function is gone -- `isGroqModel` replaced it --
 * and no merge was done, because the two answer different questions. `apiName`
 * (`groqai`/`openai`) stays a third spelling for the reason it always did: Groq
 * nests `usage` differently, so the transport needs to know which vendor it
 * asked.
 */
export const AI_MODEL_VENDOR: Readonly<Record<string, AiVendorId>> = {
  claude: 'anthropic',
  openai: 'openai',
  groq: 'groq',
};

/**
 * The vendor a model-dropdown code calls, or null when the code is not one the
 * catalogue knows.
 * @param {string} code The dropdown code.
 * @return {AiVendorId | null} The vendor, when the code maps to one.
 */
export const vendorForModelCode = (code: string): AiVendorId | null =>
  AI_MODEL_VENDOR[code] ?? null;
