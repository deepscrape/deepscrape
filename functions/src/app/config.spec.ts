import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { versionsToRetire } from "./config"

/**
 * The two ways rotation hygiene fails, and both are silent.
 *
 * Rotating is only revocation if the superseded value stops being readable, and this
 * decision is the only thing between "rotated" and "the old credential still works".
 * It cannot be exercised against the emulator -- that path stores one overwritten
 * document with no version concept -- so the decision is pinned here instead, which
 * is the only place it can be.
 */
describe("versionsToRetire", () => {
    const version = (n: number, state = "ENABLED") => ({
        name: `projects/p/secrets/s/versions/${n}`,
        state,
    })

    it("keeps the version just written and retires the rest", () => {
        const versions = [version(1), version(2)]

        assert.deepEqual(versionsToRetire(versions, versions[1].name), [versions[0].name])
    })

    it("retires MORE than one when a secret has accumulated versions", () => {
        // The legacy BYOK migration plus two rotations is three versions, so "destroy
        // the previous one" would leave the oldest still readable.
        const versions = [version(1), version(2), version(3)]

        assert.deepEqual(versionsToRetire(versions, versions[2].name), [
            versions[0].name,
            versions[1].name,
        ])
    })

    it("skips versions already destroyed", () => {
        // Destroying one twice errors, and a single error abandons the loop -- leaving
        // every LATER version enabled.
        const versions = [version(1, "DESTROYED"), version(2), version(3)]

        assert.deepEqual(versionsToRetire(versions, versions[2].name), [versions[1].name])
    })

    it("never retires the version it was told to keep", () => {
        // The failure with no recovery: destroying the credential being stored.
        assert.deepEqual(versionsToRetire([version(1)], version(1).name), [])
    })

    it("retires everything when it was told to keep nothing valid", () => {
        assert.deepEqual(versionsToRetire([version(1)], null), [version(1).name])
        assert.deepEqual(versionsToRetire([version(1)], undefined), [version(1).name])
    })

    it("ignores a malformed listing entry", () => {
        assert.deepEqual(versionsToRetire([{name: null}, {state: "ENABLED"}], "keep"), [])
    })
})
