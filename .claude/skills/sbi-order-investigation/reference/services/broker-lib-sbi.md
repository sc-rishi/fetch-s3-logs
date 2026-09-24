# broker-lib-sbi

broker-lib SBI cash adapter. Runs in-process inside order-updates. All SBI wire protocol, status maps and error classification.

**branch when read:** development (NOT 'rebalance-in-amo' as the task assumed; HEAD = dbe4206f, pkg version 16.11.15, dated 2026-09-18). origin/production exists but is 2 years stale (bab9ae3c, 2024-09-25, v15.22.0) and is NOT how this repo ships — see corrections.

This directory is the entire SBI CASH wire protocol: it builds every JSON body smallcase sends to SBI Securities, maps every SBI response field back to a smallcase order status, and is where the only redaction that protects (or fails to protect) a production log line is decided. For an investigator, the three load-bearing artefacts here are (1) the tag — `sc_` + 9 alphanumerics, generated in config.js, written to SBI as `externalReferenceNumber` AND `remarks`, and the ONLY key that ties a raw SBI order back to a smallcase order; (2) `orderStatusesReverse`, the numeric-code table that collapses SBI's 12 order states into 4 smallcase states and silently drops codes 5/7/8 into `ERROR`; and (3) `_mapPlaceOrderResponse`'s `shortfallFlag` N/Q/F branch, which turns a HTTP-200 SBI response into either a PLACED order or a synthesized `Quantity shortfall:`/`Funds shortfall:` statusMessage that downstream `getErrorCode` regexes then classify. Almost nothing in this directory logs on its own — order placement emits zero log lines of its own; every trace you will find comes from `services/request.js` (msg `Successful request` / `sending success response` / `Error in request`) or from `api.js`'s thin `logWarn` wrappers. Two facts will cost you hours if you do not know them: SBI-MTF writes `broker: "sbi"` in logs too, so the `broker` field does NOT distinguish cash from MTF (use the `sc_` vs `scmtf_` tag prefix or `product: 1` vs `product: 6`); and redaction is key-name-only, so the full `Authorization: Bearer <session token>` header and the dealer's plaintext login password ARE present in prod logs while `accessToken`/`brokerParams`/`userName`/`ipAddress` keys are not.

Confidence markers are the researcher's own: unmarked = confirmed from source, `[INFERRED]` = deduced but unproven, `[UNCONFIRMED]` = a lead, not a fact. `!` marks facts flagged critical. Re-verify line numbers against the checked-out SHA.


## Facts (108)


### branch-and-shipping

- **!** broker-lib is checked out on branch 'development' at HEAD dbe4206f, package version 16.11.15. It is NOT on 'rebalance-in-amo'. Verify with: git -C <repo> rev-parse --abbrev-ref HEAD  
  `sc-integrations-broker-lib/package.json:4`
- **!** broker-lib does NOT deploy from a git branch — it is published as the npm package @smallcase/sc-integrations-broker-lib and consumers pin a caret range: order-updates ^16.11.15, platform-api ^16.11.14, jobs ^16.11.14, leprechaun ^16.11.9. To know what SBI code ran in prod at time T, resolve the consuming service's pinned version, not a broker-lib branch.  
  `sc-integrations-order-updates/package.json ("@smallcase/sc-integrations-broker-lib": "^16.11.15"); sc-platform-api/package.json (^16.11.14); sc-integrations-jobs/package.json (^16.11.14); sc-integrations-leprechaun/package.json (^16.11.9)`
- **!** The broker-lib copy actually installed under order-updates is 16.11.13-rebalance-in-amo.1 — a pre-release cut from the rebalance-in-amo branch. Its entire src/brokers/sbi/ tree is byte-identical to the 'development' checkout EXCEPT config.js, which differs in exactly two places: the installed copy has `rebalanceInAMOEnabled: true` (removed on development) and `limitBatchConfig.default.validity: 'IOC'` (development says 'DAY'). Every other SBI fact in this report is identical on both.  
  `sc-integrations-order-updates/node_modules/@smallcase/sc-integrations-broker-lib/package.json:3 and diff vs sc-integrations-broker-lib/src/brokers/sbi/config.js:78,138`

### broker-log-field

- **!** The `broker` field written into every log line from this adapter is `config.brokerName`, which is the literal string 'sbi' (or 'sbi-leprechaun' when isLeprechaun=true). lib/log stamps it as the top-level `broker` key on every info/warn/error record.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:17,53 and src/lib/log.js:51-55,60-69,74-83`
- **!** SBI-MTF ALSO writes broker: 'sbi' — sbi-mtf/config.js sets `brokerName = isLeprechaun ? 'sbi-mtf-leprechaun' : 'sbi'`. There is NO 'sbi-mtf' value for the log `broker` field in the real (non-leprechaun) path. Filtering logs on broker=='sbi' returns cash AND MTF traffic mixed together.  
  `sc-integrations-broker-lib/src/brokers/sbi-mtf/config.js:19`
- **!** Reliable ways to separate SBI cash from SBI-MTF inside a raw log line, in order of reliability: (1) tag prefix — cash is `sc_`+9 chars, MTF is `scmtf_`+9 chars; (2) request body `orderParameters.orderLegDetails.product` — cash sends 1 (CASH), MTF sends 6 (MTF); (3) the request URL host, since cash reads SBI_API_ENDPOINT and MTF reads SBI_MTF_API_ENDPOINT (may or may not be the same host in prod — unverified).  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:109-113 vs src/brokers/sbi-mtf/config.js:115-119; src/brokers/sbi/services/order.js:223 vs src/brokers/sbi-mtf/services/order.js:233; src/brokers/sbi/config.js:2 vs src/brokers/sbi-mtf/config.js:3`

### tag-generation

- **!** config.generateTag() returns `sc_` + a 9-character nanoid drawn from '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'. Total length 12. Regex to grep a raw log for an SBI cash tag: /sc_[0-9a-zA-Z]{9}/ . Runtime-verified samples: sc_50E9wiIxr, sc_A1k6LYcfh.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:109-113`
- **!** The tag is written into the SBI place-order body TWICE: as `orderParameters.externalReferenceNumber` and as `orderParameters.remarks`. Both carry the same value. The dealer variant writes it to `dealerorderparameterbean.externalReferenceNumber` and `.remarks`.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:228-229 (retail), :143-144 (dealer)`
- **!** config.getOrderKey(order) returns `order.tag` — for SBI the smallcase orderKey IS the tag, not the SBI internalOrderNumber. On origin/production it returned order.orderId instead, so any pre-2024 reasoning about orderKey is wrong for the shipped code.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:92-94`

### order-status-codes

- **!** SBI raw orderStatus numeric enum (constants.orderStatuses): 1 PENDING, 2 MODIFIED, 3 PARTIALLY_TRADED, 4 TRADED, 5 TRANSIT, 6 CANCELLED, 7 EXPIRED, 8 FREEZED, 9 REJECTED, 10 QUEUED, 11 SENT_TO_EXCHANGE, 12 GTDT_BLOCKED, 99 ALL (query-only sentinel), plus a non-numeric ERROR:'ERROR'.  
  `sc-integrations-broker-lib/src/brokers/sbi/constants.js:99-114`
- **!** orderStatusesReverse (raw code -> smallcase status) is the COMPLETE mapping: 1->PLACED, 2->PLACED, 3->PLACED, 4->COMPLETE, 6->CANCELLED, 9->REJECTED, 10->PLACED, 11->PLACED, 12->REJECTED. Codes 5 (TRANSIT), 7 (EXPIRED), 8 (FREEZED) and 99 are DELIBERATELY ABSENT (commented out) and therefore fall through to constants.scStatus.ERROR. The raw numeric code is never itself logged downstream of this mapping, so an order showing smallcase status ERROR could be TRANSIT, EXPIRED or FREEZED and you cannot tell which from smallcase logs alone — you need the raw order-status response body.  
  `sc-integrations-broker-lib/src/brokers/sbi/constants.js:115-130 applied at src/brokers/sbi/services/order.js:40`
- Source carries the verbatim comment `// todo: confirm the commented out statuses` directly above orderStatusesReverse — the original authors never verified 5/7/8. Treat any inference about those three as unconfirmed by smallcase itself.  
  `sc-integrations-broker-lib/src/brokers/sbi/constants.js:116`

### order-status-mapping

- **!** _mapBrokerOrderResponseToSC builds the smallcase order object from these exact SBI paths: status <- orderLegDetails.orderStatus (via orderStatusesReverse, default ERROR); orderId AND orderKey <- orderLegDetails.internalOrderNumber (same value in both); exchangeOrderId <- orderLegDetails.exchangeOrderNumber; filledQuantity <- orderQuantityDetails.tradedQuantity||0; averagePrice <- orderPriceDetails.totalTradedValue / tradedQuantity (0 when tradedQuantity is 0); orderType <- broker2ScOrderTypes[orderLegDetails.orderType]; tag <- orderLegDetails.externalReferenceNumber; transactionType <- transactionTypesReverse[orderLegDetails.orderSide]; orderTimestamp <- parseSBITimestamp(orderLegDetails.orderTime).  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:32-52`
- broker2ScOrderTypes has EXACTLY ONE entry: {1: 'MARKET'}. Any SBI orderType other than 1 maps orderType to undefined in the smallcase order object (the key is then dropped by JSON serialisation). transactionTypesReverse has only {1:'BUY', 2:'SELL'}.  
  `sc-integrations-broker-lib/src/brokers/sbi/constants.js:21-23,33-36`

### order-timestamps

- **!** SBI returns order timestamps as IST wall-clock strings in the format '08 JUN 2026 01:15:27 PM'. parseSBITimestamp splits on whitespace, requires >=4 parts, maps the 3-letter month via a MONTHS table, applies AM/PM correction, then SUBTRACTS 19800000 ms (5h30m) and returns a UTC ISO string. It returns null (not throws) for any unparseable value — so a null orderTimestamp on an SBI order means a malformed broker timestamp, not a missing one.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:5-27`

### shortfall-flag

- **!** shortfallFlag state machine in _mapPlaceOrderResponse, evaluated ONLY when error is falsy AND response is truthy AND response.result exists: flag 'N' => {status:'PLACED', orderId: response.result.internalOrderNumber}. flag 'Q' => {statusMessage: `Quantity shortfall: ${response.result.shortfallDetails.shortfallValue}`} with NO status field. flag 'F' => {statusMessage: `Funds shortfall: ${...shortfallValue}`} with NO status field.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:54-91`
- **!** If shortfallFlag is any value other than N/Q/F, execution falls past all three branches to the tail return: {error: new Error('order placement failed'), response:{statusMessage: response.error || 'Unknown error'}}. The actual flag character is never put into statusMessage. But it IS recoverable: request.js logs the whole raw body under msg 'sending success response' at details.responseBody.result.shortfallDetails.shortfallFlag.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:64-90 and src/brokers/sbi/services/request.js:160-163`
- **!** When SBI returns 200 but with NO `result` object, _mapPlaceOrderResponse returns {response:{statusMessage: messageList[0].messageDescription}} or the literal 'Unknown API error' when messageList is empty/absent. Because the returned object has no `status` field, api.js's `response.status === PLACED` check is false and the order is passed to failureHandler.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:56-63 and src/brokers/sbi/api.js:165-170`

### place-order-body

- **!** Retail place-order body shape (POST /order-service/place-order): {tradingAccountDetails:{tradingAccountNumber:<userId from token>, accountSettlementType:<nriFlag>}, instrumentDetails:{exchangeIdentity:{exchangeId, exchangeIdType:2}, instrumentIdentity:{instrumentSegment:1, instrumentType:1, instrumentIdType:42, instrumentId}}, orderParameters:{orderDetails:{internalOrderNumber:-1, orderSerialNumber:0, orderSide, bookType:1}, orderQuantityDetails:{lotQuantityIndicator:1, orderQuantity}, orderPriceDetails:{orderPriceCurrency:'INR', orderPrice}, orderLegDetails:{product:1, orderSlot, orderValidity, preOpenFlag:'N'}, externalReferenceNumber:<tag>, remarks:<tag>}}  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:181-233`
- **!** There is NO orderType / MARKET-vs-LIMIT field anywhere in the SBI place-order body. The only price signal is orderPriceDetails.orderPrice. A market order is therefore expressed as orderPrice 0 and a limit order as a non-zero orderPrice. `[INFERRED]`  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:190-232 (no orderType key present)`
- **!** instrumentId is `orderOptions.brokersymbol` if present, else formatSecurityName(tradingsymbol, series) which appends 'RR' when series==='RR' and 'EQ' for EVERYTHING else — including BE and BZ series. So a BE-series stock placed without a brokersymbol goes to SBI as <SYMBOL>EQ, which SBI will likely reject as an unknown instrument.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:204 and src/brokers/sbi/services/util.js:72-77`
- **!** constants.exchanges contains ONLY {NSE:'NSE'}. exchangeId is computed as constants.exchanges[orderOptions.exchange], so any exchange other than the literal 'NSE' yields undefined and the exchangeId key is dropped from the serialised JSON entirely. SBI cash is NSE-only by construction.  
  `sc-integrations-broker-lib/src/brokers/sbi/constants.js:25-27 used at src/brokers/sbi/services/order.js:197`

### order-validity

- **!** _resolveOrderValidity precedence: if variety==='amo' -> ALWAYS orderValidities.DAY (1), overriding any caller-supplied validity. Else if options.validity is truthy -> constants.orderValidities[validity] with fallback to the raw string. Else -> orderValidities.IOC (2). Default for a regular order with no validity is therefore IOC.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:171-179`
- **!** Shipped orderValidities wire codes are DAY:1, IOC:2, GTDt:4, ALL:99. NOTE: the stale origin/production branch has DAY:0, IOC:1 — reading that branch will give you the WRONG wire codes for every order placed since ~2025.  
  `sc-integrations-broker-lib/src/brokers/sbi/constants.js:53-60; git diff origin/production...HEAD -- src/brokers/sbi/constants.js`

### order-slots-amo

- **!** orderSlot is derived purely from variety: variety==='amo' -> orderSlots.OFF_MARKET (2), anything else -> orderSlots.ONLINE (0). orderSlots.ALL (99) is used only in order-status queries. scVariety strings are LOWERCASE on shipped code ('amo'/'regular'); origin/production had them UPPERCASE ('AMO'/'REGULAR').  
  `sc-integrations-broker-lib/src/brokers/sbi/constants.js:6-9,48-52 and src/brokers/sbi/services/order.js:183-188`

### enums

- Full remaining SBI enum set: transactionTypes BUY:1 SELL:2 ALL:99. bookTypes REGULAR_LOT:1 STOP_LOSS:2. qtyIndicators QUANTITY:1 LOT:2. preOpenFlags YES:'Y' NO:'N' (SBI cash always sends 'N'). instrumentSegments EQUITY:1. instrumentTypes EQUITY:1. instrumentIdTypes INTERNAL_CODE:42 ISIN:2. referenceNumberFilterTypes INTERNAL_ORDER_NUMBER:1 EXCHANGE_ORDER_NUMBER:2 EXTERNAL_REFERENCE_NUMBER:3 ALL:99. orderTypes NORMAL:1 TRAILING_STOP_LOSS:2 BRACKET_ORDER:3 ALL:99. tradingMarkets PRIMARY:1 SECONDARY:2. dpHoldTransactionTypes ADHOC_HOLD:1 ONLINE_HOLD:2 RELEASE:3 COLLATERAL_HOLD:4 COLLATERAL_RELEASE:5. currencies INR:'INR'.  
  `sc-integrations-broker-lib/src/brokers/sbi/constants.js:28-98,131-147`
- **!** constants.products = {MARGIN:0, CASH:1, INTRADAY:2, COLLATERAL_SELL:3, SPOT:4, E_MARGIN:5}. There is NO `ALL` key. SBI cash always sends product:1 on place/cancel. SBI-MTF adds MTF:6.  
  `sc-integrations-broker-lib/src/brokers/sbi/constants.js:91-98; sbi-mtf/constants.js:91-99`

### order-status-polling

- **!** getOrderDetails posts to /books-service/order-status with orderReferenceDetails.referenceNumberFilter = the TAG and referenceNumberFilterType = 99 (ALL). It does NOT query by SBI order id. The correlation is then re-done client-side: orderStatusList.find(o => o.orderLegDetails.externalReferenceNumber === tag).  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:322-349,388`
- BUG / wire quirk: the order-status query sets `product: constants.products.ALL`, but products has no ALL key, so the value is undefined and JSON.stringify drops the key. Every SBI cash order-status query is therefore sent with NO product filter at all. Runtime-verified: require('./constants').products.ALL === undefined.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:342 against src/brokers/sbi/constants.js:91-98`
- getOrderDetails ALWAYS sends ipAddress '127.0.0.1' (hardcoded), not the caller's IP. So the X-IP-ADDRESS header on every order-status call is 127.0.0.1 — do not read it as the user's real IP.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:356,372`
- **!** If the response has no result, no result.orderStatusList, or an empty orderStatusList, getOrderDetails THROWS new Error('Invalid response from broker') which its own try/catch converts to {error}. If the list is non-empty but no entry matches the tag, it returns {response:{status:'ERROR', statusMessage:'Order not found'}} instead — two different outcomes for two different 'not found' shapes.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:384-397`

### settlement-type-retry

- **!** The 600014 retry loop: after the first order-status call, the code loops over accountSettlementType in [0, 2, 3]. On each iteration it re-checks whether the CURRENT response has messageList[0].messageCode === 600014 ('no data found'); if so AND the candidate settlement type differs from the ORIGINAL nriFlag decoded from the token, it re-issues the same order-status call with accountSettlementType overwritten. It stops as soon as a call comes back without 600014. Worst case it issues 1 + 3 = 4 order-status calls for a single poll.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:363-378`
- **!** The retry exists because a dual-eligible NRI account (NRE_NRO) gets nriFlag '0' written into its access token as a placeholder — the real settlement type is only discoverable by trying. Non-dual accounts get the single eligible code ('2' NRO or '3' NRE) baked into the token at login.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:363-364 (comment) and src/brokers/sbi/services/user.js:82,118`
- **!** SBI-MTF has NO 600014 retry loop — grep of sbi-mtf/services/order.js for '600014' returns zero matches. An MTF order-status query that hits the wrong settlement type is a dead end where the identical SBI cash query would have recovered.  
  `grep -c 600014 sc-integrations-broker-lib/src/brokers/sbi-mtf/services/order.js == 0`

### nri-settlement

- **!** accountSettlementType resolution at order time: `NRI_STRING_TO_CODE[options.nri] || nriFlag` where NRI_STRING_TO_CODE = {NRE:3, NRO:2}. So a per-order 'NRE'/'NRO' choice wins over the token-baked flag; otherwise the token's numeric nriFlag is used. 0 means resident Indian. The same {NRE:3,NRO:2} table is duplicated in order.js, fund.js and security.js.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:9,258; services/fund.js:10,69; services/security.js:7,13`

### access-token-format

- **!** The smallcase 'accessToken' for SBI is NOT an SBI token — it is a pipe-joined 6-field string: `${sbiToken}|${userId}|${dealerId}|${nriFlag}|${dpAccountNumber}|${dpCode}`. decodeAccessToken splits on '|'; if nriFlag is not numeric it coerces to 0 (resident). If accessToken is falsy the decode returns an object with `accessToken:''` and NO `token` key at all — so downstream `const {token} = decodeAccessToken(x)` is undefined for an empty token.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/util.js:7-64`

### dealer-orders

- **!** MOST IMPORTANT DEALER TRAP: in place(), if the decoded token has a dealerId but options.dealerDetails is ABSENT, the function returns a FAKE SUCCESS — {orderId:'NA', statusMessage:'order placed by dealer', status:'PLACED'} — WITHOUT calling SBI at all. A smallcase order showing orderId 'NA' was never sent to the broker.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:260-269`
- **!** Real dealer placement (placeDealerOrder) reads the dealer's SBI token from Redis key `sbi:dealer_token:${entityId}:${dealerUserId}`. If the key is missing/expired it returns {error: new Error('Dealer session not found or expired, please re-authenticate')} and never calls SBI.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:149-169 and constants.js:3`
- **!** Dealer order body differs structurally from retail: it adds dealerAccountDetails{entityId, tokenId, userId} and renames the parameter bundle to `dealerorderparameterbean` with sub-keys dealerorderDetails / dealerorderLegDetails / dealerorderPriceDetails / dealerorderQuantityDetails. It also uses tradingAccountDetails.clientId (not tradingAccountNumber), hardcodes orderValidity to IOC (2) even for AMO, and sets disclosedQuantity 0 / minimumFillQuantity 0.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:93-147`
- **!** Dealer AMO validity inconsistency: the retail path forces DAY (1) for AMO via _resolveOrderValidity, but _getDealerBrokerOrderObject hardcodes `orderValidity: constants.orderValidities.IOC` unconditionally while still setting orderSlot OFF_MARKET for AMO. A dealer AMO order therefore goes to SBI as OFF_MARKET + IOC.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:128-131 vs :225 and :171-179`

### dealer-auth

- **!** authenticateDealer POSTs to {SBI_DEALER_LOGIN_API_ENDPOINT}/dealer-authentication-service/dealer-details with body {dealerDetails:{entityIdentity:{loginID, loginIdType:1, loginTypeValue:<PLAINTEXT PASSWORD>}}}. It extracts entityId/userId from response.dealerDetailsResult.entityDetails.deatailsOfDealer (note the SBI-side typo 'deatailsOfDealer') and the token from .tokenDetails.accessToken, then Redis SET `sbi:dealer_token:{entityId}:{userId}` with EX 28800 (8 hours).  
  `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:5-6,402-443`

### redaction

- **!** Redaction is KEY-NAME-ONLY and is done by lib/log via _.cloneDeepWith. A key whose name matches the blacklist has its entire value replaced by the literal string 'REDACTED'. Effective blacklist for SBI = lib/log defaults [/api[_-]?(key|secret)/i, /^(userName|email|phone|pan|accessToken)$/, /^ipAddress$/i, /^brokerParams$/, /^cookie$/i, /^addFundsUrl$/] PLUS config.keyBlacklist [/^A(PP|pp)Key$/, /^ipAddress$/]. Additionally any string containing process.env.SBI_APP_KEY is rewritten to '[REDACTED]'.  
  `sc-integrations-broker-lib/src/lib/log.js:3-46 and src/brokers/sbi/config.js:166-171`
- **!** WHAT YOU WILL NOT FIND IN AN SBI LOG (redacted to 'REDACTED'): any key literally named accessToken, userName, email, phone, pan, ipAddress, brokerParams, cookie, addFundsUrl, APPKey/AppKey, or any key matching /api[_-]?(key|secret)/i.  
  `sc-integrations-broker-lib/src/lib/log.js:4-11 + src/brokers/sbi/config.js:166-170; empirically verified by running logInfo with those keys`
- **!** WHAT YOU *WILL* FIND IN FULL IN AN SBI LOG (empirically verified by executing lib/log with the SBI config): request.headers.Authorization = 'Bearer <raw SBI session token>'; request.headers['X-IP-ADDRESS'] = the real client IP (the key is X-IP-ADDRESS, NOT ipAddress, so the /^ipAddress$/i rule never fires on it); tradingAccountDetails.tradingAccountNumber (the SBI client code); depositoryAccountNumber / depositoryCode; clientId; and — on the getDealerDetails call — dealerDetails.entityIdentity.loginTypeValue, which is the dealer's PLAINTEXT PASSWORD. Do not copy these out of a log.  
  `sc-integrations-broker-lib/src/lib/log.js:20-46 (no Authorization/tradingAccountNumber/loginTypeValue rule) vs src/brokers/sbi/services/request.js:59-67,148-159 and src/brokers/sbi/services/user.js:405-413`
- Latent hazard: redactSensitiveValue does value.replace(process.env.SBI_APP_KEY, '[REDACTED]'). If SBI_APP_KEY is unset in an environment, the argument is undefined and String.replace coerces it to the literal 'undefined', so any logged string containing the substring 'undefined' would be rewritten to '[REDACTED]'. Whether SBI_APP_KEY is set in prod was not verifiable from this checkout. `[INFERRED]`  
  `sc-integrations-broker-lib/src/lib/log.js:31-36 and src/brokers/sbi/config.js:171`

### request-headers

- **!** Every SBI request carries these headers: 'X-SOURCE-ID':'5', Authorization:`Bearer ${accessToken}`, 'X-IP-ADDRESS':<client ip or 127.0.0.1>, 'X-REQ-UID':<fresh uuidv4 per request>, 'X-API-VERSION':'1.0.0', 'X-APPLICATON-ID':'MSILAPP1' (note the MISSPELLING — APPLICATON, not APPLICATION), Accept:'application/json'. X-REQ-UID is the per-call correlation id you can use to pair a request log with its response log.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:53-70`
- **!** The Authorization header is DELETED for every service NOT in AUTH_REQUIRED_SERVICES = ['placeOrder','cancelOrder','securityHold','getDealerDetails','placeDealerOrder']. So order-status (getOrderDetails), viewLimits, getUserProfile, getRejectionReason, placeSipOrder, triggerMail and triggerWhatsapp are sent WITH NO Authorization header — which is how 'sessionless polling' works for SBI.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:112,136-138`
- **!** placeDealerOrder additionally sets X-AUTHORIZATION:`Bearer ${token}`, X-DEVICE-ID:<uuid>, X-GEO-LOCATION:'INDIA', X-LANGUAGE-ID:'ENG', X-USER-AGENT:'Chrome browser; android OS'. getDealerDetails DELETES Authorization and X-SOURCE-ID and instead sets X-AUTHORIZATION:`Basic ${apiKey}` plus the same four extra headers. Presence of 'X-GEO-LOCATION' in a log line marks a dealer-path call.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:118-134`

### timeouts

- **!** Default SBI request timeout is config.brokerApiRequestTimeout = 9000 ms. BUT placeOrder, getDealerDetails and placeDealerOrder have their timeout FORCED TO 0 (axios: no timeout, wait forever). So a hung place-order call will never surface as ECONNABORTED — it will just hang. An explicit options.apiTimeout (used by comms) overrides the default but is then overwritten by the 0 for those three services.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:106,114-116 and src/brokers/sbi/config.js:172`

### tls

- Every SBI call uses an https.Agent built with `ca: config.caCert` (SBI_PRIVATE_CERT base64-decoded) and `rejectUnauthorized: false`. TLS validation is disabled, so a cert problem will never appear as an error in the logs.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:90-93 and src/brokers/sbi/config.js:14,50`

### response-validation

- **!** isResponseStructureValid(body) returns true only if the body has a top-level key 'responseCode' OR 'data'. A 200 response lacking both is treated as a FAILURE even though HTTP succeeded: the code builds an Error from messageList[0].messageDescription, or the literal 'Failed request' if messageList is empty, and returns {error, response: body-or-{}}.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:26-28,164-191`
- **!** Special case in the catch block: any HTTP error on a URL containing 'place-order' returns {response: error.response.data} with NO error field. So a 4xx/5xx on place-order is deliberately downgraded to a non-error and flows into _mapPlaceOrderResponse, where the missing `result` yields the messageList-derived statusMessage. This is why a failed SBI placement shows as a statusMessage rather than a thrown error.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:240-245`
- **!** Second special case: an HTTP error on a URL containing 'rejection-reason' whose body has responseCode===1 and a non-empty messageList is REINTERPRETED AS SUCCESS, returning {response:{reason: messageList[0].messageDescription}}, and is logged with msg 'Successful rejection reason request'. That literal 'Successful' line therefore marks an HTTP-level failure, not a success.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:201-219`

### rejection-reason

- **!** When order-status maps an order to REJECTED, getOrderDetails immediately calls getOrderRejectionReason (POST /order-rejection/rejection-reason) with body {orderDetails:{exchangeIdentity:{exchangeId:'NSE', exchangeIdType:2}, instrumentSegment:1, internalOrderNumber: options.orderId, orderSerialNumber:0}, tradingAccountDetails:{tradingAccountNumber:userId}} and writes the returned `reason` into scOrder.statusMessage. NOTE it uses options.orderId (the CALLER-supplied id), not the internalOrderNumber just parsed from the status response.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:401-409,419-460`

### error-classification

- **!** config.getErrorCode(order) tests order.statusMessage against the statusMessageMap regexes in KEY INSERTION ORDER and returns the FIRST matching key, else the literal 'otherError'. Insertion order is: checkHoldings, marginExceeded, userNotLoggedIn, clientNotEnabled, tradingSystemNotReady, securityNotAllowed. A missing/undefined statusMessage returns 'otherError' (runtime-verified).  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:114-119,176-184`
- **!** checkHoldings regex: /(Quantity shortfall:\s*\d+\s*\.\s*Please hold the stocks through the SBI Securities App by navigating to Portfolio > Demat Balance, then retry smallcase orders again\.|Quantity shortfall:\s*\d+)/i — the second alternative means the bare 'Quantity shortfall: N' that _mapPlaceOrderResponse synthesizes for shortfallFlag 'Q' classifies as checkHoldings.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:177`
- **!** marginExceeded regex: /(Funds shortfall:\s*\d+(?:\.\d+)?|Order Rejected: Funds violation by \d+(?:\.\d+)?)/i — so the synthesized 'Funds shortfall: N' from shortfallFlag 'F' classifies as marginExceeded. Runtime-verified: getErrorCode({statusMessage:'Funds shortfall: 500'}) === 'marginExceeded'.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:178`
- **!** userNotLoggedIn regex: /(You are already logged in from another device\.?\s*Please re-login to Place order from current device|Entity .* Is Already Logged In Through OWS Operator\.)/i — the second alternative is the DEALER-terminal concurrency message (OWS Operator).  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:179`
- **!** clientNotEnabled regex: /(EQU:\s*.*\s*is deactivated on all Exchanges in CASH product|EQU:\s*\d+\s+is\s+(?:deactivated|suspended)\s+on all Exchanges in all products)/i. tradingSystemNotReady regex: /(IOC Orders are not allowed in PreOpen Session|Closing Price is not available)/i. securityNotAllowed regex: /(Square-off your today's position \(Cash or E-Margin\) in the same scrip, before placing this order\.|SECURITY .* is Suspended by MATRIX Internally|Cash buy orders are not allowed on the security|Currently orders are not allowed on .*?, Please try later\.)/i  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:180-182`
- **!** There is a COMMENTED-OUT otherError regex in source: /(Order Rejected|Order failed|Unknown API error|Unknown error|Market is not open for trade)/i. Because it is commented out, those five messages all land in the 'otherError' fallback rather than matching a named key. Runtime-verified: getErrorCode({statusMessage:'Unknown API error'}) === 'otherError'.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:183`
- getErrorCode consumers (outside this repo) that stamp the result onto an order: order-updates services/orders.js:3493,3497 and services/autosip-service.js:432 and services/errors.js:425,463; jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:171. config.getStatusMessageMap() also exposes the raw map for bulk backfills (jobs/scripts/adhoc/orders/fixHistoricalErrorCodes.js:431,481).  
  `sc-integrations-order-updates/services/orders.js:3493,3497; sc-integrations-order-updates/services/errors.js:425,463; sc-integrations-jobs/jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:171; sc-integrations-broker-lib/src/brokers/sbi/config.js:120-122`

### cancel-order

- **!** cancelOrder sends DELETE /order-service/cancel-order. It hardcodes orderSlot: OFF_MARKET (2), orderSerialNumber: 1 (not 0 as in place), triggerPrice: 0, optionType: -1, strikePrice: '0.00', symbol: ''. product is CASH (1). orderValidity comes from _resolveOrderValidity(options). orderId is coerced via Number() and a NaN returns {error:'Invalid orderId'} — a BARE STRING, not an Error instance, so error.message is undefined downstream.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:462-530`
- **!** On a successful cancel, the adapter SYNTHESIZES {status:'CANCELLED AMO', orderId, tag: options.orderKey, filledQuantity:0, orderKey: options.orderKey, orderTimestamp:new Date()}. The literal string 'CANCELLED AMO' is emitted for EVERY successful cancel regardless of variety — it is NOT constants.scStatus.CANCELLED and does NOT prove the order was AMO. filledQuantity is hardcoded 0 even if the order was partially filled before cancellation.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:550-559`

### funds-check

- **!** fund.check is a TWO-STEP call: (1) GET /rmslimit-service/trading-accounts/{userId}/account-settlement-types/{settlementType}/limit/fund (viewLimits), then (2) PUT /bank-service/fund-hold-management (fundsCheck) with body {amountDetails:{amount: fundsToBeHeld, currencyCode:'INR'}, tradingAccountDetails:{accountSettlementType, tradingAccountNumber}}. Success is response.responseCode == 0 (loose equality).  
  `sc-integrations-broker-lib/src/brokers/sbi/services/fund.js:104-157,303-312 and config.js:33-34`
- **!** fundsToBeHeld formula: brokerObligations = max(totalAvailableLimit - availableLimitCashAndCarry, 0); then if requiredFunds > availableLimitCashAndCarry -> fundsToBeHeld = requiredFunds + brokerObligations, else fundsToBeHeld = requiredFunds. Both limit figures come from viewLimitsResponse.result.totalAvailableLimitDetails.{totalAvailableLimit, availableLimitCashAndCarry}.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/fund.js:41-50,124-131`
- **!** messageCode 709152 (ERR_POSITIVE_AMT) on the funds-hold response is DELIBERATELY treated as SUCCESS — it is SBI rejecting a zero-rupee hold. Returns {code:true, sufficientFunds:true}. Checked twice: on the primary call and on the rebalance minRequiredFunds retry.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/fund.js:7,159-178,239-258`
- **!** A viewLimits failure does NOT abort the flow — handleViewLimitsError returns {code:true, sufficientFunds:false, error:'Failed to fetch user limits'} and logs 'View Limits API failed' at error level. The fundsCheck PUT is then never issued.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/fund.js:21-32,119-121`
- **!** A dealer account short-circuits fund.check entirely: if the decoded token has a dealerId, it returns {sufficientFunds:true, requiredFunds:0} with NO broker call at all. Same shape as the dealer short-circuit in place().  
  `sc-integrations-broker-lib/src/brokers/sbi/services/fund.js:57-67`
- options.fundsHoldNotRequired short-circuits AFTER computing requiredFunds but BEFORE any broker call, returning sufficientFunds: null (not true/false). A null sufficientFunds in a log means the funds hold was intentionally skipped.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/fund.js:90-102`

### funds-buffers

- config.bufferConfig selects a buffer by [orderMode][variety], orderMode defaulting to 'market'. market.regular {buy:1.030348, sell:-0.97, minBrokerage:5}; market.amo {buy:1.05, sell:0.03, minBrokerage:5}; limit.regular and limit.amo both {buy:1.02, sell:-1, minBrokerage:5}. The odd 1.030348 is deliberate: source comment says platform already adds 0.5%, so this adds 3.048% for a 3.55% total.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:123-136 used at src/brokers/sbi/services/fund.js:71-73`
- **!** Two-step rebalance override: if options.label==='REBALANCE' AND options.twoStepRebalance===true, getAllowedSellValues returns {T0:1} (full sell proceeds usable) and getFundsBuffer overrides sell to -1. Otherwise config.allowedSellValues {T0:0, T1:1} applies, i.e. a normal same-day SELL contributes NOTHING toward buy funds.  
  `sc-integrations-broker-lib/src/lib/utils.js:7-9,96-107 and src/brokers/sbi/config.js:158-162`
- Other SBI money constants: dpCharges 25 (plus GST, applied as *1.18 in the minRequiredFunds path), addBufferAmount 118, nextDayBufferWithClosePrice 0.02 (2% of buy amount), amoFundsBuffer 3 (percent, marked with a todo: check if this is correct), fundsBuffer 0, maxSharesInSip from process.env.SBI_MAX_SHARES_SIP.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:58,75,154,163-165 and services/fund.js:192-193`

### config-flags

- **!** SBI cash feature flags in full: getFundsAllowed false, fundsHoldRequired true, securitiesHoldRequired TRUE, pricesAvailable false, orderStatusBy {postback:false, polling:true}, concurrentOrdersNotAllowed true, sanitizeTradingSymbol false, userLevelOrderLock false, holdingsCheckRequired false, logoutRequired false, positionsProvided false, liveHoldingsProvided false, liveHoldingsCheckRequired false, orderIdNotSufficientForPolling TRUE, orderKeyNotSufficientForCancellation TRUE, amoAllowed true, onlyLimitAmoAllowed TRUE, sessionlessPollingAvailable ()=>true, autoSipAllowed true, twoStepRebalanceEnabled true, rebalanceSipAllowed true, authorizationRequiredForSell false, emailSendingApiProvided true, whatsappSendingApiProvided true, userEmailProvided false, usesVersionedEmailTemplates true, smsSendingApiProvided false, userPhoneProvided false, pushNotificationApiProvided false, autoSipManagedByBroker false.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:54-91`
- **!** postback is FALSE and polling is TRUE — SBI never pushes an order update to smallcase. Every status change is discovered by a getOrderDetails poll. There is no webhook path in this adapter.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:59-62`
- **!** orderIdNotSufficientForPolling:true and orderKeyNotSufficientForCancellation:true cause order-updates to fetch the FULL cached order object from Redis before polling or cancelling, rather than passing just the id — that is why the poll/cancel payloads carry brokersymbol, quantity, price and variety.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:71-72 consumed at sc-integrations-order-updates/services/orders.js:530,1703,3665`
- twoStepRebalanceEnabled:true is read by order-updates/services/twoStepRebalanceService.js:151 to gate the two-step rebalance path for SBI.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:79 consumed at sc-integrations-order-updates/services/twoStepRebalanceService.js:151`
- config.getSecurityIdentifier(exchange) returns `sbi.${exchange}` — e.g. 'sbi.NSE'. This is the Redis/symbol-store key namespace used to resolve brokersymbol. On the stale origin/production branch it returned `ticker.${exchange}` instead.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:98-100`

### endpoints

- **!** Complete SBI cash endpoint table (all prefixed with process.env.SBI_API_ENDPOINT except the two dealer ones, which use process.env.SBI_DEALER_LOGIN_API_ENDPOINT): placeOrder POST /order-service/place-order; placeSipOrder POST /sipbasket-service/smallcase-sip-place-order; fundsCheck PUT /bank-service/fund-hold-management; viewLimits GET /rmslimit-service/trading-accounts/{accountId}/account-settlement-types/{settlementType}/limit/fund; getPositions POST /books-service/tradeBook; getUserProfile GET /authentication-service/trading-accounts/{accountId}/user-details; getOrderDetails POST /books-service/order-status; getRejectionReason POST /order-rejection/rejection-reason; cancelOrder DELETE /order-service/cancel-order; securityHold POST /dp-service/hold-release/dp; getDealerDetails POST /dealer-authentication-service/dealer-details; placeDealerOrder POST /dealer-authentication-service/place-order; triggerMail POST /api/SendMailToUser; triggerWhatsapp POST /api/v1/WhatsappCM/Postwhatsappdetails.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:29-47`
- **!** SBI cash and SBI-MTF share an IDENTICAL endpoint path table (same 14 paths, same methods); MTF adds one extra: getEmarginDetails POST /position-service/emargin-details. They differ only in base-URL env var (SBI_API_ENDPOINT vs SBI_MTF_API_ENDPOINT). Both dealer endpoints read the SAME env var SBI_DEALER_LOGIN_API_ENDPOINT.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:29-47 vs src/brokers/sbi-mtf/config.js:31-48; both read SBI_DEALER_LOGIN_API_ENDPOINT at sbi/config.js:5 and sbi-mtf/config.js:16`

### env-vars

- **!** Env vars this adapter reads: SBI_API_ENDPOINT, LEPRECHAUN_API_ENDPOINT (fallback http://localhost:7777/sbi), SBI_DEALER_LOGIN_API_ENDPOINT (defaults to '' — if unset, dealer URLs become bare paths like '/dealer-authentication-service/dealer-details' and the request will fail), SBI_APP_KEY, SBI_SECRET_KEY, SBI_PRIVATE_CERT (base64 CA cert), SBI_DECRYPT_PASSWORD, SBI_DECRYPT_SALT, SBI_MAX_SHARES_SIP.  
  `sc-integrations-broker-lib/src/brokers/sbi/config.js:1-14,50-52,154`

### login

- **!** Real-SBI login requires options.brokerParams (a JSON string). It decrypts, via AES-256-GCM, these fields: dealer_emp -> dealerId, EM_ENTITY_ID -> userId AND secondaryField, EM_NAME -> userName, client_id -> clientId (dealer path), EBD_RES_STATUS -> the NRI eligibility string. options.requestToken decrypts to the raw SBI access token. Missing brokerParams -> Error('Missing brokerParams'); neither dealerId nor requestToken -> Error('Missing requestToken').  
  `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:47-74`
- **!** parseEBDResStatus handles SBI sometimes wrapping the value in brackets ('[2,3]' vs '2,3'): it strips leading '[' and trailing ']', splits on ',', trims. Eligible NRI types are the literals '2' and '3'. isNriUser = list is non-empty AND does not contain '0'. nriFlag baked into the token = the single eligible type when exactly one, else '0'. When isNriUser but zero eligible types, it sets decryptedParams.meta.nriNotSupported = true. Two or more eligible types sets decryptedParams.nriFlag = 'NRE_NRO'.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:12-37,79-118`
- **!** Settlement-type code meanings: '0' = resident Indian (also the placeholder for dual-eligible), '2' = NRO, '3' = NRE. The string form exposed to the platform is parseNRIFlag's {nriFlag:'NRE'} for '3' and {nriFlag:'NRO'} for '2', or the literal 'NRE_NRO' for dual.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:22-37,99,116 and services/util.js:8-11`
- **!** NON-dealer login makes a MANDATORY getUserProfile call (GET /authentication-service/trading-accounts/{userId}/user-details) and reads result.depositoryList.depositoryDetails[0].{depositoryAccountNumber, depositoryCode} into the encoded access token. If that call errors, or the depositoryDetails path is missing, login FAILS with the userProfileErr or Error('invalid user profile response'); an empty first element fails with Error('invalid depository details'). Dealer login SKIPS getUserProfile entirely and leaves dpAccountNumber/dpCode empty.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:120-149 (retail) vs :76-102 (dealer)`
- **!** For DEALER login the encoded access token has an EMPTY first field: encodeAccessToken('', clientId, dealerId, nriFlag) — i.e. '|<clientId>|<dealerId>|<nriFlag>||'. A token starting with '|' means a dealer session. The real SBI token for a dealer lives only in Redis, not in the smallcase access token.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:89 and services/util.js:13`
- **!** checkSession() is a NO-OP for SBI — it takes no arguments, calls nothing, and unconditionally returns {code:true, sufficientFunds:true, requiredFunds:0}. A 'session valid' result for SBI proves nothing about the actual SBI session.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:366-376`

### crypto

- Both encrypt and decrypt derive key+IV with pbkdf2Sync(SBI_DECRYPT_PASSWORD, SBI_DECRYPT_SALT, 1000 iterations, 48 bytes, 'sha1'), taking the first 32 bytes as the AES-256-GCM key and the next 16 as a FIXED IV. Ciphertext is base64 with the 16-byte auth tag appended at the end. decryptGCM returns '' for falsy input and rethrows a new Error(error.message) on failure (stack is lost). encryptGCM swallows failures, console.errors 'Encryption failed:' and returns ''.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/decrypt.js:3-58 and services/encrypt.js:3-57`

### security-hold

- **!** securitiesHoldRequired is TRUE for SBI cash (it is FALSE for SBI-MTF). holdSecurities POSTs /dp-service/hold-release/dp with {tradingAccountDetails:{tradingAccountNumber}, tradingMarketDetails:{tradingMarket:1}, depositoryHoldReleaseList:{depositoryDetails:{depositoryAccountNumber, depositoryCode, accountSettlementType}, instrumentIdentity:{instrumentIdType:42, instrumentId}, transactionType:1 (ADHOC_HOLD), quantity}}. dpAccountNumber/dpCode come from the access token.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/security.js:10-56 and config.js:56 vs sbi-mtf/config.js:60`
- **!** A security-hold response with result.transactionDetails.transactionFailureReason === 'Insufficient Balance.' (exact string, trailing period included) is DELIBERATELY treated as success and returns the literal string 'passing "insufficient balance" error as success'. A dealer token short-circuits to 'dealer order stock hold successful' with no broker call. Normal success returns 'stock hold successful'.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/security.js:15-19,58-77`
- **!** api.Security.hold ALWAYS calls back with a null error — on failure it does `callback(null, failureHandler(error))`, so a security-hold failure never surfaces as an error to the caller, only as code:false in the response object.  
  `sc-integrations-broker-lib/src/brokers/sbi/api.js:225-237`

### autosip

- **!** place() diverts to autosipService when options.label === 'AUTOSIP' OR options.activated is truthy OR options.autoSip is truthy — note `activated` alone is enough, so an activated (two-step) order takes the SIP endpoint, not the normal place-order endpoint.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:273-280 and constants.js:16-19`
- **!** autosip.placeOrder POSTs /sipbasket-service/smallcase-sip-place-order with a completely different body: {tradingAccountDetails:{accountSettlementType: nriFlag||0, tradingAccountNumber: options.brokeruserId}, smallcaseSipDetails:{sipDetails:{buySell:1, facilitatorCode:0, internalOrderNumber:0, externalReferenceNumber:<tag>, permanentAccountNumber:''}, instrumentDetailsList:{exchangeIdentity:{exchangeIdType:2, exchangeId:'NSE'}, instrumentIdentity:{instrumentIdType:42, instrumentId}, amountOrQuantityDetails:{sipOrderPrice:0, sipOrderQuantity}, orderSerialNumber:-1, action:1, productId:1}}}. buySell is HARDCODED to BUY (1) — SIP orders can never be sells. It uses options.brokeruserId, NOT the userId from the access token. No Authorization header is sent (placeSipOrder is not in AUTH_REQUIRED_SERVICES).  
  `sc-integrations-broker-lib/src/brokers/sbi/services/autosip.js:5-43 and services/request.js:112`
- **!** AutoSIP success is keyed on response.result.internalOrderNumber being truthy -> {code:true, status:'PLACED', orderId}. Anything else -> {code:false, statusMessage:'Unknown error'} with NO status field.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/autosip.js:51-67`
- **!** api.Sip.delete is a pure no-op for SBI: it logs 'Successful request' and calls back with successHandler({}) without touching the broker. A 'deleted' SBI SIP was never deleted at SBI.  
  `sc-integrations-broker-lib/src/brokers/sbi/api.js:257-261`

### amo-window

- **!** miscService.amoActiveHours computes the AMO place/cancel window from the CURRENT time, and place and cancel windows are always IDENTICAL. Three branches (all constructed from local-time Date parts, with IST offsets baked in as UTC hours): if now < 09:00 IST -> [yesterday 19:00 IST, today 08:59 IST]; else if now < 09:15 IST -> [today 09:07 IST, today 09:14 IST] (a 7-minute window); else -> [today 19:00 IST, tomorrow 08:59 IST].  
  `sc-integrations-broker-lib/src/brokers/sbi/services/misc.js:44-88`
- **!** amoActiveHours builds its timestamps with `new Date(year, month, day, 3, 30, 0)` — the LOCAL-time constructor with hours chosen as UTC equivalents of IST. This is only correct when the process TZ is UTC. broker-lib's own test script runs with TZ=utc. If a service runs in any other timezone the AMO window silently shifts. `[INFERRED]`  
  `sc-integrations-broker-lib/src/brokers/sbi/services/misc.js:57-64 and package.json:8 ("test:unit": "TZ=utc mocha ...")`

### funds-get

- api.Funds.get is NOT IMPLEMENTED for SBI — it immediately calls back with failureHandler({statusCode: 501}). getFundsAllowed is false. Any attempt to read SBI balances through this adapter returns a 501.  
  `sc-integrations-broker-lib/src/brokers/sbi/api.js:96-98 and config.js:54`

### comms

- Email template name -> SBI numeric code: marketOpenReminder '1', orderUpdates '3', playedOutUpdates '4', rebalanceUpdates '5', sipUpdates '6'. An unknown name yields '' (empty mailBody). Note there is NO code '2'. brokeruserId is encrypted with encryptGCM before being sent as `clientId`.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/comms.js:21-27,56,67-84`
- Both triggerMail and triggerWhatsapp treat success as `response.statuscode === '200'` — a STRING comparison against SBI's lowercase `statuscode` field, and they read the reply text from `response.messgae` (SBI's actual misspelling of 'message', flagged in a source comment). The WhatsApp body field is `inputvaribale` — also SBI's real misspelling, documented in a source comment.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/comms.js:85-87,112-114,127-129`

### logging-architecture

- **!** order.js and fund.js call the RAW logger directly (logger.info / logger.error) rather than lib/log's logInfo/logWarn. Those five lines therefore carry NO `broker` field and receive NO redaction. Every other SBI log line goes through lib/log and carries broker:'sbi' plus a `details` envelope.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:480,546 and services/fund.js:22,182,211 vs src/lib/log.js:48-85`
- **!** lib/log's record shape is {broker, msg, details} for info, and {broker, msg, details, err:{name,message,stack}} for warn/error. When the msg argument is falsy, warn/error fall back to err.message, so a warn line's msg can be an SBI error string rather than a fixed literal. handeUnIndexedKeys additionally copies details.user.id up to details.userId when present.  
  `sc-integrations-broker-lib/src/lib/log.js:24-29,48-85`
- **!** Order PLACEMENT emits no log line of its own anywhere in order.js — the only trace of a successful SBI placement is request.js's 'Successful request' / 'sending success response' pair. api.js only logs on FAILURE ('Error in placing order'). So the absence of an 'Error in placing order' line plus the presence of a place-order 'Successful request' line is what a successful placement looks like.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:256-309 (no log calls) and src/brokers/sbi/api.js:151-171, services/request.js:148-163`
- **!** request.js logs a `health` object on every outcome via buildHealthObject: {type: 'http' when a broker response exists else error.code/error.name/'NA', code: HTTP status or 0, method, url}. getHealthUrl normalises the URL by replacing the trading-accounts id with ':accountId' and the settlement type with ':settlementType' — so health.url is a TEMPLATE, not the real URL. The real URL is in details.request.url.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:6-18,155,205,225,237 and src/lib/health.js:1-10`
- **!** BUG: security.js calls logWarn(error, 'error holding stock', {payload}, logger) — arguments transposed against the (err, details, msg, logger) signature. The emitted record therefore has msg = {payload:...} (an object) and details = the string 'error holding stock'. Grep for the string 'error holding stock' will find it in the DETAILS field, not the msg field, and the logger argument is actually the msg slot so the call may throw or log nowhere depending on the logger.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/security.js:80 against src/lib/log.js:71-84`

### success-failure-envelope

- **!** api.js wraps every response: successHandler -> {code:true, reason:'success', ...data}; failureHandler -> {code:false, reason:'failure', ...data, statusCode:500 when data has no statusCode}. So an SBI failure with no HTTP status appears as statusCode 500 even when no 500 ever occurred.  
  `sc-integrations-broker-lib/src/brokers/sbi/api.js:299-313`

### leprechaun

- **!** The leprechaun (mock broker) path is selected INSIDE broker-lib by config('sbi-leprechaun'), not by a separate service. Its login emits five 'DEBUG: '-prefixed lines at INFO level — presence of any 'DEBUG: getLeprechaunAccessToken called' / 'DEBUG: detectDealerLogin result' / 'DEBUG: Entering dealer login branch' / 'DEBUG: Extracted userId from requestToken' / 'DEBUG: NOT entering dealer branch...' line proves you are looking at the MOCK path, not real SBI.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:253,262,273,277,304 and src/brokers/sbi/config.js:3,17`
- Leprechaun dealer detection differs from real SBI: it accepts a requestToken containing '_' (format 'userId_dealerId'), or brokerParams.dealer_emp / .dealerId / .dealer===true, or options.dealerAuthData. Real SBI only ever uses the encrypted brokerParams.dealer_emp. A source comment states the '_d suffix' shape was copied from HDFC/Axis/Kotak and is not an SBI convention.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:163-242`
- In the leprechaun cancelOrder path the orderId is a MongoDB ObjectId STRING and is deliberately NOT coerced to Number; the real-broker path does Number(options.orderId) and rejects NaN. The branch is chosen by config.brokerName === 'sbi-leprechaun'.  
  `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:465-484`


## Grep targets (98)

Search with `fetch-by-identifier.js --service <svc> --text "<string>"`.

| String | Means | Emitted by | Citation |
|---|---|---|---|
| `Successful request` | An SBI HTTP call returned and passed structure validation. Payload: details.request{url,method,headers,data}, details.response{statusCode,body}, details.health. THE single most useful SBI log line — it contains the full outbound body and the full inbound body. NOTE: api.js:259 emits the SAME literal for a no-op Sip.delete, so disambiguate by whether details.request exists. | requestBroker (every SBI service) — and separately Sip.delete _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:148-159; also src/brokers/sbi/api.js:259` |
| `sending success response` | Emitted immediately after 'Successful request'. details.responseBody is the RAW SBI body, details.type is typeof it. This is where to read result.shortfallDetails.shortfallFlag when the mapped statusMessage says only 'Unknown error'. | requestBroker _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:160-163` |
| `Error in request` | Axios threw AND error.response.data exists. details.request, details.response = error.response.data, details.health. For place-order URLs this is followed by a NON-error return, so an order can still be 'placed' after this line. | requestBroker catch block _(lvl warn)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:234-238` |
| `Error in request - ${error.message}` | Axios threw with NO error.response / no response body — i.e. a network-level failure (ECONNREFUSED, ETIMEDOUT, socket hang up, DNS). Template literal: grep the prefix 'Error in request - '. This is the ONLY SBI log line that distinguishes a network failure from a broker rejection. | requestBroker catch block _(lvl warn)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:221-229` |
| `Successful rejection reason request` | MISLEADING NAME: an HTTP-level ERROR on /order-rejection/rejection-reason that had responseCode===1 and a non-empty messageList, deliberately reinterpreted as a valid rejection lookup. | requestBroker catch block, rejection-reason special case _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:202-206` |
| `Error in placing order` | orderService.place returned an error. details.options = the full place options (tag, brokersymbol, quantity, price, variety, transactionType), details.response = mapped response. Absence of this line + presence of a place-order 'Successful request' = successful placement. | api.js Orders.place _(lvl warn)_ | `sc-integrations-broker-lib/src/brokers/sbi/api.js:157-162` |
| `Error in order status` | orderService.getOrderDetails returned an error — includes the thrown 'Invalid response from broker' case. | api.js Orders.status _(lvl warn)_ | `sc-integrations-broker-lib/src/brokers/sbi/api.js:188-193` |
| `Failed to delete order` | orderService.cancelOrder returned an error (including the bare-string 'Invalid orderId'). | api.js Orders.delete _(lvl warn)_ | `sc-integrations-broker-lib/src/brokers/sbi/api.js:207` |
| `Error in funds check` | fundService.check returned an error. Rare: check() almost always returns a response rather than an error, so this line usually means an exception, not insufficient funds. | api.js Funds.check _(lvl warn)_ | `sc-integrations-broker-lib/src/brokers/sbi/api.js:117-122` |
| `Failed to hold securities` | securityService.holdSecurities returned an error. Note the caller still calls back with null error, so the order flow continues. | api.js Security.hold _(lvl warn)_ | `sc-integrations-broker-lib/src/brokers/sbi/api.js:228-233` |
| `Error in placing sip order` | autosipService.placeOrder returned an error (AUTOSIP / activated / autoSip path). | api.js Sip.placeOrder _(lvl warn)_ | `sc-integrations-broker-lib/src/brokers/sbi/api.js:247-252` |
| `Error in fetching access token` | userService.getAccessToken failed — decrypt failure, missing brokerParams/requestToken, or a failed getUserProfile. | api.js User.accessToken _(lvl warn)_ | `sc-integrations-broker-lib/src/brokers/sbi/api.js:36-41` |
| `Broker login successful` | SBI login completed. details.response carries userId/secondaryField in plain text; accessToken and userName are REDACTED; details.options.brokerParams is REDACTED. | api.js User.accessToken _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/api.js:44` |
| `Error in check session` | Effectively unreachable for SBI — checkSession() is a no-op that always returns success. | api.js User.checkSession _(lvl warn)_ | `sc-integrations-broker-lib/src/brokers/sbi/api.js:60-65` |
| `Error in dealer authentication` | authenticateDealer failed — bad credentials, unreachable SBI_DEALER_LOGIN_API_ENDPOINT, or a malformed dealerDetailsResult. | api.js User.authenticateDealer _(lvl warn)_ | `sc-integrations-broker-lib/src/brokers/sbi/api.js:76-81` |
| `Decrypted user params` | Real-SBI login decrypt succeeded. details.decryptedParams shows userId, secondaryField, dealer, dealerId, nriFlag, meta.nriNotSupported in plain text; userName and accessToken are REDACTED. | userService.getAccessToken _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:151-153` |
| `Error in decrypting user params` | AES-256-GCM decrypt threw — wrong SBI_DECRYPT_PASSWORD/SBI_DECRYPT_SALT, or a corrupt/truncated encrypted param. details is EMPTY ({}), so the offending field name is not logged. | userService.getAccessToken catch _(lvl warn)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:157` |
| `User profile response` | Full raw body of GET /authentication-service/trading-accounts/{id}/user-details, including depositoryList.depositoryDetails with depositoryAccountNumber and depositoryCode in plain text. | userService.getUserProfile _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:395-397` |
| `Failed to parse brokerParams` | brokerParams was not valid JSON during leprechaun dealer detection. details.brokerParams is REDACTED so you cannot see the bad value. | detectDealerLogin _(lvl warn)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:223` |
| `Dealer login detected via _d suffix pattern` | LEPRECHAUN/MOCK ONLY. requestToken contained '_' and was split into userId_dealerId. | detectDealerLogin _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:193` |
| `DEBUG: getLeprechaunAccessToken called` | Proof the trace is on the MOCK broker path, not real SBI. Logged at INFO level despite the DEBUG prefix. | getLeprechaunAccessToken _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:253` |
| `DEBUG: Extracted userId from requestToken` | Leprechaun login — userId parsed from requestToken (before any '_'). | getLeprechaunAccessToken _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:262` |
| `DEBUG: detectDealerLogin result` | Leprechaun login — shows dealerId, dealerUserId, isDealerLogin, requestToken, userId. | getLeprechaunAccessToken _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:273` |
| `DEBUG: Entering dealer login branch` | Leprechaun login took the dealer branch and will SKIP getUserProfile. | getLeprechaunAccessToken _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:277` |
| `DEBUG: NOT entering dealer branch, proceeding with regular user login` | Leprechaun login took the retail branch and WILL call getUserProfile. | getLeprechaunAccessToken _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:304` |
| `Leprechaun dealer login successful` | Mock dealer login completed; details.responseParams.accessToken is REDACTED. | getLeprechaunAccessToken _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:300` |
| `Leprechaun login successful` | Mock retail login completed. | getLeprechaunAccessToken _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:357` |
| `Error fetching leprechaun user profile` | Mock getUserProfile failed. | getLeprechaunAccessToken _(lvl warn)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:315` |
| `Error in leprechaun login` | Unhandled throw inside the mock login flow. | getLeprechaunAccessToken catch _(lvl warn)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:361` |
| `View Limits API failed` | GET viewLimits errored during funds check. RAW logger call — NO broker field, NO redaction, and the shape is logger.error(msg, {error, userId}) i.e. the message is the FIRST arg, unlike every lib/log line. Funds check then returns sufficientFunds:false with error 'Failed to fetch user limits' and never issues the fund-hold PUT. | fund.js handleViewLimitsError _(lvl error)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/fund.js:22` |
| `Funds Check For Minimum Required Funds` | The primary fund-hold failed AND options.rebalanceBasketFlag is true, so a second hold is being attempted with the lower minRequiredFunds figure. RAW logger call, no broker field. Payload {userId, fundsRequired}. | fund.js check, rebalance retry _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/fund.js:182` |
| `Request Params: Funds Check with Minimum Required Funds` | Shows {userId, minRequiredFunds, fundsToBeHeld} just before the second fund-hold PUT. RAW logger call, no broker field. | fund.js check, rebalance retry _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/fund.js:211` |
| `Invalid orderId` | cancelOrder got a non-numeric orderId on the REAL (non-leprechaun) path. RAW logger.info call — NO broker field, NO redaction. Payload {orderId}. | order.js cancelOrder _(lvl info)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:480` |
| `Error in cancelling order` | The DELETE /order-service/cancel-order call failed. RAW logger.error({error}, msg) — note the bunyan-style (obj, msg) arg order here, unlike fund.js's (msg, obj). No broker field. | order.js cancelOrder _(lvl error)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:546` |
| `error holding stock` | TWO distinct uses: (a) as an Error message returned when securityHold got no response; (b) as a MISPLACED argument in the catch-block logWarn, where it lands in the log's `details` field instead of `msg` because the args are transposed. Grep both fields. | security.js holdSecurities _(lvl warn (transposed))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/security.js:71,80` |
| `Encryption failed:` | encryptGCM threw. Goes to console.error (STDOUT/STDERR), not the structured logger — it will NOT have a broker field or a msg key and may not be indexed like other logs. Followed by a bare stack trace line. | encrypt.js encryptGCM catch _(lvl console.error)_ | `sc-integrations-broker-lib/src/brokers/sbi/services/encrypt.js:48-49` |
| `Quantity shortfall: ${response.result.shortfallDetails.shortfallValue}` | SYNTHESIZED statusMessage for shortfallFlag 'Q'. Interpolates the numeric shortfall quantity. Classified by getErrorCode as 'checkHoldings'. Grep the literal prefix 'Quantity shortfall: '. | order.js _mapPlaceOrderResponse _(lvl n/a (response field, appears inside logged details))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:72-78` |
| `Funds shortfall: ${response.result.shortfallDetails.shortfallValue}` | SYNTHESIZED statusMessage for shortfallFlag 'F'. Interpolates the rupee shortfall. Classified by getErrorCode as 'marginExceeded'. Grep the literal prefix 'Funds shortfall: '. | order.js _mapPlaceOrderResponse _(lvl n/a (response field))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:79-85` |
| `Unknown API error` | SBI returned 200 with no `result` object AND an empty/absent messageList. Falls through getErrorCode to 'otherError' on SBI cash (but classifies as 'unknownError' on SBI-MTF). | order.js _mapPlaceOrderResponse _(lvl n/a (statusMessage))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:59-61` |
| `Unknown error` | Two sources: (a) the shortfallFlag fall-through tail of _mapPlaceOrderResponse, meaning shortfallFlag was NOT N/Q/F and its real value is only in the 'sending success response' log; (b) the place() catch-all, paired with orderStatus 'ERROR'; (c) autosip when result.internalOrderNumber is missing. | order.js _mapPlaceOrderResponse / place catch; autosip.js placeOrder _(lvl n/a (statusMessage))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:89,306; services/autosip.js:64` |
| `order placement failed` | Error.message on the tail return of _mapPlaceOrderResponse — the shortfallFlag was not N/Q/F, or error was truthy, or response was falsy. | order.js _mapPlaceOrderResponse _(lvl n/a (err.message in the warn envelope))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:88` |
| `order placed by dealer` | CRITICAL FAKE SUCCESS. Appears with orderId 'NA' and status 'PLACED'. The order was NEVER sent to SBI — the token had a dealerId but options.dealerDetails was absent. | order.js place, dealer short-circuit _(lvl n/a (statusMessage))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:260-269` |
| `Dealer session not found or expired, please re-authenticate` | Redis key sbi:dealer_token:{entityId}:{dealerUserId} was missing or past its 8h TTL. The dealer order was never sent to SBI. | order.js placeDealerOrder _(lvl n/a (err.message))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:155-157` |
| `CANCELLED AMO` | Literal synthesized status on EVERY successful SBI cancel, AMO or not. Not a member of constants.scStatus. Accompanied by a hardcoded filledQuantity: 0. | order.js cancelOrder success return _(lvl n/a (status field))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:550-559` |
| `Invalid response from broker` | Thrown (and caught into {error}) when the order-status response has no result, no result.orderStatusList, or an empty list. Distinct from 'Order not found'. | order.js getOrderDetails _(lvl n/a (err.message))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:384-386` |
| `Order not found` | The order-status list came back non-empty but contained NO entry whose orderLegDetails.externalReferenceNumber equals the tag. Returned as {status:'ERROR', statusMessage:'Order not found'}. | order.js getOrderDetails _(lvl n/a (statusMessage))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:390-397` |
| `Invalid orderId` | Also returned as a BARE STRING error value (not an Error instance) from cancelOrder — so err.message is undefined wherever this propagates. | order.js cancelOrder _(lvl n/a (error value))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:481` |
| `Failed request` | SBI returned a 200/201 whose body had neither 'responseCode' nor 'data', AND no messageList to build a message from. Generic structural-validation failure. | requestBroker _(lvl n/a (err.message, surfaces in the 'Error in ...' warn lines))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:182` |
| `Generic error` | An HTTP error whose body failed isResponseStructureValid or had no messageList. Means 'SBI returned something we could not parse at all'. | requestBroker catch block _(lvl n/a (err.message))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:256` |
| `Failed to fetch user limits` | Set as response.error when the viewLimits GET errored. Pairs with the 'View Limits API failed' log line. | fund.js handleViewLimitsError _(lvl n/a (response field))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/fund.js:29` |
| `stock hold successful` | securityHold POST returned a response and was not the insufficient-balance case. | security.js holdSecurities _(lvl n/a (response string))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/security.js:75-77` |
| `dealer order stock hold successful` | FAKE SUCCESS — the access token decoded a dealerId so the DP hold-release call was skipped entirely. | security.js holdSecurities _(lvl n/a (response string))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/security.js:15-19` |
| `passing "insufficient balance" error as success` | SBI's DP hold returned result.transactionDetails.transactionFailureReason === 'Insufficient Balance.' and smallcase deliberately treats it as a success. | security.js holdSecurities _(lvl n/a (response string))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/security.js:58-67` |
| `Insufficient Balance.` | Exact SBI-side string (trailing period included) in result.transactionDetails.transactionFailureReason on the DP hold-release response. The only value special-cased. | SBI /dp-service/hold-release/dp response, matched in security.js _(lvl n/a (broker response field))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/security.js:62` |
| `Missing brokerParams` | Real-SBI login called without options.brokerParams. | user.js getAccessToken _(lvl n/a (err.message))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:49` |
| `Missing requestToken` | Neither a decrypted dealer_emp nor a requestToken was present on a real-SBI login. | user.js getAccessToken _(lvl n/a (err.message))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:64` |
| `invalid depository details` | depositoryList.depositoryDetails existed but its [0] element was falsy — login aborts, no access token is minted. | user.js getAccessToken _(lvl n/a (err.message))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:133` |
| `invalid user profile response` | getUserProfile succeeded but the result.depositoryList.depositoryDetails path was absent — login aborts. A very common cause of 'user cannot log into SBI on smallcase'. | user.js getAccessToken _(lvl n/a (err.message))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:145` |
| `Invalid dealer details response` | The dealer-details POST returned 200 but lacked dealerDetailsResult.entityDetails or .tokenDetails. No Redis token is written, so every subsequent dealer order will fail with 'Dealer session not found or expired'. | user.js authenticateDealer _(lvl n/a (err.message))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:427-429` |
| `Missing requestToken (userId for leprechaun)` | MOCK path only — leprechaun login with no requestToken. | user.js getLeprechaunAccessToken _(lvl n/a (err.message))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:256` |
| `Invalid requestToken format` | MOCK path only — requestToken split yielded an empty userId. | user.js getLeprechaunAccessToken _(lvl n/a (err.message))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:266` |
| `Invalid user profile response from leprechaun` | MOCK path only — leprechaun user-details returned no result object. | user.js getLeprechaunAccessToken _(lvl n/a (err.message))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:320` |
| `brokerId missing` | triggerMail/triggerWhatsapp called without options.brokeruserId. Paired with the user-facing string 'Something went wrong'. | comms.js triggerMail / triggerWhatsapp _(lvl n/a (err.message))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/comms.js:70,104` |
| `Something went wrong` | Generic comms failure message returned to the caller — carries no diagnostic value; look at the paired requestBroker log for the real cause. | comms.js triggerMail / triggerWhatsapp _(lvl n/a (response field))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/comms.js:70,104,131` |
| `sbi:dealer_token:` | Redis key PREFIX for the cached dealer SBI token. Full key is `sbi:dealer_token:${entityId}:${userId}`. Written by authenticateDealer with EX 28800 (8h), read by placeDealerOrder. SBI-MTF uses a different prefix. | constants.js dealerTokenRedisKeyPrefix; user.js authenticateDealer (SET); order.js placeDealerOrder (GET) _(lvl n/a (Redis key))_ | `sc-integrations-broker-lib/src/brokers/sbi/constants.js:3; services/user.js:434-435; services/order.js:152-153` |
| `sc_` | SBI CASH order tag prefix. Full pattern /sc_[0-9a-zA-Z]{9}/ (12 chars total). Sent to SBI as BOTH externalReferenceNumber and remarks, and used as the order-status lookup filter. SBI-MTF uses 'scmtf_' instead — this prefix is the most reliable cash-vs-MTF discriminator in a raw log. | config.generateTag _(lvl n/a (identifier))_ | `sc-integrations-broker-lib/src/brokers/sbi/config.js:109-113; sbi-mtf/config.js:115-119` |
| `X-APPLICATON-ID` | Header name, MISSPELLED in source (APPLICATON, not APPLICATION). Value is always 'MSILAPP1'. Grepping for 'X-APPLICATION-ID' will find nothing. | request.js getHeaders _(lvl n/a (header key in details.request.headers))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:65` |
| `MSILAPP1` | Constant value of X-APPLICATON-ID on every SBI request. A cheap way to confirm a log line is an SBI broker call. | request.js getHeaders _(lvl n/a (header value))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:65` |
| `X-REQ-UID` | Per-request uuidv4 correlation id present on every SBI call. Use it to pair the 'Successful request' line with any SBI-side trace. A fresh value per request — it is NOT stable across a retry. | request.js getHeaders _(lvl n/a (header key))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:63` |
| `X-GEO-LOCATION` | Header set ONLY on the two dealer services (getDealerDetails, placeDealerOrder), value 'INDIA'. Its presence in details.request.headers proves the call is on the dealer path. Same for X-DEVICE-ID, X-LANGUAGE-ID ('ENG') and X-USER-AGENT ('Chrome browser; android OS'). | request.js dealer header block _(lvl n/a (header key))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/request.js:118-134` |
| `/order-service/place-order` | SBI cash AND MTF place-order path. Timeout is FORCED TO 0 (no timeout). HTTP errors on this URL are downgraded to non-errors. | config.endpoint placeOrder _(lvl n/a (details.request.url))_ | `sc-integrations-broker-lib/src/brokers/sbi/config.js:31; services/request.js:114-116,240-245` |
| `/books-service/order-status` | The polling endpoint. Queried by TAG (referenceNumberFilter), never by SBI order id. Sent with NO Authorization header. | config.endpoint getOrderDetails _(lvl n/a (details.request.url))_ | `sc-integrations-broker-lib/src/brokers/sbi/config.js:37; services/order.js:322-349; services/request.js:112,136-138` |
| `/order-rejection/rejection-reason` | Called only after order-status maps an order to REJECTED. An HTTP error here with responseCode===1 is reinterpreted as success. | config.endpoint getRejectionReason _(lvl n/a (details.request.url))_ | `sc-integrations-broker-lib/src/brokers/sbi/config.js:38; services/order.js:401-409,444-453` |
| `/order-service/cancel-order` | DELETE. Always sends orderSlot OFF_MARKET (2) and product CASH (1), orderSerialNumber 1. | config.endpoint cancelOrder _(lvl n/a (details.request.url))_ | `sc-integrations-broker-lib/src/brokers/sbi/config.js:39; services/order.js:486-530` |
| `/bank-service/fund-hold-management` | PUT. The funds-HOLD call. responseCode == 0 means the hold succeeded. messageCode 709152 in the response means zero-amount rejection, treated as success. | config.endpoint fundsCheck _(lvl n/a (details.request.url))_ | `sc-integrations-broker-lib/src/brokers/sbi/config.js:33; services/fund.js:145-178` |
| `/rmslimit-service/trading-accounts/` | GET viewLimits — full path /rmslimit-service/trading-accounts/{accountId}/account-settlement-types/{settlementType}/limit/fund. Read totalAvailableLimitDetails.{totalAvailableLimit, availableLimitCashAndCarry}. Appears in details.health.url normalised to ':accountId'/':settlementType'. | config.endpoint viewLimits _(lvl n/a (details.request.url))_ | `sc-integrations-broker-lib/src/brokers/sbi/config.js:34; services/fund.js:105-125; services/request.js:6-18` |
| `/dp-service/hold-release/dp` | POST securityHold. SBI cash only (securitiesHoldRequired true); SBI-MTF sets that flag false. | config.endpoint securityHold _(lvl n/a (details.request.url))_ | `sc-integrations-broker-lib/src/brokers/sbi/config.js:40,56; services/security.js:45-56` |
| `/sipbasket-service/smallcase-sip-place-order` | POST — the AUTOSIP / activated-order placement path, taken instead of place-order when label==='AUTOSIP' or options.activated or options.autoSip. buySell is hardcoded to 1 (BUY). Sent with NO Authorization header. | config.endpoint placeSipOrder _(lvl n/a (details.request.url))_ | `sc-integrations-broker-lib/src/brokers/sbi/config.js:32; services/autosip.js:40-43; services/order.js:273-280` |
| `/dealer-authentication-service/dealer-details` | POST dealer login. Body contains the dealer's PLAINTEXT PASSWORD at dealerDetails.entityIdentity.loginTypeValue, which is NOT redacted by lib/log. Host comes from SBI_DEALER_LOGIN_API_ENDPOINT, not SBI_API_ENDPOINT. | config.endpoint getDealerDetails _(lvl n/a (details.request.url))_ | `sc-integrations-broker-lib/src/brokers/sbi/config.js:41; services/user.js:405-420` |
| `/dealer-authentication-service/place-order` | POST dealer order placement. Body uses dealerorderparameterbean instead of orderParameters. Timeout forced to 0. | config.endpoint placeDealerOrder _(lvl n/a (details.request.url))_ | `sc-integrations-broker-lib/src/brokers/sbi/config.js:42; services/order.js:93-169; services/request.js:114-116` |
| `/authentication-service/trading-accounts/` | GET user profile — full path .../{accountId}/user-details. Mandatory on retail login; failure or a missing depositoryList aborts login. | config.endpoint getUserProfile _(lvl n/a (details.request.url))_ | `sc-integrations-broker-lib/src/brokers/sbi/config.js:36; services/user.js:378-400` |
| `/books-service/tradeBook` | POST getPositions. Defined in the endpoint table but positionsProvided is false and no SBI service in this adapter calls it — expect zero hits in cash logs. | config.endpoint getPositions (unreferenced by any sbi/ service) _(lvl n/a (details.request.url))_ | `sc-integrations-broker-lib/src/brokers/sbi/config.js:35,68` |
| `/api/SendMailToUser` | POST triggerMail. Success is the STRING comparison response.statuscode === '200'; the reply text is read from the misspelled key response.messgae. | config.endpoint triggerMail _(lvl n/a (details.request.url))_ | `sc-integrations-broker-lib/src/brokers/sbi/config.js:43; services/comms.js:72-89` |
| `/api/v1/WhatsappCM/Postwhatsappdetails` | POST triggerWhatsapp. Body field is the misspelled 'inputvaribale' (SBI's real contract, per source comment). Success is statuscode === '200' as a string. | config.endpoint triggerWhatsapp _(lvl n/a (details.request.url))_ | `sc-integrations-broker-lib/src/brokers/sbi/config.js:44; services/comms.js:107-131` |
| `600014` | SBI messageCode meaning 'no data found' on an order-status query. Triggers the settlement-type retry loop over [0,2,3] on SBI CASH. SBI-MTF has NO such retry. Grep messageList[0].messageCode in the 'Successful request' response body. | SBI order-status response; handled in order.js getOrderDetails _(lvl n/a (broker response field))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:365-378` |
| `709152` | SBI messageCode ERR_POSITIVE_AMT on the fund-hold PUT — rejection of a non-positive amount. DELIBERATELY treated as success (sufficientFunds:true). | SBI fund-hold response; handled in fund.js _(lvl n/a (broker response field))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/fund.js:7,164,244` |
| `shortfallFlag` | Field at result.shortfallDetails.shortfallFlag in the SBI place-order response. 'N' = placed, 'Q' = quantity shortfall, 'F' = funds shortfall, anything else = unhandled fall-through to 'Unknown error'. Companion field shortfallValue holds the numeric magnitude. | SBI place-order response; branched in order.js _mapPlaceOrderResponse _(lvl n/a (broker response field))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:64-85` |
| `externalReferenceNumber` | The field carrying the smallcase tag, on BOTH the outbound place-order body and the inbound order-status entries (orderLegDetails.externalReferenceNumber). The join key between smallcase and SBI. | order.js _getBrokerOrderObject / _mapBrokerOrderResponseToSC / getOrderDetails match _(lvl n/a (wire field))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:228,47,388` |
| `internalOrderNumber` | SBI's own order id. Sent as -1 on placement (meaning 'new order'), returned as result.internalOrderNumber on success, and read from orderLegDetails.internalOrderNumber on order-status into BOTH smallcase orderId and orderKey. NOT the same as exchangeOrderNumber. | order.js _getBrokerOrderObject / _mapPlaceOrderResponse / _mapBrokerOrderResponseToSC _(lvl n/a (wire field))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:209,68,41-42` |
| `accountSettlementType` | The NRI settlement code on the wire: 0 = resident (also the dual-eligible placeholder), 2 = NRO, 3 = NRE. Present on place, cancel, order-status, fund-hold and DP-hold bodies. | order.js/fund.js/security.js payload builders _(lvl n/a (wire field))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/order.js:193,347,527; services/fund.js:140; services/security.js:34` |
| `deatailsOfDealer` | SBI's MISSPELLED response key (deatails, not details) inside dealerDetailsResult.entityDetails, holding {entityId, userId}. Grepping 'detailsOfDealer' finds nothing. | SBI dealer-details response; read in user.js authenticateDealer _(lvl n/a (broker response field))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:431` |
| `EBD_RES_STATUS` | Encrypted brokerParams field carrying the NRI eligibility list. Decrypts to something like '0', '2,3' or '[2,3]'. Determines the nriFlag baked into the access token. | user.js getAccessToken / parseEBDResStatus _(lvl n/a (login param name))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:12-20,79,105` |
| `EM_ENTITY_ID` | Encrypted brokerParams field that decrypts to the SBI userId / trading account number. Also copied to secondaryField. | user.js getAccessToken _(lvl n/a (login param name))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:69-72` |
| `dealer_emp` | Encrypted brokerParams field whose presence marks a REAL-SBI dealer login. Decrypts to the dealerId. If present, getUserProfile is skipped and the access token's first field is empty. | user.js getAccessToken _(lvl n/a (login param name))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:60,76,203` |
| `NRE_NRO` | Literal nriFlag value set on the login response when the account is eligible for BOTH NRE and NRO. The access token itself then gets nriFlag '0', which is what makes the 600014 retry loop necessary at poll time. | user.js getAccessToken _(lvl n/a (login response field))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:99,115` |
| `nriNotSupported` | Set at decryptedParams.meta.nriNotSupported = true when the user IS an NRI but has no eligible (2 or 3) settlement type. Login still returns success — the block happens downstream. | user.js getAccessToken _(lvl n/a (login response field))_ | `sc-integrations-broker-lib/src/brokers/sbi/services/user.js:92-94,108-110` |
| `REDACTED` | Literal replacement value written by lib/log for any key named accessToken, userName, email, phone, pan, ipAddress, brokerParams, cookie, addFundsUrl, APPKey/AppKey, or matching /api[_-]?(key\|secret)/i. Seeing it tells you the field existed but was scrubbed. | src/lib/log.js redactIfDataIsSensitive _(lvl n/a (log value))_ | `sc-integrations-broker-lib/src/lib/log.js:38-46` |
| `[REDACTED]` | Distinct from 'REDACTED' — this bracketed form is the VALUE-level substitution applied when a logged string contains process.env.SBI_APP_KEY. | src/lib/log.js redactSensitiveValue _(lvl n/a (log value))_ | `sc-integrations-broker-lib/src/lib/log.js:31-36 and src/brokers/sbi/config.js:171` |


## Corrections (12)

Where the old `SBI_LOG_INVESTIGATION_GUIDE.md`, or an obvious assumption, is provably wrong.


**Claimed:** The task brief states: 'this repo is on branch rebalance-in-amo, NOT production' and 'broker-lib, broker-api and leprechaun are on rebalance-in-amo'.

**Actually:** sc-integrations-broker-lib is checked out on branch 'development' at HEAD dbe4206f (package version 16.11.15, 2026-09-18). 'rebalance-in-amo' exists as a local branch but is not checked out. Any skill instruction that tells an investigator to assume rebalance-in-amo for broker-lib is wrong; the skill should instruct running `git -C <repo> rev-parse --abbrev-ref HEAD` and reading the checked-out branch.

`git -C /Users/rishidatta/Desktop/integrations/sc-integrations-broker-lib rev-parse --abbrev-ref HEAD -> development; sc-integrations-broker-lib/package.json:4`


**Claimed:** Implicit assumption in the task: comparing against origin/production tells you what runs in prod for broker-lib.

**Actually:** DANGEROUSLY WRONG for this repo. origin/production last moved 2024-09-25 at version 15.22.0 — two years and ~1,940 lines of SBI code behind HEAD. broker-lib does not deploy from a branch; it is published to npm as @smallcase/sc-integrations-broker-lib and consumers pin caret ranges (order-updates ^16.11.15, platform-api ^16.11.14, jobs ^16.11.14, leprechaun ^16.11.9). Reading origin/production gives WRONG wire codes: orderValidities there are DAY:0/IOC:1 (shipped code uses DAY:1/IOC:2), scVariety is 'AMO'/'REGULAR' (shipped uses lowercase 'amo'/'regular'), getOrderKey returns order.orderId (shipped returns order.tag), getSecurityIdentifier returns 'ticker.NSE' (shipped returns 'sbi.NSE'), and statusMessageMap is COMPLETELY EMPTY so getErrorCode would return 'otherError' for everything. The correct procedure is: read the consuming service's pinned version, then that version's code.

`git log -1 origin/production -> bab9ae3c 2024-09-25, package.json version 15.22.0; git diff origin/production...HEAD -- src/brokers/sbi/constants.js:53-60 and config.js:92-113,176-184`


**Claimed:** Obvious assumption (and what the task's own question 9 presumes): the `broker` field in a log line distinguishes SBI cash from SBI-MTF, i.e. broker:'sbi' vs broker:'sbi-mtf'.

**Actually:** There is NO broker:'sbi-mtf' value in real (non-leprechaun) logs. sbi-mtf/config.js line 19 reads `const brokerName = isLeprechaun ? 'sbi-mtf-leprechaun' : 'sbi'` — the MTF adapter stamps broker:'sbi' exactly like the cash adapter. Filtering on broker=='sbi' returns cash and MTF traffic mixed. Use the tag prefix (sc_ vs scmtf_) or orderLegDetails.product (1 vs 6) instead. (The existing SBI_LOG_INVESTIGATION_GUIDE.md already notes this at line 81 — confirming it here with the primary citation.)

`sc-integrations-broker-lib/src/brokers/sbi-mtf/config.js:19 vs src/brokers/sbi/config.js:17`


**Claimed:** SBI_LOG_INVESTIGATION_GUIDE.md line 1013: 'if shortfallFlag is present but not N/Q/F, the code falls through to a generic Unknown error and the actual flag value is never logged ... the raw un-redacted response body (not the mapped statusMessage) is the only place to find the real flag value.'

**Actually:** The first half is right but the conclusion is defeatist — the raw body IS logged, unconditionally, on every successful SBI call. request.js:160-163 emits logInfo({type, responseBody}, 'sending success response', logger) with the ENTIRE un-redacted SBI response body. So the exact recovery path for an investigator is: grep msg=='sending success response' near the order's X-REQ-UID, then read details.responseBody.result.shortfallDetails.shortfallFlag. The guide should give that instruction rather than leaving it as a dead end.

`sc-integrations-broker-lib/src/brokers/sbi/services/request.js:160-163`


**Claimed:** Obvious assumption: lib/log redaction protects credentials in SBI logs, so tokens and passwords will not appear.

**Actually:** Redaction is KEY-NAME-ONLY and the header/body key names SBI uses are not on the blacklist. Empirically verified by executing lib/log with the SBI config: request.headers.Authorization is logged as the full 'Bearer <raw SBI session token>'; request.headers['X-IP-ADDRESS'] is logged in full (the /^ipAddress$/i rule never matches the header key spelling); tradingAccountDetails.tradingAccountNumber, depositoryAccountNumber, depositoryCode and clientId are all logged in full; and on the getDealerDetails call dealerDetails.entityIdentity.loginTypeValue — the dealer's PLAINTEXT LOGIN PASSWORD — is logged in full. Only keys literally named accessToken/userName/email/phone/pan/ipAddress/brokerParams/cookie/addFundsUrl/APPKey (and /api[_-]?(key|secret)/i) are scrubbed. The skill must tell investigators both that these values are findable and that they must not be copied out.

`sc-integrations-broker-lib/src/lib/log.js:3-46 (blacklist contents) vs src/brokers/sbi/services/request.js:59-67,148-159 and src/brokers/sbi/services/user.js:405-413; verified by running logInfo against src/brokers/sbi/config.js`


**Claimed:** SBI_LOG_INVESTIGATION_GUIDE.md line 416 cites the 600014 settlement-type retry at 'sbi/services/order.js:363-378'; line 441 cites the statusMessageMap at 'sbi/config.js:170-178'; line 81 cites generateTag at 'BL-SBI/config.js:114'.

**Actually:** All three citations have drifted against the current checkout. Actual locations on branch 'development' @ dbe4206f: the 600014 retry loop is order.js:363-378 where 363-364 are the explanatory comment and the loop itself is 365-378; statusMessageMap is config.js:176-184 (not 170-178); generateTag is config.js:109-113 (line 114 is the start of getErrorCode). Re-verify every line citation against the checked-out SHA before quoting it — the guide was written against a different tree.

`sc-integrations-broker-lib/src/brokers/sbi/services/order.js:363-378; src/brokers/sbi/config.js:176-184; src/brokers/sbi/config.js:109-113`


**Claimed:** Reasonable assumption: the order-status query filters SBI's order book by product so that only CASH orders come back.

**Actually:** It does not. order.js:342 sets `product: constants.products.ALL`, but constants.products has no ALL key (MARGIN:0, CASH:1, INTRADAY:2, COLLATERAL_SELL:3, SPOT:4, E_MARGIN:5 only). The value is undefined and JSON.stringify drops the key, so every SBI cash order-status request goes out with NO product filter at all. Runtime-verified: require('./src/brokers/sbi/constants.js').products.ALL === undefined. Every other ALL sentinel used in that payload (transactionTypes.ALL, orderSlots.ALL, orderStatuses.ALL, orderTypes.ALL, orderValidities.ALL) does exist and equals 99.

`sc-integrations-broker-lib/src/brokers/sbi/services/order.js:342 against src/brokers/sbi/constants.js:91-98`


**Claimed:** Reasonable assumption: SBI AMO orders are placed with DAY validity on every path, since tests/order.test.js asserts exactly that.

**Actually:** Only the RETAIL path forces DAY. _getDealerBrokerOrderObject hardcodes `orderValidity: constants.orderValidities.IOC` unconditionally while still setting orderSlot to OFF_MARKET for AMO — so a DEALER AMO order goes to SBI as orderSlot 2 (OFF_MARKET) with orderValidity 2 (IOC). The test only exercises the retail path (it calls place() with no dealerDetails).

`sc-integrations-broker-lib/src/brokers/sbi/services/order.js:128-131 vs :225 and :171-179; tests/order.test.js:1-47`


**Claimed:** Reasonable assumption: a log line containing 'error holding stock' will have that string in its msg field.

**Actually:** It will not. security.js:80 calls logWarn(error, 'error holding stock', { payload }, logger) but lib/log's signature is logWarn(err, details, msg, logger). The arguments are transposed: 'error holding stock' lands in `details` and the { payload } object lands in `msg`, while `logger` is passed into the msg slot's position shifted by one. Grep for the string across the whole record, not just msg, and expect a malformed or missing record for this branch.

`sc-integrations-broker-lib/src/brokers/sbi/services/security.js:80 against src/lib/log.js:71-84`


**Claimed:** Reasonable assumption: a place-order call that hangs will eventually time out at the configured brokerApiRequestTimeout of 9000ms.

**Actually:** It will not. request.js:114-116 forces requestParams.timeout = 0 for placeOrder, getDealerDetails and placeDealerOrder — axios treats 0 as no timeout. Those three calls wait indefinitely. So a stuck SBI placement produces NO 'Error in request - timeout' line and no ECONNABORTED; it simply produces no follow-up log at all. The 9000ms default applies only to order-status, viewLimits, fundsCheck, getUserProfile, getRejectionReason, cancelOrder, securityHold and the comms calls.

`sc-integrations-broker-lib/src/brokers/sbi/services/request.js:106,114-116 and src/brokers/sbi/config.js:172`


**Claimed:** Reasonable assumption: order-updates runs the same SBI code as the broker-lib checkout, so reading the checkout is sufficient.

**Actually:** Close, but two config values differ. The copy actually installed under sc-integrations-order-updates/node_modules is 16.11.13-rebalance-in-amo.1. A full recursive diff of its src/brokers/sbi/ against the 'development' checkout shows ONLY config.js differs, in exactly two places: the installed copy has `rebalanceInAMOEnabled: true` (absent on development) and `limitBatchConfig.default.validity: 'IOC'` (development says 'DAY'). Everything else — constants.js, order.js, request.js, user.js, fund.js, security.js, autosip.js, misc.js, comms.js, util.js, api.js — is byte-identical. So every wire-protocol and status-mapping fact holds on both, but any reasoning about limit-batch validity must use 'IOC' for what order-updates actually ran.

`diff -rq sc-integrations-broker-lib/src/brokers/sbi sc-integrations-order-updates/node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi; sc-integrations-order-updates/node_modules/@smallcase/sc-integrations-broker-lib/package.json:3`


**Claimed:** Reasonable assumption: securitiesHoldRequired and other feature flags are shared between SBI cash and SBI-MTF since the adapters are near-clones.

**Actually:** securitiesHoldRequired is TRUE for SBI cash (config.js:56) and FALSE for SBI-MTF (sbi-mtf/config.js:60). So an SBI cash SELL triggers a POST /dp-service/hold-release/dp before the order and an SBI-MTF SELL does not. A missing DP-hold log line on an MTF order is expected, not a defect. On the stale origin/production branch SBI cash also had it false, which is another reason not to read that branch.

`sc-integrations-broker-lib/src/brokers/sbi/config.js:56 vs src/brokers/sbi-mtf/config.js:60; git diff origin/production...HEAD -- src/brokers/sbi/config.js`


## Open questions (10)

Genuinely unresolved. Report these as unknown rather than guessing.

- Do process.env.SBI_API_ENDPOINT and process.env.SBI_MTF_API_ENDPOINT resolve to the SAME host in production? If they do, the request URL is useless as a cash-vs-MTF discriminator and only the tag prefix (sc_ / scmtf_) and orderLegDetails.product (1 / 6) remain. Env values are not visible from this checkout — check the deployment config for order-updates/platform-api.
- Which exact npm version of @smallcase/sc-integrations-broker-lib was deployed in prod at the time of any given incident? Consumers pin caret ranges (^16.11.14 / ^16.11.15) so the resolved version drifts with each deploy. The node_modules copy inspected here (16.11.13-rebalance-in-amo.1) is a LOCAL install and may not match prod. The authoritative source would be the deployed image's package-lock or a runtime version log — neither was available here.
- Is `rebalanceInAMOEnabled` read by anything? It exists in the installed 16.11.13-rebalance-in-amo.1 config and was removed on development, but a grep across sc-integrations-order-updates, sc-platform-api and sc-integrations-jobs (excluding node_modules) found ZERO consumers. Either the consumer lives in a repo not checked out here, or the flag is dead.
- Does SBI genuinely infer MARKET vs LIMIT from orderPrice alone? The place-order body has no orderType field at all — only orderPriceDetails.orderPrice. The MARKET inference from orderPrice===0 is a deduction from the sbi-mtf/services/order.js header curl sample, not from SBI documentation. Confirm against the SBI API spec before relying on it.
- What do raw orderStatus codes 5 (TRANSIT), 7 (EXPIRED) and 8 (FREEZED) actually mean operationally, and what should they map to? Source carries the verbatim comment '// todo: confirm the commented out statuses' and all three currently collapse to smallcase ERROR with the raw code discarded. Nobody at smallcase has confirmed these.
- Is process.env.SBI_APP_KEY always set in production? If it is unset, lib/log's redactSensitiveValue calls String.replace(undefined, '[REDACTED]'), which coerces to the literal 'undefined' and would rewrite any logged string containing that substring. Unverifiable from the checkout.
- Does SBI_DEALER_LOGIN_API_ENDPOINT default to '' in any real environment? config.js:5 falls back to an empty string, which would make the two dealer URLs bare relative paths ('/dealer-authentication-service/dealer-details') and produce an axios failure with a confusing message. Not verifiable without the deployed env.
- miscService.amoActiveHours constructs its window with the LOCAL-time Date constructor while choosing UTC hour values (3,30 for 09:00 IST). This is only correct under TZ=UTC. broker-lib's own unit tests force TZ=utc (package.json:8), but whether every deployed consumer process actually runs with TZ=UTC was not verified — if any does not, the SBI AMO place/cancel window silently shifts.
- getOrderRejectionReason sends `internalOrderNumber: options.orderId` — the CALLER-supplied orderId, not the internalOrderNumber just parsed out of the order-status response. Whether order-updates always populates options.orderId with the SBI internal order number before calling status() was not traced; if it does not, rejection-reason lookups would query the wrong order.
- The order-status 600014 retry loop guards with `accountSettlementType !== nriFlag` where nriFlag is the ORIGINAL token value and is never updated as the loop progresses. Whether a successful retry's settlement type is persisted anywhere (so the next poll starts with the right one) was not traced beyond this file — if not, every poll of a dual-eligible NRI account re-pays the 2-4 call cost.
