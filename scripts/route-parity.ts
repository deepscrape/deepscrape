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
 * THREE lists, and the third is the one that finds live defects
 * ------------------------------------------------------------
 * The first two compare BASES, and a base counts as served when any route extends
 * it -- so `/api/pricing` passes on `/api/pricing/rates` alone. Two methods
 * (`/api/vision`, `/api/pricing/estimate`) shipped as 404s under a base that was
 * perfectly served, and neither showed up here, because a base-level comparison
 * cannot see the difference. The third list enumerates the method paths the client
 * actually builds and is what caught them.
 *
 * INFORMATIONAL, NOT A GATE. Computed paths defeat a string comparison:
 * `crawlapi.service.ts` derives `/job/stream/:id` and `/job/.../cancel` by
 * `replace()`-ing its own base, and `browser-session.service.ts` appends
 * `/close` to a helper that already carries an id, so those never appear here and
 * their absence is expected rather than a finding. Read this as "these lists
 * disagree in ways worth a human glance", never as a pass -- and note the printed
 * denominator, because a detector that enumerates nothing also reports zero.
 *
 * Usage: `bunx tsx scripts/route-parity.ts`
 *        `PARITY_LIST=1 bunx tsx scripts/route-parity.ts`  (dump every path checked)
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

/**
 * Every STATIC method path a service builds.
 *
 * Why this exists on top of the base check
 * ----------------------------------------
 * A base is "served" if ANY route extends it, so `/api/pricing` passes on the
 * strength of `/api/pricing/rates` while `/api/pricing/estimate` has no route at
 * all. That is not hypothetical: `/api/vision` and `/api/pricing/estimate` both
 * shipped as methods that 404, and each stayed invisible because its consumer
 * swallows the failure (the vision tab looked empty; the crawl price line simply
 * never appeared). A base-level comparison structurally cannot see either one.
 *
 * Only the two spellings that concatenate onto the base FIELD are read -- the
 * field is what carries the base, so joining to it is the one form where the
 * result is knowable without running the code.
 *
 * What this still cannot see, stated so the next reader does not over-trust it: a
 * path built from a helper that already carries an id (`sessionUrl(id) + '/close'`)
 * has a result that depends on the id, and enumerating it would report routes that
 * do not exist as missing. Dynamic tails are skipped, and that remains a blind
 * spot.
 * @return {Array<[string, string]>} `[path, declaringFile]`, sorted.
 */
function clientMethodPaths(): Array<[string, string]> {
  const found = new Map<string, string>();

  for (const file of serviceFiles(CLIENT_DIR)) {
    // Collapsed so a call broken across lines reads as one string.
    const source = readFileSync(file, 'utf8').replace(/\s+/g, ' ');
    const where = file.replace(ROOT, '.').replace(/\\/g, '/');

    // TWO declarations hold a base: a field with an annotation, and a plain
    // assignment in a constructor. Reading only the first misses
    // `crawlapi.service.ts` and `seeding.service.ts`, which is how a service ends
    // up with no coverage while the harness reports nothing.
    const declares = [
      /(?:readonly|private|protected|public)\s+(\w+)\s*:\s*string\s*=\s*[^;]*?API_BASE_URL\s*\+\s*'([^']*)'/g,
      /this\.(\w+)\s*=\s*[^;]*?API_BASE_URL\s*\+\s*'([^']*)'/g,
    ];

    for (const declaresForm of declares) {
      for (const declare of source.matchAll(declaresForm)) {
        const field = declare[1];
        const segment = declare[2];
        const base = segment === '' ? '/api' : `/api${segment}`;

        const forms = [
          new RegExp(`this\\.${field}\\s*\\+\\s*'([^']*)'`, 'g'),
          new RegExp(`this\\.${field}\\}([^\`]*)`, 'g'),
        ];

        for (const form of forms) {
          for (const join of source.matchAll(form)) {
            const tail = join[1] ?? '';

            // A dynamic tail (`/${id}`), a bare root, or no tail at all is not a
            // path this can name.
            if (!/^\/[A-Za-z0-9\-_/.%]+$/.test(tail) || tail === '/') {
              continue;
            }

            const methodPath = base + tail;
            if (!found.has(methodPath)) {
              found.set(methodPath, where);
            }
          }
        }
      }
    }

    // The parameterised form, which no join-on-the-field rule can see:
    // `webrain-tools.service.ts` builds every path as `API_BASE_URL + path` inside
    // one private helper, so `/api/vision` was a literal in a CALL SITE rather
    // than a concatenation. That is the exact instance this harness missed twice.
    // Only files with such a helper are read this way, so a stray `.post('/x')`
    // elsewhere cannot produce a hit.
    const takesAPath = /API_BASE_URL\s*\+\s*(?!'|\`)(\w+)/.test(source);

    if (takesAPath) {
      const base = clientBaseFor(source);

      for (const call of source.matchAll(
        /\.(?:get|post|put|delete)\s*(?:<[^>]*>)?\s*\(\s*'(\/[^']*)'/g
      )) {
        const methodPath = base + call[1];
        if (!found.has(methodPath)) {
          found.set(methodPath, `${where} (path passed as an argument)`);
        }
      }
    }
  }

  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** The single client base a service declares, or `/api` when it declares none. */
function clientBaseFor(source: string): string {
  const match = source.match(
    /(?:API_BASE_URL\s*\+\s*'([^']*)'|this\.\w+\s*=\s*[^;]*?API_BASE_URL\s*\+\s*'([^']*)')/
  );
  const segment = match?.[1] ?? match?.[2] ?? '';
  return segment === '' ? '/api' : `/api${segment}`;
}

/**
 * The STATIC part of a path that follows a DYNAMIC segment.
 *
 * This is the blind spot the header above calls out, and it is the one that cost
 * three live 404s. `browser-session.service.ts` builds `/frame` as
 * `base + '/' + encodeURIComponent(id) + '/frame?n=' + nonce`: the id is
 * unknowable statically, so the rule above skips it — but `/frame` is a literal,
 * and whether a route ends in it is decidable without running anything. Nothing
 * checked that, so `GET /api/browser/session/:id/frame` was never registered and
 * every poll 404'd while the transport, the client and 11 specs passed.
 *
 * Two shapes carry it, and both are read:
 *  - concat after a non-literal operand: `encodeURIComponent(id) + '/frame'`
 *  - template tail after an interpolation: `` `${id}/frame` ``
 *
 * A suffix that contains `:` or `${` is skipped: that is a whole path with its
 * own parameter names, and comparing parameter names across two files reports
 * differences in spelling rather than in routes.
 * @return {Array<[string, string]>} `[suffix, declaringFile]`, deduped and sorted.
 */
function dynamicSuffixes(): Array<[string, string]> {
  const found = new Map<string, string>();

  const keep = (raw: string, where: string): void => {
    const path = raw.split('?')[0];

    if (path.length < 2 || !path.startsWith('/') || path.includes(':') || path.includes('${')) {
      return;
    }

    if (!found.has(path)) {
      found.set(path, where);
    }
  };

  for (const file of serviceFiles(CLIENT_DIR)) {
    const source = readFileSync(file, 'utf8').replace(/\s+/g, ' ');
    const where = file.replace(ROOT, '.').replace(/\\/g, '/');

    // `) + '/frame'` / `} + '/frame'` — a literal joined to a computed operand.
    for (const match of source.matchAll(/[)\]}]\s*\+\s*'([^']*)'/g)) {
      keep(match[1], where);
    }

    // `` `${id}/frame` `` — everything after the last interpolation.
    for (const match of source.matchAll(/`[^`]*\$\{[^}]*\}([^`]*)`/g)) {
      keep(match[1], where);
    }
  }

  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Whether some route ends with this suffix, comparing SEGMENTS.
 *
 * Segment-wise rather than `endsWith`, so a route parameter matches a concrete
 * suffix: `/frame` is served by `/api/browser/session/:id/frame`. A plain string
 * comparison would also have to spell the parameter's name the same way, which is
 * a difference between two files, not a difference in routes.
 * @param {string} suffix The static tail the client appends.
 * @param {string[]} routes The served route table.
 * @return {boolean} True when a route ends in it.
 */
function suffixServed(suffix: string, routes: readonly string[]): boolean {
  const segments = (path: string): string[] => path.split('/').filter(Boolean);
  const want = segments(suffix);

  return routes.some(route => {
    const have = segments(route);

    return (
      have.length >= want.length &&
      have.slice(have.length - want.length).every(
        (segment, index) => segment === want[index] || segment.startsWith(':')
      )
    );
  });
}

/**
 * Route literals across EVERY BFF module, not just the served table.
 *
 * The suffix check asks a tail question, so it must see every module that
 * registers a path. `bff/api.ts` is one; `bff/oauth.ts` is another and is mounted
 * elsewhere. Reading only `api.ts` reported the five `/oauth/phone/*` and
 * `/oauth/email/*` literals as unrouted when every one IS served -- the harness
 * crying wolf, which this file's own header warns is how a harness loses its
 * audience and gets ignored.
 *
 * The mount prefix is deliberately not reconstructed. The comparison is
 * segment-wise on the tail, so `/oauth/email/verification` answers for
 * `/email/verification` without knowing what it is mounted under.
 * @return {string[]} Path literals from every non-spec module under `bff/`.
 */
function bffRouteLiterals(): string[] {
  const found = new Set<string>();
  const dir = join(ROOT, 'bff');

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) {
      continue;
    }

    const source = readFileSync(join(dir, entry), 'utf8');

    for (const match of source.matchAll(/'(\/[A-Za-z][A-Za-z0-9\-_/.:]*)'/g)) {
      found.add(match[1]);
    }
  }

  return [...found];
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
const methodPaths = clientMethodPaths();

// Two sources, because one of them is blind to a whole service. `calledBy` reads
// BASES, and a service that builds its paths as `API_BASE_URL + <parameter>`
// declares none -- so `/api/vision`, `/api/search`, `/api/extract` and `/api/pdf`
// were reported as client-less while the app called every one of them. The only
// thing that makes that service visible is the method path, which is exact.
//
// Registering `/api` as a base instead would have been worse than the false alarm:
// every `/api/*` route would then match it, and the list would report zero
// forever. A silent empty list is the one failure this harness must not have.
const orphanRoutes = routes.filter(
  route =>
    calledBy(route) === null &&
    !methodPaths.some(
      ([methodPath]) => route === methodPath || route.startsWith(`${methodPath}/`)
    )
);
console.log(`ROUTES WITH NO CLIENT (${orphanRoutes.length})`);

for (const route of orphanRoutes) {
  console.log(`  ${route}`);
}

// The check the base comparison cannot make. A method path the client builds is
// served if a route IS it, or if a route lives under it (a dynamic last segment
// the client spells out is a different shape, not a missing route).
console.log('');
const orphanMethods = methodPaths.filter(
  ([methodPath]) =>
    !routes.some(
      route =>
        route === methodPath || route.startsWith(`${methodPath}/`)
    )
);

// The DENOMINATOR is printed on purpose. A detector that enumerates nothing
// reports zero gaps and looks identical to a clean tree, so "0" alone is not
// evidence of anything.
console.log(
  `CLIENT METHODS WITH NO ROUTE (${orphanMethods.length} of ${methodPaths.length} checked)`
);

for (const [methodPath, where] of orphanMethods) {
  console.log(`  ${methodPath}  <- ${where}`);
}

// The check the three above cannot make, and the one that would have caught the
// frame route. A suffix appended after a dynamic segment is a literal, so whether
// a route ends in it is decidable without running anything -- and nothing decided
// it until now.
console.log('');
const suffixes = dynamicSuffixes();
// `routes` is the served table the three advisory lists above read. The gate below
// reads EVERY module instead, because a suffix is served by any router, not only
// by the one `api.ts` registers.
const allRouteLiterals = bffRouteLiterals();
const orphanSuffixes = suffixes.filter(
  ([suffix]) => !suffixServed(suffix, allRouteLiterals)
);

console.log(
  `DYNAMIC SUFFIXES WITH NO ROUTE (${orphanSuffixes.length} of ${suffixes.length} checked)`
);

for (const [suffix, where] of orphanSuffixes) {
  console.log(`  ${suffix}  <- ${where}`);
}

// TWO client-side lists are GATES: a client method path with no route, and a
// suffix appended to a dynamic segment with no route, are both requests that WILL
// 404 — the defect this file exists to prevent. The frame route shipped dead this
// way while every other check was green.
//
// `orphanMethods` joined the gate on 2026-10-20. It was advisory on the argument
// that a false alarm trains the next reader to ignore a real one, but the
// measurement contradicts that: it reports 0 of 27 today, so it can only fire on a
// genuine regression — and "the docstring's own examples land in orphanMethods"
// was the audit's point.
//
// `ROUTES WITH NO CLIENT` stays ADVISORY and must: 6 routes are legitimately
// client-less (webrain callbacks, paths the client computes), so gating it would
// fail every build for a state that is correct.
if (orphanSuffixes.length > 0 || orphanMethods.length > 0) {
  process.exitCode = 1;
}

if (process.env['PARITY_LIST']) {
  console.log('');
  console.log(`EVERY CLIENT METHOD PATH CHECKED (${methodPaths.length})`);

  for (const [methodPath, where] of methodPaths) {
    console.log(`  ${methodPath}  <- ${where}`);
  }
}
