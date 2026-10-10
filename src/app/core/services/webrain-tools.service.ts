import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_BASE_URL } from '../variables';
import { AuthService } from './auth.service';
import { ToolEnvelope, ToolRequestBody, SchemaCompileResult } from '../types';

/**
 * The one writer of `POST /api/search`, `POST /api/extract`, `POST /api/pdf`
 * and `POST /api/vision`.
 *
 * Why one service for four routes
 * -------------------------------
 * The repository convention is one writer per route, and this keeps it: it is
 * one writer for these three, because they are one thing. All three are the
 * same `runRoute` tail behind the same guard (`access` plus `crawl.execute`),
 * carrying the same envelope back -- see `webrain-tools.interface.ts`. Three
 * files would be three copies of one `post` and three docstrings explaining a
 * distinction that does not exist.
 *
 * Why it is not `SearchService` or `AiFetchService`
 * -----------------------------------------------
 * `SearchService` owns `/api/serp` and `AiFetchService` owns `/api/scrape`.
 * Those routes take different arguments and answer different payloads; folding
 * these in would make each of them two things.
 *
 * Same-origin, like every other playground service: `API_BASE_URL` is the
 * relative `/api`, so the request lands on Hosting and the BFF, and the caller's
 * ID token never leaves our origin.
 *
 * The token is read from `AuthService.token` at call time rather than captured
 * in a header built in the constructor, so a refreshed token is used on the next
 * call without rebuilding the service.
 */
@Injectable({ providedIn: 'root' })
export class WebrainToolsService {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);

  /** `webrain_search` -- one engine's results page. */
  search(body: ToolRequestBody): Observable<ToolEnvelope> {
    return this.post('/search', body);
  }

  /**
   * `webrain_extract` -- structured data from the page the worker is on.
   *
   * Note what this route cannot take: `url`. The worker's tool reads the current
   * page of a browser session, so on the shared pool it answers
   * `502 -- Needs a private worker`. That is the route's real behaviour rather
   * than a bug in this call, and the panel states it.
   */
  extract(body: ToolRequestBody): Observable<ToolEnvelope> {
    return this.post('/extract', body);
  }

  /** `webrain_pdf` -- PDF work on a file the worker can reach. */
  pdf(body: ToolRequestBody): Observable<ToolEnvelope> {
    return this.post('/pdf', body);
  }

  /**
   * `webrain_vision` -- local vision over screenshot pixels.
   *
   * The only PAID route here, and the guard differs for a STATE reason rather
   * than a secrecy one: `op=ask` never leaves the worker, but `op=index` holds a
   * named tile index on the worker BETWEEN calls, which a shared pool cannot
   * attribute to one caller. So a free caller gets a 402 before the tool
   * allowlist is consulted.
   *
   * `op=ask` is the visual-QA path and runs on the worker's bundled model, so it
   * takes no cloud key. Like `extract`, it reads the CURRENT page, so on the
   * shared pool it answers `502 -- Needs a private worker`.
   */
  vision(body: ToolRequestBody): Observable<ToolEnvelope> {
    return this.post('/vision', body);
  }

  /**
   * `POST /api/extract/schema` — compile a sentence into a reusable schema.
   *
   * The one writer here whose reply is NOT a `ToolEnvelope`: the handler answers
   * this gateway's own contract (a schema it has already proved yields rows, see
   * `SchemaCompileResult`), so it gets its own type rather than being squeezed
   * into a shape that does not describe it.
   *
   * `model` is required by the route: a model id is a value neither the gateway
   * nor the worker may invent, so it is the caller's to name.
   * @param {ToolRequestBody} body `url`, `intent` and `model`.
   * @return {Observable<SchemaCompileResult>} The schema, or why not.
   */
  compileSchema(body: ToolRequestBody): Observable<SchemaCompileResult> {
    return this.post<SchemaCompileResult>('/extract/schema', body);
  }

  /**
   * One POST, with the headers every route here carries.
   *
   * `Accept: application/json` is explicit for the same reason `MonitorService`
   * gives: the BFF streams on other routes and the bridge decides to stream from
   * what the client asked for.
   * @param {string} path The route path, leading slash included.
   * @param {ToolRequestBody} body The mapped arguments.
   * @return {Observable<T>} The route's reply, typed by the caller.
   */
  private post<T = ToolEnvelope>(path: string, body: ToolRequestBody): Observable<T> {
    return this.http.post<T>(API_BASE_URL + path, body, {
      headers: new HttpHeaders({
        'Authorization': `Bearer ${this.authService.token}`,
        'Accept': 'application/json',
      }),
    });
  }
}
