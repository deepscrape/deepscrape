import { Component, OnInit, OnDestroy, signal, WritableSignal, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormBuilder, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';

import { CartPack, CrawlPack, CrawlPackConfigs, Headers, Users } from 'src/app/core/types';
import { CartService } from 'src/app/core/services/cart.service';
import { AsyncPipe, JsonPipe, KeyValuePipe } from '@angular/common';
import { AnalyticsService, AuthService, FirestoreService, LocalStorage, SnackbarService } from 'src/app/core/services';
import { Observable } from 'rxjs/internal/Observable';
import { Subscription } from 'rxjs/internal/Subscription';
import { of } from 'rxjs/internal/observable/of';
import { from } from 'rxjs/internal/observable/from';
import { MatIcon } from '@angular/material/icon';
import { ReversePipe } from 'src/app/core/pipes';
import { formatDistanceToNow } from 'date-fns/formatDistanceToNow';
import { convertKeysToSnakeCase, switchPackageIcon, switchPackKey, } from 'src/app/core/functions';
import { ActivatedRoute, Router } from '@angular/router';
import { MarkdownModule } from 'ngx-markdown';
import { ClipboardbuttonComponent, CPackComponent, DialogComponent, SnackBarType, StinputComponent } from 'src/app/core/components';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { expandCollapseAnimation, fadeinCartItems, listStaggerAnimation } from 'src/app/animations';
import { distinctUntilChanged } from 'rxjs/internal/operators/distinctUntilChanged';
import { filter } from 'rxjs/internal/operators/filter';
import { tap } from 'rxjs/internal/operators/tap';
import { RemoveToolbarDirective, RippleDirective } from 'src/app/core/directives';
import { switchMap } from 'rxjs/internal/operators/switchMap';
import { catchError, concatMap, finalize, map, startWith, Subject, takeUntil, throwError } from 'rxjs';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { themeStorageKey } from 'src/app/shared';
import { UserInfo } from '@angular/fire/auth';

@Component({
    selector: 'app-crawlerpack',
    templateUrl: './crawlerpack.component.html',
    styleUrl: './crawlerpack.component.scss',
    imports: [ReactiveFormsModule, AsyncPipe, KeyValuePipe, JsonPipe, ReversePipe, MatIcon, MarkdownModule, RippleDirective, RemoveToolbarDirective, MatProgressSpinner, DialogComponent, CPackComponent, ReactiveFormsModule, StinputComponent, TranslateModule],
    animations: [
        // animation triggers go here
        expandCollapseAnimation,
        fadeinCartItems,
        listStaggerAnimation,
    ],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class CrawlerPackComponent implements OnInit, OnDestroy {

    private user: Users & { currProviderData: UserInfo | null } | null = null
    private localStorage = inject(LocalStorage)
    private translate = inject(TranslateService)
    readonly clipboardButton = ClipboardbuttonComponent
    previousPacks: any[] = [];
    packTitleControl: FormControl<string>

    protected loadingCartItems: boolean = false
    protected deletingCart: boolean = false
    protected cartItems$: Observable<any>
    protected itemVisibility: { [key: string]: WritableSignal<boolean> } = {};
    protected itemToJson: { [key: string]: any } = {}
    protected crawlPackages$: Observable<CrawlPack[] | null | undefined>
    private cartSubscription: Subscription | undefined
    private destroy$ = new Subject<void>()

    protected dialogOpen = signal(false);


    constructor(
        private route: ActivatedRoute,
        private cartService: CartService,
        private fireService: FirestoreService,
        private authService: AuthService,
        private router: Router,
        private snackbarService: SnackbarService
    ) {
        this.crawlPackages$ = of(undefined) // Initialize with an empty observable
    }

    ngOnInit(): void {
        this.user = this.route.snapshot.data['user']

        this.setCartItems()

        // load most 10 recent crawl packs
        this.loadCrawlPacks()

        this.packTitleControl = new FormControl<string>('', {
            nonNullable: true,
            validators: [Validators.required, Validators.maxLength(30)]
        })
    }

    private setCartItems() {
        this.cartItems$ = this.cartService.getCart$.pipe(

            // distinctUntilChanged((prevkey: any, currKey) => prevkey?.key === currKey?.uid),
            // tap((items) => console.log(items)),
            // filter(items => items !== null && items !== undefined),
            map(items => {
                if (!items) return null
                Object.keys(items).forEach((key) => {
                    if (key !== 'uid' && key !== 'type') {
                        this.itemVisibility[key] = signal(false)
                        this.itemToJson[key] = convertKeysToSnakeCase(
                            switchPackKey(key, items[key]?.config), ['headers']
                        )
                    }
                })
                return items
            }),
        )
    }
    private readonly analytics = inject(AnalyticsService)

    private loadCrawlPacks() {
        if (this.user?.uid)
            this.crawlPackages$ = from(this.fireService.loadPreviousPacks(this.user.uid))
                .pipe(startWith(undefined)) // Emit undefined initially to avoid flickering in the UI
    }

    getObjectKeys(obj: any): string[] {
        return Object.keys(obj);
    }

    protected openDialog() {
        // this.selectedUserIndex.set(index);
        this.dialogOpen.set(true)
    }

    saveCartItems() {

        if (!this.packTitleControl.valid) {
            this.showSnackbar(this.translate.instant('CRAWLER_PACK.TITLE_REQUIRED'), SnackBarType.info, '', 5000);
            return
        }
        
        let cartItems: CartPack = {} as CartPack; // Initialize with a default value
        this.cartItems$.forEach((item: CartPack) => {
            cartItems = item;
        })

        // if cartItems is not empty
        if (!cartItems) {
            this.showSnackbar(this.translate.instant('CRAWLER_PACK.CART_NO_ITEMS'), SnackBarType.info, '', 5000)
            return
        }

        // start loading spinner
        this.loadingCartItems = true

        this.cartSubscription = of(cartItems).pipe(

            concatMap((item: CartPack) => {
                console.log('cartpack', item)
                // reset items according to library configuration json format 
                const packager: any = {
                    uid: item.uid,
                    title: this.packTitleControl.value.trim(), // <-- Add this line
                    type: item.type,
                    created_at: new Date(),
                    config: {
                        type: Object.keys(this.itemToJson as CrawlPackConfigs).flatMap(key => key),
                        value: Object.values(this.itemToJson as CrawlPackConfigs).reduce<Record<string, any>>((acc, curr) => ({ ...acc, ...curr }), {}),
                    }
                }
                return from(this.fireService.saveCrawlPackToFirestore(this.user?.uid || '', packager, false)).pipe(
                    tap(() => this.analytics.trackEvent('crawlpack_created', {
                        // `packager` is the exact JSON handed to the Python service, so its
                        // type/config.type are the canonical identifiers, not the form title.
                        type: packager.type,
                        title: packager.title,
                        sections: packager.config.type,
                    }).subscribe({ error: () => undefined })),
                    catchError((error) => {
                        this.loadingCartItems = false
                        return throwError(() => error)
                    })
                )
            }),
            concatMap((done: boolean) => this.cartService.deleteCart()),
            finalize(() => {
                if (this.user?.uid)
                    this.crawlPackages$ = from(this.fireService.loadPreviousPacks(this.user.uid))
            })
        ).subscribe({
            next: (done: boolean) => {

                this.showSnackbar(this.translate.instant('CRAWLER_PACK.CART_PACKED'), SnackBarType.success, '', 5000)
            },
            error: (error: any) => {
                this.loadingCartItems = false
                this.showSnackbar(this.translate.instant('CRAWLER_PACK.CART_PACK_FAILED'), SnackBarType.error, '', 5000)
                console.error('Error saving cart items:', error)
            },
            complete: () => {
                this.loadingCartItems = false
            }
        })
    }

    deleteCart() {
        this.deletingCart = true
        this.cartService.deleteCart().
            pipe(
                takeUntil(this.destroy$)
            ).
            subscribe({
                next: (done: boolean) => {
                    this.showSnackbar(this.translate.instant('CRAWLER_PACK.CART_DELETED'), SnackBarType.success, '', 5000)
                },
                error: (error: any) => {
                    this.deletingCart = false
                    this.dialogOpen.set(false)
                    this.showSnackbar(this.translate.instant('CRAWLER_PACK.CART_DELETE_FAILED'), SnackBarType.error, '', 5000)
                    console.error('Error deleting cart:', error)
                },
                complete: () => {
                    this.deletingCart = false
                    this.dialogOpen.set(false)
                }
            })
    }

    protected openCartItem(event: Event, key: string) {
        console.log(event)
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
    }

    protected openJsonFormat(event: Event, packKey: any, packValue: any) {

        event.stopPropagation()

        // toggle visibility of packValue
        this.itemVisibility[packKey]?.update(prev => {
            if (prev) {
                return !prev
            }
            return true
        })

        // reset all boolean signal values in itemVisibility to false except packValue
        Object.keys(this.itemVisibility).forEach(key => {
            if (key !== packKey) {
                this.itemVisibility[key]?.set(false)
            }
        })
        // set itemToJson to packValue
        // this.itemToJson[packKey] = convertKeysToSnakeCase(switchPackKey(packKey, packValue?.config))
        // console.log(packKey, switchPackKey(packKey, snakeFormat))


    }
    protected openPythonFormat(event: Event, packKey: any, packValue: any) {
        event.stopPropagation()
        event.preventDefault()
        const snakeFormat = convertKeysToSnakeCase(packValue?.config)

    }

    switchIcon(packKey: string, browserType?: string): string {
        return switchPackageIcon(packKey, browserType)
    }

    protected parseCartItemDate(pastDate: number) {
        return formatDistanceToNow(new Date(pastDate), { addSuffix: true })
    }

    get isDarkTheme(): boolean {
        return this.localStorage?.getItem(themeStorageKey) === 'true'
    }

    showSnackbar(
        message: string,
        type: SnackBarType = SnackBarType.info,
        action: string | '' = '',
        duration: number = 3000) {

        this.snackbarService.showSnackbar(message, type, action, duration)
    }

    ngOnDestroy(): void {
        this.cartSubscription?.unsubscribe()
        this.destroy$.next()
        this.destroy$.complete()
    }

}
