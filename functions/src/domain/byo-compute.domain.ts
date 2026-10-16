/* eslint-disable object-curly-spacing */
/**
 * A caller's OWN Fly organization, as opposed to the platform's.
 *
 * The OTHER BYO axis, and why it is its own file
 * ---------------------------------------------
 * `byo-egress.domain.ts` owns where a crawl's traffic appears to come from.
 * This owns whose machines run it. The two are independent -- a caller may
 * bring their own exits and still run on our hardware, or the reverse -- so one
 * document for both would force a choice on everyone who wanted only one.
 *
 * The store split is the same one, for a stronger reason
 * -----------------------------------------------------
 * The Firestore document holds ONE field, `secretPath`, and nothing else. The
 * app, the token and the region live in Secret Manager. A Fly token is far more
 * dangerous than a proxy password: a deploy token creates and destroys machines
 * in the caller's organization, so it must never sit in a document that is
 * backed up, exported, and read by rules.
 *
 * Ask for a DEPLOY token, never an org token
 * -----------------------------------------
 * `fly tokens create deploy -a <app>` mints a token scoped to one app. An org
 * token would let this platform act on EVERY app the caller owns, which is a
 * blast radius nobody agreed to when they asked to bring their own compute. The
 * UI states that before the field. This file cannot enforce it -- the two token
 * shapes are not reliably distinguishable -- so it says so rather than
 * pretending to check.
 *
 * Nothing here emits a credential
 * -------------------------------
 * The token is validated on the way in, serialised into the secret, and never
 * projected outward. `toPublicCompute` has no field a token could occupy, and
 * the spec asserts that by SHAPE rather than by review, because a shape is what
 * a future edit would actually change.
 */

/** Prefix of a caller's compute secret id. One secret per caller. */
export const COMPUTE_SECRET_PREFIX = "compute-byo-"

/** A Fly app name: lowercase letters, digits and dashes, alphanumeric ends. */
const FLY_APP_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** A Fly region code, e.g. `fra`, `lhr`, `iad`. */
const FLY_REGION_PATTERN = /^[a-z]{3}$/

/**
 * The longest token we will accept.
 *
 * A bound rather than a preference: this value arrives in a request body and is
 * written to Secret Manager, so an unbounded one is a way to make us store an
 * arbitrary amount of somebody else's data. Real Fly tokens are a few hundred
 * characters, so this refuses only what cannot be one.
 */
const MAX_TOKEN_LENGTH = 4096

/**
 * The Secret Manager id holding one caller's Fly config.
 *
 * Keyed by uid for the same reason `egressSecretId` is: a name holds one value
 * per project, so the caller's identity IS the namespace -- there is no list to
 * enumerate and no way to read a config without already knowing whose it is.
 * @param {string} uid The verified caller uid.
 * @return {string} The bare secret id, for `upsertSecretValue`.
 */
export const computeSecretId = (uid: string): string =>
  `${COMPUTE_SECRET_PREFIX}${uid}`

/**
 * Which Fly organization pays for this caller's machines.
 *
 * This is the value the billing path reads, and it is the whole reason the
 * setting exists. A caller running on their own Fly organization pays Fly
 * directly, so charging them our compute rate on top would bill the same
 * machine twice. `platform` means the cost is ours to pass on; `byo` means it
 * is not ours to bill at all.
 */
export type ComputeSource = "platform" | "byo"

/** A caller's Fly identity. Holds the one credential this axis has. */
export interface FlyTenantConfig {
  /** The Fly app machines are created in. */
  app: string
  /** A DEPLOY token scoped to `app`. Never projected outward. */
  token: string
  /** Fly region, or `""` to let the provider choose. */
  region: string
}

/** What a caller sees of their own compute. No credential in any field. */
export interface ComputeSettingsPublic {
  /** `byo` when the caller runs on their own Fly organization. */
  mode: "platform" | "byo"
  /** The value a bill reads. `platform` unless `mode` is `byo`. */
  computeSource: ComputeSource
  /** A presence bit, never a prefix, a length or a masked tail. */
  hasCredentials: boolean
  /** Their app name, echoed so they can confirm WHICH one. Empty on platform. */
  app: string
  /** Their region, empty when unset. */
  region: string
}

/** What a caller with no document at all has. */
export const DEFAULT_COMPUTE: ComputeSettingsPublic = {
  mode: "platform",
  computeSource: "platform",
  hasCredentials: false,
  app: "",
  region: "",
}

/**
 * A validated write.
 *
 * Clearing is its own mode rather than an empty config, for the reason
 * `EgressWrite` gives: `mode` is stated rather than inferred, so a typo cannot
 * silently move a caller off their own organization.
 */
export type ComputeWrite =
  | { mode: "platform" }
  | { mode: "byo"; app: string; token: string; region: string }

/** The outcome of validating a write body. */
export type ComputeValidation =
  | { ok: true; write: ComputeWrite }
  | { ok: false; reason: string }

/**
 * The resolved answer to "whose Fly organization runs this caller's machines?".
 *
 * Three states rather than an optional config, because `undefined` cannot tell
 * "not configured" apart from "configured but broken" -- and those want
 * opposite behaviour. See `computeFrom`.
 *
 * `unusable` carries NO source, which is deliberate: `computeSourceOf` returns
 * null for it, so a billing path cannot obtain a source for a caller whose
 * config did not resolve. The type makes "refuse before you bill" the only way
 * to write it, rather than a rule someone has to remember.
 */
export type ComputeResolution =
  | { kind: "platform" }
  | { kind: "tenant"; config: FlyTenantConfig }
  | { kind: "unusable" }

/**
 * One caller's Fly config as the secret payload.
 *
 * The object wrapper matches `WEBRAIN_CONFIG` and the egress pool, so every
 * secret this platform writes is the same shape and a reader who knows one
 * knows the rest.
 * @param {FlyTenantConfig} config The validated config.
 * @return {string} The JSON payload for Secret Manager.
 */
export const serializeFlyTenant = (config: FlyTenantConfig): string =>
  JSON.stringify({
    app: config.app,
    token: config.token,
    region: config.region,
  })

/**
 * Validate a write body: `{mode:"platform"}` to clear, or
 * `{mode:"byo", app, token, region}` to set.
 *
 * Every failure names a REASON and never echoes the value it rejected. A
 * message quoting the input would put a deploy token in the response body and
 * the log at the same time.
 * @param {unknown} input The raw request body.
 * @return {ComputeValidation} The validated write, or why it was refused.
 */
export const validateComputeInput = (input: unknown): ComputeValidation => {
  const record = input && typeof input === "object" ?
    (input as {
        mode?: unknown
        app?: unknown
        token?: unknown
        region?: unknown
      }) :
    {}

  if (record.mode === "platform") {
    return { ok: true, write: { mode: "platform" } }
  }

  if (record.mode !== "byo") {
    return {
      ok: false,
      reason: "mode must be \"byo\" or \"platform\"",
    }
  }

  const app = typeof record.app === "string" ? record.app.trim() : ""

  if (!FLY_APP_PATTERN.test(app)) {
    return {
      ok: false,
      reason: "app must be a Fly app name",
    }
  }

  const token = typeof record.token === "string" ? record.token.trim() : ""

  if (token.length === 0) {
    return { ok: false, reason: "token is required" }
  }

  if (token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "token is too long" }
  }

  // The outbound request sets this token as `Authorization: Bearer <token>`.
  // A line break in it is how a caller appends headers to a request we make --
  // refused rather than stripped, because a token that had to be repaired is
  // not the token they minted, and failing loudly is the only way they learn
  // that. Only CR and LF are matched: those are what end a header, whereas a
  // NUL cannot separate one and a rule that rejected it would be theatre.
  if (/[\r\n]/.test(token)) {
    return { ok: false, reason: "token must not contain line breaks" }
  }

  const region = typeof record.region === "string" ? record.region.trim() : ""

  if (region.length > 0 && !FLY_REGION_PATTERN.test(region)) {
    return {
      ok: false,
      reason: "region must be a three-letter Fly region code",
    }
  }

  return { ok: true, write: { mode: "byo", app, token, region } }
}

/**
 * The config out of a stored payload, or null when it is not usable.
 *
 * Re-validated on the way OUT rather than trusted because it was validated on
 * the way in, for the reason `parseEgressPool` gives: the secret can be edited
 * by an operator, restored from a backup, or written by an older revision with
 * different rules. A stored value is input like any other, and this one decides
 * whose Fly organization we are about to act on.
 * @param {unknown} raw The secret payload as read.
 * @return {FlyTenantConfig | null} The usable config, or null.
 */
export const parseFlyTenant = (raw: unknown): FlyTenantConfig | null => {
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
    (parsed as Record<string, unknown>) :
    {}

  // Through the SAME validator the write path uses, with `mode` supplied
  // because a stored payload does not carry one. That is the point: this is a
  // second caller of the rules rather than a second copy of them that drifts.
  const check = validateComputeInput({
    app: record.app,
    token: record.token,
    region: record.region,
    mode: "byo",
  })

  if (!check.ok || check.write.mode !== "byo") {
    return null
  }

  return {
    app: check.write.app,
    token: check.write.token,
    region: check.write.region,
  }
}

/**
 * Whose organization a request should act on, given what the document held.
 *
 * The fail-closed rule is the point of this function, and it is the same rule
 * `egressFrom` applies for the same reason. A caller who brought their own Fly
 * organization did so to stop paying us for compute. Falling back to the
 * platform identity when their config is unreadable would do the exact opposite
 * of what they configured -- and worse than for egress, it would create their
 * machines in OUR organization and bill US for them, while they believe the
 * work landed on their own account.
 *
 * `undefined` and `null` therefore mean opposite things and must not be
 * conflated: `undefined` is "no pointer, use the platform" and `null` is "there
 * IS a pointer and it did not resolve".
 * @param {FlyTenantConfig | null | undefined} config The config, or which
 * absence.
 * @return {ComputeResolution} The identity to act as, or the refusal.
 */
export const computeFrom = (
  config: FlyTenantConfig | null | undefined
): ComputeResolution => {
  if (config === undefined) {
    return { kind: "platform" }
  }

  if (config === null) {
    return { kind: "unusable" }
  }

  return { kind: "tenant", config }
}

/**
 * The value a bill reads.
 *
 * Null means "there is no source to bill", which is exactly the unusable case.
 * Returning `platform` there would be the double-bill this whole axis exists to
 * prevent, and the caller would have no way to notice.
 * @param {ComputeResolution} resolution The resolved identity.
 * @return {ComputeSource | null} What to bill for, or null to refuse.
 */
export const computeSourceOf = (
  resolution: ComputeResolution
): ComputeSource | null => {
  if (resolution.kind === "unusable") {
    return null
  }

  return resolution.kind === "tenant" ? "byo" : "platform"
}

/**
 * The resolution as a caller may see it.
 *
 * An unusable config reads as `byo` with no credential and no app, which is the
 * honest description of a pointer that did not resolve -- and it is the same
 * condition `computeFrom` refuses on, so the UI can say "configured, but not
 * usable" rather than showing a caller's own organization as switched off.
 * @param {ComputeResolution} resolution The resolved identity.
 * @return {ComputeSettingsPublic} A body with no credential in it.
 */
export const toPublicCompute = (
  resolution: ComputeResolution
): ComputeSettingsPublic => {
  if (resolution.kind === "unusable") {
    return {
      mode: "byo",
      computeSource: "byo",
      hasCredentials: false,
      app: "",
      region: "",
    }
  }

  if (resolution.kind === "tenant") {
    return {
      mode: "byo",
      computeSource: "byo",
      hasCredentials: true,
      app: resolution.config.app,
      region: resolution.config.region,
    }
  }

  return DEFAULT_COMPUTE
}
