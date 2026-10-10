import { AsyncPipe, DatePipe, NgClass } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, inject, signal, ViewChild, WritableSignal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { from, map, tap } from 'rxjs';
import { Observable } from 'rxjs/internal/Observable';
import { of } from 'rxjs/internal/observable/of';
import { throwError } from 'rxjs/internal/observable/throwError';
import { catchError } from 'rxjs/internal/operators/catchError';
import { concatMap } from 'rxjs/internal/operators/concatMap';
import { Subscription } from 'rxjs/internal/Subscription';
import { AppDockerStepperComponent, ContainerBoxComponent, RadioButtonComponent, SlideInModalComponent, SnackBarType } from 'src/app/core/components';
import { BrowserSessionPanelComponent } from 'src/app/core/components/browser-session/browser-session-panel.component';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { RippleDirective, TooltipDirective } from 'src/app/core/directives';
import { MACHNINE_STATE } from 'src/app/core/enum';
import { describeMachineFailure } from 'src/app/core/functions';
import { FormControlPipe } from 'src/app/core/pipes';
import { DeploymentService, FirestoreService, LocalStorage, MachineStoreService, ScrollService, SnackbarService } from 'src/app/core/services';
import { FlyMachine, MachineResponse } from 'src/app/core/types';
import { themeStorageKey } from 'src/app/shared/theme-picker/theme-picker.component';

@Component({
    selector: 'app-machines',
    imports: [ContainerBoxComponent, NgClass, ReactiveFormsModule, MatIcon, SlideInModalComponent, RippleDirective, TooltipDirective, AppDockerStepperComponent, MatProgressSpinner, AsyncPipe, FormControlPipe, TranslateModule, BrowserSessionPanelComponent],
    templateUrl: './machines.component.html',
    styleUrl: './machines.component.scss',
    // OnPush, per the repository rule. The tab previously ran on the default strategy
    // and reached for `ChangeDetectorRef.detectChanges()` to refresh after the modal
    // subscription wrote state, which is what the omission had cost.
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class MachinesComponent {
    private cdr = inject(ChangeDetectorRef)
    private destroyRef = inject(DestroyRef)
    @ViewChild(AppDockerStepperComponent, { static: false }) dockerStepper: AppDockerStepperComponent
    private localStorage: Storage = inject(LocalStorage)
    private deploySub: Subscription
    protected modalOpened: boolean = false
    protected isModalOpen: FormControl<boolean>
    protected isModalLoading: { modal: boolean, visibility: { [key: string]: boolean } }
    protected newMachineName: FormControl<string>

    // Task runner state. `isTaskModalOpen` is deliberately its own control rather
    // than a reuse of `isModalOpen`, whose valueChanges resets the deploy stepper.
    protected isTaskModalOpen: FormControl<boolean>
    protected taskPayload: FormControl<string>
    protected taskMachineId: string = ''
    protected isTaskRunning: boolean = false

    // Signals
    protected currentStep = signal(1)
    // protected playPressed: WritableSignal<boolean> = signal(false)

    /**
     * The machines a browser session owns, keyed by machine id to session id.
     *
     * Loaded from `GET /api/machines`, which joins the caller's session records on
     * the server. It is deliberately NOT derived from the `bs-` machine-name
     * prefix: that convention has nothing enforcing it, and this data decides
     * whether a destructive action may be offered on a row.
     *
     * Empty on failure, deliberately. A failed annotation must not take the
     * container console down, and treating the unknown as "container" is at worst
     * today's behaviour rather than a new one.
     */
    protected readonly sessionMachineIds = signal<Record<string, string>>({})

    /**
     * Whether a machine is owned by a browser session.
     * @param {string} machineId The machine id.
     * @return {boolean} True when a session owns it.
     */
    protected isSessionMachine(machineId: string): boolean {
        return Boolean(this.sessionMachineIds()[machineId])
    }

    /**
     * Learn which of the caller's machines a browser session owns.
     *
     * A separate call from the list on purpose: the list is paginated through the
     * `getMachinesPaging` callable, and this is one read of the whole set, so
     * coupling them would refetch the kinds on every page change for no benefit.
     * @return {void} Nothing.
     */
    protected loadMachineKinds(): void {
        this.deployService.listMine()
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: reply => {
                    const owned: Record<string, string> = {}
                    for (const machine of reply.machines ?? []) {
                        if (machine.kind === 'browser-session' && machine.sessionId) {
                            owned[machine.id] = machine.sessionId
                        }
                    }
                    this.sessionMachineIds.set(owned)
                },
                error: error => {
                    console.error('Error loading machine kinds:', error)
                },
            })
    }

    // validation
    protected isDeploying: boolean = false

    protected machines$: Observable<FlyMachine[] | null | undefined>
    protected totalMachinePages$: Observable<number>
    protected inTotal$: Observable<number>

    protected currMachinePage: number = 1

    protected createMachineForm: any;

    constructor(
        private formBuilder: FormBuilder,
        private deployService: DeploymentService,
        private machineStoreService: MachineStoreService,
        private snackbarService: SnackbarService,
        private scrollService: ScrollService,
        private translate: TranslateService,
    ) {
    }

    ngOnInit(): void {
        //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
        //Add 'implements OnInit' to the class.
        this.initMachines()
        // Annotate rows with what each machine is for. Independent of the list
        // call so a failure here cannot stop the console from loading.
        this.loadMachineKinds()

        this.initMachineForm()
    }

    ngAfterViewInit(): void {
        //Called after ngAfterContentInit when the component's view has been initialized. Applies to components only.
        //Add 'implements AfterViewInit' to the class.
        this.modalOpenChanged()
    }

    private initMachines(): void {

        this.machines$ = this.machineStoreService.machines$
        this.totalMachinePages$ = this.machineStoreService.totalPages$
        this.inTotal$ = this.machineStoreService.inTotal$
    }

    private initMachineForm(): void {
        this.isModalLoading = { modal: false, visibility: {} }
        this.isModalOpen = new FormControl<boolean>(false, { nonNullable: true })

        this.isTaskModalOpen = new FormControl<boolean>(false, { nonNullable: true })
        this.taskPayload = new FormControl<string>(
            JSON.stringify({ urls: ['https://example.com'] }, null, 2),
            { nonNullable: true }
        )

        this.createMachineForm = this.formBuilder.group({
            name: [''],
            cpu: [0],
            memory: [0],
            network: ['public'],
            performance: ['Shared'],
            image: ['default']
        })
        // this.newMachineName = new FormControl<string>('', { nonNullable: true, validators: [Validators.required] })

    }

    private modalOpenChanged(): void {
        this.isModalOpen.valueChanges.pipe(
            takeUntilDestroyed(this.destroyRef)
        ).subscribe((isOpen) => {
            
            this.modalOpened = isOpen
            console.log('Modal open state changed:', isOpen, this.modalOpened)
            if (!isOpen) {
                // reset the stepper
                this.currentStep.set(1)
                // reset the form
                this.createMachineForm.reset()
                // reset the stepper component
                this.dockerStepper.formStep1.reset()
                this.dockerStepper.formStep2.reset()
                this.dockerStepper.formStep3.reset()
                this.dockerStepper.currentStep.set(1)
            }
            this.handleScrollbar(!isOpen)
            // detect changes
            this.cdr.detectChanges()
        })
    }

    /* Machine Actions */
    createMachine(): void {

        // this.modalOpened = !this.modalOpened

        // this.showSettings = this.newProfileOpened

        // reset saving state
        // this.savingNewContainer = false

        this.isModalOpen.setValue(true)

        // reset form to default values
        this.createMachineForm.reset()

        // Implement your machine creation logic here
        // console.log(this.createMachineForm.value)
    }

    startMachine(machine: { id: string, laststate: string, instance_id: string }) {
        // Implement your machine start/stop logic here
        this.showSnackbar(`Machine ${machine.id} starting`, SnackBarType.info)
        this.deploySub = this.deployService.startMachine(machine.id)
            .pipe(
                concatMap((response: any) => {
                    console.log('Machine starting waiting for state change:', response.message)
                    return this.deployService.waitforState(machine.id, machine.instance_id, MACHNINE_STATE.STARTED).pipe(
                        catchError((error) => {
                            console.error('Error waiting for state change:', error)
                            return throwError(() => error)
                        })
                    )
                })
            )
            .subscribe({
                next: (response: any) => {
                    this.machineStoreService.nextPage(1, 10)
                    this.showSnackbar(`Machine ${machine.id} started`, SnackBarType.success)
                },
                error: (error: any) => {
                    console.error('Error starting machine:', error)
                    this.machineStoreService.updateMachineState(machine.id, machine.laststate)
                    this.showSnackbar(`Machine ${machine.id} starting failed`, SnackBarType.error)
                },
                complete: () => {
                    this.deploySub?.unsubscribe()
                }
            });
    }
    suspendMachine(machine: any): void {
        // Implement your suspend machine logic here
        machine.status = 'Suspended';
        this.showSnackbar(`Machine ${machine.id} suspending`, SnackBarType.info)
        this.deploySub = this.deployService.suspendMachine(machine.id)
            .pipe(
                concatMap((response: any) => {
                    console.log('Machine suspending waiting for state change:', response.message)
                    return this.deployService.waitforState(machine.id, machine.instance_id, MACHNINE_STATE.SUSPENDED).pipe(
                        catchError((error) => {
                            console.error('Error waiting for state change:', error)
                            return throwError(() => error)
                        })
                    )
                })
            )
            .subscribe({
                next: (response: any) => {
                    this.machineStoreService.nextPage(1, 10)
                    this.showSnackbar(`Machine ${machine.id} suspended`, SnackBarType.success)
                },
                error: (error: any) => {
                    console.error('Error suspending machine:', error)
                    this.machineStoreService.updateMachineState(machine.id, machine.laststate)
                    this.showSnackbar(`Machine ${machine.id} suspending failed`, SnackBarType.error)
                },
                complete: () => {
                }
            })

    }

    /**
     * Refuse a container lifecycle action on a machine a browser session owns.
     *
     * The container console lists `users/{uid}/machines`, and a session's machine
     * lives in that same collection under `bs-<sessionId>`, so session machines
     * have always appeared in this list. Destroying one does NOT end the session:
     * the session record survives and `chargeSessionMeter` bills from the record
     * rather than from the machine, so the customer keeps paying until the spend
     * ceiling and the idle reaper catch up, with nothing left to connect to.
     *
     * This is a pre-existing hazard rather than one introduced by putting the
     * sessions on this page, and it is guarded here, at the point of damage,
     * because this is the code that does the damage.
     *
     * The session panel owns these machines: ending one there stops the meter and
     * the record together.
     * @param {string} machineId The machine the action targeted.
     * @return {boolean} True when the action was refused.
     */
    protected refuseSessionOwnedAction(machineId: string): boolean {
        if (!this.isSessionMachine(machineId)) {
            return false
        }
        this.showSnackbar(
            this.translate.instant('MACHINES.SESSION_OWNED'),
            SnackBarType.error,
        )
        return true
    }

    stopMachine(machine: { id: string, laststate: string, instance_id: string }): void {

        // A session's machine is the session's to stop.
        if (this.refuseSessionOwnedAction(machine.id)) {
            return
        }

        this.showSnackbar(`Machine ${machine.id} stopping`, SnackBarType.info)
        this.machineStoreService.updateMachineState(machine.id, MACHNINE_STATE.STOPPING)

        this.deploySub = this.deployService.stopMachine(machine.id)
            .pipe(
                concatMap((response: any) => {
                    console.log('Machine stopping waiting for state change:', response.message)
                    return this.deployService.waitforState(machine.id, machine.instance_id, MACHNINE_STATE.STOPPED).pipe(
                        catchError((error) => {
                            console.error('Error waiting for state change:', error)
                            return throwError(() => error)
                        })
                    )
                })
            )
            .subscribe({
                next: (response: any) => {
                    // update machine state to 'stopped'
                    // machine reaced the e desired state
                    this.machineStoreService.nextPage(1, 10)
                    this.showSnackbar(`Machine ${machine.id} ${MACHNINE_STATE.STOPPED}`, SnackBarType.success)
                },
                error: (error) => {
                    console.error('Error stopping machine:', error)
                    this.machineStoreService.updateMachineState(machine.id, machine.laststate)
                    this.showSnackbar(`Machine ${machine.id} stopping failed`, SnackBarType.error)
                }
            })

    }

    destroyMachine(machine: { id: string, laststate: string, instance_id: string }): void {

        // Irreversible, and it would orphan the session that owns this machine.
        if (this.refuseSessionOwnedAction(machine.id)) {
            return
        }

        // show snackbar
        this.showSnackbar(`Machine ${machine.id} ${MACHNINE_STATE.DESTROYING}`, SnackBarType.info)

        // update machine state to 'destroying' and destroy the machine
        this.machineStoreService.updateMachineState(machine.id, MACHNINE_STATE.DESTROYING)
        this.deploySub = this.deployService.destroy(machine.id)
            .pipe(
                concatMap((response: any) => {
                    console.log('Machine destroyed waiting for state change:', response.message)
                    return this.deployService.waitforState(machine.id, machine.instance_id, MACHNINE_STATE.DESTROYED, 20).pipe(
                        catchError(waitError => {
                            console.error('waitforState failed:', waitError)
                            // rethrow error to propagate to the main error handler
                            return throwError(() => waitError)
                        })
                    )
                }),
            )
            .subscribe({
                next: () => {
                    // update machine state to 'destroyed'
                    // machine reaced the e desired state
                    this.machineStoreService.nextPage(1, 10)
                    this.showSnackbar(`Machine ${machine.id} successfully ${MACHNINE_STATE.DESTROYED}`, SnackBarType.success);
                },
                error: (error) => {
                    const isRunning = (machine.laststate === MACHNINE_STATE.STARTED ? machine.id + ' currently running!' : '')
                    console.error('Error destroying machine:', error);
                    this.machineStoreService.updateMachineState(machine.id, machine.laststate)
                    this.showSnackbar(`Error destroying machine ${isRunning}`, SnackBarType.error);
                }
            });
    }
    /**
     * Opens the task runner for a container. The container has to be started:
     * arachnefly resolves the target from its started machines and replays the
     * request onto that instance.
     */
    runTask(machine: { id: string, laststate: string, instance_id: string }): void {
        this.taskMachineId = machine.id
        this.taskPayload.reset(JSON.stringify({ urls: ['https://example.com'] }, null, 2))
        this.isTaskModalOpen.setValue(true)
    }

    /**
     * Posts the modal's JSON body to the container. Parsed here so a typo shows up
     * as a message instead of as a 500 from the upstream.
     */
    protected submitTask(): void {
        let parsed: unknown
        try {
            parsed = JSON.parse(this.taskPayload.value)
        } catch {
            this.showSnackbar('Task payload is not valid JSON', SnackBarType.error)
            return
        }

        this.isTaskRunning = true
        this.deploySub = this.deployService.runTask(this.taskMachineId, parsed).subscribe({
            next: () => {
                this.isTaskRunning = false
                this.isTaskModalOpen.setValue(false)
                this.showSnackbar(`Task executed on machine ${this.taskMachineId}`, SnackBarType.success)
            },
            error: (error) => {
                this.isTaskRunning = false
                console.error('Error executing task:', error)
                this.showSnackbar('Failed to execute task on machine', SnackBarType.error)
            }
        })
    }

    editMachine(machine: any): void {
        // Implement your edit machine logic here
    }

    openDropdownMenu(machine: any): void {
        // Implement your menu dropdown logic here
    }

    /* Modal Functions */
    clearInput() {
        // this.newMachineName.setValue('')
        this.dockerStepper.clearCurrStepInput()
    }


    isStepValid(step: number) {
        const isValid = this.dockerStepper?.isStepValid(step)
        if (isValid === undefined)
            return true
        
        // this.cdr.detectChanges()
        return isValid
    }

    prevStep() {
        this.dockerStepper.prevStep()
    }

    nextStep() {
        this.dockerStepper.nextStep()
    }

    deploy() {

        // startt loading animation
        this.isDeploying = true

        /* The above TypeScript code snippet is subscribing to the `deploy` method of `dockerStepper`
        and handling the machine using an object with `next`, `error`, and `complete` properties. */
        this.deploySub = this.dockerStepper.deploy()
            .pipe(
                map((response: MachineResponse) => {
                    return response.machine_details as FlyMachine
                }),
                tap((machine: FlyMachine) => {
                    // preset the machine's state to 'started'
                    machine.state = MACHNINE_STATE.STARTED
                    this.updateSelfComponent()
                    this.showSnackbar('Machine successfully deployed', SnackBarType.success)
                    this.machineStoreService.nextPage(1, 10)
                    this.showSnackbar(`Machine ${machine.id} starting`, SnackBarType.info)
                }),
                concatMap((machine: FlyMachine) => {
                    console.log('Machine created waiting for state change:', machine)
                    return this.deployService.waitforState(machine.id, machine.instance_id, MACHNINE_STATE.STARTED as string).pipe(
                        catchError(waitError => {
                            console.error('waitforState failed:', waitError)
                            // rethrow error to propagate to the main error handler
                            return throwError(() => waitError)
                        })
                    )
                }),
            )
            .subscribe({
                next: (waitResponse: FlyMachine) => {

                    console.log('waitforState successful:', waitResponse)
                    this.machineStoreService.nextPage(1, 10)
                },
                error: (error) => {
                    // set the loading state to false
                    this.isDeploying = false

                    // Report what actually happened. This used to pass `error` itself as
                    // the snackbar message, so every deploy failure rendered as
                    // `[object Object]` -- and because the message carried no status, a
                    // capacity refusal read exactly like a broken deploy.
                    const failure = describeMachineFailure(error)
                    const action = this.translate.instant('MACHINES.DEPLOY')
                    const reason = this.translate.instant(failure.key)
                    this.showSnackbar(`${action}: ${reason}`, SnackBarType.error, '', 5000)

                    // log the error
                    console.error('Machine error:', error, 'retryable:', failure.retryable)
                },
                complete: () => { this.isDeploying = false },
            })
    }

    /* Machine previous next Buttons */
    protected onPageChanged(page: number, totalMachinePages: number) {

        // if the page is the same as the current page, return
        if (page == 1 && page == totalMachinePages || (this.currMachinePage == page))
            return

        // set the currentOpePage
        this.currMachinePage = page

        // make the request via Firestore Functions
        this.machineStoreService.nextPage(this.currMachinePage)

        // scroll to the search bar target in the page
        // this.scroll.scrollToElement(this.searchBar.nativeElement as HTMLElement)

    }

    protected Array(totalPages: number) {
        return Array(totalPages).fill(0).map((_, i) => i + 1)
    }
    private updateSelfComponent() {

        this.currentStep.set(this.currentStep() + 1)
        this.isModalOpen.setValue(false)

        this.showSnackbar('Deployment successful', SnackBarType.success, '', 5000)
    }

    themeIsDark() {

        return this.localStorage?.getItem(themeStorageKey) === 'true'
    }

    private handleScrollbar(closed: boolean) {
        if (closed) // If aside bar is closed, show scrollbar
            this.scrollService.showScroll()
        else // If aside bar is open, hide scrollbar
            this.scrollService.hideScroll()
    }

    showSnackbar(
        message: string,
        type: SnackBarType = SnackBarType.info,
        action: string | '' = '',
        duration: number = 3000) {

        this.snackbarService.showSnackbar(message, type, action, duration)
    }

    ngOnDestroy(): void {
        //Called once, before the instance is destroyed.
        //Add 'implements OnDestroy' to the class.
        this.deploySub?.unsubscribe()
    }
}
