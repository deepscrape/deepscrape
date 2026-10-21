import { inject, Injectable } from '@angular/core'
import { FlyMachine } from '../types'
import { BehaviorSubject } from 'rxjs/internal/BehaviorSubject'
import { SessionStorage } from './storage.service'
import { FirestoreService } from './firestore.service'
import { Firestore } from '@angular/fire/firestore'
import { LoadingBarService } from '@ngx-loading-bar/core'
import { Subscription } from 'rxjs/internal/Subscription'
import { Observable } from 'rxjs/internal/Observable'
import { from } from 'rxjs/internal/observable/from'
import { map } from 'rxjs/internal/operators/map'
import { switchMap } from 'rxjs/internal/operators/switchMap'
import { AuthService } from './auth.service'

@Injectable({
  providedIn: 'root'
})
export class MachineStoreService {

  private machinesSub: Subscription
  private machineSubject = new BehaviorSubject<FlyMachine[] | null | undefined>(undefined)
  private totalPagesSubject = new BehaviorSubject<number>(1)
  private inTotalSubject = new BehaviorSubject<number>(0)
  private machinePageCursors = new Map<string, Map<number, string | null>>()
  private SessionStorage: Storage = inject(SessionStorage)


  machines$ = this.machineSubject.asObservable()
  totalPages$ = this.totalPagesSubject.asObservable()
  inTotal$ = this.inTotalSubject.asObservable()

  constructor(
    private firestoreService: FirestoreService,
    private loadingBar: LoadingBarService,

    private auth: AuthService
  ) {


    this.initializeOperations(null)
  }

  private initializeOperations(storeMachines: string | null) {
    if (storeMachines) {
      this.machineSubject.next(JSON.parse(storeMachines))
      // this.totalPagesSubject.next(1)
    } else {
      this.machineSubject.next(undefined)
      this.totalPagesSubject.next(1)
      // Get Data from Firestore
      this.machinesSub = this.getMachinesByPagination().pipe(
      ).subscribe({
        next: (results: any) => {
          const { machines, inTotal, totalPages } = results
          // include totalPages in the response
          // Update the Machines in the BehaviorSubject
          this.machineSubject.next(machines)
          this.totalPagesSubject.next(totalPages)
          this.inTotalSubject.next(inTotal)
          // this.saveMachines(machines)
        },
        error: (error: any) => {
          console.error('Error retrieving machines:', error)
          this.machineSubject.next(null)
          this.totalPagesSubject.next(0)
          this.inTotalSubject.next(0)
        }
      })
    }
  }

  private getCursorKey(state: string | null): string {
    return state || '__all__'
  }

  private getCursorStore(state: string | null): Map<number, string | null> {
    const key = this.getCursorKey(state)
    let store = this.machinePageCursors.get(key)

    if (!store) {
      store = new Map<number, string | null>([[1, null]])
      this.machinePageCursors.set(key, store)
    }

    return store
  }

  private async resolveMachinePageCursor(currPage: number, pageSize: number, state: string | null): Promise<string | null> {
    const cursorStore = this.getCursorStore(state)
    if (currPage <= 1) {
      cursorStore.set(1, null)
      return null
    }

    const knownCursor = cursorStore.get(currPage)
    if (knownCursor === null) {
      // Only page 1 legitimately starts at null. A cached null for a later page
      // means the previous page reported `hasMore: false`, so fetching with it
      // would silently show page 1's machines labelled as page N.
      throw new Error('Requested page exceeds total pages.')
    }
    if (knownCursor !== undefined) {
      return knownCursor
    }

    let knownPage = 1
    for (const page of Array.from(cursorStore.keys()).sort((left, right) => left - right)) {
      if (page <= currPage) {
        knownPage = page
      }
    }

    let lastDocId = cursorStore.get(knownPage) ?? null

    while (knownPage < currPage) {
      const response = await this.firestoreService.callFunction<
        { pageSize: number; state: string | null; lastDocId: string | null },
        { hasMore: boolean; nextLastDocId: string | null }
      >('getMachinesPaging', { pageSize, state, lastDocId })

      cursorStore.set(knownPage + 1, response?.nextLastDocId ?? null)

      if (!response?.hasMore && knownPage + 1 < currPage) {
        throw new Error('Requested page exceeds total pages.')
      }

      lastDocId = response?.nextLastDocId ?? null
      knownPage += 1
    }

    return cursorStore.get(currPage) ?? null
  }

  private getMachinesByPagination(currPage: number = 1, pageSize: number = 10, state: string | null = null): Observable<any> {
    return from(this.resolveMachinePageCursor(currPage, pageSize, state)).pipe(
      switchMap((lastDocId) => from(this.firestoreService.callFunction<{ pageSize: number; state: string | null; lastDocId: string | null }, any>(
        'getMachinesPaging',
        { pageSize, state, lastDocId }
      ))),
      map((data: any) => {
          const { error, machines, inTotal, totalPages, message, nextLastDocId } = data as any

          if (error) {
            console.error('Error retrieving machines by pagination:', error, machines, message)
            throw new Error(message, error)
          }

          this.getCursorStore(state).set(currPage + 1, nextLastDocId ?? null)

          const newMachine = machines?.map((machine: FlyMachine): any => {
            // const created_At = (machine.created_at as any).toDate() // new Date((((key.created_At as any)._seconds * 1000) + ((key.created_At as any)._nanoseconds / 1000000)))
            // const showKey = key.showKey
            return { ...machine }
          })

          return { machines: newMachine, inTotal, totalPages }
      })
    )
  }


  nextPage(page: number, pageSize: number = 10, state = null): void {
    this.loadingBar.useRef().start(); // Start loading bar manually
    this.machinesSub?.unsubscribe()
    this.machinesSub = this.getMachinesByPagination(page, pageSize, state)
      .pipe()
      .subscribe({
        next: (results: any) => {
          // include totalPages in the response
          const { machines, inTotal, totalPages } = results

          // Update the Operations in the BehaviorSubject
          this.machineSubject.next(machines)
          // this.saveOperations(operations)

          // update the totalpages behavior
          this.totalPagesSubject.next(totalPages)
          this.inTotalSubject.next(inTotal)

        },
        error: (error: any) => {
          console.error('Error retrieving Machines list:', error)
          this.machineSubject.next(null)
          this.totalPagesSubject.next(0)
          this.inTotalSubject.next(0)
          this.loadingBar.useRef().stop() // Stop on error
        },
        complete: () => {
          this.loadingBar.useRef().complete(); // Complete loading bar manually
        }
      })
  }


  /**
   * The function `updateMachineState` updates the state of a machine identified by its ID in a
   * BehaviorSubject array of machines.
   * @param {string} machineId - The `machineId` parameter is a string that represents the unique
   * identifier of the machine whose state needs to be updated.
   * @param {string} state - The `state` parameter in the `updateMachineState` function represents the
   * new state that you want to update for a specific machine identified by `machineId`. This function
   * is designed to update the state of a machine in a list of machines stored in a BehaviorSubject. By
   * providing the `machineId`
   */
  updateMachineState(machineId: string, state: string): void {

    // Get the current value of machines from the BehaviorSubject
    const currentMachines = this.machineSubject.getValue()

    // Check if machines is not undefined or null before proceeding
    if (currentMachines) {
      // Find the index of the machine to update
      const index = currentMachines.findIndex(m => m.id === machineId);

      // If the machine is found, update its state
      if (index > -1) {
        // Create a new array to trigger change detection
        const updatedMachines = [...currentMachines];
        updatedMachines[index] = { ...updatedMachines[index], state: state };

        // Update the BehaviorSubject with the new array
        this.machineSubject.next(updatedMachines);
      }
    }

  }

  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.
    this.machinesSub?.unsubscribe()
  }

}
