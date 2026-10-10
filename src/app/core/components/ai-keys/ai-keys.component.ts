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
import { AiKeysService } from '../../services';
import { AiKeyRefusal, AiVendorDescriptor, AiVendorId, isPlausibleApiKey } from '../../types';
import { StinputComponent } from '../stinput/stinput.component';

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
   */
  private readonly keyControls: Record<AiVendorId, FormControl<string>> = {
    anthropic: this.newKeyControl(),
    openai: this.newKeyControl(),
    groq: this.newKeyControl(),
    jina: this.newKeyControl(),
  };

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
    return !isPlausibleApiKey(this.keyControls[vendor].value);
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

    if (!isPlausibleApiKey(candidate)) {
      return;
    }

    this.busyVendor.set(vendor);
    try {
      await this.aiKeys.storeKey(vendor, candidate);
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

  private newKeyControl(): FormControl<string> {
    return new FormControl('', {
      nonNullable: true,
      validators: [Validators.minLength(16), Validators.maxLength(512)],
    });
  }
}
