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
import { concat, switchMap, takeWhile, timer } from 'rxjs'
import { Router, RouterModule } from '@angular/router'
import {
  SERP_DEFAULTS,
  SERP_ENGINE_OPTIONS,
  SERP_LIMITS,
  CrawlOperation,
  JobResult,
  SerpEnvelope,
  SerpErrorEnvelope,
  SerpEngine,
  SerpRequest,
  SerpResponse,
} from '../../types'
import { CrawlOperationStatus } from '../../enum'
import { AuthService, CrawlAPIService } from '../../services'
import { StinputComponent } from '../stinput/stinput.component'
import { DropdownComponent } from '../dropdown/dropdown.component'
import { RadioToggleComponent } from '../radiotoggle/radiotoggle.component'
import { SerpResultsComponent } from '../serp-results/serp-results.component'
import { ResultEnvelopeState } from '../result-envelope/result-envelope.component'

/**
 * How often a queued search is re-read.
 *
 * The same cadence the tools panel and the operation page use: this mode is a
 * VIEWER of work that runs server-side, so each read only answers "has it
 * landed?".
 */
const JOB_POLL_MS = 2000

/** The statuses after which nothing about the job can change. */
const JOB_TERMINAL: readonly CrawlOperationStatus[] = [
  CrawlOperationStatus.COMPLETED,
  CrawlOperationStatus.FAILED,
  CrawlOperationStatus.CANCELED,
]

/** The tool id `TOOL_JOB_ROUTES` knows this mode by. */
const SERP_JOB_TOOL = 'serp'

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
    RouterModule,
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

  private readonly auth = inject(AuthService)
  private readonly crawl = inject(CrawlAPIService)
  private readonly router = inject(Router)
  private readonly translate = inject(TranslateService)
  private readonly destroyRef = inject(DestroyRef)

  /**
   * The caller, for the `/operations` row this mode files.
   *
   * A signal rather than the `route.snapshot.data['user']` the page-level
   * surfaces use: this component is a playground MODE and has no route data of
   * its own, so the auth stream is the only source that is true for it.
   */
  private readonly user = toSignal(this.auth.user$)

  /**
   * The job this search was queued as, once the queue has accepted it.
   *
   * Exposed so the mode can say where the answer goes: the point of queueing is
   * that the user may leave, and a run they cannot find again is worse than one
   * that died with the tab.
   */
  readonly jobId = signal<string | null>(null)

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
   * Run the search as a QUEUED JOB.
   *
   * Touches the form rather than throwing when it is invalid, so the field
   * errors appear where the shared input controls already render them instead
   * of a separate banner.
   *
   * Why queued and not called directly: this mode called `POST /api/serp`,
   * which lived exactly as long as this tab. Switching playground mode
   * destroyed the component and aborted the request, so the answer was gone and
   * nothing recorded that the search had been made -- which is also why Search
   * was the only mode with nothing in `/operations`. One unit of work on the
   * queue fixes both: the run outlives the tab, and the row is readable from the
   * list and from its own page.
   *
   * The request body is still `SerpRequest`; the queue's own mapper
   * (`serpArguments`, via `TOOL_JOB_ROUTES.serp`) is the same one the direct
   * route uses, so a queued search and a direct one cannot take different
   * arguments.
   */
  submit(): void {
    if (this.queryControl.invalid || this.limitControl.invalid) {
      this.queryControl.markAsTouched()
      this.limitControl.markAsTouched()
      return
    }

    this.searchState.set('loading')
    this.errorMessage.set('')
    this.jobId.set(null)

    this.crawl
      .enqueueTool(
        SERP_JOB_TOOL,
        { ...this.buildRequest() },
        this.operationRow(),
      )
      .pipe(
        switchMap(task => {
          this.jobId.set(task.id)
          // Read once IMMEDIATELY, then poll. A search can finish before the
          // first timer tick, and an immediate read is also what makes a fast
          // engine feel like a request rather than a wait.
          return concat(
            this.crawl.getJobResult(task.id),
            timer(JOB_POLL_MS, JOB_POLL_MS).pipe(
              switchMap(() => this.crawl.getJobResult(task.id)),
            ),
          ).pipe(
            takeWhile(result => !JOB_TERMINAL.includes(result.status), true),
          )
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: result => this.applyJobResult(result),
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
   * The `/operations` row this search should leave behind.
   *
   * The server owns everything it can know better -- `id`, `task_id`,
   * `created_At`, `status`, and `author.uid` from the credential -- and merges
   * this row underneath them. So only what it cannot know is sent: that this
   * was a serp call. `urls` is left empty on purpose; the server fills it with
   * the call's own label (`serp · <query>`), which is what the list renders.
   *
   * `urlPath` is this component's own url, so the row can say where it was
   * started from.
   * @return {CrawlOperation} The row to send.
   */
  private operationRow(): CrawlOperation {
    const user = this.user()

    return {
      type: 'playground',
      author: {
        uid: user?.uid ?? '',
        displayName: user?.currProviderData?.displayName || 'anonymous',
      },
      name: SERP_JOB_TOOL,
      created_At: Date.now(),
      scheduled_At: Date.now(),
      urls: [],
      status: CrawlOperationStatus.READY,
      urlPath: this.router.url,
    }
  }

  /**
   * Fold one job snapshot into the view.
   *
   * A snapshot with no rows yet is a call the queue has accepted but not run,
   * so nothing is set and the mode keeps its loading state rather than painting
   * an empty answer. The LAST row wins: the stored array is append-only and a
   * redelivered target leaves two.
   *
   * The job's row carries the worker's raw `webrain_serp` payload in `data`,
   * which is the same `SerpResponse` the direct route returned, so the results
   * view is unchanged by the move to the queue.
   * @param {JobResult} result One read of the job.
   * @return {void}
   */
  private applyJobResult(result: JobResult): void {
    const item = result.items[result.items.length - 1]

    if (!item) {
      return
    }

    const query = this.queryControl.value.trim()

    if (item.status === 'ok') {
      this.applyEnvelope({
        provider: 'webrain',
        status: 'ok',
        query,
        data: item.data as SerpResponse,
        tokens: item.tokens?.est_tokens,
        ms: item.ms,
      })
      return
    }

    this.applyEnvelope({
      provider: 'webrain',
      status: 'error',
      query,
      error: item.message || (this.translate.instant('SEARCH.FAILED') as string),
    })
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
