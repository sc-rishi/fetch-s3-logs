# broker-lib-mtf

broker-lib SBI-MTF adapter. A near-clone of the cash adapter with dangerous small divergences.

**branch when read:** development (NOT rebalance-in-amo as the task stated, and NOT production — see corrections; sbi-mtf/ does not exist on the production branch at all)

sbi-mtf/ is a fork-copy of sbi/ carrying the MTF (Margin Trading Facility, product code 6) order path for SBI Securities. Only 4 of 16 service files are byte-identical to sbi/ (misc, comms, encrypt, decrypt); everything else diverges, and one file (portfolio.js, margin-receivable FIFO) is MTF-only. The two most investigator-relevant divergences are invisible in logs: the adapter's `config.brokerName` is the literal string `'sbi'`, so every log line it emits carries `broker: "sbi"` exactly like the cash adapter — the ONLY reliable discriminator in a raw payload is the tag prefix `scmtf_` vs `sc_`; and the MTF funds-check reads a per-stock margin percentage from Redis `MTF:{sid}` field `sbi-mtf.nse`, where a cache miss silently defaults to 100% (full price, no leverage) rather than erroring, which presents to a user as "MTF order demanded full funds" with no error anywhere in the logs. MTF also drops several safety nets the cash adapter has: no 600014 cross-settlement-type retry on order-status (an MTF status lookup at the wrong settlement type is a dead end), no securities hold (`securitiesHoldRequired: false`), no `Sip.delete`, no `twoStepRebalanceEnabled`/`rebalanceSipAllowed`, and inverted `allowedSellValues`. Its `placeDealerOrder` path is broken: the dealer auth-header block was deleted from request.js but order.js still calls the service, so dealer MTF orders go out with no Authorization header at all. There is no MTF-to-CNC conversion, pledge, margin-call or square-off logic anywhere in the adapter or the wider repo.

Confidence markers are the researcher's own: unmarked = confirmed from source, `[INFERRED]` = deduced but unproven, `[UNCONFIRMED]` = a lead, not a fact. `!` marks facts flagged critical. Re-verify line numbers against the checked-out SHA.


## Facts (86)


### branch-and-deployment

- **!** sc-integrations-broker-lib working tree is on branch 'development' at commit dbe4206f, version 16.11.15, tree clean. The task brief's claim that this repo is on 'rebalance-in-amo' is wrong for this checkout.  
  `sc-integrations-broker-lib/package.json:version (git show development:package.json) + `git -C sc-integrations-broker-lib rev-parse --abbrev-ref HEAD` => development`
- **!** src/brokers/sbi-mtf/ DOES NOT EXIST on the 'production' branch of broker-lib (`git ls-tree -d production -- src/brokers/sbi-mtf/` returns empty) and 'sbi-mtf' is NOT registered in src/index.js on production. The production branch is version 15.22.0. Reading the 'production' branch to answer an SBI-MTF question will return nothing and is a trap.  
  `sc-integrations-broker-lib/src/index.js:87-94 (development only); `git ls-tree -d production -- src/brokers/sbi-mtf/` empty; `git show production:package.json` version 15.22.0`
- **!** Production consumers pin broker-lib ^16.11.15 (order-updates), ^16.11.14 (platform-api, jobs), ^16.11.9 (leprechaun) — all 16.x, matching the 'development' branch version 16.11.15, not the 'production' branch version 15.22.0. So the code under sbi-mtf/ on 'development' is what production services actually install; the broker-lib 'production' branch is stale and is not the shipping branch. `[INFERRED]`  
  `sc-integrations-order-updates/package.json:24; sc-platform-api/package.json:33; sc-integrations-jobs/package.json:18; sc-integrations-leprechaun/package.json:32`
- **!** `git diff rebalance-in-amo..development -- src/brokers/sbi-mtf/` is EMPTY — the sbi-mtf adapter is byte-identical on both branches. The task's branch warning has no effect on any fact in this report.  
  ``git -C sc-integrations-broker-lib diff --stat rebalance-in-amo..development -- src/brokers/sbi-mtf/` => no output`

### broker-identity

- **!** sbi-mtf's config sets `const brokerName = isLeprechaun ? 'sbi-mtf-leprechaun' : 'sbi';` — in production the MTF adapter's brokerName is the literal string 'sbi', identical to the cash adapter's.  
  `src/brokers/sbi-mtf/config.js:19 (cf. src/brokers/sbi/config.js:17)`
- **!** The shared logger is constructed as `require('../../lib/log')(config.brokerName, config)` and stamps every line with `broker: <that name>`. Because sbi-mtf's brokerName is 'sbi', every SBI-MTF log line carries `"broker":"sbi"`. You CANNOT filter SBI-MTF traffic by the log's broker field.  
  `src/lib/log.js:2,49-55 (logInfo sets `logger.info({ broker, msg, details })`); src/brokers/sbi-mtf/api.js:5-8`
- **!** The registry key IS 'sbi-mtf' (src/index.js) even though the resolved config.brokerName is 'sbi'. So `getBrokerConfig('sbi-mtf')` returns a config whose `.brokerName === 'sbi'`. Mongo `Order.broker` and job broker lists use 'sbi-mtf'; logs use 'sbi'.  
  `src/brokers/sbi-mtf/config.js:19 vs src/index.js:87-94; consumers e.g. sc-integrations-jobs/jobs/reconciliations/sbiReconAllOrders.js:1160 `broker: { $in: ['sbi','sbi-mtf'] }``

### tag-generation

- **!** SBI-MTF tags are `scmtf_` + 9 chars from the alphabet '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' (nanoid/generate), total length 15. SBI cash is `sc_` + the same 9-char nanoid, total length 12. Verified by executing config.generateTag(): e.g. 'scmtf_cyv6TSjfV'.  
  `src/brokers/sbi-mtf/config.js:115-119 (cf. src/brokers/sbi/config.js:109-112 `sc_${nanoId()}`)`
- **!** The tag is written into the broker request as BOTH `orderParameters.externalReferenceNumber` and `orderParameters.remarks`, and order-status matching finds the order by `orderStatusList.find(o => o.orderLegDetails.externalReferenceNumber === tag)`. `config.getOrderKey(order)` returns `order.tag`.  
  `src/brokers/sbi-mtf/services/order.js:239-240 (place), :158-159 (dealer place), :382 (status match); src/brokers/sbi-mtf/config.js:95-97`

### product-code

- **!** constants.products in sbi-mtf adds `MTF: 6` on top of the cash adapter's set. Full map: MARGIN 0, CASH 1, INTRADAY 2, COLLATERAL_SELL 3, SPOT 4, E_MARGIN 5, MTF 6. sbi/constants.js stops at E_MARGIN 5 — it has no MTF key at all.  
  `src/brokers/sbi-mtf/constants.js:91-99 (cf. src/brokers/sbi/constants.js:91-98)`
- **!** product is set to MTF(6) in exactly two places: `_getBrokerOrderObject` (normal place) and `_getDealerBrokerOrderObject` (dealer place).  
  `src/brokers/sbi-mtf/services/order.js:233 and :143`
- **!** CONFIRMED BUG: `cancelOrder` sets `orderLegDetails.product: constants.products.CASH` (=1), not MTF(6). This line is unchanged from the cash adapter (sbi/services/order.js:513), i.e. it was copied and never updated. Every other order-mutating MTF call sends 6. An MTF cancel therefore describes itself to SBI as a CASH-product order.  
  `src/brokers/sbi-mtf/services/order.js:507 (identical text at src/brokers/sbi/services/order.js:513)`

### emargin-date

- **!** `emarginDate` is an MTF-only field on the place-order payload: `orderParameters.orderLegDetails.emarginDate = formatDateToYYYYMMDD(orderOptions.emarginDate)`. It has no counterpart in the cash adapter's payload. Its presence in a captured request body is a positive identifier that the request came from the MTF adapter.  
  `src/brokers/sbi-mtf/services/order.js:237; formatter at src/brokers/sbi-mtf/services/util.js:79-99`
- formatDateToYYYYMMDD returns `undefined` (not null, not a string) for a falsy or unparseable input, so `emarginDate` is silently omitted from the JSON body when options.emarginDate is missing. This helper is MTF-only — it is absent from sbi/services/util.js.  
  `src/brokers/sbi-mtf/services/util.js:79-99 (`if (!inputDate) { return; }` and `if (isNaN(date.getTime())) { return; }`)`
- **!** The caller that populates emarginDate is sc-integrations-order-updates (branch: production). For AMO variety it is today's date if today is a working day, else previousActiveDay(1); for every non-AMO variety it is unconditionally previousActiveDay(1) — i.e. a regular MTF order is always tagged with the PREVIOUS trading day.  
  `sc-integrations-order-updates/lib/objects.js:255-269`

### margin-lookup-redis

- **!** MTF margin percentage is read from Redis hash key `MTF:{sid}`, field = `config.getMarginIdentifier(exchange)` = `sbi-mtf.${exchange.toLowerCase()}` (e.g. 'sbi-mtf.nse'). Verified by execution: getMarginIdentifier('NSE') === 'sbi-mtf.nse'.  
  `src/brokers/sbi-mtf/config.js:104-106; read at src/brokers/sbi-mtf/services/fund.js:131-140`
- **!** ON A REDIS MISS THE MARGIN DEFAULTS TO 100, meaning factor 1.0 — the user is asked for the FULL buy value with no leverage. `Number(marginFundingPercentages[index]) || 100`. This is not logged and is not an error. 'MTF order asked me for full funds' with a clean log is almost always a missing `MTF:{sid}` field.  
  `src/brokers/sbi-mtf/services/fund.js:147-148`
- **!** The job that populates `MTF:{sid}` is sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js (branch: production). It ingests SBI MTF margin CSVs from S3 (bucket and base path from jobConfig.sbi.s3Bucket / .symbolsRemoteFilePath) and writes fields 'sbi-mtf.nse' and 'sbi-mtf.bse'. If no CSV is found for today it logs a warning and CONTINUES, leaving yesterday's values (or nothing) in place.  
  `sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js:119-186, :781-783, :354`
- The same job has a cleanup step that HDELs 'sbi-mtf.nse' and 'sbi-mtf.bse' from MTF:* keys, but only runs when new SBI MTF data was actually parsed (guarded by hasSbiMtfUpdates). A partial ingest followed by cleanup is a plausible mechanism for margins vanishing mid-day.  
  `sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js:563-604 (`batch.hdel(key, 'sbi-mtf.nse', 'sbi-mtf.bse')` at :604), guard at :345-356`
- **!** Prices missing from the order are backfilled from Redis hash `QTS:{sid}` field `kite`, whose value is a JSON string like '{"price":267.35,"close":263.28,...}'. An unparseable value falls back to `Number(raw) || 0`, and a price of 0 makes that stock contribute 0 to the required funds.  
  `src/brokers/sbi-mtf/services/fund.js:72-88 (getPriceFromRedisQuote), :105-120`
- **!** MTF funds formula: buyAmount = Σ (quantity × price × marginFundingPercent/100) over BUY orders only. sellAmount = Σ (quantity × price) over SELL orders. This entire path is skipped unless BOTH `options.orders` (non-empty) AND `options.redis` are passed in — otherwise buyAmount/sellAmount fall back to the raw `options.buyAmount`/`options.sellAmount` numbers.  
  `src/brokers/sbi-mtf/services/fund.js:143-150, :316-320`
- **!** If calculateMTFFunds throws anywhere (Redis down, batch failure), it catches, logs 'Error fetching margin funding percentages from Redis', and returns the FULL un-margined buy amount via calculateFullBuyAmount. Failure mode is again 'user pays full price', not a hard error.  
  `src/brokers/sbi-mtf/services/fund.js:152-158`
- platform-api's getMtfData HARDCODES the field name `cachedData['sbi-mtf.nse']` when reading MTF:{sid}, defaulting to 100. calculateUnrealizedMarginInvestment is the generic version (strips a '-leprechaun' suffix then tries `{broker}.nse` then `{broker}.bse`, defaulting to factor 1).  
  `sc-platform-api/app/services/userSmallcase/userSmallcase.js:11700-11712 (hardcode) and :11657-11693 (generic)`
- order-updates' getMarginFromRedis also defaults a missing margin to 100 and returns value/100, i.e. factor 1.0. Same fail-to-full-price semantics as broker-lib.  
  `sc-integrations-order-updates/lib/utils.js:481-494`

### funds-check-mtf

- **!** MTF reads `totalAvailableLimitDetails.availableLimitEqEmargin` from the viewLimits response. The cash adapter reads `availableLimitCashAndCarry` from the same object. brokerObligations = max(totalAvailableLimit - availableLimitEqEmargin, 0).  
  `src/brokers/sbi-mtf/services/fund.js:166-171, :345-346 (cf. src/brokers/sbi/services/fund.js reading availableLimitCashAndCarry)`
- **!** MTF's fundsToHold formula is a single inline expression: `Math.max(buyAmount*fundsBuffer.buy + sellAmount*fundsBuffer.sell*allowedSellValue + (options.addBufferAmount ? 118 : 0), 0)`. The 118 is a MAGIC NUMBER inlined here; the cash adapter has it as a named config field `addBufferAmount: 118`, which sbi-mtf/config.js does not define at all.  
  `src/brokers/sbi-mtf/services/fund.js:331 vs src/brokers/sbi/config.js:164`
- **!** MTF's `fundsRequired` returned to callers is actually fundsToHold (the buffered figure) — the true unbuffered requirement is commented out and never computed. So `requiredFunds` in an MTF funds-check response is NOT comparable to the cash adapter's `requiredFunds`, which comes from the shared calculateFundsValues helper.  
  `src/brokers/sbi-mtf/services/fund.js:328 (commented-out `const fundsRequired = ...`), :190,:194,:201 (all return fundsToHold as requiredFunds)`
- **!** MTF's funds-check response object contains ONLY {code, sufficientFunds, requiredFunds} (+ `error` on a viewLimits failure). It never returns allowedSellValues, buyValue, sellValue, minRequiredFunds or bufferAdded — all of which the cash adapter returns. A caller expecting those fields gets undefined.  
  `src/brokers/sbi-mtf/services/fund.js:182-205, :14-27 vs src/brokers/sbi/services/fund.js (returns allowedSellValues/buyValue/sellValue/bufferAdded throughout)`
- **!** MTF has NO rebalanceBasketFlag / minRequiredFunds retry. The cash adapter, on a funds-check failure with options.rebalanceBasketFlag set, recomputes a minimum requirement (using dpCharges*1.18 and nextDayBufferWithClosePrice) and calls fundsCheck a SECOND time. MTF calls fundsCheck exactly once, ever.  
  `src/brokers/sbi-mtf/services/fund.js:349-362 (single call) vs src/brokers/sbi/services/fund.js (second fundsCheck under `if (options.rebalanceBasketFlag && ...)`), and src/brokers/sbi/config.js:163-165 (dpCharges/addBufferAmount/nextDayBufferWithClosePrice, all absent from sbi-mtf/config.js)`
- messageCode 709152 (ERR_POSITIVE_AMT) on a fundsCheck response is special-cased as SUCCESS in both adapters: SBI errors on a zero-rupee hold, and both treat it as {code:true, sufficientFunds:true}.  
  `src/brokers/sbi-mtf/services/fund.js:8, :184-191 (cf. src/brokers/sbi/services/fund.js:7)`
- sufficientFunds is decided by `response.responseCode == 0` using loose equality, so the string '0' also passes.  
  `src/brokers/sbi-mtf/services/fund.js:200`
- **!** allowedSellValues is INVERTED between the adapters. SBI cash: {T0:0, T1:1}. SBI-MTF: {T0:1, T1:0}. MTF's check() uses `options.variety === 'regular' ? config.allowedSellValues.T0 : 1`, so a regular MTF basket credits 100% of sell proceeds against the buy requirement, whereas regular SBI cash credits 0%.  
  `src/brokers/sbi-mtf/config.js:144-147 and src/brokers/sbi-mtf/services/fund.js:294 vs src/brokers/sbi/config.js:158-161`
- **!** MTF's buffers live in flat `regularBuffer` / `amoBuffer` config keys ({buy:1.030348, sell:-0.97, minBrokerage:5} and {buy:1.05, sell:0.03, minBrokerage:5}) selected by `options.variety === AMO ? config.amoBuffer : config.regularBuffer`. The cash adapter additionally has a nested `bufferConfig` keyed by orderMode (limit/market) then variety, plus `limitBatchConfig` — both entirely absent from sbi-mtf/config.js, so MTF ignores orderMode when choosing buffers.  
  `src/brokers/sbi-mtf/config.js:129-142 and services/fund.js:293 vs src/brokers/sbi/config.js:123-140`
- **!** Both adapters short-circuit the funds check for dealers, returning {code:true, sufficientFunds:true, requiredFunds:0} without calling the broker. This is NOT an MTF-specific divergence — the cash adapter does the same (it just also echoes allowedSellValues).  
  `src/brokers/sbi-mtf/services/fund.js:287-291 and src/brokers/sbi/services/fund.js:57-66`

### margin-receivable

- **!** portfolio.js is MTF-ONLY — sbi/services/ has no such file. It exposes calculateMarginReceivable, surfaced on the public API as `Portfolio.fetchMarginReceivable`. The cash adapter's api.js has no Portfolio namespace.  
  `src/brokers/sbi-mtf/services/portfolio.js:224-226; src/brokers/sbi-mtf/api.js:280-311, :318-326; src/brokers/sbi-mtf/services/index.js:8,19`
- **!** calculateMarginReceivable calls the MTF-only endpoint `POST {api_endpoint}/position-service/emargin-details` (service name 'getEmarginDetails'), filters the returned emarginPositionList to exchangeId === 'NSE' only, then applies FIFO over positions. BSE positions are silently dropped.  
  `src/brokers/sbi-mtf/config.js:47 (endpoint), services/portfolio.js:169-178, :38-46 (_filterNSEPositions)`
- Per-position receivable: if currentPrice >= avgBuyPrice, receivable = qty × avgBuyPrice × marginPct; else receivable = max(qty × avgBuyPrice × marginPct − (avgBuyPrice − currentPrice) × qty, 0). Position fields consumed are `netQuantity` and `averageTradedPrice`.  
  `src/brokers/sbi-mtf/services/portfolio.js:19-31, :90-91`
- The emargin-details payload sends `tradingAccountDetails.clientType = nriFlag === 0 ? 1 : nriFlag` — note a resident (nriFlag 0) is sent as clientType 1, NOT 0. tradingAccountNumber is coerced with Number().  
  `src/brokers/sbi-mtf/services/portfolio.js:56-73 (line 69)`
- **!** calculateMarginReceivable swallows every failure path and returns {marginReceivable: 0}: invalid inputs, requestBroker error, or an empty emarginPositionList all produce 0 with no warn-level log (only the catch-all throw path logs). A sell leg silently contributing 0 receivable is indistinguishable from a genuinely zero position.  
  `src/brokers/sbi-mtf/services/portfolio.js:154-160, :180-186, :190-196, :211-221`
- **!** marginReceivable is only computed for MIXED baskets — `hasBuy && hasSell && options.redis` — and when it runs it OVERWRITES sellAmount entirely (`sellAmount = marginReceivable`). A pure-sell MTF basket never calls this path and keeps the raw qty×price sellAmount.  
  `src/brokers/sbi-mtf/services/fund.js:295-296, :306-315 (line 314)`
- The mixed-basket path issues one emargin-details HTTP call PER SELL ORDER, deliberately sequential (`// This is intentionally sequential to avoid spiking downstream calls`, eslint-disable no-await-in-loop). A large mixed MTF basket will be slow at funds-check; brokerApiRequestTimeout is 9000ms per call.  
  `src/brokers/sbi-mtf/services/fund.js:250-253; src/brokers/sbi-mtf/config.js:154`
- The mixed-basket path resolves each sell order's brokersymbol from Redis `SID:{sid}` field `config.getSecurityIdentifier(exchange)`. getSecurityIdentifier is `sbi.${exchange}` and does NOT lowercase, but the caller lowercases the exchange first, yielding 'sbi.nse' — which matches what putBrokerSymbolsInRedis writes. Verified: getSecurityIdentifier('nse') === 'sbi.nse'. Note MTF uses the CASH broker's SID field, not an MTF-specific one.  
  `src/brokers/sbi-mtf/services/fund.js:231-236; src/brokers/sbi-mtf/config.js:101-103; write side sc-integrations-jobs/jobs/putBrokerSymbolsInRedis.js:707,713 (`tickerMap[...].data['sbi.nse']`)`
- A sell order only contributes receivable when brokersymbol AND quantity>0 AND currentPrice>0 AND marginPct>0 all hold. A margin of 0 in `MTF:{sid}` (as opposed to a missing field) yields zero receivable here — the opposite direction from the buy-side default of 100.  
  `src/brokers/sbi-mtf/services/fund.js:243-247`

### order-status-polling

- **!** CONFIRMED MISSING: sbi-mtf has NO 600014 cross-settlement-type retry. The cash adapter, on messageList[0].messageCode === 600014 ('no data found'), re-issues the order-status request across accountSettlementType [0,2,3]. The MTF adapter issues exactly one request at the token's nriFlag and returns. An MTF status lookup at the wrong settlement type is a dead end that returns 'not found'.  
  `src/brokers/sbi/services/order.js:363-378 (the `for (const accountSettlementType of [0, 2, 3])` loop) — no equivalent anywhere in src/brokers/sbi-mtf/services/order.js (grep for 600014 returns zero hits in that file); MTF single call at :360-370`
- MTF is polling-only: `orderStatusBy: {postback: false, polling: true}`, plus `orderIdNotSufficientForPolling: true` and `sessionlessPollingAvailable: () => true`. There is no postback/webhook code path.  
  `src/brokers/sbi-mtf/config.js:63-66, :75, :81`
- orderStatusesReverse is IDENTICAL in both adapters: 1/2/3→PLACED, 4→COMPLETE, 6→CANCELLED, 9→REJECTED, 10/11→PLACED, 12→REJECTED. Codes 5 (TRANSIT), 7 (EXPIRED), 8 (FREEZED) are commented out in both, under a verbatim `// todo: confirm the commented out statuses`. An order in state 5/7/8 maps to undefined in both.  
  `src/brokers/sbi-mtf/constants.js:116-131 (byte-identical to src/brokers/sbi/constants.js:116-131 apart from line offset)`

### missing-features

- **!** CONFIRMED MISSING: `twoStepRebalanceEnabled: true` AND `rebalanceSipAllowed: true` are both present in sbi/config.js and entirely absent from sbi-mtf/config.js. The guide names only twoStepRebalanceEnabled; rebalanceSipAllowed is the second, unmentioned casualty.  
  `src/brokers/sbi/config.js:79-80; absent from src/brokers/sbi-mtf/config.js (verified by full-file diff)`
- **!** CONFIRMED MISSING: `Sip.delete` exists on the cash adapter as a no-op that logs 'Successful request' and calls back with success; sbi-mtf's `sip()` factory exposes only `placeOrder`. Calling Sip.delete on SBI-MTF is a TypeError (undefined is not a function), not a silent no-op.  
  `src/brokers/sbi/api.js:257-261 vs src/brokers/sbi-mtf/api.js:241-258`
- **!** `securitiesHoldRequired: false` on MTF vs `true` on SBI cash. order-updates gates the securities-hold step on this flag, so SBI-MTF sell orders NEVER go through the DP hold/release call in the normal flow — even though sbi-mtf/services/security.js still contains a working holdSecurities implementation. The guide does not mention this divergence at all.  
  `src/brokers/sbi-mtf/config.js:60 vs src/brokers/sbi/config.js:56; consumer sc-integrations-order-updates/services/orders.js:2664 (`!getBrokerConfig(broker).securitiesHoldRequired ||`)`
- **!** `mtfBroker: true` is MTF-only. order-updates uses it to force the stored product to EMARGIN (determineProduct returns orderConsts.product.EMARGIN instead of 'CNC'), to choose an MTF-specific batch-apply endpoint in platform.js, and to gate the Redis margin fetch in orders.js. So a stored Order with product EMARGIN is another MTF discriminator.  
  `src/brokers/sbi-mtf/config.js:94; consumers sc-integrations-order-updates/lib/objects.js:64-73, services/platform.js:110-112, services/orders.js:2551,:2774-2776`
- **!** MTF's place() AutoSIP trigger is `options.label == 'AUTOSIP' || options.activated` — it drops the `|| options.autoSip` disjunct the cash adapter has. An order flagged only with autoSip (not label/activated) takes the NORMAL place path on MTF and the AUTOSIP path on SBI cash.  
  `src/brokers/sbi-mtf/services/order.js:283 vs src/brokers/sbi/services/order.js:273`

### nri-settlement

- **!** PARTIAL CORRECTION to 'sbi-mtf hardcodes accountSettlementType 0': it is hardcoded to 0 ONLY in autosip.js. place (:198), dealer place (:121), order-status (:358), cancel (:521), fundsCheck (:352) and securityHold all send the decoded `nriFlag` from the access token. The cash adapter's autosip.js uses `nriFlag || 0`.  
  `src/brokers/sbi-mtf/services/autosip.js:6-8 (`accountSettlementType: 0`, and no decodeAccessToken import) vs src/brokers/sbi/services/autosip.js:5-8; nriFlag used at sbi-mtf/services/order.js:121,198,358,521, fund.js:352, security.js:29`
- **!** MTF's parseNRIFlag maps FLAG_NRE='3' and FLAG_NRO='1'. The cash adapter maps FLAG_NRE='3' and FLAG_NRO='2'. SBI's own settlement codes elsewhere in the cash adapter are NRE=3 / NRO=2, so MTF's '1' looks wrong — an NRO MTF user whose EBD_RES_STATUS is '2' gets NO nriFlag label at all (neither branch matches).  
  `src/brokers/sbi-mtf/services/user.js:18 vs src/brokers/sbi/services/user.js:39 and src/brokers/sbi/services/security.js:7 (`NRI_STRING_TO_CODE = { NRE: 3, NRO: 2 }`)`
- **!** MTF has NO dual-eligible (NRE_NRO) handling. The cash adapter parses EBD_RES_STATUS via parseEBDResStatus (strips wrapping brackets, splits on comma, keeps types 2/3, sets nriFlag='0' for dual-eligible, sets meta.nriNotSupported, sets nriFlag='NRE_NRO' when >=2 types). MTF passes the raw decrypted EBD_RES_STATUS straight into parseNRIFlag and encodeAccessToken.  
  `src/brokers/sbi/services/user.js:12-21 (parseEBDResStatus) — absent from src/brokers/sbi-mtf/services/user.js; MTF raw path at services/user.js:329-331, :362`
- **!** MTF also lacks the per-order NRI override. The cash adapter defines `NRI_STRING_TO_CODE = { NRE: 3, NRO: 2 }` in both order.js and security.js and resolves `options.nri` ('NRE'/'NRO') over the token's nriFlag. sbi-mtf has no such constant and ignores options.nri entirely — a dealer's per-order NRE/NRO selection has NO effect on an MTF order.  
  `src/brokers/sbi/services/order.js:9-10 and src/brokers/sbi/services/security.js:5-7 — both absent from the sbi-mtf equivalents (sbi-mtf/services/order.js:268-280, security.js:8-29)`
- Access-token wire format is shared: `${accessToken}|${userId}|${dealerId}|${nriFlag}|${dpAccountNumber}|${dpCode}`, pipe-delimited, with nriFlag defaulting to '0' when falsy on encode and coerced to Number 0 when NaN on decode.  
  `src/brokers/sbi-mtf/services/util.js:7-16 (encode), :30-60 (decode)`

### dealer-flow

- **!** CONFIRMED BUG, previously unreported: sbi-mtf/services/request.js REMOVED 'placeDealerOrder' from AUTH_REQUIRED_SERVICES and deleted the block that sets X-AUTHORIZATION/X-DEVICE-ID/X-GEO-LOCATION/X-LANGUAGE-ID/X-USER-AGENT for it — but order.js STILL calls `{ service: 'placeDealerOrder' }`. Result: line 119 deletes the Authorization header and nothing replaces it, so an SBI-MTF dealer place-order request goes out with NO authorization header of any kind.  
  `src/brokers/sbi-mtf/services/request.js:112 (AUTH_REQUIRED_SERVICES omits placeDealerOrder), :118-119 (`delete requestParams.headers.Authorization`); caller still live at src/brokers/sbi-mtf/services/order.js:178; cf. src/brokers/sbi/services/request.js:112,118-124`
- **!** Related: 'getDealerDetails' IS in MTF's AUTH_REQUIRED_SERVICES, but MTF lacks the cash adapter's block that deletes Authorization and X-SOURCE-ID and sets `X-AUTHORIZATION: Basic ${accessToken}`. So MTF sends `Authorization: Bearer <basic-credentials>` plus X-SOURCE-ID where SBI cash sends `X-AUTHORIZATION: Basic <creds>` with both stripped.  
  `src/brokers/sbi-mtf/services/request.js:112 vs src/brokers/sbi/services/request.js:126-134`
- MTF also loses the `requestParams.timeout = 0` (no timeout) for placeDealerOrder — its list is only ['placeOrder','getDealerDetails'], so dealer MTF orders are subject to the 9000ms brokerApiRequestTimeout.  
  `src/brokers/sbi-mtf/services/request.js:114 vs src/brokers/sbi/services/request.js:114; timeout value at src/brokers/sbi-mtf/config.js:154`
- MTF's real-broker dealer login calls `encodeAccessToken('', clientId, dealerId)` with NO nriFlag/dp arguments, so the encoded token carries nriFlag='0' and empty dp fields. The cash adapter passes a computed nriFlag derived from EBD_RES_STATUS.  
  `src/brokers/sbi-mtf/services/user.js:303 vs src/brokers/sbi/services/user.js (dealer branch passes nriFlag as 4th arg)`
- Dealer token Redis namespace differs: `sbi-mtf:dealer_token` (MTF) vs `sbi:dealer_token` (cash) — despite both dealer endpoints resolving from the SAME env var SBI_DEALER_LOGIN_API_ENDPOINT.  
  `src/brokers/sbi-mtf/constants.js:3 vs src/brokers/sbi/constants.js:3; shared endpoint at src/brokers/sbi-mtf/config.js:16,43-44`
- Both adapters short-circuit securityHold for dealers, returning the literal string response 'dealer order stock hold successful' without calling the broker.  
  `src/brokers/sbi-mtf/services/security.js:10-14`

### mtf-only-user-flags

- **!** MTF-only user metadata: getAccessToken returns `meta.emarginNotEnabled` (true unless result.tradingAccountPrivileges.eMarginTermsConditionFlag === 'Y', defaulting to 'N') and `meta.ddpiNotEnabled` (true unless some depositoryDetails entry has depositoryPowerOfAttorneyFlag === 'Y'). Neither field exists on the cash adapter. 'User can't place MTF orders' most often traces to eMarginTermsConditionFlag !== 'Y' in the user-profile response.  
  `src/brokers/sbi-mtf/services/user.js:30-51 (isDDPIEnabled, getEMarginTermsConditionFlag), :314-323, :356-366`
- **!** MTF's real-broker normal-login path TOLERATES missing depository details: the `if (!dpDetails) return { error: new Error('invalid depository details') }` guard is commented out and depositoryAccountNumber/depositoryCode default to empty strings. The cash adapter still hard-fails. An MTF user can therefore hold a valid token with empty DP fields, which would break securityHold if it were ever invoked.  
  `src/brokers/sbi-mtf/services/user.js:344-355 (commented-out guard) vs src/brokers/sbi/services/user.js (active `return { error: new Error('invalid depository details') }`)`

### error-code-mapping

- **!** sbi-mtf's statusMessageMap has 10 keys, sbi's has 6 — verified by executing Object.keys() on both configs. MTF adds amoNotAllowed, unknownError, invalidOrder, networkError. Key ORDER matters because getErrorCode returns the FIRST regex that matches: checkHoldings, marginExceeded, userNotLoggedIn, clientNotEnabled, tradingSystemNotReady, securityNotAllowed, amoNotAllowed, unknownError, invalidOrder, networkError, else 'otherError'.  
  `src/brokers/sbi-mtf/config.js:158-169 (10 keys) vs src/brokers/sbi/config.js:176-183 (6 keys); matcher at src/brokers/sbi-mtf/config.js:120-125`
- **!** Because marginExceeded precedes invalidOrder, 'Order Rejected: Funds violation by 1644.27' classifies as marginExceeded, while a bare 'Order Rejected' falls through to invalidOrder. On SBI cash the bare string has no matching key and becomes 'otherError'.  
  `src/brokers/sbi-mtf/config.js:160,167; asserted at src/brokers/sbi-mtf/tests/config.test.js:69-74, :150-154`
- **!** MTF's checkHoldings regex adds the alternative 'Fresh sell orders are not allowed on E-Margin product' and DROPS the cash adapter's bare 'Quantity shortfall: \d+' alternative. So a raw 'Quantity shortfall: 10' with no trailing instruction text classifies as checkHoldings on SBI cash but falls through to otherError on SBI-MTF.  
  `src/brokers/sbi-mtf/config.js:159 vs src/brokers/sbi/config.js:177`
- **!** MTF's clientNotEnabled regex was rewritten to a single pattern covering three SBI phrasings — 'all Exchanges in CASH product', 'all Exchanges in all products' and the abbreviated 'all Exch in all products' — and matches both 'deactivated' and 'suspended'. The cash adapter's version does not match the abbreviated 'all Exch in all' form.  
  `src/brokers/sbi-mtf/config.js:162 vs src/brokers/sbi/config.js:179; cases at src/brokers/sbi-mtf/tests/config.test.js:83-101`
- **!** MTF's tradingSystemNotReady adds 'Market is not open for trade' and 'Emargin product is currently unavailable'. MTF's securityNotAllowed adds 'Trading on E-Margin product is not allowed on Security' and 'Orders on .* have been blocked for Extended Margin Product'. All four are MTF-only classifications.  
  `src/brokers/sbi-mtf/config.js:163-164 vs src/brokers/sbi/config.js:180-182`

### synthesized-responses

- **!** A successful MTF cancel synthesizes `status: 'CANCELLED AMO'` as a literal string on EVERY cancel regardless of variety — do not infer the order was AMO from it. It also sets filledQuantity: 0 and orderTimestamp: new Date() (client clock, not broker time).  
  `src/brokers/sbi-mtf/services/order.js:544-553`
- cancelOrder returns the bare STRING 'Invalid orderId' as the error value (not an Error instance) when Number(options.orderId) is NaN, so `error.message` is undefined downstream. It also logs at info level, not error.  
  `src/brokers/sbi-mtf/services/order.js:473-476`
- **!** place() with a dealerId but no options.dealerDetails returns a FAKE SUCCESS: {orderId: 'NA', statusMessage: 'order placed by dealer', status: constants.scStatus.PLACED-ish shape} without ever calling the broker. An 'NA' orderId on an MTF order means the broker was never contacted.  
  `src/brokers/sbi-mtf/services/order.js:269-279`

### place-order-payload

- MTF's place payload carries extra fields the cash payload lacks: instrumentDetails.optionType = -1, instrumentDetails.strikePrice = '0.00', instrumentDetails.symbol = '', orderQuantityDetails.disclosedQuantity = 0, and orderPriceDetails.triggerPrice = options.triggerPrice || 0. Presence of optionType/strikePrice/symbol in a captured body identifies the MTF adapter.  
  `src/brokers/sbi-mtf/services/order.js:210-212, :224, :230`
- _resolveOrderValidity was hoisted to module scope in MTF (it is a closure-local function in the cash adapter) and MTF applies it to the DEALER order path too, where the cash adapter hardcodes orderValidities.IOC. Logic itself is the same: AMO -> DAY(1), explicit validity -> mapped, else IOC(2).  
  `src/brokers/sbi-mtf/services/order.js:33-41 (module scope), :145 (dealer path) vs src/brokers/sbi/services/order.js:171-179 (closure) and :130 (dealer hardcodes IOC)`
- orderSlot is OFF_MARKET(2) for AMO variety and ONLINE(0) otherwise, identical in both adapters. preOpenFlag is always 'N'. bookType is always REGULAR_LOT(1).  
  `src/brokers/sbi-mtf/services/order.js:187-193, :236, :219`
- A stale hand-pasted production curl sits at the top of sbi-mtf/services/order.js including a real-looking Bearer token, an IP, an X-REQ-UID and tradingAccountNumber 1002723904, against host https://api.sbisecurities.in. It documents the real wire format (product:6, accountSettlementType:0) but is a comment, not executed code — do not cite it as evidence of runtime behaviour.  
  `src/brokers/sbi-mtf/services/order.js:1-7`

### pledge-conversion

- **!** SETTLED — NOT FOUND, and confirmed absent, not merely unsearched. A case-insensitive grep for pledge|unpledge|conversion|convert|\bcnc\b|margincall|margin.call|squareoff|square.off across BOTH src/brokers/sbi-mtf/ and src/brokers/sbi/ returns only: (a) the literal SBI error strings containing 'square off'/'Square-off' inside statusMessageMap regexes and their tests, and (b) unrelated 'convert to Number' code comments in cancelOrder. There is no MTF-to-CNC conversion, no pledge/unpledge call, no margin-call handler and no square-off trigger in the adapter.  
  `grep -rniE 'pledge|conversion|convert|\bcnc\b|margincall|squareoff|square.?off' over src/brokers/sbi-mtf/ and src/brokers/sbi/ — hits only at sbi-mtf/config.js:164, sbi-mtf/tests/config.test.js:58,62,120, sbi-mtf/services/order.js:459-471 (comments), sbi/config.js:182`
- **!** Repo-wide the only 'square off' concept is SBI's own rejection text surfaced to users, e.g. 'Fresh sell orders are not allowed on E-Margin product. Only 116 qty available for square off' — classified as checkHoldings. Square-off is performed by SBI on their side, not by smallcase.  
  `src/brokers/sbi-mtf/tests/config.test.js:56-65; regex at src/brokers/sbi-mtf/config.js:159`

### identical-files

- Exactly four service files are byte-identical between sbi/ and sbi-mtf/: services/misc.js, services/comms.js, services/encrypt.js, services/decrypt.js. Any question about AMO active hours, email/WhatsApp triggers or GCM encrypt/decrypt can be answered from either adapter interchangeably.  
  ``diff -q` on each of src/brokers/sbi/services/{misc,comms,encrypt,decrypt}.js vs src/brokers/sbi-mtf/services/ — all report no differences`
- sbi-mtf has an extra test file tests/config.test.js (177 lines) with no cash-adapter counterpart, and a tests/portfolio.test.js; it LACKS tests/order.test.js which sbi/ has. tests/config.test.js is the authoritative catalogue of exact SBI error strings and their expected error codes.  
  `src/brokers/sbi-mtf/tests/config.test.js:1-177; src/brokers/sbi/tests/order.test.js exists with no sbi-mtf equivalent`

### config-divergence

- api_endpoint for MTF comes from SBI_MTF_API_ENDPOINT (cash uses SBI_API_ENDPOINT), but apiKey/apiSecret/caCert/decryptPassword/decryptSalt all still read the SHARED SBI_* env vars (SBI_APP_KEY, SBI_SECRET_KEY, SBI_PRIVATE_CERT, SBI_DECRYPT_PASSWORD, SBI_DECRYPT_SALT). Only the host differs.  
  `src/brokers/sbi-mtf/config.js:3, :8, :12, :15, :55-56`
- MTF's leprechaun mode hardcodes credentials in source: apiKey 'leprechaun_test_key', apiSecret 'leprechaun_test_secret', decryptPassword 'test_password_for_leprechaun', decryptSalt 'test_salt_for_leprechaun'. The cash adapter leaves the leprechaun key/secret as empty strings and always reads decrypt creds from env. Seeing these literals confirms a mock-path trace.  
  `src/brokers/sbi-mtf/config.js:9, :13, :55-56 vs src/brokers/sbi/config.js:8,12`
- Shared-value config confirmed identical across both adapters (do NOT assume divergence): getFundsAllowed false, fundsHoldRequired true, pricesAvailable false, fundsBuffer 0, concurrentOrdersNotAllowed true, holdingsCheckRequired false, positionsProvided false, liveHoldingsProvided false, amoAllowed true, amoFundsBuffer 3, onlyLimitAmoAllowed true, autoSipAllowed true, authorizationRequiredForSell false, orderKeyNotSufficientForCancellation true, brokerApiRequestTimeout 9000.  
  `src/brokers/sbi-mtf/config.js:58-93, :154 — full-file diff against src/brokers/sbi/config.js shows no change on any of these lines`

### ecosystem-gaps

- **!** sbi-mtf is EXCLUDED from the activated-AMO polling exception list in triggerAmoPoll.js: amoAllowedBrokers is .concat(['sbi','sbi-mtf']) so plain AMO polling covers it, but the activated-orders special case queries {broker: {$in: ['sbi','axis']}} — activated sbi-mtf AMO orders are not picked up.  
  `sc-integrations-jobs/jobs/triggerAmoPoll.js:111 (concat) and :83-89 (activated list, branch: production)`
- cleanupMtfNonTerminalBatches.js treats 'sbi-mtf' and 'sbi-mtf-leprechaun' as MTF brokers for stuck-batch cleanup: MTF_BROKERS = ['axis-mtf','sbi-mtf','hdfc-mtf','axis-mtf-leprechaun','sbi-mtf-leprechaun','hdfc-mtf-leprechaun'].  
  `sc-integrations-jobs/jobs/cleanup/cleanupMtfNonTerminalBatches.js:5 (branch: production)`
- SBI recon jobs treat sbi and sbi-mtf together: sbiReconAllOrders.js and sbiReconBatchCreation.js query broker: {$in: ['sbi','sbi-mtf']}, and sbiRejectedAmoOrdersIngest.js defines SBI_BROKERS = ['sbi','sbi-mtf']. sbiReconAllOrders separately counts sbiMtfFiles, implying a distinct MTF recon file set in S3.  
  `sc-integrations-jobs/jobs/reconciliations/sbiReconAllOrders.js:123,:1160,:1174; sbiReconHelperFiles/sbiReconBatchCreation.js:10,:74; sbiRejectedAmoOrdersIngest.js:35 (branch: production)`


## Grep targets (74)

Search with `fetch-by-identifier.js --service <svc> --text "<string>"`.

| String | Means | Emitted by | Citation |
|---|---|---|---|
| `Broker login successful` | getAccessToken succeeded; the redacted decrypted user params (incl. meta.emarginNotEnabled / meta.ddpiNotEnabled for MTF) are in details.response | api.js user().accessToken success path _(lvl info (bunyan 30))_ | `src/brokers/sbi-mtf/api.js:45` |
| `Error in fetching access token` | getAccessToken failed — missing brokerParams, JSON parse failure, missing requestToken, or invalid user profile response | api.js user().accessToken failure path _(lvl warn (40))_ | `src/brokers/sbi-mtf/api.js:37-42` |
| `Error in check session` | session check failed | api.js user().checkSession _(lvl warn (40))_ | `src/brokers/sbi-mtf/api.js:61-66` |
| `Error in dealer authentication` | authenticateDealer failed — dealer token could not be obtained/cached | api.js user().authenticateDealer _(lvl warn (40))_ | `src/brokers/sbi-mtf/api.js:77-82` |
| `Error in funds check` | fundService.check returned an error; note MTF's check() swallows most failures into {sufficientFunds:false} instead, so this line is comparatively rare | api.js funds().check _(lvl warn (40))_ | `src/brokers/sbi-mtf/api.js:118-123` |
| `Error in placing order` | orderService.place returned an error for an MTF order | api.js orders().place _(lvl warn (40))_ | `src/brokers/sbi-mtf/api.js:158-163` |
| `Error in order status` | getOrderDetails failed. On MTF this includes the 600014 'no data found' case with NO settlement-type retry | api.js orders().status _(lvl warn (40))_ | `src/brokers/sbi-mtf/api.js:189-194` |
| `Failed to delete order` | cancelOrder failed. Remember MTF's cancel sends product CASH(1), not MTF(6) | api.js orders().delete _(lvl warn (40))_ | `src/brokers/sbi-mtf/api.js:208` |
| `Failed to hold securities` | securityService.holdSecurities failed. Rare on MTF because securitiesHoldRequired is false, so order-updates normally skips this call entirely | api.js security().hold _(lvl warn (40))_ | `src/brokers/sbi-mtf/api.js:229-234` |
| `Error in placing sip order` | autosipService.placeOrder failed. Note MTF's autosip hardcodes accountSettlementType 0 | api.js sip().placeOrder _(lvl warn (40))_ | `src/brokers/sbi-mtf/api.js:248-253` |
| `Margin receivable calculated successfully` | MTF-ONLY. Portfolio.fetchMarginReceivable completed. details.response.marginReceivable may still be 0 from any of four silent-zero paths | api.js portfolio().fetchMarginReceivable success _(lvl info (30))_ | `src/brokers/sbi-mtf/api.js:309` |
| `Error calculating margin receivable` | MTF-ONLY. fetchMarginReceivable threw; only the catch-all path reaches here | api.js portfolio().fetchMarginReceivable failure _(lvl warn (40))_ | `src/brokers/sbi-mtf/api.js:301-306` |
| `Error calculating margin receivable` | MTF-ONLY, second emitter. portfolioService.calculateMarginReceivable's own catch. Distinguish from the api.js one by details.options being present alongside details.error | services/portfolio.js calculateMarginReceivable catch _(lvl error (50))_ | `src/brokers/sbi-mtf/services/portfolio.js:213` |
| `Error calculating margin receivable for mixed basket` | MTF-ONLY. The mixed BUY+SELL basket receivable loop threw; sellAmount silently falls back to 0, inflating required funds | services/fund.js calculateMarginReceivableForMixedBasket catch _(lvl error (50))_ | `src/brokers/sbi-mtf/services/fund.js:280` |
| `Error computing marginReceivable` | MTF-ONLY. Outer guard in check() around the mixed-basket call; sellAmount keeps its pre-margin value | services/fund.js check() catch _(lvl error (50))_ | `src/brokers/sbi-mtf/services/fund.js:323` |
| `Error fetching margin funding percentages from Redis` | MTF-ONLY, HIGH VALUE. The MTF:{sid} margin lookup failed; buyAmount falls back to the FULL un-margined value, so the user is asked for 100% of the basket. This is the loudest signal for 'MTF order demanded full funds' | services/fund.js calculateMTFFunds catch _(lvl error (50))_ | `src/brokers/sbi-mtf/services/fund.js:155` |
| `View Limits API failed` | GET /rmslimit-service/trading-accounts/{accountId}/account-settlement-types/{settlementType}/limit/fund failed. Response becomes {sufficientFunds:false, error:'Failed to fetch user limits'} | services/fund.js handleViewLimitsError _(lvl error (50))_ | `src/brokers/sbi-mtf/services/fund.js:20` |
| `Failed to fetch user limits` | The error string returned to the CALLER (not a log msg field) when viewLimits fails. Greppable in downstream order-updates/platform-api logs | services/fund.js handleViewLimitsError return value _(lvl n/a (payload value))_ | `src/brokers/sbi-mtf/services/fund.js:25` |
| `Error in cancelling order` | requestBroker returned an error for DELETE /order-service/cancel-order | services/order.js cancelOrder _(lvl error (50))_ | `src/brokers/sbi-mtf/services/order.js:540` |
| `Invalid orderId` | Two emitters: the log message, AND the returned error value (a bare string, not an Error). Number(options.orderId) was NaN on a non-leprechaun cancel | services/order.js cancelOrder guard _(lvl info (30) — note: logged at INFO despite being a failure)_ | `src/brokers/sbi-mtf/services/order.js:474-475` |
| `error holding stock` | POST /dp-service/hold-release/dp failed. Note the argument order here is (error, 'error holding stock', {payload}, logger) — msg and details are SWAPPED relative to every other logWarn call in the adapter, so this line's `details` field will contain the string and `msg` will contain the payload object | services/security.js holdSecurities _(lvl warn (40))_ | `src/brokers/sbi-mtf/services/security.js:75` |
| `Successful request` | Every successful broker HTTP call. details.request holds url/method/headers, details.response holds {statusCode, body}. This is THE line to grep to see raw SBI request/response bodies for an MTF order | services/request.js requestBroker success _(lvl info (30))_ | `src/brokers/sbi-mtf/services/request.js:130-139` |
| `sending success response` | Immediately follows 'Successful request'; details = {type: typeof responseBody, responseBody}. Redundant duplicate of the response body | services/request.js requestBroker success _(lvl info (30))_ | `src/brokers/sbi-mtf/services/request.js:142-145` |
| `Successful rejection reason request` | POST /order-rejection/rejection-reason returned an HTTP error but a usable body; the reason is extracted from error.response.data.messageList[0].messageDescription when responseCode === 1. Logged as a SUCCESS despite arriving via the catch block | services/request.js requestBroker catch, url includes 'rejection-reason' _(lvl info (30))_ | `src/brokers/sbi-mtf/services/request.js:184-188` |
| `Error in request - ${error.message}` | Network-level failure with no error.response.data — timeout, DNS, TLS, connection refused. The interpolated tail is the axios message, e.g. 'Error in request - timeout of 9000ms exceeded' | services/request.js requestBroker catch, no response body _(lvl warn (40))_ | `src/brokers/sbi-mtf/services/request.js:203-211` |
| `Error in request` | HTTP error WITH a response body. details.response holds SBI's error payload (messageList etc.). For place-order URLs the error is then swallowed and the body returned as a response | services/request.js requestBroker catch, response body present _(lvl warn (40))_ | `src/brokers/sbi-mtf/services/request.js:216-220` |
| `Failed request` | Generic Error message constructed when the response structure is valid and status is 2xx but messageList[0].messageDescription is absent | services/request.js requestBroker non-2xx/invalid-structure branch _(lvl n/a (Error message, surfaces via other log lines' err.message))_ | `src/brokers/sbi-mtf/services/request.js:159-167` |
| `Decrypted user params` | Real-broker login completed; details.decryptedParams holds userId, userName, dealer flags, accessToken (REDACTED by keyBlacklist) and the MTF meta block | services/user.js getAccessToken success _(lvl info (30))_ | `src/brokers/sbi-mtf/services/user.js:377-380` |
| `Error in decrypting user params` | decryptGCM threw on brokerParams/requestToken — wrong SBI_DECRYPT_PASSWORD/SALT or malformed payload | services/user.js getAccessToken catch _(lvl warn (40))_ | `src/brokers/sbi-mtf/services/user.js:383` |
| `Dealer login detected via _d suffix pattern` | LEPRECHAUN/MOCK PATH ONLY. requestToken contained an underscore; second segment taken as dealerId | services/user.js detectDealerLogin _(lvl info (30))_ | `src/brokers/sbi-mtf/services/user.js:80` |
| `Failed to parse brokerParams` | JSON.parse of options.brokerParams threw inside detectDealerLogin | services/user.js detectDealerLogin _(lvl warn (40))_ | `src/brokers/sbi-mtf/services/user.js:110` |
| `DEBUG: getLeprechaunAccessToken called for sbi-mtf-leprechaun` | MOCK PATH MARKER, MTF-SPECIFIC WORDING. The cash adapter's equivalent line omits the ' for sbi-mtf-leprechaun' suffix — this exact string proves the MTF leprechaun adapter. Logged at INFO, not debug | services/user.js getLeprechaunAccessToken _(lvl info (30) despite the DEBUG: prefix)_ | `src/brokers/sbi-mtf/services/user.js:139` |
| `DEBUG: Extracted userId from requestToken` | MOCK PATH. userId parsed off the requestToken before the underscore | services/user.js getLeprechaunAccessToken _(lvl info (30))_ | `src/brokers/sbi-mtf/services/user.js:147` |
| `DEBUG: detectDealerLogin result` | MOCK PATH. details carry {dealerId, dealerUserId, isDealerLogin, requestToken, userId} | services/user.js getLeprechaunAccessToken _(lvl info (30))_ | `src/brokers/sbi-mtf/services/user.js:158` |
| `DEBUG: Entering dealer login branch` | MOCK PATH. getUserProfile is skipped; meta is hardcoded to {ddpiNotEnabled:true, emarginNotEnabled:false} | services/user.js getLeprechaunAccessToken _(lvl info (30))_ | `src/brokers/sbi-mtf/services/user.js:162` |
| `DEBUG: NOT entering dealer branch, proceeding with regular user login` | MOCK PATH. Falls through to the leprechaun getUserProfile call | services/user.js getLeprechaunAccessToken _(lvl info (30))_ | `src/brokers/sbi-mtf/services/user.js:192` |
| `Leprechaun dealer login successful` | MOCK PATH. Encoded token is `\|{clientId}\|{dealerId}\|0\|\|` | services/user.js getLeprechaunAccessToken _(lvl info (30))_ | `src/brokers/sbi-mtf/services/user.js:188` |
| `Leprechaun login successful` | MOCK PATH, regular user. responseParams include the MTF meta block; note `email` is NOT returned (unlike the cash adapter) | services/user.js getLeprechaunAccessToken _(lvl info (30))_ | `src/brokers/sbi-mtf/services/user.js:251` |
| `Error fetching leprechaun user profile` | MOCK PATH. getUserProfile against the leprechaun host failed | services/user.js getLeprechaunAccessToken _(lvl warn (40))_ | `src/brokers/sbi-mtf/services/user.js:202` |
| `Error in leprechaun login` | MOCK PATH. Outer catch of getLeprechaunAccessToken | services/user.js getLeprechaunAccessToken catch _(lvl warn (40))_ | `src/brokers/sbi-mtf/services/user.js:255` |
| `scmtf_` | THE single most reliable SBI-MTF discriminator. Tag prefix, 9 alphanumeric chars follow (total length 15). Appears as Order.orders[].tag, externalReferenceNumber and remarks. `sc_` = SBI cash | config.generateTag() _(lvl n/a (payload value))_ | `src/brokers/sbi-mtf/config.js:115-119` |
| `MTF:` | Redis key prefix for the per-stock margin hash, `MTF:{sid}`. Field read is 'sbi-mtf.nse' / 'sbi-mtf.bse' | services/fund.js calculateMTFFunds and calculateMarginReceivableForMixedBasket _(lvl n/a (Redis key))_ | `src/brokers/sbi-mtf/services/fund.js:135, :236` |
| `sbi-mtf.nse` | Redis hash FIELD holding the MTF margin percentage for NSE. Missing field => default 100 => full-price funds requirement, silently | config.getMarginIdentifier; written by putBrokerMtfsInRedis.js _(lvl n/a (Redis field))_ | `src/brokers/sbi-mtf/config.js:104-106; sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js:354,:604` |
| `QTS:` | Redis key prefix for the quote hash, `QTS:{sid}`, field 'kite', value is JSON like '{"price":267.35,"close":263.28}'. Used to backfill missing order prices in the MTF funds calc | services/fund.js calculateMTFFunds _(lvl n/a (Redis key))_ | `src/brokers/sbi-mtf/services/fund.js:109, :72-88` |
| `sbi-mtf:dealer_token` | Redis key prefix for the cached MTF dealer token: `sbi-mtf:dealer_token:{entityId}:{userId}`. Distinct namespace from the cash adapter's `sbi:dealer_token` despite a shared auth host | constants.js dealerTokenRedisKeyPrefix _(lvl n/a (Redis key))_ | `src/brokers/sbi-mtf/constants.js:3` |
| `/position-service/emargin-details` | MTF-ONLY endpoint path. Presence in a request log proves the MTF adapter. Service name 'getEmarginDetails' | config.js endpoint map; called from services/portfolio.js _(lvl n/a (URL in details.request.url))_ | `src/brokers/sbi-mtf/config.js:47; src/brokers/sbi-mtf/services/portfolio.js:175` |
| `emarginDate` | MTF-ONLY request field under orderParameters.orderLegDetails, format YYYYMMDD. Absent from cash-adapter payloads. Omitted entirely when the source date is falsy/invalid | services/order.js _getBrokerOrderObject _(lvl n/a (payload field))_ | `src/brokers/sbi-mtf/services/order.js:237` |
| `"product":6` | MTF product code in the place-order / dealer-place payload. `"product":1` on a CANCEL is expected-but-wrong (see corrections); `"product":1` on a PLACE means the cash adapter | services/order.js _getBrokerOrderObject / _getDealerBrokerOrderObject _(lvl n/a (payload field))_ | `src/brokers/sbi-mtf/services/order.js:233, :143; constants at src/brokers/sbi-mtf/constants.js:98` |
| `availableLimitEqEmargin` | MTF-ONLY field consumed from the viewLimits response. The cash adapter reads availableLimitCashAndCarry instead. Its presence/absence in a captured viewLimits body tells you which adapter will get a sane number | services/fund.js parseViewLimitsResponse _(lvl n/a (payload field))_ | `src/brokers/sbi-mtf/services/fund.js:166-171` |
| `eMarginTermsConditionFlag` | MTF-ONLY user-profile field under result.tradingAccountPrivileges. Anything other than 'Y' sets meta.emarginNotEnabled = true. Primary cause of 'user cannot place MTF orders' | services/user.js getEMarginTermsConditionFlag _(lvl n/a (payload field))_ | `src/brokers/sbi-mtf/services/user.js:43-51` |
| `depositoryPowerOfAttorneyFlag` | MTF-ONLY read. Any depositoryDetails entry with 'Y' sets ddpiEnabled; otherwise meta.ddpiNotEnabled = true | services/user.js isDDPIEnabled _(lvl n/a (payload field))_ | `src/brokers/sbi-mtf/services/user.js:30-41` |
| `emarginNotEnabled` | MTF-ONLY response meta field on the login payload. true => user has not accepted eMargin T&C | services/user.js getAccessToken / getLeprechaunAccessToken _(lvl n/a (payload field))_ | `src/brokers/sbi-mtf/services/user.js:247, :321, :365` |
| `ddpiNotEnabled` | MTF-ONLY response meta field. true => no depository POA on any DP account | services/user.js getAccessToken / getLeprechaunAccessToken _(lvl n/a (payload field))_ | `src/brokers/sbi-mtf/services/user.js:246, :320, :364` |
| `CANCELLED AMO` | Literal synthesized status on EVERY successful MTF cancel, AMO or not. Do not infer AMO variety from it | services/order.js cancelOrder success return _(lvl n/a (payload value))_ | `src/brokers/sbi-mtf/services/order.js:546` |
| `order placed by dealer` | Fake-success statusMessage paired with orderId 'NA'. The broker was NEVER called — options.dealerDetails was missing on a dealer order | services/order.js place() dealer guard _(lvl n/a (payload value))_ | `src/brokers/sbi-mtf/services/order.js:269-279` |
| `Fresh sell orders are not allowed on E-Margin product` | SBI rejection, MTF-ONLY classification => errorCode 'checkHoldings'. Often suffixed with 'Only N qty available for square off' | SBI broker; matched by config.statusMessageMap.checkHoldings _(lvl n/a (broker statusMessage))_ | `src/brokers/sbi-mtf/config.js:159; cases at src/brokers/sbi-mtf/tests/config.test.js:52-65` |
| `Emargin product is currently unavailable` | SBI rejection, MTF-ONLY => errorCode 'tradingSystemNotReady'. Full observed text: 'Emargin product is currently unavailable. Kindly place delivery order.' | SBI broker; matched by config.statusMessageMap.tradingSystemNotReady _(lvl n/a (broker statusMessage))_ | `src/brokers/sbi-mtf/config.js:163; case at src/brokers/sbi-mtf/tests/config.test.js:113-116` |
| `Trading on E-Margin product is not allowed on Security` | SBI rejection, MTF-ONLY => errorCode 'securityNotAllowed'. Observed with ' : SBINEQ' / ' : IDEAEQ' suffixes | SBI broker; matched by config.statusMessageMap.securityNotAllowed _(lvl n/a (broker statusMessage))_ | `src/brokers/sbi-mtf/config.js:164; cases at src/brokers/sbi-mtf/tests/config.test.js:127-135` |
| `have been blocked for Extended Margin Product` | SBI rejection, MTF-ONLY => errorCode 'securityNotAllowed'. Observed: 'Orders on RCOMEQ (TT script) have been blocked for Extended Margin Product .' | SBI broker; matched by config.statusMessageMap.securityNotAllowed _(lvl n/a (broker statusMessage))_ | `src/brokers/sbi-mtf/config.js:164; case at src/brokers/sbi-mtf/tests/config.test.js:136-139` |
| `You cannot place AMO orders now.` | MTF-ONLY errorCode 'amoNotAllowed'. On SBI cash this same string falls through to 'otherError'. Observed suffix: 'AMO orders are allowed between 7:00PM to 9:00AM' | SBI broker; matched by config.statusMessageMap.amoNotAllowed _(lvl n/a (broker statusMessage))_ | `src/brokers/sbi-mtf/config.js:165; case at src/brokers/sbi-mtf/tests/config.test.js:140-144` |
| `Unknown API error` | MTF-ONLY errorCode 'unknownError'. On SBI cash this maps to 'otherError' — same string, different classification | matched by config.statusMessageMap.unknownError _(lvl n/a (broker statusMessage))_ | `src/brokers/sbi-mtf/config.js:166; case at src/brokers/sbi-mtf/tests/config.test.js:145-149` |
| `Exchange connection is down` | MTF-ONLY errorCode 'networkError'. Observed: 'Exchange connection is down, please try later'. On SBI cash => 'otherError' | matched by config.statusMessageMap.networkError _(lvl n/a (broker statusMessage))_ | `src/brokers/sbi-mtf/config.js:168; case at src/brokers/sbi-mtf/tests/config.test.js:155-159` |
| `is deactivated on all Exch in all products` | Abbreviated SBI phrasing that MTF's clientNotEnabled regex matches but the CASH adapter's does NOT. Same account state classifies differently per adapter | SBI broker; matched by config.statusMessageMap.clientNotEnabled _(lvl n/a (broker statusMessage))_ | `src/brokers/sbi-mtf/config.js:162; cases at src/brokers/sbi-mtf/tests/config.test.js:88-96` |
| `Order Rejected: Funds violation by` | => errorCode 'marginExceeded' (marginExceeded is checked before invalidOrder). A bare 'Order Rejected' => 'invalidOrder' on MTF, 'otherError' on cash | SBI broker; matched by config.statusMessageMap.marginExceeded _(lvl n/a (broker statusMessage))_ | `src/brokers/sbi-mtf/config.js:160,167; cases at src/brokers/sbi-mtf/tests/config.test.js:69-74,:150-154` |
| `Funds shortfall:` | => errorCode 'marginExceeded'. Followed by a decimal amount | SBI broker; matched by config.statusMessageMap.marginExceeded _(lvl n/a (broker statusMessage))_ | `src/brokers/sbi-mtf/config.js:160` |
| `Starting SBI MTF ingestion` | putBrokerMtfsInRedis began the SBI MTF margin CSV ingest. If this is followed by 'No SBI MTF CSV files found for today, continuing job', margins are stale and every MTF funds check that day risks the 100% default | sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js addSbiMtfSymbols _(lvl info (30))_ | `sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js:120` |
| `No SBI MTF CSV files found for today, continuing job` | HIGH VALUE. No margin file for today; job continues without updating MTF:{sid}. Direct cause of stale-or-absent margins | sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js addSbiMtfSymbols _(lvl warn (40))_ | `sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js:149` |
| `Failed to list SBI MTF files from S3` | S3 ListObjects failed for the SBI MTF margin prefix; no margins ingested | sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js addSbiMtfSymbols _(lvl error (50))_ | `sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js:140` |
| `Error ingesting SBI MTF file` | One margin CSV failed to parse; other files may still have succeeded, so margins can be PARTIALLY populated | sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js addSbiMtfSymbols _(lvl error (50))_ | `sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js:178` |
| `Unexpected SBI MTF header. Expected ${EXPECTED_SBI_HEADERS} received ${headerColumns}` | Thrown Error (surfaces via 'Error ingesting SBI MTF file'). SBI changed their CSV column layout — whole file rejected | sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js parseSbiMtfCsvContent _(lvl n/a (Error message))_ | `sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js:940` |
| `SBI MTF row skipped due to incorrect column count` | Individual ticker dropped from the margin ingest => that sid keeps no margin => 100% default at funds check | sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js processSbiMtfLine _(lvl warn (40))_ | `sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js:969` |
| `Starting SBI MTF redis cleanup for old fields` | About to HDEL 'sbi-mtf.nse'/'sbi-mtf.bse' from stale MTF:* keys. Only runs when new data was parsed | sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js cleanupOldSbiMtfFieldsInRedis _(lvl info (30))_ | `sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js:569` |
| `Skipping SBI MTF redis cleanup because no new SBI MTF data was parsed` | Confirms the ingest produced nothing; existing (stale) margins are left in place rather than deleted | sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js cleanupOldSbiMtfFieldsInRedis _(lvl info (30))_ | `sc-integrations-jobs/jobs/putBrokerMtfsInRedis.js:565` |
| `MTF_MARGIN_REDIS_ERROR` | platform-api subtype tag when the MTF:{sid} hgetall throws while computing unrealized margin investment; that constituent silently falls back to factor 1 (100%) | sc-platform-api/app/services/userSmallcase/userSmallcase.js calculateUnrealizedMarginInvestment _(lvl error (50))_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:11680-11684` |


## Corrections (13)

Where the old `SBI_LOG_INVESTIGATION_GUIDE.md`, or an obvious assumption, is provably wrong.


**Claimed:** TASK BRIEF: 'NOTE: repo is on branch rebalance-in-amo, NOT production — flag facts the branch may affect.' (stated for sc-integrations-broker-lib)

**Actually:** sc-integrations-broker-lib is checked out on 'development' (commit dbe4206f, v16.11.15), working tree clean — not 'rebalance-in-amo'. More importantly the warning is moot for this domain: `git diff rebalance-in-amo..development -- src/brokers/sbi-mtf/` is EMPTY, so the adapter is byte-identical on both branches. No fact in this report is affected by the branch.

``git -C sc-integrations-broker-lib rev-parse --abbrev-ref HEAD` => development; `git -C sc-integrations-broker-lib diff --stat rebalance-in-amo..development -- src/brokers/sbi-mtf/` => no output`


**Claimed:** IMPLICIT ASSUMPTION (and the natural reading of 'several repos here are NOT on production, which means the code you read may not be what runs in prod'): that broker-lib's 'production' branch is the prod-truth to check facts against.

**Actually:** INVERTED. src/brokers/sbi-mtf/ DOES NOT EXIST on broker-lib's 'production' branch and 'sbi-mtf' is not registered in its src/index.js there; that branch is v15.22.0. Meanwhile every production consumer pins broker-lib ^16.11.9–^16.11.15, matching the 'development' branch's v16.11.15. For SBI-MTF, 'development' IS the prod-truth and 'production' is the stale branch. An investigator who 'checks against production' will conclude SBI-MTF does not exist.

``git ls-tree -d production -- src/brokers/sbi-mtf/` => empty; `git show production:src/index.js | grep sbi-mtf` => no match; `git show production:package.json` => 15.22.0; sc-integrations-order-updates/package.json:24 (^16.11.15), sc-platform-api/package.json:33 (^16.11.14), sc-integrations-jobs/package.json:18 (^16.11.14)`


**Claimed:** TASK BRIEF: 'the guide claims sbi-mtf ... hardcodes accountSettlementType 0' — presented as an adapter-wide property.

**Actually:** Only TRUE in autosip.js. sbi-mtf/services/autosip.js:6-8 writes `accountSettlementType: 0` literally and does not import decodeAccessToken. Everywhere else the MTF adapter sends the decoded nriFlag from the access token: place :198, dealer place :121, order-status :358, cancel :521, fundsCheck (fund.js:352), securityHold (security.js:29). The guide's own §1.3 wording correctly scopes this to autosip.js; the task's paraphrase drops the scope and is wrong.

`src/brokers/sbi-mtf/services/autosip.js:5-8 vs src/brokers/sbi-mtf/services/order.js:121,198,358,521; services/fund.js:352; services/security.js:29`


**Claimed:** Guide line 441: 'SBI-MTF — 9 keys (3 more than SBI regular), sbi-mtf/config.js:159-169'

**Actually:** It is 10 keys, 4 more than SBI regular (which has 6). Verified by executing Object.keys(config.getStatusMessageMap()): sbi-mtf => checkHoldings, marginExceeded, userNotLoggedIn, clientNotEnabled, tradingSystemNotReady, securityNotAllowed, amoNotAllowed, unknownError, invalidOrder, networkError (10); sbi => the first six (6). The object also starts at line 158, not 159.

`src/brokers/sbi-mtf/config.js:158-169 (10 keys) vs src/brokers/sbi/config.js:176-183 (6 keys); verified by `node -e "Object.keys(require('./src/brokers/sbi-mtf/config.js')().getStatusMessageMap()).length"` => 10, sbi => 6`


**Claimed:** Guide line 475 and task item 3: 'MTF cancelOrder sets product CASH(1) not MTF(6) ... flagged as a likely real discrepancy'

**Actually:** CONFIRMED CORRECT — verified at src/brokers/sbi-mtf/services/order.js:507. Adding the proof the guide lacks: the line is byte-identical to src/brokers/sbi/services/order.js:513, i.e. it is an un-updated copy from the fork rather than a deliberate choice. Place (:233) and dealer place (:143) both correctly send 6, so cancel is the sole outlier.

`src/brokers/sbi-mtf/services/order.js:507 vs src/brokers/sbi/services/order.js:513; correct usages at src/brokers/sbi-mtf/services/order.js:233,:143`


**Claimed:** Guide line 209: 'twoStepRebalanceEnabled ... is absent entirely from BL-MTF/config.js' — presented as the notable config omission.

**Actually:** CONFIRMED, but INCOMPLETE. sbi-mtf/config.js also lacks FIVE further keys the cash adapter defines: rebalanceSipAllowed (sbi/config.js:80), bufferConfig (:123), limitBatchConfig (:137), dpCharges (:163), addBufferAmount (:164) and nextDayBufferWithClosePrice (:165). The bufferConfig omission means MTF ignores orderMode (limit vs market) entirely when picking buffers; the dpCharges/nextDayBufferWithClosePrice omission is why MTF has no minRequiredFunds retry; addBufferAmount survives only as the inlined magic number 118 in fund.js:331.

`src/brokers/sbi/config.js:79-80,:123-140,:163-165 — none present in src/brokers/sbi-mtf/config.js (full-file diff); inlined 118 at src/brokers/sbi-mtf/services/fund.js:331`


**Claimed:** TASK BRIEF: 'the guide claims sbi-mtf ... short-circuits funds-check for dealers' — listed among MTF divergences to verify.

**Actually:** NOT A DIVERGENCE. Both adapters short-circuit identically: `if (dealerId) return { response: { code: true, sufficientFunds: true, requiredFunds: 0 } }`. The cash adapter merely also echoes allowedSellValues in that object. Treating this as MTF-specific would mislead an investigator into thinking dealer funds checks behave differently between the two.

`src/brokers/sbi-mtf/services/fund.js:287-291 vs src/brokers/sbi/services/fund.js:57-66`


**Claimed:** UNREPORTED BY THE GUIDE (searched: no hit for 'securitiesHoldRequired' or 'allowedSellValues' in SBI_LOG_INVESTIGATION_GUIDE.md) — implicit assumption that MTF and cash share the sell-side pre-order mechanics.

**Actually:** Two hard divergences. (1) securitiesHoldRequired is false on MTF, true on cash; order-updates gates the DP hold call on this flag, so SBI-MTF sell orders never execute securityHold even though the implementation still exists in sbi-mtf/services/security.js. (2) allowedSellValues is INVERTED: cash {T0:0,T1:1}, MTF {T0:1,T1:0} — a regular MTF basket credits 100% of sell proceeds against the buy requirement where regular cash credits 0%.

`src/brokers/sbi-mtf/config.js:60 and :144-147 vs src/brokers/sbi/config.js:56 and :158-161; gate at sc-integrations-order-updates/services/orders.js:2664; MTF usage at src/brokers/sbi-mtf/services/fund.js:294`


**Claimed:** UNREPORTED BY THE GUIDE (no hit for 'X-AUTHORIZATION' in SBI_LOG_INVESTIGATION_GUIDE.md) — the dealer place-order path is described as working on both adapters.

**Actually:** SBI-MTF DEALER PLACE-ORDER SENDS NO AUTHORIZATION HEADER. request.js dropped 'placeDealerOrder' from AUTH_REQUIRED_SERVICES and deleted the block that sets X-AUTHORIZATION/X-DEVICE-ID/X-GEO-LOCATION/X-LANGUAGE-ID/X-USER-AGENT for it, yet order.js:178 still calls `{ service: 'placeDealerOrder' }`. Line 119 therefore deletes Authorization with no replacement. Separately, 'getDealerDetails' is in MTF's AUTH_REQUIRED_SERVICES but lacks the cash adapter's rewrite to `X-AUTHORIZATION: Basic` with Authorization and X-SOURCE-ID stripped, so it sends `Authorization: Bearer <basic-creds>` instead. Expect auth failures / 401s on MTF dealer orders with no explanatory log beyond 'Error in request'.

`src/brokers/sbi-mtf/services/request.js:112,:114,:118-119 vs src/brokers/sbi/services/request.js:112,:114,:118-134; live caller at src/brokers/sbi-mtf/services/order.js:178`


**Claimed:** UNREPORTED BY THE GUIDE (no hit for 'FLAG_NRO') — implicit assumption that NRI settlement-code parsing matches between adapters.

**Actually:** MTF's parseNRIFlag uses FLAG_NRO = '1'; the cash adapter uses FLAG_NRO = '2', and SBI's own code elsewhere in the cash adapter is NRE=3/NRO=2 (NRI_STRING_TO_CODE). An NRO MTF user whose EBD_RES_STATUS is '2' matches NEITHER MTF branch and gets no nriFlag label. MTF additionally has no parseEBDResStatus at all, so no dual-eligible (NRE_NRO) handling, no meta.nriNotSupported, and no per-order options.nri override — a dealer's NRE/NRO selection has zero effect on an MTF order.

`src/brokers/sbi-mtf/services/user.js:18 vs src/brokers/sbi/services/user.js:39; src/brokers/sbi/services/user.js:12-21 (parseEBDResStatus, absent from MTF); src/brokers/sbi/services/order.js:9-10 and security.js:5-7 (NRI_STRING_TO_CODE, absent from MTF)`


**Claimed:** TASK ITEM 7 / guide: MTF-to-CNC conversion, margin-call and pledge logic — 'NOT FOUND', left as an open question.

**Actually:** SETTLED AS GENUINELY ABSENT, not merely unfound. A case-insensitive grep for pledge|unpledge|conversion|convert|\bcnc\b|margincall|margin.call|squareoff|square.?off across BOTH src/brokers/sbi-mtf/ and src/brokers/sbi/ returns only SBI's own rejection strings containing 'square off'/'Square-off' inside statusMessageMap regexes plus their test fixtures, and two unrelated 'convert to Number' code comments in cancelOrder. There is no conversion, pledge, margin-call or square-off code path in the adapter. Square-off is performed by SBI and only ever surfaces to smallcase as rejection text classified 'checkHoldings' or 'securityNotAllowed'.

`grep -rniE 'pledge|conversion|convert|\bcnc\b|margincall|squareoff|square.?off' src/brokers/sbi-mtf/ src/brokers/sbi/ => hits only at sbi-mtf/config.js:164, sbi-mtf/tests/config.test.js:58,62,120, sbi-mtf/services/order.js:459-471, sbi/config.js:182`


**Claimed:** UNREPORTED — implicit assumption that MTF's funds-check response is shape-compatible with the cash adapter's.

**Actually:** It is not. MTF returns only {code, sufficientFunds, requiredFunds} (+ error on viewLimits failure) and never returns allowedSellValues, buyValue, sellValue, minRequiredFunds or bufferAdded. Worse, the `requiredFunds` it returns is fundsToHold — the BUFFERED figure — because the unbuffered computation is commented out at fund.js:328. So MTF's requiredFunds is not numerically comparable to the cash adapter's requiredFunds, which comes from the shared calculateFundsValues helper.

`src/brokers/sbi-mtf/services/fund.js:182-205,:14-27,:328 vs src/brokers/sbi/services/fund.js (returns allowedSellValues/buyValue/sellValue/bufferAdded and a separately-computed fundsRequired)`


**Claimed:** Guide §1.2 correctly notes the tag prefix is 'one of the only reliable ways to tell SBI from SBI-MTF' — but does not state the consequence for the stored Order document.

**Actually:** Adding the second discriminator the guide omits: because `mtfBroker: true` is set on the MTF config, order-updates' determineProduct forces the stored product to EMARGIN rather than 'CNC'. So a Mongo Order with product EMARGIN is an independent MTF marker, usable when the tag is unavailable. The same flag also routes the batch-apply to an MTF-specific platform endpoint and gates the Redis margin fetch.

`src/brokers/sbi-mtf/config.js:94; sc-integrations-order-updates/lib/objects.js:64-73, services/platform.js:110-112, services/orders.js:2551,:2774-2776`


## Open questions (8)

Genuinely unresolved. Report these as unknown rather than guessing.

- Does the published npm package @smallcase/sc-integrations-broker-lib@16.11.15 actually build from the 'development' branch? I inferred this from matching package.json versions (development=16.11.15, consumers pin ^16.11.15/^16.11.14) but could not query the registry or inspect CI config from this environment. If the publish pipeline builds from some other ref, the prod-truth branch conclusion changes.
- Is the SBI-MTF dealer place-order path actually exercised in production? The missing Authorization header (request.js:112,118-119 vs the live caller at order.js:178) would make every MTF dealer order fail auth. Either the path is dead in practice, or SBI accepts these requests for a reason I cannot see from the client side. Confirming requires a real MTF dealer order trace — grep for 'Error in request' with url containing '/dealer-authentication-service/place-order'.
- Is cancelOrder's product:1 (CASH) actually rejected by SBI for an MTF order, or does SBI ignore the product field on cancel and key only off internalOrderNumber? The code proves the wrong value is sent; it does not prove the consequence. A captured cancel request/response pair for an MTF order would settle it.
- What is the real-world distribution of EBD_RES_STATUS values for MTF users? MTF's FLAG_NRO='1' looks wrong against SBI's documented NRO=2, but I could not find any source in these repos defining SBI's settlement-type codes authoritatively — I inferred NRO=2 from the cash adapter's NRI_STRING_TO_CODE. If SBI genuinely uses 1 for NRO in the EBD_RES_STATUS field specifically, MTF is right and the cash adapter is wrong.
- Which S3 bucket and prefix do the SBI MTF margin CSVs live in? putBrokerMtfsInRedis.js reads them from jobConfig.sbi.s3Bucket / .symbolsRemoteFilePath and jobConfig.sbi.requiredHeaders, none of which are literal in the job file. Resolving these from sc-integrations-jobs/config.js (and any env overrides) would let an investigator verify margin-file arrival directly.
- Is sbi-mtf included in the autosip enableForBrokers list in production? The guide notes jobs/config.js default is 'axis,kotak,sbi,kite' with no sbi-mtf; I did not verify whether an env override adds it. This matters because MTF's autosip path both hardcodes accountSettlementType 0 and is reachable via a narrower trigger condition (no options.autoSip disjunct).
- Does anything actually call Sip.delete on an sbi-mtf broker? Its absence is a TypeError rather than a no-op, so if any scheduled job or API route invokes it generically across brokers, that is a live crash. I confirmed the method is missing but did not trace callers across all repos.
- Does any caller pass options.orders AND options.redis into the MTF Funds.check? The entire margin-aware funds calculation is skipped without both, falling back to the raw buyAmount/sellAmount. I confirmed the guard at fund.js:316 but did not trace the platform-api/order-updates call site to verify both are supplied in every flow (notably AMO vs regular, and rebalance vs fresh buy).
