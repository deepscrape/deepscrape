import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject } from 'rxjs';

import { PlaygroundComponent } from './playground.component';
import { getTestProviders } from 'src/app/testing';

describe('PlaygroundComponent', () => {
  let component: PlaygroundComponent;
  const queryParams$ = new Subject<Record<string, string>>();
  const navigateSpy = jasmine.createSpy('navigate');

  const routeStub = {
    queryParams: queryParams$,
  } as unknown as ActivatedRoute;

  const routerStub = {
    navigate: navigateSpy,
  } as unknown as Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [...getTestProviders()],
    });

    navigateSpy.calls.reset();

    component = TestBed.runInInjectionContext(
      () => new PlaygroundComponent(routeStub, routerStub, { markForCheck: () => {} } as any)
    );
  });

  it('should default to llm-scrape mode', () => {
    expect(component.currentMode).toBe('llm-scrape');
  });

  it('should update mode from query params', () => {
    component.ngOnInit();
    queryParams$.next({ mode: 'crawl' });

    expect(component.currentMode).toBe('crawl');
  });

  it('should fallback to llm-scrape for unknown mode', () => {
    component.ngOnInit();
    queryParams$.next({ mode: 'unknown' });

    expect(component.currentMode).toBe('llm-scrape');
  });

  it('should navigate with merged query params when mode changes', () => {
    component.changeMode('crawl');

    expect(navigateSpy).toHaveBeenCalledWith([], {
      relativeTo: routeStub,
      queryParams: { mode: 'crawl' },
      queryParamsHandling: 'merge',
    });
  });

  it('should not navigate when mode is unchanged', () => {
    component.currentMode = 'llm-scrape';
    component.changeMode('llm-scrape');

    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('should center active mode button after view init', fakeAsync(() => {
    const activeButton = {
      offsetLeft: 120,
      clientWidth: 80,
    };
    const container = {
      clientWidth: 300,
      scrollLeft: 0,
      querySelector: jasmine.createSpy('querySelector').and.returnValue(activeButton),
    };

    component.modeScrollContainer = { nativeElement: container } as unknown as PlaygroundComponent['modeScrollContainer'];
    component.ngAfterViewInit();
    tick(0);

    expect(container.scrollLeft).toBe(10);
  }));
});
