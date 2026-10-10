import { ChangeDetectionStrategy, Component, DestroyRef, forwardRef, inject } from '@angular/core'
import { DatePipe, JsonPipe, NgClass } from '@angular/common';
import { FormControl, FormGroup, NG_VALUE_ACCESSOR, ReactiveFormsModule, Validators } from '@angular/forms'
import { AuthService, FirestoreService, LocalStorage, SnackbarService } from 'src/app/core/services'
import { DropdownComponent, PreviewImageComponent, SnackBarType, StinputComponent } from 'src/app/core/components'
import { FormControlPipe, ProviderPipe } from 'src/app/core/pipes'
import { MatProgressBarModule } from '@angular/material/progress-bar'
import { ChangeDetectorRef, ViewChild, ElementRef } from '@angular/core'
import { extractNames, fileToBase64, formatBytes } from 'src/app/core/functions'
import { DropDownOption, FileMetadata, ProfileStatus, UserDetails, Users, UserSocialLinks } from 'src/app/core/types'
import { UserInfo } from '@angular/fire/auth'
import { ActivatedRoute } from '@angular/router'
import { ImageSrcsetDirective, RippleDirective } from 'src/app/core/directives'
import { themeStorageKey } from 'src/app/shared'
import { from, take } from 'rxjs'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import { TranslateModule, TranslateService } from '@ngx-translate/core'


@Component({
  selector: 'app-profile-tab',
  imports: [StinputComponent, FormControlPipe, DatePipe, ReactiveFormsModule, NgClass, MatProgressBarModule, ImageSrcsetDirective, ProviderPipe, DropdownComponent, RippleDirective, MatProgressSpinnerModule, PreviewImageComponent, TranslateModule],
  templateUrl: './profile.component.html',
  styleUrls: ['./profile.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileTabComponent {

  private destroryRef = inject(DestroyRef)
  private localStorage = inject(LocalStorage)
  private cdRef = inject(ChangeDetectorRef)
  private firestore = inject(FirestoreService)
  private authService = inject(AuthService)
  private snackbarService = inject(SnackbarService)
  private translate = inject(TranslateService)

  profileForm: FormGroup

  protected user: Users & { currProviderData: UserInfo | null } | null = null
  selectedFile: File | null = null
  isDragging = false
  isLoadingFile = false
  fileError: string | null = null
  fileSize: string | null = null

  isSaving: boolean = false

  engineerStatuses: DropDownOption[] = []
  @ViewChild('image', { static: true }) imageInput: ElementRef

  constructor(private route: ActivatedRoute) {
    this.user = this.route.snapshot.data['user']
    console.log('Resolved user data:', this.user)
  }


  get previewUrl() {
    return this.profileForm.get('previewUrl')
  }

  get isAdmin(): boolean {
    const role = (this.user?.role || '').trim().toLowerCase()
    return this.authService.isAdmin || role === 'admin'
  }

  // Resolve a stored engineer-status value (stable code, display key path, or a pre-i18n
  // English label already persisted in Firestore) to the matching option. The dropdown keeps
  // the localized key-path `name` for display while the persisted value is the stable `code`.
  private engineerStatusOptionFor(stored?: string | null): DropDownOption {
    if (stored) {
      const byCode = this.engineerStatuses.find((s) => s.code === stored)
      if (byCode) return byCode
      const byKey = this.engineerStatuses.find((s) => s.name === stored)
      if (byKey) return byKey
      // Legacy rows written before i18n stored the raw English label.
      const legacyToCode: Record<string, string> = {
        'Not selected': '0',
        'Aspiring engineer (<1 year)': '1',
        'Entry-level (1 year)': '2',
        'Mid-level (2-3 years)': '3',
        'Experienced (4-5 years)': '4',
        'Highly experienced (6-10 years)': '5',
        'I\'ve suffered enough (10+ years)': '6',
        'I am ethical hacker': '7',
        'I\'m not an engineer': '8',
      }
      const code = legacyToCode[stored]
      if (code !== undefined)
        return this.engineerStatuses.find((s) => s.code === code) || this.engineerStatuses[0]
    }
    return this.engineerStatuses[0]
  }


  validateFile(file: File): boolean {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      this.fileError = 'SETTINGS_PROFILE.FILE_ERROR_TYPE'
      return false
    }

    if (file.size > 5 * 1024 * 1024) {
      this.fileError = 'SETTINGS_PROFILE.FILE_ERROR_SIZE'
      return false
    }

    this.fileError = null
    return true
  }

  ngOnInit(): void {
    //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
    //Add 'implements OnInit' to the class.
    this.initProfileForm()
    this.initPhotoPreview()
  }



  initProfileForm() {

    this.profileForm = new FormGroup(
      {
      username: new FormControl<string>(this.user?.username || '', {
        updateOn: 'change',
        validators: [
        Validators.required,
        Validators.minLength(4),
        ]
      }),
      displayName: new FormControl<string>('', {
        updateOn: 'change',
        validators: [
        Validators.required,
        Validators.minLength(4),
        ]
      }),
      photoFile: new FormControl<File | null>(null, {
        updateOn: 'change',
        validators: [],
        nonNullable: false
      }),
      previewUrl: new FormControl<string | ArrayBuffer | null>('', {
        updateOn: 'change',
        validators: [],
        nonNullable: false
      }),
      bio: new FormControl<string>(this.user?.details?.bio || '', {
        validators: [
        Validators.minLength(0),
        Validators.maxLength(600),
        Validators.pattern(/^[\p{L}\p{N}\s@$%^&*()_+{}\[\]:<>,.?~\\/'!,-]*$/u)

        ]
      }),
      company: new FormControl<string>(this.user?.details?.company || '', {
        validators: [Validators.pattern(/^[a-zA-Z0-9\s!@#$%^&*()_+{}\[\]:<>,.?~\\/-]*$/)]
      }),
      location: new FormControl<string>(this.user?.details?.location || '', {
        validators: [Validators.pattern(/^[a-zA-Z0-9\s!@#$%^&*()_+{}\[\]:<>,.?~\\/-]*$/)]
      }),
      jobTitle: new FormControl<string>(this.user?.details?.jobTitle || '', {
        validators: [Validators.pattern(/^[a-zA-Z0-9\s!@#$%^&*()_+{}\[\]:<>,.?~\\/-]*$/)]
      }),
      socialLinks: new FormGroup({
        twitter: new FormControl<string>(this.user?.details?.socialLinks?.twitter || '', {
        validators: [Validators.pattern(/^(https?:\/\/)?[a-zA-Z0-9_]+$/)]
        }),
        linkedin: new FormControl<string>(this.user?.details?.socialLinks?.linkedin || '', {
        validators: [Validators.pattern(/^(https?:\/\/)?[a-zA-Z0-9-]+$/)]
        }),
        threads: new FormControl<string>(this.user?.details?.socialLinks?.threads || '', {
        validators: [Validators.pattern(/^(https?:\/\/)?[a-zA-Z0-9_]+$/)]
        }),
        github: new FormControl<string>(this.user?.details?.socialLinks?.github || '', {
        validators: [Validators.pattern(/^(https?:\/\/)?[a-zA-Z0-9-]+$/)]
        }),
        website: new FormControl<string>(this.user?.details?.socialLinks?.website || '', {
        validators: [Validators.pattern(/^(https?:\/\/)?([\w-]+(\.[\w-]+)+([\w.,@?^=%&:\/~+#-]*[\w@?^=%&\/~+#-])?)$/)]
        }),
        stackoverflow: new FormControl<string>(this.user?.details?.socialLinks?.stackoverflow || '', {
        validators: [Validators.pattern(/^(https?:\/\/)?[a-zA-Z0-9-]+$/)]
        }),
        youtube: new FormControl<string>(this.user?.details?.socialLinks?.youtube || '', {
        validators: [Validators.pattern(/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/[A-Za-z0-9_-]+$/)]
        }),
        codepen: new FormControl<string>(this.user?.details?.socialLinks?.codepen || '', {
        validators: [Validators.pattern(/^(https?:\/\/)?[a-zA-Z0-9_-]+$/)]
        }),
      }),
      role: new FormControl<string>('', { nonNullable: false, validators: [] }),
      engineerStatus: new FormControl<DropDownOption>({ name: 'SETTINGS_PROFILE.STATUS_NONE', code: '0' }, { validators: [], nonNullable: true } ),
      }
    )

    this.engineerStatuses = [
      { name: 'SETTINGS_PROFILE.STATUS_NONE', code: '0' },
      { name: 'SETTINGS_PROFILE.STATUS_ASPIRING', code: '1' },
      { name: 'SETTINGS_PROFILE.STATUS_ENTRY', code: '2' },
      { name: 'SETTINGS_PROFILE.STATUS_MID', code: '3' },
      { name: 'SETTINGS_PROFILE.STATUS_EXPERIENCED', code: '4' },
      { name: 'SETTINGS_PROFILE.STATUS_HIGHLY_EXPERIENCED', code: '5' },
      { name: 'SETTINGS_PROFILE.STATUS_SUFFERED', code: '6' },
      { name: 'SETTINGS_PROFILE.STATUS_ETHICAL_HACKER', code: '7' },
      { name: 'SETTINGS_PROFILE.STATUS_NOT_ENGINEER', code: '8' }
    ]
    
    // Initialize form with user data if available
    this.patchProfileForm()
  }

  initPhotoPreview() {
    
  console.log('Current provider data:', this.user?.currProviderData)
    
    if (!this.user?.providerId)
      return
  
    this.previewUrl?.setValue(this.user?.details?.photoURL || this.user?.currProviderData?.photoURL || null, { emitEvent: false })
  //  set a default File object to trigger the preview display
  if (this.previewUrl)
    this.profileForm.controls['photoFile'].patchValue(new File([], 'profile-pic'), { emitEvent: false }) 
  }

  patchProfileForm() {
    if (!this.user)
      return

    this.usernameEditable()

    let displayName = this.user?.details?.displayName || this.user?.currProviderData?.displayName || ''
    
    this.profileForm.patchValue({
      username: this.user?.username || '',
      displayName,
      engineerStatus: this.engineerStatusOptionFor(this.user?.details?.engineerStatus),
      bio: this.user?.details?.bio || '',
      company: this.user?.details?.company || '',
      location: this.user?.details?.location || '',
      jobTitle: this.user?.details?.jobTitle || '',
      socialLinks: {
        twitter: this.user?.details?.socialLinks?.twitter || '',
        linkedin: this.user?.details?.socialLinks?.linkedin || '',
        threads: this.user?.details?.socialLinks?.threads || '',
        github: this.user?.details?.socialLinks?.github || '',
        website: this.user?.details?.socialLinks?.website || '',
        stackoverflow: this.user?.details?.socialLinks?.stackoverflow || '',
      }
    }, { emitEvent: false })
  }

  private usernameEditable() {
    const usernameControl = this.profileForm.get('username');
    if (this.user?.details?.last_username_change) {
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

      usernameControl?.[this.user.details.last_username_change > sixMonthsAgo ? 'disable' : 'enable']({ emitEvent: false });
    } else {
      usernameControl?.disable({ emitEvent: false });
    }
  }

   getAndFilterConfirmForm() {
      // get form values
      const config = this.profileForm.getRawValue()
      const newConfig = { ...config }; // Create a copy of the config object
      delete newConfig?.previewUrl; // Remove the 'previewUrl' attribute from the config object
  
  
      // Filter out null, unchanged, or default values
      const filteredConfig: any = Object.keys(newConfig).reduce((acc: any, key) => {
        const formControl = this.profileForm.get(key)
  
        if (formControl && (formControl.dirty || !formControl.pristine) && newConfig[key] !== null && newConfig[key] !== '') {
          if (key === 'engineerStatus')
            acc[key] = newConfig[key]?.code
          else acc[key] = newConfig[key]
        } else if (!formControl && newConfig[key] !== null && newConfig[key] !== '') {
          if (key === 'engineerStatus')
            acc[key] = newConfig[key]?.code
          else acc[key] = newConfig[key]
        }
        // console.log(acc, key)
        return acc
      }, {})
  
      return filteredConfig
    }

  async saveProfile() {

    // validate form
    if (!this.profileForm.valid)
      return

    // loading state
    this.isSaving = true

    // 1. Get username value if changed
    const {username} = this.getAndFilterConfirmForm()

    // 2. Handle file upload if a new file is selected and get the photoURL
    const detailsUpdate: Partial<UserDetails> | null = await this.saveImageAndGetFormData()
    
    if (!detailsUpdate) {
      this.isSaving = false
      this.cdRef.detectChanges() // Trigger change detection manually
      return
    }

    const localUser = {... this.user}
    delete localUser?.currProviderData // remove currProviderData before saving to Firestore

    // 3. Save to Firestore
    const newUserData: Partial<Users> = {
      ...localUser,
      ...(!!username ? { username } : {}), // Only include username if it is defined
      details: detailsUpdate
    } as Partial<Users>

    const userId = this.user?.uid || ''

    if (!userId) {
      console.error('User ID is missing. Cannot update profile.')
      this.isSaving = false
      this.cdRef.detectChanges() // Trigger change detection manually
      return
    }

    from(this.firestore.setUserData(userId, newUserData, true))
    .pipe(
      takeUntilDestroyed(this.destroryRef)
    ).subscribe({
      next: () => {
        // console.log('Profile updated successfully')
        // Reset form state after successful save
        this.profileForm.markAsPristine()
        this.profileForm.markAsUntouched()
        this.usernameEditable()
        
        
        // Optionally, you can also reset the selected file and preview URL as upload is done
        this.previewUrl?.setValue(detailsUpdate.photoURL || this.user?.currProviderData?.photoURL || null, { emitEvent: false })

        //  set a default File object to trigger the preview display
        if (this.previewUrl?.value)
          this.profileForm.controls['photoFile'].setValue(new File([], 'profile-pic'), { emitEvent: false }) 

        this.selectedFile = null
        this.fileSize = null
      },
      error: (error) => {
        this.isSaving = false
        console.error('Error updating profile:', error)

        const errorMessage = error?.message || this.translate.instant('SETTINGS_PROFILE.UPDATE_ERROR_GENERIC')
        this.showSnackbar(errorMessage, SnackBarType.error, '', 5000)
        this.cdRef.detectChanges() // Ensure the view is updated
      },
      complete: async () => {
        this.isSaving = false
        this.showSnackbar(this.translate.instant('SETTINGS_PROFILE.UPDATE_SUCCESS'), SnackBarType.success, '', 3000)
        this.cdRef.detectChanges() // Ensure the view is updated
      }
    })
  }

  private async saveImageAndGetFormData(): Promise<Partial<UserDetails> | null> {

     // 1. Handle file upload if a new file is selected
    const {photoFile} = this.getAndFilterConfirmForm()
    const userId = this.user?.uid || ''
    if (!userId) {
      console.error('User ID is missing. Cannot upload profile picture.')
      return null
    }

    //  { photoFile: File, previewUrl: string | ArrayBuffer }
    let detailsUpdate: Partial<UserDetails & { photoFile: File }> = {... this.getAndFilterConfirmForm() as Partial<UserDetails & { photoFile: File }>}
    delete detailsUpdate.photoFile// we handle photoFile separately

    try {
      if (photoFile instanceof File) {

        // convert file to base64
        detailsUpdate.photoURL = await fileToBase64(photoFile) as string

        // upload to firebase storage
        const markDate = Date.now()
        const fileName = `${photoFile.name.split('.').shift()}.${photoFile.type.split('/')[1]}`
        const metadata: FileMetadata = {
            uploadedBy: userId,
            uploadedAt: markDate,
            lastModified: photoFile.lastModified, 
            type: photoFile.type,
            initialName: photoFile.name, 
            initialSize: photoFile.size,
          }


        const downloadURL = await this.firestore.uploadFileToStorage(detailsUpdate.photoURL, userId,
           fileName, metadata)

        detailsUpdate.photoURL = downloadURL
      } else {
        detailsUpdate.photoURL = this.user?.details?.photoURL || this.user?.currProviderData?.photoURL || '';
      }
    } catch (error) {
      console.error('Error occured on file uploading: ', error)
      this.showSnackbar(this.translate.instant('SETTINGS_PROFILE.UPLOAD_ERROR'), SnackBarType.error)
      return null
    }

    return detailsUpdate || null
  }

  previewFile() {
    if (!this.selectedFile) return;

    const reader = new FileReader();
    reader.onload = () => {
      this.previewUrl?.setValue(reader.result as string, { emitEvent: true })
      this.isLoadingFile = false
      this.cdRef.markForCheck()
      this.cdRef.detectChanges()
    };
    reader.onerror = () => {
      console.error('Error reading file.');
      this.fileError = 'SETTINGS_PROFILE.FILE_ERROR_READ';
      this.isLoadingFile = false
      this.cdRef.markForCheck()
      this.cdRef.detectChanges()
    };

    this.isLoadingFile = true;
    reader.readAsDataURL(this.selectedFile)
    this.cdRef.detectChanges()
  }

  onEngineerStatusChange(option: Event) {
    const controls = this.profileForm.controls['engineerStatus']
    controls.markAsDirty()
    controls.markAsTouched()
  }


  onDragOver(event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    this.isDragging = true
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    this.isDragging = false
  }

  async onDrop(event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    this.isDragging = false
    const files = event.dataTransfer?.files
    if (files && files.length > 0) {
      const file = files[0]
      if (!this.validateFile(file)) {
        this.selectedFile = null
        this.previewUrl?.reset()
        this.fileSize = null
        return
      }

      this.selectedFile = file
      this.fileSize = formatBytes(file.size)
      this.isLoadingFile = true
      // Update the form control value and mark it as dirty
      const photoFileControl = this.profileForm.controls['photoFile']
      photoFileControl.setValue(this.selectedFile)
      photoFileControl.markAsDirty() // Mark the control as dirty
      photoFileControl.markAsTouched() // Optionally mark it as touched
      photoFileControl.updateValueAndValidity()
      // this.imageInput.nativeElement.blur() // Remove focus from the input element
      
      this.previewFile()
    }
  }

  onPreviewChange(event: any) {
    // event.preventDefault()
    // event.stopPropagation()
    console.log('Preview change event:', event)
  }

    onFileSelected(event: any) {
    this.fileError = null
    const input = event.target as HTMLInputElement

    // console.log('File input event:', event, input)

    if (!input.files || input.files.length === 0) {
      console.log('No file selected')
      return
    }

    const file = input.files[0]
    if (!this.validateFile(file)) {
      this.selectedFile = null
      this.previewUrl?.reset()
      this.fileSize = null
      return
    }

    this.selectedFile = file
    this.fileSize = formatBytes(file.size)
    this.isLoadingFile = true
     // Update the form control value and mark it as dirty
    const photoFileControl = this.profileForm.controls['photoFile']
    photoFileControl.setValue(this.selectedFile)
    photoFileControl.markAsDirty() // Mark the control as dirty
    photoFileControl.markAsTouched() // Optionally mark it as touched
    photoFileControl.updateValueAndValidity()
    // input.blur() // Remove focus from the input element alue = await this.selectedFile.bytes()

    this.previewFile()
  }

  removeImage() {
    this.selectedFile = null
    this.previewUrl?.reset()
    this.profileForm.controls['photoFile'].setValue(null, { emitEvent: true })
    if (this.imageInput) {
      this.imageInput.nativeElement.value = ''
    }
    this.cdRef.detectChanges()
  }

  themeIsDark(): boolean {
    return this.localStorage?.getItem(themeStorageKey) === 'true'; // Initialize isThemeDark
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

  }
}
