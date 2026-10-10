import { DatePipe } from '@angular/common'
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
import { MachineFleetService } from '../../core/services/machine-fleet.service'
import { FleetMachine } from '../../core/types/machine-fleet.interface'
import {
  ResultEnvelopeComponent,
  ResultEnvelopeState,
} from '../../core/components/result-envelope/result-envelope.component'

/** One table row: the machine, plus its timestamps only when they parse. */
interface FleetRow {
  machine: FleetMachine
  created: Date | null
  updated: Date | null
}

/** Fly states that mean the machine is up. Anything else is not running. */
const RUNNING_STATES: readonly string[] = ['started', 'starting']

/** Fly states that mean the machine exists but is doing no work. */
const PARKED_STATES: readonly string[] = ['stopped', 'stopping', 'suspended']

/**
 * Read an RFC3339 string, or nothing.
 *
 * Arachnefly stores `created_at` as a STRING (`MachineInDB.CreatedAt`), which is
 * whatever Fly sent. Most of the time that parses; the template is built so that
 * when it does not, the raw value is shown rather than `Invalid Date`. A console
 * that displays `Invalid Date` for a real machine teaches an operator to ignore
 * that column, which is worse than showing them the thing the server actually
 * said.
 * @param {string} raw The stored value.
 * @return {Date | null} The parsed time, or null when it is absent or unusable.
 */
const parseWhen = (raw: string): Date | null => {
  if (!raw) {
    return null
  }
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * The platform-wide machine fleet.
 *
 * This is the admin console's view ACROSS ALL TENANTS, and it is deliberately
 * read-only. That is not an unfinished table: arachnefly's
 * `MachineOwnershipMiddleware` admits only the machine's owner and has no admin
 * bypass, so the lifecycle actions an operator would expect here (start, suspend,
 * stop, destroy) cannot be performed by a platform admin on another tenant's
 * machine. The page says so in the interface rather than offering four buttons
 * that would each answer 403, because a button that always fails is a worse
 * answer than a sentence that explains why there is no button.
 *
 * Why the state is rendered raw
 * ----------------------------
 * `state` comes from Fly by way of arachnefly, and NOTHING enforces that this
 * codebase's idea of the state set agrees with theirs. Translating it would mean
 * an i18n table that silently goes stale the day Fly adds a state, and an
 * unrecognised state would render as a missing key. So the value is shown as the
 * server wrote it, and only its TONE is decided here: a state this page does not
 * recognise gets neutral styling and still displays, which degrades honestly.
 *
 * The count in the header is a fact about the loaded page, not the platform. When
 * the read was capped the page says so, so a capped list is never mistaken for
 * the whole fleet.
 */
@Component({
  selector: 'app-admin-machines',
  standalone: true,
  imports: [DatePipe, TranslateModule, ResultEnvelopeComponent],
  templateUrl: './admin-machines.component.html',
  styleUrl: './admin-machines.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminMachinesComponent implements OnInit {
  private readonly fleet = inject(MachineFleetService)
  private readonly destroyRef = inject(DestroyRef)

  /** The envelope's state. `empty` and `ready` are different remedies. */
  readonly state = signal<ResultEnvelopeState>('idle')

  /** A translation key for the failure, resolved by the template. */
  readonly errorKey = signal('')

  readonly machines = signal<FleetMachine[]>([])

  /** True when the server capped the read, so "more exist" is a fact. */
  readonly truncated = signal(false)

  readonly rows = computed<FleetRow[]>(() =>
    this.machines().map(machine => ({
      machine,
      created: parseWhen(machine.createdAt),
      updated: parseWhen(machine.updatedAt),
    }))
  )

  /** How many of the loaded machines are up. Not a platform total. */
  readonly running = computed(
    () => this.machines().filter(item => RUNNING_STATES.includes(item.state)).length
  )

  ngOnInit(): void {
    this.load()
  }

  /**
   * Read the fleet.
   *
   * A 500 is reported as an error rather than as an empty list, because
   * "no machines" and "cannot read machines" have different remedies and the
   * second is an operator problem this page must not hide. The likeliest cause
   * is the collection-group index, which is declared but not yet deployed.
   * @return {void} Nothing.
   */
  load(): void {
    this.state.set('loading')
    this.errorKey.set('')
    this.fleet
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: reply => {
          this.machines.set(reply.machines)
          this.truncated.set(reply.truncated)
          this.state.set(reply.machines.length > 0 ? 'ready' : 'empty')
        },
        error: (error: unknown) => {
          this.errorKey.set(this.messageKeyFor(error))
          this.state.set('error')
        },
      })
  }

  /**
   * An id shortened for a table cell.
   *
   * Fly ids are long and an operator matches them by prefix, so the full value
   * stays in the DOM via `title` while the cell shows enough to compare by eye.
   * @param {string} value The full id or uid.
   * @return {string} The first eight characters.
   */
  shortId(value: string): string {
    return value.length > 8 ? value.slice(0, 8) : value
  }

  /**
   * The tone for a machine's state.
   *
   * Three buckets, and the third is the important one: a state this page has
   * never seen renders neutral rather than disappearing or throwing.
   * @param {string} state The raw state from the server.
   * @return {string} The Tailwind classes for the state chip.
   */
  stateClass(state: string): string {
    const base =
      'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium'
    if (RUNNING_STATES.includes(state)) {
      return `${base} border-cyan-600 bg-cyan-50 text-cyan-800 dark:border-cyan-500 dark:bg-cyan-900/20 dark:text-cyan-200`
    }
    if (PARKED_STATES.includes(state)) {
      return `${base} border-gray3/55 bg-white/75 text-gray5 dark:border-gray5/60 dark:bg-gray7/55 dark:text-gray-300`
    }
    return `${base} border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-900/20 dark:text-rose-300`
  }

  /**
   * The message for a refusal.
   *
   * The status carries the axis and the body does not: 403 is a permission
   * boundary (this operator is not a platform admin), 401 is an expired session,
   * and the two must not collapse into one "something went wrong". The page is
   * behind `adminGuard` as well, but a route guard is a courtesy and the server
   * is the gate, so the refusal path has to exist here.
   * @param {unknown} error The failure.
   * @return {string} A translation key.
   */
  private messageKeyFor(error: unknown): string {
    const status = error instanceof HttpErrorResponse ? error.status : 0
    switch (status) {
      case 401:
        return 'ADMIN_MACHINES.ERROR_SESSION'
      case 403:
        return 'ADMIN_MACHINES.ERROR_PERMISSION'
      default:
        return 'ADMIN_MACHINES.ERROR_GENERIC'
    }
  }
}
