/* eslint-disable max-len */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {join} from "node:path"

// The purge may not delete a browser session it has not handed to the reaper: those
// documents are the only route from a deleted account to a machine still running on Fly,
// and a pointer nobody kept is a VM that bills forever and appears in no view.
describe("account purge and running machines", () => {
  it("expires the deadline first and keeps the sessions it handed over", () => {
    const src = readFileSync(join(__dirname, "admin-users.ts"), "utf8")

    assert.match(src, /idleDeadline: now - 1/)
    assert.match(src, /collectionRef\.id === "browserSessions" && orphanedMachines\.length > 0/)
  })
})
