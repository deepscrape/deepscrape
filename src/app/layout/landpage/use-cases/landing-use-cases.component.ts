import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  viewChild,
} from '@angular/core';
import { NgClass } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';
import { TranslateModule } from '@ngx-translate/core';
import { myIcons } from 'src/app/shared/lucideicons';
import { RevealDirective } from 'src/app/shared/reveal/reveal.directive';

interface UseCase {
  icon: string;
  title: string;
  headline: string;
  description: string;
  gradient: string;
  features: string[];
  bgIcon: string;
}

@Component({
  selector: 'app-landing-use-cases',
  standalone: true,
  imports: [NgClass, LucideAngularModule, TranslateModule, RevealDirective],
  templateUrl: './landing-use-cases.component.html',
  styleUrl: './landing-use-cases.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LandingUseCasesComponent {
  readonly icons = myIcons;

  /** Decorative mp4 in the banner — streamed only when the section nears the viewport. */
  private readonly useCasesVideo =
    viewChild.required<ElementRef<HTMLVideoElement>>('useCasesVideo');

  constructor() {
    // Browser-only: the 4MB mp4 must not be fetched on page load (preload="none"),
    // so playback is started when the section scrolls near the viewport instead.
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const video = this.useCasesVideo().nativeElement;
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              video.play().catch(() => undefined);
            } else {
              video.pause();
            }
          }
        },
        { rootMargin: '300px 0px' },
      );
      observer.observe(video);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  readonly useCaseImages = [
    'assets/images/landing/use-cases-ecommerce.svg',
    'assets/images/landing/use-cases-ai-training.svg',
    'assets/images/landing/use-cases-market-research.svg',
    'assets/images/landing/use-cases-seo.svg',
  ];

  // Color helpers per use-case index: [icon-text, check-border, label, accent-bar, glow-rgba]
  private readonly iconColorClasses = [
    'text-cyan-500',
    'text-violet-400',
    'text-emerald-500',
    'text-orange-500',
  ];
  private readonly labelColorClasses = [
    'text-cyan-600 dark:text-cyan-400',
    'text-violet-500 dark:text-violet-400',
    'text-emerald-600 dark:text-emerald-400',
    'text-orange-500 dark:text-orange-400',
  ];
  readonly accentBarClasses = [
    'from-cyan-500 to-blue-600',
    'from-violet-500 to-rose-500',
    'from-emerald-500 to-teal-600',
    'from-orange-500 to-rose-500',
  ];
  readonly borderGlowColors = [
    'rgba(6,182,212,0.35)',
    'rgba(139,92,246,0.35)',
    'rgba(16,185,129,0.35)',
    'rgba(249,115,22,0.35)',
  ];

  readonly useCases: UseCase[] = [
    {
      icon: 'shoppingbag',
      title: 'USECASES.UC1_T',
      headline: 'USECASES.UC1_H',
      description: 'USECASES.UC1_D',
      gradient: 'from-cyan-500 to-blue-600',
      features: [
        'USECASES.UC1_F1',
        'USECASES.UC1_F2',
        'USECASES.UC1_F3',
        'USECASES.UC1_F4',
      ],
      bgIcon: 'store',
    },
    {
      icon: 'brain',
      title: 'USECASES.UC2_T',
      headline: 'USECASES.UC2_H',
      description: 'USECASES.UC2_D',
      gradient: 'from-violet-500 to-rose-500',
      features: [
        'USECASES.UC2_F1',
        'USECASES.UC2_F2',
        'USECASES.UC2_F3',
        'USECASES.UC2_F4',
      ],
      bgIcon: 'sparkles',
    },
    {
      icon: 'target',
      title: 'USECASES.UC3_T',
      headline: 'USECASES.UC3_H',
      description: 'USECASES.UC3_D',
      gradient: 'from-emerald-500 to-teal-600',
      features: [
        'USECASES.UC3_F1',
        'USECASES.UC3_F2',
        'USECASES.UC3_F3',
        'USECASES.UC3_F4',
      ],
      bgIcon: 'globe',
    },
    {
      icon: 'search',
      title: 'USECASES.UC4_T',
      headline: 'USECASES.UC4_H',
      description: 'USECASES.UC4_D',
      gradient: 'from-orange-500 to-rose-500',
      features: [
        'USECASES.UC4_F1',
        'USECASES.UC4_F2',
        'USECASES.UC4_F3',
        'USECASES.UC4_F4',
      ],
      bgIcon: 'linechart',
    },
  ];

  iconColorClass(i: number): string {
    return this.iconColorClasses[i] ?? 'text-cyan-500';
  }

  labelColorClass(i: number): string {
    return this.labelColorClasses[i] ?? 'text-cyan-600 dark:text-cyan-400';
  }

  accentBarClass(i: number): string {
    return this.accentBarClasses[i] ?? 'from-cyan-500 to-blue-600';
  }

  borderGlowColor(i: number): string {
    return this.borderGlowColors[i] ?? 'rgba(6,182,212,0.35)';
  }
}
