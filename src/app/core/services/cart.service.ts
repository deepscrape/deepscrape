import { DestroyRef, inject, Injectable, OnDestroy } from '@angular/core'
import { Firestore, doc, setDoc, getDoc, onSnapshot, deleteDoc, collection, docSnapshots, connectFirestoreEmulator } from '@angular/fire/firestore'
import { openDB } from 'idb'
import { BehaviorSubject, catchError, from, map, Observable, of, throwError } from 'rxjs'
import { AuthService } from './auth.service'
import { FirestoreService } from './firestore.service'
import { BrowserConfig, BrowserProfile, CrawlConfig, CrawlPack, CrawlProvider, CrawlResult, CrawlResultConfig } from '../types'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'

@Injectable({ providedIn: 'root' })
export class CartService implements OnDestroy {
  private cartItemSubject = new BehaviorSubject<any>(null)
  private dbName = 'PackDB'
  private storeName = 'pack'
  private userId: string = ''
  private cartUnsubscribe: (() => void) | null = null

  private destroyRef = inject(DestroyRef)

  constructor(
    // private firestore: Firestore,
    private authService: AuthService,
    private firestoreService: FirestoreService
  ) {

    this.authService.user$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((user) => {
      void this.handleUserChange(user?.uid ?? '')
    })
    
    // set the firestore instance
    // this.firestore = this.firestoreService.getInstanceDB('easyscrape')

    this.initDB()
  }

  private async handleUserChange(nextUserId: string): Promise<void> {
    if (this.userId === nextUserId) {
      return
    }

    this.stopFirestoreListener()
    this.userId = nextUserId

    if (!this.userId) {
      this.cartItemSubject.next(null)
      return
    }

    await this.loadCartFromIndexedDB(this.userId)
    this.listenToFirestoreChanges(this.userId)
  }
  // Initialize IndexedDB
  private async initDB() {

    const storeName = this.storeName

    try {
      // Version 2 because version 1 is already out there without this store: a visitor who
      // was signed in on load reached `loadCartFromIndexedDB` first, and a version-less
      // `openDB` creates the database EMPTY at version 1. IndexedDB only runs `upgrade` when
      // the requested version is higher, so `pack` was never created again in that browser
      // and every later transaction threw "One of the specified object stores was not found".
      await openDB(this.dbName, 2, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: 'uid' })
          }
        },
      })
    } catch (error) {
      console.error('Error initializing IndexedDB:', error)
    }
  }

  /**
   * The only way in. Every read and write goes through here, so the upgrade above always
   * completes before a transaction is opened — the race that created the empty database is
   * not something a call site has to remember.
   */
  private async db() {
    await this.initDB()
    return openDB(this.dbName)
  }

  // Get current cart as Observable
  get getCart$(): Observable<any> {
    return this.cartItemSubject.asObservable() // BrowserProfile | CrawlConfig | CrawlResultConfig
  }

  // Save cart item to IndexedDB
  private async saveToIndexedDB(item: any) {
    if (!item.uid)
      throw new Error('Item must have an uid property')

    const db = await this.db()
    const tx = db.transaction(this.storeName, 'readwrite')
    await tx.store.put(item)
    await tx.done
  }

  private async deletFromIndexedDB(id: string) {
    // Delete from IndexDb
    const db = await this.db()
    const tx = db.transaction(this.storeName, 'readwrite')
    await tx.store.delete(id)
    await tx.done

    this.cartItemSubject.next(null)
  }

  // Load cart from IndexedDB
  async loadCartFromIndexedDB(id: string = this.userId) {
    try {
      const db = await this.db()
      const item = await db.get(this.storeName, id)
      if (item) this.cartItemSubject.next(item)
    } catch (error) {
      console.error('Error loading cart from IndexedDB:', error)
    }
  }

  // Save to Firestore
  private async saveToFirestore(item: any) {
    // Save to Firestore
    await this.firestoreService.savePackToFirestore(this.userId, item, false)
  }

  private async updateToFirestore(item: any) {
    // Save to Firestore
    await this.firestoreService.savePackToFirestore(this.userId, item, false)
  }

  private async deleteFromFirestore() {
    // Save to Firestore
    await this.firestoreService.deletePackFromFirestore(this.userId)
  }

  // Listen for Firestore changes and update IndexedDB
  private listenToFirestoreChanges(userId: string) {
    try {
      console.log('Listening to Firestore changes...')
      if (!userId) return
      const cartRef = this.firestoreService.doc(`users/${userId}/cartpack/${userId}`)
      this.cartUnsubscribe = onSnapshot(cartRef, async (docSnap) => {
        if (docSnap.exists()) {
          const item = docSnap.data();

          // Compare Firestore data with current cart item
          // if (JSON.stringify(item) !== JSON.stringify(this.cartItemSubject.value)) {
          if (Object.keys(item).length === 1 && item?.['uid']) {
            this.cartItemSubject.next(null)
            await this.deletFromIndexedDB(userId)
            return
          }
          console.log('Firestore data changed:', item)
          this.cartItemSubject.next(item)
          await this.saveToIndexedDB(item)
          // }
        } else {
          // Deleted on another device. Doing nothing here left the IndexedDB copy in
          // place, so the next add restored a pack the customer had removed.
          this.cartItemSubject.next(null)
          await this.deletFromIndexedDB(userId)
        }
      })

    } catch (error) {
      console.log('Listening to Firestore changes error', error)
    }
  }

  private stopFirestoreListener(): void {
    if (this.cartUnsubscribe) {
      this.cartUnsubscribe()
      this.cartUnsubscribe = null
    }
  }

  /**
   * Add a configured fragment to the cart, which becomes the pack document.
   *
   * `provider` is required and typed. It used to be a second parameter defaulting
   * to `'crawl4ai'`, so a caller that omitted it was silently branded crawl4ai --
   * and because `type` was only written when the cart was EMPTY, whichever fragment
   * happened to be added first decided the provider for the entire pack. Every add
   * now states its provider, so the value is the caller's declared one rather than
   * an accident of ordering.
   *
   * @param {any} item The fragment to merge into the cart.
   * @param {CrawlProvider} provider The engine that will execute this pack.
   * @return {Promise<void>} Resolves once the cart has been persisted.
   */
  async addItemToCart(item: any, provider: CrawlProvider): Promise<void> {
    const previousCart = this.cartItemSubject.value
    // `userId` is filled from an async auth subscription, so a fragment added before
    // it resolves would carry an empty uid -- and `saveToIndexedDB` refuses that with
    // "Item must have an uid property". Fall back to the uid already on the cart
    // rather than clobbering a good one with an empty string.
    const uid = this.userId || previousCart?.uid || ''
    item = { ...(previousCart ?? {}), ...item, type: provider, uid }

    this.cartItemSubject.next(item)
    await Promise.all([
      this.saveToIndexedDB(item),
      this.saveToFirestore(item)
    ])
  }

  // Remove crawlpack item from cart
  async removeItemFromCart(attributeName: string) {
    // Get the current cart item
    const currentCartItem = this.cartItemSubject.value
    const hasAttribute = attributeName in currentCartItem

    // If the item inlucded in the current cart, remove the item from the cart
    if (hasAttribute && currentCartItem) {
      // Remove the attribute from the item
      delete currentCartItem[attributeName]

      // update indexedDB
      this.cartItemSubject.next(currentCartItem)
      await this.saveToIndexedDB(currentCartItem)

      // update to firestore
      await this.updateToFirestore(currentCartItem)
    }
    // if current cart has only uid or type or both attribute, delete the cart from firestore
    const keys = Object.keys(currentCartItem);
    const hasUid = keys.includes('uid')
    const hasType = keys.includes('type')
    if (
      (hasUid && hasType && keys.length === 2) ||
      ((hasUid || hasType) && keys.length === 1)
    ) {
      await this.deletion()
    }
  }

  deleteCart(): Observable<boolean> {
    return from(this.deletion()).pipe(
      // If both promises resolve, emit true
      // If any fails, error will be caught by catchError
      map(() => true),
      catchError((error) => {
        console.log('Error deleting cart:', error)
        return throwError(() => new Error('Failed to delete cart'))
      })
    )
  }

  private async deletion() {
    await Promise.all([
      this.deletFromIndexedDB(this.userId),
      this.deleteFromFirestore()
    ])
  }

  ngOnDestroy(): void {
    this.stopFirestoreListener()
    this.cartItemSubject?.complete()
  }
}
