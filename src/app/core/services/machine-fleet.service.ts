import { Injectable, inject } from '@angular/core'
import { HttpClient, HttpHeaders } from '@angular/common/http'
import { Observable } from 'rxjs'
import { API_BASE_URL } from '../variables'
import { AuthService } from './auth.service'
import { MachineFleetResponse } from '../types/machine-fleet.interface'

/**
 * The one reader of `/api/admin/machines`.
 *
 * Same-origin, like every other `/api` service: `API_BASE_URL` is the relative
 * `/api`, so the request lands on Hosting and the BFF. The client never addresses
 * arachnefly directly, even though arachnefly is what creates these machines.
 *
 * Read-only, and the class is the reason: there is no `start`, `suspend`, `stop`
 * or `destroy` here, and adding one would be wrong rather than merely missing.
 * Those actions live on the tenant routes (`DeploymentService`), because
 * arachnefly's ownership middleware admits only the machine's owner and has no
 * admin bypass. A platform admin can SEE another tenant's machine and cannot act
 * on it. An admin action would have to forward that tenant's uid, which is an
 * authorization change in a service carrying live traffic, so it is not something
 * to add quietly underneath a UI table. Roadmap `05` Part D carries the two
 * options and their costs.
 *
 * Every method returns its `Observable` untouched. The service does not retry and
 * does not translate errors, for the same reason `BrowserSessionService` does not:
 * the status is the meaning -- 403 is a permission boundary, 401 means the token
 * is gone, 500 means the fleet could not be read at all -- and a blanket catch
 * here would flatten three different remedies into one message.
 */
@Injectable({ providedIn: 'root' })
export class MachineFleetService {
  private readonly http = inject(HttpClient)
  private readonly authService = inject(AuthService)
  private readonly base: string = API_BASE_URL + '/admin/machines'

  /**
   * Every machine in the platform, newest first.
   *
   * The token is read at CALL time rather than captured into headers built in the
   * constructor, so a refreshed ID token is used on the next call without
   * rebuilding the service.
   * @return {Observable<MachineFleetResponse>} The fleet, and whether it is capped.
   */
  list(): Observable<MachineFleetResponse> {
    return this.http.get<MachineFleetResponse>(this.base, {
      headers: this.headers(),
    })
  }

  private headers(): HttpHeaders {
    return new HttpHeaders({
      Authorization: `Bearer ${this.authService.token}`,
    })
  }
}
