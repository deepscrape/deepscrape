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
import { ComputeService } from '../../../../core/services/compute.service';
import { EgressService } from '../../../../core/services/egress.service';
import type { ComputeSource, ComputeWrite, EgressMode, EgressWrite } from '../../../../core/types/webrain-config.interface';

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
  /** The caller's own egress pool, so this page can move it the way it moves the cap. */
  private readonly egress = inject(EgressService);
  /** The caller's own Fly organization -- the OTHER BYO axis, and a separate one. */
  private readonly compute = inject(ComputeService);

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

  /**
   * The egress proxies as TEXT, one per line.
   *
   * A textarea rather than a row-per-entry editor: the server stores a flat list
   * of URLs and never returns them, so a row editor would have to invent an
   * identity for entries that have none -- and a proxy URL's identity is the
   * credential it carries.
   */
  readonly egressUrlsControl = new FormControl('', { nonNullable: true });

  private readonly egressHasCredentials = signal(false);
  private readonly egressExitCount = signal(0);

  /** Which pool is in force, as the SERVER answered it. */
  readonly egressMode = signal<EgressMode>('platform');

  /** The read succeeded, so the rows may be rendered at all. */
  readonly egressReady = signal(false);

  readonly egressLoading = signal(true);
  readonly egressSaving = signal(false);

  /** An i18n KEY, never a sentence -- the template translates it at render time. */
  readonly egressError = signal('');

  /**
   * Configured, but the server could not read the pool.
   *
   * `hasCredentials` with ZERO exits is the only shape that state can take: the
   * pointer says a pool is stored, and an empty projection of it means it did
   * not resolve. Those calls are REFUSED rather than quietly moved onto the
   * platform pool, so this row is the only place a caller could find out.
   */
  readonly egressBroken = computed(() =>
    this.egressMode() === 'byo'
      && this.egressHasCredentials()
      && this.egressExitCount() === 0,
  );

  /**
   * The caller's own Fly app, region and token, as TEXT.
   *
   * The token control is never filled from the reply, and that is not an
   * oversight: the server stores it in Secret Manager behind a pointer and never
   * returns it, so saving REPLACES it and the field is re-entered every time.
   * The app control IS filled, because an app name is not a credential.
   */
  readonly computeAppControl = new FormControl('', { nonNullable: true });
  readonly computeRegionControl = new FormControl('', { nonNullable: true });
  readonly computeTokenControl = new FormControl('', { nonNullable: true });

  private readonly computeHasCredentials = signal(false);
  private readonly computeApp = signal('');

  /** Which organization is in force, as the SERVER answered it. */
  readonly computeMode = signal<ComputeSource>('platform');

  /** The read succeeded, so the fields may be rendered at all. */
  readonly computeReady = signal(false);

  readonly computeLoading = signal(true);
  readonly computeSaving = signal(false);

  /** An i18n KEY, never a sentence -- the template translates it at render time. */
  readonly computeError = signal('');

  /**
   * Configured, but the server could not read the config.
   *
   * `hasCredentials` with an EMPTY app is the only shape that state can take:
   * the pointer says a config is stored, and an empty projection of it means it
   * did not resolve. Those operations are REFUSED rather than moved into the
   * platform's organization, so this row is the only place a caller could learn.
   */
  readonly computeBroken = computed(() =>
    this.computeMode() === 'byo'
      && this.computeHasCredentials()
      && this.computeApp().length === 0,
  );

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
    // A second, INDEPENDENT read. The two need no shared error channel: each has
    // its own `ready` flag, so one failing cannot blank the other's rows.
    void this.loadEgress();
    // A third, independent for the same reason: compute and egress are separate
    // axes, so one failing must not blank the other's fields.
    void this.loadCompute();
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

  /**
   * Read the caller's own egress configuration.
   *
   * The textarea is deliberately NOT filled from the reply, and that is not an
   * oversight: both routes mask the pool down to `host:port`, so there is no URL
   * for the server to hand back. Leaving the box empty is the honest rendering of
   * that -- pre-filling it with masked hosts would invite a save that silently
   * replaces a working pool with unparseable hostnames.
   * @return {Promise<void>} Nothing.
   */
  private async loadEgress(): Promise<void> {
    this.egressError.set('');

    try {
      const settings = await firstValueFrom(this.egress.get());
      this.applyEgress(settings.mode, settings.hasCredentials, settings.exits.length);
    } catch {
      // A failed READ is reported, never rendered as the platform default: that
      // default is exactly what a caller with their own exits is trying to
      // LEAVE, so showing it would state the opposite of their account's state.
      this.egressError.set('SETTINGS_EGRESS.LOAD_FAILED');
    } finally {
      this.egressLoading.set(false);
    }
  }

  /**
   * Persist the typed proxies as the caller's own pool.
   *
   * NOT save-on-change, for the same reason the spend cap is not: a textarea
   * emits on every keystroke, and the write REPLACES the pool -- so a save per
   * input could retire a working exit in the middle of an edit.
   * @return {Promise<void>} Nothing.
   */
  async saveEgress(): Promise<void> {
    const urls = this.egressUrlsControl.value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // Refused HERE rather than sent. The route rejects an empty list (for an
    // OPERATOR that would silently move every caller onto a direct exit), and its
    // refusal names an entry INDEX -- which for an empty box is meaningless to
    // the person reading it.
    if (urls.length === 0) {
      this.egressError.set('SETTINGS_EGRESS.EMPTY');
      return;
    }

    await this.writeEgress({ mode: 'byo', proxies: urls });
  }

  /**
   * Go back to the platform's exits.
   *
   * A distinct action from saving an empty box, because the two mean different
   * things: this STATES the intent, and the route purges the stored secret with
   * it -- so "I removed my proxy" is true rather than merely unevaluated.
   * @return {Promise<void>} Nothing.
   */
  async usePlatformPool(): Promise<void> {
    await this.writeEgress({ mode: 'platform' });
  }

  /**
   * One write, in one place.
   *
   * The reply IS the new state, so it is applied rather than re-read: a second
   * GET would be a round trip to learn something the write already answered.
   * @param {EgressWrite} write The request body.
   * @return {Promise<void>} Nothing.
   */
  private async writeEgress(write: EgressWrite): Promise<void> {
    this.egressError.set('');
    this.egressSaving.set(true);

    try {
      const settings = await firstValueFrom(this.egress.set(write));
      this.applyEgress(settings.mode, settings.hasCredentials, settings.exits.length);

      // Emptied after EVERY successful write, not only after a clear: the box
      // would otherwise be sitting on proxy passwords the user has stopped
      // looking at, and the status line above already confirms the write landed.
      this.egressUrlsControl.setValue('', { emitEvent: false });
    } catch {
      this.egressError.set('SETTINGS_EGRESS.SAVE_FAILED');
    } finally {
      this.egressSaving.set(false);
    }
  }

  /**
   * The four pieces of egress state, applied together.
   *
   * One place, because the read and the write must leave the view in the same
   * shape -- and a partial application would render a mode beside a count from a
   * different answer.
   * @param {EgressMode} mode Which pool is in force.
   * @param {boolean} hasCredentials Whether a pointer is stored.
   * @param {number} exits How many exits the pool projected to.
   * @return {void}
   */
  private applyEgress(mode: EgressMode, hasCredentials: boolean, exits: number): void {
    this.egressMode.set(mode);
    this.egressHasCredentials.set(hasCredentials);
    this.egressExitCount.set(exits);
    this.egressReady.set(true);
  }

  /**
   * Read the caller's own compute configuration.
   *
   * The APP is filled from the reply; the TOKEN is not, and cannot be. An app
   * name is no credential, so rendering it lets a caller confirm WHICH
   * organization they configured -- while the token lives in Secret Manager and
   * is never returned, so its field stays empty and a save replaces it.
   * @return {Promise<void>} Nothing.
   */
  private async loadCompute(): Promise<void> {
    this.computeError.set('');

    try {
      const settings = await firstValueFrom(this.compute.get());
      this.applyCompute(settings.mode, settings.hasCredentials, settings.app);
      this.computeRegionControl.setValue(settings.region, { emitEvent: false });
    } catch {
      // A failed READ is reported, never rendered as the platform default: that
      // default is what a caller with their own organization is trying to LEAVE,
      // so showing it would state the opposite of their account's state.
      this.computeError.set('SETTINGS_COMPUTE.LOAD_FAILED');
    } finally {
      this.computeLoading.set(false);
    }
  }

  /**
   * Persist the typed app, region and token as the caller's own organization.
   *
   * NOT save-on-change, for the reason the egress box gives: a text field emits
   * on every keystroke and the write REPLACES the stored token, so a save per
   * input could destroy a working credential mid-edit.
   * @return {Promise<void>} Nothing.
   */
  async saveCompute(): Promise<void> {
    const app = this.computeAppControl.value.trim();
    const region = this.computeRegionControl.value.trim();
    const token = this.computeTokenControl.value.trim();

    // Refused HERE rather than sent. The route requires both fields, and its
    // refusal does not say which one is missing -- from its side an empty app and
    // an empty token are the same sentence, while from the caller's they are two
    // different mistakes.
    if (app.length === 0 || token.length === 0) {
      this.computeError.set('SETTINGS_COMPUTE.MISSING');
      return;
    }

    await this.writeCompute({ mode: 'byo', app, token, region });
  }

  /**
   * Go back to the platform's own Fly organization.
   *
   * A distinct action from saving an empty form, because the two mean different
   * things: this STATES the intent, and the route purges the stored secret with
   * it -- so "I removed my token" is true rather than merely unevaluated.
   * @return {Promise<void>} Nothing.
   */
  async usePlatformMachines(): Promise<void> {
    await this.writeCompute({ mode: 'platform' });
  }

  /**
   * One write, in one place.
   *
   * The reply IS the new state, so it is applied rather than re-read: a second
   * GET would be a round trip to learn something the write already answered.
   * @param {ComputeWrite} write The request body.
   * @return {Promise<void>} Nothing.
   */
  private async writeCompute(write: ComputeWrite): Promise<void> {
    this.computeError.set('');
    this.computeSaving.set(true);

    try {
      const settings = await firstValueFrom(this.compute.set(write));
      this.applyCompute(settings.mode, settings.hasCredentials, settings.app);
      this.computeRegionControl.setValue(settings.region, { emitEvent: false });

      // Emptied after EVERY successful write, not only after a clear: the field
      // would otherwise be sitting on a token the user has stopped looking at,
      // and the status line above already confirms the write landed.
      this.computeTokenControl.setValue('', { emitEvent: false });
    } catch {
      this.computeError.set('SETTINGS_COMPUTE.SAVE_FAILED');
    } finally {
      this.computeSaving.set(false);
    }
  }

  /**
   * The four pieces of compute state, applied together.
   *
   * One place, because the read and the write must leave the view in the same
   * shape -- and a partial application would render a mode beside an app taken
   * from a different answer.
   *
   * `app` is held as its own signal rather than read back off the control, and
   * that is the difference between a warning and a flicker: the control is
   * user-editable, so a broken config would stop reading as broken the moment
   * someone began typing a replacement.
   * @param {ComputeSource} mode Which organization is in force.
   * @param {boolean} hasCredentials Whether a pointer is stored.
   * @param {string} app The app the config projected to, empty when it did not.
   * @return {void}
   */
  private applyCompute(mode: ComputeSource, hasCredentials: boolean, app: string): void {
    this.computeMode.set(mode);
    this.computeHasCredentials.set(hasCredentials);
    this.computeApp.set(app);
    this.computeAppControl.setValue(app, { emitEvent: false });
    this.computeReady.set(true);
  }
}
