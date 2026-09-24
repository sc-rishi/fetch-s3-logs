# Status Codes, Enums and Error Classification

All codes are broker-response-level (SBI wire format) unless marked smallcase-internal.
SBI and SBI-MTF share almost all of this; divergences are called out explicitly.

## The two status enums — get these right or you get zero rows

Two distinct enums on two distinct fields. Both spellings are correct on their own field and
wrong on the other. This was an unresolved open question in the old guide; it is now settled.

```
Order.status          the batch      terminal success = COMPLETED     (with a D)
orders[].status       a single leg   terminal success = COMPLETE      (no D)
unplaced[].status     a single leg   same enum as orders[]
```

`sc-integrations-babel/src/constants/order.js:19-32` (batch) and `:58-67` (leg),
bound at `src/models/_schema.js:118` and `:36`.

**Batch — `Order.status`, 11 values, exhaustive:**

```
ACKED  PLACED  ERROR  UNPLACED  PARTIALLYPLACED  UNFILLED
PARTIALLYFILLED  COMPLETED  FIXED  MARKEDCOMPLETE  CANCELLED
```

**Leg — `orders[].status`, 8 values, exhaustive:**

```
ACKED  PLACED  REJECTED  CANCELLED  COMPLETE  ERROR  "CANCELLED AMO"  PARTIAL
```

Caveat: `ACKED` is absent from `sc-babel`'s and `sc-platform-babel`'s batch enums, so only
`sc-integrations-babel` can legally save a batch in `ACKED`.

Correct queries:

```
{status: 'COMPLETED'}            batches
{'orders.status': 'COMPLETE'}    legs
```

## Raw SBI `orderStatus` → smallcase status

Identical table for both adapters. `sbi/constants.js:99-130`, `sbi-mtf/constants.js:100-131`,
applied in `_mapBrokerOrderResponseToSC`.

| Raw | Broker name | → smallcase | Meaning |
|---|---|---|---|
| 1 | PENDING | `PLACED` | live at exchange, awaiting fill |
| 2 | MODIFIED | `PLACED` | live, modified in flight |
| 3 | PARTIALLY_TRADED | `PLACED` | partial fill; `filledQuantity` = `tradedQuantity` |
| 4 | TRADED | **`COMPLETE`** | terminal, filled. `averagePrice = totalTradedValue / tradedQuantity` |
| 5 | TRANSIT | **unmapped → `ERROR`** | indeterminate, no detail retained |
| 6 | CANCELLED | `CANCELLED` | terminal |
| 7 | EXPIRED | **unmapped → `ERROR`** | indeterminate |
| 8 | FREEZED | **unmapped → `ERROR`** | indeterminate |
| 9 | REJECTED | `REJECTED` | triggers a `getOrderRejectionReason` round trip |
| 10 | QUEUED | `PLACED` | pending |
| 11 | SENT_TO_EXCHANGE | `PLACED` | acknowledged, not yet filled |
| 12 | GTDT_BLOCKED | `REJECTED` | same rejection-reason enrichment as 9 |
| 99 | ALL | — | query wildcard, never a real status |

**Codes 5 / 7 / 8 are explicitly unconfirmed by the original authors** — the source carries the
verbatim comment `// todo: confirm the commented out statuses`. All three collapse into a generic
`ERROR` and **the raw code is discarded**, so there is no way to recover which one it was from
downstream logs. When a batch is "stuck in ERROR with no clear reason", this is the most common
explanation, and there genuinely is no more detail available.

### "Order status 4 or 11"

- `4` = TRADED → `COMPLETE`. Settled and filled.
- `11` = SENT_TO_EXCHANGE → `PLACED`. Acknowledged, pending — **not** an error or a stuck state.

Neither maps to ERROR. Cross-validated against real production data: every `orderStatus: 4` entry
had `tradedQuantity === orderQuantityDay`, every `orderStatus: 11` had `tradedQuantity: 0`.

## Place-order `shortfallFlag`

`_mapPlaceOrderResponse`, `sbi/services/order.js:54-91`, identical logic in MTF at `:69-106`,
keyed on `response.result.shortfallDetails.shortfallFlag`.

| Flag | Meaning | Result |
|---|---|---|
| `N` | no shortfall | `status: PLACED`, `orderId: result.internalOrderNumber` — success |
| `Q` | quantity shortfall | `statusMessage: "Quantity shortfall: <value>"`, **no** `status: PLACED` → fails → classified `checkHoldings` |
| `F` | funds shortfall | `statusMessage: "Funds shortfall: <value>"` → fails → classified `marginExceeded` |
| no `response.result` | generic API error | `statusMessage = messageList[0].messageDescription \|\| 'Unknown API error'` |
| anything else | unhandled | `Error('order placement failed')`, flag value **not** included in the mapped message |

**Recovering an unrecognised flag:** the old guide called this a dead end. It is not. The raw
un-redacted SBI response body is logged unconditionally on every successful call:

```
grep for  msg == 'sending success response'   near the order's X-REQ-UID
then read  details.responseBody.result.shortfallDetails.shortfallFlag
```

`broker-lib/src/brokers/sbi/services/request.js:160-163`

## `statusMessage` → `errorCode` classification

`config.getErrorCode()`. SBI cash has **6** keys, SBI-MTF has **10**
(`sbi/config.js:176-183`, `sbi-mtf/config.js:158-169`).

| errorCode | Meaning | Retryable? |
|---|---|---|
| `checkHoldings` | not enough shares held / available for hold or square-off | No — user must release or hold stock in the SBI app |
| `marginExceeded` | insufficient funds or margin | No — funds must be added; an identical retry fails identically |
| `userNotLoggedIn` | session taken over by another device or operator | No — needs re-login |
| `clientNotEnabled` | client deactivated or suspended by SBI at the exchange | No — broker-side account gate, escalate |
| `tradingSystemNotReady` | IOC in pre-open, closing price unavailable, market shut, emargin unavailable | **Yes** — transient, retry once the window opens |
| `securityNotAllowed` | scrip-level restriction (suspended, square-off required, E-Margin blocked) | Usually no — same-day retry likely fails again |
| `amoNotAllowed` *(MTF only)* | outside the AMO window | **Yes** — retry inside the window |
| `networkError` *(MTF only)* | `"Exchange connection is down, please try later"` | **Yes** — transient |
| `invalidOrder` / `unknownError` / `otherError` | generic or unmatched text | Unknown — inspect the raw response body |

**There is no automated retry for placement failures anywhere in the flow.** The only built-in
retry is the order-*status* settlement-type retry below.

## Numeric message codes

| Code | Meaning | Scope |
|---|---|---|
| `600014` | "no data found" for the given `accountSettlementType` on an order-status query → retries across settlement types `[0,2,3]` for NRI-eligible accounts | **SBI cash only** — `sbi/services/order.js:365-378`. No equivalent loop exists in MTF |
| `709152` (`ERR_POSITIVE_AMT`) | zero/positive-amount validation on funds-check | **both** adapters special-case it as **success**: `{code:true, sufficientFunds:true}`. Not an error |

## Telling SBI cash from SBI-MTF

| Signal | SBI cash | SBI-MTF |
|---|---|---|
| tag prefix | `sc_` | `scmtf_` |
| wire `product` | `1` (CASH) | `6` (MTF) |
| **stored** product in Mongo | `CNC` | **`EMARGIN`** — there is no `MTF` value in the babel enum |
| Redis dealer-token prefix | `sbi:dealer_token` | `sbi-mtf:dealer_token` |
| `emarginDate` field | absent | present (may be `undefined`) |
| leprechaun variant | `sbi-leprechaun` | `sbi-mtf-leprechaun` |
| `broker` log field | `sbi` | **`sbi` — identical, useless as a discriminator** |

## Confirmed SBI-MTF divergences

Beyond the guide's list, all source-verified. An assumption of parity here sends you down the
wrong path.

- **`statusMessageMap`**: MTF has 10 keys, cash has 6. The extra four are `amoNotAllowed`,
  `unknownError`, `invalidOrder`, `networkError`.
- **`securitiesHoldRequired`**: `true` on cash, `false` on MTF. An SBI cash SELL fires a
  `POST /dp-service/hold-release/dp` before the order; an MTF SELL does not. A missing DP-hold
  line on an MTF order is expected, not a defect.
- **`allowedSellValues` is inverted**: cash `{T0:0, T1:1}`, MTF `{T0:1, T1:0}`. A regular MTF
  basket credits 100% of sell proceeds against the buy requirement; cash credits 0%.
- **`cancelOrder` sends `product: CASH (1)` on MTF**, not MTF (6) — `sbi-mtf/services/order.js:507`
  is byte-identical to the cash adapter's `:513`, i.e. an un-updated copy from the fork. Place and
  dealer-place both correctly send 6, so cancel is the sole outlier.
- **MTF dealer place-order sends no Authorization header at all.** `request.js` dropped
  `placeDealerOrder` from `AUTH_REQUIRED_SERVICES` but `order.js:178` still calls it, so line 119
  deletes Authorization with no replacement. Expect 401s with no explanatory log beyond
  `Error in request`.
- **MTF lacks six config keys** cash has: `twoStepRebalanceEnabled`, `rebalanceSipAllowed`,
  `bufferConfig`, `limitBatchConfig`, `dpCharges`, `addBufferAmount`,
  `nextDayBufferWithClosePrice`. Consequences: MTF ignores `orderMode` when picking buffers, has no
  `minRequiredFunds` retry, and an MTF LIMIT order gets `validity: undefined`.
- **MTF's funds-check response is shape-incompatible** with cash's. It returns only
  `{code, sufficientFunds, requiredFunds}`, and its `requiredFunds` is the **buffered** figure
  (the unbuffered computation is commented out at `fund.js:328`). Not numerically comparable to
  cash's `requiredFunds`.
- **`accountSettlementType: 0` is hardcoded only in `autosip.js`**, not adapter-wide. Every other
  MTF call sends the decoded `nriFlag`.
- **NRI flag parsing differs**: MTF uses `FLAG_NRO = '1'`, cash uses `'2'`. MTF has no
  `parseEBDResStatus`, so no dual-eligible handling and no per-order NRI override.
- **Dealer funds-check short-circuit is NOT an MTF divergence** — both adapters do it identically.
- **MTF-to-CNC conversion, pledge, margin-call and square-off logic does not exist** in either
  adapter. Settled as genuinely absent, not merely unfound. Square-off is performed by SBI and
  surfaces only as rejection text classified `checkHoldings` or `securityNotAllowed`.

## Other quirks worth knowing

- **Order-status queries carry no product filter.** `order.js:342` sets
  `product: constants.products.ALL`, but `products` has no `ALL` key — the value is `undefined` and
  `JSON.stringify` drops it. Every SBI cash order-status request goes out unfiltered.
- **Dealer AMO orders use IOC validity, not DAY.** `_getDealerBrokerOrderObject` hardcodes
  `orderValidity: IOC` while still setting `orderSlot: OFF_MARKET`. Only the retail path forces DAY.
- **Cancel success is synthesised**, always the literal `'CANCELLED AMO'` regardless of variety.
  Never infer "this was an AMO order" from that string.
- **`orderTimestamp: null` is not evidence of a hang** — `parseSBITimestamp` returns `null`
  silently on any malformed SBI timestamp.
