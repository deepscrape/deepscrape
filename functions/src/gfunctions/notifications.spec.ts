import assert from "node:assert/strict"
import {describe, it} from "node:test"
import {readFileSync} from "node:fs"
import {join} from "node:path"

// The callable needs Firestore and a verified session, so these assert the two
// invariants that must not be refactored away: the admin gate and the audience
// cap. Deliberately source-level, like the sessions callable checks.
describe("notification broadcast", () => {
  const src = readFileSync(join(__dirname, "notifications.ts"), "utf8")
  const callable = src.slice(
    src.indexOf("export const adminBroadcastNotification"),
  )

  it("gates the sender on a platform role", () => {
    assert.match(callable, /role !== "admin" && access\.role !== "superadmin"/)
  })

  it("caps the audience", () => {
    assert.match(src, /BROADCAST_MAX_USERS = \d+/)
    assert.match(callable, /\.limit\(BROADCAST_MAX_USERS\)/)
  })
})
