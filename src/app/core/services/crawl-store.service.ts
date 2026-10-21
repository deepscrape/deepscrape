import { inject, Injectable } from '@angular/core'
import { Firestore, Timestamp } from '@angular/fire/firestore'
import { FirestoreService } from './firestore.service'
import { deleteOperationDoc, storeCrawlOperation } from '../functions'
import { from } from 'rxjs/internal/observable/from'
import { BehaviorSubject, catchError, map, Observable, of, Subscription, tap, throwError } from 'rxjs'
import { CrawlOperation } from '../types'
import { SessionStorage } from './storage.service'
import { LoadingBarService } from '@ngx-loading-bar/core';


@Injectable({
  providedIn: 'root'
})
export class CrawlStoreService {

  private operationsSub: Subscription
  private operationSubject = new BehaviorSubject<CrawlOperation[] | null | undefined>(undefined)
  private totalPagesSubject = new BehaviorSubject<number>(1)
  private inTotalSubject = new BehaviorSubject<number>(0)

  private SessionStorage: Storage = inject(SessionStorage)

  operations$ = this.operationSubject.asObservable()
  totalPages$ = this.totalPagesSubject.asObservable()
  inTotal$ = this.inTotalSubject.asObservable()

  constructor(
    private firestoreService: FirestoreService,
    private firestore: Firestore,
    private loadingBar: LoadingBarService,
  ) {

    // Load existing API keys from local storage or backend
    // const storeOperations = this.SessionStorage.getItem('operations')
    this.initializeOperations(null)

    // set the firestore instance
    this.firestore = this.firestoreService.getInstanceDB('easyscrape')
  }
  /**
   * Initializes the crawl operations by updating the operation and total pages subjects.
   * If stored operations are provided, they are parsed and set in the operation subject.
   * Otherwise, operations are fetched from Firestore with pagination, and the results
   * are used to update the operation, total pages, and in total subjects.
   * Handles errors by logging them and resetting the subjects to default values.
   *
   * @param storeOperations - A JSON string of stored operations or null.
   */
  private initializeOperations(storeOperations: string | null) {
    if (storeOperations) {
      this.operationSubject.next(JSON.parse(storeOperations))
      // this.totalPagesSubject.next(1)
    } else {
      this.operationSubject.next(undefined)
      this.totalPagesSubject.next(1)
      // Get Data from Firestore
      this.operationsSub = this.getOperationsByPagination().pipe(
      ).subscribe({
        next: (results: any) => {
          const { operations, inTotal, totalPages } = results
          // include totalPages in the response
          // Update the Operations in the BehaviorSubject
          this.operationSubject.next(operations)
          this.totalPagesSubject.next(totalPages)
          this.inTotalSubject.next(inTotal)
          // this.saveOperations(operations)
        },
        error: (error: any) => {
          console.error('Error retrieving Crawl Operations:', error)
          this.operationSubject.next(null)
          this.totalPagesSubject.next(0)
          this.inTotalSubject.next(0)
        }
      })
    }


  }

  // refreshOperationsData() {

  // }


  /**
   * Sets data to the 'operation' subcollection in the users collection
   * @param userId The ID of the user
   * @param operationData The data to be stored in the operation subcollection
   * @returns A promise that resolves when the data is successfully set
   */
  storeCrawlOperation(userId: string, operationData: CrawlOperation) {

    // get the user document
    return from(storeCrawlOperation(userId, operationData, this.firestore)).pipe(
      tap(() => {

        // Get the current BehaviorSubject Value
        const crawlOperations: CrawlOperation[] | null | undefined = this.operationSubject.value
        let totalPages: number = this.totalPagesSubject.value

        if (!crawlOperations || totalPages > 1)
          return

        // keep 10 size data — pop only AT capacity. Unconditionally popping dropped
        // the oldest row of a 3-item list on every save.
        if (crawlOperations.length >= 10) {
          crawlOperations.pop()
        }
        // maintaining sorted order
        crawlOperations.unshift(operationData)

        // Update the Operations in the BehaviorSubject, 
        this.operationSubject.next(crawlOperations)

        totalPages = crawlOperations.length > 10 ? 2 : 1
        this.totalPagesSubject.next(totalPages)
      }),
      catchError((err) => {
        console.error(err)
        return throwError(() => err)
      })
    )
  }

  deleteCrawlOperation(userId: string, operationId: string, page: number, pageSize: number) {

    return from(deleteOperationDoc(userId, operationId, this.firestore)).pipe(
      tap(() => {
        // Get the current BehaviorSubject Value
        this.nextPage(page, pageSize)
      }),

      catchError((err) => {
        console.error(err)
        return throwError(() => err)
      })
    )

  }



  nextPage(page: number, pageSize: number = 10) {
    this.loadingBar.useRef().start(); // Start loading bar manually
    this.operationsSub?.unsubscribe()
    this.operationsSub = this.getOperationsByPagination(page, pageSize).pipe().subscribe({
      next: (results: any) => {
        // include totalPages in the response
        const { operations, inTotal, totalPages } = results

        // Update the Operations in the BehaviorSubject
        this.operationSubject.next(operations)
        // this.saveOperations(operations)

        // update the totalpages behavior
        this.totalPagesSubject.next(totalPages)
        this.inTotalSubject.next(inTotal)

      },
      error: (error: any) => {
        console.error('Error retrieving Crawl Operations:', error)
        this.operationSubject.next(null)
        this.totalPagesSubject.next(0)
        this.inTotalSubject.next(0)
        this.loadingBar.useRef().stop() // Stop on error
      },
      complete: () => {
        this.loadingBar.useRef().complete(); // Complete loading bar manually
      }
    })
  }

  private getOperationsByPagination(currPage: number = 1, pageSize: number = 10): Observable<any> {
    return from(this.firestoreService.callFunction<{ currPage: number; pageSize: number }, any>(
      'getOperationsPaging',
      { currPage, pageSize }
    ))
      .pipe(
        map((data: any) => {
          const { error, operations, inTotal, totalPages, message } = data as any

          if (error) {
            console.error('Error retrieving Crawl Operation:', error, operations, message)
            throw new Error(message, error)
          }

          const newOpe = operations?.map((oper: CrawlOperation): any => {
            // const created_At = (oper.created_At as any).toDate()
            // const metrics = oper.metrics ? { 
            //   ...oper.metrics, 
            //   timestamp: (oper.metrics.timestamp instanceof Timestamp) 
            //     ? (oper.metrics.timestamp as any).toDate() 
            //     : oper.metrics.timestamp 
            // } : undefined
            // oper = { ...oper, metrics }
            // const showKey = key.showKey
            return { ...oper }
          })

          return { operations: newOpe, inTotal, totalPages }
        })
      )
  }

  private operationsCaching(keys: CrawlOperation[]) {
    this.SessionStorage.setItem('operations', JSON.stringify(keys))
  }

  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.
    // this.operationSubject?.unsubscribe()
    this.operationsSub?.unsubscribe()
  }


}
