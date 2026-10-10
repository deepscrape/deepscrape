/**
 * Which BFF routes have no client, and which client calls have no route.
 *
 * The skill cites `scripts/route-parity.ts` as an informational harness, and the
 * file did not exist. This is that harness, rebuilt from the two places that
 * actually hold the truth rather than from a guess about formatting:
 *
 *  - `bff/api.ts` is the ONLY served route table. Every route path is a quoted
 *    `'/api/...'` literal, but NOT always on the same line as its verb
 *    (`api.get(\n  '/api/webrain/config',\n  h(userGuard)\n)`), so a regex that
 *    anchors on `api.get('` finds a fraction of them and silently under-reports.
 *    Quoted literals are read instead.
 *  - A client service holds one root as `API_BASE_URL + '<segment>'`, where
 *    `API_BASE_URL` already ends in `/api`.
 *
 * INFORMATIONAL, NOT A GATE. Computed paths defeat a string comparison:
 * `crawlapi.service.ts` derives `/job/stream/:id` and `/job/.../cancel` by
 * `replace()`-ing its own base, so those never appear here and their absence is
 * expected rather than a finding. Read this as "these two lists disagree in ways
 * worth a human glance", never as a pass.
 *
 * Usage: `bunx tsx scripts/route-parity.ts`
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const BFF_TABLE = join(ROOT, 'bff', 'api.ts');
const CLIENT_DIR = join(ROOT, 'src', 'app', 'core', 'services');

/** The `'/api/...'` literals in a file, deduped and sorted. */
function quotedRoutes(source: string): string[] {
  const found = new Set<string>();

  for (const match of source.matchAll(/'(\/api\/[^']*)'/g)) {
    found.add(match[1]);
  }

  return [...found].sort();
}

/** Every service file, recursively, so a nested service is not missed. */
function serviceFiles(dir: string): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      out.push(...serviceFiles(full));
    } else if (entry.endsWith('.service.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }

  return out;
}

/**
 * Every place a client root is declared.
 *
 * TWO forms hold one, and reading only the first reports phantom gaps. A service
 * writes `API_BASE_URL + '/segment'`; the rest name a constant from
 * `core/variables/` that IS the path. `API_ARACHNEFLY_URL` is `/api/machines`
 * despite its name, `API_ORGANIZATIONS` is `/api/orgs`, and the four AI cores are
 * `/api/anthropic`, `/api/openai`, `/api/groq` and `/api/jina`.
 *
 * Measured both ways on 2026-10-10: reading only `API_BASE_URL` reported 29 of 56
 * routes as having no client. With the constants included, that collapses to the
 * handful listed below as genuinely client-less. So the first reading was almost
 * entirely artefacts, and a harness that cries wolf gets ignored.
 */
function clientRoots(): Map<string, string[]> {
  const bases = new Map<string, string[]>();
  const varsDir = join(CLIENT_DIR, '..', 'variables');

  const add = (route: string, file: string): void => {
    const holders = bases.get(route) ?? [];
    holders.push(file.replace(ROOT, '.').replace(/\\/g, '/'));
    bases.set(route, holders);
  };

  for (const file of serviceFiles(CLIENT_DIR)) {
    const source = readFileSync(file, 'utf8');

    for (const match of source.matchAll(/API_BASE_URL\s*\+\s*'([^']*)'/g)) {
      add(match[1] === '' ? '/api' : `/api${match[1]}`, file);
    }
  }

  for (const entry of readdirSync(varsDir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) {
      continue;
    }

    const file = join(varsDir, entry);

    for (const match of readFileSync(file, 'utf8').matchAll(/'(\/api\/[^']*)'/g)) {
      add(match[1], file);
    }
  }

  return bases;
}

const routes = quotedRoutes(readFileSync(BFF_TABLE, 'utf8'));
const clients = clientRoots();

/** A client base is served if some route equals it or extends it. */
const servedBy = (base: string): boolean =>
  routes.some(route => route === base || route.startsWith(`${base}/`));

/** A route is called if some client base is the route or a parent of it. */
const calledBy = (route: string): string | null => {
  for (const [base, files] of clients) {
    if (route === base || route.startsWith(`${base}/`)) {
      return files[0];
    }
  }

  return null;
};

console.log(`bff routes        : ${routes.length}`);
console.log(`client bases      : ${clients.size}`);
console.log('');

const orphanClients = [...clients.entries()].filter(([base]) => !servedBy(base));
console.log(`CLIENT CALLS WITH NO ROUTE (${orphanClients.length})`);

for (const [base, files] of orphanClients) {
  console.log(`  ${base}  <- ${files.join(', ')}`);
}

console.log('');
const orphanRoutes = routes.filter(route => calledBy(route) === null);
console.log(`ROUTES WITH NO CLIENT (${orphanRoutes.length})`);

for (const route of orphanRoutes) {
  console.log(`  ${route}`);
}
