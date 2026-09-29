# Checkout & Rewards Service

A backend for cart → checkout → orders, with a per-customer milestone coupon reward system.
Built to demonstrate correctness under retries, concurrent requests, and competing operations —
not just happy-path CRUD. See `DECISIONS.md` for the reasoning behind every non-obvious choice,
and `API_DESIGN.md` / `openapi.yaml` for the full API contract.

The original assignment brief is preserved at `ASSIGNMENT.md`.

## Stack

Node.js + TypeScript, Express, Vitest + Supertest for tests. No database — persistence is a
hand-rolled, Redis-inspired in-memory store (`src/store/`), chosen specifically to demonstrate the
concurrency reasoning the assignment evaluates rather than delegating it to an external engine.
See `DECISIONS.md` → "Decision 3" and "Evolving to multiple instances and a production database"
for why, and what would change for real infrastructure.

## Requirements

- Node.js 20+ (uses `structuredClone` and `node:crypto`'s `randomUUID`, both built in)

## Setup

```bash
cd be
npm install
```

No environment variables, credentials, or external services are required. Two are optional (see
below).

## Running the service

```bash
npm run dev     # tsx watch — restarts on file changes
# or
npm run build && npm start   # compiled, production-style run
```

The server listens on `http://localhost:3000` by default. Product data is seeded in-memory on
startup — see `src/seed.ts`: 5 plentiful products, `p-poster` (3 units) and `p-scarf` (2 units) as
two independently-scarce items for concurrency demos, and `p-typewriter` (0 units) already sold
out for testing the immediate-rejection path.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `COUPON_MILESTONE_N` | `5` | Every customer's Nth successful order unlocks a coupon |
| `COUPON_DISCOUNT_X` | `10` | Discount percentage the unlocked coupon carries |

## Running tests

```bash
npm test          # single run
npm run test:watch
```

40 tests across the store engine, each domain service, and the HTTP layer, including the
concurrency scenarios the assignment specifically calls for: concurrent checkouts racing for
limited stock, concurrent identical idempotent retries, two carts of one customer racing to
redeem the same coupon, and payment-decline rollback + failure replay.

## Demo walkthrough

Uses [`jq`](https://jqlang.org/) for readability — if you don't have it installed, drop the
`| jq` pipes and read the raw JSON instead; nothing below depends on it. Every step here was run
against the actual server while writing this README, not just described.

With the server running (`npm run dev`), this is a full cart → checkout → coupon → report cycle.
`COUPON_MILESTONE_N=1` (see below) makes the coupon show up after a single order instead of five,
which is more convenient for a live demo.

```bash
# Restart the server with a milestone of 1 for this walkthrough:
#   COUPON_MILESTONE_N=1 npm run dev

# 1. Products
curl -s localhost:3000/products | jq

# 2. Create a cart and add an item
CART=$(curl -s -X POST localhost:3000/carts -H 'Content-Type: application/json' \
  -d '{"customerId":"cust1"}' | jq -r .id)
curl -s -X POST localhost:3000/carts/$CART/items -H 'Content-Type: application/json' \
  -d '{"productId":"p-mug","quantity":2}' | jq

# 3. View the cart (live-priced totals)
curl -s localhost:3000/carts/$CART | jq

# 4. Checkout (Idempotency-Key is required)
ORDER=$(curl -s -X POST localhost:3000/carts/$CART/checkout \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' -d '{}')
echo "$ORDER" | jq

# 5. Retry the exact same request — same order comes back, nothing double-charged
curl -s -X POST localhost:3000/carts/$CART/checkout \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' -d '{}' | jq

# 6. Admin: generate this customer's coupon (milestone just reached)
COUPON=$(curl -s -X POST localhost:3000/admin/coupons/generate \
  -H 'Content-Type: application/json' -d '{"customerId":"cust1"}')
echo "$COUPON" | jq
CODE=$(echo "$COUPON" | jq -r .code)

# 7. Use the coupon on a second order
CART2=$(curl -s -X POST localhost:3000/carts -H 'Content-Type: application/json' \
  -d '{"customerId":"cust1"}' | jq -r .id)
curl -s -X POST localhost:3000/carts/$CART2/items -H 'Content-Type: application/json' \
  -d '{"productId":"p-notebook","quantity":1}' > /dev/null
curl -s -X POST localhost:3000/carts/$CART2/checkout \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-2' \
  -d "{\"couponCode\":\"$CODE\"}" | jq   # discountCents should be non-zero

# 8. Admin report — reconciles with the two orders and one coupon above
curl -s localhost:3000/admin/reports/summary | jq
```

To see the oversell-prevention invariant instead of just reading about it, fire several concurrent
checkouts at the scarce product (`p-poster`, seeded with 3 units) from different carts and watch
only 3 succeed. **Set up every cart before firing any checkout** — if setup and checkout are
interleaved, the earlier (fast, ~15ms) checkouts can finish before later carts even add their
item, which produces a different, less interesting failure (`400 CART_EMPTY`) instead of the
`409` race this is meant to demonstrate:

```bash
CARTS=()
for i in 1 2 3 4 5; do
  CART=$(curl -s -X POST localhost:3000/carts -H 'Content-Type: application/json' \
    -d "{\"customerId\":\"race-$i\"}" | jq -r .id)
  curl -s -X POST localhost:3000/carts/$CART/items -H 'Content-Type: application/json' \
    -d '{"productId":"p-poster","quantity":1}' > /dev/null
  CARTS+=("$CART")
done

for i in 0 1 2 3 4; do
  CART=${CARTS[$i]}
  curl -s -o /dev/null -w "cart $((i+1)) -> %{http_code}\n" -X POST \
    localhost:3000/carts/$CART/checkout \
    -H 'Content-Type: application/json' -H "Idempotency-Key: race-$i" -d '{}' &
done
wait
curl -s localhost:3000/products | jq '.[] | select(.id == "p-poster")'
# expect: three 201s, two 409s, availableInventory: 0
```

(This is also exercised as an automated test, both at the service layer and over real HTTP — see
`src/test/checkoutService.test.ts` and `src/test/http.test.ts`.)

## API documentation

- **`http://localhost:3000/docs`** — interactive Swagger UI, live while the server is running.
  Every endpoint is browsable and "Try it out"-able directly from the browser.
- `http://localhost:3000/openapi.json` — the same spec as JSON, if you want to point a tool
  (Postman, Insomnia, ...) at a live URL instead of importing the file.
- `API_DESIGN.md` — full narrative contract: resources, state machines, concurrency/idempotency
  strategy, every endpoint with status codes and error cases.
- `openapi.yaml` — the static source of the same contract (what `/docs` and `/openapi.json` serve).
- Admin endpoints (`POST /admin/coupons/generate`, `GET /admin/reports/summary`) are the only ones
  treated as administrative. No authentication is implemented, per the assignment's scope.

## Testing it yourself

Three ways, roughly in order of effort:

1. **Swagger UI** (`http://localhost:3000/docs`) — click into any endpoint, "Try it out", fill the
   fields, "Execute". No tooling needed beyond a browser. Best for poking around interactively.
2. **curl / httpie**, or import `openapi.yaml` into Postman/Insomnia as a collection — best for a
   scripted walkthrough. See "Demo walkthrough" above for a copy-paste sequence, including the
   concurrent-oversell demo (which Swagger UI can't drive on its own, since it only fires one
   request at a time).
3. **The automated test suite** (`npm test`) — this is the actual correctness evidence, not just a
   manual click-through: 44 tests including every concurrency scenario described in this README.

## Project layout

```
src/
  domain/types.ts       Domain types (Product, Cart, Order, Coupon, ...)
  store/                The concurrency engine: Database.exec() (atomic commit),
                         AsyncLock (cross-await per-key mutex), clone()
  services/              One service per resource; checkoutService.ts is the core
                         reserve -> pay -> finalize flow
  http/                 Express app, routers, error handling, request validation
  errors/AppError.ts     Typed errors (code, httpStatus, message, details)
  seed.ts, config.ts     Seed data and n/x reward configuration
  composition.ts          Wires the store + lock + payment gateway into the services
  server.ts               Process entry point
  test/                   Vitest suites (store, each service, HTTP layer)
```
