/**
 * Replace the banned dash characters in the locale files.
 *
 * The design rule is binary: zero em-dashes (U+2014) and zero en-dashes
 * (U+2013) anywhere a user can read one. The locale files are where almost all
 * of the visible copy lives, so they are where almost all of the violations
 * live.
 *
 * Why a script rather than 185 hand edits
 * ---------------------------------------
 * The rewrite is the same in every string: an em-dash joining two clauses
 * becomes a comma, and an en-dash between digits is a number range and becomes
 * a hyphen. Doing that by hand across five locales invites five different
 * mistakes and leaves no way to prove the result.
 *
 * The one case that needs care is a dash that already follows punctuation. A
 * blind `—` -> `,` turns "counts, — and they" into a double comma, so the
 * punctuation is consumed first and the dash is simply dropped.
 *
 * Run: node scripts/strip-banned-dashes.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'src/assets/i18n'
const EM = '\u2014'
const EN = '\u2013'

/** Rewrites one file's text, leaving keys untouched (keys carry no dashes). */
const rewrite = (text) =>
  text
    // A dash already preceded by punctuation: drop the dash, keep the mark.
    .replace(new RegExp(`([,.:;!?])\\s*${EM}\\s*`, 'g'), '$1 ')
    // Otherwise the dash joins two clauses, which a comma does.
    .replace(new RegExp(`\\s*${EM}\\s*`, 'g'), ', ')
    // An en-dash between digits or a currency mark is a numeric range.
    .replace(new RegExp(`(?<=\\d)\\s*${EN}\\s*(?=[\\d\u20ac$])`, 'g'), '-')
    // Any remaining en-dash is a range separator too.
    .replace(new RegExp(`\\s*${EN}\\s*`, 'g'), '-')

const count = (text, ch) => text.split(ch).length - 1

let changed = 0

for (const name of readdirSync(DIR)) {
  if (!name.endsWith('.json')) {
    continue
  }

  const path = join(DIR, name)
  const before = readFileSync(path, 'utf8')
  const em = count(before, EM)
  const en = count(before, EN)

  if (em === 0 && en === 0) {
    console.log(`${name}: clean`)
    continue
  }

  const after = rewrite(before)

  // Fail loudly rather than write a file the app cannot parse.
  try {
    JSON.parse(after)
  } catch (error) {
    console.error(`${name}: REFUSED, result is not valid JSON`, error)
    process.exitCode = 1
    continue
  }

  writeFileSync(path, after)
  changed += 1
  console.log(
    `${name}: ${em} em-dash(es) and ${en} en-dash(es) replaced ` +
      `(remaining: ${count(after, EM)}/${count(after, EN)})`,
  )
}

console.log(`${changed} locale file(s) rewritten`)
