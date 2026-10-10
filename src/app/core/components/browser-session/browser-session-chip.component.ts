import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import {
  BrowserSession,
  BrowserSessionState,
} from '../../types/browser-session.interface';

/**
 * How each state looks.
 *
 * Read as a total map so a state added to the server enum is a compile error
 * here rather than a chip with no colour. The hues are the repository's own: the
 * primary accent is cyan and the secondary is rose, and there is deliberately no
 * emerald because the theme map asks new UI to prefer rose over it.
 *
 * `starting` is amber rather than cyan on purpose. Cyan is the "live" accent, and
 * a session still coming up is not live yet; using the same colour for both would
 * make the two states indistinguishable at a glance, which is the one job a
 * status chip has.
 */
const STATE_CLASS: Record<BrowserSessionState, string> = {
  starting: 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  ready: 'bg-cyan-50 text-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-200',
  suspended: 'bg-gray-100 text-gray-700 dark:bg-gray5/60 dark:text-gray-200',
  closed: 'bg-gray-100 text-gray-500 dark:bg-gray5/40 dark:text-gray-400',
};

/** The shape every chip shares, independent of state. */
const CHIP_BASE = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium';

/**
 * A session's state at a glance.
 *
 * Presentational and stateless: it takes a session and renders it. It holds no
 * timer, calls no service, and never polls, so it can sit inside a list of many
 * sessions without each one costing a request.
 *
 * The state is carried as TEXT, not only as colour. Colour alone would fail both
 * a screen reader and anyone who cannot separate the hues, and the chip is the
 * only place some of these states are announced.
 */
@Component({
  selector: 'app-browser-session-chip',
  standalone: true,
  imports: [TranslateModule],
  templateUrl: './browser-session-chip.component.html',
  styleUrl: './browser-session-chip.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserSessionChipComponent {
  /** The session to render. Required: a chip with no session has nothing to say. */
  readonly session = input.required<BrowserSession>();

  /**
   * The full class list for the current state.
   *
   * A `computed` here is correct, unlike the `FormControl` case the repository
   * warns about: `session` is a signal input, so this re-evaluates when it
   * changes. Nothing here reads a `FormControl`.
   */
  readonly chipClass = computed(
    () => CHIP_BASE + ' ' + STATE_CLASS[this.session().state]
  );

  /**
   * The translation key for the state.
   *
   * Built from the server's own value rather than a local `switch`, so a state
   * this build does not know about renders as its key instead of silently
   * presenting the wrong word.
   */
  readonly stateKey = computed(
    () => 'BROWSER_SESSION.STATE_' + this.session().state.toUpperCase()
  );

  /**
   * The translation key for how the session got its browser.
   *
   * `BROWSER_SESSION`, not `BROWSER`: the latter is already taken by the
   * remote-browser viewer, whose strings describe a connection state. Sharing it
   * would put two unrelated features' words in one namespace and invite reading a
   * lease state as a viewer's connection state.
   */
  readonly modeKey = computed(
    () => 'BROWSER_SESSION.MODE_' + this.session().mode.toUpperCase()
  );
}
