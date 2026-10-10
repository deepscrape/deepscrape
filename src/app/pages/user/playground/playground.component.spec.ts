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

  it('should accept the browser mode from query params', () => {
    // Regression, found 2026-10-03: `browser` was missing from the accept-list
    // in `ngOnInit` while the `modes` array, the gate record and the template arm
    // all had it. So `?mode=browser` fell through to the default and the Browser
    // tab looked selected while rendering the LLM Scrape pane.
    component.ngOnInit();
    queryParams$.next({ mode: 'browser' });

    expect(component.currentMode).toBe('browser');
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

  it('locates the active tab by its data attribute, not by a visual class', fakeAsync(() => {
    // Regression guard, 2026-10-10: the lookup was `button.shadow-md`. The active
    // styling moved from a shadow to a ring, so the selector matched nothing, the
    // strip stopped scrolling to the selected mode, and every spec still passed --
    // the stub above returns its button whatever the selector is, so only an
    // assertion on the selector itself can catch this.
    const querySelector = jasmine.createSpy('querySelector').and.returnValue(null);
    const container = {
      clientWidth: 300,
      scrollLeft: 0,
      querySelector,
    };

    component.modeScrollContainer = { nativeElement: container } as unknown as PlaygroundComponent['modeScrollContainer'];
    component.ngAfterViewInit();
    tick(0);

    expect(querySelector).toHaveBeenCalledWith('button[data-active="true"]');
  }));
});
