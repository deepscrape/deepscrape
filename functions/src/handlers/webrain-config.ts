/* eslint-disable object-curly-spacing */
/**
 * The admin surface for the webrain configuration.
 *
 * Three routes: read the state, rotate the MCP token, replace the proxy pool.
 * All three sit behind `requirePermission("platform", ...)`, which admits only
 * a platform admin -- `authz.domain.ts` grants `platform` to no role, so the
 * only path through `canPerform` is the `isPlatformAdmin` short-circuit. There
 * is deliberately no second admin check here: a route that re-decided "is
 * admin" would be one more place for the answer to differ.
 *
 * What may leave this file
 * ------------------------
 * Never the token, never a proxy URL. The GET reports `hasToken` and each proxy
 * as a label plus a masked host. The POST validator names an index and a fixed
 * reason rather than the entry. The one deliberate exception is a token a POST
 * mints: a generated credential has to reach the operator once, in that
 * response, because installing it on the worker is out of band -- the worker
 * exposes no config endpoint this service can reach.
 *
 * Every write goes through `saveWebrainConfig`, which drops the store's 30s
 * cache, so the change is visible to the next request rather than to the next
 * deploy.
 */
import { Request, Response } from "express"
import {
  resolveTokenUpdate,
  toPublicConfig,
  toPublicProxies,
  validateProxyInput,
} from "../domain/webrain-config-admin.domain"
import {
  saveWebrainConfig,
  webrainConfigSource,
  webrainMcpToken,
  webrainProxyPool,
} from "../infrastructure/webrain-config.store"

/**
 * The error class name, never its message.
 *
 * A Secret Manager failure can quote the resource path, and the message is the
 * one field a credential could ride in -- so the log line names the operation
 * and the class only.
 * @param {unknown} error The thrown value.
 * @return {string} A safe label for the log.
 */
const errorLabel = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error

/**
 * `GET /api/webrain/config` -- the state an operator may see.
 *
 * The three reads share the store's in-flight promise, so a cold instance
 * resolves them with one Secret Manager access rather than three.
 * @param {Request} _req The request; the guard already ran.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const getWebrainConfig = async (
  _req: Request,
  res: Response
): Promise<void> => {
  try {
    const [token, proxies, source] = await Promise.all([
      webrainMcpToken(),
      webrainProxyPool(),
      webrainConfigSource(),
    ])

    const body = toPublicConfig({ mcpToken: token, proxies, source })
    res.status(200).json(body)
  } catch (error) {
    console.error("webrain-config: read failed:", errorLabel(error))
    res.status(500).json({ error: "internal", code: "internal" })
  }
}

/**
 * `POST /api/webrain/config/token` -- set or mint the MCP bearer token.
 *
 * A supplied token is stored and not echoed. A missing one is minted and
 * returned exactly once, here: the operator has to install it on the worker
 * themselves, so this response is the only time it is ever readable. The store
 * read after the write is what makes that true -- it repopulates the cache from
 * the secret rather than leaving it holding the value this request just made,
 * and the GET route reports only `hasToken` either way.
 * @param {Request} req The request carrying an optional `token`.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const setWebrainToken = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { token, generated } = resolveTokenUpdate(req.body)

  try {
    await saveWebrainConfig({ mcpToken: token })
    await webrainMcpToken()
  } catch (error) {
    console.error("webrain-config: token write failed:", errorLabel(error))
    res.status(500).json({ error: "internal", code: "internal" })
    return
  }

  if (generated) {
    res.status(200).json({ generated: true, token })
    return
  }

  res.status(200).json({ generated: false })
}

/**
 * `POST /api/webrain/config/proxies` -- replace the egress pool.
 *
 * The pool is replaced wholesale, as the brief requires: a partial update would
 * need an identity for an entry, and the entry's identity is a credential.
 * @param {Request} req The request carrying `{ proxies: [...] }`.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const setWebrainProxies = async (
  req: Request,
  res: Response
): Promise<void> => {
  const validation = validateProxyInput(req.body)

  if (!validation.ok) {
    // Index and fixed reason only -- the entry carries a credential.
    res.status(400).json({
      error: "bad_request",
      code: "bad_request",
      index: validation.index,
      reason: validation.reason,
    })
    return
  }

  try {
    await saveWebrainConfig({
      proxies: validation.proxies.map((entry) => entry.url),
    })

    const stored = await webrainProxyPool()
    res.status(200).json({
      poolSize: stored.length,
      proxies: toPublicProxies(stored),
    })
  } catch (error) {
    console.error("webrain-config: pool write failed:", errorLabel(error))
    res.status(500).json({ error: "internal", code: "internal" })
  }
}
