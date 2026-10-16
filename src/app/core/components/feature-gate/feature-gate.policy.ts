/**
 * The entitlement and permission contract for the app's run surfaces, in one table.
 *
 * Every entry mirrors a registration in `bff/api.ts`, which is the enforcement point.
 * Two independent axes are recorded, because they refuse for different reasons and
 * only one of them can be fixed by paying:
 *
 *  - `paid: true` mirrors `requirePaidAccess` (`paid`) and is the 402. The AI cores,
 *    `/api/crawl`, the job and seeder enqueues and the machine routes carry it.
 *  - `rbac` mirrors `requirePermission(resource, action)` and is the 403. Every route
 *    here carries `crawl.execute`, except the AI cores, which carry `ai.execute`.
 *
 * Keeping the axes apart is what makes the gate honest. A `viewer` in an org is
 * refused by RBAC; a free `self` user is refused by plan. An upgrade CTA is only
 * truthful for the second, because a plan does not grant execution rights.
 *
 * The free tier is free by PLAN, not by role. `/api/serp`, `/api/scrape`,
 * `/api/search`, `/api/extract`, `/api/pdf` and `/api/monitor/*` are registered with
 * `access` (free-resolving) plus `crawl.execute`, so a free account with the default
 * `self` role can use Search and Monitor. `viewer` grants `crawl.read` only, so a
 * viewer genuinely cannot use any of the six surfaces.
 *
 * Monitor is free because `MONITOR_MAX_PER_USER` (20) bounds it in the handler, not
 * because it is cheap: the limit protects the shared worker pool rather than revenue,
 * so no plan gate belongs in front of it.
 *
 * This module is a UX improvement and nothing more. It lets the UI say "you cannot
 * run this, and here is why" before a submit instead of after a 402 or a 403.
 * `bff/api.ts` remains the source of truth, and no route is made more permissive by
 * anything here.
 */

export type GateResource = 'ai' | 'crawl' | 'machine';
export type GateAction = 'execute' | 'read';

/** What one run surface needs before the backend will serve it. */
export type RunSurfaceRequirement = {
  /** The `requirePermission(resource, action)` pair the BFF route carries. */
  readonly rbac: { readonly resource: GateResource; readonly action: GateAction };
  /** Whether the route carries `requirePaidAccess`, i.e. 402s a free caller. */
  readonly paid: boolean;
  /** The `bff/api.ts` registration this mirrors, so the next reader can check it. */
  readonly source: string;
};

/** The playground's mode ids. The playground's own `modes` array must use these. */
export const PLAYGROUND_MODES = ['llm-scrape', 'crawl', 'seeder', 'search', 'monitor', 'tools', 'browser'] as const;
export type PlaygroundModeId = (typeof PLAYGROUND_MODES)[number];

export const RUN_SURFACE_REQUIREMENTS: Readonly<Record<PlaygroundModeId, RunSurfaceRequirement>> = {
  'llm-scrape': {
    rbac: { resource: 'ai', action: 'execute' },
    paid: true,
    source: 'POST /api/anthropic/messages, /api/openai/chat/completions, /api/groq/chat/completions',
  },
  crawl: {
    rbac: { resource: 'crawl', action: 'execute' },
    paid: true,
    source: 'POST /api/crawl',
  },
  seeder: {
    rbac: { resource: 'crawl', action: 'execute' },
    paid: true,
    source: 'POST /api/seeder/stream/job/multi-research',
  },
  search: {
    rbac: { resource: 'crawl', action: 'execute' },
    paid: false,
    source: 'POST /api/search, /api/serp, /api/scrape, /api/extract, /api/pdf',
  },
  monitor: {
    rbac: { resource: 'crawl', action: 'execute' },
    paid: false,
    source: 'GET /api/monitor/list, POST /api/monitor/create, /update, /delete',
  },
  tools: {
    rbac: { resource: 'crawl', action: 'execute' },
    // Left at the mode level rather than moved: FOUR of this mode's seven tools
    // are paid-only routes (`vision`, `batch`, `spider`, `watch`), so `true`
    // would gate the three free ones with them. The paid routes answer 402.
    paid: false,
    // All SEVEN routes the panel can call, not the three an earlier version of
    // this string claimed. The gate panel shows it, so an incomplete list is
    // a false statement about the mode.
    source:
      'POST /api/search, /api/extract, /api/pdf, /api/vision, /api/batch, ' +
      '/api/spider, /api/watch',
  },
  browser: {
    rbac: { resource: 'crawl', action: 'execute' },
    // NOT paid, and that is deliberate rather than an oversight. The routes carry
    // `access`, and `browser-sessions.ts` explains in its header that `paid` would
    // 402 a free caller before the tier table could answer. Free is not
    // "not entitled" here, so no upgrade CTA belongs in front of this mode.
    //
    // ONE exception, and it carries its own gate rather than moving this one:
    // `POST /api/browser/session/vault` is `paid`, because the vault is
    // process-global on the worker and `VAULT_TOOLS` puts those ops behind a
    // paid tier -- a free caller would be reading a vault it does not own. The
    // vault SECTION renders its own disabled + upgrade state; this mode-level
    // flag stays false so the lease panel is not gated along with it.
    paid: false,
    source: 'GET,POST /api/browser/session, POST /api/browser/session/:id/keepalive, POST /api/browser/session/:id/close, POST /api/browser/session/vault (paid)',
  },
};

/**
 * `/operations` is not a playground mode, but it enqueues on the same paid job
 * surface, so it shares the table rather than carrying its own copy of the rule.
 */
export const OPERATIONS_REQUIREMENT: RunSurfaceRequirement = {
  rbac: { resource: 'crawl', action: 'execute' },
  paid: true,
  source: 'POST /api/crawl/stream/job',
};

/** Why a surface is refused. `role-and-plan` needs both stated or the copy misleads. */
export type GateDenial = 'none' | 'role' | 'plan' | 'role-and-plan';

export type GateState = {
  readonly allowed: boolean;
  readonly denial: GateDenial;
  /** i18n key for the heading, or `null` when the surface is allowed. */
  readonly titleKey: string | null;
  /** i18n key for the explanation, or `null` when the surface is allowed. */
  readonly bodyKey: string | null;
  /** i18n key for the one line fragment shown next to a locked mode strip entry. */
  readonly hintKey: string | null;
  /** Whether the upgrade path actually addresses this denial. */
  readonly showUpgrade: boolean;
};

/**
 * What the caller currently holds.
 *
 * `permissions` is partial and a missing key is treated as `false`: an unknown
 * resource is not evidence of a right. The UI gate fails closed, the backend is
 * unaffected either way.
 */
export type RunSurfaceCapabilities = {
  readonly permissions: Partial<Record<GateResource, boolean>>;
  /** Mirrors `requirePaidAccess` resolving successfully on the route. */
  readonly paid: boolean;
};

/** i18n keys for an org role, shared so the label map has one copy. */
export const ORG_ROLE_LABEL_KEYS: Readonly<Record<string, string>> = {
  owner: 'SETTINGS_WORKSPACE.ROLE_OWNER',
  admin: 'SETTINGS_WORKSPACE.ROLE_ADMIN',
  member: 'SETTINGS_WORKSPACE.ROLE_MEMBER',
  viewer: 'SETTINGS_WORKSPACE.ROLE_VIEWER',
};

/**
 * Decide one surface.
 *
 * Role is checked first and owns the heading, because buying a plan cannot clear a
 * role denial. `showUpgrade` is therefore true only when the plan is the sole
 * blocker.
 *
 * @param requirement The surface's contract, from {@link RUN_SURFACE_REQUIREMENTS}.
 * @param capabilities What the caller holds right now.
 * @returns The gate state, including the copy keys to render.
 */
export function gateStateFor(
  requirement: RunSurfaceRequirement,
  capabilities: RunSurfaceCapabilities,
): GateState {
  const hasRole = capabilities.permissions[requirement.rbac.resource] === true;
  const hasPlan = !requirement.paid || capabilities.paid;

  if (hasRole && hasPlan) {
    return { allowed: true, denial: 'none', titleKey: null, bodyKey: null, hintKey: null, showUpgrade: false };
  }

  if (!hasRole) {
    return {
      allowed: false,
      denial: hasPlan ? 'role' : 'role-and-plan',
      titleKey: 'FEATURE_GATE.REQUIRES_ROLE_TITLE',
      bodyKey: hasPlan ? 'FEATURE_GATE.REQUIRES_ROLE_BODY' : 'FEATURE_GATE.REQUIRES_ROLE_AND_PLAN_BODY',
      hintKey: 'FEATURE_GATE.LOCKED_ROLE_HINT',
      // An upgrade does not grant execution rights, so offering one here would be a lie.
      showUpgrade: false,
    };
  }

  return {
    allowed: false,
    denial: 'plan',
    titleKey: 'FEATURE_GATE.REQUIRES_PLAN_TITLE',
    bodyKey: 'FEATURE_GATE.REQUIRES_PLAN_BODY',
    hintKey: 'FEATURE_GATE.LOCKED_PLAN_HINT',
    showUpgrade: true,
  };
}

/**
 * Every playground mode's state, built by iterating the table so a mode cannot be
 * gated in the template and forgotten here.
 *
 * @param capabilities What the caller holds right now.
 * @returns One state per mode id.
 */
export function playgroundGateStates(
  capabilities: RunSurfaceCapabilities,
): Record<PlaygroundModeId, GateState> {
  const states = {} as Record<PlaygroundModeId, GateState>;
  for (const mode of PLAYGROUND_MODES) {
    states[mode] = gateStateFor(RUN_SURFACE_REQUIREMENTS[mode], capabilities);
  }
  return states;
}
