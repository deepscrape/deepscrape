/* eslint-disable indent */
/* eslint-disable object-curly-spacing */
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import {
    API_KEY_PREFIX,
    apiKeyIndexId,
    isPlatformApiKey,
} from "./api-key-index.domain"

/**
 * The property that must hold.
 *
 * The index is the only thing that turns a presented key into an owner, so two
 * distinct keys resolving to one document would authenticate a stranger's key as
 * its owner's. This pins the cause of that: a digest over PART of the key instead
 * of all of it, which is the mistake the module comment argues against.
 */
describe("apiKeyIndexId", () => {
    it("gives keys that share a prefix distinct ids", () => {
        assert.notEqual(
            apiKeyIndexId("dpsp-key-abc"),
            apiKeyIndexId("dpsp-key-abcd"),
        )
    })

    it("gives keys that share all but the last character distinct ids", () => {
        const shared = `${API_KEY_PREFIX}${"A".repeat(64)}`
        assert.notEqual(
            apiKeyIndexId(`${shared}x`),
            apiKeyIndexId(`${shared}y`),
        )
    })

    it("is stable, so the writer and the reader agree", () => {
        assert.equal(
            apiKeyIndexId("dpsp-key-abc"),
            apiKeyIndexId("dpsp-key-abc"),
        )
    })

    it("does not contain the key it indexes", () => {
        // The index lives in Firestore. A digest that leaked its input would make a
        // database export a working set of credentials.
        assert.equal(
            apiKeyIndexId("dpsp-key-SECRETVALUE").includes("SECRETVALUE"),
            false,
        )
    })
})

describe("isPlatformApiKey", () => {
    it("separates a platform key from a Firebase ID token", () => {
        assert.equal(isPlatformApiKey("dpsp-key-abc"), true)
        assert.equal(
            isPlatformApiKey("eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJ1MSJ9.sig"),
            false,
        )
        assert.equal(isPlatformApiKey(undefined), false)
        assert.equal(isPlatformApiKey(""), false)
    })

    it("is only a prefix test, so it decides nothing on its own", () => {
        // Verification is the index lookup, not this predicate. That is why it is not
        // named `isValidApiKey`, and why a well-formed but unissued key still has to
        // fail at the lookup.
        assert.equal(isPlatformApiKey("dpsp-key-never-issued-by-us"), true)
    })
})
