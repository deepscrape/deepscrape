// One-off: the 12 remaining lint errors, applied as an explicit list.
//
// Why a script instead of twelve edits: each fix is a known, exact substitution,
// and doing them here keeps the old and new text side by side where it can be
// reviewed in one place. It REPORTS every op that did not apply, so a stale
// string cannot pass silently — the failure mode of a bulk edit.
//
// Usage: bun scripts/fix-maxlen-code.mjs   (from the repo root)
import { readFileSync, writeFileSync } from "node:fs"

const root = "functions/"

/**
 * `find` must appear exactly once; `findAll` replaces every occurrence.
 * `insertBefore` prepends a line to the first line starting with the marker.
 */
const ops = [
  {
    file: "scripts/webrain-smoke.ts",
    find:
      '      "  NOTE  gap OPEN: webrain_session(op=list) is served on a shared instance" +',
    to:
      '      "  NOTE  gap OPEN: webrain_session(op=list) is served on a" +\n' +
      '      " shared instance" +',
    why: "string concatenation over 80",
  },
  {
    file: "src/handlers/webrain-jobs.ts",
    find: '    return "This tool needs a private worker (the shared pool holds no sessions)"',
    to: '    return "Needs a private worker (the shared pool holds no sessions)"',
    why: "message over 80",
  },
  {
    file: "src/handlers/webrain-jobs.ts",
    find:
      '      "The batch job surface is served by the embedded engine only. Select it to use jobs.",',
    to: '      "Jobs are served by the embedded engine only. Select it to use jobs.",',
    why: "message over 80",
  },
  {
    file: "src/domain/webrain-tools.domain.ts",
    find: '    return "This tool needs a private worker; the shared pool serves stateless work only"',
    to: '    return "Needs a private worker; the shared pool serves stateless work"',
    why: "message over 80",
  },
  {
    file: "src/domain/scrape-providers.domain.ts",
    find:
      "  /** Routes this provider can serve. A provider absent from a route is not offered for it. */",
    to:
      "  /**\n" +
      "   * Routes this provider can serve. A provider absent from a route is\n" +
      "   * not offered for it.\n" +
      "   */",
    why: "one-line JSDoc over 80",
  },
  {
    file: "src/domain/scrape-providers.domain.ts",
    find:
      "/** The provider used when nothing is stored. `crawl4ai` keeps today's behaviour. */",
    to:
      "/**\n" +
      " * The provider used when nothing is stored. `crawl4ai` keeps today's\n" +
      " * behaviour.\n" +
      " */",
    why: "one-line JSDoc over 80",
  },
  {
    file: "src/domain/scrape-providers.domain.ts",
    find:
      "  /** Where the answer came from, for the UI to explain and for logs to trace. */",
    to:
      "  /**\n" +
      "   * Where the answer came from, for the UI to explain and for logs to\n" +
      "   * trace.\n" +
      "   */",
    why: "one-line JSDoc over 80",
  },
  {
    file: "src/domain/user-ai-settings.domain.ts",
    find:
      "/** The vendors the platform integrates. Grounded in `AiApiService`'s four endpoints. */",
    to:
      "/**\n" +
      " * The vendors the platform integrates. Grounded in `AiApiService`'s four\n" +
      " * endpoints.\n" +
      " */",
    why: "one-line JSDoc over 80",
  },
  {
    file: "src/domain/user-ai-settings.domain.ts",
    find:
      "/** Anything that is not explicitly free counts as paid — see `scrape-providers.domain.ts`.",
    to:
      "/**\n" +
      " * Anything that is not explicitly free counts as paid — see\n" +
      " * `scrape-providers.domain.ts`.",
    why: "JSDoc line over 80",
  },
  {
    file: "src/domain/url-guard.domain.ts",
    insertBefore: "  /^(localhost",
    line:
      "  // eslint-disable-next-line max-len -- a regex literal cannot be wrapped",
    why: "regex literal over 80, unbreakable by design",
  },
  {
    file: "src/infrastructure/scrape-provider.store.ts",
    findAll: "PREFERENCE_DOC",
    to: "preferenceDoc",
    why: "new-cap: a called function must not look like a constructor",
  },
]

let applied = 0
const missed = []

for (const op of ops) {
  const path = root + op.file
  let source = readFileSync(path, "utf8")

  if (op.insertBefore) {
    const lines = source.split("\n")
    const index = lines.findIndex((line) => line.startsWith(op.insertBefore))
    if (index === -1) {
      missed.push(`${op.file}: marker not found (${op.why})`)
      continue
    }
    lines.splice(index, 0, op.line)
    writeFileSync(path, lines.join("\n"), "utf8")
    applied += 1
    continue
  }

  if (op.findAll) {
    const occurrences = source.split(op.findAll).length - 1
    if (occurrences === 0) {
      missed.push(`${op.file}: ${op.findAll} not found (${op.why})`)
      continue
    }
    source = source.split(op.findAll).join(op.to)
    writeFileSync(path, source, "utf8")
    applied += 1
    continue
  }

  const occurrences = source.split(op.find).length - 1
  if (occurrences !== 1) {
    missed.push(`${op.file}: matched ${occurrences}x, expected 1 (${op.why})`)
    continue
  }
  writeFileSync(path, source.split(op.find).join(op.to), "utf8")
  applied += 1
}

console.log(`${applied}/${ops.length} ops applied`)
for (const entry of missed) {
  console.log(`  MISSED ${entry}`)
}
