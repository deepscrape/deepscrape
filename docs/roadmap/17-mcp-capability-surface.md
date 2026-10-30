# 17 — The MCP capability surface

Status: **plan, not built.** Written 2026-10-15. Branch `next`.

This is the answer to two questions that turned out to be the same question: *"can users add plugins
and skills?"* and *"should we embed the GitHub Copilot SDK instead of building our own chat?"*

## The decision

**Publish the platform's tools as an MCP server, and let the customer's own agent be the client.**
Their Copilot, their Claude Desktop, their script — anything that speaks MCP. We expose capability;
we never run their agent.

Explicitly **not**: embedding an agent runtime (Copilot, Codex, anything) inside our chat as the
model loop.

## Why not embed an agent runtime — the Copilot SDK, measured 2026-10-15

Source: `github/copilot-sdk` (`github/copilot-agent-runtime`), v1.0.22, MIT, "generally available".

| Fact | Value |
|---|---|
| Shape | `Your App → SDK Client → JSON-RPC → Copilot CLI (server mode)`; the SDK manages the CLI process |
| UI | **none** — it is a headless runtime, so it cannot replace a chat component at all |
| Node floor | `^20.19.0` or `>=22.12.0`; the CLI ships as a bundled platform package |
| Default tools | *"the Copilot CLI's first-party tools, similar to running the CLI with `--allow-all`"* |
| Billing | *"each prompt being counted towards your usage allowance"* |
| Auth | GitHub OAuth, GitHub App token, env vars, or BYOK (key-based only — **no Entra ID, no managed identity**) |
| Multi-user | `mode: "empty"` is documented as "multi-user server mode"; skills stay **disabled** there until `enableSkills: true` |

Four blockers, any one of which is sufficient:

1. **Default posture is the opposite of ours.** Out of the box it exposes a shell-capable coding
   agent. Our catalogue deliberately excludes `eval`-class and long-running tools, and the chat now
   parks a write behind an approval click. Adopting this means whitelisting a coding agent back down
   until it resembles what we already have.
2. **The entitlement model doesn't fit a product.** Prompts draw on a Copilot allowance, so either
   every customer needs their own Copilot subscription, or you go BYOK — in which case the SDK is an
   agent loop over keys we already proxy through eleven `paidOrByok` routes, at the cost of a bundled
   CLI. Nothing is gained.
3. **It breaks I2 in a new place.** Infinite sessions persist a workspace to disk
   (`~/.copilot/session-state/{id}/`) and the CLI is a child process. Cloud Run is ephemeral and
   scales to zero; one long-lived CLI hosting several tenants' sessions is the same shape I2 forbids
   for browsers — a process another tenant can reach.
4. **It cannot be our UI**, which was the original ask.

**Worth keeping from it as prior art:** `onPreToolUse` returns `allow | deny | **ask**`, which is the
tri-state our `requiresConfirm` already implements, and `skillProvider` serves skills from *your own
database* rather than `SKILL.md` files. Those are the two ideas here that are actually good, and we
have the first one already.

## Where the pieces already are

- **webrain** ships MCP over HTTP and is **live** at `https://mcp.deepscrape.dev` (`GET /mcp` → 401,
  token-gated). This is an *engine-level* surface.
- **arachnefly** has `POST /machine/mcp/:id` (14 routes) behind the same
  `MachineOwnershipMiddleware`, forwarding the **machine's own** `WEBRAIN_HTTP_TOKEN`, refusing a
  suspended machine with 409 and a tokenless one with 503.
- **ADR-2026-09** already plans container-per-tenant.
- **`webrain-tools.domain.ts`** already carries the three gating axes: tier, exclusivity, ownership.
- The chat's **`AI_TOOLS`** catalogue plus the `requiresConfirm` seam exist and are spec'd.

**What is missing:** an MCP server that exposes the **platform's** tools with the **caller's**
authorization. Every MCP surface today is engine-level and scoped to one leased machine. There is no
surface that says "list my sessions", "run my crawl", "read my storage" over MCP.

## The shape

- **One Streamable HTTP endpoint** on the BFF: `/api/mcp`, next to the existing route table.
- **Auth: a platform-issued token** presented by the MCP client, resolving to a uid. Every tool maps
  onto the **same `guard([...])` predicates the REST routes already use**, so MCP is an alternate
  *transport*, not a second implementation. One table, two callers — the property that stops the two
  surfaces drifting about who may do what.
- **The tool list comes from `AI_TOOLS`**, the same array the chat offers, so chat and MCP cannot
  disagree about what exists.
- **`requiresConfirm` becomes `annotations.destructiveHint`** on the MCP tool, so a conforming client
  prompts its own user.

**The honest limitation, and it is the whole reason phase 1 is read-only:** MCP tool annotations are
**advisory**. A client may ignore them. We cannot enforce a server-side approval over MCP the way the
chat enforces one over its own seam. Therefore the *route guards* remain the only real control, and
write tools ship only after metering is proven.

## Phases

1. **Token + read-only subset.** `search`, `serp`, `scrape`, `guide`, `list_sessions`, `list_storage`,
   `list_machines` — the seven `AI_TOOLS` entries that already change nothing. No new trust boundary:
   same guards, same refusals. Acceptance: `tools/list` returns exactly `availableTools()` names.
2. **Metering parity.** Every MCP call must hit the same credit path as the equivalent REST route. If
   it does not, MCP is a free side door around the wallet, and that is the failure mode to design
   against *before* exposing anything billable.
3. **Write tools**, annotated destructive, only after (2) is proven and only the stopping-direction
   ones — the same blast-radius rule `15` applies to the chat.
4. **Container-per-tenant** for expensive or graph-shaped tools, reusing ADR-2026-09's decision
   rather than inventing a second isolation story.

## Anti-goals — never

- **No `eval`-class tools**, and no arbitrary code execution in our process. The agent runs on *their*
  machine; that is the entire point of the inversion.
- **Never `set_ai_key` as a tool.** A key in a tool argument is a key in the caller's transcript and
  in their vendor's logs.
- **No silent reuse of a pooled browser worker.** The exclusivity axis is not negotiable because the
  caller brought their own agent.

## What this does NOT claim

- It does not give us server-side approval enforcement over MCP.
- Tool annotations are advisory, not a control.
- A token is not a scope — the route guards are the scope.
- Tenant isolation here is exactly what the REST surface already provides, no better.
- It does not make the chat's own gaps disappear. Persistence, stop, retry and provenance are chat
  work, tracked separately.

## Why this also answers the plugins question

User-authored plugins need a sandbox we do not have: in this codebase a tool *is* an entry in
`AI_TOOLS` plus a `dispatch` case, and there is no boundary between that array and a request issued
with the signed-in user's token. Since tools and instructions are shared per workspace, one member
authoring a plugin creates a path where another member's credentials are exercised by it.

An MCP server inverts the dependency instead: **they compose our tools from their runtime.** Users get
the composability a plugin system promises, and our process gains no new execution surface.

External validation, found while researching this: `nexu-io/open-design` and `asorichetti/OpenDesign`
ship an **Open WebUI plugin plus an MCP endpoint** rather than a chat SDK, and
`OpenDesignlabs/Open-Design` is a Next.js app. None of them ships a chat library. They chose the same
inversion.

And GitHub's own default agrees with the caution: in `mode: "empty"` (multi-user server mode), skills
stay **disabled** until explicitly enabled. That is the same judgement `15` reached about shared
skills — arrived at independently.

## Plugins, agents, skills, custom MCP servers — one answer per word

Added 2026-10-30. The ask was "add plugins, agents, skills and custom MCPs to the chat". Four of the
five words name the same missing thing — a sandbox — so they get one table rather than four features.

| Ask | What it would take here | Verdict |
|---|---|---|
| **Plugins** (user-authored tools) | A sandbox, plus a boundary between `AI_TOOLS` and a request issued with the caller's token. Neither exists. Tools and instructions are shared per workspace, so one member's plugin runs on another member's credentials. | **Refused** — unchanged from the section above |
| **Skills** (user-authored instructions) | The same sharing problem one layer up: a skill is prompt text that reaches a model holding the caller's tool set and spend cap. `15` reached the same conclusion about shared write tools, independently | **Refused** for a shared workspace. A single-member workspace could have it; that is a separate decision, not a config flag |
| **Agents** (a named persona over a tool subset) | Cheapest of the five, and the only one that adds no capability: prompt text plus a **narrowed** tool list. Narrowing can only withhold, so it cannot widen the boundary. `availableTools(paid)` already returns the list a preset would filter | **Not refused, not built.** Presentation only, so it ranks below `26` P1 |
| **MCPs** — our tools to their runtime | Phases 1–4 below | **Adopted.** This is the direction that ships |
| **Custom MCPs** — their server as our tool source | An outbound connection to a caller-supplied URL, and tools whose code we do not control returning text into our model loop. Needs the SSRF guard, a per-user credential in the vault, and a ruling on whose spend the call lands on | **Not now.** It is the only one of the five that ADDS execution surface, and it needs phase 2's metering proof first |

The rule that decides all five: **a capability may only be added where the tool boundary still holds.**
That boundary is one function, `resolveToolCall(call, paid)`, applied before dispatch. A plugin or a
custom MCP server introduces a tool that function has never heard of, so the tool must first be
representable in `AI_TOOLS` — which is exactly what phase 1's acceptance criteria already require.

What would unblock custom MCP servers, in order: phase 2 (metering parity) proven; an SSRF ruling
recorded against `url-guard`; a credential path in the vault rather than a config field; and the same
`requiresConfirm` parking applied to any tool their server declares destructive. Until all four hold,
offering the feature would be selling a second execution surface with no metering and no approval.

**What shipped instead of the framework, 2026-10-30:** the chat now lists the tools it can actually
use, read from `availableTools(paid)` — the same array phase 1 must serve over `tools/list`. One
catalogue, two readers, so the panel and the MCP surface cannot disagree about what exists.

## Acceptance criteria

- `POST /api/mcp` answers `initialize`, `tools/list` and `tools/call`.
- `tools/list` returns exactly the names in `availableTools()`.
- A tool the caller's tier refuses returns the **same** refusal the REST route returns — asserted by
  calling both and comparing, not by reading the code.
- A metered MCP call appears in the credit ledger exactly once.
- `ruby`-style parity is not the test here: there is no second route table. The test is that the MCP
  surface imports the same guards and the same `AI_TOOLS`.
