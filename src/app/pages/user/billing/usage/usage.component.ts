import { AsyncPipe, CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core'
import { FormControl, ReactiveFormsModule } from '@angular/forms'
import { MatIconModule } from '@angular/material/icon'
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { DropdownComponent } from 'src/app/core/components/dropdown/dropdown.component'
import { fadeInUp, smoothfadeAnimation } from 'src/app/animations'
import { BillingService } from 'src/app/core/services'
import {
  BillingUsageRangeKey,
  BillingUsageResponse,
} from 'src/app/core/types'
import { BehaviorSubject, catchError, from, map, Observable, of, shareReplay, switchMap } from 'rxjs'
import { ACTION_LABELS } from '../rates/rates.component'

/**
 * Ledger reasons that are not pricing actions, so `ACTION_LABELS` cannot name them.
 *
 * `meter:block` is written by `chargeSessionMeter` and appears once per started
 * block of every leased session, which makes it the single largest line on a
 * browser-heavy account. Without an entry here that line would read `meter:block`
 * to the customer -- a raw identifier on the one row they most need to understand.
 */
const LEDGER_REASON_LABELS: Record<string, string> = {
  'meter:block': 'BILLING_USAGE.METERED_BILLED_BROWSER_TIME',
}

type UsageViewModel = {
  report: BillingUsageResponse | null
}

@Component({
  selector: 'app-usage',
  imports: [AsyncPipe, ReactiveFormsModule, CurrencyPipe, DecimalPipe, DatePipe, MatIconModule, MatProgressSpinnerModule, DropdownComponent, TranslateModule],
  templateUrl: './usage.component.html',
  styleUrl: './usage.component.scss',
  animations: [fadeInUp, smoothfadeAnimation],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsageComponent {
  private readonly translate = inject(TranslateService)

  readonly rangeDropdownOptions: Array<{ name: string; code: string }> = [
    { name: 'BILLING_TRANSACTIONS.RANGE_THIS_MONTH', code: 'this_month' },
    { name: 'BILLING_TRANSACTIONS.RANGE_LAST_MONTH', code: 'last_month' },
    { name: 'BILLING_TRANSACTIONS.RANGE_LAST_30_DAYS', code: 'last_30_days' },
    { name: 'BILLING_TRANSACTIONS.RANGE_LAST_90_DAYS', code: 'last_90_days' },
  ]

  readonly rangeControl = new FormControl<{ name: string; code: string }>(
    { name: 'BILLING_TRANSACTIONS.RANGE_THIS_MONTH', code: 'this_month' },
    { nonNullable: true },
  )

  selectedRange: BillingUsageRangeKey = 'this_month'
  errorMessage = ''
  readonly loadingState$ = this.billingService.loadingState$

  private readonly range$ = new BehaviorSubject<BillingUsageRangeKey>(this.selectedRange)

  readonly vm$: Observable<UsageViewModel> = this.range$.pipe(
    switchMap((range) => {
      this.errorMessage = ''

      return from(this.billingService.getUsageReport({ range })).pipe(
        map((report) => ({ report })),
        catchError(() => {
          this.errorMessage = 'BILLING_USAGE.LOAD_ERROR'
          return of({ report: null })
        }),
      )
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  )

  constructor(private readonly billingService: BillingService) {}

  onRangeChange(range: BillingUsageRangeKey): void {
    this.selectedRange = range
    this.range$.next(range)
  }

  asCurrencyCode(currency: string | null | undefined): string {
    return (currency || 'EUR').toUpperCase()
  }

  /**
   * The translated label for a metered capability, or null when there is none.
   *
   * Reuses the rates page's action map rather than holding a second copy, so a capability
   * reads identically on both screens. An unmapped action returns null and the template
   * falls back to the raw action id — the same intended failure mode the rates page
   * documents: a raw id is worse than a translated name but better than a wrong one.
   */
  meterLabel(action: string): string | null {
    const reason = LEDGER_REASON_LABELS[action]
    if (reason) {
      return reason
    }

    const suffix = ACTION_LABELS[action]
    return suffix ? `PRICING_RATES.ACTION_${suffix}` : null
  }

  /** Share of the period's credits this capability accounts for, 0-100. */
  shareOfMetered(credits: number, total: number): number {
    if (!Number.isFinite(credits) || !Number.isFinite(total) || total <= 0) {
      return 0
    }

    return Math.min(100, Math.max(0, (credits / total) * 100))
  }

}
