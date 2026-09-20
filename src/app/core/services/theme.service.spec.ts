import { TestBed } from '@angular/core/testing';

import { ThemeService } from './theme.service';
import { getTestProviders } from 'src/app/testing';
import { LocalStorage } from './storage.service';
import { themeStorageKey } from 'src/app/shared';
import { WindowToken } from './window.service';

describe('ThemeService', () => {
  let service: ThemeService;
  let localStorageMock: jasmine.SpyObj<Storage>;

  /**
   * Controllable stand-in for the host's `prefers-color-scheme`.
   *
   * `getTestProviders` provides the REAL window, and ThemeService falls back to
   * the system preference when nothing is stored — so these tests used to assert
   * against whatever theme the machine running them happened to use. They passed
   * on a light CI box and failed on a dark desktop, which is the shape of a flake
   * nobody can reproduce.
   */
  let systemPrefersDark = false;
  const windowStub = {
    matchMedia: (query: string) =>
      ({ matches: query.includes('dark') && systemPrefersDark }) as MediaQueryList,
  } as unknown as Window;

  const createService = (): ThemeService =>
    TestBed.runInInjectionContext(() => new ThemeService());

  beforeEach(() => {
    systemPrefersDark = false;
    localStorageMock = jasmine.createSpyObj('Storage', ['getItem', 'setItem', 'removeItem', 'clear']);
    localStorageMock.getItem.and.returnValue(null);

    TestBed.configureTestingModule({
      providers: [
        ...getTestProviders(),
        { provide: LocalStorage, useValue: localStorageMock },
        { provide: WindowToken, useValue: windowStub },
      ],
    });

    service = createService();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should initialize with light mode when no stored preference', () => {
    localStorageMock.getItem.and.returnValue(null);
    const newService = createService();
    expect(newService.isDarkMode).toBe(false);
  });

  it('should initialize with dark mode when stored as true', () => {
    localStorageMock.getItem.and.returnValue('true');
    const newService = createService();
    expect(newService.isDarkMode).toBe(true);
  });

  it('should emit theme changes via observable', (done) => {
    localStorageMock.getItem.and.returnValue(null);
    const newService = createService();

    newService.isDarkMode$.subscribe((isDark) => {
      expect(isDark).toBe(false);
      done();
    });
  });

  it('should update theme when setDarkMode is called', (done) => {
    localStorageMock.getItem.and.returnValue(null);
    const newService = createService();

    newService.setDarkMode(true);
    expect(newService.isDarkMode).toBe(true);

    newService.isDarkMode$.subscribe((isDark) => {
      expect(isDark).toBe(true);
      done();
    });
  });

  it('should toggle between dark and light modes', (done) => {
    localStorageMock.getItem.and.returnValue(null);
    const newService = createService();

    expect(newService.isDarkMode).toBe(false);
    newService.setDarkMode(true);
    expect(newService.isDarkMode).toBe(true);
    newService.setDarkMode(false);

    newService.isDarkMode$.subscribe((isDark) => {
      expect(isDark).toBe(false);
      done();
    });
  });

  it('should follow the system preference when nothing is stored', () => {
    systemPrefersDark = true;
    localStorageMock.getItem.and.returnValue(null);

    expect(createService().isDarkMode).toBe(true);
  });

  it('should let an explicit stored value win over the system preference', () => {
    systemPrefersDark = true;
    localStorageMock.getItem.and.returnValue('false');

    expect(createService().isDarkMode).toBe(false);
  });
});
