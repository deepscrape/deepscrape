import { AsyncPipe, DatePipe, JsonPipe, KeyValuePipe } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, inject, Input, Output } from '@angular/core';
import { Outsideclick } from '../../directives';
import { MatIcon } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { PopupAnimation } from 'src/app/animations';
import { CartService, ToggleBtnService } from '../../services';
import { catchError, map, Observable, of, shareReplay, Subscription, tap } from 'rxjs';
import { formatDistanceToNow } from 'date-fns/formatDistanceToNow';
import { Router } from '@angular/router';
import { ReversePipe } from '../../pipes';
import { switchPackageIcon } from '../../functions';

@Component({
  selector: 'app-dropdown-cart',
  imports: [Outsideclick, MatIcon, AsyncPipe, KeyValuePipe, ReversePipe, TranslateModule],
  templateUrl: './dropdown-cart.component.html',
  styleUrl: './dropdown-cart.component.scss',
  animations: [PopupAnimation],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DropdownCartComponent {


  @Input() showCartMenu: boolean = false

  date: string = ''
  packagesLoading: boolean = false
  cartItems$: Observable<{ [key: string]: any }>

  private cartService = inject(CartService)
  private btnService = inject(ToggleBtnService)
  private cdr = inject(ChangeDetectorRef)

  private btnSubs: Subscription


  constructor(private router: Router) {

    this.cartItems$ = this.cartService.getCart$/* .pipe(
      // FIXME: this.cartItems$ is not working properly
      map((items: { [key: string]: any }) => Object.entries(items).map(([key, value]) => ({ key, value }))),
      map(items => items.sort((a, b) => {
        if (a.key === 'uid') return -1
        // Sort by created_At field in descending order
        const dateA = new Date(a.value.created_At)
        const dateB = new Date(b.value.created_At)

        return dateB.getTime() - dateA.getTime()
      })),
      map(items => {
        const result: any = {};
        // console.log(items.reverse())
        for (const { key, value } of items) {
          result[key] = value
          console.log(key)
        }
        return result;
      }),
      catchError(error => {
        console.error(error);
        return of([]); // or some other default value
      })
    ) */
  }

  ngOnInit() {
    this.btnSubs = this.btnService.menuOpen$.subscribe((open) => {
      this.showCartMenu = open
      // OnPush: written from a service stream, not a template event.
      this.cdr.markForCheck()
    })
  }


  protected closeCartMenu(event: any) {
    // if user press profile button
    // Delay click detection to allow button click event to process first
    setTimeout(() => {

      // on outside click
      this.btnService.closeMenu()
    }, 100)
  }

  protected openLinkMenu(event: Event, key: string) {
    console.log(key)
    switch (key) {
      case 'browserProfile':
        this.router.navigate(['/crawlpack/browser'], { fragment: 'controlling-each-browser' })
        break
      case 'crawlConfig':
        this.router.navigate(['/crawlpack/configuration'], { fragment: 'controlling-each-crawl' })
        break
      case 'crawlResultConfig':
        this.router.navigate(['/crawlpack/results'], { fragment: 'controlling-each-crawl-result' })
        break
      default:
        break
    }

    this.closeCartMenu(event)

  }

  switchIcon(packKey: string, browserType?: string): string {
    return switchPackageIcon(packKey, browserType)
  }


  protected parseCartItemDate(pastDate: number) {
    return formatDistanceToNow(new Date(pastDate), { addSuffix: true })
  }
  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.
    this.btnSubs?.unsubscribe()
  }
}
