import { AngularAppEngine, createRequestHandler } from '@angular/ssr';

// The request handler Angular's dev server looks for. Its absence is what prints
// "The 'reqHandler' export in 'server.ts' is either undefined ... Using the internal SSR
// middleware instead" on every `ng serve`. Production never runs this file: the BFF serves
// the CSR shell from `index.csr.html`, and prerendering uses `main.server.ts`.
const angularApp = new AngularAppEngine();

export const reqHandler = createRequestHandler((request) => angularApp.handle(request));
