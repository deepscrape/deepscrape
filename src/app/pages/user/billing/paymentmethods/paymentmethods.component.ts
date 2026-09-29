import { AsyncPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core'
import { MatIconModule } from '@angular/material/icon'
import { TranslateModule } from '@ngx-translate/core'
import {
  BehaviorSubject, catchError, combineLatest, from, map, Observable, of, shareReplay, switchMap,
} from 'rxjs'
import { collection, collectionData, Firestore, query } from '@angular/fire/firestore'
import { AuthService, BillingService, WindowToken } from 'src/app/core/services'

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
  private readonly firestore = inject(Firestore)
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
      const pmCollection = collection(this.firestore, `users/${pmUid}/payment_methods`)
      const pmQuery = query(pmCollection)
      return (collectionData(pmQuery, { idField: 'id' }) as Observable<SavedPaymentMethod[]>).pipe(
        // Do NOT swallow this silently. An earlier `catchError(() => of([]))` turned a
        // permission-denied (no nested rules block for this subcollection) into the
        // "No payment methods saved" empty state, which hid the cause and cost two rounds
        // of remote debugging. The uid is logged with it so a path/uid mismatch is
        // distinguishable from a denied read.
        catchError((error: unknown) => {
          console.error(`[paymentmethods] read of users/${pmUid}/payment_methods failed`, error)
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
    const brand = pm.brand || 'card'
    const last4 = pm.last4 || '****'
    return `${brand.charAt(0).toUpperCase() + brand.slice(1)} •••• ${last4}`
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
