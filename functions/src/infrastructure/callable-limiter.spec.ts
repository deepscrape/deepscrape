/* eslint-disable max-len */
import assert from "node:assert/strict"
import test from "node:test"
import {APP_CHECK_ENFORCED, applyAppCheckPolicy, enforceCallableRateLimit, guardedOnCall, resolveCallableLimitKey} from "./callable-limiter"

// Covers the branches reachable without mocking Redis. The counter itself is the same
// atomic FIXED_WINDOW_INCREMENT Lua script already exercised by
// sendDeviceVerificationCode; what is new and worth pinning here is the wiring — the
// key derivation, the overload dispatch inside the cast, and that the request still
// reaches the handler.

test("resolveCallableLimitKey keys by uid when there is one, by IP otherwise", () => {
  // The verified uid is the better bucket and must win even when an IP is present.
  assert.equal(
    resolveCallableLimitKey({auth: {uid: "u1"}, rawRequest: {ip: "203.0.113.7"}}),
    "callableRateLimit:u1",
  )

  // Anonymous callers get an IP bucket, namespaced so it cannot collide with a uid.
  assert.equal(
    resolveCallableLimitKey({auth: null, rawRequest: {headers: {"x-forwarded-for": "203.0.113.7, 10.0.0.1"}}}),
    "callableRateLimit:ip:203.0.113.7",
  )

  // A loopback or absent address identifies nobody: pooling those callers into one
  // bucket would throttle them collectively, so they are left unmetered.
  assert.equal(resolveCallableLimitKey({}), null)
  assert.equal(resolveCallableLimitKey({auth: null, rawRequest: {ip: "127.0.0.1"}}), null)
  assert.equal(resolveCallableLimitKey({auth: null, rawRequest: {ip: "::1"}}), null)
})

test("enforceCallableRateLimit is a no-op when the caller cannot be identified", async () => {
  // Must resolve, not throw: a callable that cannot be invoked at all is worse than
  // one that is unmetered. Note an anonymous caller *with* an IP is metered now — the
  // guest heartbeat (`recordGuestPresence`) never rejects an anonymous caller, so the
  // old "no uid => nothing to meter" assumption left it unbounded.
  await enforceCallableRateLimit({})
  await enforceCallableRateLimit({auth: null})
})

test("guardedOnCall returns a callable for both overload shapes", () => {
  // Both forms are used in this repo: onCall(handler) and onCall(opts, handler).
  assert.ok(guardedOnCall(async () => "ok"), "handler-only overload returned nothing")
  assert.ok(guardedOnCall({region: "us-central1"}, async () => "ok"), "options overload returned nothing")
})

test("guardedOnCall still passes the request through to the handler", async () => {
  let seen: unknown = null
  const wrapped = guardedOnCall(async (request: unknown) => {
    seen = request
    return "ok"
  }) as unknown as {run: (r: unknown) => Promise<unknown>}

  const request = {auth: null, data: {hello: "world"}}
  const result = await wrapped.run(request)

  // If the wrapper ever swallows the handler call, this fails.
  assert.equal(result, "ok")
  assert.equal(seen, request)
})

test("applyAppCheckPolicy keeps the server in lockstep with a client that sends no token", () => {
  // app.config.ts no longer calls provideAppCheck(), so the browser sends no App Check
  // token, and firebase-functions rejects a MISSING app token with a bare
  // HttpsError("unauthenticated", "Unauthenticated") whenever enforceAppCheck is true.
  // Nine callables in gfunctions/sessions.ts declared `true` and were therefore dead for
  // every real user — session revoke, sign-out, device removal, MFA preferences and both
  // halves of device verification. 156 tests passed with all of that broken, so pin it.
  assert.equal(APP_CHECK_ENFORCED, false, "flip this only after provideAppCheck() is restored")

  // A declared `true` must not survive while the client cannot produce a token: that is
  // precisely the combination that turns a hardening flag into an outage.
  const declaredTrue = applyAppCheckPolicy({region: "us-central1", enforceAppCheck: true})
  assert.equal(
    declaredTrue["enforceAppCheck"],
    false,
    "enforceAppCheck: true with a tokenless client makes the callable unreachable",
  )

  // Every other option is load-bearing for deployment (secrets, region, memory, cors)
  // and must pass through untouched.
  assert.equal(declaredTrue["region"], "us-central1")
  const declaredFalse = applyAppCheckPolicy({secrets: ["a"], memory: "256MiB", enforceAppCheck: false})
  assert.deepEqual(declaredFalse["secrets"], ["a"])
  assert.equal(declaredFalse["memory"], "256MiB")
  assert.equal(declaredFalse["enforceAppCheck"], false)

  // The effective value is always the call site's intent AND the global switch, so the
  // two halves can only be enabled together.
  assert.equal(
    applyAppCheckPolicy({enforceAppCheck: true})["enforceAppCheck"],
    APP_CHECK_ENFORCED,
  )
})
