#!/usr/bin/env bun
/**
 * Route-table diff: `bff/api.ts` vs the UNMOUNTED Express table.
 *
 * READ THIS BEFORE TREATING THE OUTPUT AS A PROBLEM.
 *
 * `bff/api.ts` (Bun + Elysia, Cloud Run `deepscrape-bff`) is the only served /api surface.
 * `functions/src/infrastructure/syncaiapi.ts` is a LIBRARY the BFF consumes — `bff/api.ts`
 * imports `ReverseAPIProxy` from it and binds its middleware — but its `this.router.*`
 * registrations are never mounted: `functions/src/index.ts` imports no Express app, and every
 * `firebase.json` hosting rewrite goes to Cloud Run. Verified 2026-10-01.
 *
 * Therefore a route present in one table and absent from the other CANNOT 404 anywhere. This
 * compares a live table against a dead one. It is an inventory aid, not a safety gate — an
 * earlier version of this header claimed the opposite, and that claim was wrong.
 *
 * Run from the repository root:
 *   bun .github/skills/browser-platform-skill/scripts/route-parity.ts
 *
 * Exit 0 on success; 2 when a source file could not be read (wrong working directory).
 * Drift is reported, never failed on.
 *
 * Paths are normalised before comparison because the two tables differ in two ways: the BFF
 * prefixes `/api`, and route parameter names differ (`:id` vs `:machineId`). Both are collapsed.
 */

import { readFileSync } from "node:fs";

const BFF = "bff/api.ts";
const TWIN = "functions/src/infrastructure/syncaiapi.ts";

/** Matches a route registration receiver + method, e.g. `api.get(`, `this.router.post(`. */
const CALL =
  /(?:^|[^\w.$])(?:api|router|this\.router|app)\.(get|post|put|patch|delete)\s*\(/g;

type Route = { method: string; path: string; line: number };

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

/** Strip the `/api` prefix and collapse parameter names so the two tables are comparable. */
function normalize(raw: string): string {
  const stripped = raw.replace(/\/+$/, "").replace(/^\/api(?=\/|$)/, "");
  const collapsed = stripped.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":");
  return collapsed === "" ? "/" : collapsed;
}

function collect(file: string): Route[] {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    console.error(`cannot read ${file} — run this from the repository root`);
    process.exit(2);
  }

  const seen = new Map<string, Route>();
  for (const match of src.matchAll(CALL)) {
    const at = match.index!;
    // Skip commented-out registrations — they are not routes. Both files carry commented
    // twins of live routes, which otherwise show up as phantom drift.
    const lineStart = src.lastIndexOf("\n", at) + 1;
    if (src.slice(lineStart, at).includes("//")) continue;

    const afterCall = at + match[0].length;
    // The BFF writes the path on the following line, so scan a window for the first
    // quote-delimited string that starts with a slash.
    const literal = src
      .slice(afterCall, afterCall + 400)
      .match(/["'`](\/[^"'`\n]*)["'`]/);
    if (!literal) continue;

    const route: Route = {
      method: match[1].toUpperCase(),
      path: normalize(literal[1]),
      line: src.slice(0, at).split("\n").length,
    };
    if (!seen.has(key(route))) seen.set(key(route), route);
  }
  return [...seen.values()];
}

const bff = collect(BFF);
const twin = collect(TWIN);

const twinKeys = new Set(twin.map(key));
const bffKeys = new Set(bff.map(key));

const missing = bff.filter((r) => !twinKeys.has(key(r)));
const twinOnly = twin.filter((r) => !bffKeys.has(key(r)));

console.log(`bff/api.ts            ${bff.length} routes  (served)`);
console.log(`syncaiapi.ts          ${twin.length} routes  (NOT mounted — read the header)`);
console.log("(counts are regex-derived and approximate; the diff below is informational)");

if (missing.length) {
  console.log(
    `\nIN THE BFF, NOT IN THE UNMOUNTED TABLE (${missing.length}) — informational. Nothing\n` +
      `serves the Express table, so these cannot 404 anywhere:`,
  );
  for (const r of missing) {
    console.log(`  ${key(r).padEnd(54)} ${BFF}:${r.line}`);
  }
}

if (twinOnly.length) {
  console.log(
    `\nIN THE UNMOUNTED TABLE ONLY (${twinOnly.length}) — dead registrations, or aliases:`,
  );
  for (const r of twinOnly) {
    console.log(`  ${key(r).padEnd(54)} ${TWIN}:${r.line}`);
  }
}

if (!missing.length) {
  console.log("\nOK — the two tables agree (which still proves nothing: one of them is dead).");
}

// Always 0. Drift between these two tables cannot 404 anywhere, because the Express table is never
// mounted. Exiting 1 would train the next reader to "fix" drift by editing dead code.
process.exit(0);
