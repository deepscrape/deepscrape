import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateModule } from '@ngx-translate/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { firstValueFrom, interval } from 'rxjs';
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
 * The tool's own payload, unwrapped from the MCP envelope.
 *
 * THREE shapes in series, and each is a place a contract can drift: a
 * `tools/call` answer is `{result: {content: [{type: "text", text: "..."}]}}`, so
 * the tool's JSON arrives as a STRING inside the envelope rather than as nested
 * JSON. Undefined for anything that is not that shape, so a caller reads a
 * refusal rather than half an object.
 * @param {unknown} envelope The `result` of the machine's reply.
 * @return {Record<string, unknown> | undefined} The payload, or undefined.
 */
export const toolPayload = (
  envelope: unknown,
): Record<string, unknown> | undefined => {
  const result = (envelope as { result?: { content?: unknown } } | null)?.result;
  const content = result?.content;

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((part) => (part as { text?: unknown })?.text)
    .filter((value): value is string => typeof value === 'string')
    .join('');

  if (!text) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ?
      (parsed as Record<string, unknown>) :
      undefined;
  } catch {
    return undefined;
  }
};

/**
 * The visible interactive elements a page state reports.
 *
 * `index` is the ENGINE's, and it is valid for `type` because webrain's own
 * `ELEMENTS_JS` is documented as "shared by navigate and snapshot so both produce
 * identical element lists" -- so an index read from `observe` resolves against
 * the same list `webrain_type` uses. That is the whole join this feature rests on.
 *
 * The engine also returns a `selector`, and it is deliberately NOT used: a
 * selector is not an index, and passing one where the other is meant is exactly
 * the silent wrong answer this file refuses elsewhere. Non-visible elements are
 * dropped, because they cannot be clicked or typed into.
 * @param {Record<string, unknown> | undefined} payload The page state.
 * @return {{index: number, label: string}[]} One row per usable element.
 */
export const pageFields = (
  payload: Record<string, unknown> | undefined,
): { index: number; label: string }[] => {
  const elements = payload?.['elements'];

  if (!Array.isArray(elements)) {
    return [];
  }

  const rows: { index: number; label: string }[] = [];

  for (const value of elements) {
    const element = value as {
      index?: unknown;
      tag?: unknown;
      text?: unknown;
      visible?: unknown;
    };

    if (typeof element.index !== 'number' || element.visible === false) {
      continue;
    }

    const tag = typeof element.tag === 'string' ? element.tag : '?';
    const text = typeof element.text === 'string' ? element.text.trim().slice(0, 60) : '';
    rows.push({ index: element.index, label: text ? `${tag} \u2014 ${text}` : tag });
  }

  return rows;
};

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
  imports: [TranslateModule, ReactiveFormsModule],
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

  /**
   * The keys this surface can send, as value plus an i18n key.
   *
   * Data rather than four near-identical buttons: the values are the engine's own
   * key names and must not be translated, while the labels must be.
   */
  protected readonly KEYS = [
    { value: 'Enter', label: 'BROWSER_SESSION.KEY_ENTER' },
    { value: 'Tab', label: 'BROWSER_SESSION.KEY_TAB' },
    { value: 'Escape', label: 'BROWSER_SESSION.KEY_ESCAPE' },
    { value: 'Backspace', label: 'BROWSER_SESSION.KEY_BACKSPACE' },
  ] as const;

  /**
   * The page's interactive elements, as the engine indexed them.
   *
   * A plain signal rather than a resource: this is fetched on demand after a
   * click, and an empty list is a legitimate answer (a page with nothing
   * interactive) rather than a loading state.
   */
  readonly fields = signal<{ index: number; label: string }[]>([]);

  readonly fieldsLoading = signal(false);

  /** Which element to type into, by the engine's index. */
  readonly fieldControl = new FormControl<number | null>(null);

  /** The text to send. Emits per keystroke, which is why sending is a button. */
  readonly textControl = new FormControl('', { nonNullable: true });

  /**
   * The image, so a click on it can be mapped to a click on the PAGE.
   *
   * Necessary because the picture is displayed `w-full`: it is almost always
   * SCALED, and raw client offsets would aim at a point the caller never clicked.
   * That is a plausible wrong answer rather than an error, which is the failure
   * mode this repository treats as the worst one.
   */
  private readonly frameImage = viewChild<ElementRef<HTMLImageElement>>('frame');

  /** True while an action is in flight, so the controls lock instead of queue. */
  readonly acting = signal(false);

  /** What the last action did, as an i18n KEY. Empty until one is sent. */
  readonly actionNote = signal('');

  /**
   * Whether driving is possible at all.
   *
   * A paused or failed view cannot be driven: the coordinates would be mapped
   * against a picture that is not the page, which is the silent wrong answer this
   * component refuses everywhere else. Pausing is therefore also a safety
   * control, not only a cost one.
   */
  readonly canDrive = computed(() => this.live() && !this.failed());

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

  /**
   * Click the PAGE where the picture was clicked.
   *
   * Both axes are scaled INDEPENDENTLY, by the ratio of the screenshot's own
   * pixels to its displayed pixels. A single ratio would be a lie the moment the
   * container is not proportionally sized -- and the error would be invisible, at
   * coordinates that look deliberate.
   * @param {MouseEvent} event The click on the image.
   * @return {Promise<void>} Nothing.
   */
  async clickFrame(event: MouseEvent): Promise<void> {
    const image = this.frameImage()?.nativeElement;

    if (!this.canDrive() || !image?.naturalWidth || !image.naturalHeight) {
      return;
    }

    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    // `click_coords` wants INTEGERS: the engine reads them with `as_i64` and
    // refuses a negative, so a fractional coordinate would arrive as missing.
    const x = Math.round(
      (event.clientX - rect.left) * (image.naturalWidth / rect.width),
    );
    const y = Math.round(
      (event.clientY - rect.top) * (image.naturalHeight / rect.height),
    );

    await this.run('click_coords', { x, y });
  }

  /** Press a named key on the page.
   * @param {string} key The engine's key name, never a label.
   * @return {Promise<void>} Nothing.
   */
  async pressKey(key: string): Promise<void> {
    await this.run('press', { key });
  }

  /** Scroll the page.
   * @param {string} direction `up` or `down`, as the engine names them.
   * @return {Promise<void>} Nothing.
   */
  async scrollPage(direction: string): Promise<void> {
    await this.run('scroll', { direction });
  }

  /** Reload the page the machine is on.
   * @return {Promise<void>} Nothing.
   */
  async reloadPage(): Promise<void> {
    await this.run('nav', { nav: 'reload' });
  }

  /**
   * Send one interaction to the session's OWN machine.
   *
   * One place rather than four, so the lock, the note and the failure handling
   * cannot disagree about what "an action is running" means.
   *
   * The frame is deliberately NOT refreshed on success. The loop asks for the next
   * one within a second, and forcing one here would put two captures inside a
   * single interval -- which the server refuses with `frame_too_soon`, turning a
   * successful click into a visible failure.
   *
   * Every action here is an `interact`, so the tool name is fixed and only the
   * `action` varies. Text entry goes through `typeText` instead, because it needs
   * an element index from `loadFields` first.
   * @param {string} action One of `webrain_interact`'s actions.
   * @param {Record<string, unknown>} args That action's arguments.
   * @return {Promise<unknown>} The MCP envelope, or undefined on failure.
   */
  private run(action: string, args: Record<string, unknown>): Promise<unknown> {
    return this.runTool('webrain_interact', { action, ...args });
  }

  /**
   * The one place a machine tool is called, so the lock, the note and the
   * envelope unwrap cannot disagree between callers.
   * @param {string} tool A name from `SESSION_TOOLS`.
   * @param {Record<string, unknown>} args That tool's arguments.
   * @return {Promise<unknown>} The MCP envelope, or undefined on failure.
   */
  private async runTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.acting()) {
      return undefined;
    }

    this.acting.set(true);
    this.actionNote.set('');

    try {
      const reply = await firstValueFrom(this.sessions.tool(this.sessionId(), tool, args));
      this.actionNote.set('BROWSER_SESSION.ACTION_SENT');
      return reply.result;
    } catch {
      // Reported, never swallowed: a refused action and a delivered one look
      // identical on a picture that has not changed yet.
      this.actionNote.set('BROWSER_SESSION.ACTION_FAILED');
      return undefined;
    } finally {
      this.acting.set(false);
    }
  }

  /**
   * Read the page's interactive elements, so one of them can be typed into.
   *
   * This is the surface text entry was missing. `webrain_type` REFUSES a call
   * with no element `index` ("index required"), so a text box with no list behind
   * it would be a control that always fails -- which is why the first cut of this
   * component had none. `observe(what=state)` reports the same indexed list
   * `navigate` does, because webrain's `ELEMENTS_JS` is shared by both for exactly
   * that reason, and that is what makes an index read here valid for `type`.
   * @return {Promise<void>} Nothing.
   */
  async loadFields(): Promise<void> {
    this.fieldsLoading.set(true);

    try {
      const payload = toolPayload(await this.runTool('webrain_observe', { what: 'state' }));
      const rows = pageFields(payload);

      this.fields.set(rows);
      this.fieldControl.setValue(rows.length > 0 ? rows[0].index : null);

      if (rows.length === 0 && payload !== undefined) {
        // A live page with nothing interactive is an ANSWER, not a failure, and
        // it must not read as one or the load looks broken.
        this.actionNote.set('BROWSER_SESSION.NO_FIELDS');
      }
    } finally {
      this.fieldsLoading.set(false);
    }
  }

  /**
   * Type the box's text into the chosen element.
   * @return {Promise<void>} Nothing.
   */
  async typeText(): Promise<void> {
    const index = this.fieldControl.value;
    const text = this.textControl.value;

    // The engine refuses a missing index but TYPES an empty string without
    // complaint, so an empty box would be a silently successful no-op.
    if (index === null || index < 0 || text.length === 0) {
      this.actionNote.set('BROWSER_SESSION.TYPE_NEEDS_BOTH');
      return;
    }

    await this.runTool('webrain_interact', { action: 'type', index, text });

    if (this.actionNote() === 'BROWSER_SESSION.ACTION_SENT') {
      // Cleared only on success: what was typed may be a credential, and leaving
      // it on screen is the same hygiene rule the egress box follows.
      this.textControl.setValue('', { emitEvent: false });
    }
  }

  /** Whether the tab is hidden right now, per the document. */
  private hiddenNow(): boolean {
    return !isPlatformBrowser(this.platformId) || this.doc.visibilityState === 'hidden';
  }
}
