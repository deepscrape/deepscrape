import { AsyncPipe, CurrencyPipe, NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core'
import { ActivatedRoute, Router, RouterLink } from '@angular/router'
import { TranslateModule } from '@ngx-translate/core'
import { combineLatest, map, Observable } from 'rxjs'
import { AuthService, BillingService } from 'src/app/core/services'
import { BillingPlanCatalog, BillingPlanTier, CreditPackCatalog, UserBilling } from 'src/app/core/types'

type PlanDetailVm = {
  selectedPlan: BillingPlanCatalog | null
  allPlans: BillingPlanCatalog[]
  creditPacks: CreditPackCatalog[]
  billing: UserBilling
  isCurrentPlan: boolean
}

@Component({
  selector: 'app-plan-details',
  imports: [NgClass, AsyncPipe, CurrencyPipe, RouterLink, TranslateModule],
  templateUrl: './plan-details.component.html',
  styleUrl: './plan-details.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanDetailsComponent {
  readonly vm$: Observable<PlanDetailVm>

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly billingService: BillingService,
    private readonly authService: AuthService,
  ) {
    const planId$ = this.route.paramMap.pipe(
      map((params) => (params.get('planId') || '').toLowerCase() as BillingPlanTier)
    )

    this.vm$ = combineLatest([this.billingService.catalog$, this.billingService.billing$, planId$]).pipe(
      map(([catalog, billing, planId]) => {
        const selectedPlan = catalog.plans.find((plan) => plan.id === planId) || null
        if (!selectedPlan) {
          void this.router.navigate(['/billing/plans'])
        }

        return {
          selectedPlan,
          allPlans: catalog.plans,
          creditPacks: catalog.creditPacks,
          billing,
          isCurrentPlan: selectedPlan?.id === billing.plan,
        }
      })
    )
  }

  readonly intervals: Array<{ key: 'payAsYouGo' | 'monthly' | 'quarterly' | 'annually'; label: string }> = [
    { key: 'payAsYouGo', label: 'BILLING_PLAN_DETAILS.INT_PAY_AS_YOU_GO' },
    { key: 'monthly', label: 'BILLING_PLAN_DETAILS.INT_MONTHLY' },
    { key: 'quarterly', label: 'BILLING_PLAN_DETAILS.INT_QUARTERLY' },
    { key: 'annually', label: 'BILLING_PLAN_DETAILS.INT_ANNUALLY' },
  ]

  /**
   * A catalog feature token as a translatable key.
   *
   * Same vocabulary as the plans card and the public pricing page, so one plan cannot be
   * described two ways depending on which page the customer opened.
   * @param {string} feature The token from the plan catalog.
   * @return {string} The i18n key for that feature.
   */
  featureLabel(feature: string): string {
    return `PRICING.FEATURES.${feature.toUpperCase()}`
  }

  /**
   * The intervals this plan is actually sold on, in display order.
   *
   * The list above is the SHAPE of a plan, not a fact about every plan: Enterprise has no
   * pay-as-you-go price at all, and rendering the static list for it showed a EUR0.00 row
   * that nothing could buy. Filtering on presence is what keeps this page describing the
   * catalog rather than the union of every interval anyone has ever sold.
   * @param {BillingPlanCatalog} plan The plan being detailed.
   * @return {Array} Only the intervals with a price on this plan.
   */
  intervalRowsFor(plan: BillingPlanCatalog): Array<{ key: 'payAsYouGo' | 'monthly' | 'quarterly' | 'annually'; label: string }> {
    return this.intervals.filter((interval) => Boolean(plan.prices[interval.key]))
  }

  get isAdmin(): boolean {
    return this.authService.isAdmin
  }

  goToPlan(planId: BillingPlanTier): void {
    void this.router.navigate(['/billing/plans', planId])
  }
}
