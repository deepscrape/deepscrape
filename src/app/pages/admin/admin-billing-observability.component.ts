
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, inject } from '@angular/core'
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms'
import { RouterLink } from '@angular/router'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { CheckboxComponent, StinputComponent } from 'src/app/core/components'
import { RippleDirective } from 'src/app/core/directives'
import { BillingService } from 'src/app/core/services'

type ObservabilityResponse = {
  generatedAt: string
  incidents: Array<Record<string, unknown>>
  failedEvents: Array<Record<string, unknown>>
  pendingEvents: Array<Record<string, unknown>>
  pastDueAccounts: Array<Record<string, unknown>>
}

@Component({
  selector: 'app-admin-billing-observability',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, RippleDirective, TranslateModule, StinputComponent, CheckboxComponent],
  templateUrl: './admin-billing-observability.component.html',
  styleUrl: './admin-billing-observability.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminBillingObservabilityComponent {
  private readonly billingService = inject(BillingService)
  private readonly cdr = inject(ChangeDetectorRef)
  private readonly translate = inject(TranslateService)

  loading = false
  error: string | null = null
  data: ObservabilityResponse | null = null

  // ponytail: string controls — StinputComponent is FormControl<string>; the values
  // are parsed by sanitizeLimit() at submit time, so no numeric control is needed.
  readonly includeAcknowledged = new FormControl(false, { nonNullable: true })
  readonly incidentLimit = new FormControl('20', { nonNullable: true, validators: [Validators.min(1), Validators.max(100)] })
  readonly failedEventLimit = new FormControl('20', { nonNullable: true, validators: [Validators.min(1), Validators.max(100)] })
  readonly pendingEventLimit = new FormControl('20', { nonNullable: true, validators: [Validators.min(1), Validators.max(100)] })
  readonly pastDueLimit = new FormControl('30', { nonNullable: true, validators: [Validators.min(1), Validators.max(200)] })

  readonly retryingEventIds = new Set<string>()
  readonly acknowledgingIncidentIds = new Set<string>()

  async ngOnInit(): Promise<void> {
    await this.refresh()
  }

  async refresh(): Promise<void> {
    this.loading = true
    this.error = null
    this.cdr.markForCheck()

    try {
      this.data = await this.billingService.getAdminBillingObservability({
        includeAcknowledged: this.includeAcknowledged.value,
        incidentLimit: this.sanitizeLimit(Number(this.incidentLimit.value), 1, 100, 20),
        failedEventLimit: this.sanitizeLimit(Number(this.failedEventLimit.value), 1, 100, 20),
        pendingEventLimit: this.sanitizeLimit(Number(this.pendingEventLimit.value), 1, 100, 20),
        pastDueLimit: this.sanitizeLimit(Number(this.pastDueLimit.value), 1, 200, 30),
      })
    } catch (error) {
      this.error = error instanceof Error ? error.message : this.translate.instant('ADMIN_BILLING_OBS.ERR_FETCH')
    } finally {
      this.loading = false
      this.cdr.markForCheck()
    }
  }

  async acknowledgeIncident(incidentId: string): Promise<void> {
    if (!incidentId || this.acknowledgingIncidentIds.has(incidentId)) {
      return
    }

    this.acknowledgingIncidentIds.add(incidentId)
    this.cdr.markForCheck()

    try {
      await this.billingService.acknowledgeBillingIncident(incidentId)
      await this.refresh()
    } catch (error) {
      this.error = error instanceof Error ? error.message : this.translate.instant('ADMIN_BILLING_OBS.ERR_ACKNOWLEDGE')
    } finally {
      this.acknowledgingIncidentIds.delete(incidentId)
      this.cdr.markForCheck()
    }
  }

  async retryEvent(eventId: string): Promise<void> {
    if (!eventId || this.retryingEventIds.has(eventId)) {
      return
    }

    this.retryingEventIds.add(eventId)
    this.cdr.markForCheck()

    try {
      await this.billingService.requestStripeEventRetry(eventId)
      await this.refresh()
    } catch (error) {
      this.error = error instanceof Error ? error.message : this.translate.instant('ADMIN_BILLING_OBS.ERR_RETRY')
    } finally {
      this.retryingEventIds.delete(eventId)
      this.cdr.markForCheck()
    }
  }

  incidentId(incident: Record<string, unknown>): string {
    return String(incident['id'] || '')
  }

  eventId(eventData: Record<string, unknown>): string {
    return String(eventData['id'] || '')
  }

  private sanitizeLimit(value: number, min: number, max: number, fallback: number): number {
    const numeric = Math.floor(Number(value))
    if (!Number.isFinite(numeric)) {
      return fallback
    }

    return Math.max(min, Math.min(max, numeric))
  }
}
