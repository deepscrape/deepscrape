import { Component, ChangeDetectionStrategy, DestroyRef, inject, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { TranslateModule } from '@ngx-translate/core';
import { interval, Subscription } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { myIcons } from 'src/app/shared/lucideicons';
import { RevealDirective } from 'src/app/shared/reveal/reveal.directive';

/**
 * Interactive "crawl in 60 seconds" demo for the marketing landing page.
 *
 * This is a marketing simulation — it does NOT hit the real API. A guest picks
 * an extraction pack, presses run, and watches a believable machine-deploy →
 * engine → anti-bot → extraction pipeline execute live in the DOM, then
 * receives a mock structured-JSON payload. Pure client-side showpiece built on
 * signals (zoneless-safe, OnPush). No SDK required — the SaaS does the work.
 */
type Pack = {
  id: string;
  url: string;
  engine: string;
  machine: string;
  schema: string;
  /** Operation family the preset demonstrates. */
  mode: 'crawl' | 'batch' | 'watch' | 'interact';
  /** Multiple targets when mode is batch/interact (webrain batch_markdown / batch_interact / batch_extract). */
  targets?: string[];
};

type LogStep = {
  key: string;
  icon: string;
  tone: string;
};

@Component({
  selector: 'app-landing-code-demo',
  standalone: true,
  imports: [NgClass, LucideAngularModule, RouterLink, TranslateModule, RevealDirective],
  templateUrl: './landing-code-demo.component.html',
  styleUrl: './landing-code-demo.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LandingCodeDemoComponent {
  readonly icons = myIcons;

  /** Prebuilt operations a guest can switch between (crawl presets + real webrain ops). */
  readonly packs: Pack[] = [
    {
      id: 'products',
      url: 'https://example.com/products',
      engine: 'chromium',
      machine: 'm-7f2a91',
      schema: 'products',
      mode: 'crawl',
    },
    {
      id: 'docs',
      url: 'https://developer.mozilla.org/en-US/docs/Web',
      engine: 'chromium',
      machine: 'm-9c01de',
      schema: 'docs',
      mode: 'crawl',
    },
    {
      id: 'batch · 3 tabs',
      url: '3 targets · 1 call',
      engine: 'obscura',
      machine: 'm-5a77c2',
      schema: 'batch',
      mode: 'batch',
      targets: [
        'https://docs.deepscrape.dev/getting-started',
        'https://docs.deepscrape.dev/api-reference',
        'https://docs.deepscrape.dev/browser-profiles',
      ],
    },
    {
      id: 'watch video',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      engine: 'yt-dlp',
      machine: 'm-0b41e3',
      schema: 'video',
      mode: 'watch',
    },
    {
      id: 'batch interact',
      url: '2 targets · scripted',
      engine: 'obscura',
      machine: 'm-6d09a1',
      schema: 'interact',
      mode: 'interact',
      targets: [
        'https://example.com/search',
        'https://example.com/cart',
      ],
    },
  ];

  /** Single-target crawl narrative. Keep in sync with stepCount. */
  readonly logSteps: LogStep[] = [
    { key: 'DEMO.LIVE_LOG_1', icon: 'git-branch', tone: 'cyan' },
    { key: 'DEMO.LIVE_LOG_2', icon: 'rocket', tone: 'cyan' },
    { key: 'DEMO.LIVE_LOG_3', icon: 'server', tone: 'rose' },
    { key: 'DEMO.LIVE_LOG_4', icon: 'refresh-cw', tone: 'rose' },
    { key: 'DEMO.LIVE_LOG_5', icon: 'shieldcheck', tone: 'cyan' },
    { key: 'DEMO.LIVE_LOG_6', icon: 'globe', tone: 'rose' },
    { key: 'DEMO.LIVE_LOG_7', icon: 'brain', tone: 'cyan' },
    { key: 'DEMO.LIVE_LOG_8', icon: 'circle-check-big', tone: 'green' },
  ];

  /** Batch narrative — reuses the shared machine spine, fans out to N tabs. */
  readonly batchSteps: LogStep[] = [
    { key: 'DEMO.LIVE_LOG_1', icon: 'git-branch', tone: 'cyan' },
    { key: 'DEMO.LIVE_LOG_2', icon: 'rocket', tone: 'cyan' },
    { key: 'DEMO.LIVE_LOG_3', icon: 'server', tone: 'rose' },
    { key: 'DEMO.LIVE_LOG_4', icon: 'refresh-cw', tone: 'rose' },
    { key: 'DEMO.LIVE_LOG_5', icon: 'shieldcheck', tone: 'cyan' },
    { key: 'DEMO.B_LOG_6', icon: 'layers', tone: 'rose' },
    { key: 'DEMO.B_LOG_7', icon: 'brain', tone: 'cyan' },
    { key: 'DEMO.LIVE_LOG_8', icon: 'circle-check-big', tone: 'green' },
  ];

  /** Watch-video narrative — resolve → download → transcript + frames → LLM summary. */
  readonly watchSteps: LogStep[] = [
    { key: 'DEMO.LIVE_LOG_1', icon: 'git-branch', tone: 'cyan' },
    { key: 'DEMO.LIVE_LOG_2', icon: 'rocket', tone: 'cyan' },
    { key: 'DEMO.LIVE_LOG_3', icon: 'server', tone: 'rose' },
    { key: 'DEMO.W_LOG_1', icon: 'play', tone: 'rose' },
    { key: 'DEMO.W_LOG_2', icon: 'refresh-cw', tone: 'rose' },
    { key: 'DEMO.W_LOG_3', icon: 'monitor', tone: 'cyan' },
    { key: 'DEMO.W_LOG_4', icon: 'brain', tone: 'cyan' },
    { key: 'DEMO.LIVE_LOG_8', icon: 'circle-check-big', tone: 'green' },
  ];

  /** Batch-interact narrative — scripted click/type/scroll across pages, per-page extract. */
  readonly interactSteps: LogStep[] = [
    { key: 'DEMO.LIVE_LOG_1', icon: 'git-branch', tone: 'cyan' },
    { key: 'DEMO.LIVE_LOG_2', icon: 'rocket', tone: 'cyan' },
    { key: 'DEMO.LIVE_LOG_3', icon: 'server', tone: 'rose' },
    { key: 'DEMO.I_LOG_1', icon: 'mouse-pointer-click', tone: 'rose' },
    { key: 'DEMO.I_LOG_2', icon: 'monitor', tone: 'cyan' },
    { key: 'DEMO.I_LOG_3', icon: 'layers', tone: 'rose' },
    { key: 'DEMO.I_LOG_4', icon: 'brain', tone: 'cyan' },
    { key: 'DEMO.LIVE_LOG_8', icon: 'circle-check-big', tone: 'green' },
  ];

  readonly stepCount = this.logSteps.length;

  readonly pack = signal<Pack>(this.packs[0]);
  readonly running = signal(false);
  readonly step = signal(0);
  readonly progress = signal(0);

  /** Steps for the active operation. */
  steps(): LogStep[] {
    switch (this.pack().mode) {
      case 'batch':
        return this.batchSteps;
      case 'watch':
        return this.watchSteps;
      case 'interact':
        return this.interactSteps;
      default:
        return this.logSteps;
    }
  }

  /** Target URL(s) for the active operation. */
  targets(): string[] {
    const p = this.pack();
    return p.targets && p.targets.length ? p.targets : [p.url];
  }

  /** Under-the-hood pipeline rows (step thresholds drive their state). */
  readonly hoodRows = [
    { key: 'deploy', icon: 'rocket', labelKey: 'DEMO.HOOD_ROW_1', at: 1 },
    { key: 'engine', icon: 'server', labelKey: 'DEMO.HOOD_ROW_2', at: 2 },
    { key: 'proxy', icon: 'refresh-cw', labelKey: 'DEMO.HOOD_ROW_3', at: 4 },
    { key: 'shield', icon: 'shieldcheck', labelKey: 'DEMO.HOOD_ROW_4', at: 5 },
    { key: 'extract', icon: 'brain', labelKey: 'DEMO.HOOD_ROW_5', at: 6 },
  ];

  private readonly destroyRef = inject(DestroyRef);
  private runSub: Subscription | null = null;

  selectPack(p: Pack): void {
    this.pack.set(p);
    if (!this.running()) {
      this.run();
    }
  }

  run(): void {
    if (this.running()) {
      return;
    }
    this.runSub?.unsubscribe();
    this.step.set(0);
    this.progress.set(0);
    this.running.set(true);

    this.runSub = interval(600)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((i) => {
        const n = i + 1;
        this.step.set(n);
        this.progress.set(Math.min(100, Math.round((n / this.stepCount) * 100)));
        if (n >= this.stepCount) {
          this.running.set(false);
        }
      });
  }

  /** Map console run state to a status chip tone. */
  statusTone(): 'pending' | 'live' | 'done' {
    if (this.step() === 0 && !this.running()) {
      return 'pending';
    }
    return this.step() >= this.stepCount ? 'done' : 'live';
  }

  /** i18n params injected into console log lines (url / machine / schema…). */
  lineParams(): Record<string, string> {
    const p = this.pack();
    return { url: p.url, machine: p.machine, engine: p.engine, schema: p.schema };
  }

  /** Pipeline row state derived from the current step. */
  hoodState(i: number): 'done' | 'live' | 'pending' {
    const at = this.hoodRows[i].at;
    const s = this.step();
    if (this.running() && s === at) {
      return 'live';
    }
    if (s > at || s >= this.stepCount) {
      return 'done';
    }
    return 'pending';
  }

  /** Pipeline row fill percent. */
  hoodPct(i: number): number {
    const st = this.hoodState(i);
    return st === 'done' ? 100 : st === 'live' ? 55 : 8;
  }
}
