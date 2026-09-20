import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LucideAngularModule } from 'lucide-angular';
import { TranslateModule } from '@ngx-translate/core';
import { RadioToggleComponent } from 'src/app/core/components';
import { myIcons, LangPickerComponent, ThemeToggleComponent } from 'src/app/shared';
import { NotificationService, type PushState } from '../../../../core/services/notification.service';

@Component({
  selector: 'app-general-tab',
  imports: [TranslateModule, ReactiveFormsModule, LucideAngularModule, RadioToggleComponent, LangPickerComponent, ThemeToggleComponent],
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

  // ponytail: plain English rather than new i18n keys — the copy is UI-specific and
  // each locale catalogue would need four new entries. Move to SETTINGS_GENERAL.PUSH_*
  // if the push settings ever need translating.
  private static readonly STATUS_LABELS: Record<PushState, string> = {
    unsupported: 'This browser does not support push notifications.',
    unconfigured: 'Push is not configured for this build.',
    default: 'Get notified when a crawl finishes or a job needs attention.',
    blocked: 'Notifications are blocked. Allow them in your browser site settings.',
    subscribed: 'This device will receive push notifications.',
    error: 'Push notifications could not be updated.',
  };

  readonly statusLabel = computed(() => GeneralTabComponent.STATUS_LABELS[this.notification.status()]);

  readonly canToggle = computed(() => {
    const status = this.notification.status();
    return !this.notification.busy()
      && status !== 'unsupported'
      && status !== 'unconfigured'
      && status !== 'blocked';
  });

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
  }

  async sendTestPush(): Promise<void> {
    await this.notification.sendTest();
  }
}
