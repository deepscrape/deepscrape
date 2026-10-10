import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostBinding,
  OnInit,
  PLATFORM_ID,
  inject,
  signal,
} from '@angular/core'
import { DatePipe, NgClass, isPlatformBrowser } from '@angular/common'
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms'
import { HttpErrorResponse } from '@angular/common/http'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { MatIcon } from '@angular/material/icon'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import {
  Check,
  MONITOR_INTERVAL_PRESETS,
  MONITOR_LIMITS,
  Monitor,
  MonitorCheckStatus,
  MonitorCreateRequest,
  MonitorExtractMode,
  MonitorLastStatus,
} from '../../types'
import { MonitorService } from '../../services'
import { StinputComponent } from '../stinput/stinput.component'
import { ResultEnvelopeComponent, ResultEnvelopeMeta, ResultEnvelopeState } from '../result-envelope/result-envelope.component'

/**
 * The monitor playground mode.
 *
 * One form creates a monitor, one list owns the existing ones, and each row can
 * open its own change history. The routes it speaks to are the `/api/monitor/*`
 * contract described in `core/types/monitor.interface.ts`, and
 * `MonitorService` is the only writer of them.
 *
 * State is signalled rather than assigned, because the app is zoneless: an
 * HTTP reply that only wrote a field would never reach the view. The three
 * asynchronous surfaces (the list, the create request, one row's history) each
 * carry their own `ResultEnvelopeState`, so a failure loading history does not
 * blank the list it was opened from.
 *
 * Destructive actions are two-step rather than `window.confirm`, which is a
 * browser API that does not exist during prerender and would have to be guarded
 * to be safe. A pending delete is cleared by any other interaction.
 */
@Component({
  selector: 'app-monitor',
  imports: [DatePipe, NgClass, ReactiveFormsModule, MatIcon, TranslateModule, StinputComponent, ResultEnvelopeComponent],
  templateUrl: './app-monitor.component.html',
  styleUrl: './app-monitor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppMonitorComponent implements OnInit {
  @HostBinding('class') classes = 'flex items-center flex-col relative w-full'

  private readonly monitorService = inject(MonitorService)
  private readonly translate = inject(TranslateService)
  private readonly destroyRef = inject(DestroyRef)
  private readonly platformId = inject(PLATFORM_ID)

  /** Exposed for the template so the form advertises the route's own bounds. */
  readonly limits = MONITOR_LIMITS

  /** One-tap intervals, in minutes. The number field remains the fallback. */
  readonly intervalPresets = MONITOR_INTERVAL_PRESETS

  /** What the monitor compares between runs. */
  readonly extractModes: { name: string; code: MonitorExtractMode }[] = [
    { name: 'MONITOR.EXTRACT_MARKDOWN', code: 'markdown' },
    { name: 'MONITOR.EXTRACT_TEXT', code: 'text' },
    { name: 'MONITOR.EXTRACT_HTML', code: 'html' },
  ]

  // ── the create form ────────────────────────────────────────────────────────

  readonly nameControl = new FormControl('', { nonNullable: true, validators: [Validators.required] })

  /**
   * The URL pattern is checked in the browser so a typo is answered before a
   * request. The BFF re-validates; this is a courtesy, not the boundary.
   */
  readonly urlControl = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.pattern(/^https?:\/\/[^\s]+$/i)],
  })

  /** A string control because `StinputComponent` is `FormControl<string>`. */
  readonly intervalControl = new FormControl(String(MONITOR_LIMITS.defaultIntervalMinutes), {
    nonNullable: true,
    validators: [
      Validators.required,
      Validators.min(MONITOR_LIMITS.minIntervalMinutes),
      Validators.max(MONITOR_LIMITS.maxIntervalMinutes),
    ],
  })

  readonly selectorControl = new FormControl('', { nonNullable: true })

  readonly extractModeControl = new FormControl<MonitorExtractMode>('markdown', { nonNullable: true })

  // ── the list ───────────────────────────────────────────────────────────────

  readonly monitors = signal<Monitor[]>([])
  readonly listState = signal<ResultEnvelopeState>('loading')
  readonly listError = signal('')

  // ── the create request ─────────────────────────────────────────────────────

  readonly creating = signal(false)
  readonly createError = signal('')

  // ── per-row and per-history state ──────────────────────────────────────────

  /** Ids with a request in flight, so a row's buttons can disable themselves. */
  readonly busyIds = signal<string[]>([])

  /** The row whose history is open, or null. Only one is open at a time. */
  readonly historyOpenFor = signal<string | null>(null)
  readonly historyState = signal<ResultEnvelopeState>('idle')
  readonly historyError = signal('')
  readonly history = signal<Check[]>([])

  /** The row awaiting a confirming second click, or null. */
  readonly pendingDelete = signal<string | null>(null)

  ngOnInit(): void {
    // Browser only. `/user/playground` is `RenderMode.Server`, so a direct
    // request with `?mode=monitor` renders this on the server, where there is no
    // caller session to authorise with and the relative `/api` base has no
    // origin to resolve against. Fetching there would fail and hydrate an error
    // state over a page that was one tick away from working, so the server
    // renders the loading state and the browser does the fetch.
    if (isPlatformBrowser(this.platformId)) {
      this.loadMonitors()
    }
  }

  /** Whether the create form may be submitted. */
  get createDisabled(): boolean {
    return this.nameControl.invalid || this.urlControl.invalid || this.intervalControl.invalid || this.creating()
  }

  /**
   * Header chips for the list.
   *
   * The paused count is only present when it is non-zero, because "0 paused" is
   * a chip that says nothing; the total is always shown.
   */
  get listMeta(): ResultEnvelopeMeta[] {
    const rows = this.monitors()
    const paused = rows.filter(row => !row.enabled).length
    const chips: ResultEnvelopeMeta[] = [{ label: 'MONITOR.META_TOTAL', value: String(rows.length) }]

    if (paused > 0) {
      chips.push({ label: 'MONITOR.META_PAUSED', value: String(paused), tone: 'secondary' })
    }

    return chips
  }

  // ── list ───────────────────────────────────────────────────────────────────

  /** Load every monitor. Also the retry path for a failed list request. */
  loadMonitors(): void {
    this.listState.set('loading')
    this.listError.set('')

    this.monitorService
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: reply => {
          this.monitors.set(reply.monitors ?? [])
          this.listState.set(this.monitors().length ? 'ready' : 'empty')
        },
        error: error => {
          this.listError.set(this.describeFailure(error, 'MONITOR.LOAD_ERROR'))
          this.listState.set('error')
        },
      })
  }

  // ── create ─────────────────────────────────────────────────────────────────

  /**
   * Create a monitor from the form.
   *
   * The optional fields are omitted rather than sent empty: a blank selector or
   * an empty region would be a value the BFF has to decide the meaning of, and
   * "not sent" has one meaning.
   */
  create(): void {
    if (this.createDisabled) {
      this.nameControl.markAsTouched()
      this.urlControl.markAsTouched()
      this.intervalControl.markAsTouched()
      return
    }

    const request: MonitorCreateRequest = {
      name: this.nameControl.value.trim(),
      url: this.urlControl.value.trim(),
      intervalMinutes: this.boundedInterval(),
      extractMode: this.extractModeControl.value,
    }

    const selector = this.selectorControl.value.trim()
    if (selector) {
      request.selector = selector
    }

    this.creating.set(true)
    this.createError.set('')

    this.monitorService
      .create(request)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.creating.set(false)
          this.resetForm()
          this.loadMonitors()
        },
        error: error => {
          this.creating.set(false)
          this.createError.set(this.describeFailure(error, 'MONITOR.CREATE_ERROR'))
        },
      })
  }

  /** Tap one of the interval presets. */
  applyInterval(minutes: number): void {
    this.intervalControl.setValue(String(minutes))
    this.intervalControl.markAsDirty()
  }

  /** Whether an interval preset is the current value. */
  isActiveInterval(minutes: number): boolean {
    return Number(this.intervalControl.value) === minutes
  }

  // ── row actions ────────────────────────────────────────────────────────────

  /** Pause or resume one monitor. */
  toggleEnabled(monitor: Monitor): void {
    this.pendingDelete.set(null)
    this.markBusy(monitor.id)

    this.monitorService
      .update({ id: monitor.id, enabled: !monitor.enabled })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.clearBusy(monitor.id)
          this.loadMonitors()
        },
        error: error => {
          this.clearBusy(monitor.id)
          this.listError.set(this.describeFailure(error, 'MONITOR.UPDATE_ERROR'))
          this.listState.set('error')
        },
      })
  }

  /**
   * Delete one monitor, on the second click.
   *
   * The first click arms the row; a second click on the same row commits. Any
   * other row interaction disarms it, so a mis-click cannot be completed much
   * later by a second mis-click.
   */
  requestDelete(id: string): void {
    if (this.pendingDelete() !== id) {
      this.pendingDelete.set(id)
      return
    }

    this.pendingDelete.set(null)
    this.markBusy(id)

    this.monitorService
      .remove(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.clearBusy(id)
          if (this.historyOpenFor() === id) {
            this.closeHistory()
          }
          this.loadMonitors()
        },
        error: error => {
          this.clearBusy(id)
          this.listError.set(this.describeFailure(error, 'MONITOR.DELETE_ERROR'))
          this.listState.set('error')
        },
      })
  }

  // ── history ────────────────────────────────────────────────────────────────

  /** Open a row's history, or close it when it is already open. */
  toggleHistory(id: string): void {
    this.pendingDelete.set(null)

    if (this.historyOpenFor() === id) {
      this.closeHistory()
      return
    }

    this.historyOpenFor.set(id)
    this.loadHistory(id)
  }

  /** Reload the open history, and the retry path for a failed one. */
  loadHistory(id: string): void {
    this.historyState.set('loading')
    this.historyError.set('')
    this.history.set([])

    this.monitorService
      .checks(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: reply => {
          this.history.set(reply.checks ?? [])
          this.historyState.set(this.history().length ? 'ready' : 'empty')
        },
        error: error => {
          this.historyError.set(this.describeFailure(error, 'MONITOR.HISTORY_ERROR'))
          this.historyState.set('error')
        },
      })
  }

  private closeHistory(): void {
    this.historyOpenFor.set(null)
    this.history.set([])
    this.historyError.set('')
    this.historyState.set('idle')
  }

  // ── presentation helpers ───────────────────────────────────────────────────

  isBusy(id: string): boolean {
    return this.busyIds().includes(id)
  }

  /** The chip class for a monitor's last outcome. */
  statusClass(status: MonitorLastStatus | MonitorCheckStatus): string {
    switch (status) {
      case 'changed':
        return 'bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300'
      case 'error':
        return 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300'
      default:
        return 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200'
    }
  }

  /** The translation key for a monitor's last outcome. */
  statusLabel(status: MonitorLastStatus | MonitorCheckStatus): string {
    switch (status) {
      case 'changed':
        return 'MONITOR.STATUS_CHANGED'
      case 'error':
        return 'MONITOR.STATUS_ERROR'
      default:
        return 'MONITOR.STATUS_UNCHANGED'
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * The interval as an integer inside the route's bounds.
   *
   * A valid control can still hold `"7.5"` or `"1e3"`, which the route's
   * integer read would drop to its own default; clamping here means the value
   * that is stored is the value that was shown.
   */
  private boundedInterval(): number {
    const parsed = Math.trunc(Number(this.intervalControl.value))
    if (!Number.isFinite(parsed)) {
      return MONITOR_LIMITS.defaultIntervalMinutes
    }
    return Math.min(Math.max(parsed, MONITOR_LIMITS.minIntervalMinutes), MONITOR_LIMITS.maxIntervalMinutes)
  }

  private resetForm(): void {
    this.nameControl.reset('')
    this.urlControl.reset('')
    this.selectorControl.reset('')
    this.intervalControl.reset(String(MONITOR_LIMITS.defaultIntervalMinutes))
    this.extractModeControl.reset('markdown')
  }

  private markBusy(id: string): void {
    this.busyIds.update(ids => (ids.includes(id) ? ids : [...ids, id]))
  }

  private clearBusy(id: string): void {
    this.busyIds.update(ids => ids.filter(existing => existing !== id))
  }

  /**
   * One readable line for anything the transport threw.
   *
   * The BFF answers refusals and outages with a JSON body carrying `error`, and
   * that message is preferred over the local fallback because it names the
   * actual reason. `fallbackKey` is translated here so the component never
   * hands the view a key it would print verbatim.
   */
  private describeFailure(error: unknown, fallbackKey: string): string {
    const fallback = this.translate.instant(fallbackKey) as string

    if (!(error instanceof HttpErrorResponse)) {
      return fallback
    }

    const body = error.error
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
      const message = (body as { error: string }).error
      if (message.trim()) {
        return message
      }
    }

    return fallback
  }
}
