import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * One plotted day.
 *
 * `credits` is the field the billing payload already uses and `value` is the
 * neutral one, so a second caller (storage reports bytes) does not have to
 * reshape its data into a credit-shaped struct just to draw a bar.
 */
export type ChartPoint = {
  date: string;
  value?: number;
  credits?: number;
};

/** The number a point contributes, whichever field carried it. */
const valueOf = (point: ChartPoint): number => point.value ?? point.credits ?? 0;

/**
 * A value per day, as bars.
 *
 * Why not a chart library
 * -----------------------
 * The repository's only chart is Chart.js in `admin-analytics`, on a canvas. A
 * canvas does not exist during prerender and this component sits on an
 * entitlement page that IS prerendered, so the same choice would have made the
 * chart the one thing that renders empty on first paint. Bars are also the whole
 * job here: one series, one axis, no legend.
 *
 * The input is sparse — a quiet day is absent, not zero — because that is what
 * both sources report. Absent days simply are not drawn, so the axis shows the
 * days the caller actually used the product.
 */
@Component({
  selector: 'app-usage-history-chart',
  templateUrl: './usage-history-chart.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsageHistoryChartComponent {
  /** Days to plot, oldest first. */
  readonly series = input<ReadonlyArray<ChartPoint>>([]);

  /** What the numbers are, for the caption and the accessible label. */
  readonly unit = input<string>('credits');

  /** The tallest day, floored at 1 so a period of all zeros does not divide by it. */
  protected readonly peak = computed(() =>
    Math.max(1, ...this.series().map(valueOf)));

  protected readonly total = computed(() =>
    this.series().reduce((sum, point) => sum + valueOf(point), 0));

  /** The busiest day, for the caption. */
  protected readonly busiest = computed(() => {
    const days = this.series();
    if (!days.length) return null;
    return days.reduce((best, day) => (valueOf(day) > valueOf(best) ? day : best));
  });

  /** Bar height as a percentage of the peak, with a visible floor for a zero day. */
  protected heightOf(point: ChartPoint): number {
    const value = valueOf(point);
    if (value <= 0) return 2;
    return Math.max(6, Math.round((value / this.peak()) * 100));
  }

  protected valueOf(point: ChartPoint): number {
    return valueOf(point);
  }
}
