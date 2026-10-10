import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  AI_VENDORS,
  AiKeyMutationResponse,
  AiKeyResolution,
  AiKeySource,
  AiVendorId,
  AiVendorState,
  ClearMyAiKeyRequest,
  MyAiSettings,
  ScrapeProviderMutationResponse,
  ScrapeProviderState,
  SetMyAiKeyRequest,
  SetMyScrapeProviderRequest,
  aiVendorDescriptor,
  resolveAiKeySource,
  vendorForModelCode,
} from '../types';
import { FirestoreService } from './firestore.service';

/** The callable names, spelled once so a rename is one edit. */
const CALLABLE = {
  getMySettings: 'getMySettings',
  setMyAiKey: 'setMyAiKey',
  clearMyAiKey: 'clearMyAiKey',
  setMyScrapeProvider: 'setMyScrapeProvider',
} as const;

/**
 * The caller's AI vendor state, and the two writes that change it.
 *
 * Whose key pays: the server decides, this reports
 * ------------------------------------------------
 * Nothing here selects a credential. `ai_handler.ts`'s `keyFor` is the single
 * place a vendor key is chosen, and it reads the user's stored key first. The
 * browser cannot influence that choice and must not try: it holds no key, so it
 * has none to send and none to leak.
 *
 * NEVER RENDER KEY MATERIAL
 * -------------------------
 * This is the invariant the whole file is shaped around:
 *
 *  1. No member of this class, of `AiVendorState`, or of
 *     `AiKeyMutationResponse` can hold a key. Presence is a boolean.
 *  2. `storeKey`'s `key` parameter is the only reference to the value, it is
 *     placed in the callable payload and never assigned anywhere else, never
 *     logged, and never included in an error message. The payload is built on
 *     the stack of that one call.
 *  3. No error path echoes the request body. `describe` reads `error.message`
 *     only, and the server's own messages name the problem ("That does not look
 *     like an API key.") without the value.
 *  4. There is no read-back method. The server has no endpoint that returns a
 *     key, so there is nothing to call.
 *
 * The cost of getting (2) wrong is a credential in a log, so the rule is stated
 * here rather than left to the reviewer to notice.
 *
 * What the UI cannot show, and why
 * -------------------------------
 * There is no "last updated" time. The server stores the key as a plain field
 * on `users/{uid}/private/ai` and `getMySettings` reports only presence, so
 * this surface can say WHICH vendors have a key and nothing about when. Adding
 * a timestamp is a backend change, not a presentation choice.
 */
@Injectable({ providedIn: 'root' })
export class AiKeysService {
  private readonly firestore = inject(FirestoreService);
  private readonly platformId = inject(PLATFORM_ID);

  private readonly accessModeState = signal<string | undefined>(undefined);
  private readonly vendorsState = signal<AiVendorState[]>([]);
  private readonly enginesState = signal<ScrapeProviderState[]>([]);
  private readonly storedEngineState = signal<string | null>(null);
  private readonly loadingState = signal(false);
  private readonly loadedState = signal(false);
  private readonly errorState = signal('');

  /** The plan mode the server resolved, when it has been asked. */
  readonly accessMode = this.accessModeState.asReadonly();
  /** Per-vendor state, exactly as the server reported it. */
  readonly vendors = this.vendorsState.asReadonly();
  /**
   * The scraping engines the caller's plan may select.
   *
   * Lives here rather than in a service of its own because the server composes
   * it into the SAME `getMySettings` reply as the vendors, deliberately: asking
   * twice would let one half render against a plan the other half had already
   * been refused under. One consumer, one callable.
   */
  readonly engines = this.enginesState.asReadonly();
  /**
   * The engine the server has stored, or null when the platform default governs.
   *
   * Read from the server on every load rather than remembered in the browser:
   * `scrapeMiddleware` resolves this same value for `/api/crawl`, so a locally
   * cached copy would be a claim about which backend serves the next crawl.
   */
  readonly storedEngine = this.storedEngineState.asReadonly();
  readonly isLoading = this.loadingState.asReadonly();
  readonly isLoaded = this.loadedState.asReadonly();
  readonly errorMessage = this.errorState.asReadonly();

  /**
   * The catalogue, so the panel renders every vendor including any with no
   * state yet. `vendors` is a sparse server reply; this is the complete list of
   * rows the UI must show.
   */
  readonly catalogue = AI_VENDORS;

  /** Vendors the server reports as having a stored user key. */
  readonly keyedVendors = computed(() =>
    this.vendorsState().filter(vendor => vendor.hasKey && vendor.id !== null)
  );

  /**
   * The state the server reported for one vendor, or null when it has not been
   * asked.
   * @param {AiVendorId} vendor The vendor.
   * @return {AiVendorState | null} The reported state.
   */
  stateFor(vendor: AiVendorId): AiVendorState | null {
    return this.vendorsState().find(state => state.id === vendor) ?? null;
  }

  /**
   * Where a call to `vendor` would get its key.
   *
   * The SERVER's answer wins whenever there is one, because the server is the
   * thing that will actually choose the credential and a UI that computed a
   * different answer would be lying. The ported `resolveAiKeySource` is used
   * only for the window before the first reply, or for a caller that never
   * signs in, so the badge is not blank while the request is in flight.
   * @param {AiVendorId} vendor The vendor the call targets.
   * @return {AiKeyResolution} The source, and whether the vendor is usable.
   */
  resolve(vendor: AiVendorId): AiKeyResolution {
    const reported = this.stateFor(vendor);
    if (reported) {
      return {
        vendor: aiVendorDescriptor(vendor),
        source: reported.source,
        allowed: reported.allowed,
        refusal: reported.refusal ?? undefined,
      };
    }

    const local = this.keyedVendors().some(state => state.id === vendor);
    return resolveAiKeySource(vendor, this.accessModeState(), local);
  }

  /**
   * Where a call to the vendor behind a model-dropdown code would get its key.
   * @param {string} modelCode The dropdown's `code`.
   * @return {AiKeySource} The source, or `none` when the code is unknown.
   */
  sourceForModelCode(modelCode: string): AiKeySource {
    const vendor = this.vendorForCode(modelCode);
    return vendor ? this.resolve(vendor).source : 'none';
  }

  /**
   * Whether a call to the vendor behind a model-dropdown code would be allowed.
   * @param {string} modelCode The dropdown's `code`.
   * @return {boolean} True when the server would serve the call.
   */
  allowsModelCode(modelCode: string): boolean {
    const vendor = this.vendorForCode(modelCode);
    return vendor ? this.resolve(vendor).allowed : false;
  }

  /**
   * The vendor a dropdown code maps to, through the shared table rather than a
   * local switch, so this cannot drift from `AI_MODEL_VENDOR`.
   * @param {string} modelCode The dropdown's `code`.
   * @return {AiVendorId | null} The vendor, when the code maps to one.
   */
  private vendorForCode(modelCode: string): AiVendorId | null {
    return vendorForModelCode(modelCode);
  }

  /**
   * Read the caller's settings.
   *
   * Skipped entirely outside the browser: the callable needs an authenticated
   * user, and a prerender pass has none. Skipping is the correct outcome
   * (an empty panel) rather than an error the prerender would have to absorb.
   * @return {Promise<void>} Resolves when the state has been applied.
   */
  async load(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    this.loadingState.set(true);
    this.errorState.set('');

    try {
      const settings = await this.firestore.callFunction<void, MyAiSettings>(CALLABLE.getMySettings);
      this.accessModeState.set(settings?.accessMode);
      this.vendorsState.set(Array.isArray(settings?.ai?.vendors) ? settings.ai.vendors : []);
      // Absent and empty are kept apart on purpose: `selectable: []` means the
      // plan offers no engine, while a missing `scrape` object means the reply
      // was not the shape this version expects. Both render as no rows, and
      // only the second is a drift worth noticing.
      this.enginesState.set(
        Array.isArray(settings?.scrape?.selectable) ? settings.scrape.selectable : []
      );
      this.storedEngineState.set(
        typeof settings?.scrape?.stored === 'string' ? settings.scrape.stored : null
      );
      this.loadedState.set(true);
    } catch (error) {
      this.errorState.set(this.describe(error));
    } finally {
      this.loadingState.set(false);
    }
  }

  /**
   * Store the caller's preferred scraping engine.
   *
   * The SERVER owns the allowlist. It validates the choice against the same
   * catalogue `scrapeMiddleware` resolves from, so this does not filter what it
   * sends: a client-side check that disagreed with the server would offer a
   * choice which then silently fell back, and the server's own comment on
   * `setMyScrapeProvider` calls that worse than a rejection.
   *
   * The REPLY is stored rather than the request echoed. `stored` is what a later
   * crawl will actually resolve, so recording the requested value locally would
   * let the UI claim an engine the platform had refused.
   * @param {string} provider The engine id.
   * @return {Promise<boolean>} Whether the engine is now stored.
   */
  async storeEngine(provider: string): Promise<boolean> {
    if (!isPlatformBrowser(this.platformId)) {
      return false;
    }

    this.errorState.set('');

    try {
      const request: SetMyScrapeProviderRequest = { provider };
      const reply = await this.firestore.callFunction<
        SetMyScrapeProviderRequest,
        ScrapeProviderMutationResponse
      >(CALLABLE.setMyScrapeProvider, request);

      if (typeof reply?.stored !== 'string') {
        return false;
      }

      this.storedEngineState.set(reply.stored);
      return true;
    } catch (error) {
      this.errorState.set(this.describe(error));
      return false;
    }
  }

  /**
   * Store a BYOK key for one vendor.
   *
   * The key is a parameter and nothing else: it is not assigned to a field, not
   * logged, and not echoed. See this class's NEVER RENDER KEY MATERIAL note.
   * @param {AiVendorId} vendor The vendor the key belongs to.
   * @param {string} key The key. Write-only, by construction.
   * @return {Promise<boolean>} Whether the vendor now has a key.
   */
  async storeKey(vendor: AiVendorId, key: string): Promise<boolean> {
    if (!isPlatformBrowser(this.platformId)) {
      return false;
    }

    this.errorState.set('');
    try {
      const request: SetMyAiKeyRequest = { vendor, key };
      const reply = await this.firestore.callFunction<SetMyAiKeyRequest, AiKeyMutationResponse>(
        CALLABLE.setMyAiKey,
        request
      );

      // Re-read rather than trusting the reply: a stored key changes the
      // resolved SOURCE for that vendor (user beats platform), and that
      // resolution is computed server-side. Deriving it here would be the
      // second model this file exists to avoid.
      await this.load();
      return reply?.hasKey ?? false;
    } catch (error) {
      this.errorState.set(this.describe(error));
      return false;
    }
  }

  /**
   * Remove the caller's key for one vendor, returning them to the platform key
   * or to nothing. Never refused: removing a key can only reduce what is used.
   * @param {AiVendorId} vendor The vendor whose key should go.
   * @return {Promise<boolean>} Whether the vendor still has a key.
   */
  async clearKey(vendor: AiVendorId): Promise<boolean> {
    if (!isPlatformBrowser(this.platformId)) {
      return false;
    }

    this.errorState.set('');
    try {
      const request: ClearMyAiKeyRequest = { vendor };
      const reply = await this.firestore.callFunction<ClearMyAiKeyRequest, AiKeyMutationResponse>(
        CALLABLE.clearMyAiKey,
        request
      );
      await this.load();
      return reply?.hasKey ?? false;
    } catch (error) {
      this.errorState.set(this.describe(error));
      return false;
    }
  }

  /**
   * A message a person can read for a failed call.
   *
   * Reads `error.message` only. The request body is never read and never
   * included: for `setMyAiKey` that body contains a credential.
   * @param {unknown} error The rejection.
   * @return {string} The message.
   */
  private describe(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return 'AI_KEYS.LOAD_FAILED';
  }
}
