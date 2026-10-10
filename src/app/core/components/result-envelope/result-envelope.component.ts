import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core'
import { NgClass } from '@angular/common'
import { MatIcon } from '@angular/material/icon'
import { TranslateModule } from '@ngx-translate/core'

/**
 * The four states every playground output can be in, plus the initial one.
 *
 * `empty` and `error` are deliberately distinct: "the engine answered with
 * nothing" and "the request failed" have different remedies, and rendering both
 * as a blank panel is how a 403 gets mistaken for a content problem.
 */
export type ResultEnvelopeState = 'idle' | 'loading' | 'error' | 'empty' | 'ready'

/**
 * A meta chip's tone.
 *
 * Named after the repository's Material palettes rather than after colours, so
 * a token change moves every chip at once: `primary` is cyan, `secondary` is
 * rose (the repo's preferred second accent over emerald in new UI), `danger`
 * is the error red the form controls already use.
 */
export type ResultEnvelopeTone = 'neutral' | 'primary' | 'secondary' | 'danger'

/** One read-only fact about a result, rendered as a chip in the header. */
export interface ResultEnvelopeMeta {
  /** A translation key. */
  label: string
  /** The already-formatted value. An empty value hides the chip. */
  value: string
  tone?: ResultEnvelopeTone
}

/**
 * The one presentation for a playground result.
 *
 * Every mode renders its output through this component, so "loading", "no
 * results yet" and "the request failed" look the same wherever they appear, and
 * a mode cannot silently forget one of them. The content itself is projected,
 * because what a mode has to show differs and only the chrome around it should
 * not.
 *
 * Absent metadata is not rendered at all: a chip whose value is empty is a
 * missing fact, and an empty chip reads as a zero. That rule lives here rather
 * than in each caller so the `undefined`-in-the-header mistake is not available.
 */
@Component({
  selector: 'app-result-envelope',
  imports: [NgClass, MatIcon, TranslateModule],
  templateUrl: './result-envelope.component.html',
  styleUrl: './result-envelope.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultEnvelopeComponent {
  /** A translation key for the panel heading. */
  @Input() title = ''

  @Input() state: ResultEnvelopeState = 'idle'

  /** Header chips. Empty values are skipped, not rendered blank. */
  @Input() meta: ResultEnvelopeMeta[] = []

  /** The failure text, already resolved to something a person can read. */
  @Input() errorMessage = ''

  /** Translation keys for the three non-content states. */
  @Input() loadingMessage = 'RESULT_ENVELOPE.LOADING'
  @Input() emptyMessage = 'RESULT_ENVELOPE.EMPTY'
  @Input() idleMessage = 'RESULT_ENVELOPE.IDLE'

  /** Show the retry affordance in the header; the caller decides when retry makes sense. */
  @Input() showRetry = false

  @Output() retry = new EventEmitter<void>()

  /**
   * The class for one chip tone.
   *
   * A `switch` rather than a lookup object so a tone added to the union without
   * a class fails the type check instead of rendering unstyled.
   * @param {ResultEnvelopeTone} tone The chip's tone.
   * @return {string} The Tailwind classes for that tone.
   */
  toneClass(tone: ResultEnvelopeTone = 'neutral'): string {
    switch (tone) {
      case 'primary':
        return 'bg-cyan-50 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300'
      case 'secondary':
        return 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
      case 'danger':
        return 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
      default:
        return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
    }
  }

  /** Whether anything belongs in the header at all. */
  get hasHeader(): boolean {
    return Boolean(this.title) || this.meta.length > 0 || this.showRetry
  }
}
