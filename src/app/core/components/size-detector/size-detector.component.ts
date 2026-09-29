import { AfterViewInit, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, Inject, OnInit, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { AuthService, ScreenResizeService, WindowToken } from 'src/app/core/services';
import { SCREEN_SIZE } from 'src/app/core/enum';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { timer } from 'rxjs/internal/observable/timer';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Subject, of } from 'rxjs';
import { debounceTime, switchMap } from 'rxjs/operators';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-size-detector',
  imports: [],
  templateUrl: './size-detector.component.html',
  styleUrl: './size-detector.component.scss'
})
// size-detector.component.ts

export class SizeDetectorComponent implements AfterViewInit {
  private authService = inject(AuthService)
  private isBrowser: boolean
  private destroyRef = inject(DestroyRef)
  private _window = inject(WindowToken); // or window = inject(WINDOW);
  private animationFrameId: number | null = null;
  private fingerprint$ = new Subject<any>();

  prefix = 'is-';
  sizes = [
    {
      id: SCREEN_SIZE.XXS, name: 'xxs', css: `block xs:hidden` // `d-block d-xs-none`
    },
    {
      id: SCREEN_SIZE.XS, name: 'xs', css: `block sm:hidden` // `d-block d-sm-none`
    },
    {
      id: SCREEN_SIZE.SM, name: 'sm', css: `hidden sm:block md:hidden` // `d-none d-sm-block d-md-none`
    },
    {
      id: SCREEN_SIZE.MD, name: 'md', css: `hidden md:block lg:hidden`  // `d-none d-md-block d-lg-none`
    },
    {
      id: SCREEN_SIZE.LG, name: 'lg', css: `hidden lg:block xl:hidden` // `d-none d-lg-block d-xl-none`
    },
    {
      id: SCREEN_SIZE.XL, name: 'xl', css: `hidden xl:block 2xl:hidden` // `d-none d-xl-block d-xxl-none`
    },
    {
      id: SCREEN_SIZE.XXL, name: '2xl', css: `hidden 2xl:block 3xl:hidden` // `d-none d-xxl-block`
    },
    {
      id: SCREEN_SIZE.XXXL, name: '3xl', css: `hidden 3xl:block` // `d-none d-xxl-block`
    },

  ];

  @HostListener("window:resize")
  public onResize() {
    if (this.animationFrameId) {
      this._window.cancelAnimationFrame(this.animationFrameId);
    }

    this.animationFrameId = this._window.requestAnimationFrame(() => {
      this.detectScreenSize();
    });
  }

  constructor(
    private elementRef: ElementRef,
    private resizeSvc: ScreenResizeService,
    @Inject(PLATFORM_ID) private platformId: Object,
    private http: HttpClient
  ) {
    this.isBrowser = isPlatformBrowser(this.platformId)
    // Set up fingerprint posting pipeline once
    this.fingerprint$
      .pipe(
        debounceTime(500),
        switchMap(data => {
          const token = this.authService.token;
          if (!token) return of(null); // Skip if no token
          const headers = new HttpHeaders({
            'Authorization': token ? `Bearer ${token}` : '',
            'Accept': 'application/json',
          });
          return this.http.post('/event/guest-fingerprint', data, { headers });
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe();
  }

  ngAfterViewInit() {
    if (this.isBrowser) {
      timer(100)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
              this.detectScreenSize()
            })
    }
  }


  private detectScreenSize() {


    const currentSize = this.sizes.find(x => {
      // get the HTML element
      const el = this.elementRef.nativeElement.querySelector(`.${this.prefix}${x.id}`);

      // check its display property value
      const isVisible = this._window.getComputedStyle(el).display !== 'none';

      return isVisible;
    })

    if (currentSize) {
      this.resizeSvc.onResize(currentSize.id);
      // Emit fingerprint data for analytics
      const fingerprintData = this.resizeSvc.getFingerprintData();
      this.fingerprint$.next(fingerprintData);
    }
  }
}
