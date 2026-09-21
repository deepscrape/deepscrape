import { Injectable, inject } from '@angular/core'
import { Router } from '@angular/router'
import { firstValueFrom } from 'rxjs'
import { AuthService } from './auth.service'
import { DeviceVerificationService } from './device-verification.service'
import { WebAuthnService } from './webauthn.service'

@Injectable({
  providedIn: 'root',
})
export class HighRiskActionService {
  private authService = inject(AuthService)
  private deviceVerificationService = inject(DeviceVerificationService)
  private webAuthnService = inject(WebAuthnService)
  private router = inject(Router)

  async ensureVerified(action: 'unlink_provider' | 'api_key_reveal' | 'billing_change' | 'login'): Promise<boolean> {
    const user = await firstValueFrom(this.authService.user$, { defaultValue: null })
    if (!user?.uid) {
      return false
    }

    const fingerprint = this.deviceVerificationService.getDeviceFingerprint()
    const alreadyTrusted = await this.deviceVerificationService.isDeviceTrusted(user.uid, fingerprint)
    if (alreadyTrusted) {
      // The device is recognised. If the account also holds a passkey, prove possession of
      // it: the assertion is verified server-side against the stored public key, so it is
      // the strongest factor available here — and the only reason enrolling one matters.
      return this.ensurePasskeyStepUp()
    }

    // Device not trusted — redirect to the verification page.
    // After the user verifies, they will be redirected back to returnUrl.
    // The caller will cancel the current operation when we return false,
    // and the user can retry once the device is trusted.
    await this.router.navigate(['/service/device-verification'], {
      queryParams: { action, returnUrl: this.router.url },
    })
    return false
  }

  /**
   * Require a fresh passkey assertion when the account has one enrolled.
   *
   * Returns true when the action may proceed: either no passkey is enrolled (enrolment is
   * optional, so this must never block someone who declined), or the assertion verified.
   *
   * @return {Promise<boolean>} Whether the caller may proceed.
   */
  private async ensurePasskeyStepUp(): Promise<boolean> {
    try {
      await this.webAuthnService.loadPasskeys()
    } catch {
      // ponytail: fail open. The device-trust gate above already passed and enrolment is
      // optional, so a failure to enumerate must not brick billing. Revisit if passkeys
      // become mandatory, which is when this needs to fail closed.
      return true
    }

    if (this.webAuthnService.passkeys().length === 0) {
      return true
    }

    const { verified } = await this.webAuthnService.authenticateWithPasskey()
    return verified
  }
}