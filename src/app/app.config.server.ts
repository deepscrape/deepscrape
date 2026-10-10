import { provideServerRendering, withRoutes } from '@angular/ssr';
import { mergeApplicationConfig, ApplicationConfig } from '@angular/core';
import { appConfig } from './app.config';
import { serverRoutes } from './app.routes.server';
const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes(serverRoutes)),
    // Server-side Auth is provided by the platform branch inside `provideAuth` in `app.config.ts`
    // — the factory that definitely runs. The equivalent override that used to sit here was
    // commented out, so it never applied, and every prerendered `/service/**` page went through
    // `getAuth()` on the server instead.
  ]
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
