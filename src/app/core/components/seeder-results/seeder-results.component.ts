import { ChangeDetectionStrategy, Component, Input } from '@angular/core'
import { SeederResult } from '../../types/seeding.interface'
import { NgClass, DecimalPipe, UpperCasePipe, KeyValuePipe } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { expandCollapseAnimation, fadeInUp } from 'src/app/animations'
import { MatIconModule } from '@angular/material/icon'
import { MatTooltipModule } from '@angular/material/tooltip'


@Component({
  selector: 'app-seeder-results',
  imports: [NgClass, DecimalPipe, UpperCasePipe, KeyValuePipe, MatIconModule, MatTooltipModule, TranslateModule],
  templateUrl: './seeder-results.component.html',
  styleUrl: './seeder-results.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    fadeInUp,
    expandCollapseAnimation
  ]
})
export class SeederResultsComponent {
  @Input() results: SeederResult[] = []
  expanded: { [url: string]: boolean } = {}

  toggleExpand(url: string) {
    this.expanded[url] = !this.expanded[url]
  }

  // Get defined metadata with improved filtering
  getDefinedMeta(meta: any): Record<string, string> {
    if (!meta) return {}
    return Object.fromEntries(
      Object.entries(meta)
        .filter(([_, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)])
    )
  }

  // Helper method to get the most important metadata
  getPrimaryMeta(meta: any): Record<string, string> {
    if (!meta) return {}
    
    // Priority metadata fields
    const priorityFields = ['description', 'keywords', 'author', 'og:title', 'og:description']
    
    return Object.fromEntries(
      Object.entries(meta)
        .filter(([k, v]) => priorityFields.includes(k) && v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)])
    )
  }
  
  // Helper method to get secondary metadata
  getSecondaryMeta(meta: any): Record<string, string> {
    if (!meta) return {}
    
    // Priority metadata fields to exclude from secondary
    const priorityFields = ['description', 'keywords', 'author', 'og:title', 'og:description']
    
    return Object.fromEntries(
      Object.entries(meta)
        .filter(([k, v]) => !priorityFields.includes(k) && v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)])
    )
  }

  // Get a relevance color class based on score
  getRelevanceColorClass(score: number): string {
    if (score >= 0.8) return 'text-green-600 dark:text-green-400'
    if (score >= 0.6) return 'text-sky-600 dark:text-sky-400'
    if (score >= 0.4) return 'text-yellow-600 dark:text-yellow-400'
    return 'text-orange-600 dark:text-orange-400'
  }
  
  // Get background style based on relevance score
  getRelevanceBackgroundStyle(score: number): object {
    const opacity = Math.min(score * 0.15, 0.15).toFixed(2)
    
    if (score >= 0.8) {
      return { 
        'background': `rgba(16, 185, 129, ${opacity})`,
        'border-left': '3px solid rgb(16, 185, 129)'
      }
    }
    if (score >= 0.6) {
      return { 
        'background': `rgba(14, 165, 233, ${opacity})`,
        'border-left': '3px solid rgb(14, 165, 233)'
      }
    }
    if (score >= 0.4) {
      return { 
        'background': `rgba(250, 204, 21, ${opacity})`,
        'border-left': '3px solid rgb(250, 204, 21)'
      }
    }
    return { 
      'background': `rgba(234, 88, 12, ${opacity})`,
      'border-left': '3px solid rgb(234, 88, 12)'
    }
  }
  
  // Get a clean domain name without www.
  getCleanDomain(domain: string): string {
    return domain.replace(/^www\./, '')
  }
  
  // Get domain favicon URL
  getFaviconUrl(domain: string): string {
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
  }
  
  // Get jsonld types from the data
  getJsonLdTypes(jsonld: any[] | undefined): string[] {
    if (!jsonld || !jsonld.length) return []
    
    return jsonld
      .filter(item => item && item['@type'])
      .map(item => item['@type'])
      .flat()
      .filter((value, index, self) => self.indexOf(value) === index)
  }
}
