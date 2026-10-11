/**
 * Every `| translate` key that does not exist, and every key a locale is missing.
 *
 * Why this exists
 * ---------------
 * `docs/roadmap/12` §3.4: "No gate validates i18n JSON. 5 locales; a missing key
 * fails at runtime, in whichever language the user happens to be using." Nothing in
 * the toolchain notices -- `tsc` does not read templates, Karma compiles only what a
 * spec imports, and `bun run build` bundles the catalogue without checking that a
 * referenced key is in it. So a typo'd key ships, and the user reads
 * `VAULT.NOTHING_TO_KEEP` instead of a sentence.
 *
 * That is the same species as a client method with no route: something declared and
 * never wired, invisible to every gate.
 *
 * WHY THIS ONE CAN BE A GATE, when `route-parity.ts` cannot
 * --------------------------------------------------------
 * A literal key either exists in the catalogue or it does not, with no computed
 * paths and no shapes to guess at. The two blind spots are stated rather than
 * papered over:
 *
 *  - A key built at runtime (`'MODE.' + mode | translate`) is not seen. This is the
 *    main reason the unused-key count below is printed and not acted on: an
 *    unreferenced key may be perfectly live.
 *  - A key reached through another component's `@Input` is not seen either, so
 *    "unused" is never evidence of dead copy.
 *
 * Usage: `bunx tsx scripts/i18n-keys.ts`
 * Exits 1 when a referenced key is missing from the default locale, because that is
 * a user-visible defect with no false positives. Locale drift is listed and does not
 * fail the run: it degrades to the default language rather than to a raw key.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const APP_DIR = join(ROOT, 'src', 'app');
const I18N_DIR = join(ROOT, 'src', 'assets', 'i18n');
const DEFAULT_LOCALE = 'en';

/** Every file under a directory, recursively, by extension. */
function filesUnder(dir: string, extensions: string[]): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      out.push(...filesUnder(full, extensions));
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }

  return out;
}

/** A catalogue flattened to dotted keys, so `VAULT.TITLE` is a member. */
function catalogueOf(locale: string): Set<string> {
  const parsed = JSON.parse(
    readFileSync(join(I18N_DIR, `${locale}.json`), 'utf8')
  ) as Record<string, unknown>;
  const keys = new Set<string>();

  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, path);
      } else {
        keys.add(path);
      }
    }
  };

  walk(parsed, '');
  return keys;
}

/**
 * A key-shaped string literal, and a key PREFIX, told apart by what follows.
 *
 * Deliberately loose, and the looseness is load-bearing: an earlier version anchored
 * on `'KEY' | translate` and MISSED six keys in one file, because this repo also
 * writes
 *
 *     {{ (busy() ? 'AI_KEYS.SAVING' : 'AI_KEYS.SAVE') | translate }}
 *
 * where the literal is not adjacent to the pipe. The same shape appears in key maps
 * (`labelKey: 'AI_KEYS.TITLE'`), which are references too. So any
 * `UPPER.SNAKE.CASE` literal counts.
 *
 * A literal followed by `+` is NOT a key, it is the head of one:
 * `'BROWSER_SESSION.MODE_' + mode`. Those are collected separately and checked by
 * prefix, because "the whole namespace this file builds keys from does not exist" is
 * the same defect one level up.
 */
const KEY_LITERAL = /'([A-Z][A-Z0-9_]*(?:\.[A-Z0-9_]+)+)'(\s*\+)?/g;

/**
 * Every key referenced under `src/app`, with the files that reference it, plus every
 * key PREFIX those files build keys from.
 * @return {{keys: Map<string, string[]>, prefixes: Map<string, string[]>}} Both sets.
 */
function scanReferences(): {
  keys: Map<string, string[]>;
  prefixes: Map<string, string[]>;
} {
  const keys = new Map<string, string[]>();
  const prefixes = new Map<string, string[]>();

  const record = (into: Map<string, string[]>, key: string, where: string) => {
    const holders = into.get(key) ?? [];
    if (!holders.includes(where)) {
      holders.push(where);
    }
    into.set(key, holders);
  };

  for (const file of filesUnder(APP_DIR, ['.html', '.ts'])) {
    // A spec asserting on a key is a reference to the same catalogue entry, so
    // specs are read too; excluding them would report a key that only a test
    // names as unused.
    const source = readFileSync(file, 'utf8');
    const where = file.replace(ROOT, '.').replace(/\\/g, '/');

    for (const match of source.matchAll(KEY_LITERAL)) {
      record(match[2] ? prefixes : keys, match[1], where);
    }
  }

  return {keys, prefixes};
}

const locales = readdirSync(I18N_DIR)
  .filter((entry) => entry.endsWith('.json'))
  .map((entry) => entry.replace('.json', ''))
  .sort();

const defaultKeys = catalogueOf(DEFAULT_LOCALE);
const {keys: referenced, prefixes} = scanReferences();

console.log(`locales           : ${locales.join(', ')}`);
console.log(`${DEFAULT_LOCALE} keys         : ${defaultKeys.size}`);
console.log(`referenced keys   : ${referenced.size}`);
console.log(`key prefixes      : ${prefixes.size}`);
console.log('');

// The denominator matters for the same reason it does in `route-parity.ts`: a scan
// that reads nothing reports no defects.
const missing = [...referenced.entries()]
  .filter(([key]) => !defaultKeys.has(key))
  .sort(([a], [b]) => a.localeCompare(b));

console.log(`KEYS REFERENCED BUT NOT IN ${DEFAULT_LOCALE.toUpperCase()} (${missing.length})`);

for (const [key, files] of missing) {
  console.log(`  ${key}  <- ${files.join(', ')}`);
}

// The blind spot the loose pattern cannot eliminate, made checkable: a key built as
// `'PREFIX_' + value` is invisible to the check above, but the namespace it lives in
// is not. A prefix with no catalogue entry is a whole family of raw keys.
const orphanPrefixes = [...prefixes.entries()]
  .filter(
    ([prefix]) =>
      ![...defaultKeys].some((key) => key.startsWith(prefix))
  )
  .sort(([a], [b]) => a.localeCompare(b));

console.log('');
console.log(`KEY PREFIXES WITH NO CATALOGUE ENTRY (${orphanPrefixes.length})`);

for (const [prefix, files] of orphanPrefixes) {
  console.log(`  ${prefix}*  <- ${files.join(', ')}`);
}

console.log('');
let drifted = 0;

for (const locale of locales) {
  if (locale === DEFAULT_LOCALE) {
    continue;
  }

  const keys = catalogueOf(locale);
  const absent = [...defaultKeys].filter((key) => !keys.has(key)).sort();

  if (absent.length > 0) {
    drifted += absent.length;
    console.log(`MISSING FROM ${locale.toUpperCase()} (${absent.length})`);

    for (const key of absent) {
      console.log(`  ${key}`);
    }

    console.log('');
  }
}

if (drifted === 0) {
  console.log(`LOCALE DRIFT: none, every locale matches ${DEFAULT_LOCALE}`);
}

// Deliberately a count and not a list: a key can be reached dynamically or through
// another component's input, so "referenced nowhere the scanner looks" is not
// evidence that copy is dead.
const unreferenced = [...defaultKeys].filter((key) => !referenced.has(key));
console.log('');
console.log(`UNREFERENCED (${unreferenced.length}) - informational, not a defect`);

process.exit(missing.length > 0 ? 1 : 0);
