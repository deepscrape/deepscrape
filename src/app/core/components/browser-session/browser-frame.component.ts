import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  PLATFORM_ID,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateModule } from '@ngx-translate/core';
import { interval } from 'rxjs';
import { Subscription } from 'rxjs/internal/Subscription';
import { BrowserSessionService } from '../../services/browser-session.service';

/**
 * How long one good frame stays up before the next is requested, in ms.
 *
 * Equal to the interval the server enforces for the slowest tier that serves a
 * frame (`SESSION_CAPS.paid.fps` is 1, so `frameIntervalMs` is 1000), and that is
 * safe rather than a coin flip: `interval()` schedules the next poll 1000ms after
 * the previous one was ISSUED, so the gap measured server-side is 1000ms plus the
 * round trip. Tightening the coupling by polling slower would only make admins
 * (4 fps) wait longer than their cap allows.
 */
const FRAME_INTERVAL_MS = 1000;

/** The delay a failing loop backs off to, in ms. */
const MAX_BACKOFF_MS = 8000;

/**
 * The live view of a session.
 *
 * Roadmap `03` B.4 is the specification, and each clause is a rule rather than a
 * suggestion:
 *
 * - It polls on a timer and CANCELS on destroy. A leaked interval is the most
 *   expensive bug this file can have: it keeps capturing screenshots and keeps
 *   billing minutes with nothing on screen paying for it.
 * - It PAUSES while the tab is hidden, for the same reason. Frames nobody can see
 *   are still frames the customer is charged for.
 * - It BACKS OFF after a failure rather than retrying at full rate, so a broken
 *   frame is not a request per second for as long as the tab stays open.
 * - The status is carried as TEXT. A screen reader gets nothing from an `<img>` of
 *   someone's page, and it still has to learn that frames stopped.
 *
 * One image per poll is the frame-based transport. A WebRTC transport (the neko
 * shape) is a sibling behind the same inputs rather than a rewrite of this one,
 * which is why nothing here assumes more than a URL.
 */
@Component({
  selector: 'app-browser-frame',
  standalone: true,
  imports: [TranslateModule],
  templateUrl: './browser-frame.component.html',
  styleUrl: './browser-frame.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserFrameComponent {
  private readonly sessions = inject(BrowserSessionService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly doc = inject(DOCUMENT);
  private readonly platformId = inject(PLATFORM_ID);

  /** The session to view. Required: a frame with no session has nothing to show. */
  readonly sessionId = input.required<string>();

  /** Whether the loop is currently asking for frames. */
  readonly live = signal(true);

  /** Set when the last frame failed, so the surface can say so instead of looking idle. */
  readonly failed = signal(false);

  /**
   * Whether the tab is hidden.
   *
   * Held as STATE rather than read at each poll. Reading the DOM inside `poll` made
   * the loop undriveable from a spec -- headless Chrome reports the document as
   * `hidden`, so every poll returned early and the suite could not tell "correctly
   * paused" from "broken". It also means the DOM is touched once per visibility
   * change instead of once per frame. On the server this stays true, so the SSR pass
   * asks for no frames at all.
   */
  readonly hidden = signal(true);

  /** Bumped by each poll. Changing it is what makes the `<img>` fetch again. */
  private readonly nonce = signal(0);

  /** The current frame URL. */
  readonly frameUrl = computed(() =>
    this.sessions.frameUrl(this.sessionId(), this.nonce())
  );

  /**
   * What the surface is doing, as a key rather than a sentence.
   *
   * Resolved here instead of as a nested ternary in the template, so a spec can
   * assert the precedence -- a failure outranks a pause, because a paused view and a
   * broken one need different remedies.
   */
  readonly statusKey = computed(() => {
    if (this.failed()) {
      return 'BROWSER_SESSION.FRAME_FAILED';
    }
    return this.live() ? 'BROWSER_SESSION.FRAME_LIVE' : 'BROWSER_SESSION.FRAME_PAUSED';
  });

  /** The toggle's own label, which is the opposite of the current state. */
  readonly toggleKey = computed(() =>
    this.live() ? 'BROWSER_SESSION.FRAME_PAUSE' : 'BROWSER_SESSION.FRAME_RESUME'
  );

  /** The poll loop, held so `stop` can prove it closed rather than assume it. */
  polling: Subscription | null = null;

  /** The delay the next failure will use. Doubles per failure up to the ceiling. */
  private backoff = FRAME_INTERVAL_MS;

  constructor() {
    // Read visibility BEFORE starting: `start` schedules polls, and a hidden tab must
    // not be scheduled even once.
    this.hidden.set(this.hiddenNow());
    this.start();
    this.destroyRef.onDestroy(() => this.stop());

    // Resuming on the way back is a courtesy. NOT polling while hidden is the part
    // that costs money, and `poll` enforces that on its own.
    if (isPlatformBrowser(this.platformId)) {
      const onVisibility = (): void => {
        this.hidden.set(this.hiddenNow());
        if (!this.hidden()) {
          this.poll();
        }
      };
      this.doc.addEventListener('visibilitychange', onVisibility);
      this.destroyRef.onDestroy(() =>
        this.doc.removeEventListener('visibilitychange', onVisibility)
      );
    }
  }

  /**
   * Start (or restart) the loop.
   *
   * `takeUntilDestroyed` is belt to `stop`'s braces: the subscription is also kept
   * so a spec can assert the loop really closed, which the operator alone hides.
   */
  start(): void {
    this.stop();
    this.subscribeWith(FRAME_INTERVAL_MS);
  }

  /** Stop the loop. Safe to call twice, which `onDestroy` relies on. */
  stop(): void {
    this.polling?.unsubscribe();
    this.polling = null;
  }

  /** Ask for one more frame, unless this is a moment when nobody is looking. */
  poll(): void {
    if (!this.live() || this.hidden()) {
      return;
    }
    this.nonce.update((value) => value + 1);
  }

  /** Pause or resume. A pause is deliberate, so it is not a failure. */
  toggle(): void {
    this.live.update((value) => !value);
    if (this.live()) {
      this.poll();
    }
  }

  /**
   * Record that a frame failed to load, and slow the loop down.
   *
   * The interval is replaced rather than left alone: retrying at the full rate is
   * how a single broken frame becomes sustained load against a backend that is
   * already unhappy.
   */
  onFrameError(): void {
    this.failed.set(true);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.stop();
    this.subscribeWith(this.backoff);
  }

  /** Clear the failure once a frame arrives, and return to the normal cadence. */
  onFrameLoad(): void {
    this.failed.set(false);
    if (this.backoff !== FRAME_INTERVAL_MS) {
      this.backoff = FRAME_INTERVAL_MS;
      this.stop();
      this.subscribeWith(this.backoff);
    }
  }

  /** The current frame URL, for a template that needs it twice. */
  private subscribeWith(delay: number): void {
    this.polling = interval(delay)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.poll());
  }

  /** Whether the tab is hidden right now, per the document. */
  private hiddenNow(): boolean {
    return !isPlatformBrowser(this.platformId) || this.doc.visibilityState === 'hidden';
  }
}
