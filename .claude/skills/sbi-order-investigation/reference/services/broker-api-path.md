# broker-api-path

sc-integrations-broker-api — NOT on the SBI order path. Read this to know when it is worth searching at all.

**branch when read:** production (commit f2d0ae9, 2026-09-17) — NOTE: the task brief claimed this repo is on 'rebalance-in-amo'; it is NOT. Verified via git rev-parse --abbrev-ref HEAD. The repos actually off production in this workspace are sc-integrations-leprechaun (rebalance-in-amo) and sc-integrations-broker-lib (development). However, broker-api's locally installed node_modules copy of broker-lib is 16.11.13-rebalance-in-amo.2 while package.json pins ^16.11.14 — so broker-lib behaviour read from this checkout's node_modules is a pre-release, not prod.

sc-integrations-broker-api ("SCB", deployed at https://scb.prod.smallcase.com) is a stateless TypeScript/Express HTTP facade over the broker-lib npm package. For SBI and SBI-MTF it is DEFINITIVELY NOT on the order place / order status / cancel path: its broker-lib wrapper binds no Orders.* function whatsoever, and the repo contains zero order-tag, orderId or batchId handling outside one SBI funds helper. Order placement and status run in-process inside sc-integrations-order-updates, which requires broker-lib directly. What broker-api DOES serve for SBI is a short, enumerable list: brokerage computation (POST /api/v1/misc/getBrokerage and /api/v1/funds/checkFundsWithBrokerage, the only place broker-api calls SBI directly, at https://fhapi.sbisecurities.in/sp-updation-service/brokerage-details), funds checks with the SBI-specific buffer-amount rule, dealer-terminal authentication (POST /api/v1/user/authenticateDealer — which writes the Redis dealer token that order placement later reads, the one real coupling to the order path), rebalance-SIP CRUD, portfolio holdings, and generic login/session. The rule for an investigator: if the question involves an order tag, order id or batch id, broker-api logs are guaranteed empty — go to order-updates. If the question is "why was brokerage/funds/margin wrong", "why did the dealer login fail", or "why did the rebalance SIP not get created", broker-api logs are the right place. Its bunyan name field is "sc.service.sc-integrations-brokers-api" — brokerS, plural, unlike the repo and S3 path.

Confidence markers are the researcher's own: unmarked = confirmed from source, `[INFERRED]` = deduced but unproven, `[UNCONFIRMED]` = a lead, not a fact. `!` marks facts flagged critical. Re-verify line numbers against the checked-out SHA.


## Facts (57)


### routing-decision

- **!** DEFINITIVE: broker-api is NOT on the SBI/SBI-MTF order place, order status, order cancel or order book path. Its broker-lib wrapper object `brokerApi` binds exactly 30 functions and none of them is an Orders.* call. Full list: User.accessToken, User.checkSession, User.refreshSession, User.logout, User.getLoginUrl, User.authenticateDealer, Portfolio.fetchMarginReceivable, Portfolio.holdings, Portfolio.positions, Portfolio.liveHoldings, Sip.delete, Sip.create, Sip.modify, Instruments.quote, Funds.check, Funds.get, Funds.getAddFundsUrl, Lead.search, Lead.create, Communication.triggerMail, Communication.triggerSms, Communication.triggerPush, Security.hold, Security.authorizeSell, Security.getAuthForSell, Security.getAuthStatus, Misc.getInternalUserAccessToken, Misc.generateTotp, Misc.amoActiveHours, Misc.getCheckSum.  
  `sc-integrations-broker-api/src/services/brokerLib.ts:120-151`
- **!** Complete route inventory of broker-api. Root: GET / and GET /health (both plain 200). Everything else is under /api/v1 behind a domain-token gate. /api/v1/config/brokerConfigs (GET); /api/v1/kite (EMPTY router, no routes); /api/v1/user/{accessToken, checkSession, refreshSession, logout, authenticateDealer, loginUrl} (POST) and /api/v1/user/cachedAccessTokenResponse (GET); /api/v1/funds/{checkFunds, checkFundsWithBrokerage, getFunds, getAddFundsUrl, getAddFundsUrlV2} (POST); /api/v1/securities/{hold, authorizeSell, getAuthStatus} (POST); /api/v1/portfolio/{getHoldings, getPositions, getLiveHoldings, getLiveHoldingsWithSid} (POST); /api/v1/instruments/quote (POST); /api/v1/lead/{search, create} (POST); /api/v1/communications/{triggerMail, triggerSms, triggerPush} (POST); /api/v1/misc/{getInternalUserAccessToken, generateTotp, internalToken, getBrokerage, amoActiveHours, checkSum, setBrokerKeysInRedis} (POST); /api/v1/sip/... (see separate fact); /api/v1/tradebook/submit (POST). There is NO /orders route of any kind.  
  `sc-integrations-broker-api/src/routes/index.ts:6-9; src/routes/api/v1/index.ts:26-68; src/routes/api/v1/user.ts:21-53; src/routes/api/v1/funds.ts:13-17; src/routes/api/v1/securities.ts:7-15; src/routes/api/v1/portfolio.ts:7-10; src/routes/api/v1/instruments.ts:9; src/routes/api/v1/lead.ts:10-11; src/routes/api/v1/communications.ts:11-24; src/routes/api/v1/misc.ts:13-36; src/routes/api/v1/config.ts:7`
- **!** broker-api handles no order identifiers at all. Grepping the whole src tree for 'tag' yields ONLY AES-GCM auth-tag handling in encryption.ts. Grepping for orderId/batchId/correlationId outside SIP/AutoSIP/transaction code yields ONLY batchId/originalBatchId inside the SBI funds-buffer helper. Consequence: `fetch-by-identifier.js --service broker-api --tag <sc_xxx>` and `--order-id` and `--batch-id` will ALWAYS return zero rows. The skill must never route a tag/order-id query to broker-api.  
  `sc-integrations-broker-api/src/services/encryption.ts:14,17,28,32; sc-integrations-broker-api/src/services/brokerUtils/sbi.ts:10,23,34,38`
- **!** The three things worth pulling broker-api logs for on an SBI investigation: (1) brokerage/charges disputes — it is the ONLY service that calls SBI's brokerage-details endpoint; (2) funds-check outcomes including the SBI buffer-amount decision; (3) dealer-terminal authentication failures. Also rebalance-SIP create/delete/getAll, portfolio holdings, and generic login/session. Everything order-shaped belongs to order-updates.  
  `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1643-1735; src/controllers/broker/funds.ts:26-65; src/controllers/broker/user.ts:105-124`

### log-identity

- **!** Every broker-api log line carries "name":"sc.service.sc-integrations-brokers-api" — note BROKERS, plural — because config.serviceName is the string 'sc-integrations-brokers-api' while the repo, ECR image, pm2 process and S3 prefix all use the singular 'sc-integrations-broker-api'. Filtering logs on the singular name field silently returns nothing.  
  `sc-integrations-broker-api/src/config.ts:7; sc-integrations-broker-api/src/services/logger.ts:11-15`
- Log lines also carry a top-level `version` field equal to package.json version (currently 3.11.8), plus `type` (the logger type), `reqId` (uuid v1 per request, or the literal 'NA' if express-http-context lookup throws), and elastic-apm trace ids spread in via apm.currentTraceIds (trace.id / transaction.id / span.id).  
  `sc-integrations-broker-api/src/services/logger.ts:9,13,30-38,80-88,106-118; sc-integrations-broker-api/package.json:3`
- **!** Logger `type` values emitted by broker-api: REQUEST_LOG, RESPONSE_LOG, SERVER_LOG, BROKER_LOG, SC_BROKER (note LOGGER_TYPE.BROKER_LIB_LOG maps to the string 'SC_BROKER', not 'BROKER_LIB_LOG'), and POLLING_LIB. 'SERVICE_LOG' is used for the startup line only.  
  `sc-integrations-broker-api/src/services/constants.ts:5-11; sc-integrations-broker-api/src/services/logger.ts:165-169`

### log-shape

- **!** Log context is DOUBLE-NESTED when stringify=true. wrapLogger emits `context: { ...getContext(obj, stringify), ...overrides }`, and getContext(obj,true) returns `{ context: JSON.stringify(obj) }`. So a REQUEST_LOG line reads context.context = the stringified {req:{body,headers,query}}, while context.url / context.userId / context.brokerFunctionLogId sit alongside it as plain fields. Grep tools must not assume a flat context object.  
  `sc-integrations-broker-api/src/services/logger.ts:58-68,70-118; sc-integrations-broker-api/src/server.ts:54,64-73`

### cross-service-join

- **!** brokerFunctionLogId is the join key between sc-platform-api and broker-api. platform-babel generates a uuidv4 per broker call and puts it in the request body's `context`; broker-api's loggerMiddleware spreads req.body.context into the REQUEST_LOG and RESPONSE_LOG overrides, so it appears as context.brokerFunctionLogId on both sides. To correlate a platform-api broker call with the broker-api log line that served it, grep both services for the same brokerFunctionLogId.  
  `sc-platform-babel/services/brokerAsService.js:349-352,367-371; sc-integrations-broker-api/src/server.ts:54,101-102`

### request-response-logging

- **!** Every non-/health request logs 'request received' (type REQUEST_LOG) with the FULL request body, ALL headers and query, and every response logs 'response sent' (type RESPONSE_LOG) with res.code, the parsed body, response headers, and responseTime in SECONDS (not ms). /health is explicitly skipped. This makes broker-api logs unusually complete — if a request reached it, the full payload is there.  
  `sc-integrations-broker-api/src/server.ts:45-50,64-73,92,104-114`

### log-redaction

- **!** These keys are REDACTED to the literal string 'REDACTED' before logging: apiKey, apiSecret, userName, accessToken, redis, requestToken, brokerParams (exact-match regexes). broker-lib additionally contributes its own per-broker keyBlacklist regexes at startup via addBrokerBlackListedKeys. So an investigator will never see the SBI accessToken in a broker-api log line — do not waste time looking. Note the value-level redaction branch at logger.ts:49-54 computes redactedValue but never returns it, so only KEY-based redaction actually works.  
  `sc-integrations-broker-api/src/services/logger.ts:40-56,159-163; sc-integrations-broker-api/src/services/brokerLib.ts:166-179`

### s3-log-location

- **!** broker-api logs live at s3://sc-eks-pod-logs/production/{YYYY-MM-DD}/integrations/sc-integrations-broker-api-pod/ (EKS) and s3://sc-pm2logs-new/PROD/{YYYY-MM-DD}/sc-integrations-broker-api/{Out-logs,Error-logs}/ (older EC2/PM2). The CLI's --service key is 'broker-api'. The repo still ships PM2 deploy scripts that name the process 'sc-integrations-broker-api' alongside an EKS ingress manifest for scb.prod.smallcase.com.  
  `fetch-s3-logs/search-s3-logs.js:55-59,274-290; sc-integrations-broker-api/deployment/setup_ssh_prod.sh:134,143; sc-integrations-broker-api/deployment/infra/production-sc-integrations-broker-api.yaml:83`

### deployment

- Prod host is https://scb.prod.smallcase.com, an INTERNAL ALB (alb.ingress.kubernetes.io/scheme: internal, group prod-integrations-internal), namespace 'integrations', port 8000, health path /health. Staging/dev in-cluster address is http://sc-integrations-broker-api-smallcase-apps.integrations:8000.  
  `sc-integrations-broker-api/deployment/infra/production-sc-integrations-broker-api.yaml:53-83; sc-integrations-broker-api/deployment/infra/production-sc-integrations-broker-api-env.yaml:1-2; sc-integrations-order-updates/deployment/infra/staging-sc-integrations-order-updates-env.yaml:69`

### auth

- **!** EVERY /api/v1 route requires header `x-domain-token` matching one of four env-provided tokens: PLATFORM_DOMAIN_TOKEN ('platform'), GATEWAY_DOMAIN_TOKEN ('gateway'), TEST_DOMAIN_TOKEN ('test'), COMMS_DOMAIN_TOKEN ('comms'). A bad or missing token logs a WARN 'missing or invalid domain token' and returns HTTP 400. If broker-api logs show only that warn line for a caller, the caller's secret is wrong — not a broker problem.  
  `sc-integrations-broker-api/src/services/domainToken/index.ts:7-20; sc-integrations-broker-api/src/services/domainToken/domainTokens.ts:11-14; sc-integrations-broker-api/src/routes/api/v1/index.ts:24`

### sbi-brokerage

- **!** The ONLY direct SBI HTTP call broker-api makes is POST {SBI_API_ENDPOINT}/sp-updation-service/brokerage-details. In production SBI_API_ENDPOINT and SBI_MTF_API_ENDPOINT are BOTH https://fhapi.sbisecurities.in (same host). Request headers are fixed: X-SOURCE-ID:5, X-CHANNEL-ID:1, X-API-VERSION:1.0.0, X-APPLICATON-ID:MSILAPP1 (note the misspelling — APPLICATON, no second I), X-REQ-UID: a fresh uuidv4 per call, X-IP-ADDRESS from options.clientDetails.channelIp with fallback 127.0.0.1.  
  `sc-integrations-broker-api/src/configs/sbi.ts:5,44-54,61-72; sc-integrations-broker-api/deployment/infra/production-sc-integrations-broker-api-env.yaml:94-95`
- **!** The ONLY difference between the sbi and sbi-mtf brokerage request bodies is the `product` field: 'C' (cash) for sbi, 'E' (e-margin) for sbi-mtf. Everything else is identical — buySell B/S, channel 'C', mtfDays '6', nriSettlementType '0', segment 'E', strikePrice '0.00', expiryDate/instrument/optionType empty strings, isin from Redis, qty and price as strings. Both configs read the same SBI_API_ENDPOINT and SBI_PRIVATE_CERT env vars.  
  `sc-integrations-broker-api/src/configs/sbi.ts:24-40; sc-integrations-broker-api/src/configs/sbimtf.ts:6-7,26-43`
- Both SBI brokerage configs build an https.Agent with `rejectUnauthorized: false` and ca = String(process.env.SBI_PRIVATE_CERT). SBI_PRIVATE_CERT does not appear in the production env yaml, so if it is not injected from a secret store the CA is the literal string 'undefined' — and because rejectUnauthorized is false, TLS still succeeds silently. Certificate problems will therefore NOT surface as errors here.  
  `sc-integrations-broker-api/src/configs/sbi.ts:6,56-59; sc-integrations-broker-api/src/configs/sbimtf.ts:7,58-61; sc-integrations-broker-api/deployment/infra/production-sc-integrations-broker-api-env.yaml:94-95 (no SBI_PRIVATE_CERT)`
- **!** The SBI brokerage response fields (all STRINGS, parsed with parseFloat) are: responseCode, brkAmt/brkRate/brkRateType (brokerage), exchTotAmt/exchRate (transaction charge), sebiTotAmt/sebiTotRate, gstAmt/gstRate, sttAmt/sttRate, stampDutyAmt/stampDutyRate. If ANY of brkAmt, sttAmt, exchTotAmt, sebiTotAmt, stampDutyAmt, gstAmt fails isValidNumber, the whole basket throws 'invalid values recieved from sbi' (note misspelling 'recieved'). SBI-MTF reuses calculateSbi verbatim.  
  `sc-integrations-broker-api/src/services/misc/getBrokerage/responses.ts:230-245; sc-integrations-broker-api/src/services/misc/getBrokerage/common.ts:750-783; controllers.ts:1889`
- SBI and SBI-MTF DP charges are both hardcoded to 25 (plus GST), applied per-order by calculateDpChargesForOrders after summing broker-returned charges.  
  `sc-integrations-broker-api/src/configs/sbi.ts:9-11; sc-integrations-broker-api/src/configs/sbimtf.ts:10-13; sc-integrations-broker-api/src/services/misc/getBrokerage/common.ts:778-781`
- **!** Brokerage is computed PER SCRIP in parallel (Promise.all over orders). Each task first does redis.hgetall(`SID:${order.sid}`) and requires BOTH an `isin` field AND a `series` field; if either is missing it throws BadRequest('invalid sid') — a 400 to the caller. Then it splits options.accessToken on '|' and uses element [1] as SBI entityId. A single bad SID fails the entire basket's brokerage call.  
  `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1660-1680 (sbi), 1837-1856 (sbimtf)`
- Exchange is NOT taken from the caller. getBrokerage overwrites order.exchange for every order: 'BSE' if the sid is in the BSE-permitted-stocks list, else 'NSE'. If that list fetch fails the whole call rejects with 'error in getting bse permitted stocks - ${err.message}'.  
  `sc-integrations-broker-api/src/services/misc/getBrokerage/index.ts:47-66`
- **!** Broker-name normalisation for brokerage: 'sbi-mtf'→'sbimtf' and 'sbi-mtf-leprechaun'→'sbimtf' (deliberately routed to the real sbimtf function so margin calculation still runs). Plain 'sbi' is not mapped. Normalisation happens BEFORE the generic leprechaun check, so sbi-mtf-leprechaun does NOT fall through to charges.leprechaun. An unmapped, non-leprechaun broker rejects with NotImplemented('broker not supported') → HTTP 501.  
  `sc-integrations-broker-api/src/services/misc/getBrokerage/index.ts:8-21,33-46,67-72`
- **!** Bypass: if options.accessToken contains the substring 'dummy_token', both sbi() and sbimtf() return generic() estimated charges instead of calling SBI. WARNING — in sbi() this is a bare `resolve(generic(options))` with NO return statement, so execution FALLS THROUGH and the real SBI call is ALSO made; the extra promise settlement is discarded. sbimtf() has the `return` and short-circuits correctly. So a dummy-token SBI cash request still hits fhapi.sbisecurities.in.  
  `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1648-1652 (no return) vs 1743-1745 (has return)`

### sbi-mtf-margin

- **!** SBI-MTF adds a `margin: { marginRequired, brokerage, marginReceivable }` object to the charges response. marginRequired = Σ(qty × price × MTF%) over BUY orders, read from Redis hash `MTF:${sid}` at field `${mtfBrokerName}.${exchange.toLowerCase()}` (e.g. 'sbi-mtf.nse'), DEFAULTING TO '100' when the field is absent. marginReceivable comes from per-order broker-lib Portfolio.fetchMarginReceivable calls. When any BUY exists, margin.brokerage += 118 — a hardcoded smallcase fee + GST.  
  `sc-integrations-broker-api/src/services/misc/getBrokerage/margin.ts:15-41,44-81,84-160; controllers.ts:1893-1927`
- **!** Margin failures are SWALLOWED, not surfaced. fetchRebalanceMarginRequired returns 0 per order on any throw (logging warn 'failed to fetch rebalance margin for order'); getMtfPercentForSid returns null on any throw with a bare catch; and the whole margin block is wrapped in try/catch logging 'failed to fetch margin required'. A user complaining of marginReceivable: 0 will find NO error in the response — only these warn lines in broker-api logs.  
  `sc-integrations-broker-api/src/services/misc/getBrokerage/margin.ts:38-40,132-152; controllers.ts:1928-1930`
- fetchRebalanceMarginRequired picks the broker-lib broker name as: options.brokerName if it contains the substring 'mtf', otherwise the hardcoded default 'sbi-mtf'. So a non-MTF broker reaching this code path would silently be treated as sbi-mtf.  
  `sc-integrations-broker-api/src/services/misc/getBrokerage/margin.ts:115-118`

### sbi-funds-buffer

- **!** SBI buffer-amount rule (broker-api adds `addBufferAmount: true` to the funds-check options). Applies only when brokerName is in the set {'sbi','sbi-mtf','sbi-mtf-leprechaun'} — note plain 'sbi-leprechaun' is NOT in this set. Returns true when: (label BUY or INVESTMORE) AND brokerName === 'sbi'; OR (label BUY or REBALANCE) AND brokerName === 'sbi-mtf'. Note the asymmetry — INVESTMORE only helps sbi, REBALANCE only helps sbi-mtf, and 'sbi-mtf-leprechaun' passes the set guard but then matches NEITHER rule, so it always resolves false.  
  `sc-integrations-broker-api/src/controllers/broker/funds.ts:10,26-39; sc-integrations-broker-api/src/services/brokerUtils/sbi.ts:22-31`
- **!** Third buffer rule (REPAIR): when label === 'REPAIR' and originalBatchId is present, it queries Mongo collection('orders') for {originalLabel: {$in:['BUY','INVESTMORE']}, originalBatchId} projecting {date,status}. Returns false if no docs, false if ANY doc has status 'PARTIALLYFILLED', else true only if the latest doc's date is NOT today (UTC day comparison). The destructure reads `originalBatchId` while the TypeScript interface only declares `batchId` — it compiles solely because of the `[key: string]: unknown` index signature, so a caller sending `batchId` gets silently no buffer.  
  `sc-integrations-broker-api/src/services/brokerUtils/sbi.ts:8-13,15-20,23,34-63`
- **!** Only sc-platform-api populates originalBatchId on the funds-check body (it is an explicit positional arg threaded through checkFunds/checkFundsWithBrokerage into the options object). sc-integrations-jobs' SBI two-step rebalance path builds its own options with label:'REBALANCE' and NO originalBatchId and NO batchId — so the REPAIR branch is unreachable from the jobs path.  
  `sc-platform-api/app/services/userSmallcase/userSmallcase.js:211,238-241,249; sc-integrations-jobs/services/brokerAsService/funds.js:15-39; sc-integrations-jobs/jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js:315-317`
- **!** The buffer decision is ALWAYS logged at info with message 'sbi funds check buffer resolved' and fields {userId, brokerName, addBufferAmount}. This is the single most useful grep for any 'SBI insufficient funds' complaint — it tells you definitively whether the buffer was applied.  
  `sc-integrations-broker-api/src/controllers/broker/funds.ts:34-37`
- **!** checkFundsWithBrokerage is gated to BROKERAGE_INCLUSIVE_BROKERS = {axis, axis-leprechaun, hdfc, hdfc-leprechaun, sbi, sbi-leprechaun}. SBI-MTF is NOT in this set — a checkFundsWithBrokerage call for sbi-mtf returns error 'checkFundsWithBrokerage is not supported for sbi-mtf' with HTTP 200 and error:true in the envelope. It computes brokerage FIRST (failing the whole call on brokerage error, logged as 'brokerage calculation failed'), then adds the summed charges as options.additionalBrokerage before calling Funds.check.  
  `sc-integrations-broker-api/src/controllers/broker/funds.ts:11-18,20-24,67-80,88-102`

### sbi-dealer-auth

- **!** THE ONE REAL COUPLING to the SBI order path. POST /api/v1/user/authenticateDealer → broker-lib User.authenticateDealer WRITES Redis key `sbi:dealer_token:{entityId}:{userId}` (sbi-mtf uses prefix `sbi-mtf:dealer_token`) with TTL 28800s = 8 hours. Later, SBI dealer order placement running in-process inside order-updates READS that exact key; if absent it fails with 'Dealer session not found or expired, please re-authenticate'. So a dealer order failing 8+ hours after login is a broker-api/Redis TTL story, and broker-api logs ARE worth pulling to find the last successful authenticateDealer.  
  `sc-integrations-broker-api/src/controllers/broker/user.ts:105-124; sc-integrations-broker-lib/src/brokers/sbi/services/user.js:6,434-435; sc-integrations-broker-lib/src/brokers/sbi/constants.js:3; sc-integrations-broker-lib/src/brokers/sbi-mtf/constants.js:3; sc-integrations-broker-lib/src/brokers/sbi/services/order.js:152-157`
- **!** authenticateDealer resolves ipAddress as options.ipAddress || x-forwarded-for header || '127.0.0.1'. The broker-lib call sends loginIdType = 1 (password) and, on success, returns ONLY {entityId, userId} as strings — the dealer access token itself never leaves Redis. If the SBI response lacks dealerDetailsResult.entityDetails or .tokenDetails, broker-lib returns error 'Invalid dealer details response'.  
  `sc-integrations-broker-api/src/controllers/broker/user.ts:109-119; sc-integrations-broker-lib/src/brokers/sbi/services/user.js:5,402-443`
- **!** The caller is sc-platform-api's SBI dealer-terminal integration, POSTing to /api/v1/user/authenticateDealer with a 30s timeout and up to 2 retries on 5xx. It maps broker-api HTTP status to its own error codes: 400→SBIDT001 (ValidationError), 401→SBIDT002, 404→SBIDT003, other→SBIDT004, and a 200-with-error:true body→SBIDT005. Those SBIDT* codes are greppable in platform-api logs and pin the failure to a specific status.  
  `sc-platform-api/app/integrations/sbi/sbi.dealerTerminal.integrations.js:26-34,91,115-124,137-157`

### sbi-session

- SBI and SBI-MTF have NO check-session caching. checkSessionAndCache only caches when the broker's config has BOTH cacheCheckSessionResponse and checkSessionCacheConfig; in broker-api's config only `icici` has them (30s expiry) and only `upstox` has cacheAccessTokenResponse. So every SBI checkSession call hits broker-lib, and you will never see 'cached check session response is valid' for SBI.  
  `sc-integrations-broker-api/src/config.ts:181-188,146-156,285-295; sc-integrations-broker-api/src/services/user/checkSesssionAndCache.ts:71-81,95-113`

### sbi-broker-config

- **!** config.brokers entries for SBI carry NO apiKey/apiSecret — `sbi` and `sbi-mtf` are literally `{ redisRequired: true }`, and `sbi-mtf-leprechaun` is `{apiKey:'leprechaun_test_key', apiSecret:'leprechaun_test_secret', redisRequired:true}`. Only `sbi-leprechaun` reads SBI_API_KEY/SBI_API_SECRET. Because addBrokerKeys only injects keys when brokerConfig.apiKey is truthy, for sbi and sbi-mtf it injects ONLY the redis client wrapper — real SBI credentials must come from broker-lib's own config (refreshed from the Mongo BrokerConfig collection).  
  `sc-integrations-broker-api/src/config.ts:285-295,330-333; sc-integrations-broker-api/src/services/lib.ts:106-160; sc-integrations-broker-api/src/services/utils.ts:45-57`
- Because sbi/sbi-mtf have redisRequired:true, addBrokerKeys attaches a hand-built Redis wrapper (get/set/hget/hgetall/hset/expire/mget/quit/batch/pipeline) to options, explicitly nulling connector/emitter/_events to dodge circular JSON. If Redis is down, SBI routes that need it break at this middleware, before any broker call.  
  `sc-integrations-broker-api/src/services/lib.ts:120-160; sc-integrations-broker-api/src/config.ts:285-290`

### sbi-rebalance-sip

- **!** POST /api/v1/sip/rebalanceSip/create accepts brokerName in exactly {'kite','axis','sbi'} — SBI-MTF is NOT accepted and is rejected by Joi with HTTP 400 'invalid request'. brokerSipId is required only for kite. The SBI handler is a near no-op at the broker: it never calls SBI, it only reads the batch and persists a local rebalance-SIP document, then returns a synthetic success {code:true, scheduledDate, brokerSipId: undefined, basketIds: undefined}.  
  `sc-integrations-broker-api/src/routes/api/v1/sip/rebalanceSip.ts:8-9,39-42,68-72,93-97; sc-integrations-broker-api/src/services/rebalanceSip/createSip/sbi.ts:25-40,81-103`
- **!** The SBI rebalance-SIP create bails early unless the batch's originalLabel === 'REBALANCE', logging info with ERROR_MESSAGE.INVALID_BATCH and pushing it into response.errors while still returning HTTP 200. This is the most likely reason an SBI rebalance SIP 'silently did nothing'. Its logger is created with type SERVER_LOG, overrides {correlationId}, stringify=true — so grep by correlationId, not by tag.  
  `sc-integrations-broker-api/src/services/rebalanceSip/createSip/sbi.ts:48-52,66-72`
- GET /api/v1/sip/rebalanceSip requires EXACTLY ONE of correlationId or brokerIdentifier (Joi .xor). POST /delete requires correlationId + accessToken + action ∈ {FIX_BATCH, CANCEL_BATCH, SIP_EXECUTED, MARK_SIP_EXECUTED}; executedCorrelationId is REQUIRED when action is SIP_EXECUTED and FORBIDDEN otherwise. POST /getAll requires exactly one of correlationIds or scheduledDate.  
  `sc-integrations-broker-api/src/routes/api/v1/sip/rebalanceSip.ts:10-15,17-38,76-81`
- **!** The rebalance-SIP endpoints are the ONLY broker-api routes sc-integrations-order-updates calls over HTTP: exactly two, GET /api/v1/sip/rebalanceSip and POST /api/v1/sip/rebalanceSip/delete, via BROKER_AS_SERVICE_URL (prod: https://scb.prod.smallcase.com) with header x-domain-token. This is the complete set of order-updates→broker-api HTTP traffic.  
  `sc-integrations-order-updates/services/brokerAsService.js:7-10,17-27; sc-integrations-order-updates/config.js:391-393; sc-integrations-order-updates/deployment/infra/production-sc-integrations-order-updates-env.yaml:135`

### callers

- **!** sc-integrations-jobs calls broker-api at: /api/v1/sip/rebalanceSip/getAll, /api/v1/sip/rebalanceSip/delete, /api/v1/sip/rebalanceSip, /api/v1/sip/reconcile (delete+update autosip), /api/v1/user/cachedAccessTokenResponse, /api/v1/funds/checkFundsWithBrokerage. The SBI-relevant one is checkFundsWithBrokerage from jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js.  
  `sc-integrations-jobs/services/brokerAsService/request.js:16-22; sc-integrations-jobs/jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js:22,315-317`
- **!** sc-platform-api reaches broker-api two ways: (a) directly by URL for /api/v1/misc/getBrokerage, /api/v1/portfolio/getLiveHoldingsWithSid, /api/v1/sip/sessionless/{create, transaction/create, transaction/status}, /api/v1/user/authenticateDealer (SBI dealer), /api/v1/user/loginUrl; (b) via the @smallcase/sc-platform-babel brokerApi client for funds, session, portfolio, securities, lead, instruments, amoActiveHours, tradebook. INTEGRATION_SERVICE_URL is https://scb.prod.smallcase.com in prod.  
  `sc-platform-api/app/services/userSmallcase/userSmallcase.js:1440-1442,11584,11740; sc-platform-api/app/services/auth.js:288; sc-platform-api/app/integrations/sbi/sbi.dealerTerminal.integrations.js:33; sc-platform-api/deployment/infra/production-sc-platform-api-env.yaml:159; sc-platform-babel/services/brokerAsService.js:48-157`

### sbi-autosip

- **!** The generic AutoSIP routes are kite-only. schemas/autoSip.ts pins SUPPORTED_BROKERS = ['kite'], so /api/v1/sip/sessionless/{create, transaction/create, transaction/status} reject SBI with HTTP 400 'invalid request'. /api/v1/sip/reconcile is also kite-only. And the plain /api/v1/sip autoSip router is an EMPTY Router with no routes at all. Conclusion: SBI AutoSIP does NOT flow through broker-api.  
  `sc-integrations-broker-api/src/schemas/autoSip.ts:4,11-12,30-31; sc-integrations-broker-api/src/routes/api/v1/sip/common.ts:12; sc-integrations-broker-api/src/routes/api/v1/sip/autoSip.ts:5-7; src/routes/api/v1/sip/index.ts:11-14`

### sbi-branches

- **!** COMPLETE inventory of SBI/sbi-mtf-specific branches in broker-api (5 files, nothing else): (1) src/config.ts:285-295,330-333 — broker credential/redis entries; (2) src/configs/sbi.ts + src/configs/sbimtf.ts — brokerage endpoint builders; (3) src/services/brokerUtils/sbi.ts — determineBufferAmount; (4) src/controllers/broker/funds.ts:10,16-17,26-39 — SBI_BROKERS set and BROKERAGE_INCLUSIVE_BROKERS; (5) src/services/misc/getBrokerage/{index.ts:9-10,41, controllers.ts:1643,1737, common.ts:750, responses.ts:230, margin.ts:47,88-89,115-118} — brokerage + MTF margin; plus src/routes/api/v1/sip/rebalanceSip.ts:8 and src/services/rebalanceSip/createSip/{index.ts:4,14, sbi.ts:42}.  
  `sc-integrations-broker-api (grep -rni sbi src) — files as cited above`

### error-mapping

- **!** controllerWrapper maps typed errors to HTTP codes: BadRequest→400, Unauthorized→401, Forbidden→403, NotFound→404, NotImplemented→501, NotAvailable→503, and any other Error→500 logged at WARN (not error) with the error's own message as the log message. A generic 500 from broker-api therefore appears in logs as a WARN line whose message is the raw error text.  
  `sc-integrations-broker-api/src/services/lib.ts:22-48`
- **!** Response envelope is always { error: boolean, response, errorMessage?, message? } where message is the Error.message. Note many controllers return errors with HTTP 200 and error:true (e.g. every `return res.json(apiResponse(undefined, error))` path) — so status code alone is not a reliable success signal; check the `error` field. That is exactly what order-updates' client comments on.  
  `sc-integrations-broker-api/src/services/utils.ts:145-159; sc-integrations-broker-api/src/controllers/broker/funds.ts:55-57,109; sc-integrations-order-updates/services/brokerAsService.js:50-56`

### broker-lib-integration

- broker-api decrypts a BAT (broker access token) via decryptBAT(options.accessToken) before EVERY broker-lib call, and injects a real Redis client only for axis-mtf / axis-mtf-leprechaun at this layer (SBI gets its Redis from addBrokerKeys instead). After User.accessToken it rebinds the logging userId to the broker-returned response.userId — so the userId on an accessToken log line is the BROKER's user id, not smallcase's.  
  `sc-integrations-broker-api/src/services/brokerLib.ts:45-60,71-73`
- **!** Broker configs are hot-reloaded: ScbWrapper deep-clones broker-lib and refreshes each broker's config from the Mongo BrokerConfig collection every SCB_CONFIG_REFRESH_INTERVAL seconds (default 60). So broker behaviour can change WITHOUT a deploy — if SBI behaviour changed at an odd time with no release, check the BrokerConfig collection, not git.  
  `sc-integrations-broker-api/src/services/utils.ts:44-57; sc-integrations-broker-api/src/config.ts:70-71`

### kafka

- broker-api produces two Kafka topics: 'REBALANCE_SIP_response' and 'KITE_TRADEBOOK_READY', both consumed by sc-integrations-jobs. The SBI-relevant one is REBALANCE_SIP_response.  
  `sc-integrations-broker-api/src/config.ts:28-34`

### amo

- amoActiveHours passes date+poaFlag to broker-lib ONLY for kite; every other broker (SBI included) is called as brokers[brokerName].api.Misc.amoActiveHours() with NO arguments. Also note the date guard is inverted — `if (parsedDate instanceof Date && !Number.isNaN(date))` tests the raw `date`, not parsedDate, so a valid date string makes Number.isNaN(date) true and the branch is skipped, while a numeric input overwrites parsedDate with now(). Any SBI AMO-window question must be answered from broker-lib's SBI config, not from a parameter broker-api passed.  
  `sc-integrations-broker-api/src/services/misc/amo/amoActiveHours.ts:7-23`

### misc-broker-gates

- Several /api/v1/misc routes are hard-gated to kite and will never produce SBI logs beyond the rejection: getInternalUserAccessToken and generateTotp return bare HTTP 501 {} for any non-kite broker; internalToken throws NotImplemented('route not available for this broker'); setBrokerKeysInRedis is axis-only with the same message. getAddFundsUrl (v1) is kite-only and returns 501.  
  `sc-integrations-broker-api/src/controllers/broker/misc.ts:17-19,36-38,49-51,117-119; sc-integrations-broker-api/src/controllers/broker/funds.ts:141-149`

### timeouts

- **!** Timeout budget on broker-api calls: sc-platform-babel's client uses 10s default; sc-platform-api's ou.scb integration uses 10s; the SBI dealer-terminal integration uses 30s with 2 retries on 5xx. broker-api's own server keepAliveTimeout is 121000ms and headersTimeout 125000ms (deliberately 1s above the ALB idle timeout). A caller-side timeout on a slow SBI brokerage call will therefore appear as a completed request in broker-api logs but a failure upstream.  
  `sc-platform-babel/services/brokerAsService.js:162; sc-platform-api/app/integrations/ou/ou.scb.integrations.js:28; sc-platform-api/app/integrations/sbi/sbi.dealerTerminal.integrations.js:27,30,53; sc-integrations-broker-api/src/config.ts:4-6`

### ip-address

- Client IP handling differs per route: getBrokerage and checkFundsWithBrokerage read req.headers['x-forwarded-for'] || req.connection.remoteAddress; checkSession forces x-forwarded-for || '127.0.0.1'; authenticateDealer prefers options.ipAddress first. Separately, the SBI brokerage request's X-IP-ADDRESS header comes from options.clientDetails.channelIp (NOT the forwarded header), falling back to 127.0.0.1. SBI-side IP rejections should be debugged against clientDetails.channelIp.  
  `sc-integrations-broker-api/src/controllers/broker/misc.ts:61; src/controllers/broker/funds.ts:72; src/controllers/broker/user.ts:31-33,113; src/configs/sbi.ts:42,51; src/services/misc/getBrokerage/controllers.ts:1677`

### rate-limiting

- The configured rate limiter is kite-only (KITE_GLOBAL_RATE_LIMIT default 6 points/sec, jitter and DLQ retry settings). There is no SBI rate limiting in broker-api — SBI throttling, if any, is enforced by SBI or by broker-lib.  
  `sc-integrations-broker-api/src/config.ts:82-89`

### leprechaun

- 'sbi-mtf-leprechaun' brokerage routes to the REAL sbimtf() function, which then detects the 'leprechaun' substring in options.brokerName and calls POST {LEPRECHAUN_API_ENDPOINT}/v1/charges (prod: https://leprechaun.prod.smallcase.com/v1/charges) instead of SBI, afterwards bolting the locally computed margin onto the response. So for sbi-mtf-leprechaun there will be a BROKER_LOG line to leprechaun, not to fhapi.sbisecurities.in. SBI_LEPRECHAUN_API_ENDPOINT exists only in the staging env yaml, not production.  
  `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1748-1759,1802-1809; src/config.ts:80; deployment/infra/production-sc-integrations-broker-api-env.yaml:9; deployment/infra/staging-sc-integrations-broker-api-env.yaml:91`

### encryption

- Broker access tokens are JWT-wrapped and AES-GCM encrypted with strictly append-only key arrays: jwtSecrets[BAT_JWT_SECRET_V0] and encryptionKeys[BAT_ENCRYPTION_KEY_V0], currentEncryptionVersion 0, JWT expiry default 30 days (BAT_JWT_EXPIRE_IN_DAYS). A BAT decrypt failure surfaces from decryptBAT inside brokerLibAPIWrapper before any broker call is made.  
  `sc-integrations-broker-api/src/config.ts:56-64; src/services/brokerLib.ts:45-48`


## Grep targets (72)

Search with `fetch-by-identifier.js --service <svc> --text "<string>"`.

| String | Means | Emitted by | Citation |
|---|---|---|---|
| `sbi funds check buffer resolved` | THE key SBI funds line. Fields {userId, brokerName, addBufferAmount}. Tells you definitively whether the SBI buffer amount was applied on a funds check. First grep for any 'SBI insufficient funds' complaint. | addSbiBufferAmount() in the checkFunds / checkFundsWithBrokerage controllers _(lvl info)_ | `sc-integrations-broker-api/src/controllers/broker/funds.ts:34-37` |
| `broker request successful` | Outbound HTTP to SBI (or leprechaun) SUCCEEDED. Type BROKER_LOG. Carries the FULL request {method,url,headers,data} and full response {status,headers,data}. This is where the raw SBI brokerage-details request/response body lives. | utils.requestBroker() _(lvl info)_ | `sc-integrations-broker-api/src/services/utils.ts:287-297` |
| `broker request failed` | Outbound HTTP to SBI FAILED. Type BROKER_LOG. Carries err plus the full request and, when present, response {status,headers,data}. Empty response object means the call never got a reply (timeout/DNS/TLS). | utils.requestBroker() _(lvl warn)_ | `sc-integrations-broker-api/src/services/utils.ts:309-316` |
| `broker lib function response recieved` | A broker-lib call returned (success OR error — both land here). NOTE the misspelling 'recieved'. Type SC_BROKER. Carries options and {response:{error,response}}, plus override fields userId and brokerApi:{functionName,brokerName}. Grep with brokerApi.functionName to isolate e.g. Funds.check or User.authenticateDealer. | brokerLibAPIWrapper() in services/brokerLib.ts _(lvl info)_ | `sc-integrations-broker-api/src/services/brokerLib.ts:92-101` |
| `error in calling broker lib function` | broker-lib threw (as opposed to returning an error). Type SC_BROKER. The promise rejects, so the controller's wrapper turns it into a 500. | brokerLibAPIWrapper() catch branch _(lvl error)_ | `sc-integrations-broker-api/src/services/brokerLib.ts:104-116` |
| `Broker Lib function does not exist` | The requested broker+function pair is not implemented in the installed broker-lib version. Strong signal of a broker-lib version mismatch or an unsupported broker name (e.g. sending 'sbi_mtf' instead of 'sbi-mtf'). | brokerLibAPIWrapper() guard _(lvl error)_ | `sc-integrations-broker-api/src/services/brokerLib.ts:31-40` |
| `request received` | Every non-/health inbound request. Type REQUEST_LOG. context.context holds the stringified {req:{body,headers,query}}; context.url, context.userId and context.brokerFunctionLogId sit alongside. The full inbound payload for any SBI call is here. | loggerMiddleware in server.ts _(lvl info)_ | `sc-integrations-broker-api/src/server.ts:64-73` |
| `response sent` | Every non-/health outbound response. Type RESPONSE_LOG. Carries res.code, parsed body, response headers and responseTime IN SECONDS. Use responseTime to spot slow SBI brokerage calls. | loggerMiddleware res.end override _(lvl info)_ | `sc-integrations-broker-api/src/server.ts:104-114` |
| `calculated charges` | Brokerage computation SUCCEEDED for sbi or sbimtf. Carries {userId, options, charges} — and for sbimtf the charges object includes the margin{marginRequired,brokerage,marginReceivable} block. | charges.sbi() and charges.sbimtf() in getBrokerage/controllers.ts _(lvl info)_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1716-1723 (sbi), 1931-1938 (sbimtf)` |
| `failed to compute charges` | Brokerage computation FAILED for sbi/sbimtf; the caller gets an error. Carries {err, userId, options}. | charges.sbi() / charges.sbimtf() catch _(lvl warn)_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1727-1730 (sbi), 1942-1945 (sbimtf)` |
| `failed to get charges for a scrip` | ONE scrip's brokerage call failed (bad SID, SBI error, or SBI 4xx/5xx). Carries {err, order, userId}. Because tasks run under Promise.all, one of these fails the whole basket — look here first when 'calculated charges' is missing. | per-order task catch in charges.sbi() and charges.sbimtf() _(lvl warn)_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1695-1702 (sbi), 1871-1878 (sbimtf)` |
| `failed to fetch margin required` | SBI-MTF margin block threw; charges are still returned but margin will be zeros. Note the field is `e`, not `err`. This is why a user can see marginReceivable:0 with no API error. | sbimtf() margin try/catch _(lvl warn)_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1929` |
| `failed to fetch rebalance margin for order` | Per-order broker-lib Portfolio.fetchMarginReceivable failed for SBI-MTF; that order contributes 0 to marginReceivable. Carries {err, order, userId}. | fetchRebalanceMarginRequired() catch in getBrokerage/margin.ts _(lvl warn)_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/margin.ts:143-150` |
| `failed to compute margin for leprechaun` | sbi-mtf-leprechaun margin calculation failed; leprechaun charges are still returned WITHOUT margin. | sbimtf() leprechaun branch _(lvl warn)_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1812-1815` |
| `failed to compute charges from leprechaun` | The leprechaun /v1/charges call failed for sbi-mtf-leprechaun; the whole brokerage call rejects. | sbimtf() leprechaun branch catch _(lvl warn)_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1821-1824` |
| `invalid values recieved from sbi` | SBI returned a charge field that parseFloat could not turn into a finite number (brkAmt/sttAmt/exchTotAmt/sebiTotAmt/stampDutyAmt/gstAmt). NOTE the misspelling 'recieved'. Thrown, so it surfaces as the message on a 500 / 'failed to compute charges'. Same string for SBI-MTF (it reuses calculateSbi). | Charges.calculateSbi() _(lvl error (thrown, logged via the warn path))_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/common.ts:767` |
| `sbi didn't send any data` | SBI brokerage response had an empty body. | charges.sbi() per-order response check _(lvl error (thrown))_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1684` |
| `sbi didn't send charges` | SBI brokerage response had a body but no `brokerage` field. | charges.sbi() per-order response check _(lvl error (thrown))_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1690` |
| `sbimtf didn't send any data` | SBI-MTF brokerage response had an empty body. | charges.sbimtf() per-order response check _(lvl error (thrown))_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1860` |
| `sbimtf didn't send charges` | SBI-MTF brokerage response had a body but no `brokerage` field. | charges.sbimtf() per-order response check _(lvl error (thrown))_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1866` |
| `invalid sid` | Redis hash SID:{sid} was missing, or lacked `isin` or `series`. Becomes HTTP 400 BadRequest. Means the symbol cache is stale/incomplete, not an SBI fault. | per-order redis.hgetall guard in charges.sbi() and charges.sbimtf() _(lvl error (thrown as BadRequest))_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1665 (sbi), 1842 (sbimtf)` |
| `invalid params` | SBI returned res.data.error truthy on the brokerage call. Becomes HTTP 400. The actual SBI error body is in the adjacent 'broker request successful' BROKER_LOG line. | per-order response check in charges.sbi() and charges.sbimtf() _(lvl error (thrown as BadRequest))_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/controllers.ts:1687 (sbi), 1863 (sbimtf)` |
| `error in getting bse permitted stocks - ${err.message}` | The BSE-permitted-stock list fetch failed, so exchange could not be assigned. Fails the ENTIRE getBrokerage call for every broker including SBI, before any SBI call is made. | getBrokerage() in getBrokerage/index.ts _(lvl error (rejected))_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/index.ts:62-66` |
| `checkFundsWithBrokerage is not supported for ${brokerName}` | brokerName was not in {axis, axis-leprechaun, hdfc, hdfc-leprechaun, sbi, sbi-leprechaun}. Notably fires for sbi-mtf and sbi-mtf-leprechaun. Returned with HTTP 200 and error:true. | checkFundsWithBrokerage controller guard _(lvl n/a (returned in response envelope, not logged))_ | `sc-integrations-broker-api/src/controllers/broker/funds.ts:74-79` |
| `brokerage calculation failed` | checkFundsWithBrokerage aborted because the brokerage step threw — the funds check never ran. Carries {err, brokerName, userId}. | checkFundsWithBrokerage controller catch _(lvl error)_ | `sc-integrations-broker-api/src/controllers/broker/funds.ts:92-95` |
| `funds check returned no response` | Funds.check returned neither error nor response in checkFundsWithBrokerage. | checkFundsWithBrokerage controller _(lvl n/a (returned in response envelope))_ | `sc-integrations-broker-api/src/controllers/broker/funds.ts:110-112` |
| `get brokerage request received` | Entry into POST /api/v1/misc/getBrokerage. Carries {userId, brokerId, brokerName, requestBody} — the full unredacted-except-blacklist request. | misc.getBrokerage controller _(lvl info)_ | `sc-integrations-broker-api/src/controllers/broker/misc.ts:62-70` |
| `missing or invalid domain token` | x-domain-token header absent or not one of the four configured tokens → HTTP 400. The caller's INTEGRATION_SERVICE_SECRET / BROKER_AS_SERVICE_SECRET is wrong. Nothing broker-related happened. | domainTokenValidator middleware _(lvl warn)_ | `sc-integrations-broker-api/src/services/domainToken/index.ts:16-17` |
| `invalid request` | Joi schema validation failed → HTTP 400. Carries {err, body}. For SBI this is what you see when rebalanceSip/create is called with brokerName 'sbi-mtf' (only kite/axis/sbi allowed) or when a sessionless AutoSIP route is called with any non-kite broker. | requestValidator middleware _(lvl warn)_ | `sc-integrations-broker-api/src/services/lib.ts:61-62` |
| `route doesn't exist` | HTTP 404 from notFoundHandler. Seen when a caller uses a stale path — e.g. /api/v1/lead/createLead, /api/v1/lead/searchLead, /api/v1/configs/brokerConfigs, or any /api/v1/sip/{create,modify,delete,transaction/*} non-sessionless path. | notFoundHandler in server.ts _(lvl n/a (returned in response envelope))_ | `sc-integrations-broker-api/src/server.ts:39-43` |
| `unhandled error` | Express error handler caught something no controller handled → HTTP 500 'internal server error'. | errorHandler in server.ts _(lvl error)_ | `sc-integrations-broker-api/src/server.ts:33` |
| `request with invalid json body` | body-parser rejected malformed JSON → HTTP 400. Caller bug, not a broker issue. | errorHandler in server.ts _(lvl warn)_ | `sc-integrations-broker-api/src/server.ts:28-30` |
| `unhandled scb error` | An async function wrapped in tryCatchFunctionWrapper threw outside a request context. | tryCatchFunctionWrapper in services/lib.ts _(lvl error)_ | `sc-integrations-broker-api/src/services/lib.ts:18` |
| `failed to assign reqId` | express-http-context failed; reqId falls back to the literal string 'NA'. If you see reqId:'NA' you cannot correlate that line by reqId — fall back to brokerFunctionLogId or userId. | loggerMiddleware in server.ts _(lvl warn)_ | `sc-integrations-broker-api/src/server.ts:59-62` |
| `failed to parse body` | The response body could not be JSON.parsed for RESPONSE_LOG; the 'response sent' line will show body as empty string. | loggerMiddleware res.end override _(lvl error)_ | `sc-integrations-broker-api/src/server.ts:98` |
| `server started` | Process boot, type SERVICE_LOG, carries {port}. Use it to find restarts/deploys — a gap in logs bracketed by this line is a restart, not a missing request. | Server.start() _(lvl info)_ | `sc-integrations-broker-api/src/server.ts:144` |
| `cached check session response is valid` | checkSession served from Redis without hitting the broker. NEVER appears for SBI (only icici has cacheCheckSessionResponse) — if you see it for an SBI investigation, the broker name is not what you think. | isCachedResponseValid() in user/checkSesssionAndCache.ts _(lvl info)_ | `sc-integrations-broker-api/src/services/user/checkSesssionAndCache.ts:20-23` |
| `cached check session response is expired` | Redis session cache miss; the broker call will be made. Also SBI-irrelevant. | isCachedResponseValid() _(lvl info)_ | `sc-integrations-broker-api/src/services/user/checkSesssionAndCache.ts:27-30` |
| `error in checking cached check session response` | Redis read threw during session cache lookup; treated as a miss. | isCachedResponseValid() catch _(lvl warn)_ | `sc-integrations-broker-api/src/services/user/checkSesssionAndCache.ts:34-40` |
| `error in caching check session response` | Redis write threw after a successful checkSession. | cacheResponse() catch _(lvl warn)_ | `sc-integrations-broker-api/src/services/user/checkSesssionAndCache.ts:61-67` |
| `Failed to add broker fields to response` | addFieldsToResponse post-processing of a funds-check response failed. The funds response is still returned, possibly missing fields. | services/funds/index.ts _(lvl warn/error)_ | `sc-integrations-broker-api/src/services/funds/index.ts (message string; see grep of src/services/funds)` |
| `Rebalance Basket Create Request received` | Entry into POST /api/v1/sip/rebalanceSip/create. Grep alongside the correlationId for SBI rebalance-SIP investigations. | services/rebalanceSip/createSip/index.ts _(lvl info)_ | `sc-integrations-broker-api/src/services/rebalanceSip/createSip/index.ts:34` |
| `rebalance sip created` | SBI rebalance SIP persisted locally. Carries {newRebalanceSip}. NOTE: nothing was sent to SBI — this is a local-only success. | createRebalanceSip() in rebalanceSip/createSip/sbi.ts _(lvl info)_ | `sc-integrations-broker-api/src/services/rebalanceSip/createSip/sbi.ts:28` |
| `no intent to create rebalance sip` | The create payload had no `rebalance` object, so nothing was created. Returns 200 with isRebalanceSipCreated:false. | sbi() in rebalanceSip/createSip/sbi.ts _(lvl info)_ | `sc-integrations-broker-api/src/services/rebalanceSip/createSip/sbi.ts:105` |
| `broker action - ${functionName}` | CRITICAL DISAMBIGUATION: emitted by sc-integrations-order-updates, NOT broker-api, with name 'sc.service.sc-integrations-order-updates' and type SC_BROKER. functionName ∈ {placeOrder, orderStatus, orderBook, deleteOrder, securityHold, placeFractionalSell}. These carry the raw outbound SBI order HTTP. If you are searching broker-api for these you will find nothing. | lib/brokerApi.js in sc-integrations-order-updates _(lvl info)_ | `sc-integrations-order-updates/lib/brokerApi.js:63` |
| `SC_BROKER_REQUEST_INITIATED` | Caller-side (sc-platform-api) subtype logged just BEFORE an HTTP call to broker-api, with {url, method, params, timeout} and type SC_BROKER_META. Pair it with broker-api's 'request received' via brokerFunctionLogId to prove whether the request left platform-api and whether it arrived. | requestBrokerAsService() in @smallcase/sc-platform-babel _(lvl info)_ | `sc-platform-babel/services/brokerAsService.js:208-213` |
| `SC_BROKER_META_SUCCESS_RESPONSE` | Caller-side subtype: broker-api returned a usable response. scbMessage reads '${endpointName} request successful'. | requestBroker() in @smallcase/sc-platform-babel _(lvl info)_ | `sc-platform-babel/services/brokerAsService.js:381,387,396-401` |
| `SC_BROKER_META_FAILURE_RESPONSE` | Caller-side subtype: broker-api returned error:true or threw. scbMessage reads '${endpointName} request failed due to ${error}'. data.brokerApi.errorMessage holds the message. | requestBroker() in @smallcase/sc-platform-babel _(lvl info / error)_ | `sc-platform-babel/services/brokerAsService.js:382-385,411,416-421` |
| `${endpointName} request failed to due to exception, fix it` | Caller-side exception (not an API error) calling broker-api — timeout, DNS, connection refused. NOTE the literal typo 'failed to due to'. Means broker-api logs will likely have NOTHING for this request. | requestBrokerAsService() catch in @smallcase/sc-platform-babel _(lvl error)_ | `sc-platform-babel/services/brokerAsService.js:237-250` |
| `FUNDS_CHECK_REQUEST` | sc-platform-api subtype logged before every funds check, with {broker, label, variety, orderMode, buyAmount, sellAmount, twoStepRebalance}. Shows the NORMALIZED label (INVESTMORE substitution already applied) that broker-api's SBI buffer rule will see. | performFundsCheck() in sc-platform-api userSmallcase service _(lvl info (type DEBUG_MESSAGES))_ | `sc-platform-api/app/services/userSmallcase/userSmallcase.js:260-273` |
| `DEALER_TERMINAL_REQUEST` | sc-platform-api subtype logged before POSTing to broker-api /api/v1/user/authenticateDealer. Carries {brokerName, method, endpoint, hasData}. Start of the SBI dealer-login trail. | makeRequest() in sbi.dealerTerminal.integrations.js _(lvl info)_ | `sc-platform-api/app/integrations/sbi/sbi.dealerTerminal.integrations.js:61-72` |
| `DEALER_TERMINAL_ERROR` | sc-platform-api subtype for SBI dealer-login failure. Carries {brokerName, statusCode, endpoint, errorData}. Paired with an SBIDT00x code. | makeRequest() in sbi.dealerTerminal.integrations.js _(lvl error)_ | `sc-platform-api/app/integrations/sbi/sbi.dealerTerminal.integrations.js:79-90,102-113` |
| `SBIDT001` | SBI dealer terminal: broker-api returned HTTP 400 → ValidationError. Usually bad dealerLoginId/dealerPassword shape or a Joi rejection. | sbi.dealerTerminal.integrations.js status mapping _(lvl error)_ | `sc-platform-api/app/integrations/sbi/sbi.dealerTerminal.integrations.js:117` |
| `SBIDT002` | SBI dealer terminal: broker-api returned HTTP 401. | sbi.dealerTerminal.integrations.js status mapping _(lvl error)_ | `sc-platform-api/app/integrations/sbi/sbi.dealerTerminal.integrations.js:119` |
| `SBIDT003` | SBI dealer terminal: broker-api returned HTTP 404 — usually a stale/incorrect endpoint path. | sbi.dealerTerminal.integrations.js status mapping _(lvl error)_ | `sc-platform-api/app/integrations/sbi/sbi.dealerTerminal.integrations.js:121` |
| `SBIDT004` | SBI dealer terminal: broker-api returned 5xx or the call errored with no status (after 2 retries). | sbi.dealerTerminal.integrations.js status mapping _(lvl error)_ | `sc-platform-api/app/integrations/sbi/sbi.dealerTerminal.integrations.js:123` |
| `SBIDT005` | SBI dealer terminal: broker-api returned HTTP 200 but with error:true in the envelope — i.e. broker-lib/SBI rejected the dealer login. The real reason is in broker-api's SC_BROKER log line for User.authenticateDealer. | sbi.dealerTerminal.integrations.js 200-with-error branch _(lvl error)_ | `sc-platform-api/app/integrations/sbi/sbi.dealerTerminal.integrations.js:91` |
| `Dealer session not found or expired, please re-authenticate` | SBI dealer order placement could not find Redis key sbi:dealer_token:{entityId}:{userId} (8h TTL expired, or authenticateDealer was never called for this entityId/userId). Emitted from broker-lib running IN-PROCESS inside order-updates — search order-updates, then check broker-api for the last successful authenticateDealer. | placeDealerOrder() in broker-lib src/brokers/sbi/services/order.js (and sbi-mtf equivalent) _(lvl error (returned as error))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:155-157; src/brokers/sbi-mtf/services/order.js:170` |
| `Invalid dealer details response` | SBI's getDealerDetails reply lacked dealerDetailsResult.entityDetails or .tokenDetails. Surfaces through broker-api authenticateDealer as error:true with HTTP 200 → SBIDT005 upstream. | authenticateDealer() in broker-lib src/brokers/sbi/services/user.js _(lvl error (returned as error))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:427-429` |
| `sbi:dealer_token:` | Redis key prefix for the SBI dealer token, full form sbi:dealer_token:{entityId}:{userId}, TTL 28800s. SBI-MTF uses sbi-mtf:dealer_token:. Written by broker-api authenticateDealer, read by order placement in order-updates. | broker-lib sbi constants; written in user.js, read in order.js _(lvl n/a (Redis key, appears in logs only if a key string is logged))_ | `sc-integrations-broker-lib/src/brokers/sbi/constants.js:3; src/brokers/sbi-mtf/constants.js:3; src/brokers/sbi/services/user.js:434; src/brokers/sbi/services/order.js:152` |
| `fhapi.sbisecurities.in` | SBI's production API host. In broker-api it appears ONLY inside BROKER_LOG lines for /sp-updation-service/brokerage-details. If you see any OTHER sbisecurities path in a broker-api log, the guide's routing model is wrong — re-verify. | utils.requestBroker() via configs/sbi.ts and configs/sbimtf.ts _(lvl info/warn (inside 'broker request successful'/'failed'))_ | `sc-integrations-broker-api/deployment/infra/production-sc-integrations-broker-api-env.yaml:94-95; src/configs/sbi.ts:5,65` |
| `/sp-updation-service/brokerage-details` | The ONLY SBI endpoint broker-api calls. Greppable inside the BROKER_LOG request.url. Distinguish sbi from sbi-mtf by the request body's product field: 'C' = cash, 'E' = e-margin/MTF. | configs/sbi.ts and configs/sbimtf.ts endpoint builders _(lvl info/warn (inside 'broker request successful'/'failed'))_ | `sc-integrations-broker-api/src/configs/sbi.ts:65; src/configs/sbimtf.ts:65` |
| `MSILAPP1` | The fixed X-APPLICATON-ID header value on every SBI brokerage request (note the header name misspelling — APPLICATON). Useful as a unique marker to find SBI brokerage calls in a noisy log dump. | configs/sbi.ts and configs/sbimtf.ts header block _(lvl n/a (request header, logged inside BROKER_LOG request.headers))_ | `sc-integrations-broker-api/src/configs/sbi.ts:52; src/configs/sbimtf.ts:54` |
| `sc.service.sc-integrations-brokers-api` | The bunyan `name` on EVERY broker-api log line. Note BROKERS plural — the S3 path and pm2 process use the singular. Use this to confirm you are actually reading broker-api logs. | bunyan.createLogger in services/logger.ts, from config.serviceName _(lvl n/a (name field on every line))_ | `sc-integrations-broker-api/src/config.ts:7; src/services/logger.ts:11-15` |
| `REDACTED` | Appears wherever a blacklisted key was logged: apiKey, apiSecret, userName, accessToken, redis, requestToken, brokerParams (plus broker-lib's own per-broker blacklist). Seeing REDACTED where you expected a token is expected behaviour, not corruption. | redactIfDataIsSensitive() in services/logger.ts _(lvl n/a (substituted value))_ | `sc-integrations-broker-api/src/services/logger.ts:40-47` |
| `brokerFunctionLogId` | uuidv4 join key. Generated by sc-platform-api's babel client per broker call, sent in the request body's context, and re-emitted by broker-api inside context on REQUEST_LOG and RESPONSE_LOG. The single best field for correlating one platform-api broker call to its broker-api handling. | requestBroker() in sc-platform-babel; re-logged by loggerMiddleware in broker-api _(lvl n/a (context field))_ | `sc-platform-babel/services/brokerAsService.js:349-352,367-371; sc-integrations-broker-api/src/server.ts:54,101-102` |
| `set broker keys in redis request received` | Entry into POST /api/v1/misc/setBrokerKeysInRedis. Axis-only; any other broker (including SBI) throws NotImplemented → HTTP 501. | misc.setBrokerKeysInRedis controller _(lvl info)_ | `sc-integrations-broker-api/src/controllers/broker/misc.ts:116-119` |
| `route not available for this broker` | NotImplemented → HTTP 501. Emitted by /api/v1/misc/internalToken (kite-only) and /api/v1/misc/setBrokerKeysInRedis (axis-only). Expected for SBI. | misc.getInternalToken and misc.setBrokerKeysInRedis controllers _(lvl error (thrown as NotImplemented))_ | `sc-integrations-broker-api/src/controllers/broker/misc.ts:50,118` |
| `broker not supported` | NotImplemented → HTTP 501 from getBrokerage when the (normalized) broker name is neither a known charges function nor a leprechaun name. | getBrokerage() in getBrokerage/index.ts _(lvl error (thrown as NotImplemented))_ | `sc-integrations-broker-api/src/services/misc/getBrokerage/index.ts:71` |
| `Add funds URL not supported for this broker` | getAddFundsUrlV2 found no addFundsUrl in the broker config → HTTP 501. Also 'Broker configuration not found' → 404 and 'Invalid addFundsUrl configuration' → 500 from the same handler. | getAddFundsUrlV2 controller _(lvl error)_ | `sc-integrations-broker-api/src/controllers/broker/funds.ts:180-183,193-195,208-210` |
| `channel hook missing` | A Mattermost notification was attempted but MM_BROKER_LOGIN_NOTIFICATIONS_HOOK is unset for the requested channel. | mustSendMattermostMessage() in services/utils.ts _(lvl error (rejected))_ | `sc-integrations-broker-api/src/services/utils.ts:167-168` |
| `failed to fetch configs` | The periodic BrokerConfig refresh from Mongo returned nothing. Broker configs then go stale — relevant because SBI config is hot-reloaded every 60s and can change without a deploy. | ScbWrapper.refresh() in services/utils.ts _(lvl error (rejected))_ | `sc-integrations-broker-api/src/services/utils.ts:54-57` |


## Corrections (7)

Where the old `SBI_LOG_INVESTIGATION_GUIDE.md`, or an obvious assumption, is provably wrong.


**Claimed:** sc-mindmap/equity/CLAUDE.md:43 and :79 state the order flow is 'sc-platform-api → sc-integrations-order-updates → sc-integrations-broker-api → sc-integrations-broker-lib → broker', i.e. broker-api places order legs on the broker.

**Actually:** FALSE for SBI/SBI-MTF (and for every broker). broker-api's broker-lib wrapper object literally does not expose ANY Orders.* function — the complete list is getAccessToken, checkUserSession, refreshUserSession, logout, getLoginUrl, fetchMarginDetails, deleteSip, createSip, modifySip, instrumentsQuote, fundsCheck, getFunds, getAddFundsUrl, searchLead, createLead, triggerMail, triggerSms, triggerPush, hold, authorizeSell, getAuthForSell, getAuthStatus, getInternalUserAccessToken, generateTotp, amoActiveHours, getHoldings, getPositions, getLiveHoldings, getCheckSum, authenticateDealer. No Orders.place, no Orders.status, no Orders.delete, no Orders.list. There is also no /orders route anywhere in the repo (routes are config, kite, user, funds, securities, portfolio, instruments, lead, communications, sip, misc, tradebook). order-updates instead requires @smallcase/sc-integrations-broker-lib IN-PROCESS and maps placeOrder→Orders.place, orderStatus→Orders.status, orderBook→Orders.list, deleteOrder→Orders.delete, securityHold→Security.hold, placeFractionalSell→Orders.placeFractionalSell.

`sc-integrations-broker-api/src/services/brokerLib.ts:120-151; sc-integrations-broker-api/src/routes/api/v1/index.ts:26-68; sc-integrations-order-updates/lib/brokerApi.js:1,24-31`


**Claimed:** SBI_LOG_INVESTIGATION_GUIDE.md §1.2 (lines 116-122) claims broker-api is NOT in the SBI order hot path and order-updates calls broker-lib in-process.

**Actually:** CORRECT — confirmed from broker-api's own source. This resolves the contradiction in favour of the guide and against sc-mindmap/equity/CLAUDE.md. Proof is stronger than the guide's: broker-api's wrapper has no Orders.* binding at all, so the HTTP hop is not merely unused, it is impossible.

`sc-integrations-broker-api/src/services/brokerLib.ts:120-151; sc-integrations-order-updates/lib/brokerApi.js:24-31`


**Claimed:** SBI_LOG_INVESTIGATION_GUIDE.md lines 972, 993, 1021, 1044, 1065, 1086, 1124, 1141 repeatedly instruct 'Fetch: sc-integrations-broker-api, --filter-text "<tag>"' to find placeOrder / orderStatus / fundsCheck / cancel payloads for an order tag.

**Actually:** FALSE, and self-contradictory with the guide's own §1.2. broker-api NEVER sees an order tag. Grepping the whole repo for 'tag' returns only AES-GCM auth-tag handling in src/services/encryption.ts:14,17,28,32 — zero order-tag code. Grepping for orderId/batchId/correlationId outside SIP code returns only batchId/originalBatchId inside the SBI funds-buffer helper. A --filter-text "<tag>" search against --service broker-api is GUARANTEED to return zero rows. The skill must never route a tag-based order query to broker-api.

`sc-integrations-broker-api/src/services/encryption.ts:14-32; sc-integrations-broker-api/src/services/brokerUtils/sbi.ts:10,23,34,38 (only batchId hits in the repo)`


**Claimed:** SBI_LOG_INVESTIGATION_GUIDE.md line 1114 states '3. sc-integrations-broker-api: broker-lib's place() — options.label==\'AUTOSIP\' || options.activated ... routes to autosipService.placeOrder → POST /sipbasket-service/smallcase-sip-place-order'.

**Actually:** Wrong service attribution. That broker-lib place() dispatch is executed in-process by whichever service loaded broker-lib — for order placement that is sc-integrations-order-updates (or sc-integrations-jobs), never broker-api, because broker-api never binds Orders.place.

`sc-integrations-broker-api/src/services/brokerLib.ts:120-151; sc-integrations-order-updates/lib/brokerApi.js:24-31,42-43`


**Claimed:** The research task brief states 'sc-integrations-broker-api ... (branch: rebalance-in-amo, NOT production — flag this)'.

**Actually:** FALSE for this repo. sc-integrations-broker-api is checked out on branch 'production' at commit f2d0ae9 (2026-09-17). The repos actually off production are sc-integrations-leprechaun (rebalance-in-amo) and sc-integrations-broker-lib (development). Caveat that does apply: broker-api's package.json pins broker-lib ^16.11.14 but the locally installed node_modules copy is 16.11.13-rebalance-in-amo.2, a pre-release — so broker-lib behaviour read from THIS checkout's node_modules is not necessarily prod.

`git -C sc-integrations-broker-api rev-parse --abbrev-ref HEAD → production; sc-integrations-broker-api/package.json:39; sc-integrations-broker-api/node_modules/@smallcase/sc-integrations-broker-lib/package.json:3`


**Claimed:** Implicit assumption that broker-api's bunyan log 'name' field matches the repo/service name 'sc-integrations-broker-api'.

**Actually:** FALSE. config.serviceName is 'sc-integrations-brokers-api' — BROKERS plural — so every log line carries "name":"sc.service.sc-integrations-brokers-api". The S3 bucket path uses the singular 'sc-integrations-broker-api'. Searching logs by name with the singular spelling silently returns nothing.

`sc-integrations-broker-api/src/config.ts:7; sc-integrations-broker-api/src/services/logger.ts:11-15`


**Claimed:** Assumption that endpoints registered in the platform-side client are all live routes on broker-api.

**Actually:** Several are dead and 404. sc-platform-babel/services/brokerAsService.js maps createLead→'/api/v1/lead/createLead' and searchLead→'/api/v1/lead/searchLead', but broker-api serves '/api/v1/lead/create' and '/api/v1/lead/search'. Both are actually called from sc-platform-api/app/services/auth.js:890,969. Likewise getBrokerConfigs→'/api/v1/configs/brokerConfigs' (plural 'configs') does not exist; only '/api/v1/config/brokerConfigs' does. And createSip/modifySip/deleteSip/createSipTransaction/getSipTransactionStatus map to '/api/v1/sip/{create,modify,delete,transaction/create,transaction/status}' while broker-api's autoSip router is an EMPTY Router with zero routes — the only live SIP routes are /api/v1/sip/rebalanceSip*, /api/v1/sip/sessionless/*, /api/v1/sip/reconcile. All of these return HTTP 404 {"error":true,"message":"route doesn't exist"}.

`sc-platform-babel/services/brokerAsService.js:105-112,121-124,125-144; sc-integrations-broker-api/src/routes/api/v1/lead.ts:10-11; sc-integrations-broker-api/src/routes/api/v1/sip/autoSip.ts:5-7; sc-integrations-broker-api/src/routes/api/v1/sip/index.ts:11-14; sc-integrations-broker-api/src/server.ts:39-43`


## Open questions (7)

Genuinely unresolved. Report these as unknown rather than guessing.

- SBI_PRIVATE_CERT is absent from production-sc-integrations-broker-api-env.yaml (staging has no cert either). If it is not injected from a secret store, String(undefined) yields the literal string 'undefined' as the CA. Because rejectUnauthorized:false is set, TLS still succeeds, so this would fail silently. Could not verify the secret-store wiring from this repo — check the Helm/ArgoCD secret manifests or exec into the pod.
- SBI_DEALER_LOGIN_API_ENDPOINT exists only in staging env yaml (:88), not in production. Whether SBI dealer authentication is live in prod, or points at some default inside broker-lib, could not be determined from broker-api's config.
- Whether a per-broker allowlist gates /api/v1/user/accessToken, /checkSession, /refreshSession, /logout, /loginUrl for SBI. broker-api itself does not gate them (brokerName is free-form; only addBrokerKeys reads config.brokers), so support is decided inside broker-lib. Verify in broker-lib src/brokers/sbi/api.js before telling an investigator SBI login logs will exist in broker-api.
- The exact prod value of SBI_API_KEY / SBI_API_SECRET for the 'sbi-leprechaun' broker key (config.ts:330-333) is not in the env yaml; sbi and sbi-mtf themselves have NO apiKey at all (only redisRequired:true), so addBrokerKeys injects only the redis wrapper for them. Whether broker-lib sources SBI credentials from the BrokerConfig Mongo collection instead (via ScbWrapper refresh) is likely but unverified.
- Whether the SBI REPAIR buffer-amount query in brokerUtils/sbi.ts:35-45 targets the right Mongo collection. It queries collection('orders') filtering on originalLabel and originalBatchId and projects date/status — those look like BATCH document fields, not order-document fields. If the real collection is 'batches', this branch silently returns false for every REPAIR. Not verifiable without the Mongo schema.
- Whether any caller ever reaches the REPAIR branch: sc-integrations-jobs' two-step SIP path sends label:'REBALANCE' with no originalBatchId at all, and only sc-platform-api forwards originalBatchId. Whether platform-api ever sends label 'REPAIR' to checkFunds was not traced.
- broker-api is listed as EKS-only in the guide (§3.2). The repo still ships EC2/PM2 deploy scripts (deployment/setup_ssh_prod.sh:134-143) alongside an EKS ingress manifest. Which surface is authoritative for a given historical date was not re-verified here.
