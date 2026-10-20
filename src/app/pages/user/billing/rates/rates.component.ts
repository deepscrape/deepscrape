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
import { PricingRatesService } from '../../../../core/services/pricing-rates.service'
import { PricingRate } from '../../../../core/types/pricing-rates.interface'
import {
  ResultEnvelopeComponent,
  ResultEnvelopeState,
} from '../../../../core/components/result-envelope/result-envelope.component'

/** How a rate is grouped on the page. */
type RateGroup = 'ai' | 'crawl' | 'machines' | 'webrain' | 'other'

/** Display order. `other` is last because it is the least specific. */
const GROUP_ORDER: readonly RateGroup[] = ['ai', 'crawl', 'machines', 'webrain', 'other']

/**
 * A translation key for an action, when one exists.
 *
 * This map is the ONLY thing this page contributes. It does not decide which rates
 * exist, how many there are, or what any of them cost: the server sends all three.
 * So a rate added on the server appears here immediately, and it appears with its
 * raw action id as its label until someone adds a translation. That is the
 * intended failure mode. The alternative, a page that lists prices by hand, fails
 * by showing a stale NUMBER, which is worse than showing a machine-readable name.
 */
const ACTION_LABELS: Record<string, string> = {
  'ai.anthropic.messages': 'AI_ANTHROPIC',
  'ai.openai.chat': 'AI_OPENAI',
  'ai.groq.chat': 'AI_GROQ',
  'crawl.execute': 'CRAWL',
  'machines.deploy': 'MACHINE_DEPLOY',
  'machines.read': 'MACHINE_READ',
  'machines.check_image': 'MACHINE_CHECK_IMAGE',
  'machines.wait_for_state': 'MACHINE_WAIT',
  'machines.start': 'MACHINE_START',
  'machines.suspend': 'MACHINE_SUSPEND',
  'machines.stop': 'MACHINE_STOP',
  'machines.destroy': 'MACHINE_DESTROY',
  'machines.list': 'MACHINE_LIST',
  // The webrain capacity tools. They carried the `paid` guard with no rule in the
  // price table, so each one was charged the 1-credit fallback until 2026-10-20 --
  // which is how a site-wide spider came to cost a third of one crawl request.
  'webrain.navigate': 'WEBRAIN_NAVIGATE',
  'webrain.observe': 'WEBRAIN_OBSERVE',
  'webrain.vision': 'WEBRAIN_VISION',
  'webrain.batch': 'WEBRAIN_BATCH',
  'webrain.spider': 'WEBRAIN_SPIDER',
  'webrain.download': 'WEBRAIN_DOWNLOAD',
  'webrain.watch': 'WEBRAIN_WATCH',
}

/**
 * Which section an action belongs in, from its own name.
 *
 * Derived rather than declared, so an action nobody has classified is still
 * grouped and still visible. A hand-maintained grouping would silently drop the
 * new rate into no section at all, which is how a price becomes invisible while
 * remaining chargeable.
 * @param {string} action The action id.
 * @return {RateGroup} The group.
 */
const groupFor = (action: string): RateGroup => {
  if (action.startsWith('ai.')) {
    return 'ai'
  }
  if (action.startsWith('crawl.')) {
    return 'crawl'
  }
  if (action.startsWith('machines.')) {
    return 'machines'
  }
  if (action.startsWith('webrain.')) {
    return 'webrain'
  }
  return 'other'
}

/** One priced action, ready to render. */
interface RateRow {
  action: string
  credits: number
  /** A label key, or null when the action has no translation yet. */
  labelKey: string | null
}

/** One section of the page. */
interface RateGroupView {
  group: RateGroup
  rows: RateRow[]
}

/**
 * What the platform charges, read from the table that does the charging.
 *
 * Why this page holds no numbers
 * -----------------------------
 * Roadmap `07` Part G: a hand-written pricing page drifts from the code, and the
 * drift is silent because the code keeps charging correctly. So this page renders
 * the server's table instead of restating it, and the only local knowledge it
 * carries is how to LABEL an action and which section it belongs in. Add a rate on
 * the server and it appears here.
 *
 * Why the fallback is not in the list
 * ----------------------------------
 * The server sends `fallback` separately, and it is rendered separately, because it
 * states something different: not "here is an action you can buy" but "anything not
 * listed costs this". Folding it into the sections would present
 * `api.paid.default` as a product.
 *
 * Why an unlabelled rate shows its action id
 * -----------------------------------------
 * Because the honest failure is a machine-readable name next to a correct number,
 * and the dishonest one is a correct name next to a number nobody has checked. The
 * page never hides a rate it cannot name.
 */
@Component({
  selector: 'app-rates',
  standalone: true,
  imports: [TranslateModule, ResultEnvelopeComponent],
  templateUrl: './rates.component.html',
  styleUrl: './rates.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RatesComponent implements OnInit {
  private readonly pricing = inject(PricingRatesService)
  private readonly destroyRef = inject(DestroyRef)

  /** The envelope's state. `empty` and `ready` are different remedies. */
  readonly state = signal<ResultEnvelopeState>('idle')

  /** A translation key for the failure, resolved by the template. */
  readonly errorKey = signal('')

  readonly rates = signal<PricingRate[]>([])

  /** The price of anything unlisted. Null until the read succeeds. */
  readonly fallback = signal<PricingRate | null>(null)

  /**
   * The rates, grouped and labelled.
   *
   * Empty sections are dropped, and the order comes from `GROUP_ORDER` rather than
   * from the server's declaration order, so the page does not reshuffle itself when
   * a rule is added to the table.
   */
  readonly groups = computed<RateGroupView[]>(() => {
    const buckets = new Map<RateGroup, RateRow[]>()
    for (const rate of this.rates()) {
      const group = groupFor(rate.action)
      const rows = buckets.get(group) ?? []
      rows.push({
        action: rate.action,
        credits: rate.credits,
        labelKey: ACTION_LABELS[rate.action] ?? null,
      })
      buckets.set(group, rows)
    }

    return GROUP_ORDER.map(group => ({
      group,
      rows: buckets.get(group) ?? [],
    })).filter(entry => entry.rows.length > 0)
  })

  ngOnInit(): void {
    this.load()
  }

  /**
   * Read the price list.
   *
   * A 500 is reported as a failure rather than as "nothing is priced", because an
   * empty page makes a false claim about the product while a failure reports one
   * read that did not work.
   * @return {void} Nothing.
   */
  load(): void {
    this.state.set('loading')
    this.errorKey.set('')
    this.pricing
      .rates()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: reply => {
          this.rates.set(reply.rates)
          this.fallback.set(reply.fallback)
          this.state.set(reply.rates.length > 0 ? 'ready' : 'empty')
        },
        error: (error: unknown) => {
          this.errorKey.set(this.messageKeyFor(error))
          this.state.set('error')
        },
      })
  }

  /**
   * The section heading for a group.
   * @param {RateGroup} group The group.
   * @return {string} A translation key.
   */
  groupLabelKey(group: RateGroup): string {
    return 'PRICING_RATES.GROUP_' + group.toUpperCase()
  }

  /**
   * The unit for a credit count.
   *
   * A one/many split rather than a plural-rules engine: ngx-translate has no plural
   * support of its own, and the languages here all separate one from many at this
   * boundary. "1 credits" is the mistake this prevents.
   * @param {number} credits The amount.
   * @return {string} A translation key.
   */
  creditUnitKey(credits: number): string {
    return credits === 1 ? 'PRICING_RATES.CREDIT' : 'PRICING_RATES.CREDITS'
  }

  /**
   * The message for a failure.
   *
   * 401 means the session is gone and 403 means the caller is not entitled to the
   * plan-resolving layer at all; the two need different remedies, so they must not
   * collapse into one "something went wrong".
   * @param {unknown} error The failure.
   * @return {string} A translation key.
   */
  private messageKeyFor(error: unknown): string {
    const status = error instanceof HttpErrorResponse ? error.status : 0
    switch (status) {
      case 401:
        return 'PRICING_RATES.ERROR_SESSION'
      case 403:
        return 'PRICING_RATES.ERROR_FORBIDDEN'
      default:
        return 'PRICING_RATES.ERROR_GENERIC'
    }
  }
}
