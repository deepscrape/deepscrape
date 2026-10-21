
import { Inject, Injectable, DOCUMENT } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs/operators';

@Injectable({
  providedIn: 'root'
})
export class NgswUpdateService {

  constructor(private swUpdate: SwUpdate, @Inject(DOCUMENT) private document: Document) {
    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates
        .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
        .subscribe(() => {
          this.activateUpdate();
        });
    }
  }

   private activateUpdate() {  
    this.swUpdate.activateUpdate()
      // Activate now, reload only when nobody is looking: a reload in front of
      // the user destroys a half-typed checkout or an unsaved crawl setup, and
      // someone else's deploy must not be able to do that. Activation alone is
      // safe — the new assets are served from the next navigation onwards.
      .then(() => {
        if (this.document.visibilityState === 'hidden') {
          this.document.location.reload();
        }
      })
      .catch((error) => {  
        console.error('Failed to activate service worker update:', error);  
      });  
  }  
}
