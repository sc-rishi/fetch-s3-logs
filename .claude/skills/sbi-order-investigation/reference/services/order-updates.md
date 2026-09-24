# order-updates

sc-integrations-order-updates — the PRIMARY log source. Placement, polling, batch state, the fix endpoint, and all raw SBI wire traffic.

**branch when read:** production (HEAD fb95292c5eb2d428811cb160f7a4272bf1f7858c, 2026-09-18, "Merge PR #1059 chore/bump-broker-lib-kite-series-fix")

sc-integrations-order-updates (internally "BB", Big Beast) is the service that owns an SBI order batch end to end: it accepts POST /orders/place, builds per-stock broker options, calls broker-lib IN-PROCESS (a plain `require`, never HTTP to sc-integrations-broker-api), writes the Order document through three states (INITIAL→PLACED→FINAL), tracks outstanding legs in a Redis bitmap, and drives a RabbitMQ TTL-delay polling loop until every leg settles. For SBI and SBI-MTF specifically, broker-lib declares `orderStatusBy: { postback: false, polling: true }`, so the Kafka postback consumers are effectively dead paths — every status update for an SBI order arrives through `brokerPoll` → `Orders.status`, and the batch is force-finalized on the last scheduled poll. The Redis order key for both SBI and SBI-MTF is the order's TAG (not the broker orderId), so `BB:order:sbi:sc_XXXXXXXXX` is the primary Redis handle; SBI tags are `sc_`+9 alphanumerics, SBI-MTF tags are `scmtf_`+9. POST /errors/fix/:batchId is the single write endpoint the recon jobs use to repair a stuck batch; despite `triageErrorBatch` returning FIXBY.NONE for SBI, every real SBI fix bypasses triage by passing an explicit `fixBy:'orderbook'` plus a caller-supplied `tradebook` array, because SBI has no orderbook API of its own. A fixed batch is stamped `meta.source` (who fixed it) and each repaired leg gets `meta.reconciled = true`.

Confidence markers are the researcher's own: unmarked = confirmed from source, `[INFERRED]` = deduced but unproven, `[UNCONFIRMED]` = a lead, not a fact. `!` marks facts flagged critical. Re-verify line numbers against the checked-out SHA.


## Facts (68)


### service-identity

- **!** The bunyan logger `name` field for every line this service emits is `sc.service.sc-integrations-order-updates`. lib/logger.js builds it as `sc.service.${loggerConfig.loggerName}`; config.js sets loggerName from APPLICATION_NAME; the production env pins APPLICATION_NAME to `sc-integrations-order-updates`. Filter a mixed log dump on this exact name to isolate BB lines.  
  `lib/logger.js:5-8, config.js:306-311, deployment/infra/production-sc-integrations-order-updates-env.yaml:3`
- **!** Every jsonLogger line carries `type` (default 'APPLICATION_LOGS'), `message`, APM trace ids spread from `apm.currentTraceIds`, and a `context` object. logError/logWarn/logFatal additionally emit `err:{code,name,message,stack}`. Known non-default `type` values in this repo: 'API_REQUEST', 'RESPONSE_LOG', 'DEBUG_MESSAGES', 'SC_BROKER', 'SC_BROKER_META'.  
  `lib/logger.js:9-72, ou-server/app.js:24, ou-server/controller.js:71, ou-server/controller.js:400, lib/brokerApi.js:52, lib/brokerApi.js:63`

### broker-lib-invocation

- **!** broker-lib is called IN-PROCESS, not over HTTP. lib/brokerApi.js line 1 does `const brokers = require('@smallcase/sc-integrations-broker-lib')` and line 61 invokes `apiEndpoint(options, cb, logger)` directly. There is no reference to sc-integrations-broker-api anywhere in this repo. Any theory that OU talks to a broker-api HTTP service is wrong.  
  `lib/brokerApi.js:1, lib/brokerApi.js:42-65`
- **!** The broker function map is exactly: placeOrder→Orders.place, orderStatus→Orders.status, orderBook→Orders.list, deleteOrder→Orders.delete, securityHold→Security.hold, placeFractionalSell→Orders.placeFractionalSell. If a broker lacks the endpoint, BB logs 'Broker API endpoint does not exist' with type SC_BROKER_META and calls back an Error.  
  `lib/brokerApi.js:24-31, lib/brokerApi.js:45-54`

### sbi-no-orderbook

- **!** SBI and SBI-MTF expose only Orders.place / Orders.status / Orders.delete and Security.hold in broker-lib — there is NO `Orders.list`. Therefore `brokerEndpointExists('sbi','orderBook')` is false and errors.js getOrderBook() throws 'order book api not supported by this broker'. A fix request with fixBy=orderbook and NO tradebook in the body can never work for SBI.  
  `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/api.js:151-289, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi-mtf/api.js:152-318, services/errors.js:472-489`

### sbi-polling-vs-postback

- **!** SBI and SBI-MTF are POLLING-ONLY: broker-lib config sets `orderStatusBy: { postback: false, polling: true }` for both. The Kafka ORDER_conciliation consumer therefore carries no SBI broker postbacks; all SBI status data enters via brokerPoll → Orders.status. Do not look for SBI postback ingestion.  
  `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/config.js:58-61, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi-mtf/config.js:63-66`

### sbi-order-key

- **!** For SBI and SBI-MTF the Redis order key IS THE TAG: broker-lib config defines `getOrderKey: function (order) { return order.tag; }`. utils.getOrderKey falls through to this. So the Redis hash holding a live SBI order is `BB:order:sbi:<tag>` (and `BB:order:sbi-mtf:<tag>`), NOT keyed by broker orderId.  
  `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/config.js:98-100, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi-mtf/config.js:95-97, lib/utils.js:703, lib/utils.js:748-757`

### sbi-tag-format

- **!** SBI tag format is `sc_` + 9 characters from [0-9a-zA-Z] (nanoid). SBI-MTF tag format is `scmtf_` + 9 such characters. This is the single most greppable SBI identifier — regex `sc_[0-9A-Za-z]{9}` / `scmtf_[0-9A-Za-z]{9}`.  
  `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/config.js:108-112, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi-mtf/config.js:115-119`
- The tag is generated at query-string build time by `utils.generateTag(broker, options, overrideTag)`. overrideTag is true (i.e. an incoming order.tag is preserved instead of regenerated) when the batch is twoStep, or dealer, or activated, or autoSip, or broker==='axis' && label==='AUTOSIP'. For an ordinary SBI rebalance/buy, BB mints a fresh tag.  
  `services/orders.js:2547-2548, lib/utils.js:758-761`

### sbi-sessionless-poll

- **!** SBI/SBI-MTF set `sessionlessPollingAvailable: () => true`, so getAccessToken() short-circuits and returns the literal string 'X' — SBI polling needs NO user access token. Consequently 'Access Token not found on broker poll.' can never be the cause of an SBI polling failure.  
  `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/config.js:81, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi-mtf/config.js:81, services/orders.js:3617-3637`

### sbi-serial-polling

- **!** SBI/SBI-MTF set `concurrentOrdersNotAllowed: true`, so pollBroker uses `utils.executeInSeries` (one order at a time) instead of executeInParallel, and processIndividualOrders places orders with async.mapSeries rather than map. A 20-leg SBI batch is placed and polled strictly serially — expect wall-clock latency proportional to leg count.  
  `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/config.js:62, services/orders.js:3643, services/orders.js:3692-3697, services/orders.js:2604-2605`
- SBI/SBI-MTF set `orderIdNotSufficientForPolling: true`, so before each poll BB re-reads the whole order hash from Redis (`BB:order:<broker>:<orderKey>`) and merges it with batch details into the poll payload. If that Redis hash has expired or was cleaned up, the SBI poll payload is incomplete.  
  `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/config.js:74, services/orders.js:3665-3686`

### polling-queues

- **!** Four poll queues exist, created at module load of services/orders.js, each backed by a RabbitMQ TTL queue: regular (interval 3s, limit REGULAR_POLL_COUNT_LIMIT), day (600s, DAY_POLL_COUNT_LIMIT), amo (900s, AMO_POLL_COUNT_LIMIT), activated (900s, AMO_POLL_COUNT_LIMIT). All four run batchExpireHandler.  
  `config.js:16-33, services/orders.js:47-74`
- **!** Production poll limits (overriding config defaults): DAY_POLL_COUNT_LIMIT=30, AMO_POLL_COUNT_LIMIT=26, REGULAR_POLL_COUNT_LIMIT=25, QUEUE_CONCURRENCY=1. So in prod: regular ≈ 25 polls × 3s ≈ 75s; day ≈ 30 × 10min ≈ 5h; amo/activated ≈ 26 × 15min ≈ 6.5h.  
  `deployment/infra/production-sc-integrations-order-updates-env.yaml:99-102, config.js:16-33`
- **!** At placement, AMO batches are NOT polled (`variety !== orderConsts.variety.AMO` guard). Non-AMO batches: if not all legs are DAY validity, `poll.regular.start(..., prePoll = broker === 'kite')` — so for SBI prePoll is FALSE, meaning the first poll is delayed by the queue TTL, not immediate. If any leg is DAY validity, `poll.day.start(..., true)` also fires with prePoll TRUE.  
  `services/orders.js:1218-1233`
- **!** SBI regular (non-AMO) LIMIT orders get validity 'IOC' from SBI's `limitBatchConfig.default = { validity: 'IOC', bufferPercent: 2, TV: 10000000 }`. IOC means hasDayOrder=false, so an SBI regular batch rides the REGULAR queue only (~75s in prod) and never the day queue.  
  `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/config.js:138-140, services/orders.js:2440, services/orders.js:2493, services/orders.js:1220-1230`
- **!** SBI-MTF has NO `limitBatchConfig` at all. So for sbi-mtf: limitConfigForLabel={}, bufferPercent falls back to env LIMIT_PRICE_BUFFER_PERCENT (3 in prod) and `ValidityForLabel` is undefined — a LIMIT sbi-mtf order is assigned `order.validity = undefined`. Also TV=0 so a large sbi-mtf batch is never forced to LIMIT by turnover value.  
  `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi-mtf/config.js (no limitBatchConfig key present), services/orders.js:2435-2440, services/orders.js:2483-2500, lib/utils.js:441-444, config.js:66`

### batch-force-finalize

- **!** SBI batches are FORCE-FINALIZED on the last poll. In batchExpireHandler, if bits remain set and `!hasDayOrder && pollCount === 1 && orderStatusBy.polling && !orderStatusBy.postback`, BB calls completeBatchOrSellLeg() and writes the FINAL Order document from whatever Redis holds. SBI matches this predicate exactly (polling true, postback false). This is why an SBI batch flips to UNFILLED/PARTIALLYFILLED/ERROR ~75s after placement even if the broker never answered.  
  `services/orders.js:3796-3806, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/config.js:58-61`
- If the bitmap is already empty at the top of batchExpireHandler (`setBitOffsets.length === 0`), BB finalizes immediately and returns false to stop polling.  
  `services/orders.js:3741-3745`

### batch-state-machine

- **!** Order.status (batch level) is written ONLY by babel's Order.saveOrder, in four states. INITIAL → status='ACKED' unconditionally. PLACED → 'PLACED' if every leg left ACKED and orders.length==quantity, else 'UNPLACED' if unplaced.length==quantity (completedDate stamped), else 'PARTIALLYPLACED'; then overridden to 'ERROR' if errorStatus is true. FINAL → calcTxnFields() decides, then overridden to 'ERROR' if errorStatus. AUTO → calcTxnFields() only (used by the dummy-order endpoint).  
  `node_modules/@smallcase/sc-integrations-babel/src/models/Order.js:10-118`
- **!** calcTxnFields (the FINAL status rule): filled>0 && quantity==filled → 'COMPLETED'; filled>0 && quantity>filled → 'PARTIALLYFILLED' (or 'MARKEDCOMPLETE' for SST); filled==0 && (buyAmount||sellAmount) → 'PARTIALLYFILLED'; filled==0 && variety==='amo' && every leg CANCELLED AMO → 'CANCELLED'; filled==0 && unplaced.length===quantity → 'UNPLACED'; otherwise → 'UNFILLED'. It also recomputes buyAmount/sellAmount from averagePrice×filledQuantity.  
  `node_modules/@smallcase/sc-integrations-babel/src/models/_util.js:9-55`
- **!** Every saveOrder appends an audit entry to `Order.meta.updates[]` (`{date, update}`) with literal strings: 'Order saved initially with status ACKED', 'Order saved with status <S>', 'Order saved finally with status <S>', 'Auto order saved with status <S>'. This array is the in-document history of a batch — read it before trusting the current status field.  
  `node_modules/@smallcase/sc-integrations-babel/src/models/Order.js:38, :67, :104, :116, :120-130`
- **!** Batch status enum (babel orderConsts.status): ACKED, PLACED, ERROR, UNPLACED, PARTIALLYPLACED, UNFILLED, PARTIALLYFILLED, COMPLETED, FIXED, MARKEDCOMPLETE, CANCELLED. Leg status enum (txnStatus): ACKED, PLACED, REJECTED, CANCELLED, COMPLETE, ERROR, 'CANCELLED AMO' (note the space), PARTIAL.  
  `node_modules/@smallcase/sc-integrations-babel/src/constants/order.js:19-31, :57-66`
- **!** `utils.isOrderSettled` treats a leg as settled only for COMPLETE, REJECTED, CANCELLED, 'CANCELLED AMO', PARTIAL (case-insensitive). ACKED, PLACED and ERROR are NOT settled — a leg in PLACED keeps its bitmap bit set and keeps the batch polling.  
  `lib/utils.js:699`

### leg-status-at-placement

- **!** Leg status at placement is set by objects.determineOrderStatus: initial hash → 'ACKED'; broker returned reason==='success' → 'PLACED' (+ orderId, redisIndex); anything else → 'ERROR' (+ statusMessage from the broker payload).  
  `lib/objects.js:15-37, services/orders.js:2799-2801`
- **!** On a failed placement BB immediately clears that leg's bitmap bit (`unSetBits` on BB:bitmap:<batchId>) so the batch is not held open by it. If the failure was a network error (err, or data.errorType==='NetworkException', or statusCode 502/504) it sets flags.error=true which becomes batch errorStatus → batch status ERROR; otherwise it is merely 'Order unplaced'.  
  `services/orders.js:2888-2899, config.js:64`

### redis-keys

- **!** Redis key prefixes (config.variables.prefix): BB:lock (batch update lock), BB:bitmap (outstanding legs), BB:orders (redisIndex→orderKey hash), BB:details (batch details hash), BB:order (per-order hash), BB:order:flag (early-postback flag), BB:order:count, BB:queue:lock, BB:stock:count, BB:stock:additional, BB:postbacks, API:SCL (scid lock). Concrete SBI examples: BB:bitmap:<batchId>, BB:orders:<batchId>, BB:details:<batchId>, BB:order:sbi:<tag>, BB:lock:<batchId>.  
  `config.js:42-56, lib/utils.js:527-541`
- **!** redisCleanup deletes BB:bitmap:<batchId>, BB:orders:<batchId>, BB:details:<batchId>, BB:lock:<batchId> and, for every orderKey in BB:orders:<batchId>, BB:order:<broker>:<orderKey> and BB:order:flag:<broker>:<orderKey>. It runs on successful FINAL save and on error-fix success — so for a finished batch these keys are GONE and only Mongo has the truth.  
  `lib/utils.js:508-527, services/orders.js:3454, services/errors.js:501-507`
- **!** The batch update lock `BB:lock:<batchId>` is set with a 7-day TTL at placement and DELETED by sendSmallcaseUpdate as the mutual-exclusion claim for finalization. If deleteLock returns 0 (lock absent) finalization is skipped entirely and logs 'Batch update lock did not exist for batch. smallcase update not sent'. A batch whose lock was already consumed can never be re-finalized by the normal path.  
  `lib/utils.js:744-746, services/orders.js:1174, services/orders.js:3335, services/orders.js:3342, services/orders.js:3478-3481`
- SBI-MTF margin lookup reads Redis hash `MTF:<sid>` field `sbi-mtf.<exchange lowercased>` and divides by 100, defaulting to 100 (i.e. 1.0) when absent. This happens twice: once building the broker options and once inside placeOrder.  
  `lib/utils.js:481-494, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi-mtf/config.js:101-103, services/orders.js:2550-2557, services/orders.js:2774-2789`

### fix-endpoint

- **!** POST /errors/fix/:batchId (and GET, same handler) is mounted on the root router. The handler merges `{...req.query, ...req.body}` into options, reads header `x-request-source` (default 'smallboard') into options.requestSource, 400s if no batchId, then delegates to errorsService.handle({batchId, options}) and returns HTTP 200 when handleRes.success is true, else HTTP 400 — with the whole handle() result as the JSON body.  
  `ou-server/routes.js:31-34, ou-server/controller.js:16-29`
- **!** handle() returns one of exactly four shapes: {batch:{batchId}, success:false, reason:'Invalid batchId', requestSource} when the batch is not in Order or SSTOrder; {batch, success:false, msg:'Error batch fixing will be retried', requestSource} when shouldRetry; {batch, success:true, msg:'Error Batch already fixed', requestSource} when nothing was modified and no retry; {batch:savedBatch, success:true, msg:'Error Batch fixed', requestSource} on a real fix; {batch, success:false, msg:'Internal Server Error', requestSource} on a thrown error.  
  `services/errors.js:509-547`
- **!** GOTCHA: HTTP 200 + 'Error Batch already fixed' means BB did NOTHING. fixBatch returns early with isModified=false whenever `!batch.errorStatus || batch.status !== 'ERROR'` and options.force is not set. A recon job that omits `force:true` against a batch sitting in UNFILLED/PARTIALLYFILLED gets a cheerful 200 and no write.  
  `services/errors.js:107-123, services/errors.js:523-530`
- **!** `options.force: true` does two distinct things: (1) it forcibly sets batch.errorStatus=true and batch.status='ERROR' so the guard passes, and (2) it skips the `batch.date < previousActiveDay()` age check in both fixBatchByOrderBook and fixBatchByOrderStatus (which otherwise throws "Cannot fix old batch with today's orderbook").  
  `services/errors.js:109-117, services/errors.js:172-174, services/errors.js:292-294`

### fix-mechanisms

- **!** FIXBY is a numeric enum in services/common.js: NONE=0, ORDERBOOK=1, POLLING=2, UNLOCKING=3, RETRY=4. The fixMechanisms map binds NONE→fixBatchByNone, RETRY→fixBatchByRetry, ORDERBOOK→fixBatchByOrderBook, POLLING→fixBatchByOrderStatus, UNLOCKING→fixBatchByUnlocking.  
  `services/common.js:9-15, services/errors.js:69-75`
- **!** There is NO 'tradebook' fixBy mode. The only accepted fixBy strings are (case-insensitively) 'none', 'orderbook', 'polling', 'unlocking', 'retry'. `tradebook` is a separate request-body PARAMETER consumed by fixBatchByOrderBook as a ready-made order book, skipping the broker call entirely.  
  `services/common.js:9-15, services/errors.js:118, services/errors.js:295-304`
- **!** fixBy resolution: `FIXBY[options.fixBy && options.fixBy.toUpperCase()] || triageErrorBatch(batch)`. An explicit fixBy therefore OVERRIDES the per-broker triage. For a supplied `fixBy:'orderbook'` the value is 1 (truthy) so triage never runs — this is how SBI batches get fixed despite triage saying NONE.  
  `services/errors.js:118-119`
- **!** Per-broker mechanisms are declared in one place only: the switch in triageErrorBatch (services/errors.js:126-160). kite/motilal→ORDERBOOK; leprechaun, kite-leprechaun, motilal-leprechaun→UNLOCKING; sbi→NONE; hdfc/hdfcpbg/axis/hdfc-leprechaun/hdfcpbg-leprechaun/axis-leprechaun/hdfc-mtf/axis-mtf→POLLING; groww/groww-leprechaun/smc→POLLING; icici/icici-leprechaun→POLLING; upstox/upstox-leprechaun→ORDERBOOK; default→NONE.  
  `services/errors.js:125-160`
- **!** 'sbi-mtf' is NOT a case in triageErrorBatch — it falls into `default: return FIXBY.NONE`. Same outcome as 'sbi' but via a different branch, and it means adding a mechanism for sbi would not cover sbi-mtf. Neither is 'sbi-leprechaun' or 'sbi-mtf-leprechaun'.  
  `services/errors.js:126-160`
- **!** FIXBY.NONE means literally 'call fixBatchByNone', which only logs '[ERRORS] No mechanism found to this error batch' and returns {} — so isModified=false and shouldRetry=false, and handle() answers HTTP 200 'Error Batch already fixed' having written nothing. It does NOT mean the batch is unfixable, only that no automatic mechanism is chosen for that broker.  
  `services/errors.js:162-165, services/errors.js:119-122, services/errors.js:523-530`

### fix-orderbook-path

- **!** fixBatchByOrderBook builds a tradeMap keyed by `t.tag` from the tradebook/orderbook rows, then classifies with treatMissingAsPending=false. A leg absent from the tradebook is marked UNPLACED/rejected. If any leg comes back pending it returns {shouldRetry:true} WITHOUT saving. Otherwise it stamps completedDate, replaces batch.orders/unplaced/filled, sets errorStatus=false and returns {isModified:true}.  
  `services/errors.js:291-343`
- **!** markOrderUnplaced sets leg status='ERROR', deletes orderId, defaults statusMessage to 'NA'; when statusMessage was 'NA' AND requestSource is set it instead writes statusMessage='Marked as rejected as no update received from the broker' and errorCode='markedRejected'; otherwise errorCode comes from the broker config's getErrorCode(). It always stamps `meta.reconciled = true`.  
  `services/errors.js:411-437`
- **!** markOrderSettled copies filledQuantity, averagePrice, status, orderId, exchangeOrderId, orderTimestamp and statusMessage from the tradebook row onto the leg, computes errorCode for non-COMPLETE legs, and stamps `meta.reconciled = true`. Grep a leg's `meta.reconciled` in Mongo to prove it was touched by the fix path rather than by a live poll.  
  `services/errors.js:439-469`

### fix-provenance

- **!** On a successful fix, handle() stamps `batch.meta.source = requestSource` before saving. Values seen in practice: 'sc-integrations-jobs' (all recon jobs set header x-request-source) and 'smallboard' (the default when no header). Order.meta.source is the definitive answer to 'who fixed this batch'.  
  `services/errors.js:532-535, ou-server/controller.js:20-22`
- After a successful fix, handle() also calls utils.updateUserHoldings(savedBatch, platformApiService) → POSTs the batch to platform-api, then removeRedisMetadata (redisCleanup), then postProcessOrderHelper which produces to Kafka ORDER_finished (or ORDER_errored) and, if still errored, schedules another retry.  
  `services/errors.js:535-541, services/common.js:28-50, lib/utils.js:240-252`

### fix-retry-backoff

- Error retry cadence is 1 min × 5, then 5 min × 5, then 15 min × 24 = 34 attempts spanning 390 minutes (6.5 hours), not ~6h as the in-repo doc says. retryErrorOrder gives up with '[ERRORS] Retry limit reached' once attempt >= 34.  
  `services/errors.js:77-96, docs/error-reconciliation.md:86-90`
- Error retry channels are pre-created at boot for the three unique intervals (60, 300, 900 s) by initErrorRetryChannels(), which index.js awaits before starting the HTTP server and Kafka consumers. Each is a Poll with maxPollCount:1 and identifier:'error'.  
  `services/errors.js:28-46, index.js:14-23`

### rabbitmq-delay

- Polling delay is implemented with RabbitMQ per-interval TTL queues named `ORDERS_<interval>_SEC_DELAY` bound to exchange ORDERS_EXCHANGE with routing key `ORDERS_RK_<interval>_SEC_DELAY`, dead-lettering into the single COLLECTOR_QUEUE via COLLECTOR_QUEUE_RK. Every Poll instance listens on COLLECTOR_QUEUE and filters the dequeued message by matching both `interval` and `identifier`. Live intervals: 3 (regular), 600 (day), 900 (amo/activated AND error retries), 60 and 300 (error retries).  
  `lib/amqp.js:39-68, lib/amqp.js:89-141, lib/poll.js:23-52, config.js:318-336`
- Because PREVIEW_ENV is unset in production, config.queueSuffix is '' and the queue/exchange names are unsuffixed: ORDERS_EXCHANGE, COLLECTOR_QUEUE, ORDERS_<n>_SEC_DELAY, CAS_POLL_EXCHANGE, CAS_POLL_DELAY, CAS_POLL_START.  
  `config.js:40, config.js:318-330, deployment/infra/production-sc-integrations-order-updates-env.yaml (no PREVIEW_ENV key)`
- Every error-retry tick emits 'polling limit reached for the following batch' because error Poll objects use maxPollCount:1, so pollsLeft is always 0 after the single handler run. This log line is NORMAL for error retries and does NOT mean retries stopped — retryErrorOrder re-queues explicitly on the next interval.  
  `lib/poll.js:36-52, services/errors.js:36-40, services/errors.js:84-96`

### kafka

- **!** Two Kafka consumers only. Group 'smallcase-order-updates-amo' subscribes to topic ORDER_amoPoll; its handler amoTrigger({accessToken,batchId,sstOrder}) just calls ordersService.pollForBatch. Group 'smallcase-order-updates-regular' subscribes to topic ORDER_conciliation; its handler handleUpdate camel-cases the payload and routes to handleSipUpdate (if a brokerSipId is derivable from tags) or handleOrderUpdate. There are no other consumers.  
  `consumer/index.js:46-91, consumer/amoPoll.js:9-36, consumer/orderConcile.js:10-48, connections/events.js:22-54`
- BB PRODUCES to topics ORDER_placed, ORDER_finished, ORDER_errored (and the SST_-prefixed variants for SST batches). ORDER_placed is produced right after the PLACED save; ORDER_finished/ORDER_errored are produced by postProcessOrderHelper keyed on batch.errorStatus.  
  `config.js:57-63, services/orders.js:96-101, services/orders.js:1171, services/common.js:28-42`
- The regular consumer processes messages with eachBatch in sub-batches of QUEUE_CONCURRENCY (=1 in prod) and commits only the last offset of each sub-batch; a handler throw is swallowed and logged by the wrapper, so a poison message is logged and skipped, never retried.  
  `consumer/index.js:18-43, consumer/index.js:65-86, config.js:75`

### order-update-ingest

- **!** handleOrderUpdate is the single funnel for every status change — broker postbacks, poll responses (brokerPoll calls it on res.code) and flagged early postbacks (redisPoll calls it). It looks up BB:order:<broker>:<orderKey>; if that hash is missing it only logs 'Postback flagged' and stores a flag; if present and the status is settled (or hash.validity==='DAY') it sanity-checks, merges the update into Redis, and on settle clears the bitmap bit via unSetBits. When the bitmap reaches zero it logs 'All orders in batch resolved sending update' and calls completeBatchOrSellLeg.  
  `services/orders.js:1480-1594, services/orders.js:3556-3572, services/orders.js:3588-3592`
- **!** checkUpdateForSanity rejects an update (logged as 'Malformed order update', the update is DROPPED) when: quantity mismatch vs (placed quantity − nettedOffQuantity); filledQuantity > that broker quantity; brokersymbol mismatch; or filledQuantity > 0 with averagePrice 0. A broker sending a filled update with zero average price silently loses that update.  
  `lib/utils.js:576-589, services/orders.js:1505-1511`

### finalization

- **!** sendSmallcaseUpdate re-derives every leg's final status from the Redis hashes, not from Mongo: filledQuantity>0 && <quantity → PARTIAL; filledQuantity===0 && status COMPLETE → downgraded to CANCELLED; status still PLACED → sets errorStatus=true for the whole batch; missing filledQuantity is back-computed as quantity − pendingQuantity. Then it saves state FINAL.  
  `services/orders.js:3366-3438`
- **!** Two hard finalization aborts, both of which leave the batch stuck in its pre-final state: (a) any Redis order hash comes back null → logs 'redis contains null elements.' and returns; (b) zero Redis orders found → logs 'Skipping finalization for batch without Redis orders' and returns. Both are prime suspects for an SBI batch stuck in PLACED/PARTIALLYPLACED.  
  `services/orders.js:3353-3364`

### place-order-path

- **!** Placement path is: POST /orders/place → ordersController.placeOrders → utils.sanitizeOrderRequest → casService.resolveCASContext (when applicable) → orderPlacement.placeOrdersWithCAS → getQueryStringForPlaceOrders (symbol lookup, tick, limit price, tag) → Order.saveOrder INITIAL → setBitMap → placeOrderWrapper SELL first, then (after BB_TIMEOUT_AFTER_ALL_SELL_ORDERS, default 2s) BUY → placeOrder → brokerApi.placeOrder → Order.saveOrder PLACED → setBatchDetails/setLockForBatch → poll queue start.  
  `ou-server/controller.js:31-101, services/orders.js:1431-1474, services/orders.js:884-1307, config.js:65`
- If a batch ends up with zero placed orders (savedBatch.orders.length === 0), BB deletes BB:bitmap:<batchId> and finishes immediately without any polling — postProcessOrder fires straight away. Such a batch will be UNPLACED (or ERROR if flags.error) and will never appear in poll logs.  
  `services/orders.js:1272-1295`

### config-env

- Behaviour-changing env vars: BB_PLACEORDERS_PORT (default 8005; prod sets BB_ORDERUPDATES_PORT=8005 which config.js does NOT read — so the port is the 8005 default), REGULAR/DAY/AMO_POLL_COUNT_LIMIT, QUEUE_CONCURRENCY, AMO/REGULAR_BATCH_SIZE & _MIN_SIZE, AMO/REGULAR_PARTITION_CONCURRENCY, BB_TIMEOUT_AFTER_ALL_SELL_ORDERS, LIMIT_PRICE_BUFFER_PERCENT, POSTBACK_FLAG_TTL, KEEPALIVE_TIMEOUT/HEADERS_TIMEOUT, DEBUG, MONGO_DEBUG, CAS_CONFIG_KEY/CAS_CONFIG_CACHE_TTL_MS, PREVIEW_ENV (queue suffix).  
  `config.js:13-131, deployment/infra/production-sc-integrations-order-updates-env.yaml:16-17, :91-102`
- **!** SBI production endpoints: SBI_API_ENDPOINT and SBI_MTF_API_ENDPOINT are BOTH https://fhapi.sbisecurities.in. SBI leprechaun is https://leprechaun.prod.smallcase.com/sbi. DEBUG is 'true' in production, so consumer/orderConcile.js and consumer/amoPoll.js emit their per-message debug lines.  
  `deployment/infra/production-sc-integrations-order-updates-env.yaml:97, :142-145`
- config.brokers.sbi/sbi-leprechaun/sbi-mtf all read `process.env.SBI_API_KEY`, but broker-lib's SBI config reads `process.env.SBI_APP_KEY` / `SBI_SECRET_KEY`. The apiKey OU injects into poll/place options therefore comes from a different env var than the one broker-lib actually authenticates with.  
  `config.js:211-223, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/config.js:6-12, services/orders.js:3578, services/errors.js:188`

### dependency-version-caveat

- **!** DANGER: the node_modules in this checkout does NOT match production. package-lock.json (committed, unmodified, on branch production) pins @smallcase/sc-integrations-broker-lib 16.11.15 and @smallcase/sc-integrations-babel 6.3.2, but the installed trees are 16.11.13-rebalance-in-amo.1 and 6.3.3-rebalance-in-amo.2. Every broker-lib/babel fact read from node_modules here is from the rebalance-in-amo pre-release, not the production artifact.  
  `package.json:23-24, package-lock.json:559-563, package-lock.json:610-615, node_modules/@smallcase/sc-integrations-broker-lib/package.json:2-3, node_modules/@smallcase/sc-integrations-babel/package.json:2-3`

### sbi-branching

- **!** `grep -ri sbi` across all non-test JS in this repo returns only THREE runtime hits: the four config.brokers entries (sbi, sbi-leprechaun, sbi-mtf, sbi-mtf-leprechaun), the `case 'sbi': return FIXBY.NONE` in triageErrorBatch, and a comment in lib/utils.js. There is no other SBI-specific branching in order-updates — all SBI behaviour comes from broker-lib config flags read generically.  
  `config.js:211-223, services/errors.js:135-136, lib/utils.js:484`

### two-step

- SBI has `twoStepRebalanceEnabled: true` and `rebalanceInAMOEnabled: true` in broker-lib, so an SBI REBALANCE batch can run the two-step path: SELL legs placed first, bitmap sized to sells only, and the BUY leg deferred to POST /orders/twostep/buy-leg or a queued trigger with identifier twoStepRebalanceService.QUEUE_IDENTIFIER. Two-step batches carry `meta.twoStep` on the Order and `twoStep:'true'` in BB:details, and finalization is gated by twoStepRebalanceService.validateFinalization.  
  `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/config.js:84-85, services/orders.js:913-918, services/orders.js:1087-1088, services/orders.js:986-994, services/orders.js:3301-3326, lib/objects.js:511-513, services/orders.js:76-84`

### order-mode

- POST /orders/determineOrderMode returns LIMIT for SBI/SBI-MTF whenever amoFlag is true (both set onlyLimitAmoAllowed:true, reason 'onlyLimitAmoAllowed is true and AMO flag is true', marketOrderBlocked:true), or when the CAS session is CAS_LIMIT_ONLY (reason 'CAS_LIMIT_ONLY'), or — SBI only — when buyAmount+sellAmount >= TV 10,000,000 (reason 'TV met'). Otherwise MARKET.  
  `services/orders.js:738-848, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/config.js:80, :138-140, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi-mtf/config.js:80`

### smallboard-auth

- **!** The /smallboard/* routes require header `x-domain-token` matching SMALLBOARD_INTERNAL_API_TOKEN (config.smallboardService.clientToken, default 'test') or return 401. The root router (including /errors/fix/:batchId) and /sst/* have NO authentication middleware at all — anything that can reach the pod's port 8005 can fix a batch.  
  `ou-server/controller.js:374-383, ou-server/routes.js:9-49, ou-server/app.js:28-30, config.js:396-398`

### write-surface

- **!** Everything that can mutate an Order document from this service: placeOrders (INITIAL/PLACED), sendSmallcaseUpdate/completeBatchOrSellLeg (FINAL), errorsService.handle via POST /errors/fix/:batchId (FINAL), createBatch via POST /orders/dummyOrder (AUTO), deleteBatch via DELETE /batch/orders and DELETE /orders/dummyOrder, updateOrderFields via PATCH /smallboard/orders, stampSupersededBatch via PATCH /orders/stamp-superseded, markPreviousBatchFixed (sets previous batch to FIXED when a FIX-label batch is placed), and archiveOrder.  
  `services/orders.js:1041-1077, services/orders.js:1123-1151, services/orders.js:3437-3439, services/errors.js:491-499, services/orders.js:1927-1936, services/orders.js:1945-1956, ou-server/controller.js:834-917, services/orders.js:3530-3540`


## Grep targets (146)

Search with `fetch-by-identifier.js --service <svc> --text "<string>"`.

| String | Means | Emitted by | Citation |
|---|---|---|---|
| `Order placement request received` | Entry of a batch into BB. context carries the full batch, investedSmallcase, context, requestId, correlationId, userId, clientDetails. The batchId is minted one line earlier, so this is the FIRST line for a new batchId. | orderPlacement.placeOrdersWithCAS _(lvl info)_ | `services/orders.js:886-891` |
| `Place order request received ->` | Raw HTTP body + headers dump for POST /orders/place, type API_REQUEST. user object is stripped, only userId kept. | ordersController.placeOrders _(lvl info)_ | `ou-server/controller.js:57-72` |
| `Order placement successful` | POST /orders/place returned 200 with the batch. | ordersController.placeOrders callback _(lvl info)_ | `ou-server/controller.js:95` |
| `Error in order placement` | Non-validation failure from placeOrders; response is HTTP 500. | ordersController.placeOrders callback _(lvl error)_ | `ou-server/controller.js:89` |
| `Error in sanitizing order request` | utils.sanitizeOrderRequest threw (bad transactionType/quantity/exchange/sid/nettedOffQuantity). Batch was never created; HTTP 400. | placeOrders _(lvl error)_ | `services/orders.js:1436-1443, lib/utils.js:591-600` |
| `Options object created` | Per-leg broker options built (pre-tag). context.options holds the full orderToBrokerOptions for one stock. | getQueryStringForPlaceOrders _(lvl info)_ | `services/orders.js:2546` |
| `Error in qs formation` | Symbol/tick/price resolution failed for a leg; that leg goes into the error bucket and is never placed. | getQueryStringForPlaceOrders _(lvl error)_ | `services/orders.js:2536, services/orders.js:2587` |
| `Batch saved` | Emitted TWICE per batch — once after the INITIAL save and once after the PLACED save. context.batch holds the full saved document (stringified). Distinguish by the document's status field (ACKED vs PLACED/PARTIALLYPLACED/UNPLACED/ERROR). | placeOrdersWithCAS (INITIAL cb, then PLACED cb) _(lvl info)_ | `services/orders.js:1085, services/orders.js:1159` |
| `Error in initial batch saving` | Misleading name — this exact string is used for the INITIAL save failure, the waterfall placement failure AND the PLACED save failure. Check the surrounding lines to tell which. | placeOrdersWithCAS _(lvl error)_ | `services/orders.js:1081, services/orders.js:1119, services/orders.js:1155` |
| `Error in setting bitmap` | setBitMap lua failed; the batch has no outstanding-leg tracking and will not finalize normally. | placeOrdersWithCAS _(lvl error)_ | `services/orders.js:1090` |
| `Order placed` | Broker accepted one leg (data.reason === 'success'). context.order is the full PLACED hash including orderId, orderKey (= tag for SBI), redisIndex, tag, margin, product. | placeOrder _(lvl info)_ | `services/orders.js:2849` |
| `Order unplaced` | Broker rejected one leg with a NON-network error. The bitmap bit is cleared. Batch errorStatus is NOT set by this path. | placeOrder _(lvl info)_ | `services/orders.js:2898` |
| `NetworkException in placeOrder` | Placement failed with err, or errorType 'NetworkException', or HTTP 502/504. Sets flags.error=true → batch status becomes ERROR. This is the line that turns a batch into an ERROR batch at placement time. | placeOrder _(lvl warn)_ | `services/orders.js:2891-2894` |
| `NetworkException in holdSecurity` | Security.hold call failed with a network-class error; sets flags.error=true. SBI has securitiesHoldRequired:true so this runs for SBI sells. | holdSecurity _(lvl warn)_ | `services/orders.js:2703, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/config.js:56` |
| `Margin fetched from Redis for MTF broker` | SBI-MTF only (mtfBroker:true). Logged once per leg during option building; context has margin, broker, order. Absence for an sbi-mtf batch means the MTF:<sid> lookup path did not run. | getQueryStringForPlaceOrders _(lvl info)_ | `services/orders.js:2554` |
| `Margin fetched from Redis` | Second SBI-MTF margin fetch, inside placeOrder. NOTE: emitted via logInfo(err, ...) so the first arg is an error object — the message argument is what you grep. | placeOrder → fetchMargin _(lvl info)_ | `services/orders.js:2786` |
| `Error fetching margin from Redis, continuing without margin` | SBI-MTF margin lookup failed in placeOrder; the order is placed with no margin field. | placeOrder → fetchMargin _(lvl warn)_ | `services/orders.js:2783` |
| `broker action - placeOrder` | Wrapper message on EVERY broker-lib place call, type SC_BROKER. The broker-lib payload ({broker, msg, details:{request,response,health}}) is nested under context.extra.data for info and context.data.data for warn/error. context.health is promoted to a top-level searchable field when broker-lib supplies it. | lib/brokerApi.js getStringifiedLogger _(lvl info/warn/error)_ | `lib/brokerApi.js:61-64, lib/logger.js:74-171` |
| `broker action - orderStatus` | Wrapper message on EVERY SBI status poll (SBI's only status channel). type SC_BROKER. | lib/brokerApi.js getStringifiedLogger _(lvl info/warn/error)_ | `lib/brokerApi.js:24-31, lib/brokerApi.js:61-64` |
| `broker action - orderBook` | Wrapper for Orders.list. Should NEVER appear for sbi/sbi-mtf — they have no Orders.list. | lib/brokerApi.js getStringifiedLogger _(lvl info/warn/error)_ | `lib/brokerApi.js:27, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/api.js:288` |
| `broker action - deleteOrder` | Wrapper for Orders.delete (AMO cancel / day-order cancel). | lib/brokerApi.js getStringifiedLogger _(lvl info/warn/error)_ | `lib/brokerApi.js:28` |
| `broker action - securityHold` | Wrapper for Security.hold — runs for SBI sells (securitiesHoldRequired true). | lib/brokerApi.js getStringifiedLogger _(lvl info/warn/error)_ | `lib/brokerApi.js:29` |
| `Broker API endpoint does not exist` | type SC_BROKER_META. The requested broker function is not implemented for this broker — for SBI this fires on any orderBook attempt. context has broker, functionName. | lib/brokerApi.js brokerApi[functionName] _(lvl error)_ | `lib/brokerApi.js:46-53` |
| `Broker Poll initiated` | About to call Orders.status for one leg. TWO distinct emitters with different context shapes: services/orders.js version has orderStatusOptions + requestId; lib/brokerApiUtils.js version (used only by the error-fix POLLING path) has order + no requestId. | orders.js brokerPoll AND lib/brokerApiUtils.brokerPoll _(lvl info)_ | `services/orders.js:3582, lib/brokerApiUtils.js:11` |
| `Broker Poll Response` | Broker returned res.code truthy. context.response (orders.js) or context.res (brokerApiUtils) holds the full broker payload. The response is then fed into handleOrderUpdate. | orders.js brokerPoll AND lib/brokerApiUtils.brokerPoll _(lvl info)_ | `services/orders.js:3589, lib/brokerApiUtils.js:24` |
| `Broker poll error` | Orders.status called back with an error. The leg keeps its bitmap bit; the batch will be polled again. | orders.js brokerPoll _(lvl error)_ | `services/orders.js:3585` |
| `Broker poll failed` | Orders.status returned without res.code (a structurally-invalid/negative broker response). Not an exception — the update is simply discarded. | orders.js brokerPoll AND lib/brokerApiUtils.brokerPoll _(lvl warn)_ | `services/orders.js:3594, lib/brokerApiUtils.js:29` |
| `Checking flagged postbacks` | redisPoll checking BB:order:flag:<broker>:<orderKey> before hitting the broker. Only runs for brokers where orderStatusBy.postback is true — so NOT for SBI. | redisPoll _(lvl info)_ | `services/orders.js:3557, services/orders.js:3747-3766` |
| `Order update received` | Entry point of every status change (poll response, postback, or flagged replay). context has the raw order, broker, orderKey. For SBI orderKey === tag. | module.exports.handleOrderUpdate _(lvl info)_ | `services/orders.js:1488` |
| `Order update to ingest` | The update passed the sanity check and the merged orderUpdate is about to be written to Redis. context.order is the merged hash; context.batchId is present. This is the strongest per-leg 'BB accepted this update' proof. | handleOrderUpdate _(lvl info)_ | `services/orders.js:1540` |
| `Malformed order update` | checkUpdateForSanity threw — quantity mismatch, over-fill, brokersymbol mismatch, or filled with zero average price. THE UPDATE IS DROPPED SILENTLY (resolve() with no state change). | handleOrderUpdate _(lvl warn)_ | `services/orders.js:1509, lib/utils.js:576-589` |
| `Malformed order update: ` | Prefix of the logError message when orderKey is missing or the broker is unknown: `Malformed order update: order key missing` or `Malformed order update: No such broker: ${broker}`. | handleOrderUpdate _(lvl error)_ | `services/orders.js:1491-1494` |
| `Postback flagged` | An update arrived for an orderKey that has NO Redis hash yet (postback beat the placement write). If status is COMPLETE/REJECTED/CANCELLED it is stashed in BB:order:flag:<broker>:<orderKey> for later replay. For SBI (polling-only) this usually means the Redis order hash was cleaned up or never written. | handleOrderUpdate _(lvl info)_ | `services/orders.js:1584-1591` |
| `Error in getting key at BB:order:<broker>:<orderKey>` | Redis hgetall failed while reading the order hash; the update is abandoned. | handleOrderUpdate _(lvl error)_ | `services/orders.js:1498` |
| `Error in setting key at BB:order:<broker>:<orderKey>` | Redis hmset failed writing the merged update; the leg keeps its old Redis state and its bitmap bit. | handleOrderUpdate _(lvl error)_ | `services/orders.js:1543` |
| `Error in unsetting key at BB:bitmap:<batchId>` | unSetBits lua failed — the leg settled but its bit stays set, so the batch will keep polling and may be force-finalized. | handleOrderUpdate _(lvl error)_ | `services/orders.js:1558` |
| `All orders in batch resolved sending update` | Bitmap hit zero — every leg settled. Triggers completeBatchOrSellLeg → finalization. context has batchId, order, orderKey. | handleOrderUpdate _(lvl info)_ | `services/orders.js:1563` |
| `brokeruserId is undefined` | The update carried no broker user id from any of userId/placedBy/brokeruserId/hash.brokeruserId; the string 'undefined' is persisted. | handleOrderUpdate _(lvl error)_ | `services/orders.js:1535-1537` |
| `ordermeta.details null` | batchExpireHandler found no BB:details:<batchId> — the batch was already finalized and cleaned up, or Redis lost it. Polling continues (returns true) but does nothing useful. | batchExpireHandler _(lvl info)_ | `services/orders.js:3733-3739` |
| `Batch update lock did not exist for batch. smallcase update not sent` | BB:lock:<batchId> was already consumed, so finalization is skipped entirely. A batch stuck mid-state with this line is a strong signal of a double-finalize race. | sendSmallcaseUpdate _(lvl info)_ | `services/orders.js:3479` |
| `redis contains null elements.` | At least one BB:order:<broker>:<orderKey> hash was missing during finalization. Finalization ABORTS — batch stays in its pre-FINAL status. Historically seen with duplicate broker orderIds. | sendSmallcaseUpdate _(lvl error)_ | `services/orders.js:3353-3358` |
| `Skipping finalization for batch without Redis orders` | BB:orders:<batchId> resolved to an empty list. Finalization ABORTS. Prime suspect for a batch stuck in PLACED. | sendSmallcaseUpdate _(lvl warn)_ | `services/orders.js:3360-3363` |
| `Batch saved in ERROR state` | The FINAL save produced errorStatus=true → Order.status='ERROR'. postProcessOrder then produces to ORDER_errored and enqueues the error-retry backoff. context.order is the full saved batch. | sendSmallcaseUpdate _(lvl info)_ | `services/orders.js:3446` |
| `Batch processing finished` | Clean terminal success. context has batchId, iscid, requestId, userId, errorStatus, brokeruserId, batchTime (seconds from batch.date), broker. batchTime is the end-to-end batch duration. | sendSmallcaseUpdate _(lvl info)_ | `services/orders.js:3457-3466` |
| `Error in final batch saving` | Order.saveOrder FINAL failed after its internal retries (message is suffixed ' after N retries'). The batch never reaches its final status. | sendSmallcaseUpdate _(lvl error)_ | `services/orders.js:3441, node_modules/@smallcase/sc-integrations-babel/src/models/_util.js:63-73` |
| `Cleaning up redis keys` | redisCleanup running — after this, BB:bitmap/orders/details/lock/order/order:flag for the batch are gone. Anything you needed from Redis must be read before this line. | utils.redisCleanup _(lvl info)_ | `lib/utils.js:510` |
| `[ERRORS] Error Order fixing request received` | Entry to errorsService.handle. context has batch, batchId, options (including fixBy, force, tradebook), attempt, requestSource. THE line to grep to answer 'did anything try to fix this batch'. | services/errors.js handle _(lvl info)_ | `services/errors.js:511` |
| `[ERRORS] Fix batch result` | Outcome of fixBatch: context has batchId, isModified, shouldRetry, requestSource. isModified=false && shouldRetry=false means NOTHING was written despite an HTTP 200. | services/errors.js handle _(lvl info)_ | `services/errors.js:522` |
| `[ERRORS] Error fix completed` | The batch was actually saved, holdings updated, Redis cleaned and post-processed. Definitive 'this batch was fixed'. | services/errors.js handle _(lvl info)_ | `services/errors.js:540` |
| `[ERRORS] Error occured while fixing ERROR batch` | fixBatch or the save/holdings/cleanup chain threw. Response is HTTP 400 with msg 'Internal Server Error'. | services/errors.js handle _(lvl error)_ | `services/errors.js:544` |
| `[ERRORS] No mechanism found to this error batch` | fixBatchByNone ran — i.e. triage chose NONE (sbi, sbi-mtf, and every unlisted broker) and no explicit fixBy was supplied. Nothing was written. THIS is the SBI default-path line. | fixBatchByNone _(lvl info)_ | `services/errors.js:163` |
| `Error fetching tradebook` | getOrderBook() threw inside fixBatchByOrderBook. For SBI this is 'order book api not supported by this broker'. Returns shouldRetry:true → HTTP 400 'Error batch fixing will be retried'. | fixBatchByOrderBook _(lvl error)_ | `services/errors.js:301` |
| `order book api not supported by this broker` | brokerEndpointExists(broker,'orderBook') was false. Guaranteed for sbi and sbi-mtf. Means the caller MUST supply options.tradebook. | getOrderBook _(lvl error)_ | `services/errors.js:473-477` |
| `OrderBook retreival from broker failed` | Orders.list returned without code+payload. (Note the misspelling 'retreival'.) Unreachable for SBI. | getOrderBook _(lvl n/a (thrown Error message))_ | `services/errors.js:487` |
| `Cannot fix old batch with today's orderbook` | Thrown when batch.date < previousActiveDay() and options.force is falsy, in BOTH fixBatchByOrderBook and fixBatchByOrderStatus. Surfaces as HTTP 400 msg 'Internal Server Error'. Fix: pass force:true. | fixBatchByOrderBook / fixBatchByOrderStatus _(lvl n/a (thrown, then logged by handle's catch))_ | `services/errors.js:172-174, services/errors.js:292-294` |
| `[ERRORS] Scheduling retry` | Next retry queued. context has batchId, attempt, nextAttempt, interval (60/300/900 seconds). | retryErrorOrder _(lvl info)_ | `services/errors.js:93` |
| `[ERRORS] Retry limit reached` | attempt >= 34. BB will never retry this error batch again on its own. context has batchId, attempt, maxAttempts. | retryErrorOrder _(lvl info)_ | `services/errors.js:87` |
| `[ERRORS] Saving batch with pending orders and newly settled orders before retry` | POLLING fix path partially advanced the batch (some legs settled, some still pending). Only emitted when settledOrders.length > 0. Not an SBI path unless fixBy=polling is forced. | fixBatchByOrderStatus _(lvl info)_ | `services/errors.js:218-226` |
| `[ERRORS] Error saving batch with pending orders` | The partial save above failed. | fixBatchByOrderStatus _(lvl error)_ | `services/errors.js:231` |
| `[ERRORS] Initializing error retry channels` | Boot-time creation of the 60/300/900 second error Poll objects. context.intervals = [60,300,900]. | initErrorRetryChannels _(lvl info)_ | `services/errors.js:32` |
| `[ERRORS] Error retry channels initialized` | Error retry infrastructure is live; the HTTP server starts after this. | initErrorRetryChannels _(lvl info)_ | `services/errors.js:45` |
| `[ERRORS] Poll object not pre-initialized, creating on-demand` | An interval was requested that initErrorRetryChannels did not pre-create — should not happen; indicates the retryBackOff table and the boot init drifted apart. | getPollObj _(lvl warn)_ | `services/errors.js:58` |
| `Batch with id ${batch.id} has multiple order timestamps` | The fixed batch's legs span more than one calendar date — the supplied tradebook mixed days. Interpolated with the batch id. | fixBatchByOrderBook _(lvl info)_ | `services/errors.js:334-336` |
| `Marked as rejected as no update received from the broker` | Not a log line — the statusMessage WRITTEN onto a leg (with errorCode 'markedRejected') when the fix could not find it in the tradebook and requestSource was set. Grep Mongo Order.orders[].statusMessage for it to find legs killed by a recon job rather than by the broker. | markOrderUnplaced / markOrderSettled _(lvl n/a (persisted field))_ | `services/errors.js:420-423, services/errors.js:458-461` |
| `markedRejected` | Not a log line — the errorCode value stamped alongside the statusMessage above. Distinguishes recon-forced rejections from broker-reported ones. | markOrderUnplaced / markOrderSettled _(lvl n/a (persisted field))_ | `services/errors.js:422, services/errors.js:460` |
| `polling limit reached for the following batch` | A Poll instance exhausted its pollCount. For ERROR retries (maxPollCount:1) this fires on EVERY tick and is normal. For the regular/day/amo queues it means the batch ran out of polls. context is the whole dequeued message (batchId, interval, identifier, pollCount). | Poll.internalValidationFunction _(lvl info)_ | `lib/poll.js:46-51` |
| `Poll request received` | GET /orders/poll/:batchId hit. context has batchId, accessToken, isSSTOrder. | ordersService.pollForBatch _(lvl info)_ | `services/orders.js:1864` |
| `orderDetails not found` | pollForBatch could not read BB:details:<batchId> — the batch is already cleaned up or never got details written. No poll is scheduled. | pollForBatch _(lvl error)_ | `services/orders.js:1880` |
| `Batch polling skipped` | Placement deliberately scheduled NO polling because label is AUTOSIP or the batch is activated/autoSip. context has requestId, batchId, broker, label, activated. | placeOrdersWithCAS finishPlacement _(lvl info)_ | `services/orders.js:1209-1215` |
| `CAS batch polling deferred` | Poll request arrived before cas.pollAfter; nothing scheduled. context has batchId, casSession, pollAfter. | pollForBatch _(lvl info)_ | `services/orders.js:1887-1891` |
| `CAS batch polling already started` | The CAS:poll:started:<batchId> lock was already held; a duplicate CAS start was suppressed. | startCASPollingOnce _(lvl info)_ | `services/orders.js:1330` |
| `CAS batch polling started` | CAS-delayed polling actually began for this batch. | startCASPollingOnce _(lvl info)_ | `services/orders.js:1339` |
| `CAS batch polling scheduled` | A CAS poll wake-up was published to the CAS delay queue. | scheduleCASPollStart _(lvl info)_ | `services/orders.js:1374` |
| `Failed to schedule CAS batch polling` | Publishing the CAS delay message failed; the batch may never be polled. context has requestId, batchId, broker, pollAfter. | placeOrdersWithCAS finishPlacement _(lvl error)_ | `services/orders.js:1194-1203` |
| `NSE closing auction session applies to batch` | CAS context resolved as applicable for this batch's sids. | services/cas.js _(lvl info)_ | `services/cas.js:131` |
| `onlyLimitAmoAllowed is true and AMO flag is true, returning LIMIT` | determineOrderMode forced LIMIT because the broker (SBI and SBI-MTF both) forbids MARKET AMOs. Response carries marketOrderBlocked:true. | determineOrderMode fallbackOrderMode _(lvl info)_ | `services/orders.js:755` |
| `TV met, returning LIMIT` | buyAmount+sellAmount >= the broker's limitBatchConfig TV (10,000,000 for SBI; never for SBI-MTF which has no TV). context has broker, totalAmount, TV. | determineOrderMode fallbackOrderMode _(lvl info)_ | `services/orders.js:760` |
| `OrderMode determination request` | type API_REQUEST. Full body+headers plus a flat searchable context (requestId from x-amzn-trace-id, userId, broker, label, amoFlag, buyAmount, sellAmount, sids). | ordersController.determineOrderMode _(lvl info)_ | `ou-server/controller.js:138-142` |
| `OrderMode determined` | type API_REQUEST. The decision: orderMode, reason, bufferPercent, marketOrderBlocked, plus the raw response. | ordersController.determineOrderMode _(lvl info)_ | `ou-server/controller.js:183-187` |
| `OrderMode determination request failed validation` | Missing/ill-typed broker, buyAmount, sellAmount, label, amoFlag or sids; HTTP 400. | ordersController.determineOrderMode _(lvl warn)_ | `ou-server/controller.js:147` |
| `API request` | type RESPONSE_LOG, emitted on res.finish for EVERY HTTP request. context has url, statusCode, method, responseTime (ms). Use this to find every /errors/fix/<batchId> call and its status code and latency. | ou-server/app.js middleware _(lvl info)_ | `ou-server/app.js:15-27` |
| `Listening for place orders on: ` | Startup line, suffixed with the port (8005 in prod). | ou-server/app.js start _(lvl info)_ | `ou-server/app.js:38, config.js:100` |
| `connected to rabbitmq instance` | AMQP connection up — required before any poll or error retry can be scheduled. | lib/amqp.js AMQP.Connect _(lvl info)_ | `lib/amqp.js:79` |
| `connection to rabbit mq cluster failed` | FATAL. No polling and no error retries at all while this persists. | lib/amqp.js AMQP.Connect _(lvl fatal)_ | `lib/amqp.js:72` |
| `disconnected from rabbit mq cluster` | Transient AMQP drop; in-flight delay messages may be redelivered. | lib/amqp.js AMQP.Connect _(lvl warn)_ | `lib/amqp.js:76` |
| `failed to enforce queue args in rabbitmq` | assertQueue/assertExchange failed — usually a pre-existing queue with mismatched args (ttl/dead-letter/quorum). Delay queues will not work. | lib/amqp.js _(lvl fatal)_ | `lib/amqp.js:68, lib/amqp.js:118` |
| `listening for messages on rabbitmq` | A consumer attached to COLLECTOR_QUEUE. context.queue names it. Expect several of these per pod (one per Poll instance). | AMQP.listen _(lvl info)_ | `lib/amqp.js:145, lib/poll.js:27` |
| `failed to publish rabbitmq message` | A poll/retry schedule could not be enqueued; that batch will simply never be polled again. context includes batchId and the whole payload. | AMQP.push _(lvl error)_ | `lib/amqp.js:138` |
| `published rabbit mq message` | Debug-level (emitted through logDebug which maps to logger.info). Fires for every poll/retry schedule; context includes batchId, interval, identifier, pollCount. | AMQP.push _(lvl info (via logDebug))_ | `lib/amqp.js:136, lib/logger.js:11-18` |
| `error in consuming message` | COLLECTOR_QUEUE message failed to JSON.parse; it is nacked with requeue=true — a poison message can loop forever here. | AMQP.listen _(lvl error)_ | `lib/amqp.js:155-158` |
| `Failed to subscribe to ORDER_conciliation topic` | The postback consumer never attached. Harmless for SBI (postback:false) but fatal for postback brokers. | consumer/orderConcile.js init _(lvl error)_ | `consumer/orderConcile.js:41, config.js:61` |
| `Failed to subscribe to ORDER_amoPoll topic` | AMO next-day poll triggers will not arrive; AMO batches stay unpolled. | consumer/amoPoll.js init _(lvl error)_ | `consumer/amoPoll.js:29, config.js:62` |
| `Processed postback in order concile queue` | DEBUG=true in prod so this fires for every ORDER_conciliation message. context.order is the raw payload. | consumer/orderConcile.js handleUpdate _(lvl info (via logDebug))_ | `consumer/orderConcile.js:22-24, deployment/infra/production-sc-integrations-order-updates-env.yaml:97` |
| `Processed message in amo poll queue` | DEBUG=true in prod so this fires for every ORDER_amoPoll message. context is the whole message (accessToken, batchId, sstOrder). | consumer/amoPoll.js amoTrigger _(lvl info)_ | `consumer/amoPoll.js:12-14` |
| `batch applied to user investments` | platform-api accepted the holdings update for this batch. context has batchId, requestId (meta.correlationId) and the platform response. | lib/utils.js updateUserHoldings _(lvl info)_ | `lib/utils.js:248` |
| `Failed to apply batch to user investment` | platform-api rejected the holdings update. context has batchId plus the platform error body and statusCode. Batch is final in BB but the user's holdings did not move. | lib/utils.js updateUserHoldings _(lvl warn)_ | `lib/utils.js:250` |
| `Fetching NSE circuit limits failed` | CL:<sid> upper/lower lookup failed while computing a LIMIT price; the limit price is still computed from the buffer alone. | lib/utils.js getLimitPrice _(lvl error)_ | `lib/utils.js:438` |
| `Error getting tick size for sid` | Tick size lookup failed; BB falls back to 0.10, which can mis-round a LIMIT price. | getQueryStringForPlaceOrders _(lvl warn)_ | `services/orders.js:2465-2467` |
| `tradingsymbolNotFound` | Both the message and the Error name. A sid could not be mapped to an SBI trading symbol — the leg is dropped from the fractional path. context has batchId, order, broker, sid, requestId. | placeFractionalOrders _(lvl error)_ | `services/orders.js:3822` |
| `Failed to cleanup bitmap` | cleanUpBitmap failed; stale bits remain on BB:bitmap:<batchId>. | lib/utils.js _(lvl error)_ | `lib/utils.js:106` |
| `Bitmap cleanup successfull` | (sic, double-l). Bitmap cleared for the batch. | lib/utils.js _(lvl info)_ | `lib/utils.js:109` |
| `Failed to set TTL. key doesn't exist` | setOrderFlag could not expire BB:order:flag:<broker>:<orderKey> because the key vanished. context.data.key holds the exact key. | lib/utils.js setOrderFlag _(lvl error)_ | `lib/utils.js:190` |
| `Calendar initialized` | activeDays calendar loaded at boot; previousActiveDay() is now valid. Until this appears, the fix path's age check can misbehave. | lib/utils.js initCalendar _(lvl info)_ | `lib/utils.js:211, index.js:19` |
| `Error in initializing calendar` | The trading calendar failed to load; previousActiveDay() is unreliable for the whole process lifetime. | lib/utils.js initCalendar _(lvl error)_ | `lib/utils.js:208` |
| `Uncaught Exception: ` | Two fatal lines per crash — one with JSON.stringify(err), one with err.message. The process does NOT exit (no process.exit), so the pod keeps serving in an unknown state. | index.js handleUncaughtExceptions _(lvl fatal)_ | `index.js:25-28, index.js:51-52` |
| `BB Deployment triggered` | SIGUSR1 received from CodeDeploy; connections are being drained. In-flight polls/retries may be lost across this boundary. The log's context also carries name:'SIGUSR1'. | index.js handleDeploymentEvent _(lvl warn)_ | `index.js:32-45` |
| `Connections closed due to deployment` | Kafka producer/consumers, Redis, RabbitMQ and both Mongo connections were closed for the deploy. | index.js handleDeploymentEvent _(lvl info)_ | `index.js:40, connections/index.js:70-83` |
| `Mongo connected` | Primary Mongo connection open. 'Mongo connected for users collection' is the separate users-collection connection. | connections/index.js _(lvl info)_ | `connections/index.js:20, connections/index.js:32` |
| `Error while connecting to mongodb` | FATAL. No Order reads or writes possible. | connections/index.js _(lvl fatal)_ | `connections/index.js:23` |
| `redis connected` | Redis client up — required before any placement or poll can read/write BB:* keys. | connections/index.js _(lvl info)_ | `connections/index.js:44` |
| `Two-step finalization blocked` | twoStepRebalanceService.validateFinalization rejected — the buy leg is not done, so finalization is deliberately withheld. context spreads err.finalization. Applies to SBI two-step rebalances. | canFinalizeBatch _(lvl warn)_ | `services/orders.js:3323` |
| `Two-step sell leg completed` | Sell leg done; context has batchId, broker, mechanism.type, scheduledFor — the buy leg is now scheduled. | services/twoStepRebalanceService.js _(lvl info)_ | `services/twoStepRebalanceService.js:261` |
| `Two-step buy leg trigger failed` | The queued buy-leg trigger threw; the buy leg was not placed and the batch will sit half-executed. | services/orders.js poll infrastructure dequeue handler _(lvl error)_ | `services/orders.js:80` |
| `Two-step buy leg rescheduled after token refresh failure` | Access token refresh failed; the buy leg was converted to a SIP-style reschedule instead of being placed. | placeTwoStepBuyLeg _(lvl warn)_ | `services/orders.js:3214` |
| `Two-step SELL reconciliation failed` | Sell-leg reconciliation threw; context spreads err.reconciliation. | services/orders.js _(lvl error)_ | `services/orders.js:3272` |
| `Failed to persist two-step SELL update` | syncTwoStepSellOrder threw while mirroring a SELL update into Mongo; the Redis state advanced but Mongo did not. | handleOrderUpdate _(lvl error)_ | `services/orders.js:1548` |
| `failed to initialize polling infrastructure` | The module-level newMq.getClient() chain rejected. NO poll queues exist for the life of the process — batches are placed and never polled. Catastrophic and easy to miss. | services/orders.js pollInfrastructureReady _(lvl error)_ | `services/orders.js:86-89` |
| `Fully-netted order registered, broker placement skipped` | A rebalance-all netted leg was never sent to the broker; its orderId is the synthetic 'NETTED:<batchId>:<redisIndex>' and it is completed by a synthetic update. | placeOrder _(lvl info)_ | `services/orders.js:2769, services/orders.js:2761` |
| `Synthetic netted completion failed` | The synthetic COMPLETE for a fully-netted leg threw; BB best-effort clears the bit so the batch can still finalize. context has batchId, broker, requestId, orderKey. | placeOrdersWithCAS netted sweep _(lvl error)_ | `services/orders.js:1264` |
| `NETTED:` | Prefix of the synthetic orderId minted for a fully-netted leg: `NETTED:<batchId>:<redisIndex>`. Any orderId starting with this never reached the broker. | placeOrder _(lvl n/a (persisted field))_ | `services/orders.js:2761` |
| `Received request from smallboard to update batch fields -> ` | type API_REQUEST on PATCH /smallboard/orders. This is a HUMAN editing an Order document. context has batchId, iscid and the raw query+headers. | ordersController.updateOrderFields _(lvl info)_ | `ou-server/controller.js:836-844` |
| `Request to update the batch fileds successful` | (sic, 'fileds'). The smallboard field edit was applied; context.data.recordsModifiedCount says how many documents changed. | ordersController.updateOrderFields _(lvl info)_ | `ou-server/controller.js:857-866` |
| `Delete Batch Request receivied` | (sic, 'receivied'). DELETE /batch/orders or DELETE /orders/dummyOrder. The Order document is about to be removed from Mongo and its Redis keys purged. | ordersService.deleteBatch _(lvl info)_ | `services/orders.js:1946` |
| `Deleted Batch` | The Order document was actually deleted. context.data.deletedCount confirms. | ordersService.deleteBatch _(lvl info)_ | `services/orders.js:1955` |
| `Stamped supersededByDummyBatchId on archived batch` | PATCH /orders/stamp-superseded linked an archived batch to a replacement dummy batch. | ordersService.stampSupersededBatch _(lvl info)_ | `services/orders.js:2212` |
| `previous batch marked FIXED` | A FIX-label batch was placed, so its previousBatchId was flipped to status FIXED. | services/orders.js _(lvl info)_ | `services/orders.js:294, services/orders.js:3530-3540` |
| `Couldn't mark previous batch FIXED` | markPreviousBatchFixed threw; the old batch stays in its error state even though a FIX batch exists. | placeOrdersWithCAS _(lvl error)_ | `services/orders.js:1162-1167` |
| `Cancel AMO request received` | POST /amo/cancel. context has batchId, clientDetails. | ordersService.cancelAmo _(lvl info)_ | `services/orders.js:1658` |
| `Polling broker to crosscheck order cancellation` | After a cancel, BB polls the broker to confirm. Two emitters (cancelDayOrders and cancelAmo) with slightly different context. | cancelOrder / cancelAmo _(lvl info)_ | `services/orders.js:554, services/orders.js:1721` |
| `Order cannot be moved to MARKEDCOMPLETE` | An attempt to mark a batch MARKEDCOMPLETE was refused given its current status. context has batchId, status. | services/orders.js _(lvl warn)_ | `services/orders.js:1988` |
| `Archive order request ->` | type API_REQUEST on POST /orders/archive; followed by 'Order archived' (type DEBUG_MESSAGES) on success or 'Error in archiving batch' on failure. | ordersController.archiveOrder _(lvl info)_ | `ou-server/controller.js:387-407` |
| `Circuit Limit data not healthy` | circuit-tracker returned an unusable payload while classifying error codes; errorCodes stay as the broker reported them. | updateErrorCodes _(lvl warn)_ | `services/orders.js:3513` |
| `Error in getting circuit limit API response` | The circuit-tracker HTTP call failed (1s timeout). Error-code enrichment is skipped. | updateErrorCodes _(lvl warn)_ | `services/orders.js:3521, config.js:385-389` |
| `Successful request` | broker-lib SBI HTTP layer, nested inside context.extra.data.msg of a 'broker action - *' SC_BROKER line. Carries details.request (url/method/body) and details.response (statusCode/body) plus details.health. | node_modules broker-lib sbi/services/request.js requestBroker _(lvl info)_ | `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/services/request.js:148-159` |
| `sending success response` | broker-lib SBI: the raw response body being returned to BB, nested in the same SC_BROKER envelope. | node_modules broker-lib sbi/services/request.js _(lvl info)_ | `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/services/request.js:160-163` |
| `Error in request` | broker-lib SBI HTTP error WITH a response body (details.response holds SBI's error payload). Note: for /place-order URLs broker-lib deliberately returns the error body as a normal response rather than an error. | node_modules broker-lib sbi/services/request.js _(lvl warn)_ | `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/services/request.js:228-242` |
| `Error in request - ` | broker-lib SBI HTTP error with NO response (timeout/DNS/TLS), suffixed with error.message. This is the true network-failure signature for SBI. | node_modules broker-lib sbi/services/request.js _(lvl warn)_ | `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/services/request.js:217-227` |
| `Successful rejection reason request` | broker-lib SBI: the /order-rejection/rejection-reason endpoint answered (even on an HTTP error status) with responseCode 1; the human-readable rejection text is in messageList[0].messageDescription. | node_modules broker-lib sbi/services/request.js _(lvl info)_ | `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/services/request.js:200-216` |
| `Invalid orderId` | broker-lib SBI order service rejected the orderId supplied for a status/cancel call. | node_modules broker-lib sbi/services/order.js _(lvl info)_ | `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/services/order.js:480` |
| `Error in cancelling order` | broker-lib SBI cancel-order failed. | node_modules broker-lib sbi/services/order.js _(lvl error)_ | `node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/services/order.js:546` |
| `Order saved initially with status ACKED` | NOT a log line — an entry appended to Order.meta.updates[]. Proves the INITIAL save ran. | babel Order.saveOrder saveInitialOrder _(lvl n/a (persisted field))_ | `node_modules/@smallcase/sc-integrations-babel/src/models/Order.js:38` |
| `Order saved with status ` | NOT a log line — Order.meta.updates[] entry from the PLACED save, suffixed with PLACED / PARTIALLYPLACED / UNPLACED / ERROR. | babel Order.saveOrder savePlacedOrder _(lvl n/a (persisted field))_ | `node_modules/@smallcase/sc-integrations-babel/src/models/Order.js:67` |
| `Order saved finally with status ` | NOT a log line — Order.meta.updates[] entry from the FINAL save, suffixed with COMPLETED / PARTIALLYFILLED / UNFILLED / UNPLACED / CANCELLED / ERROR. Count these to see how many times a batch was finalized (a fix produces another one). | babel Order.saveOrder saveFinalOrder _(lvl n/a (persisted field))_ | `node_modules/@smallcase/sc-integrations-babel/src/models/Order.js:104` |
| `Order still in ACKED state. BatchId: ` | The FINAL save retried 5 times and the PLACED save never landed. The batch is stuck at ACKED forever. Suffixed with the batchId. | babel Order.saveOrder saveFinalOrder _(lvl n/a (Error message, surfaced via 'Error in final batch saving'))_ | `node_modules/@smallcase/sc-integrations-babel/src/models/Order.js:84-94` |
| `Order not found. BatchId: ` | saveOrder PLACED or FINAL could not find the document by _id. Should be impossible; indicates the INITIAL save never committed or the document was deleted mid-flight. | babel Order.saveOrder _(lvl n/a (Error message))_ | `node_modules/@smallcase/sc-integrations-babel/src/models/Order.js:48-50, :80-82` |
| `Batch not found with batchId: ` | errors.js findBatch looked in both Order and SSTOrder and found neither. Surfaces as HTTP 400 with reason 'Invalid batchId'. | services/errors.js findBatch _(lvl n/a (Error message))_ | `services/errors.js:98-105, services/errors.js:512-518` |


## Corrections (12)

Where the old `SBI_LOG_INVESTIGATION_GUIDE.md`, or an obvious assumption, is provably wrong.


**Claimed:** SBI's error-reconciliation mechanism is 'NONE', meaning SBI error batches cannot be auto-fixed / are never fixed by BB.

**Actually:** Half right, and the useful half is missing. triageErrorBatch does return FIXBY.NONE for 'sbi' (and sbi-mtf falls to the same via `default`), but triage is only consulted when the caller does NOT pass fixBy: `const fixBy = FIXBY[options.fixBy && options.fixBy.toUpperCase()] || triageErrorBatch(batch)`. Every real SBI recon job passes `fixBy: 'orderbook'` explicitly, so triage never runs and SBI batches ARE fixed, by fixBatchByOrderBook, using a tradebook the job supplies in the request body. 'NONE' only describes the unattended/retry-queue default path.

`services/errors.js:118-119, services/errors.js:126-160, /Users/rishidatta/Desktop/integrations/sc-integrations-jobs/jobs/reconciliations/sbiReconAllOrders.js:592-608, /Users/rishidatta/Desktop/integrations/sc-integrations-jobs/jobs/reconciliations/sbiDealerRecon.js:169-180`


**Claimed:** POST /errors/fix/:batchId supports fixBy modes 'orderbook', 'tradebook', and others.

**Actually:** 'tradebook' is NOT a fixBy mode. The FIXBY enum has exactly five members — NONE=0, ORDERBOOK=1, POLLING=2, UNLOCKING=3, RETRY=4 — and fixBy is matched against those names uppercased. `tradebook` is a separate top-level body parameter consumed by fixBatchByOrderBook as a pre-supplied order book, which is the ONLY way SBI can be fixed since SBI has no Orders.list endpoint.

`services/common.js:9-15, services/errors.js:69-75, services/errors.js:118, services/errors.js:295-304`


**Claimed:** (Implied by the FIXBY enum) passing fixBy='none' explicitly forces the no-op mechanism.

**Actually:** It does not. FIXBY.NONE === 0, which is falsy, so `FIXBY['NONE'] || triageErrorBatch(batch)` falls through to triage. For SBI the outcome is coincidentally the same (triage also returns 0), but for e.g. kite, sending fixBy='none' actually runs fixBatchByOrderBook. This is a live bug in the fixBy resolution.

`services/common.js:10, services/errors.js:118-119, services/errors.js:126-133`


**Claimed:** order-updates calls broker-lib over HTTP via sc-integrations-broker-api.

**Actually:** False. lib/brokerApi.js does `require('@smallcase/sc-integrations-broker-lib')` and calls the endpoint function in-process. There is no HTTP client for a broker-api service and no BROKER_API_* config anywhere in the repo or in the production env file. Broker HTTP traffic originates from inside the order-updates process itself.

`lib/brokerApi.js:1, lib/brokerApi.js:42-65, package.json:23, deployment/infra/production-sc-integrations-order-updates-env.yaml`


**Claimed:** SBI order updates arrive as broker postbacks and are consumed from the ORDER_conciliation Kafka topic.

**Actually:** SBI and SBI-MTF are polling-only: broker-lib sets `orderStatusBy: { postback: false, polling: true }` for both. batchExpireHandler explicitly branches on `orderStatusBy.postback` and, when false, skips the redis-flag check and goes straight to brokerPoll. Searching ORDER_conciliation for an SBI order is a dead end; search for 'Broker Poll Response' / 'broker action - orderStatus' instead.

`node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/config.js:58-61, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi-mtf/config.js:63-66, services/orders.js:3747-3767`


**Claimed:** An SBI order can be located in Redis by its broker orderId.

**Actually:** No. SBI and SBI-MTF override getOrderKey to return `order.tag`, so the Redis hash is `BB:order:sbi:<tag>` / `BB:order:sbi-mtf:<tag>`. BB:orders:<batchId> maps redisIndex→orderKey, i.e. redisIndex→tag, not →orderId. The broker orderId appears only as a field inside the hash and the Mongo leg.

`node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/config.js:98-100, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi-mtf/config.js:95-97, lib/utils.js:703, services/orders.js:2841-2848`


**Claimed:** A 200 response from POST /errors/fix/:batchId means the batch was repaired.

**Actually:** No. HTTP 200 is returned for BOTH `msg: 'Error Batch fixed'` (a real write) and `msg: 'Error Batch already fixed'` (fixBatch bailed out at the guard and wrote nothing — which happens whenever the batch is not simultaneously errorStatus:true AND status==='ERROR' and `force` was not passed). Always read the `msg` field, not the status code. Note sbiUnplacedRecon.js is the one SBI recon job that does NOT pass force:true.

`services/errors.js:107-123, services/errors.js:523-530, ou-server/controller.js:26-27, /Users/rishidatta/Desktop/integrations/sc-integrations-jobs/jobs/reconciliations/sbiUnplacedRecon.js:86-89`


**Claimed:** The error-retry backoff spans about 6 hours across 34 attempts (as stated in the repo's own docs/error-reconciliation.md).

**Actually:** The attempt count is right but the span is 6.5 hours: 5×60s + 5×300s + 24×900s = 300 + 1500 + 21600 = 23400 s = 390 min. The in-repo doc rounds this down to '~6 hours'.

`services/errors.js:77-82, docs/error-reconciliation.md:86-90`


**Claimed:** Reading node_modules/@smallcase/sc-integrations-broker-lib in this checkout tells you what production runs.

**Actually:** It does not. package-lock.json on branch production (unmodified per git status) pins broker-lib 16.11.15 and babel 6.3.2, but the installed trees are 16.11.13-rebalance-in-amo.1 and 6.3.3-rebalance-in-amo.2 — the rebalance-in-amo pre-release. Every broker-lib/babel fact sourced from node_modules here must be re-verified against the 16.11.15 / 6.3.2 tarballs before being trusted as production behaviour.

`package.json:23-24, package-lock.json:559-563, package-lock.json:610-615, node_modules/@smallcase/sc-integrations-broker-lib/package.json:2-3, node_modules/@smallcase/sc-integrations-babel/package.json:2-3`


**Claimed:** 'polling limit reached for the following batch' means BB gave up retrying a failed batch.

**Actually:** For the error-retry lane it means nothing of the sort. Error Poll objects are constructed with maxPollCount:1, so pollsLeft is 0 after the single handler invocation and this line is emitted on EVERY error-retry tick as normal operation; the next retry is scheduled separately by retryErrorOrder. The genuine give-up line is '[ERRORS] Retry limit reached'. On the regular/day/amo lanes the line does mean the poll budget is exhausted.

`lib/poll.js:36-52, services/errors.js:36-40, services/errors.js:84-89`


**Claimed:** SBI-MTF behaves like SBI for error triage and limit-order configuration.

**Actually:** Two concrete divergences. (1) triageErrorBatch has a `case 'sbi'` but NO `case 'sbi-mtf'` — sbi-mtf reaches FIXBY.NONE via `default`, so a future per-broker mechanism added for 'sbi' would silently not cover sbi-mtf. (2) SBI has `limitBatchConfig.default = {validity:'IOC', bufferPercent:2, TV:10000000}` while SBI-MTF has no limitBatchConfig at all, so an sbi-mtf LIMIT order gets `validity = undefined`, a 3% buffer from the LIMIT_PRICE_BUFFER_PERCENT env fallback, and is never forced to LIMIT by turnover value.

`services/errors.js:126-160, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi/config.js:138-140, node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi-mtf/config.js (no limitBatchConfig), services/orders.js:2435-2440, services/orders.js:2483-2500`


**Claimed:** POST /errors/fix/:batchId is an authenticated internal endpoint.

**Actually:** It has no authentication. Only the /smallboard/* sub-router checks a token (x-domain-token vs SMALLBOARD_INTERNAL_API_TOKEN); the root router — which carries /errors/fix/:batchId, /orders/place, /batch/orders DELETE and /orders/dummyOrder — and the /sst/* router have no auth middleware at all. The endpoint also accepts GET with the same handler, so a batch can be mutated by a plain URL fetch.

`ou-server/routes.js:9-49, ou-server/routes.js:31-34, ou-server/controller.js:374-383, ou-server/app.js:28-30`


## Open questions (8)

Genuinely unresolved. Report these as unknown rather than guessing.

- The installed node_modules (broker-lib 16.11.13-rebalance-in-amo.1, babel 6.3.3-rebalance-in-amo.2) does not match package-lock.json (16.11.15 / 6.3.2). Every SBI broker-lib config flag I cite — orderStatusBy, getOrderKey, generateTag, sessionlessPollingAvailable, limitBatchConfig, mtfBroker, absence of Orders.list — needs re-verification against the 16.11.15 tarball before being treated as production truth. I could not obtain 16.11.15 from this checkout.
- config.brokers.sbi.apiKey reads process.env.SBI_API_KEY, but broker-lib's SBI config reads SBI_APP_KEY / SBI_SECRET_KEY. SBI_API_KEY does not appear in the production env yaml (secrets come from AWS Secret Manager). Whether the apiKey OU injects into place/poll options is used at all by SBI's api layer, or is silently ignored, I could not determine without reading the SBI request signing code end to end.
- sbi-mtf's config sets `brokerName = isLeprechaun ? 'sbi-mtf-leprechaun' : 'sbi'` — i.e. the non-leprechaun sbi-mtf config reports brokerName 'sbi', not 'sbi-mtf'. broker-lib's log wrapper stamps that value into the `broker` field of SC_BROKER payloads. I did not verify whether SBI-MTF broker calls therefore appear in logs labelled broker:'sbi', which would be a serious search trap. Worth confirming against a real log sample.
- For an sbi-mtf LIMIT order, `order.validity` is left undefined (no limitBatchConfig). What SBI's place-order API does with an absent validity field — reject, or default to something — is broker-side behaviour I did not trace.
- POST /errors/fix/:batchId does `{...req.query, ...req.body}`, so on the GET variant fixBy/force can arrive as query strings. `force` would then be the STRING 'true'/'false'; 'false' is truthy in JS, so `?force=false` would force. I read the code path but found no caller exercising it, so I could not confirm this is ever hit in practice.
- Every Poll instance calls mq.listen(COLLECTOR_QUEUE), so a single pod registers ~7 AMQP consumers on that one queue (4 order polls + 3 error-retry intervals) and relies on the shared EventEmitter to fan each message out to all instances for interval+identifier filtering. I believe this is correct-but-wasteful rather than lossy, but I did not prove that amqp-connection-manager's consume+emit ordering guarantees every Poll instance sees every dequeue.
- I did not read services/orders.js exhaustively (3998 lines); I covered placement, handleOrderUpdate, polling, finalization, determineOrderMode, placeOrder and the fix-adjacent paths. The autosip/SIP ingestion block (lines 110-490), the gateway/SST query paths, and placeFractionalOrders were only skimmed for log strings, so SBI autosip-specific behaviour is under-mapped here.
- docs/error-reconciliation.md carries a self-imposed rule that it must be updated with every change to services/errors.js. Its triage table matches the code today, but it predates the pending-orders/netting additions in some details (it describes isToBeFixed without the includeAcked twoStep argument). Treat it as a secondary source only.
