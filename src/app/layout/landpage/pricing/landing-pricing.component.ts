import { Component, ChangeDetectionStrategy, ChangeDetectorRef, OnInit, DestroyRef, inject } from '@angular/core';
import { NgClass } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LucideAngularModule } from 'lucide-angular';
import { TranslateModule } from '@ngx-translate/core';
import { RadioToggleComponent } from 'src/app/core/components/radiotoggle/radiotoggle.component';
import { AnalyticsService } from 'src/app/core/services';
import { myIcons } from 'src/app/shared/lucideicons';
import { RevealDirective } from 'src/app/shared/reveal/reveal.directive';

interface PricingTier {
  tier: string;
  name: string;
  priceMonthly: string;
  priceYearly: string;
  credits: string;
  description: string;
  features: string[];
  highlighted: boolean;
  cta: string;
  ctaLink: string;
}

@Component({
  selector: 'app-landing-pricing',
  standalone: true,
  imports: [RouterLink, LucideAngularModule, NgClass, ReactiveFormsModule, RadioToggleComponent, TranslateModule, RevealDirective],
  templateUrl: './landing-pricing.component.html',
  styleUrl: './landing-pricing.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LandingPricingComponent implements OnInit {
  readonly icons = myIcons;
  readonly billingControl = new FormControl<boolean>(false, { nonNullable: true });
  isYearly = false;
  private destroyRef = inject(DestroyRef);
  private analytics = inject(AnalyticsService);
  private cdr = inject(ChangeDetectorRef);

  ngOnInit(): void {
    // Exposure signal no server fact can produce: without it the funnel cannot tell
    // "never reached pricing" from "read pricing and left", which is the difference
    // between a traffic problem and an offer problem.
    this.analytics.trackEvent('pricing_viewed', { section: 'landing' })
      .subscribe({ error: () => undefined })

    this.billingControl.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(val => {
      this.isYearly = val;
      // OnPush: valueChanges fires outside the toggle's own template event.
      this.cdr.markForCheck();
    });
  }

  readonly tiers: PricingTier[] = [
    {
      tier: 'free',
      name: 'PRICING.NAME_FREE',
      priceMonthly: '0',
      priceYearly: '0',
      credits: '100',
      description: 'PRICING.DESC_FREE',
      features: [
        'PRICING.FEATURES.EXTRACTION_SUITE',
        'PRICING.FEATURES.SCHEMA_COMPILER',
        'PRICING.FEATURES.MONITORS',
        'PRICING.FEATURES.AI_PROVIDERS',
        'PRICING.FEATURES.COMMUNITY_SUPPORT',
      ],
      highlighted: false,
      cta: 'PRICING.CTA_FREE',
      ctaLink: '/service/signup',
    },
    {
      tier: 'starter',
      name: 'PRICING.NAME_STARTER',
      priceMonthly: '9.99',
      priceYearly: '8.33',
      credits: '1,000',
      description: 'PRICING.DESC_STARTER',
      // The landing card shows the paid DELTA; the free-tier tools are already listed above.
      features: [
        'PRICING.FEATURES.CRAWL_API',
        'PRICING.FEATURES.ANTI_BOT',
        'PRICING.FEATURES.IDENTITY_CRAWLING',
        'PRICING.FEATURES.PROXY_ROTATION',
        'PRICING.FEATURES.HIGH_CONCURRENCY',
        'PRICING.FEATURES.CAPACITY_TOOLS',
        'PRICING.FEATURES.BROWSER_SESSION_DEDICATED',
        'PRICING.FEATURES.BROWSER_SESSION_BYO',
        'PRICING.FEATURES.LIVE_VIEW',
        'PRICING.FEATURES.CREDENTIAL_VAULT',
        'PRICING.FEATURES.MACHINE_LEASING',
      ],
      highlighted: false,
      cta: 'PRICING.CTA_TRIAL',
      ctaLink: '/service/signup',
    },
    {
      tier: 'pro',
      name: 'PRICING.NAME_PRO',
      priceMonthly: '19.99',
      priceYearly: '16.67',
      credits: '5,000',
      description: 'PRICING.DESC_PRO',
      features: [
        'PRICING.FEATURES.CRAWL_API',
        'PRICING.FEATURES.ANTI_BOT',
        'PRICING.FEATURES.IDENTITY_CRAWLING',
        'PRICING.FEATURES.PROXY_ROTATION',
        'PRICING.FEATURES.HIGH_CONCURRENCY',
        'PRICING.FEATURES.CAPACITY_TOOLS',
        'PRICING.FEATURES.BROWSER_SESSION_DEDICATED',
        'PRICING.FEATURES.BROWSER_SESSION_BYO',
        'PRICING.FEATURES.LIVE_VIEW',
        'PRICING.FEATURES.CREDENTIAL_VAULT',
        'PRICING.FEATURES.MACHINE_LEASING',
        'PRICING.FEATURES.PRIORITY_SUPPORT',
      ],
      highlighted: true,
      cta: 'PRICING.CTA_TRIAL',
      ctaLink: '/service/signup',
    },
    {
      tier: 'enterprise',
      name: 'PRICING.NAME_ENT',
      // `Custom` is what the template keys off to render the label instead of a number --
      // and it is the truth: Enterprise is unlimited under a negotiated agreement, so a
      // list price here would advertise a meter the tier does not have.
      priceMonthly: 'Custom',
      priceYearly: 'Custom',
      credits: 'PRICING.UNLIMITED',
      description: 'PRICING.DESC_ENT',
      features: [
        'PRICING.FEATURES.UNLIMITED_USAGE',
        'PRICING.FEATURES.CRAWL_API',
        'PRICING.FEATURES.ANTI_BOT',
        'PRICING.FEATURES.IDENTITY_CRAWLING',
        'PRICING.FEATURES.PROXY_ROTATION',
        'PRICING.FEATURES.CAPACITY_TOOLS',
        'PRICING.FEATURES.BROWSER_SESSION_DEDICATED',
        'PRICING.FEATURES.BROWSER_SESSION_BYO',
        'PRICING.FEATURES.MACHINE_LEASING',
        'PRICING.FEATURES.PRIORITY_SUPPORT',
        'PRICING.FEATURES.DEDICATED_SUPPORT',
        'PRICING.FEATURES.SSO',
        'PRICING.FEATURES.AUDIT_LOGS',
        'PRICING.FEATURES.CUSTOM_LIMITS',
      ],
      highlighted: false,
      cta: 'PRICING.CTA_SALES',
      ctaLink: '/contact',
    },
  ];
}
