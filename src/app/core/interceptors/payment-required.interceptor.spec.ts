import {
  HttpErrorResponse,
  HttpHandlerFn,
  HttpRequest,
  HttpResponse,
} from '@angular/common/http'
import { TestBed } from '@angular/core/testing'
import { Router } from '@angular/router'
import { Observable, of, throwError } from 'rxjs'
import { WindowToken } from '../services'
import { paymentRequiredInterceptor } from './payment-required.interceptor'
import { getTestProviders } from 'src/app/testing';

describe('paymentRequiredInterceptor', () => {
  let routerMock: jasmine.SpyObj<Pick<Router, 'navigate' | 'url'>>
  let windowMock: Pick<Window, 'location'>

  const executeInterceptor = (req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<unknown> =>
    TestBed.runInInjectionContext(() => paymentRequiredInterceptor(req, next))

  beforeEach(() => {
    routerMock = jasmine.createSpyObj<Pick<Router, 'navigate' | 'url'>>('Router', ['navigate'], {
      url: '/dashboard',
    })
    routerMock.navigate.and.resolveTo(true)

    windowMock = {
      location: {
        origin: 'https://deepscrape.dev',
      } as Location,
    }
    TestBed.configureTestingModule({
      providers: [
        ...getTestProviders(),
        { provide: Router, useValue: routerMock },
        { provide: WindowToken, useValue: windowMock },
      ],
    })
  })

  it('passes through non-API requests without redirecting', (done) => {
    const req = new HttpRequest('GET', '/assets/logo.svg')
    const next: HttpHandlerFn = () => of(new HttpResponse({ status: 200 }))

    executeInterceptor(req, next).subscribe((event) => {
      expect(event).toEqual(jasmine.any(HttpResponse))
      expect(routerMock.navigate).not.toHaveBeenCalled()
      done()
    })
  })

  it('redirects to billing plans on 402 API response', (done) => {
    const req = new HttpRequest('GET', '/api/jobs')
    const error = new HttpErrorResponse({
      status: 402,
      url: '/api/jobs',
      error: { code: 'payment_required' },
    })
    const next: HttpHandlerFn = () => throwError(() => error)

    executeInterceptor(req, next).subscribe({
      next: () => fail('expected error'),
      error: (receivedError) => {
        expect(receivedError).toBe(error)
        expect(routerMock.navigate).toHaveBeenCalledWith(['/billing/plans'], {
          queryParams: {
            reason: 'payment_required',
            returnUrl: '/dashboard',
          },
        })
        done()
      },
    })
  })

  it('stays put when the 402 arrives while a checkout is settling', (done) => {
    Object.defineProperty(routerMock, 'url', {
      value: '/org_abc?checkout=success',
      configurable: true,
    })

    const req = new HttpRequest('GET', '/api/jobs')
    const error = new HttpErrorResponse({
      status: 402,
      url: '/api/jobs',
      error: { code: 'payment_required' },
    })
    const next: HttpHandlerFn = () => throwError(() => error)

    executeInterceptor(req, next).subscribe({
      next: () => fail('expected error'),
      error: (receivedError) => {
        expect(receivedError).toBe(error)
        expect(routerMock.navigate).not.toHaveBeenCalled()
        done()
      },
    })
  })

  it('sends a held wallet to the passes page, not to the plans page', (done) => {
    const req = new HttpRequest('GET', '/api/jobs')
    const error = new HttpErrorResponse({
      status: 402,
      url: '/api/jobs',
      error: { code: 'wallet_on_hold' },
    })
    const next: HttpHandlerFn = () => throwError(() => error)

    executeInterceptor(req, next).subscribe({
      next: () => fail('expected error'),
      error: () => {
        // A held wallet may be full: "buy a plan" is wrong advice, and the passes page is
        // where the balance and the reason are rendered.
        expect(routerMock.navigate).toHaveBeenCalledWith(['/billing/passes'])
        done()
      },
    })
  })

  it('does not redirect when already on a billing page', (done) => {
    Object.defineProperty(routerMock, 'url', {
      value: '/billing/plans',
      configurable: true,
    })

    const req = new HttpRequest('GET', '/api/jobs')
    const error = new HttpErrorResponse({
      status: 402,
      url: '/api/jobs',
      error: { error: 'payment_required' },
    })
    const next: HttpHandlerFn = () => throwError(() => error)

    executeInterceptor(req, next).subscribe({
      next: () => fail('expected error'),
      error: () => {
        expect(routerMock.navigate).not.toHaveBeenCalled()
        done()
      },
    })
  })

  it('does not redirect for non-payment API errors', (done) => {
    const req = new HttpRequest('GET', '/api/jobs')
    const error = new HttpErrorResponse({
      status: 500,
      url: '/api/jobs',
      error: { code: 'internal_error' },
    })
    const next: HttpHandlerFn = () => throwError(() => error)

    executeInterceptor(req, next).subscribe({
      next: () => fail('expected error'),
      error: () => {
        expect(routerMock.navigate).not.toHaveBeenCalled()
        done()
      },
    })
  })
})
