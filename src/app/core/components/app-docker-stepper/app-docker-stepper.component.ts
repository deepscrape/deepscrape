import { JsonPipe } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, inject, model } from '@angular/core'
import { AbstractControl, FormArray, FormBuilder, FormControl, FormGroup, ReactiveFormsModule, ValidationErrors, ValidatorFn, Validators } from '@angular/forms'
import { MatIcon } from '@angular/material/icon'
import { RadioButtonComponent } from '../radio-button/radio-button.component'
import { FormControlPipe } from '../../pipes'
import { DropdownComponent } from '../dropdown/dropdown.component'
import { DockerImageInfo, DropDownOption, MachineResponse } from '../../types'
import { fileToBase64, isImageParsable, DEFAULT_IMAGES, DEPLOYMENT_REGIONS, CPU_TYPES, AUTO_CONTAINER_OPTIONS } from '../../functions'
import { cloneMachineValidator, dockerHubUrlValidator } from '../../directives'
import { CheckboxComponent } from '../checkbox/checkbox.component'
import { MarkdownModule } from 'ngx-markdown'
import { RadioToggleComponent } from '../radiotoggle/radiotoggle.component'
import { ClipboardbuttonComponent } from '../clipboardbutton/clipboardbutton.component'
import { DeploymentService } from '../../services'
import { debounceTime } from 'rxjs/internal/operators/debounceTime'
import { distinctUntilChanged } from 'rxjs/internal/operators/distinctUntilChanged'
import { switchMap } from 'rxjs/internal/operators/switchMap'
import { map } from 'rxjs/internal/operators/map'
import { filter } from 'rxjs/internal/operators/filter'
import { tap } from 'rxjs'
import { MatProgressSpinner } from '@angular/material/progress-spinner'
import { TranslateModule } from '@ngx-translate/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'




@Component({
  selector: 'app-docker-stepper',
  imports: [ReactiveFormsModule, JsonPipe, MatIcon, RadioButtonComponent, FormControlPipe, DropdownComponent, CheckboxComponent, RadioToggleComponent, MarkdownModule, MatProgressSpinner, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-docker-stepper.component.html',
  styleUrl: './app-docker-stepper.component.scss'
})
export class AppDockerStepperComponent {
  private destroyRef = inject(DestroyRef)
  private fb: FormBuilder = inject(FormBuilder)
  private cdr = inject(ChangeDetectorRef)
  existingMachines: DropDownOption[] = []

  readonly clipboardButton = ClipboardbuttonComponent
  currentStep = model.required<number>()
  totalSteps = 4

  // Form groups for each step
  formStep1: FormGroup
  formStep2: FormGroup
  formStep3: FormGroup

  // File variable for Dockerfile
  dockerfileFile: File | null = null

  // Mock data (replace with API calls in production)
  defaultImages: DropDownOption[] = []
  regions: DropDownOption[] = []
  CPUTypes: DropDownOption[] = []
  autoContainerOptions: DropDownOption[] = []

  // fly Toml controls
  flyTomlMarkdown: string = ''

  protected imageIsChecking: boolean | null = null

  constructor(private deployService: DeploymentService) { }

  get dockerHubUrl(): FormControl<string | null> {
    return this.formStep1.get('dockerHubUrl') as FormControl<string | null>
  }

  ngOnInit() {
    // Initialize dropdown options with constants (direct assignment avoids array mutations)
    this.defaultImages = [...DEFAULT_IMAGES];
    this.regions = [...DEPLOYMENT_REGIONS];
    this.CPUTypes = [...CPU_TYPES];
    this.autoContainerOptions = [...AUTO_CONTAINER_OPTIONS];

    // Initialize forms
    this.initForms();

    // Emit Step Status to the parent component
    this.currentStep.set(1);
  }
  /**
   * comment initForms
   * @description Inits forms
   */
  private initForms() {

    /* Set Step 1 */
    this.formStep1 = this.fb.group({
      imageOption: this.fb.control('default', {
        nonNullable: true,
        validators: [Validators.required]
      }),
      defaultImage: this.fb.control(this.defaultImages[0], {
        nonNullable: true,
        validators: [Validators.required]
      }) as FormControl<DropDownOption>,
      cloneMachine: this.fb.control({}, {
        nonNullable: true,
        validators: [
          Validators.required,
          cloneMachineValidator()
        ]
      }) as FormControl<DropDownOption>,
      dockerfile: this.fb.control(null,
        {
          nonNullable: false,
          validators: [
            this.dockerfileValidator()
          ]
        }) as FormControl<string | null>,
      dockerHubUrl: this.fb.control('', {
        validators: [Validators.required, dockerHubUrlValidator()],
      }),
    })

    /* Set Step 2 */
    this.formStep2 = this.fb.group({
      default: this.fb.control(false, {
        nonNullable: true, validators: [Validators.required]
      }),
      machineName: ['', Validators.required],
      region: this.fb.control(this.regions[0], {
        nonNullable: true,
        validators: [Validators.required]
      }) as FormControl<DropDownOption>,
      cpukind: this.fb.control(this.CPUTypes[0], {
        nonNullable: true,
        validators: [Validators.required]
      }) as FormControl<DropDownOption>,
      cpuCores: [1, [Validators.required, Validators.min(1),
      this.cpuValidator()
      ]],
      memory: [256, [
        Validators
          .required,
        Validators.min(256),
        this.memoryValidator()

      ]],
      autoStart: this.fb.control(false, {
        nonNullable: true, validators: [Validators.required]
      }),
      autoStop: this.fb.control(this.autoContainerOptions[0], {
        nonNullable: true, validators: [Validators.required]
      }),
      environmentVariables: this.fb.array([]),
    })

    /* Set Step 3 */
    this.formStep3 = this.fb.group({
      flyToml: this.fb.control('', {
        nonNullable: true,
        validators: [Validators.required]
      }),
      flyTomlViewer: this.fb.control(false, {
        nonNullable: true,
        validators: [Validators.required]
      })
    })


    this.formStep1.get('imageOption')?.valueChanges.pipe(
      takeUntilDestroyed(this.destroyRef),
      distinctUntilChanged() // Add this line
    ).subscribe((value) => {
      this.updateStep1Validators(value)
    })


    this.dockerHubUrl.valueChanges.pipe(
      takeUntilDestroyed(this.destroyRef),
      tap(() => this.imageIsChecking = null),
      filter((value): value is string => !!value && !this.dockerHubUrl.invalid),
      distinctUntilChanged(),
      debounceTime(1000), // Adjust the debounce time as needed
      map((registryValue: string) => {
        this.imageIsChecking = true
        if (!registryValue) {
          throw new Error('Invalid Docker Image URL')
        }
        const { info } = isImageParsable(registryValue)
        if (info) {
          const { registry, repository, namespace, tag } = info
          registryValue = `${namespace}/${repository}:${!tag ? 'latest' : tag}`
        }
        return registryValue
      }),
      switchMap((imageName: string) =>
        this.deployService.checkImageDeployability(imageName))
    ).subscribe({
      next: (image: {
        exists: boolean;
        info: DockerImageInfo;
      }) => {
        if (image.exists) {
          const { repository, tag } = image.info;
          this.dockerHubUrl.patchValue(`${repository}:${!tag ? 'latest' : tag}`, { emitEvent: false })
          this.dockerHubUrl.setErrors(null)
          this.imageIsChecking = false
        } else {
          console.error('Image is not deployable')
          this.imageIsChecking = null
        }
        // OnPush: the result arrives from a debounced HTTP check.
        this.cdr.markForCheck()
      },
      error: (error) => {
        this.imageIsChecking = null
        this.dockerHubUrl.setErrors({ dockerHubUrl: error })
        console.error('Error checking image deployability:', error);
        this.cdr.markForCheck()
      },
    })

    this.formStep3.get('flyToml')?.valueChanges.pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((value) => {
      this.flyTomlMarkdown = value
      // OnPush: valueChanges fires outside the editor's own template event.
      this.cdr.markForCheck()
    })

    this.updateStep1Validators('default')
  }
  // Custom validator for Dockerfile (must be named "Dockerfile")
  dockerfileValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (control.value && this.dockerfileFile?.name !== 'Dockerfile') {
        return { invalidDockerfile: 'DOCKER_STEPPER.ERR_DOCKERFILE_NAME' };
      }
      return null
    };
  }

  private memoryValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const validMemorySizes = [256, 512, 1024, 2048, 4096, 8192, 16384]; // MB values
      const value = control.value;

      if (!validMemorySizes.includes(value)) {
        return { invalidMemory: 'Memory must be one of: 256MB, 512MB, 1GB, 2GB, 4GB, 8GB, or 16GB' };
      }
      return null;
    };
  }

  private cpuValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const validCPUValues = [1, 2, 4, 8, 16];
      const value = control.value;

      if (!validCPUValues.includes(value)) {
        return { invalidCPU: 'CPU must be one of: 1, 2, 4, 8, or 16' };
      }
      return null;
    };
  }

  updateStep1Validators(option: string | null | undefined) {
    const controls = {
      defaultImage: this.formStep1.get('defaultImage'),
      cloneMachine: this.formStep1.get('cloneMachine'),
      dockerfile: this.formStep1.get('dockerfile'),
      dockerHubUrl: this.formStep1.get('dockerHubUrl'),
    };
    // Clear all validators
    Object.values(controls).forEach((control) => control?.clearValidators());
    if (option === 'default') controls.defaultImage?.setValidators(Validators.required)
    else if (option === 'clone') controls.cloneMachine?.setValidators([Validators.required, cloneMachineValidator()])
    else if (option === 'upload') controls.dockerfile?.setValidators(this.dockerfileValidator())
    else if (option === 'url') controls.dockerHubUrl?.setValidators([Validators.required, dockerHubUrlValidator()]) // (/^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,6}(\/[^\s]*)?$/)
    // ^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,6}(\/[^\s]*)?$

    Object.values(controls).forEach((control) => control?.updateValueAndValidity({ emitEvent: false }))
  }

  // Environment variables FormArray
  get environmentVariables() {
    return this.formStep2.get('environmentVariables') as FormArray
  }

  addEnvVar() {
    this.environmentVariables.push(
      this.fb.group({
        key: ['', Validators.required],
        value: ['', Validators.required],
      })
    )
  }

  removeEnvVar(index: number) {
    this.environmentVariables.removeAt(index)
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    this.dockerfileFile = input.files?.[0] || null;
    this.formStep1.patchValue({ dockerfile: this.dockerfileFile ? 'selected' : null });
    this.formStep1.get('dockerfile')?.updateValueAndValidity()
  }

  protected onCPUTypeChange(value: DropDownOption) {
    const selectedCPUtype: DropDownOption = value

    const getCpuNumber = (selected: string) => {
      const match = selected.match(/(\d+)x/)
      return match ? parseInt(match[1], 10) : null
    }

    const cpuNumber = getCpuNumber(selectedCPUtype?.code)


    if (!cpuNumber)
      return

    this.formStep2.patchValue({ cpuCores: cpuNumber })
  }

  getConfiguration() {

    const extractResourceType = (resourceClass: string): string => {
      if (resourceClass.startsWith("shared")) {
        return "shared";
      } else if (resourceClass.startsWith("performance")) {
        return "performance";
      }
      return resourceClass;
    }

    const resourceType = extractResourceType(this.formStep2.value.cpukind.code)
    if (!resourceType)
      return

    const dockerHubUrl = encodeURIComponent(this.formStep1.value.dockerHubUrl)

    return {
      default: this.formStep2.value.default,
      imageOption: this.formStep1.value.imageOption,
      defaultImage: this.formStep1.value.defaultImage.name,
      cloneMachine: this.formStep1.value.cloneMachine.code,
      dockerfile: this.dockerfileFile,
      dockerHubUrl,
      machineName: this.formStep2.value.machineName,
      region: this.formStep2.value.region.code,
      cpuCores: this.formStep2.value.cpuCores,
      cpuType: resourceType,
      // add gpu cores
      // gpu type
      memory: this.formStep2.value.memory,
      autoStart: this.formStep2.value.autoStart,
      autoStop: this.formStep2.value.autoStop.code,
      environmentVariables: this.formStep2.value.environmentVariables,
      flyToml: this.formStep3.value.flyToml,
    }
  }

  clearCurrStepInput() {
    switch (this.currentStep()) {
      case 1:
        this.formStep1.reset()
        this.formStep1.get('imageOption')?.setValue('default')
        this.updateStep1Validators('default')
        break
      case 2:
        this.formStep2.reset()
        // Add specific reset logic for step 2 if needed
        break
      case 3:
        this.formStep3.reset()
        // Add specific reset logic for step 3 if needed
        break
      default:
        // Handle invalid or unknown step
        console.error('Invalid step')
    }
    this.dockerfileFile = null
  }

  nextStep() {

    if (this.currentStep() === 1 && this.isStepValid(this.currentStep())) {
      // Reset all fields except imageOption, clear pristine/touched states
      /* const imageOption = this.formStep1.value.imageOption;
      this.formStep1.reset({ imageOption });
      this.dockerfileFile = null;
      Object.keys(this.formStep1.controls).forEach((key) => {
        const control = this.formStep1.get(key);
        control?.markAsUntouched();
        control?.markAsPristine();
      })
      this.updateStep1Validators(imageOption) */
      this.currentStep.set(this.currentStep() + 1)
    } else if (this.currentStep() < this.totalSteps && this.isStepValid(this.currentStep())) {
      this.currentStep.set(this.currentStep() + 1)
    }
  }

  prevStep(setStep?: number) {

    if (this.currentStep() > 1) this.currentStep.set(this.currentStep() - 1)
  }

  isStepValid(step: number): boolean {
    if (!step)
      return false

    if (step === 1) {
      return (
        this.formStep1.valid &&
        (this.formStep1.value.imageOption !== 'upload' || this.dockerfileFile?.name === 'Dockerfile')
      )
    } else if (step === 2) {
      return this.formStep2.valid
    } else if (step === 3) {
      return true // Optional step
    }
    return false
  }

  deploy() {
    const config = this.getConfiguration()
    return this.deployService.createMachine(config)
  }

  onCheckBoxChange() {
    // console.log(this.formStep2.get("autoStart")?.value)
    // this.this.formStep2.get("autoStart").setValue(!this.this.formStep2.get("autoStart").value)
  }
}
