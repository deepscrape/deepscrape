/* eslint-disable max-len */
/**
 * Guards the Functions dependency tree against the override that silently
 * broke every Cloud Functions deployment.
 *
 * The container installs its dependencies with Bun from `functions/bun.lockb`
 * (the `package-lock.json` sitting next to it is never consulted). Express 5
 * arrives through `@google-cloud/functions-framework` and pulls `router`, which
 * calls `pathRegexp.match(...)`. This project separately depends on express 4,
 * which needs `path-to-regexp@~0.1.12` - a major that has no `match` export.
 *
 * A bare `path-to-regexp` entry in `overrides` forces ONE version across the
 * whole tree. That collapses `router` onto 0.1.x and the container dies during
 * framework startup with `TypeError: pathRegexp.match is not a function`,
 * failing the Cloud Run healthcheck. The previous revision keeps serving, so
 * the only symptom is a rejected deploy.
 *
 * An override scoped to the parent (`router`) is safe: it can only remove
 * ambiguity. Both assertions below fail loudly if either side regresses.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {createRequire} from "node:module"
import {existsSync, readFileSync} from "node:fs"
import {join} from "node:path"

const functionsRoot = join(__dirname, "../..")
const routerLayer = join(functionsRoot, "node_modules/router/lib/layer.js")

type Manifest = {
  overrides?: Record<string, unknown>,
}

const readManifest = (): Manifest =>
  JSON.parse(readFileSync(join(functionsRoot, "package.json"), "utf8"))

describe("functions dependency tree", () => {
  it("never pins path-to-regexp with a bare override", () => {
    const {overrides = {}} = readManifest()

    assert.equal(
      overrides["path-to-regexp"],
      undefined,
      "a bare `path-to-regexp` override forces a single version tree-wide and breaks `router`; scope it to `router` instead",
    )
  })

  it("resolves a path-to-regexp that router can actually call", () => {
    assert.ok(
      existsSync(routerLayer),
      "router is not installed; run `bun install` in functions/ first",
    )

    const requireFromRouter = createRequire(routerLayer)
    const resolved = requireFromRouter.resolve("path-to-regexp")
    const pathToRegexp = requireFromRouter("path-to-regexp") as {match?: unknown}

    assert.equal(
      typeof pathToRegexp.match,
      "function",
      `router resolves ${resolved}, which has no callable .match - the container will fail its startup healthcheck`,
    )
  })
})
