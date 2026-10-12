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

  it("still detects a direct platform-key read", () => {
    // Without this the check above passes vacuously the moment the pattern is renamed -- a
    // stale assertion reports safety it is not testing.
    //
    // This used to assert a COUNT of call sites, and that number rotted the moment the
    // per-vendor cores were collapsed into one factory: eight vendors now share a single
    // `keyFor` call, so a count of calls can no longer say anything about coverage. What the
    // count was really guarding against is a vacuous regex, so that is what is tested -- the
    // pattern must still FIRE on the shape it exists to catch.
    const viaKeyFor = [...source.matchAll(/await keyFor\(/g)]
    assert.ok(viaKeyFor.length > 0, "no keyFor call site found at all")

    const offending = "const apiKey = env.OPENAI_API_KEY"
    assert.equal(
      [...offending.matchAll(/const apiKey = (?!await keyFor\()/g)].length,
      1,
      "the direct-read pattern no longer matches a direct read"
    )
  })
})
