# Playbook — symptom to root cause

Each scenario: **fetch** → **look for** → **interpret** → **next action**.

Every scenario fetches from `order-updates` unless stated otherwise. The old guide told you to
fetch `sc-integrations-broker-api` in eight of these — that is wrong in every case and returns
zero rows, because broker-api never sees an order tag.

Baseline:

```bash
node fetch-by-identifier.js --service order-updates --tag <tag>
```

Always filter by **tag**, never by `broker` — the real broker's log field is `broker: "sbi"` for
both SBI and SBI-MTF.

---

## 1. "What was the last update for this tag?" — hanging order

**Look for, in order:**

1. The `placeOrder` request/response pair. Confirm an `orderId` came back, and check
   `orderLegDetails.product` — `1` = cash, `6` = MTF.
2. **The dealer fake-success trap:** `orderId: "NA"` with `statusMessage: "order placed by dealer"`
   means the order was **never sent to the broker at all**. `place()` short-circuits when
   `dealerId` is present but `options.dealerDetails` is not. Nothing to poll for — this is an
   application-side bug upstream of broker-lib, not a broker hang.
3. Any later `broker action - orderStatus` for the same tag.
4. `context.batch.meta.updates[]` on the chronologically last `Order placement successful` /
   `Batch saved` / `Batch saved in ERROR state` entry — the last entry plus its date directly
   answers "what was the last update".

**Interpret:**

- SBI has **no postbacks**. Status changes only when something explicitly calls `getOrderDetails`.
- There is **no generic order-status polling job** for regular (non-AMO, non-activated) SBI orders
  in `sc-integrations-jobs`. If nothing re-polls, the order sits at its last-known status
  indefinitely. Stated plainly because it is a real gap, not an inference.
- `orderTimestamp: null` is **not** evidence of a hang — `parseSBITimestamp` returns null silently
  on any malformed timestamp.

**Next:** if a real placement succeeded and no later status call exists, check
`hangingOrderEodReport.js` output for the batch. For SBI-MTF in a non-terminal state, check
`cleanupMtfNonTerminalBatches` — it only force-closes when a **newer** batch exists for the same
iscid, and explicitly skips the latest batch for an iscid.

---

## 2. Broker returned an error or rejection — what does it mean, is it retryable

**Look for:** the raw `statusMessage` in the place-order or order-status response, and for
`REJECTED` orders the follow-up `getOrderRejectionReason` call whose `.reason` becomes the
`statusMessage`.

**Interpret:** classify via the `getErrorCode` table in `02-status-codes.md`. Retryable:
`tradingSystemNotReady`, `amoNotAllowed` (MTF), `networkError` (MTF). Everything else needs a
non-automated fix — funds, holdings, re-login, or broker-side account state — before any retry can
succeed.

**There is no automated retry for placement failures anywhere in the flow.**

**If you see a bare `'Unknown error'` on a shortfall-shaped response:** the raw un-redacted SBI
response body *is* logged. Grep `sending success response` near the order's `X-REQ-UID` and read
`details.responseBody.result.shortfallDetails.shortfallFlag`.

`709152` on a **funds-check** response is not an error — both adapters treat it as
`sufficientFunds: true`.

---

## 3. Batch stuck in ERROR — why, and will it self-resolve

**Look for:** the raw numeric `orderLegDetails.orderStatus` in the SBI response.

**ERROR is a catch-all, not a broker state.** It comes from one of:

1. Raw code `5` (TRANSIT), `7` (EXPIRED) or `8` (FREEZED) — **unmapped**, and the raw code is
   discarded. This is the most common cause, and there is genuinely no further detail available.
   Source carries `// todo: confirm the commented out statuses`.
2. `_mapPlaceOrderResponse`'s fallback branch — no `response.result`, or an unrecognised
   `shortfallFlag`.
3. A `REJECTED` order whose `getOrderRejectionReason` follow-up itself errored, surfacing as ERROR
   rather than a clean REJECTED.

**Self-resolution — what exists:**

- `cleanupMtfNonTerminalBatches` does **not** cover ERROR — its `NON_TERMINAL_STATES` is
  `['UNPLACED','UNFILLED','PARTIALLYFILLED']`.
- `hangingOrderEodReport` includes ERROR but is **report-only**.
- `sbiReconAllOrders` is the one real path: it reads SBI's own CSV export and calls the fix API
  when the broker's terminal state disagrees with the DB.

**Three things that stop recon fixing it:**

- **No `--save`** → nothing is written, yet the job still logs `Batch updated successfully`.
  Check the run's `running job ... with params:` line.
- `batch.meta.supersededByDummyBatchId` is set → explicitly skipped
  (`Skipping batch superseded by dummy order...`). Check the superseding batch instead.
- **A never-traded order cannot be fixed structurally.** `validateOrderFields` drops any CSV row
  with `averagePrice <= 0` or NaN, and that column is the weighted average *trade* price — empty
  for an order with no trades. Rejected, cancelled and zero-fill orders are discarded at parse time
  into `failedOrders` and never reach the tradebook stage. Quantity, filledQuantity and price
  mismatches are *reported* but never repaired.

There is **no terminal-state skip.** `orderTerminalStates` is used only for reporting; a batch
already `COMPLETED` or `MARKEDCOMPLETE` is still passed to `getFixTradebook` and **can be
overwritten**, because the fix body sets `force: true`.

---

## 4. AMO placed the evening before — did it execute at open?

**Look for:**

1. Placement: `orderLegDetails.orderSlot: 2` (OFF_MARKET) confirms AMO. Retail AMO forces
   `orderValidity: DAY(1)`; **dealer AMO hardcodes IOC(2)** instead.
2. Next morning: `Amo Poll(...) Triggered for brokers ...` from `triggerAmoPoll.js` — `sbi` and
   `sbi-mtf` are both hardcoded into `amoAllowedBrokers`.
3. A resulting order-status call for the tag.

**Interpret:**

- Poll query: `status ∈ [PLACED, PARTIALLYPLACED, ERROR]` AND broker in the allowed list AND the
  AMO date window AND (`activated != true` OR (`activated == true` AND broker in `['sbi','axis']`)).
- **Activated SBI-MTF AMO orders are excluded** — `sbi-mtf` is not in the activated-exception
  list. An activated MTF AMO order that looks stuck was never auto-polled. `triggerAmoPollNonMarketDay`
  omits `sbi-mtf` entirely.
- AMO windows (IST): before 09:00 → `[19:00 yesterday, 08:59 today]`; 09:00–09:15 → `[09:07, 09:14]`;
  otherwise → `[19:00 today, 08:59 tomorrow]`. Cancel mirrors place.
- `AMO polling skipped as it's not a working day.` resolves a holiday question — **but see the
  calendar trap below.**

**Calendar trap:** `createSbiAutosipOrders` registers its `initCalender` callback **without the
`err` parameter**, silently discarding a calendar-load failure. If the Holidays fetch fails or the
year's document is missing, `isWorkingDay()` returns false for every date and the job emits exactly
the same "postponed to next working day" line while placing zero orders. **Confirm against the
Holidays collection, not against the log line.**

**Timezone trap:** the AMO window constructors assume `TZ=UTC`. Whether every deployed host
actually runs UTC is unverified. `hangingOrderEodReport` uses 3:30 server-local as "market open",
which is 09:00 IST under UTC — before NSE's real 09:15.

---

## 5. Funds / quantity shortfall — SBI-cash and SBI-MTF have different math, don't cross-apply

**Both adapters share the same wire-level shortfall signal** —
`response.result.shortfallDetails.shortfallFlag` — `Q` (quantity) or `F` (funds), with a
`shortfallValue`, mapped 1:1 into `statusMessage` by `_mapPlaceOrderResponse`
(`broker-lib/src/brokers/sbi/services/order.js:72-85` and the byte-identical
`sbi-mtf/services/order.js:87-99`). **That part of the diagnosis is broker-side and identical for
both — a `Q`/`F` flag in the actual place-order response is a genuine SBI rejection, not
retryable, regardless of broker.** What differs, and is the actual investigation surface when the
*pre-check* (funds.js `check()`) looks wrong before any order reaches the broker, is the internal
funds-hold math:

**SBI-cash** (`broker-lib/src/brokers/sbi/services/fund.js`):
- `fundsRequired` from `calculateFundsValues()` (`lib/utils.js`) using `config.bufferConfig[orderMode][variety]`
  and `allowedSellValues.T0` (regular) vs `.amo`.
- `fundsToBeHeld` = `fundsRequired` alone, or `+ brokerObligations` if `fundsRequired > availableLimitCashAndCarry` (`fund.js:41-50`).
- **Cash-only fallback:** if `options.rebalanceBasketFlag` is true and the funds-check fails, cash
  retries at a T1-settlement `minRequiredFunds` (buffer × amounts + a next-day buffer using
  `config.dpCharges` and `config.nextDayBufferWithClosePrice`) before giving up (`fund.js:181-287`).
  **SBI-MTF has no equivalent fallback path at all** — one failed funds-hold call is final for MTF.
- `0` on a `viewLimits`/`fundsCheck` failure returns `sufficientFunds: false` outright; `dealerId`
  present short-circuits to `sufficientFunds: true, requiredFunds: 0` (funds-check is skipped
  entirely for dealer cash orders too — not an MTF-only trait).

**SBI-MTF** (`broker-lib/src/brokers/sbi-mtf/services/fund.js`) — see scenario 5b below for the
margin-percentage math; the discriminator versus cash is: MTF's `buyAmount` comes from
`calculateMTFFunds()` (qty × Redis `QTS:` price × Redis `MTF:` margin%, defaulting to 100% i.e.
no leverage when the Redis key is missing), not from the basket's own declared `buyAmount`/`price`
like cash does. **A missing `MTF:<sid>` Redis key silently becomes a full-value (unmargined) funds
requirement** — this can look exactly like "funds shortfall" support tickets for cash, but the
actual defect is an absent margin-percentage cache entry, not insufficient balance.

**Discriminator:** if the pre-check failure log shows `calculateMTFFunds`/`Error fetching margin
funding percentages from Redis`, it's the MTF path; if it shows a `rebalanceBasketFlag` /
`Funds Check For Minimum Required Funds` retry, it's cash-only and doesn't apply to MTF at all.

---

## 5b. SBI-MTF margin or funds shortfall

**Look for:**

1. Place-order response `shortfallDetails.shortfallFlag` — `Q` (quantity) or `F` (funds) with
   `shortfallValue`.
2. The funds-check response — `sufficientFunds` derived from `responseCode == 0`.
3. `Error fetching margin funding percentages from Redis` — a Redis outage during margin lookup.
4. `Error computing marginReceivable` / `Error calculating margin receivable for mixed basket`.

**Interpret:**

- MTF funds required = `Σ (qty × price × margin%)`. Price comes from Redis `QTS:<sid>` field `kite`;
  margin % from Redis `MTF:<sid>`, **defaulting to 100% (no leverage) when missing**. A missing
  Redis entry is not an error — it just means "pay full amount", which can look like a margin
  shortfall that is not a broker rejection at all.
- On any exception in the margin calc the code falls back to the full unmargined amount (fail-safe,
  over-holds) and logs item 3.
- Mixed-basket sell credit can legitimately be `0` on a losing position:
  `receivable = max(qty × avgBuyPrice × marginPercent − loss, 0)`.
- `viewLimits` for MTF reads `availableLimitEqEmargin`, not the cash field
  `availableLimitCashAndCarry`.
- **Dealer MTF orders bypass funds-check entirely** — `check()` short-circuits to
  `{sufficientFunds: true, requiredFunds: 0}` when `dealerId` is present. (This is **not** an MTF
  divergence — cash does the same.) A shortfall on a dealer MTF order can therefore only come from
  the broker's own place-order response.
- MTF's `requiredFunds` is the **buffered** figure and is not numerically comparable to cash's.

**Next:** a `shortfallFlag` in the actual place-order response is a genuine broker rejection, not
retryable. If only the internal pre-check failed and item 3 is present nearby, treat it as a
possible false positive from a Redis lookup failure.

---

## 6. Dealer order failure

**Look for:**

- `Dealer session not found or expired, please re-authenticate` — the cached Redis token at
  `sbi:dealer_token:{entityId}:{userId}` (or `sbi-mtf:` prefix) came back empty. TTL is 28800s (8h)
  from the last successful dealer login.
- `orderId: "NA"` + `statusMessage: "order placed by dealer"` — **not** a token problem. See
  scenario 1.
- In platform-api: `DEALER_TERMINAL_REQUEST` / `DEALER_TERMINAL_ERROR` subtypes and error codes
  `SBIDT001`–`SBIDT005`. This is the **login** flow that populates the Redis token; a failure here
  means the token was never cached, which is distinct from an expired one.

**SBI-MTF specific:** the MTF dealer place-order path sends **no Authorization header at all** —
`placeDealerOrder` was dropped from `AUTH_REQUIRED_SERVICES` but is still called. Expect 401s with
no explanatory log beyond `Error in request`. Whether this path is exercised in production at all
is an open question.

**Next:** if login itself is failing, trace the `SBIDT00x` code. If it is the `orderId: "NA"`
pattern, the order never reached SBI despite appearing PLACED — check the `dealerOrderDownloadLogs`
collection; absence there confirms it.

---

## 7. Partial fill — find the problem leg

**Look for:** per-leg `orderQuantityDetails.orderQuantity` (requested) vs `tradedQuantity` (filled),
plus `orderLegDetails.orderStatus`.

**Interpret:**

- SBI has no order-level "partially filled" state — raw code `3` still maps to `PLACED`.
  `PARTIALLYFILLED` / `PARTIALLYPLACED` is a **batch-level rollup** computed from the set of leg
  statuses. Isolating the problem leg means comparing legs, not hunting a special code.
- **`Order.filled` is a count of fully-filled legs, not shares.** A partially filled leg contributes
  zero. Do not read it as a share total.
- A leg at `REJECTED` inside an otherwise-filled batch is the typical problem leg — check its
  rejection-reason call.
- A leg at `ERROR` (raw 5/7/8) is the other common pattern, with no further detail available.

**Pull the whole batch, not just the flagged leg.** In real batches checked, most legs were
correctly `COMPLETE` with real exchange order ids while only specific legs stayed `PLACED` with
zero fill for months. Which legs succeeded is itself diagnostic: *every* leg stuck suggests the
batch's polling broke; a *few* legs stuck suggests those legs individually never got a terminal
status from SBI.

---

## 8. Cancel investigation

**Look for:** `Error in cancelling order` on the failure path. On success the response is
**synthesised** — the literal `'CANCELLED AMO'` regardless of whether the order was AMO. Never
infer variety from that string.

**Known quirks:**

- **MTF `cancelOrder` sends `product: CASH (1)`, not MTF (6)** — byte-identical to the cash
  adapter's line, i.e. an un-updated copy from the fork. Check the request body's `product` before
  concluding a failed MTF cancel is broker-side. Whether SBI actually rejects it or ignores the
  field is unconfirmed.
- The invalid-orderId path returns a **bare string** `'Invalid orderId'`, not an `Error` object —
  calling `.message` on it gives `undefined`.

---

## 9. A stuck placement with no error line at all

**`placeOrder`, `getDealerDetails` and `placeDealerOrder` run with `timeout: 0`** — axios waits
forever. A hung placement produces **no timeout, no `ECONNABORTED`, no error line** — just silence
after the request.

So: a request logged with no corresponding response, and nothing after it, is itself the signal.
The 9000ms default applies only to order-status, viewLimits, fundsCheck, getUserProfile,
getRejectionReason, cancelOrder and securityHold.

---

## 10. Batch apply stuck — `PlacedOrders` never reaches COMPLETED

**Look for:** the platform-api chain `APPLY_BATCH_START` → `PLACEDORDER_STATUS_CHECK` →
`PLACEDORDER_STATUS_APPLIED` → `MARK_PLACEDORDER_COMPLETED_START`.

**The silent stall:** `markPlacedOrderCompleted` no-ops with **zero log output** when the user's
`investedSmallcases[].status` is still `'PLACED'`. `PlacedOrders` sits at `APPLIED` forever with no
error trail on that endpoint. **Check `investedSmallcases[].status` for the iscid directly.**

**Full SCBAT catalogue** (`sc-platform-api/lib/exceptions/batch.js:1-58` — note SCBAT0006 does not
exist, it is not merely unused here):

| Code | Class | Thrown when | Where |
|---|---|---|---|
| `SCBAT0001` | BatchNotFound | `Order`/batch lookup by id came back empty | `chatClient.js` (support tooling), `internalService.js:530` |
| `SCBAT0002` | PlacedOrderNotFound | No `PlacedOrders` doc for the id | `userSmallcase.js:10018,10067,10351,10519` (incl. `markPlacedOrderCompleted`) |
| `SCBAT0003` | InconsistentOrderState | Status gate failed — e.g. `markPlacedOrderCompleted` requires `PlacedOrders.status === 'APPLIED'` (`userSmallcase.js:10521-10522`); `smallboard.service.js:1655` throws it with a synthetic id `'RDOIOS_0001'` for its own distinct gate | `userSmallcase.js:2168,10102,10385,10522`, `smallboard.service.js:1655` |
| `SCBAT0004` | FailedToArchive | Archiving a batch for a new placement failed | `userSmallcase.js:10193` |
| `SCBAT0005` | IscidInPlacedStatus | An AutoSIP ingestion order arrived while the iscid already has a batch `PLACED` and no rebalance basket is scheduled for it | `internalService.js:316` |
| `SCBAT0007` | RetryOrderExecution | Generic "retry or contact support" — rebalance-basket delete/execution paths fall back to this on any unexpected error | `basket.service.js:520-540`, `basket.controller.js:89` |

`SCBAT0002`/`SCBAT0003` are the two you will actually see on a stuck-apply investigation (scenario
10's silent stall is `SCBAT0003`'s sibling — the *no-throw* branch of the same gate). The rest are
support/basket-management paths, useful mainly to rule an apply-gate failure in or out quickly by
grepping the code verbatim.

Use **exact-match** greps — the normal and recovery paths differ by a single trailing space
(`"PlacedOrders state ACKED "` vs `"PlacedOrders state ACKED"`).

A batch stuck here with no broker-lib trail at all usually means the failure never reached SBI.

**Recovery-path bug:** on the getstatus-recovery path, `handlePlacedOrders` reads
`resp.data.success.batchId` but the payload is `{success: {batch}}` — so `batchId` is `undefined`.
`PlacedOrders` keeps status `ACKED` with no batchId, and platform-api returns `batchId: undefined`
to the client.

**Also:** the recovery path never calls `user.handleActions(...)`, so a recovered batch leaves the
user's pending action visible — which looks to support like an invitation to place a duplicate.

---

## 11. "ORDER UPDATES DOWN" in the logs

**Does not mean order-updates was unavailable.** That branch is reached for *any* failed placement
where the getstatus retry also failed to return a batch — including a perfectly healthy OU
returning HTTP 400 for a validation error (bad sid, bad quantity, unsupported broker, missing
access token). Axios rejects on every non-2xx and `sendBBRequest` converts every rejection into
`{networkError}`.

**Always read the preceding `PLACE_ORDER_OU_HTTPCLIENT` / `ERROR` line for the real status code.**

---

## 12. Order not in Mongo at all

Not proof it never existed. Two smallboard endpoints permanently delete the Order document. Check
`placedOrders` for status `REVERSED`, and grep order-updates for `Delete Batch Request receivied`
(the typo is in the source) and `Deleted Batch`.

---

## 13. Was a fix actually applied?

**HTTP 200 from `/errors/fix/:batchId` does not mean fixed.** 200 covers both
`msg: 'Error Batch fixed'` (a real write) and `msg: 'Error Batch already fixed'` (the guard bailed
and nothing was written — which happens whenever the batch is not simultaneously `errorStatus: true`
AND `status === 'ERROR'`, and `force` was not passed). **Read the `msg` field.**

`sbiUnplacedRecon.js` is the one SBI recon job that does **not** pass `force: true`.

For the full attribution procedure, see `05-provenance.md`.

---

## 14. An "insufficient funds" line in an AutoSIP or activation job

**Does not mean the order was blocked.** In `createSbiAutosipOrders.holdFunds` the
insufficient-funds branch only calls `logger.error` and falls through — pre-placement and placement
run regardless. `placeActivatedOrders.placeOrder` logs the equivalent at **info** and likewise
continues. A funds warning in these jobs is not a placement blocker; the broker rejects downstream
or does not.

---

## Jobs that do NOT cover SBI

Do not chase these for an SBI order:

- `markBatchesAsUnfilled.js` (`markDealerBatchesAsUnfilledEOD`) — hardcoded to
  `['axis','hdfc','hdfc-mtf']`.
- `jobs/activations/*` in its Axis form — the original pipeline is Axis-only. (SBI does have its own
  `activations/sbi/` and `activations/sbiV2/` — those *are* SBI.)
- `sbiDealerRecon.js` and `sbiUnplacedRecon.js` query `broker: 'sbi'` **only** — SBI-MTF batches are
  never touched. Only `sbiReconAllOrders` uses `{$in: ['sbi','sbi-mtf']}`.

## When the schedule matters

**No cron definitions exist in `sc-integrations-jobs` for any SBI job.** Every schedule lives in an
external scheduler service's Bull/Redis config. You cannot read the cron expression from any
checked-out repo.

Derive schedules **empirically** from the epoch-ms suffix in `sc-prod-logs` object keys and from S3
`LastModified` — and say that is what you did. Do not quote invented times.

The same limitation applies to **which flags a scheduled run passes** (`--save`,
`--createMissingBatches`, …). The only way to know is the first line of an actual run's log:
`running job <name> with params: {...}`, which prints the parsed yargs object verbatim. Until you
have checked that, treat every recon fix as **unproven**.
