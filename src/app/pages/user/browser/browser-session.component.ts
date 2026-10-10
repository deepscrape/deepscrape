import { ChangeDetectionStrategy, Component } from '@angular/core';
import { BrowserSessionPanelComponent } from '../../../core/components/browser-session/browser-session-panel.component';
import { BrowserSessionVaultComponent } from '../../../core/components/browser-session/browser-session-vault.component';

/**
 * The browser-session page.
 *
 * A thin host, on purpose: the page owns the frame and the heading, and the panel
 * owns every call to `/api/browser/session*`. Keeping the routing concerns out of
 * the panel is what lets the same panel be dropped into the playground's
 * `browser` mode and the crawl-pack tab later without a second implementation of
 * the lease controls.
 */
@Component({
  selector: 'app-user-browser-page',
  standalone: true,
  imports: [BrowserSessionPanelComponent, BrowserSessionVaultComponent],
  templateUrl: './browser-session.component.html',
  styleUrl: './browser-session.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserBrowserPageComponent {}
