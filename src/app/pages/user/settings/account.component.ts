import { AsyncPipe, NgClass, TitleCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, HostBinding, inject } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { RouterOutlet, RouterLink, RouterLinkActive, Router, ActivatedRoute, ChildrenOutletContexts, NavigationEnd } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { Subscription } from 'rxjs/internal/Subscription';
import { Observable } from 'rxjs/internal/Observable';
import { switchMap } from 'rxjs/internal/operators/switchMap';
import { smoothfadeAnimation } from 'src/app/animations';
import { RippleDirective } from 'src/app/core/directives';
import { RouteService } from 'src/app/core/services';
import { GlobalTabs } from 'src/app/core/types';
import { ACCOUNT_DATA_TABS } from 'src/app/core/variables';
import { myIcons } from 'src/app/shared/lucideicons';

@Component({
  selector: 'app-account-settings',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NgClass, AsyncPipe, LucideAngularModule, TitleCasePipe, RippleDirective],
  templateUrl: './account.component.html',
  styleUrl: './account.component.scss',
  animations: [smoothfadeAnimation],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountSettingsComponent {
  readonly icons = myIcons
  private invService = inject(RouteService)
  private routeSub: Subscription
  private router = inject(Router)
  private route = inject(ActivatedRoute)
  private contexts = inject(ChildrenOutletContexts)
  @HostBinding('class') classes = 'grow'


  gTabs$: Observable<GlobalTabs[]>
  activeLink: string

  constructor(private cdr: ChangeDetectorRef) {

  }

  ngOnInit(): void {
    //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
    //Add 'implements OnInit' to the class.
   
    this.routeSub = this.router.events.subscribe((event: any) => {
      if ((event instanceof NavigationEnd))  {
        const url = this.route.snapshot.url[this.route.snapshot.url.length - 1].toString()
          this.activeLink = this.getRouteId()
          this.cdr.detectChanges()
      }      
    })


     this.gTabs$ = this.route.paramMap.pipe(
      switchMap(params => {
        // (+) before `params.get()` turns the string into a number
        this.activeLink = this.getRouteId()
        this.cdr.detectChanges(); // Use detectChanges to avoid ExpressionChangedAfterItHasBeenCheckedError
        return this.invService.getInventoryTabs(ACCOUNT_DATA_TABS)
      })
    )
  }

  ngAfterViewInit(): void {
    //Called after ngAfterContentInit when the component's view has been initialized. Applies to components only.
    //Add 'implements AfterViewInit' to the class.
  }

  routerLink(id?: string) {
    return id === 'account' ? ['/settings'] : ['/settings', id]
  }

  getAnimationData(outlet: RouterOutlet) {
    // return this.contexts.getContext('primary')?.route?.snapshot?.data?.['animation']
    return outlet && outlet.activatedRouteData && outlet.activatedRouteData['animation']
  }

  getRouteId(): string {
    // No logging on this path: it is called from the router-events subscriber, so a
    // `console.log` here printed the last URL segment on every navigation, in
    // production included.
    return this.router.url.split('/').pop() ?? ''
  }

  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.
    this.routeSub?.unsubscribe()
  }
}
