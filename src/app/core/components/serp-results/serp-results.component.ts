import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core'
import { NgClass } from '@angular/common'
import { MatIcon } from '@angular/material/icon'
import { TranslateModule } from '@ngx-translate/core'
import { SerpEngineReport, SerpEngineStatus, SerpResponse, SerpResult } from '../../types'
import { ResultEnvelopeComponent, ResultEnvelopeMeta, ResultEnvelopeState, ResultEnvelopeTone } from '../result-envelope/result-envelope.component'
import { StorageSaveButtonComponent } from '../storage-save-button/storage-save-button.component'

/**
 * Renders one `SerpResponse`.
 *
 * Three of the response's fields are `skip_serializing_if` on the Rust side, so
 * `per_engine`, `skipped` and `source` are ABSENT when empty rather than `null`
 * or `[]`. Every read here goes through a getter that coalesces to an empty
 * array, so an absent field renders nothing at all instead of an empty block or
 * the word `undefined`. That is the whole reason this is a component and not
 * markup inline in a mode: the rule is easy to get wrong once and hard to get
 * wrong in a single place.
 *
 * `empty` and `skipped` per-engine statuses stay distinct on screen. `empty`
 * means the engine answered with nothing relevant; `skipped` means it never
 * answered, which is a configuration or availability problem wearing the same
 * label as a content problem if the two are merged.
 */
@Component({
  selector: 'app-serp-results',
  imports: [NgClass, MatIcon, TranslateModule, ResultEnvelopeComponent, StorageSaveButtonComponent],
  templateUrl: './serp-results.component.html',
  styleUrl: './serp-results.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SerpResultsComponent {
  /** The engine's reply. `null` until a search has succeeded. */
  @Input() response: SerpResponse | null = null

  /** Which envelope state to render. The caller owns this because it owns the request. */
  @Input() state: ResultEnvelopeState = 'idle'

  @Input() errorMessage = ''

  @Input() showRetry = false

  @Output() retry = new EventEmitter<void>()

  /** Typed results, or nothing when the reply carries none. */
  get results(): SerpResult[] {
    return this.response?.results ?? []
  }

  /**
   * The per-engine breakdown.
   *
   * Absent for a single-engine call with no fallbacks, so this is routinely
   * empty and the block below it is conditional on that.
   */
  get perEngine(): SerpEngineReport[] {
    return this.response?.per_engine ?? []
  }

  /** Engines that never answered. Absent more often than not. */
  get skipped(): string[] {
    return this.response?.skipped ?? []
  }

  /**
   * Header facts.
   *
   * `source` is added only when it differs from `engine`, because equal values
   * are one fact printed twice; the route sets it only after a fallback, so the
   * check is a guard against a producer that always fills it in.
   */
  get meta(): ResultEnvelopeMeta[] {
    const reply = this.response
    if (!reply) {
      return []
    }

    const chips: ResultEnvelopeMeta[] = [
      { label: 'SEARCH.META_ENGINE', value: reply.engine, tone: 'primary' },
      { label: 'SEARCH.META_RESULTS', value: String(this.results.length) },
    ]

    if (reply.source && reply.source !== reply.engine) {
      chips.push({ label: 'SEARCH.META_SOURCE', value: reply.source, tone: 'secondary' })
    }

    if (typeof reply.ms === 'number') {
      chips.push({ label: 'SEARCH.META_TOOK', value: `${reply.ms} ms` })
    }

    return chips
  }

  /** A title is not guaranteed; the URL is the honest fallback. */
  displayTitle(result: SerpResult): string {
    return result.title?.trim() ? result.title : result.url
  }

  /** The chip class for one engine status. */
  statusTone(status: SerpEngineStatus): ResultEnvelopeTone {
    switch (status) {
      case 'ok':
        return 'primary'
      case 'skipped':
        return 'secondary'
      default:
        return 'neutral'
    }
  }

  /** The translation key for one engine status. */
  statusLabel(status: SerpEngineStatus): string {
    switch (status) {
      case 'ok':
        return 'SEARCH.STATUS_OK'
      case 'empty':
        return 'SEARCH.STATUS_EMPTY'
      default:
        return 'SEARCH.STATUS_SKIPPED'
    }
  }

  /** The inline class for one engine status, used by the per-engine list. */
  statusClass(status: SerpEngineStatus): string {
    switch (status) {
      case 'ok':
        return 'bg-cyan-100 text-cyan-800 dark:bg-cyan-950/50 dark:text-cyan-300'
      case 'empty':
        return 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200'
      default:
        return 'bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300'
    }
  }
}
