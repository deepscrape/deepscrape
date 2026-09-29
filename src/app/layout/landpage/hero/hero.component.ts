import {
  Component,
  inject,
  Inject,
  DOCUMENT,
  PLATFORM_ID,
  DestroyRef,
  signal,
  OnInit,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { NgClass } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ScrollService } from 'src/app/core/services';
import { myIcons } from 'src/app/shared/lucideicons';

@Component({
  selector: 'app-hero',
  imports: [LucideAngularModule, RouterLink, NgClass, TranslateModule],
  templateUrl: './hero.component.html',
  styleUrl: './hero.component.scss'
})
export class HeroComponent implements OnInit {

  readonly icons = myIcons
  readonly bgImagePath = 'images/bgland-optimized.webp'
  activeLang: 'python' | 'node' | 'curl' = 'python';

  /**
   * Translation keys for the "web rain" outputs that rotate in the hero copy.
   * Static (first phrase) on SSR and for reduced-motion users.
   */
  readonly phraseKeys = ['HERO.TYPED_1', 'HERO.TYPED_2', 'HERO.TYPED_3'];
  readonly typedText = signal<string>('');
  readonly caretOn = signal(false);

  private readonly translate = inject(TranslateService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly destroyRef = inject(DestroyRef);
  private typeTimer: ReturnType<typeof setTimeout> | null = null;
  private scroll = inject(ScrollService);

  constructor(private router: Router, @Inject(DOCUMENT) private document: Document) { }

  ngOnInit(): void {
    this.typedText.set(this.phrase(0));
    this.startTypewriter();
  }

  /** Resolve a typed phrase key in the active locale. */
  private phrase(i: number): string {
    return this.translate.instant(this.phraseKeys[i]);
  }

  /** Type/erase/rotate the example outputs. Static for SSR + reduced motion. */
  private startTypewriter(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let pi = 0;
    let pos = this.phrase(0).length; // show the first phrase, then rotate
    let state: 'hold' | 'erase' | 'type' = 'hold';

    const tick = () => {
      const cur = this.phrase(pi);
      if (pos > cur.length) pos = cur.length; // self-heal on mid-cycle language switch
      if (state === 'hold') {
        this.caretOn.set(false);
        state = 'erase';
        this.typeTimer = setTimeout(tick, 1500);
        return;
      }
      if (state === 'erase') {
        pos = Math.max(0, pos - 1);
        this.typedText.set(this.phrase(pi).slice(0, pos));
        this.caretOn.set(pos > 0);
        if (pos === 0) {
          pi = (pi + 1) % this.phraseKeys.length;
          state = 'type';
        }
        this.typeTimer = setTimeout(tick, pos === 0 ? 140 : 34);
        return;
      }
      // typing forward
      const t = this.phrase(pi);
      pos = Math.min(t.length, pos + 1);
      this.typedText.set(t.slice(0, pos));
      this.caretOn.set(pos < t.length);
      if (pos === t.length) state = 'hold';
      this.typeTimer = setTimeout(tick, 46);
    };

    this.typeTimer = setTimeout(tick, 1100);
    this.destroyRef.onDestroy(() => {
      if (this.typeTimer) clearTimeout(this.typeTimer);
    });
  }

  scrollTo(link: string) {
    const elem = this.document.getElementById(link) as HTMLElement
    if (elem)
      this.scroll.scrollToElementByOffset(elem)
  }


  scrollIntoView() {
    const url = this.router.url
    const id: string = url.substring(url.indexOf('#') + 1)
    if (id) this.scrollTo(id)
  }
}
