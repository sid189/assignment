# API Design — Checkout & Rewards Service

This document is the contract the implementation is built against. It captures the resource
model, endpoints, state machines, idempotency strategy, and error model, along with the
ambiguity resolutions agreed on before implementation started. Rationale for the choices below
(with alternatives considered) belongs in `DECISIONS.md`; this file is the "what," not the "why."

See also `openapi.yaml` for the machine-readable version of the same contract.

## Identity model

There is no authentication in this system (explicitly out of scope per the assignment). A
`customerId` is an opaque, client-supplied string (e.g. `"cust_42"`). It is not validated against
a customer registry — in a real system this would come from an auth token; here the caller
asserts it. Every cart, order, and coupon is scoped to a `customerId`.

There is no separate "administrator" auth either. Endpoints under `/admin/*` are the operations
this assignment calls administrative; they are unauthenticated in this implementation but are
clearly namespaced so authorization could be added at that boundary without changing the
domain logic.

## Money representation

All monetary values are **integers in minor units (cents)**, never floats. A `$19.99` price is
represented as `1999`. Discount percentages are integers (`0–100`). Discount amount is computed
as `floor(subtotalCents * discountPercent / 100)`, and total is `subtotalCents - discountCents`,
which is always `>= 0` by construction since `discountPercent <= 100`.

## Resources

### Product
| Field | Type | Notes |
|---|---|---|
| `id` | string | stable identifier |
| `name` | string | |
| `unitPriceCents` | integer | current live price |
| `availableInventory` | integer | current stock |

Products are read-only via the API (seeded at startup). No product-mutation endpoint is exposed —
out of scope for this assignment.

### Cart
| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `customerId` | string | required at creation |
| `status` | enum | `open` \| `checked_out` |
| `items` | CartItem[] | |
| `createdAt` | timestamp | |

### CartItem
| Field | Type | Notes |
|---|---|---|
| `productId` | string | |
| `quantity` | integer | `> 0` |

Cart items carry **no price snapshot**. Per the "keep live pricing until checkout" decision, the
cart view always re-reads current product price/inventory to compute display totals. The only
point where price and inventory become fixed is order creation.

### Order
| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `cartId` | string | |
| `customerId` | string | |
| `customerOrderSequence` | integer | this customer's Nth successful order (1-based) |
| `status` | enum | `placed` \| `failed` (see Order state machine) |
| `items` | OrderItem[] | snapshotted |
| `subtotalCents` | integer | sum of line totals, snapshotted prices |
| `discountCents` | integer | `0` if no coupon applied |
| `totalCents` | integer | `subtotalCents - discountCents` |
| `couponCode` | string \| null | coupon applied, if any |
| `createdAt` | timestamp | |

### OrderItem
| Field | Type | Notes |
|---|---|---|
| `productId` | string | |
| `productName` | string | snapshotted, survives later product renames |
| `unitPriceCents` | integer | snapshotted at checkout |
| `quantity` | integer | |
| `lineTotalCents` | integer | `unitPriceCents * quantity` |

Snapshotting name/price on the order is what lets the order "explain what the customer purchased
and how its total was calculated" even if the product catalog changes later.

### Coupon
| Field | Type | Notes |
|---|---|---|
| `code` | string | unique |
| `customerId` | string | coupon is scoped to one customer |
| `discountPercent` | integer | from config `x` |
| `milestoneOrderNumber` | integer | which of this customer's order-count multiples earned it (e.g. `5`, `10`, ...) |
| `status` | enum | `available` \| `redeemed` |
| `redeemedByOrderId` | string \| null | |
| `createdAt` | timestamp | |

### RewardCounter (internal, not directly exposed)
Per customer: `successfulOrderCount`, `lastRewardedMilestone`. Used to determine eligibility for
`/admin/coupons/generate` and to prevent generating two coupons for the same milestone.

## State machines

**Cart**: `open --[checkout succeeds]--> checked_out`. A `checked_out` cart is terminal — no
further item mutation or checkout is allowed on it.

**Order**: created directly as `placed` on a successful checkout (checkout either fully succeeds
and produces a `placed` order, or fails validation before any order is persisted — there is no
"pending" order state in this design, see `DECISIONS.md` for the payment-abstraction rationale).

**Coupon**: `available --[redeemed by a successful checkout]--> redeemed`. A coupon is only moved
to `redeemed` in the same transaction/commit as the order and inventory changes — a checkout that
fails validation or fails to commit must leave the coupon `available`.

## Concurrency and idempotency strategy (checkout)

Checkout is the one operation with a genuinely async step (a payment call — real or faked, see
`DECISIONS.md`), so it needs two independent mechanisms, each solving a different race:

1. **Per-cart async lock** — serializes repeated/concurrent requests *against the same cart*
   (retries, or two truly concurrent checkout calls for one cart). Acquired on `cart:{cartId}`
   and held across the awaited payment call, so a retry that arrives while the first attempt is
   still in flight simply queues behind it instead of re-running payment or racing the commit.
   This is what makes idempotency cheap: by the time a queued duplicate gets the lock, the
   original attempt has already recorded its result, so the duplicate just returns it.
2. **Synchronous atomic commit** — the actual state mutation (decrement inventory for every line
   item, mark the coupon redeemed, create the order, increment the customer's reward counter,
   flip the cart to `checked_out`) happens in one synchronous, non-interruptible block. This is
   what prevents *cross-cart* corruption — two different customers' carts, each holding their own
   cart lock, can still race for the same limited product stock or (less commonly) the same
   coupon, and the per-cart lock alone would not stop that. The synchronous commit does, because
   nothing else in the process can run mid-block, so inventory/coupon checks and their mutation
   are inseparable. See "Store engine" below.

`POST /carts/{cartId}/checkout` requires an `Idempotency-Key` header.

- First request with a given key: acquires the cart lock, processes normally, and the result
  (success or business-rule failure) is recorded against the key before the lock is released.
- A request with the same key that arrives while the first is still in flight: queues on the same
  cart lock, then — once it acquires the lock — finds the key already recorded and returns that
  stored response verbatim, without touching payment, inventory, or the coupon again.
- Replay with the same key after the first attempt has completed: same as above, served from the
  recorded result.
- Replay with the same key but a different `cartId` or body: `409 IDEMPOTENCY_KEY_CONFLICT`.
- Missing header: `400 IDEMPOTENCY_KEY_REQUIRED`.

This is layered on top of (not a substitute for) the cart's own `open -> checked_out` transition
and the synchronous commit, which are the underlying invariants — see `DECISIONS.md`.

## Store engine

The persistence layer is a hand-rolled, Redis-inspired in-memory store (not real Redis) — chosen
specifically to demonstrate the concurrency reasoning this assignment evaluates, rather than
delegating it to an external engine. Two primitives:

- **`Database.exec(fn)`** — `fn` is a *synchronous* callback (no `await` inside) that reads/writes
  any of the store's tables. Because Node runs synchronous code to completion, no other request
  can execute while `fn` runs — this is the in-process stand-in for a Redis Lua script or
  `MULTI`/`EXEC`. Used for every state mutation that doesn't itself need to await something
  (cart item edits, coupon generation, and the commit phase of checkout).
- **`AsyncLock.withLock(key, fn)`** — a per-key async mutex (FIFO queue of promises) that a caller
  can hold *across* an `await`. Used only where a critical section must span real async work — in
  this design, that's checkout's payment step, locked per `cart:{cartId}`.

Together, checkout is a **reserve → pay → finalize** flow, all under the cart's async lock:

1. **Reserve** (sync `exec()`): validate the cart/coupon and *immediately decrement inventory*.
   This is the authoritative oversell check — it protects against every other cart racing for the
   same stock, not just retries of this one cart.
2. **Pay** (async, inside the lock): call the payment gateway.
3. **Finalize** (sync `exec()`) on success: create the order, redeem the coupon, advance the
   reward counter, close the cart. On payment failure, or if finalize itself fails (see below),
   roll back the inventory reservation in another `exec()` block instead.

Reserving inventory *before* payment (rather than re-checking after) means a declined or slow
payment never risks a torn state — the rollback path is exercised by an explicit code path, not
assumed. Coupon generation and cart item mutations have no async step, so they go straight through
`exec()` with no lock needed.

**Accepted residual race:** a coupon is only atomically flipped to `redeemed` in the *finalize*
step, not reserved up front like inventory is. If two different carts for the same customer both
pass payment concurrently using the same coupon, only the first to reach finalize wins; the second
throws `COUPON_ALREADY_REDEEMED` there and rolls back its own inventory reservation — but its
(fake) payment already "succeeded." With a real payment provider this would need a refund call;
deferred here since no real money moves. Reserving the coupon up front, symmetrically with
inventory, is the two-hours-more improvement — see `DECISIONS.md`.

This design maps cleanly onto a production evolution: `exec()` blocks translate almost directly
into Redis Lua scripts or DB transactions with row locks; `AsyncLock` translates to a real Redis
distributed lock (`SET key val NX PX ttl` + a token-checked Lua unlock, i.e. the Redlock pattern).
See `DECISIONS.md` for the multi-instance/production-DB discussion.

## Endpoints

### `GET /products`
List all products with current price/inventory.
- `200` → `Product[]`

### `POST /carts`
Create a cart for a customer.
- Request: `{ "customerId": string }`
- `201` → `Cart`
- `400 VALIDATION_ERROR` — missing/blank `customerId`

### `GET /carts/{cartId}`
View a cart with live-priced line items and totals.
- `200` → `Cart` extended with computed `items[].unitPriceCents`, `items[].lineTotalCents`, and
  `subtotalCents`, always computed from current product state (no snapshot exists to diff
  against, per the live-pricing decision — there is no "price changed" flag).
- `404 CART_NOT_FOUND`

### `POST /carts/{cartId}/items`
Add an item to the cart (or increase quantity if the product is already present — see
`DECISIONS.md` for the merge-vs-reject choice).
- Request: `{ "productId": string, "quantity": integer > 0 }`
- `201` → `Cart`
- `400 VALIDATION_ERROR` — quantity `<= 0` or missing fields
- `404 PRODUCT_NOT_FOUND`
- `404 CART_NOT_FOUND`
- `409 CART_ALREADY_CHECKED_OUT`
- `409 INSUFFICIENT_INVENTORY` — quantity requested exceeds current stock (checked at add-time as
  a fast-fail UX convenience; the authoritative check is still at checkout)

### `PATCH /carts/{cartId}/items/{productId}`
Set an item's quantity.
- Request: `{ "quantity": integer > 0 }`
- `200` → `Cart`
- `400 VALIDATION_ERROR`
- `404 CART_NOT_FOUND` / `404 ITEM_NOT_IN_CART`
- `409 CART_ALREADY_CHECKED_OUT`

### `DELETE /carts/{cartId}/items/{productId}`
Remove an item from the cart.
- `200` → `Cart`
- `404 CART_NOT_FOUND` / `404 ITEM_NOT_IN_CART`
- `409 CART_ALREADY_CHECKED_OUT`

### `POST /carts/{cartId}/checkout`
Validate the cart, atomically deduct inventory, optionally redeem a coupon, and create an order.
- Headers: `Idempotency-Key: <client-generated string>` (required)
- Request: `{ "couponCode": string | null }`
- `201` → `Order`
- `400 IDEMPOTENCY_KEY_REQUIRED`
- `400 CART_EMPTY`
- `400 COUPON_INVALID` — coupon doesn't exist, or belongs to a different customer, or malformed
- `404 CART_NOT_FOUND`
- `409 CART_ALREADY_CHECKED_OUT` — includes on retry without/with a different idempotency key
- `409 INSUFFICIENT_INVENTORY` — the authoritative check, at inventory reservation time
- `409 COUPON_ALREADY_REDEEMED`
- `409 IDEMPOTENCY_KEY_CONFLICT` — key reused with a different cart/body
- `402 PAYMENT_DECLINED` — the (fake) payment gateway declined the charge; inventory/coupon are
  rolled back before this is returned

### `GET /orders/{orderId}`
Retrieve an order.
- `200` → `Order`
- `404 ORDER_NOT_FOUND`

### `POST /admin/coupons/generate` — **administrative**
Generate a coupon for a specific customer if their successful-order count has just crossed an
unrewarded multiple of the configured `n`.
- Request: `{ "customerId": string }`
- `201` → `Coupon` — newly created, `status: available`
- `400 VALIDATION_ERROR`
- `409 MILESTONE_NOT_REACHED` — customer's order count hasn't reached the next unrewarded
  multiple of `n`. Note: this single code also covers "a coupon was already generated for the
  current milestone" — the read-check-write happens inside one `exec()` block keyed on
  `lastRewardedMilestone`, so once a milestone is rewarded it structurally cannot be reached
  again as "eligible"; there is no separate state to distinguish from "not yet eligible."

### `GET /admin/reports/summary` — **administrative**
Read-only reconciling report. Must not mutate state, and repeated calls must be stable for a
fixed underlying data set.
- `200` →
  ```json
  {
    "purchasedQuantityByProduct": { "<productId>": 12 },
    "grossRevenueCents": 123456,
    "totalDiscountCents": 4500,
    "netRevenueCents": 118956,
    "coupons": { "generated": 10, "available": 3, "redeemed": 7 },
    "totalSuccessfulOrders": 42
  }
  ```

## Error model

All errors share one shape:

```json
{
  "error": {
    "code": "INSUFFICIENT_INVENTORY",
    "message": "Only 2 units of 'Blue Mug' are available.",
    "details": { "productId": "p1", "requested": 5, "available": 2 }
  }
}
```

`code` is a stable machine-readable string (used in tests and by API clients); `message` is
human-readable; `details` is optional structured context. Every error code referenced above maps
to exactly one HTTP status, listed per-endpoint.

## Admin endpoint marking

`/admin/coupons/generate` and `/admin/reports/summary` are the two operations this assignment
specifies as administrative. They are namespaced under `/admin` and are the only endpoints
treated as such — everything else is a regular customer-facing operation. No auth is implemented
per the assignment's scope (see `DECISIONS.md`).
