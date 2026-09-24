# platform-babel-orderflow

sc-platform-babel smallcaseOrderFlow — the hop from platform-api into order-updates.

**branch when read:** production (HEAD 4ce58d4, package version 6.6.2). Cross-referenced repos and their branches at time of research: sc-platform-api = production (01e5f51bc); sc-integrations-order-updates = production (fb95292c); sc-integrations-babel = production (d3dd6cd, v6.3.2); sc-integrations-broker-lib = development (dbe4206f) — NOT 'rebalance-in-amo' as the task brief assumed; sc-integrations-leprechaun = rebalance-in-amo (89e424e); sc-integrations-jobs = production (5bd80bd0); sc-smallboard-be = production (9baeb983); sc-babel = stableApi/production (v19.0.2-stableApi.12).

smallcaseOrderFlow is NOT an opaque npm package — it is source at /Users/rishidatta/Desktop/integrations/sc-platform-babel/others/smallcaseOrderFlow.js (838 lines), re-exported as `require('@smallcase/sc-platform-babel').utils.smallcaseOrderFlow` (index.js:302). It is the single hop between sc-platform-api and the "BB" service, and the BB service is definitively sc-integrations-order-updates: babel POSTs to `https://${BB_SERVICE_HOST}/orders/place`, `/orders/dummyOrder` and `/orders/getstatus`, and those three routes exist only in sc-integrations-order-updates/ou-server/routes.js:9,39,12. This layer owns three things an investigator cares about: it MINTS the correlationId (it is literally `new PlacedOrders()._id`, smallcaseOrderFlow.js:504-536), it drives the PlacedOrders state machine's first two states (RECEIVED → ACKED), and it mutates the user document (invested-smallcase status/version/flags, pending actions) BEFORE the broker has seen anything. It does NOT mint batchId — order-updates does, at services/orders.js:885. The layer is completely broker-agnostic: there is not one `sbi` / `sbi-mtf` branch in the file, so SBI-specific behaviour never originates here — but every SBI order passes through it, and its two failure paths (the `getstatus` recovery and the direct-Mongo `orders` lookup) are the usual explanation for SBI batches that exist in `orders` but whose PlacedOrders doc is stuck, missing a batchId, or whose pending actions were never cleared.

Confidence markers are the researcher's own: unmarked = confirmed from source, `[INFERRED]` = deduced but unproven, `[UNCONFIRMED]` = a lead, not a fact. `!` marks facts flagged critical. Re-verify line numbers against the checked-out SHA.


## Facts (63)


### location

- **!** smallcaseOrderFlow is source in this workspace at sc-platform-babel/others/smallcaseOrderFlow.js (838 lines). It is exported to consumers as `require('@smallcase/sc-platform-babel').utils.smallcaseOrderFlow`.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:1-838; sc-platform-babel/index.js:302`

### exports

- **!** The module exports exactly THREE functions: `placeOrders` (line 392), `cancelBatch` (line 331) and `rollbackPlacedOrderChanges` (line 794). There is no modify/fix/archive export here — fix and archive go through a different client (sc-platform-api/app/integrations/ou/ou.bb.integrations.js).  
  `sc-platform-babel/others/smallcaseOrderFlow.js:331,392,794`

### bb-service-identity

- **!** The BB service IS sc-integrations-order-updates. Proof from this package's own code: it POSTs to `${bbParams.url}/orders/place` and `${bbParams.url}/orders/dummyOrder`; the only repo in the workspace defining those exact routes is sc-integrations-order-updates (`router.route('/orders/place').post(ordersController.placeOrders)` and `router.route('/orders/dummyOrder').post(ordersController.createDummyOrder)`).  
  `sc-platform-babel/others/smallcaseOrderFlow.js:72,84; sc-integrations-order-updates/ou-server/routes.js:9,39`

### http-call

- **!** Exact HTTP call for a live order: POST `https://${process.env.BB_SERVICE_HOST}/orders/place`, Content-Type application/json (axios default), body = the `orderOptions` object. No custom headers, no auth header, no timeout, no retry.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:69-79,157-161,431-483; sc-platform-api/config/config.js:1112-1116`
- **!** The outgoing body shape is exactly: `{ user:{userId, broker, session, accessToken, dealer, ipAddress}, batch:{orders, fractionalOrders, label, variety, orderMode, gateway, batchTag, activated}, investedSmallcase:{iscid, name, scid, flags, tier, version, source}, context:{requestId, autoDebit, agent, gatewayTransactionId, dealerId, rmId, distributor, archiveBatch, assistedBy, verifiedHoldings, dummySource, dealerDetails, twoStepRebalance, correlationId}, clientDetails }`. For FIX batches it additionally carries `batch.originalLabel`, `batch.previousBatchId`, `batch.originalBatchId`.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:431-483,536`
- `isInvestMore` rewrites the wire label: if `batch.isInvestMore` is truthy the outgoing `batch.label` is forced to 'INVESTMORE' regardless of what platform-api set. So an INVESTMORE batch in `orders` may have been requested as BUY upstream.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:476-478`
- BB_SERVICE_PORT (sc-platform-api config default 8106) is DEAD CONFIG for this hop — babel builds the URL from host only, with no port. order-updates actually listens on `BB_PLACEORDERS_PORT` (default 8005).  
  `sc-platform-api/config/config.js:1113-1114; sc-platform-babel/others/smallcaseOrderFlow.js:72; sc-integrations-order-updates/config.js:100; sc-integrations-order-updates/ou-server/app.js:11,37`
- babel dials `https://` but order-updates' ou-server creates a plain `http.createServer(app)`. TLS is therefore terminated by something in front (ALB/ingress). The server sets keepAliveTimeout 121000ms and headersTimeout 125000ms, commented as '1s more than the ALB timeout' — i.e. the ALB idle timeout is ~120s.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:72; sc-integrations-order-updates/ou-server/app.js:34-37; sc-integrations-order-updates/config.js:102-106`
- **!** NO TIMEOUT is set on the placeOrders axios instance. `config.brokerBrokerService.timeout` (10s) exists in platform-api but is never passed into bbParams, so a hung place-order call blocks until the ALB (~120s) or the socket gives up. Contrast: the other BB client in platform-api (ou.bb.integrations.js) DOES set `timeout: config.brokerBrokerService.timeout`.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:69-91 (no timeout key); sc-platform-api/config/config.js:1115; sc-platform-api/app/integrations/ou/ou.bb.integrations.js:28`
- **!** NO `x-amzn-trace-id` header is sent by smallcaseOrderFlow. The platform-api `requestId` reaches order-updates only inside the JSON body as `context.requestId`. Contrast: ou.bb.integrations.js explicitly sets `headers['x-amzn-trace-id'] = customHeaders.requestId`. So when correlating platform-api ↔ order-updates logs for a PLACEMENT, join on `context.requestId` in the body or on correlationId — not on a trace header.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:69-91,157-199,460; sc-platform-api/app/integrations/ou/ou.bb.integrations.js:24-26`

### correlationId-minting

- **!** correlationId is minted HERE, not upstream. It is the `_id` of a newly constructed PlacedOrders mongoose doc: `const placedOrders = new PlacedOrders({...}); orderOptions.context.correlationId = placedOrders._id;`. So correlationId === placedOrders._id === orders.meta.correlationId, always.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:504-536; sc-platform-babel/models/User/InvestedSmallcaseImage.js:12 (comment 'orders.meta.correlationId ==== placedOrders._id')`

### batchId-minting

- **!** batchId is minted by order-updates, NOT by babel: `const batchId = new mongoose.Types.ObjectId().toString();` at the top of `orderPlacement.placeOrdersWithCAS`. babel only reads it back off the HTTP response.  
  `sc-integrations-order-updates/services/orders.js:885; sc-platform-babel/others/smallcaseOrderFlow.js:661`
- **!** For DUMMY orders batchId is minted in a different place: `const batchId = mongoose.Types.ObjectId();` inside `objects.dummyOrderObject`, and the doc is written with `_id: batchId` and `batchId: batchId.valueOf()`.  
  `sc-integrations-order-updates/lib/objects.js:667,688,694`
- **!** `orders._id === orders.batchId` by construction — every save path does `order._id = order.batchId` (INITIAL and AUTO states). `batchId` is also a real top-level schema String field, so both `{_id: batchId}` and `{batchId: batchId}` queries work.  
  `sc-platform-babel/models/Order/Order.js:23,83,103; sc-platform-babel/models/Order/schema.js:114`

### response-shape

- **!** `/orders/place` returns the saved mongoose Order doc verbatim (`res.status(200).json(batch)` where batch is `savedBatch`). So `bbResponse.data.batchId` on the happy path is the orders-collection doc's `batchId`, and `bbResponse.data` is the whole batch document.  
  `sc-integrations-order-updates/ou-server/controller.js:95-97; sc-integrations-order-updates/services/orders.js:1215,1225,1231 (callback(null, savedBatch))`
- **!** `/orders/dummyOrder` returns a DIFFERENT shape: `{ status: true, batchId, iscid }`. This is why placeOrders.v2.service special-cases dummy and reads `response.data.status` where the normal path reads `response.data.orders`.  
  `sc-integrations-order-updates/ou-server/controller.js:558-570; sc-platform-api/app/services/userSmallcase/placeOrders.v2.service.js:208-215`
- **!** `/orders/getStatus` returns `{ success: { batch } }` — the batch is NESTED one level under `success`.  
  `sc-integrations-order-updates/services/orders.js:1641; sc-integrations-order-updates/ou-server/controller.js:263`

### logging-service-name

- **!** Everything smallcaseOrderFlow logs goes to whatever logger the CALLER passes in (`logger` is the 6th arg, default `console`). From sc-platform-api all three placeOrders call sites pass `jsonLogger`, whose bunyan `name` is `sc.service.${APPLICATION_NAME}` = `sc.service.smallcase_api` by default. So these lines land in sc-platform-api's log stream, NOT order-updates'.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:398; sc-platform-api/app/services/userSmallcase/userSmallcase.js:3633,3928,4136; sc-platform-api/config/logger.js:8-11; sc-platform-api/config/config.js:1186`
- smallboard.service.js's dummy-order path passes `serviceLogger` (not jsonLogger) as the babel logger, so its PLACE_ORDER_OU_HTTPCLIENT lines carry serviceLogger's field shape.  
  `sc-platform-api/app/services/smallboard.service.js:1621`
- **!** For S3 log retrieval: platform-api logs live at `s3://sc-pm2logs-new/PROD/<date>/sc-platform-api/` (EC2, still dual-running) AND `s3://sc-eks-pod-logs/production/<date>/platform/sc-platform-api-pod/` (EKS). order-updates logs are EKS-only for recent dates: `s3://sc-eks-pod-logs/production/<date>/integrations/sc-integrations-order-updates-pod/`.  
  `fetch-s3-logs/fetch-s3-logs.js:67-90`
- order-updates' own bunyan name is `sc.service.${APPLICATION_NAME}` defaulting to the directory basename, i.e. `sc.service.sc-integrations-order-updates`.  
  `sc-integrations-order-updates/lib/logger.js:5-8; sc-integrations-order-updates/config.js:307`

### placedorders-state-machine

- **!** PlacedOrders status enum is exactly ['RECEIVED','ERROR','ACKED','APPLIED','COMPLETED','CANCELLED','REVERSED','QUEUED'] and the collection is `placedOrders`.  
  `sc-platform-babel/models/User/PlacedOrders.js:4,14-27`
- **!** babel owns the first two transitions: it INSERTS the doc with status 'RECEIVED' (line 507) and, on a 200 from OU, flips it to 'ACKED' with a guard `{_id: correlationId, status:'RECEIVED'}` plus a separate unconditional `$set:{batchId}`. Both are fire-and-forget `.exec()` with no error handling.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:504-512,688-695`
- **!** APPLIED and COMPLETED are written by sc-platform-api, not babel: `applyBatchToIscid` sets APPLIED (inside a mongo transaction) and `markPlacedOrderAsCompleted` sets COMPLETED. The apply gate requires status ∈ {ACKED, RECEIVED, QUEUED}, otherwise it throws InconsistentOrderState.  
  `sc-platform-api/app/services/userSmallcase/userSmallcase.js:10086-10101,10203-10207,10460-10463`
- **!** Nothing in sc-integrations-order-updates or sc-integrations-leprechaun ever reads or writes the `placedOrders` collection — a grep across their services/lib/consumer directories returns zero hits. PlacedOrders is written ONLY by sc-platform-babel, sc-babel and sc-platform-api code. Treat it as platform-side bookkeeping.  
  `sc-integrations-order-updates/services/*, lib/*, consumer/* (no matches for 'placedOrders'); sc-platform-api/app/repositories/placedOrders.repository.js:11,56,77,93,110; sc-platform-babel/others/smallcaseOrderFlow.js:301-312`
- **!** A PlacedOrders doc stuck in RECEIVED means babel never got a usable ACK. The code comment says 'PlacedOrders stuck in status: RECEIVED will be handled by OU-Recon Job', and the line that would have marked it OU_ACK_PENDING is commented out. I could find NO job in sc-integrations-jobs that sweeps PlacedOrders by status — the only job that touches PlacedOrders (`sanity/batchAndPlacedOrdersMismatch.js`) is a read-only report keyed off the orders collection. So stuck-RECEIVED docs are, as far as the checked-out code shows, never auto-healed. `[INFERRED]`  
  `sc-platform-babel/others/smallcaseOrderFlow.js:654-656; sc-integrations-jobs/jobs/sanity/batchAndPlacedOrdersMismatch.js:15-44`

### error-handling

- **!** There is NO retry anywhere in smallcaseOrderFlow — no async.retry, no attempts loop, no setTimeout backoff. One HTTP attempt, then the recovery ladder.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:1-838 (no retry/attempts/setTimeout except the promisified rollback)`
- **!** `sendBBRequest` NEVER calls back with an error. Its `.catch` does `callback(null, {networkError: err})`. Every axios rejection (connection refused, timeout, 4xx, 5xx — axios rejects on any non-2xx by default) becomes a `networkError` envelope.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:209-212`
- **!** Recovery ladder on failure (networkError OR statusCode !== 200): (1) POST `/orders/getstatus` with `{correlationId}`; (2) if that returns `resp.data.success`, treat as success via handlePlacedOrders; (3) otherwise log type 'ORDER UPDATES DOWN', then do a DIRECT Mongo read `Order.findOne({'meta.correlationId': correlationId})` from inside the platform-api process; (4) if that finds a doc, treat as success; (5) only if that also fails does it `callback(error, bbResponse)`.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:583-659,94-134`
- **!** The synthetic error message on a non-200 with no network error is literally `Response code from OU: ${bbResponse.statusCode}`.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:589`
- The direct-Mongo fallback proves sc-platform-api and sc-integrations-order-updates share one MongoDB: babel, running in the platform-api process, reads the `orders` collection that order-updates writes. The collection name is hardcoded 'orders' in the babel Order model.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:101; sc-platform-babel/models/Order/Order.js:2,103`
- **!** An axios rejection is logged whole via `logBB(logger,'ERROR',...)`, and axios 0.30's AxiosError.toJSON() includes `config` — which includes `config.data`, the serialized request body. That body contains `user.accessToken` and `user.session`. So the ERROR log line for a failed place-order leaks the user's live broker access token into platform-api logs (and conversely: an investigator CAN reconstruct the exact outgoing payload from that log line).  
  `sc-platform-babel/others/smallcaseOrderFlow.js:209-212,137-155,436-437; sc-platform-babel/node_modules/axios/lib/core/AxiosError.js:33-50`
- **!** Divergence between the happy path and the recovery path: the 200-path calls `user.handleActions(batch, version, {hide:true})` (which removes/hides the buy/rebalance/sip/investMore/fix pending action), but `handlePlacedOrders` — used by BOTH recovery paths — does NOT. Symptom to look for: order placed successfully but the user still sees the rebalance/fix pending action ⇒ the recovery path was taken.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:702 vs 251-329; sc-platform-babel/models/User/User.js:1445-1499`

### user-doc-mutation

- **!** placeOrders mutates the user document BEFORE any HTTP call and saves it in parallel with the PlacedOrders insert. For label BUY it creates a brand new investedSmallcase (status 'PLACED'); for everything except RECON_BUY it sets the isc status to 'PLACED'; for REBALANCE it bumps the isc version; for variety 'amo' it sets flag `amoPending: true`.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:402-429,497-503; sc-platform-babel/models/User/User.js:1287-1296,1500-1527`
- **!** Consequence: if the process dies between `user.save()` and the OU response, the user has an investedSmallcase in status PLACED (or a brand-new isc for BUY) with a PlacedOrders doc in RECEIVED and NO batch in `orders`. That is the canonical 'phantom PLACED isc' state. `[INFERRED]`  
  `sc-platform-babel/others/smallcaseOrderFlow.js:495-570`
- **!** `rollbackPlacedOrderChanges` is the designed repair for that state: inside a mongo transaction it flips PlacedOrders RECEIVED→ERROR (and throws 'placedOrder status update failed' if nModified==0), then for label BUY `$pull`s the investedSmallcase entirely, else sets isc status to 'INVALID' (label FIX) or 'VALID' (everything else) and un-hides the fix action. platform-api wraps it as `rollbackPlacedOrder(correlationId)` and also deletes the redis lock.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:794-838; sc-platform-api/app/services/userSmallcase/userSmallcase.js:10015-10022`

### locking

- **!** The per-user placement lock key is `API:SCL:${userId}:${lockKey}` in redis, acquired with plain SETNX and NO TTL. `lockKey` is `userParams.lockKey` (stored on the PlacedOrders doc); order-updates independently defaults `batch.lockKey = batch.lockKey || investedSmallcase.scid`. Because there is no expiry, a lock not explicitly deleted blocks that user+smallcase forever.  
  `sc-platform-api/app/services/userSmallcase/userSmallcase.js:11226,10021,10494,10533; sc-platform-babel/others/smallcaseOrderFlow.js:509; sc-integrations-order-updates/lib/utils.js:602`

### dummy-orders

- **!** A dummy order is requested by setting `bbParams.method = 'placeDummy'`, which is driven by `params.dummy` at every platform-api call site. babel then rebuilds the payload entirely via `getPlaceDummyOrderPayload` and POSTs it to `/orders/dummyOrder`.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:162-188,16-67; sc-platform-api/app/services/userSmallcase/userSmallcase.js:3530-3534,3903-3907,4113; sc-platform-api/app/services/userSmallcase/placeOrders.v2.service.js:466`
- **!** How to recognise a dummy order in the data: `orders.dummy === true` (schema comment: 'Orders created by support requests'); `orders.meta.dummySource` is set (babel default 'cx_link', order-updates fallback 'platform'); `placedOrders.dummy === true`; and an `investedSmallcaseImage` doc exists keyed by that correlationId (created ONLY for dummy batches, holding a pre-placement snapshot of the isc).  
  `sc-platform-babel/models/Order/schema.js:96,154; sc-integrations-order-updates/lib/objects.js:695,707; sc-platform-babel/others/smallcaseOrderFlow.js:31,537-549,314-319; sc-platform-babel/models/User/InvestedSmallcaseImage.js:1-27`
- Dummy batches are written with `Order.saveOrder(orderObject,'AUTO',...)`, so they skip the INITIAL/PLACED lifecycle entirely and land pre-completed. Per-order status is derived from filledQuantity vs quantity (COMPLETE / PARTIAL / REJECTED), batch status from filled vs total (COMPLETED / PARTIALLYFILLED / UNFILLED), and `completedDate` is set to `date + 1000ms`.  
  `sc-integrations-order-updates/services/orders.js:1926-1936; sc-integrations-order-updates/lib/objects.js:592-628,666-680,699; sc-platform-babel/models/Order/Order.js:80-87`
- **!** `archiveBatch` handling: babel sends `options:{archiveBatch, archiveIscid: iscid}`. order-updates' createBatch archives FIRST (marks the iscid's latest batch MARKEDCOMPLETE) and only then creates the dummy. `archiveOrder` THROWS unless the latest batch status is one of UNPLACED / UNFILLED / PARTIALLYFILLED / CANCELLED — otherwise it logs 'Order cannot be moved to MARKEDCOMPLETE' and createBatch returns `{success:false, message:'Error in archiving batch'}` → HTTP 500 → babel's networkError path.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:60-66,177; sc-integrations-order-updates/services/orders.js:1914-1942,1963-1990`
- **!** A dummy order that fails the archive step leaves an orphan: PlacedOrders stuck in RECEIVED with dummy:true, an investedSmallcaseImage row with no batchId, and NO orders doc — because the getstatus and direct-Mongo fallbacks both look for an `orders` doc by correlationId that was never created. `[INFERRED]`  
  `sc-platform-babel/others/smallcaseOrderFlow.js:537-549,583-659; sc-integrations-order-updates/services/orders.js:1918-1924`

### superseded-batches

- **!** The 'superseded by a dummy order' marker is `orders.meta.supersededByDummyBatchId`. It is stamped by order-updates via PATCH `/orders/stamp-superseded` (`Order.updateOne({batchId: archivedBatchId}, {$set:{'meta.supersededByDummyBatchId': dummyBatchId}})`), called from sc-platform-api's placeOrders.v2 right after a dummy MANAGE/SELLALL apply, and consumed by sbiReconAllOrders.js which `continue`s past such batches.  
  `sc-integrations-order-updates/services/orders.js:2204-2220; sc-integrations-order-updates/ou-server/routes.js:42; sc-platform-api/app/integrations/ou/ou.bb.integrations.js:177-185; sc-platform-api/app/services/userSmallcase/placeOrders.v2.service.js:860-869; sc-integrations-jobs/jobs/reconciliations/sbiReconAllOrders.js:1228-1242`
- **!** The stamping is best-effort only — a failure is swallowed into `serviceLogger.logError(e, {type:'STAMP_ARCHIVED_BATCH_FAIL'})` and the dummy apply still succeeds. So a batch CAN be genuinely superseded yet unstamped, and the SBI recon will then try to fix it.  
  `sc-platform-api/app/services/userSmallcase/placeOrders.v2.service.js:866-868`

### cancelBatch

- **!** `cancelBatch(user, batch, iscIndex, callback, options)` makes NO HTTP call. It sets `batch.status='MARKEDCOMPLETE'` locally, flips the isc status to 'VALID' (or 'PLACED' if `options.preserveIsc`), maybe deletes the isc via `User.completeOrder`, strips matching `actions.fix` entries, saves user+batch in parallel, optionally emits an 'ISC_deleted' event, and sets the PlacedOrders doc (by `batch.meta.correlationId`) to 'COMPLETED'.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:331-390`
- **!** sc-smallboard-be's support archive flow calls `smallcaseOrderFlow.cancelBatch` from `@smallcase/sc-babel` — a DIFFERENT, older package (v19.0.2-stableApi.12, 555 lines) than platform-api's `@smallcase/sc-platform-babel` (v6.6.2, 838 lines). smallboard-be depends on BOTH packages simultaneously.  
  `sc-smallboard-be/app/services/api/support.js:18-19,239; sc-smallboard-be/package.json:10,12; sc-babel/others/smallcaseOrderFlow.js:145; sc-babel/package.json:2-3`

### package-divergence

- sc-babel's smallcaseOrderFlow is materially behind sc-platform-babel's: its placeOrders takes 7 args (no `sipConfig`), its dummy payload builder has no `dummySource`/`dealerId`/`previousBatchId`/`originalBatchId`/`originalLabel`, and it has NO `ouOrderStatusDBLookup` direct-Mongo fallback (its recovery ladder stops after getstatus).  
  `sc-babel/others/smallcaseOrderFlow.js:16-41,90,195,366-427 vs sc-platform-babel/others/smallcaseOrderFlow.js:16-67,94-134,392-401`

### version-drift

- **!** Local node_modules are STALE feature-branch builds, but the lockfiles pin production versions — so the checked-out repo source IS what prod runs. sc-platform-api node_modules has sc-platform-babel 6.3.1-rebalance-in-amo.0 while package-lock.json pins 6.6.2 (= this repo's HEAD). The only diff between the two builds of smallcaseOrderFlow.js is one line: the rebalance-in-amo build carries `rebalanceInAMO: batch.rebalanceInAMO` in orderOptions.context; production 6.6.2 does NOT. Same pattern for order-updates (node_modules sc-integrations-babel 6.3.3-rebalance-in-amo.2, lock 6.3.2).  
  `sc-platform-api/package-lock.json:6578-6581; sc-platform-api/node_modules/@smallcase/sc-platform-babel/others/smallcaseOrderFlow.js:473 (extra line); sc-integrations-order-updates/package-lock.json:559-561`

### sbi-scope

- **!** smallcaseOrderFlow contains ZERO broker-specific logic — no 'sbi', 'sbi-mtf', or any broker name appears in the file. SBI and SBI-MTF orders traverse this layer identically to every other broker. Broker divergence starts in order-updates (`config.brokers`) and broker-lib.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:1-838 (no broker literals); sc-integrations-order-updates/config.js:211-222`
- **!** Broker names order-updates accepts for SBI are exactly: `sbi`, `sbi-leprechaun`, `sbi-mtf`, `sbi-mtf-leprechaun`. Anything else is rejected upstream of placement with ValidationError `Unsupported broker:${broker}` → HTTP 400.  
  `sc-integrations-order-updates/config.js:211-222; sc-integrations-order-updates/lib/utils.js:608-610`

### ou-validation

- **!** order-updates rejects a placement with HTTP 400 (ValidationError, batch NOT created) for any of: 'batch.orders is not an array', 'Invalid transactionType', 'Invalid quantity', 'Invalid exchange', 'Invalid SID', 'Invalid nettedOffQuantity', 'nettedOffQuantity is not supported for autosip batches', `Unsupported broker:${broker}`, 'Invalid label', 'context.correlationId is required', 'previousBatchId required for FIX batches', 'Gateway is required' (SST only), 'Must provide a valid access token'.  
  `sc-integrations-order-updates/lib/utils.js:560-632; sc-integrations-order-updates/ou-server/controller.js:82-86`
- **!** Label whitelisting is destructive: `batch.label = orderConsts.label[batch.label]` — an unrecognised label silently becomes `undefined` and then trips 'Invalid label'. The accepted label set is BUY, INVESTMORE, SIP, AUTOSIP, PARTIALEXIT, SELLALL, MANAGE, REBALANCE, FIX, RECON_BUY, RECON_SYNC.  
  `sc-integrations-order-updates/lib/utils.js:593,611-613; sc-integrations-babel/src/constants/order.js:6-18`

### ou-request-id

- **!** Inside order-updates' placement path, `requestId` is REBOUND to the correlationId: `var requestId = context.correlationId;`. So every downstream OU log field named `requestId` for a placement is actually the platform correlationId / PlacedOrders._id — not platform-api's requestId. The one exception is the entry log 'Order placement request received', which logs both `requestId: context.requestId` and `correlationId: context.correlationId`.  
  `sc-integrations-order-updates/services/orders.js:938,886-891`

### ou-placement-order

- order-updates places SELLs first, then waits `BB_TIMEOUT_AFTER_ALL_SELL_ORDERS` seconds (default 2) before placing BUYs — but only if at least one sell succeeded; otherwise buys go immediately. This is the source of the ~2s gap between sell and buy timestamps within one batch.  
  `sc-integrations-order-updates/services/orders.js:1094-1114; sc-integrations-order-updates/config.js:65`

### orders-schema

- **!** Key `orders` fields for identifier pivots: `_id`/`batchId` (same value), `meta.correlationId` (String), `meta.dummySource`, `meta.supersededByDummyBatchId`, `meta.updates[]` (audit trail of status changes, appended by `recordUpdate`), `iscid`, `scid`, `userId`, `brokeruserId`, `broker` (indexed), `label` (indexed), `status` (indexed), `originalLabel`, `previousBatchId`, `originalBatchId`, `dummy`, `variety`, `gateway`, `batchTag`.  
  `sc-platform-babel/models/Order/schema.js:73,95-96,99,106,114-154; sc-platform-babel/models/Order/Order.js:89-101`
- **!** Batch status enum: PLACED, ERROR, UNPLACED, PARTIALLYPLACED, UNFILLED, PARTIALLYFILLED, COMPLETED, FIXED, MARKEDCOMPLETE, CANCELLED. Per-order txnStatus enum: ACKED, PLACED, REJECTED, CANCELLED, COMPLETE, ERROR, 'CANCELLED AMO', PARTIAL.  
  `sc-platform-babel/constants/order.js:18-29,53-62`
- Initial batch status is derived purely by counting: all orders placed → PLACED; all unplaced → UNPLACED (or MARKEDCOMPLETE if label==='SST'); otherwise PARTIALLYPLACED. `errorStatus: true` overrides everything to ERROR and is described in-code as preventing the user from repairing the order.  
  `sc-platform-babel/models/Order/Order.js:20-43`

### pending-action

- **!** babel also writes the recon pending-action doc: `UserPendingAction.updateOne({_id: batch.reconId, status:{$nin:['COMPLETED','MARKEDCOMPLETE']}, 'batches.iscid': batch.iscid}, {$set:{'batches.$.status':'ACKED','batches.$.correlationId':…,'batches.$.batchId':…}})`. Sub-batch status enum is RECEIVED/ACKED/ERROR/COMPLETED; parent status enum is CREATED/ERROR/COMPLETED/MARKEDCOMPLETE; type ∈ RECON_BUY/RECON_SYNC/MANAGE/FIX/REBALANCE; category ∈ RECON/REBALANCE_ALL.  
  `sc-platform-babel/others/smallcaseOrderFlow.js:672-687,284-299; sc-platform-babel/models/User/UserPendingAction.js:9-33`

### archive-fix-endpoints

- **!** Flows that touch an EXISTING order do not live in smallcaseOrderFlow. They go through sc-platform-api/app/integrations/ou/ou.bb.integrations.js: POST `/orders/archive` (body `{iscid}`) and PATCH `/orders/stamp-superseded` (body `{archivedBatchId, dummyBatchId}`). That client maps HTTP 400→ValidationError('OU001'), 404→ResourceNotFound('OU002'), anything else→ExternalServiceFailed('OU003'); a bad response shape from /orders/filterOrdersForBroker yields 'OU004'.  
  `sc-platform-api/app/integrations/ou/ou.bb.integrations.js:21-57,95-101,167-193`
- The full BB route surface an investigator can hit: /orders/place, /orders/twostep/buy-leg, /orders/determineOrderMode, /orders/getStatus, /orders/getStatus/multiple, /orders/cumulativeBuyAmount/:batchId, /orders/autorepair, /orders/createAutosipOrders, /batch/orders (POST+DELETE), /orders/postprocess, /orders/poll/:batchId, /orders/archive, /amo/cancel, /errors/fix/:batchId (GET+POST), /orders/dummyOrder (POST+DELETE), /orders/stamp-superseded (PATCH), /orders/activatedOrders, /orders/filterOrdersForBroker, /health — plus /sst/* and /smallboard/* sub-routers.  
  `sc-integrations-order-updates/ou-server/routes.js:9-88`

### dummy-delete

- A dummy batch can be hard-deleted: DELETE `/orders/dummyOrder` with `{batchId}` → 400 if no batchId, 404 'Batch does not exist', 403 'Not a dummy order' if `order.dummy` is falsy, else `Order.deleteOne` plus a redis cleanup. sc-platform-api's smallboard.service calls it directly with raw axios (no OUBbIntegrator).  
  `sc-integrations-order-updates/ou-server/controller.js:572-592; sc-integrations-order-updates/services/orders.js:1944-1961; sc-platform-api/app/services/smallboard.service.js:495-517`

### callers

- **!** Every sc-platform-api entry into this hop, with its bbParams: userSmallcase.placeOrders (line 3432, bbParams at 3526), userSmallcase.sellAll (3821, bbParams at 3899), userSmallcase.fixBatch (4022, bbParams at 4111), placeOrders.v2.service (bbParams at 463, call at 544/189), smallboard.service dummy path (bbParams at 1610). All build `url: https://${config.brokerBrokerService.host}` and `method: dummy ? 'placeDummy' : 'place'`.  
  `sc-platform-api/app/services/userSmallcase/userSmallcase.js:3432,3526-3534,3821,3899-3907,4022,4111-4115,3628,3923,4131; sc-platform-api/app/services/userSmallcase/placeOrders.v2.service.js:463-467,544-551; sc-platform-api/app/services/smallboard.service.js:1610-1625`
- placeOrders' signature is `(user, userParams, investedSmallcase, batch, bbParams, logger, sipConfig, callback)` — 8 args. `sipConfig` is dereferenced unguarded (`sipConfig.sharesConfig`), so calling it with the older 7-arg sc-babel signature would put the callback in the sipConfig slot and crash on `callback(err)` being undefined. All current callers pass 8 (promisify supplies the 8th).  
  `sc-platform-babel/others/smallcaseOrderFlow.js:392-401,514-516; sc-platform-api/app/services/smallboard.service.js:1615-1623; sc-babel/others/smallcaseOrderFlow.js:195`


## Grep targets (73)

Search with `fetch-by-identifier.js --service <svc> --text "<string>"`.

| String | Means | Emitted by | Citation |
|---|---|---|---|
| `Payload being sent to order updates` | The single richest log line in the whole hop — emitted immediately before the HTTP call, with the ENTIRE outgoing orderOptions object (orders, label, variety, iscid, scid, correlationId is NOT yet set at this point, accessToken IS). type='DEBUG_MESSAGES'. Presence = placeOrders was entered for this batch. | smallcaseOrderFlow.placeOrders (sc-platform-api process) _(lvl info)_ | `sc-platform-babel/others/smallcaseOrderFlow.js:485-494` |
| `PLACE_ORDER_OU_HTTPCLIENT` | The `type` field on every HTTP-client log from this hop. subType is one of REQUEST / RESPONSE / ERROR. Grep this alone to get the complete request/response trail for a placement. | logBB() in smallcaseOrderFlow _(lvl info for REQUEST/RESPONSE, error for ERROR)_ | `sc-platform-babel/others/smallcaseOrderFlow.js:137-155` |
| `POST ${bbParams.url}/orders/${bbParams.method}` | The `description` on every PLACE_ORDER_OU_HTTPCLIENT line. Concrete forms: 'POST https://<BB_SERVICE_HOST>/orders/place', '...\/orders/placeDummy', '...\/orders/getstatus'. WARNING: the 'placeDummy' form is a lie — the real URL hit is /orders/dummyOrder. | logBB() in smallcaseOrderFlow _(lvl info/error)_ | `sc-platform-babel/others/smallcaseOrderFlow.js:148,84,162-188` |
| `Response sent by order updates on order placement` | Emitted right after sendBBRequest returns, with the full response envelope {statusCode, data} or {networkError} plus requestId. type='DEBUG_MESSAGES'. Absence after a 'Payload being sent' line = the process died mid-call. | smallcaseOrderFlow.placeOrders waterfall step 3 _(lvl info)_ | `sc-platform-babel/others/smallcaseOrderFlow.js:571-582` |
| `ORDER UPDATES DOWN` | The `type` (not a message) on the error log fired when BOTH the original call AND the /orders/getstatus retry failed. DOES NOT MEAN OU WAS DOWN — it also fires for a plain 400 ValidationError from OU. Always pair it with the preceding PLACE_ORDER_OU_HTTPCLIENT/ERROR line to see the real status code. | smallcaseOrderFlow.placeOrders failure branch _(lvl error)_ | `sc-platform-babel/others/smallcaseOrderFlow.js:607-616` |
| `PlacedOrders state RECEIVED ` | DDD_DEBUG_MESSAGES description, WITH a trailing space. Emitted at insert time with the whole PlacedOrders doc spread into extra. Marks the birth of the correlationId. | smallcaseOrderFlow.placeOrders, parallel step 2 _(lvl info)_ | `sc-platform-babel/others/smallcaseOrderFlow.js:550-559` |
| `PlacedOrders state ACKED ` | DDD_DEBUG_MESSAGES, WITH trailing space = the NORMAL 200-response path. Carries the full bbResponse (i.e. the saved orders doc). | smallcaseOrderFlow.placeOrders success branch _(lvl info)_ | `sc-platform-babel/others/smallcaseOrderFlow.js:662-671` |
| `PlacedOrders state ACKED` | DDD_DEBUG_MESSAGES with NO trailing space = the RECOVERY path (handlePlacedOrders), reached only after the original call failed and either /orders/getstatus or the direct Mongo lookup rescued it. The trailing space is the ONLY textual difference between the happy path and the recovery path — use an exact-match grep to tell them apart. On this path user.handleActions is never called, so pending actions stay visible. | handlePlacedOrders() in smallcaseOrderFlow _(lvl info)_ | `sc-platform-babel/others/smallcaseOrderFlow.js:273-282,702` |
| `PlacedOrders state ERROR ` | DDD_DEBUG_MESSAGES (trailing space). Emitted alongside 'ORDER UPDATES DOWN', just before the direct-Mongo last-ditch lookup. Note: it logs the state but does NOT write ERROR to the doc — the doc stays RECEIVED. | smallcaseOrderFlow.placeOrders failure branch _(lvl info)_ | `sc-platform-babel/others/smallcaseOrderFlow.js:617-626` |
| `PLACE_ORDERS` | The `type` on the last-ditch direct-Mongo lookup log (subType 'ORDER_STATUS_DB'). Its presence proves the HTTP layer failed twice and platform-api went straight to the orders collection. | ouOrderStatusDBLookup() in smallcaseOrderFlow _(lvl info on success, error on query failure)_ | `sc-platform-babel/others/smallcaseOrderFlow.js:94-134` |
| `ORDER_STATUS_DB` | subType of the direct-Mongo fallback log. The `description` is the literal query text: db.Orders.find({"meta.correlationId": '<correlationId>'}) — grep this to extract the correlationId even when nothing else did. | ouOrderStatusDBLookup() _(lvl info/error)_ | `sc-platform-babel/others/smallcaseOrderFlow.js:95-99` |
| `db.Orders.find({"meta.correlationId": '${correlationId}'})` | Literal description string of the fallback lookup, with the correlationId interpolated. Greppable by correlationId directly. | ouOrderStatusDBLookup() _(lvl info/error)_ | `sc-platform-babel/others/smallcaseOrderFlow.js:98` |
| `Response code from OU: ${bbResponse.statusCode}` | Error message constructed when OU answered with a non-200 but no transport error. This Error is what finally reaches platform-api's callback if both fallbacks fail. | smallcaseOrderFlow.placeOrders failure branch _(lvl n/a (Error message; surfaced via PLACEORDERS_SMALLCASEORDERFLOW_ERROR))_ | `sc-platform-babel/others/smallcaseOrderFlow.js:587-589` |
| `sendBBrequest: Invalid method` | Error thrown when bbParams.method is anything other than place / placeDummy / getstatus. Indicates a caller bug, not an infra problem. Note the lowercase 'r' in 'sendBBrequest'. | sendBBRequest() in smallcaseOrderFlow _(lvl n/a (Error))_ | `sc-platform-babel/others/smallcaseOrderFlow.js:198` |
| `Error in removing fix action for iscid ${investedSmallcase.iscid}` | Warn emitted when the post-placement cleanup (archiveBatch + label MANAGE → set isc VALID and $pull actions.fix) fails. The order still succeeds; the user keeps a stale fix action. | postOrderPlacementHandler() in smallcaseOrderFlow _(lvl warn)_ | `sc-platform-babel/others/smallcaseOrderFlow.js:239-243` |
| `[rollbackPlacedOrderChanges] Failed for userId ${userId} iscid ${iscid}` | console.log (NOT the structured logger) when the rollback transaction aborts. Because it is console.log it has no type/level fields — grep the literal bracketed prefix. | rollbackPlacedOrderChanges() in smallcaseOrderFlow _(lvl stdout (unstructured))_ | `sc-platform-babel/others/smallcaseOrderFlow.js:829-833` |
| `placedOrder status update failed` | Error thrown by rollbackPlacedOrderChanges when the PlacedOrders doc was not in RECEIVED (nModified==0) — i.e. someone else already moved it. Rollback aborts and nothing is undone. | rollbackPlacedOrderChanges() _(lvl n/a (Error))_ | `sc-platform-babel/others/smallcaseOrderFlow.js:810-812` |
| `Error in removing invested smallcase for userId ${userId}` | console.log on failure to $pull a BUY isc during rollback. | removeInvestedSmallcase() in smallcaseOrderFlow _(lvl stdout (unstructured))_ | `sc-platform-babel/others/smallcaseOrderFlow.js:739-743` |
| `Error in changing status of invested smallcase for userId ${userId} iscid ${iscid}` | console.log on failure to reset isc status during rollback (non-BUY labels). | changeInvestedSmallcaseStatus() rollback helper _(lvl stdout (unstructured))_ | `sc-platform-babel/others/smallcaseOrderFlow.js:766-769` |
| `Error in changing status of invested smallcase for userId ${userId} and iscid ${iscid}` | console.log on failure to un-hide the fix action during rollback. Note the extra 'and' — this is a DIFFERENT string from the one above. | setHiddenFixActionFlag() rollback helper _(lvl stdout (unstructured))_ | `sc-platform-babel/others/smallcaseOrderFlow.js:786-789` |
| `PLACEORDERS_SMALLCASEORDERFLOW_DEBUG` | platform-api subtype logged immediately BEFORE calling into babel, carrying userDoc, userParams, investedSmallcase, batch and bbParams. The last platform-api-side checkpoint before the hop. | userSmallcaseService.placeOrders _(lvl info)_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:3614-3623` |
| `PLACEORDERS_SMALLCASEORDERFLOW_ERROR` | platform-api subtype when babel's callback returned err or response.networkError. additionalContext holds the response envelope. | userSmallcaseService.placeOrders callback _(lvl error)_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:3637-3641` |
| `PLACEORDERS_SMALLCASEORDERFLOW_SUCCESS` | platform-api subtype on a successful return; message is the babel response (contains batchId and iscid). | userSmallcaseService.placeOrders callback _(lvl info)_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:3644-3647` |
| `PLACEORDERS_V2_SMALLCASEORDERFLOW_ERROR` | Same as above but for the v2 placement service (placeOrders.v2.service.js). | placeOrdersCoreAsync in placeOrders.v2.service _(lvl error)_ | `sc-platform-api/app/services/userSmallcase/placeOrders.v2.service.js:199-203` |
| `PLACEORDERS_V2_SMALLCASEORDERFLOW_SUCCESS` | v2 success marker. | placeOrdersCoreAsync in placeOrders.v2.service _(lvl info)_ | `sc-platform-api/app/services/userSmallcase/placeOrders.v2.service.js:205-208` |
| `PLACEORDERS_V2_DEBUG` | v2 pre-call dump of userDoc/userParams/investedSmallcase/batch/bbParams. | placeOrders.v2.service _(lvl info)_ | `sc-platform-api/app/services/userSmallcase/placeOrders.v2.service.js:536-546` |
| `ORDER_MODE_SELECTION` | platform-api subtype logged just before placement with {orderMode, label, broker, variety, gateway}. Tells you whether the batch went out MARKET or LIMIT and for which broker — the fastest way to confirm an SBI batch's order mode at placement time. | userSmallcaseService.sellAll / fixBatch _(lvl info)_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:3911-3921,4118-4128` |
| `APPLY_DUMMY_FAIL_V2` | platform-api error type when applying a dummy MANAGE/SELLALL batch to the portfolio fails after the dummy was created. Result carries applyFailed/applyError. | placeOrders.v2.service dummy post-place block _(lvl error)_ | `sc-platform-api/app/services/userSmallcase/placeOrders.v2.service.js:853-857` |
| `STAMP_ARCHIVED_BATCH_FAIL` | platform-api error type when the /orders/stamp-superseded PATCH failed. Means the archived batch is superseded in reality but NOT marked — SBI recon will then try to fix a batch it should have skipped. | placeOrders.v2.service dummy post-place block _(lvl error)_ | `sc-platform-api/app/services/userSmallcase/placeOrders.v2.service.js:866-868` |
| `AUTO_ARCHIVED_BEFORE_DUMMY_ORDER` | smallboard subtype (type 'DUMMY_ORDER') logged when an intermittent batch was auto-archived just before placing a dummy. Explains an unexpected MARKEDCOMPLETE on the prior batch. | smallboard.service dummy placement _(lvl info)_ | `sc-platform-api/app/services/smallboard.service.js:1571-1577` |
| `Place order request ->` | order-updates' entry log (type 'API_REQUEST') for POST /orders/place. Logs the full body with `user` blanked but userId kept, plus all request headers. This is the OU-side counterpart of babel's 'Payload being sent to order updates'. | ordersController.placeOrders _(lvl info)_ | `sc-integrations-order-updates/ou-server/controller.js:56-71` |
| `Order placement request received` | order-updates log at the top of placeOrdersWithCAS, carrying batch, investedSmallcase, context, requestId (= platform-api's requestId here), correlationId, userId and clientDetails. THE join point between platform-api and OU logs. | orderPlacement.placeOrdersWithCAS _(lvl info)_ | `sc-integrations-order-updates/services/orders.js:886-892` |
| `Error in sanitizing order request` | order-updates log when validation rejected the batch → HTTP 400 and NO batch created. Carries the whole batch/investedSmallcase/context. If you see this, the placement never existed in `orders`. | placeOrders() in services/orders.js _(lvl error)_ | `sc-integrations-order-updates/services/orders.js:1435-1443` |
| `Error in order placement` | order-updates log for a non-validation failure → HTTP 500. loggingData includes the partially-built batch. | ordersController.placeOrders callback _(lvl error)_ | `sc-integrations-order-updates/ou-server/controller.js:89` |
| `Order placement successful` | order-updates 200-path marker; loggingData.batch is the saved batch. | ordersController.placeOrders callback _(lvl info)_ | `sc-integrations-order-updates/ou-server/controller.js:95` |
| `Batch saved` | order-updates log emitted TWICE per batch — once after the INITIAL save and once after the PLACED save — each with the whole savedBatch object. Two occurrences with the same batchId is normal; only one means placement aborted between broker submission and the final save. | orderPlacement.placeOrdersWithCAS _(lvl info)_ | `sc-integrations-order-updates/services/orders.js:1085,1159` |
| `Error in initial batch saving` | order-updates error log — despite the name it is reused for BOTH the INITIAL and PLACED save failures and for the waterfall error after order placement. A batch can be live at the broker with this logged. | orderPlacement.placeOrdersWithCAS _(lvl error)_ | `sc-integrations-order-updates/services/orders.js:1081,1119,1155` |
| `Error in qs formation` | order-updates error building the broker query string (symbol/token resolution). Fires before anything reaches the broker. | getQueryStringForPlaceOrders callback _(lvl error)_ | `sc-integrations-order-updates/services/orders.js:991,2536,2587` |
| `batch status fetched successfuly` | order-updates /orders/getStatus success log. NOTE THE TYPO ('successfuly', one l). Its presence right after a PLACE_ORDER_OU_HTTPCLIENT/ERROR proves the getstatus recovery hop ran. | ordersController.getStatus _(lvl info)_ | `sc-integrations-order-updates/ou-server/controller.js:261` |
| `failed to fetch batch status` | order-updates /orders/getStatus failure (HTTP 500). Usually accompanied by the 'No such batch found with correlationId: <id>' error message. | ordersController.getStatus _(lvl warn)_ | `sc-integrations-order-updates/ou-server/controller.js:266` |
| `No such batch found with ${batchId ? 'batchId' : 'correlationId'}: ${id}` | order-updates getStatus error message — concrete form 'No such batch found with correlationId: 65f...'. Definitive proof the batch was never created in `orders`. | ordersService.getStatus _(lvl warn (via 'failed to fetch batch status'))_ | `sc-integrations-order-updates/services/orders.js:1638` |
| `Create order request received` | order-updates dummy-order log, carrying the FULL constructed dummy orderObject (batchId, per-order statuses, meta.dummySource, meta.correlationId). The single best line for reconstructing a dummy batch. | ordersService.createBatch _(lvl info)_ | `sc-integrations-order-updates/services/orders.js:1926` |
| `Order inserted` | order-updates confirmation that the dummy batch was written; data is the saved doc. | ordersService.createBatch _(lvl info)_ | `sc-integrations-order-updates/services/orders.js:1933` |
| `Error in archiving batch` | order-updates dummy-order failure: the pre-dummy archive of the existing batch failed, so NO dummy was created and HTTP 500 was returned. Appears both as a log message and as the JSON error body. | ordersService.createBatch _(lvl error)_ | `sc-integrations-order-updates/services/orders.js:1922-1923` |
| `Error in creating order object` | order-updates dummy-order failure while building the dummyOrderObject (usually sid→tradingsymbol resolution). HTTP 500, no batch. | ordersService.createBatch catch _(lvl error)_ | `sc-integrations-order-updates/services/orders.js:1940-1941` |
| `Order cannot be moved to MARKEDCOMPLETE` | order-updates warn when archiveOrder found the latest batch in a non-archivable status. Logs {batchId, status}. This is the usual root cause behind 'Error in archiving batch'. | ordersService.archiveOrder _(lvl warn)_ | `sc-integrations-order-updates/services/orders.js:1988` |
| `Order is already in a valid state and cannot be archived!` | The Error message thrown by archiveOrder in that same situation. | ordersService.archiveOrder _(lvl n/a (Error))_ | `sc-integrations-order-updates/services/orders.js:1987` |
| `No order found against the iscid` | archiveOrder Error when the iscid has zero batches at all. | ordersService.archiveOrder _(lvl n/a (Error))_ | `sc-integrations-order-updates/services/orders.js:1966` |
| `Stamped supersededByDummyBatchId on archived batch` | order-updates log with {archivedBatchId, dummyBatchId, matched, modified}. matched:0 means the archivedBatchId did not exist — the stamp silently did nothing. | ordersService.stampSupersededBatch _(lvl info)_ | `sc-integrations-order-updates/services/orders.js:2212-2218` |
| `Error stamping supersededByDummyBatchId` | order-updates controller-level failure of the PATCH /orders/stamp-superseded. | ordersController.stampSupersededBatch _(lvl error)_ | `sc-integrations-order-updates/ou-server/controller.js:914` |
| `Skipping batch superseded by dummy order — broker update received for archived batch` | sbiReconAllOrders warn (note the em dash) with batchId/label/iscid/supersededByDummyBatchId. This is the recon-side effect of the whole dummy+stamp mechanism. | sbiReconAllOrders.js dealer-order loop _(lvl warn)_ | `sc-integrations-jobs/jobs/reconciliations/sbiReconAllOrders.js:1229-1235` |
| `API request` | order-updates' per-request access log (type 'RESPONSE_LOG') with {url, statusCode, method, responseTime}. Grep url='/orders/place' plus statusCode to find every placement attempt and its HTTP outcome, including ones that never produced a batch. | ou-server app.js middleware _(lvl info)_ | `sc-integrations-order-updates/ou-server/app.js:15-27` |
| `RESPONSE_LOG` | The `type` on the above access log. The cheapest way to count/timeline BB hits. | ou-server app.js middleware _(lvl info)_ | `sc-integrations-order-updates/ou-server/app.js:24` |
| `Unsupported broker:${broker}` | order-updates ValidationError → HTTP 400. Concrete SBI forms would be 'Unsupported broker:sbi' only if config.brokers lacked the key — normally seen for typo'd/new broker keys. | utils.sanitizeOrderRequest / sanitizeAutoSipBatch _(lvl n/a (400 body {error}))_ | `sc-integrations-order-updates/lib/utils.js:609,663,805` |
| `context.correlationId is required` | order-updates ValidationError → 400. Would mean babel failed to attach the PlacedOrders _id — effectively impossible on the normal path, so seeing it implies a non-babel caller. | utils.sanitizeOrderRequest _(lvl n/a (400 body {error}))_ | `sc-integrations-order-updates/lib/utils.js:615` |
| `previousBatchId required for FIX batches` | order-updates ValidationError → 400 for a FIX placement missing previousBatchId. babel only forwards previousBatchId when batch.label === 'FIX'. | utils.sanitizeOrderRequest _(lvl n/a (400 body {error}))_ | `sc-integrations-order-updates/lib/utils.js:619; sc-platform-babel/others/smallcaseOrderFlow.js:479-483` |
| `Must provide a valid access token` | order-updates ValidationError → 400 when user.accessToken is missing/non-string. For dummy orders platform-api deliberately sends accessToken: null — which is fine because dummy orders go to /orders/dummyOrder and never hit sanitizeOrderRequest. | utils.sanitizeOrderRequest _(lvl n/a (400 body {error}))_ | `sc-integrations-order-updates/lib/utils.js:630-632; sc-platform-api/app/services/smallboard.service.js:1582-1589` |
| `Invalid label` | order-updates ValidationError → 400 after the label whitelist mapped an unknown label to undefined. | utils.sanitizeOrderRequest _(lvl n/a (400 body {error}))_ | `sc-integrations-order-updates/lib/utils.js:611-613` |
| `APPLY_BATCH_START` | platform-api RECON_MULTI_DEBUG subtype at the start of applyBatchToIscid — the return leg from OU into platform-api. Carries batchId, correlationId, userId, iscid, label, originalLabel. | userSmallcaseService.applyBatchToIscid _(lvl info)_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:10032-10044` |
| `PLACEDORDER_STATUS_CHECK` | platform-api RECON_MULTI_DEBUG subtype logging the PlacedOrders status right before the apply gate. Shows whether the doc was ACKED (normal) or still RECEIVED (recovery path). | userSmallcaseService.applyBatchToIscid _(lvl info)_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:10068-10081` |
| `PLACEDORDER_INVALID_STATUS` | platform-api RECON_MULTI_DEBUG ERROR subtype — the apply was rejected because PlacedOrders.status was not in {ACKED, RECEIVED, QUEUED}. Logs currentStatus and expectedStatuses. Throws InconsistentOrderState. | userSmallcaseService.applyBatchToIscid _(lvl error)_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:10091-10101` |
| `PLACEDORDER_STATUS_APPLIED` | platform-api RECON_MULTI_DEBUG subtype confirming the RECEIVED/ACKED → APPLIED transition, with previousStatus and newStatus. | userSmallcaseService.applyBatchToIscid _(lvl info)_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:10209-10220` |
| `PlacedOrders state APPLIED ` | DDD_DEBUG_MESSAGES description (trailing space) for the APPLIED transition; extra is the whole batch. | userSmallcaseService.applyBatchToIscid _(lvl info)_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:10222-10231` |
| `MARK_PLACEDORDER_COMPLETED_START` | platform-api RECON_MULTI_DEBUG subtype entering markPlacedOrderAsCompleted. | userSmallcaseService.markPlacedOrderAsCompleted _(lvl info)_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:10447-10457` |
| `MARK_PLACEDORDER_COMPLETED_DONE` | platform-api RECON_MULTI_DEBUG subtype with matchedCount/modifiedCount of the COMPLETED write. modifiedCount:0 means the doc was already COMPLETED (or missing). | userSmallcaseService.markPlacedOrderAsCompleted _(lvl info)_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:10465-10477` |
| `PlacedOrders state COMPLETED` | DDD_DEBUG_MESSAGES description (NO trailing space) for the final transition. The terminal marker of a healthy batch lifecycle. | userSmallcaseService.markPlacedOrderAsCompleted _(lvl info)_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:10479-10488` |
| `Marking reconinitiated as false` | DDD_DEBUG_MESSAGES emitted for RECON_BUY batches after apply, carrying batchId and correlationId. | userSmallcaseService.applyBatchToIscid recon block _(lvl info)_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:10269-10280` |
| `RECON_HANDLING_START` | platform-api RECON_MULTI_DEBUG subtype just before reconApplicationHandling, with hasReconId. | userSmallcaseService.applyBatchToIscid _(lvl info)_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:10233-10243` |
| `API:SCL:` | Redis key prefix for the per-user placement lock: API:SCL:<userId>:<lockKey>. No TTL. Grep platform-api logs for 'Deleting Lock' (v2 service) and check this key in redis when a user is stuck 'order already in progress'. | userSmallcaseService.lockIscid / releasePlacedOrderRedisLock / placeOrders.v2 releaseLockAsync _(lvl info (the 'Deleting Lock' subtype))_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:11226,10021,10494,10533,10753; sc-platform-api/app/services/userSmallcase/placeOrders.v2.service.js:168-175` |
| `BB:bitmap:` | Redis key prefix order-updates uses per batch to track which orders are still awaiting a postback (BB:bitmap:<batchId>). Set bits = orders with no terminal update yet. Checked by cancelAmo and cleared on netting/synthetic completion. | orderPlacement.placeOrdersWithCAS / cancelAmo / holdSecurity _(lvl n/a (redis key))_ | `sc-integrations-order-updates/services/orders.js:1088,1172,1264,2696; sc-integrations-order-updates/services/orders.js:1657` |
| `Synthetic netted completion failed` | order-updates error for rebalance-all netting: a fully-netted leg never reaches the broker and has no poll fallback, so if its synthetic COMPLETE fails the batch can hang. Logs batchId, broker, requestId, orderKey. | orderPlacement.placeOrdersWithCAS netting block _(lvl error)_ | `sc-integrations-order-updates/services/orders.js:1264` |
| `Batch polling skipped` | order-updates info explaining why no poller was started (AUTOSIP / activated / autoSip batches). If an SBI batch never gets polled, check for this line first. | finishPlacement() in placeOrdersWithCAS _(lvl info)_ | `sc-integrations-order-updates/services/orders.js:1208-1214` |
| `Couldn't mark previous batch FIXED` | order-updates error when a FIX batch failed to flip its previousBatchId to status FIXED. The fix batch still exists; the old batch stays in its old status. | placeOrdersWithCAS FIX block _(lvl error)_ | `sc-integrations-order-updates/services/orders.js:1157-1168` |


## Corrections (16)

Where the old `SBI_LOG_INVESTIGATION_GUIDE.md`, or an obvious assumption, is provably wrong.


**Claimed:** "smallcaseOrderFlow.placeOrders ... external npm package @smallcase/sc-platform-babel, not source in any researched repo" — the hop from sc-platform-api into the BB service is undocumented (guide lines 83, 114, 169).

**Actually:** It is plain source in this workspace: sc-platform-babel/others/smallcaseOrderFlow.js, 838 lines, exported at index.js:302. Nothing about this hop is opaque.

`sc-platform-babel/others/smallcaseOrderFlow.js:1-838; sc-platform-babel/index.js:302`


**Claimed:** "batchId — Minted downstream by smallcaseOrderFlow" (guide line 83).

**Actually:** WRONG. smallcaseOrderFlow never mints a batchId; it only reads `bbResponse.data.batchId` off the HTTP response. batchId is minted inside sc-integrations-order-updates: `new mongoose.Types.ObjectId().toString()` at the top of placeOrdersWithCAS for live orders, and `mongoose.Types.ObjectId()` inside dummyOrderObject for dummy orders.

`sc-integrations-order-updates/services/orders.js:885; sc-integrations-order-updates/lib/objects.js:667; sc-platform-babel/others/smallcaseOrderFlow.js:661`


**Claimed:** "correlationId — batch.meta.correlationId, minted upstream of PA" (guide line 89).

**Actually:** WRONG direction. correlationId is minted INSIDE the babel package that PA calls — it is literally the `_id` of the PlacedOrders document babel constructs (`orderOptions.context.correlationId = placedOrders._id`). Nothing upstream of platform-api supplies it. This is why correlationId === placedOrders._id === orders.meta.correlationId.

`sc-platform-babel/others/smallcaseOrderFlow.js:504,536; sc-platform-babel/models/User/InvestedSmallcaseImage.js:12`


**Claimed:** "it POSTs to BB_SERVICE_HOST/BB_SERVICE_PORT (PA/config/config.js:1112-1115 default port 8106, likely an unused local default)" (guide line 114).

**Actually:** Now provable: BB_SERVICE_PORT is definitively unused by this path. babel builds `${bbParams.url}` = `https://${BB_SERVICE_HOST}` with no port at all. order-updates' place-orders server listens on BB_PLACEORDERS_PORT (default 8005), never 8106.

`sc-platform-babel/others/smallcaseOrderFlow.js:72; sc-platform-api/app/services/userSmallcase/userSmallcase.js:3527; sc-integrations-order-updates/config.js:100; sc-integrations-order-updates/ou-server/app.js:11,37`


**Claimed:** Implied by "bbParams.method is 'placeDummy' if params.dummy else 'place'" (guide line 114): that the dummy request goes to a /orders/placeDummy endpoint.

**Actually:** There is NO /orders/placeDummy route. 'placeDummy' is an internal switch value only; the actual HTTP call goes to POST /orders/dummyOrder with a completely rebuilt payload ({batch, options}) rather than the orderOptions shape. Worse for investigators: the log line still reads `POST https://<host>/orders/placeDummy`, so the logged URL never existed.

`sc-platform-babel/others/smallcaseOrderFlow.js:84,162-188,148; sc-integrations-order-updates/ou-server/routes.js:38-41`


**Claimed:** The guide concluded "BB == sc-integrations-order-updates based on indirect evidence" (guide line 98).

**Actually:** Now direct: the three paths babel constructs (/orders/place, /orders/dummyOrder, /orders/getstatus) map 1:1 onto sc-integrations-order-updates/ou-server/routes.js:9, 39 and 12. Note that babel sends lowercase 'getstatus' while the route is declared '/orders/getStatus' — this works only because Express routing is case-insensitive by default and ou-server never enables 'case sensitive routing'.

`sc-platform-babel/others/smallcaseOrderFlow.js:72,84,189-196; sc-integrations-order-updates/ou-server/routes.js:9,12,39; sc-integrations-order-updates/ou-server/app.js:10 (bare express(), no case-sensitivity setting)`


**Claimed:** Obvious assumption: a log line of type 'ORDER UPDATES DOWN' means the order-updates service was unavailable.

**Actually:** FALSE. That branch is reached for ANY failed placement where the /orders/getstatus retry also failed to return a batch — including a perfectly healthy OU returning HTTP 400 for a ValidationError (bad sid, bad quantity, unsupported broker, missing access token). Axios rejects on every non-2xx, and sendBBRequest converts every rejection into `{networkError}`. Always read the preceding PLACE_ORDER_OU_HTTPCLIENT/ERROR line for the real status code before concluding an outage.

`sc-platform-babel/others/smallcaseOrderFlow.js:209-212,583-616; sc-integrations-order-updates/ou-server/controller.js:82-86; sc-integrations-order-updates/lib/utils.js:560-632`


**Claimed:** Obvious assumption: if platform-api returns success for a placement, PlacedOrders.batchId is populated.

**Actually:** Not on the getstatus-recovery path. `handlePlacedOrders` reads `resp.data.success.batchId`, but /orders/getStatus returns `{ success: { batch } }` — the batchId is one level deeper, at `success.batch.batchId`. So on that path batchId is `undefined`: PlacedOrders keeps status ACKED with no batchId, and platform-api returns `batchId: undefined` to the client. The other recovery path (direct Mongo lookup) is unaffected, because it builds `{data:{success: dbOrder}}` and dbOrder.batchId is a real top-level field.

`sc-platform-babel/others/smallcaseOrderFlow.js:260,595-604,637-642; sc-integrations-order-updates/services/orders.js:1641; sc-platform-babel/models/Order/schema.js:114`


**Claimed:** Obvious assumption: the happy path and the failure-recovery path leave the same end state.

**Actually:** They do not. The 200 path calls `user.handleActions(batch, version, {hide:true})`, which removes/hides the buy / rebalance / sip / investMore / fix pending action. `handlePlacedOrders` — used by BOTH recovery paths — never calls it. A batch that recovered therefore leaves the user's pending action visible, which looks to support like a duplicate-order invitation.

`sc-platform-babel/others/smallcaseOrderFlow.js:696-718 vs 251-329; sc-platform-babel/models/User/User.js:1445-1499`


**Claimed:** Obvious assumption: the ACKED log line is the same regardless of which path produced it.

**Actually:** They are distinguishable by ONE character. The normal 200 path logs description "PlacedOrders state ACKED " (trailing space); the recovery path (handlePlacedOrders) logs "PlacedOrders state ACKED" (no trailing space). Same for "PlacedOrders state RECEIVED " / "PlacedOrders state ERROR " / "PlacedOrders state APPLIED " which all carry trailing spaces, while "PlacedOrders state COMPLETED" does not. Exact-match greps only.

`sc-platform-babel/others/smallcaseOrderFlow.js:276,553,620,665; sc-platform-api/app/services/userSmallcase/userSmallcase.js:10225,10482`


**Claimed:** Obvious assumption: the batch status babel sends for a dummy order ("COMPLETED") is what the dummy batch ends up with.

**Actually:** Dead value. `getPlaceDummyOrderPayload` hardcodes `status: "COMPLETED"`, but order-updates' dummyOrderObject recomputes it unconditionally from filled-vs-quantity: all filled → COMPLETED, none filled → UNFILLED, partial → PARTIALLYFILLED. A dummy batch can therefore land as UNFILLED/PARTIALLYFILLED despite the caller asking for COMPLETED — notably when `unplaced` entries pad the quantity.

`sc-platform-babel/others/smallcaseOrderFlow.js:41; sc-integrations-order-updates/lib/objects.js:668-680`


**Claimed:** Obvious assumption: platform-api's 10-second brokerBrokerService timeout protects the place-order call.

**Actually:** It does not. `config.brokerBrokerService.timeout` is only used by the OTHER BB client (ou.bb.integrations.js). bbParams carries only {url, method, requestId}, and the axios instances babel creates set no timeout at all — so a place-order call rides until the ~120s ALB idle timeout. The same bbParams gap means no x-amzn-trace-id header is sent either, while ou.bb.integrations.js does send one.

`sc-platform-api/config/config.js:1112-1116; sc-platform-api/app/integrations/ou/ou.bb.integrations.js:24-32; sc-platform-babel/others/smallcaseOrderFlow.js:69-91,157-199; sc-platform-api/app/services/userSmallcase/userSmallcase.js:3526-3529`


**Claimed:** Obvious assumption: 'requestId' means the same thing on both sides of the hop.

**Actually:** It does not. Inside order-updates' placement path `var requestId = context.correlationId;` rebinds it, so every OU log field called `requestId` for a placement is actually the platform correlationId (= PlacedOrders._id). Only the single entry log 'Order placement request received' logs the true upstream requestId, alongside correlationId. Joining platform-api↔OU on 'requestId' without knowing this gives false negatives.

`sc-integrations-order-updates/services/orders.js:938,886-892`


**Claimed:** Obvious assumption: 'the babel package' is one thing.

**Actually:** There are two divergent implementations of smallcaseOrderFlow in this workspace and both are in production use. sc-platform-babel v6.6.2 (838 lines) is what sc-platform-api uses; sc-babel v19.0.2-stableApi.12 (555 lines) is what sc-smallboard-be's support archive/cancel path uses, and it lacks `sipConfig`, all the dummy extras (dummySource/dealerId/previousBatchId/originalBatchId/originalLabel) and the entire direct-Mongo fallback. smallboard-be depends on both packages at once.

`sc-babel/package.json:2-3; sc-babel/others/smallcaseOrderFlow.js:16-41,195,366-427; sc-smallboard-be/package.json:10,12; sc-smallboard-be/app/services/api/support.js:18-19,239`


**Claimed:** Task brief assumption: "broker-lib, broker-api and leprechaun are on 'rebalance-in-amo'".

**Actually:** Only leprechaun is. At research time sc-integrations-broker-lib was on `development` (dbe4206f) and sc-integrations-leprechaun on `rebalance-in-amo` (89e424e). Separately, the stale-node_modules risk is real but inverted from what you might fear: sc-platform-api's installed sc-platform-babel is 6.3.1-rebalance-in-amo.0 while its package-lock.json pins 6.6.2 — so the CHECKED-OUT repo source is what prod runs, and the local node_modules is the outlier. The only smallcaseOrderFlow difference between the two builds is one extra line, `rebalanceInAMO: batch.rebalanceInAMO`, present in the feature build and absent from production 6.6.2.

`git -C sc-integrations-broker-lib rev-parse --abbrev-ref HEAD → development; sc-platform-api/package-lock.json:6578-6581; sc-platform-api/node_modules/@smallcase/sc-platform-babel/others/smallcaseOrderFlow.js:473`


**Claimed:** Obvious assumption: sc-integrations-order-updates participates in the PlacedOrders state machine.

**Actually:** It never touches it. Greps across order-updates' services/, lib/ and consumer/ and across leprechaun return zero references to the `placedOrders` collection. PlacedOrders is written ONLY by sc-platform-babel/sc-babel (RECEIVED, ACKED, COMPLETED-on-cancel, ERROR-on-rollback) and sc-platform-api (APPLIED, COMPLETED, QUEUED). When reasoning about who mutated a PlacedOrders doc, OU is never the answer.

`sc-integrations-order-updates/services,lib,consumer (no 'placedOrders' matches); sc-platform-babel/others/smallcaseOrderFlow.js:301-312,379-383,801-808; sc-platform-api/app/services/userSmallcase/userSmallcase.js:10203,10460; sc-platform-api/app/repositories/placedOrders.repository.js:11-110`


## Open questions (6)

Genuinely unresolved. Report these as unknown rather than guessing.

- The in-code comment at smallcaseOrderFlow.js:654 says PlacedOrders stuck in RECEIVED 'will be handled by OU-Recon Job', and the OU_ACK_PENDING write is commented out at :655. I could not find any such job in sc-integrations-jobs — the only job touching PlacedOrders is the read-only sanity report batchAndPlacedOrdersMismatch.js. Either the job lives in a repo not checked out here (sc-platform-worker? scheduler?), or the comment is stale and stuck-RECEIVED docs are never auto-healed. UNCONFIRMED — worth resolving before the skill tells an operator 'a job will pick it up'.
- The actual production value of BB_SERVICE_HOST (and therefore whether /orders/place traffic crosses an ALB, an internal ingress, or service mesh) is not in any checked-out file — it is an env var. UNCONFIRMED.
- Whether elastic-apm-node's http instrumentation injects `traceparent`/`elastic-apm-traceparent` onto babel's axios calls (giving an implicit trace join between platform-api and order-updates even though babel sets no headers). platform-api does load elastic-apm-node in config/logger.js, and order-updates has apm.currentTraceIds in its logger, so it is plausible — but I did not read the APM agent's instrumentation to confirm. INFERRED, not confirmed.
- The getstatus-recovery batchId bug (reading resp.data.success.batchId where the payload is {success:{batch}}) results in `$set: {batchId: undefined}` on PlacedOrders. Whether mongoose 6 silently drops that key or writes null was not verified against the driver, so the exact DB end-state (batchId absent vs batchId null) is UNCONFIRMED — though either way it is not the real batchId.
- sc-integrations-jobs/jobs/createBrokerAutoSipOrders.js also imports smallcaseOrderFlow; I did not read it in depth because placeActivatedOrders.js (its sibling) is axis-only. Whether it can place SBI batches through this hop is UNCONFIRMED and worth a follow-up if SBI autosip is ever in scope.
- sc-platform-worker and the `scheduler` directory are present in the workspace but were not searched. If any additional writer of PlacedOrders or `orders` lives there, the 'who can write what' list above is incomplete.
