import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core'
import { HttpErrorResponse } from '@angular/common/http'
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms'
import { RouterLink } from '@angular/router'
import { firstValueFrom } from 'rxjs'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { ClipboardbuttonComponent, DialogComponent, StinputComponent } from 'src/app/core/components'
import { RippleDirective } from 'src/app/core/directives'
import { WebrainConfigService } from 'src/app/core/services'
import { WebrainConfig, WebrainProxyEntryInput } from 'src/app/core/types'

/**
 * One editable pool row.
 *
 * The two controls hold what the operator is typing now. They never hold a
 * stored value: a stored entry is a credential and the read route masks it, so
 * the editor starts empty and is cleared again after a save.
 */
interface ProxyDraft {
  id: number
  label: FormControl<string>
  url: FormControl<string>
}

/** The proxy URL schemes the backend accepts. Kept in step with `ALLOWED_PROTOCOLS`. */
const SUPPORTED_PROXY_PROTOCOLS: readonly string[] = ['http:', 'https:', 'socks5:']

/**
 * Admin console for the webrain worker configuration.
 *
 * The page exists for two credentials, and it treats each the way its lifetime
 * demands:
 *
 * - **The MCP token.** A token the operator *generates* is returned once, by
 *   the mint response, and never again: `GET` reports only `hasToken`. So the
 *   reveal lives in a plain component field, not a signal and not a service
 *   state, which means it dies with this page and a navigation away is a
 *   navigation away from the only copy. The operator is told, on screen, that
 *   it will not be shown again. A token the operator *enters* is the opposite:
 *   the backend never echoes it, this page never stores it, and the control is
 *   cleared the moment the request settles.
 *
 * - **A proxy URL.** Write-only. It is `user:pass@host`, so the read side
 *   returns a label and a masked host instead. The editor therefore accepts a
 *   URL but never renders a stored one back, and the pool is replaced whole
 *   because the backend offers no partial update.
 *
 * Everything here is a request to a server that re-checks `platform` permission
 * on the call; the UI is a courtesy, the backend is the gate.
 */
@Component({
  selector: 'app-admin-webrain',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, RippleDirective, TranslateModule, StinputComponent, DialogComponent, ClipboardbuttonComponent],
  templateUrl: './admin-webrain.component.html',
  styleUrl: './admin-webrain.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminWebrainComponent implements OnInit, OnDestroy {
  private readonly webrain = inject(WebrainConfigService)
  private readonly cdr = inject(ChangeDetectorRef)
  private readonly translate = inject(TranslateService)

  /** The token the operator is typing. Cleared the moment the request settles. */
  readonly typedToken = new FormControl('', { nonNullable: true })

  config: WebrainConfig | null = null
  loading = false
  error: string | null = null
  notice: string | null = null
  busyToken = false
  busyProxies = false
  confirmReplace = false

  /**
   * The minted token, and the only deliberate exception to "never render key
   * material".
   *
   * A plain field on purpose: not a signal, not a service value, so it is
   * destroyed with this component and cannot survive a navigation. It is set
   * only from a `generated: true` reply and cleared by the dismiss action, by a
   * new mint, and in `ngOnDestroy`.
   */
  mintedToken: string | null = null

  drafts: ProxyDraft[] = []
  private nextDraftId = 1

  ngOnInit(): void {
    void this.refresh()
  }

  ngOnDestroy(): void {
    // Drop the last reference this page holds to a minted token.
    this.mintedToken = null
  }

  /** Load the state an operator may see. */
  async refresh(): Promise<void> {
    this.loading = true
    this.error = null
    this.cdr.markForCheck()

    try {
      this.config = await firstValueFrom(this.webrain.getConfig())
    } catch (caught) {
      this.error = this.messageFor(caught, 'ADMIN_WEBRAIN.ERR_LOAD')
    } finally {
      this.loading = false
      this.cdr.markForCheck()
    }
  }

  /** i18n key for the token presence card, never the value. */
  tokenStatusKey(): string {
    return this.config?.hasToken ? 'ADMIN_WEBRAIN.TOKEN_SET' : 'ADMIN_WEBRAIN.TOKEN_MISSING'
  }

  /** i18n key for which seam answered the last read. */
  sourceKey(): string {
    return this.config?.source === 'secret' ? 'ADMIN_WEBRAIN.SOURCE_SECRET' : 'ADMIN_WEBRAIN.SOURCE_ENV'
  }

  /** Ask the server to mint a token. The reply carries the only copy. */
  async mintToken(): Promise<void> {
    if (this.busyToken) {
      return
    }

    this.busyToken = true
    this.error = null
    this.notice = null
    // A new mint supersedes any previous reveal: there is never more than one.
    this.mintedToken = null
    this.cdr.markForCheck()

    try {
      const response = await firstValueFrom(this.webrain.setToken())

      if (response.generated) {
        this.mintedToken = response.token
      }

      this.notice = this.translate.instant('ADMIN_WEBRAIN.OK_MINTED')
      await this.reloadQuietly()
    } catch (caught) {
      this.error = this.messageFor(caught, 'ADMIN_WEBRAIN.ERR_TOKEN')
    } finally {
      this.busyToken = false
      this.cdr.markForCheck()
    }
  }

  /** Store a token the operator entered. The server never returns it. */
  async useTypedToken(): Promise<void> {
    if (this.busyToken) {
      return
    }

    // Read once and hand it straight to the request. A blank value is not a
    // token, it is the signal the server reads as "mint one", so it is refused
    // here rather than silently rotating the credential.
    const supplied = this.typedToken.value
    if (!supplied || !supplied.trim()) {
      this.error = this.translate.instant('ADMIN_WEBRAIN.ERR_TOKEN_EMPTY')
      this.cdr.markForCheck()
      return
    }

    this.busyToken = true
    this.error = null
    this.notice = null
    this.mintedToken = null
    this.cdr.markForCheck()

    try {
      // The reply for a supplied token carries no value, and this page wants
      // none: there is nothing to read back.
      await firstValueFrom(this.webrain.setToken(supplied))
      this.notice = this.translate.instant('ADMIN_WEBRAIN.OK_STORED')
      await this.reloadQuietly()
    } catch (caught) {
      this.error = this.messageFor(caught, 'ADMIN_WEBRAIN.ERR_TOKEN')
    } finally {
      // Drop the typed value as soon as the request settles, whether it worked
      // or not, so it does not linger in the DOM or in memory.
      this.typedToken.setValue('')
      this.busyToken = false
      this.cdr.markForCheck()
    }
  }

  /** Copy the one-time token. The value stays on screen if the clipboard refuses. */
  async copyMintedToken(): Promise<void> {
    const token = this.mintedToken
    if (!token) {
      return
    }

    try {
      await navigator.clipboard.writeText(token)
    } catch {
      // Clipboard access can be denied; the operator can still copy by hand
      // from the code block, which is why it is rendered as selectable text.
    }
  }

  /** Close the one-time reveal. */
  dismissMintedToken(): void {
    this.mintedToken = null
    this.cdr.markForCheck()
  }

  /** Append an empty pool row. Starts blank: a stored URL is never shown back. */
  addDraft(): void {
    this.drafts = [
      ...this.drafts,
      {
        id: this.nextDraftId,
        label: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
        url: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
      },
    ]
    this.nextDraftId += 1
    this.cdr.markForCheck()
  }

  /** Drop one draft row. */
  removeDraft(id: number): void {
    this.drafts = this.drafts.filter((row) => row.id !== id)
    this.cdr.markForCheck()
  }

  /** Validate locally, then ask for confirmation before the wholesale replace. */
  askReplace(): void {
    this.error = null

    if (!this.draftsAreValid()) {
      this.drafts.forEach((row) => {
        row.label.markAsTouched()
        row.url.markAsTouched()
      })
      this.error = this.translate.instant('ADMIN_WEBRAIN.ERR_PROXY_FORM')
      this.cdr.markForCheck()
      return
    }

    this.confirmReplace = true
    this.cdr.markForCheck()
  }

  /** Send the whole pool. The reply is the pool as stored, already masked. */
  async applyProxyPool(): Promise<void> {
    const payload: WebrainProxyEntryInput[] = this.drafts.map((row) => ({
      label: row.label.value.trim(),
      url: row.url.value.trim(),
    }))

    this.confirmReplace = false
    this.busyProxies = true
    this.error = null
    this.notice = null
    this.cdr.markForCheck()

    try {
      const response = await firstValueFrom(this.webrain.setProxies(payload))
      this.notice = this.translate.instant('ADMIN_WEBRAIN.OK_POOL_SAVED', { count: response.poolSize })
      // The drafts held live credentials in their `url` controls; the save is
      // done with them, so the rows go with it.
      this.drafts = []
      await this.reloadQuietly()
    } catch (caught) {
      this.error = this.proxyErrorMessage(caught)
    } finally {
      this.busyProxies = false
      this.cdr.markForCheck()
    }
  }

  /** Close the confirmation dialog without saving. */
  closeDialog(): void {
    this.confirmReplace = false
    this.cdr.markForCheck()
  }

  /**
   * Re-read the status after a write, without the full-page spinner.
   *
   * The write already reported its result, so a failure here leaves the cards
   * showing what they showed before rather than replacing a success notice with
   * a spurious error.
   */
  private async reloadQuietly(): Promise<void> {
    try {
      this.config = await firstValueFrom(this.webrain.getConfig())
    } catch {
      // Intentionally ignored: the status card keeps its previous value.
    }
  }

  /** Every row carries a label and a URL the backend will accept. */
  private draftsAreValid(): boolean {
    return this.drafts.length > 0 && this.drafts.every((row) =>
      Boolean(row.label.value.trim()) && this.isSupportedProxyUrl(row.url.value.trim())
    )
  }

  /** A cheap local mirror of the backend's scheme check. */
  private isSupportedProxyUrl(value: string): boolean {
    try {
      return SUPPORTED_PROXY_PROTOCOLS.includes(new URL(value).protocol)
    } catch {
      return false
    }
  }

  /**
   * Turn a proxy-write failure into something actionable.
   *
   * The 400 body names an offending INDEX and a fixed reason, never the entry:
   * an entry is a credential, so the server will not quote it and neither will
   * this page. The reason is a fixed server-side phrase, shown as data inside a
   * translated sentence.
   */
  private proxyErrorMessage(caught: unknown): string {
    if (caught instanceof HttpErrorResponse && caught.status === 400) {
      const body = caught.error as { index?: number; reason?: string } | null

      if (body && typeof body.index === 'number' && body.index >= 0) {
        return this.translate.instant('ADMIN_WEBRAIN.ERR_PROXY_INDEX', {
          index: body.index + 1,
          reason: body.reason ?? '',
        })
      }

      return this.translate.instant('ADMIN_WEBRAIN.ERR_POOL_EMPTY')
    }

    return this.messageFor(caught, 'ADMIN_WEBRAIN.ERR_PROXIES')
  }

  /** Translate a transport error into something an operator can act on. */
  private messageFor(caught: unknown, fallbackKey: string): string {
    if (caught instanceof Error && caught.message) {
      return caught.message
    }
    return this.translate.instant(fallbackKey)
  }
}
