import { Injectable, inject, PLATFORM_ID, signal } from '@angular/core'
import { DOCUMENT, isPlatformBrowser } from '@angular/common'
import { HttpClient } from '@angular/common/http'
import { CookieService } from 'ngx-cookie-service'
import { from, Observable } from 'rxjs'
import { map } from 'rxjs'
import { environment } from 'src/environments/environment'
import { FirestoreService } from './firestore.service'
import { Timestamp } from '@angular/fire/firestore'

/**
 * PHASE 4.2: Device Verification Service
 * Detects new devices and requires verification (email/SMS confirmation)
 */
export interface DeviceFingerprint {
  userAgent: string
  ipAddress: string
  deviceId: string
  timestamp: Date
}

export interface TrustedDevice {
  deviceId: string
  deviceName: string
  fingerprint: DeviceFingerprint
  trustedAt: Date
  lastUsedAt: Date
  browser: string
  os: string
  location: string
}

export interface SendVerificationCodeResult {
  success: boolean
  expiresAt?: string
  message?: string
  method?: 'email' | 'sms'
  deliveryStatus?: 'sent' | 'pending_client_mfa'
  hasPhoneNumber?: boolean
  hasMfaEnabled?: boolean
  sessionId?: string | null
}

@Injectable({
  providedIn: 'root'
})
export class DeviceVerificationService {
  private firestore = inject(FirestoreService)
  private http = inject(HttpClient)
  private platformId = inject(PLATFORM_ID)
  private documentRef = inject(DOCUMENT)
  private cookieService = inject(CookieService)

  /** First-party cookie holding the device id, matching the consent cookie's flags. */
  private static readonly DEVICE_ID_COOKIE = 'device_id'
  private static readonly DEVICE_ID_DAYS = 365

  readonly requiresVerification = signal(false)
  readonly pendingDeviceId = signal('')
  readonly verificationCode = signal('')
  readonly verificationExpiry = signal<Date | null>(null)

  /**
   * Compute device fingerprint from browser
   */
  getDeviceFingerprint(): DeviceFingerprint {
    if (!isPlatformBrowser(this.platformId)) {
      return {
        userAgent: 'server',
        ipAddress: '',
        deviceId: 'server-device',
        timestamp: new Date()
      }
    }

    const browserWindow = this.documentRef?.defaultView
    const browserNavigator = browserWindow?.navigator
    const browserScreen = browserWindow?.screen

    if (!browserWindow || !browserNavigator || !browserScreen) {
      const randomUuid = globalThis.crypto?.randomUUID?.()
      const fallbackDeviceId = randomUuid
        ? `browser-fallback-${randomUuid}`
        : this.hashString(`browser-fallback-${Date.now()}-${Math.random()}`)
      return {
        userAgent: 'unknown',
        ipAddress: '',
        deviceId: fallbackDeviceId,
        timestamp: new Date()
      }
    }

    // Stable stored id instead of a computed fingerprint: the canvas+UA hash drifted
    // (canvas randomization in Brave/Firefox, browser major updates, display changes) and
    // asked already-trusted users to verify again, while trust was never carried by that
    // entropy — the out-of-band code carries it — and a copied cookie is no weaker than a
    // copied canvas hash. Reintroduce passive signals only if device trust becomes a
    // server-side control rather than a client-side prompt.
    let deviceId = ''
    try {
      deviceId = this.cookieService.get(DeviceVerificationService.DEVICE_ID_COOKIE)
    } catch {
      deviceId = ''
    }
    if (!deviceId) {
      deviceId = globalThis.crypto?.randomUUID?.()
        ?? this.hashString(`device-${Date.now()}-${Math.random()}`)
      try {
        this.cookieService.set(
          DeviceVerificationService.DEVICE_ID_COOKIE,
          deviceId,
          DeviceVerificationService.DEVICE_ID_DAYS,
          '/',
          '',
          true,
          'Lax',
        )
      } catch {
        // A blocked cookie store (private mode) only means verifying again next visit.
      }
    }

    return {
      userAgent: browserNavigator.userAgent,
      ipAddress: '', // Will be filled by backend
      deviceId,
      timestamp: new Date()
    }
  }

  /**
   * Check if device is trusted
   */
  async isDeviceTrusted(userId: string, fingerprint: DeviceFingerprint): Promise<boolean> {
    try {
      // Query user's trustedDevices collection
      const trustedDevices = await this.firestore.callFunction<
        { userId: string; deviceId: string },
        { trusted: boolean }
      >('isDeviceTrusted', {
        userId,
        deviceId: fingerprint.deviceId
      })
      return trustedDevices.trusted || false
    } catch (error) {
      console.error('Failed to check device trust:', error)
      return false
    }
  }

  /**
   * Send device verification code
   */
  async sendVerificationCode(userId: string, method: 'email' | 'sms' | 'auto', sessionId?: string): Promise<SendVerificationCodeResult> {
    try {
      const result = await this.firestore.callFunction<
        { userId: string; method: string; sessionId?: string },
        SendVerificationCodeResult
      >('sendDeviceVerificationCode', {
        userId,
        method,
        ...(sessionId ? { sessionId } : {}),
      })

      if (result.success && result.expiresAt) {
        this.verificationExpiry.set(new Date(result.expiresAt))
      }
      return result
    } catch (error) {
      console.error('Failed to send verification code:', error)
      // Extract the actual error message from Firebase Functions error wrapper
      const message =
        ((error as Record<string, unknown>)?.['message'] as string) ||
        ((error as Record<string, unknown>)?.toString() as string) ||
        'Failed to send verification code'
      return {
        success: false,
        message,
      }
    }
  }

  /**
   * Verify device and add to trusted list
   */
  async verifyDevice(userId: string, code: string, deviceName: string, sessionId?: string, mfaVerified?: boolean): Promise<boolean> {
    try {
      const fingerprint = this.getDeviceFingerprint()
      const result = await this.firestore.callFunction<
        { userId: string; code: string; deviceId: string; deviceName: string; sessionId?: string; mfaVerified?: boolean },
        { success: boolean; trustedUntil: string }
      >('verifyAndTrustDevice', {
        userId,
        code,
        deviceId: fingerprint.deviceId,
        deviceName,
        ...(sessionId ? { sessionId } : {}),
        ...(mfaVerified ? { mfaVerified: true } : {}),
      })

      if (result.success) {
        this.requiresVerification.set(false)
        this.pendingDeviceId.set('')
        this.verificationCode.set('')
        this.verificationExpiry.set(null)
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to verify device:', error)
      return false
    }
  }

  /**
   * Get list of trusted devices
   */
  getTrustedDevices(userId: string): Observable<TrustedDevice[]> {
    return from(
      this.firestore.callFunction<
        { userId: string },
        { devices: TrustedDevice[] }
      >('getTrustedDevices', { userId })
    ).pipe(
      map(response => response.devices)
    )
  }

  /**
   * Remove device from trusted list
   */
  async removeTrustedDevice(userId: string, deviceId: string): Promise<boolean> {
    try {
      const result = await this.firestore.callFunction<
        { userId: string; deviceId: string },
        { success: boolean }
      >('removeTrustedDevice', { userId, deviceId })
      return result.success || false
    } catch (error) {
      console.error('Failed to remove trusted device:', error)
      return false
    }
  }

  /**
   * Simple string hash for device fingerprint
   */
  private hashString(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36)
  }
}
