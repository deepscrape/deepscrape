/* eslint-disable max-len */
/**
 * The admin analytics types exist twice on purpose.
 *
 * The browser copy (`src/app/core/types/analytics.interface.ts`) carries
 * Angular's `@angular/fire/firestore` Timestamp; the functions copy
 * (`functions/src/domain/analytics-optimized.domain.ts`) carries
 * `firebase-admin/firestore`'s. Importing either into the other bundle is the
 * reason the mirror exists at all, so unifying them is not on the table.
 *
 * What that buys is a silent-drift hazard: rename a field on the writer and the
 * reader keeps compiling right up until a dashboard renders `undefined`.
 *
 * Field NAMES must match. Optionality deliberately does not: the reader marks
 * fields optional that the writer declares required (`MetricsRange.trends`,
 * `LoginHistory.city`, `UserLoginMetrics.*`), because Firestore still holds
 * documents written before those fields existed. That asymmetry is the
 * defensive read, not drift — so it is not asserted here.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {join} from "node:path"

const repoRoot = join(__dirname, "../../..")
const writerFile = join(repoRoot, "functions/src/domain/analytics-optimized.domain.ts")
const readerFile = join(repoRoot, "src/app/core/types/analytics.interface.ts")

/** Field names of every `export interface` in a file, keyed by interface name.
 * @param {*} source
 * @return {*}
 */
const fieldsByInterface = (source: string): Map<string, Set<string>> => {
  const out = new Map<string, Set<string>>()

  for (const [, name, body] of source.matchAll(/export interface (\w+) \{([\s\S]*?)\n\}/g)) {
    out.set(
      name,
      new Set([...body.matchAll(/^\s+(\w+)\??:/gm)].map(([, field]) => field)),
    )
  }

  return out
}

/**
 * analytics contract mirror
 */
describe("analytics contract mirror", () => {
  const writer = fieldsByInterface(readFileSync(writerFile, "utf8"))
  const reader = fieldsByInterface(readFileSync(readerFile, "utf8"))
  /**
   * callback
   * @param {*} name
   */
  const shared = [...writer.keys()].filter((name) => reader.has(name))

  /**
   * still finds the mirrored interfaces in both files
   */
  it("still finds the mirrored interfaces in both files", () => {
    assert.ok(
      shared.length >= 12,
      `expected at least 12 mirrored interfaces, found ${shared.length}: ${shared.join(", ")}`,
    )
  })

  for (const name of shared) {
    it(`${name} exposes the same fields to the browser and the writer`, () => {
      const written = writer.get(name) as Set<string>
      const read = reader.get(name) as Set<string>

      assert.deepEqual(
        {
          missingFromReader: [...written].filter((field) => !read.has(field)).sort(),
          unknownToWriter: [...read].filter((field) => !written.has(field)).sort(),
        },
        {missingFromReader: [], unknownToWriter: []},
        `${name} drifted: update the browser mirror in src/app/core/types/analytics.interface.ts (or the backend copy), or add the field to both`,
      )
    })
  }
})
