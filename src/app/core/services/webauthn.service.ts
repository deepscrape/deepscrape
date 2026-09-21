import { Injectable, inject, signal } from '@angular/core'
import { FirestoreService } from './firestore.service'
import { AnalyticsService } from './analytics.service'

export interface WebAuthnCredential {
  id: string
  credentialId: string
  deviceName: string
  counter: number
  createdAt: Date
  lastUsedAt: Date
}

export interface WebAuthnRegistrationOptions {
  challenge: string
  rp: { name: string; id: string }
  user: { id: string; name: string; displayName: string }
  pubKeyCredParams: { type: string; alg: number }[]
  authenticatorSelection: {
    authenticatorAttachment: string
    userVerification: string
    residentKey: string
  }
  timeout: number
  attestation: string
  excludeCredentials: { id: string; type: string }[]
}

@Injectable({
  providedIn: 'root',
})
export class WebAuthnService {
  private firestore = inject(FirestoreService)
  private analytics = inject(AnalyticsService)

  readonly passkeys = signal<WebAuthnCredential[]>([])
  readonly isRegistering = signal(false)
  readonly isAuthenticating = signal(false)
  readonly error = signal('')

  /**
   * Convert ArrayBuffer to base64url string for transport.
   */
  private bufferToBase64Url(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }

  /**
   * Convert base64url string to Uint8Array for the WebAuthn API.
   */
  private base64UrlToBuffer(base64url: string): Uint8Array {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
    const padding = '='.repeat((4 - (base64.length % 4)) % 4)
    const binary = atob(base64 + padding)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  /**
   * Recursively convert ArrayBuffer values in an object to base64url strings
   * so the object can be serialized to JSON for the Cloud Function.
   */
  private convertBuffersToBase64(obj: any): any {
    if (obj instanceof ArrayBuffer) {
      return this.bufferToBase64Url(obj)
    }
    if (obj instanceof Uint8Array) {
      return this.bufferToBase64Url(obj.buffer as ArrayBuffer)
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.convertBuffersToBase64(item))
    }
    if (obj && typeof obj === 'object') {
      const result: any = {}
      for (const key of Object.keys(obj)) {
        result[key] = this.convertBuffersToBase64(obj[key])
      }
      return result
    }
    return obj
  }

  /**
   * Register a new passkey (WebAuthn credential).
   * Returns true if successful.
   */
  async registerPasskey(): Promise<boolean> {
    this.isRegistering.set(true)
    this.error.set('')

    try {
      // Step 1: Get registration options from the server
      const { options } = await this.firestore.callFunction<
        void,
        { success: boolean; options: any }
      >('generateWebAuthnRegistrationOptions')

      // Step 2: Convert base64url options to buffers for the WebAuthn API
      // Buffer fields are converted by name, not by a heuristic walker: the old
      // `convertBase64ToBuffers` skipped every `id` (because `rp.id` is a plain domain
      // string), so `user.id` reached the browser as base64url text and the API threw
      // "not of type (ArrayBuffer or ArrayBufferView)". The spec names exactly these
      // four buffer fields, so listing them is correct and boring.
      const publicKey: PublicKeyCredentialCreationOptions = {
        ...options,
        challenge: this.base64UrlToBuffer(options.challenge),
        user: {
          ...options.user,
          id: this.base64UrlToBuffer(options.user.id),
        },
        excludeCredentials: (options.excludeCredentials || []).map((cred: any) => ({
          ...cred,
          id: this.base64UrlToBuffer(cred.id),
        })),
      }

      // Step 3: Create the credential via the browser's WebAuthn API
      const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential

      if (!credential) {
        throw new Error('Passkey creation was cancelled or failed')
      }

      // Step 4: Serialize the credential response to send to the server
      const serializedCredential = this.convertBuffersToBase64({
        id: credential.id,
        rawId: credential.rawId,
        type: credential.type,
        response: {
          clientDataJSON: credential.response.clientDataJSON,
          attestationObject: (credential.response as AuthenticatorAttestationResponse).attestationObject,
          transports: (credential.response as AuthenticatorAttestationResponse).getTransports?.() || ['internal'],
          deviceName: (credential as any).deviceName || 'Passkey',
        },
      })

      // Step 5: Verify on the server and store the credential
      const result = await this.firestore.callFunction<
        { credential: any },
        { success: boolean; credentialId: string; credentialName: string }
      >('verifyWebAuthnRegistration', { credential: serializedCredential })

      if (result.success) {
        // Security-adoption signal. The disable side of MFA was instrumented and this
        // was not, so "how many accounts added a passkey" had no answer at all.
        this.analytics.trackEvent('passkey_added', { credentialId: result.credentialId })
          .subscribe({ error: () => undefined })
        // Refresh the passkey list
        await this.loadPasskeys()
        return true
      }

      return false
    } catch (error: any) {
      console.error('Failed to register passkey:', error)
      const msg = error?.message || ''
      if (msg.includes('cancelled') || msg.includes('canceled') || msg.includes('not allowed')) {
        this.error.set('Passkey registration was cancelled.')
      } else {
        this.error.set(msg || 'Failed to register passkey.')
      }
      return false
    } finally {
      this.isRegistering.set(false)
    }
  }

  /**
   * Authenticate using an existing passkey.
   * Returns true if verified.
   */
  async authenticateWithPasskey(): Promise<{ verified: boolean; customToken: string }> {
    this.isAuthenticating.set(true)
    this.error.set('')

    try {
      // Step 1: Get authentication options from the server
      const { options } = await this.firestore.callFunction<
        void,
        { success: boolean; options: any }
      >('generateWebAuthnAuthenticationOptions')

      // Step 2: Convert base64url options to buffers
      const publicKey: PublicKeyCredentialRequestOptions = {
        ...options,
        challenge: this.base64UrlToBuffer(options.challenge),
        allowCredentials: (options.allowCredentials || []).map((cred: any) => ({
          ...cred,
          id: this.base64UrlToBuffer(cred.id),
        })),
      }

      // Step 3: Get the assertion from the browser's WebAuthn API
      const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential

      if (!credential) {
        throw new Error('Passkey authentication was cancelled')
      }

      // Step 4: Serialize the response
      const serializedCredential = this.convertBuffersToBase64({
        id: credential.id,
        rawId: credential.rawId,
        type: credential.type,
        response: {
          clientDataJSON: (credential.response as AuthenticatorAssertionResponse).clientDataJSON,
          authenticatorData: (credential.response as AuthenticatorAssertionResponse).authenticatorData,
          signature: (credential.response as AuthenticatorAssertionResponse).signature,
          userHandle: (credential.response as AuthenticatorAssertionResponse).userHandle,
        },
      })

      // Step 5: Verify on the server
      const result = await this.firestore.callFunction<
        { credential: any },
        { success: boolean; credentialId: string; newCounter: number; customToken?: string }
      >('verifyWebAuthnAuthentication', { credential: serializedCredential })

      // The token is empty for a step-up (the caller is already signed in) and set for a
      // sign-in, which is the only case that has a session to create.
      return { verified: result.success, customToken: result.customToken || '' }
    } catch (error: any) {
      console.error('Failed to authenticate with passkey:', error)
      const msg = error?.message || ''
      if (msg.includes('cancelled') || msg.includes('canceled') || msg.includes('not allowed')) {
        this.error.set('Passkey authentication was cancelled.')
      } else {
        this.error.set(msg || 'Failed to authenticate with passkey.')
      }
      return { verified: false, customToken: '' }
    } finally {
      this.isAuthenticating.set(false)
    }
  }

  /**
   * Load the list of registered passkeys for the current user.
   */
  async loadPasskeys(): Promise<void> {
    try {
      const { credentials } = await this.firestore.callFunction<
        void,
        { success: boolean; credentials: any[] }
      >('getWebAuthnCredentials')

      const mapped = (credentials || []).map((c) => ({
        ...c,
        createdAt: this.toDate(c.createdAt),
        lastUsedAt: this.toDate(c.lastUsedAt),
      })) as WebAuthnCredential[]

      this.passkeys.set(mapped)
    } catch (error) {
      console.error('Failed to load passkeys:', error)
    }
  }

  /** Convert Firestore Timestamp-like object or ISO string to Date */
  private toDate(val: any): Date {
    if (val && typeof val === 'object' && 'seconds' in val) {
      return new Date((val as { seconds: number; nanoseconds?: number }).seconds * 1000)
    }
    if (val && typeof val === 'object' && '_seconds' in val) {
      return new Date((val as { _seconds: number })._seconds * 1000)
    }
    if (typeof val === 'string') {
      return new Date(val)
    }
    if (val instanceof Date) {
      return val
    }
    return new Date(0)
  }

  /**
   * Remove a passkey credential.
   */
  async removePasskey(credentialDocId: string): Promise<boolean> {
    try {
      const result = await this.firestore.callFunction<
        { credentialDocId: string },
        { success: boolean }
      >('removeWebAuthnCredential', { credentialDocId })

      if (result.success) {
        this.passkeys.update((keys) => keys.filter((k) => k.id !== credentialDocId))
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to remove passkey:', error)
      return false
    }
  }
}
