/* eslint-disable max-len */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {join} from "node:path"
import {
  evaluateMfaDisabledNotification,
  getDefaultPrimaryMethod,
  getDefaultSecondaryMethod,
  readMfaPreferences,
} from "./sessions"

describe("sessions trust boundary", () => {
  it("never forwards internal detail in HttpsError messages", () => {
    const src = readFileSync(join(__dirname, "sessions.ts"), "utf8")
    const messages = [...src.matchAll(/new HttpsError\("[^"]*",\s*"([^"]*)"/g)].map((m) => m[1])
    const forbidden = ["/", "Firestore", "collection", "document", "missing ", "undefined"]

    assert.ok(messages.length > 0, "expected typed HttpsError codes at the trust boundary")
    for (const message of messages) {
      for (const leaked of forbidden) {
        assert.ok(!message.includes(leaked), `HttpsError message leaks internal detail: "${message}"`)
      }
    }
  })

  // A trusted device is a 90-day re-authentication bypass, so revoking its session has to
  // drop the trust too — otherwise "sign out this device" leaves the bypass in place.
  it("drops the session's trusted device with the session", () => {
    const src = readFileSync(join(__dirname, "sessions.ts"), "utf8")
    const revoke = src.slice(src.indexOf("async function performSessionRevoke"))

    assert.match(revoke, /trusted_devices\/\$\{revokedDeviceId\}/)
    assert.match(revoke, /trustedDeviceKey\(targetUserId, revokedDeviceId\)/)
  })
})

describe("sessions mfa preferences", () => {
  it("normalizes invalid preferences to available defaults", () => {
    const available = {totp: true, sms: true, email: true}

    const prefs = readMfaPreferences(
      {
        settings: {
          security: {
            mfa: {
              primaryMethod: "garbage",
              secondaryMethod: "totp",
              riskEmailNotifications: false,
            },
          },
        },
      },
      available,
    )

    assert.equal(prefs.primaryMethod, "totp")
    assert.equal(prefs.secondaryMethod, "sms")
    assert.equal(prefs.riskEmailNotifications, false)
  })

  it("applies default factor ordering as totp > sms > email", () => {
    assert.equal(
      getDefaultPrimaryMethod({totp: true, sms: true, email: true}),
      "totp",
    )
    assert.equal(
      getDefaultPrimaryMethod({totp: false, sms: true, email: true}),
      "sms",
    )
    assert.equal(
      getDefaultPrimaryMethod({totp: false, sms: false, email: true}),
      "email",
    )

    assert.equal(
      getDefaultSecondaryMethod({totp: true, sms: true, email: true}, "totp"),
      "sms",
    )
    assert.equal(
      getDefaultSecondaryMethod({totp: true, sms: false, email: true}, "email"),
      "totp",
    )
  })

  it("evaluates mfa_disabled notification conditions", () => {
    const stillEnabled = evaluateMfaDisabledNotification({
      hasEnrolledMfa: true,
      riskEmailNotifications: true,
      hasEmail: true,
    })
    assert.equal(stillEnabled.shouldNotify, false)
    assert.equal(stillEnabled.reason, "mfa_still_enabled")

    const notificationsOff = evaluateMfaDisabledNotification({
      hasEnrolledMfa: false,
      riskEmailNotifications: false,
      hasEmail: true,
    })
    assert.equal(notificationsOff.shouldNotify, false)
    assert.equal(notificationsOff.reason, "risk_email_notifications_disabled")

    const missingEmail = evaluateMfaDisabledNotification({
      hasEnrolledMfa: false,
      riskEmailNotifications: true,
      hasEmail: false,
    })
    assert.equal(missingEmail.shouldNotify, false)
    assert.equal(missingEmail.reason, "missing_email")

    const shouldNotify = evaluateMfaDisabledNotification({
      hasEnrolledMfa: false,
      riskEmailNotifications: true,
      hasEmail: true,
    })
    assert.equal(shouldNotify.shouldNotify, true)
    assert.equal(shouldNotify.reason, "notify")
  })
})
