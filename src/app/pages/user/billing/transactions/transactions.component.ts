import { AsyncPipe, CurrencyPipe, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { MatIconModule } from '@angular/material/icon'
import { TranslateModule } from '@ngx-translate/core'
import { BehaviorSubject, catchError, from, map, of, shareReplay, switchMap } from 'rxjs'
import { BillingService } from 'src/app/core/services'
import { BillingUsageInvoice, BillingUsagePayment, BillingUsageResponse, BillingUsageRangeKey } from 'src/app/core/types'

@Component({
  selector: 'app-transactions',
  imports: [AsyncPipe, CurrencyPipe, DatePipe, MatIconModule, TranslateModule],
  templateUrl: './transactions.component.html',
  styleUrl: './transactions.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransactionsComponent {
  private readonly billingService = inject(BillingService)
  private readonly destroyRef = inject(DestroyRef)

  readonly rangeKey$ = new BehaviorSubject<BillingUsageRangeKey>('last_30_days')
  readonly ranges: Array<{ key: BillingUsageRangeKey; label: string }> = [
    { key: 'this_month', label: 'BILLING_TRANSACTIONS.RANGE_THIS_MONTH' },
    { key: 'last_month', label: 'BILLING_TRANSACTIONS.RANGE_LAST_MONTH' },
    { key: 'last_30_days', label: 'BILLING_TRANSACTIONS.RANGE_LAST_30_DAYS' },
    { key: 'last_90_days', label: 'BILLING_TRANSACTIONS.RANGE_LAST_90_DAYS' },
  ]

  readonly usageReport$ = this.rangeKey$.pipe(
    switchMap((range) =>
      from(this.billingService.getUsageReport({ range })).pipe(
        catchError(() => of(null)),
      ),
    ),
    shareReplay({ bufferSize: 1, refCount: true }),
  )

  readonly invoices$ = this.usageReport$.pipe(
    map((report) => report?.invoices || []),
  )

  readonly payments$ = this.usageReport$.pipe(
    map((report) => report?.payments || []),
  )

  readonly summary$ = this.usageReport$.pipe(
    map((report) => report?.summary || null),
  )

  setRange(key: BillingUsageRangeKey): void {
    this.rangeKey$.next(key)
  }

  /** Stripe sends lowercase codes and `CurrencyPipe` needs the ISO form to print €. */
  asCurrencyCode(currency: string | null | undefined): string {
    return (currency || 'EUR').toUpperCase()
  }

  getInvoiceStatusIcon(status: string | null): string {
    switch (status) {
      case 'paid': return 'check_circle'
      case 'open': return 'pending'
      case 'void': return 'cancel'
      case 'uncollectible': return 'error'
      default: return 'help_outline'
    }
  }

  getPaymentStatusClass(status: string): string {
    switch (status) {
      case 'succeeded': return 'text-green-600 dark:text-green-400'
      case 'processing': return 'text-amber-600 dark:text-amber-400'
      case 'requires_payment_method': return 'text-red-600 dark:text-red-400'
      default: return 'text-gray-500'
    }
  }
}
