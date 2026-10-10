import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LucideAngularModule } from 'lucide-angular';
import { TranslateModule } from '@ngx-translate/core';
import { RadioToggleComponent } from 'src/app/core/components';
import { myIcons } from 'src/app/shared/lucideicons';
import { firstValueFrom } from 'rxjs';
import { LangPickerComponent } from 'src/app/shared/lang-picker/lang-picker.component';
import { ThemeToggleComponent } from 'src/app/shared/theme-picker/theme-picker.component';
import { BillingPolicyService } from '../../../../core/services/billing-policy.service';
import { FirestoreService } from '../../../../core/services/firestore.service';
import { NotificationService, type PushState } from '../../../../core/services/notification.service';
import { AiKeysComponent } from '../../../../core/components/ai-keys/ai-keys.component';

@Component({
  selector: 'app-general-tab',
  imports: [TranslateModule, ReactiveFormsModule, LucideAngularModule, RadioToggleComponent, LangPickerComponent, ThemeToggleComponent, AiKeysComponent],
  templateUrl: './general.component.html',
  styleUrls: ['./general.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GeneralTabComponent {
  readonly icons = myIcons;
  readonly notification = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  /** Custom radio toggle doubles as the push enable/disable control. */
  readonly pushControl = new FormControl<boolean>(this.notification.isSubscribed(), { nonNullable: true });

  /**
   * The push status line, as i18n KEYS.
   *
   * These were literal English sentences, carried on a note that said to move
   * them here "if the push settings ever need translating". They are the one
   * line under RECEIVE_NOTIFICATIONS, so they are on screen for every visitor
   * to this page, in every locale — which is what "the push settings need
   * translating" looks like once it happens. The template pipes the key
   * through `translate`.
   */
  private static readonly STATUS_LABEL_KEYS: Record<PushState, string> = {
    unsupported: 'SETTINGS_GENERAL.PUSH_UNSUPPORTED',
    unconfigured: 'SETTINGS_GENERAL.PUSH_UNCONFIGURED',
    default: 'SETTINGS_GENERAL.PUSH_DEFAULT',
    blocked: 'SETTINGS_GENERAL.PUSH_BLOCKED',
    subscribed: 'SETTINGS_GENERAL.PUSH_SUBSCRIBED',
    error: 'SETTINGS_GENERAL.PUSH_ERROR',
  };

  /** An i18n KEY, not a sentence: the template translates it at render time. */
  readonly statusLabel = computed(() => GeneralTabComponent.STATUS_LABEL_KEYS[this.notification.status()]);

  readonly canToggle = computed(() => {
    const status = this.notification.status();
    return !this.notification.busy()
      && status !== 'unsupported'
      && status !== 'unconfigured'
      && status !== 'blocked';
  });

  // --- Alerts --------------------------------------------------------------

  /**
   * The email-alert preference, written through the
   * `setMyNotificationPreference` callable.
   *
   * Starts `false` and is corrected by `loadAlerts()`, because the server owns
   * the default: a control that started `true` would advertise a preference the
   * account does not have for as long as the request takes. Every alert
   * preference is an OPT IN, so a customer who never opens this page receives no
   * mail — the only safe default for something that costs money and domain
   * reputation.
   */
  readonly spendCapEmailControl = new FormControl<boolean>(false, { nonNullable: true });
  readonly alertsLoading = signal(true);
  /** An i18n KEY, not a sentence: the message is translated at render time. */
  readonly alertsError = signal('');
  private readonly fireService = inject(FirestoreService);
  private readonly policyService = inject(BillingPolicyService);

  // --- Spend cap -----------------------------------------------------------

  /**
   * The cap in CREDITS. `null` is an empty input, which saves as `0` = no cap.
   * Starts `null` and is only RENDERED once the policy read succeeds, because an
   * empty box means "no cap" and showing one after a failed read would state a
   * limit the account may well have.
   */
  readonly spendCapControl = new FormControl<number | null>(null);
  /** Set only by a successful policy read, so the row is never a guess. */
  readonly spendCapReady = signal(false);
  /** Credits spent this period. `null` when the counter read failed. */
  readonly spendCapSpent = signal<number | null>(null);
  readonly spendCapSaving = signal(false);
  readonly spendCapSaved = signal(false);

  constructor() {
    // Mirror service state into the toggle (no event echo, so no feedback loop)
    // and lock it while an update is in flight or permission is unavailable.
    effect(() => {
      const subscribed = this.notification.isSubscribed();
      if (this.pushControl.value !== subscribed) {
        this.pushControl.setValue(subscribed, { emitEvent: false });
      }
      if (this.canToggle()) {
        this.pushControl.enable({ emitEvent: false });
      } else {
        this.pushControl.disable({ emitEvent: false });
      }
    });

    this.pushControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((enable) => void (enable ? this.notification.enable() : this.notification.disable()));

    // Save on change. Both programmatic writes below pass `emitEvent: false`,
    // and that is what stops this firing on a value the user did not choose:
    // without it, the revert in `saveAlertPreference` would echo straight back
    // to the server, forever.
    this.spendCapEmailControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((enabled) => void this.saveAlertPreference('spendCapEmail', enabled));

    // The cap is NOT save-on-change (see `saveSpendCap`), so the button reports
    // its own result and this clears that report as soon as the value moves.
    this.spendCapControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.spendCapSaved.set(false));

    void this.loadAlerts();
  }

  async sendTestPush(): Promise<void> {
    await this.notification.sendTest();
  }

  /**
   * Read the caller's stored alert preferences and spend cap.
   * @return {Promise<void>} Nothing.
   */
  private async loadAlerts(): Promise<void> {
    this.alertsError.set('');

    // Settled, not `all`: these are two different reads, and letting a policy
    // failure blank the email toggle would report one fault as two.
    const [prefs, policy] = await Promise.allSettled([
      this.fireService.callFunction<
        Record<string, never>,
        { preferences: { spendCapEmail: boolean } }
      >('getMyNotificationPreferences', {}),
      firstValueFrom(this.policyService.get()),
    ]);

    if (prefs.status === 'fulfilled') {
      this.spendCapEmailControl.setValue(
        prefs.value.preferences?.spendCapEmail === true,
        { emitEvent: false },
      );
    }

    if (policy.status === 'fulfilled') {
      this.spendCapControl.setValue(
        policy.value.policy?.spendCapCredits ?? null,
        { emitEvent: false },
      );
      // `?? null` rather than `?? 0`: a failed counter read is not a spend of zero,
      // and the route distinguishes the two by sending `null` only on failure.
      this.spendCapSpent.set(policy.value.window?.spentCredits ?? null);
      this.spendCapReady.set(true);
    }

    if (prefs.status === 'rejected' || policy.status === 'rejected') {
      // A failed READ is reported, never rendered as "off" or "no cap". An
      // unchecked control would tell the customer that a preference they never
      // saw is their current state, and their next toggle would be a guess.
      this.alertsError.set('SETTINGS_ALERTS.LOAD_FAILED');
    }

    this.alertsLoading.set(false);
  }

  /**
   * Persist the spend cap.
   *
   * Explicitly NOT save-on-change, and that is a money decision rather than a
   * style one: a number input emits per keystroke, so typing `100` would PUT `1`,
   * then `10`, then `100` and store each in turn. The first two are a cap the
   * customer never chose, and a running session is stopped against one.
   * @return {Promise<void>} Nothing.
   */
  async saveSpendCap(): Promise<void> {
    this.alertsError.set('');
    this.spendCapSaving.set(true);

    const typed = this.spendCapControl.value;
    // Empty or malformed CLEARS the cap: the route reads `0` as no cap, which is
    // the documented way to remove one, so there is no DELETE to call.
    const cap = typeof typed === 'number' && Number.isInteger(typed) && typed >= 0
      ? typed
      : 0;

    try {
      await firstValueFrom(this.policyService.set({ spendCapCredits: cap }));
      this.spendCapSaved.set(true);
    } catch {
      this.alertsError.set('SETTINGS_ALERTS.SAVE_FAILED');
    } finally {
      this.spendCapSaving.set(false);
    }
  }

  /**
   * Persist one alert preference.
   * @param {string} key The preference key.
   * @param {boolean} enabled The desired value.
   * @return {Promise<void>} Nothing.
   */
  private async saveAlertPreference(key: string, enabled: boolean): Promise<void> {
    this.alertsError.set('');
    try {
      await this.fireService.callFunction<
        { key: string; enabled: boolean },
        { key: string; enabled: boolean }
      >('setMyNotificationPreference', { key, enabled });
    } catch {
      this.alertsError.set('SETTINGS_ALERTS.SAVE_FAILED');
      // Put the control back: it currently disagrees with the server, so leaving
      // it would show a preference that was never stored.
      this.spendCapEmailControl.setValue(!enabled, { emitEvent: false });
    }
  }
}
