import { TestBed } from '@angular/core/testing';
import { openDB } from 'idb';

import { CartService } from './cart.service';
import { getTestProviders } from 'src/app/testing';

/** Drops `PackDB` so each case starts from a known schema. */
const deletePackDB = (): Promise<void> => new Promise((resolve) => {
  const request = indexedDB.deleteDatabase('PackDB');
  request.onsuccess = request.onerror = request.onblocked = () => resolve();
});

/** Recreates the damaged state users hit: version 1 exists, `pack` does not. */
const seedEmptyVersionOne = (): Promise<void> => new Promise((resolve, reject) => {
  const request = indexedDB.open('PackDB', 1);
  request.onsuccess = () => {
    request.result.close();
    resolve();
  };
  request.onerror = () => reject(request.error);
});

describe('CartService', () => {
  let service: CartService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: getTestProviders() });
    service = TestBed.inject(CartService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should expose cart observable stream', () => {
    expect(service.getCart$).toBeDefined();
  });

  it('should emit null as the initial cart state', (done) => {
    service.getCart$.subscribe((value) => {
      expect(value).toBeNull();
      done();
    });
  });
});

/**
 * The provider is an ORDER-level value and it used to be an accident: `type` was
 * only written when the cart was empty, so the first fragment added decided the
 * provider for the whole pack. These cases pin that a later add states its own.
 */
describe('CartService provider', () => {
  let service: CartService;

  beforeEach(() => {
    // The shared provider list swaps in a CartService stub, so the real class is
    // re-provided last (later providers win for the same token).
    TestBed.configureTestingModule({
      providers: [...getTestProviders(), CartService],
    });
    service = TestBed.inject(CartService);
    // `userId` is filled from an async auth subscription this suite does not run, and
    // `saveToIndexedDB` refuses an item with no uid. Set it here so the cases below are
    // about the provider rather than about auth wiring.
    (service as unknown as { userId: string }).userId = 'test-uid';
    // Point these cases at their OWN database. The service's `db()` opens a connection
    // it never closes, so exercising `addItemToCart` against the real `PackDB` leaves a
    // handle that blocks the schema-upgrade case later in this file -- and a blocked
    // upgrade times out rather than failing, which is exactly what the comment on that
    // case warns about. These cases are about the provider, not about the schema.
    (service as unknown as { dbName: string }).dbName = 'PackDB-provider';
    // The shared FirestoreService stub has no persistence method and `addItemToCart`
    // awaits it. Add just that one to the stub this instance was given, rather than
    // replacing the whole service, which other paths in it also use.
    const firestore = (service as unknown as {
      firestoreService: {
        savePackToFirestore?: (...args: unknown[]) => Promise<void>;
      };
    }).firestoreService;
    firestore.savePackToFirestore = () => Promise.resolve();
  });

  /** Every non-null cart emission, in order. */
  const emissions = (): any[] => {
    const seen: any[] = [];
    service.getCart$.subscribe((value) => { if (value) seen.push(value); });
    return seen;
  };

  it('records the provider on the first add', async () => {
    const seen = emissions();
    await service.addItemToCart({ browserProfile: {} }, 'webrain');
    expect(seen[seen.length - 1].type).toBe('webrain');
  });

  it('replaces the provider on a later add instead of inheriting the first', async () => {
    // Before this, the second add kept the first fragment's `crawl4ai`, which would
    // silently brand a webrain pack as crawl4ai for the whole order.
    const seen = emissions();
    await service.addItemToCart({ browserProfile: {} }, 'crawl4ai');
    await service.addItemToCart({ crawlConfig: {} }, 'webrain');
    expect(seen[seen.length - 1].type).toBe('webrain');
  });
});

/**
 * The reported failure was a browser whose `PackDB` sat at version 1 with no object stores,
 * so every read threw "One of the specified object stores was not found". IndexedDB only runs
 * `upgrade` when the requested version is higher — this is the check that the version in
 * `initDB` is high enough to heal that database, and that a read alone is enough to trigger it.
 */
/**
 * Whether `pack` exists, closing the connection it opens: a handle left open blocks the
 * service's own upgrade and the case times out instead of failing.
 */
const packStoreExists = async (): Promise<boolean> => {
  const db = await openDB('PackDB');
  const exists = db.objectStoreNames.contains('pack');
  db.close();
  return exists;
};

describe('CartService IndexedDB upgrade', () => {
  afterEach(async () => {
    await deletePackDB();
  });

  it('creates the pack store on a database stranded at version 1', async () => {
    await deletePackDB();
    await seedEmptyVersionOne();
    expect(await packStoreExists()).toBeFalse();

    // The shared provider list swaps in a CartService stub, so the real class is re-provided
    // last (later providers win for the same token). This case is about the real IndexedDB
    // behaviour, and a stub cannot have it.
    TestBed.configureTestingModule({ providers: [...getTestProviders(), CartService] });
    const service = TestBed.inject(CartService);

    await service.loadCartFromIndexedDB('someone');

    expect(await packStoreExists()).toBeTrue();
  });
});
