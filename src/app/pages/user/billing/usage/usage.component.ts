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

}
