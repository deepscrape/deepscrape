import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostBinding,
  inject,
  signal,
} from '@angular/core'
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms'
import { HttpErrorResponse } from '@angular/common/http'
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop'
import { MatIcon } from '@angular/material/icon'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import {
  SERP_DEFAULTS,
  SERP_ENGINE_OPTIONS,
  SERP_LIMITS,
  SerpEnvelope,
  SerpErrorEnvelope,
  SerpEngine,
  SerpRequest,
  SerpResponse,
} from '../../types'
import { SearchService } from '../../services'
import { StinputComponent } from '../stinput/stinput.component'
import { DropdownComponent } from '../dropdown/dropdown.component'
import { RadioToggleComponent } from '../radiotoggle/radiotoggle.component'
import { SerpResultsComponent } from '../serp-results/serp-results.component'
import { ResultEnvelopeState } from '../result-envelope/result-envelope.component'

/**
 * The structured-search playground mode.
 *
 * Inputs are the repository's shared controls rather than bespoke markup:
 * `app-stinput` for the text and number fields, `app-dropdown` for the engine,
 * `app-radiotoggle` for the boolean. That is what makes this mode's labels,
 * error text and disabled states match the crawl-pack and admin surfaces
 * without restating any of it here.
 *
 * Number fields are `FormControl<string>` because `StinputComponent` is, and
 * the values are parsed once at submit. That is the same convention
 * `admin-analytics` documents for its numeric inputs, and it means the limit is
 * validated by the parser and clamped against `SERP_LIMITS` rather than trusted
 * from a text box.
 *
 * The reply is narrowed before it reaches the view: the route's union is
 * resolved here into one `SerpResponse | null` plus one error string, so the
 * template never reads `data` off an error payload.
 */
@Component({
  selector: 'app-search',
  imports: [
    ReactiveFormsModule,
    MatIcon,
    TranslateModule,
    StinputComponent,
    DropdownComponent,
    RadioToggleComponent,
    SerpResultsComponent,
  ],
  templateUrl: './app-search.component.html',
  styleUrl: './app-search.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppSearchComponent {
  @HostBinding('class') classes = 'flex items-center flex-col relative w-full'

  private readonly searchService = inject(SearchService)
  private readonly translate = inject(TranslateService)
  private readonly destroyRef = inject(DestroyRef)

  /** Exposed for the template so the fields advertise the engine's own bounds. */
  readonly limits = SERP_LIMITS

  /** The engine picker's options, built from the engine union so it cannot drift. */
  readonly engineOptions: { name: string; code: SerpEngine }[] = SERP_ENGINE_OPTIONS.map(option => ({ ...option }))

  /**
   * String control for the query because `StinputComponent` is `FormControl<string>`.
   *
   * `minLength(2)` rather than `required` alone: a single character is a request
   * the engines will answer with noise, and rejecting it here is clearer than
   * showing the noise.
   */
  readonly queryControl = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.minLength(2)],
  })

  /** A string, like every other numeric `StinputComponent` in the repository. */
  readonly limitControl = new FormControl(String(SERP_DEFAULTS.limit), {
    nonNullable: true,
    validators: [Validators.required, Validators.min(SERP_LIMITS.minLimit), Validators.max(SERP_LIMITS.maxLimit)],
  })

  readonly regionControl = new FormControl('', { nonNullable: true })

  readonly safeControl = new FormControl(SERP_DEFAULTS.safe, { nonNullable: true })

  /**
   * Whether the worker may drive a browser for this search.
   *
   * Defaults to `false` — the browserless path — because that is the worker's
   * own default and the cheap one. Only `bing` acts on it, which is why the
   * template renders this control for that engine alone.
   */
  readonly browserControl = new FormControl(false, { nonNullable: true })

  readonly engineControl = new FormControl<{ name: string; code: SerpEngine }>(
    { name: 'SEARCH.ENGINE_AUTO', code: SERP_DEFAULTS.engine },
    { nonNullable: true },
  )

  /**
   * The engine as a signal, so the template can react to a change.
   *
   * A getter reading `engineControl.value` would not be tracked under zoneless
   * change detection, so the `browser` control would keep showing after the
   * engine moved off `bing` — and then a search would drive a browser the user
   * never asked for.
   */
  readonly engine = toSignal(this.engineControl.valueChanges, {
    initialValue: this.engineControl.value,
  })

  /** Which envelope state the output is in. */
  readonly searchState = signal<ResultEnvelopeState>('idle')

  /** The last successful reply, kept so a failed retry does not blank the page. */
  readonly response = signal<SerpResponse | null>(null)

  readonly errorMessage = signal('')

  /** Only offer retry once there is a query worth repeating. */
  get showRetry(): boolean {
    return this.searchState() === 'error' && this.queryControl.valid
  }

  /** Whether the form may be submitted at all. */
  get submitDisabled(): boolean {
    return this.queryControl.invalid || this.limitControl.invalid || this.searchState() === 'loading'
  }

  /** Whether the clear button does anything. */
  get clearDisabled(): boolean {
    return this.searchState() === 'loading'
  }

  /**
   * Run the search.
   *
   * Touches the form rather than throwing when it is invalid, so the field
   * errors appear where the shared input controls already render them instead
   * of a separate banner.
   */
  submit(): void {
    if (this.queryControl.invalid || this.limitControl.invalid) {
      this.queryControl.markAsTouched()
      this.limitControl.markAsTouched()
      return
    }

    this.searchState.set('loading')
    this.errorMessage.set('')

    this.searchService
      .search(this.buildRequest())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: envelope => this.applyEnvelope(envelope),
        error: error => this.applyFailure(error),
      })
  }

  /** Re-run the last query without making the user retype it. */
  retry(): void {
    this.submit()
  }

  /** Put the mode back to its opening state, without touching the engine choice. */
  clear(): void {
    this.queryControl.reset('')
    this.regionControl.reset('')
    this.limitControl.reset(String(SERP_DEFAULTS.limit))
    this.safeControl.reset(SERP_DEFAULTS.safe)
    this.browserControl.reset(false)
    this.response.set(null)
    this.errorMessage.set('')
    this.searchState.set('idle')
  }

  /**
   * The request for the current form state.
   *
   * The limit is clamped here as well as by its validators, because a control
   * can be valid and still hold `"7.5"`, which the route's integer check would
   * silently drop to the engine's default.
   */
  private buildRequest(): SerpRequest {
    const parsed = Math.trunc(Number(this.limitControl.value))
    const limit = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, SERP_LIMITS.minLimit), SERP_LIMITS.maxLimit)
      : SERP_DEFAULTS.limit

    const request: SerpRequest = {
      query: this.queryControl.value.trim(),
      engine: this.engineControl.value.code,
      limit,
      page: SERP_DEFAULTS.page,
      safe: this.safeControl.value,
    }

    const region = this.regionControl.value.trim()
    if (region) {
      request.region = region
    }

    // Sent only when it was turned on. `false` and "absent" both mean the
    // browserless path, so sending `false` would pin a default the worker owns
    // and turn a future change to that default into a silent no-op.
    if (this.browserControl.value) {
      request.browser = true
    }

    return request
  }

  /**
   * Fold a reply into view state.
   *
   * A `status: "error"` body inside a 200 is treated as a failure, not as an
   * empty reply: the route maps a provider-side error to a 502, but a proxy is
   * free to rewrite the status, and "the search failed" must not be shown as
   * "no results".
   * @param {SerpEnvelope} envelope The route reply.
   */
  private applyEnvelope(envelope: SerpEnvelope): void {
    if (envelope.status === 'error') {
      this.errorMessage.set(envelope.error)
      this.searchState.set('error')
      return
    }

    this.response.set(envelope.data)
    this.searchState.set('ready')
  }

  /** Turn anything the transport threw into one readable line. */
  private applyFailure(error: unknown): void {
    this.errorMessage.set(this.describeFailure(error))
    this.searchState.set('error')
  }

  /**
   * A refusal is a plan answer and an outage is a retry, so the route's message
   * is preferred over a generic one whenever the body actually carries it.
   */
  private describeFailure(error: unknown): string {
    const fallback = this.translate.instant('SEARCH.FAILED') as string

    if (!(error instanceof HttpErrorResponse)) {
      return fallback
    }

    const body = error.error
    if (body && typeof body === 'object') {
      const message = (body as SerpErrorEnvelope).error
      if (typeof message === 'string' && message.trim()) {
        return message
      }
    }

    if (typeof body === 'string' && body.trim()) {
      return body
    }

    return fallback
  }
}
