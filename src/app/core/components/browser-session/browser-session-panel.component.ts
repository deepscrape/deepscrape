import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { BrowserSessionService } from '../../services/browser-session.service';
import {
  BrowserSession,
  BrowserSessionCreateRequest,
  BrowserSessionKind,
  BrowserSessionMode,
} from '../../types/browser-session.interface';
import { ResultEnvelopeComponent, ResultEnvelopeState } from '../result-envelope/result-envelope.component';
import { StinputComponent } from '../stinput/stinput.component';
import { listStaggerAnimation } from '../../../animations';
import { BrowserFrameComponent } from './browser-frame.component';
import { BrowserSessionChipComponent } from './browser-session-chip.component';

/** Where one row's own action is in its lifecycle. */
type RowBusy = 'none' | 'keepalive' | 'closing';

/**
 * Lease a browser session, and see what you already hold.
 *
 * Why there are TWO error channels
 * --------------------------------
 * `state` drives the envelope and covers the LIST LOAD only. Everything else
 * (create, keepalive, close) reports through `noticeKey` instead, because those
 * failures happen while the caller still holds sessions. Flipping the envelope to
 * `error` for a failed keepalive would hide the list, and a session the caller
 * cannot see is a session they cannot close, so the UI would be hiding the very
 * thing that needs acting on. One channel for "there is nothing to show", another
 * for "that action did not work".
 *
 * Why a failure here is not "nothing happened"
 * --------------------------------------------
 * Closing a session performs its FINAL meter charge. A 502 means the charge could
 * not be taken and the server deliberately left the session OPEN, so it is still
 * live and still accruing minutes. The copy says that rather than reporting a
 * generic failure, because "the click did nothing" would be a lie.
 *
 * The `FormControl` caution
 * -------------------------
 * `canCreate()` is a METHOD, not a `computed`, on purpose. `cdpControl` is a
 * `FormControl`, which is not a signal, so a `computed` would cache its first
 * value forever and the button would stay disabled after the user typed. This
 * exact bug already shipped once in `tools-panel`.
 */
@Component({
  selector: 'app-browser-session-panel',
  standalone: true,
  imports: [
    DatePipe,
    ReactiveFormsModule,
    TranslateModule,
    ResultEnvelopeComponent,
    StinputComponent,
    BrowserSessionChipComponent,
    BrowserFrameComponent,
  ],
  templateUrl: './browser-session-panel.component.html',
  styleUrl: './browser-session-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [listStaggerAnimation],
})
export class BrowserSessionPanelComponent implements OnInit {
  private readonly service = inject(BrowserSessionService);
  private readonly destroyRef = inject(DestroyRef);

  /** The selectable modes, in the order they are offered. */
  readonly MODES: readonly BrowserSessionMode[] = ['dedicated', 'byo'];

  /**
   * The selectable engines.
   *
   * All three are offered because the server's own `BrowserSessionKind` accepts
   * all three and this component has no basis to refuse one: a session is not a
   * frame. Gating an engine happens at the LIVE VIEW instead, in `canFrame`, which
   * is the only place the missing capability is observable.
   */
  readonly KINDS: readonly BrowserSessionKind[] = [
    'chrome',
    'lightpanda',
    'obscura',
  ];

  /** The live sessions the caller holds. `closed` ones never appear. */
  readonly sessions = signal<BrowserSession[]>([]);

  /** The envelope's state, and the LIST LOAD's failure only. */
  readonly state = signal<ResultEnvelopeState>('idle');

  /** A translation key for the list failure, resolved by the template. */
  readonly errorKey = signal('');

  /** A translation key for an action failure. Never hides the list. */
  readonly noticeKey = signal('');

  /** Per-row busy state, keyed by session id, so rows are independent. */
  readonly busy = signal<Record<string, RowBusy>>({});

  /**
   * Which rows have their live view open, keyed by session id.
   *
   * Absent means CLOSED, and closed is the default because a frame costs money:
   * an open view asks the machine for a frame every second, and a dedicated
   * session bills in started 5-minute blocks. So the frame is mounted only when a
   * human asked for it, and closing the view UNMOUNTS it. Hiding it with CSS
   * would leave the poll running and the meter turning with nothing on screen.
   */
  readonly framed = signal<Record<string, boolean>>({});

  readonly creating = signal(false);
  readonly mode = signal<BrowserSessionMode>('dedicated');
  readonly kind = signal<BrowserSessionKind>('chrome');

  /** The BYO endpoint. Write-only by design: sent, never read back. */
  readonly cdpControl = new FormControl('', { nonNullable: true });

  ngOnInit(): void {
    this.load();
  }

  /**
   * Load the sessions this caller holds.
   *
   * The server excludes `closed`, so what arrives is the live set and it is what
   * a lease list should render. An empty reply is `empty`, not `ready`: "nothing
   * is leased" and "here is your list" have different remedies.
   * @return {void} Nothing.
   */
  load(): void {
    this.state.set('loading');
    this.errorKey.set('');
    this.noticeKey.set('');
    this.service
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: reply => {
          this.sessions.set(reply.sessions);
          this.state.set(reply.sessions.length > 0 ? 'ready' : 'empty');
        },
        error: (error: unknown) => {
          this.errorKey.set(this.messageKeyFor(error));
          this.state.set('error');
        },
      });
  }

  /**
   * Open a session.
   *
   * For `dedicated` this provisions a machine and CHARGES the deploy action, so
   * the button is single-fire while the request is in flight: two calls are two
   * sessions and two charges.
   * @return {void} Nothing.
   */
  create(): void {
    if (!this.canCreate()) {
      return;
    }

    const request: BrowserSessionCreateRequest = {
      mode: this.mode(),
      kind: this.kind(),
    };

    // A CDP URL belongs to `byo` only. On `dedicated` we rent the machine, so
    // carrying one would be meaningless, and `setMode` clears it for that reason.
    if (this.mode() === 'byo') {
      request.cdpUrl = this.cdpControl.value;
    }

    this.creating.set(true);
    this.noticeKey.set('');

    this.service
      .create(request)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: reply => {
          this.creating.set(false);
          this.cdpControl.setValue('');
          this.sessions.update(list => [reply.session, ...list]);
          this.state.set('ready');
        },
        error: (error: unknown) => {
          this.creating.set(false);
          this.noticeKey.set(this.messageKeyFor(error));
        },
      });
  }

  /**
   * Push a session's idle deadline out.
   *
   * A session nobody renews is suspended at its deadline, so a UI that drives one
   * has to call this while it is in use.
   * @param {string} id The session id.
   * @return {void} Nothing.
   */
  keepalive(id: string): void {
    if (this.action(id) !== 'none') {
      return;
    }

    this.setAction(id, 'keepalive');
    this.service
      .keepalive(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: reply => {
          this.setAction(id, 'none');
          this.noticeKey.set('');
          // The reply carries the new deadline, so the row updates from the
          // server's value rather than from a guess about the idle window.
          this.replace(reply.session);
        },
        error: () => {
          this.setAction(id, 'none');
          this.noticeKey.set('BROWSER_SESSION.KEEPALIVE_FAILED');
        },
      });
  }

  /**
   * End a session and release its machine.
   *
   * A closed session leaves the list, because the server's own list excludes
   * `closed`: keeping it here would make the page disagree with itself on the
   * next reload.
   * @param {string} id The session id.
   * @return {void} Nothing.
   */
  close(id: string): void {
    if (this.action(id) !== 'none') {
      return;
    }

    this.setAction(id, 'closing');
    this.service
      .close(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: reply => {
          this.setAction(id, 'none');
          this.noticeKey.set('');
          // Forget the row's view flag with the row, so the map cannot outgrow
          // the list it describes.
          this.framed.update(map => {
            const next = { ...map };
            delete next[reply.session.id];
            return next;
          });
          this.sessions.update(list =>
            list.filter(item => item.id !== reply.session.id)
          );
          if (this.sessions().length === 0) {
            this.state.set('empty');
          }
        },
        error: () => {
          this.setAction(id, 'none');
          this.noticeKey.set('BROWSER_SESSION.CLOSE_FAILED');
        },
      });
  }

  /**
   * Whether the create button may fire.
   *
   * A METHOD rather than a `computed`: `cdpControl` is a `FormControl`, which is
   * not a signal, so a `computed` would freeze on its first value and the button
   * would never enable after the user typed a URL.
   * @return {boolean} True when the request would be complete.
   */
  canCreate(): boolean {
    if (this.creating()) {
      return false;
    }
    if (this.mode() === 'dedicated') {
      return true;
    }
    return this.cdpControl.value.trim().length > 0;
  }

  /**
   * Choose the access mode.
   * @param {BrowserSessionMode} mode The chosen mode.
   * @return {void} Nothing.
   */
  setMode(mode: BrowserSessionMode): void {
    this.mode.set(mode);
    if (mode === 'dedicated') {
      // A URL left over from `byo` must not ride along on a dedicated create,
      // and leaving it on screen would imply it is still in play.
      this.cdpControl.setValue('');
    }
  }

  /**
   * Choose the engine.
   * @param {BrowserSessionKind} kind The chosen engine.
   * @return {void} Nothing.
   */
  setKind(kind: BrowserSessionKind): void {
    this.kind.set(kind);
  }

  /**
   * The translation key for a mode, built from the server's own value.
   * @param {BrowserSessionMode} mode The mode.
   * @return {string} The translation key.
   */
  modeLabelKey(mode: BrowserSessionMode): string {
    return 'BROWSER_SESSION.MODE_' + mode.toUpperCase();
  }

  /**
   * The translation key for an engine, built from the server's own value.
   * @param {BrowserSessionKind} kind The engine.
   * @return {string} The translation key.
   */
  kindLabelKey(kind: BrowserSessionKind): string {
    return 'BROWSER_SESSION.KIND_' + kind.toUpperCase();
  }

  /**
   * One row's current action.
   * @param {string} id The session id.
   * @return {RowBusy} The action, or `none`.
   */
  action(id: string): RowBusy {
    return this.busy()[id] ?? 'none';
  }

  /**
   * Whether an engine can produce a frame at all.
   *
   * `lightpanda` cannot, and this is the only place that matters. It is a parser
   * that returns the page as markup with no rendering step, which is precisely why
   * it is cheap: no layout, no paint, and therefore no pixels to show. Offering it
   * a live view would be offering an image that cannot exist, so the row says why
   * instead of showing a permanently broken panel.
   *
   * A METHOD rather than a `computed`: a `computed` caches a signal, and this
   * depends on an argument.
   * @param {BrowserSessionKind} kind The engine.
   * @return {boolean} True when the engine renders pixels.
   */
  canFrame(kind: BrowserSessionKind): boolean {
    return kind !== 'lightpanda';
  }

  /**
   * The DOM id of a row's live view region.
   *
   * Built in one place so the toggle's `aria-controls` and the region cannot
   * drift apart. Naming an element that is absent while collapsed is allowed,
   * so this can be handed out whether or not the view is open.
   * @param {string} id The session id.
   * @return {string} The id for the region element.
   */
  frameId(id: string): string {
    return 'browser-frame-' + id;
  }

  /**
   * Whether a row's live view is open.
   * @param {string} id The session id.
   * @return {boolean} True when the frame should be mounted.
   */
  isFramed(id: string): boolean {
    return this.framed()[id] === true;
  }

  /**
   * Open or close a row's live view.
   *
   * Closing UNMOUNTS the frame rather than hiding it. The frame owns the poll, so
   * a poll that outlives its viewer is a meter running with nothing on screen.
   * @param {string} id The session id.
   * @return {void} Nothing.
   */
  toggleFrame(id: string): void {
    this.framed.update(map => ({ ...map, [id]: !this.isFramed(id) }));
  }

  /**
   * The chrome for one selectable option.
   *
   * Cyan is the repository's primary accent, and it is the only thing that
   * distinguishes the chosen option, so `aria-pressed` carries the same fact for
   * anyone who cannot separate the hues.
   * @param {boolean} active Whether the option is the current choice.
   * @return {string} The Tailwind classes.
   */
  toggleClass(active: boolean): string {
    return active
      ? 'inline-flex items-center rounded-full border border-cyan-600 bg-cyan-50 px-3 py-1 text-xs font-medium text-cyan-800 dark:border-cyan-500 dark:bg-cyan-900/20 dark:text-cyan-200'
      : 'inline-flex items-center rounded-full border border-gray3/55 bg-white/75 px-3 py-1 text-xs font-medium text-gray5 hover:border-gray4 dark:border-gray5/60 dark:bg-gray7/55 dark:text-gray-300';
  }

  /** The chrome for a per-row action that is not destructive. */
  actionClass(): string {
    return 'rounded-md border border-gray3/55 bg-white/75 px-2.5 py-1 text-xs font-medium text-gray5 hover:border-gray4 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray5/60 dark:bg-gray7/55 dark:text-gray-200';
  }

  /**
   * The chrome for ending a session, which is the one destructive action here.
   *
   * Rose is the repository's secondary accent and it is what the admin surfaces
   * already use for a failure, so ending a session reads as destructive without
   * introducing a third colour family.
   */
  dangerClass(): string {
    return 'rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-800 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-900/60 dark:bg-rose-900/20 dark:text-rose-300';
  }

  /**
   * Record a row's action.
   * @param {string} id The session id.
   * @param {RowBusy} action The action to record.
   * @return {void} Nothing.
   */
  private setAction(id: string, action: RowBusy): void {
    this.busy.update(map => ({ ...map, [id]: action }));
  }

  /**
   * Swap one session for the server's newer copy of it.
   * @param {BrowserSession} session The session as the server just reported it.
   * @return {void} Nothing.
   */
  private replace(session: BrowserSession): void {
    this.sessions.update(list =>
      list.map(item => (item.id === session.id ? session : item))
    );
  }

  /**
   * The message for a refusal.
   *
   * The status carries the axis and the body does not, which is why this reads
   * the status: 402 is a PLAN boundary and 403 is a PERMISSION boundary, and the
   * two must not collapse into one "you cannot do that". A viewer with no lease
   * rights is not a customer who has not paid, so 403 deliberately gets no
   * upgrade framing.
   * @param {unknown} error The failure.
   * @return {string} A translation key.
   */
  private messageKeyFor(error: unknown): string {
    const status = error instanceof HttpErrorResponse ? error.status : 0;
    switch (status) {
      case 402:
        return 'BROWSER_SESSION.ERROR_PLAN';
      case 403:
        return 'BROWSER_SESSION.ERROR_PERMISSION';
      case 503:
        return 'BROWSER_SESSION.ERROR_CAPACITY';
      default:
        return 'BROWSER_SESSION.ERROR_GENERIC';
    }
  }
}
