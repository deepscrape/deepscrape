import { HttpErrorResponse } from '@angular/common/http'
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { TranslateModule } from '@ngx-translate/core'
import {
  AdminSession,
  AdminSessionsService,
} from '../../core/services/admin-sessions.service'
import {
  ResultEnvelopeComponent,
  ResultEnvelopeState,
} from '../../core/components/result-envelope/result-envelope.component'

/** One table row: the session, plus its idle time as of this load. */
interface SessionRow {
  session: AdminSession
  /** Minutes since last use, or null when that cannot be computed honestly. */
  idleMinutes: number | null
}

/**
 * Minutes since a session was last used, or null.
 *
 * `null` rather than `0` for an unusable stamp, and the distinction is the whole
 * point of the function: a session used a minute ago and a session whose
 * timestamp did not parse are different facts, and rendering the second as "0
 * idle" would tell an operator that a stuck session is active. A negative delta
 * (clock skew between the server that wrote the stamp and this browser) clamps
 * to 0 rather than rendering a negative age.
 * @param {number} lastUsedAt Epoch ms, as the server wrote it.
 * @param {number} now Epoch ms, read once for the whole table.
 * @return {number | null} Whole minutes idle, or null.
 */
const idleMinutesSince = (lastUsedAt: number, now: number): number | null => {
  if (!Number.isFinite(lastUsedAt) || lastUsedAt <= 0) {
    return null
  }
  const delta = now - lastUsedAt
  return delta <= 0 ? 0 : Math.floor(delta / 60000)
}

/**
 * The platform-wide view of LIVE browser sessions.
 *
 * Across all tenants, and deliberately read-only. `05` Part D asks for "idle
 * time, minutes billed, one-click reclaim"; this ships the first two, because
 * reclaim is not a UI omission but a destructive action against another tenant's
 * live, still-billing machine, and it needs the same sign-off the fleet's
 * lifecycle actions do. The page says so in the interface rather than offering a
 * button that spends someone else's credits.
 *
 * Why the enum values are rendered raw
 * -----------------------------------
 * `mode`, `kind` and `state` come from the server, and nothing enforces that this
 * page's idea of the state set agrees with it. Translating them would mean an
 * i18n table that silently goes stale the day a state is added, and an
 * unrecognised value would render as a missing key. So each is shown as the
 * server wrote it; only the tone is decided here, and an unrecognised value
 * degrades to neutral instead of disappearing.
 *
 * The idle clock is a SNAPSHOT taken at load
 * -----------------------------------------
 * `idleMinutes` is computed from one `Date.now()` per load, not from a ticking
 * interval. That is honest for a console with a Refresh button, and it avoids a
 * timer that would keep the page awake for a number nobody watches.
 */
@Component({
  selector: 'app-admin-sessions',
  standalone: true,
  imports: [TranslateModule, ResultEnvelopeComponent],
  templateUrl: './admin-sessions.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminSessionsComponent implements OnInit {
  private readonly console = inject(AdminSessionsService)
  private readonly destroyRef = inject(DestroyRef)

  /** The envelope's state. `empty` and `ready` are different remedies. */
  readonly state = signal<ResultEnvelopeState>('idle')

  /** A translation key for the failure, resolved by the template. */
  readonly errorKey = signal('')

  readonly sessions = signal<AdminSession[]>([])

  /** True when the server capped the read, so "more exist" is a fact. */
  readonly truncated = signal(false)

  readonly rows = computed<SessionRow[]>(() => {
    // One `now` for the whole table, so two rows cannot disagree about the time.
    const now = Date.now()
    return this.sessions().map(session => ({
      session,
      idleMinutes: idleMinutesSince(session.lastUsedAt, now),
    }))
  })

  /** Minutes billed across the LOADED sessions. Not a platform total. */
  readonly billedMinutes = computed(() =>
    this.sessions().reduce(
      (sum, item) => sum + (Number.isFinite(item.minutesBilled) ? item.minutesBilled : 0),
      0
    )
  )

  ngOnInit(): void {
    this.load()
  }

  /**
   * Read the live sessions.
   *
   * A 500 is reported as an error rather than as an empty list, because "nobody
   * is running a browser" and "the sessions could not be read" have opposite
   * remedies and the second is an operator problem this page must not hide. The
   * likeliest cause is the collection-group index behind the query.
   * @return {void} Nothing.
   */
  load(): void {
    this.state.set('loading')
    this.errorKey.set('')

    this.console
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: reply => {
          const sessions = reply.sessions ?? []
          this.sessions.set(sessions)
          this.truncated.set(reply.truncated === true)
          this.state.set(sessions.length ? 'ready' : 'empty')
        },
        error: (error: HttpErrorResponse) => {
          // 403 is a permission boundary and the operator cannot fix it by
          // retrying; anything else is a read that failed. Collapsing the two
          // would make a platform-admin misconfiguration look like an outage.
          this.errorKey.set(
            error.status === 403
              ? 'ADMIN_SESSIONS.ERROR_PERMISSION'
              : 'ADMIN_SESSIONS.ERROR_GENERIC'
          )
          this.state.set('error')
        },
      })
  }
}
