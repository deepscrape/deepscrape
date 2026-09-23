import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule, DecimalPipe, NgClass } from '@angular/common';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartData } from 'chart.js';
// chart.js v4 has an empty registry until something registers it — see that file's header.
import '../../core/chart-registration';
import { FirestoreService, FirestoreAnalyticsService } from '../../core/services';
import { AnalyticsPeriod, AnalyticsRangeService, RetentionCohort } from '../../core/services/analytics-range.service';
import {
    mapSessionRecordToDisplaySession,
    resolveSessionIdFromRecord,
    getSessionNetworkSummary,
    getSessionProxySummary,
    getSessionRiskLabel,
    getSessionRiskLevel,
    getSessionRiskReason,
    getSessionRiskTone,
} from 'src/app/core/functions';
import { LucideAngularModule } from 'lucide-angular';
import { myIcons } from '../../shared/lucideicons';
import { RouterLink } from '@angular/router';
import { DropdownComponent } from 'src/app/core/components/dropdown/dropdown.component';
import { CheckboxComponent, StinputComponent } from 'src/app/core/components';
import { SessionDisplayInfo } from 'src/app/core/types';
import { firstValueFrom, Subscription } from 'rxjs';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

interface DayActivity {
    date: string;
    logins: number;
    newUsers: number;
    trend: number;
}

interface DailyBreakdownItem {
    date: string;
    totalLogins?: number;
    newGuests?: number;
    /** Unique visitors active in the bucket (falls back to new guests). */
    activeGuests?: number;
    newUsers?: number;
    guestConversions?: number;
    conversionRate?: number;
    /** Human page views in the bucket. */
    pageViews?: number;
    byOS?: Record<string, number>;
    byCountry?: Record<string, number>;
    byBrowser?: Record<string, number>;
    byDevice?: Record<string, number>;
    byTimezone?: Record<string, number>;
    byProvider?: Record<string, number>;
    hour?: number;
}

interface Dashboard {
    totalGuests?: number;
    totalUsers?: number;
    totalLogins?: number;
    guestConversions?: number;
    conversionRate?: number;
    activeUsersNow?: number;
    activeUsers?: number;
    activeGuestsNow?: number;
    activeGuests?: number;
    onlineNow?: number;
    online?: number;
    topProviders?: Record<string, number>;
    topCountries?: Record<string, number>;
    topBrowsers?: Record<string, number>;
    topDevices?: Record<string, number>;
    topOperatingSystems?: Record<string, number>;
    topOS?: Record<string, number>;
    // Raw dimension breakdowns (written by real-time triggers; top* variants only by backfill)
    byCountry?: Record<string, number>;
    byBrowser?: Record<string, number>;
    byDevice?: Record<string, number>;
    byOS?: Record<string, number>;
    byTimezone?: Record<string, number>;
    byProvider?: Record<string, number>;
    byRegion?: Record<string, number>;
    byLanguage?: Record<string, number>;
    byIP?: Record<string, number>;
    byASN?: Record<string, number>;
    byISP?: Record<string, number>;
    byChannel?: Record<string, number>;
    byReferrer?: Record<string, number>;
    byProxyType?: Record<string, number>;
    byAS?: Record<string, number>;
    byUsageType?: Record<string, number>;
    byDomain?: Record<string, number>;
    byThreat?: Record<string, number>;
}

interface RangeMetrics {
    totalGuests?: number;
    newGuests?: number;
    totalUsers?: number;
    newUsers?: number;
    totalLogins?: number;
    logins?: number;
    guestConversions?: number;
    registeredGuests?: number;
    conversions?: number;
    conversionRate?: number;
    activeUsersNow?: number;
    activeUsers?: number;
    activeGuestsNow?: number;
    activeGuests?: number;
    onlineNow?: number;
    online?: number;
    startDate?: string | Date;
    endDate?: string | Date;
    dailyBreakdown?: DailyBreakdownItem[];
    byOS?: Record<string, number>;
    byCountry?: Record<string, number>;
    byBrowser?: Record<string, number>;
    byDevice?: Record<string, number>;
    byTimezone?: Record<string, number>;
    byProvider?: Record<string, number>;
    byRegion?: Record<string, number>;
    byLanguage?: Record<string, number>;
    byIP?: Record<string, number>;
    byASN?: Record<string, number>;
    byISP?: Record<string, number>;
    byChannel?: Record<string, number>;
    byReferrer?: Record<string, number>;
    byProxyType?: Record<string, number>;
    byAS?: Record<string, number>;
    byUsageType?: Record<string, number>;
    byDomain?: Record<string, number>;
    byThreat?: Record<string, number>;
    byBotKind?: Record<string, number>;
    bots?: number;
    funnel?: Record<string, number>;
    clientEvents?: Record<string, number>;
    byPage?: Record<string, number>;
    byLandingPath?: Record<string, number>;
    revenueByCurrency?: Record<string, number>;
    paymentsByCurrency?: Record<string, number>;
    paidByPlan?: Record<string, number>;
    paidByChannel?: Record<string, number>;
    retention?: RetentionCohort[];
}

interface RankRow {
    label: string;
    count: number;
    pct: number;
}

interface FunnelStep {
    label: string;
    count: number;
    pct: number;
}

interface RetentionRow {
    cohort: string;
    size: number;
    /** Retention rate per column (D1/D7/D14/D30); null = window not elapsed. */
    cells: Array<number | null>;
}

interface RevenueRow {
    currency: string;
    /** Major units (amountMinor / 100). */
    amount: number;
    payments: number;
    arpu: number;
}

interface DimensionPanel {
    title: string;
    accent: string;
    rows: RankRow[];
}

/**
 * `AnalyticsPeriod` is imported from the range service rather than redeclared: the
 * local copy drifted, so the service supported `last-5m`/`last-3d` while the picker
 * could not offer them.
 */
type AnalyticsSection = 'content' | 'payments' | 'platform';

/** Nightly snapshot from `metrics_billing/current` — state, not a period aggregate. */
interface BillingMetricsView {
    payingAccounts: number;
    activeTrials: number;
    pastDueAccounts: number;
    mrrEur: number;
    trialPipelineEur: number;
}

@Component({
    selector: 'app-admin-analytics',
    imports: [BaseChartDirective, DecimalPipe, NgClass, LucideAngularModule, RouterLink, ReactiveFormsModule, DropdownComponent, TranslateModule, StinputComponent, CheckboxComponent],
    templateUrl: './admin-analytics.component.html',
    styleUrls: ['./admin-analytics.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class AdminAnalyticsComponent implements OnInit, OnDestroy {
    private firestoreService = inject(FirestoreService);
    private analyticsRangeService = inject(AnalyticsRangeService);
    private firestoreAnalyticsService = inject(FirestoreAnalyticsService);
    private cdr = inject(ChangeDetectorRef);
    private translate = inject(TranslateService);

    // Data properties
    loading = true;
    error: string | null = null;
    guestCount = 0;
    registeredGuestsCount = 0;
    unregisteredGuestsCount = 0;
    userCount = 0;
    activeUsersNow = 0;
    activeGuestsNow = 0;
    onlineNow = 0;
    // Consent decisions (aggregate) and the consent-blind request level, published by
    // `computeActiveUsersNow`. These are the only tiles a visitor who declined appears in.
    consentGrantedToday = 0;
    consentDeclinedToday = 0;
    requestsToday = 0;
    botsToday = 0;
    /** Seconds since the per-minute job last wrote the summary; null until the first snapshot. */
    summaryAgeSeconds: number | null = null;
    totalLogins = 0;
    conversionRate = 0;
    guestConversionRate = 0;
    recentActivity: DayActivity[] = [];
    Math = Math;
    readonly icons = myIcons;
    trafficPanels: DimensionPanel[] = [];
    paymentPanels: DimensionPanel[] = [];
    /** Billing state for the payments tab; null until the snapshot read resolves. */
    billingMetrics: BillingMetricsView | null = null;
    planMixEntries: Array<[string, number]> = [];
    readonly sectionTabs: Array<{ id: AnalyticsSection; label: string }> = [
        { id: 'content', label: 'ADMIN_ANALYTICS.SECTION_CONTENT' },
        { id: 'payments', label: 'ADMIN_ANALYTICS.SECTION_PAYMENTS' },
        { id: 'platform', label: 'ADMIN_ANALYTICS.SECTION_PLATFORM' },
    ];
    activeSection = signal<AnalyticsSection>('content');
    // Always five steps so the template can index them before data lands.
    funnelSteps: FunnelStep[] = [
        { label: 'ADMIN_ANALYTICS.FUNNEL_STEP_VISITORS', count: 0, pct: 100 },
        { label: 'ADMIN_ANALYTICS.FUNNEL_STEP_SIGNUPS', count: 0, pct: 0 },
        { label: 'ADMIN_ANALYTICS.FUNNEL_STEP_LOGINS', count: 0, pct: 0 },
        { label: 'ADMIN_ANALYTICS.FUNNEL_STEP_ACTIVATED', count: 0, pct: 0 },
        { label: 'ADMIN_ANALYTICS.FUNNEL_STEP_PAID', count: 0, pct: 0 },
    ];
    retentionRows: RetentionRow[] = [];
    revenueRows: RevenueRow[] = [];
    botTrafficCount = 0;
    botSharePct = 0;
    displayPeriodDays = 7;
    // ponytail: string controls — StinputComponent is FormControl<string>; the limit is
    // parsed with Number() at call time.
    readonly adminSessionTargetUserId = new FormControl('', { nonNullable: true });
    adminSessionsLoading = false;
    adminSessionsError: string | null = null;
    readonly adminSessionLimit = new FormControl('25', { nonNullable: true, validators: [Validators.min(1), Validators.max(200)] });
    readonly adminActiveOnly = new FormControl(true, { nonNullable: true });
    adminSessions: SessionDisplayInfo[] = [];
    revokingAdminSessionId = '';

    // Caching for performance optimization
    private cacheTimestamp: number | null = null;
    private cachedPeriodKey: string | null = null;
    private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
    private cachedDashboard: Dashboard | null = null;
    private cachedRangeMetrics: RangeMetrics | null = null;

    // Real-time tracking
    realtimeIndicator = false;
    showRangeMissingBanner = false;
    private realtimeSubscriptions: Subscription[] = [];

    // Filter state
    selectedPeriod: AnalyticsPeriod = 'last-7d';
    readonly periodControl = new FormControl<{ name: string; code: AnalyticsPeriod }>({
        name: 'ADMIN_ANALYTICS1.P_7D',
        code: 'last-7d'
    }, { nonNullable: true });
    readonly customStartDate = new FormControl(this.getDateOffset(-7), { nonNullable: true });
    readonly customEndDate = new FormControl(this.getDateOffset(0), { nonNullable: true });
    readonly periodOptions: Array<{ value: AnalyticsPeriod; label: string }> = [
        { value: 'last-5m', label: 'ADMIN_ANALYTICS.RANGE_LAST_5M' },
        { value: 'last-30m', label: 'ADMIN_ANALYTICS.RANGE_LAST_30M' },
        { value: 'last-1h', label: 'ADMIN_ANALYTICS.RANGE_LAST_1H' },
        { value: 'last-3h', label: 'ADMIN_ANALYTICS.RANGE_LAST_3H' },
        { value: 'last-24h', label: 'ADMIN_ANALYTICS.RANGE_LAST_24H' },
        { value: 'last-3d', label: 'ADMIN_ANALYTICS.RANGE_LAST_3D' },
        { value: 'last-7d', label: 'ADMIN_ANALYTICS1.P_7D' },
        { value: 'last-30d', label: 'ADMIN_ANALYTICS1.P_30D' },
        { value: 'last-90d', label: 'ADMIN_ANALYTICS1.P_90D' },
        { value: 'custom', label: 'ADMIN_ANALYTICS.RANGE_CUSTOM' },
    ];
    readonly periodDropdownOptions: Array<{ name: string; code: AnalyticsPeriod }> = this.periodOptions.map(option => ({
        name: option.label,
        code: option.value,
    }));

    // Line Chart Configuration
    public lineChartData: ChartData<'line'> = {
        labels: [],
        datasets: [{
            label: this.translate.instant('ADMIN_ANALYTICS.TH_LOGINS'),
            data: [],
            borderColor: '#0F766E',
            backgroundColor: 'rgba(15, 118, 110, 0.12)',
            fill: true,
            tension: 0.4
        }]
    };
    public lineChartOptions: ChartConfiguration<'line'>['options'] = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: { mode: 'index', intersect: false }
        },
        scales: {
            y: { beginAtZero: true, grid: { color: 'rgba(0, 0, 0, 0.05)' } },
            x: { grid: { display: false } }
        }
    }; public lineChartType = 'line' as const;

    // Bar Chart Configuration
    public barChartData: ChartData<'bar'> = {
        labels: [],
        datasets: [
            {
                label: this.translate.instant('ADMIN_ANALYTICS.DS_GUESTS'),
                data: [],
                backgroundColor: '#10B981'
            },
            {
                label: this.translate.instant('ADMIN_ANALYTICS.DS_AUTHENTICATED'),
                data: [],
                backgroundColor: '#66BB6A'
            }
        ]
    };
    public barChartOptions: ChartConfiguration<'bar'>['options'] = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'top' } },
        scales: {
            y: { beginAtZero: true, stacked: true, grid: { color: 'rgba(0, 0, 0, 0.05)' } },
            x: { stacked: true, grid: { display: false } }
        }
    }; public barChartType = 'bar' as const;

    // Pie Chart Configuration
    public pieChartData: ChartData<'pie'> = {
        labels: [this.translate.instant('ADMIN_ANALYTICS.DS_GUESTS'), this.translate.instant('ADMIN_ANALYTICS.DS_AUTH_USERS')],
        datasets: [{
            data: [0, 0],
            backgroundColor: ['#10B981', '#66BB6A'],
            borderWidth: 2,
            borderColor: '#fff'
        }]
    };
    public pieChartOptions: ChartConfiguration<'pie'>['options'] = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } }
    }; public pieChartType = 'pie' as const;

    // Doughnut Chart Configuration
    public doughnutChartData: ChartData<'doughnut'> = {
        labels: ['Email/Password', 'Google', 'GitHub', 'Phone'],
        datasets: [{
            data: [45, 30, 20, 5],
            backgroundColor: ['#0F766E', '#EC4899', '#F59E0B', '#10B981'],
            borderWidth: 2,
            borderColor: '#fff'
        }]
    };
    public doughnutChartOptions: ChartConfiguration<'doughnut'>['options'] = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } }
    }; public doughnutChartType = 'doughnut' as const;

    // Radar Chart Configuration
    public radarChartData: ChartData<'radar'> = {
        labels: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00'],
        datasets: [{
            label: this.translate.instant('ADMIN_ANALYTICS.DS_ACTIVITY'),
            data: [10, 5, 25, 40, 35, 20],
            backgroundColor: 'rgba(15, 118, 110, 0.2)',
            borderColor: '#0F766E',
            pointBackgroundColor: '#0F766E',
            pointBorderColor: '#fff',
            pointHoverBackgroundColor: '#fff',
            pointHoverBorderColor: '#0F766E'
        }]
    };
    public radarChartOptions: ChartConfiguration<'radar'>['options'] = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            r: { beginAtZero: true, grid: { color: 'rgba(0, 0, 0, 0.05)' } }
        }
    }; public radarChartType = 'radar' as const;

    // NEW GUEST ANALYTICS CHARTS

    // Guest Conversion Chart (Registered vs Unregistered)
    public guestConversionChartData: ChartData<'doughnut'> = {
        labels: [this.translate.instant('ADMIN_ANALYTICS.DS_REGISTERED'), this.translate.instant('ADMIN_ANALYTICS.DS_UNREGISTERED')],
        datasets: [{
            data: [0, 0],
            backgroundColor: ['#10B981', '#EF4444'],
            borderWidth: 2,
            borderColor: '#fff'
        }]
    };
    public guestConversionChartOptions: ChartConfiguration<'doughnut'>['options'] = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { position: 'bottom' },
            tooltip: {
                callbacks: {
                    label: (context) => {
                        const label = context.label || '';
                        const value = context.parsed || 0;
                        const total = context.dataset.data.reduce((a: number | string, b: number | string) => Number(a) + Number(b), 0);
                        const percentage = ((value / total) * 100).toFixed(1);
                        return `${label}: ${value} (${percentage}%)`;
                    }
                }
            }
        }
    };
    public guestConversionChartType = 'doughnut' as const;

    // Guest by Country Chart (Top 10)
    public guestCountryChartData: ChartData<'bar'> = {
        labels: [],
        datasets: [{
            label: this.translate.instant('ADMIN_ANALYTICS.DS_GUESTS_BY_COUNTRY'),
            data: [],
            backgroundColor: '#14B8A6',
            borderRadius: 6
        }]
    };
    public guestCountryChartOptions: ChartConfiguration<'bar'>['options'] = {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
            x: { beginAtZero: true, grid: { color: 'rgba(0, 0, 0, 0.05)' } },
            y: { grid: { display: false } }
        }
    };
    public guestCountryChartType = 'bar' as const;

    // Guest by Browser Chart
    public guestBrowserChartData: ChartData<'pie'> = {
        labels: [],
        datasets: [{
            data: [],
            backgroundColor: ['#14B8A6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'],
            borderWidth: 2,
            borderColor: '#fff'
        }]
    };
    public guestBrowserChartOptions: ChartConfiguration<'pie'>['options'] = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right' } }
    };
    public guestBrowserChartType = 'pie' as const;

    // Guest by Device Chart
    public guestDeviceChartData: ChartData<'doughnut'> = {
        labels: [],
        datasets: [{
            data: [],
            backgroundColor: ['#0F766E', '#EC4899', '#10B981', '#F59E0B'],
            borderWidth: 2,
            borderColor: '#fff'
        }]
    };
    public guestDeviceChartOptions: ChartConfiguration<'doughnut'>['options'] = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } }
    };
    public guestDeviceChartType = 'doughnut' as const;

    // Guest by OS Chart
    public guestOSChartData: ChartData<'bar'> = {
        labels: [],
        datasets: [{
            label: this.translate.instant('ADMIN_ANALYTICS.CH_OS'),
            data: [],
            backgroundColor: '#8B5CF6',
            borderRadius: 6
        }]
    };
    public guestOSChartOptions: ChartConfiguration<'bar'>['options'] = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            y: { beginAtZero: true, grid: { color: 'rgba(0, 0, 0, 0.05)' } },
            x: { grid: { display: false } }
        }
    };
    public guestOSChartType = 'bar' as const;

    // Guest by Timezone Chart
    public guestTimezoneChartData: ChartData<'bar'> = {
        labels: [],
        datasets: [{
            label: this.translate.instant('ADMIN_ANALYTICS.DS_TIMEZONES'),
            data: [],
            backgroundColor: '#22C55E',
            borderRadius: 6
        }]
    };
    public guestTimezoneChartOptions: ChartConfiguration<'bar'>['options'] = {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
            x: { beginAtZero: true, grid: { color: 'rgba(0, 0, 0, 0.05)' } },
            y: { grid: { display: false } }
        }
    };
    public guestTimezoneChartType = 'bar' as const;

    // ✨ NEW: Region Distribution (horizontal bar)
    public regionChartData: ChartData<'bar'> = {
        labels: [],
        datasets: [{
            label: this.translate.instant('ADMIN_ANALYTICS.DS_GUESTS_BY_REGION'),
            data: [],
            backgroundColor: '#06B6D4',
            borderRadius: 6
        }]
    };
    public regionChartOptions: ChartConfiguration<'bar'>['options'] = {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
            x: { beginAtZero: true, grid: { color: 'rgba(0, 0, 0, 0.05)' } },
            y: { grid: { display: false } }
        }
    };
    public regionChartType = 'bar' as const;

    // ✨ NEW: Language Distribution (pie)
    public languageChartData: ChartData<'pie'> = {
        labels: [],
        datasets: [{
            data: [],
            backgroundColor: ['#06B6D4', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#3B82F6', '#84CC16'],
            borderWidth: 2,
            borderColor: '#fff'
        }]
    };
    public languageChartOptions: ChartConfiguration<'pie'>['options'] = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right' } }
    };
    public languageChartType = 'pie' as const;

    // ✨ NEW: Top IP Addresses (horizontal bar)
    public topIPsChartData: ChartData<'bar'> = {
        labels: [],
        datasets: [{
            label: this.translate.instant('ADMIN_ANALYTICS.DS_CONNECTIONS'),
            data: [],
            backgroundColor: '#F43F5E',
            borderRadius: 6
        }]
    };
    public topIPsChartOptions: ChartConfiguration<'bar'>['options'] = {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
            x: { beginAtZero: true, grid: { color: 'rgba(0, 0, 0, 0.05)' } },
            y: { grid: { display: false } }
        }
    };
    public topIPsChartType = 'bar' as const;

    // Guest Activity Over Time
    public guestActivityChartData: ChartData<'line'> = {
        labels: [],
        datasets: [{
            label: this.translate.instant('ADMIN_ANALYTICS.DS_NEW_GUESTS'),
            data: [],
            borderColor: '#10B981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            fill: true,
            tension: 0.4
        }]
    };
    public guestActivityChartOptions: ChartConfiguration<'line'>['options'] = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: { mode: 'index', intersect: false }
        },
        scales: {
            y: { beginAtZero: true, grid: { color: 'rgba(0, 0, 0, 0.05)' } },
            x: { grid: { display: false } }
        }
    };
    public guestActivityChartType = 'line' as const;

    // ponytail: top-15 ranked lists beat one mixed chart for six different-cardinality dimensions.
    private buildDimensionPanel(title: string, accent: string, source: unknown, fallback: string): DimensionPanel {
        const entries = this.getTopDimensionEntries(source, 15, fallback);
        const total = entries.reduce((sum, [, count]) => sum + count, 0);
        const rows: RankRow[] = entries.map(([label, count]) => ({
            label,
            count,
            pct: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
        }));
        return { title, accent, rows };
    }

    private refreshTrafficPanels(dashboard: Dashboard, rangeMetrics: RangeMetrics): void {
        const has = (value?: Record<string, number>): value is Record<string, number> =>
            !!value && Object.keys(value).length > 0;

        this.trafficPanels = [
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_REGION', '#06B6D4',
                has(rangeMetrics?.byRegion) ? rangeMetrics.byRegion : dashboard.byRegion, 'Unknown Region'),
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_AS', '#A78BFA',
                has(rangeMetrics?.byAS) ? rangeMetrics.byAS : dashboard.byAS, 'Unknown AS'),
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_USAGE_TYPE', '#64748B',
                has(rangeMetrics?.byUsageType) ? rangeMetrics.byUsageType : dashboard.byUsageType, 'Unknown usage type'),
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_COUNTRY', '#14B8A6',
                has(rangeMetrics?.byCountry) ? rangeMetrics.byCountry : (has(dashboard.topCountries) ? dashboard.topCountries : dashboard.byCountry), 'Unknown Country'),
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_DEVICE', '#0F766E',
                has(rangeMetrics?.byDevice) ? rangeMetrics.byDevice : (has(dashboard.topDevices) ? dashboard.topDevices : dashboard.byDevice), 'Unknown Device'),
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_BROWSER', '#F59E0B',
                has(rangeMetrics?.byBrowser) ? rangeMetrics.byBrowser : (has(dashboard.topBrowsers) ? dashboard.topBrowsers : dashboard.byBrowser), 'Unknown Browser'),
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_CHANNEL', '#22C55E',
                has(rangeMetrics?.byChannel) ? rangeMetrics.byChannel : dashboard.byChannel, 'direct'),
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_REFERRER', '#3B82F6',
                has(rangeMetrics?.byReferrer) ? rangeMetrics.byReferrer : dashboard.byReferrer, 'direct'),
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_PROXY', '#EF4444',
                has(rangeMetrics?.byProxyType) ? rangeMetrics.byProxyType : dashboard.byProxyType, 'direct'),
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_THREAT', '#991B1B',
                has(rangeMetrics?.byThreat) ? rangeMetrics.byThreat : dashboard.byThreat, 'Unknown'),
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_BOT', '#A855F7',
                has(rangeMetrics?.byBotKind) ? rangeMetrics.byBotKind : null, 'bot'),
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_PAGE', '#0EA5E9',
                has(rangeMetrics?.byPage) ? rangeMetrics.byPage : null, '/'),
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_ENTRY', '#D946EF',
                has(rangeMetrics?.byLandingPath) ? rangeMetrics.byLandingPath : null, 'direct'),
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_CLIENT_EVENT', '#CA8A04',
                has(rangeMetrics?.clientEvents) ? rangeMetrics.clientEvents : null, 'unknown'),
        ];

        // Rose accents for money, per the repo theme guidance for new UI.
        this.paymentPanels = [
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_PAID_CHANNEL', '#E11D48',
                has(rangeMetrics?.paidByChannel) ? rangeMetrics.paidByChannel : null, 'direct'),
            this.buildDimensionPanel('ADMIN_ANALYTICS.PANEL_PAID_PLAN', '#BE123C',
                has(rangeMetrics?.paidByPlan) ? rangeMetrics.paidByPlan : null, 'unknown'),
        ];
    }

    setSection(section: AnalyticsSection): void {
        this.activeSection.set(section);
        this.renderNow();
    }

    /**
     * Bot-free funnel straight off `metrics_daily.funnel.*` (written by the realtime
     * triggers). Falls back to the coarser dashboard counters when a range doc has
     * not been recomputed since the facts layer shipped, so the card never goes blank.
     */
    private refreshFunnel(rangeMetrics: RangeMetrics): void {
        const funnel = rangeMetrics?.funnel || {};
        const visitors = Number(funnel['guest_created'] || rangeMetrics?.newGuests || 0);
        const signups = Number(funnel['user_registered'] || rangeMetrics?.newUsers || 0);
        const logins = Number(funnel['login_succeeded'] || rangeMetrics?.totalLogins || 0);
        // Client-stream steps count events, not unique people — the server facts above do.
        const activated = Number(rangeMetrics?.clientEvents?.['crawl_completed'] || 0);
        const paid = Object.values(rangeMetrics?.paymentsByCurrency || {})
            .reduce((sum, count) => sum + Number(count || 0), 0);
        const bots = Number(rangeMetrics?.bots || 0);
        const base = visitors || 1;
        const rate = (value: number): number => Math.round((value / base) * 1000) / 10;

        this.funnelSteps[0].count = visitors;
        this.funnelSteps[1].count = signups;
        this.funnelSteps[1].pct = rate(signups);
        this.funnelSteps[2].count = logins;
        this.funnelSteps[2].pct = rate(logins);
        this.funnelSteps[3].count = activated;
        this.funnelSteps[3].pct = rate(activated);
        this.funnelSteps[4].count = paid;
        this.funnelSteps[4].pct = rate(paid);

        this.botTrafficCount = bots;
        // Bots never enter `funnel.guest_created`, so the two sets are disjoint.
        this.botSharePct = visitors + bots > 0
            ? Math.round((bots / (visitors + bots)) * 1000) / 10
            : 0;
    }

    /** Amounts arrive in minor units, per currency — summing currencies would be wrong. */
    private refreshRevenue(rangeMetrics: RangeMetrics): void {
        const payments = rangeMetrics?.paymentsByCurrency || {};
        this.revenueRows = Object.entries(rangeMetrics?.revenueByCurrency || {})
            .map(([currency, amountMinor]) => {
                const amount = Number(amountMinor || 0) / 100;
                const count = Number(payments[currency] || 0);
                return { currency, amount, payments: count, arpu: count > 0 ? amount / count : 0 };
            })
            .sort((a, b) => b.amount - a.amount);
    }

    /**
     * Read the nightly billing snapshot (`metrics_billing/current`). Fired separately
     * from the range load so a missing snapshot can never blank the traffic dashboard.
     */
    private async loadBillingMetrics(): Promise<void> {
        try {
            const snapshot = await this.analyticsRangeService.getBillingMetrics();
            if (!snapshot) {
                return;
            }

            this.billingMetrics = {
                payingAccounts: Number(snapshot['payingAccounts'] || 0),
                activeTrials: Number(snapshot['activeTrials'] || 0),
                pastDueAccounts: Number(snapshot['pastDueAccounts'] || 0),
                mrrEur: Number(snapshot['mrrEur'] || 0),
                trialPipelineEur: Number(snapshot['trialPipelineEur'] || 0),
            };
            this.planMixEntries = Object.entries((snapshot['planMix'] || {}) as Record<string, number>)
                .map(([plan, count]) => [plan, Number(count || 0)] as [string, number])
                .sort((a, b) => b[1] - a[1]);
            this.renderNow();
        } catch (error) {
            console.warn('Billing metrics unavailable:', error);
        }
    }

    private refreshRetention(rangeMetrics: RangeMetrics): void {
        this.retentionRows = (rangeMetrics?.retention || []).map((row: RetentionCohort) => {
            const size = Number(row.size || 0);
            return {
                cohort: row.cohort,
                size,
                cells: [row.d1, row.d7, row.d14, row.d30].map((value) =>
                    value === null || value === undefined || size === 0
                        ? null
                        : Math.round((Number(value) / size) * 1000) / 10,
                ),
            };
        });
    }

    get selectedPeriodLabel(): string {
        return this.periodOptions.find(option => option.value === this.selectedPeriod)?.label ?? 'ADMIN_ANALYTICS.SELECTED_PERIOD';
    }

    ngOnInit(): void {
        void this.initializeAnalytics();
        this.setupRealtimeSubscriptions();
    }

    ngOnDestroy(): void {
        this.teardownRealtimeSubscriptions();
    }

    private async initializeAnalytics(): Promise<void> {
        this.loading = true;
        this.error = null;
        try {
            await this.loadAnalyticsData();
        } catch (err) {
            this.error = this.translate.instant('ADMIN_ANALYTICS.ERR_LOAD_DATA');
            console.error(err);
        } finally {
            this.loading = false;
            this.renderNow();
        }
    }

    onPeriodSelected(option: { name: string; code: AnalyticsPeriod }): void {
        this.selectedPeriod = option.code;
        this.onPeriodChanged();
    }

    async loadAnalyticsData(forceRefresh = false) {
        const now = Date.now();
        const periodKey = this.getPeriodCacheKey();
        
        // Return cached data if still fresh
        if (!forceRefresh && this.isCacheValid(now) && this.cachedPeriodKey === periodKey) {
            console.log('✅ Using cached analytics data');
            if (this.cachedDashboard && this.cachedRangeMetrics) {
                this.updateChartsFromOptimizedData(this.cachedDashboard, this.cachedRangeMetrics);
            }
            return;
        }

        // Independent reads: start the period metrics alongside the summary instead of
        // paying two round trips in series on the dashboard's critical path.
        const rangeMetricsPromise = this.resolveMetricsForSelectedPeriod();

        // ✅ OPTIMIZED: Fetch pre-aggregated dashboard summary (1 read instead of 3+)
        const dashboardSummary = await this.analyticsRangeService.getDashboardSummary();

        if (!dashboardSummary) {
            console.warn('⚠️ Dashboard summary not available, falling back to legacy queries');
            return this.loadAnalyticsDataLegacy();
        }

        // Extract metrics from single document
        this.guestCount = dashboardSummary.totalGuests || 0;
        this.userCount = dashboardSummary.totalUsers || 0;
        this.activeUsersNow = dashboardSummary.activeUsersNow || 0;
        this.activeGuestsNow = dashboardSummary.activeGuestsNow || 0;
        this.onlineNow = dashboardSummary.onlineNow || (this.activeUsersNow + this.activeGuestsNow);
        this.consentGrantedToday = dashboardSummary.consentGrantedToday || 0;
        this.consentDeclinedToday = dashboardSummary.consentDeclinedToday || 0;
        this.requestsToday = dashboardSummary.requestsToday || 0;
        this.totalLogins = dashboardSummary.totalLogins || 0;
        this.conversionRate = dashboardSummary.conversionRate || 0;
        
        // Guest conversion metrics
        this.registeredGuestsCount = dashboardSummary.guestConversions || 0;
        this.unregisteredGuestsCount = this.guestCount - this.registeredGuestsCount;
        this.guestConversionRate = this.guestCount > 0
            ? Math.round((this.registeredGuestsCount / this.guestCount) * 10000) / 100
            : 0;

        // Time-series data for charts based on selected period (already in flight)
        const rangeMetrics = await rangeMetricsPromise;

        // Track whether pre-computed range data was available (for info banner)
        // Periods answered by a computed series (`metrics_minutely`/`metrics_hourly`/3 days of
        // `metrics_daily`) instead of a precomputed `metrics_range` document — a null result
        // there is not a missing range doc, so it must not raise the banner.
        const computedPeriods: AnalyticsPeriod[] = [
            'last-5m', 'last-30m', 'last-1h', 'last-3h', 'last-24h', 'last-3d',
        ];
        this.showRangeMissingBanner = !rangeMetrics && !computedPeriods.includes(this.selectedPeriod);

        if (rangeMetrics) {
            this.totalLogins = rangeMetrics.totalLogins ?? this.totalLogins;
            this.conversionRate = rangeMetrics.conversionRate ?? this.conversionRate;
        }
        
        // Update cache
        this.cachedDashboard = dashboardSummary;
        this.cachedRangeMetrics = rangeMetrics;
        this.cacheTimestamp = now;
        this.cachedPeriodKey = periodKey;
        
        console.log('✅ Analytics data loaded from optimized backend');
        
        // Update all charts with optimized data
        this.updateChartsFromOptimizedData(dashboardSummary, rangeMetrics);
        this.renderNow();
    }

    async refreshData() {
        this.loading = true;
        this.error = null;
        this.cacheTimestamp = null; // Invalidate cache
        
        try {
            await this.loadAnalyticsData(true);
        } catch (err) {
            this.error = this.translate.instant('ADMIN_ANALYTICS.ERR_REFRESH');
            console.error(err);
        } finally {
            this.loading = false;
            this.renderNow();
        }
    }

    private setupRealtimeSubscriptions(): void {
        // Subscribe to real-time dashboard updates from FirestoreAnalyticsService
        const dashSub = this.firestoreAnalyticsService.watchDashboard().subscribe({
            next: (summary) => {
                if (!summary) { return; }
                // Update live counters without invalidating chart cache
                this.activeUsersNow = summary.activeUsersNow ?? this.activeUsersNow;
                this.activeGuestsNow = summary.activeGuestsNow ?? this.activeGuestsNow;
                this.onlineNow = summary.onlineNow ?? (this.activeUsersNow + this.activeGuestsNow);
                this.consentGrantedToday = summary.consentGrantedToday ?? this.consentGrantedToday;
                this.consentDeclinedToday = summary.consentDeclinedToday ?? this.consentDeclinedToday;
                this.requestsToday = summary.requestsToday ?? this.requestsToday;
                this.botsToday = summary.botsToday ?? this.botsToday;
                // Computed per snapshot rather than published, so freshness costs no write.
                this.summaryAgeSeconds = summary.lastUpdated
                    ? Math.max(0, Math.round((Date.now() - summary.lastUpdated.toMillis()) / 1000))
                    : null;
                this.totalLogins = summary.totalLogins ?? this.totalLogins;

                // Flash real-time indicator
                this.realtimeIndicator = true;
                setTimeout(() => {
                    this.realtimeIndicator = false;
                    this.renderNow();
                }, 2000);

                this.renderNow();
            },
            error: (err) => console.error('Real-time dashboard subscription error:', err),
        });
        this.realtimeSubscriptions.push(dashSub);

        // Subscribe to generic real-time updates stream for live indicator
        const updateSub = this.firestoreAnalyticsService.watchRealtimeUpdates().subscribe({
            next: (update) => {
                if (update) {
                    this.realtimeIndicator = true;
                    setTimeout(() => {
                        this.realtimeIndicator = false;
                        this.renderNow();
                    }, 2000);
                }
            },
            error: (err) => console.error('Real-time update stream error:', err),
        });
        this.realtimeSubscriptions.push(updateSub);
    }

    private teardownRealtimeSubscriptions(): void {
        for (const sub of this.realtimeSubscriptions) {
            sub.unsubscribe();
        }
        this.realtimeSubscriptions = [];
    }

    private renderNow(): void {
        this.cdr.detectChanges();
    }

    async onPeriodChanged() {
        if (this.selectedPeriod !== 'custom') {
            await this.refreshData();
        }
    }

    async applyCustomRange() {
        this.selectedPeriod = 'custom';
        await this.refreshData();
    }

    async loadAdminSessions(): Promise<void> {
        const targetUserId = this.adminSessionTargetUserId.value.trim();
        if (!targetUserId) {
            this.adminSessionsError = this.translate.instant('ADMIN_ANALYTICS.ERR_SESSION_TARGET_REQUIRED');
            this.adminSessions = [];
            this.renderNow();
            return;
        }

        this.adminSessionsLoading = true;
        this.adminSessionsError = null;
        this.renderNow();

        try {
            const response = await firstValueFrom(
                this.analyticsRangeService.getUserLoginSessionsByAdmin(
                    targetUserId,
                    Number(this.adminSessionLimit.value),
                    this.adminActiveOnly.value,
                ),
            );

            const sessions = Array.isArray(response?.sessions) ? response.sessions : [];
            this.adminSessions = sessions.map((s: any) =>
                mapSessionRecordToDisplaySession(s, {
                    defaultUserId: targetUserId,
                    currentSessionId: '',
                }),
            );
        } catch (error) {
            console.error('Failed to load admin sessions:', error);
            this.adminSessions = [];
            this.adminSessionsError = this.translate.instant('ADMIN_ANALYTICS.ERR_SESSIONS_LOAD');
        } finally {
            this.adminSessionsLoading = false;
            this.renderNow();
        }
    }

    async revokeAdminSession(session: SessionDisplayInfo): Promise<void> {
        const loginId = resolveSessionIdFromRecord(session);
        if (!loginId || this.revokingAdminSessionId) {
            return;
        }

        this.revokingAdminSessionId = loginId;
        this.renderNow();

        try {
            await firstValueFrom(
                this.analyticsRangeService.revokeUserLoginSessionByAdmin(
                    loginId,
                    'admin_security_review',
                ),
            );

            await this.loadAdminSessions();
        } catch (error) {
            console.error('Failed to revoke admin session:', error);
            this.adminSessionsError = this.translate.instant('ADMIN_ANALYTICS.ERR_SESSION_REVOKE');
        } finally {
            this.revokingAdminSessionId = '';
            this.renderNow();
        }
    }

    getAdminSessionRiskLevel(session: SessionDisplayInfo): 'pending' | 'low' | 'medium' | 'high' {
        return getSessionRiskLevel(session);
    }

    getAdminSessionRiskTone(session: SessionDisplayInfo): string {
        return getSessionRiskTone(session);
    }

    getAdminSessionRiskLabel(session: SessionDisplayInfo): string {
        return getSessionRiskLabel(session, (k, p) => this.translate.instant(k, p));
    }

    getAdminSessionRiskReason(session: SessionDisplayInfo): string {
        return getSessionRiskReason(session, (k, p) => this.translate.instant(k, p));
    }

    getAdminSessionNetworkSummary(session: SessionDisplayInfo): string {
        return getSessionNetworkSummary(session, (k, p) => this.translate.instant(k, p));
    }

    getAdminSessionProxySummary(session: SessionDisplayInfo): string {
        return getSessionProxySummary(session, (k, p) => this.translate.instant(k, p));
    }

    getAdminDisplayBrowser(session: SessionDisplayInfo): string {
        const explicit = (session.browser || '').trim();
        if (explicit && explicit.toLowerCase() !== 'unknown') {
            return explicit;
        }

        return this.detectBrowserFromUserAgent(session.userAgent || '');
    }

    getAdminDisplayOS(session: SessionDisplayInfo): string {
        const explicit = (session.os || '').trim();
        if (explicit && explicit.toLowerCase() !== 'unknown') {
            return explicit;
        }

        return this.detectOsFromUserAgent(session.userAgent || '');
    }

    canRevokeAdminSession(session: SessionDisplayInfo): boolean {
        const connected = (session as any)?.connected ?? session.active;
        const revokedAt = (session as any)?.revokedAt ?? session.revokedAt;
        const signOutTime = (session as any)?.signOutTime ?? null;
        return connected === true && !revokedAt && !signOutTime;
    }

    formatAdminSessionTimestamp(session: SessionDisplayInfo): string {
        if (session.humanReadableTime && session.humanReadableTime !== 'Unknown time') {
            return session.humanReadableTime;
        }
        return String(session.createdAt ? new Date(session.createdAt).toLocaleString() : this.translate.instant('ADMIN_ANALYTICS.UNKNOWN_TIME'));
    }

    private isCacheValid(now: number): boolean {
        return this.cacheTimestamp !== null &&
               (now - this.cacheTimestamp) < this.CACHE_TTL_MS &&
               this.cachedDashboard !== null;
    }

    private updateChartsFromOptimizedData(dashboard: Dashboard, rangeMetrics: RangeMetrics) {
        this.applyDisplayMetrics(dashboard, rangeMetrics);

        // Extract daily breakdown for time-series charts
        const dailyData = rangeMetrics?.dailyBreakdown || [];
        const labels = dailyData.map((day: DailyBreakdownItem) => {
            const parsed = new Date(day.date);
            if (Number.isNaN(parsed.getTime())) {
                return String(day.date);
            }
            const hasTime = String(day.date).includes('T');
            return parsed.toLocaleDateString('en-US', hasTime ?
                { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } :
                { month: 'short', day: 'numeric' });
        });
        const loginData = dailyData.map((day: DailyBreakdownItem) => day.totalLogins || 0);
        const newGuestsData = dailyData.map((day: DailyBreakdownItem) => day.newGuests || 0);
        const activeGuestsData = dailyData.map((day: DailyBreakdownItem) => day.activeGuests || 0);
        const pageViewsData = dailyData.map((day: DailyBreakdownItem) => day.pageViews || 0);
        const newUsersData = dailyData.map((day: DailyBreakdownItem) => day.newUsers || 0);

        // Update Line Chart - Login Trend
        this.lineChartData = {
            labels: labels,
            datasets: [{
                label: this.translate.instant('ADMIN_ANALYTICS.TH_LOGINS'),
                data: loginData,
                borderColor: '#0F766E',
                backgroundColor: 'rgba(15, 118, 110, 0.12)',
                fill: true,
                tension: 0.4
            }]
        };

        // Update Bar Chart - Guests vs Authenticated
        this.barChartData = {
            labels: labels,
            datasets: [
                {
                    label: this.translate.instant('ADMIN_ANALYTICS.DS_GUESTS'),
                    data: newGuestsData,
                    backgroundColor: '#10B981'
                },
                {
                    label: this.translate.instant('ADMIN_ANALYTICS.DS_AUTHENTICATED'),
                    data: newUsersData,
                    backgroundColor: '#66BB6A'
                }
            ]
        };

        // Update Pie Chart - Total Distribution
        this.pieChartData = {
            labels: [this.translate.instant('ADMIN_ANALYTICS.DS_GUESTS'), this.translate.instant('ADMIN_ANALYTICS.DS_AUTH_USERS')],
            datasets: [{
                data: [this.guestCount, this.userCount],
                backgroundColor: ['#10B981', '#66BB6A'],
                borderWidth: 2,
                borderColor: '#fff'
            }]
        };

        // Login methods (providers)
        // Range metrics have byProvider from scheduled computeRangeMetrics,
        // dashboard.topProviders from backfill, dashboard.byProvider from
        // real-time onLoginEvent trigger. Try each in priority order.
        const providerEntries = this.getTopDimensionEntries(
            (rangeMetrics?.byProvider && Object.keys(rangeMetrics.byProvider).length > 0)
                ? rangeMetrics.byProvider
                : (dashboard.topProviders && Object.keys(dashboard.topProviders).length > 0)
                ? dashboard.topProviders
                : (dashboard.byProvider && Object.keys(dashboard.byProvider).length > 0)
                ? dashboard.byProvider
                : {},
            8,
            'unknown',
        );
        this.doughnutChartData = {
            labels: providerEntries.map(([provider]) => provider),
            datasets: [{
                data: providerEntries.map(([, count]) => count),
                backgroundColor: ['#0F766E', '#EC4899', '#F59E0B', '#10B981', '#14B8A6', '#8B5CF6', '#14B8A6', '#F43F5E'],
                borderWidth: 2,
                borderColor: '#fff'
            }]
        };

        // Guest Conversion Chart
        this.guestConversionChartData = {
            labels: [this.translate.instant('ADMIN_ANALYTICS.DS_REGISTERED'), this.translate.instant('ADMIN_ANALYTICS.DS_UNREGISTERED')],
            datasets: [{
                data: [this.registeredGuestsCount, this.unregisteredGuestsCount],
                backgroundColor: ['#10B981', '#EF4444'],
                borderWidth: 2,
                borderColor: '#fff'
            }]
        };

        // Guest by Country Chart (Top 10 from selected range, fallback to dashboard summary)
        const topCountriesSource =
            rangeMetrics?.byCountry ??
            dashboard.topCountries ??
            dashboard.byCountry ??
            {};
        const topCountries = this.getTopDimensionEntries(topCountriesSource, 10, 'Unknown Country');
        this.guestCountryChartData = {
            labels: topCountries.map(([country]) => country),
            datasets: [{
                label: this.translate.instant('ADMIN_ANALYTICS.DS_GUESTS_BY_COUNTRY'),
                data: topCountries.map(([, count]) => count),
                backgroundColor: '#14B8A6',
                borderRadius: 6
            }]
        };

        // Guest by Browser Chart
        const topBrowsers = this.getTopDimensionEntries(
            rangeMetrics?.byBrowser ?? dashboard.topBrowsers ?? dashboard.byBrowser ?? {},
            10,
            'Unknown Browser',
        );
        this.guestBrowserChartData = {
            labels: topBrowsers.map(([browser]) => browser),
            datasets: [{
                data: topBrowsers.map(([, count]) => count),
                backgroundColor: ['#14B8A6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'],
                borderWidth: 2,
                borderColor: '#fff'
            }]
        };

        // Guest by Device Chart
        const topDevices = this.getTopDimensionEntries(
            rangeMetrics?.byDevice ?? dashboard.topDevices ?? dashboard.byDevice ?? {},
            10,
            'Unknown Device',
        );
        this.guestDeviceChartData = {
            labels: topDevices.map(([device]) => device),
            datasets: [{
                data: topDevices.map(([, count]) => count),
                backgroundColor: ['#0F766E', '#EC4899', '#10B981', '#F59E0B'],
                borderWidth: 2,
                borderColor: '#fff'
            }]
        };

        // Guest by OS Chart (from selected range with dashboard fallback)
        const osSource =
            rangeMetrics?.byOS ??
            dashboard.topOperatingSystems ??
            dashboard.topOS ??
            dashboard.byOS ??
            {};
        const osEntries = this.getTopDimensionEntries(osSource, 10, 'Unknown OS');

        this.guestOSChartData = {
            labels: osEntries.map(([os]) => os),
            datasets: [{
                label: this.translate.instant('ADMIN_ANALYTICS.CH_OS'),
                data: osEntries.map(([, count]) => count),
                backgroundColor: '#8B5CF6',
                borderRadius: 6
            }]
        };

        const timezoneEntries = this.getTopDimensionEntries(
            rangeMetrics?.byTimezone ?? dashboard.byTimezone ?? {},
            10,
            'Unknown Timezone',
        );
        this.guestTimezoneChartData = {
            labels: timezoneEntries.map(([timezone]) => timezone),
            datasets: [{
                label: this.translate.instant('ADMIN_ANALYTICS.DS_TIMEZONES'),
                data: timezoneEntries.map(([, count]) => count),
                backgroundColor: '#22C55E',
                borderRadius: 6,
            }],
        };

        // ✨ NEW: Region Distribution (from range metrics with dashboard fallback)
        const regionEntries = this.getTopDimensionEntries(
            rangeMetrics?.byRegion ?? dashboard.byRegion ?? {},
            10,
            'Unknown Region',
        );
        this.regionChartData = {
            labels: regionEntries.map(([region]) => region),
            datasets: [{
                label: this.translate.instant('ADMIN_ANALYTICS.DS_GUESTS_BY_REGION'),
                data: regionEntries.map(([, count]) => count),
                backgroundColor: '#06B6D4',
                borderRadius: 6,
            }],
        };

        // ✨ NEW: Language Distribution (from range metrics with dashboard fallback)
        const languageEntries = this.getTopDimensionEntries(
            rangeMetrics?.byLanguage ?? dashboard.byLanguage ?? {},
            10,
            'Unknown Language',
        );
        this.languageChartData = {
            labels: languageEntries.map(([lang]) => lang),
            datasets: [{
                data: languageEntries.map(([, count]) => count),
                backgroundColor: ['#06B6D4', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#3B82F6', '#84CC16'],
                borderWidth: 2,
                borderColor: '#fff',
            }],
        };

        // ✨ NEW: Top IP Addresses (from range metrics with dashboard fallback)
        const ipEntries = this.getTopDimensionEntries(
            (rangeMetrics?.byIP && Object.keys(rangeMetrics.byIP).length > 0)
                ? rangeMetrics.byIP
                : (dashboard.byIP && Object.keys(dashboard.byIP).length > 0)
                ? dashboard.byIP
                : {},
            15,
            'Unknown IP',
        );
        this.topIPsChartData = {
            labels: ipEntries.map(([ip]) => ip),
            datasets: [{
                label: this.translate.instant('ADMIN_ANALYTICS.DS_CONNECTIONS'),
                data: ipEntries.map(([, count]) => count),
                backgroundColor: '#F43F5E',
                borderRadius: 6,
            }],
        };

        // Unique visitors vs page views. Both series come off the bucket rows the
        // tiles already read, so the chart itself adds no Firestore reads.
        this.guestActivityChartData = {
            labels: labels,
            datasets: [
                {
                    label: this.translate.instant('ADMIN_ANALYTICS.DS_UNIQUE_VISITORS'),
                    data: activeGuestsData,
                    borderColor: '#10B981',
                    backgroundColor: 'rgba(16, 185, 129, 0.1)',
                    fill: true,
                    tension: 0.4
                },
                {
                    label: this.translate.instant('ADMIN_ANALYTICS.DS_PAGE_VIEWS'),
                    data: pageViewsData,
                    borderColor: '#0EA5E9',
                    backgroundColor: 'rgba(14, 165, 233, 0.08)',
                    fill: false,
                    tension: 0.4
                },
            ]
        };

        // Generate recent activity data
        this.recentActivity = dailyData.slice(-7).map((day: DailyBreakdownItem) => ({
            date: new Date(day.date).toLocaleDateString(),
            logins: day.totalLogins || 0,
            newUsers: day.newUsers || 0,
            trend: day.conversionRate || 0
        }));

        this.refreshTrafficPanels(dashboard, rangeMetrics);
        this.refreshFunnel(rangeMetrics);
        this.refreshRevenue(rangeMetrics);
        this.refreshRetention(rangeMetrics);
        void this.loadBillingMetrics();
        this.renderNow();
    }

    private applyDisplayMetrics(dashboard: Dashboard, rangeMetrics: RangeMetrics): void {
        const dailyBreakdown = Array.isArray(rangeMetrics?.dailyBreakdown) ? rangeMetrics.dailyBreakdown : [];

        const getNumber = (value: unknown): number | null => {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        };

        const firstNumber = (source: Dashboard | RangeMetrics | null, keys: string[]): number | null => {
            if (!source) {
                return null;
            }
            const sourceAsRecord = source as Record<string, unknown>;
            for (const key of keys) {
                const value = getNumber(sourceAsRecord[key]);
                if (value !== null) {
                    return value;
                }
            }
            return null;
        };

        const sumDaily = (key: string): number =>
            dailyBreakdown.reduce((sum: number, row: DailyBreakdownItem) => sum + Number((row as unknown as Record<string, unknown>)?.[key] || 0), 0);

        const periodGuests =
            firstNumber(rangeMetrics, ['totalGuests', 'newGuests'])
            ?? (dailyBreakdown.length > 0 ? sumDaily('newGuests') : null)
            ?? firstNumber(dashboard, ['totalGuests'])
            ?? 0;

        const periodUsers =
            firstNumber(rangeMetrics, ['totalUsers', 'newUsers'])
            ?? (dailyBreakdown.length > 0 ? sumDaily('newUsers') : null)
            ?? firstNumber(dashboard, ['totalUsers'])
            ?? 0;

        const periodLogins =
            firstNumber(rangeMetrics, ['totalLogins', 'logins'])
            ?? (dailyBreakdown.length > 0 ? sumDaily('totalLogins') : null)
            ?? firstNumber(dashboard, ['totalLogins'])
            ?? 0;

        const periodGuestConversions =
            firstNumber(rangeMetrics, ['guestConversions', 'registeredGuests', 'conversions'])
            ?? (dailyBreakdown.length > 0 ? sumDaily('guestConversions') : null)
            ?? firstNumber(dashboard, ['guestConversions'])
            ?? 0;

        this.guestCount = periodGuests;
        this.userCount = periodUsers;
        this.totalLogins = periodLogins;
        this.registeredGuestsCount = periodGuestConversions;
        this.unregisteredGuestsCount = Math.max(periodGuests - periodGuestConversions, 0);
        this.guestConversionRate = periodGuests > 0
            ? Math.round((periodGuestConversions / periodGuests) * 10000) / 100
            : 0;

        const resolvedConversionRate =
            firstNumber(rangeMetrics, ['conversionRate'])
            ?? firstNumber(dashboard, ['conversionRate'])
            ?? (periodGuests > 0 ? Math.round((periodGuestConversions / periodGuests) * 100) : 0);

        this.conversionRate = Number(resolvedConversionRate || 0);

        this.activeUsersNow = Number(
            firstNumber(rangeMetrics, ['activeUsersNow', 'activeUsers'])
            ?? firstNumber(dashboard, ['activeUsersNow', 'activeUsers'])
            ?? 0
        );
        this.activeGuestsNow = Number(
            firstNumber(rangeMetrics, ['activeGuestsNow', 'activeGuests'])
            ?? firstNumber(dashboard, ['activeGuestsNow', 'activeGuests'])
            ?? 0
        );
        this.onlineNow = Number(
            firstNumber(rangeMetrics, ['onlineNow', 'online'])
            ?? firstNumber(dashboard, ['onlineNow', 'online'])
            ?? (this.activeUsersNow + this.activeGuestsNow)
        );
        this.displayPeriodDays = this.resolvePeriodDays(rangeMetrics);
    }

    private resolvePeriodDays(rangeMetrics: RangeMetrics): number {
        const start = new Date(rangeMetrics?.startDate ?? '');
        const end = new Date(rangeMetrics?.endDate ?? '');
        if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
            const ms = Math.max(end.getTime() - start.getTime(), 0);
            return Math.max(1, Math.floor(ms / (24 * 60 * 60 * 1000)) + 1);
        }

        if (this.selectedPeriod === 'last-30d') {
            return 30;
        }
        if (this.selectedPeriod === 'last-90d') {
            return 90;
        }
        if (this.selectedPeriod === 'last-3d') {
            return 3;
        }
        if (this.selectedPeriod === 'last-24h'
            || this.selectedPeriod === 'last-3h'
            || this.selectedPeriod === 'last-1h'
            || this.selectedPeriod === 'last-30m'
            || this.selectedPeriod === 'last-5m') {
            return 1;
        }

        return 7;
    }

    private async resolveMetricsForSelectedPeriod(): Promise<any> {
        return this.analyticsRangeService.resolveRangeMetrics({
            period: this.selectedPeriod,
            customStartDate: this.customStartDate.value,
            customEndDate: this.customEndDate.value,
        });
    }

    private getPeriodCacheKey(): string {
        if (this.selectedPeriod !== 'custom') {
            return this.selectedPeriod;
        }
        return `custom:${this.customStartDate.value}:${this.customEndDate.value}`;
    }

    private getDateOffset(offsetDays: number): string {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() + offsetDays);
        return date.toISOString().slice(0, 10);
    }

    private detectBrowserFromUserAgent(userAgent: string): string {
        const ua = (userAgent || '').toLowerCase();
        if (ua.includes('edg')) return 'Edge';
        if (ua.includes('opr') || ua.includes('opera')) return 'Opera';
        if (ua.includes('firefox')) return 'Firefox';
        if (ua.includes('chrome') && !ua.includes('edg')) return 'Chrome';
        if (ua.includes('safari') && !ua.includes('chrome')) return 'Safari';
        return this.translate.instant('ADMIN_ANALYTICS.UNKNOWN_BROWSER');
    }

    private detectOsFromUserAgent(userAgent: string): string {
        const ua = (userAgent || '').toLowerCase();
        if (ua.includes('windows')) return 'Windows';
        if (ua.includes('mac os') || ua.includes('macintosh')) return 'macOS';
        if (ua.includes('android')) return 'Android';
        if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) return 'iOS';
        if (ua.includes('linux')) return 'Linux';
        return this.translate.instant('ADMIN_ANALYTICS.UNKNOWN_OS');
    }

    /**
     * Legacy fallback method (only used if optimized backend data not available)
     * @deprecated Use loadAnalyticsData() which fetches optimized pre-aggregated data
     */
    private async loadAnalyticsDataLegacy() {
        console.warn('⚠️ Using legacy analytics queries - this is less efficient');
        
        // Fetch comprehensive guest analytics in one call
        const guestAnalytics = await this.firestoreService.getComprehensiveGuestAnalytics();

        if (!guestAnalytics) {
            throw new Error('Failed to load guest analytics');
        }

        // Set guest counts
        this.guestCount = guestAnalytics.total;
        this.registeredGuestsCount = guestAnalytics.registered;
        this.unregisteredGuestsCount = guestAnalytics.unregistered;
        this.guestConversionRate = this.guestCount > 0
            ? Math.round((this.registeredGuestsCount / this.guestCount) * 10000) / 100
            : 0;

        // Fetch user and login data
        this.userCount = await this.firestoreService.getAuthenticatedUserCount();
        const loginCountsByDay = await this.firestoreService.getLoginCountsByDay(7);

        // Calculate metrics
        this.totalLogins = Object.values(loginCountsByDay).reduce((a, b) => a + b, 0);
        this.conversionRate = this.guestCount > 0
            ? Math.round((this.userCount / (this.guestCount + this.userCount)) * 100)
            : 0;

        // Update charts with legacy data structure
        this.updateChartsFromLegacyData(guestAnalytics, loginCountsByDay);
        this.renderNow();
    }

    /**
     * Update charts using legacy data structure
     */
    private updateChartsFromLegacyData(guestAnalytics: Record<string, unknown>, loginCountsByDay: Record<string, unknown>) {
        // Prepare login chart data
        const labels = Object.keys(loginCountsByDay).map(date =>
            new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        );
        const loginData = Object.values(loginCountsByDay);

        // Update Line Chart
        this.lineChartData = {
            labels: labels,
            datasets: [{
                label: this.translate.instant('ADMIN_ANALYTICS.TH_LOGINS'),
                data: loginData as number[],
                borderColor: '#0F766E',
                backgroundColor: 'rgba(15, 118, 110, 0.12)',
                fill: true,
                tension: 0.4
            }]
        };

        // Update Bar Chart
        this.barChartData = {
            labels: labels,
            datasets: [
                {
                    label: this.translate.instant('ADMIN_ANALYTICS.DS_GUESTS'),
                    data: (loginData as number[]).map(val => Math.floor(val * 0.4)),
                    backgroundColor: '#10B981'
                },
                {
                    label: this.translate.instant('ADMIN_ANALYTICS.DS_AUTHENTICATED'),
                    data: (loginData as number[]).map(val => Math.floor(val * 0.6)),
                    backgroundColor: '#66BB6A'
                }
            ]
        };

        // Update Pie Chart
        this.pieChartData = {
            labels: [this.translate.instant('ADMIN_ANALYTICS.DS_GUESTS'), this.translate.instant('ADMIN_ANALYTICS.DS_AUTH_USERS')],
            datasets: [{
                data: [this.guestCount, this.userCount],
                backgroundColor: ['#10B981', '#66BB6A'],
                borderWidth: 2,
                borderColor: '#fff'
            }]
        };

        // Guest Conversion Chart
        this.guestConversionChartData = {
            labels: [this.translate.instant('ADMIN_ANALYTICS.DS_REGISTERED'), this.translate.instant('ADMIN_ANALYTICS.DS_UNREGISTERED')],
            datasets: [{
                data: [this.registeredGuestsCount, this.unregisteredGuestsCount],
                backgroundColor: ['#10B981', '#EF4444'],
                borderWidth: 2,
                borderColor: '#fff'
            }]
        };

        // Guest by Country Chart (Top 10)
        const topCountries = Object.entries((guestAnalytics['byCountry'] as Record<string, number>) || {})
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10);
        this.guestCountryChartData = {
            labels: topCountries.map(([country]) => country),
            datasets: [{
                label: this.translate.instant('ADMIN_ANALYTICS.DS_GUESTS_BY_COUNTRY'),
                data: topCountries.map(([, count]) => count),
                backgroundColor: '#14B8A6',
                borderRadius: 6
            }]
        };

        // Guest by Browser Chart
        const browserEntries = Object.entries((guestAnalytics['byBrowser'] as Record<string, number>) || {});
        this.guestBrowserChartData = {
            labels: browserEntries.map(([browser]) => browser),
            datasets: [{
                data: browserEntries.map(([, count]) => count),
                backgroundColor: ['#14B8A6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'],
                borderWidth: 2,
                borderColor: '#fff'
            }]
        };

        // Guest by Device Chart
        const deviceEntries = Object.entries((guestAnalytics['byDevice'] as Record<string, number>) || {});
        this.guestDeviceChartData = {
            labels: deviceEntries.map(([device]) => device),
            datasets: [{
                data: deviceEntries.map(([, count]) => count),
                backgroundColor: ['#0F766E', '#EC4899', '#10B981', '#F59E0B'],
                borderWidth: 2,
                borderColor: '#fff'
            }]
        };

        // Guest by OS Chart
        const osEntries = this.getTopDimensionEntries(guestAnalytics['byOS'], 10);
        this.guestOSChartData = {
            labels: osEntries.map(([os]) => os),
            datasets: [{
                label: this.translate.instant('ADMIN_ANALYTICS.CH_OS'),
                data: osEntries.map(([, count]) => count),
                backgroundColor: '#8B5CF6',
                borderRadius: 6
            }]
        };

        // Guest Activity Over Time Chart
        const byDayRecord = (guestAnalytics['byDay'] as Record<string, number>) || {};
        const activityDates = Object.keys(byDayRecord).sort().slice(-7);
        this.guestActivityChartData = {
            labels: activityDates.map(date =>
                new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            ),
            datasets: [{
                label: this.translate.instant('ADMIN_ANALYTICS.DS_NEW_GUESTS'),
                data: activityDates.map(date => byDayRecord[date]),
                borderColor: '#10B981',
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                fill: true,
                tension: 0.4
            }]
        };

        // Generate recent activity data
        const dateLabels = Object.keys(loginCountsByDay);
        this.recentActivity = dateLabels.map((date, index) => ({
            date: new Date(date).toLocaleDateString(),
            logins: (loginData as number[])[index] || 0,
            newUsers: Math.floor(((loginData as number[])[index] || 0) * 0.3),
            trend: index > 0 ? Math.round((((loginData as number[])[index] - (loginData as number[])[index - 1]) / (loginData as number[])[index - 1]) * 100) : 0
        }));
    }

    private normalizeDimensionKey(key: unknown, fallback = 'Unknown'): string {
        const normalized = String(key ?? '').trim();
        return normalized.length > 0 ? normalized : fallback;
    }

    /**
     * Aggregates a specific dimension across multiple rows
     * @param rows Array of daily breakdown items
     * @param dimensionKey The key to extract from each row (e.g., 'byOS', 'byCountry')
     * @param fallback Fallback label for missing values
     * @returns Aggregated Record<string, number>
     */
    private aggregateDimension(
        rows: DailyBreakdownItem[],
        dimensionKey: keyof DailyBreakdownItem,
        fallback = 'Unknown'
    ): Record<string, number> {
        const result: Record<string, number> = {};
        for (const row of rows) {
            const dimensionData = row[dimensionKey] as Record<string, number> || {};
            Object.entries(dimensionData).forEach(([k, v]) => {
                const normalized = this.normalizeDimensionKey(k, fallback);
                result[normalized] = (result[normalized] || 0) + Number(v || 0);
            });
        }
        return result;
    }

    private getTopDimensionEntries(source: unknown, max = 10, fallback = 'Unknown'): Array<[string, number]> {
        const merged: Record<string, number> = {};

        if (Array.isArray(source)) {
            source.forEach((entry: {country?: string; browser?: string; device?: string; os?: string; provider?: string; timezone?: string; name?: string; label?: string; count?: number; value?: number}) => {
                const rawKey = entry?.country ?? entry?.browser ?? entry?.device ?? entry?.os ?? entry?.provider ?? entry?.timezone ?? entry?.name ?? entry?.label;
                const key = this.normalizeDimensionKey(rawKey, fallback);
                const count = Number(entry?.count ?? entry?.value ?? 0);
                if (count > 0) {
                    merged[key] = (merged[key] || 0) + count;
                }
            });
        } else {
            Object.entries((source || {}) as Record<string, unknown>).forEach(([rawKey, value]) => {
                const key = this.normalizeDimensionKey(rawKey, fallback);
                const count = Number(value || 0);
                if (count > 0) {
                    merged[key] = (merged[key] || 0) + count;
                }
            });
        }

        const entries = Object.entries(merged)
            .sort(([, a], [, b]) => b - a)
            .slice(0, max);

        if (entries.length > 0) {
            return entries;
        }

        return [[fallback, 0]];
    }
}

