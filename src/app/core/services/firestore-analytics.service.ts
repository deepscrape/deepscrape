/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */

import { Injectable, NgZone, inject } from '@angular/core'
import { 
  Firestore, 
  doc, 
  getDoc, 
  collection, 
  query, 
  where, 
  orderBy, 
  limit, 
  onSnapshot,
  Unsubscribe,
  DocumentData
} from '@angular/fire/firestore'
import { Observable, BehaviorSubject, combineLatest, map, shareReplay, startWith } from 'rxjs'
import { 
  DashboardSummary, 
  MetricsDaily, 
  MetricsRange, 
  AnalyticsRequest, 
  AnalyticsResponse,
  RealtimeUpdate,
  PeriodFilter,
  DimensionFilter
} from '../types/analytics.interface'

/**
 * 🚀 Optimized Analytics Service
 * 
 * Key optimizations:
 * 1. Pre-aggregated data = 90% fewer Firestore reads
 * 2. Real-time listeners for live updates
 * 3. In-memory caching for repeated queries
 * 4. Single API calls instead of multiple collection queries
 */
@Injectable({
  providedIn: 'root'
})
export class FirestoreAnalyticsService {
  private firestore = inject(Firestore)
  private ngZone = inject(NgZone)
  
  // Cache for frequently accessed data
  private cache = new Map<string, { data: any; timestamp: number; ttl: number }>()
  private readonly CACHE_TTL = {
    dashboard: 30 * 1000,      // 30 seconds
    daily: 5 * 60 * 1000,     // 5 minutes
    range: 60 * 60 * 1000,    // 1 hour
  }
  
  // Real-time subjects
  private dashboardSubject = new BehaviorSubject<DashboardSummary | null>(null)
  private realtimeUpdatesSubject = new BehaviorSubject<RealtimeUpdate | null>(null)
  
  // Active listeners (for cleanup)
  private activeListeners: Unsubscribe[] = []
  // Separate from reading `dashboardSubject.value`: that getter throws once the
  // listener has errored the subject, which would take the whole page down.
  private dashboardListening = false

  // ============================================================================
  // PUBLIC API - Optimized Methods
  // ============================================================================

  /**
   * 🎯 Get dashboard summary - Single Firestore read
   * Returns cached data if available, otherwise fetches fresh
   */
  async getDashboardSummary(): Promise<DashboardSummary | null> {
    const cacheKey = 'dashboard-summary'
    
    // Check cache first
    const cached = this.getFromCache<DashboardSummary>(cacheKey)
    if (cached) {
      console.log('📦 Dashboard summary from cache')
      return cached
    }
    
    try {
      const docRef = doc(this.firestore, 'metrics_summary/dashboard')
      const docSnap = await getDoc(docRef)
      
      if (docSnap.exists()) {
        const data = docSnap.data() as DashboardSummary
        this.setCache(cacheKey, data, this.CACHE_TTL.dashboard)
        console.log('🔥 Dashboard summary from Firestore')
        return data
      }
      
      return null
    } catch (error) {
      console.error('❌ Error fetching dashboard summary:', error)
      return null
    }
  }

  /**
   * 📈 Get metrics for date range - Uses pre-computed ranges when possible
   */
  async getMetricsForRange(period: PeriodFilter, startDate?: string, endDate?: string): Promise<AnalyticsResponse | null> {
    // Try to use pre-computed range first
    if (period !== 'custom' && this.isCommonRange(period)) {
      const rangeId = this.periodToRangeId(period)
      const rangeData = await this.getRangeMetrics(rangeId)
      
      if (rangeData) {
        console.log(`📊 Using pre-computed range: ${rangeId}`)
        return this.convertRangeToResponse(rangeData)
      }
    }
    
    // Fallback to daily aggregation
    console.log('📅 Computing range from daily metrics')
    return await this.computeRangeFromDaily(startDate!, endDate!)
  }

  /**
   * 🔴 Real-time dashboard observable - Live updates
   */
  watchDashboard(): Observable<DashboardSummary | null> {
    // Start listening if not already
    if (!this.dashboardListening) {
      this.startDashboardListener()
    }
    
    return this.dashboardSubject.asObservable().pipe(
      shareReplay(1) // Share the subscription among multiple subscribers
    )
  }

  /**
   * ⚡ Real-time updates stream
   */
  watchRealtimeUpdates(): Observable<RealtimeUpdate | null> {
    return this.realtimeUpdatesSubject.asObservable()
  }

  /**
   * 📊 Get filtered analytics with real-time updates
   */
  getFilteredAnalytics(request: AnalyticsRequest): Observable<AnalyticsResponse | null> {
    const { period, dimensions, realtime } = request
    
    // Get base metrics
    const baseMetrics$ = this.getMetricsObservable(period, request.startDate, request.endDate)
    
    if (!realtime) {
      // Static data only
      return baseMetrics$.pipe(
        map(data => data ? this.applyDimensionFilters(data, dimensions) : null)
      )
    }
    
    // Combine with real-time updates
    return combineLatest([
      baseMetrics$,
      this.watchRealtimeUpdates().pipe(startWith(null))
    ]).pipe(
      map(([baseData, update]) => {
        if (!baseData) return null
        
        let result = this.applyDimensionFilters(baseData, dimensions)
        
        // Apply real-time update if available
        if (update && result) {
          result = this.applyRealtimeUpdate(result, update)
        }
        
        return result
      }),
      shareReplay(1)
    )
  }

  // ============================================================================
  // PRIVATE METHODS - Internal Implementation
  // ============================================================================

  private async getRangeMetrics(rangeId: string): Promise<MetricsRange | null> {
    const cacheKey = `range-${rangeId}`
    
    // Check cache
    const cached = this.getFromCache<MetricsRange>(cacheKey)
    if (cached) {
      return cached
    }
    
    try {
      const docRef = doc(this.firestore, `metrics_range/${rangeId}`)
      const docSnap = await getDoc(docRef)
      
      if (docSnap.exists()) {
        const data = docSnap.data() as MetricsRange
        this.setCache(cacheKey, data, this.CACHE_TTL.range)
        return data
      }
      
      return null
    } catch (error) {
      console.error(`❌ Error fetching range metrics for ${rangeId}:`, error)
      return null
    }
  }

  private async computeRangeFromDaily(startDate: string, endDate: string): Promise<AnalyticsResponse | null> {
    try {
      const dates = this.generateDateRange(startDate, endDate)
      
      // Fetch daily metrics for all dates
      const dailyPromises = dates.map(date => 
        this.getDailyMetrics(date)
      )
      
      const dailyResults = await Promise.all(dailyPromises)
      const validDailyMetrics = dailyResults.filter(Boolean) as MetricsDaily[]
      
      if (validDailyMetrics.length === 0) {
        return null
      }
      
      // Aggregate the daily data
      return this.aggregateDailyMetrics(validDailyMetrics, dates)
      
    } catch (error) {
      console.error('❌ Error computing range from daily metrics:', error)
      return null
    }
  }

  private async getDailyMetrics(date: string): Promise<MetricsDaily | null> {
    const cacheKey = `daily-${date}`
    
    // Check cache
    const cached = this.getFromCache<MetricsDaily>(cacheKey)
    if (cached) {
      return cached
    }
    
    try {
      const docRef = doc(this.firestore, `metrics_daily/${date}`)
      const docSnap = await getDoc(docRef)
      
      if (docSnap.exists()) {
        const data = docSnap.data() as MetricsDaily
        this.setCache(cacheKey, data, this.CACHE_TTL.daily)
        return data
      }
      
      return null
    } catch (error) {
      console.error(`❌ Error fetching daily metrics for ${date}:`, error)
      return null
    }
  }

  private startDashboardListener(): void {
    console.log('🔴 Starting real-time dashboard listener')
    this.dashboardListening = true
    
    const docRef = doc(this.firestore, 'metrics_summary/dashboard')
    
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      this.ngZone.run(() => {
        if (docSnap.exists()) {
          const data = docSnap.data() as DashboardSummary
          
          // Cache the fresh data
          this.setCache('dashboard-summary', data, this.CACHE_TTL.dashboard)
          
          // Emit to subscribers
          this.dashboardSubject.next(data)
          
          // Emit as realtime update
          this.realtimeUpdatesSubject.next({
            type: 'guest_created', // This could be more specific
            timestamp: data.lastUpdated,
            metrics: data
          })
          
          console.log('🔴 Dashboard updated in real-time')
        } else {
          this.dashboardSubject.next(null)
        }
      })
    }, (error) => {
      console.error('❌ Dashboard listener error:', error)
      this.dashboardSubject.error(error)
    })
    
    this.activeListeners.push(unsubscribe)
  }

  private getMetricsObservable(period: PeriodFilter, startDate?: string, endDate?: string): Observable<AnalyticsResponse | null> {
    if (period === 'today') {
      // Special case: listen to today's metrics in real-time
      const today = new Date().toISOString().split('T')[0]
      return this.watchDailyMetrics(today)
    }
    
    // For other periods, return a static observable
    return new Observable<AnalyticsResponse | null>(observer => {
      this.getMetricsForRange(period, startDate, endDate)
        .then(data => observer.next(data))
        .catch(error => observer.error(error))
    })
  }

  private watchDailyMetrics(date: string): Observable<AnalyticsResponse | null> {
    const docRef = doc(this.firestore, `metrics_daily/${date}`)
    
    return new Observable<AnalyticsResponse | null>(observer => {
      const unsubscribe = onSnapshot(docRef, (docSnap) => {
        this.ngZone.run(() => {
          if (docSnap.exists()) {
            const data = docSnap.data() as MetricsDaily
            const response = this.convertDailyToResponse(data)
            observer.next(response)
          } else {
            observer.next(null)
          }
        })
      }, error => {
        observer.error(error)
      })
      
      this.activeListeners.push(unsubscribe)
      
      // Cleanup function
      return () => unsubscribe()
    })
  }

  private applyDimensionFilters(data: AnalyticsResponse, filters?: DimensionFilter): AnalyticsResponse {
    if (!filters) return data
    
    let filtered = { ...data }
    
    // Filter breakdowns based on dimension filters
    if (filters.country) {
      const countries = Array.isArray(filters.country) ? filters.country : [filters.country]
      filtered.breakdowns.byCountry = filtered.breakdowns.byCountry.filter(
        item => countries.includes(item.country)
      )
    }
    
    if (filters.browser) {
      const browsers = Array.isArray(filters.browser) ? filters.browser : [filters.browser]
      filtered.breakdowns.byBrowser = filtered.breakdowns.byBrowser.filter(
        item => browsers.includes(item.browser)
      )
    }
    
    if (filters.device) {
      const devices = Array.isArray(filters.device) ? filters.device : [filters.device]
      filtered.breakdowns.byDevice = filtered.breakdowns.byDevice.filter(
        item => devices.includes(item.device)
      )
    }
    
    if (filters.provider) {
      const providers = Array.isArray(filters.provider) ? filters.provider : [filters.provider]
      filtered.breakdowns.byProvider = filtered.breakdowns.byProvider.filter(
        item => providers.includes(item.provider)
      )
    }
    
    return filtered
  }

  private applyRealtimeUpdate(response: AnalyticsResponse, update: RealtimeUpdate): AnalyticsResponse {
    if (!update.metrics) return response
    
    // Update summary with real-time data
    const updatedResponse = { ...response }
    
    if (update.metrics.totalGuests !== undefined) {
      updatedResponse.summary.totalGuests = update.metrics.totalGuests
    }
    if (update.metrics.totalUsers !== undefined) {
      updatedResponse.summary.totalUsers = update.metrics.totalUsers
    }
    if (update.metrics.totalLogins !== undefined) {
      updatedResponse.summary.totalLogins = update.metrics.totalLogins
    }
    
    return updatedResponse
  }

  // ============================================================================
  // CACHE MANAGEMENT
  // ============================================================================

  private getFromCache<T>(key: string): T | null {
    const cached = this.cache.get(key)
    if (!cached) return null
    
    const now = Date.now()
    if (now > cached.timestamp + cached.ttl) {
      // Expired
      this.cache.delete(key)
      return null
    }
    
    return cached.data as T
  }

  private setCache(key: string, data: any, ttl: number): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    })
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  private isCommonRange(period: PeriodFilter): boolean {
    return ['last-7d', 'last-30d', 'last-90d', 'this-month', 'last-month'].includes(period)
  }

  private periodToRangeId(period: PeriodFilter): string {
    switch (period) {
      case 'last-7d': return 'last-7d'
      case 'last-30d': return 'last-30d'
      case 'last-90d': return 'last-90d'
      case 'this-month': return 'this-month'
      case 'last-month': return 'last-month'
      default: return 'last-7d'
    }
  }

  private generateDateRange(startDate: string, endDate: string): string[] {
    const dates: string[] = []
    const current = new Date(startDate)
    const end = new Date(endDate)
    
    while (current <= end) {
      dates.push(current.toISOString().split('T')[0])
      current.setDate(current.getDate() + 1)
    }
    
    return dates
  }

  private convertRangeToResponse(range: MetricsRange): AnalyticsResponse {
    return {
      summary: {
        totalGuests: range.totalGuests,
        totalUsers: range.totalUsers,
        totalLogins: range.totalLogins,
        guestConversions: range.guestConversions,
        conversionRate: range.conversionRate,
        // Fill other required summary fields
        activeGuests: 0,
        activeUsers: 0,
        trends: { guestsGrowth: 0, usersGrowth: 0, loginsGrowth: 0, conversionGrowth: 0 },
        topCountries: [],
        topBrowsers: [],
        topDevices: [],
        topProviders: [],
        lastUpdated: range.computedAt,
        computedAt: range.computedAt
      },
      timeline: range.dailyBreakdown,
      breakdowns: {
        byCountry: Object.entries(range.byCountry).map(([country, count]) => ({ country, count, percentage: 0 })),
        byBrowser: Object.entries(range.byBrowser).map(([browser, count]) => ({ browser, count, percentage: 0 })),
        byDevice: Object.entries(range.byDevice).map(([device, count]) => ({ device, count, percentage: 0 })),
        byProvider: Object.entries(range.byProvider).map(([provider, count]) => ({ provider, count, percentage: 0 }))
      },
      requestId: `range-${range.rangeId}-${Date.now()}`,
      computedAt: range.computedAt,
      fromCache: false
    }
  }

  private convertDailyToResponse(daily: MetricsDaily): AnalyticsResponse {
    return {
      summary: {
        totalGuests: daily.totalGuests,
        activeGuests: daily.activeGuests,
        totalUsers: daily.totalUsers,
        activeUsers: daily.activeUsers,
        totalLogins: daily.totalLogins,
        guestConversions: daily.guestConversions,
        conversionRate: daily.conversionRate,
        trends: { guestsGrowth: 0, usersGrowth: 0, loginsGrowth: 0, conversionGrowth: 0 },
        topCountries: daily.topCountries || [],
        topBrowsers: daily.topBrowsers || [],
        topDevices: [],
        topProviders: [],
        lastUpdated: daily.updatedAt,
        computedAt: daily.updatedAt
      },
      timeline: [{
        date: daily.date,
        newGuests: daily.newGuests,
        newUsers: daily.newUsers,
        totalLogins: daily.totalLogins,
        guestConversions: daily.guestConversions,
        conversionRate: daily.conversionRate
      }],
      breakdowns: {
        byCountry: Object.entries(daily.byCountry).map(([country, count]) => ({ country, count, percentage: 0 })),
        byBrowser: Object.entries(daily.byBrowser).map(([browser, count]) => ({ browser, count, percentage: 0 })),
        byDevice: Object.entries(daily.byDevice).map(([device, count]) => ({ device, count, percentage: 0 })),
        byProvider: Object.entries(daily.byProvider).map(([provider, count]) => ({ provider, count, percentage: 0 }))
      },
      requestId: `daily-${daily.date}-${Date.now()}`,
      computedAt: daily.updatedAt,
      fromCache: false
    }
  }

  private aggregateDailyMetrics(dailyMetrics: MetricsDaily[], dates: string[]): AnalyticsResponse {
    // Implementation for aggregating multiple daily metrics
    const summary = dailyMetrics.reduce((acc, daily) => ({
      totalGuests: Math.max(acc.totalGuests, daily.totalGuests),
      totalUsers: Math.max(acc.totalUsers, daily.totalUsers),
      newGuests: acc.newGuests + daily.newGuests,
      newUsers: acc.newUsers + daily.newUsers,
      totalLogins: acc.totalLogins + daily.totalLogins,
      guestConversions: acc.guestConversions + daily.guestConversions
    }), { totalGuests: 0, totalUsers: 0, newGuests: 0, newUsers: 0, totalLogins: 0, guestConversions: 0 })
    
    const timeline = dailyMetrics.map(daily => ({
      date: daily.date,
      newGuests: daily.newGuests,
      newUsers: daily.newUsers,
      totalLogins: daily.totalLogins,
      guestConversions: daily.guestConversions,
      conversionRate: daily.conversionRate
    }))
    
    return {
      summary: {
        ...summary,
        activeGuests: 0,
        activeUsers: 0,
        conversionRate: summary.newGuests > 0 ? (summary.guestConversions / summary.newGuests) * 100 : 0,
        trends: { guestsGrowth: 0, usersGrowth: 0, loginsGrowth: 0, conversionGrowth: 0 },
        topCountries: [],
        topBrowsers: [],
        topDevices: [],
        topProviders: [],
        lastUpdated: dailyMetrics[dailyMetrics.length - 1]?.updatedAt,
        computedAt: dailyMetrics[dailyMetrics.length - 1]?.updatedAt
      },
      timeline,
      breakdowns: {
        byCountry: [],
        byBrowser: [],
        byDevice: [],
        byProvider: []
      },
      requestId: `aggregated-${Date.now()}`,
      computedAt: dailyMetrics[dailyMetrics.length - 1]?.updatedAt,
      fromCache: false
    }
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  /**
   * Stop the live listeners without discarding the read cache.
   *
   * `watchDashboard()` arms `startDashboardListener()` only while
   * `dashboardSubject` is null, so this MUST reset the subject or a second visit
   * to the page never re-arms and the live counters stay frozen. Kept separate
   * from `destroy()` on purpose: that one also clears the cache, which is right
   * for a real teardown and wrong for merely leaving a page — and nothing calls
   * `destroy()`, so until this existed an `onSnapshot` outlived the component.
   */
  stopRealtime(): void {
    this.activeListeners.forEach(unsubscribe => unsubscribe())
    this.activeListeners = []
    this.dashboardListening = false
    this.dashboardSubject.next(null)
    this.realtimeUpdatesSubject.next(null)
  }

  /**
   * Call this when the service is destroyed to clean up listeners
   */
  destroy(): void {
    console.log(`🧹 Cleaning up ${this.activeListeners.length} analytics listeners`)
    this.stopRealtime()
    this.cache.clear()
  }
}
