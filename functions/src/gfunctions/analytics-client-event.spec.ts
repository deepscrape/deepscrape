/* eslint-disable max-len */
import test from "node:test"
import assert from "node:assert/strict"
import {toClientEvent} from "./analytics"
import {parseUA} from "../infrastructure/ua-parser"

const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"

test("toClientEvent takes the uid from the VERIFIED token, never the body", () => {
  const spoofed = {
    eventType: "signup_completed",
    userId: "victim-uid",
    guestId: "g-1",
    metadata: {ok: true, count: 5, long: "x".repeat(500), nested: {a: 1}, list: [1, 2], nothing: null},
  }

  // The body's uid is ignored: this ingress is reachable anonymously, and a
  // body-supplied uid let anyone manufacture a conversion as somebody else.
  const anonymous = toClientEvent(spoofed, parseUA(""))
  assert.equal(anonymous.userId, undefined)
  // The guest id stays, because it IS the anonymous identity by design.
  assert.equal(anonymous.guestId, "g-1")

  // A verified token wins, and the spoofed body uid cannot override it.
  const verified = toClientEvent(spoofed, parseUA(""), "real-uid")
  assert.equal(verified.userId, "real-uid")
})

test("toClientEvent flattens and bounds client metadata at the trust boundary", () => {
  const event = toClientEvent({
    eventType: "crawl.started",
    metadata: {
      ok: true,
      count: 5,
      long: "x".repeat(500),
      nested: {a: 1},
      list: [1, 2],
      nothing: null,
    },
  }, parseUA(""))

  assert.equal(event.eventType, "crawl_started")
  assert.equal(event.metadata?.ok, true)
  assert.equal(event.metadata?.count, 5)
  assert.equal(String(event.metadata?.long).length, 200)
  assert.equal(event.metadata?.nothing, null)
  assert.equal(Object.keys(event.metadata || {}).includes("nested"), false)
  assert.equal(Object.keys(event.metadata || {}).includes("list"), false)
})

test("toClientEvent tags bot traffic from the request UA", () => {
  const bot = toClientEvent({eventType: "page_view"}, parseUA(GOOGLEBOT))
  const human = toClientEvent({eventType: "page_view"}, parseUA(""))

  assert.equal(bot.isBot, true)
  assert.equal(bot.botKind, "bot")
  assert.equal(human.isBot, false)
  assert.equal(human.botKind, null)
})

test("toClientEvent survives a junk payload", () => {
  const event = toClientEvent(undefined, parseUA(""))

  assert.equal(event.eventType, "unknown")
  assert.deepEqual(event.metadata, {})
})

test("toClientEvent accepts the legacy event/properties payload shape", () => {
  const event = toClientEvent({event: "login_attempt", properties: {success: false}}, parseUA(""))

  assert.equal(event.eventType, "login_attempt")
  assert.equal(event.metadata?.success, false)
})
