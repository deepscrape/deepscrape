#!/usr/bin/env node
/**
 * OnPush safety guard.
 *
 * Why this exists: `Default` change detection re-renders a component whenever
 * change detection happens to run for any reason, so async code that writes a
 * plain field still shows up by luck. Under `OnPush` that incidental refresh is
 * gone — an async write to a field the template reads now needs a signal or an
 * explicit `markForCheck()`, otherwise the UI silently freezes. That failure is
 * invisible to tsc, to Karma and to `ng build`, so it needs a check of its own.
 *
 * Exit 1 on the unsafe pattern. Components still on `Default` are only reported:
 * they are not broken, just un-migrated, and failing on them would block CI for
 * a whole migration's worth of work.
 *
 * ponytail: regex + paren scan, not an AST. It catches a direct `this.x = ...`
 * inside a subscribe/timer/listener callback, and it treats any `markForCheck()`
 * in the file as covering every callback in it. It will not follow indirection
 * through a helper method. Swap in @angular-eslint with a custom rule if that
 * ever hides a real case.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const ROOT = 'src/app';
const ASYNC_CALL = /\.subscribe\s*\(|setTimeout\s*\(|setInterval\s*\(|addEventListener\s*\(|\.then\s*\(/g;
const ASSIGN = /this\.(\w+)\s*=\s*[^=]/g;

/** Character ranges spanned by each async callback's argument list. */
function asyncRanges(src) {
  const ranges = [];
  for (const m of src.matchAll(ASYNC_CALL)) {
    const open = src.indexOf('(', m.index);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) {
        ranges.push([open, i]);
        break;
      }
    }
  }
  return ranges;
}

const within = (ranges, i) => ranges.some(([a, b]) => i > a && i < b);

/** Markup this component renders: the sibling template file, or an inline one. */
function markup(path, src) {
  const file = path.replace(/\.ts$/, '.html');
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const inline = src.match(/template:\s*`([\s\S]*?)`/);
  return inline ? inline[1] : '';
}

const files = readdirSync(ROOT, { recursive: true })
  .map(String)
  .map((f) => f.split('\\').join('/'))
  .filter((f) => f.endsWith('.component.ts'));

const unsafe = [];
const missing = [];

for (const rel of files) {
  const path = `${ROOT}/${rel}`;
  const src = readFileSync(path, 'utf8');
  const html = markup(path, src);

  if (!src.includes('ChangeDetectionStrategy.OnPush')) {
    missing.push(path);
    continue;
  }
  // Any explicit view notification in the file is taken as covering its callbacks.
  // `detectChanges()` forces the view synchronously and is equally safe here.
  if (/markForCheck|detectChanges/.test(src)) continue;

  const ranges = asyncRanges(src);
  const offenders = new Set();

  for (const m of src.matchAll(ASSIGN)) {
    const name = m[1];
    if (!within(ranges, m.index)) continue; // sync write: its own event marks the view
    if (new RegExp(`\\b${name}\\s*(?::[^=]+)?=\\s*(signal|computed)\\s*\\(`).test(src)) continue;
    if (!new RegExp(`\\b${name}\\b`).test(html)) continue; // never rendered, so nothing to freeze
    offenders.add(name);
  }

  if (offenders.size) unsafe.push({ path, fields: [...offenders].sort() });
}

const n = (c) => '\x1b[31m' + c + '\x1b[0m';

console.log(`scanned ${files.length} components`);

if (unsafe.length) {
  console.log(n(`\nUNSAFE — OnPush + async write to a rendered field, no signal/markForCheck: ${unsafe.length}`));
  for (const { path, fields } of unsafe) console.log(`  ${path}\n      ${fields.join(', ')}`);
} else {
  console.log('\nNo unsafe async-write components.');
}

console.log(`\nstill on Default (reported, not fatal): ${missing.length}`);

process.exit(unsafe.length ? 1 : 0);
