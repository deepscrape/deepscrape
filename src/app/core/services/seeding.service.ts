import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { catchError, map, Observable, tap, throwError } from 'rxjs';
import { CrawlOperation, CrawlPack, CrawlTask, SeederRequest, SeederResult } from '../types';
import { AuthService } from './auth.service';
import { API_BASE_URL } from '../variables';
import { CrawlAPIService } from './crawlapi.service';

@Injectable({ providedIn: 'root' })
export class SeedingService {
  private crawl4AiEndpoint: string

  constructor(private http: HttpClient, private authService: AuthService, private crawlService: CrawlAPIService) {

    // ponytail: same-origin, matching CrawlAPIService. This had the identical
    // production branch pointing at the crawl agent, so fixing only that file
    // would have left this one still sending the caller's ID token off-origin.
    this.crawl4AiEndpoint = API_BASE_URL + '/seeder'
  }
  cancelTask(taskId: string): Observable<any> {
    return this.crawlService.cancelTask(taskId)
  }

  multiSeedEnqueue(operationData: CrawlOperation, seederReq: SeederRequest): Observable<CrawlTask> {


    const crawl4AiReaderEndpoint: string = this.crawl4AiEndpoint + "/stream/job/multi-research"

    const headers = new HttpHeaders({
      'Authorization': `Bearer ${this.authService.token}`, // this is for the python fastapi server
      'Accept': 'application/json',
    })

    const body = {
      "operation_data": operationData,
      // "priority": 10,
      ...seederReq,
    }
    // console.log(crawl4AiReaderEndpoint, body)
    return this.http.post(crawl4AiReaderEndpoint, body, { headers/* , transferCache: true */ })
      .pipe(
        tap((task: any) => {
          // console.log('response data:', task)
        }),
        map((job: any) => {
          return {
            id: job.task_id,
            operationId: job.operation_id,
            ...job
          } as CrawlTask
        }),
        catchError(error => {
          console.error('Error in Seeder Enqueue API call:', error)
          return throwError(() => error)
        }))
  }

  streamTaskResults(taskId: string): Observable<any> {
    const crawl4AiEndpoint: string = this.crawl4AiEndpoint.replace('/seeder', '/job') + "/stream/" + taskId

    return this.crawlService.streamTaskResults(taskId)
  }
  /* TODO:
  *
  */

}
