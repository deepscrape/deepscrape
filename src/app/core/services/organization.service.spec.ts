import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { OrganizationService } from './organization.service';
import { getTestProviders } from 'src/app/testing';
import { AuthService } from './auth.service';
import { AuthzService } from './authz.service';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { API_ORGANIZATIONS } from '../variables';

describe('OrganizationService', () => {
  let service: OrganizationService;
  let httpMock: HttpTestingController;
  let authServiceMock: jasmine.SpyObj<AuthService>;
  let authzServiceMock: jasmine.SpyObj<AuthzService>;

  beforeEach(() => {
    authServiceMock = jasmine.createSpyObj('AuthService', ['isAuthenticated'], { token: 'test-token', user$: of(null) });
    // `listMyOrganizations` waits for the snapshot before it reads `token`, so the mock
    // has to answer it or the request is never issued.
    authServiceMock.isAuthenticated.and.returnValue(of({ isAuthenticated: true, user: null }) as any);
    authzServiceMock = jasmine.createSpyObj('AuthzService', ['setActiveOrgId'], {
      activeOrgId: null,
    });

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        ...getTestProviders(),
        { provide: AuthService, useValue: authServiceMock },
        { provide: AuthzService, useValue: authzServiceMock },
        OrganizationService,
      ],
    });

    service = TestBed.inject(OrganizationService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should list user organizations', () => {
    const mockOrgs = [
      { id: 'org-1', name: 'Org 1', slug: 'org-1', ownerId: 'user-1' },
      { id: 'org-2', name: 'Org 2', slug: 'org-2', ownerId: 'user-2' },
    ];

    service.listMyOrganizations().subscribe((response) => {
      expect(response.organizations).toEqual(mockOrgs);
    });

    const req = httpMock.expectOne(API_ORGANIZATIONS);
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('Authorization')).toBe('Bearer test-token');
    req.flush({ organizations: mockOrgs });
  });

  it('should set active org when listing organizations', () => {
    const mockOrgs = [{ id: 'org-1', name: 'Org 1', slug: 'org-1', ownerId: 'user-1' }];

    service.listMyOrganizations().subscribe();

    const req = httpMock.expectOne(API_ORGANIZATIONS);
    req.flush({ organizations: mockOrgs });

    expect(authzServiceMock.setActiveOrgId).toHaveBeenCalledWith('org-1');
  });

  it('should collapse two concurrent list calls into one request', () => {
    service.listMyOrganizations().subscribe();
    service.listMyOrganizations().subscribe();

    const requests = httpMock.match(API_ORGANIZATIONS);
    expect(requests.length).toBe(1);

    requests[0].flush({ organizations: [{ id: 'org-1' }] });
  });

  it('should answer a second list call from the cache', () => {
    service.listMyOrganizations().subscribe();
    httpMock.expectOne(API_ORGANIZATIONS).flush({ organizations: [{ id: 'org-1' }] });

    let received: { organizations: { id: string }[] } | undefined;
    service.listMyOrganizations().subscribe((response) => { received = response; });

    httpMock.expectNone(API_ORGANIZATIONS);
    expect(received?.organizations.length).toBe(1);
  });

  it('should drop the cached list when a mutation lands', () => {
    service.listMyOrganizations().subscribe();
    httpMock.expectOne(API_ORGANIZATIONS).flush({ organizations: [] });

    service.createOrganization('Another').subscribe();
    httpMock.expectOne(API_ORGANIZATIONS).flush({ id: 'org-2' });

    service.listMyOrganizations().subscribe();
    httpMock.expectOne(API_ORGANIZATIONS).flush({ organizations: [{ id: 'org-2' }] });
  });

  it('should create organization', () => {
    const orgName = 'New Organization';
    const mockResponse = { id: 'org-123' };

    service.createOrganization(orgName).subscribe((response) => {
      expect(response.id).toBe('org-123');
    });

    const req = httpMock.expectOne(API_ORGANIZATIONS);
    expect(req.request.method).toBe('POST');
    expect(req.request.body.name).toBe(orgName);
    req.flush(mockResponse);
  });

  it('should handle organization creation errors', () => {
    service.createOrganization('Test Org').subscribe({
      next: () => fail('Should have failed'),
      error: (error) => {
        expect(error).toBeTruthy();
      },
    });

    const req = httpMock.expectOne(API_ORGANIZATIONS);
    req.error(new ErrorEvent('Network error'), { status: 500 });
  });

  // A typo in this path is a 404 in production and nothing else in the app touches it.
  it('moves credits into the workspace and drops the cached list', () => {
    service.fundOrganizationFromWallet('org-9', 40).subscribe((result) => {
      expect(result.moved).toBe(40);
    });

    const req = httpMock.expectOne(`${API_ORGANIZATIONS}/org-9/credits/transfer`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ amount: 40, direction: 'toOrg' });
    req.flush({ moved: 40, replayed: false, personalAvailable: 60, organizationAvailable: 40 });

    // The wallet balance rides on the org list, so the mutation has to drop it.
    service.listMyOrganizations().subscribe();
    httpMock.expectOne(API_ORGANIZATIONS).flush({ organizations: [] });
  });

  // The direction is what makes the delete refusal escapable; sending the default
  // would silently fund the workspace again.
  it('asks the server to withdraw, not to fund, on the way out', () => {
    service.withdrawOrganizationCredits('org-9', 25).subscribe();

    const req = httpMock.expectOne(`${API_ORGANIZATIONS}/org-9/credits/transfer`);
    expect(req.request.body).toEqual({ amount: 25, direction: 'fromOrg' });
    req.flush({ moved: 25, replayed: false, personalAvailable: 25, organizationAvailable: 0 });
  });
});
