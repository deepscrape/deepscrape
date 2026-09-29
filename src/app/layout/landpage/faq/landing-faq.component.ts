import { Component, ChangeDetectionStrategy, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';
import { TranslateModule } from '@ngx-translate/core';
import { myIcons } from 'src/app/shared/lucideicons';
import { RevealDirective } from 'src/app/shared/reveal/reveal.directive';

interface FaqItem {
  question: string;
  answer: string;
  category: 'general' | 'comparison' | 'technical';
}

@Component({
  selector: 'app-landing-faq',
  standalone: true,
  imports: [LucideAngularModule, NgClass, TranslateModule, RevealDirective],
  templateUrl: './landing-faq.component.html',
  styleUrl: './landing-faq.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LandingFaqComponent {
  readonly icons = myIcons;
  readonly openIndex = signal<number | null>(null);
  readonly activeCategory = signal<'general' | 'comparison' | 'technical'>('general');

  readonly categories = [
    { id: 'general' as const, label: 'FAQ.CAT_GENERAL' },
    { id: 'comparison' as const, label: 'FAQ.CAT_VS_SELFHOST' },
    { id: 'technical' as const, label: 'FAQ.CAT_TECHNICAL' },
  ];

  readonly faqs: FaqItem[] = [
    // General
    {
      question: 'FAQ.Q1',
      answer: 'FAQ.A1',
      category: 'general',
    },
    {
      question: 'FAQ.Q2',
      answer: 'FAQ.A2',
      category: 'general',
    },
    {
      question: 'FAQ.Q3',
      answer: 'FAQ.A3',
      category: 'general',
    },
    // Comparison
    {
      question: 'FAQ.Q4',
      answer: 'FAQ.A4',
      category: 'comparison',
    },
    {
      question: 'FAQ.Q5',
      answer: 'FAQ.A5',
      category: 'comparison',
    },
    {
      question: 'FAQ.Q6',
      answer: 'FAQ.A6',
      category: 'comparison',
    },
    // Technical
    {
      question: 'FAQ.Q7',
      answer: 'FAQ.A7',
      category: 'technical',
    },
    {
      question: 'FAQ.Q8',
      answer: 'FAQ.A8',
      category: 'technical',
    },
    {
      question: 'FAQ.Q9',
      answer: 'FAQ.A9',
      category: 'technical',
    },
  ];

  get filteredFaqs(): FaqItem[] {
    return this.faqs.filter(f => f.category === this.activeCategory());
  }

  toggleFaq(index: number): void {
    this.openIndex.set(this.openIndex() === index ? null : index);
  }

  setCategory(cat: 'general' | 'comparison' | 'technical'): void {
    this.activeCategory.set(cat);
    this.openIndex.set(null);
  }
}
