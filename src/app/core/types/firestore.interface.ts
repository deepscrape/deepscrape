import { UserInfo } from "@angular/fire/auth"

export type Users = {
    // Firebase UID
    uid: string
    email: string | null
    username: string
    details?: UserDetails
    notifications?: any
    alerts?: any
    settings?: any
    providerParent: string
    providerId: string
    providerData: UserInfo[]
    mfa_enabled?: boolean
    emailVerified: boolean
    lastSeen?: Date
    last_login_at: any // Timestamp | null
    created_At: Date
    updated_At?:Date

    // Phone authentication fields
    phoneNumber?: string | null
    phoneVerified?: boolean | null // Optional, may not be present in all user objects

    // Stripe customer ID
    stripeId?: string
    // Stripe Subscription data
    subscriptionId?: string
    status?: string
    currentUsage?: number
    balance?: number
    itemId?: string

    // User Authorization fieldsrole
    role?: string
    defaultOrgId?: string
    plan?: 'free' | 'trial' | 'starter' | 'pro' | 'enterprise'
    planInterval?: 'payAsYouGo' | 'monthly' | 'quarterly' | 'annually'

    // Profile status
    profileStatus?: ProfileStatus

    // Onboarding
    onboardedAt?: any // Firestore Timestamp | null — null means onboarding not yet completed
}

export type UserDetails = {
    displayName: string
    photoURL?: string
    engineerStatus?: string
    geo?: {
        continent: string,
        region: string 
    } // continent: "EU" region: "GR"
    country?: string
    region?: string
    location?: string
    language?: string
    timezone?: string
    latitude?: number
    longitude?: number
    bio?: string
    website?: string
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

    /** Hard-delete deadline set at confirmation time. */
    purgeAfter?: Date | null
    /** Set once the scheduled purger has erased the account. */
    purgedAt?: Date | null
    /** `self` for a user-requested deletion, otherwise the acting admin's uid. */
    deletedBy?: string | null
    /** Join key into the retained erasure record. */
    deletionId?: string | null
}


export type loginMetrics = {
    id?: string
    
    // Guest tracking
    guestId: string // created by guestId
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
    asn?: string | null
    as?: string | null
    isp?: string | null
    domain?: string | null
    usageType?: string | null
    proxy?: {
        isProxy: boolean
        proxyType?: string | null
        threat?: string | null
        lastSeenDays?: number | null
        provider?: string | null
        fraudScore?: number | null
        confidence?: 'none' | 'open-proxy-detected' | 'unknown' | string
    }
}

export type loginHistoryEvent = {
    id?: string
    uid?: string
    eventType: 'login' | 'logout' | 'revoke' | string
    eventSessionId?: string
    providerId?: string
    timestamp?: Date | string
    createdAt?: Date | string
    signOutTime?: Date | string
    revokedAt?: Date | string | null
    connected?: boolean
    os?: string
    ipAddress?: string
    browser?: string
    userAgent?: string
    location?: string
    deviceType?: string
    guestId?: string
    sessionKey?: string
    deviceFingerprintHash?: string
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
  fingerprint?: string // Unique fingerprint for guest tracking
    network?: {
        asn: string | null
        as: string | null
        isp: string | null
        domain: string | null
        usageType: string | null
    }
    proxy?: {
        isProxy: boolean
        proxyType?: string | null
        threat?: string | null
        lastSeenDays?: number | null
        provider?: string | null
        fraudScore?: number | null
        confidence?: 'none' | 'open-proxy-detected' | 'unknown' | string
    }
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

export interface FileMetadata {
  uploadedBy: string;
  uploadedAt: number;
  lastModified: number;
  type: string;
  initialName: string;
  initialSize: number;
}

export type Session = {
    id: string
    auth_id: string
    username: string
    user_id: string
    auth_type: string
    expires_at: Date
    created_at: Date
}

export type Author = Pick<UserInfo, 'uid' | 'displayName'>



// export type FireUser = {
//     uid: string
//     email: string | null
//     displayName: string | null
//     photoURL: string | null
//     phoneNumber?: string | null
//     providerId: string
//     providerData: UserInfo[]
//     emailVerified: boolean
//     phoneVerified?: boolean // Optional, may not be present in all user objects
// }
