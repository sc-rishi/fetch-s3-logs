# smallboard-provenance

sc-smallboard-be — every manual operator path and what it does or does not record.

**branch when read:** production

sc-smallboard-be is smallcase's internal ops dashboard backend (prod: `smallboard-api.util.smallcase.com`, k8s "util" env, `DGN='production'`). It is the ONLY human-driven writer of Order/SSTOrder state. Every order-mutating route is `POST /api/support/*` (plus `/api/IndianEq/*`, `/api/autoRecon/*`, `/api/leprechaun/marketStatus`, `/api/corpActions/*`), gated by a Google-OAuth JWT cookie (`_smallboard_jwt`) and a per-route permission string via `authController.verifyRouteAccess(<perm>)`. Critically, smallboard contains ZERO SBI-specific code — SBI and SBI-MTF orders are mutated through exactly the same broker-agnostic endpoints as every other broker, so "was this SBI order touched by a human?" is answered by endpoint + timestamp + operator, never by a broker branch. Three write styles exist: (a) proxied writes to order-updates (`bb.prod.smallcase.com`) or platform-api (`api-k8s.prod.smallcase.com`), (b) direct Mongo writes from smallboard's own process (the "quiet paths" — no log, no actor, no `meta.updates`), and (c) client-side document mutation posted wholesale downstream (the SST path). Human identity DOES survive in several places the existing guide says it does not: `supportRequests.openedBy`, `bulkSupportRequests.openedBy`, `reverseSupportRequests.openedBy`, `brokerAutoReconPendingApprovals.actionedBy/pricedBy`, the `DUMMY_ORDER_AUDIT` structured log, and the universal `REQUEST_LOG`/`RESPONSE_LOG` middleware which stamps `message.user.email` plus the full request body (batchId included) on EVERY authenticated `/api` call.

Confidence markers are the researcher's own: unmarked = confirmed from source, `[INFERRED]` = deduced but unproven, `[UNCONFIRMED]` = a lead, not a fact. `!` marks facts flagged critical. Re-verify line numbers against the checked-out SHA.


## Facts (81)


### service-identity-and-logs

- **!** smallboard's logger name is `sc.service.smallboard` — built as `getJsonLogger('sc.service.' + loggerConfig.loggerName)` where loggerName is hardcoded 'smallboard'. This is the `name` field an investigator greps for in S3 log lines emitted by this service.  
  `config/logger.js:1-7 (with config/config.js:8-9)`
- **!** EVERY authenticated request to /api/* and /mf/* emits two structured log entries: `type: 'REQUEST_LOG'` and `type: 'RESPONSE_LOG'`. Both carry `message.user.email` (the operator), `message.url`, `message.requestId`, and `message.extra.body` (the FULL request body — so batchId, iscid, trades[] are all present). This is the single most complete human-attribution trail smallboard produces, and it exists for every mutating endpoint whether or not that endpoint logs anything of its own.  
  `app/server.js:63-140 (REQUEST_LOG at :72, RESPONSE_LOG at :103), mounted at app/server.js:212-213`
- `req.requestId` is `req.headers['x-amzn-trace-id']` or, absent that, a literal `id-<Math.random()>` string. A `REQUEST_LOG` and its `RESPONSE_LOG` can be paired on this value.  
  `app/server.js:69`
- Prod deployment is the k8s 'util' environment, applicationTeam 'platform', APPLICATION_NAME 'sc-smallboard-be', DGN='production', NODE_PORT 8082. Prod API host is `smallboard-api.util.smallcase.com` (internal ALB) for /api,/auth,/mf,/webhook,/QAAutomation; `smallboard-api.smallcase.com` is external but only routes /slack/interactions and /health.  
  `deployment/infra/util-sc-smallboard-be.yaml:53-75, deployment/infra/util-sc-smallboard-be-onboard.yaml:5-6, deployment/infra/util-sc-smallboard-be-env.yaml:2-4, .github/workflows/util_cd.yaml:13-17`
- **!** The exact S3 prefix for smallboard pod logs is NOT derivable from this repo. The EKS log bucket convention used by the toolkit is `s3://sc-eks-pod-logs/<production|staging>/<date>/<namespace>/<service>-pod/`; smallboard's cluster env is 'util' (not 'production') and its team/namespace is 'platform', so the most likely prefix is `s3://sc-eks-pod-logs/util/<date>/platform/sc-smallboard-be-pod/`. This has NOT been verified against S3. `[UNCONFIRMED]`  
  `deployment/infra/util-sc-smallboard-be-onboard.yaml:5-6 + /Users/rishidatta/Desktop/integrations/fetch-s3-logs/search-s3-logs.js:49-65`

### auth

- **!** Operator auth is a Google OAuth2 code exchange at `GET /auth/login`. The decoded Google `email` is looked up in the `internalUsers` Mongo collection; an unknown email is AUTO-CREATED with roles ['Leprechaun_Leprechaun_user'] (minimal access). A JWT with `{id, email, name}` is set as the httpOnly cookie `_smallboard_jwt` (7-day maxAge); a non-httpOnly `_smallboard_internalUsers` cookie carries display fields for the FE.  
  `app/controllers/auth/index.js:176-330 (cookie write at :300-325), cookieTimeout at :13`
- The JWT deliberately does NOT carry permissions. `checkUser` verifies the token then fetches `permissionsGroupsList` from Redis key `SMALLBOARD:PERMISSIONS_GROUPS_LIST:<internalUserId>` (falling back to the `internalUsers` doc and repopulating the cache). Arbitrary per-user grants live at Redis key `SMALLBOARD:ARBITRARY_PERMISSIONS:<internalUserId>`.  
  `app/server.js:25-46, app/services/auth/index.js:19-54 and :66-90`
- **!** `verifyRouteAccess(perm)` expands the user's `permissionsGroupsList` through `config.groupedPermissionsMap`, then falls back to `arbitraryPermissions`. To answer 'who COULD have done this', query `db.internalUsers.find({$or:[{permissionsGroupsList: '<group>'},{arbitraryPermissions:'<perm>'}]})`.  
  `app/controllers/auth/index.js:429-470; groupedPermissionsMap at config/index.js:3994+`
- The internalUsers schema is `{email (unique, lowercased), access:{admin,broker}, type, isManager, meta:{dateCreated, profile:{name,picture,chat,phone,virtualPhone}}, roles:[String], permissionsGroupsList:[String], arbitraryPermissions:[String]}`, collection `internalUsers`. Note there is NO audit/lastAction field of any kind.  
  `node_modules/@smallcase/sc-platform-babel/models/User/InternalUser.js:3,13-44`
- **!** Permission groups that grant order mutation: 'Support_Fix Error Order_user' → [getErrorOrder, updateErrorOrder]; 'Support_Update Batch Status_user' → [updateBatchStatus]; 'Support_Fix SST Orders_user' → [getSstOrder, updateErrorOrder, updateSstOrder]; 'Support_User Profile_user' → includes cancelBatch, reverseDummyOrder, updateSmallcaseName, endSip; 'Support_User Profile_admin' → includes newSupportRequest; 'Support_Support Requests_admin' → [approveReverseSupportRequest]; 'Support_Bulk Dummy Trade_user' → [newBulkSupportRequest,...]; 'Support_Create Invested Smallcase_user' → [createInvestedSmallcase, createInvestedScFromBatchId].  
  `config/index.js:4060-4192`
- A legacy role map grants `updateErrorOrder` + `updateBatchStatus` + `dummyOrders` to the role 'AI-Automation', and `brokerMigration` + `invalidIscidFix` to 'ROTA'. This map is named `rolesAndPermissionsMapBackupOld` and is NOT the one verifyRouteAccess reads (that is `groupedPermissionsMap`) — but the same names appear as permissionsGroupsList entries, so treat these as plausible grantors when triaging. `[INFERRED]`  
  `config/index.js:2416-2456 (rolesAndPermissionsMapBackupOld) vs app/controllers/auth/index.js:436-446`

### fix-error-order

- **!** `POST /api/support/updateErrorOrder` (permission `updateErrorOrder`) is the main manual ERROR-order fix. Body: `{batchId, trades:[{sid, filledQuantity, averagePrice}]}`. It loads `Order.findOne({_id: batchId, status: 'ERROR'})` — a batch NOT in ERROR is rejected with `No error order with batchId: <batchId>` — then forwards to order-updates.  
  `app/routes/api/support.js:113-118, app/controllers/api/support.js:1436-1454, app/services/helper/integrations.helper.js:159-174`
- **!** The actual downstream call is `POST https://bb.prod.smallcase.com/errors/fix/${batch.batchId}` with body `{force: true, fixBy: tradebook.length ? 'orderbook' : 'unlocking', tradebook}`. `force:true` is ALWAYS set from smallboard. `fixBy` is derived purely from whether any supplied trade had both filledQuantity and averagePrice — an operator submitting an empty/zero tradebook produces `fixBy:'unlocking'`.  
  `app/services/helper/integrations.helper.js:118-142 (URL at :136, body at :137-141); host from config/index.js:185-188 + deployment/infra/util-sc-smallboard-be-env.yaml:18-19`
- **!** Before POSTing, smallboard merges each supplied trade over the existing leg (`{...batchMap[t.sid], ...t}`), defaults `orderTimestamp` to the batch date, and runs `setOrderStatus` which sets COMPLETE if quantity===filledQuantity, PARTIAL if filledQuantity>0, else REJECTED when `orderId` is truthy or ERROR when it is not. Legs with no filledQuantity/averagePrice are filtered OUT of the tradebook entirely.  
  `app/services/helper/integrations.helper.js:119-132, app/services/util/integrations.util.js:130-141`
- **!** smallboard sends NO `requestSource` header/field on the /errors/fix call, so order-updates applies its own default. It also sends no operator identity of any kind on this call — the only human trace is the Mattermost post and smallboard's own REQUEST_LOG.  
  `app/services/helper/integrations.helper.js:134-142 (no headers object)`
- **!** On success smallboard posts to Mattermost channel `fix-error-order` with the operator's Mattermost @username resolved from `req.user.email`. Exact message text: `[${environment.toUpperCase()}] Error batch (${data.batchId}) updated by @${username}` where environment = `config.DGN` = 'production'.  
  `app/controllers/api/support.js:1446-1453 (channel const at :36), app/services/mattermost/index.js:35-42 and :66-97, config/index.js:194`

### update-batch-status

- **!** `POST /api/support/updateBatchStatus` (permission `updateBatchStatus`, body `{batchId}`) forces a batch to ERROR so it can then be fixed. It does NOT write Mongo from smallboard — it calls order-updates `PATCH https://bb.prod.smallcase.com/smallboard/orders?batchId=<id>` with body `{status:'ERROR'}` and header `X-DOMAIN-TOKEN: <INTEGRATIONS_DOMAIN_TOKEN>`, 6s timeout.  
  `app/routes/api/support.js:218-223, app/controllers/api/support.js:1669-1726, app/services/api/support.js:37-43, app/integrations/ou/ou.scb.integrations.js:17-24 and :35-51, config/index.js:261-265, deployment/infra/util-sc-smallboard-be-env.yaml:33`
- **!** A two-step-rebalance guard runs BEFORE the OU call. It blocks (HTTP 409, message 'Cannot update batch status while two-step rebalance is in progress') when the Order has `meta.twoStep` present AND `completedDate` is null/undefined, unless `meta.twoStep.phase === 'SELL_LEG'` (always allowed) or phase is SELL_COMPLETE/BUY_LEG and the computed retryAt has passed. retryAt = buyLegScheduledFor+10s for MARKET, 09:30 IST on the next market day for AMO, 09:30 IST same day for REBALANCE_SIP.  
  `app/services/api/twoStepBatchStatusGuard.js:1-21, :102-164, :191-205; controller 409 at app/controllers/api/support.js:1673-1702`
- **!** A blocked two-step update emits `jsonLogger.warn({batchId, iscid, phase, mechanism, retryAt}, 'Blocked support batch status update during two-step rebalance')` and sends NO Mattermost notification.  
  `app/controllers/api/support.js:1681-1690`
- **!** On success it posts to Mattermost channel `fix-error-order` with `changeToError:true`, rendering exactly: `[${environment.toUpperCase()}] Batch (${data.batchId}) status changed to ERROR by @${username}`.  
  `app/controllers/api/support.js:1709-1715, app/services/mattermost/index.js:34-37`
- **!** Downstream, order-updates' `updateOrderFields` runs a Joi allowlist: when addressed by batchId the ONLY writable field is `status` and the ONLY accepted value is `ERROR`; when addressed by iscid the only writable field is `name`. Everything else is stripped (stripUnknown:true). The Mongo filter additionally requires current status ∈ {PLACED, PARTIALLYPLACED, ACKED}, and the same `updateMany` is applied to BOTH the `Order` and `SSTOrder` collections.  
  `sc-integrations-order-updates/lib/utils.js:887-926, sc-integrations-order-updates/services/orders.js:2174-2202`

### cancel-batch

- **!** `POST /api/support/cancelBatch` (permission `cancelBatch`, body `{userId, batchId, iscid, label, source, did, scid}`) runs three middlewares: `scidLockCheck` → `cancelBatchValidation` → `cancelBatch`. The lock check reads Redis `API:SCL:<userId>:<lockKey>` where lockKey is `did` (BUY+CUSTOM/CREATED), `scid` (other BUY) or `iscid` (non-BUY); if locked it returns 400 'Scid or iscid locked for placing orders' and logs `new Error('SCID/ISCID locked for user')` with context {userId, lockKey, value}.  
  `app/routes/api/support.js:264-271, app/controllers/api/support.js:1080-1122, app/services/api/support.js:226-234`
- **!** cancelBatch is the ONLY smallboard endpoint that stamps provenance into the Order document: `batchDoc.meta.source = 'smallboard'` is set explicitly in smallboard before delegating to sc-babel's `smallcaseOrderFlow.cancelBatch`.  
  `app/services/api/support.js:236-261 (stamp at :238)`
- **!** sc-babel's cancelBatch sets `batch.status = 'MARKEDCOMPLETE'`, flips the invested smallcase to 'VALID' (or 'PLACED' with preserveIsc), removes matching entries from `user.actions.fix`, may splice the invested smallcase out entirely, then calls RAW `batch.save()` and `user.save()`. If the isc was deleted and events were passed it produces Kafka `ISC_deleted`. If `batch.meta.correlationId` exists it sets that PlacedOrders doc to status 'COMPLETED'.  
  `node_modules/@smallcase/sc-babel/others/smallcaseOrderFlow.js:145-193`
- **!** Because cancelBatch uses raw `batch.save()` and never `Order.saveOrder()`/`recordUpdate()`, it appends NOTHING to `meta.updates`. Fingerprint of a manual smallboard cancel: `status === 'MARKEDCOMPLETE'` AND `meta.source === 'smallboard'` AND no new `meta.updates` entry at the cancel timestamp.  
  `node_modules/@smallcase/sc-babel/others/smallcaseOrderFlow.js:169 vs node_modules/@smallcase/sc-babel/models/Order/Order.js:93-104`
- **!** The operator id IS captured at cancelBatch time as `{archivedBy: req.user.id}` — but it is passed only into the conditional `endSip` call (as `internalUserId`, remarks 'SUPPORT - archive order') that fires when the isc is deleted AND the isc had flags.sip. It is NEVER written to the Order. So for a non-SIP smallcase, archivedBy is discarded entirely.  
  `app/controllers/api/support.js:1863-1888 (archivedBy at :1873), app/services/api/support.js:236-261 (:247-253)`
- cancelBatch emits no success log at all — only `jsonLogger.error(err, {context:{batchId, iscid}})` on failure. Its trace is REQUEST_LOG/RESPONSE_LOG plus the document state.  
  `app/controllers/api/support.js:1875-1886`

### sst-fix

- **!** SST (Single Securities Transactions) fixes are a completely separate mechanism that bypasses order-updates. `POST /api/support/getSstOrder` (perm getSstOrder) GETs `PLATFORM_SERVICE_URL/v1/internal/smallboard/reconcile?batchId=<id>`; `POST /api/support/updateSstOrder` (perm updateSstOrder, body `{batchId, trades}`) re-fetches the batch, mutates it CLIENT-SIDE in `fixSSTBatch`, then POSTs the whole mutated document to the same `/v1/internal/smallboard/reconcile`.  
  `app/routes/api/support.js:125-136, app/controllers/api/support.js:972-1008, app/services/helper/platform.helper.js:553-573 and :663-683, requestUrlMap at :786-797, URL at lib/constants.js:21`
- **!** `fixSSTBatch` sets `statusMessage = 'Order fixed by support request.'` on EVERY leg it touches — both the legs it fills (moved to batch.orders with status COMPLETE or PARTIAL) and the legs it cannot fill (moved to batch.unplaced with status ERROR). This string in an SSTOrder leg is a definitive manual-smallboard-fix marker.  
  `app/services/helper/platform.helper.js:588-661 (strings at :633 and :638)`
- **!** `fixSSTBatch` also APPENDS a `meta.updates` entry client-side: `{update: 'Order saved initially with status ' + status, date: <now>}`. Because the canonical sc-babel writer only emits that exact 'saved initially' string on a genuinely NEW order, an SSTOrder whose meta.updates contains a SECOND/late 'Order saved initially with status X' entry — especially one dated after an 'Order saved finally...' entry — is a manual smallboard SST fix. This is a real document-level fingerprint, not state-derived.  
  `app/services/helper/platform.helper.js:644-658 (:650-657), vs node_modules/@smallcase/sc-babel/models/Order/Order.js:22-47 (:44) and :49-80 (:76)`
- **!** fixSSTBatch also sets `batch.errorStatus = false`, recomputes `buyAmount`/`sellAmount`/`filled`/`quantity` from scratch, sets `completedDate = new Date()`, and recomputes status via setSSTOrderStatus: COMPLETED when quantity===filled, PARTIALLYFILLED when buyAmount>0 or sellAmount>0, UNPLACED when unplaced.length===quantity, else UNFILLED.  
  `app/services/helper/platform.helper.js:575-586 and :597-647`
- **!** Server side, platform-api's `POST /v1/internal/smallboard/reconcile` does `SSTOrder.findOneAndUpdate({batchId, status:{$in:[PLACED,PARTIALLYPLACED,ERROR]}}, batch)` — a whole-document replace with the client-supplied batch, adding NO provenance of its own. An SST batch in any other status is rejected with `The batch is ineligible for reconciliation`.  
  `sc-platform-api/routes/internal/smallboard.route.js:76-79, sc-platform-api/app/services/smallboard.service.js:1505-1535`
- **!** After the POST, smallboard produces Kafka event `SST_ORDER_finished` with `{batch}` and logs three lines in sequence: 'SST_ORDER_finished event produced', 'Batch saved', 'Applying order to user: ' + JSON.stringify(diff). It then sends the Mattermost `fix-error-order` message (the non-changeToError variant, i.e. 'Error batch (<batchId>) updated by @<user>').  
  `app/services/helper/platform.helper.js:663-683, app/controllers/api/support.js:999-1005`

### support-requests

- **!** Human identity IS persisted for the support-request family. `supportRequests` (collection `supportRequests`), `bulkSupportRequests` and `reverseSupportRequests` all carry `openedBy: {name: String, userId: ObjectId}` populated from `req.user.name` / `req.user.id`.  
  `node_modules/@smallcase/sc-babel/models/SupportRequestSchema.js:20-23, models/SupportRequests.js:2, models/BulkSupportRequest.js:3,22-25, models/ReverseSupportRequests.js:2,6-9; populated at app/controllers/api/support.js:856-859, :1139-1142, :1219, :2215-2218`
- **!** IMPORTANT REGRESSION: `POST /api/support/newRequest` with `type === 'trades'` NO LONGER creates a supportRequests document. Both the CSV branch (`form === false`) and the form branch now call platform-api placeDummyOrder directly and return `{batchId, directFlow: true}` without ever reaching `internalService.newSupportRequest`. Only non-'trades' types (exit, exitAll, addStocks, forceArchive, revLedger, aggregateTrades, adjustTopLevelHoldings) still produce a supportRequests doc with openedBy.  
  `app/controllers/api/support.js:699-848 (CSV branch returns at :825-827) and :866-943 (form branch returns at :933-936); the surviving supportRequests write at :946-962 → app/services/api/internal.service.js:370-394`
- **!** For the new direct trades flow, the ONLY operator trace smallboard writes is a structured log `{type:'DUMMY_ORDER_AUDIT', message:{brokerId, userId, trades, batchId, operatorId, operatorName, tradeSource:'manual'}}`. It is emitted from both the CSV branch and the single-form branch. Grep this on `batchId` to attribute a manual dummy order to a person.  
  `app/controllers/api/support.js:798-811 and :921-932`
- **!** The CSV/direct trades path places orders with `label:'MANAGE'`, `variety:'regular'`, `clientType:'web'`, and `dummySource:'csv_upload'` (CSV branch only; the single-form branch omits dummySource). It retries only on statusCode>=500, max 3 attempts, backoff 1000ms then 2000ms.  
  `app/controllers/api/support.js:743-757 and :780-790, :904-913`
- **!** createOrderSets splits an uploaded CSV into TWO batches when a ticker has both a BUY and a SELL: set 1 = all BUYs + SELLs with no matching BUY, set 2 = SELLs whose ticker also has a BUY. The sets are placed sequentially, so one CSV upload can legitimately produce two distinct batchIds seconds apart for the same iscid.  
  `app/controllers/api/support.js:709-713 and :816-823, app/services/api/support.js:263-300`
- **!** Partial-failure mode is explicitly unresolved: if set 1 places and set 2 throws, the already-placed batches are orphaned and the operator gets a plain 500. The orphan batchIds appear only in the log line `'Partial dummy-order placement: some batches placed before failure'` with `{placedBatchIds, iscid, userId}`.  
  `app/controllers/api/support.js:828-843 (:834-839)`
- Bulk dummy trades: `POST /api/support/newBulkSupportRequest` inserts many `bulkSupportRequests` docs sharing one `bulkId` with `openedBy`, then produces Kafka `BULK_supportRequest` with `{bulkId}`. It logs `'User level support request log'` with `{context:{body, user}}` on entry and `'User level support request output'` with `{context:{res, user}}` when any row failed validation.  
  `app/controllers/api/support.js:1125-1254 (logs at :1133-1138 and :1238-1243, kafka at :1249), app/services/api/internal.service.js:396-399`
- **!** The openedBy audit trail is DESTRUCTIBLE by an ordinary support user: `DELETE /api/support/request` (permission `deleteSupportRequest`, in group 'Support_Support Requests_user') hard-deletes via `SupportRequests.remove({_id: requestId})`. `deleteReverseSupportRequest` likewise does `ReverseSupportRequests.deleteOne({_id})`. Absence of a supportRequests doc therefore does not prove no support request existed.  
  `app/routes/api/support.js:89-94, app/services/api/internal.service.js:518-520 and :29-31, config/index.js:4123-4131`

### reverse-support-request

- **!** `POST /api/support/approveReverseSupportRequest` (permission `approveReverseSupportRequest`, admin-only group) is the heaviest human mutation: it rolls the User document back to `supportRequest.prevInvestedSmallcasesSnapshot`, then either (case 1, updated request is 'trades') calls `processReverseSupportRequest`, or (case 2, pure reversal) calls `deleteDummyOrder(batchId)` which HARD-DELETES the Order. It then re-applies all subsequent orders to the user and marks both requests 'REVERSED'.  
  `app/controllers/api/support.js:1940-2177 (user.save at :2019, deleteDummyOrder at :2124-2136, applyOrdersToUser at :2159, status writes at :2160-2167)`
- **!** `supportService.deleteDummyOrder` calls `DELETE http://bb.prod.smallcase.com:80/orders/dummyOrder` with body `{batchId}`. Order-updates validates `order.dummy === true` (403 'Not a dummy order' otherwise) and then runs `Order.deleteOne({_id: batchId})` — a permanent hard delete plus a Redis cleanup keyed on the broker.  
  `app/services/api/support.js:421-444, sc-integrations-order-updates/ou-server/controller.js:572-592, sc-integrations-order-updates/services/orders.js:1945-1958`
- Reversal is blocked if any corp action exists on the affected constituents since the support-request date; the reverse request is then set to status ERROR with errorMessage `${corpActionsCount} corp actions are present` (exit type) or the request 400s with 'Need to do it manually as corpActions are present' (trades type).  
  `app/controllers/api/support.js:2033-2051 and :2080-2093`
- **!** A safety check `postReversalApplyingOrdersValidation` aborts with errorMessage 'Shares count is becomming -ve while applying orders, please mark it to ROTA' — but only AFTER `user.save()` has already committed the snapshot rollback, so the user document can be left rolled-back while the request is marked ERROR.  
  `app/controllers/api/support.js:2019 (save) then :2144-2158 (check)`

### reverse-dummy-order

- **!** `POST /api/support/order/dummy/reverse` (permission `reverseDummyOrder`, granted broadly via 'Support_User Profile_user') proxies to platform-api `POST /v1/internal/smallboard/order/dummy/reverse` with `{batchId}`. platform-api requires the order to be dummy and in COMPLETED/MARKEDCOMPLETE/FIXED, restores the investedSmallcase image, DELETES the dummy Order via order-updates, re-applies later orders, and sets the PlacedOrders doc to 'REVERSED'.  
  `app/routes/api/support.js:381-386, app/controllers/api/support.js:2454-2458, app/services/api/support.js:82-84, app/services/helper/platform.helper.js:720-727 + lib/constants.js:22, sc-platform-api/app/services/smallboard.service.js:1644-1752`
- **!** Consequence for an investigator: a batchId that yields NOTHING from the orders collection may have been reverse-dummy-ordered (or bulk-deleted) rather than never existing. Check `placedOrders` for status 'REVERSED' on that correlation, and grep order-updates for 'Delete Batch Request receivied' / 'Deleted Batch' with that batchId.  
  `sc-platform-api/app/services/smallboard.service.js:1718-1748, sc-integrations-order-updates/services/orders.js:1945-1957`

### auto-recon-approval

- **!** MAJOR: a THIRD human path exists and it DOES persist the operator's email. `PATCH /api/autoRecon/:id/approve`, `PATCH /api/autoRecon/:id/reject`, `PATCH /api/autoRecon/updatePrice`, `POST /api/autoRecon/bulkApproveBySid` proxy to platform-api `/v1/internal/smallboard/auto-recon/*` sending `approvedBy: req.user.email` / `rejectedBy: req.user.email` / `pricedBy: req.user.email`.  
  `app/routes/api/autoRecon.js:7-40, app/controllers/api/autoRecon.js:26-87`
- **!** platform-api writes those to Mongo collection `brokerAutoReconPendingApprovals`: `{status:'APPROVED'|'REJECTED', actionedBy:<email>, actionedAt:<Date>, rejectionReason, pricedBy:<email>, pricedAt}`. Query by `{userId, iscid, sid, broker, createdDate}` to attribute an SBI-MTF auto-recon dummy order to the human who approved it.  
  `sc-platform-api/app/services/brokerAutoRecon/brokerAutoRecon.service.js:46-136, sc-platform-api/node_modules/@smallcase/sc-platform-babel/models/Broker/BrokerAutoReconPendingApproval.js:2,4-43`
- **!** The auto-recon approval document schema fields are: userId, iscid, sid, shortfallQty, ohlcPrice, dummySource (default 'AUTO_POSITIONS_RECON_OHLC'), priceSource, corpActionType, exDate, createdDate, status ∈ {PENDING_APPROVAL, APPROVED, REJECTED, AUTO_REJECTED, EXECUTED, EXECUTION_FAILED}, actionedBy, actionedAt, rejectionReason, autoRejectedAt, pricedBy, pricedAt, broker. Indexed on {broker, createdDate, status}.  
  `sc-platform-api/node_modules/@smallcase/sc-platform-babel/models/Broker/BrokerAutoReconPendingApproval.js:6-46`
- **!** SBI-MTF relevance: platform-api's recon dummy-order placer defaults the synthetic request's broker to `'sbimtf'` when the user document has no broker.name, and places SELL-only dummy orders with `label:'MANAGE'`, `isGroupOrder:true`, `dummy:true`, `dummySource: trade.dummySource || 'AUTO_POSITIONS_RECON'`.  
  `sc-platform-api/app/services/brokerAutoRecon/brokerAutoRecon.service.js:251-301 (:258, :281-300)`
- **!** Approval produces Kafka `AUTO_RECON_CORP_ACTION_APPROVED` with `{approvalId, broker}` and logs `{type:'AUTO_RECON_CORP_ACTION', subtype:'KAFKA_PRODUCE_ATTEMPT'|'KAFKA_PRODUCE_SUCCESS'}`; the bulk path uses subtypes BULK_KAFKA_PRODUCE_ATTEMPT / BULK_KAFKA_PRODUCE_SUCCESS / BULK_KAFKA_PRODUCE_FAILED / BULK_KAFKA_PRODUCE_SUMMARY. Rejection produces no event.  
  `sc-platform-api/app/services/brokerAutoRecon/brokerAutoRecon.service.js:14, :66-76, :141-191`

### quiet-path

- **!** QUIET PATH 1 — `POST /api/support/updateSmallcaseName` (permission `updateSmallcaseName`) fans out SIX direct Mongo writes with no logging and no actor: User.investedSmallcases.$.name, User.actions.fix.$.name, User.actions.sip.$.name, User.actions.rebalance.$.name, `Order.updateMany({iscid}, {$set:{name}})` (EVERY order for that iscid), `Sip.updateMany({iscid},...)`, and an in-place UserLedger.smallcaseLedger rewrite + save.  
  `app/routes/api/support.js:137-142, app/controllers/api/support.js:1402-1421, app/services/helper/platform.helper.js:876-956 (Order write via app/services/helper/integrations.helper.js:180-188)`
- **!** QUIET PATH 2 — `POST /api/IndianEq/broker/migration` (permission `brokerMigration`, group 'ROTA') with `{oldBrokerId, oldBrokerName, newBrokerId, newBrokerName, update:true}` runs `Order.updateMany({userId: oldUser._id}, {$set:{userId: newUser._id, broker: newBroker.name, brokeruserId: newBroker.userId}})` plus equivalent rewrites of Sip, UserPendingAction, PlacedOrders and both User docs. NO log line, NO meta stamp, NO actor. An SBI order whose `broker` field disagrees with its placement logs may have been migrated this way.  
  `app/routes/api/IndianEq.js:14-19, app/controllers/api/IndianEq.js:35-51, app/services/api/IndianEq.js:13-124 (Order.updateMany at :65-78)`
- **!** The broker-migration transaction is fire-and-forget: `transactionWrapper(async (session) => {...})` is called WITHOUT await inside a non-awaited block, and the controller immediately responds `createRes(true, null, true)`. A migration can therefore report success and then fail silently inside the transaction with no error surfaced to the operator.  
  `app/services/api/IndianEq.js:52 (`transactionWrapper(` with no await) and app/controllers/api/IndianEq.js:44-46`
- **!** QUIET PATH 3 — `POST /api/leprechaun/marketStatus` (permission `setMarketStatus`, held by the near-default 'Leprechaun_Leprechaun_user' group) does `Config.findOneAndUpdate({key: '<broker>_marketStatus'}, {$set:{value: status}}, {strict:false})` and publishes Redis `API:REDIS_EVENTS` → `{eventName:'updateLeprechaunAMOFlags', leprechaun:<broker>}`. This controls isMarketOpen / isAmoOpen / isCancelOpen for that broker. No actor persisted; the only human trace is Mattermost channel `market-status`.  
  `app/routes/api/leprechaun.js:29-33, app/controllers/api/leprechaun.js:140-181, app/services/helper/shared.helper.js:37-59, app/services/mattermost/index.js:8-20`
- QUIET PATH 4 — `POST /api/broker/autoSipStatus` (permission `setAutoSipStatus`) does `Config.findOneAndUpdate({key:'<broker>_dr_isPrimary'}, {$set:{'value.autosipServer': status}})` and publishes Redis `SCPI:REDIS_EVENTS` → `{eventName:'updateKotakAutosipPrimary', broker}`. Note the event name is hardcoded 'updateKotakAutosipPrimary' regardless of which broker is passed. Mattermost channel is `autosip-status` but the mattermost `message()` switch has NO case for 'autosip-status', so it sends an EMPTY text — the notification is effectively lost.  
  `app/routes/api/broker.js:12-21, app/controllers/api/broker.js:33-55, app/services/helper/shared.helper.js:106-124, app/services/mattermost/index.js:5-58 (default case returns '' at :55)`
- QUIET PATH 5 — corpActions: `POST/DELETE /api/corpActions/listing[/:id]` and `/amalgamation[/:id]` (single permission `corpActions`) create/hard-delete `UniverseRevision` (type 'delisted') and `CorpActionAdjustment` (type 'relistingAmalgamation') documents. The operator email goes ONLY to Slack (`config.slack.caAlertsHook`), never into the document. Deletes are permitted only when the action date is today or later.  
  `app/routes/api/corpActions.js:8-41, app/controllers/api/corpActions.js:13-18, :106-155, :189-247 (notifySlack at :20-60)`
- The Slack corpAction alert is a block-kit message whose header text is `${emoji} ${actionType} corpAction` (actionType is 'added' or 'deleted'), with context fields `*Environment:* ${environment}` and `*User:* \`${user}\`` (the operator's email) and the raw JSON document in a code block.  
  `app/controllers/api/corpActions.js:20-60`

### read-paths

- `POST /api/support/getErrorOrder` (perm getErrorOrder) reads `Order.findOne({_id: batchId, status:'ERROR'})` directly from Mongo and returns the FULL document with no projection — so `meta.source`, `meta.updates[]`, `meta.twoStep` are all visible in its raw JSON. `POST /api/support/getSstOrder` similarly returns the full SSTOrder from platform-api.  
  `app/controllers/api/support.js:1423-1434, app/services/helper/integrations.helper.js:234-249`
- **!** `GET /api/support/getOrders?iscid=` returns `Order.find({iscid}).sort({date:1})` — the full order timeline for one invested smallcase, straight from Mongo. This is the fastest way to see a whole SBI iscid's batch history including every meta.updates trail.  
  `app/routes/api/support.js:95-100, app/controllers/api/support.js:1385-1400, app/services/helper/integrations.helper.js:190-192`
- **!** `POST /api/support/getOrdersCustom` (perm getOrdersCustom) does NOT read Mongo locally — it POSTs to order-updates `/smallboard/orders`. Its allowed batch filters are exactly: batchId, iscid, name, scid, originalLabel[], status[], buyAmount{value,criteria}, sellAmount{...}, completedDate{...}, source[], dummy, variety — plus orders/unplaced sub-filters on tradingsymbol/transactionType/sid. userId is REQUIRED. There is no way to filter by `meta.source`, and the `source` filter is `Order.source` (PROFESSIONAL/CUSTOM/CREATED), an unrelated field.  
  `app/controllers/api/support.js:88-111, app/schema/api/support.schema.js:12-59, app/integrations/ou/ou.scb.integrations.js:7-14, sc-integrations-order-updates/lib/utils.js:821-881`
- `GET /api/support/getDummyOrders?brokerId&userId&iscid` reads `supportRequests` (NOT orders) and only returns docs from the last 48 hours that are not status REVERSED. It will therefore show nothing for an older manual trade, and nothing at all for trades placed via the new direct flow (which writes no supportRequests doc).  
  `app/controllers/api/support.js:1727-1747, app/services/api/internal.service.js:348-372`

### dead-code

- **!** `integrationsHelper.updateBatchStatus` (direct Mongo: load Order, require status PLACED or PARTIALLYPLACED, set ERROR, `batch.save()`) is exported but has ZERO callers — the live updateBatchStatus goes through OU. Do not reason about the smallboard-side status gate; the effective gate is OU's {PLACED, PARTIALLYPLACED, ACKED}.  
  `app/services/helper/integrations.helper.js:251-267 and :282 (no caller; app/services/api/support.js:37-43 uses OUScbIntegrator instead)`
- **!** `integrationsUtil.fixBatch` — the plain-Order analogue of fixSSTBatch, which also writes `statusMessage = 'Order fixed by support request.'` — is exported but has ZERO callers. The only live producer of that string in smallboard is the SST path.  
  `app/services/util/integrations.util.js:149-212 and :215 (string at :190); no caller anywhere under app/`

### meta-updates-semantics

- **!** The canonical meta.updates strings are produced ONLY by `Order.saveOrder(options, state, cb)` via `recordUpdate`: state 'INITIAL' → `Order saved initially with status ${order.status}`, state 'FINAL' → `Order saved finally with status ${order.status}`, state 'AUTO' → `Auto order saved with status ${order.status}`. `recordUpdate` pushes `{date: new Date(), update: <string>}`. Any plain `doc.save()` adds nothing.  
  `node_modules/@smallcase/sc-babel/models/Order/Order.js:9-19, :22-47 (:44), :49-80 (:76), :82-91 (:88), :93-104`
- **!** `saveOrderTask` forces `order.status = 'ERROR'` whenever `order.errorStatus` is truthy, immediately before saving — which is why a fix must clear errorStatus (fixSSTBatch does: `batch.errorStatus = false`) or the status flips straight back to ERROR.  
  `node_modules/@smallcase/sc-babel/models/Order/util.js:57-67, app/services/helper/platform.helper.js:610-611`

### broker-agnostic

- **!** smallboard-be contains NO SBI-specific logic whatsoever: a case-insensitive grep for `sbi`, `sbimtf`, `sbi_`, `broker === ` or `brokerName === ` across app/, lib/ and config/ returns zero matches (the only 'SBI' occurrences repo-wide are prose comments in the IPOT subscription code). Every order-fix endpoint is broker-agnostic; SBI and SBI-MTF go through the identical code path as kite/motilal/upstox.  
  `grep over /Users/rishidatta/Desktop/integrations/sc-smallboard-be app/ lib/ config/ — only hits are app/controllers/api/ipot.js:167,192, lib/constants.js:87, app/services/helper/ipot-service.helper.js:81`
- `brokerKeyMap` — used by getSmallcases/saveSmallcase/addSmallcase to resolve a Config key — contains ONLY `{axis: 'activationSmallcaseConfig'}`. Calling those endpoints with broker='sbi' resolves to `Config.findOne({key: undefined})` and silently returns nothing rather than erroring.  
  `lib/constants.js:59-61, app/services/helper/shared.helper.js:126-146`

### ipot

- IPOT (subscription debit reconciliation, HDFC + SBI ledger scope) is the ONLY smallboard subsystem with explicit actor propagation: `actorFromReq(req)` builds `{id, name, email}` from req.user and the helper signs it into the outbound JWT payload alongside `source:'sc-smallboard-be'`, which gw-ipot-service decodes into `req.userData` for its own audit log (readable via `GET /api/ipot/config/audit-log`, permission `viewIpotAuditLog`).  
  `app/controllers/api/ipot.js:20-24, app/services/helper/ipot-service.helper.js:5-45 (:16-19, :40), :152-154; route app/routes/api/ipot.js:164-165`
- `POST /api/ipot/reconciliation/fail-orders` forwards `{orderIds, reason, failureType}`. failureType defaults to `IPOT_DEBIT_FAILED` when absent; the only other accepted value is `IPOT_CONSENT_MISMATCH`, and gw-ipot-service coerces SBI/non-HDFC orders to IPOT_DEBIT_FAILED regardless. A failureType not in smallboard's local allow-list is rejected with a 400 here even if downstream would accept it.  
  `app/controllers/api/ipot.js:165-211, lib/constants.js:81-99`

### downstream-hosts

- **!** Prod downstream targets: order-updates ('BB') = `bb.prod.smallcase.com` (BB_SERVICE_HOST, port 80; `config.BB` used for /errors/fix and /orders/dummyOrder) and `https://bb.prod.smallcase.com` (INTEGRATIONS_SERVICE_URL, used with X-DOMAIN-TOKEN for /smallboard/orders). platform-api = `https://api-k8s.prod.smallcase.com` with headers x-client-id / x-client-secret / Bearer. Mongo = smallcase-prod. Mattermost hook = chat.smallcase.com.  
  `deployment/infra/util-sc-smallboard-be-env.yaml:7,16,18-19,26,33; config/index.js:185-188, :208-214, :261-265`

### kafka-events

- Kafka events smallboard itself produces on the order path: `SST_ORDER_finished` (payload `{batch}`, after an SST fix), `BULK_supportRequest` (payload `{bulkId}`, after a bulk dummy-trade upload), and indirectly `ISC_deleted` (payload `{batch:{broker, brokeruserId, userId}}`, emitted by sc-babel's cancelBatch when the invested smallcase is removed).  
  `app/services/helper/platform.helper.js:673-675, app/controllers/api/support.js:1249, node_modules/@smallcase/sc-babel/others/smallcaseOrderFlow.js:171-182; producer wiring at connections/events.js:1-7`

### related-writes

- **!** `POST /api/support/createInvestedSmallcase` and `/createInvestedScFromBatchId` CREATE synthetic holdings. The former builds a dummy `Order` document locally (status 'COMPLETED', `dummy: true`, label 'BUY', variety 'regular', date = tomorrow, `__v: 1`) and `.save()`s it directly to Mongo — bypassing order-updates and leaving no meta.updates. The latter only pushes the investedSmallcase onto the User.  
  `app/controllers/api/support.js:1810-1837 and :1498-1520, app/services/api/support.js:94-159 (save at :158) and :165-215, app/services/util/integrations.util.js:6-41`
- `createInvestedScFromBatchId` refuses unless the source batch is COMPLETED or MARKEDCOMPLETE, throwing CustomError "The batch should be in 'COMPLETED' or 'MARKEDCOMPLETE' status"; both endpoints throw 'User has already invested in this smallcase.' on scid+source collision.  
  `app/services/api/support.js:169-176 and :201-209, :122-129`
- `POST /api/support/invalidIscidFix` (permission `invalidIscidFix`, group 'ROTA') takes `{fixBy: 'iscid'|'userId'}` XOR'd with `{iscid}` / `{userId}` and proxies to platform-api `POST /v1/internal/smallboard/pa-invalidator`. Smallboard records nothing about it beyond REQUEST_LOG.  
  `app/routes/api/support.js:19-24, app/controllers/api/support.js:129-149, app/services/api/support.js:49-51, app/services/helper/platform.helper.js:1479-1486, app/schema/api/support.schema.js:61-67`
- `POST /api/support/endSip` passes `req.user.id` as `internalUserId` to platform-api `/v1/internal/smallboard/user/actions/endSip` — one of very few places an operator id crosses a service boundary on the equity path. Whether platform-api persists it is outside this repo and unverified here.  
  `app/controllers/api/support.js:1778-1792, app/services/helper/platform.helper.js:494-508, lib/constants.js:11`

### failure-modes

- `updateErrorOrder`'s success branch checks `res.data.success` but then returns `res.body` (undefined on an axios response — the field is `res.data`). So a successful fix returns `{success:true, data: undefined}` to the FE, and the log line 'Error order sent to BB successfully' is called with `res.body` = undefined. Absence of a payload in that log line is normal, not an error.  
  `app/services/helper/integrations.helper.js:143-151`
- **!** `updateErrorOrder`'s handler calls `res.json(...)` BEFORE firing the Mattermost notification, and `updateSstOrder` does the same. A Mattermost post can therefore be missing (network failure to chat.smallcase.com) even though the fix succeeded and the operator saw success. Never treat a missing `fix-error-order` message as proof no manual fix happened.  
  `app/controllers/api/support.js:1445-1453 and :998-1006`
- **!** `mmService.sendNotification` silently no-ops when `email` is falsy (`if (!email) return callback()`), and its `.catch(callback)` swallows every Mattermost error into the same callback that logs 'Mattermost notification sent'. So that log line does NOT prove the message was delivered.  
  `app/services/mattermost/index.js:62-98 (:63-65, :95)`
- **!** Every platform-api and order-updates call from smallboard uses a 6-second axios timeout. A slow downstream surfaces to the operator as a 500 'Request to platform service failed' / 'Request to orders filter service failed' even when the downstream write eventually lands — so a smallboard 500 does NOT prove the mutation did not happen.  
  `app/services/helper/platform.helper.js:848-873 (:849, :869), app/integrations/ou/ou.scb.integrations.js:43-66 (:44, :63)`


## Grep targets (53)

Search with `fetch-by-identifier.js --service <svc> --text "<string>"`.

| String | Means | Emitted by | Citation |
|---|---|---|---|
| `DUMMY_ORDER_AUDIT` | A human placed a manual dummy/support trade. The log's `message` object carries brokerId, userId, trades[], batchId, operatorId, operatorName, tradeSource:'manual'. This is the strongest operator-attribution string smallboard emits. | supportController.newSupportRequest — both the CSV branch and the single-form branch _(lvl info)_ | `app/controllers/api/support.js:798-811, :921-932` |
| `REQUEST_LOG` | Every authenticated /api or /mf request. Carries message.user.email, message.url, message.requestId and the FULL request body (batchId/iscid/trades). Combine with `--text` on a batchId to find who called what. | app/server.js logger middleware _(lvl info)_ | `app/server.js:71-97` |
| `RESPONSE_LOG` | Paired with REQUEST_LOG on the same requestId; adds statusCode, responseTime, apiError. A 200 here is the proof the mutation endpoint returned success. | app/server.js logger middleware, res.on('finish') _(lvl info)_ | `app/server.js:99-137` |
| `Sending ERROR order to BB` | A manual /api/support/updateErrorOrder fix is about to POST to order-updates. Log context contains the FULL pre-fix `batch` document and the computed `tradebook`. This is the single best snapshot of what an operator submitted. | integrationsHelper.sendTradebookToBB _(lvl info)_ | `app/services/helper/integrations.helper.js:133` |
| `Error order sent to BB successfully` | order-updates accepted the manual fix (res.data.success truthy). The second argument is `res.body`, which is always undefined — an empty payload here is normal. | integrationsHelper.sendTradebookToBB success branch _(lvl info)_ | `app/services/helper/integrations.helper.js:145` |
| `Request to BB failed` | order-updates responded but without success:true — the manual fix did NOT apply. Also used by deleteDummyOrder's failure path and by approveReverseSupportRequest. | integrationsHelper.sendTradebookToBB error branch; supportService.deleteDummyOrder; approveReverseSupportRequest _(lvl error)_ | `app/services/helper/integrations.helper.js:148-149, app/services/api/support.js:441, app/controllers/api/support.js:2128-2129` |
| `No error order with batchId: ${batchId}` | getErrorOrder/updateErrorOrder found no Order with that _id in status ERROR — either the batchId is wrong or the batch was already fixed/never errored. Returned to the FE as a 500 body. | integrationsHelper.getErrorOrder / updateErrorOrder; and platformHelper.getSstOrder uses the same wording for SST _(lvl error)_ | `app/services/helper/integrations.helper.js:168, :243; app/services/helper/platform.helper.js:564` |
| `Blocked support batch status update during two-step rebalance` | An operator tried POST /api/support/updateBatchStatus on a batch with in-flight meta.twoStep. Context has batchId, iscid, phase, mechanism, retryAt. The operator got a 409 and NOTHING was written. | supportController.updateBatchStatus _(lvl warn)_ | `app/controllers/api/support.js:1681-1690` |
| `Cannot update batch status while two-step rebalance is in progress` | The 409 error string returned to the operator for the same event as above. | supportController.updateBatchStatus response body _(lvl n/a (HTTP 409 body, also visible in RESPONSE_LOG))_ | `app/controllers/api/support.js:1696-1698` |
| `Received request from smallboard to update batch fields -> ` | THE quiet-path marker. order-updates received smallboard's PATCH /smallboard/orders. Context carries batchId, iscid, queryParams and headers. This is the only trace of a forced status→ERROR that leaves nothing in the Order document. | order-updates ordersController.updateOrderFields, type API_REQUEST _(lvl info)_ | `sc-integrations-order-updates/ou-server/controller.js:834-844` |
| `Request to update the batch fileds successful` | The quiet force-update landed (note the 'fileds' typo — grep it verbatim). Context includes recordsModifiedCount; 0 means the batch was not in PLACED/PARTIALLYPLACED/ACKED and nothing changed. | order-updates ordersController.updateOrderFields success branch _(lvl info)_ | `sc-integrations-order-updates/ou-server/controller.js:857-866` |
| `updated batches: ${totalUpdates}` | Service-level count from the quiet update; it is the SUM of SSTOrder.modifiedCount and Order.modifiedCount, so a value of 1 does not tell you which collection was hit. | order-updates ordersService.updateOrderFields _(lvl info)_ | `sc-integrations-order-updates/services/orders.js:2200` |
| `Received request from smallboard for orders list =>` | An operator ran the smallboard order search (POST /api/support/getOrdersCustom). Read-only — useful for proving someone was LOOKING at a batch before it changed. | order-updates ordersController.applyFilter, type API_REQUEST _(lvl info)_ | `sc-integrations-order-updates/ou-server/controller.js:922-925` |
| `Received custom filtered orders list request from smallboard:` | Same read as above, one layer down, with the parsed `filters` object. | order-updates ordersService.getOrdersFilterApply _(lvl info)_ | `sc-integrations-order-updates/services/orders.js:2223` |
| `Delete Batch Request receivied` | An Order document is about to be PERMANENTLY deleted (note the 'receivied' typo). Reached from smallboard's reverse-dummy-order and approveReverseSupportRequest flows. Context is {batchId}. | order-updates ordersService.deleteBatch _(lvl info)_ | `sc-integrations-order-updates/services/orders.js:1946` |
| `Deleted Batch` | The Order document is now GONE from the orders collection. Context is {batchId, broker, deletedCount}. If you cannot find a batch in Mongo, grep this first. | order-updates ordersService.deleteBatch _(lvl info)_ | `sc-integrations-order-updates/services/orders.js:1955` |
| `deleteBatch: Batch does exist` | Misleading text — it actually means the batch did NOT exist, so nothing was deleted. Context {batchId}. | order-updates ordersService.deleteBatch _(lvl warn)_ | `sc-integrations-order-updates/services/orders.js:1949` |
| `Not a dummy order` | A reverse/delete attempt was refused because the target Order does not have dummy:true. HTTP 403. | order-updates ordersController.deleteDummyOrder _(lvl n/a (HTTP 403 body))_ | `sc-integrations-order-updates/ou-server/controller.js:585-589` |
| `SST_ORDER_finished event produced` | A manual SST fix completed and the Kafka event went out. Always immediately follows the platform-api /reconcile POST. | platformHelper.updateSstOrder _(lvl info)_ | `app/services/helper/platform.helper.js:674` |
| `Batch saved` | Manual SST fix committed. Bare string with no context — pair it with the neighbouring 'Applying order to user: ' line and the REQUEST_LOG for the batchId. | platformHelper.updateSstOrder _(lvl info)_ | `app/services/helper/platform.helper.js:676` |
| `Applying order to user: ` | Followed by the JSON.stringify of the SST diff object the operator's fix produced (orders[], unplaced[], buyAmount, sellAmount, filled, status). The best record of exactly what an SST fix changed. | platformHelper.updateSstOrder _(lvl info)_ | `app/services/helper/platform.helper.js:677` |
| `Order fixed by support request.` | Written into SSTOrder leg `statusMessage` by a manual smallboard SST fix — on both filled legs and the legs it could not fill. NOT emitted on the plain-Order path (the code that would do that, integrations.util.js fixBatch, has no callers). | platformHelper.fixSSTBatch — appears in the DOCUMENT, not the log stream _(lvl n/a (document field))_ | `app/services/helper/platform.helper.js:633, :638` |
| `Order saved initially with status ${order.status}` | Normally the first meta.updates entry of a brand-new order. BUT smallboard's fixSSTBatch appends this exact string client-side on every manual SST fix — a duplicate or late-dated occurrence in SSTOrder.meta.updates is a human SST fix. | sc-babel Order/SSTOrder saveInitialOrder → recordUpdate; ALSO app/services/helper/platform.helper.js:653 _(lvl n/a (meta.updates entry))_ | `node_modules/@smallcase/sc-babel/models/Order/Order.js:44 and app/services/helper/platform.helper.js:650-657` |
| `Order saved finally with status ${order.status}` | meta.updates entry written by Order.saveOrder(...,'FINAL'). State-derived only — identical for a manual fix routed through order-updates and an automated recon fix. Do NOT use for provenance. | sc-babel saveFinalOrder → recordUpdate _(lvl n/a (meta.updates entry))_ | `node_modules/@smallcase/sc-babel/models/Order/Order.js:76` |
| `Auto order saved with status ${order.status}` | meta.updates entry from Order.saveOrder(...,'AUTO') — the third and rarest state string. | sc-babel saveAutoOrder → recordUpdate _(lvl n/a (meta.updates entry))_ | `node_modules/@smallcase/sc-babel/models/Order/Order.js:88` |
| `[${environment.toUpperCase()}] Error batch (${data.batchId}) updated by @${username}` | Mattermost channel `fix-error-order`. Emitted for BOTH updateErrorOrder and updateSstOrder. environment is config.DGN = 'production'. username is the Mattermost handle resolved from req.user.email. Search MM, not S3, for this. | mmService.message case 'fix-error-order', changeToError falsy _(lvl n/a (Mattermost post))_ | `app/services/mattermost/index.js:34-42` |
| `[${environment.toUpperCase()}] Batch (${data.batchId}) status changed to ERROR by @${username}` | Mattermost channel `fix-error-order`. The ONLY human-readable trace that someone forced a batch to ERROR via updateBatchStatus (the document itself records nothing). | mmService.message case 'fix-error-order', changeToError true _(lvl n/a (Mattermost post))_ | `app/services/mattermost/index.js:35-38` |
| `#### Market Status Changed for ${data.broker.toUpperCase()} ${environment.toUpperCase()}` | Mattermost channel `market-status`. Someone changed a broker's isMarketOpen / isAmoOpen / isCancelOpen — check this before blaming SBI for an order window failure. Body table shows the three flags and '@${username}'. | mmService.message case 'market-status' _(lvl n/a (Mattermost post))_ | `app/services/mattermost/index.js:8-20` |
| `Mattermost notification sent` | Fired as the sendNotification callback — but that callback is BOTH the .then and the .catch, so this line appears even when the Mattermost post failed. Do not treat it as delivery proof. | supportController.updateErrorOrder / updateSstOrder / updateBatchStatus _(lvl info)_ | `app/controllers/api/support.js:1004, :1451, :1714; app/services/mattermost/index.js:95` |
| `User level support request log` | A bulk dummy-trade upload started. Context carries the ENTIRE request body (every row) plus the full req.user object (id, email, name, permissionsGroupsList). | supportController.newBulkSupportRequest _(lvl info)_ | `app/controllers/api/support.js:1133-1138` |
| `User level support request output` | A bulk dummy-trade upload was REJECTED on validation. Context has the per-row errors array and req.user. Nothing was written. | supportController.newBulkSupportRequest _(lvl info)_ | `app/controllers/api/support.js:1238-1243` |
| `Partial dummy-order placement: some batches placed before failure` | A CSV support upload placed set 1 and then failed on set 2. Context `{placedBatchIds, iscid, userId}` — these batches are ORPHANS that nobody reversed. | supportController.newSupportRequest CSV branch catch _(lvl error)_ | `app/controllers/api/support.js:835-838` |
| `placeDummyOrder returned no batchId` | platform-api accepted the dummy-order POST but returned no batchId — the manual trade did not land. Context is the raw `result`. | supportController.newSupportRequest (both branches) _(lvl error)_ | `app/controllers/api/support.js:794, :917` |
| `SCID/ISCID locked for user` | A cancelBatch (or other support action) was refused because Redis key API:SCL:<userId>:<scid\|iscid\|did> was held. Context {userId, lockKey, value}. Operator saw 'Scid or iscid locked for placing orders'. | supportController.scidLockCheck _(lvl error)_ | `app/controllers/api/support.js:1109-1115` |
| `Scid or iscid locked for placing orders` | The 400 body for the lock refusal above — visible in RESPONSE_LOG. | supportController.scidLockCheck response _(lvl n/a (HTTP 400 body))_ | `app/controllers/api/support.js:1116-1118` |
| `API SCL lock deleted.` | A support flow cleared the Redis SCID lock `API:SCL:<userId>:<scid\|iscid>` after applying orders to the user. | integrationsHelper.cleanRedisLocks (console.log, not jsonLogger) _(lvl stdout)_ | `app/services/helper/integrations.helper.js:17-30 (:26)` |
| `Logging Dummy Order before processing it` | Inside approveReverseSupportRequest, just before the reversal branches. type DEBUG_LOG; the full dummyOrder document is stringified into message.extra.dummyOrder — a pre-deletion snapshot of an Order that is about to be destroyed. | supportController.approveReverseSupportRequest _(lvl info)_ | `app/controllers/api/support.js:2053-2063` |
| `Shares count is becomming -ve while applying orders, please mark it to ROTA` | A reversal was aborted mid-way (note the 'becomming' typo). The User snapshot rollback had ALREADY been saved before this check ran, so the user doc may be inconsistent. | supportController.approveReverseSupportRequest _(lvl n/a (HTTP 400 body + written into reverseSupportRequests.errorMessage))_ | `app/controllers/api/support.js:2150-2157` |
| `Need to do it manually as corpActions are present` | A trades-type reversal was refused because corp actions exist on the affected sids since the support-request date. | supportController.approveReverseSupportRequest _(lvl n/a (HTTP 400 body))_ | `app/controllers/api/support.js:2084-2093` |
| `Request is rollbacked, but you need to apply corp actions and post orders` | An exit-type reversal DID roll back the user document but stopped short; errorMessage `${corpActionsCount} corp actions are present` is written to the reverse request. Half-applied state. | supportController.approveReverseSupportRequest _(lvl n/a (HTTP 400 body))_ | `app/controllers/api/support.js:2037-2051` |
| `The batch should be in 'COMPLETED' or 'MARKEDCOMPLETE' status` | createInvestedScFromBatchId refused because the source batch is in some other status. | supportService.createInvestedScFromBatchId (CustomError) _(lvl n/a (HTTP 400 body))_ | `app/services/api/support.js:173-175` |
| `User has already invested in this smallcase.` | createInvestedSmallcase / createInvestedScFromBatchId refused on scid+source (or iscid) collision. | supportService (CustomError) _(lvl n/a (HTTP 400 body))_ | `app/services/api/support.js:127, :207` |
| `The batch is ineligible for reconciliation` | platform-api refused an SST fetch or SST write because the SSTOrder is not in PLACED / PARTIALLYPLACED / ERROR. | sc-platform-api smallboardService.getSSTOrder / updateSSTOrder _(lvl n/a (error message))_ | `sc-platform-api/app/services/smallboard.service.js:1494-1496, :1526-1528` |
| `AUTO_RECON_CORP_ACTION` | platform-api log `type` for the human auto-recon approval flow. Subtypes: KAFKA_PRODUCE_ATTEMPT, KAFKA_PRODUCE_SUCCESS, BULK_KAFKA_PRODUCE_ATTEMPT, BULK_KAFKA_PRODUCE_SUCCESS, BULK_KAFKA_PRODUCE_FAILED, BULK_KAFKA_PRODUCE_SUMMARY. message carries approvalId, broker, sid. | sc-platform-api brokerAutoReconService.approveEntry / bulkApproveBySid _(lvl info (error for BULK_KAFKA_PRODUCE_FAILED))_ | `sc-platform-api/app/services/brokerAutoRecon/brokerAutoRecon.service.js:66-76, :141-191` |
| `AUTO_RECON_CORP_ACTION_APPROVED` | The Kafka event name produced when a human approves an auto-recon shortfall entry (payload {approvalId, broker}). Consumed downstream to actually place the SBI-MTF recon dummy order. | sc-platform-api brokerAutoReconService _(lvl n/a (Kafka topic))_ | `sc-platform-api/app/services/brokerAutoRecon/brokerAutoRecon.service.js:14, :71, :152` |
| `Cannot approve entry with status: ${approval.status}` | A human clicked approve on an auto-recon entry that was no longer PENDING_APPROVAL (already approved/rejected/executed). Error code RECON_003. | sc-platform-api brokerAutoReconService.approveEntry / rejectEntry _(lvl n/a (ValidationError))_ | `sc-platform-api/app/services/brokerAutoRecon/brokerAutoRecon.service.js:53-57, :88-92` |
| `AUTO_POSITIONS_RECON` | Default `dummySource` for recon-placed dummy orders from the auto-recon flow ('AUTO_POSITIONS_RECON_OHLC' is the pending-approval document default). An Order carrying this dummySource was NOT placed by a person typing trades, even though a person approved it. | sc-platform-api brokerAutoReconService.placeReconDummyOrders / BrokerAutoReconPendingApproval schema default _(lvl n/a (document field))_ | `sc-platform-api/app/services/brokerAutoRecon/brokerAutoRecon.service.js:290, sc-platform-api/node_modules/@smallcase/sc-platform-babel/models/Broker/BrokerAutoReconPendingApproval.js:11-14` |
| `csv_upload` | `dummySource` set only by smallboard's CSV support-request branch. An Order with dummySource 'csv_upload' was placed by a human uploading a spreadsheet — correlate with the DUMMY_ORDER_AUDIT line for the operator. | supportController.newSupportRequest CSV branch, placeDummyOrder payload _(lvl n/a (document field))_ | `app/controllers/api/support.js:789` |
| `[Slack] Incoming request to /slack` | Unauthenticated (signature-verified) Slack interaction hit smallboard. Followed by '[Slack] Raw body captured by urlencoded parser' and '[SlackInteraction] Signature verified successfully'. | app/server.js slack mount + slackInteractions _(lvl info)_ | `app/server.js:160-174, app/controllers/slack/slackInteractions.js:56` |
| `[SlackInteraction] Signature verification failed` | Someone POSTed to /slack/interactions without a valid Slack signature. Context has hasRawBody, rawBodyLength, hasTimestamp, hasSignature. 401 returned. | slackInteractions.handleInteraction _(lvl error)_ | `app/controllers/slack/slackInteractions.js:43-53` |
| `Please mail us at tech@smallcase.com. Mistake is on our side!` | smallboard's global express error handler body. If an operator reports seeing this, the real error is in the preceding jsonLogger.error line for that requestId, not in the response. | app/server.js error middleware _(lvl error)_ | `app/server.js:217-223` |
| `User not authenticated/logged out` | JWT verification or permissions lookup failed; both smallboard cookies are cleared. 403. Precedes any REQUEST_LOG (checkUser runs first), so a 403'd call leaves NO REQUEST_LOG. | app/server.js checkUser _(lvl error)_ | `app/server.js:47-61` |
| `User does not have the required permission for the action` | verifyRouteAccess denied the operator. 403. The attempt still produced a REQUEST_LOG with the operator email and body, so denied attempts ARE traceable. | authController.verifyRouteAccess _(lvl error)_ | `app/controllers/auth/index.js:457-471` |


## Corrections (11)

Where the old `SBI_LOG_INVESTIGATION_GUIDE.md`, or an obvious assumption, is provably wrong.


**Claimed:** "If you need to know which person fixed an order (not just 'smallboard did it'), the order document and order-updates' logs cannot tell you — check the fix-error-order Mattermost channel history instead." (guide line 1280) — implying human identity exists ONLY in Mattermost/Slack.

**Actually:** Partly wrong, and the wrong advice at 2am. Persisted, queryable human identity exists in FOUR other places: (1) `supportRequests.openedBy.{name,userId}`, `bulkSupportRequests.openedBy`, `reverseSupportRequests.openedBy` — real Mongo fields, populated from req.user.name/req.user.id; (2) `brokerAutoReconPendingApprovals.actionedBy` / `.pricedBy` — the operator's EMAIL, plus actionedAt/pricedAt, for the auto-recon human-approval path (whose default broker is 'sbimtf'); (3) smallboard's own `DUMMY_ORDER_AUDIT` structured log with operatorId/operatorName/batchId/tradeSource; (4) the universal `REQUEST_LOG`/`RESPONSE_LOG` middleware, which stamps `message.user.email` AND the full request body (batchId included) on EVERY authenticated /api call — i.e. on every single mutating endpoint in the repo, including the 'quiet' ones. Mattermost should be the last resort, not the first.

`node_modules/@smallcase/sc-babel/models/SupportRequestSchema.js:20-23; sc-platform-api/node_modules/@smallcase/sc-platform-babel/models/Broker/BrokerAutoReconPendingApproval.js:34-39 + sc-platform-api/app/services/brokerAutoRecon/brokerAutoRecon.service.js:60-64,:112,:129-136; app/controllers/api/support.js:798-811,:921-932; app/server.js:71-137`


**Claimed:** The guide never resolves what `POST /updateBatchStatus` actually writes, and treats the smallboard side as a direct Mongo status flip.

**Actually:** smallboard writes NOTHING to Mongo on this path. It calls order-updates `PATCH /smallboard/orders?batchId=<id>` with `{status:'ERROR'}` and `X-DOMAIN-TOKEN`. Downstream a Joi allowlist strips everything except `status`, and only the literal value `ERROR` is accepted when addressed by batchId (by iscid, only `name` is writable). The Mongo filter requires current status ∈ {PLACED, PARTIALLYPLACED, ACKED} — note ACKED, which the smallboard-side dead code does NOT allow — and the same updateMany is fired at BOTH the `Order` and `SSTOrder` collections. The smallboard function that does the direct Mongo flip, `integrationsHelper.updateBatchStatus`, is DEAD CODE with zero callers.

`app/integrations/ou/ou.scb.integrations.js:17-24; sc-integrations-order-updates/lib/utils.js:887-926; sc-integrations-order-updates/services/orders.js:2174-2202; dead code at app/services/helper/integrations.helper.js:251-267 vs live path app/services/api/support.js:37-43`


**Claimed:** "`statusMessage === 'Order fixed by support request.'` → SSTOrder leg only, manual smallboard fix, SST path only, not the plain-Order path SBI normally uses." (guide line 1294) — stated as an observation without proof.

**Actually:** Correct, and now provable. The plain-Order analogue `integrationsUtil.fixBatch()` sets the identical string at app/services/util/integrations.util.js:190, but it is exported and NEVER CALLED anywhere in the repo. The only reachable producer is `fixSSTBatch` (platform.helper.js:633,638). Corollary the guide misses: fixSSTBatch sets this string on BOTH the legs it fills and the legs it cannot fill (which it pushes to `unplaced` with status ERROR) — so seeing it on an unfilled leg is still a manual fix, not a failed one.

`app/services/util/integrations.util.js:149-212 (:190) with no callers; app/services/helper/platform.helper.js:612-643 (:633, :638)`


**Claimed:** "meta.updates[] CANNOT tell you [provenance]. Its text depends only on which save state was written... Do not use §1's meta.updates[] text to answer a provenance question." (guide line 1187)

**Actually:** True for the plain-Order path, but FALSE for SSTOrder. smallboard's `fixSSTBatch` appends a meta.updates entry CLIENT-SIDE before the POST: `{update: 'Order saved initially with status ' + status, date: <now>}`. Since sc-babel only ever emits 'saved initially' when constructing a brand-new order, a SECOND or late-dated 'Order saved initially with status X' entry in an SSTOrder — especially one appearing after an 'Order saved finally...' entry — is a positive document-level fingerprint of a manual smallboard SST fix. This is the one case where meta.updates DOES answer 'who'.

`app/services/helper/platform.helper.js:644-658 (:650-657) vs node_modules/@smallcase/sc-babel/models/Order/Order.js:22-47 (:44) and :49-80 (:76)`


**Claimed:** "a smallboard-initiated cancel-to-MARKEDCOMPLETE does get tagged [with meta.source='smallboard'], unlike the quiet updateBatchStatus path." (guide line 1236)

**Actually:** Correct but incomplete in a way that matters. sc-babel's cancelBatch calls RAW `batch.save()` (others/smallcaseOrderFlow.js:169), not `Order.saveOrder()`/`recordUpdate()` — so it appends NOTHING to meta.updates. The full fingerprint is therefore: status === 'MARKEDCOMPLETE' AND meta.source === 'smallboard' AND NO new meta.updates row at that timestamp. It also silently mutates the User document (isc status → 'VALID', matching `actions.fix` entries spliced out, possibly the whole investedSmallcase removed), flips `PlacedOrders[meta.correlationId].status` to 'COMPLETED', and may produce Kafka `ISC_deleted`. And the operator id IS captured as `archivedBy: req.user.id` but is discarded unless the isc was deleted AND had flags.sip (it is only ever passed to endSip).

`node_modules/@smallcase/sc-babel/others/smallcaseOrderFlow.js:145-193 (:169, :172-182, :183-189); app/services/api/support.js:236-261 (:238, :247-253); app/controllers/api/support.js:1873`


**Claimed:** Implicit throughout: that investigating an SBI order in smallboard means finding SBI-specific handling.

**Actually:** There is none. A case-insensitive grep for `sbi`, `sbimtf`, `sbi_`, `broker === ` or `brokerName === ` across app/, lib/ and config/ returns ZERO matches — the only 'SBI' strings in the repo are prose comments in the unrelated IPOT subscription code. Every order-fix endpoint is broker-agnostic. The corollary an investigator needs: you cannot narrow a smallboard log search by broker, because the broker never appears in smallboard's request handling. Narrow by batchId/iscid/userId instead.

`grep over sc-smallboard-be app/ lib/ config/ — only hits app/controllers/api/ipot.js:167,192, lib/constants.js:87, app/services/helper/ipot-service.helper.js:81`


**Claimed:** The guide's provenance table lists only three outcomes (normal ingestion / automated recon / manual fix) and never covers order DELETION.

**Actually:** Two smallboard-reachable endpoints permanently DELETE the Order document: `POST /api/support/order/dummy/reverse` (permission reverseDummyOrder — granted broadly by the 'Support_User Profile_user' group) and `POST /api/support/approveReverseSupportRequest` case 2. Both end in order-updates `Order.deleteOne({_id: batchId})`. So a batchId that returns nothing from Mongo is NOT proof it never existed. Check `placedOrders` for status 'REVERSED' and grep order-updates for 'Delete Batch Request receivied' / 'Deleted Batch'.

`sc-platform-api/app/services/smallboard.service.js:1644-1752 (:1718-1725, :1744-1748); app/controllers/api/support.js:2124-2136; app/services/api/support.js:421-444; sc-integrations-order-updates/services/orders.js:1945-1958`


**Claimed:** "Not fully explored, flagged for follow-up: sc-platform-api has a THIRD recon-adjacent mechanism — brokerAutoReconController ... Not researched in this pass." (guide line 1301)

**Actually:** Now resolved, and it is the guide's biggest miss. The smallboard surface is `/api/autoRecon/*` (permissions autoReconListApprovals / autoReconApprove / autoReconReject / autoReconUpdatePrice / autoReconBulkApprove). It writes the operator's EMAIL into Mongo collection `brokerAutoReconPendingApprovals` as `actionedBy` + `actionedAt` (approve/reject/bulk-approve) or `pricedBy` + `pricedAt` (price override). Approval produces Kafka `AUTO_RECON_CORP_ACTION_APPROVED {approvalId, broker}` which triggers the actual dummy-order placement — placed with `label:'MANAGE'`, SELL-only, `dummy:true`, `isGroupOrder:true`, `dummySource:'AUTO_POSITIONS_RECON'`/'AUTO_POSITIONS_RECON_OHLC', and a broker that DEFAULTS TO 'sbimtf'. This is a genuine human-in-the-loop SBI-MTF order-creation path that the guide's whole provenance model omits.

`app/routes/api/autoRecon.js:7-40; app/controllers/api/autoRecon.js:26-87; sc-platform-api/routes/internal/smallboard.route.js:151-166; sc-platform-api/app/services/brokerAutoRecon/brokerAutoRecon.service.js:46-136, :251-301 (:258); sc-platform-api/node_modules/@smallcase/sc-platform-babel/models/Broker/BrokerAutoReconPendingApproval.js:2-46`


**Claimed:** Implicit assumption that a manual 'trades' support request always leaves a `supportRequests` document with `openedBy` to identify the operator.

**Actually:** No longer true. Both trades branches of `POST /api/support/newRequest` were rewritten (commit 690ae6e1 'depricate support request flow in upload file path...') to call platform-api placeDummyOrder directly and return `{batchId, directFlow: true}` WITHOUT creating any supportRequests document. Only non-'trades' types (exit, exitAll, addStocks, forceArchive, revLedger, aggregateTrades, adjustTopLevelHoldings) still write one. For a modern manual SBI trade the only operator record is the `DUMMY_ORDER_AUDIT` log line. Separately, `DELETE /api/support/request` hard-deletes supportRequests docs (`SupportRequests.remove`) under an ordinary user-level permission, so even for the surviving types the openedBy record is destructible.

`app/controllers/api/support.js:699-848 (:825-827) and :866-943 (:933-936) vs the surviving write at :946-962; app/services/api/internal.service.js:370-394 and :518-520; config/index.js:4123-4131`


**Claimed:** The guide names one 'quiet path' (updateBatchStatus / PATCH /smallboard/orders).

**Actually:** There are five distinct quiet paths reachable from smallboard, four of which the guide does not mention and three of which write Mongo DIRECTLY from smallboard's own process with no log line at all: (1) updateBatchStatus (the one the guide has); (2) `POST /api/support/updateSmallcaseName` → `Order.updateMany({iscid},{$set:{name}})` plus 5 more direct writes across User/Sip/UserLedger; (3) `POST /api/IndianEq/broker/migration` → `Order.updateMany({userId: old},{$set:{userId, broker, brokeruserId}})` — it REWRITES THE BROKER FIELD on every order of a user, and its transaction is fire-and-forget (called without await) so it can report success and fail silently; (4) `POST /api/leprechaun/marketStatus` → Config `<broker>_marketStatus` (controls isMarketOpen/isAmoOpen/isCancelOpen for SBI) with Redis publish to `API:REDIS_EVENTS`; (5) `POST /api/broker/autoSipStatus` → Config `<broker>_dr_isPrimary`, whose Mattermost notification renders as EMPTY TEXT because the message() switch has no 'autosip-status' case.

`(2) app/services/helper/platform.helper.js:876-956 + app/services/helper/integrations.helper.js:180-188; (3) app/services/api/IndianEq.js:52,:65-78 + app/controllers/api/IndianEq.js:35-51; (4) app/services/helper/shared.helper.js:37-59; (5) app/services/helper/shared.helper.js:106-124 + app/services/mattermost/index.js:5-58`


**Claimed:** Obvious-but-wrong assumption: the fetch-s3-logs toolkit can pull smallboard logs the same way it pulls order-updates/broker-api/platform-api.

**Actually:** It cannot. `smallboard` is not a key in the toolkit's `APP_SERVICES` registry (only order-updates, broker-api, platform-api, jobs, jobs-recon), and `--service` is required. Since REQUEST_LOG/RESPONSE_LOG are the primary operator-attribution trail, this is a real capability gap the skill must either close (add a smallboard entry) or flag. smallboard's own logger name is `sc.service.smallboard`; its prod k8s env is 'util' and team/namespace 'platform', so the likely prefix is `s3://sc-eks-pod-logs/util/<date>/platform/sc-smallboard-be-pod/` — UNVERIFIED.

`/Users/rishidatta/Desktop/integrations/fetch-s3-logs/search-s3-logs.js:49-66 and :78-79; config/config.js:8-9; deployment/infra/util-sc-smallboard-be-onboard.yaml:5-6`


## Open questions (8)

Genuinely unresolved. Report these as unknown rather than guessing.

- What is the ACTUAL S3 bucket/prefix for sc-smallboard-be pod logs? The repo proves env='util', team='platform', app='sc-smallboard-be', logger name 'sc.service.smallboard', but the bucket partition for the util cluster is not derivable from source. Someone must list s3://sc-eks-pod-logs/ to confirm whether 'util' is a top-level partition alongside 'production'/'staging'. Until confirmed, smallboard's REQUEST_LOG/DUMMY_ORDER_AUDIT trail is theoretically available but practically unreachable by the toolkit.
- Does platform-api persist the `internalUserId` that smallboard sends on `POST /v1/internal/smallboard/user/actions/endSip` (from cancelBatch's archivedBy and from POST /api/support/endSip)? If it lands in a Sip/ArchivedSip document, that is a second persisted operator id on the equity path. Not checked — outside this domain.
- Does platform-api's `POST /v1/internal/smallboard/placeOrders/dummy` record `dummySource`, `clientType:'web'` or any caller identity on the resulting Order document? That determines whether a manual smallboard-placed dummy order is distinguishable from an auto-recon dummy order by document inspection alone. `duplicateDummyOrderCheck` middleware also gates it — its dedupe window/criteria were not read.
- Does platform-api's `POST /v1/internal/smallboard/pa-invalidator` (invalidIscidFix) touch Order documents, or only the User's investedSmallcases status? The smallboard side passes only {fixBy, iscid|userId} and logs nothing.
- sc-smallboard-be is on branch `production` (verified) and so are sc-platform-api and sc-integrations-order-updates — but the task brief notes broker-lib, broker-api and leprechaun are on `rebalance-in-amo`. None of the facts above were sourced from those three repos, so no branch caveat applies to this domain's findings. Worth re-checking if a future pass pulls broker-side behaviour into the smallboard provenance story.
- Is there any Mattermost/Slack export or search API available to the skill? Several human-attribution traces (channels `fix-error-order`, `market-status`, the corpActions Slack hook) exist ONLY there, and the exact message templates are now documented — but the skill has no tool to query them.
- gw-ipot-service's audit log (reachable at GET /api/ipot/config/audit-log) is the only purpose-built audit store smallboard talks to. Does it cover anything beyond IPOT subscription debits? If it were extended to equity order fixes it would close the whole attribution gap.
- Nothing in this repo writes an `Order.meta.source` value other than 'smallboard' (cancelBatch). The guide asserts 'sc-integrations-jobs' as the automated-recon value; that assertion was not re-verified here and lives outside this domain.
