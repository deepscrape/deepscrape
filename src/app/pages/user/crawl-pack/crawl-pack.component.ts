
import { ChangeDetectorRef, Component, DestroyRef, HostBinding, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, ChildrenOutletContexts, NavigationEnd, NavigationStart, Router, RouterOutlet } from '@angular/router';
import { Subscription } from 'rxjs/internal/Subscription';
import { fadeInOutAnimation, smoothfadeAnimation } from 'src/app/animations';
import { AppTabsComponent } from 'src/app/core/components';
import { LinkTabs } from 'src/app/core/types';

@Component({
    selector: 'app-crawl-pack',
    imports: [RouterOutlet, AppTabsComponent],
    templateUrl: './crawl-pack.component.html',
    styleUrl: './crawl-pack.component.scss',
    animations: [ smoothfadeAnimation]
})
export class CrawlPackComponent {
  private contexts = inject(ChildrenOutletContexts)
  @HostBinding('class') classes = 'w-full';

  protected sourceTabUrl: string = 'crawlpack'
  protected tabs: LinkTabs[] = []

  private routerEventSubscription: Subscription
  constructor(
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute, 
    private router: Router,
    private destroyRef: DestroyRef
  ) {

    this.routerEventSubscription = this.router.events.subscribe((event: any) => {
      if (event instanceof NavigationStart) {
        // this.isLoading = true;
      } else if (event instanceof NavigationEnd) {

        this.onRouterChangeSetTabs()
        
      }
    })
  }
  ngOnInit(): void {
    //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
    //Add 'implements OnInit' to the class.
    // The Machines tab moved to a top-level route (`/machines`, see
    // `routes/user/main.route.ts`): the deploy console is not a crawl-pack setting,
    // and its list now includes machines that browser sessions own.
    // ['crawlpack', 'browserconfig', 'crawlerconfig', 'crawlresults', 'extraction']

    

    const newTabs: LinkTabs[] = [
      { label: 'Crawler Pack', active: false, icon: 'inventory_2', link: '', index: 'crawlpack' },
      { label: 'Browser Configuration', icon: 'travel_explore', active: false, link: 'browser', index: 'browserconfig' },
      { label: 'Crawler Configuration', icon: 'tune', active: false, link: 'configuration', index: 'crawlerconfig' },
      { label: 'Crawler Results', icon: 'data_object', active: false, link: 'results', index: 'crawlresults' },
      { label: 'Extraction Strategies', icon: 'output_circle', active: false, link: 'extraction', index: 'crawlextraction' },
    ]

    // push the new tabs
    this.tabs.push(...newTabs)


    this.onRouterChangeSetTabs()

  }

  private onRouterChangeSetTabs() {

    this.route.paramMap
    .pipe(
      takeUntilDestroyed(this.destroyRef)
    )
    .subscribe(params => {
      const urlPath = this.router.url
      const urlWithoutHash = urlPath.split('#')[0]
      const pathParts = urlWithoutHash.split('/')
      const lastPathPart = pathParts[pathParts.length - 1]

      this.tabs.forEach(tab => {
        if (tab.link === lastPathPart || (lastPathPart === 'crawlpack' && tab.link === '')) {
          tab.active = true
        } else {
          tab.active = false
        }
      })
    })
  }

  // Helper method to get the animation data from the router outlet
 getAnimationData() {
    return this.contexts.getContext('primary')?.route?.snapshot?.data?.['animation']
      // return outlet?.activatedRouteData?.['animation']
  }

  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.
    this.routerEventSubscription?.unsubscribe()
  }
}
