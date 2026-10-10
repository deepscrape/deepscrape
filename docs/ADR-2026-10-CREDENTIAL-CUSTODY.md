# ADR-2026-10 — Credential custody: per-user, and why not per-organization

**Status:** Accepted — 2026-10-11
**Supersedes:** nothing. **Amends:** `ADR-2026-03-AUTHZ-REBAC-ABAC.md` (adds a resource it does not cover).
**Related:** `ADR-2026-10-BROWSER-SESSIONS.md`, `docs/roadmap/09-interactive-live-view-and-vault.md`.

## Context

The credential vault stores what lets a browser log itself in: a `state.json` per
`service` + `profile` (cookies plus localStorage), held by a worker, plus the
cookie pair as inline payload. A saved entry is, without qualification,
**somebody's login**.

Two pressures arrive together.

1. **Every enterprise buyer eventually asks for shared credentials.** A team
   wants one logged-in session for a paid account, so nobody re-solves a
   challenge five times a day. The obvious implementation is to move the vault
   from `users/{uid}/...` to an organization, so an org admin can see and share
   entries.
2. **The rest of the platform is already org-scoped.** Routes carry an org,
   `memberships` drives authz, and `/{orgId}/...` is canonical. A uid-scoped
   vault looks like an oversight rather than a decision.

The tempting answer is a retrofit: add `orgId` to a vault entry, grant an org
role read, and inherit the existing membership checks.

## Decision

**A saved credential belongs to the person who saved it.** The vault stays keyed
by uid. No organization role is granted any action on a vault entry — not read,
not list, not replay. A credential is never shared across uids by the platform.

An org may not read a member's vault even where it already holds administrative
authority over that member, and this is deliberately consistent with
`authz.domain.ts`, which grants no org role anything on the `account` resource:
an org admin has no consent from, and no visibility into, the rest of the
human's data.

If a customer needs shared credentials, that is **a separate org-vault resource
with its own consent and custody record** — not a widening of this one.

## Why the retrofit was rejected

**Sharing a credential is not an ownership change; it is a different custody
model with different liability.** The moment an org can read a member's saved
login, we hold — on behalf of an entity nobody individual consented to — the
ability to act as that person on a third-party service. Every member of the org
becomes a party who could have replayed it, and the dispute that follows cannot
be resolved from our records because the vault's purpose is to make the access
indistinguishable from the member's own.

**Consent cannot be inferred from membership.** Joining an organization is not
agreement that your bank session is now the organization's to read. Consent for
shared custody has to be recorded explicitly, at the moment of sharing, with the
entry named — which is exactly the resource that does not exist yet.

**The migration is the expensive part, and it is one-way.** Retrofitting after
customers exist means moving live credential records and deciding, per entry,
what an existing org membership now means. Getting that wrong is a disclosure
with nothing to revoke, because a session cookie cannot be un-leaked. Deciding
it while the table is empty costs nothing; the asymmetry is the whole argument
for deciding now.

## Consequences

- **An org cannot see, share, or transfer a member's vault entries.** Offboarding
  a member does not hand their credentials to the org; it purges them.
- **Erasure must actually reach them**, which is why the purge derives rather
  than reads: `accountSecrets` composes every per-uid Secret Manager id from its
  owning helper (a pointer on a subcollection document is deleted by the sweep
  and would strand the live credential), the vault index is a uid-scoped
  subcollection swept by `recursiveDelete`, and `purgeAccountBlobs` sweeps the
  caller's own hashed object namespace.
- **Offboarding is destructive by design.** A departing member's saved logins do
  not survive them, and recreating them is a human retry. This is the cost of the
  decision, accepted knowingly.
- **The vault carries no org authorization surface at all**, so it cannot be
  reached by a membership change, an invitation, or an ownership transfer.

## Reopening this decision

Only one condition: **a customer needs shared credentials.** Then the answer is a
new resource — an org vault — that records who consented, to which entry, and
when, and that is authorized separately from the personal vault rather than by
widening it. Retrofitting `orgId` onto the existing entries is not the answer and
should be rejected on sight, for the migration reason above.
