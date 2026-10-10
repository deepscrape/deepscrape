import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Observable, catchError, of, throwError } from 'rxjs';
import { API_BASE_URL } from '../variables';
import { AuthService } from './auth.service';
import { WebrainScrapeEnvelope } from '../types';

/**
 * The one writer of `POST /api/scrape`.
 *
 * Why this is not `SearchService`
 * ------------------------------
 * `SearchService` owns `/api/serp`, whose reply type, echo field and argument
 * mapping are the search engine's. This route is the scraping worker's, with a
 * different worker payload (`result.text`, not a typed result list) and a
 * different required argument set. Sharing one service would mean one method
 * whose return type is a union of two unrelated envelopes.
 *
 * Why the AI pipeline and not the crawl path
 * -----------------------------------------
 * `/api/scrape` is a FREE route: it resolves `accessMode` and is behind
 * `crawl.execute`, not `paid`, so it is reachable by any authenticated caller
 * including a free plan (see the header of
 * `functions/src/handlers/webrain-tools.ts`). That is what lets the LLM step
 * read a page without spending the caller's crawl credits, and it is why the
 * fetch step here is not routed through `CrawlAPIService`, whose `/api/crawl`
 * route is a different and separately gated thing.
 *
 * Same-origin, like every other playground service: the credential must not
 * leave our origin, and the production CSP permits only our own.
 *
 * No `catchError` that swallows: the route answers 400/401/403/502 with an
 * error body, and the caller narrows on `status` so a failure cannot read as an
 * empty success. The only added behaviour is unwrapping an `HttpErrorResponse`
 * body into the same union, because a refusal and an outage both arrive as a
 * non-2xx and the template should not have to know two error shapes.
 */
@Injectable({ providedIn: 'root' })
export class AiFetchService {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly endpoint: string = API_BASE_URL + '/scrape';

  /**
   * Fetch one page's text content through the shared scraping worker.
   *
   * The body is `{ url }` and nothing else: the route accepts no other argument
   * (see `scrapeArguments`), and an argument the worker ignores is a request
   * that looks accepted and does nothing. Cookie forwarding and iframe
   * extraction, which the crawl path's own options cover, have no equivalent
   * here and are therefore NOT sent rather than sent and dropped.
   * @param {string} url The absolute http(s) target.
   * @return {Observable<WebrainScrapeEnvelope>} Either branch of the route reply.
   */
  scrape(url: string): Observable<WebrainScrapeEnvelope> {
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${this.authService.token}`,
      'Accept': 'application/json',
    });

    return this.http
      .post<WebrainScrapeEnvelope>(this.endpoint, { url }, { headers })
      .pipe(
        catchError((error: unknown) => {
          const body = error instanceof HttpErrorResponse ? error.error : undefined;

          // A non-2xx with a body that already declares itself an error reply is
          // returned as the union rather than rethrown, so one narrowing in the
          // caller covers both transports. Anything else (a network failure, a
          // body that is a string) is rethrown: inventing an envelope for it
          // would present a transport fault as the provider's answer.
          if (body && typeof body === 'object' && (body as { status?: unknown }).status === 'error') {
            return of(body as WebrainScrapeEnvelope);
          }

          return throwError(() => error);
        })
      );
  }
}
