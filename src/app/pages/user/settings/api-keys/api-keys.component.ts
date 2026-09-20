import { DatePipe, AsyncPipe } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, CUSTOM_ELEMENTS_SCHEMA, DestroyRef, HostBinding, HostListener, inject, Inject, OnInit, signal, ViewChild, ViewEncapsulation  } from '@angular/core';
import { Observable, Subscription, tap, timer } from 'rxjs';
import { NAVIGATOR } from 'src/app/core/providers';
import { CheckboxComponent, ClipboardbuttonComponent, DialogComponent, PopupMenuComponent, SlideInModalComponent, StinputComponent } from 'src/app/core/components';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MatIcon } from '@angular/material/icon';
import { ApiKey, ApiKeyLoader, ApiKeyType } from 'src/app/core/types';
import { ApiKeyService, AuthService, HighRiskActionService, LocalStorage } from 'src/app/core/services';
import { Outsideclick, RippleDirective, TooltipDirective } from 'src/app/core/directives';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { themeStorageKey } from 'src/app/shared';
import { FormControlPipe } from 'src/app/core/pipes';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { Router } from '@angular/router'

@Component({
  selector: 'app-api-keys',
  imports: [DatePipe, AsyncPipe, TooltipDirective, PopupMenuComponent, ClipboardbuttonComponent, MatIcon, RippleDirective, Outsideclick, SlideInModalComponent, ReactiveFormsModule, MatProgressBarModule, CheckboxComponent, FormControlPipe, DialogComponent, TranslateModule, StinputComponent],
  templateUrl: './api-keys.component.html',
  styleUrl: './api-keys.component.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApiKeysComponent implements OnInit {

 private destroyRef = inject(DestroyRef);
  @HostBinding('class') classes = 'w-full'

  private apiKeySub: Subscription
  private localStorage: Storage = inject(LocalStorage)
  protected popupNewKeyVisible: boolean = false;
  protected apiKeys$: Observable<ApiKey[] | null>;

  protected newApiKey: FormControl<string>
  protected newApiKeyName: FormControl<string>
  protected defaultKey: FormControl<boolean>
  protected isKeyModalOpen: FormControl<boolean>
  protected keyModalTitle: string = ''
  protected apiKeyLoading: ApiKeyLoader

  protected dialogOpen = signal(false)
  protected KeyIdToDelete = signal<ApiKey>({} as ApiKey)
  protected revealSecurityOpen = new FormControl<boolean>(false, { nonNullable: true })
  protected revealPassword = new FormControl<string>('', { nonNullable: true, validators: [Validators.required] })
  protected revealPendingKey = signal<ApiKey | null>(null)
  protected revealSecurityError = signal<string>('')
  protected revealSecurityMode = signal<'password' | 'mfa-required' | 'mfa-enroll-required'>('password')
  protected revealSecurityLoading = false
  private cdr = inject(ChangeDetectorRef)
  private highRiskActionService = inject(HighRiskActionService)
  private translate = inject(TranslateService)

  constructor(
    private apiKeyService: ApiKeyService,
    private authService: AuthService,
    private router: Router,
    @Inject(NAVIGATOR) private navigator: Navigator
  ) {

    this.apiKeyLoading = { modal: false, visibility: {} }

    this.apiKeys$ = this.apiKeyService.apiKeys$.pipe(
      tap((key: ApiKey[] | null) => {

        if (key && key.length) {

          key.map(key => this.apiKeyLoading.visibility[key.id] = false)
        }
      })
    );

    this.isKeyModalOpen = new FormControl<boolean>(false, { nonNullable: true })

    this.defaultKey = new FormControl<boolean>(true, { nonNullable: true, validators: [Validators.required] })
    this.newApiKey = new FormControl<string>('', { nonNullable: true, validators: [Validators.required] })
    this.newApiKeyName = new FormControl<string>('', { nonNullable: true, validators: [Validators.required] })
  }

  ngOnInit(): void {
  }

  generateApiKey() {
    // open the popupmenu
    this.popupNewKeyVisible = true
  }

  deleteApiKey(key: ApiKey) {
    if (!key || !key.id) return
    console.log('deleting key', key)
    this.apiKeySub = this.apiKeyService.deleteApiKey(key)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.closePopupMenu(new Event(''), key)
          this.dialogOpen.set(false)
          this.cdr.detectChanges()
        },
        error: (error) => {
          console.error('Error deleting API key:', error)
          this.cdr.detectChanges()
        },
      })
  }
  disableApiKey(key: ApiKey) {
    timer(500)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.closePopupMenu(new Event(''), key);
        this.cdr.detectChanges()
      })
    throw new Error('Method not implemented.');
  }

  copyToClipboard(key: ApiKey) {
    this.navigator.clipboard.writeText(key.key).then(() => {
      // Optional: Show a toast or snackbar to indicate successful copy
      console.log('API Key copied to clipboard');
      timer(500)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.closePopupMenu(new Event(''), key);
        this.cdr.detectChanges()
      })
    }).catch(err => {
      console.error('Failed to copy API key: ', err);
    });
  }
  async toggleKeyVisibility(key: ApiKey) {
    if (!key || !key.id) {
      return
    }

    if (!key.visibility) {
      const verified = await this.highRiskActionService.ensureVerified('api_key_reveal')
      if (!verified) {
        this.cdr.detectChanges()
        return
      }
    }

    if (!key.visibility) {
      this.revealPendingKey.set(key)
    }

    const keyId = key.id as string
    this.apiKeyLoading.visibility[keyId] = true

    this.apiKeySub = this.apiKeyService.setKeyVisible(key)
      .subscribe({
        next: (currentKeys: ApiKey) => {
          console.log(currentKeys)
        },
        error: (err: any) => {
          console.error(err)

          if (err?.code === 'RECENT_AUTH_REQUIRED') {
            this.revealSecurityMode.set('password')
            this.revealSecurityOpen.setValue(true)
            this.revealSecurityError.set(this.translate.instant('SETTINGS_API_KEYS.ERR_CONFIRM_PASSWORD'))
          } else if (err?.code === 'MFA_REQUIRED') {
            this.revealSecurityMode.set('mfa-required')
            this.revealSecurityOpen.setValue(true)
            this.revealSecurityError.set(this.translate.instant('SETTINGS_API_KEYS.ERR_MFA_REQUIRED'))
          } else if (err?.code === 'MFA_ENROLL_REQUIRED') {
            this.revealSecurityMode.set('mfa-enroll-required')
            this.revealSecurityOpen.setValue(true)
            this.revealSecurityError.set(this.translate.instant('SETTINGS_API_KEYS.ERR_MFA_ENROLL_REQUIRED'))
          }

          this.apiKeyLoading.visibility[keyId] = false
          this.cdr.detectChanges()
        }, complete: () => {
          this.apiKeyLoading.visibility[keyId] = false
          this.cdr.detectChanges()
        }
      })
  }
 
  toggleMenuVisible(key: ApiKey) {
    console.log('toggling menu visible', key)
    this.apiKeyService.setMenuVisible(key);
  }

  addApiKey(type: string) {
    this.closePopupNewKey()
    this.keyModalTitle = type
    this.isKeyModalOpen.setValue(true, { emitEvent: true })
    console.log(this.isKeyModalOpen.value)
  }

  clearKeysInput() {

    this.newApiKeyName.setValue('')
    this.newApiKey.setValue('')
  }

  closePopupMenu(event: Event, key: ApiKey) {

    /* const element = event.target as HTMLElement
    console.log(element) */

    if (!key.menu_visible) return

    // this.apiKeyService.setMenuVisible(key)
  }

  closePopupNewKey() {
    this.popupNewKeyVisible = false;
  }

  keyModalCompleted() {

    if (!this.newApiKeyName.valid || !this.newApiKey.valid) return

    // set the loading state
    this.apiKeyLoading.modal = true

    // get the apiKey type from title
    const type = this.keyModalTitle.toLowerCase() as ApiKeyType

    // create a fake key to hide the real key
    const startFrom = 6
    const fakeKey = this.apiKeyService.generateFakeKey(this.newApiKey.value.length - startFrom, startFrom - 1)

    // generate the real key
    const newKey = this.apiKeyService.generateApiKey(this.newApiKeyName.value, this.newApiKey.value,
      this.newApiKey.value.substring(0, startFrom) + fakeKey, type, this.defaultKey.value)

    // subscribe
    this.apiKeySub = newKey
      .subscribe({
        next: (fun) => {

          console.log(fun)

        },
        error: (error) => {
          console.error('Error creating API key:', error);

          // set the loading state
          this.apiKeyLoading.modal = false

          // reset the input field in modal
          this.clearKeysInput()
          this.cdr.detectChanges()
        },
        complete: () => {
          this.apiKeyLoading.modal = false
          // reset the input field in modal
          this.clearKeysInput()

          // close the modal
          this.isKeyModalOpen?.setValue(!this.isKeyModalOpen?.value)
          this.cdr.detectChanges()
        }
      })

  }

  protected openDialog(key: ApiKey) {
      this.KeyIdToDelete.set(key)
      this.dialogOpen.set(true)
  }

  protected cancelRevealSecurityStep(): void {
    this.revealSecurityOpen.setValue(false)
    this.revealPassword.setValue('')
    this.revealSecurityError.set('')
    this.revealSecurityMode.set('password')
    this.revealSecurityLoading = false
    this.revealPendingKey.set(null)
    this.cdr.detectChanges()
  }

  protected confirmRevealSecurityStep(): void {
    if (this.revealSecurityMode() !== 'password') {
      return
    }

    if (this.revealPassword.invalid || this.revealSecurityLoading) {
      return
    }

    const pendingKey = this.revealPendingKey()
    if (!pendingKey) {
      return
    }

    this.revealSecurityLoading = true
    this.revealSecurityError.set('')

    void this.authService.reauthenticateWithPassword(this.revealPassword.value)
      .then(() => {
        this.revealSecurityLoading = false
        this.revealSecurityOpen.setValue(false)
        this.revealPassword.setValue('')
        this.revealSecurityError.set('')
        this.revealSecurityMode.set('password')
        this.toggleKeyVisibility(pendingKey)
        this.cdr.detectChanges()
      })
      .catch((error: any) => {
        console.error('Sensitive action reauthentication failed:', error)
        this.revealSecurityLoading = false
        this.revealSecurityError.set(error?.message || this.translate.instant('SETTINGS_API_KEYS.ERR_PASSWORD_CONFIRM_FAILED'))
        this.cdr.detectChanges()
      })
  }

  protected goToSecuritySettings(): void {
    this.cancelRevealSecurityStep()
    void this.router.navigate(['/settings/security'])
  }

  onCheckBoxChange() {
    console.log(this.defaultKey.value)
    // this.defaultKey.setValue(!this.defaultKey.value)
  }

  themeIsDark() {

    return this.localStorage?.getItem(themeStorageKey) === 'true'
  }

  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.
    this.apiKeySub?.unsubscribe()
  }


}


