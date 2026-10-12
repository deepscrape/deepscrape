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
 * The vendors that serve a CHAT completion.
 *
 * Kept as a union rather than `string` so a vendor added to the catalogue and
 * forgotten here fails the type check instead of rendering as an unlabelled
 * row.
 *
 * `jina` is deliberately NOT here -- it is a reader, a scrape provider beside
 * `crawl4ai` and `webrain`, and it sat in this union only because the key store
 * was keyed by it. A union of chat vendors cannot describe a reader.
 */
export type AiVendorId =
  | 'anthropic'
  | 'openai'
  | 'groq'
  | 'deepseek'
  | 'fireworks'
  | 'qwen'
  | 'kimi'
  | 'openrouter'
  | 'gemini'
  | 'custom';

/**
 * A scrape provider the platform has integrated.
 *
 * A client mirror of `ScrapeProviderId` rather than an import: the browser cannot reach
 * the functions package, and the only use here is naming a provider in the settings panel.
 * `jina` is the only one a caller may bring a key for, which is why this union exists at
 * all on this side.
 */
export type ScrapeProviderId = 'crawl4ai' | 'jina' | 'webrain';

/**
 * Everything the platform holds a credential for, or a caller may bring one for.
 *
 * The key store answers one question -- "which credential do we use for this upstream, and
 * whose is it" -- and that question does not care whether the upstream is a chat vendor or
 * a reader. Keying it by `AiVendorId` alone is what forced `jina` into a union of chat
 * vendors: the store had nowhere else to put it.
 */
export type ProviderKeyId = AiVendorId | ScrapeProviderId;

/**
 * What the platform knows about one model.
 *
 * A client mirror of `functions/src/domain/model-facts.domain.ts`, and the same rule as
 * everywhere else in this file: the server's answer is the correct one and this is the shape it
 * arrives in.
 *
 * Every field is optional because ABSENT MEANS UNKNOWN. A model the registry has never heard of
 * must read as "no facts", which is a different answer from "no vision, no audio, and free" --
 * and only one of those two is true.
 *
 * `inputCostPerMTokens` is per MILLION, which is the registry's published unit. The table in
 * `aiapi.fun.ts` is per 1K, and the conversion lives in the one function that reads both, so a
 * unit mix-up is a 1000x error in a displayed price rather than a silent one.
 */
export interface ModelFacts {
  /** Present only when known to be true; see the absent-means-unknown rule above. */
  vision?: boolean;
  audio?: boolean;
  video?: boolean;
  pdf?: boolean;
  /** Tokens accepted in one request. */
  contextLength?: number;
  maxOutputTokens?: number;
  /** USD per 1 million input tokens. */
  inputCostPerMTokens?: number;
  outputCostPerMTokens?: number;
  /**
   * `YYYY-MM-DD` on which the registry says this model retires.
   *
   * Present only when the registry's own key for the model is canonical: a cloud deployment's
   * retirement date is not a fact about the model this platform offers, so it is dropped rather
   * than passed on. Absent therefore means "no reliable retirement date", not "retires never".
   */
  deprecatedOn?: string;
}

/**
 * One vendor's catalogue: the ids it serves, and whatever facts could be attached to them.
 *
 * They travel together because they answer one question, and because the two halves fail
 * independently: a registry outage leaves the ids intact with no facts, and a vendor outage
 * leaves both empty. The caller falls back to its own table either way rather than failing.
 */
export interface ModelCatalogue {
  models: string[];
  facts: Readonly<Record<string, ModelFacts>>;
}

/**
 * The vendors reached over the OpenAI wire protocol.
 *
 * `anthropic` speaks its own protocol and has its own method; everything else is this shape,
 * including a caller's own endpoint -- which is why `custom` is here rather than beside it.
 *
 * No `jina` exclusion is needed any more: it is a scrape provider and is not in `AiVendorId`
 * at all. It had to be carved out for exactly as long as it was wrongly listed as a chat
 * vendor.
 *
 * This exists so the transport can key a table by vendor and get a compile error rather than
 * a misroute when the catalogue grows.
 */
export type OpenAiChatVendor = Exclude<AiVendorId, 'anthropic'>;

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
  // BYOK-only, matching the server rows one for one. `internalKey: false` is what makes
  // the settings row read "requires your own API key" rather than "not in your plan",
  // which is the difference between a remedy the user can act on and one they cannot.
  { id: 'deepseek', labelKey: 'AI_VENDOR.DEEPSEEK', internalKey: false, minAccess: 'paid', byok: true },
  { id: 'fireworks', labelKey: 'AI_VENDOR.FIREWORKS', internalKey: false, minAccess: 'paid', byok: true },
  { id: 'qwen', labelKey: 'AI_VENDOR.QWEN', internalKey: false, minAccess: 'paid', byok: true },
  { id: 'kimi', labelKey: 'AI_VENDOR.KIMI', internalKey: false, minAccess: 'paid', byok: true },
  { id: 'openrouter', labelKey: 'AI_VENDOR.OPENROUTER', internalKey: false, minAccess: 'paid', byok: true },
  { id: 'gemini', labelKey: 'AI_VENDOR.GEMINI', internalKey: false, minAccess: 'paid', byok: true },
  // The caller's own endpoint, key and models. BYOK-only by construction: there is no
  // platform route to this vendor in any deployment, because the URL itself is the
  // caller's.
  { id: 'custom', labelKey: 'AI_VENDOR.CUSTOM', internalKey: false, minAccess: 'paid', byok: true },
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
  /**
   * The address the BFF would dial for this vendor, or null.
   *
   * Only `custom` ever has one, and it is not a credential: it is the caller's own URL,
   * reported back so the panel can show which address is configured rather than asking
   * the user to remember what they typed.
   */
  endpoint: string | null;
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
 * One reader a caller may bring their own key for, as the server reports it.
 *
 * Deliberately three fields: an id, a label, and whether a key is stored. There is no
 * `allowed` and no `source` because a reader has no plan entitlement to resolve -- the
 * scrape catalogue's `byok` is the whole rule, and the server has already applied it.
 */
export interface ReaderKeyState {
  id: ScrapeProviderId;
  labelKey: string;
  hasKey: boolean;
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
    /**
     * Readers with a BYOK option, and whether one is stored.
     *
     * In the `scrape` half rather than in `ai.vendors` because a reader is a scrape provider:
     * `jina` reads a URL, it does not complete a chat. Its key presence is reported here so
     * the panel can render its input on the surface that chooses a scrape engine.
     */
    keys: ReaderKeyState[];
  };
  ai: {
    vendors: AiVendorState[];
  };
}

/**
 * The `setMyAiKey` request. The key travels in the body and nowhere else.
 *
 * `endpoint` is required by the `custom` vendor and REFUSED by every other one, which the
 * server enforces rather than ignoring: a quietly dropped field is a user who believes
 * they pointed a vendor at their own proxy while the platform kept calling the vendor.
 */
export interface SetMyAiKeyRequest {
  vendor: ProviderKeyId;
  key: string;
  endpoint?: string;
}

/** The `clearMyAiKey` request. */
export interface ClearMyAiKeyRequest {
  vendor: ProviderKeyId;
}

/**
 * What both mutation callables answer.
 *
 * Deliberately no member that can hold a key. A caller cannot use the write endpoint to read
 * back what it wrote, and a proxy or a log capturing the reply captures no credential.
 */
export interface AiKeyMutationResponse {
  vendor: ProviderKeyId;
  hasKey: boolean;
  /**
   * The stored endpoint, echoed for the `custom` vendor and null for every other.
   *
   * Not a credential, and reported so the panel can show which address is configured. The
   * key has no counterpart here: there is still no read-back path for it.
   */
  endpoint: string | null;
}

/**
 * The model-dropdown `code` to the vendor it calls.
 *
 * The dropdown speaks in its own vocabulary (`claude`) while the vendor
 * catalogue speaks in vendor ids (`anthropic`), and the two are not the same
 * word. This maps the CODE. `vendorForModel` reads a model NAME back to a
 * vendor, but only for the two that share the OpenAI table, which is why the
 * code is carried explicitly rather than inferred from the name.
 *
 * Two axes rather than two copies of one: a code answers "whose key does this
 * need" for the BYOK UI, and -- since the picker started listing each vendor's
 * LIVE catalogue -- "where does this request go" for the transport, because a
 * model id read out of a vendor's catalogue is only attributable to the vendor
 * it was read from. `apiName` (`groqai`/`openai`) stays a third spelling for the
 * reason it always did: Groq nests `usage` differently, so the transport needs
 * to know which vendor it asked.
 */
export const AI_MODEL_VENDOR: Readonly<Record<string, AiVendorId>> = {
  claude: 'anthropic',
  openai: 'openai',
  groq: 'groq',
  deepseek: 'deepseek',
  fireworks: 'fireworks',
  qwen: 'qwen',
  kimi: 'kimi',
  openrouter: 'openrouter',
  gemini: 'gemini',
  custom: 'custom',
};

/**
 * The vendor a model-dropdown code calls, or null when the code is not one the
 * catalogue knows.
 * @param {string} code The dropdown code.
 * @return {AiVendorId | null} The vendor, when the code maps to one.
 */
export const vendorForModelCode = (code: string): AiVendorId | null =>
  AI_MODEL_VENDOR[code] ?? null;

/**
 * The dropdown `code` that stands for a vendor.
 *
 * The identity for every vendor except Anthropic, whose code is the legacy `claude`. Kept
 * as a function rather than a second table so the two directions cannot disagree: the pairs
 * live in `AI_MODEL_VENDOR`, and this is the one case where the pair is not symmetric.
 *
 * `jina` has no code either way -- it is a reader, not a chat model, and never appears in a
 * model dropdown.
 * @param {AiVendorId} vendor The vendor.
 * @return {string} The code the dropdown uses for it.
 */
export const modelCodeForVendor = (vendor: AiVendorId): string =>
  vendor === 'anthropic' ? 'claude' : vendor;
