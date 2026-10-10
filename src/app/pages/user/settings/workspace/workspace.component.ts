import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core'
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms'
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { finalize } from 'rxjs'
import { DropdownComponent, StinputComponent } from 'src/app/core/components'
import { IfAuthorizedDirective, RippleDirective } from 'src/app/core/directives'
import { FormControlPipe } from 'src/app/core/pipes'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { listStaggerAnimation } from 'src/app/animations'
import {
  AuthzService,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationService,
  OrganizationSummary,
  SnackbarService,
} from 'src/app/core/services'
import { SnackBarType } from 'src/app/core/components'

type DropdownOption = {
  name: string
  code: string
}

@Component({
  selector: 'app-workspace-tab',
  imports: [ReactiveFormsModule, IfAuthorizedDirective, RippleDirective, StinputComponent, FormControlPipe, DropdownComponent, DatePipe, TranslateModule],
  templateUrl: './workspace.component.html',
  styleUrl: './workspace.component.scss',
  animations: [listStaggerAnimation],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block py-5',
  },
})
export class WorkspaceTabComponent {
  private organizationService = inject(OrganizationService)
  private authzService = inject(AuthzService)
  private snackbar = inject(SnackbarService)
  private translate = inject(TranslateService)
  private destroyRef = inject(DestroyRef)

  organizations = signal<OrganizationSummary[]>([])
  sentInvitations = signal<OrganizationInvitation[]>([])
  incomingInvitations = signal<OrganizationInvitation[]>([])
  members = signal<OrganizationMember[]>([])

  selectedOrgId = signal<string | null>(null)
  isLoading = signal(false)
  isMembersLoading = signal(false)
  isSentInvitationsLoading = signal(false)
  isIncomingInvitationsLoading = signal(false)
  isSubmittingCreate = signal(false)
  isSubmittingInvite = signal(false)
  isAcceptingInvite = signal<string | null>(null)
  isRemovingMember = signal<string | null>(null)
  readonly workspaceControl = new FormControl<DropdownOption>({ name: 'SHELL.SELECT_WORKSPACE', code: '' }, { nonNullable: true })
  readonly inviteRoleControl = new FormControl<DropdownOption>({ name: 'SETTINGS_WORKSPACE.ROLE_MEMBER', code: 'member' }, { nonNullable: true })
  readonly inviteRoleOptions: DropdownOption[] = [
    { name: 'SETTINGS_WORKSPACE.ROLE_ADMIN', code: 'admin' },
    { name: 'SETTINGS_WORKSPACE.ROLE_MEMBER', code: 'member' },
    { name: 'SETTINGS_WORKSPACE.ROLE_VIEWER', code: 'viewer' },
  ]

  // display label for a role code (admin/member/viewer/owner); unknown codes pass through
  roleLabelKey(role: string): string {
    const map: Record<string, string> = {
      admin: 'SETTINGS_WORKSPACE.ROLE_ADMIN',
      member: 'SETTINGS_WORKSPACE.ROLE_MEMBER',
      viewer: 'SETTINGS_WORKSPACE.ROLE_VIEWER',
      owner: 'SETTINGS_WORKSPACE.ROLE_OWNER',
    }
    return map[role] || role
  }

  readonly workspaceOptions = computed(() =>
    this.organizations().map((org) => ({
      name: `${org.name || org.slug || org.id} (${org.membership?.role || 'member'})`,
      code: org.id,
    })),
  )

  readonly selectedOrganization = computed(() => {
    const currentId = this.selectedOrgId()
    return this.organizations().find((org) => org.id === currentId) || null
  })

  /** Label key for the caller's role in the selected workspace. */
  readonly activeRoleKey = computed(() => {
    const role = this.selectedOrganization()?.membership?.role
    return role ? this.roleLabelKey(role) : null
  })

  /**
   * What that role can actually do, in the same terms `functions/src/domain/authz.domain.ts`
   * `POLICIES` uses: `viewer` holds `crawl.read` alone, which is the one role whose limits
   * are easy to miss, so it is stated rather than implied.
   *
   * A personal account (no membership) resolves to the `self` role, which is the default
   * path for a free user.
   */
  readonly activeAccessKey = computed(() => {
    const role = this.selectedOrganization()?.membership?.role
    switch (role) {
      case 'owner':
      case 'admin':
        return 'SETTINGS_WORKSPACE.ACCESS_ADMIN'
      case 'member':
        return 'SETTINGS_WORKSPACE.ACCESS_MEMBER'
      case 'viewer':
        return 'SETTINGS_WORKSPACE.ACCESS_VIEWER'
      default:
        return 'SETTINGS_WORKSPACE.ACCESS_SELF'
    }
  })

  readonly createOrgForm = new FormGroup({
    name: new FormControl('', {
      validators: [Validators.required, Validators.minLength(3), Validators.maxLength(64)],
      nonNullable: true,
    }),
  })

  readonly inviteForm = new FormGroup({
    email: new FormControl('', {
      validators: [Validators.required, Validators.email],
      nonNullable: true,
    }),
    role: new FormControl<'admin' | 'member' | 'viewer'>('member', {
      validators: [Validators.required],
      nonNullable: true,
    }),
  })

  ngOnInit(): void {
    this.refreshWorkspaceData()
  }

  refreshWorkspaceData(): void {
    this.isLoading.set(true)

    this.organizationService
      .listMyOrganizations()
      .pipe(
        finalize(() => {
          this.isLoading.set(false)
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (response) => {
          const orgs = response.organizations || []
          this.organizations.set(orgs)

          const activeOrgId = this.organizationService.getActiveOrganization() || orgs[0]?.id || null
          this.selectedOrgId.set(activeOrgId)
          this.syncWorkspaceControl(activeOrgId)

          if (activeOrgId) {
            this.loadMembers(activeOrgId)
            this.loadSentInvitations(activeOrgId)
          } else {
            this.members.set([])
            this.sentInvitations.set([])
          }

          this.loadIncomingInvitations()
        },
        error: () => {
          this.organizations.set([])
          this.selectedOrgId.set(null)
          this.members.set([])
          this.sentInvitations.set([])
          this.syncWorkspaceControl(null)
          this.showError(this.translate.instant('SETTINGS_WORKSPACE.ERR_LOAD_WORKSPACES'))
        },
      })
  }

  onSelectOrganization(orgId: string): void {
    if (!orgId) {
      return
    }

    this.selectedOrgId.set(orgId)
    this.organizationService.setActiveOrganization(orgId)
    this.syncWorkspaceControl(orgId)
    this.loadMembers(orgId)
    this.loadSentInvitations(orgId)
  }

  onWorkspaceSelected(option: DropdownOption): void {
    if (!option?.code) {
      return
    }

    this.onSelectOrganization(option.code)
  }

  onInviteRoleSelected(option: DropdownOption): void {
    if (!option?.code) {
      return
    }

    this.inviteForm.controls.role.setValue(option.code as 'admin' | 'member' | 'viewer')
  }

  createWorkspace(): void {
    if (this.createOrgForm.invalid || this.isSubmittingCreate()) {
      this.createOrgForm.markAllAsTouched()
      return
    }

    const name = this.createOrgForm.controls.name.value.trim()
    if (!name) {
      return
    }

    this.isSubmittingCreate.set(true)
    this.organizationService
      .createOrganization(name)
      .pipe(
        finalize(() => {
          this.isSubmittingCreate.set(false)
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.createOrgForm.reset({ name: '' })
          this.showSuccess(this.translate.instant('SETTINGS_WORKSPACE.SUCCESS_CREATED'))
          this.refreshWorkspaceData()
        },
        error: () => {
          this.showError(this.translate.instant('SETTINGS_WORKSPACE.ERR_CREATE'))
        },
      })
  }

  inviteMember(): void {
    const orgId = this.selectedOrgId()
    if (!orgId || this.inviteForm.invalid || this.isSubmittingInvite()) {
      this.inviteForm.markAllAsTouched()
      return
    }

    const email = this.inviteForm.controls.email.value.trim().toLowerCase()
    const role = this.inviteForm.controls.role.value

    this.isSubmittingInvite.set(true)
    this.organizationService
      .createInvitation(orgId, email, role)
      .pipe(
        finalize(() => {
          this.isSubmittingInvite.set(false)
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.inviteForm.reset({ email: '', role: 'member' })
          this.showSuccess(this.translate.instant('SETTINGS_WORKSPACE.SUCCESS_INVITATION_SENT'))
          this.refreshWorkspaceData()
        },
        error: () => {
          this.showError(this.translate.instant('SETTINGS_WORKSPACE.ERR_SEND_INVITATION'))
        },
      })
  }

  removeMember(userId: string): void {
    const orgId = this.selectedOrgId()
    if (!orgId || !userId || this.isRemovingMember()) {
      return
    }

    this.isRemovingMember.set(userId)
    this.organizationService
      .removeMember(orgId, userId)
      .pipe(
        finalize(() => {
          this.isRemovingMember.set(null)
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.showSuccess(this.translate.instant('SETTINGS_WORKSPACE.SUCCESS_MEMBER_REMOVED'))
          this.loadMembers(orgId)
        },
        error: () => {
          this.showError(this.translate.instant('SETTINGS_WORKSPACE.ERR_REMOVE_MEMBER'))
        },
      })
  }

  canManageCurrentOrg(): boolean {
    const selected = this.selectedOrganization()
    if (!selected) {
      return false
    }

    const role = selected.membership?.role
    return role === 'owner' || role === 'admin'
  }

  getCreatedAtDate(createdAt: OrganizationInvitation['createdAt'] | null | undefined): Date | null {
    if (!createdAt) {
      return null
    }

    if (createdAt instanceof Date) {
      return createdAt
    }

    if (typeof createdAt.toDate === 'function') {
      return createdAt.toDate()
    }

    return null
  }

  private loadSentInvitations(orgId: string): void {
    this.isSentInvitationsLoading.set(true)
    this.organizationService
      .listOrgInvitations(orgId)
      .pipe(
        finalize(() => {
          this.isSentInvitationsLoading.set(false)
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (response) => {
          this.sentInvitations.set(response.invitations || [])
        },
        error: () => {
          this.sentInvitations.set([])
        },
      })
  }

  private loadIncomingInvitations(): void {
    this.isIncomingInvitationsLoading.set(true)
    this.organizationService
      .listMyInvitations()
      .pipe(
        finalize(() => {
          this.isIncomingInvitationsLoading.set(false)
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (response) => {
          this.incomingInvitations.set(response.invitations || [])
        },
        error: () => {
          this.incomingInvitations.set([])
        },
      })
  }

  acceptInvitation(invitationId: string): void {
    if (!invitationId || this.isAcceptingInvite()) {
      return
    }

    this.isAcceptingInvite.set(invitationId)
    this.organizationService
      .acceptInvitation(invitationId)
      .pipe(
        finalize(() => {
          this.isAcceptingInvite.set(null)
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.showSuccess(this.translate.instant('SETTINGS_WORKSPACE.SUCCESS_INVITATION_ACCEPTED'))
          this.loadIncomingInvitations()
          this.refreshWorkspaceData()
        },
        error: () => {
          this.showError(this.translate.instant('SETTINGS_WORKSPACE.ERR_ACCEPT_INVITATION'))
        },
      })
  }

  private loadMembers(orgId: string): void {
    this.isMembersLoading.set(true)
    this.organizationService
      .listMembers(orgId)
      .pipe(
        finalize(() => {
          this.isMembersLoading.set(false)
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (response) => {
          this.members.set(response.members || [])
        },
        error: () => {
          this.members.set([])
          this.showError(this.translate.instant('SETTINGS_WORKSPACE.ERR_LOAD_MEMBERS'))
        },
      })
  }

  private syncWorkspaceControl(orgId: string | null): void {
    const selectedOption = this.workspaceOptions().find((option) => option.code === orgId)
    this.workspaceControl.setValue(selectedOption || { name: 'SHELL.SELECT_WORKSPACE', code: '' })
  }

  private showSuccess(message: string): void {
    this.snackbar.showSnackbar(message, SnackBarType.success)
  }

  private showError(message: string): void {
    this.snackbar.showSnackbar(message, SnackBarType.error)
  }
}
