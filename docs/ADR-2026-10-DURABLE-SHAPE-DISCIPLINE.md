# ADR 2026-10: Durable shapes are validated at the store boundary, never versioned

- **Status:** accepted (2026-10-11)
- **Context:** `functions/src/infrastructure/*.store.ts`, `functions/src/app/cacheConfig.ts`

## The gap this closes

Eight stores read documents back out of Firestore, the blob layer reads payloads
back out of Tigris, and six call sites read caches out of Redis. Each parses
defensively, and none of them says what has to happen when a shape changes. The
unstated risk is not that a parser is wrong today -- it is that the next change
is made by whichever habit its author happens to have: add a `v` field and a
switch, or tighten the parser so it rejects what it does not recognise, which
silently breaks a rolling deploy.

## Decision

A stored shape is read by one build at a time, so it is **validated, not
versioned**:

1. A parser checks every field it hands back, and returns nothing when a
   required field is absent or the wrong type. Never a cast, never a partial
   record.
2. Unknown **fields** are ignored. This is what lets a newer build write a
   document that an older build is still reading during a deploy.
3. Unknown **enumeration values** fail closed. A value no branch can act on is
   not one this build may carry forward.
4. No `v`, no `schemaVersion`, no migration registry. There is nothing for one to
   do that rules 2 and 3 do not already do.

## Why rules 2 and 3 make a version field unnecessary

A version field answers one question: which of two shapes is this? The only
reasons to ask are to accept both, or to refuse one deliberately. Rule 2 accepts
both for the fields the reader knows; rule 3 refuses what no branch can act on. A
version adds a second thing to keep in step with the first -- and a failure mode
of its own, the parser that trusts `v` and casts the rest -- without changing
either answer.

## Changing a shape

- **Adding an optional field:** write it. Older readers ignore it, so no deploy
  order is needed.
- **Adding a value to an enumeration:** two-phase. Deploy the readers that accept
  it everywhere **first**, and only then write it. A writer that goes out first
  produces documents its own previous build drops, which reads as data loss.
- **Renaming, retyping or removing a field:** a migration, and a migration is a
  script under `functions/scripts/` reading Firestore directly. The parser's
  rejection is what makes a half-migrated collection visible: the store drops the
  rows it cannot read instead of preserving them as something wrong.

## Consequences

- A rejection is indistinguishable from a missing document in the logs, so a
  shape change lands as "rows disappeared" rather than as an error. Run the
  migration and the parser change together; do not tighten a parser to find
  stragglers.
- Caches need none of this. A cache entry is either usable or it is a miss, and
  both paths refetch from the source of truth, so `parseCachedJson` answers
  `null` rather than guessing.
- `monitor.store.ts` casts its documents instead of parsing them. Its two
  dangerous fields are clamped before use -- `clampIntervalMinutes`, and a parked
  `nextCheckAt` for a disabled monitor -- so the cast is a display concern today.
  It gets a parser when either of those stops being true.
- The lossy client-event queue is a separate, deliberate decision: it drops
  events by construction and may not be read for money. See the doc comment on
  `ANALYTICS_EVENTS_KEY`.

## Enforcement

`functions/src/domain/durable-shape.spec.ts` holds rules 2 and 3 against the
session parser, and the never-throw contract of the cache parser. A store that
gains a parser should gain its cases there.
