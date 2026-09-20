import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

const ORIGIN = 'https://deepscrape.dev';
const SITE = 'deepscrape';
const OG_IMAGE = `${ORIGIN}/og-deepscrape-1200x630.png`;

// ponytail: only these paths are public and indexable today; everything else (auth, app, not-found) is noindex.
const SEO: Record<string, { title: string; description: string }> = {
  '': {
    title: 'Web Scraping API & Crawl Orchestration for AI | deepscrape',
    description:
      'Turn any website into structured, AI-ready data. deepscrape handles proxies, anti-bot, browser rendering and LLM extraction end-to-end. Try it free today.',
  },
  '/contact': {
    title: 'Contact deepscrape — We Reply Within a Day',
    description:
      'Questions, feedback or partnership? Message the deepscrape team — expect a reply within one business day. We are happy to help you get started right away.',
  },
  '/privacy': {
    title: 'Privacy Policy — How deepscrape Protects Data',
    description:
      'How deepscrape collects, uses and protects your data: what we store, our security, sharing with processors, and your GDPR rights — explained in plain language.',
  },
  '/terms': {
    title: 'Terms of Service — Using deepscrape',
    description:
      'Plain-language terms for using deepscrape: acceptable use, billing, intellectual property, liability limits, and how we may update these terms over time.',
  },
};

/** '/contact/' -> '/contact', '/' -> ''. Query/hash stripped. */
export function pathOf(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  return path.length > 1 ? path.replace(/\/+$/, '') : path === '/' ? '' : path;
}

export function isIndexablePath(path: string): boolean {
  return path in SEO;
}

/** Trailing slash matches the site's 301 canonical form. */
export function canonicalUrl(path: string): string {
  return path === '' ? `${ORIGIN}/` : `${ORIGIN}${path}/`;
}

@Injectable()
export class SeoTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly doc = inject(DOCUMENT);

  override updateTitle(state: RouterStateSnapshot): void {
    const path = pathOf(state.url);
    const seo = SEO[path];
    const indexable = !!seo;

    this.title.setTitle(indexable ? seo.title : SITE);

    this.upsertMeta('name', 'description', indexable ? seo.description : null);
    this.upsertMeta('property', 'og:title', indexable ? seo.title : null);
    this.upsertMeta('property', 'og:description', indexable ? seo.description : null);
    this.upsertMeta('property', 'og:url', indexable ? canonicalUrl(path) : null);
    this.upsertMeta('property', 'og:type', indexable ? 'website' : null);
    this.upsertMeta('property', 'og:image', indexable ? OG_IMAGE : null);
    this.upsertMeta('property', 'og:image:width', indexable ? '1200' : null);
    this.upsertMeta('property', 'og:image:height', indexable ? '630' : null);
    this.upsertMeta('property', 'og:image:alt', indexable ? seo.title : null);
    this.upsertMeta('name', 'robots', indexable ? null : 'noindex, nofollow');

    this.setCanonical(indexable ? canonicalUrl(path) : null);
    this.setJsonLd(indexable ? orgJsonLd() : null);
  }

  private upsertMeta(attr: 'name' | 'property', key: string, content: string | null): void {
    const selector = `${attr}="${key}"`;
    if (content === null) {
      this.meta.removeTag(selector);
      return;
    }
    if (this.meta.getTag(selector)) {
      this.meta.updateTag({ [attr]: key, content });
    } else {
      this.meta.addTag({ [attr]: key, content });
    }
  }

  private setCanonical(href: string | null): void {
    let link = this.doc.head.querySelector<HTMLLinkElement>('link#seo-canonical');
    if (href === null) {
      link?.remove();
      return;
    }
    if (!link) {
      link = this.doc.createElement('link');
      this.doc.head.appendChild(link);
    }
    link.id = 'seo-canonical';
    link.rel = 'canonical';
    link.href = href;
  }

  private setJsonLd(json: object | null): void {
    let script = this.doc.head.querySelector<HTMLScriptElement>('script#seo-jsonld');
    if (json === null) {
      script?.remove();
      return;
    }
    if (!script) {
      script = this.doc.createElement('script');
      script.type = 'application/ld+json';
      this.doc.head.appendChild(script);
    }
    script.id = 'seo-jsonld';
    script.textContent = JSON.stringify(json);
  }
}

function orgJsonLd(): object {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${ORIGIN}/#website`, url: `${ORIGIN}/`, name: SITE },
      {
        '@type': 'Organization',
        '@id': `${ORIGIN}/#organization`,
        url: `${ORIGIN}/`,
        name: SITE,
        // ponytail: a raster logo (Google ignores favicon.ico for the knowledge
        // panel) plus sameAs — the entity signal that wins the brand SERP.
        logo: `${ORIGIN}/icons/icon-512x512.png`,
        sameAs: ['https://github.com/deepscrape/deepscrape'],
      },
    ],
  };
}
