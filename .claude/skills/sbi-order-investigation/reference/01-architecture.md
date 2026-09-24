# Architecture and Identifiers

How an SBI order moves through the platform, and what every identifier means.

## The actual order path

```
sc-platform-api
  │  placeOrdersNormal → smallcaseOrderFlow.placeOrders
  │  (sc-platform-babel/others/smallcaseOrderFlow.js — plain source, not opaque)
  ▼
POST https://{BB_SERVICE_HOST}/orders/place        ← "BB" IS sc-integrations-order-updates
  ▼
sc-integrations-order-updates  (listens on BB_PLACEORDERS_PORT, default 8005)
  │  require('@smallcase/sc-integrations-broker-lib')   ← IN-PROCESS, no HTTP hop
  ▼
broker-lib  src/brokers/sbi/  or  src/brokers/sbi-mtf/
  ▼
SBI's API   (order-service, books-service, bank-service, dp-service, rmslimit-service …)
```

Return leg: order-updates responds with `batchId`; platform-api's babel layer records
`PlacedOrders`, then the BB service calls back to `POST /v2/internal/batch/apply`
(or `/batch/apply-mtf`).

**`sc-integrations-broker-api` is not on this path.** It has no `Orders.*` binding at all and no
`/orders` route (`src/services/brokerLib.ts:120-151`). It serves login, session, funds, holdings,
positions, portfolio, instruments, leads, comms and SIP — never order placement or status. It
never sees an order tag.

`sc-mindmap/equity/CLAUDE.md` says otherwise; it is stale. The correction is recorded in
`00-corrections.md`.

### The three routes babel actually calls

| babel `method` | Real HTTP path | Note |
|---|---|---|
| `place` | `POST /orders/place` | — |
| `placeDummy` | `POST /orders/dummyOrder` | **there is no `/orders/placeDummy` route** — but the log line still prints that URL, so the logged URL never existed |
| *(status recovery)* | `POST /orders/getstatus` | lowercase; works only because Express routing is case-insensitive by default |

## Identifiers

| Identifier | Minted by | Equals | Where it first appears |
|---|---|---|---|
| `tag` | `config.generateTag()` in broker-lib at query-build time | — | the place-order request body, as `orderParameters.externalReferenceNumber` |
| `batchId` | **order-updates**, `new mongoose.Types.ObjectId().toString()` | `Order._id` | `services/orders.js:885` |
| `correlationId` | **sc-platform-babel**, inside the call platform-api makes | `PlacedOrders._id` **and** `orders.meta.correlationId` | `smallcaseOrderFlow.js:504,536` |
| `orderId` / `orderKey` | SBI | `orderLegDetails.internalOrderNumber` | place-order response |
| `exchangeOrderId` | the exchange | `orderLegDetails.exchangeOrderNumber` | order-status response |
| `iscid` | upstream of platform-api | `User.investedSmallcases[]._id` | `APPLY_BATCH_START` and friends |

The old guide had two of these backwards: it said batchId was minted downstream by
`smallcaseOrderFlow` (it is minted in order-updates; babel only *reads* it off the response) and
that correlationId was minted upstream of platform-api (it is minted inside the babel package that
platform-api calls).

`brokerOrderId` and `transactionId` **do not exist** as field names anywhere. Do not grep for them.

### Tag format

```
SBI cash   sc_    + 9 chars from [0-9a-zA-Z]     regex  sc_[0-9A-Za-z]{9}
SBI-MTF    scmtf_ + 9 chars from [0-9a-zA-Z]     regex  scmtf_[0-9A-Za-z]{9}
```

The tag is regenerated per placement **unless** the batch is twoStep, dealer, activated or autoSip
— in those cases an incoming `order.tag` is preserved.

### `requestId` means different things on each side of the hop

Inside order-updates' placement path, `var requestId = context.correlationId` rebinds it — so
every OU log field called `requestId` for a placement is actually the platform **correlationId**.
Only `Order placement request received` logs the true upstream requestId, alongside correlationId.
Joining platform-api to OU on `requestId` without knowing this gives false negatives.

## Redis

For SBI and SBI-MTF the Redis order key **is the tag**, because both adapters override
`getOrderKey` to return `order.tag`:

```
BB:order:sbi:<tag>            the live order hash
BB:order:sbi-mtf:<tag>
BB:orders:<batchId>           maps redisIndex → orderKey (i.e. → tag, not → orderId)
```

The broker `orderId` appears only as a field inside the hash and on the Mongo leg. You cannot
locate an SBI order in Redis by its broker orderId.

## Polling, not postbacks

Both adapters declare `orderStatusBy: { postback: false, polling: true }`. There is no webhook or
postback path for SBI. Status changes only when something explicitly calls `getOrderDetails`.

`batchExpireHandler` branches on this flag and goes straight to `brokerPoll`. **Searching the
`ORDER_conciliation` Kafka topic for an SBI order is a dead end.** Search `Broker Poll Response`
and `broker action - orderStatus` instead.

Two consequences:

- SBI polling needs **no user access token** — `sessionlessPollingAvailable: () => true`, so
  `getAccessToken()` short-circuits and returns the literal string `'X'`. "Access Token not found
  on broker poll" can never be the cause of an SBI polling failure.
- `concurrentOrdersNotAllowed: true`, so placement and polling run **strictly serially**, one leg
  at a time. Expect wall-clock latency proportional to leg count on a large basket.

## The fix endpoint

`POST /errors/fix/:batchId` on order-updates. The single write path every recon job uses.

```
FIXBY enum:  NONE=0  ORDERBOOK=1  POLLING=2  UNLOCKING=3  RETRY=4
```

- **`tradebook` is not a fixBy mode.** It is a separate top-level body parameter — a pre-supplied
  order book. This is the *only* way SBI can be fixed, because SBI has no `Orders.list` endpoint
  and so `getOrderBook()` throws.
- `triageErrorBatch` returns `FIXBY.NONE` for `sbi`, but **triage only runs when the caller does
  not pass `fixBy`**: `FIXBY[options.fixBy?.toUpperCase()] || triageErrorBatch(batch)`. Every real
  SBI recon job passes `fixBy: 'orderbook'` explicitly, so SBI batches **are** fixed. "NONE" only
  describes the unattended retry-queue default.
- `sbi-mtf` has **no `case` in triage at all** — it reaches NONE via `default`. A future per-broker
  mechanism added for `'sbi'` would silently not cover `sbi-mtf`.
- Passing `fixBy: 'none'` does **not** force the no-op: `FIXBY.NONE === 0` is falsy, so it falls
  through to triage. A live bug, harmless for SBI only by coincidence.
- **The endpoint has no authentication.** Only the `/smallboard/*` sub-router checks a token. The
  root router — carrying `/errors/fix/:batchId`, `/orders/place`, `/batch/orders` DELETE and
  `/orders/dummyOrder` — has no auth middleware. It also accepts GET with the same handler.

Error-retry backoff: 5×60s + 5×300s + 24×900s = 34 attempts over **6.5 hours** (the in-repo doc
rounds this to "~6 hours").

## PlacedOrders state machine

```
QUEUED → {ACKED | RECEIVED | QUEUED}(gate) → APPLIED → COMPLETED
```

Written **only** by sc-platform-babel / sc-babel (RECEIVED, ACKED, COMPLETED-on-cancel,
ERROR-on-rollback) and sc-platform-api (APPLIED, COMPLETED, QUEUED).
**order-updates never touches it** — zero references to the `placedOrders` collection anywhere in
its `services/`, `lib/` or `consumer/`.

Gates and failure codes: entry requires `status ∈ {ACKED, RECEIVED, QUEUED}`, else
`InconsistentOrderState` (`SCBAT0003`). A missing document gives `PlacedOrderNotFound` (`SCBAT0002`).

**Silent stall:** `markPlacedOrderCompleted` no-ops with **zero log output** when the user's
`investedSmallcases[].status` is still `'PLACED'`. `PlacedOrders` then sits at `APPLIED` forever
with no error trail. Check `investedSmallcases[].status` for the iscid directly, not just
`PlacedOrders.status`.

Log lines differ by **one character** depending on which path produced them: the normal 200 path
logs `"PlacedOrders state ACKED "` (trailing space), the recovery path logs `"PlacedOrders state
ACKED"` (none). Same for RECEIVED / ERROR / APPLIED. `COMPLETED` has no trailing space on either.
Use exact-match greps.

## The Order model — three implementations, one collection

Three packages register a model named `Order` over the same `orders` collection with materially
different schemas, different save state machines and different lookup keys.

| Package | Used by | Missing vs sc-integrations-babel |
|---|---|---|
| `sc-integrations-babel` | order-updates, jobs | — (the fullest) |
| `sc-platform-babel` | platform-api | `meta.source`, `meta.reconciled`, `orders[].sipId`, `orders[].priceSource`, `orderMode`, `autoSip` |
| `sc-babel` v18.x | smallboard | the above **plus** `nettedOffQuantity`, `brokerFilledQuantity`, `twoStep`, `cas` |

`sc-babel` and `sc-platform-babel` also have no `PLACED` save state and no `ACKED` status, and
locate batches by `{userId, batchId, iscid}` rather than `_id`.

Practical consequences:

- A fact learned from one service's model may not hold in another.
- `meta.type` is **not declared in any of the three schemas**. It survives only because
  `sbiReconBatchCreation` writes with the raw driver, bypassing mongoose. It is visible only via
  Redash / raw / `.lean()` reads, and batches carrying it have **no `meta.updates` array at all**.
- Schema `strict` is the mongoose **default true** (the `strict:false` in the changelog is the
  MongoDB stable-API flag, something else entirely). Undeclared paths are silently dropped on both
  saves and updates.
- `mongoose.set('autoIndex', false)` runs at module load, so declared indexes create **nothing** at
  runtime. The declared index list is intent, not a guarantee. Only
  `scripts/adhoc/mongo/syncIndexes.js` actually creates them.

### Field semantics that are easy to misread

- **`Order.quantity` and `Order.filled` are leg counts, not share counts.** `quantity` is the
  number of stocks in the basket; `filled` increments once per *fully* filled leg, so a partially
  filled leg contributes zero. The share-level total is computed as `totalFilled` and never
  persisted.
- **SBI-MTF legs store `product: 'EMARGIN'`**, not `'MTF'`. The babel product enum is
  `[CNC, NRML, EMARGIN]` and has no `MTF` value at all. (sc-babel v18.x is the exception and does
  include `MTF`, so a smallboard write could carry it — query for `product ∈ {EMARGIN, MTF}` to be
  safe.)

## Version hazard

Several services run **pre-release** builds that differ from the checked-out source:

| Repo | Checked-out branch | Installed `sc-integrations-babel` |
|---|---|---|
| sc-integrations-order-updates | production | 6.3.3-rebalance-in-amo.2 |
| sc-integrations-jobs | production | 6.3.3-rebalance-in-amo.1 |
| sc-integrations-broker-api | production | 6.3.3-rebalance-in-amo.1 |
| sc-integrations-babel | production (6.3.2) | — |

And critically: **broker-lib's `production` branch is two years stale (v15.22.0) and does not
contain `src/brokers/sbi-mtf/` at all.** broker-lib ships via npm; consumers pin `^16.11.x`, which
matches the `development` branch. For SBI, **`development` is the prod truth** and `production` is
the stale branch. Reading `production` gives wrong validity codes, wrong variety casing, wrong
order keys and an entirely empty `statusMessageMap`.

Always run `git -C <repo> rev-parse --abbrev-ref HEAD` rather than assuming.
