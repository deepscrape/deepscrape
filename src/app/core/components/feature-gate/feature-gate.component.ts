import { ChangeDetectionStrategy, Component, Input, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { MatIcon } from '@angular/material/icon';
import { AuthzService } from '../../services';
import { orgScopedUrl } from '../../guards/host-routing.policy';
import type { GateState } from './feature-gate.policy';

/**
 * Explains why a run surface is refused, and offers the one action that would fix it.
 *
 * Presentational on purpose: the decision comes from `feature-gate.policy.ts`, so this
 * component holds no rules of its own and cannot drift from the table.
 *
 * The upgrade link is scoped with `orgScopedUrl` rather than hard-coded, so it lands on
 * `/{orgId}/billing/plans` directly instead of relying on `orgScopeGuard` to rewrite a
 * bare path.
 */
@Component({
  selector: 'app-feature-gate',
  standalone: true,
  imports: [TranslateModule, MatIcon, RouterLink],
  templateUrl: './feature-gate.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FeatureGateComponent {
  private readonly authz = inject(AuthzService);

  /** The decision to explain. `null` or allowed renders nothing. */
  @Input() state: GateState | null = null;

  /** i18n key for the caller's role, when a role denial is the reason. */
  @Input() roleKey: string | null = null;

  /**
   * A getter rather than a `computed`: `activeOrgId` is a plain getter on the service,
   * so there is no signal to depend on and a computed would cache the first org forever.
   */
  get plansHref(): string {
    return orgScopedUrl('/billing/plans', this.authz.activeOrgId);
  }
}
