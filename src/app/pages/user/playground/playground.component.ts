import { ChangeDetectionStrategy, ChangeDetectorRef, Component, HostBinding, computed, inject, OnInit, ViewChild, ElementRef, AfterViewInit, DestroyRef } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { NgClass } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatIcon } from '@angular/material/icon';
import { AppCrawlComponent, AppLLMScrapeComponent, AppMonitorComponent, AppSearchComponent, DomainSeederComponent, SavedFilesListComponent, ToolsPanelComponent } from 'src/app/core/components';
import { FeatureGateComponent } from 'src/app/core/components/feature-gate/feature-gate.component';
import { BrowserSessionPanelComponent } from 'src/app/core/components/browser-session/browser-session-panel.component';
import {
  ORG_ROLE_LABEL_KEYS,
  PLAYGROUND_MODES,
  playgroundGateStates,
  type GateState,
  type PlaygroundModeId,
} from 'src/app/core/components/feature-gate/feature-gate.policy';
import { TranslateModule } from '@ngx-translate/core';
import { AuthzService, BillingService } from 'src/app/core/services';
import { fadeinCartItems, smoothfadeAnimation } from 'src/app/animations';
import { HiddenDragScrollDirective } from 'src/app/core/directives';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { combineLatest, timer } from 'rxjs';
import { map } from 'rxjs/internal/operators/map';

@Component({
  selector: 'app-playground',
  imports: [AppLLMScrapeComponent, AppCrawlComponent, RouterModule, NgClass, DomainSeederComponent, AppSearchComponent, AppMonitorComponent, ToolsPanelComponent, HiddenDragScrollDirective, FeatureGateComponent, BrowserSessionPanelComponent, SavedFilesListComponent, MatIcon, TranslateModule],
  templateUrl: './playground.component.html',
  styleUrl: './playground.component.scss',
  animations: [
    fadeinCartItems,
    smoothfadeAnimation
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaygroundComponent implements OnInit, AfterViewInit {
  @HostBinding('class') classes = 'grow';
  @ViewChild('modeScrollContainer') modeScrollContainer!: ElementRef;

  private readonly authz = inject(AuthzService);
  private readonly billing = inject(BillingService);

  /**
   * What the caller may do, from the two sources the backend itself uses: the
   * membership-derived RBAC decision and the plan entitlement.
   *
   * `null` until both answer. The gate renders nothing while it is null rather than
   * assuming a refusal, because showing a paywall to a paying user for one frame is a
   * worse failure than showing a child one frame late.
   */
  private readonly capabilities = toSignal(
    combineLatest([
      this.authz.can$('ai', 'execute'),
      this.authz.can$('crawl', 'execute'),
      this.billing.canAccessPaidFeatures$(),
    ]).pipe(
      map(([ai, crawl, paid]) => ({ permissions: { ai, crawl }, paid })),
    ),
    { initialValue: null },
  );

  /**
   * Per-mode gate, derived from the one table in `feature-gate.policy.ts` so a mode
   * cannot be gated here and forgotten there. Mode ids come from the `modes` array
   * below; adding a mode there without adding it to the table is a compile error at
   * the `isModeBlocked` / `modeHintKey` call sites, because both take
   * `PlaygroundModeId`.
   */
  protected readonly gateStates = computed(() => {
    const caps = this.capabilities();
    return caps ? playgroundGateStates(caps) : null;
  });

  /** The caller's role in the active org. `null` for a personal account. */
  private readonly orgRole = toSignal(
    combineLatest([this.authz.memberships$, this.authz.activeOrgId$]).pipe(
      map(([memberships, activeOrgId]) => (activeOrgId ? memberships[activeOrgId] ?? null : null)),
    ),
    { initialValue: null },
  );

  /** Translated label key for the role above, for the gate panel's context line. */
  protected readonly roleKey = computed(() => {
    const role = this.orgRole();
    return role ? ORG_ROLE_LABEL_KEYS[role] ?? null : null;
  });

  currentMode: PlaygroundModeId = 'llm-scrape'; // Default mode

  /**
   * The mode strip as data.
   *
   * Previously the strip carried its own array, a nested label ternary and a
   * `switch` whitelist, so a mode had to be added to three places that agreed
   * only by convention, and the labels were the easiest of the three to forget.
   * One list now drives the tabs and their labels.
   *
   * `PlaygroundModeId` rather than an inline union: the union was a second copy
   * of `PLAYGROUND_MODES` that could drift from it without a compile error.
   *
   * Uses `m` rather than `mode` because the template already binds `mode` for
   * the route animation at the top of the block; iterating over `mode` again
   * silently shadowed it.
   */
  readonly modes = [
    { id: 'llm-scrape', label: 'LLM Scrape' },
    { id: 'crawl', label: 'Crawl' },
    { id: 'seeder', label: 'Seeder' },
    { id: 'search', label: 'Search' },
    { id: 'monitor', label: 'Monitor' },
    { id: 'tools', label: 'Tools' },
    // The browser-session surface. Its gate entry lives in `RUN_SURFACE_REQUIREMENTS`,
    // which is a `Record<PlaygroundModeId, ...>`, so adding the id here without adding
    // the entry is a compile error rather than a silently ungated mode.
    { id: 'browser', label: 'Browser' },
  ] as const;

  private destroyRef = inject(DestroyRef);

  /**
   * The gate for the selected mode. A getter rather than a `computed`: `currentMode` is
   * a plain field written from the query-param subscription, so there is no signal to
   * depend on and the getter is re-evaluated on each change-detection pass.
   */
  protected get activeGate(): GateState | null {
    return this.gateStates()?.[this.currentMode] ?? null;
  }

  /**
   * Whether a mode is refused for this caller.
   *
   * The tab stays clickable and carries `aria-disabled` rather than `disabled`: a
   * natively disabled control cannot be reached in order to explain itself, and the
   * explanation is the point. Selecting a blocked mode renders the gate panel in place
   * of the child, so the mode never mounts and nothing can be submitted from it.
   */
  protected isModeBlocked(mode: PlaygroundModeId): boolean {
    const gate = this.gateStates()?.[mode];
    return gate ? !gate.allowed : false;
  }

  /** Tooltip key for a blocked tab, so the reason is also available on hover. */
  protected modeHintKey(mode: PlaygroundModeId): string | null {
    const gate = this.gateStates()?.[mode];
    return gate && !gate.allowed ? gate.hintKey : null;
  }

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {
  }
  ngOnInit(): void {
    this.route.queryParams.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      // Derived from `PLAYGROUND_MODES` rather than a second list. The `switch`
      // this replaces was the ONE of the four places a mode id lives that no
      // type checked: adding a mode to `PLAYGROUND_MODES` and
      // `RUN_SURFACE_REQUIREMENTS` (both compile-enforced) left it unreachable
      // from a query param, with no error anywhere. An unusable param still
      // falls back to the default, matching the `default:` branch it replaces.
      const requested = params['mode'];
      const newMode =
        PLAYGROUND_MODES.find((m) => m === requested) ?? 'llm-scrape';
      // Only update if the mode actually changed to trigger animation
      if (this.currentMode !== newMode) {
        this.currentMode = newMode;
        // OnPush: the query-param write is async, so the view needs telling.
        this.cdr.markForCheck()
      }
    });
  }

  ngAfterViewInit(): void {
    // Check for mobile device after view init
    timer(0)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        // Set initial scroll position to make the selected mode visible if needed
        this.scrollToActiveMode();
      });
  }

  // Scroll to make the active mode button visible
  private scrollToActiveMode(): void {
    if (!this.modeScrollContainer) return;
    
    const container = this.modeScrollContainer.nativeElement;
    // Located by `data-active`, not by a visual class. The previous selector was
    // `button.shadow-md`, so moving the active styling from a shadow to a ring
    // stopped the centring with nothing to catch it -- the strip simply stopped
    // scrolling to the selected mode. The attribute is set from the same boolean
    // that drives the active styles, so the two cannot drift apart again.
    const activeButton = container.querySelector('button[data-active="true"]');

    if (activeButton) {
      // Calculate position to center the active button
      const containerWidth = container.clientWidth;
      const buttonLeft = activeButton.offsetLeft;
      const buttonWidth = activeButton.clientWidth;
      
      // Center the button in the container
      container.scrollLeft = buttonLeft - (containerWidth / 2) + (buttonWidth / 2);
    }
  }

  // Handle scroll events
  onModeScroll(event: Event): void {
    // Handle any scroll-related logic here if needed
  }
  changeMode(mode:string): void {
    if (this.currentMode === mode) return; // Don't navigate if already on this mode
    
    // Navigate and update query params
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { mode: mode },
      queryParamsHandling: 'merge'
    });
  }
}
