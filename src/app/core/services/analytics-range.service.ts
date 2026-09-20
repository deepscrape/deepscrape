import { Injectable, inject } from '@angular/core'
import { Observable } from 'rxjs'

import { FirestoreService } from './firestore.service'
import { loginHistoryInfo } from '../types'

/**
 * The date the minutely bucket series went live. An empty minutely window before it is a
 * missing backfill; after it, an empty window is genuinely nobody visiting.
 * ponytail: delete alongside the guard in `buildBucketedRangeMetrics`.
 */
const MINUTELY_SERIES_START_MS = Date.UTC(2026, 8, 17)

export type AnalyticsPeriod =
  | 'last-5m'
  | 'last-30m'
  | 'last-1h'
  | 'last-3h'
  | 'last-24h'
  | 'last-3d'
  | 'last-7d'
  | 'last-30d'
  | 'last-90d'
  | 'custom'

export interface AnalyticsRangeRequest {
  period: AnalyticsPeriod
  customStartDate?: string | null
  customEndDate?: string | null
  now?: Date
}

export interface AnalyticsDailyBreakdown {
  date: string
  hour?: number
  /** Set only on minutely rows (the 30m/1h windows). */
  minute?: number
  totalLogins?: number
  newGuests?: number
  newUsers?: number
  guestConversions?: number
  conversionRate?: number
  byOS?: Record<string, number>
  byCountry?: Record<string, number>
  byBrowser?: Record<string, number>
  byDevice?: Record<string, number>
  byTimezone?: Record<string, number>
  byProvider?: Record<string, number>
  byRegion?: Record<string, number>
  byLanguage?: Record<string, number>
  byIP?: Record<string, number>
  byASN?: Record<string, number>
  byISP?: Record<string, number>
  byChannel?: Record<string, number>
  byReferrer?: Record<string, number>
  byProxyType?: Record<string, number>
  byAS?: Record<string, number>
  byUsageType?: Record<string, number>
  byDomain?: Record<string, number>
  byThreat?: Record<string, number>
  /** Bot traffic for the day (excluded from `funnel`). */
  bots?: number
  /** Bot-free funnel counters: `funnel.<event name>`. */
  funnel?: Record<string, number>
  byBotKind?: Record<string, number>
  /** Drained client-side event counts, keyed by event name. */
  clientEvents?: Record<string, number>
  /** Human page views per normalized route path. */
  byPage?: Record<string, number>
  /** Entry page (first-touch landing path) per guest. */
  byLandingPath?: Record<string, number>
  /** Paid amounts in minor units per currency (never summed together). */
  revenueByCurrency?: Record<string, number>
  /** Payment count per currency. */
  paymentsByCurrency?: Record<string, number>
  paidByPlan?: Record<string, number>
  paidByChannel?: Record<string, number>
}

export interface RetentionCohort {
  cohort: string
  size: number
  /** null = that window has not elapsed yet (rendered as “—”, never as 0%). */
  d1?: number | null
  d7?: number | null
  d14?: number | null
  d30?: number | null
}

export interface AnalyticsRangeResult {
  rangeId: string
  startDate: string
  endDate: string
  totalGuests: number
  totalUsers: number
  totalLogins: number
  guestConversions: number
  conversionRate: number
  byOS: Record<string, number>
  byCountry: Record<string, number>
  byBrowser: Record<string, number>
  byDevice: Record<string, number>
  byTimezone: Record<string, number>
  byProvider: Record<string, number>
  byRegion?: Record<string, number>
  byLanguage?: Record<string, number>
  byIP?: Record<string, number>
  byASN?: Record<string, number>
  byISP?: Record<string, number>
  byChannel?: Record<string, number>
  byReferrer?: Record<string, number>
  byProxyType?: Record<string, number>
  byAS?: Record<string, number>
  byUsageType?: Record<string, number>
  byDomain?: Record<string, number>
  byThreat?: Record<string, number>
  /** Bot traffic in the window (excluded from `funnel`). */
  bots?: number
  /** Bot-free funnel counters: `funnel.<event name>`. */
  funnel?: Record<string, number>
  byBotKind?: Record<string, number>
  /** Drained client-side event counts, keyed by event name. */
  clientEvents?: Record<string, number>
  /** Human page views per normalized route path. */
  byPage?: Record<string, number>
  /** Entry page (first-touch landing path) per guest. */
  byLandingPath?: Record<string, number>
  /** Paid amounts in minor units per currency (never summed together). */
  revenueByCurrency?: Record<string, number>
  /** Payment count per currency. */
  paymentsByCurrency?: Record<string, number>
  paidByPlan?: Record<string, number>
  paidByChannel?: Record<string, number>
  /** Cohort retention grid — only on the precomputed 30-day range. */
  retention?: RetentionCohort[]
  dailyBreakdown: AnalyticsDailyBreakdown[]
}

@Injectable({
  providedIn: 'root',
})
export class AnalyticsRangeService {
  private firestoreService = inject(FirestoreService)

  async getDashboardSummary(): Promise<any | null> {
    return this.firestoreService.getDashboardSummary()
  }

  async getRangeMetrics(rangeId: string): Promise<any | null> {
    return this.firestoreService.getRangeMetrics(rangeId)
  }

  /**
   * Nightly billing snapshot: MRR, paying accounts, plan mix, trials, past due.
   * One document read; the range documents deliberately do not carry these numbers
   * because they are state, not a period aggregate.
   */
  async getBillingMetrics(): Promise<any | null> {
    return this.firestoreService.getBillingMetrics()
  }

  async getMetricsByDateRange(startDate: string, endDate: string): Promise<any[]> {
    return this.firestoreService.getMetricsByDateRange(startDate, endDate)
  }

  async getHourlyMetricsByDateTimeRange(startKey: string, endKey: string): Promise<any[]> {
    return this.firestoreService.getHourlyMetricsByDateTimeRange(startKey, endKey)
  }

  getUserLoginSessionsByAdmin(targetUserId: string, limit: number = 50, activeOnly: boolean = false): Observable<{
    success: boolean
    targetUserId: string
    sessions: loginHistoryInfo[]
    total: number
  }> {
    return this.firestoreService.getUserLoginSessionsByAdmin(targetUserId, limit, activeOnly)
  }

  revokeUserLoginSessionByAdmin(loginId: string, reason?: string): Observable<{
    success: boolean
    loginId: string
    targetUserId: string
    revokedAt: string
  }> {
    return this.firestoreService.revokeUserLoginSessionByAdmin(loginId, reason)
  }

  async resolveRangeMetrics(request: AnalyticsRangeRequest): Promise<AnalyticsRangeResult | null> {
    switch (request.period) {
      case 'last-7d':
      case 'last-30d':
      case 'last-90d': {
        const precomputed = await this.firestoreService.getRangeMetrics(request.period)
        // Use pre-computed range doc if available (1 read, fastest path)
        if (precomputed) {
          return this.mapRangeResult(request.period, precomputed)
        }
        // Fallback: compute on-the-fly from metrics_daily so the dashboard
        // never silently shows wrong period data. This is slightly more
        // expensive (N reads for N days) but ensures correctness.
        const days = request.period === 'last-7d' ? 7 : request.period === 'last-30d' ? 30 : 90
        const end = request.now ? new Date(request.now) : new Date()
        const start = new Date(end.getTime() - (days - 1) * 24 * 60 * 60 * 1000)
        const startDate = start.toISOString().slice(0, 10)
        const endDate = end.toISOString().slice(0, 10)
        console.warn(`⚠️ Pre-computed range "${request.period}" not found — computing on-the-fly from ${startDate} to ${endDate}`)
        return this.buildCustomDateRangeMetrics(startDate, endDate)
      }
      case 'last-24h':
        return this.buildBucketedRangeMetrics(24, 'hour', 'last-24h', request.now)
      // Sub-day windows read the minutely series, which is the only grain that can answer
      // a rolling window — an hour bucket can at best mean "this hour so far".
      case 'last-1h':
        return this.buildBucketedRangeMetrics(60, 'minute', 'last-1h', request.now)
      case 'last-30m':
        return this.buildBucketedRangeMetrics(30, 'minute', 'last-30m', request.now)
      // Hour buckets: "last 3h" is 3 aligned hours, same grain the hourly series stores.
      case 'last-3h':
        return this.buildBucketedRangeMetrics(3, 'hour', 'last-3h', request.now)
      case 'last-5m':
        return this.buildBucketedRangeMetrics(5, 'minute', 'last-5m', request.now)
      case 'last-3d': {
        // Three `metrics_daily` documents — cheaper to read than to own a precomputed
        // range doc, and `computeRangeMetrics` only builds 7/30/90.
        const end = request.now ? new Date(request.now) : new Date()
        const start = new Date(end.getTime() - 2 * 24 * 60 * 60 * 1000)
        return this.buildCustomDateRangeMetrics(
          start.toISOString().slice(0, 10),
          end.toISOString().slice(0, 10),
          'last-3d',
        )
      }
      case 'custom':
        return this.buildCustomDateRangeMetrics(request.customStartDate, request.customEndDate)
      default: {
        const fallback = await this.firestoreService.getRangeMetrics('last-7d')
        return this.mapRangeResult('last-7d', fallback)
      }
    }
  }

  private async buildCustomDateRangeMetrics(
    customStartDate?: string | null,
    customEndDate?: string | null,
    rangeId: string = 'custom',
  ): Promise<AnalyticsRangeResult | null> {
    if (!customStartDate || !customEndDate) {
      const fallback = await this.firestoreService.getRangeMetrics('last-7d')
      return this.mapRangeResult('last-7d', fallback)
    }

    const rows = await this.firestoreService.getMetricsByDateRange(customStartDate, customEndDate)
    const sortedRows = [...rows].sort((a: AnalyticsDailyBreakdown, b: AnalyticsDailyBreakdown) =>
      String(a.date || '').localeCompare(String(b.date || '')),
    )

    const byOS: Record<string, number> = {}
    const byCountry: Record<string, number> = {}
    const byBrowser: Record<string, number> = {}
    const byDevice: Record<string, number> = {}
    const byTimezone: Record<string, number> = {}
    const byProvider: Record<string, number> = {}
    const byRegion: Record<string, number> = {}
    const byLanguage: Record<string, number> = {}
    const byIP: Record<string, number> = {}
    const byASN: Record<string, number> = {}
    const byISP: Record<string, number> = {}
    const byChannel: Record<string, number> = {}
    const byReferrer: Record<string, number> = {}
    const byProxyType: Record<string, number> = {}
    const byAS: Record<string, number> = {}
    const byUsageType: Record<string, number> = {}
    const byDomain: Record<string, number> = {}
    const byThreat: Record<string, number> = {}

    let totalGuests = 0
    let totalUsers = 0
    let totalLogins = 0
    let guestConversions = 0
    const botTotals = { bots: 0, funnel: {} as Record<string, number>, byBotKind: {} as Record<string, number> }
    const clientEvents: Record<string, number> = {}
    const byPage: Record<string, number> = {}
    const byLandingPath: Record<string, number> = {}
    const revenueByCurrency: Record<string, number> = {}
    const paymentsByCurrency: Record<string, number> = {}
    const paidByPlan: Record<string, number> = {}
    const paidByChannel: Record<string, number> = {}

    for (const rawRow of sortedRows) {
      const row = this.normalizeDailyBreakdownRow(rawRow)
      totalGuests += Number(row.newGuests || 0)
      totalUsers += Number(row.newUsers || 0)
      totalLogins += Number(row.totalLogins || 0)
      guestConversions += this.toGuestConversions(row.guestConversions)

      this.mergeDimensionCounts(byOS, row.byOS, 'Unknown OS')
      this.mergeDimensionCounts(byCountry, row.byCountry, 'Unknown Country')
      this.mergeDimensionCounts(byBrowser, row.byBrowser, 'Unknown Browser')
      this.mergeDimensionCounts(byDevice, row.byDevice, 'Unknown Device')
      this.mergeDimensionCounts(byTimezone, row.byTimezone, 'Unknown Timezone')
      this.mergeDimensionCounts(byProvider, row.byProvider, 'unknown')
      this.mergeDimensionCounts(byRegion, row.byRegion, 'Unknown Region')
      this.mergeDimensionCounts(byLanguage, row.byLanguage, 'Unknown Language')
      this.mergeDimensionCounts(byIP, row.byIP, 'Unknown IP')
      this.mergeDimensionCounts(byASN, row.byASN, 'Unknown ASN')
      this.mergeDimensionCounts(byISP, row.byISP, 'Unknown ISP')
      this.mergeDimensionCounts(byChannel, row.byChannel, 'direct')
      this.mergeDimensionCounts(byReferrer, row.byReferrer, 'direct')
      this.mergeDimensionCounts(byProxyType, row.byProxyType, 'direct')
      this.mergeDimensionCounts(byAS, row.byAS, 'Unknown AS')
      this.mergeDimensionCounts(byUsageType, row.byUsageType, 'Unknown usage type')
      this.mergeDimensionCounts(byDomain, row.byDomain, 'Unknown domain')
      this.mergeDimensionCounts(byThreat, row.byThreat, 'Unknown')
      this.mergeBotCounts(botTotals, row)
      this.mergeDimensionCounts(clientEvents, row.clientEvents, 'unknown')
      this.mergeDimensionCounts(byPage, row.byPage, '/')
      this.mergeDimensionCounts(byLandingPath, row.byLandingPath, 'direct')
      this.mergeDimensionCounts(revenueByCurrency, row.revenueByCurrency, 'unknown')
      this.mergeDimensionCounts(paymentsByCurrency, row.paymentsByCurrency, 'unknown')
      this.mergeDimensionCounts(paidByPlan, row.paidByPlan, 'unknown')
      this.mergeDimensionCounts(paidByChannel, row.paidByChannel, 'direct')
    }

    return {
      rangeId,
      startDate: customStartDate,
      endDate: customEndDate,
      totalGuests,
      totalUsers,
      totalLogins,
      guestConversions,
      conversionRate: totalGuests > 0 ? Math.round((guestConversions / totalGuests) * 100) : 0,
      byOS,
      byCountry,
      byBrowser,
      byDevice,
      byTimezone,
      byProvider,
      byRegion,
      byLanguage,
      byIP,
      byASN,
      byISP,
      byChannel,
      byReferrer,
      byProxyType,
      byAS,
      byUsageType,
      byDomain,
      byThreat,
      bots: botTotals.bots,
      funnel: botTotals.funnel,
      byBotKind: botTotals.byBotKind,
      clientEvents,
      byPage,
      byLandingPath,
      revenueByCurrency,
      paymentsByCurrency,
      paidByPlan,
      paidByChannel,
      dailyBreakdown: sortedRows.map((row: AnalyticsDailyBreakdown) => ({
        date: String(row.date || ''),
        newGuests: Number(row.newGuests || 0),
        newUsers: Number(row.newUsers || 0),
        totalLogins: Number(row.totalLogins || 0),
        guestConversions: this.toGuestConversions(row.guestConversions),
        conversionRate: Number(row.conversionRate || 0),
      })),
    }
  }

  private async buildBucketedRangeMetrics(
    buckets: number,
    unit: 'hour' | 'minute',
    rangeId: string,
    now?: Date,
  ): Promise<AnalyticsRangeResult> {
    const end = now ? new Date(now) : new Date()
    // Buckets are aligned to their own boundary, so an unaligned window cannot drag in a
    // whole extra one: at 13:10 "last 1h" used to sum the 12:00 AND 13:00 documents (up
    // to two hours of traffic) and "last 24h" covered 25 buckets.
    const stepMs = unit === 'hour' ? 60 * 60 * 1000 : 60 * 1000
    const lastBucket = unit === 'hour' ?
      new Date(Date.UTC(
        end.getUTCFullYear(),
        end.getUTCMonth(),
        end.getUTCDate(),
        end.getUTCHours(),
      )) :
      new Date(Math.floor(end.getTime() / stepMs) * stepMs)
    const start = new Date(lastBucket.getTime() - (buckets - 1) * stepMs)

    const rows = await this.firestoreService.getHourlyMetricsByDateTimeRange(
      this.toDateTimeKey(start, unit),
      this.toDateTimeKey(lastBucket, unit),
      unit === 'hour' ? 'metrics_hourly' : 'metrics_minutely',
    )

    // The minutely series has no history before the deploy that introduced it, so an
    // empty window BEFORE that means "not written yet", not "nobody visited". Bounded by
    // date so a genuinely quiet 5m window still renders 0 rather than an hour of traffic.
    // ponytail: delete this guard (and the constant above) once a day of minutely documents exists.
    if (unit === 'minute' && rows.length === 0 && Date.now() < MINUTELY_SERIES_START_MS) {
      return this.buildBucketedRangeMetrics(1, 'hour', rangeId, now)
    }

    const totalGuests = rows.reduce((sum: number, row: AnalyticsDailyBreakdown) => sum + Number(row.newGuests || 0), 0)
    const totalUsers = rows.reduce((sum: number, row: AnalyticsDailyBreakdown) => sum + Number(row.newUsers || 0), 0)
    const totalLogins = rows.reduce((sum: number, row: AnalyticsDailyBreakdown) => sum + Number(row.totalLogins || 0), 0)
    const guestConversions = rows.reduce((sum: number, row: AnalyticsDailyBreakdown) => sum + this.toGuestConversions(row.guestConversions), 0)

    const byOS: Record<string, number> = {}
    const byCountry: Record<string, number> = {}
    const byBrowser: Record<string, number> = {}
    const byDevice: Record<string, number> = {}
    const byTimezone: Record<string, number> = {}
    const byProvider: Record<string, number> = {}
    const byRegion: Record<string, number> = {}
    const byLanguage: Record<string, number> = {}
    const byIP: Record<string, number> = {}
    const byASN: Record<string, number> = {}
    const byISP: Record<string, number> = {}
    const byChannel: Record<string, number> = {}
    const byReferrer: Record<string, number> = {}
    const byProxyType: Record<string, number> = {}
    const byAS: Record<string, number> = {}
    const byUsageType: Record<string, number> = {}
    const byDomain: Record<string, number> = {}
    const byThreat: Record<string, number> = {}
    const botTotals = { bots: 0, funnel: {} as Record<string, number>, byBotKind: {} as Record<string, number> }
    const clientEvents: Record<string, number> = {}
    const byPage: Record<string, number> = {}
    const byLandingPath: Record<string, number> = {}
    const revenueByCurrency: Record<string, number> = {}
    const paymentsByCurrency: Record<string, number> = {}
    const paidByPlan: Record<string, number> = {}
    const paidByChannel: Record<string, number> = {}

    for (const rawRow of rows) {
      const row = this.normalizeDailyBreakdownRow(rawRow)
      this.mergeDimensionCounts(byOS, row.byOS, 'Unknown OS')
      this.mergeDimensionCounts(byCountry, row.byCountry, 'Unknown Country')
      this.mergeDimensionCounts(byBrowser, row.byBrowser, 'Unknown Browser')
      this.mergeDimensionCounts(byDevice, row.byDevice, 'Unknown Device')
      this.mergeDimensionCounts(byTimezone, row.byTimezone, 'Unknown Timezone')
      this.mergeDimensionCounts(byProvider, row.byProvider, 'unknown')
      this.mergeDimensionCounts(byRegion, row.byRegion, 'Unknown Region')
      this.mergeDimensionCounts(byLanguage, row.byLanguage, 'Unknown Language')
      this.mergeDimensionCounts(byIP, row.byIP, 'Unknown IP')
      this.mergeDimensionCounts(byASN, row.byASN, 'Unknown ASN')
      this.mergeDimensionCounts(byISP, row.byISP, 'Unknown ISP')
      this.mergeDimensionCounts(byChannel, row.byChannel, 'direct')
      this.mergeDimensionCounts(byReferrer, row.byReferrer, 'direct')
      this.mergeDimensionCounts(byProxyType, row.byProxyType, 'direct')
      this.mergeDimensionCounts(byAS, row.byAS, 'Unknown AS')
      this.mergeDimensionCounts(byUsageType, row.byUsageType, 'Unknown usage type')
      this.mergeDimensionCounts(byDomain, row.byDomain, 'Unknown domain')
      this.mergeDimensionCounts(byThreat, row.byThreat, 'Unknown')
      this.mergeBotCounts(botTotals, row)
      this.mergeDimensionCounts(clientEvents, row.clientEvents, 'unknown')
      this.mergeDimensionCounts(byPage, row.byPage, '/')
      this.mergeDimensionCounts(byLandingPath, row.byLandingPath, 'direct')
      this.mergeDimensionCounts(revenueByCurrency, row.revenueByCurrency, 'unknown')
      this.mergeDimensionCounts(paymentsByCurrency, row.paymentsByCurrency, 'unknown')
      this.mergeDimensionCounts(paidByPlan, row.paidByPlan, 'unknown')
      this.mergeDimensionCounts(paidByChannel, row.paidByChannel, 'direct')
    }

    return {
      rangeId,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      totalGuests,
      totalUsers,
      totalLogins,
      guestConversions,
      conversionRate: totalGuests > 0 ? Math.round((guestConversions / totalGuests) * 100) : 0,
      byOS,
      byCountry,
      byBrowser,
      byDevice,
      byTimezone,
      byProvider,
      byRegion,
      byLanguage,
      byIP,
      byASN,
      byISP,
      byChannel,
      byReferrer,
      byProxyType,
      byAS,
      byUsageType,
      byDomain,
      byThreat,
      bots: botTotals.bots,
      funnel: botTotals.funnel,
      byBotKind: botTotals.byBotKind,
      clientEvents,
      byPage,
      byLandingPath,
      revenueByCurrency,
      paymentsByCurrency,
      paidByPlan,
      paidByChannel,
      dailyBreakdown: rows.map((row: AnalyticsDailyBreakdown) => {
        const hour = Number(row.hour ?? 0)
        const minute = Number(row.minute ?? 0)
        const newGuests = Number(row.newGuests || 0)
        const rowGuestConversions = this.toGuestConversions(row.guestConversions)
        const stamp = String(row.date || '') + 'T' + String(hour).padStart(2, '0')
        const point: AnalyticsDailyBreakdown = {
          date: unit === 'minute' ?
            `${stamp}:${String(minute).padStart(2, '0')}:00.000Z` :
            `${stamp}:00:00.000Z`,
          hour,
          newGuests,
          newUsers: Number(row.newUsers || 0),
          totalLogins: Number(row.totalLogins || 0),
          guestConversions: rowGuestConversions,
          conversionRate: newGuests > 0 ? Math.round((rowGuestConversions / newGuests) * 100) : 0,
        }
        if (unit === 'minute') {
          point.minute = minute
        }
        return point
      }),
    }
  }

  private mapRangeResult(rangeId: string, raw: any | null): AnalyticsRangeResult | null {
    if (!raw) {
      return null
    }

    const startDate = String(raw.startDate || '')
    const endDate = String(raw.endDate || '')

    return {
      rangeId,
      startDate,
      endDate,
      totalGuests: Number(raw.totalGuests || raw.newGuests || 0),
      totalUsers: Number(raw.totalUsers || raw.newUsers || 0),
      totalLogins: Number(raw.totalLogins || raw.logins || 0),
      guestConversions: this.toGuestConversions(raw.guestConversions, raw.registeredGuests, raw.conversions),
      conversionRate: Number(raw.conversionRate || 0),
      byOS: this.asNumberMap(raw.byOS),
      byCountry: this.asNumberMap(raw.byCountry),
      byBrowser: this.asNumberMap(raw.byBrowser),
      byDevice: this.asNumberMap(raw.byDevice),
      byTimezone: this.asNumberMap(raw.byTimezone),
      byProvider: this.asNumberMap(raw.byProvider),
      byRegion: this.asNumberMap(raw.byRegion),
      byLanguage: this.asNumberMap(raw.byLanguage),
      byIP: this.asNumberMap(raw.byIP),
      byASN: this.asNumberMap(raw.byASN),
      byISP: this.asNumberMap(raw.byISP),
      byChannel: this.asNumberMap(raw.byChannel),
      byReferrer: this.asNumberMap(raw.byReferrer),
      byProxyType: this.asNumberMap(raw.byProxyType),
      bots: Number(raw.bots || 0),
      funnel: this.asNumberMap(raw.funnel),
      byBotKind: this.asNumberMap(raw.byBotKind),
      clientEvents: this.asNumberMap(raw.clientEvents),
      byPage: this.asNumberMap(raw.byPage),
      byLandingPath: this.asNumberMap(raw.byLandingPath),
      revenueByCurrency: this.asNumberMap(raw.revenueByCurrency),
      paymentsByCurrency: this.asNumberMap(raw.paymentsByCurrency),
      paidByPlan: this.asNumberMap(raw.paidByPlan),
      paidByChannel: this.asNumberMap(raw.paidByChannel),
      retention: Array.isArray(raw.retention)
        ? raw.retention.map((row: RetentionCohort) => ({
            cohort: String(row.cohort || ''),
            size: Number(row.size || 0),
            d1: this.toNullableNumber(row.d1),
            d7: this.toNullableNumber(row.d7),
            d14: this.toNullableNumber(row.d14),
            d30: this.toNullableNumber(row.d30),
          }))
        : undefined,
      dailyBreakdown: Array.isArray(raw.dailyBreakdown)
        ? raw.dailyBreakdown.map((row: AnalyticsDailyBreakdown) => ({
            date: String(row.date || ''),
            hour: typeof row.hour === 'number' ? row.hour : undefined,
            totalLogins: Number(row.totalLogins || 0),
            newGuests: Number(row.newGuests || 0),
            newUsers: Number(row.newUsers || 0),
            guestConversions: Number(row.guestConversions || 0),
            conversionRate: Number(row.conversionRate || 0),
            byOS: this.asNumberMap(row.byOS),
            byCountry: this.asNumberMap(row.byCountry),
            byBrowser: this.asNumberMap(row.byBrowser),
            byDevice: this.asNumberMap(row.byDevice),
            byTimezone: this.asNumberMap(row.byTimezone),
            byProvider: this.asNumberMap(row.byProvider),
            byRegion: this.asNumberMap(row.byRegion),
            byLanguage: this.asNumberMap(row.byLanguage),
            byIP: this.asNumberMap(row.byIP),
          }))
        : [],
    }
  }

  /**
   * Bot traffic + funnel counters are written by the realtime triggers only, so
   * rows from before the facts layer simply contribute zero.
   */
  private mergeBotCounts(
    target: { bots: number, funnel: Record<string, number>, byBotKind: Record<string, number> },
    row: AnalyticsDailyBreakdown,
  ): void {
    target.bots += Number(row.bots || 0)
    this.mergeDimensionCounts(target.funnel, row.funnel, 'Unknown')
    this.mergeDimensionCounts(target.byBotKind, row.byBotKind, 'bot')
  }

  /**
   * `null`/`undefined` must stay null — Number(null) is 0, which would render an
   * un-elapsed retention window as a real 0% drop.
   */
  private toNullableNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
      return null
    }
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  private mergeDimensionCounts(
    target: Record<string, number>,
    source: Record<string, number> | undefined,
    fallback: string,
  ): void {
    for (const [key, value] of Object.entries(source || {})) {
      const normalizedKey = this.normalizeDimensionKey(key, fallback)
      target[normalizedKey] = (target[normalizedKey] || 0) + Number(value || 0)
    }
  }

  // ponytail: realtime writes guestConversions as a number; the old batch aggregator wrote
  // { registered, unregistered }. Coerce both so a stray legacy doc can't NaN the whole chart.
  private toGuestConversions(...values: unknown[]): number {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const registered = Number((value as { registered?: unknown }).registered ?? 0)
        if (Number.isFinite(registered)) {
          return registered
        }
      }
    }
    return 0
  }

  private asNumberMap(source: unknown): Record<string, number> {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(source as Record<string, unknown>).map(([key, value]) => {
        const normalizedKey = this.normalizeDimensionKey(key)
        return [normalizedKey, Number(value || 0)]
      }),
    )
  }

  private normalizeDimensionKey(value: string | undefined, fallback: string = 'Unknown'): string {
    const normalized = String(value || '').trim()
    return normalized || fallback
  }

  /**
   * Build a dimension map from a daily/hourly row that may store breakdowns
   * EITHER as a nested map (byBrowser: { Chrome: n }) OR as flat dotted fields
   * written by the realtime triggers (byBrowser.Chrome: n).
   * ponytail: normalizing at read time fixes both existing flat days and future
   * writes with no migration and no change to the write path.
   */
  private extractDimension(doc: Record<string, unknown> | undefined, prefix: string): Record<string, number> {
    const out: Record<string, number> = {}
    if (!doc) {
      return out
    }

    const nested = doc[prefix]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
        const dim = this.normalizeDimensionKey(k)
        out[dim] = (out[dim] || 0) + Number(v || 0)
      }
    }

    for (const k of Object.keys(doc)) {
      if (k.startsWith(`${prefix}.`)) {
        const dim = this.normalizeDimensionKey(k.slice(prefix.length + 1))
        out[dim] = (out[dim] || 0) + Number(doc[k] || 0)
      }
    }

    return out
  }

  private normalizeDailyBreakdownRow(raw: AnalyticsDailyBreakdown): AnalyticsDailyBreakdown {
    const obj = raw as unknown as Record<string, unknown>
    return {
      ...raw,
      byOS: this.extractDimension(obj, 'byOS'),
      byCountry: this.extractDimension(obj, 'byCountry'),
      byBrowser: this.extractDimension(obj, 'byBrowser'),
      byDevice: this.extractDimension(obj, 'byDevice'),
      byTimezone: this.extractDimension(obj, 'byTimezone'),
      byProvider: this.extractDimension(obj, 'byProvider'),
      byRegion: this.extractDimension(obj, 'byRegion'),
      byLanguage: this.extractDimension(obj, 'byLanguage'),
      byIP: this.extractDimension(obj, 'byIP'),
      // These five are written by the realtime triggers ONLY as flat dotted fields
      // (`byASN.12345`), so without an extraction here `row.byASN` was undefined and
      // every sub-day range rendered those panels empty — 7d/30d/90d were fine because
      // `computeRangeMetric` stores them as nested maps.
      byASN: this.extractDimension(obj, 'byASN'),
      byISP: this.extractDimension(obj, 'byISP'),
      byChannel: this.extractDimension(obj, 'byChannel'),
      byReferrer: this.extractDimension(obj, 'byReferrer'),
      byProxyType: this.extractDimension(obj, 'byProxyType'),
      byBotKind: this.extractDimension(obj, 'byBotKind'),
      funnel: this.extractDimension(obj, 'funnel'),
      clientEvents: this.extractDimension(obj, 'clientEvents'),
      byPage: this.extractDimension(obj, 'byPage'),
      byLandingPath: this.extractDimension(obj, 'byLandingPath'),
      revenueByCurrency: this.extractDimension(obj, 'revenueByCurrency'),
      paymentsByCurrency: this.extractDimension(obj, 'paymentsByCurrency'),
      paidByPlan: this.extractDimension(obj, 'paidByPlan'),
      paidByChannel: this.extractDimension(obj, 'paidByChannel'),
    }
  }

  private toDateTimeKey(date: Date, unit: 'hour' | 'minute' = 'hour'): string {
    const y = date.getUTCFullYear()
    const m = String(date.getUTCMonth() + 1).padStart(2, '0')
    const d = String(date.getUTCDate()).padStart(2, '0')
    const h = String(date.getUTCHours()).padStart(2, '0')
    if (unit === 'minute') {
      return `${y}-${m}-${d}-${h}-${String(date.getUTCMinutes()).padStart(2, '0')}`
    }
    return `${y}-${m}-${d}-${h}`
  }
}
