# Decisions

This document explains the reasoning behind the implementation in `src/`. The "what" of the API
lives in `API_DESIGN.md`; this is the "why."

## System invariants

These are the properties the implementation is built to guarantee, regardless of retries,
concurrent requests, or interleaved operations:

1. **Inventory never goes negative.** `product.availableInventory >= 0` at all times.
2. **A cart is checked out at most once.** `open -> checked_out` is a one-way transition.
3. **A checkout retry never creates a second order or double-charges inventory.** Same
   `Idempotency-Key` + same cart always returns the original outcome.
4. **A coupon is redeemed at most once, and only by the customer it was issued to.**
5. **A coupon is never lost or consumed by a checkout that ultimately fails** (payment decline,
   or losing a race for the coupon itself).
6. **Exactly one coupon is generated per customer per unrewarded milestone** — never zero once
   eligible, never two for the same milestone.
7. **An order is self-describing.** Its totals and line items are computed from data snapshotted
   at checkout time, independent of later changes to the product catalog.
8. **Discount math is deterministic and the order total is never negative.**
9. **The admin report reconciles with the underlying orders/coupons by construction**, and reading
   it never mutates state.

Every concurrency test in `src/test/` exists to exercise one of these under a real race, not just
a sequential happy path.

## Ambiguities and the semantics chosen

The assignment/brief left several things unspecified. Resolved as follows:

- **Cart item pricing over time** — not specified whether a cart "locks in" the price it saw when
  an item was added. Chosen: **no** — the cart always shows live product price/availability, and
  the only snapshot happens at checkout (onto the order). See Decision 1.
- **Coupon milestone scope** — global store counter vs. per-customer counter. Chosen:
  **per-customer** (every customer's own Nth successful order), per explicit direction during
  design. See Decision 2.
- **Admin coupon generation: one customer or a batch job?** Chosen: **one `customerId` per call.**
  See Decision 2.
- **What "already generated for this milestone" means as an error** — chosen to **not** treat it
  as a state distinct from "milestone not reached": the atomic read-check-write in
  `CouponService.generateForCustomer` makes it structurally unreachable as a separate case (once a
  milestone is rewarded, `lastRewardedMilestone` has already advanced past it), so one error code,
  `MILESTONE_NOT_REACHED`, covers both.
- **Merge vs. reject when adding an already-present product to a cart.** Chosen: **merge**
  (quantity accumulates), with the inventory check applied to the new total — simpler UX than
  forcing a client to read-then-update.
- **Idempotency-Key replay of a failure.** Chosen: a failure (e.g. `PAYMENT_DECLINED`) is cached
  against the key exactly like a success, and replays return the same failure rather than
  re-attempting. A client that wants a genuine new attempt (e.g. after fixing a payment method)
  is expected to mint a new key — this mirrors how Stripe's idempotency keys behave, and avoids
  silently double-charging on a naive retry loop.
- **Coupon expiry.** Not modeled — coupons don't expire, only single-use is enforced. Not
  specified either way; simplest defensible choice within scope.
- **Administrator authentication.** Not implemented, per the assignment's explicit scope note.
  Admin operations are only distinguished by living under `/admin/*`.

## Material design decisions

## Decision 1: Live pricing vs. price snapshot on add-to-cart

**Context:** A cart item can sit for a while before checkout, during which the product's price or
stock could change. Need to decide what the cart "means" — a quote, or a live view.

**Options considered:**
- Snapshot price/availability at the moment an item is added, and show that frozen value on the
  cart until checkout.
- Always show live product state; only checkout fixes anything in place.

**Choice:** Live pricing until checkout. The cart never stores a price; `CartItem` is just
`{productId, quantity}`. `GET /carts/:id` computes `unitPriceCents`/`lineTotalCents` from the
current `Product` on every read.

**Why:** Checkout is the actual point of commitment — that's where "the price" should be decided,
not an arbitrary earlier moment. It also avoids a whole class of bugs around reconciling a stale
snapshot with reality (what does "price changed" even mean to a customer who hasn't paid yet?).
Simplicity was a real factor too: no snapshot means no snapshot-invalidation logic.

**Consequences:** A cart's displayed total can change between views without any user action,
which is fine because nothing is charged until checkout. It also means there's no basis for a
"price changed since you added this" UI hint — I drafted one into the early API design
(`priceChanged`/`availabilityWarning` flags) and removed it once I actually implemented the cart
service, because it contradicted having no snapshot to diff against.

---

## Decision 2: Per-customer coupon milestones, single-customer admin generation

**Context:** The spec says "every nth order gets a coupon" without saying whether "order" means
store-wide or per-customer, and the assignment brief later confirmed per-customer explicitly.

**Options considered:**
- Global counter: the store's Nth successful order (across all customers) unlocks one coupon.
- Per-customer counter: each customer's own Nth successful order unlocks a coupon for them.
- For admin generation specifically: one targeted `{customerId}` call vs. a batch "generate for
  everyone currently eligible" call.

**Choice:** Per-customer counters (`RewardCounter` keyed by `customerId`), and admin generation
takes a single `customerId` per call.

**Why:** Per-customer matches real loyalty-program semantics and was the explicit direction.
Single-customer generation reads closer to "an admin reviews and triggers this for a specific
case" than "run the whole reward job," and it's simpler to reason about under concurrency — one
customer's counter, not a table scan with its own race conditions.

**Consequences:** Introduced the need for a customer identity even without auth — `customerId` is
an opaque client-supplied string, unvalidated against any registry (there is none; auth is out of
scope). A coupon is now scoped to one customer and checkout must verify ownership, not just
validity. A batch "generate for all eligible customers" endpoint was considered but not built —
would be a small addition on top of the existing per-customer logic if needed later.

---

## Decision 3: Hand-rolled, Redis-inspired in-memory store instead of real Redis or a naive lock

**Context:** Needed a persistence + concurrency-control layer. The assignment explicitly allows
(and rewards reasoning about) an in-memory implementation.

**Options considered:**
- Embed real Redis via a client library, using `WATCH`/`MULTI`/`EXEC` or Lua scripts for atomicity.
- A single global mutex wrapping every store operation.
- A hand-rolled in-memory engine with two purpose-built primitives (see Decision 4).

**Choice:** Hand-rolled engine (`Database.exec()` + `AsyncLock`).

**Why:** Real Redis would delegate the exact reasoning this assignment evaluates to an external,
battle-tested engine instead of demonstrating it in code. A single global mutex would be
correct but serializes unrelated operations unnecessarily (e.g. two customers checking out
different carts for different products would block each other for no reason). The hand-rolled
engine costs a small amount of custom code but keeps the reasoning visible, adds zero external
setup for evaluators, and — because it leans on Node's single-threaded run-to-completion
semantics rather than a general-purpose lock — makes atomicity a property of the code's shape
(no `await` inside `exec()`) rather than something that can silently be forgotten.

**Consequences:** This does not generalize across multiple process instances (each has its own
memory) — that's an explicit, acknowledged limitation, not an oversight. See "Evolving to
multiple instances" below for the migration path.

---

## Decision 4: Two separate concurrency primitives, not one

**Context:** Checkout has a genuinely asynchronous step (the payment call). A purely synchronous
`exec()` block can't contain an `await`, so something else has to guard the part of checkout that
spans real async time — but a lock guarding one cart doesn't protect resources *shared* across
different carts (inventory, coupons).

**Options considered:**
- Optimistic: do the async payment call first (unguarded), then synchronously re-validate and
  commit, rejecting the commit if something changed underneath.
- A per-cart async lock (`AsyncLock.withLock`) held across the payment `await`, with the actual
  state mutation happening inside a synchronous `exec()` block once the lock is held.

**Choice:** Both, each solving a different race: `AsyncLock` on `cart:{cartId}` serializes
repeated/concurrent requests *against that one cart* (this is what makes idempotent retries cheap
— a queued duplicate finds the result already recorded and never re-touches payment). The
synchronous `exec()` commit is what actually prevents *cross-cart* corruption — two different
customers' carts, each holding their own cart lock, can still race for the same limited product
stock, and only the atomic commit stops that.

**Why:** The pure-optimistic option would let concurrent retries of the *same* cart both pay
before either commits, wasting a real payment call on a request that's going to lose anyway. The
lock avoids that by making the second request wait instead of racing. But a lock alone isn't
enough because it's scoped to one cart, not to the shared resources multiple carts contend for —
hence still needing the atomic commit underneath.

**Consequences:** Two mechanisms to reason about instead of one, but each has a narrow, specific
job, and both map cleanly onto real infrastructure later (Decision 3's consequences / the
multi-instance section).

---

## Decision 5: Reserve inventory before payment, roll back on failure

**Context:** Given checkout awaits a payment call, when should inventory actually be decremented —
before payment (optimistically) or only after payment succeeds?

**Options considered:**
- Decrement only in the post-payment commit. Risk: two carts could both pass payment for the last
  unit of stock, and one of them has to be told "you paid, but it's gone" — which either needs a
  refund flow or leaves a customer overcharged for nothing.
- Reserve (decrement) inventory synchronously *before* calling payment, and explicitly roll it
  back if payment is declined or the post-payment commit fails for any other reason.

**Choice:** Reserve-then-rollback.

**Why:** This is the same pattern real systems use for scarce, contested resources (e.g. a
concert-ticket hold) — decide who gets the resource *before* asking them to pay, not after. It
makes the "must not oversell" invariant airtight rather than probabilistic, and turns the failure
path into an explicit, tested code path (`rollbackReservation`) instead of an assumption.

**Consequences (original):** Coupon redemption was *not* given the same symmetric treatment at
first — a coupon was only atomically flipped to `redeemed` in the post-payment finalize step, not
reserved up front like inventory. That left one narrow race: two different carts of the *same*
customer, both holding a reference to the same coupon, could both pass the fake payment step
before only one of them won the final redemption — the loser rolled back its inventory, but its
"payment" had already gone through. This was initially deferred rather than fixed, on the
reasoning that no real money moves with the fake gateway.

**Update — closed:** on a follow-up pass specifically auditing for concurrency issues, this was
fixed rather than left deferred: `CouponStatus` gained a third state, `reserved`, and
`reserve()` now claims the coupon (`available -> reserved`) in the same atomic step that decrements
inventory, *before* payment is ever called. A losing concurrent checkout is now rejected at
`reserve()` — before it calls payment at all — instead of being accepted, paid, and rolled back at
`finalize()`. `rollbackReservation()` restores the coupon to `available` symmetrically with how it
restores inventory. Verified with a regression test (`checkoutService.test.ts`, "rejects a losing
concurrent checkout for a shared coupon before it ever calls payment") asserting the payment
gateway is called exactly once across two racing checkouts, where it was previously called twice.

The same pass also found and fixed a second, related bug: `reserve()`'s original single-pass loop
validated and mutated each cart item in the same iteration, so a cart with item 1 valid and item 2
invalid (e.g. insufficient stock) would decrement item 1's inventory and *then* throw on item 2 —
leaking a decrement with no rollback, since the call site didn't wrap `reserve()` in a try/catch
(it didn't need to, on the assumption that "pure validation failures mutate nothing," which this
violated for any cart with more than one item). Fixed by splitting `reserve()` into two passes:
validate every item and the coupon first, mutate nothing; only decrement/reserve once every check
has passed. Verified with a regression test asserting a first, valid item's inventory is untouched
when a later item in the same cart fails.

---

## Decision 6: Money as integer cents, discount computed with `floor`

**Context:** "Calculate money without floating-point rounding errors," and discount percentages
need a deterministic, never-negative result.

**Options considered:**
- IEEE-754 floats with rounding applied at display time.
- An arbitrary-precision decimal library.
- Integers representing minor currency units (cents) throughout.

**Choice:** Integer cents everywhere (`unitPriceCents`, `subtotalCents`, etc.).
`discountCents = floor(subtotalCents * discountPercent / 100)`,
`totalCents = max(0, subtotalCents - discountCents)`.

**Why:** Integer arithmetic in JS is exact for the magnitudes involved here, so this gets
exactness for free without adding a dependency. `floor` for the discount and `max(0, ...)` for the
total make two of the invariants (deterministic discount, never-negative total) true by
construction rather than by validation — there's no code path that could produce a negative total,
because the subtraction is clamped at the point it happens.

**Consequences:** Every API consumer needs to know amounts are integer minor units, not dollars —
documented in `API_DESIGN.md`. There's no support for sub-cent discount precision, which is fine
since coupons are whole-percent.

---

## Decision 7: Exceptions-based error model (`AppError`) over a schema-validation library

**Context:** The spec wants "errors that are distinguishable and useful to an API client," and
validated request input, without prescribing an implementation approach.

**Options considered:**
- A schema-validation library (e.g. zod) at the HTTP boundary, generating structured errors
  automatically from a declared schema.
- A typed `AppError` class (`code`, `httpStatus`, `message`, `details`) thrown by the domain
  services themselves, caught by one central Express error-handling middleware.

**Choice:** `AppError` + manual validation helpers (`requireString`, `requireNumber`) at the HTTP
boundary; services throw `AppError` for every business-rule violation.

**Why:** Putting validation/error semantics in the service layer (not just the HTTP layer) means
the services are fully testable — and were tested — without any HTTP plumbing at all (see
`cartService.test.ts`, `checkoutService.test.ts`), while the HTTP layer still gets a consistent,
typed error contract for free via one error-handling middleware. Given the explicit scope/timebox
in the brief, a full schema library felt like solving a problem (deep nested request validation)
this domain doesn't really have — every request body here is 1-2 flat fields.

**Consequences:** Request validation is manual and minimal rather than schema-driven — acceptable
for this domain's shape, but wouldn't scale to a much larger request surface without revisiting.
The error `code` string is the stable contract (used directly in tests and meant for API clients),
independent of the human-readable `message`.

## Transaction, concurrency, and idempotency strategy

Fully described in `API_DESIGN.md` ("Concurrency and idempotency strategy" / "Store engine"
sections) and implemented in `src/store/Database.ts`, `src/store/AsyncLock.ts`, and
`src/services/checkoutService.ts`. Summary: `Database.exec()` is a synchronous atomic-commit
primitive (no `await` inside it, so Node's run-to-completion guarantee makes it uninterruptible);
`AsyncLock.withLock()` is a per-key async mutex for critical sections that must span real async
work. Checkout combines both in a reserve → pay → finalize flow (Decisions 4 and 5). Idempotency
is a side effect of the lock: a queued duplicate request finds its key's outcome already recorded
once it acquires the lock, and replays it without redoing any work.

## Money and rounding rules

See Decision 6. Integer cents throughout; discount is `floor`ed; total is clamped at zero.

## Error-model choices

See Decision 7. Every error response is `{"error": {"code", "message", "details?"}}`; `code` is
the stable, tested contract. Full endpoint-by-endpoint error/status mapping is in `API_DESIGN.md`.

## What was implemented vs. deferred

**Implemented:** full cart lifecycle, live pricing, checkout with idempotency and symmetric
inventory + coupon reservation/rollback (see Decision 5's update — the coupon race originally
called out as accepted was subsequently closed, along with a separate partial-mutation bug found
in the same pass), per-customer coupon milestones and redemption, admin coupon generation and a
reconciling read-only report, a fake-but-asynchronous-and-fallible payment abstraction, a
consistent HTTP error contract, and 42 tests covering the concurrency scenarios the assignment
calls out by name (oversell races, idempotent retries, coupon-redemption races, payment-decline
rollback, and the two regression tests added for the fixes above).

**Deferred, and why:**
- **Real persistence / multi-instance support** — out of scope per the assignment ("in-memory
  implementation is acceptable"); migration path is documented below rather than built.
- **Authentication/authorization** — explicitly out of scope per the assignment.
- **Schema-validation library, request pagination, rate limiting, structured logging** — the
  domain's request surface didn't justify the added dependency/complexity within scope; noted as
  the kind of thing that would matter at a larger scale.
- **Coupon expiry, order cancellation/refunds, admin order listing** — not specified by the
  assignment; no invariant depends on them.

## Evolving to multiple instances and a production database

The two concurrency primitives were deliberately designed to have a direct production analog, so
this isn't a rewrite:

- **`Database.exec()` blocks** → either a relational DB transaction with row-level locking
  (`SELECT ... FOR UPDATE`) or optimistic concurrency (a `version` column checked in the `WHERE`
  clause, retried on conflict), or — staying closer to the current design — a Redis Lua script
  (Lua scripts are atomic in Redis the same way `exec()`'s callback is atomic in one Node process).
- **`AsyncLock.withLock()`** → a real Redis distributed lock: `SET lock:{key} token NX PX ttl`,
  released by a Lua script that only unlocks if the token still matches (the standard pattern
  behind Redlock), which is what actually generalizes "only one holder at a time" across multiple
  app processes instead of one.
- **Idempotency records** would move from an in-memory map to a real table/Redis hash with a TTL,
  since they currently live forever in process memory.
- **The report** would very likely need to stop being computed live over every order once order
  volume grows — at that point it becomes a materialized/aggregated view (updated on order
  write, or recomputed on a schedule) rather than a full scan on every request; the current "derive
  live, reconcile by construction" approach is a small-scale-appropriate choice, not a permanent one.
- Multiple app instances would also mean seed data and configuration (`n`, `x`) need to live in
  the shared store/config service rather than being process-local, which they already
  conceptually are (`config.ts` reads from environment variables) but would need to be centrally
  managed rather than per-instance environment variables in a real deployment.

## How AI tools were used

This service was built collaboratively with Claude (Claude Code) across the whole session — API
design, the concurrency architecture, the service implementations, the HTTP layer, and this
document were all produced through an interactive back-and-forth, not generated in one shot and
accepted as-is.

**A concrete example of materially redirecting AI output:** during API design, when asked how the
coupon system should work, the AI's first proposal treated the reward milestone as a *store-wide*
counter — "every Nth order overall gets a coupon" — with a single global coupon becoming available
per milestone. That's a reasonable reading of the original one-line spec ("every nth order gets a
coupon"), but it was corrected during design: coupons needed to be **per-customer** ("if a
customer completed n transactions, they get x% off"). This wasn't a small tweak — it changed the
data model (needed a `customerId`-scoped `RewardCounter` and `Coupon` instead of a single global
counter), the admin-generation endpoint's shape (targets one customer, not a global trigger), and
the checkout validation logic (coupon ownership check). The AI then proposed two ways to shape the
admin-generation endpoint around that correction (single-customer vs. batch-generate-for-everyone)
and a choice was made between them (single-customer) — see Decision 2.

A second, smaller instance was the AI catching its own earlier design drift rather than being
externally corrected: the API design draft had included `priceChanged`/`availabilityWarning`
fields on the cart view (a "this price changed since you added it" hint), which directly
contradicted the already-agreed "live pricing, no snapshot" decision (Decision 1) — there is
nothing to diff against if nothing was ever snapshotted. This was caught and removed while
implementing `CartService`, with `API_DESIGN.md`/`openapi.yaml` corrected to match.

## What I'd examine first with another two hours

(The coupon-reservation race and the reserve() partial-mutation bug, originally the top item here,
were found and closed in a later pass — see Decision 5's "Update — closed." What's left:)

1. **A real persistence prototype** — swap `Database` for a thin adapter over SQLite or Postgres
   to validate that the `exec()`/lock seams actually translate as cleanly as claimed above, rather
   than taking that on faith.
2. **Request validation** — replace the manual `requireString`/`requireNumber` helpers with a
   schema library if the request surface were to grow past its current handful of flat fields.
3. **Observability** — structured request logging and a correlation ID per request, useful for
   debugging idempotency-key replay behavior in particular.
4. **A targeted audit for the same class of bug elsewhere** — the `reserve()` partial-mutation bug
   was a "loop that both validates and mutates" shape; worth specifically checking whether any
   other multi-step mutation in the codebase shares that shape rather than assuming this was the
   only instance.
