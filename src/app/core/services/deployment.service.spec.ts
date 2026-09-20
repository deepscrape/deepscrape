import { DeploymentService } from './deployment.service';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AuthService } from './auth.service';
import { API_ARACHNEFLY_URL } from '../variables';
import { getTestProviders } from 'src/app/testing';

describe('DeploymentService', () => {
  let service: DeploymentService;
  let httpMock: HttpTestingController;
  let authServiceMock: Pick<AuthService, 'token'>;

  beforeEach(() => {
    authServiceMock = { token: 'token-123' } as Pick<AuthService, 'token'>;

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [...getTestProviders(), { provide: AuthService, useValue: authServiceMock }],
    });

    service = TestBed.inject(DeploymentService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should request image deployability and map response data', (done) => {
    service.checkImageDeployability('ghcr.io/org/image:latest').subscribe((result) => {
      expect(result).toEqual({ exists: true, info: { registry: 'ghcr' } as any });
      done();
    });

    const req = httpMock.expectOne(
      (request) =>
        request.method === 'GET' &&
        request.url === `${API_ARACHNEFLY_URL}/check-image` &&
        request.params.get('name') === 'ghcr.io/org/image:latest',
    );

    expect(req.request.headers.get('Authorization')).toBe('Bearer token-123');
    req.flush({ data: { exists: true, info: { registry: 'ghcr' } } });
  });

  it('should request a machine by id and unwrap response data', (done) => {
    service.getMachine('machine-123').subscribe((result) => {
      expect(result).toEqual({ id: 'machine-123' } as any);
      done();
    });

    const req = httpMock.expectOne(`${API_ARACHNEFLY_URL}/machine/machine-123`);
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('Authorization')).toBe('Bearer token-123');
    req.flush({ data: { id: 'machine-123' } });
  });

  it('should send region and clone params when creating a machine', (done) => {
    const payload = { region: 'lhr', image: 'nginx:latest' };

    service.createMachine(payload).subscribe((result) => {
      expect(result).toEqual({ id: 'machine-123' } as any);
      done();
    });

    const req = httpMock.expectOne(
      (request) =>
        request.method === 'POST' &&
        request.url === `${API_ARACHNEFLY_URL}/deploy` &&
        request.params.get('region') === 'lhr' &&
        request.params.get('clone') === 'false',
    );

    expect(req.request.body).toEqual(payload);
    req.flush({ data: { id: 'machine-123' } });
  });
});
