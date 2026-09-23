/* eslint-disable object-curly-spacing */

/**
 * Optimized Analytics Domain Types for Real-time Admin Dashboard
 *
 * This provides a complete type system for the new
 * pre-aggregated analytics architecture
 * that reduces Firestore reads by 90% while providing real-time updates.
 */

import { Timestamp } from "firebase-admin/firestore"

// ============================================================================
// CORE METRICS COLLECTIONS (Pre-aggregated for performance)
// ============================================================================

/**
 * Real-time dashboard summary - Single document for instant loading
 * Collection: metrics_summary/dashboard
 */
export interface DashboardSummary {
    // Real-time counters (updated by triggers)
    totalGuests: number
    activeGuests: number // Last 24h
    totalUsers: number
    activeUsers: number // Last 24h
    totalLogins: number

    // Live online counts (last 5 minutes)
    activeGuestsNow?: number
    activeUsersNow?: number
    onlineNow?: number

    // Consent decisions reported by the banner today, and the consent-blind
    // request level.
    // Mirrored in `src/app/core/types/analytics.interface.ts` — the analytics
    // contract spec fails if the two copies drift.
    consentGrantedToday?: number
    consentDeclinedToday?: number
    requestsToday?: number
    // Bots among the newest day's guests. Kept beside the counts above so a
    // crawler wave is not read as growth.
    botsToday?: number

    // Conversion metrics
    guestConversions: number
    conversionRate: number // (conversions / totalGuests) * 100

    // Growth trends (vs previous period)
    trends: {
        guestsGrowth: number // % change from yesterday
        usersGrowth: number // % change from yesterday
        loginsGrowth: number // % change from yesterday
        conversionGrowth: number // % change from yesterday
    }

    // Top-level breakdowns (top 5 each)
    topCountries: CountryMetric[]
    topBrowsers: BrowserMetric[]
    topDevices: DeviceMetric[]
    topProviders: ProviderMetric[]

    // Meta
    lastUpdated: Timestamp
    computedAt: Timestamp
}

/**
 * Daily aggregated metrics - One document per day
 * Collection: metrics_daily/{YYYY-MM-DD}
 */
export interface MetricsDaily {
    date: string // YYYY-MM-DD
    timestamp: Timestamp

    // Core metrics
    totalGuests: number // Cumulative
    newGuests: number // New today
    activeGuests: number // Active today
    totalUsers: number // Cumulative
    newUsers: number // New today
    activeUsers: number // Active today
    totalLogins: number // Today only

    // Hourly breakdown for charts
    loginsByHour: { [hour: string]: number } // "0" to "23"
    guestsByHour: { [hour: string]: number }
    usersByHour: { [hour: string]: number }

    // Conversions
    guestConversions: number // Guests who became users today
    conversionRate: number // (conversions / newGuests) * 100

    // Dimensional breakdowns
    byCountry: { [country: string]: number }
    byRegion?: { [region: string]: number }
    byLocation?: { [location: string]: number }
    byGeoCell?: { [geoCell: string]: number }
    byLatitudeBand?: { [latitudeBand: string]: number }
    byLongitudeBand?: { [longitudeBand: string]: number }
    byBrowser: { [browser: string]: number }
    byDevice: { [device: string]: number }
    byOS: { [os: string]: number }
    byProvider: { [providerId: string]: number }
    byTimezone: { [timezone: string]: number }

    // Bots among the day's new guests, written by the daily rollup. Absent on
    // days rolled up before bot tagging shipped.
    bots?: number

    // Computed analytics
    topCountries: CountryMetric[] // Top 10
    topBrowsers: BrowserMetric[] // Top 10
    avgSessionDuration?: number // If tracking sessions

    updatedAt: Timestamp
}

/**
 * Hourly metrics for real-time granularity
 * Collection: metrics_hourly/{YYYY-MM-DD-HH}
 */
export interface MetricsHourly {
    datetime: string // YYYY-MM-DD-HH
    date: string // YYYY-MM-DD
    hour: number // 0-23
    timestamp: Timestamp

    // Hourly counters
    newGuests: number
    newUsers: number
    totalLogins: number
    guestConversions: number
    activeGuests: number // Unique guests this hour
    activeUsers: number // Unique users this hour

    // Quick breakdowns (top 5 each)
    topCountries: CountryMetric[]
    topBrowsers: BrowserMetric[]
    topDevices: DeviceMetric[]

    updatedAt: Timestamp
}

/**
 * Pre-computed range metrics for common periods
 * Collection: metrics_range/{rangeId}
 * rangeId examples: "last-7d", "last-30d", "this-month"
 */
export interface MetricsRange {
    rangeId: string // "last-7d", "last-30d", "last-90d", "this-month"
    startDate: string // YYYY-MM-DD
    endDate: string // YYYY-MM-DD

    // Aggregated totals
    totalGuests: number
    newGuests: number
    totalUsers: number
    newUsers: number
    totalLogins: number
    guestConversions: number
    conversionRate: number

    // Dimensional aggregations
    byCountry: { [country: string]: number }
    byRegion?: { [region: string]: number }
    byLocation?: { [location: string]: number }
    byGeoCell?: { [geoCell: string]: number }
    byLatitudeBand?: { [latitudeBand: string]: number }
    byLongitudeBand?: { [longitudeBand: string]: number }
    byBrowser: { [browser: string]: number }
    byDevice: { [device: string]: number }
    byOS?: { [os: string]: number }
    byProvider: { [provider: string]: number }
    byTimezone?: { [timezone: string]: number }

    // Daily timeline for charts
    dailyBreakdown: DailyBreakdown[]

    // Growth analysis
    trends: {
        avgDailyGuests: number
        avgDailyUsers: number
        avgDailyLogins: number
        peakDay: string // Date with highest activity
        peakValue: number // Peak day's value
    }

    computedAt: Timestamp
    expiresAt: Timestamp // Cache expiry
}

// ============================================================================
// DETAILED ANALYTICS COLLECTIONS (For drill-down analysis)
// ============================================================================

/**
 * Individual user login events
 * Collection: login_metrics/{userId}/login_history_Info/{loginId}
 */
export interface LoginHistory {
    id: string
    userId: string
    sessionId: string

    // Event details
    timestamp: Timestamp
    signOutTime?: Timestamp
    sessionDuration?: number // seconds

    // Authentication
    providerId: string // "google.com", "password", "github.com", "phone"
    connection: string // "oauth", "email", "sms"

    // Device & Location
    ipAddress: string // Hashed for privacy
    userAgent: string
    browser: string
    os: string
    device: string // "desktop", "mobile", "tablet"
    deviceFingerprint: string // Hashed

    // Geolocation
    country: string
    region: string
    city: string
    timezone: string
    latitude?: number
    longitude?: number

    // Linking
    guestId?: string // If converted from guest

    // Meta
    createdAt: Timestamp
}

/**
 * Per-user login metrics summary
 * Collection: users/{userId}/login_metrics
 */
export interface UserLoginMetrics {
    userId: string

    // Counters
    totalLogins: number
    loginStreak: number // Consecutive days
    longestStreak: number

    // Timestamps
    firstLogin: Timestamp
    lastLogin: Timestamp
    createdAt: Timestamp

    // Conversion tracking
    wasGuest: boolean
    guestId?: string
    linkedAt?: Timestamp

    // Behavioral patterns
    favoriteProvider: string // Most used auth method
    averageSessionDuration: number
    loginsByDay: { [day: string]: number } // "monday", "tuesday", etc.
    loginsByHour: { [hour: string]: number } // "0" to "23"

    // Device patterns
    primaryDevice: string
    primaryBrowser: string
    primaryOS: string
    deviceCount: number // Unique devices used

    updatedAt: Timestamp
}

// ============================================================================
// SUPPORTING TYPES
// ============================================================================

export interface CountryMetric {
    country: string
    count: number
    percentage: number
    growth?: number // % change from previous period
}

export interface BrowserMetric {
    browser: string
    count: number
    percentage: number
    growth?: number
}

export interface DeviceMetric {
    device: string
    count: number
    percentage: number
    growth?: number
}

export interface ProviderMetric {
    provider: string
    count: number
    percentage: number
    growth?: number
}

export interface DailyBreakdown {
    date: string // YYYY-MM-DD
    newGuests: number
    newUsers: number
    totalLogins: number
    guestConversions: number
    conversionRate: number
}

// ============================================================================
// REQUEST/RESPONSE TYPES FOR API
// ============================================================================

export type PeriodFilter =
    | "today"
    | "yesterday"
    | "last-2d"
    | "last-7d"
    | "last-30d"
    | "last-90d"
    | "this-month"
    | "last-month"
    | "this-year"
    | "custom"

export type GranularityFilter = "hourly" | "daily" | "weekly" | "monthly"

export interface DimensionFilter {
    country?: string | string[]
    device?: "desktop" | "mobile" | "tablet" | string[]
    browser?: string | string[]
    provider?: "google" | "github" | "password" | "phone" | string[]
    userType?: "guests" | "users" | "all"
}

export interface AnalyticsRequest {
    period: PeriodFilter
    granularity?: GranularityFilter
    startDate?: string // For custom period
    endDate?: string // For custom period
    dimensions?: DimensionFilter
    realtime?: boolean // Enable real-time updates
}

export interface AnalyticsResponse {
    // Summary stats
    summary: DashboardSummary

    // Time-series data for charts
    timeline: DailyBreakdown[]

    // Dimensional breakdowns
    breakdowns: {
        byCountry: CountryMetric[]
        byBrowser: BrowserMetric[]
        byDevice: DeviceMetric[]
        byProvider: ProviderMetric[]
    }

    // Real-time indicators
    realtime?: {
        lastUpdate: Timestamp
        activeUsers: number
        activeGuests: number
        onlineNow: number
    }

    // Meta
    requestId: string
    computedAt: Timestamp
    fromCache: boolean
}

// ============================================================================
// REAL-TIME UPDATE EVENTS
// ============================================================================

export interface RealtimeUpdate {
    type: "guest_created" | "user_registered" | "user_login" | "guest_converted"
    timestamp: Timestamp

    // Updated metrics (partial)
    metrics?: Partial<DashboardSummary>

    // Event details
    event?: {
        userId?: string
        guestId?: string
        country?: string
        browser?: string
        device?: string
        provider?: string
    }
}

// ============================================================================
// CACHE STRATEGIES
// ============================================================================

export interface CacheConfig {
    // Summary cache (Redis/Memory)
    summaryTTL: number // 30 seconds

    // Daily metrics cache
    dailyTTL: number // 5 minutes

    // Range metrics cache
    rangeTTL: number // 1 hour

    // Real-time updates
    realtimeEnabled: boolean
    realtimeInterval: number // milliseconds
}
