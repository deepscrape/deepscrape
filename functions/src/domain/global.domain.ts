/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */

import { UserInfo } from "firebase-admin/auth"


export type Users = {
    // Firebase UID
    uid: string
    email: string | null
    username: string
    details?: UserDetails
    notifications?: UserNotifications
    alerts?: UserAlerts
    settings?: UserSettings
    providerParent: string
    providerId: string
    providerData: UserInfo[]
    mfa_enabled?: boolean
    emailVerified: boolean
    lastSeen: Date
    last_login_at: Date // Timestamp | null
    created_At: Date
    updated_At?:Date

    // Phone authentication fields
    phoneNumber?: string
    // Optional, may not be present in all user objects
    phoneVerified?: boolean | null

    // Stripe customer ID
    stripeId?: string
    // Stripe Subscription data
    subscriptionId?: string
    status?: string
    currentUsage?: number
    balance?: number
    itemId?: string

    // User Authorization fields
    role?: string
    plan?: "free" | "trial" | "starter" | "pro" | "enterprise"

    // Profile status
    profileStatus?: ProfileStatus
    loginMetricsId?: string
}

export type UserDetails = {
    displayName: string
    photoURL?: string
    engineerStatus?: string
    geo?: {
        continent: string,
        region: string
     } // continent: "EU" region: "GR"
    region?: string
    country?: string
    language?: string
    timezone?: string
    bio?: string
    website?: string
    location?: string
    longitude?: number
    latitude?: number
    company?: string
    jobTitle?: string
    socialLinks?: UserSocialLinks
    last_username_change?: Date | null
    updated_At?: Date | null
}


export type ProfileStatus = {
    isBanned?: boolean
    isDeleted?: boolean
    banReason?: string
    deleteReason?: string
    banExpires?: Date | null
    deletedAt?: Date | null
}


export type loginMetrics = {
    id?: string
    lastGuestId: string
    /** Time the user was created. */
    creationTime?: string
    /** Time the user last signed in. */
    lastSignInTime?: string
    lastLoginId?: string
    loginCount?: number
}

export type loginHistoryInfo = {
    id?: string
    providerId: string
    uid?: string
    timestamp: Date
    connection: string
    connected: boolean
    os: string
    ipAddress: string
    browser: string
    userAgent: string
    location?: string // Optional field to store the location of the login
    deviceType?: string // Optional field to store the type of device used
    guestId?: string // Optional field to store geolocation data
    signOutTime?: Date // Optional field to store sign out time
    sessionKey?: string // Optional field to link to a session
    deviceFingerprintHash?: string
    revokedAt?: Date | null
    revokedByUid?: string | null
}

export type Guest = {
  id: string
  uid: string
  ip: { ipv4: string | null, ipv6: string | null, raw: string | null }
  userAgent: string
  browser: string
  os: string
  device: string
  language: string
  timezone: string
  country: string
  region: string
  geo: {
    continent: string
    region: string
  }
  latitude: number
  longitude: number
  location: string
    network?: {
        asn: string | null
        as: string | null
        isp: string | null
        domain: string | null
        usageType: string | null
    }
    proxy?: {
        isProxy: boolean
        proxyType: string | null
        threat: string | null
        lastSeenDays: number | null
        provider: string | null
        fraudScore: number | null
        confidence: "none" | "open-proxy-detected" | "unknown"
    }
  // First-touch acquisition context captured at guest creation (utm_* lowercased).
  acquisition?: {
    utmSource?: string
    utmMedium?: string
    utmCampaign?: string
    utmTerm?: string
    utmContent?: string
    referrer?: string
    landingPath?: string
  }
  // Bot / AI-agent classification from the UA (infrastructure/ua-parser).
  isBot?: boolean
  botKind?: "ai-assistant" | "ai-crawler" | "bot" | null
  fingerprint: string // Unique fingerprint for guest tracking
  /**
   * How this guest's identity was established, so the IP fallback can be audited:
   * `new` for a first-ever visitor, `ip` when an unknown fingerprint was absorbed
   * into the guest already mapped to that IP (see `GUEST_IP_TTL_SECONDS`).
   * Absent on documents written before the index existed.
   */
  identitySource?: "new" | "ip"
  createdAt: Date
  lastSeen: Date
  linkedAt?: Date | null
}


export type UserSocialLinks = {
    twitter?: string
    linkedin?: string
    threads?: string
    youtube?: string
    codepen?: string
    github?: string
    engineerStatus?: string
    website?: string
    stackoverflow?: string
}

export type UserNotifications = {
    emailNotifications?: boolean
    pushNotifications?: boolean
    marketingEmails?: boolean
    securityAlerts?: boolean
    preferences?: { [key: string]: boolean | string | number }
}

export type UserAlerts = {
    unreadCount?: number
    alerts?: Array<{
        id: string
        type: "info" | "warning" | "error" | "success"
        title: string
        message: string
        read?: boolean
        createdAt: Date
        actions?: Array<{
            label: string
            action: string
            style?: "primary" | "secondary" | "danger"
        }>
    }>
}

export type UserSettings = {
    theme?: "light" | "dark" | "auto"
    language?: string
    timezone?: string
    dateFormat?: string
    privacySettings?: {
        profileVisibility?: "public" | "private" | "friends"
        showEmail?: boolean
        showLocation?: boolean
        allowDataCollection?: boolean
    }
    communicationSettings?: {
        emailFrequency?: "immediate" | "daily" | "weekly" | "never"
        allowMarketingEmails?: boolean
        allowNotifications?: boolean
    }
    preferences?: { [key: string]: boolean | string | number }
}

/**
 * Enterprise login session - tracks authenticated user sessions per device
 * Stored in /loginSessions/{sessionId} and users/{userId}/sessions/{sessionId}
 * @since 2026-04-06 Enterprise SaaS architecture
 */
export type LoginSession = {
    sessionId: string
    userId: string
    deviceId: string
    createdAt: Date
    lastActivityAt: Date
    expiresAt: Date
    revokedAt: Date | null
    active: boolean
    ipAddress: string
    userAgent: string
    browser: string
    os: string
    location: string
    providerId: string
}

/**
 * Login session metrics - aggregated data for admin analytics
 */
export type LoginSessionMetrics = {
    sessionId: string
    userId: string
    deviceId: string
    totalDuration: number // milliseconds
    totalRequests: number
    totalHeartbeats: number
    createdAt: Date
    lastActivityAt: Date
    createdFromIp: string
    revokedAt?: Date | null
    revokeReason?: string
}

/**
 * Device fingerprint cache for session deduplication
 */
export type DeviceFingerprint = {
    fingerprintHash: string
    userId: string
    browser: string
    os: string
    deviceType: string
    firstSeenAt: Date
    lastSeenAt: Date
    sessionCount: number
    isVerified: boolean
}
