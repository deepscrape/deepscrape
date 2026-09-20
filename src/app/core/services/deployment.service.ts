import { inject, Injectable } from '@angular/core';
import { AnalyticsService } from './analytics.service';
import { AuthService } from './auth.service';
import { HttpClient, HttpParams } from '@angular/common/http';
import { API_ARACHNEFLY_UPLOAD_URL, API_ARACHNEFLY_URL } from '../variables';
import { catchError } from 'rxjs/internal/operators/catchError';
import { tap } from 'rxjs/internal/operators/tap';
import { DockerImageInfo, FlyMachine, MachineResponse } from '../types';
import { Observable } from 'rxjs/internal/Observable';
import { handleError } from '../functions';
import { map } from 'rxjs/internal/operators/map';

@Injectable({
  providedIn: 'root'
})
export class DeploymentService {

  private readonly analyticsService = inject(AnalyticsService)

  constructor(private http: HttpClient, private authService: AuthService) { }


  /**
   * The function `checkImageDeployability` sends a request to an API endpoint to check the
   * deployability of a Docker image and returns an Observable with the response.
   * @param {string} imageName - The `imageName` parameter is a string that represents the name of the
   * Docker image that you want to check for deployability. This function `checkImageDeployability`
   * sends a request to an API endpoint with the provided image name to determine if the image exists
   * and retrieve additional information about it.
   * @returns The `checkImageDeployability` function returns an Observable that emits an object with
   * two properties: `exists` of type boolean and `info` of type `DockerImageInfo`. The Observable
   * makes an HTTP GET request to a specified API endpoint to check the deployability of a given image
   * name. The response from the API call is logged to the console if successful, and any errors
   * encountered during the
   */
  checkImageDeployability(imageName: string): Observable<{ exists: boolean; info: DockerImageInfo }> {
    const url = `${API_ARACHNEFLY_URL}/check-image` // Replace with your API endpoint
    const headers = {
      // 'api-key': `Bearer ${this.authService.token}`, // this is for the ssr express server `,
      'Authorization': `Bearer ${this.authService.token}`, // this is for the python fastapi server
    }
    const params = new HttpParams().set('name', imageName)

    return this.http.get<{ exists: boolean; info: DockerImageInfo }>(url, { headers, params }).pipe(
      tap((response: any) => {
        console.log('Image deployability check successful:', response)
      }),
      map((response: any) => response.data),
      catchError(handleError)
    )
  }

  getMachine(machineId: string): Observable<MachineResponse> {

    // set api url
    const url = `${API_ARACHNEFLY_URL}/machine/${machineId}` // Replace with your API endpoint
    
    // set headers
    const headers = {
      'Authorization': `Bearer ${this.authService.token}`,
      'Content-Type': 'application/json',
      // 'Content-Type': 'multipart/form-data' // Let the browser set it
    }

    // make the http request
    return this.http.get(url, { headers }).pipe(
      tap((response: any) => {
        console.log('Get Machine successful:', response)
      }),
      map((response: any) => response?.data),
      catchError(error => {
        console.error('Error in Get Machine API call:', error)
        throw error
      })
    );
  }


  /**
   * The function `createMachine` sends a POST request to an API endpoint with deployment data, setting
   * headers and parameters, and handling the response and errors.
   * @param {FormData} deploymentData - The `deploymentData` parameter in the `createMachine` function
   * is of type `FormData`, which is typically used to send data in key-value pairs via HTTP requests.
   * In this context, it likely contains the data needed for deploying a machine or making a
   * deployment-related API call. The function sets headers
   * @returns The `createMachine` function is returning an Observable from an HTTP POST request to the
   * specified API endpoint (`API_ARACHNEFLY_URL/deploy`). The function sets headers with an
   * authorization token, sets parameters including the region and clone values, and then makes the
   * POST request with the deployment data, headers, and parameters.
   */
  createMachine(deploymentData: any): Observable<MachineResponse> {

    // set headers
    const headers = {
      'Authorization': `Bearer ${this.authService.token}`,
      'Content-Type': 'application/json',
      // 'Content-Type': 'multipart/form-data' // Let the browser set it
    }
    const region: string = deploymentData['region'] as string

    // set params
    const params: HttpParams = new HttpParams()
    .set('region', region)
    .set('clone', 'false')

    const url = `${API_ARACHNEFLY_URL}/deploy` // Replace with your API endpoint

    return this.http.post(url, deploymentData, { headers, params }).pipe(
      tap((response: any) => {
      console.log('Deployment successful:', response)
      // The deploy call came back, so a machine was requested for this account.
      this.analyticsService.trackEvent('machine_deployed', { region }).subscribe({ error: () => undefined })
      }),
      map((response: any) => response?.data),
      catchError(error => {
      console.error('Error in Deployment API call:', error)
      throw error
      })
    );
  }

  startMachine(machineId: string): Observable<any> {
    // set headers
    const headers = {
      'Authorization': `Bearer ${this.authService.token}`
    }
    const url = `${API_ARACHNEFLY_URL}/machine/${machineId}/start`  // Replace with your API endpoint

    return this.http.put(url, {}, { headers }).pipe(
      tap((response: any) => {
        console.log('Machine started:', response)
      }),
      map((response: any) => response.data),
      catchError(error => {
        console.error('Error in Machine Start API call:', error)
        throw error
      })
    );
  }

  suspendMachine(machineId: string): Observable<any> {
    // set headers
    const headers = {
      'Authorization': `Bearer ${this.authService.token}`
    }
    const url = `${API_ARACHNEFLY_URL}/machine/${machineId}/suspend`  // Replace with your API endpoint

    return this.http.put(url, {}, { headers }).pipe(
      tap((response: any) => {
        console.log('Machine suspended:', response)
      }),
      map((response: any) => response.data),
      catchError(error => {
        console.error('Error in Machine Suspend API call:', error)
        throw error
      })
    );
  }

  stopMachine(machineId: string): Observable<any> {
    // set headers
    const headers = {
      'Authorization': `Bearer ${this.authService.token}`
    }
    const url = `${API_ARACHNEFLY_URL}/machine/${machineId}/stop`  // Replace with your API endpoint

    return this.http.put(url, {}, { headers }).pipe(
      tap((response: any) => {
        console.log('Machine stopped:', response)
        this.analyticsService.trackEvent('machine_stopped', { machineId }).subscribe({ error: () => undefined })
      }),
      map((response: any) => response.data),
      catchError(error => {
        console.error('Error in Machine Stop API call:', error)
        throw error
      })
    );
  }

  waitforState(machineId: string, instance_id: string, state: string, timeout?: number): Observable<any> {
    // set headers
    const headers = {
      'Authorization': `Bearer ${this.authService.token}`
    }
    const url = `${API_ARACHNEFLY_URL}/machine/waitforstate/${machineId}`  // Replace with your API endpoint

    // set params
    const params = new HttpParams()
      .set('state', state)
      .set('timeout', timeout?.toString() || '')
      .set('instance_id', instance_id)

    return this.http.get(url, { headers, params }).pipe(
      tap((response: any) => {
        console.log('waitfor machine State:', response)
      }),
      catchError(error => {
        console.error('Error WaitForState API call:', error)
        throw error
      })
    );

  }

  /* private saveMachineData(machineDetails: any, machineSchema: any, machineId: string) {
    const machineData = {
      id: machineDetails.id,
      name: machineDetails.name,
      state: machineDetails.state,
      region: machineDetails.region,
      instance_id: machineDetails.instance_id,
      private_ip: machineDetails.private_ip,
      created_at: machineDetails.created_at,
      updated_at: machineDetails.updated_at,
      host_status: machineDetails.host_status,
      config: machineDetails.config,
      image_ref: machineDetails.image_ref,
      events: machineDetails.events,
    };

    this.firestore.collection('machines').doc(machineId).set(machineData)
      .then(() => console.log('Machine data saved to Firebase'))
      .catch(error => console.error('Error saving machine data to Firebase:', error));

    // Create stats metrics collection
    const statsMetrics = {
      cpu: machineDetails.config.guest.cpus,
      memory: machineDetails.config.guest.memory_mb,
      image: machineDetails.config.image,
      region: machineDetails.region,
      createdAt: machineDetails.created_at,
      schemaVersion: machineSchema.schema.type,
    };

    this.firestore.collection('statsMetrics').doc(machineId).set(statsMetrics)
      .then(() => console.log('Stats metrics saved to Firebase'))
      .catch(error => console.error('Error saving stats metrics to Firebase:', error));
  } */

  destroy(machineId: string, force: boolean = false): Observable<any> {
    const url = `${API_ARACHNEFLY_URL}/machine/${machineId}`; // Replace with your API endpoint
    const headers = {
      'Authorization': `Bearer ${this.authService.token}`
    }

    const params = new HttpParams().set('force', force.toString())

    return this.http.delete(url, { headers, params }).pipe(
      tap((response: any) => {
        console.log('Machine destroyed successful:', response);
      }),
      map((response: any) => response.data),
      catchError(error => {
        console.error('Error on Machine destruction API call:', error);
        throw error;
      })
    );
  }
}
