import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostBinding,
  inject,
  signal,
} from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIcon } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { AiKeysService, AiModelsService } from '../../services';
import { AiKeyRefusal, AiVendorDescriptor, AiVendorId, ScrapeProviderId, isPlausibleApiKey } from '../../types';
import { StinputComponent } from '../stinput/stinput.component';

/** The one vendor whose endpoint the caller supplies. */
const CUSTOM_VENDOR: AiVendorId = 'custom';

/**
 * Whether the endpoint field looks like an https URL.
 *
 * A shape check only, and DELIBERATELY not a copy of the server's `aiEndpointFrom`: the
 * browser cannot be the authority on what the server will dial, and re-deriving the
 * private-address rules here would be a second copy of a security guard -- and the copy
 * that drifts is the one nobody reads. The server validates and its answer wins; this
 * exists so the save button is not offered for a value that cannot work.
 * @param {string} value The candidate.
 * @return {boolean} True when it is shaped like an https URL.
 */
const looksLikeHttps = (value: string): boolean =>
  /^https:\/\/[^\s]+$/i.test(value.trim());

/**
 * The BYOK surface: which vendors have a user key, and the two writes that
 * change that.
 *
 * Why it says which key pays, not just whether a key exists
 * -------------------------------------------------------
 * `ai_handler.ts` notes that BYOK today means "your own quota on a paid plan":
 * the platform-key routes are paid-gated and that check runs before the key is
 * chosen. So a user who has pasted a key can still be served by the platform's
 * key on a free plan (by being refused outright), and a paid user with a key is
 * always served by their own. Neither is guessable from "a key is saved", which
 * is why each row states the resolved SOURCE from the server rather than the
 * presence of a key alone.
 *
 * The key is write-only, and the shape of this component enforces it
 * -----------------------------------------------------------------
 *  - The input is a `FormControl<string>` whose value is never bound into text,
 *    never logged, and never held after submit: `save()` resets it in its
 *    `finally`. The control is the only place the value exists, for as long as
 *    the user is typing.
 *  - Nothing in the template renders a stored key. There is no member of
 *    `AiVendorState` or `AiKeyMutationResponse` that could carry one.
 *  - The service, not this component, owns the call. See its NEVER RENDER KEY
 *    MATERIAL note.
 */
@Component({
  selector: 'app-ai-keys',
  imports: [ReactiveFormsModule, MatIcon, TranslateModule, StinputComponent],
  templateUrl: './ai-keys.component.html',
  styleUrl: './ai-keys.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AiKeysComponent {
  @HostBinding('class') classes = 'flex w-full flex-col';

  private readonly aiKeys = inject(AiKeysService);
  private readonly aiModels = inject(AiModelsService);
  private readonly destroyRef = inject(DestroyRef);

  /** The rows to render, so the UI shows every vendor the platform integrates. */
  readonly catalogue: readonly AiVendorDescriptor[] = this.aiKeys.catalogue;

  readonly isLoading = this.aiKeys.isLoading;
  readonly isLoaded = this.aiKeys.isLoaded;
  readonly errorMessage = this.aiKeys.errorMessage;

  /** The vendor currently being written to, so only its own button spins. */
  readonly busyVendor = signal<AiVendorId | null>(null);

  /**
   * A bump counter that makes the disabled bindings recompute as a control
   * changes status. Its VALUE is never read for anything else.
   *
   * It exists because this component is OnPush and the form controls are not
   * signals: a validity transition is the one event that changes whether a save
   * is available, so watching `statusChanges` and nudging a signal is what
   * keeps the button in step without a subscription per keystroke.
   */
  readonly startedTyping = signal(0);

  /**
   * One control per vendor, so a key typed for Anthropic cannot be submitted
   * against Groq by a re-render that collapsed two rows into one control.
   *
   * Typed as a `Record` over the vendor union on purpose: adding a vendor to the catalogue
   * without adding its control here is a compile error, rather than a row that renders with
   * no input at runtime. The template already iterates the catalogue, so those two cannot
   * disagree about WHICH vendors exist -- only about whether each has a control.
   */
  private readonly keyControls: Record<AiVendorId, FormControl<string>> = {
    anthropic: this.newKeyControl(),
    openai: this.newKeyControl(),
    groq: this.newKeyControl(),
    deepseek: this.newKeyControl(),
    fireworks: this.newKeyControl(),
    qwen: this.newKeyControl(),
    kimi: this.newKeyControl(),
    openrouter: this.newKeyControl(),
    gemini: this.newKeyControl(),
    custom: this.newKeyControl(),
  };

  /**
   * The `custom` vendor's own address.
   *
   * Not a secret and not treated like one: it is displayed, editable, and echoed back by
   * the server. It gets a control of its own rather than living in the key control because
   * the two are validated differently and one of them must never be rendered.
   */
  readonly endpointControl = new FormControl('', {
    nonNullable: true,
    validators: [Validators.maxLength(512)],
  });

  /**
   * One control per reader, keyed by provider id and created on first ask.
   *
   * Not a `Record` over the id union like the vendor map above: readers are a strict subset of
   * providers, and WHICH ones exist is the server's answer, so a fully-populated record would
   * carry controls for providers that have no input.
   */
  private readonly readerControls = new Map<ScrapeProviderId, FormControl<string>>();

  constructor() {
    void this.aiKeys.load();

    // Every vendor's control is watched, because `isSaveDisabled` has to
    // re-evaluate as the user types. The value itself is read only for its
    // length (through the validator's verdict), never stored and never
    // rendered.
    for (const vendor of this.catalogue) {
      this.keyControls[vendor.id].statusChanges
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => this.startedTyping.update(count => count + 1));
    }

    // The endpoint feeds the SAME save button as a custom vendor's key, so it needs the
    // same nudge: without it the button would stay disabled after the field was filled,
    // because this component is OnPush and a plain control's value is not a signal.
    this.endpointControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.startedTyping.update(count => count + 1));
  }

  /**
   * The control for one vendor, for the template to bind.
   * @param {AiVendorId} vendor The vendor.
   * @return {FormControl<string>} The (empty, or being typed into) key control.
   */
  controlFor(vendor: AiVendorId): FormControl<string> {
    return this.keyControls[vendor];
  }

  /**
   * The i18n key for one vendor's resolved source, so a row says whose key
   * would serve it rather than only whether one is stored.
   * @param {AiVendorId} vendor The vendor.
   * @return {string} The translation key.
   */
  sourceLabelKey(vendor: AiVendorId): string {
    switch (this.aiKeys.resolve(vendor).source) {
      case 'user':
        return 'AI_VENDOR.SOURCE_USER';
      case 'platform':
        return 'AI_VENDOR.SOURCE_PLATFORM';
      default:
        return 'AI_KEYS.SOURCE_NONE';
    }
  }

  /**
   * The i18n key for why a vendor is unavailable, or null when it is available.
   * @param {AiVendorId} vendor The vendor.
   * @return {string | null} The translation key, when there is a refusal.
   */
  refusalLabelKey(vendor: AiVendorId): string | null {
    const refusal: AiKeyRefusal | undefined = this.aiKeys.resolve(vendor).refusal;
    switch (refusal) {
      case 'plan-required':
        return 'AI_VENDOR.REFUSAL_PLAN';
      case 'byok-required':
        return 'AI_VENDOR.REFUSAL_BYOK';
      case 'unsupported':
      case 'unknown-vendor':
        return 'AI_KEYS.REFUSAL_UNSUPPORTED';
      default:
        return null;
    }
  }

  /**
   * Whether the vendor accepts a user key at all. A vendor with `byok: false`
   * must not be offered an input that the server would refuse.
   * @param {AiVendorId} vendor The vendor.
   * @return {boolean} True when a key can be stored.
   */
  acceptsKey(vendor: AiVendorId): boolean {
    return this.catalogue.find(entry => entry.id === vendor)?.byok === true;
  }

  /**
   * Whether the save button for one vendor is disabled.
   *
   * Disabled while that vendor has a request in flight, and until the control's
   * value clears the same length floor the server enforces. The server still
   * validates: this only avoids offering a button that is certain to be
   * rejected.
   * @param {AiVendorId} vendor The vendor.
   * @return {boolean} True when saving is not available.
   */
  isSaveDisabled(vendor: AiVendorId): boolean {
    if (!this.acceptsKey(vendor) || this.busyVendor() !== null) {
      return true;
    }
    if (!isPlausibleApiKey(this.keyControls[vendor].value)) {
      return true;
    }
    // A custom vendor is unusable without an address, and the server refuses the write, so
    // the button is not offered for a value that is certain to fail.
    return vendor === CUSTOM_VENDOR && !looksLikeHttps(this.endpointControl.value);
  }

  /**
   * The address the server reports for a vendor, or empty.
   *
   * Read from the server's reply rather than remembered from the last save, so a reload
   * still shows what is actually configured.
   * @param {AiVendorId} vendor The vendor.
   * @return {string} The stored endpoint, or '' when the vendor has none.
   */
  storedEndpoint(vendor: AiVendorId): string {
    return this.aiKeys.stateFor(vendor)?.endpoint ?? '';
  }

  /**
   * Whether removing is available for one vendor.
   * @param {AiVendorId} vendor The vendor.
   * @return {boolean} True when a removal could be sent.
   */
  isRemoveDisabled(vendor: AiVendorId): boolean {
    return this.busyVendor() !== null || !this.hasKey(vendor);
  }

  /**
   * Whether the server reports a stored key for this vendor.
   * @param {AiVendorId} vendor The vendor.
   * @return {boolean} True when a key is stored.
   */
  hasKey(vendor: AiVendorId): boolean {
    return this.aiKeys.stateFor(vendor)?.hasKey === true;
  }

  /**
   * Store the typed key for one vendor.
   *
   * The control is reset in `finally`, so the value lives only as long as the
   * request that carries it. A failure leaves the field empty as well: keeping
   * it would be holding a credential in a component that has no reason to.
   * @param {AiVendorId} vendor The vendor.
   * @return {Promise<void>} Resolves once the write has been attempted.
   */
  async save(vendor: AiVendorId): Promise<void> {
    const control = this.keyControls[vendor];
    const candidate = control.value;

    if (!isPlausibleApiKey(candidate) || this.isSaveDisabled(vendor)) {
      return;
    }

    // The address rides along only for the vendor that owns one, and the server refuses it
    // on any other -- so this is not an optional extra, it is the other half of the write.
    const endpoint = vendor === CUSTOM_VENDOR
      ? this.endpointControl.value.trim()
      : undefined;

    this.busyVendor.set(vendor);
    try {
      await this.aiKeys.storeKey(vendor, candidate, endpoint);
      // A new key changes which models that vendor serves, and the catalogue is
      // built once per page life -- so without this the picker kept its old list.
      this.aiModels.refresh();
    } finally {
      control.reset('');
      this.busyVendor.set(null);
    }
  }

  /**
   * Remove the stored key for one vendor.
   * @param {AiVendorId} vendor The vendor.
   * @return {Promise<void>} Resolves once the write has been attempted.
   */
  async remove(vendor: AiVendorId): Promise<void> {
    this.busyVendor.set(vendor);
    try {
      await this.aiKeys.clearKey(vendor);
    } finally {
      this.busyVendor.set(null);
    }
  }

  // --- Scraping engine -----------------------------------------------------

  /**
   * The engines the caller's plan may select.
   *
   * Rendered above the vendor rows because this is the choice that changes where
   * a crawl actually GOES: `scrapeMiddleware` resolves the same stored value for
   * `/api/crawl`, whereas a vendor key only changes who pays for an AI call.
   */
  readonly engines = this.aiKeys.engines;

  /** The engine the server has stored, or null when the platform default governs. */
  readonly storedEngine = this.aiKeys.storedEngine;

  /** The engine currently being written, so only its own row is disabled. */
  readonly busyEngine = signal<string | null>(null);

  /**
   * Whether an engine is the stored one.
   * @param {string} engine The engine id.
   * @return {boolean} True when it is stored.
   */
  isEngineSelected(engine: string): boolean {
    return this.storedEngine() === engine;
  }

  /**
   * Store the chosen scraping engine.
   *
   * A press on the engine already stored is a no-op rather than a write: the
   * value would not change, and the round trip would only buy a spinner.
   * @param {string} engine The engine id.
   * @return {Promise<void>} Resolves once the write has been attempted.
   */
  async chooseEngine(engine: string): Promise<void> {
    if (this.busyEngine() !== null || this.isEngineSelected(engine)) {
      return;
    }

    this.busyEngine.set(engine);
    try {
      await this.aiKeys.storeEngine(engine);
    } finally {
      this.busyEngine.set(null);
    }
  }

  // --- Reader keys ---------------------------------------------------------

  /**
   * The readers a caller may bring a key for, as the server reports them.
   *
   * Rendered beside the engines rather than with the vendors because a reader IS a scrape
   * provider: `jina` reads a URL, it does not complete a chat. Listing it with the chat vendors
   * is the confusion this surface exists to undo.
   */
  readonly readerKeys = this.aiKeys.readerKeys;

  /** The reader currently being written, so only its own button spins. */
  readonly busyReader = signal<ScrapeProviderId | null>(null);

  /**
   * The key control for a reader, created on first ask.
   *
   * Idempotent on purpose, because the template asks for it in a binding: a control created
   * twice would be two controls for one input, which is the bug the vendor map's comment warns
   * about. The subscription is attached where the control is made, for the same OnPush reason
   * the vendor controls subscribe.
   * @param {ScrapeProviderId} id The reader's provider id.
   * @return {FormControl<string>} The control for that reader.
   */
  readerControlFor(id: ScrapeProviderId): FormControl<string> {
    const existing = this.readerControls.get(id);
    if (existing) {
      return existing;
    }

    const control = this.newKeyControl();
    control.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.startedTyping.update(count => count + 1));
    this.readerControls.set(id, control);
    return control;
  }

  /**
   * Whether the server reports a stored key for a reader.
   * @param {ScrapeProviderId} id The reader's provider id.
   * @return {boolean} True when a key is stored.
   */
  readerHasKey(id: ScrapeProviderId): boolean {
    return this.readerKeys().find(reader => reader.id === id)?.hasKey === true;
  }

  /**
   * Whether a reader's save button is disabled.
   * @param {ScrapeProviderId} id The reader's provider id.
   * @return {boolean} True when saving is not available.
   */
  isReaderSaveDisabled(id: ScrapeProviderId): boolean {
    return this.busyReader() !== null ||
      !isPlausibleApiKey(this.readerControlFor(id).value);
  }

  /**
   * Store a key for a reader.
   *
   * The same write as a vendor's, against the same store: the store is keyed by PROVIDER id,
   * which is what lets a reader keep its own key without being described as a chat vendor.
   * @param {ScrapeProviderId} id The reader's provider id.
   * @return {Promise<void>} Resolves once the write has been attempted.
   */
  async saveReader(id: ScrapeProviderId): Promise<void> {
    const control = this.readerControlFor(id);
    const candidate = control.value;

    if (!isPlausibleApiKey(candidate) || this.isReaderSaveDisabled(id)) {
      return;
    }

    this.busyReader.set(id);
    try {
      await this.aiKeys.storeKey(id, candidate);
      // Same reason as the vendor path: the catalogue is built once per page life.
      this.aiModels.refresh();
    } finally {
      control.reset('');
      this.busyReader.set(null);
    }
  }

  /**
   * Remove a reader's key.
   * @param {ScrapeProviderId} id The reader's provider id.
   * @return {Promise<void>} Resolves once the write has been attempted.
   */
  async removeReader(id: ScrapeProviderId): Promise<void> {
    this.busyReader.set(id);
    try {
      await this.aiKeys.clearKey(id);
    } finally {
      this.busyReader.set(null);
    }
  }

  private newKeyControl(): FormControl<string> {
    return new FormControl('', {
      nonNullable: true,
      validators: [Validators.minLength(16), Validators.maxLength(512)],
    });
  }
}
