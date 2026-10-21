import { AsyncPipe, CurrencyPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core'
import { MatIconModule } from '@angular/material/icon'
import { Router } from '@angular/router'
import { TranslateModule } from '@ngx-translate/core'
import { BillingService } from 'src/app/core/services'
import { CreditPackCatalog, CustomCreditsCatalog, UserBilling } from 'src/app/core/types'

@Component({
  selector: 'app-passes',
  imports: [AsyncPipe, CurrencyPipe, MatIconModule, TranslateModule],
  templateUrl: './passes.component.html',
  styleUrl: './passes.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PassesComponent {
  private readonly billingService = inject(BillingService)
  private readonly router = inject(Router)

  readonly billing$ = this.billingService.billing$
  readonly creditPacks$ = this.billingService.getCreditPacks$()
  readonly customCreditsConfig$ = this.billingService.getCustomCreditsConfig$()
  readonly purchasedCredits$ = this.billingService.getPurchasedCredits$()
  readonly includedCredits$ = this.billingService.getIncludedCredits$()
  readonly canPurchaseCredits$ = this.billingService.canPurchaseCredits$()

  getAvailablePurchased(billing: UserBilling | null): number {
    if (!billing?.credits) {
      return 0
    }

    if (billing.credits.purchasedBalance !== undefined) {
      return Math.max(0, (billing.credits.purchasedBalance || 0) - (billing.credits.purchasedReserved || 0))
    }

    return billing.plan === 'free' ? Math.max(0, (billing.credits.balance || 0) - (billing.credits.reserved || 0)) : 0
  }

  /** Stripe sends lowercase codes and `CurrencyPipe` needs the ISO form to print €. */
  asCurrencyCode(currency: string | null | undefined): string {
    return (currency || 'EUR').toUpperCase()
  }

  getAvailableIncluded(billing: UserBilling | null): number {
    if (!billing?.credits) {
      return 0
    }

    if (billing.credits.includedBalance !== undefined) {
      return Math.max(0, (billing.credits.includedBalance || 0) - (billing.credits.includedReserved || 0))
    }

    return billing.plan !== 'free' ? Math.max(0, (billing.credits.balance || 0) - (billing.credits.reserved || 0)) : 0
  }

  purchasePack(pack: CreditPackCatalog): void {
    void this.router.navigate(['/billing/plans'])
  }
}
