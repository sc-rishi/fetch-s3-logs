# SBI & SBI-MTF Log Investigation Guide

**Audience: an AI coding agent (Claude, Codex, or any similar tool), not a human.** This document is meant to
be loaded as context by any AI agent session — regardless of which model or CLI is running it — immediately
before it uses `fetch-s3-logs.js` to investigate a production SBI or SBI-MTF order question. It is not a
tutorial, not an onboarding doc, and assumes no prior conversation context — everything
you need to interpret fetched logs and answer questions like *"what was the last update for this tag,"* *"we
got broker status 4/11, what does that mean for us,"* or *"was this order fixed manually or by a job"* is
below, with file:line citations back to the source repos.

**Scope: SBI and SBI-MTF only.** Do not extrapolate anything here to other brokers.

**How to use this doc, end to end:**
1. Get the identifier you're given — a `tag` (`sc_...`/`scmtf_...`), a `brokerOrderId`/`orderId`/`exchangeOrderId`, a `batchId` (= the Mongo `Order` document's `_id`), or literal text — plus the service. A date is optional and, for `--tag`/`--order-id`/`--batch-id`, is resolved automatically if omitted — see step 2. §1.1 has the full identifier glossary if the mapping isn't obvious.
2. Fetch logs with **`fetch-by-identifier.js`** (a thin CLI entry point over `search-s3-logs.js`) — the main search tool. `--service` is mandatory; if the requester did not identify the service, ask before searching. Run `node fetch-by-identifier.js --help` for exact flags; §3.2 documents every underlying surface/path.
   ```
   node fetch-by-identifier.js --service order-updates --tag sc_rXWoyJfoH --date 2026-06-05
   node fetch-by-identifier.js --service order-updates --tag sc_rXWoyJfoH
   node fetch-by-identifier.js --service order-updates --text "broker action - orderStatus"
   node fetch-by-identifier.js --batch-id 6a221fb2d963eea6efaeabfa --from 2026-09-18 --to 2026-09-20 --service all
   node fetch-by-identifier.js --tag <value> --month 2026-06 --service jobs-recon --job-name sbiReconAllOrders
   ```
   Priority: **order-updates first** (primary source for almost everything), `sc-integrations-jobs` second (batch/recon/activation-specific), `platform-api`/`broker-api` last resort. Select the service explicitly, or pass `--service all` only when a cross-service search is genuinely required.

   **If you omit the date for `--tag`/`--order-id`/`--batch-id`, the real order date is resolved automatically and the search starts narrow, widening only if needed** — see §3.2 for the full tiering mechanics. In short: `--batch-id` decodes the date instantly from the Mongo ObjectId itself (no network call); `--tag`/`--order-id` look it up via a bounded Redash query. Either way, S3 search then starts at a ~4-day window around that date and widens in tiers (up to 30 days) only if the narrower tier finds nothing — it never does a single flat 30-day scan when a real date is available. If no order matching the tag/order-id is found via Redash at all (checked up to 30 days back), the tool stops and reports that plainly rather than guessing with an expensive blind S3 crawl — pass an explicit `--date`/`--from`+`--to`/`--month` if you know it's older. An explicit date always bypasses all of this and searches exactly what you asked for.
3. **Query the live document directly with `redash-query.js`** when you need the CURRENT state rather than the history — it goes straight to Mongo (via Redash, the org's only sanctioned path to prod DB access; data source id 35, "Atlas Mongo") and returns the full document including `meta.updates[]`, `meta.source`, `meta.reconciled` — the exact fields §5 (provenance) is about. This is often faster and more direct than reconstructing state from logs, and the two are complementary: logs tell you the sequence of events, this tells you where things landed.
   ```
   node redash-query.js --collection orders --batch-id 6a221fb2d963eea6efaeabfa
   node redash-query.js --collection orders --tag sc_rXWoyJfoH --from 2026-06-05 --to 2026-06-05
   node redash-query.js --collection orders --order-id 26060500005371 --from 2026-06-05 --to 2026-06-05
   node redash-query.js --collection orders --broker sbi --status ERROR --from 2026-09-01 --to 2026-09-20 --limit 20
   ```
   **`--tag`/`--order-id` without `--batch-id` REQUIRE `--from` and/or `--to`** — this is a production database and `orders.tag`/`unplaced.tag`/`.orderId` are unindexed array fields, so an unbounded query is a full collection scan (confirmed live: 7d~20s, 14d~24s, 30d~44s, 60d+ unreliable even with a 120s poll ceiling — cost scales with the date range, not a fixed cost). `--batch-id` doesn't need one (fast regardless, empirically ~1-2s). The script refuses to run the dangerous case rather than risk it — use `fetch-by-identifier.js` (or `redash-query.js`'s own auto-scope helper, see §3.2) if you don't know the date; it resolves one via the same tiered bounded lookup. Needs `REDASH_API_KEY`/`REDASH_URL`/`REDASH_DATA_SOURCE_ID` in a local `.env` (gitignored, not checked in).
4. Interpret what you find using §1 (order flow), §2 (status/error codes), and §5 (provenance) as reference.
5. Follow §4's scenario-by-scenario playbook for the specific kind of question being asked.

**Honesty convention used throughout this doc**: where something could not be confirmed from source code, tests,
or live data, it says so explicitly ("not found," "unconfirmed," "open question") rather than guessing. Treat
those markers as real — do not fill in a plausible-sounding answer where this doc says it doesn't have one;
they're flagged as things worth checking against source directly if they matter for the question at hand.

**Provenance of this document**: built from (a) a 10-agent parallel research pass across
`sc-integrations-broker-lib` (SBI + SBI-MTF adapters), `sc-integrations-leprechaun` (mock broker + error
catalog), `sc-integrations-jobs` (recon/sanity jobs), `sc-platform-api` (order placement/batch-apply), and
`sc-mindmap` (architecture docs); (b) direct analysis of a real production log sample
(`sc-integrations-order-updates`, 2026-06-05); (c) two follow-up deep-dive agents on
`sc-integrations-jobs/jobs/reconciliations/sbiReconAllOrders.js` and `sc-smallboard-be`'s order-fix endpoints;
and (d) live verification against real S3 buckets (via AWS SSO) on 2026-09-22, which corrected several
S3-path assumptions the source-code-only research had gotten wrong or left as placeholders.

---

## Table of Contents

1. **Identifiers, Architecture & End-to-End Order Flow** — identifier glossary, service map, order lifecycle by variant (regular/AMO/dealer/AutoSIP/two-step/recon), dealer auth, state machines
2. **Status Codes, Error Codes & Broker Response Semantics** — raw SBI `orderStatus` → smallcase status table, `shortfallFlag` state machine, `getErrorCode` classification, SBI-MTF margin codes, error-reconciliation mechanics
3. **Log Locations, S3 Paths & Field Reference** — the four S3 surfaces, live-verified bucket routing per service, `fetch-s3-logs.js` mechanics, example invocations
4. **Troubleshooting Playbook** — scenario-by-scenario: fetch → look for → interpret → root cause, for the most common question types
5. **Order Provenance** — how to tell a manual smallboard fix from an automated recon-job fix from normal ingestion

---

## Section 1: Identifiers, Architecture & End-to-End Order Flow (SBI & SBI-MTF)


### 1.0 Repo shorthand used below

| Shorthand | Repo / base path |
|---|---|
| `BL-SBI` | `sc-integrations-broker-lib/src/brokers/sbi/` |
| `BL-MTF` | `sc-integrations-broker-lib/src/brokers/sbi-mtf/` |
| `PA` | `sc-platform-api/` |
| `JOBS` | `sc-integrations-jobs/` |

---

### 1.1 Identifier Glossary

| Identifier | Generated by | First appears | Logged at (grep target) | Correlates |
|---|---|---|---|---|
| `tag` / `externalReferenceNumber` | `config.generateTag()` — SBI: `sc_` + nanoid (`BL-SBI/config.js:114`); SBI-MTF: `scmtf_` + 9-char nanoid (`BL-MTF/config.js:115-119`) | Broker order-placement request body, `orderParameters.externalReferenceNumber` / `.remarks` (`BL-SBI/services/order.js:181-233`; `BL-MTF/services/order.js:186-244`, field also called `orderOptions.tag`) | Place-order request/response; order-status request `orderReferenceDetails.referenceNumberFilter`; order-status response match key `orderStatusList.find(o => o.orderLegDetails.externalReferenceNumber === tag)` (`BL-SBI/services/order.js:388`; `BL-MTF/services/order.js` L382); AutoSIP `sipDetails.externalReferenceNumber` (`BL-SBI/services/autosip.js:5-38`) | The single field that ties a raw SBI broker order back to a smallcase `Order.orders[].tag` / `.unplaced[].tag`. Prefix alone (`sc_` vs `scmtf_`) is one of the only reliable ways to tell SBI from SBI-MTF in a raw payload — the `broker` field cannot (see §1.2). |
| `brokerOrderId` | **Term does not appear anywhere in the research corpus** — not in `sc-platform-api`, not in `sc-integrations-broker-lib`. Do not search logs for a literal field named `brokerOrderId`. | — | — | Closest confirmed analogs: `orderId`/`orderKey` = `orderLegDetails.internalOrderNumber` (`BL-SBI/services/order.js:32-52`; `BL-MTF/services/order.js` L46-66), and `exchangeOrderId` = `orderLegDetails.exchangeOrderNumber` (same mapping). On placement success, `orderId` = `result.internalOrderNumber` from the place-order response (`BL-SBI/services/order.js:54-91`; `BL-MTF/services/order.js` L69-106). |
| `batchId` | Minted downstream by `smallcaseOrderFlow` (external `@smallcase/sc-platform-babel` package, not in any researched repo) and returned as `response.data.batchId` (`PA/app/services/userSmallcase/userSmallcase.js:3644`) | Response of the placeOrders call to the broker-broker (BB) service | Every apply-flow log in `PA` (`APPLY_BATCH_START`, `PLACEDORDER_STATUS_CHECK`, `PLACEDORDER_STATUS_APPLIED`, `ISC_BATCH_APPLY`/`ISC_MTF_BATCH_APPLY` — `PA/app/controllers/userSmallcaseController.js` + `userSmallcase.js:10029-10444`); every recon job (`JOBS/jobs/reconciliations/sbiReconAllOrders.js`); `cleanupMtfNonTerminalBatches.js` (`Order.updateOne({_id: batchId}, ...)`) | Confirmed equal to the Mongo `orders` collection document's `_id`, stringified: *"`batchId` in logs is always a stringified Mongo `ObjectId` of the `orders` collection doc"* (jobs-sbi-activations-recon research, §1). No separate `Batch` model was found in any researched file — "batch" is a conceptual term for one `Order` document. |
| `Order._id` | Mongo, on document creation | `orders` collection | Same as `batchId` above (they are the same value) | See `batchId` |
| `iscid` | Upstream of the researched layers (not generated in any file read) | `placeOrdersNormal` config object (`PA/app/controllers/userSmallcaseController.js`, field list includes `iscid`) | `APPLY_BATCH_START`, `PLACEDORDER_STATUS_CHECK`, `PLACEDORDER_STATUS_APPLIED` (`PA/.../userSmallcase.js:10033,10070,10209`); Redis lock key `API:SCL:{userId}:{lockKey}` where `lockKey = scid` (source `PROFESSIONAL`/`CUSTOM`/`CREATED`) or literal `ADHOC` (`JOBS/jobs/sanity/iscAndBatchStatus.js`) | `User.investedSmallcases[]._id` — the invested-smallcase whose status (`PLACED`/`VALID`/`INVALID`) gates `markPlacedOrderCompleted` (§1.5). |
| `entityId` / `userId` (dealer) | Decoded from the dealer's SBI access token via `decodeAccessToken()` → `{token, userId, dealerId, nriFlag, dpAccountNumber, dpCode}` (`BL-SBI`/`BL-MTF` `services/util.js`) | Dealer login callback (`authenticateDealer`) | Redis dealer-token key `sbi:dealer_token:{entityId}:{userId}` (SBI) / `sbi-mtf:dealer_token:{entityId}:{userId}` (SBI-MTF) — `BL-SBI/constants.js:3`, `BL-MTF/constants.js:3`; dealer order request body `dealerAccountDetails.{entityId,tokenId,userId}` (`BL-MTF/services/order.js` L168) | Cache key for the 8h-TTL dealer session (§1.4). `PA`'s own dealer-terminal layer (`app/integrations/sbi/sbi.dealerTerminal.integrations.js`) independently notes an entityId/userId pairing but with a **1-day TTL** mentioned for that session — the corpus does not clarify whether this is the same token as broker-lib's 28800s (8h) Redis cache or a separate platform-api-level session; treat as two distinct caches unless proven otherwise. |
| `reconId` | Not generated in any researched file (opaque pass-through) | `placeOrdersNormal` config (`PA` controller, field list) | `PLACEDORDER_STATUS_CHECK`, `PLACEDORDER_STATUS_APPLIED`, `RECON_HANDLING_START` (`{reconId, hasReconId}`), `MARK_PLACEDORDER_COMPLETED_START` (`PA/.../userSmallcase.js:10070,10209,10234,10447`) | Gates `RECON_HANDLING_START` logic and a `label === 'RECON_BUY'` branch that logs `description: 'Marking reconinitiated as false'` (`userSmallcase.js:10270`). **This `reconId` is unrelated to the `sc-integrations-jobs` reconciliation ("recon") jobs described in §1.3.6** — same word, two unconnected mechanisms. Its value's origin/full semantics were not confirmed in this research pass. |
| `transactionId` | **Not found.** Grepped across all 10 research documents — no field named `transactionId` appears anywhere in `sc-integrations-broker-lib`, `sc-platform-api`, or `sc-integrations-jobs`. | — | — | Do not assume this identifier exists. The nearest related (but distinct) concepts: `transactionType` (BUY/SELL side, from `orderLegDetails.orderSide` via `transactionTypesReverse`, `BL-SBI/services/order.js:32-52`) and `transactionFailureReason` (literal string `'Insufficient Balance.'` from the SBI security-hold API, `BL-SBI/services/security.js:58-67`) — neither is an id. |
| `correlationId` (not in brief, but load-bearing) | `batch.meta.correlationId`, minted upstream of `PA` | `applyBatchToIscid`/`applyMTFBatchToIscid` entry (`PA/.../userSmallcase.js:10029-10444`) | Every apply-flow `RECON_MULTI_DEBUG`/`DEBUG_MESSAGES` log line; is the actual Mongo key for `PlacedOrders._id` lookups/updates | The real DB key behind the `PlacedOrders` state machine (§1.5.1). Missing doc for a given `correlationId` → `PlacedOrderNotFound` (`SCBAT0002`). |

---

### 1.2 Service Map

**Confirmed hops** (both ends independently read in this research pass):

```
sc-platform-api  ──(BB_SERVICE_HOST)──►  sc-integrations-order-updates ("BB" = the batch/broker-broker
                                          service — this IS order-updates, not a separate hop, see below)
                                                              │
                                          require('@smallcase/sc-integrations-broker-lib')
                                          — IN-PROCESS, no HTTP hop to broker-api for this path
                                                              │
                                                              ▼
                                          sc-integrations-broker-lib
                                          (BL-SBI / BL-MTF adapter)
                                                              │
                                                              ▼
                                                     SBI's actual API
                                                (order-service, books-service,
                                                 bank-service, rmslimit-service, …)
```

`sc-platform-api → BB service` (confirmed, `PA/app/services/userSmallcase/userSmallcase.js:167-168,3628,3614,3644`): `placeOrdersNormal` delegates to the external npm package `@smallcase/sc-platform-babel`'s `smallcaseOrderFlow.placeOrders(...)`, which is **not source in any researched repo** — it POSTs to `BB_SERVICE_HOST`/`BB_SERVICE_PORT` (`PA/config/config.js:1112-1115` default port `8106`, likely an unused local default — see below). `bbParams.method` is `'placeDummy'` if `params.dummy` else `'place'`.

**GAP CLOSED — "BB" is `sc-integrations-order-updates` itself; broker-api is NOT in the SBI hot path.** The original research plan hit a harness quirk where two research agents misread a mid-conversation scope note as applying to their assigned repo and produced redundant `fetch-s3-logs.js` analysis instead of researching order-updates — a real gap the synthesis agent (correctly) flagged rather than papering over. It has since been closed by direct source/log verification, from three independent angles:

1. **Naming.** `sc-integrations-order-updates/config.js:46-47`: `BB_SERVICE_HOST = process.env.BB_SERVICE_HOST || 'http://127.0.0.1:8005'`. `BB` here is order-updates' own name for itself (mindmap doc: "Node.js 18, Express (**port 8005**)"). The `8106` default seen in `PA/config/config.js` is a different repo's stale/local-dev default for the same env-var-driven host — in any real environment both point at the same order-updates instance via env vars/service discovery, not the literal default ports.
2. **Code.** `sc-integrations-order-updates/lib/brokerApi.js:1`: `const brokers = require('@smallcase/sc-integrations-broker-lib');` and `package.json`: `"@smallcase/sc-integrations-broker-lib": "^16.11.15"`. order-updates bundles broker-lib as a direct dependency and calls it **in-process** — there is no HTTP call to a separate `sc-integrations-broker-api` service for order placement/status in this path. (`sc-integrations-jobs` does the same — also depends on `@smallcase/sc-integrations-broker-lib` directly, for its recon jobs' broker calls.)
3. **Live log evidence** (real production sample, `sc-integrations-order-updates`, 2026-06-05, SBI AMO batch): the log entries `"message": "broker action - placeOrder"` and `"message": "broker action - orderStatus"` (`"type": "SC_BROKER"`) — which carry the **raw outbound HTTP request/response to SBI itself** (`POST https://fhapi.sbisecurities.in/order-service/place-order`, `POST .../books-service/order-status`, full headers, full broker response body) — are emitted with `"name": "sc.service.sc-integrations-order-updates"`. If this HTTP call were proxied through a separate `sc-integrations-broker-api` process, that process — not order-updates — would be the one logging it. It isn't; order-updates makes the call itself.

**Practical consequence for log investigation** (matches the priority order already established: order-updates PRIMARY, jobs SECONDARY, everything else LAST RESORT): for a plain SBI/SBI-MTF order-placement or order-status question, `sc-integrations-broker-api`'s own logs are very unlikely to contain anything not already in order-updates' logs — broker-api is a real, separately-deployed service (`sc-mindmap` doc: TypeScript, port 8000, 20+ brokers) but per its own doc its callers are portfolio/funds/AutoSIP/RebalanceSIP/symbol-cache use cases, not confirmed as being in the plain order place/status loop for SBI. Treat broker-api as last-resort exactly as the user specified, and expect it to usually be empty for a pure order-status question.

**Confirmed order-updates log message catalog** (from the same real sample, `"type": "APPLICATION_LOGS"` unless noted), in rough chronological order for one order's lifecycle:

| Message | Type | What it contains |
|---|---|---|
| `"Order placed"` | APPLICATION_LOGS | order-updates' own normalized record immediately after a leg is placed — `context.order.{orderId,status,tag,batchId,broker,...}` |
| `"Order placement successful"` | APPLICATION_LOGS | Full **batch** snapshot right after placement, including `context.batch.meta.updates[]` (see below) |
| `"Batch saved"` | APPLICATION_LOGS | Full batch snapshot on a later save |
| `"Batch saved in ERROR state"` | APPLICATION_LOGS | Batch snapshot when transitioning into `ERROR` |
| `"[ERRORS] No mechanism found to this error batch"` | APPLICATION_LOGS | SBI's error-reconciliation `FIXBY.NONE` firing (§2.9) — logged once per poll attempt against a broker with no auto-fix mechanism |
| `"broker action - placeOrder"` | **SC_BROKER** | Raw outbound HTTP request+response to SBI's place-order endpoint (headers, body, response) |
| `"broker action - orderStatus"` | **SC_BROKER** | Raw outbound HTTP request+response to SBI's order-status endpoint — **the single richest log line for status questions**, contains both order-updates' own order context and the full raw SBI response including `orderStatusList[].orderLegDetails.orderStatus` |
| `"Broker Poll initiated"` | APPLICATION_LOGS | Poll cycle start — `context.orderStatusOptions` (the request about to be made) |
| `"Broker Poll Response"` | APPLICATION_LOGS | Normalized (broker-agnostic) response: `{code,reason,status,orderId,orderKey,exchangeOrderId,averagePrice,filledQuantity,tag,transactionType,orderTimestamp}` |
| `"Order update received"` | APPLICATION_LOGS | order-updates ingesting the poll result — same normalized shape as above, plus `broker`/`orderKey` |
| `"Broker poll error"` | APPLICATION_LOGS, **level 50 (error)** | e.g. `AxiosError ECONNABORTED "timeout of 9000ms exceeded"` — SBI's order-status endpoint has a 9000ms client-side timeout |

**THE key field for "what was the last update for this tag"**: `context.batch.meta.updates[]` (also appears at `context.order.meta.updates[]` in some entries) — an array of `{date, update}` human-readable strings, written chronologically by the shared `Order.saveOrder()` mongoose static (`@smallcase/sc-integrations-babel/src/models/Order.js`). Exact wording depends only on which **state** was saved, never on who/what triggered the save (see §5 for why this means it **cannot** be used to tell manual-vs-automated fixes apart):
- `` `Order saved initially with status ${status}` `` (state INITIAL, `Order.js:37`)
- `` `Order saved with status ${status}` `` (state PLACED, `Order.js:64`)
- `` `Order saved finally with status ${status}` `` (state FINAL — used by the error-reconciliation fix flow, `Order.js:101`)
- `` `Auto order saved with status ${status}` `` (state AUTO, `Order.js:113`)

Practical recipe: grep the tag/batchId across order-updates logs, take the chronologically-last `"Order placement successful"` / `"Batch saved"` / `"Batch saved in ERROR state"` entry, read `meta.updates[-1]` — that string plus its `date` directly answers "what was the last update."

`broker-lib → SBI's actual API` (confirmed, full endpoint table in `BL-SBI/config.js` `endpoint()`, `BL-MTF/config.js:31-50` — see the companion endpoint-inventory table already compiled from this research). Auth token, headers, redaction, and error-mapping logic all live in `BL-SBI`/`BL-MTF` `services/request.js`.

**`sc-platform-api` callback path** (confirmed, the return leg): the broker-broker service calls back into `sc-platform-api` at `POST /v2/internal/batch/apply` (`PA/routes/internalV2.js:407`) or `POST /v2/internal/batch/apply-mtf` (`PA/routes/internalV2.js:411`), landing in `applyBatchToIscid`/`applyMTFBatchToIscid` (§1.5.1).

**Where `sc-integrations-jobs` fits**: not in the live order-placement request path at all. It is a **reconciliation / cleanup / reporting layer** that runs against the same Mongo (`orders` collection) and calls back into the live services after the fact:
- Fix API: `POST {BB_SERVICE_HOST}/errors/fix/{batchId}` (all SBI recon jobs, `JOBS/jobs/reconciliations/sbiReconAllOrders.js` and siblings) — same BB service `sc-platform-api` talks to for placement.
- Dealer bulk-batch creation (backfill script): `POST {platformApiService.url}/v2/internal/orders/autosip/preorder` then `POST {platformApiService.url}/v2/internal/batch/apply?broker=sbi` (`JOBS/jobs/reconciliations/sbiDealerRecon3Feb2025.js:136,171`) — calls directly into `sc-platform-api`'s own internal routes from §1.2, bypassing the BB service entirely.
- Redis population jobs (`putBrokerSymbolsInRedis`, `putBrokerMtfsInRedis`) populate the `SID:<sid>` / `MTF:<sid>` Redis hashes that `BL-MTF/services/fund.js` reads at order-placement time (§1.3.5) — an upstream dependency of the live path, not a downstream consumer.
- AMO/activation-eligibility polling (`triggerAmoPoll.js`) and hanging-order/EOD reports (`hangingOrderEodReport.js`, `cleanupMtfNonTerminalBatches.js`) — read-then-mutate jobs against `Order` docs, detailed in §1.3.6 and §1.5.

**Where leprechaun (staging mock) fits**: it is a parallel implementation selected inside `broker-lib` itself, not a separate hop in the chain. `BL-MTF/config.js:19`: `brokerName = isLeprechaun ? 'sbi-mtf-leprechaun' : 'sbi'`. Leprechaun dealer detection differs from the real broker (`_d` suffix on `requestToken`, or `brokerParams.dealerId`/`.dealer===true`, or `dealerAuthData`, vs. the real broker's `dealer_emp` field — `BL-SBI/services/user.js:176-242`; comment there says this leprechaun-detection shape was copied from HDFC/Axis/Kotak, i.e. not an SBI-specific convention). Leprechaun login is loud: `'DEBUG: ...'`-prefixed lines logged at **info** level, not filtered (`BL-SBI/services/user.js:253,262,273,277,304`) — a greppable marker that a trace is on the mock path. `LEPRECHAUN_API_ENDPOINT` env var is the fallback host for both SBI and SBI-MTF leprechaun traffic (`BL-MTF/config.js`, and separately `PA/config/config.js:170`). `sc-integrations-jobs`'s `cleanupMtfNonTerminalBatches.js` includes `'sbi-mtf-leprechaun'` in its default broker list; `iscAndBatchStatus.js` explicitly excludes any `/leprechaun/i` broker from the prod-facing email.

---

### 1.3 Order Lifecycle by Variant

#### 1.3.1 Regular order (BUY / REBALANCE / EXIT)

1. `POST /user/sc/placeOrders` (`PA/routes/user.js:480,491`; multi-order variant `/placeOrders/multi` at `:535`; dummy variant `/placeOrders/dummy` at `:494,507`) → `userSmallcaseController.js:259` `placeOrders`.
2. `req.body.label === 'SELLALL'` → `placeOrdersSellall`; else → `validateAndPlaceOrdersNormal` (`:853`) → `placeOrdersNormal` (`:951`).
3. `placeOrdersNormal` assembles a `config` object (`label, source, iscid, scid, did, batchId, name, version, requestId, reconId, dummy, dummySource, isGroupOrder, nri, variety, orderMode, twoStepRebalance, gateway, agent, dealerId, rmId, distributor, batchTag(≤256 chars), archiveLastBatch, reconInitiated, dealerDetails, weightConfig, sharesConfig`) → `uSService.placeOrders(...)`.
4. Delegates to `smallcaseOrderFlow.placeOrders` (external package, §1.2 GAP applies from here through the BB service into broker-lib).
5. Log trail in `PA/.../userSmallcase.js`: `:3448` `serviceLogger.error(err, {subtype:'PLACEORDERS_ACCESSTOKEN_ERROR'})`; `:3614` `serviceLogger.info({subtype:'PLACEORDERS_SMALLCASEORDERFLOW_DEBUG', message:{userDoc,userParams,investedSmallcase,batch,bbParams}})` (full outgoing batch payload); `:3638` `PLACEORDERS_SMALLCASEORDERFLOW_ERROR`; `:3644` `PLACEORDERS_SMALLCASEORDERFLOW_SUCCESS`.
6. Inside `broker-lib`, `place()` builds the order object via `_getBrokerOrderObject` (`BL-SBI/services/order.js:181-233`; `BL-MTF/services/order.js:186-244`) and calls `POST {api_endpoint}/order-service/place-order`, `tag` = freshly generated (`sc_...` / `scmtf_...`), `product` = `1` (SBI) or `6` (MTF).
7. Response mapped by `_mapPlaceOrderResponse` on `shortfallDetails.shortfallFlag` (`N`/`Q`/`F`) — see error-code tables in the companion research; `PLACED` iff `shortfallFlag === 'N'`.
8. BB service confirms → callback `POST /v2/internal/batch/apply` → `applyBatchToIscid` gate: `PlacedOrders.status ∈ {ACKED, RECEIVED, QUEUED}` else `InconsistentOrderState` (`SCBAT0003`) → sets `APPLIED` (`:10209`) → `markPlacedOrderAsCompleted` sets `COMPLETED` (`:10460-10463`), gated on the user's `investedSmallcases[].status` no longer being `'PLACED'` (`:10446-10489`; **silent no-op, no log**, if still `PLACED` — see §1.5.1 gotcha).
9. Ongoing status resolution is **polling only** for SBI-MTF: `orderStatusBy: {postback:false, polling:true}` (`BL-MTF/config.js` L63-66) — no webhook/postback path exists in the researched broker-lib code; `getOrderDetails` → `POST /books-service/order-status` is the mechanism.

#### 1.3.2 AMO (after-market order)

- `variety === 'amo'` forces `orderSlot = OFF_MARKET(2)` and `orderValidity = DAY(1)` regardless of requested validity (`BL-SBI/services/order.js:171-179`; `BL-MTF/services/order.js` L30-38, `_resolveOrderValidity`).
- Active-hours windows (IST, `BL-SBI/services/misc.js:48-88`): before 09:00 → `[19:00 IST yesterday, 08:59 IST today]`; 09:00–09:15 → narrow `[09:07, 09:14]`; else → `[19:00 IST today, 08:59 IST tomorrow]`. Cancel window mirrors the place window exactly.
- `JOBS/jobs/triggerAmoPoll.js:106-113`: `sbi` and `sbi-mtf` are **hardcoded** into `amoAllowedBrokers` via `.concat(['sbi','sbi-mtf'])`, independent of whatever `broker-lib`'s own `config.amoAllowed` says.
- Activated-AMO polling gotcha (`triggerAmoPoll.js:83-89`, comment verbatim: *"special case, sbi and axis is the only broker where activated orders polling will be triggered"*): the activated-order exception list is `{broker: {$in: ['sbi','axis']}}` — **`sbi-mtf` is not in it**. Plain `sbi` activated AMO orders get polled; **activated `sbi-mtf` AMO orders do not** get picked up by this job.
- AMO rejections ingest separately: `JOBS/jobs/reconciliations/sbiRejectedAmoOrdersIngest.js` reads `sbi_rejected_amo_orders/<date>/` from S3, only processes `batch.variety === 'amo'` (others skipped with `logger.info('Skipping batch — not an AMO batch', {batchId, variety})`), writes `statusMessage: "Order Rejected: <reason>"` (constant `REJECTED_STATUS_MESSAGE_PREFIX`, chosen specifically to match broker-lib's `invalidOrder` regex — L42-43), and is **dry-run unless `--save`** is passed (silent no-DB-write default).

#### 1.3.3 Activation order (dealer-placed bulk orders)

**Important correction to the brief's framing**: the `JOBS/jobs/activations/*` pipeline (`ingestActivatedUsers.js` → `placeActivatedOrders.js` → `pollActivatedOrders.js` → `removeUnfilledOrdersEod.js`) is **100% Axis-specific** — `grep -i sbi` across all five files returns zero hits (`broker = 'axis'` hardcoded throughout). SBI has no equivalent scheduled activation pipeline in this codebase.

What SBI actually has for "dealer bulk order placement":
1. **Live dealer flow** (via the normal `place()` path, not a job) — see §1.4.3.
2. **Manual/backfill script** `JOBS/jobs/reconciliations/sbiDealerRecon3Feb2025.js` `main()`: reads a flat dealer-orders CSV (hardcoded path `./jobs/reconciliations/dealerRecon2.csv`, hardcoded date `2025-02-03T05:00:00Z`), synthesizes `Order` docs with `dealer:true, source: smallcase.source`, calls `POST /v2/internal/orders/autosip/preorder` (obtains `correlationId`/`newIscid`) then `POST /v2/internal/batch/apply?broker=sbi`. Not a scheduled job — one-off.
3. **Automated self-heal** `JOBS/jobs/reconciliations/sbiReconHelperFiles/sbiReconBatchCreation.js` `createBatchesFromLogs`: for tags missing from `orders`/`unplaced` but present in the Mongo audit collection `dealerOrderDownloadLogs` (`payload.dealerOrders[].tag`, `payload.iscid`, `dealerId`, `userId`), synthesizes an `Order` doc (`status:'COMPLETED', dealer:true, variety:'regular'`, `meta.type: "reconInsert <date>"`). Gated by `--createMissingBatches`.

`sbi` still participates in the generic **activated-order** concept elsewhere: `sbiActivationAutosipReport.js` counts `Order.countDocuments({activated:true, broker:'sbi', date:{$gte,$lt}})` daily (today 12am–tomorrow 12am IST), and `triggerAmoPoll.js`'s activated-AMO exception (§1.3.2) references `broker:'sbi'`. Neither of these places new orders — they poll/report on orders placed via §1.4.3.

#### 1.3.4 AutoSIP

- Trigger inside `place()`: SBI regular — `options.label == 'AUTOSIP' || options.activated || options.autoSip` (`BL-SBI/services/order.js:273`); SBI-MTF — `options.label == 'AUTOSIP' || options.activated` (`BL-MTF/services/order.js` L283, **missing the `options.autoSip` check** present in SBI regular).
- Delegates to `autosipService.placeOrder` → `POST /sipbasket-service/smallcase-sip-place-order` (`BL-SBI/services/autosip.js:5-38`).
- `accountSettlementType`: SBI regular decodes `nriFlag` from the access token; **SBI-MTF hardcodes `0`** regardless of actual NRI status (`BL-MTF/services/autosip.js`, no `decodeAccessToken` import at all).
- Response: `result.internalOrderNumber` present → `{code:true, status:PLACED, orderId}`; else → `{code:false, statusMessage:'Unknown error'}` (no further detail captured either broker).
- `Sip.delete`: SBI regular no-ops with a synthesized success and logs `'Successful request'` (`BL-SBI/api.js:257-261`); **SBI-MTF has no `delete` method on `Sip` at all** — calling it would throw/`undefined`, not silently no-op.
- `JOBS/config.js:373`: `autosip.enableForBrokers` default `'axis,kotak,sbi,kite'` — note `sbi-mtf` is **not** in this literal default string; whether it's added via env override was not confirmed in this pass.
- `JOBS/jobs/autosips/sbi/*.js` files exist (`createSbiAutosipOrders.js`, `createSbiAutosipOrdersByIscids.js`, `createSBIAutosipOrders-NonWorkingDay.js`, `sbiRebalanceSipOrderPlace.js`) but **were not read this pass** — only their paths are known. Do not cite internal logic for them.
- `sbiActivationAutosipReport.js`: daily count/summary email only (no fixing), `brokerName = 'sbi'` — **no `sbi-mtf` counting in this report** per the corpus. `Order.countDocuments({label:'AUTOSIP', broker:'sbi', date:{$gte,$lt}})`.

#### 1.3.5 Two-step rebalance

- `twoStepRebalance` is a field on the `placeOrdersNormal` config object at `PA` (`userSmallcaseController.js`, field list in §1.3.1 step 3) — confirmed to exist and be passed through.
- `twoStepRebalanceEnabled` exists as a broker-lib config flag **only for SBI regular**; it is **absent entirely** from `BL-MTF/config.js`.
- SBI regular has an additional `rebalanceBasketFlag` retry path in funds-check (`BL-SBI/services/fund.js:182,211`, log strings `'Funds Check For Minimum Required Funds'` / `'Request Params: Funds Check with Minimum Required Funds'`) that recomputes `minRequiredFunds` and re-calls the funds-check API — **this retry path does not exist in `BL-MTF/services/fund.js` at all**.
- **Not confirmed**: the research corpus does not describe which service actually orchestrates the two legs of a two-step rebalance (what triggers the second placement, what state it waits on). Nothing beyond the config-flag-existence facts above was found — do not infer an orchestration mechanism.

#### 1.3.6 Recon

Detailed job-by-job mapping (all in `JOBS/jobs/reconciliations/` unless noted):

| Job | Scope | Fix mechanism | Write gate |
|---|---|---|---|
| `sbiReconAllOrders.js` | Full-day recon, all sbi+sbi-mtf (dealer + non-dealer) vs. broker order-status CSV (`sbi_recon/<date>/`, `mtf_recon/<date>/` in S3) | `fixBatchByTradebook(batchId, tradebook)` → `POST {BB_SERVICE_HOST}/errors/fix/{batchId}`, body `{fixBy:'orderbook', tradebook, force:true}` | Always writes (no dry-run flag on the fix call itself); `--recreateInvestment`, `--createMissingBatches`, `--createDealerDuplicateBatches` gate sub-features |
| `sbiRejectedAmoOrdersIngest.js` | AMO rejections only (`sbi_rejected_amo_orders/<date>/`) | Same fix API | **Dry-run by default** — real write only with `--save`; without it, logs `'[DRY-RUN] Would call fix API'` and returns |
| `sbiDealerRecon.js` / `sbiDealerRecon3Feb2025.js` | Dealer orders vs. explicit `--filepath` CSV, `--from`/`--to` date range | Same fix API | `sbiDealerRecon3Feb2025.js` (predecessor) hardcodes every parsed row to `status:'REJECTED'` regardless of actual CSV content (`// check the complete enum for order status` — unresolved TODO) — current `sbiDealerRecon.js` maps `T`→`COMPLETE` correctly |
| `cleanupMtfNonTerminalBatches.js` | SBI-MTF (and other MTF brokers) stuck in `UNPLACED`/`UNFILLED`/`PARTIALLYFILLED` | Direct `Order.updateOne` (no BB-service call) | Dry-run by default, `--save` to apply; marks `MARKEDCOMPLETE` only if a newer batch exists for the same `iscid` |
| `hangingOrderEodReport.js` | Broad: any broker with status `ERROR`/`PLACED`/`PARTIALLYPLACED` past a time window | Report only, no fix | Email report only, grouped by broker (sbi/sbi-mtf are separate buckets) |

---

### 1.4 Dealer Authentication + Dealer Order Placement

#### 1.4.1 sc-platform-api dealer-terminal layer

`app/integrations/sbi/sbi.dealerTerminal.integrations.js` — the **only** SBI-specific integration file in `sc-platform-api`. Handles dealer **login only** (`authenticateDealer`), not order placement. Error codes `SBIDT001`–`SBIDT005` (400/401/404/default/api-error). Log subtypes `DEALER_TERMINAL_REQUEST`, `DEALER_TERMINAL_ERROR`. Routed to via `broker.toLowerCase().startsWith('sbi')` (`PA/app/services/auth.js:1700-1702`, `authController.js:102-112`, `token.js:161-170`), session TTL noted as **1 day** at this layer.

#### 1.4.2 broker-lib dealer detection + token caching

- Dealer detection (`detectDealerLogin`, `BL-MTF/services/user.js` L63-129; `BL-SBI/services/user.js:176-242`): checks, in order, `requestToken` containing `_` (leprechaun `userId_dealerId` split), then `options.brokerParams` JSON for `dealer_emp` / `dealerId` / `dealer===true`, then `options.dealerAuthData`. **Real (non-leprechaun) broker**: presence of `dealer_emp` in the decrypted `brokerParams` is the signal.
- Dealer endpoint host is **shared** between SBI and SBI-MTF — both read `process.env.SBI_DEALER_LOGIN_API_ENDPOINT` (`BL-SBI/config.js:5`, `BL-MTF/config.js:16`, confirmed identical env var):
  - `getDealerDetails` → `POST {DEALER_API_ENDPOINT}/dealer-authentication-service/dealer-details`
  - `placeDealerOrder` → `POST {DEALER_API_ENDPOINT}/dealer-authentication-service/place-order`
- Token cache: `authenticateDealer` (`BL-SBI/services/user.js:402-443`; `BL-MTF/services/user.js` L425-466) stores the dealer's SBI access token in Redis at `sbi:dealer_token:{entityId}:{userId}` (SBI) / `sbi-mtf:dealer_token:{entityId}:{userId}` (SBI-MTF) — different key **namespace** despite sharing the same auth host — TTL `DEALER_TOKEN_TTL_SECONDS = 28800` (8h).

#### 1.4.3 Dealer order placement wire flow

`place()` (`BL-SBI/services/order.js:260-269`; `BL-MTF/services/order.js` L267-320): `decodeAccessToken(options.accessToken)` → `{token, userId, dealerId, nriFlag}`. If `dealerId` present:

```
if (!options.dealerDetails):
    return { response: { orderId: 'NA', statusMessage: 'order placed by dealer', status: scStatus.PLACED } }
    # SHORT-CIRCUIT — broker is NEVER actually called. Grep "orderId":"NA" + "order placed by dealer".
else:
    → placeDealerOrder(...)
```

If `options.dealerDetails` is present, `placeDealerOrder` builds `dealerAccountDetails{entityId, tokenId, userId}` from the cached Redis token (`options.redis.get(redisKey)`); if the key is missing → `{error: new Error('Dealer session not found or expired, please re-authenticate')}` (`BL-SBI/services/order.js:155-157`) — the grep target for a stuck dealer batch. Wire payload nests under `dealerorderparameterbean.{dealerorderDetails, dealerorderLegDetails, dealerorderPriceDetails, dealerorderQuantityDetails}` (`BL-MTF/services/order.js` L108-162).

#### 1.4.4 Dealer-specific quirks (grep table)

| Quirk | SBI regular | SBI-MTF |
|---|---|---|
| `orderValidity` on dealer order | Hardcoded `IOC(2)` (`BL-SBI/services/order.js:130`) | `_resolveOrderValidity()` (dynamic, `BL-MTF/services/order.js` L143) |
| `product` on dealer order | `1` (CASH) | `6` (MTF) |
| Request timeout | `placeOrder`/`getDealerDetails`/`placeDealerOrder` all get `timeout:0` (no timeout) | `placeDealerOrder` is **not** in the no-timeout list — keeps default `9000`ms (`BL-MTF/services/request.js` L112-116) |
| Funds-check for dealer orders | Not documented as bypassed in the SBI-regular corpus | `check()` short-circuits to `{sufficientFunds:true, requiredFunds:0}` **without calling the broker** whenever `dealerId` is decoded from the token (`BL-MTF/services/fund.js` L289-291) — dealer MTF orders never go through funds-check |
| Cancel-order `product` field | Not flagged as anomalous in the corpus | `cancelOrder`'s payload sets `orderLegDetails.product: constants.products.CASH (1)`, **not MTF (6)**, unlike every other order-mutating call in the file — flagged as a likely bug (`BL-MTF/services/order.js` L507) |
| Cancel success status | Literal string `'CANCELLED AMO'` always, regardless of actual variety (`BL-SBI/services/order.js:551`) | Same literal, synthesized object (`BL-MTF/services/order.js` L544-553) |

---

### 1.5 State Machines

**Explicit disclaimer before the tables below**: the brief cites "`Order.txnStatus`" and "`lib/objects.js`" as the source to cite for these transitions. **Neither string appears anywhere in the research corpus.** No agent in any of the 10 research passes read a file called `lib/objects.js`, and the field name `txnStatus` was never encountered — every researched status field is called `.status` (on `Order`, `PlacedOrders`, or `User.investedSmallcases[]`). Do not present the tables below as if sourced from `lib/objects.js`; they are reconstructed from the concrete log lines and Mongo queries actually read across `sc-platform-api` and `sc-integrations-jobs`.

#### 1.5.1 `PlacedOrders.status` (sc-platform-api) — the best-documented FSM in the corpus

```
QUEUED → { ACKED | RECEIVED | QUEUED }(gate) → APPLIED → COMPLETED
```

| Transition | Trigger | Citation |
|---|---|---|
| → `QUEUED` | Deferred-rebalance-basket path for AUTOSIP, via `PlacedOrdersRepository.markStatusAsQueued({correlationId})` | `PA/.../userSmallcase.js:10141-10146` |
| Gate into `applyBatchToIscid` | `status ∈ {'ACKED','RECEIVED','QUEUED'}`; any other value throws `InconsistentOrderState` (`SCBAT0003`) | `:10084-10089` |
| Gate into `applyMTFBatchToIscid` | Same three-value gate, independent code path | `:10367-10372` |
| → `APPLIED` (apply) | Immediately after the gate passes, `models.PlacedOrders.updateOne({_id: correlationId}, {$set:{status:'APPLIED'}})` | `:10203-10209` |
| → `APPLIED` (apply-mtf) | Same, MTF path | `:10395-10401` |
| → `COMPLETED` (auto) | `markPlacedOrderAsCompleted`, called right after apply/apply-mtf returns | `:10446-10465` |
| → `COMPLETED` (explicit) | `/batch/markComplete` receiver → `markPlacedOrderCompleted`; **requires `status === 'APPLIED'`** (a second, independent gate) **and** `User.investedSmallcases[].status !== 'PLACED'` for that `iscid` | `:10513-10540` |
| **Silent stall** | If `investedSmallcases[].status` is still `'PLACED'` when `markPlacedOrderCompleted` runs, the function **no-ops with zero log output** — `PlacedOrders` stays at `APPLIED` forever with no error trail on this endpoint | `:10513-10540`, flagged explicitly in platform-api research §Gotchas |

Missing `PlacedOrders` doc for a `correlationId` → `PlacedOrderNotFound` (`SCBAT0002`) at either gate.

#### 1.5.2 `Order` ("batch") document status — literal values seen across jobs, **no single canonical enum source read**

No model/schema file defining the full `Order.status` enum was read in this pass. The following literal strings are each individually confirmed via a specific query or write site — treat this as an evidence list, not a verified exhaustive enum:

| Literal | Where seen | Meaning (as used) |
|---|---|---|
| `PLACED` | `hangingOrderEodReport.js` query (`status: {$in:["ERROR","PLACED","PARTIALLYPLACED"]}`, `JOBS/jobs/sanity/hangingOrderEodReport.js:18-28`) | Non-terminal / hanging candidate |
| `PARTIALLYPLACED` | same | Non-terminal / hanging candidate |
| `ERROR` | same | Non-terminal / hanging candidate |
| `UNPLACED` | `cleanupMtfNonTerminalBatches.js` `NON_TERMINAL_STATES` (`JOBS/jobs/sanity/cleanupMtfNonTerminalBatches.js:26`) | MTF non-terminal, cleanup-eligible |
| `UNFILLED` | same | MTF non-terminal, cleanup-eligible |
| `PARTIALLYFILLED` | same | MTF non-terminal, cleanup-eligible |
| `MARKEDCOMPLETE` | write target of `cleanupMtfNonTerminalBatches.js` (`:94-105`); also listed as terminal in `sbiReconAllOrders.js` `orderTerminalStates` (`JOBS/jobs/reconciliations/sbiReconAllOrders.js:31-36`) | Forced-terminal by cleanup job when a newer batch exists for the same `iscid` |
| `FIXED` | `sbiReconAllOrders.js` `orderTerminalStates` | Terminal, set by recon fix flow (exact write site not read) |
| `CANCELLED` | `sbiReconAllOrders.js` `orderTerminalStates` | Terminal |
| `COMPLETED` (with **D**) | `sbiReconAllOrders.js orderTerminalStates`; `sbiReconBatchCreation.js` synthesized batches (`status:'COMPLETED'`); `PlacedOrders.status` (§1.5.1) | Terminal / success |
| `COMPLETE` (**no D**) | `sbiRejectedAmoOrdersIngest.js`: `order.status === 'COMPLETE' → skip` (§1.3.2 table); matches broker-lib's `scStatus.COMPLETE` (§1.5.3) | Terminal / success |

**Flagged inconsistency, not resolved**: both `'COMPLETE'` and `'COMPLETED'` appear in the corpus referring to what reads as the same terminal concept, in different job files, without a schema file to arbitrate which is canonical on the `Order` document. A future investigation should verify which spelling the actual `Order` model uses before writing a query that filters on either string alone.

#### 1.5.3 broker-lib `scStatus` + raw SBI `orderStatus` → `scStatus` mapping

Canonical broker-lib output enum (`BL-SBI`/`BL-MTF` `constants.js:10-15`): `PLACED`, `ERROR`, `REJECTED`, `COMPLETE`. **No `CANCELLED` value in `scStatus`** — the cancel path returns the ad-hoc literal `'CANCELLED AMO'` instead (§1.4.4), never `constants.scStatus.CANCELLED`.

Raw SBI wire code → `orderStatuses` name → `orderStatusesReverse` (→ `scStatus`), identical for both brokers (`BL-SBI/constants.js:99-130`; `BL-MTF/constants.js:100-131`):

| Raw code | Name | → sc `status` |
|---|---|---|
| 1 | PENDING | `PLACED` |
| 2 | MODIFIED | `PLACED` |
| 3 | PARTIALLY_TRADED | `PLACED` |
| 4 | TRADED | `COMPLETE` |
| 5 | TRANSIT | **unmapped → falls to `'ERROR'`** |
| 6 | CANCELLED | `CANCELLED` |
| 7 | EXPIRED | **unmapped → falls to `'ERROR'`** |
| 8 | FREEZED | **unmapped → falls to `'ERROR'`** |
| 9 | REJECTED | `REJECTED` |
| 10 | QUEUED | `PLACED` |
| 11 | SENT_TO_EXCHANGE | `PLACED` |
| 12 | GTDT_BLOCKED | `REJECTED` |
| 99 | ALL | query-only, not a real status |

Source comment, present verbatim in both brokers' `constants.js`: `// todo: confirm the commented out statuses` — codes 5/7/8 are explicitly **unconfirmed** by the original authors and surface to smallcase as a generic `ERROR` with no further distinction.

#### 1.5.4 `investedSmallcases[].status` — partial, 3 literal values only

| Value | Where set/checked |
|---|---|
| `PLACED` | Blocks `markPlacedOrderCompleted` from flipping `PlacedOrders` to `COMPLETED` while still set (§1.5.1) |
| `VALID` | Set by `JOBS/jobs/sanity/iscAndBatchStatus.js` `--updateStatusInDB` when a stuck-`PLACED` isc's last `Order` is `COMPLETED`/`MARKEDCOMPLETE` and stale |
| `INVALID` (`investedSmallcaseStatus.INVALID`) | Read at `PA/.../userSmallcase.js:10174` to decide whether to archive the previous batch before an AUTOSIP apply |

No full enum for this field was found in the corpus — treat as a partial list.

---


---

## Section 2: Status Codes, Error Codes & Broker Response Semantics (SBI & SBI-MTF)


Scope: `sc-integrations-broker-lib/src/brokers/{sbi,sbi-mtf}/*`, `sc-integrations-jobs` reconciliation/sanity jobs, `sc-platform-api` batch-apply layer. All codes below are broker-response-level (SBI wire format) unless marked "smallcase-internal". SBI and SBI-MTF share almost all of this table verbatim; divergences are called out explicitly.

---

### 2.1 Raw Broker `orderStatus` Codes → smallcase `status`

Source: `sbi/constants.js:99-130`; **identical table** in `sbi-mtf/constants.js:100-131` (mapping logic `orderStatusesReverse` at L116-131). Applied in `_mapBrokerOrderResponseToSC` (`sbi/services/order.js:32-52`, `sbi-mtf/services/order.js:46-66`).

| raw `orderStatus` | broker name (`orderStatuses`) | → smallcase `status` | Internal state | smallcase-side effect |
|---|---|---|---|---|
| `1` | PENDING | `PLACED` | pending | order live at exchange, awaiting fill/next poll |
| `2` | MODIFIED | `PLACED` | pending | live, modified in-flight |
| `3` | PARTIALLY_TRADED | `PLACED` | pending (partial fill) | `filledQuantity` = `orderQuantityDetails.tradedQuantity`, status stays PLACED |
| `4` | TRADED | **`COMPLETE`** | settled | terminal, fill recorded (`averagePrice` = `totalTradedValue / tradedQuantity`) |
| `5` | TRANSIT | **unmapped → falls to `'ERROR'`** | indeterminate | generic ERROR, no distinguishing detail retained |
| `6` | CANCELLED | `CANCELLED` | terminal, no/partial fill | — |
| `7` | EXPIRED | **unmapped → falls to `'ERROR'`** | indeterminate | generic ERROR |
| `8` | FREEZED | **unmapped → falls to `'ERROR'`** | indeterminate | generic ERROR |
| `9` | REJECTED | `REJECTED` | rejected (unplaced) | triggers `getOrderRejectionReason()` round-trip (§2.6) to populate `statusMessage` |
| `10` | QUEUED | `PLACED` | pending | — |
| `11` | SENT_TO_EXCHANGE | **`PLACED`** | pending | order acknowledged, not yet filled |
| `12` | GTDT_BLOCKED | `REJECTED` | rejected (unplaced) | same rejection-reason enrichment as code 9 |
| `99` | ALL | — | n/a | query-only wildcard, never a real order's status |

`sbi/constants.js:116` — verbatim comment `// todo: confirm the commented out statuses` (identical TODO present in `sbi-mtf/constants.js`). **Codes 5/7/8 are explicitly unconfirmed in source** — any order the broker reports as TRANSIT, EXPIRED, or FREEZED is indistinguishable from a generic error once it reaches smallcase; the raw code itself is not logged anywhere downstream of this mapping.

**smallcase-internal note**: Order docs additionally track two arrays — `orders[]` (broker-matched, has a real `orderId`/`tag`) and `unplaced[]` (tag never resolved to a broker order) — e.g. `Order.findOne({..., $or:[{'orders.tag':tag},{'unplaced.tag':tag}]})` (`sbiRejectedAmoOrdersIngest.js`, per jobs-sbi-activations-recon research). "Unplaced" in the Order-doc sense is a separate concept from the raw `orderStatus` enum above — an order can be REJECTED (broker rejected it) and still live in either array depending on which side wrote it first.

---

### 2.2 Direct answer — "order status 4 or 11"

**Confirmed in research, both apply identically to SBI and SBI-MTF:**

- **`orderStatus: 4`** = `TRADED` → smallcase `status: 'COMPLETE'` (settled, filled). Citation: `sbi/constants.js:99-130`, `sbi-mtf/constants.js:100-131`.
- **`orderStatus: 11`** = `SENT_TO_EXCHANGE` → smallcase `status: 'PLACED'` (pending — order acknowledged by the exchange, not a stuck/error state on its own).

Neither code maps to `ERROR`. If a batch showing raw `orderStatus: 11` looks "stuck," it is stuck in the ordinary PLACED/pending sense (waiting for a fill or a later poll to observe `4`/`6`/`9`), not a mapping failure — the mapping failures live at codes `5`/`7`/`8` (§2.1).

**Independently cross-validated against real production data** (not just source code): in a real SBI AMO batch sample (2026-06-05), every `orderStatusList[]` entry with `orderLegDetails.orderStatus: 4` had `orderQuantityDetails.tradedQuantity === orderQuantityDay` (fully filled), and every entry with `orderStatus: 11` had `tradedQuantity: 0` (nothing filled yet) — confirming the `4`→filled / `11`→pending mapping empirically, from actual broker responses, not just the constants file. (`orderStatus: 1` was also observed with `tradedQuantity: 0` — same "unfilled" shape as `11` but a distinct code; §2.1's source-level `PENDING` vs `SENT_TO_EXCHANGE` distinction is the best available explanation, not separately re-confirmed live.)

---

### 2.3 Place-Order `shortfallFlag` State Machine

Source: `_mapPlaceOrderResponse`, `sbi/services/order.js:54-91`; identical logic `sbi-mtf/services/order.js:69-106`, keyed on `response.result.shortfallDetails.shortfallFlag`.

| `shortfallFlag` | Meaning | Resulting fields | smallcase-side effect |
|---|---|---|---|
| `'N'` | No shortfall | `status: PLACED, orderId: result.internalOrderNumber` | success — order accepted |
| `'Q'` | Quantity shortfall (insufficient holdings/margin-eligible qty) | `statusMessage: "Quantity shortfall: ${shortfallValue}"` — **no `status:PLACED` set** | falls through to `failureHandler` (`Orders.place`, `sbi/api.js:151-171` only treats `status===PLACED` as success) → placement fails, `statusMessage` re-classified via `getErrorCode()` → `checkHoldings` (§2.5) |
| `'F'` | Funds shortfall | `statusMessage: "Funds shortfall: ${shortfallValue}"` — same, no `status:PLACED` | failure → `getErrorCode()` → `marginExceeded` |
| no `response.result` at all | generic API error | `statusMessage = messageList[0].messageDescription \|\| 'Unknown API error'` | failure |
| anything else / unrecognized flag | unhandled | `error: Error('order placement failed'), statusMessage: response.error \|\| 'Unknown error'` | **the actual unrecognized flag value is never logged** — no way to reconstruct "what flag X meant" from logs after the fact |

Both brokers use the identical `N`/`Q`/`F` set — no MTF-specific shortfall flag value beyond these three was found; the difference is only in how the resulting `Quantity shortfall:` / `Funds shortfall:` strings get re-classified downstream (§2.5, MTF has a richer regex set).

---

### 2.4 Numeric `messageCode` / `responseCode` Values

| Code | Meaning | Scope | Citation |
|---|---|---|---|
| `messageCode: 600014` | "No data found" for the given `accountSettlementType` on an order-status query → triggers a retry across settlement types `[0,2,3]` for NRI-eligible accounts | **SBI regular only** | `sbi/services/order.js:363-378` |
| `messageCode: 600014` on an **SBI-MTF** order-status query | Same meaning, but **no retry loop exists in `sbi-mtf/services/order.js`** (confirmed absent by diff — no `600014` reference in the file) | SBI-MTF | broker-lib-sbi research §2 |
| `messageCode: 709152` (`ERR_POSITIVE_AMT`) | Funds-check API errors on a literal `0`/positive-amount validation | both (SBI: `sbi/services/fund.js:7,164,244`; SBI-MTF: `sbi-mtf/services/fund.js:8,187`) | both brokers special-case this as **success**: `{code:true, sufficientFunds:true}` |
| `responseCode == 0` | Success, on `fundsCheck`/`viewLimits` responses | both | `handleFundsHoldResponse`, note `sbi-mtf/services/fund.js` uses loose `==` not `===` |
| `responseCode === 1` (on the rejection-reason endpoint's **caught HTTP error**) | Deliberately reinterpreted as a valid rejection lookup, not a failure | both | `sbi/services/request.js:201-219`; MTF: `request.js` L183-201 |

**MTF-vs-SBI dead end**: an MTF order-status query returning `600014` for the wrong settlement type has no automatic retry — it is a dead end at whatever settlement type was tried first. This is a concrete, cite-able reason an MTF order-status lookup can come back "not found" where the equivalent SBI-regular lookup would have retried and succeeded.

---

### 2.5 `statusMessage` → `errorCode` Classification (`config.getErrorCode`)

Regex-tested against `order.statusMessage`, first match wins, fallback = literal `'otherError'`.

**SBI regular** — 6 keys, `sbi/config.js:170-178`:

| errorCode | matches (substring) |
|---|---|
| `checkHoldings` | `Quantity shortfall: N. Please hold the stocks through the SBI Securities App...` or bare `Quantity shortfall: N` |
| `marginExceeded` | `Funds shortfall: N` or `Order Rejected: Funds violation by N` |
| `userNotLoggedIn` | `You are already logged in from another device...` or `Entity ... Is Already Logged In Through OWS Operator.` |
| `clientNotEnabled` | `EQU: ... is deactivated on all Exchanges in CASH product` / `... suspended on all Exchanges in all products` |
| `tradingSystemNotReady` | `IOC Orders are not allowed in PreOpen Session` / `Closing Price is not available` |
| `securityNotAllowed` | `Square-off your today's position...` / `SECURITY ... is Suspended by MATRIX Internally` / `Cash buy orders are not allowed on the security` / `Currently orders are not allowed on ..., Please try later.` |

**SBI-MTF** — 9 keys (3 more than SBI regular), `sbi-mtf/config.js:159-169`, verified exact strings via `sbi-mtf/tests/config.test.js:46-176`:

| errorCode | matches (substring) | MTF-only additions vs SBI regular |
|---|---|---|
| `checkHoldings` | `Quantity shortfall: 10 . Please hold the stocks...` / `Fresh sell orders are not allowed on E-Margin product` | broadened trailing-sentence + E-Margin phrase |
| `marginExceeded` | `Funds shortfall: 500.75` / `Order Rejected: Funds violation by 1644.27` | same as SBI |
| `userNotLoggedIn` | same as SBI | — |
| `clientNotEnabled` | broadened regex covering `(deactivated\|suspended) on all Exch(anges in CASH\|anges in all\|in all) product` | broader alternation |
| `tradingSystemNotReady` | + `Market is not open for trade` + `Emargin product is currently unavailable. Kindly place delivery order.` | E-Margin specific |
| `securityNotAllowed` | + `Trading on E-Margin product is not allowed on Security : SBINEQ` + `Orders on ... have been blocked for Extended Margin Product .` | E-Margin specific |
| `amoNotAllowed` | `You cannot place AMO orders now. AMO orders are allowed between 7:00PM to 9:00AM` | **MTF-only key** |
| `unknownError` | `Unknown API error` | **MTF-only key** |
| `invalidOrder` | `Order Rejected` | **MTF-only key** |
| `networkError` | `Exchange connection is down, please try later` | **MTF-only key** |
| `otherError` | fallback | — |

SBI regular's map has **no** `amoNotAllowed`/`unknownError`/`invalidOrder`/`networkError` keys at all — a statusMessage of `"Unknown API error"` on plain SBI falls through to `otherError`, but the identical string on SBI-MTF classifies as `unknownError`.

`REJECTED_STATUS_MESSAGE_PREFIX = 'Order Rejected: '` (`sbiRejectedAmoOrdersIngest.js:42-43`, `sc-integrations-jobs`) — comment states this prefix exists specifically so ingested-CSV rejection messages match the `invalidOrder` regex above.

---

### 2.6 Synthetic / Non-Broker-Derived Status Literals (log traps)

These strings appear in logs but were **never returned by SBI** — they are smallcase-side synthesized values. Grepping for them without knowing this will misattribute broker behavior.

| Literal | Where synthesized | What it actually means |
|---|---|---|
| `orderId: "NA"`, `statusMessage: "order placed by dealer"` | `sbi/services/order.js:260-269`, `sbi-mtf/services/order.js:267-320` (L272-278) | Dealer order where `options.dealerDetails` was absent — **the broker was never called at all**; this is a fake success |
| `status: "CANCELLED AMO"` (literal string, not `constants.scStatus.CANCELLED`) | `sbi/services/order.js:551`; `sbi-mtf/services/order.js:544-553` | Synthesized on **every** successful cancel, AMO or not — do not infer the order was actually AMO from this string |
| `'passing "insufficient balance" error as success'` | `sbi/services/security.js:58-67` | Security-hold call where `transactionFailureReason === 'Insufficient Balance.'` (exact string incl. trailing period) is deliberately treated as success |
| `'Successful rejection reason request'` | `sbi/services/request.js:201-219` (mirrored MTF `request.js` L183-201) | An HTTP-level **error** on the `rejection-reason` endpoint, reinterpreted as success because `responseCode===1` + non-empty `messageList` |
| `error: 'Invalid orderId'` (bare string, not an `Error` instance) | `sbi-mtf/services/order.js` `cancelOrder`, L473-476 | `NaN` orderId on cancel — inconsistent with rest of codebase which returns `Error` objects; `error.message` on this will be `undefined` |

**MTF `cancelOrder` quirk**: payload sets `orderLegDetails.product: constants.products.CASH (1)`, not `MTF (6)`, at `sbi-mtf/services/order.js:507` — every other order-mutating call (place, placeDealerOrder) uses `product:6`. Flagged in research as a likely real discrepancy, not something to assume is intentional.

**REJECTED can bubble up as an error, not a clean rejection**: `getOrderRejectionReason()` is auto-called whenever mapped `status === 'REJECTED'` (`sbi/services/order.js:401-409`; MTF `order.js:413-454`). If that second round-trip itself errors, the error propagates up from `getOrderDetails` — so a genuinely-rejected order can surface to the caller as a raw error rather than a `status:REJECTED` response with a clean `statusMessage`.

---

### 2.7 SBI-MTF Margin/Funding-Specific Codes

Not present in plain SBI at all — confirmed via grep (zero `shortfallFlag`-style margin concepts outside `sbi-mtf/`).

| Concept | Mechanism | Citation |
|---|---|---|
| `product: 6` | Wire-level marker for MTF (`constants.products.MTF`); plain SBI's `products` enum stops at `E_MARGIN: 5` — `product===6` in a raw request/response body is the unambiguous way to identify an MTF order at the wire level | `sbi-mtf/constants.js:91-99` |
| `emarginDate` | MTF-only order field, `orderParameters.orderLegDetails.emarginDate`, `YYYYMMDD`. `undefined` if `orderOptions.emarginDate` missing/invalid | `sbi-mtf/services/order.js:237`, `services/util.js:79-100` |
| Margin funding % lookup | Redis `HGET MTF:{sid} sbi-mtf.{exchange}` (`config.getMarginIdentifier`), default `100` (no leverage) if missing — **missing Redis data silently means "pay full amount," not an error** | `sbi-mtf/services/fund.js:130-149` |
| Redis-outage fallback | On any exception computing margin %, falls back to full unmargined BUY amount + plain SELL amount; logs exact string `'Error fetching margin funding percentages from Redis'` | `sbi-mtf/services/fund.js:154-158` |
| Margin receivable (SELL side of mixed basket) | FIFO walk over `getEmarginDetails` positions (`POST /position-service/emargin-details`), NSE-only, sequential per-order (deliberately, comment: *"avoid spiking downstream calls"*) | `sbi-mtf/services/portfolio.js:19-111,146-222` |
| `marginReceivable: 0` on a losing position | **Expected, not a bug** — when `(avgBuyPrice − currentPrice) × qty` exceeds the margin-funded portion, receivable floors at 0 (confirmed by `tests/portfolio.test.js` case 1) | `sbi-mtf/services/portfolio.js:19-31` |
| Error computing marginReceivable | Never throws to caller (unless the whole function throws) — degrades to `{marginReceivable: 0}`; logs `'Error computing marginReceivable'` (`fund.js`) or `'Error calculating margin receivable for mixed basket'` (`fund.js:280`) / `'Error calculating margin receivable'` (`portfolio.js:213`) | `sbi-mtf/services/fund.js:218-284,~322`; `portfolio.js:213` |
| `clientType` field name quirk | `_buildEmarginDetailsPayload`: `tradingAccountDetails.clientType = nriFlag===0 ? 1 : nriFlag` — field literally named `clientType` here, not `nriFlag`/`accountSettlementType` as elsewhere | `sbi-mtf/services/portfolio.js:56-73` |
| Dealer path bypasses funds-check entirely | `check()` short-circuits to `{sufficientFunds:true, requiredFunds:0}` with **no broker call** if the access token decodes a `dealerId` | `sbi-mtf/services/fund.js:289-291` |

---

### 2.8 MTF-to-CNC Conversion / Margin-Call Logic — **NOT FOUND**

Research explicitly grepped the entire `sbi-mtf/` tree (case-insensitive) for `pledge`, `CNC`, `conversion`, `margin.?call`, `leverage` — **zero matches**. There is no MTF→CNC conversion flow, no pledge/unpledge logic, and no explicit margin-call handling anywhere in `sc-integrations-broker-lib`'s SBI-MTF adapter. The only "leverage"-shaped concepts that do exist are the per-security `MTF:<sid>` margin-funding-percentage Redis lookup (§2.7) and the funds/quantity-shortfall flags (§2.3). **If such logic exists, it lives outside `sc-integrations-broker-lib/src/brokers/sbi-mtf` and was not located in this research pass** — do not assume conversion/margin-call behavior based on absence of contrary evidence; treat as unconfirmed and check `sc-platform-api` and `sc-integrations-jobs/jobs/autosips/sbi/` (not read in this pass) next if this is needed.

---

### 2.9 Error Reconciliation: What "SBI's Fix Mechanism Is NONE" Means Operationally

Two separate claims from research support this, and both must be true for a batch stuck in `ERROR` to have **no confirmed automatic resolution path**:

**(a) No broker-pushed reconciliation.** `orderStatusBy: { postback: false, polling: true }` (`sbi-mtf/config.js` L63-66) — SBI never sends a webhook/postback when an order's status changes; smallcase only learns of a status change by calling `getOrderDetails` again. There is no SBI equivalent of Kotak's SFTP-based order-book reconciliation (`sc-integrations-jobs/config.js` has a full `sftp:{host,port,username,password,orderBookSource}` block for `kotak`/`kotakErrorOrderReconciliation`, L108-121/274-286 — **no such block exists for SBI at all**). SBI's only reconciliation-adjacent config is the S3 bucket pair `sbiIngestUpdates.{orderBookS3Bucket, sbiAllOrdersS3Bucket}` — confirms "SBI uses NONE" specifically means *no automated SFTP/webhook channel*, not "no reconciliation code exists whatsoever."

**(b) The reconciliation code that does exist is manual, not scheduled.** `sbiReconAllOrders.js`, `sbiDealerRecon.js`, `sbiRejectedAmoOrdersIngest.js` are all `yargs`-flag-driven CLI scripts (`--date`, `--filepath`, `--local`, `--save`, `--createMissingBatches`, `--recreateInvestment`). Research found no cron/scheduler wiring for any of them. `sbiRejectedAmoOrdersIngest.js` additionally **dry-runs by default** — the fix API and the statusMessage-only update both require an explicit `--save` flag; absent that flag, the job only logs `[DRY-RUN] Would call fix API` and writes nothing (`sc-integrations-jobs` research §2.4).

**What actually can move a stuck-ERROR batch, and their limits:**

| Mechanism | Touches `ERROR` status? | Automatic? | Gotcha |
|---|---|---|---|
| Next `getOrderDetails` poll returning a different raw `orderStatus` | Yes, in principle | Only if/when the broker's own backend resolves the underlying TRANSIT/EXPIRED/FREEZED state — entirely outside smallcase's control | For codes 5/7/8 the mapping is unconfirmed (§2.1); if SBI keeps returning one of those codes, polling reflects the same ERROR forever |
| `triggerAmoPoll.js` (`jobs/triggerAmoPoll.js`) — re-polls `getOrderDetails` for orders `status in [PLACED, PARTIALLYPLACED, ERROR]` and `broker in amoAllowedBrokers` (`sbi`, `sbi-mtf` **hardcoded** via `.concat(['sbi','sbi-mtf'])`, L106-113, independent of broker-lib's own `amoAllowed` flag) | **Yes — the one confirmed automatic re-poll for ERROR** | Runs on a schedule (job, not ad hoc), but scoped to `getAmoEligibleOrderCriteria(dateRange)` (name implies AMO-variety scoping — not fully confirmed in research) and a bounded date window (`lastMarketClose`→`todayMarketOpen`) | **Activated SBI-MTF orders are excluded**: the `activated:true` exception only covers `broker in ['sbi','axis']` (L83-89) — `sbi-mtf` is not in that list, so an activated MTF order stuck at ERROR will not get re-polled by this job |
| `jobs/sanity/cleanupMtfNonTerminalBatches.js` | **No** — `NON_TERMINAL_STATES = ['UNPLACED','UNFILLED','PARTIALLYFILLED']` (L26) **excludes `ERROR` explicitly** | Yes, but irrelevant to ERROR | This is the MTF stuck-batch safety net, but it will never touch a batch sitting in `ERROR` — only worth citing to say what it does *not* cover |
| `sbiReconAllOrders.js` / `sbiDealerRecon.js` / `sbiRejectedAmoOrdersIngest.js` — `fixBatchByTradebook()` → `POST {BB_SERVICE_HOST}/errors/fix/{batchId}` (`fixBy:'orderbook', tradebook, force:true`) | Yes, can force any status via the tradebook | **No — requires a human to run the script** with correct `--date`/`--filepath` and (for the AMO-rejection job) `--save` | Also depends on the order actually appearing in that day's broker CSV export; a batch missing from the CSV cannot be fixed this way |
| `jobs/sanity/hangingOrderEodReport.js` | Detects/reports only | N/A | Emails counts, **never mutates the DB** (§2.10) |

**Bottom line**: a batch stuck in `ERROR` because of an unmapped broker `orderStatus` (5/7/8) has exactly one confirmed automatic re-poll path (`triggerAmoPoll.js`, with the activated-MTF exclusion caveat above) and otherwise depends on a human running one of the recon scripts against that day's SBI CSV export with `--save`. There is no confirmed cron-scheduled, SBI-specific job in the research corpus that force-fixes an `ERROR` batch without a human invoking it.

---

### 2.10 Hanging-Order Semantics

**Definition** (`jobs/sanity/hangingOrderEodReport.js:18-28`, `getQuery()`): status in the exact literal set

```js
status: { $in: ["ERROR", "PLACED", "PARTIALLYPLACED"] }
```

This is the operational definition of "order placed, no [terminal] status received."

**Two date windows, split by `variety`:**

| Variety | Window | Line | Quirk |
|---|---|---|---|
| Regular (`variety != 'amo'`) | `startDate = argv.date \|\| <yesterday 18:30 local>` (via `.setDate/.setHours`, returns a **number**, not a `Date`) → `endDate = new Date(Date.now() - 60*1000)` | L115-142 | Mixed types (number vs `Date`) passed into the same Mongo query; ignores the last 1 minute (comment: "Ignore last one minute") |
| AMO (`variety == 'amo'`) | `startDate = argv.date \|\| lastWorkingDay 10:30` → `endDate = todayMarketOpen = new Date(y,m,d,3,30,0)` | L151-181 | `3:30` is in server-local/UTC hours — if the server clock is UTC (typical prod), that's `09:00 IST`, i.e. **before** NSE's actual `09:15` open — "today market open" as coded is pre-open |

**Grouping**: results grouped by `broker` first — so `data.sbi` and `data["sbi-mtf"]` are separate report buckets (L38-106) — then per-broker counted into `dealer`, `nonDealer`, `activated`, `nonActivated`, `autoSIP` (`label === 'AUTOSIP'`), `nonAutoSIP`. Fields pulled: `_id batchId status broker dealer variety label activated` (L41).

**Exact log lines** (via `sc-integrations-babel` logger, not the `Logger` class helper — different shape than other jobs, see below):
- `logger.debug({ hangingOrders: orders })` (L51-53) — raw dump of matched docs
- `"No hanging SMT orders were found."` (L220) / `"Hanging SMT orders", hangingOrders` (L223)
- `"No hanging SST orders were found."` (L228) / `"Hanging SST orders", hangingSSTOrders` (L231)
- `"No hanging SMT orders and No hanging SST orders were found."` (L236)
- `` `Mail sent for ${jobName} job` `` / `` `Failed to send mail for ${jobName} job` `` (L243, L251)

**Delivery**: HTML email, subject `Hanging Orders EOD Report`, to `integrations-reports@smallcase.com` (prod) / `notifications-dev@smallcase.com` (else), bcc `qa@smallcase.com`. Report is **counts only** (Broker/Dealer/Activated/AutoSIP/Normal columns) — **no error code or status-message breakdown is in the report itself**; investigating *why* a specific SBI order is hanging requires going to the raw `Order` doc directly (`status`, `broker:"sbi"`, `statusMessage` if any).

**This job never writes to the DB** — it is detection/reporting only, not a fix mechanism (reinforces §2.9).

**How leprechaun simulates a hanging order — NOT FOUND in this research pass.** The research corpus contains no leprechaun-specific logic for simulating a stuck/hanging SBI or SBI-MTF order (the subagent tasked with a "leprechaun error catalog" was redirected per the scope override and produced `fetch-s3-logs.js` notes instead — no leprechaun mock-hang behavior was actually researched). What *is* confirmed about leprechaun in this corpus is limited to login/dealer-detection mocking (`'DEBUG: ...'`-prefixed info logs in `sbi/services/user.js:253,262,273,277,304`) and broker-name suffixing (`sbi-leprechaun`, `sbi-mtf-leprechaun`) — nothing about order-status simulation. **To answer this, check `sc-integrations-leprechaun` directly** (available as a working directory but not covered by this research corpus) — specifically its SBI/SBI-MTF order-status mock endpoint for any deliberate delay/no-op behavior.

---

### 2.11 Open Gaps — Explicitly Unconfirmed, Do Not Fill In

| Question | Status | Where to look next |
|---|---|---|
| Meaning of raw `orderStatus` codes 5 (TRANSIT), 7 (EXPIRED), 8 (FREEZED) beyond "falls to ERROR" | Unconfirmed — source has an open TODO (`sbi/constants.js:116`) | Ask SBI/SBI Cap Sec directly, or check if a newer broker API doc superseded this |
| Composition of `getAmoEligibleOrderCriteria(dateRange)` in `triggerAmoPoll.js` (does it restrict to `variety==='amo'` only, or broader?) | Not fully captured in research; function name implies AMO scoping | `sc-integrations-jobs/jobs/triggerAmoPoll.js` — read the full function body |
| MTF-to-CNC conversion / margin-call logic | Confirmed **not present** in `sc-integrations-broker-lib/src/brokers/sbi-mtf` (exhaustive grep, zero matches) | `sc-platform-api`, `sc-integrations-jobs/jobs/autosips/sbi/*` — not read in this pass |
| Whether `sbiReconAllOrders.js`/`sbiDealerRecon.js` run on any cron/schedule in prod | Not found in research (no scheduler config seen) | Check deployment/cron config for `sc-integrations-jobs` (outside the files read) |
| Leprechaun's simulation of a hanging/stuck SBI order | Not researched (scope redirect) | `sc-integrations-leprechaun` order-status mock endpoint |
| Exact JSON field holding broker identity in raw S3 log lines (`broker` vs `brokerName`) for use with `fetch-s3-logs.js --filter-field` | Inferred, not confirmed — `fetch-s3-logs.js` itself has zero SBI-specific logic (generic filter tool); the actual field name is emitted by `sc-integrations-broker-api`/`sc-integrations-order-updates`, not visible in the fetch script | Confirm against a real pulled log line before building a `--filter-field` query; `log.js:49-85` in broker-lib confirms the emitted key is `broker` (= `config.brokerName`, literally `"sbi"` for both cash and MTF in prod — see broker-lib's Gotcha in the disambiguation table, not part of this section's scope) |

---


---

## Section 3: Log Locations, S3 Paths & Field Reference

**Everything in this section was verified live against real S3 data** (via `fetch-s3-logs.js` itself and direct `@aws-sdk/client-s3` listing, using the `smallcase` AWS SSO profile) on 2026-09-22, plus one confirmed historical sample from 2026-06-05. Where "current" and "historical" facts differ (services mid-migration), both are given with dates so you can judge which applies to the date you're investigating.

---

### 3.1 The three-and-a-half S3 log surfaces

There are not two bucket "families" to guess between — there are **four distinct S3 surfaces**, each with a different structure, and picking the wrong one silently returns nothing useful:

| # | Surface | Bucket | What's in it |
|---|---|---|---|
| 1 | **Legacy EC2/PM2 app logs** | `sc-pm2logs-new` | Per-service, date-partitioned stdout/stderr from EC2 instances running under `pm2` |
| 2 | **Kubernetes/EKS app logs** | `sc-eks-pod-logs` | Per-service, date-partitioned stdout/stderr from EKS pods (the newer hosting generation) |
| 3 | **`sc-integrations-jobs` per-run logs** | `sc-prod-logs` | One gzip object per individual job *invocation* (not date-partitioned) |
| 4 | **SBI recon/master-data files** | `sc-integrations-sbi-attachments`, `smallcase-trash` | Broker-supplied CSV exports consumed/produced by the recon jobs — not application log lines at all |

Surfaces 1 and 2 are what `fetch-s3-logs.js` was originally built for (its `DEFAULTS.S3_URL` presets, commented at the top of the file, cover both). Surfaces 3 and 4 need bucket/prefix passed explicitly via `--s3-url` — they are not in the script's built-in preset list, and surface 3 needs an additional fix described in §3.3.

---

### 3.2 Surfaces 1 & 2 — app logs, per service, CONFIRMED current routing

**Verified live** by listing both buckets for the same dates. Recent dates (2026-09-20/21, i.e. "now") vs. the older 2026-06-05 historical sample show the migration is **in progress, not uniform** — do not assume one bucket for all services:

| Service | 2026-06-05 (historical) | 2026-09-20/21 (current, verified) | Verdict |
|---|---|---|---|
| `sc-integrations-order-updates` | EC2/PM2 only (`sc-pm2logs-new`) | **EKS only** (`sc-eks-pod-logs`) — confirmed EC2 prefix is now empty | **Fully migrated to EKS.** For any recent-ish investigation, go straight to EKS; only fall back to EC2/PM2 for genuinely old incidents (June 2026 or earlier). |
| `sc-integrations-broker-api` | EC2/PM2 only | **EKS only** — confirmed EC2 prefix is now empty | Same — fully migrated. (Low priority anyway per §3.1's priority order, but noting for completeness.) |
| `sc-platform-api` | **Both** (large, actively-written files on both) | **Both**, still — confirmed non-empty and actively written on both buckets for the same recent date | **Dual-running.** A given request could have been served by either an EC2 or an EKS instance — check BOTH, don't assume EKS-first-then-stop. |
| `sc-integrations-jobs` (daemon/agent process logs — NOT per-job-run output, see §3.3) | EC2/PM2 only | **EC2/PM2 only** — confirmed no `sc-integrations-jobs-pod` exists on EKS | Not migrated; this is expected — `sc-integrations-jobs` isn't a persistent request-serving pod, so it was never a natural EKS migration candidate in the first place. |

**Recommended resolution order for the tool** (replacing "always try EKS first"):
1. **`order-updates`, `broker-api`**: try EKS first; fall back to EC2/PM2 only if EKS returns zero objects for that date (covers old incidents pre-migration).
2. **`platform-api`**: query **both** and merge — don't treat either as a fallback of the other.
3. **`jobs`** (daemon logs): EC2/PM2 only.

**Exact confirmed paths:**

```
EKS:     s3://sc-eks-pod-logs/production/{YYYY-MM-DD}/integrations/sc-integrations-order-updates-pod/
         s3://sc-eks-pod-logs/production/{YYYY-MM-DD}/integrations/sc-integrations-broker-api-pod/
         s3://sc-eks-pod-logs/production/{YYYY-MM-DD}/platform/sc-platform-api-pod/
         (staging equivalents: replace "production" with "staging")

EC2/PM2: s3://sc-pm2logs-new/PROD/{YYYY-MM-DD}/sc-integrations-order-updates/
         s3://sc-pm2logs-new/PROD/{YYYY-MM-DD}/sc-integrations-broker-api/
         s3://sc-pm2logs-new/PROD/{YYYY-MM-DD}/sc-platform-api/
         s3://sc-pm2logs-new/PROD/{YYYY-MM-DD}/sc-integrations-jobs/
```

Namespace segments `integrations`/`platform` under the EKS bucket are **confirmed verbatim** (live-listed — not inferred): `production/{date}/` also contains `communications/`, `core/`, `gateway/`, `internal-system/`, `investment/`, `publisher/`, `tickertape/` for other domains, none SBI-relevant.

**PM2 sub-folder structure** (verified live under each `sc-pm2logs-new/PROD/{date}/{service}/`): `Error-logs/`, `Out-logs/`, `code-deploy-logs/`, `script-logs/` — deployment and log-backup-script noise lives in the latter two. **`fetch-s3-logs.js` pulls ALL FOUR subfolders unless you pass `--dir Out-logs`** (or `Error-logs`, if you specifically want the error stream). Without `--dir`, you get code-deploy and cron-backup-script noise mixed into `all-logs.filtered.log` — confirmed by reproducing the user's own reference sample: omitting `--dir` pulled 29 objects across all four subfolders (mostly irrelevant), while `--dir Out-logs` pulled exactly the 18 objects that reproduce the known-good `all-logs.filtered.log` byte-for-byte. **Always pass `--dir Out-logs` for normal application-log investigation** (add a second run with `--dir Error-logs` if you specifically need the error stream, which PM2 writes to a separate file).

EKS pod logs (verified) have no equivalent sub-folder split — one flat set of objects per pod under `.../sc-integrations-order-updates-pod/`.

---

#### 3.2.1 Exhaustive identifier/text search across app logs

Use `fetch-by-identifier.js` when the date is known **or unknown**. The service is always required; never silently guess it.

```bash
# Exactly one S3 partition date
node fetch-by-identifier.js --service order-updates --tag sc_<tag> --date 2026-06-05

# Latest 30 days for the selected service
node fetch-by-identifier.js --service order-updates --tag sc_<tag>

# Literal, case-insensitive text anywhere in a raw log record
node fetch-by-identifier.js --service order-updates --text "broker action - orderStatus"
```

Exactly one of `--tag`, `--order-id`, `--batch-id`, or `--text` is required. `--date`, `--from/--to`, and `--month` restrict the S3 prefixes searched. Explicit `--from/--to` ranges are capped at 30 days, and a 31-day `--month` is rejected with instructions to use a shorter range. A single historical `--date` remains valid. `order-updates`, `broker-api`, and `platform-api` cover their EKS and EC2 locations; the EC2 search includes both `Out-logs` and `Error-logs`. `jobs-recon` additionally requires `--job-name`.

**Omitting all date options**: for `--text`, this searches the flat latest-30-calendar-days window (including today, IST) — same as always. For `--tag`/`--order-id`/`--batch-id`, it instead triggers **auto-scope** (§3.2.2) — the real order date is resolved first, then the search starts narrow around it and widens only if needed. This is deliberately NOT the same flat 30-day behavior, because a flat scan wastes most of its work on dates nowhere near the order, and — for `--tag`/`--order-id` specifically — running that scan's equivalent lookup unbounded against Mongo would be a full collection scan (§3.2.2 covers why).

#### 3.2.2 Auto-scope: resolving the date automatically for --tag/--order-id/--batch-id

When no `--date`/`--from`+`--to`/`--month` is given and the identifier is `--tag`, `--order-id`, or `--batch-id`, `search-s3-logs.js`'s `runAutoSearch()` (exported, with `resolveAnchorDate()`/`decodeObjectIdDate()`/`datesAroundAnchor()` as the individually-testable pieces) does two things in sequence: **(1) find a real anchor date**, then **(2) search S3 in widening tiers around it**, stopping at the first tier that finds anything.

**Step 1 — anchor date, chosen by identifier kind:**

| Kind | Mechanism | Cost | Why |
|---|---|---|---|
| `--batch-id` | `decodeObjectIdDate()` — a Mongo `ObjectId`'s first 4 bytes (8 hex chars) are a Unix timestamp in seconds. `batchId` IS the order document's `_id` (`order._id = order.batchId`, `sc-integrations-babel/src/models/Order.js:33`), so this recovers the real creation date **with zero network calls.** | Instant, local | No lookup needed — the date is embedded in the identifier itself |
| `--tag` / `--order-id` | Tiered Redash lookup via `redash-query.js`'s `findOrderAnchorDate()`, tried at `lookbackDays` **7, then 14, then 30** (stopping at the first tier that returns a match) | ~20-44s per tier tried, only as many tiers as needed | `orders.tag`/`unplaced.tag`/`.orderId` have **no Mongo index** — cost scales with the date range scanned (confirmed live: 7d≈20s, 14d≈24s, 30d≈44s, 60d+ unreliable even with the 120s poll ceiling in `runRedashQuery`). A single wide bound (180 days, the first thing tried while building this) is not viable — it times out. Tiering keeps every attempt in the fast range and only pays for a wider one when the narrower one truly found nothing. |

If the Redash lookup exhausts all three tiers (7/14/30 days back from today) with no match, `runAutoSearch` **stops and reports `not_found_in_db` (exit code 3) rather than scanning S3 blindly** — an expensive crawl on a pure guess is not "reliable," a clear "not found in the last 30 days" is. If you know the order is older, pass an explicit `--date`/`--from`+`--to`/`--month` — the same unbounded-query guard described in step 3 of "How to use this doc" (also `requiresDateBound()` in `redash-query.js`) still applies if you then query Redash directly for something further back, since that's a wider window over the same unindexed fields.

If Redash itself is unreachable/unconfigured (`REDASH_URL`/`REDASH_API_KEY`/`REDASH_DATA_SOURCE_ID` missing), `runAutoSearch` falls back to the old flat latest-30-days S3 scan rather than failing outright — degraded but still functional.

**Step 2 — S3 search tiers around the anchor** (`AUTO_SCOPE_TIERS`, `datesAroundAnchor()`):

| Tier | Window (relative to anchor) | Width |
|---|---|---|
| `tier1_3d` | anchor−1 .. anchor+2 | 4 days |
| `tier2_9d` | anchor−1 .. anchor+7 | 9 days |
| `tier3_17d` | anchor−1 .. anchor+15 | 17 days |
| `tier4_30d_max` | anchor−1 .. anchor+28 | 30 days (the system-wide cap) |

Deliberately **biased forward** (far more days after the anchor than before) — a delayed status update or fix appears *after* placement, essentially never before it. Each tier only re-searches the **incremental new dates** not already covered by a narrower tier (not a re-scan from scratch), and results accumulate into the same `matches.jsonl`/`all-logs.filtered.log`/`manifest.json` in the requested `--out` directory regardless of which tier found them — `manifest.json`'s `tiers[]` array records exactly which tiers ran, how many new dates each covered, and how many matches each found, for full transparency. The loop stops at the first tier with ≥1 match, or after the widest tier regardless. Per-tier scratch directories (`.tier-N/`) are cleaned up automatically. Dates are never generated past "today" in IST (future S3 partitions can't exist).

**An explicit `--date`/`--from`+`--to`/`--month` always bypasses both steps entirely** — `main()` dispatches straight to the single-shot `runSearch()`, no Redash call, no tiering, exactly the requested window searched once. This is intentional: the auto-scope machinery exists only for "I don't know the date," never to second-guess a date you did provide.

#### 3.2.3 Auto-scope example (live-verified)

```bash
# batch-id: anchor decoded locally, tier1 (4 days) already finds it — no widening, no Redash call
$ node fetch-by-identifier.js --service order-updates --batch-id 6a221fb2d963eea6efaeabfa
Anchor date resolved: 2026-06-05 (batchId-objectid-timestamp). Starting narrow, widening only if empty...
[tier1_3d] searching 4 new date(s): 2026-06-04..2026-06-07
{ "status": "complete", "anchorDate": "2026-06-05", "tiersRun": 1, "totalDatesSearched": 4, "totalMatched": 11 }
# -> 967 matching log lines across 11 objects, found in the narrowest tier.

# tag, genuinely outside the 30-day DB lookback: reports clearly instead of guessing
$ node fetch-by-identifier.js --service order-updates --tag sc_rXWoyJfoH
{ "status": "not_found_in_db", "note": "No matching order found via Redash within the last 30 days. ..." }
# exit code 3 — pass --date/--from+--to explicitly for anything older than 30 days.
```

#### 3.2.4 Reliability gotcha — a batch's `date` field does NOT reliably match its "investigation date"

**Found while cross-checking a real multi-date investigation** (22 tags across June 1/5/15/24 2026): querying `redash-query.js --broker sbi --from <date> --to <date>` for a date a human associates with an order (from an AMO investigation label, a support ticket, a recon report heading, etc.) can silently miss the order entirely, because the `date` field is set once at placement and does not always fall on the calendar day you'd expect:

- An AMO batch placed at `2026-05-30T18:42:55Z` (00:12 **IST**, i.e. just after midnight) has `date` on **May 31**, even though the batch was being polled and was clearly relevant to **June 1** (its last poll/error was `2026-06-01T10:30:52Z`). A naive `--from 2026-06-01 --to 2026-06-01` query finds nothing for it.
- A separate batch under a different `brokeruserId` had `date: 2026-06-13T03:07:27Z` — **three full days** before the date it was actually being investigated under (June 15). This one isn't an IST-midnight rounding case; the underlying reason wasn't determined, but the mismatch was real and would have produced a false "not found."

**Reliable fallback when a date-bound Redash query (`--tag`/`--order-id --from/--to`) finds nothing but you have independent reason to believe the order exists** (e.g. OU log evidence, a support ticket, an external report):
1. Search OU logs directly for the identifier with `fetch-by-identifier.js --date <the date you believe is right>` (or a `--from`/`--to` range) — this searches log **content** (which reflects poll *activity* dates, not the DB `date` field) and is far less likely to miss it for this reason.
2. Extract the real `batchId` from any matched log line (`context.batchId`, present on essentially every order-updates log entry).
3. Query Redash directly with `--batch-id <that id>` — **no date bound needed or used**, so this field-mismatch class of problem cannot cause a miss.

This is why `--batch-id` is the most reliable identifier throughout this whole toolchain wherever it's available (also true for `search-s3-logs.js`'s auto-scope — decoded straight from the ObjectId, §3.2.2) — prefer resolving to a `batchId` early in an investigation rather than staying on `--tag`/`--order-id` with an assumed date.

#### 3.2.5 Diagnostic pattern — check sibling legs in the same batch, not just the flagged one

When a specific tag is reported as "stuck," pull the **whole batch** via `redash-query.js --batch-id <id>` (not just that one tag) and look at every leg. In 3 of 4 real batches checked in the same cross-check above, *most* legs in the batch were correctly `COMPLETE` with real `exchangeOrderId`s — only specific legs (consistently the ones a human had already flagged) remained `PLACED`/`filledQuantity: 0`, unrecovered, for months. This is the expected shape of the failure mode described in §2.9/§4.3 (SBI's reconciliation mechanism is `FIXBY.NONE` — there is no automatic per-leg retry), and confirms via live data that the "stuck" state is not transient: these specific legs had not self-resolved after 3+ months. Seeing which legs in a batch succeeded and which didn't is itself diagnostic signal — a batch where *every* leg is stuck (as in the June 15 case) suggests a different failure point (e.g. the whole batch's status polling broke) than a batch where only a few legs are stuck (placement/poll succeeded generally, but a handful of legs individually never got a terminal status from SBI).

#### 3.2.6 `search-s3-recon.js` scales well to many simultaneous filter values

Confirmed live: a single invocation with **44 combined `--tag`/`--order-id`/`--exchange-order-id` values** (repeat the flag — it becomes one SQL `IN (...)` clause per field, `predicate()` in `search-s3-recon.js`) scanned all 2,555 CSV files across both recon prefixes and returned in well under a minute, with zero matches reliably reported (not a timeout or partial-result — `manifest.errors` was empty). When checking many identifiers against the recon CSVs, batch them into one call rather than looping one `search-s3-recon.js` invocation per identifier — it's both faster and produces one consolidated manifest instead of many to cross-reference by hand.

The search uses S3 Select to inspect gzip JSONL app-log records server-side and return only matching lines. It searches the complete serialized line, so an identifier nested inside EC2 `context` or inside EKS's JSON-encoded `message` is still found. Unexpected serialization, incomplete Select responses, records over S3 Select's 1 MiB limit, and per-object Select errors trigger a full `GetObject` + gunzip + exact local scan of that object. Matches are streamed through bounded temporary files instead of being accumulated in memory, so broad literal searches do not exhaust the Node heap.

Outputs under `--out` (or the generated `logs/lookup-*` directory):

- `all-logs.filtered.log` — compatibility output used by the existing investigation workflow.
- `matches.jsonl` — valid JSON Lines with the source S3 URI, surface, object timestamp, log timestamp, and complete log record.
- `manifest.json` — query/scope plus listed, scanned, fallback, failed, matched, and byte counts.

**Completeness contract:** exit `0` means every object listed in the run's S3 snapshot was searched, including successful local fallbacks. Exit `2` and `manifest.status: "incomplete"` mean at least one object was not searched; never interpret an incomplete zero-match run as "not found." S3 cannot expose logs that were deleted, expired, or had not yet been uploaded when the snapshot was listed.

Single-date searches normally finish fastest. The default 30-day search can take several minutes or longer depending on EKS object volume; it uses bounded concurrency (default `16`) and does not download non-matching objects during the normal S3 Select path. Output order reflects concurrent object completion and is not chronological; use each JSONL record's `time` and `s3Uri` when ordering evidence.

---

### 3.3 Surface 3 — `sc-integrations-jobs` per-invocation logs (a completely different shape)

This is **not** a date-partitioned, always-on service log — it's one gzip object **per job run**, written by the shared `@smallcase/scheduler-agent` package that every job in `sc-integrations-jobs` runs under (confirmed by reading `node_modules/@smallcase/scheduler-agent/utils/job-runner.js`, and separately by a screenshot of the actual bucket in the AWS console).

**Mechanism** (`job-runner.js`, `runCliJob()`):
```js
const bucketConfig = {
  Bucket: config.aws.logsUploadBucket,        // env SCHEDULER_LOGS_BUCKET — confirmed prod value: sc-prod-logs
  Key: job.data.repo + '/' + job.data.name + '_' + job.id
};
child.stdout.pipe(zlib.createGzip()).pipe(s3Stream.upload(bucketConfig));   // gzip, multipart upload
```
- `job.data.repo` = `"sc-integrations-jobs"` (literal, confirmed).
- `job.data.name` = the **physical filename** of the job script (no `.js`), e.g. `sbiReconAllOrders`, `sbiReconAllOrders-batchCreation` (a second job config pointing at the same/related file with different flags — confirmed live, both exist as separate S3 key prefixes).
- `job.id` = Bull's job id. For repeatable/cron jobs this is a string like `` `sbiReconAllOrders-batchCreation_repeat:<32-char-hash>:<epochMs>` `` (confirmed live — the epoch ms is the scheduled run time, giving you a date even without S3 `LastModified`).
- Only **stdout** is captured to S3 (`child.stdout`, not `child.stderr` — stderr only goes to the parent process's own stderr + a Redis pub/sub stream for live tailing, not to S3).

**Confirmed live example** (real bucket listing, 2026-09-22):
```
s3://sc-prod-logs/sc-integrations-jobs/sbiReconAllOrders-batchCreation_repeat:52dd02bbc3d137c2281a7c7d314c2371:1787578200000
s3://sc-prod-logs/sc-integrations-jobs/sbiReconAllOrders-batchCreation_repeat:52dd02bbc3d137c2281a7c7d314c2371:1787664600000
```
(Matches the user-supplied screenshot of the AWS console showing `sc-prod-logs` → `sc-integrations-jobs/` with 999+ objects, filenames like `placeKotakAutoSipsMonday_placeKotakAutoSipsMonday-...-init`.)

**No date-partitioned prefix exists here.** To find a specific job run:
1. List by a **key substring** matching the job's filename (e.g. `sbiReconAllOrders`) using `--bucket sc-prod-logs --prefix sc-integrations-jobs/sbiReconAllOrders` (S3 `ListObjectsV2` prefix match — substring-at-start). **`fetch-by-identifier.js --service jobs-recon --job-name <name>` does this for you.**
2. Narrow by the **embedded epoch timestamp** in the key (for repeatable jobs) or by the object's S3 `LastModified` metadata via the now-added `--modified-after`/`--modified-before` flags (see below) — `fetch-by-identifier.js` passes these automatically from your `--date`/`--from`/`--to`/`--month`.

**Two real bugs were found and fixed in `fetch-s3-logs.js` while building this guide** (both confirmed against live data, both now fixed in the checked-in script):
1. **`--bucket`/`--prefix` were silently ignored whenever `DEFAULTS.S3_URL` was set** (which it always is) — the script only checked whether `--s3-url` had been passed, not `--bucket`, so an explicit `--bucket sc-prod-logs --prefix ...` silently fetched from the hardcoded default URL instead. Fixed: the fallback now also checks `!args.bucket`.
2. **Gzip auto-detection fails on this bucket.** `HeadObjectCommand` on a real object shows `ContentType: application/octet-stream`, `ContentEncoding: undefined` — neither S3 metadata field indicates gzip, and the key has no `.gz` extension, even though the content genuinely is gzip (verified: first 4 bytes `1f 8b 08 00`). Fixed: added a `--force-gunzip` flag (`fetch-by-identifier.js` always passes it for the `jobs-recon` surface) that bypasses auto-detection entirely.

Once correctly decompressed, content is well-formed bunyan-style JSON per line — **the same log format shape as the app-log surfaces** (`{"name":"sc.service.sc-integrations-jobs","hostname":...,"pid":...,"level":30,"jobs":{"jobName":"sbiReconAllOrders","info":"<message>","data":{...}},"msg":"","time":"...","v":0}` — confirmed live). `fetch-s3-logs.js`'s existing JSON-line filtering works fine on this content once gunzip is forced.

**Log message catalog for `sbiReconAllOrders.js`** (from direct source read, `jobs/reconciliations/sbiReconAllOrders.js` — the file the user specifically flagged as most important):

| Grep target | What it shows |
|---|---|
| `"Batch state before fix"` / `"Batch state after fix"` | Full pre/post snapshot per `batchId` (orderId/tag/status/qty/avgPrice) — **diff these two to see exactly what changed**, present even in dry-run |
| `"Tradebook for batch"` | The exact fix payload `{batchId, tradebook}` about to be (or would be) sent |
| `"Fix batch response"` | The `sc-integrations-order-updates` `/errors/fix/:batchId` response |
| `"Error in fixBatchByTradebook"` | Fix call failures |
| `` `running job ${jobName} with params: ...` `` | First line of every run — shows exactly which CLI flags were used (`--save`, `--date`, etc.) |
| `"S3 files found"` | Lists every SBI recon CSV key downloaded for that date |
| `"Skipping batch superseded by dummy order..."` | Batch was intentionally NOT fixed (§4.3/§5) |
| `"Completed main reconciliation job successfully"` / `` `Error in ${jobName}: ...` `` | Success/failure end markers |

**Sibling jobs, briefly** (see §5 for the full cross-job comparison and why their provenance markers overlap):
- `sbiUnplacedRecon.js` — **gotcha**: its internal `jobName` variable is hardcoded to `'sbiDealerRecon'` (copy-paste leftover), so every log line it emits is tagged `"jobName":"sbiDealerRecon"` even though its S3 key is `sbiUnplacedRecon_<bullJobId>`. **Use the S3 key filename to identify which job produced a log object, not the `jobName` field inside the decompressed content** — they disagree for this one job.
- `sbiRejectedAmoOrdersIngest.js`, `sbiDealerRecon.js` — same fix-API pattern, different input CSVs (§3.4, §5).

---

### 3.4 Surface 4 — SBI recon/master-data files (not app logs)

**Confirmed live** (bucket listing, 2026-09-22): `s3://sc-integrations-sbi-attachments/` contains exactly these top-level prefixes:
```
masterscrip/            sbi_masterscrip/
mtf_recon/               mtf_security_margin/
sbi_recon/               sbi_rejected_amo_orders/
```

| Prefix | Env var (default bucket) | Written/read by | Contents |
|---|---|---|---|
| `sbi_recon/<YYYY-MM-DD>/` | `SBI_ALL_ORDERS_S3_BUCKET` (default `sc-integrations-sbi-attachments`) | `sbiReconAllOrders.js` (reads) | Daily SBI broker order-status CSV export (12 fixed columns — buy/sell flag, qty, client id, order no, avg price, ISIN, trade date, filled qty, tag, status T/other, exchange order no, source flag) |
| `mtf_recon/<YYYY-MM-DD>/` | same | `sbiReconAllOrders.js` (reads) | Same schema, SBI-MTF orders |
| `sbi_rejected_amo_orders/<YYYY-MM-DD>/` | same | `sbiRejectedAmoOrdersIngest.js` (reads) | AMO-specific rejection CSV, columns include client id / tag / rejection reason |
| `sbi_masterscrip/`, `masterscrip/` | `SBI_SYMBOLS_S3_BUCKET` | jobs' symbol-cache jobs | Instrument symbol master data — not order/status related |
| `mtf_security_margin/` | `SBI_MTF_SYMBOLS_S3_BUCKET` (env `SBI_MTF_SYMBOLS_REMOTE_FILE_PATH` for the exact key) | broker-lib's `sbi-mtf/services/fund.js` margin-% lookup (via Redis, populated from this file) | Per-security MTF margin-funding percentage source data |

For a recon lookup, search both date-partitioned CSV surfaces explicitly:

```
s3://sc-integrations-sbi-attachments/sbi_recon/<YYYY-MM-DD>/
s3://sc-integrations-sbi-attachments/mtf_recon/<YYYY-MM-DD>/
```

`sbiReconAllOrders.js` reads and merges both prefixes for the requested date. Search the raw CSV content by tag or broker `orderId`; absence from both surfaces means that run has no CSV match to reconcile. These are CSV files, not application-log JSON, so use `--filter-text` (or `--no-filter-text`) rather than `--filter-field`.

A separate bucket, **`smallcase-trash`** (env `SBI_ORDERBOOK_BUCKET`, a shared multi-purpose bucket — not SBI-exclusive), holds the ad-hoc order-book CSV that `sbiDealerRecon.js`/`sbiUnplacedRecon.js` read via an explicit `--filepath`, no fixed prefix.

This content is **broker-supplied CSV, not JSON log lines** — `--filter-field` (which does JSON key matching) won't parse it usefully. Use `--filter-text` (substring) or `--no-filter-text` (pull everything for offline inspection) instead.

SBI has **no SFTP-based reconciliation channel** (unlike Kotak, which has a dedicated `sftp:{host,port,...}` config block in `sc-integrations-jobs/config.js`) — SBI's order-book/recon retrieval is 100% S3-file-based. This is the concrete meaning behind "SBI's error-reconciliation mechanism is `NONE`" (§2.9) — there's no automated channel triggering a fix; a human runs a script against a CSV that itself is just sitting in S3 waiting to be read.

---

#### 3.4.1 Server-side historical recon search (S3 Select)

`search-s3-recon.js` lists every CSV below both recon prefixes, uses S3 Select to inspect each object server-side, and downloads only objects with matching rows. Non-matching CSVs are never downloaded. This recon CSV search remains unlimited across all available history; the 30-day cap applies to `fetch-by-identifier.js` log searches, not to these broker CSVs.
```bash
node search-s3-recon.js \
  --tag sc_<tag> \
  --order-id <internal-order-id> \
  --exchange-order-id <exchange-order-id> \
  --out ./logs/recon-search
```
The helper models the stable 12-column CSV layout and searches column 9 for the tag/reference, column 4 for the internal order number, and column 11 for the exchange order number. The broker CSV header is called `ORD_REMARKS` or `ORD_EXT_REF_NO` depending on the file. Search both `sbi_recon/` and `mtf_recon/`; `matches.json` and `manifest.json` retain the source S3 key and downloaded local file.
This requires `s3:ListBucket` and `s3:GetObject` permission for both recon prefixes. S3 Select returns only matching records; the subsequent `GetObject` downloads the matched CSV for local inspection. Errors are recorded in `manifest.json` and produce a non-zero exit code so an access or parsing failure is not mistaken for "no match".

### 3.5 `fetch-s3-logs.js` mechanics worth knowing before using any of the above

- `--s3-url` (or `--bucket`/`--prefix`) on the CLI **always overrides `DEFAULTS`** in the script — always pass it explicitly. The script's hardcoded `DEFAULTS.DATE` and `DEFAULTS.FILTER_TEXT` are development scratch values (currently a specific historical date and a specific tag) that silently apply if you forget to override them (or pass `--no-filter-text` to explicitly suppress the stale tag filter).
- One invocation covers **one date only** for surfaces 1/2 (the S3 prefix bakes in a single `{YYYY-MM-DD}` segment) — a date range needs one invocation per day, looped.
- `--region` is parsed but ignored; region (`ap-south-1`) and `AWS_PROFILE` (`smallcase`) are hardcoded in the script.
- Failed S3 GETs are not retried — a throttled/missing key logs `Failed for key=<key>: <err.message>` and the run still exits 0. A suspiciously incomplete result may be a silent partial failure, not "nothing there."
- Output is one aggregated file, `<outDir>/all-logs.filtered.log`, written as pretty-printed JSON objects each followed by a trailing comma, **no enclosing `[...]`** — not valid JSON as a whole file (strip trailing commas / wrap in brackets, or parse object-by-object). Non-JSON lines are wrapped as `{"raw": "<line>"}`.
- `--filter-text` and `--filter-field` are **OR'd, not AND'd** when both are given — to combine "this tag AND this status" precisely, filter once broadly (by tag) then grep/inspect the output file, rather than relying on the tool to AND two flags in one pass.

#### 3.5.1 Per-tag broker-call JSON artifacts

When a report needs a reusable broker-call artifact for each tag:

1. Fetch the order-updates surface for the tag and date, then select the `SC_BROKER` record whose message is `broker action - orderStatus`:
   ```bash
   node fetch-s3-logs.js \
     --s3-url s3://sc-pm2logs-new/PROD/<YYYY-MM-DD>/sc-integrations-order-updates/ \
     --dir Out-logs --out ./logs/<tag>/order-updates \
     --filter-text <tag> --ci --sort of
   ```
2. Write one valid, standalone JSON object named exactly `<tag>.json` directly into `logs/findings/logs/` (flat, no per-date subfolder — see §3.5.2). Keep only the relevant request and the target order leg from the broker response: `observedAt`, `trace.id`, `transaction.id`, request method/URL/tag filter, HTTP/response code, raw `orderStatus`, exchange order number, requested/remaining/traded quantities.
3. Do not copy credentials, authorization headers, account numbers, or unrelated legs from the full log. The OU log schema has no log-level `_id`; retain `trace.id` and `transaction.id` as the identifiers for retrieving the complete original event later.
4. Link the tag-named JSON file beside that tag's findings in the investigation report, as a relative path (`./logs/<tag>.json` — see §3.5.2). Keep the large aggregated OU log as supporting evidence under the raw `logs/<date-folder>/` tree, not as the per-tag artifact.

The same process applies to EKS order-updates paths; only the `--s3-url` changes. For recon evidence, keep the per-tag JSON artifact separate from the raw CSV downloads under `sbi_recon/<date>/` and `mtf_recon/<date>/`.

#### 3.5.2 Investigation report file organization

All investigation reports and their per-tag artifacts live together under `logs/findings/`, separate from the raw per-date fetch output:

```
logs/
  findings/
    <broker>_order_investigation_<date-or-range>.md   # the report(s)
    logs/
      <tag>.json                                       # flat, one per tag, from §3.5.1
  <date-folder>/                                        # raw fetch-s3-logs.js output, unchanged
    order-updates/, recon-sbi/, recon-mtf/, ...
```

- **Report naming:** `<broker>_order_investigation_<YYYY-MM-DD>.md` for a single-date investigation, or `<broker>_order_investigation_<YYYY-MM-DD>_to_<YYYY-MM-DD>.md` for a report spanning multiple investigation dates (e.g. `sbi_order_investigation_2026-06-01_to_2026-06-24.md`). Don't lead the filename with a single tag once the report covers more than one tag — name it by broker + date scope instead.
- **Per-tag artifact location:** every `<tag>.json` built per §3.5.1 goes in `logs/findings/logs/`, flat — not nested under a date or the raw per-date folder tree.
- **Linking from the report:** since the report lives in `logs/findings/` and the artifacts are its sibling `logs/` folder, link them as `./logs/<tag>.json` — not an absolute machine path, and not `./findings/logs/...` (that would be correct only if the report stayed one level up, outside `findings/`).
- **Everything else stays put:** the aggregated per-date evidence (`order-updates/all-logs.filtered.log`, recon CSV dumps, `jobs-recon/`, `redash-order.json`, etc.) is not moved into `findings/` — link it from the report using its existing path under `logs/<date-folder>/...`.

---

### 3.6 Broker-field disambiguation reminder (read before filtering)

`--filter-field "broker=sbi"` alone **cannot distinguish SBI cash from SBI-MTF** — both real (non-leprechaun) brokers log `broker:"sbi"` (`sc-integrations-broker-lib/src/brokers/sbi-mtf/config.js:19`: `brokerName = isLeprechaun ? 'sbi-mtf-leprechaun' : 'sbi'`). Use instead:

| Signal | SBI (cash) | SBI-MTF |
|---|---|---|
| `tag` / `externalReferenceNumber` prefix | `sc_` | `scmtf_` |
| `product` field (`orderLegDetails`/`dealerorderLegDetails`) | `1` | `6` |
| Redis dealer-token key prefix | `sbi:dealer_token` | `sbi-mtf:dealer_token` |
| `emarginDate` field presence | absent | present (may be `undefined`) |
| leprechaun-variant `broker` value | `sbi-leprechaun` | `sbi-mtf-leprechaun` |

---

### 3.7 Example invocations (verified working recipes)

**(a) Everything for a given tag, recent date (order-updates, EKS — current routing)**:
```bash
node fetch-s3-logs.js \
  --s3-url s3://sc-eks-pod-logs/production/2026-09-20/integrations/sc-integrations-order-updates-pod/ \
  --out ./logs/tag-scmtf_ab12cd34e \
  --filter-text scmtf_ab12cd34e --ci --sort of
```

**(b) Everything for a given tag, older date (order-updates, EC2/PM2 — pre-migration; live-verified exact recipe, reproduces a known real batch)**:
```bash
node fetch-s3-logs.js \
  --s3-url s3://sc-pm2logs-new/PROD/2026-06-05/sc-integrations-order-updates/ \
  --dir Out-logs \
  --out ./logs/tag-sc_rXWoyJfoH \
  --filter-text sc_rXWoyJfoH --ci --sort of
```
(`--dir Out-logs` is required — omitting it pulls `Error-logs`/`code-deploy-logs`/`script-logs` noise too, per §3.2.)

**(c) `platform-api` — check BOTH generations, since it's dual-running:**
```bash
for BASE in \
  "s3://sc-eks-pod-logs/production/2026-09-20/platform/sc-platform-api-pod/" \
  "s3://sc-pm2logs-new/PROD/2026-09-20/sc-platform-api/ --dir Out-logs"; do
  node fetch-s3-logs.js --s3-url $BASE --out ./logs/platform-api-2026-09-20 --filter-text "<tag or batchId>" --ci
done
```

**(d) Everything for a given `batchId` across a date range** (`fetch-s3-logs.js` has no native multi-date range — loop):
```bash
for d in 2026-06-10 2026-06-11 2026-06-12; do
  node fetch-s3-logs.js \
    --s3-url s3://sc-eks-pod-logs/production/$d/integrations/sc-integrations-order-updates-pod/ \
    --out ./logs/batch-64f1a2b3c4d5e6f7a8b9c0d1/$d \
    --filter-field "batchId=64f1a2b3c4d5e6f7a8b9c0d1" --ci
done
```
(`batchId` is a stringified Mongo `ObjectId`; its first 4 bytes are a Unix timestamp — `parseInt(batchId.slice(0,8),16)*1000` recovers an approximate creation date if narrowing the loop range without Mongo access.)

**(e) SBI recon job output for a given month — two distinct things, both needed:**
```bash
# 1. Raw broker recon CSVs the job ingested that month (surface 4 — not JSON, suppress the default filter)
for d in 2026-06-{01..30}; do
  node fetch-s3-logs.js --s3-url s3://sc-integrations-sbi-attachments/sbi_recon/$d/ \
    --out ./logs/sbi-recon-csv/$d --no-filter-text
  node fetch-s3-logs.js --s3-url s3://sc-integrations-sbi-attachments/mtf_recon/$d/ \
    --out ./logs/mtf-recon-csv/$d --no-filter-text
done

# 2. The job's own per-run stdout (surface 3 — list by filename substring, gzip needs forcing, see §3.3)
node fetch-s3-logs.js --s3-url s3://sc-prod-logs/sc-integrations-jobs/sbiReconAllOrders \
  --out ./logs/sbi-recon-job-runs --no-filter-text
# then filter/inspect by the embedded epoch-ms in each key, or by LastModified, for the specific date(s) wanted
```

---

## Section 4: Troubleshooting Playbook — How to Answer Common Questions


Procedural, scenario-driven. Each scenario: **Fetch** (service + filter) → **Look for** (exact strings/fields) → **Interpret** → **Root cause / next action**. Field/code semantics (`shortfallFlag`, `orderStatus` table, `getErrorCode` regex map) are established in §1–§2 — referenced here, not repeated in full.

**Tooling baseline** (full detail in §3): pull raw lines with
```
node fetch-s3-logs.js --s3-url s3://<bucket>/<prefix> --out <dir> --filter-text "<tag>" --ci
```
Live-verified bucket routing (§3.2), not a guess: order-updates and broker-api are **EKS-only** for recent dates (`sc-eks-pod-logs`), EC2/PM2-only (`sc-pm2logs-new`, remember `--dir Out-logs`) for older ones — fully migrated, so pick by date, not by trying both. `sc-platform-api` is **dual-running on both** for any date — always check both. `sc-integrations-jobs`' own per-run stdout lives in a *third*, structurally different surface (`sc-prod-logs/sc-integrations-jobs/`, one gzip object per job invocation, needs forced gunzip — §3.3), separate from its recon CSV data files (`sc-integrations-sbi-attachments`, `smallcase-trash` — §3.4).

Always filter by **`tag`** (`sc_...` = SBI, `scmtf_...` = SBI-MTF), never by `broker` — the real broker's log field is `broker:"sbi"` for **both** SBI and SBI-MTF (`sbi-mtf/config.js:19`). Output file `all-logs.filtered.log` is pretty-printed JSON objects with trailing commas, no `[...]` wrapper — not directly `JSON.parse`-able as a whole file.

---

### 4.1 "What was the last update for this tag?" — hanging order (no further status received)

**Fetch:** `sc-integrations-broker-api` (or `order-updates`) logs, `--filter-text "<tag>"`.

**Look for (in order):**
1. The `placeOrder` request/response pair — `'Successful request'` then `'sending success response'` (`sbi/services/request.js:81-267`, mirrored in MTF). Confirm `orderId` returned and whether `orderLegDetails.product` is `1` (CASH) or `6` (MTF) in the request body.
2. **Dealer fake-success trap**: if the response shows `orderId:"NA"` and `statusMessage:"order placed by dealer"` — the order was **never sent to the broker at all** (`sbi/services/order.js:260-269`, `sbi-mtf/services/order.js:267-279`). There is nothing further to poll for; this is not a broker-side hang, it's a missing `options.dealerDetails` on the calling side.
3. Any subsequent `getOrderDetails` call (`POST /books-service/order-status`) with the same tag in `orderLegDetails.externalReferenceNumber` in the request/response.

**Interpret:**
- SBI/SBI-MTF have **no postback/webhook** — `orderStatusBy: {postback:false, polling:true}` (`sbi-mtf/config.js:63-66`; framed generally as true for SBI too). Status only changes when something explicitly calls `getOrderDetails` again.
- The research corpus found **no generic (non-AMO, non-activated) order-status polling job** for SBI/SBI-MTF in `sc-integrations-jobs`. Only `triggerAmoPoll.js` (AMO-variety orders) and the activation-specific axis pipeline poll order status. **This is stated plainly because it could not be confirmed, not inferred**: for a regular (non-AMO) order, if nothing else in the platform re-calls `getOrderDetails`, the order can sit at its last-known status indefinitely with no automated re-check.
- `orderTimestamp: null` in a status response is not itself evidence of a hang — `parseSBITimestamp` returns `null` silently on any malformed SBI timestamp string (`sbi/services/order.js:12-27`).

**Root cause / next action:**
- If step 2's dealer fake-success pattern is present → application-side bug (dealer order placed without `dealerDetails`), not a broker hang. Fix is upstream of broker-lib.
- If a real `placeOrder` succeeded and no later `getOrderDetails` call exists for the tag → check `hangingOrderEodReport.js` output (status `ERROR|PLACED|PARTIALLYPLACED`, `sc-integrations-jobs/jobs/sanity/hangingOrderEodReport.js:18-28`) to see if this order/batch was flagged; if SBI-MTF and non-terminal (`UNPLACED|UNFILLED|PARTIALLYFILLED`), check `cleanupMtfNonTerminalBatches.js` (`MTF_BROKERS` includes `sbi-mtf`) — it force-resolves stale batches only when a **newer** batch exists for the same `iscid` (grep `Order.meta.updates` for `"Marked MARKEDCOMPLETE by cleanup job cleanupMtfNonTerminalBatches..."`); if this batch is still the latest for its `iscid`, the job explicitly skips it (`'Skipping: this is the latest batch for iscid'`) — genuinely stuck, needs a manual `getOrderDetails` re-poll or escalation.
- If AMO variety → see §4.4 instead (dedicated poll path exists).

---

### 4.2 Broker returned an error/rejection code — what does it mean, is it retryable

**Fetch:** `sc-integrations-broker-api`, `--filter-text "<tag>"`; also fetch `sc-integrations-jobs` output if the error surfaced via `sbiRejectedAmoOrdersIngest.js` (AMO rejects only — see below).

**Look for:** the raw `statusMessage` string in the `placeOrder`/`getOrderDetails` response, and (if `status:REJECTED`) the follow-up `getOrderRejectionReason` call (`POST /order-rejection/rejection-reason`) whose `.reason` becomes `statusMessage`.

**Interpret — map `statusMessage` → `errorCode` via `config.getErrorCode()` (full regex table in §2/§3):**

| errorCode | Meaning | Operationally retryable? |
|---|---|---|
| `checkHoldings` (Q shortfall) | Not enough shares held/available for hold or square-off | No — needs user to release/hold stock in SBI app first, not a system retry |
| `marginExceeded` (F shortfall) | Insufficient funds/margin | No — needs funds added; retry with same order will fail identically |
| `userNotLoggedIn` | Session taken over by another device/operator | No — needs re-login |
| `clientNotEnabled` | Client deactivated/suspended by SBI on the exchange | No — broker-side account gate, escalate |
| `tradingSystemNotReady` | IOC-in-preopen / closing price unavailable / market not open / emargin unavailable (MTF) | Yes — transient, retry after the relevant window opens |
| `securityNotAllowed` | Scrip-level restriction (suspended, square-off required, E-Margin trading blocked on scrip) | Usually no — security-specific, same-day retry likely fails again |
| `amoNotAllowed` (MTF only) | Outside AMO window (7PM–9AM) | Yes — retry inside the window |
| `networkError` (MTF only) | `"Exchange connection is down, please try later"` | Yes — transient |
| `invalidOrder` / `unknownError` / `otherError` | Generic/unclassified `Order Rejected` / `Unknown API error` / unmatched text | Unknown — no signal in the message itself; inspect raw response body |

**No code-level automated retry exists for order-placement failures.** The only built-in retry in the whole flow is `getOrderDetails`'s NRI settlement-type retry on `messageCode:600014` ("no data found", SBI-regular **only**, not MTF — `sbi/services/order.js:363-378`), which retries the *status query*, not the placement.

**Gotcha:** if `shortfallFlag` is present but not `N`/`Q`/`F`, the code falls through to a generic `'Unknown error'` and **the actual flag value is never logged** (`sbi/services/order.js:54-91`) — if you see a bare `'Unknown error'` on a shortfall-shaped response, the raw un-redacted response body (not the mapped `statusMessage`) is the only place to find the real flag value.

**Root cause / next action:** classify via the table above; for `tradingSystemNotReady`/`amoNotAllowed`/`networkError` recommend a timed retry; everything else needs a non-automated fix (funds, holdings, re-login, broker-side account state) before any retry will succeed. `709152` on a **funds-check** (not placement) response is not an error — both adapters treat it as `sufficientFunds:true` (a known "zero funds required" edge case).

---

### 4.3 Batch stuck in ERROR state for SBI — why, and can it self-resolve

**Fetch:** `sc-integrations-broker-api`, `--filter-text "<tag>"` for the raw `getOrderDetails`/`placeOrder` response; recon job output for the batch's fix history.

**Look for:** raw `orderLegDetails.orderStatus` numeric code in the SBI response body.

**Interpret — ERROR is a catch-all, not a distinct broker state.** It results from one of:
1. Raw status code `5` (TRANSIT), `7` (EXPIRED), or `8` (FREEZED) — **unmapped in `orderStatusesReverse`**, explicitly flagged unresolved in code comments (`// todo: confirm the commented out statuses`, `sbi/constants.js:116`). These three codes surface as generic `status:'ERROR'` with **no further distinguishing detail** — this is the direct, confirmed answer for "stuck in ERROR with no clear reason."
2. `_mapPlaceOrderResponse`'s fallback branch (no `response.result`, or an unhandled `shortfallFlag`) → synthesized `Error('order placement failed')`.
3. A `status:REJECTED` order whose `getOrderRejectionReason` follow-up call itself errors — that error propagates up and can surface the order as `ERROR` instead of a clean `REJECTED` (`sbi-mtf/services/order.js:398-400`).

**Self-resolve mechanisms — what exists and what doesn't:**
- `cleanupMtfNonTerminalBatches.js`'s `NON_TERMINAL_STATES` is `['UNPLACED','UNFILLED','PARTIALLYFILLED']` — **`ERROR` is not in that list**, so this job never auto-resolves an ERROR-stuck SBI-MTF batch.
- `hangingOrderEodReport.js` includes `ERROR` in its non-terminal query (`$in:["ERROR","PLACED","PARTIALLYPLACED"]`) but it is **report-only** — counts, no fix.
- The one real self-resolve path is `sbiReconAllOrders.js` (daily job): it downloads SBI's own order-status CSV export (`sbi_recon/<date>/`, `mtf_recon/<date>/`) and calls `fixBatchByTradebook(batchId, tradebook)` → `POST {BB_SERVICE_HOST}/errors/fix/{batchId}` when the broker's terminal state (`COMPLETE`/`REJECTED`) disagrees with the DB's `ERROR`. Grep its Slack/log output for `'Batch state before fix'` / `'Batch state after fix'` with this `batchId`.
- **Exception**: if `batch.meta.supersededByDummyBatchId` is set, `sbiReconAllOrders.js` explicitly **skips** the batch (`'Skipping batch superseded by dummy order — broker update received for archived batch'`, `sbiReconAllOrders.js:1228-1241`) — an ERROR batch with this meta field will never be auto-fixed by recon; it was intentionally archived in favor of a newer batch.

**Root cause / next action:** identify which of the 3 causes applies from the raw response; if code 5/7/8 → there is genuinely no more detail available from SBI's own status API, this is a known code-level gap, not a missing log. Check whether the next `sbiReconAllOrders.js` daily run fixed it (grep batchId in its report); if `supersededByDummyBatchId` is set, do not expect recon to touch it — check the superseding batch instead.

**If the batch shows `status !== 'ERROR'` now (i.e. it WAS fixed) and you need to know how**: see §5 for the full provenance breakdown — check `Order.meta.source` first (`'smallboard'` = manual, `'sc-integrations-jobs'` = automated recon, absent = check the "quiet path" log line in §5.2 before assuming normal flow), then correlate timestamps against the recon job's own S3 log (§3.3) if you need to know *which* recon script specifically.

---

### 4.4 AMO order placed evening before — did it execute at market open? Trace the overnight → poll → postback chain

**Fetch:** `sc-integrations-broker-api` the evening of placement (`--filter-text "<tag>"`) + the following morning (`orderSlot:2`/`OFF_MARKET` in the `placeOrder` request body confirms AMO).

**Look for:**
1. Placement evening-before: `orderParameters.orderLegDetails.orderSlot:2`, `orderValidity` forced to `DAY(1)` regardless of requested validity (both brokers).
2. `sc-integrations-jobs` `triggerAmoPoll.js` run the next morning — log line `` `Amo Poll(${sstOrder?'SSTOrders':'Normal Orders'}) Triggered for brokers ${amoAllowedBrokers}` `` will literally list `sbi,sbi-mtf` (both are **hardcoded** into `amoAllowedBrokers` via `.concat(['sbi','sbi-mtf'])`, independent of broker-lib's own `amoAllowed` config flag — `jobs/triggerAmoPoll.js:106-113`).
3. A `getOrderDetails` call for the same tag, triggered by that poll.

**Interpret:**
- SBI/SBI-MTF is **polling-only, no postback** — "execution at market open" is only known once the poll job actually calls `getOrderDetails` and the response is written back.
- Poll query: `status in [PLACED,PARTIALLYPLACED,ERROR]` AND `broker in amoAllowedBrokers` AND AMO date-window AND (`activated != true` OR (`activated == true` AND `broker in ['sbi','axis']`)).
- **Gotcha**: activated SBI-MTF AMO orders are **excluded** from this poll (`sbi-mtf` is not in the `['sbi','axis']` activated-exception list) — only non-activated `sbi-mtf` AMO orders get polled here. An activated SBI-MTF AMO order that looks stuck after the morning window is expected to NOT have been auto-polled by this job.
- AMO active-hours windows (`misc.js`, both brokers): before 09:00 IST → `[19:00 IST yesterday, 08:59 IST today]`; 09:00–09:15 IST → narrow `[09:07,09:14]`; else → `[19:00 today, 08:59 tomorrow]`.
- `hangingOrderEodReport.js`'s own AMO window uses `todayMarketOpen = new Date(y,m,d,3,30,0)` — **3:30 server-local hours**, which if the server runs UTC is 9:00 IST, i.e. **before** NSE's real 9:15 open. This is a coded quirk, not a bug fix target — be aware the report's "market open" cutoff runs slightly early.
- `'AMO polling skipped as it's not a working day.'` — thrown/logged if the poll ran on a non-trading day; a "why didn't it execute" question on a holiday resolves here.

**Root cause / next action:** confirm the poll job actually ran for that broker/date (log line above); if it ran and `getOrderDetails` shows a terminal status (`COMPLETE`/`REJECTED`/`CANCELLED`), that's the answer. If it ran and status is still `PLACED`/`ERROR`, check the activated-SBI-MTF exclusion above before assuming a poll bug. If the poll never ran (holiday, or job failure), check `hangingOrderEodReport.js`'s AMO section for that batch, and be aware of its own market-open time quirk.

---

### 4.5 SBI-MTF specific: margin/funding shortfall on an order

**Fetch:** `sc-integrations-broker-api`, `--filter-text "<tag>"`, look for both the `fundsCheck` (pre-check) call and the `placeOrder` response.

**Look for:**
1. `placeOrder` response `response.result.shortfallDetails.shortfallFlag` — `'Q'` (quantity, maps `checkHoldings`) or `'F'` (funds, maps `marginExceeded`) with `shortfallValue`.
2. `fundsCheck` (`PUT /bank-service/fund-hold-management`) response — `sufficientFunds` derived from `responseCode == 0`.
3. `'Error fetching margin funding percentages from Redis'` (`sbi-mtf/services/fund.js` — exact string) — Redis outage during margin-% lookup.
4. `'Error computing marginReceivable'` / `'Error calculating margin receivable for mixed basket'` — sell-leg margin credit calc failure in a mixed BUY+SELL basket.

**Interpret:**
- MTF funds required = `Σ (Stock Qty × Current Price × User Margin Funding %)`, where price comes from Redis `QTS:<sid>` field `kite`, and margin % comes from Redis `MTF:<sid>` field `sbi-mtf.<exchange>` (`config.getMarginIdentifier`), **defaulting to 100% (no leverage) if missing** — a missing Redis entry is not an error, it just means "pay full amount," which can present as an apparent margin shortfall that isn't a broker rejection at all.
- On any exception in the margin-% calc, the code falls back to **full unmargined buy amount** (fail-safe, over-holds funds rather than under-holding) and logs the exact string in item 3 above.
- Mixed-basket SELL credit (`marginReceivable`) can **legitimately be `0`** on a losing position — `receivable = max(qty×avgBuyPrice×currentMarginPercent − loss, 0)` — this is expected behavior, not a bug, when the position's loss exceeds the margin-funded portion.
- `viewLimits` for MTF reads `availableLimitEqEmargin` (not `availableLimitCashAndCarry`, which is the SBI-regular field on the same endpoint) — if a manual comparison against a raw API response is being done, use the right field.
- **Dealer-placed MTF orders bypass this entire funds-check flow** — `check()` short-circuits to `{sufficientFunds:true, requiredFunds:0}` without calling any broker API when `dealerId` is present. A shortfall on a dealer MTF order can only come from the broker's own `placeOrder` response (`shortfallFlag`), never from the pre-check.

**Root cause / next action:** if `shortfallFlag:'F'`/`'Q'` is present in the actual `placeOrder` response, it's a genuine broker-side rejection (map via `marginExceeded`/`checkHoldings`, §4.2 table — not automatically retryable). If instead only the internal `fundsCheck` pre-check failed and item 3's Redis-error log is present nearby, treat it as a possible false-positive caused by a Redis lookup failure, not a true funding gap — recommend re-checking once Redis margin data is confirmed populated for that security. **Note**: the corpus found `order.js`'s shortfall-flag state machine has **no direct unit test coverage** — treat the shortfall→statusMessage construction as read from source, not test-verified.

---

### 4.6 Dealer order placement failure — expired/missing dealer token

**Fetch:** `sc-integrations-broker-api`, `--filter-text "<tag>"` (or `--filter-text "<dealerId>"` if tag unavailable); also `sc-platform-api` for the dealer-terminal login itself.

**Look for:**
- Exact string `'Dealer session not found or expired, please re-authenticate'` — returned when the cached token lookup at Redis key `sbi:dealer_token:{entityId}:{dealerUserId}` (SBI regular) or `sbi-mtf:dealer_token:{entityId}:{dealerUserId}` (SBI-MTF — separate namespace, same shared login endpoint `SBI_DEALER_LOGIN_API_ENDPOINT`) comes back empty (`sbi/services/order.js:155-157`, `sbi-mtf/services/order.js:171`).
- Distinct pattern: `orderId:"NA"` + `statusMessage:"order placed by dealer"` — this is **not** a token problem; it means `dealerId` was present but `options.dealerDetails` was never passed, so broker-lib never called SBI at all (application-layer bug, see §4.1 item 2).
- In `sc-platform-api`: `sbi.dealerTerminal.integrations.js` log subtypes `DEALER_TERMINAL_REQUEST` / `DEALER_TERMINAL_ERROR`, error codes `SBIDT001`–`SBIDT005` (400/401/404/default/api-error) — this is the **login** flow that populates the Redis token in the first place; a failure here means the token was never cached, distinct from an expired-but-previously-valid token.

**Interpret:**
- Token TTL is `28800`s (8h) from last successful dealer login (`DEALER_TOKEN_TTL_SECONDS`, `sbi/services/user.js:402-443` / `sbi-mtf/services/user.js:425-466`). If the last dealer login was more than 8h before the failed order, expiry is the straightforward cause.
- If no prior successful login exists at all for that `entityId`/`userId` pair, the Redis key was never set — check `sc-platform-api`'s dealer-terminal login logs (`SBIDT00x`) for why login itself failed.

**Root cause / next action:** re-authenticate the dealer (triggers a fresh 8h token) if expired; if login itself is failing, trace the `SBIDT00x` code in `sc-platform-api`. If the failure is the `orderId:"NA"` fake-success pattern instead, this is not a token issue — flag as an application bug (missing `dealerDetails` on the `place()` call), and note the order was **never actually placed at SBI** despite the apparent "PLACED" status in our system — check the audit collection `dealerOrderDownloadLogs` (queried by `sbiReconBatchCreation.js`'s `checkDealerOrderDownloadLogs`) to see if SBI has any record of this tag at all; if absent there too, confirms it never reached the broker.

---

### 4.7 Activation order (bulk dealer-placed onboarding orders) — trace across sc-integrations-jobs and order-updates

**Important — confirmed via research, stated plainly**: `jobs/activations/*` in `sc-integrations-jobs` (`ingestActivatedUsers.js` → `placeActivatedOrders.js` → `pollActivatedOrders.js` → `removeUnfilledOrdersEod.js`) is **entirely Axis-specific** (`grep -i sbi` = 0 hits across all 5 files: hardcoded `broker='axis'`, `supportedBrokers=['axis']`). **There is no SBI equivalent of this pipeline.** Do not assume Axis activation-job mechanics apply to SBI.

**What SBI actually has instead:**
1. **Generic SIP-based activation** (broker-agnostic, no SBI branching at all): `sc-platform-api`'s `createSipByShares` (`POST /internal/user/sip/create` or `/v1/internal/integrations/user/sip/create`) — reads `models.Activation.findOne({userId})`, builds SIP params from `activation.orderConfig`, logs `'Internal SIP creation'` (`type:DEBUG_MESSAGES`) with the full `params` object dumped. `AUTOSIP_ENABLE_FOR_BROKERS` includes `sbi` (`config.js:373`).
2. **Bulk dealer CSV placement** (one-off/manual, not a scheduled job): `sbiDealerRecon3Feb2025.js`'s `main()` — reads a dealer-orders CSV, synthesizes `Order` docs (`dealer:true`), calls `POST /v2/internal/orders/autosip/preorder` then `POST /v2/internal/batch/apply?broker=sbi`.
3. **Self-healing for orders confirmed by SBI but missing from Mongo**: `sbiReconBatchCreation.js`'s `createBatchesFromLogs`, sourced from the raw Mongo collection `dealerOrderDownloadLogs` (fields `payload.dealerOrders[].tag`, `payload.iscid`, `dealerId`, `userId`) — gated by `--createMissingBatches`; synthesized batches get `meta.type: "reconInsert <date>"` (grep target).
4. **Daily count sanity check only** (no fix logic): `sbiActivationAutosipReport.js` — `Order.countDocuments({activated:true, broker:'sbi', date:...})`, IST day window, email to internal + external SBI Cap Sec addresses.

**Fetch/trace chain for a given activation tag/batchId:**
1. `sc-platform-api`: `PLACEORDERS_SMALLCASEORDERFLOW_DEBUG/SUCCESS/ERROR` (`userSmallcase.js:3614,3638,3644`) — full outgoing batch payload including `activated` flag.
2. `sc-platform-api`: `APPLY_BATCH_START` → `PLACEDORDER_STATUS_CHECK` → `PLACEDORDER_STATUS_APPLIED` → `MARK_PLACEDORDER_COMPLETED_START/DONE` (`userSmallcase.js:10029-10489`) — the `PlacedOrders` state machine `QUEUED/ACKED/RECEIVED → APPLIED → COMPLETED`, keyed by `batchId`/`correlationId`.
3. `sc-integrations-broker-api`: broker-lib's `place()` — `options.label=='AUTOSIP' || options.activated` (and, **SBI-regular only**, `|| options.autoSip`; SBI-MTF omits that third check — `sbi/services/order.js:273` vs `sbi-mtf/services/order.js:283`) routes to `autosipService.placeOrder` → `POST /sipbasket-service/smallcase-sip-place-order`.
4. If dealer-placed bulk: `dealerOrderDownloadLogs` collection + `sbiReconBatchCreation.js`/`sbiDealerRecon3Feb2025.js` logs.
5. `sbiActivationAutosipReport.js`'s daily count — sanity/volume check, not a per-order trace tool.

**Root cause / next action:** since there's no dedicated SBI activation-poll job, an activation order that looks stuck should be traced through the generic apply/place chain (steps 1–3) exactly like a normal order, cross-checked against `dealerOrderDownloadLogs` if it was dealer-placed. `PlacedOrders` stuck at `APPLIED` with no further movement and no error logged is a known silent-no-op case: `markPlacedOrderCompleted` only flips to `COMPLETED` if the ISC's own status has already left `'PLACED'` — check `investedSmallcases[].status` for the `iscid` directly, not just `PlacedOrders.status`.

---

### 4.8 Batch shows PARTIALLYFILLED / PARTIALLYPLACED — find the problem leg

**Fetch:** `sc-integrations-broker-api`, one filter pass per leg tag in the batch (`--filter-text "<tag1>,<tag2>,..."` is AND-semantics per line — use separate runs, or `--filter-field` with an OR expression, one tag at a time is safest).

**Look for:** per-leg `getOrderDetails` response — `orderQuantityDetails.orderQuantity` (requested) vs `tradedQuantity` (filled), and `orderLegDetails.orderStatus`.

**Interpret:**
- SBI's raw per-order status codes have no direct "partially filled" order-level state distinct from `PLACED` — code `3` (`PARTIALLY_TRADED`) still maps to `status:'PLACED'` at the individual-order level (§2 table). `PARTIALLYFILLED`/`PARTIALLYPLACED` is a **batch-level rollup** concept computed from the set of per-leg statuses, not a single SBI status value — isolating the "problem leg" means comparing legs, not looking for a special code.
- Per leg: `filledQuantity = orderQuantityDetails.tradedQuantity || 0`; compare against the leg's originally requested `orderQuantity`. `averagePrice = totalTradedValue / tradedQuantity` (0 if unfilled).
- A leg at `REJECTED` inside an otherwise-filled batch is the typical "problem leg" — check its `getOrderRejectionReason` follow-up call for the human-readable reason (remember the wire quirk: a successful lookup is logged as `'Successful rejection reason request'` even though it was an HTTP-level error internally, `sbi/services/request.js:201-219`).
- A leg at `ERROR` (raw code 5/7/8, unmapped — §4.3) is the other common "problem leg" pattern, with no further broker-side detail available.
- **SBI-MTF only**: check `Order.meta.updates` for the `cleanupMtfNonTerminalBatches.js` string — if this batch was `PARTIALLYFILLED` and *not* the latest batch for its `iscid`, the job may have already force-closed it to `MARKEDCOMPLETE` (`'Marked MARKEDCOMPLETE by cleanup job cleanupMtfNonTerminalBatches...'`). If still the latest for its `iscid`, the job explicitly leaves it alone (genuinely still open).

**Root cause / next action:** enumerate every leg's tag under the batch, pull each one's `getOrderDetails` response, diff requested vs filled quantity and status per leg — the leg(s) with `tradedQuantity < orderQuantity` and a non-`PLACED`/non-`COMPLETE` status are the cause. Classify that leg's `statusMessage` via §4.2's table for retryability.

---

### 4.9 Cancel-order investigation (additional pattern surfaced in research)

**Fetch:** `sc-integrations-broker-api`, `--filter-text "<tag>"`, around the cancel-attempt timestamp.

**Look for:** `logger.error({error}, 'Error in cancelling order')` (failure path); on success, the response is **synthesized, not broker-derived** — literal `status:'CANCELLED AMO'` string regardless of whether the order was actually AMO (`sbi/services/order.js:551`, `sbi-mtf/services/order.js:544-553`) — do not infer "this was an AMO order" from that status string alone.

**Interpret / known quirks:**
- **SBI-MTF cancel payload bug**: `cancelOrder` sets `orderLegDetails.product: constants.products.CASH (1)`, **not** `MTF (6)`, unlike every other order-mutating call in the MTF adapter (`sbi-mtf/services/order.js:507`) — flagged in research as a real discrepancy, worth checking first if an MTF cancel silently affected the wrong product leg or failed unexpectedly.
- `cancelOrder`'s invalid-orderId path returns a **bare string** `'Invalid orderId'` as the error, not an `Error` object (`sbi-mtf/services/order.js:473-476`) — code calling `.message` on it will get `undefined`, not the string itself.

**Root cause / next action:** confirm the request body's `product` field before concluding a failed/wrong-behaving MTF cancel is a broker-side issue — it may be the known `product:CASH` adapter bug rather than a genuine rejection.

---

### 4.10 "Was this order fixed manually, by an automated recon job, or never touched?"

**Fetch:** the `Order` document itself (via smallboard-be's `getOrders`/`getErrorOrder`, or a direct Mongo read if available) — this is a document-inspection question first, log-fetching second.

**Look for, in order:**
1. `meta.source` on the batch — `'smallboard'` (manual), `'sc-integrations-jobs'` (automated recon), or absent.
2. If absent, grep order-updates logs (§3.2) for `` 'Received request from smallboard to update batch fields -> ' `` with this `batchId` — this is the ONLY trace of a "quiet" force-update that leaves nothing in the document itself (§5.2).
3. If `meta.source === 'sc-integrations-jobs'` and you need to know *which* of the three recon scripts: check `statusMessage` first (`"Order Rejected: <real reason>"` → `sbiRejectedAmoOrdersIngest.js`; generic `"Marked as rejected as no update received from the broker"` → `sbiReconAllOrders.js` or `sbiDealerRecon.js`, ambiguous), then correlate the `meta.updates[]` timestamp against that job's S3 stdout log (§3.3) for a `"Batch state before/after fix"` entry with this `batchId`.
4. If the batch was newly *created* (not fixed in place) by recon, check `meta.type` — `"reconInsert <date>"` or `"<day><Mon>_DuplicateDealerOrder"` are unambiguous, job-specific markers.
5. If this is an `SSTOrder` document, check per-leg `statusMessage === 'Order fixed by support request.'` instead — a completely separate mechanism (§5.5) with its own (buggy) audit-trail quirk: it fabricates a "saved initially" `meta.updates` entry that looks like a brand-new order, not a fix.

**Full detail, tables, and every code citation: §5.**

**Root cause / next action:** report the provenance per §5.7's summary table. If the question is specifically "which person did this," the document and logs cannot answer it — the `fix-error-order` Mattermost channel is the only place a support agent's identity is recorded (§5.6).

---

## If none of the above resolves it

1. **Broaden the date range.** Re-run `fetch-s3-logs.js` with a wider `--from`/`--to` (IST via `--ist`), and confirm you're pointed at the right bucket for when the incident happened: order-updates/broker-api are **EKS-only for recent dates** and EC2/PM2-only for older ones (§3.2 — fully migrated, not a live choice); `sc-platform-api` is **dual-running on both** for any date, so always check both for platform-api specifically.
2. **Check the LAST RESORT layer**: `sc-platform-api`'s batch-apply state machine (`PlacedOrders.status`: `QUEUED/ACKED/RECEIVED → APPLIED → COMPLETED`, §4.7 step 2) is confirmed broker-agnostic and sits upstream/downstream of broker-lib — a batch stuck here with no broker-lib log trail at all often means the failure never reached SBI in the first place. Check `SCBAT0001`–`SCBAT0007` error codes and the `APPLIED`-but-ISC-still-`PLACED` silent no-op case.
3. **If this is a staging/non-prod incident**, re-check everything against the leprechaun (mock) variants instead of assuming real-broker mechanics apply: `brokerName` becomes `'sbi-leprechaun'`/`'sbi-mtf-leprechaun'` (not `'sbi'`), dealer-login detection differs (`_d` suffix / `dealerAuthData`, not `dealer_emp`), decrypt password/salt are hardcoded test values, and login-flow logs are prefixed `'DEBUG: ...'` at **info** level (noisy but real — a login trace on the mock path is unmistakable from this prefix alone).
---

## Section 5: Order Provenance — Manual (Smallboard) Fix vs Automated Recon vs Normal Ingestion

This section directly answers: **given an SBI/SBI-MTF `Order` document (or its logs), how do you tell whether its current status came from (a) normal broker ingestion (placement + poll), (b) an automated `sc-integrations-jobs` recon script, or (c) a manual fix by a support agent through `sc-smallboard-be`?**

All of this is based on direct source reads of `sc-integrations-order-updates/services/errors.js`, `ou-server/controller.js`, `ou-server/routes.js`, and `sc-smallboard-be`'s `app/controllers/api/support.js` + its helper/integration layers.

---

### 5.1 Headline answer

**`meta.updates[]` (the human-readable audit trail on the batch/order) CANNOT tell you this.** Its text depends only on which *save state* (INITIAL/PLACED/FINAL/AUTO) was written, generated by the one shared mongoose static `Order.saveOrder()` — never on who or what called it. A manual smallboard fix and an automated `sbiReconAllOrders.js` fix both end up calling `saveBatch()` → `Order.saveOrder(batch,'FINAL',cb)` → the identical `` `Order saved finally with status ${status}` `` string. **Do not use §1's `meta.updates[]` text to answer a provenance question** — it answers "what state, when," not "who."

**The real signal is a separate field: `batch.meta.source`.** It is set in exactly one place across the entire order-updates codebase:

```js
// sc-integrations-order-updates/services/errors.js:509-534, handle() — the handler
// behind POST/GET /errors/fix/:batchId, the single fix API every provenance path below goes through
async function handle({ batch, batchId, options = {} }) {
    const requestSource = options.requestSource || 'smallboard';   // default if header absent
    ...
    batch.meta.source = requestSource;
    const savedBatch = await saveBatch(batch);
```
`requestSource` comes from the `x-request-source` HTTP header, read at `ou-server/controller.js:17-22`.

| Caller | Sends `x-request-source`? | Resulting `meta.source` |
|---|---|---|
| `sc-smallboard-be` (`updateErrorOrder` → `sendTradebookToBB`) | **No** | `'smallboard'` (the default) |
| `sc-integrations-jobs`' `sbiReconAllOrders.js` / `sbiDealerRecon.js` / `sbiRejectedAmoOrdersIngest.js` | **Yes, explicitly** | `'sc-integrations-jobs'` |
| Normal ingestion (broker postback/poll) | Never calls this endpoint at all — `errorsService.handle` has exactly one caller in the whole repo (the `/errors/fix/:batchId` route) | `meta.source` field absent entirely |

**Practical rule:**
- `meta.source === 'smallboard'` → a support agent manually fixed it via smallboard-be.
- `meta.source === 'sc-integrations-jobs'` → fixed by one of the three automated recon scripts (see §5.3 for why you usually **can't** tell which of the three from this field alone).
- `meta.source` absent → never went through `/errors/fix` remediation — either it's healthy/normal-flow, **or** it was force-updated via the "quiet path" in §5.2, which leaves this field untouched too.

---

### 5.2 The "quiet path" — a write that leaves NO trace in the document at all

`sc-smallboard-be`'s **`POST /updateBatchStatus`** endpoint (support.js:218-223, permission `updateBatchStatus`) is architecturally different from the fix-API path above — it's the quietest write in the whole system:

```
smallboard-be: PATCH {BB host}/smallboard/orders?batchId={id}   body: {status:'ERROR'}
               header X-DOMAIN-TOKEN (shared secret, service-to-service, only smallboard-be has it)
                      │
                      ▼
order-updates: smallboardRouter → initSmallboard auth middleware → ordersController.updateOrderFields
                      │
                      ▼
               ordersService.updateOrderFields: raw Order.updateMany(filter, updates)
               NO saveOrder(), NO recordUpdate(), NO meta.source, NO meta.updates push — nothing.
```
Forcing a batch to `ERROR` (or whatever status) via this endpoint **leaves zero trace inside the Order document** — no `meta.source`, no `meta.updates` entry, nothing that differs from a document that was never touched this way. **The only trace of this ever happening is order-updates' own service log line:**
```
'Received request from smallboard to update batch fields -> '
```
(`ou-server/controller.js:836-844`, includes `batchId`, `iscid`, `queryParams`, and request `headers` in the log payload). **If a provenance question can't be answered from the document itself, grep order-updates' logs for this exact string with the batchId — this is the only place a quiet force-update shows up at all.**

`supportService.cancelBatch` is the one exception that's explicit and self-contained: `sc-smallboard-be/app/services/api/support.js:238` sets `batchDoc.meta.source = 'smallboard'` directly (hardcoded, independent of the order-updates default) before calling `smallcaseOrderFlow.cancelBatch` — so a smallboard-initiated cancel-to-`MARKEDCOMPLETE` **does** get tagged, unlike the quiet `updateBatchStatus` path above. The convention is real but **inconsistently applied** across smallboard-be's own endpoints.

---

### 5.3 Cannot distinguish *which* of the three recon jobs made a fix (usually)

All three active SBI recon scripts send the **identical** `x-request-source: sc-integrations-jobs` header:
- `sbiReconAllOrders.js:607`
- `sbiDealerRecon.js` (and its predecessor `sbiDealerRecon3Feb2025.js`)
- `sbiRejectedAmoOrdersIngest.js:267`

So `meta.source === 'sc-integrations-jobs'` on its own only tells you "some recon job did this," not which one. To attribute a specific in-place fix to a specific job, **correlate by timestamp**: pull that job's S3 stdout log (§3.3) for the run window around the order's `meta.updates[]` timestamp and grep for the `batchId`/`tag` in its `"Batch state before fix"` / `"Batch state after fix"` lines — each job logs the exact tradebook it applied.

**Exception — newly-*inserted* batches DO carry a job-specific marker** (not a fix, a from-scratch creation for a CSV row that had no `Order` doc at all):
- `sbiReconBatchCreation.js` (called from `sbiReconAllOrders.js` with `--createMissingBatches`): synthesized batch gets `meta.type: "reconInsert <YYYY-MM-DD>"`.
- `sbiReconDealerDuplicate.js` (dealer-double-order recovery, `--createDealerDuplicateBatches`): `meta.type: "<day><Mon>_DuplicateDealerOrder"`.

These `meta.type` strings ARE unique enough to identify the specific mechanism — but only for the create-a-new-batch case, not the far more common in-place status fix.

**One genuinely distinctive `statusMessage`, not shared across jobs:** `sbiRejectedAmoOrdersIngest.js` writes `` statusMessage: `"Order Rejected: ${reason}"` `` (constant `REJECTED_STATUS_MESSAGE_PREFIX`) — chosen deliberately to match SBI-MTF broker-lib's `invalidOrder` regex. The other two jobs' fallback `statusMessage` (used when their tradebook entry has no explicit message, which is the normal case) is the generic `` 'Marked as rejected as no update received from the broker' `` — **misleading if read literally**, since an update genuinely was received (from the CSV); it only reads that way because the tradebook entry omitted the field. If you see `"Order Rejected: <specific reason>"` verbatim, that's `sbiRejectedAmoOrdersIngest.js`, specifically the AMO-rejection path, with a real broker-supplied reason. If you see the generic "no update received" text, it's `sbiReconAllOrders.js` or `sbiDealerRecon.js` — check the S3 log timestamp correlation to tell which.

---

### 5.4 Order-leg-level marker: `meta.reconciled`

`markOrderSettled` / `markOrderUnplaced` / `markOrderNettedComplete` (`services/errors.js:407,435,467`) all set **`stockOrder.meta.reconciled = true`** on the individual order leg, regardless of `requestSource`. This tells you "this leg was resolved via the fix mechanism (orderbook/polling/unlocking), not natural broker settlement" — but it is **broker-agnostic and source-agnostic**: non-SBI brokers using the same `FIXBY.ORDERBOOK` mechanism (kite, motilal, upstox) set the identical flag, and it doesn't distinguish smallboard from a recon job either. Use it as a first filter ("was this leg fixed at all, by anything") — not as the answer to "by what."

---

### 5.5 A completely separate mechanism: `SSTOrder` fixes (Single Securities Transactions)

If the order in question is an `SSTOrder` document (not the plain `Order`/batch collection), smallboard-be's `getSstOrder`/`updateSstOrder` (support.js:125-136) **bypasses order-updates' `/errors/fix` path entirely** and goes straight to `sc-platform-api`'s `v1/internal/smallboard/reconcile` endpoint, which does a raw `SSTOrder.findOneAndUpdate()` with no provenance marker of its own added server-side.

The mutation happens **client-side** in smallboard-be's `fixSSTBatch` (`app/services/helper/platform.helper.js:588-661`) before the POST:
- Sets `statusMessage: 'Order fixed by support request.'` on each fixed leg — a genuine, unambiguous manual-fix marker, **but only for SST orders**, not the plain `Order` path used for SBI batches.
- **Bug worth knowing about**: it also fabricates a `meta.updates` entry reading `` `Order saved initially with status ${status}` `` — the word "initially" makes a manual fix look identical in the audit trail to a brand-new order's first save. Don't trust "saved initially" wording alone to mean "this was never touched by support."
- No `meta.source` is set anywhere in this SST flow.

**Open question, not resolved in this research**: whether ordinary SBI/SBI-MTF smallcase-basket orders ever live in `SSTOrder` at all (vs. exclusively the plain `Order` collection). `errors.js:135-136`'s `triageErrorBatch`, `case 'sbi': return FIXBY.NONE`, confirms SBI uses the plain `Order`/`/errors/fix` path for its normal error-reconciliation — but doesn't rule out SST being used for some other SBI order type. If you encounter an `SSTOrder` document with `broker: 'sbi'`/`'sbi-mtf'`, treat `statusMessage: 'Order fixed by support request.'` as the manual-fix signal for that document type.

---

### 5.6 Human identity — never in the database, only in Mattermost

Every smallboard-be mutating endpoint is gated by `authController.verifyRouteAccess(<permission>)`, tying the action to an authenticated internal admin/support user (`req.user`). **That identity is never written to the Order document** — the one place it surfaces at all is a Mattermost notification to the `fix-error-order` channel (support.js:1446-1452, 1709-1715), tagged with `req.user.email`, sent for `updateErrorOrder` and `updateBatchStatus`. **If you need to know *which person* fixed an order (not just "smallboard did it"), the order document and order-updates' logs cannot tell you — check the `fix-error-order` Mattermost channel history for that batchId/timestamp instead.**

---

### 5.7 Summary table — reading an `Order` document for provenance

| Signal | Where | Meaning |
|---|---|---|
| `meta.source === 'smallboard'` | `Order` doc, top-level `meta` | Manually fixed via smallboard-be `updateErrorOrder` (default) or `cancelBatch` (explicit) |
| `meta.source === 'sc-integrations-jobs'` | `Order` doc, top-level `meta` | Fixed by one of the 3 active recon scripts — cannot tell which from this field alone (§5.3); correlate by S3 log timestamp |
| `meta.source` absent | — | Either never went through `/errors/fix`, OR force-updated via the "quiet path" (§5.2) — check order-updates logs for `'Received request from smallboard to update batch fields -> '` before concluding "normal flow" |
| `meta.type === "reconInsert <date>"` / `"<day><Mon>_DuplicateDealerOrder"` | `Order` doc, top-level `meta`, **newly-inserted batches only** | Created by `sbiReconAllOrders.js`'s missing-batch or duplicate-dealer-order recovery — unambiguous, job-specific |
| `statusMessage === "Order Rejected: <reason>"` (real reason text) | Order leg | `sbiRejectedAmoOrdersIngest.js`, AMO-rejection path specifically |
| `statusMessage === "Marked as rejected as no update received from the broker"` | Order leg | `sbiReconAllOrders.js` or `sbiDealerRecon.js` — ambiguous between the two, correlate by timestamp |
| `statusMessage === "Order fixed by support request."` | `SSTOrder` leg only | Manual smallboard fix, **SST path only**, not the plain-`Order` path SBI normally uses |
| `meta.reconciled === true` | Order leg | Fixed via the orderbook/polling/unlocking mechanism, broker- and source-agnostic — "was fixed by something," not "by what" |
| order-updates log: `'Received request from smallboard to update batch fields -> '` | S3/service logs only, not in DB | The only trace of a quiet `PATCH /smallboard/orders` force-update |
| Mattermost `fix-error-order` channel | Not in DB or logs | The only place the specific human agent's identity is recorded |

**Read-side note:** `getOrders`/`getErrorOrder`/`getOrdersCustom` in smallboard-be all return the full `Order` document with no field projection, so `meta.source`/`meta.updates[]` ARE visible in the raw JSON response of any of them — but none of them let you **filter/search** by `meta.source` (the `source` filter on `getOrdersCustom` is `Order.source`, e.g. `'PROFESSIONAL'`/`'CUSTOM'` — a completely different, unrelated field; don't conflate the two).

**Not fully explored, flagged for follow-up**: `sc-platform-api` has a THIRD recon-adjacent mechanism — `brokerAutoReconController` (`routes/internal/smallboard.route.js:151-166`, an auto-recon-with-human-approval workflow: pending-approvals/approve/reject) surfaced through the same smallboard-router namespace. Not researched in this pass; may have its own provenance convention worth comparing against `meta.source` if the two markers above don't explain a given order's history.
