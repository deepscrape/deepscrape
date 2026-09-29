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
import { TranslateModule } from '@ngx-translate/core';
import { RippleDirective, TooltipDirective } from 'src/app/core/directives';
import { MACHNINE_STATE } from 'src/app/core/enum';
import { FormControlPipe } from 'src/app/core/pipes';
import { DeploymentService, FirestoreService, LocalStorage, MachineStoreService, ScrollService, SnackbarService } from 'src/app/core/services';
import { FlyMachine, MachineResponse } from 'src/app/core/types';
import { themeStorageKey } from 'src/app/shared/theme-picker/theme-picker.component';

@Component({
    selector: 'app-machines',
    imports: [ContainerBoxComponent, NgClass, ReactiveFormsModule, MatIcon, SlideInModalComponent, RippleDirective, TooltipDirective, AppDockerStepperComponent, MatProgressSpinner, AsyncPipe, FormControlPipe, TranslateModule],
    templateUrl: './machines.component.html',
    styleUrl: './machines.component.scss'
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

    // Signals
    protected currentStep = signal(1)
    // protected playPressed: WritableSignal<boolean> = signal(false)

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
    ) {
    }

    ngOnInit(): void {
        //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
        //Add 'implements OnInit' to the class.
        this.initMachines()

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

    stopMachine(machine: { id: string, laststate: string, instance_id: string }): void {

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

                    // show the snackbar
                    this.showSnackbar(error, SnackBarType.error, '', 5000)

                    // log the error
                    console.error('Machine error:', error)
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
