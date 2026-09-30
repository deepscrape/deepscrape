/* eslint-disable max-len */
/**
 * The invariant that makes BYOK real.
 *
 * `keyFor` is the single place a vendor key is chosen, and the failure it guards
 * against is silent: a handler that reads `env.X_API_KEY` directly keeps spending
 * the platform's key after the user has supplied their own. That arrives as a bill,
 * not as an error, so nothing else in the suite would notice.
 *
 * Asserts the shape of the source, the same way `gfunctions/sessions.spec.ts`
 * asserts HttpsError messages do — the other caller of this pattern in the repo.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"

// Path is relative to the package root because that is where the suite is run
// from (`cd functions && bunx tsx --test "src/**/*.spec.ts"`). `import.meta.url`
// is not used here: the functions tsconfig's module setting rejects it (TS1343),
// which is how this line failed the build the first time it was typechecked.
const source = readFileSync("src/handlers/ai_handler.ts", "utf8")

describe("ai_handler key selection", () => {
  it("routes every vendor key through keyFor", () => {
    const direct = [...source.matchAll(/const apiKey = (?!await keyFor\()/g)]
    assert.equal(direct.length, 0, `${direct.length} handler(s) read a platform key directly`)
  })

  it("still covers the four vendor call sites", () => {
    // Without this the check above passes vacuously the moment the pattern is
    // renamed — a stale assertion reports safety it is not testing.
    const viaKeyFor = [...source.matchAll(/const apiKey = await keyFor\(/g)]
    assert.equal(viaKeyFor.length, 4, "expected four vendors routed through keyFor")
  })
})
