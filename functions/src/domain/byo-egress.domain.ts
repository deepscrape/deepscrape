/* eslint-disable object-curly-spacing */
/**
 * A caller's OWN egress proxy, as opposed to the platform's pool.
 *
 * The two directions of egress
 * ---------------------------
 * `webrain-config-admin.domain.ts` owns the OTHER direction: the pool the
 * PLATFORM runs, which is why that one is admin-only. This file owns the
 * request that comes from the tenant instead -- "send my crawls out through an
 * exit I control" -- so no request of theirs leaves from our address and no
 * operator can see where their traffic appears to originate.
 *
 * Two stores, the same split `storage-settings.store.ts` makes
 * ------------------------------------------------------------------
 * The Firestore document holds ONE field, `secretPath`, and nothing else. The
 * POOL lives in Secret Manager as JSON in the shape `WEBRAIN_CONFIG` already
 * uses (`{"proxies": [...]}`), reached through `upsertSecretValue`.
 *
 * Why one field is enough, and why there is deliberately no `count` or `hosts`
 * ---------------------------------------------------------------------------
 * A present pointer means "this caller has their own exits"; an absent one means
 * "use the platform pool". Those are the only two states the resolver needs, and
 * they cannot disagree with each other the way a `mode` plus a `count` can. How
 * many exits there are, and what they are, is inside the secret -- which is the
 * business of the one function that reads it and of nothing that renders.
 *
 * Nothing in this file emits a credential
 * --------------------------------------
 * A proxy URL is `scheme://user:pass@host:port`, i.e. a password. Every export
 * here either validates one, serialises one into the secret, or projects one
 * down to a masked host by calling the masker the admin surface already uses --
 * so there is one masking rule in the codebase rather than two that drift.
 */
import type { ProxyEntry } from "./webrain-proxy.domain"
import {
  maskProxyHost,
  toPublicProxies,
  validateProxyInput,
  type ProxyValidation,
  type PublicProxyEntry,
} from "./webrain-config-admin.domain"

/** Prefix of a caller's egress secret id. One secret per caller. */
export const EGRESS_SECRET_PREFIX = "egress-byo-"

/**
 * The Secret Manager id holding one caller's pool.
 *
 * Keyed by uid for the same reason `byobSecretId` is: a name holds one value per
 * project, so the caller's identity IS the namespace -- there is no list to
 * enumerate and no way to read a pool without already knowing whose it is.
 * @param {string} uid The verified caller uid.
 * @return {string} The bare secret id, for `upsertSecretValue`.
 */
export const egressSecretId = (uid: string): string =>
  `${EGRESS_SECRET_PREFIX}${uid}`

/** What a caller sees of their own egress. No credential in any field. */
export interface EgressSettingsPublic {
  /** `byo` when the caller has their own exits, else the platform default. */
  mode: "platform" | "byo"
  /** A presence bit, never a prefix or a length. */
  hasCredentials: boolean
  /** Masked exits, in stored order. Empty on the platform default. */
  exits: PublicProxyEntry[]
}

/** What a caller with no document at all has. */
export const DEFAULT_EGRESS: EgressSettingsPublic = {
  mode: "platform",
  hasCredentials: false,
  exits: [],
}

/**
 * A validated write.
 *
 * Clearing is its own mode rather than an empty list, mirroring
 * `StorageSettingsWrite`: `validateProxyInput` deliberately refuses an empty
 * array, because for an OPERATOR that would silently move every caller onto a
 * direct exit. A tenant clearing their own pool is not that case -- it is the
 * intended way to stop using it -- so the intent is stated rather than inferred
 * from a length.
 */
export type EgressWrite =
  | { mode: "platform" }
  | { mode: "byo"; proxies: string[] }

/** The outcome of validating a write body. */
export type EgressValidation =
  | { ok: true; write: EgressWrite }
  | { ok: false; index: number; reason: string }

/**
 * The resolved answer to "where does this caller's request go out?".
 *
 * Three states rather than an optional pool, because `undefined` cannot tell
 * "not configured" apart from "configured but broken" -- and those want
 * opposite behaviour. See `egressFrom`.
 */
export type EgressResolution =
  | { kind: "platform" }
  | { kind: "tenant"; pool: ProxyEntry[] }
  | { kind: "unusable" }

/**
 * One caller's pool as the secret payload.
 *
 * The object wrapper matches `WEBRAIN_CONFIG`, so both secrets are the same
 * shape and a reader who knows one knows the other.
 * @param {string[]} urls The validated proxy URLs.
 * @return {string} The JSON payload for Secret Manager.
 */
export const serializeEgressPool = (urls: string[]): string =>
  JSON.stringify({ proxies: urls })

/**
 * The pool out of a stored payload, or null when it is not usable.
 *
 * Every URL is re-validated on the way out, not trusted because it was
 * validated on the way in: the secret can be edited by an operator, restored
 * from a backup, or written by an older revision with different rules. A stored
 * value is input like any other.
 *
 * Null for a malformed payload, an empty list, or a single bad entry -- so a
 * request is never signed through a pool that is half-readable.
 * @param {unknown} raw The secret payload as read.
 * @return {string[] | null} The usable URLs, or null.
 */
export const parseEgressPool = (raw: unknown): string[] | null => {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const record = parsed && typeof parsed === "object" ?
    (parsed as { proxies?: unknown }) :
    {}

  if (!Array.isArray(record.proxies) || record.proxies.length === 0) {
    return null
  }

  // Re-run the shared admin validator rather than a second copy of the rules:
  // the protocol allowlist lives in exactly one place, and this is a second
  // caller of it rather than a second implementation. The label is supplied only
  // because the validator requires the field, and it is discarded here -- the
  // label that reaches a caller is derived in `egressFrom` from the host.
  const check: ProxyValidation = validateProxyInput({
    proxies: record.proxies.map((url) => ({ label: "stored", url })),
  })

  return check.ok ? check.proxies.map((entry) => entry.url) : null
}

/**
 * Validate a write body: `{mode:"platform"}` to clear, or
 * `{mode:"byo", proxies:[{url}]}` to set.
 *
 * `mode` is REQUIRED rather than defaulted. A body that omits it would have to
 * be read as one of the two, and either guess is wrong for someone: treating it
 * as "set" would let a typo clear a working pool, and treating it as "clear"
 * would let a typo silently drop the caller back onto our addresses.
 * @param {unknown} input The raw request body.
 * @return {EgressValidation} The validated write, or the offending index.
 */
export const validateEgressInput = (input: unknown): EgressValidation => {
  const record = input && typeof input === "object" ?
    (input as { mode?: unknown; proxies?: unknown }) :
    {}

  if (record.mode === "platform") {
    return { ok: true, write: { mode: "platform" } }
  }

  if (record.mode !== "byo") {
    return {
      ok: false,
      index: -1,
      reason: "mode must be \"byo\" or \"platform\"",
    }
  }

  // The caller states URLs, not label/url pairs. A label is a display concern
  // and the stored payload has none -- the secret is a bare URL array, exactly
  // like `WEBRAIN_CONFIG`, and `setWebrainProxies` discards the admin's labels
  // the same way. Asking a tenant for one would be asking for a field this
  // write immediately drops. The label handed to the shared validator below is
  // therefore the masked host, which is the SAME value the read derives, so
  // there is one naming rule applied once rather than a placeholder here and a
  // real name later.
  const raw = record.proxies
  if (!Array.isArray(raw)) {
    return { ok: false, index: -1, reason: "proxies must be an array" }
  }

  // The protocol allowlist is deliberately NOT restated here: it lives in
  // `validateProxyInput`, and this is a second caller of that rule rather than
  // a second copy of it that could drift.
  const check = validateProxyInput({
    proxies: raw.map((entry) => ({
      label: typeof entry === "string" ? maskProxyHost(entry) : "invalid",
      url: entry,
    })),
  })

  if (!check.ok) {
    return { ok: false, index: check.index, reason: check.reason }
  }

  return {
    ok: true,
    write: {
      mode: "byo",
      proxies: check.proxies.map((entry) => entry.url),
    },
  }
}

/**
 * Which pool a request should use, given what the caller's document held.
 *
 * The fail-closed rule is the point of this function. A caller who configured
 * their own exits did so for a reason, and every reason is about NOT appearing
 * on our addresses -- privacy, geolocation, reputation. Falling back to the
 * platform pool when their secret is unreadable would silently undo exactly
 * that, and the caller would never learn their traffic came out somewhere they
 * did not choose. So a configured-but-unusable pool refuses the call instead.
 *
 * `undefined` and `null` therefore mean opposite things and must not be
 * conflated: `undefined` is "no pointer, use the platform" and `null` is "there
 * IS a pointer and it did not resolve".
 * @param {string[] | null | undefined} urls The parsed pool, or the failure.
 * @return {EgressResolution} The pool to use, or the refusal.
 */
export const egressFrom = (
  urls: string[] | null | undefined
): EgressResolution => {
  if (urls === undefined) {
    return { kind: "platform" }
  }

  if (urls === null || urls.length === 0) {
    return { kind: "unusable" }
  }

  return {
    kind: "tenant",
    pool: urls.map((url) => ({ label: maskProxyHost(url), url })),
  }
}

/**
 * The caller-facing projection of their own egress.
 *
 * Reuses the admin projector, so both surfaces render the same shape and there
 * is one masking rule. The label is the masked host because the tenant authored
 * no labels -- `toPublicProxies` already guarantees no field can carry a
 * credential, which is what makes this safe to hand to a route.
 * @param {*} input The resolved mode and pool.
 * @return {EgressSettingsPublic} A body with no credential in it.
 */
export const toPublicEgress = (input: {
  mode: "platform" | "byo"
  pool: ProxyEntry[]
}): EgressSettingsPublic => ({
  mode: input.mode,
  hasCredentials: input.mode === "byo" && input.pool.length > 0,
  exits: input.mode === "byo" ? toPublicProxies(input.pool) : [],
})
