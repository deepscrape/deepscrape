import { AsyncPipe, CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, ViewChild } from '@angular/core'
import { FormControl, ReactiveFormsModule } from '@angular/forms'
import { MatIconModule } from '@angular/material/icon'
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { DropdownComponent } from 'src/app/core/components/dropdown/dropdown.component'
import { ChartConfiguration, ChartData } from 'chart.js'
import { BaseChartDirective } from 'ng2-charts'
// chart.js v4 has an empty registry until something registers it — see the file's header.
import 'src/app/core/chart-registration'
import { fadeInUp, smoothfadeAnimation } from 'src/app/animations'
import { BillingService } from 'src/app/core/services'
import {
  BillingUsageBreakdownItem,
  BillingUsageRangeKey,
  BillingUsageResponse,
} from 'src/app/core/types'
import { BehaviorSubject, catchError, from, map, Observable, of, shareReplay, switchMap } from 'rxjs'

type UsageViewModel = {
  report: BillingUsageResponse | null
  chartPoints: Array<{ dateKey: string; label: string; value: number }>
  chartData: ChartData<'bar'>
  chartOptions: ChartConfiguration<'bar'>['options']
}

@Component({
  selector: 'app-usage',
  imports: [AsyncPipe, ReactiveFormsModule, CurrencyPipe, DecimalPipe, DatePipe, MatIconModule, MatProgressSpinnerModule, DropdownComponent, BaseChartDirective, TranslateModule],
  templateUrl: './usage.component.html',
  styleUrl: './usage.component.scss',
  animations: [fadeInUp, smoothfadeAnimation],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsageComponent {
  private readonly translate = inject(TranslateService)

  @ViewChild(BaseChartDirective) usageChart?: BaseChartDirective

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
        map((report) => ({
          report,
          chartPoints: this.buildChartPoints(report),
          chartData: this.buildUsageChartData(report),
          chartOptions: this.buildUsageChartOptions(),
        })),
        catchError(() => {
          this.errorMessage = 'BILLING_USAGE.LOAD_ERROR'
          return of({
            report: null,
            chartPoints: [],
            chartData: this.buildUsageChartData(null),
            chartOptions: this.buildUsageChartOptions(),
          })
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

  isUnitRow(item: BillingUsageBreakdownItem): boolean {
    return item.currency === 'units'
  }

  private buildChartPoints(report: BillingUsageResponse | null): Array<{ dateKey: string; label: string; value: number }> {
    if (!report) {
      return []
    }

    const bucket = new Map<string, number>()

    for (const meter of report.meteredUsage.meters) {
      for (const point of meter.timeline) {
        const dateKey = point.end.slice(0, 10)
        const nextValue = (bucket.get(dateKey) || 0) + Number(point.value || 0)
        bucket.set(dateKey, nextValue)
      }
    }

    if (!bucket.size) {
      for (const row of report.breakdown) {
        if (row.source !== 'meter') {
          continue
        }

        const dateKey = row.date.slice(0, 10)
        const nextValue = (bucket.get(dateKey) || 0) + Number(row.quantity || 0)
        bucket.set(dateKey, nextValue)
      }
    }

    return Array.from(bucket.entries())
      .sort(([a], [b]) => new Date(a).getTime() - new Date(b).getTime())
      .slice(-14)
      .map(([dateKey, value]) => ({
        dateKey,
        label: new Date(dateKey).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        value,
      }))
  }

  private buildUsageChartData(report: BillingUsageResponse | null): ChartData<'bar'> {
    const points = this.buildChartPoints(report)

    return {
      labels: points.map((point) => point.label),
      datasets: [
        {
          label: this.translate.instant('BILLING_USAGE.METERED_USAGE'),
          data: points.map((point) => point.value),
          borderRadius: 8,
          borderSkipped: false,
          maxBarThickness: 34,
          backgroundColor: 'rgba(99, 102, 241, 0.75)',
          borderColor: 'rgba(99, 102, 241, 1)',
          borderWidth: 1,
        },
      ],
    }
  }

  private buildUsageChartOptions(): ChartConfiguration<'bar'>['options'] {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.9)',
          titleColor: '#f8fafc',
          bodyColor: '#f8fafc',
          borderColor: 'rgba(148, 163, 184, 0.35)',
          borderWidth: 1,
          callbacks: {
            label: (context) => `${context.parsed.y ?? 0} ${this.translate.instant('BILLING_USAGE.UNITS')}`,
          },
        },
      },
      scales: {
        x: {
          grid: {
            display: false,
          },
          ticks: {
            color: '#94a3b8',
          },
        },
        y: {
          beginAtZero: true,
          grid: {
            color: 'rgba(148, 163, 184, 0.18)',
          },
          ticks: {
            color: '#94a3b8',
          },
        },
      },
    }
  }
}
