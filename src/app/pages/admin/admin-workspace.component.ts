import { AfterViewInit, Component, DestroyRef, ElementRef, HostListener, ViewChild, inject } from '@angular/core'
import { NgClass } from '@angular/common';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router'
import { LucideAngularModule } from 'lucide-angular'
import { smoothfadeAnimation } from 'src/app/animations'
import { RippleDirective } from 'src/app/core/directives'
import { myIcons } from 'src/app/shared'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { filter } from 'rxjs/internal/operators/filter'
import { TranslateModule } from '@ngx-translate/core'

@Component({
  selector: 'app-admin-workspace',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NgClass, LucideAngularModule, RippleDirective, TranslateModule],
  templateUrl: './admin-workspace.component.html',
  styleUrl: './admin-workspace.component.scss',
  animations: [smoothfadeAnimation],
})
export class AdminWorkspaceComponent implements AfterViewInit {
  @ViewChild('tabScrollStrip') private tabScrollStrip?: ElementRef<HTMLDivElement>

  readonly icons = myIcons
  private animationBindingReady = false
  showPreviousButton = false
  showNextButton = false
  private readonly router = inject(Router)
  private readonly destroyRef = inject(DestroyRef)
  private readonly tabOverlayWidth = 56
  readonly tabs = [
    { label: 'ADMIN_WORKSPACE.TAB_CONFIG', route: '/admin/config', icon: 'settings' },
    { label: 'ADMIN_WORKSPACE.TAB_ANALYTICS', route: '/admin/analytics', icon: 'gauge' },
    { label: 'ADMIN_WORKSPACE.TAB_BILLING', route: '/admin/billing-observability', icon: 'piggy-bank' },
    { label: 'ADMIN_WORKSPACE.TAB_USERS', route: '/admin/users', icon: 'user-distribution' },
    { label: 'ADMIN_WORKSPACE.TAB_MIGRATION', route: '/admin/migration', icon: 'repeat' },
    { label: 'ADMIN_WORKSPACE.TAB_RUNS', route: '/admin/migration/runs', icon: 'recent-activity' },
    { label: 'ADMIN_WORKSPACE.TAB_BACKUPS', route: '/admin/migration/backups', icon: 'database' },
  ]

  constructor() {
    setTimeout(() => {
      this.animationBindingReady = true
    }, 0)
  }

  ngAfterViewInit(): void {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.ensureActiveTabVisible()
      })

    queueMicrotask(() => {
      this.ensureActiveTabVisible(false)
      this.updateTabScrollControls()
    })
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.updateTabScrollControls()
  }

  onTabStripScroll(): void {
    this.updateTabScrollControls()
  }

  scrollTabs(direction: 'previous' | 'next'): void {
    const strip = this.tabScrollStrip?.nativeElement
    if (!strip) {
      return
    }

    const delta = Math.max(strip.clientWidth * 0.72, 180)
    const left = direction === 'next' ? delta : -delta

    strip.scrollBy({ left, behavior: 'smooth' })

    setTimeout(() => {
      this.updateTabScrollControls()
    }, 220)
  }

  getRouteAnimationData(outlet?: RouterOutlet | null): string {
    if (!this.animationBindingReady) {
      return 'initial'
    }
    return outlet?.activatedRouteData?.['animation'] || 'initial'
  }

  private ensureActiveTabVisible(useSmooth = true): void {
    const strip = this.tabScrollStrip?.nativeElement
    if (!strip) {
      return
    }

    const activeTab = strip.querySelector<HTMLElement>('.active-tab')
    if (!activeTab) {
      return
    }

    const stripRect = strip.getBoundingClientRect()
    const tabRect = activeTab.getBoundingClientRect()
    const leftBoundary = stripRect.left + this.tabOverlayWidth
    const rightBoundary = stripRect.right - this.tabOverlayWidth

    let delta = 0
    if (tabRect.left < leftBoundary) {
      delta = tabRect.left - leftBoundary
    } else if (tabRect.right > rightBoundary) {
      delta = tabRect.right - rightBoundary
    }

    if (delta !== 0) {
      strip.scrollBy({ left: delta, behavior: useSmooth ? 'smooth' : 'auto' })
    }

    setTimeout(() => {
      this.updateTabScrollControls()
    }, useSmooth ? 250 : 0)
  }

  private updateTabScrollControls(): void {
    const strip = this.tabScrollStrip?.nativeElement
    if (!strip) {
      this.showPreviousButton = false
      this.showNextButton = false
      return
    }

    const maxScrollLeft = strip.scrollWidth - strip.clientWidth
    const epsilon = 2

    this.showPreviousButton = strip.scrollLeft > epsilon
    this.showNextButton = maxScrollLeft - strip.scrollLeft > epsilon
  }
}
