import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { Observable, Subject } from 'rxjs';
import { PricingRatesService } from '../../../../core/services/pricing-rates.service';
import {
  PricingRate,
  PricingRatesResponse,
} from '../../../../core/types/pricing-rates.interface';
import { RatesComponent } from './rates.component';

/**
 * One rate, with the fields the page reads.
 * @param {Partial<PricingRate>} patch Fields to override.
 * @return {PricingRate} The rate.
 */
const rate = (patch: Partial<PricingRate> = {}): PricingRate => ({
  action: 'crawl.execute',
  method: 'POST',
  credits: 3,
  ...patch,
});

/** The fallback the page renders separately from the sections. */
const fallbackRate = (): PricingRate => ({
  action: 'api.paid.default',
  credits: 1,
});

/**
 * The point of this page is that it holds no prices, so the properties worth
 * pinning are the ones that make that true: that a rate the page has never heard of
 * still renders with its correct cost, that the grouping comes from the action
 * rather than a hand-written list, and that the fallback is kept out of the
 * sections. If any of those broke, the page would start telling a customer
 * something the charging code does not do, which is precisely the drift this page
 * exists to prevent.
 *
 * This spec is also what forces the TEMPLATE to compile. The page IS referenced by
 * `billing.route.ts`, so `bun run build` covers it too; both gates are run.
 */
describe('RatesComponent', () => {
  let fixture: ComponentFixture<RatesComponent>;
  let list$: Subject<PricingRatesResponse>;

  /** A response with a status but no body, which is what the guard reads. */
  const httpError = (status: number): HttpErrorResponse =>
    new HttpErrorResponse({ status });

  beforeEach(async () => {
    list$ = new Subject();

    const stub = {
      rates: (): Observable<PricingRatesResponse> => list$.asObservable(),
    };

    await TestBed.configureTestingModule({
      imports: [RatesComponent, TranslateModule.forRoot()],
      providers: [
        { provide: PricingRatesService, useValue: stub },
        // The envelope renders through the animation engine, so without this
        // EVERY render throws NG05105.
        provideNoopAnimations(),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RatesComponent);
    // ngOnInit issues the read, so this also puts `list$` under observation.
    fixture.detectChanges();
  });

  const page = (): RatesComponent => fixture.componentInstance;

  /** The rendered text. */
  const text = (): string =>
    (fixture.nativeElement as HTMLElement).textContent ?? '';

  /**
   * Answer the pending rates read.
   * @param {PricingRate[]} rates The rates to answer with.
   * @return {void} Nothing.
   */
  const listReplies = (rates: PricingRate[]): void => {
    list$.next({ status: 'ok', rates, fallback: fallbackRate() });
    list$.complete();
    fixture.detectChanges();
  };

  it('shows ready when the table comes back', () => {
    listReplies([rate()]);
    expect(page().state()).toBe('ready');
    expect(page().rates().length).toBe(1);
  });

  it('shows empty, not ready, when nothing is priced', () => {
    // "No rates are published" and "here is the price list" have different
    // remedies.
    listReplies([]);
    expect(page().state()).toBe('empty');
  });

  it('renders a rate it has never heard of, with its real cost', () => {
    // THE anti-drift property. A rate added on the server must appear without a
    // change here, and it must appear with the number the server sent.
    listReplies([rate({ action: 'machines.some_new_action', credits: 7 })]);

    expect(text()).toContain('machines.some_new_action');
    expect(text()).toContain('7');
  });

  it('labels a rate it does know', () => {
    listReplies([rate({ action: 'crawl.execute' })]);
    expect(text()).toContain('PRICING_RATES.ACTION_CRAWL');
  });

  it('groups by the action name, not by a hand-written list', () => {
    listReplies([
      rate({ action: 'ai.groq.chat', credits: 1 }),
      rate({ action: 'crawl.execute', credits: 3 }),
      rate({ action: 'machines.deploy', credits: 5 }),
      rate({ action: 'totally.unclassified', credits: 9 }),
    ]);

    expect(page().groups().map(entry => entry.group)).toEqual([
      'ai',
      'crawl',
      'machines',
      'other',
    ]);
  });

  it('orders the sections itself rather than trusting the reply order', () => {
    // Otherwise the page reshuffles when someone edits the pricing table.
    listReplies([
      rate({ action: 'machines.deploy', credits: 5 }),
      rate({ action: 'crawl.execute', credits: 3 }),
    ]);

    expect(page().groups().map(entry => entry.group)).toEqual([
      'crawl',
      'machines',
    ]);
  });

  it('leaves out a section that has no rates', () => {
    listReplies([rate({ action: 'crawl.execute' })]);
    expect(page().groups().length).toBe(1);
    expect(text()).not.toContain('PRICING_RATES.GROUP_MACHINES');
  });

  it('keeps the fallback out of the sections', () => {
    // It states something different: not an action a customer can buy, but the
    // price of anything unlisted.
    listReplies([rate({ action: 'crawl.execute' })]);

    expect(page().fallback()?.action).toBe('api.paid.default');
    expect(page().groups().map(entry => entry.group)).toEqual(['crawl']);
    expect(text()).toContain('PRICING_RATES.FALLBACK_LABEL');
  });

  it('carries the fallback credits the server sent', () => {
    listReplies([rate()]);
    expect(page().fallback()?.credits).toBe(1);
  });

  it('reads 401 as an expired session', () => {
    list$.error(httpError(401));
    expect(page().errorKey()).toBe('PRICING_RATES.ERROR_SESSION');
    expect(page().state()).toBe('error');
  });

  it('keeps 403 a different failure from an expired session', () => {
    list$.error(httpError(403));
    expect(page().errorKey()).toBe('PRICING_RATES.ERROR_FORBIDDEN');
    expect(page().errorKey()).not.toBe('PRICING_RATES.ERROR_SESSION');
  });

  it('reports an unreadable price list as a failure, not as an empty one', () => {
    // An empty page would make a false claim about the product.
    list$.error(httpError(500));
    expect(page().errorKey()).toBe('PRICING_RATES.ERROR_GENERIC');
    expect(page().state()).not.toBe('empty');
  });

  it('uses a singular unit for one credit and a plural otherwise', () => {
    expect(page().creditUnitKey(1)).toBe('PRICING_RATES.CREDIT');
    expect(page().creditUnitKey(3)).toBe('PRICING_RATES.CREDITS');
    expect(page().creditUnitKey(0)).toBe('PRICING_RATES.CREDITS');
  });
});
