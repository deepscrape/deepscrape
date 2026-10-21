import { AsyncPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core'
import { MatIconModule } from '@angular/material/icon'
import { TranslateModule } from '@ngx-translate/core'
import {
  BehaviorSubject, catchError, combineLatest, from, map, Observable, of, shareReplay, switchMap,
} from 'rxjs'
import { AuthService, BillingService, FirestoreService, WindowToken } from 'src/app/core/services'

interface SavedPaymentMethod {
  id: string
  brand: string | null
  last4: string | null
  expMonth: number | null
  expYear: number | null
  billingDetails: string | null
}

@Component({
  selector: 'app-paymentmethods',
  imports: [AsyncPipe, MatIconModule, TranslateModule],
  templateUrl: './paymentmethods.component.html',
  styleUrl: './paymentmethods.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PaymentMethodsComponent {
  private readonly authService = inject(AuthService)
  private readonly firestoreService = inject(FirestoreService)
  private readonly billingService = inject(BillingService)
  private readonly window: Window = inject(WindowToken)

  readonly refresh$ = new BehaviorSubject<void>(undefined)

  readonly paymentMethods$: Observable<SavedPaymentMethod[]> = combineLatest([
    this.authService.user$,
    this.refresh$,
  ]).pipe(
    switchMap(([user]) => {
      if (!user?.uid) {
        return of([])
      }

      const pmUid = user.uid
      // Stripe, not Firestore: the `payment_methods` subcollection is a webhook-fed mirror
      // and is empty whenever that event was never delivered, which read as "no cards" for
      // an account Stripe shows cards for. Reading it here also threw
      // "Expected type '_Query', but it was: a custom _CollectionReference object".
      return from(
        this.firestoreService.callFunction<
          Record<string, never>,
          { methods: SavedPaymentMethod[] }
        >('listMyPaymentMethods', {}),
      ).pipe(
        map((response) => response?.methods ?? []),
        catchError((error: unknown) => {
          console.error(`[paymentmethods] listMyPaymentMethods for ${pmUid} failed`, error)
          return of([])
        }),
      )
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  )

  getCardIcon(_brand: string | null): string {
    return 'credit_card'
  }

  getCardDisplay(pm: SavedPaymentMethod): string {
    // A Link payment method has no card number to mask; its only identifier is the email
    // the customer saved.
    if (!pm.last4) {
      return pm.billingDetails || pm.brand || 'Payment method'
    }

    const brand = pm.brand || 'card'
    return `${brand.charAt(0).toUpperCase() + brand.slice(1)} •••• ${pm.last4}`
  }

  getExpiryDisplay(pm: SavedPaymentMethod): string {
    if (!pm.expMonth || !pm.expYear) {
      return 'N/A'
    }

    return `${String(pm.expMonth).padStart(2, '0')}/${String(pm.expYear).slice(-2)}`
  }

  async addPaymentMethod(): Promise<void> {
    // Card entry is Stripe's, not ours: the platform lists what was saved, and adding or
    // replacing a card happens on the hosted portal. This used to route to the in-app
    // SetupIntent form, which went with the rest of the legacy payment flow.
    try {
      const url = await this.billingService.openBillingPortal(
        this.window.location.origin + '/billing/paymentmethods',
      )
      if (url) {
        this.window.location.assign(url)
      }
    } catch (error) {
      console.error('Unable to open billing portal', error)
    }
  }
}
