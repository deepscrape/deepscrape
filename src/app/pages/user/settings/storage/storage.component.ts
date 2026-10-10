import { NgClass } from '@angular/common'
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { FormControl } from '@angular/forms'
import { MatIcon } from '@angular/material/icon'
import { TranslateModule } from '@ngx-translate/core'
import { DropdownComponent, SavedFilesListComponent, StinputComponent } from 'src/app/core/components'
import { FormControlPipe } from 'src/app/core/pipes'
import { BucketStorageService } from 'src/app/core/services'
import { StorageMode, StorageSettingsRequest } from 'src/app/core/types'

/**
 * Settings > Storage: where files go, and what has already been saved.
 *
 * The credential rule, in one place
 * ---------------------------------
 * `accessKeyControl` and `secretKeyControl` are WRITE-ONLY. They are created
 * empty, read once inside `saveSettings` to build the outgoing body, and then
 * cleared. Nothing else reads them:
 *
 *  - no `value` binding and no read-back: the server's reply is
 *    `hasCredentials: boolean`, and this component stores only that boolean;
 *  - no interp showing a control's value, and no "show"/"reveal" control: the
 *    inputs are `type="password"` with labels that are not the literal
 *    `Password`, so the shared input's password-toggle heuristic stays inert;
 *  - no log line, no error message and no state carries the text.
 *
 * That is the same shape `AiKeysService` uses ("NEVER RENDER KEY MATERIAL"),
 * and the reason `bucketControl` IS allowed to round-trip: a bucket name is
 * configuration, not a credential.
 */
@Component({
  selector: 'app-storage-settings',
  imports: [
    NgClass,
    TranslateModule,
    MatIcon,
    DropdownComponent,
    StinputComponent,
    SavedFilesListComponent,
    FormControlPipe,
  ],
  templateUrl: './storage.component.html',
  styleUrl: './storage.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StorageTabComponent implements OnInit {
  private readonly storage = inject(BucketStorageService)

  protected readonly modeOptions: { name: string; code: string }[] = [
    { name: 'STORAGE.MODE_PLATFORM', code: 'platform' },
    { name: 'STORAGE.MODE_BYOB', code: 'byob' },
  ]

  protected readonly modeControl = new FormControl<{ name: string; code: string }>(
    this.modeOptions[0],
    { nonNullable: true }
  )

  /** Configuration, not a credential, so round-tripping it is allowed. */
  protected readonly bucketControl = new FormControl<string>('', { nonNullable: true })
  protected readonly endpointControl = new FormControl<string>('', { nonNullable: true })

  /** WRITE-ONLY. Created empty, read once on submit, cleared. See the class doc. */
  protected readonly accessKeyControl = new FormControl<string>('', { nonNullable: true })
  protected readonly secretKeyControl = new FormControl<string>('', { nonNullable: true })

  protected readonly mode = signal<StorageMode>('platform')
  protected readonly hasCredentials = signal(false)
  protected readonly loading = signal(true)
  protected readonly saving = signal(false)
  /** Two-step removal: the first press asks, the second acts. */
  protected readonly confirmClear = signal(false)
  protected readonly statusKey = signal('')
  protected readonly statusTone = signal<'ok' | 'error' | ''>('')

  constructor() {
    // Mirrored into a signal because the shared dropdown writes the control from
    // inside its own view: under zoneless change detection the parent is not
    // marked dirty by that write, so a plain getter over `control.value` would
    // leave the BYOB fields hidden until some other event happened to run.
    this.modeControl.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(value => this.mode.set(this.toMode(value?.code)))
  }

  ngOnInit(): void {
    this.storage.getSettings().subscribe({
      next: settings => {
        this.applyMode(settings.mode)
        this.hasCredentials.set(settings.hasCredentials)
        this.bucketControl.setValue(settings.bucket ?? '', { emitEvent: false })
        this.loading.set(false)
      },
      error: () => {
        this.loading.set(false)
        this.statusTone.set('error')
        this.statusKey.set('STORAGE.ERR_LOAD')
      },
    })
  }

  /**
   * Write the mode, and rotate the credentials only when the caller typed one.
   *
   * A blank secret field is omitted from the body rather than sent empty, which
   * is what "leaving it blank keeps the stored value" means on the wire. The one
   * exception is `clearCredentials`, which deliberately sends the empty strings.
   */
  protected saveSettings(): void {
    if (this.saving()) {
      return
    }

    const mode = this.mode()
    const request: StorageSettingsRequest = { mode }

    if (mode === 'byob') {
      const bucket = this.bucketControl.value.trim()
      if (bucket) {
        request.bucket = bucket
      }

      const endpoint = this.endpointControl.value.trim()
      if (endpoint) {
        request.endpoint = endpoint
      }

      // Read here and only here. Neither value reaches a signal, a template or
      // an error path.
      const accessKey = this.accessKeyControl.value
      if (accessKey) {
        request.accessKey = accessKey
      }
      const secretKey = this.secretKeyControl.value
      if (secretKey) {
        request.secretKey = secretKey
      }
    }

    this.saving.set(true)
    this.statusKey.set('')
    this.statusTone.set('')

    this.storage.saveSettings(request).subscribe({
      next: reply => {
        this.saving.set(false)
        this.applyMode(reply.mode)
        this.hasCredentials.set(reply.hasCredentials)
        // Cleared on success so the values do not sit in a live control. On
        // failure they are kept, so a retry does not force a second paste.
        this.accessKeyControl.setValue('', { emitEvent: false })
        this.secretKeyControl.setValue('', { emitEvent: false })
        this.confirmClear.set(false)
        this.statusTone.set('ok')
        this.statusKey.set('STORAGE.SAVED_SETTINGS')
      },
      error: () => {
        this.saving.set(false)
        this.statusTone.set('error')
        this.statusKey.set('STORAGE.ERR_SETTINGS')
      },
    })
  }

  /** Ask, then remove. The stored credential is never shown first. */
  protected requestClear(): void {
    this.confirmClear.set(true)
  }

  protected cancelClear(): void {
    this.confirmClear.set(false)
  }

  /**
   * Remove the stored credentials.
   *
   * Sent as an ordinary `platform` write. A `byob` mode without a credential is
   * a bucket nothing can sign against, so "clear" and "use the platform bucket"
   * are the same state -- and this body is one the route already accepts. The
   * previous empty-string convention returned `invalid_bucket`, because a
   * `byob` write requires a bucket and that body carried none, which left a
   * pasted credential permanently unremovable.
   */
  protected clearCredentials(): void {
    if (this.saving() || !this.hasCredentials()) {
      return
    }

    this.saving.set(true)
    this.statusKey.set('')
    this.statusTone.set('')

    this.storage.saveSettings({ mode: 'platform' }).subscribe({
      next: reply => {
        this.saving.set(false)
        this.hasCredentials.set(reply.hasCredentials)
        this.confirmClear.set(false)
        this.statusTone.set('ok')
        this.statusKey.set('STORAGE.CLEAR_DONE')
      },
      error: () => {
        this.saving.set(false)
        this.confirmClear.set(false)
        this.statusTone.set('error')
        this.statusKey.set('STORAGE.ERR_CLEAR')
      },
    })
  }

  private applyMode(mode: StorageMode): void {
    this.mode.set(mode)
    const option = this.modeOptions.find(candidate => candidate.code === mode) ?? this.modeOptions[0]
    this.modeControl.setValue(option, { emitEvent: false })
  }

  private toMode(code: string | undefined): StorageMode {
    return code === 'byob' ? 'byob' : 'platform'
  }
}
