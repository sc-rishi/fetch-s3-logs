# jobs-recon

sc-integrations-jobs — recon and cleanup jobs. The main non-human mutators of order state.

**branch when read:** production (HEAD 5bd80bd0 "fix: use BSE ISIN-to-symbol map when populating icici.bse (#986)") — this repo IS on production, unlike broker-lib/broker-api/leprechaun which are on rebalance-in-amo. Facts below reflect prod code.

sc-integrations-jobs is the only non-human mutator of SBI/SBI-MTF Order documents outside the live order flow. It is not in the placement request path: it runs as CLI scripts under @smallcase/scheduler-agent, reads SBI-delivered CSVs from S3 (sbi_recon/, mtf_recon/, sbi_rejected_amo_orders/) and either POSTs a synthetic tradebook to the order-updates fix API (POST {BB_SERVICE_HOST}/errors/fix/{batchId}, body {fixBy:'orderbook', tradebook, force:true}) or writes Mongo directly. The single most important operational fact for an investigator is that sbiReconAllOrders.js — the flagship daily recon — is DRY-RUN BY DEFAULT: its fix POST is gated on `yargs.save`, and when the flag is absent it still logs 'Batch updated successfully' with the batchId. Three separate sub-features (createMissingBatches, createDealerDuplicateBatches, recreateInvestment) have the same shape: they log success and push into the report/Slack/email counters even when the write flag is off. So "the Slack report said N batches were fixed" is NOT evidence that anything was written. A second structural fact: sbiReconAllOrders discards any CSV row with averagePrice <= 0 or quantity <= 0 at parse time, so it can only ever fix orders that actually traded — a rejected/never-traded SBI order is invisible to it, which is why the separate sbiRejectedAmoOrdersIngest.js job exists. Provenance of a job-made change is reconstructed from meta.type ('reconInsert <date>', '<D><Mon>_DuplicateDealerOrder'), meta.updates[].update free text, meta.sbiMtfDoubleBuyOrders, and dealer:true + source:'PROFESSIONAL' on synthesized batches.

Confidence markers are the researcher's own: unmarked = confirmed from source, `[INFERRED]` = deduced but unproven, `[UNCONFIRMED]` = a lead, not a fact. `!` marks facts flagged critical. Re-verify line numbers against the checked-out SHA.


## Facts (77)


### log-envelope

- **!** Every job log line is a Bunyan JSON object with envelope `{ jobs: { jobName, info, data } }` for logger.info, and `{ jobs: { jobName, msg, stack, data } }` for logger.error and logger.warn. CRITICAL for grepping: on error/warn the human-readable message is in `jobs.msg`, NOT `jobs.info`. Filter by `jobs.jobName` to isolate a job.  
  `utils/loggerHelper.js:14-50`
- **!** Bunyan `name` field is `sc.service.${process.env.APPLICATION_NAME || <repo dir name>}`, i.e. `sc.service.sc-integrations-jobs` in prod. Streams are process.stdout (level from config.logger.stdoutLevel, default 'info') plus a daily rotating file at /deployments/logs/sclogs_<app>. Level is 'info', so logger.debug() calls are SILENT in prod unless the Logger was constructed with debug=true.  
  `config.js:9-14 + node_modules/@smallcase/sc-integrations-babel/src/logger/logger.js:32-56 + utils/loggerHelper.js:5-12`
- When NODE_ENV/config.environment === 'local', the Logger swaps Bunyan for bare `console`, so local runs produce no JSON envelope at all. Any log sample lacking the `jobs:` wrapper came from a local run, not prod.  
  `utils/loggerHelper.js:12`

### s3-log-key

- **!** Per-invocation job logs land at S3 key `{job.data.repo}/{job.data.name}_{job.id}` in bucket `config.aws.logsUploadBucket` (env SCHEDULER_LOGS_BUCKET, default 'smallcase-trash'), gzipped. job.data.name is the PHYSICAL FILENAME of the script without .js — so the S3 key uses the filename while the log body's jobs.jobName uses the internal variable. These disagree for several jobs (see mismatch facts).  
  `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:74-79, 86; config.js of scheduler-agent:54`
- **!** ONLY child.stdout is piped into the gzip S3 upload — `child.stdout && child.stdout.pipe(zlib.createGzip()).pipe(upload)`. child.stderr is piped to the Redis pub/sub stream and to the parent process.stderr, but NOT into the per-run S3 object. Anything a job writes to stderr (console.error, an uncaught exception's stack printed by node) is therefore ABSENT from the per-invocation S3 log. Bunyan writes to stdout so logger.* calls ARE captured.  
  `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:92, 113-114`
- **!** Jobs are launched via childProcess.fork(filePath, job.data.args) by the scheduler agent, which is bootstrapped by `schedulerAgent.init()`. The CLI flags a prod run used live in job.data.args — they are not in this repo, so you cannot tell from source alone whether a given prod run passed --save.  
  `bootstrap-agent.js:1-2 + node_modules/@smallcase/scheduler-agent/utils/job-runner.js:58-62`

### dry-run-trap

- **!** sbiReconAllOrders.js IS DRY-RUN BY DEFAULT. fixBatchByTradebook() only issues the axios.post when `yargs.save` is truthy: `let res = {}; if (yargs.save) { res = await axios.post(...) }`. There is no --save in any default; yargs is raw `require('yargs').argv`.  
  `jobs/reconciliations/sbiReconAllOrders.js:592-614; jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:1`
- **!** WORST TRAP IN THE DOMAIN: without --save, sbiReconAllOrders still logs 'Batch updated successfully' with the batchId, because the success branch is `if (!yargs.save || (res && res.data && res.data.success))`. It also logs 'Fix batch response' with `response: undefined`. Seeing 'Batch updated successfully' in logs proves NOTHING about whether a write occurred — check `response` in the preceding 'Fix batch response' line: undefined/absent response.data means dry run.  
  `jobs/reconciliations/sbiReconAllOrders.js:603-614`
- The --save gate on sbiReconAllOrders' fix POST has existed since the job's first commit (adaf7941 'Script(sbi)/added script to recon all sbi orders (#511) (#551)'); it is not a recent regression.  
  `git log -S 'yargs.save' -- jobs/reconciliations/sbiReconAllOrders.js`
- **!** createBatchesFromLogs() gates only the Mongo insert on `yargs.createMissingBatches`, but pushes into `createdBatches` UNCONDITIONALLY right after. So the Slack/email counter 'Created Missing Batches: N' and the log 'Created new batch...' report phantom batches in dry run, and recreateInvestmentsForIscids() is then called on those non-existent batchIds.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconBatchCreation.js:177-186; jobs/reconciliations/sbiReconAllOrders.js:1201-1207`
- **!** processDuplicateTagOrdersForIteration() gates the insert on `yargs.createDealerDuplicateBatches` but returns newBatch regardless, so reconcileDealerDoubleOrders pushes into createdBatches and logs 'Created new batch for dealer double orders' even when nothing was written.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconDealerDuplicate.js:342-345, 174-188`
- **!** callRecreationAPI() logs 'Recreation API request' with the full url and body BEFORE checking `if (!yargs.recreateInvestment) { return; }`. The request log therefore appears even when no HTTP call is made.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:122-132`

### cli-flags

- **!** sbiReconAllOrders.js accepts exactly seven flags across the job and its three helper files: --date (default today UTC), --filepath, --local, --save (enables the fix POST), --createMissingBatches (enables inserting batches reconstructed from dealerOrderDownloadLogs), --createDealerDuplicateBatches (enables inserting dealer-double batches), --recreateInvestment (enables the pf-utils recreation POST). There are no other flags.  
  `grep of yargs.* across jobs/reconciliations/sbiReconAllOrders.js + sbiReconHelperFiles/*.js; sbiReconDependencies.js:1-4`

### terminal-states

- **!** orderTerminalStates = ['COMPLETED','FIXED','MARKEDCOMPLETE','CANCELLED'] in sbiReconAllOrders.js is used ONLY by isTerminalStatus(), which is called ONLY by checkTerminalStatusChanges() — a pure REPORTING function that records terminal->terminal batch status transitions. It does NOT gate, skip or protect any batch from being fixed.  
  `jobs/reconciliations/sbiReconAllOrders.js:31-36, 533, 536-553 (exhaustive grep: those are the only 4 references in the file and helpers)`

### skip-branches

- **!** The ONLY per-batch skip in sbiReconAllOrders' main fix loop is the superseded-by-dummy guard: `if (batch.meta && batch.meta.supersededByDummyBatchId) { continue; }`, logged at WARN level. Nothing else in the loop is conditionally skipped.  
  `jobs/reconciliations/sbiReconAllOrders.js:1227-1242`
- **!** The second reason a batch is not fixed is an empty tradebook: getFixTradebook returns [] and the job logs the batch _id as the message with data {type: batch.label, error: 'No matching orders found, no reconciliation required'}. Note the message field is the raw batchId string — grep for the batchId itself, not for a fixed phrase.  
  `jobs/reconciliations/sbiReconAllOrders.js:1243-1248`

### tradebook-construction

- **!** getFixTradebook only emits a tradebook entry when `sbiOrder.status !== order.status` — if the DB already agrees with the CSV status, the leg is omitted. A batch whose legs all already match produces an empty tradebook and is silently not fixed, even if quantity/price/filledQuantity differ. Quantity and price mismatches are REPORTED but never FIXED by this job.  
  `jobs/reconciliations/sbiReconAllOrders.js:556-589 (esp. 573)`
- **!** Tradebook entry shape posted to the fix API: { sid, orderId, exchangeOrderId, filledQuantity, averagePrice, status, tag, orderTimestamp }. Body is { fixBy: 'orderbook', tradebook, force: true }, POSTed to `${config.BB_SERVICE_HOST.url}/errors/fix/${batchId}` with header 'x-request-source: sc-integrations-jobs' and a 9000ms timeout.  
  `jobs/reconciliations/sbiReconAllOrders.js:574-583, 592-609; config.js:46-48`

### matching-logic

- **!** CSV-row -> Order-leg matching is two-tier and tried in this order everywhere in the job: (1) dealer key `${tag}|${brokeruserId}|${tradingsymbol}` where tradingsymbol = csvOrder.isin.slice(0,-2); (2) fallback lookup by orderId in nonDealerOrderMap. A leg goes into dealerOrderMap if `batch.dealer === true || !order.orderId || order.orderId === 'NA'`; otherwise into nonDealerOrderMap keyed by orderId.  
  `jobs/reconciliations/sbiReconAllOrders.js:39-44, 285-301, 313-319`
- **!** The field the code calls `csvOrder.isin` is NOT an ISIN. Column 6 (ORD_SEM_SMST_SECURITY_ID) holds values like 'PNBEQ', 'WIPROEQ', 'COHANCEEQ' — the NSE symbol with an 'EQ' series suffix. `.slice(0,-2)` strips 'EQ' to yield the tradingsymbol ('PNB'). Do not search for INE-prefixed ISINs when reading this job's logs or reports.  
  `jobs/reconciliations/sbiReconAllOrders.js:246, 315; jobs/reconciliations/sbi_all.csv:1-2 (real sample: `S,1,30043733,2.51216E+13,116.91,PNBEQ,...`)`

### csv-parse-drop

- **!** HIGHEST-VALUE 'why did recon not fix this order' ANSWER: validateOrderFields rejects any row with quantity <= 0 or NaN, or averagePrice <= 0 or NaN, pushing it to failedOrders and `continue`-ing. Column 5 is the weighted average trade price (SUM(qty*price)/SUM(qty)) which is empty for an order with no trades. Therefore a never-traded SBI order (rejected/cancelled/pending) is DISCARDED AT PARSE TIME and can never be reconciled by this job. It surfaces only as the Slack counter 'Stock Orders that failed validation checks'.  
  `jobs/reconciliations/sbiReconAllOrders.js:46-73, 255-264; REQUIRED_FIELDS[4] at :20`
- **!** Consequence of the above: sbiReconAllOrders' status mapping `parts[9] === 'T' ? 'COMPLETE' : 'REJECTED'` can essentially never produce 'REJECTED' for a zero-fill order, because that row was already dropped. The REJECTED branch only survives for rows that partially traded (avgPrice > 0) but carry a non-'T' ORD_STATUS. This is why sbiRejectedAmoOrdersIngest.js exists as a separate job. `[INFERRED]`  
  `jobs/reconciliations/sbiReconAllOrders.js:250 combined with :46-73`
- A row is also dropped with error 'Invalid number of fields' if its comma-split length !== 12. Only REQUIRED_FIELDS.length (12) is used — the field-name strings in REQUIRED_FIELDS are decorative and never matched against a header.  
  `jobs/reconciliations/sbiReconAllOrders.js:15-28, 231-238`
- processCSVContent does NOT skip a header row (loop starts at i=0). This is correct for the real S3 files, which are headerless (verified against the checked-in prod sample sbi_all.csv). If a headered file is supplied (as sbi_all_test.csv is), row 1 lands in failedOrders. By contrast sbiDealerRecon.js starts at i=1 and sbiRejectedAmoOrdersIngest.js logs 'Skipping CSV header row'.  
  `jobs/reconciliations/sbiReconAllOrders.js:223; jobs/reconciliations/sbi_all.csv:1; jobs/reconciliations/sbi_all_test.csv:1; jobs/reconciliations/sbiDealerRecon.js:103; jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:67`
- **!** REAL DATA CORRUPTION SEEN IN PROD SAMPLE: the checked-in sbi_all.csv has ORD_ORDER_NO rendered in Excel scientific notation — orderId literally equals the string '2.51216E+13'. validateOrderFields only checks orderId is a non-empty string, so such rows PASS validation but can never match a DB leg via nonDealerOrderMap.get(orderId). Non-dealer legs from a spreadsheet-mangled CSV therefore land silently in missingBatches.  
  `jobs/reconciliations/sbi_all.csv:1-2; jobs/reconciliations/sbiReconAllOrders.js:50-52, 318`
- **!** CSV column -> field mapping (0-indexed) in sbiReconAllOrders: 0 ORD_BUY_SELL_IND ('B'->BUY else SELL), 1 ORD_QTY_ORIGINAL->quantity, 2 ORD_CLIENT_ID->brokeruserId, 3 ORD_ORDER_NO->orderId, 4 weighted avg trade price->averagePrice, 5 ORD_SEM_SMST_SECURITY_ID->isin (really symbol+EQ), 6 TRUNC(ORD_TRD_TRADE_TIME)->timestamp, 7 SUM(ORD_TRD_TRADE_QTY)->filledQuantity, 8 ORD_REMARKS/ORD_EXT_REF_NO->tag, 9 ORD_STATUS ('T'->COMPLETE else REJECTED), 10 ORD_EXCH_ORDER_NO->exchangeOrderId (parseInt then toString), 11 ORD_SOURCE_FLG->sourceFlag.  
  `jobs/reconciliations/sbiReconAllOrders.js:15-28, 240-253`

### s3-inputs

- **!** sbiReconAllOrders reads BOTH `sbi_recon/${date}/` and `mtf_recon/${date}/` prefixes from bucket config.jobs.sbiIngestUpdates.sbiAllOrdersS3Bucket (env SBI_ALL_ORDERS_S3_BUCKET, default 'sc-integrations-sbi-attachments'), region ap-south-1, and merges them. If neither prefix returns any key it throws `No files found in S3 bucket for date: ${todayDate}` and the whole job aborts into the error/Slack path.  
  `jobs/reconciliations/sbiReconAllOrders.js:87-127; config.js:297-300`
- Cross-file dedup key is `${orderId}|${brokeruserId}|${tag}` — a repeat is pushed to duplicateOrders and DROPPED, not merged. Because the two prefixes are merged into one list, an order appearing in both sbi_recon and mtf_recon is silently deduped.  
  `jobs/reconciliations/sbiReconAllOrders.js:136-173`
- --local IGNORES --filepath entirely and reads the repo-local file jobs/reconciliations/sbi_all.csv via fs. --filepath (without --local) reads exactly that one S3 key and ignores --date's prefix listing.  
  `jobs/reconciliations/sbiReconAllOrders.js:75-86, 205-212`
- NO job in this repo writes SBI recon CSVs to S3. putFileToS3 is called only by kotakErrorOrderReconciliation.js and aspOfflineCompute.js. The sbi_recon/, mtf_recon/ and sbi_rejected_amo_orders/ objects are delivered by SBI/an external process. Kotak has a full sftp:{host,port,username,password,orderBookSource} config block; SBI has none — its only recon config is the two bucket names.  
  `grep putFileToS3 across jobs/ scripts/ services/; config.js:118, 284, 297-301`

### mongo-queries

- **!** sbiReconAllOrders runs two Mongo queries, both with .read('secondary').lean() on a connection already opened with readPreference:'secondary'. (a) dealerOrdersQuery: {broker:{$in:['sbi','sbi-mtf']}, brokeruserId:{$in:<all CSV brokeruserIds>}, $or:[{'orders.tag':{$in:<all CSV tags>}},{'unplaced.tag':{$in:<all CSV tags>}}]} — note NO date filter, so it can match batches from any date. (b) ordersForTodayQuery: {broker:{$in:['sbi','sbi-mtf']}, date:{$gte:<date>T00:00:00Z, $lt:+1day}}.  
  `jobs/reconciliations/sbiReconAllOrders.js:1159-1183; sbiReconHelperFiles/sbiReconDependencies.js:92-100`
- Reading from a SECONDARY means replication lag can make the job see stale order state. After the fix loop the job re-reads both queries ('Fetching fresh orders after reconciliation') still from secondary, so post-fix validations can report mismatches that were already corrected. `[INFERRED]`  
  `jobs/reconciliations/sbiReconAllOrders.js:1325-1335`

### provenance-markers

- **!** Batches synthesized by createBatchesFromLogs carry meta.type = `reconInsert ${YYYY-MM-DD}` and meta.dealerId, plus dealer:true, status:'COMPLETED', source:'PROFESSIONAL', tier:'BASIC', variety:'regular', errorStatus:false, filled = orders.length, and _id === batchId === previousBatchId === originalBatchId. Every leg gets orderType:'MARKET', product:'CNC', validity:'IOC', price:0, triggerPrice:0, status:'COMPLETE', exchange from the dealer log or 'NSE'.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconBatchCreation.js:104-175`
- **!** Batches synthesized by the dealer-duplicate path carry meta.type = `${day}${MonShort}_DuplicateDealerOrder` (e.g. '3Feb_DuplicateDealerOrder'), derived from --date, plus label:'MANAGE', originalLabel:'MANAGE', dealer:true, and statusMessage:'NA' on every leg. Status is computed: filled===quantity -> 'COMPLETED', 0<filled<quantity -> 'PARTIALLYFILLED', filled===0 -> 'UNFILLED'.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconDealerDuplicate.js:209-235, 320-324, 363-368`
- **!** cleanupMtfNonTerminalBatches stamps meta.updates with update text `Marked MARKEDCOMPLETE by cleanup job cleanupMtfNonTerminalBatches. Was in non-terminal state '<oldStatus>' but is not the last batch for its iscid.` alongside $set status:'MARKEDCOMPLETE'. This is the cleanest job-provenance marker on an Order doc.  
  `jobs/cleanup/cleanupMtfNonTerminalBatches.js:93-107`
- **!** scripts/adhoc/orders/sbi/fixDoubleBuy.js stamps meta.sbiMtfDoubleBuyOrders:true, sets label:'MANAGE' and rewrites iscid, and pushes meta.updates text `Adhoc fix: normalized duplicate ISCID for SBI/SBI-MTF double buy orders for iscid: <oldIscid> with label: <oldLabel>`.  
  `scripts/adhoc/orders/sbi/fixDoubleBuy.js:64, 303-321`
- scripts/adhoc/orders/linkFixBatch.js sets label:'FIX', previousBatchId and originalBatchId on the fix batch, sets status:'FIXED' on the original batch, and pushes a caller-supplied free-text meta.updates entry on both. This is where a batch's status becomes 'FIXED'.  
  `scripts/adhoc/orders/linkFixBatch.js:47-79`
- **!** No SBI job in this repo writes a `meta.reconciled` field or a `meta.source` field. Grep across jobs/ and scripts/ for 'meta.reconciled' and 'meta.source' returns zero hits. Do not look for those markers.  
  `grep -rn "meta\.reconciled|meta\.source" jobs/ scripts/ --include=*.js => no matches`

### jobname-mismatch

- **!** CONFIRMED: jobs/reconciliations/sbiUnplacedRecon.js line 1 is `const jobName = 'sbiDealerRecon';`. Its S3 log key says sbiUnplacedRecon but every log line inside says jobs.jobName='sbiDealerRecon', colliding with the real sbiDealerRecon.js. You cannot distinguish the two by jobName alone — disambiguate by log content: sbiUnplacedRecon logs 'No orders to reconcile' and 'Reconciliation completed'; sbiDealerRecon additionally logs 'Validating yargs', 'Unconsumed orders' and 'Validation results'.  
  `jobs/reconciliations/sbiUnplacedRecon.js:1, 145, 157; jobs/reconciliations/sbiDealerRecon.js:1, 489, 538, 542`
- **!** Other SBI-relevant filename vs jobName mismatches in this repo (S3 key uses filename, log body uses jobName): markBatchesAsUnfilled.js -> 'markDealerBatchesAsUnfilledEOD'; scripts/adhoc/orders/sbi/fixDoubleBuy.js -> 'fixDuplicateIscidsCopy'; scripts/adhoc/orders/sbi/rerunsbiautosip.js -> 'placeSbiAutosips'; scripts/adhoc/orders/markBatchAsError.js -> 'markBatchToError'; scripts/adhoc/users/sbiInvalidScidsFix.js -> 'fixInvalidScidsAndArchiveSIPs'; jobs/activations/sbi/ingestUsers.js and jobs/activations/sbiV2/ingestUsers.js BOTH -> 'sbiActivation'; jobs/activations/sbi/placeActivatedOrders.js -> 'placeSbiActivatedOrders'; jobs/autosips/sbi/createSbiAutosipOrders.js and createSBIAutosipOrders-NonWorkingDay.js BOTH -> 'placeSbiAutosips'.  
  `automated scan of `jobName =` vs basename across jobs/ and scripts/ — see jobs/reconciliations/markBatchesAsUnfilled.js:2, scripts/adhoc/orders/sbi/fixDoubleBuy.js:30, scripts/adhoc/orders/markBatchAsError.js:1, jobs/activations/sbi/ingestUsers.js, jobs/activations/sbiV2/ingestUsers.js`
- sbiReconAllOrders.js does NOT have this bug — both the file's own `const jobName = 'sbiReconAllOrders'` and the helper's `init('sbiReconAllOrders', ...)` agree with the filename. Note the logger instance actually used by the job body comes from sbiReconDependencies.js, so the jobName stamped on every line is the helper's literal, not the file's const.  
  `jobs/reconciliations/sbiReconAllOrders.js:2-3; jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:7`

### logger-arg-inversion

- **!** cleanupMtfNonTerminalBatches.js calls the logger with arguments REVERSED relative to the Logger signature `info(info, data)` — e.g. `logger.info({brokers, save}, 'Starting cleanupMtfNonTerminalBatches')`. Result: `jobs.info` holds the OBJECT and `jobs.data` holds the MESSAGE STRING. For this job, grep the human message in `jobs.data`, not `jobs.info`. Same inversion in twoStepRebalanceReconcile.js's `logger.error(err, {...})` (correct for error) but its logger.info calls are in the right order.  
  `jobs/cleanup/cleanupMtfNonTerminalBatches.js:41, 46, 62, 77-80, 88-91, 110, 115, 118, 125, 137 vs utils/loggerHelper.js:14-24`

### job-inventory-reconAllOrders

- **!** sbiReconAllOrders.js — file: jobs/reconciliations/sbiReconAllOrders.js; jobName 'sbiReconAllOrders'. Reads S3 sbi_recon/<date>/ + mtf_recon/<date>/. Writes via POST {BB_SERVICE_HOST}/errors/fix/{batchId} (gated --save) and via direct dbConnection.db.collection('orders').insertOne for the two batch-creation paths (gated --createMissingBatches / --createDealerDuplicateBatches). Reports to Slack channel 'sbi-sec-integration-dev-team' and emails integrations-reports@smallcase.com in production.  
  `jobs/reconciliations/sbiReconAllOrders.js:1-13, 592-614; sbiReconHelperFiles/sbiReconBatchCreation.js:177-179; sbiReconHelperFiles/sbiReconDealerDuplicate.js:342-344; sbiReconHelperFiles/sbiReconReporting.js:31-40, 769-787`

### job-inventory-rejectedAmo

- **!** sbiRejectedAmoOrdersIngest.js — jobName matches filename. Reads S3 `sbi_rejected_amo_orders/<date>/` from the same sbiAllOrdersS3Bucket. CSV columns used: 0 ORD_CLIENT_ID->brokeruserId, 6 ORD_EXT_REF_NO->tag, 7 ERROR_OR_REASON->statusMessage; rows with <8 columns or any of those three empty are skipped with a WARN. Flags: --date (defaults to IST-shifted today, unlike sbiReconAllOrders' UTC today), --filepath, --save, --muteSlackNotification.  
  `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:1-43, 83-140, 406, 479-486`
- **!** sbiRejectedAmoOrdersIngest is the ONLY job in this repo that dry-runs HONESTLY: it emits explicit '[DRY-RUN] Would call fix API' and '[DRY-RUN] Would update statusMessage for already-rejected order' lines and appends ' _(dry-run — no writes)_' to the Slack title and ' [DRY-RUN]' to the email subject.  
  `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:260-263, 309-312, 382-384, 444`
- **!** It refuses any batch where `batch.variety !== 'amo'` ('Skipping batch — not an AMO batch'), skips legs with status==='COMPLETE' and legs with filledQuantity>0, and for legs already status==='REJECTED' it bypasses the fix API entirely and does a direct Order.updateOne with arrayFilters setting `<orders|unplaced>.$[elem].statusMessage` and `.errorCode`. errorCode comes from brokerLib[broker].config.getErrorCode({statusMessage}).  
  `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:169-178, 207-252, 281-313`
- **!** statusMessage written is `Order Rejected: ${errorReason}` — constant REJECTED_STATUS_MESSAGE_PREFIX = 'Order Rejected: ', with an in-code comment stating the prefix exists so the message matches broker-lib's SBI invalidOrder regex.  
  `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:41-43, 230, 242`

### job-inventory-cleanup

- **!** cleanupMtfNonTerminalBatches.js — file at jobs/cleanup/ (NOT jobs/sanity/). MTF_BROKERS = ['axis-mtf','sbi-mtf','hdfc-mtf','axis-mtf-leprechaun','sbi-mtf-leprechaun','hdfc-mtf-leprechaun']; NON_TERMINAL_STATES = ['UNPLACED','UNFILLED','PARTIALLYFILLED'] — 'ERROR' is NOT in that list, so this job never touches an ERROR batch. Flags: --save (default false, honest dry run), --brokers (comma list, default all six; entries not in MTF_BROKERS are filtered out and an empty result exits(1) with 'No valid MTF brokers specified'). Writes direct Order.updateOne, no fix API. Applies only to 'sbi-mtf', never plain 'sbi'.  
  `jobs/cleanup/cleanupMtfNonTerminalBatches.js:1-60, 93-107`
- **!** cleanupMtfNonTerminalBatches' safety rule: for each non-terminal batch it finds the newest batch for the same iscid (sort date:-1) and SKIPS if that newest batch is itself ('Skipping: this is the latest batch for iscid'). Only a stale, superseded non-terminal batch gets MARKEDCOMPLETE.  
  `jobs/cleanup/cleanupMtfNonTerminalBatches.js:66-91`

### job-inventory-dealerRecon

- **!** sbiDealerRecon.js — jobName 'sbiDealerRecon'. Requires --filepath (throws 'filepath is required'), also takes --from/--to. Reads ONE S3 key from config.jobs.sbiIngestUpdates.orderBookS3Bucket (env SBI_ORDERBOOK_BUCKET, default 'smallcase-trash' — a different bucket from sbiReconAllOrders'). Query: {broker:'sbi', date:{$gte:from,$lt:to}, status:{$ne:'COMPLETED'}} — plain 'sbi' only, no 'sbi-mtf'. Its fixBatchByTradebook has NO --save gate: it ALWAYS POSTs, with a 3000ms timeout.  
  `jobs/reconciliations/sbiDealerRecon.js:1, 86-97, 169-193, 489-510; config.js:298`
- sbiDealerRecon.js maps CSV status as `parts[9] === 'T' ? 'COMPLETE' : 'PENDING'` (note: PENDING, not REJECTED) and skips rows with fewer than 11 columns. It starts at i=1, skipping a header row.  
  `jobs/reconciliations/sbiDealerRecon.js:103-126`

### job-inventory-unplacedRecon

- **!** sbiUnplacedRecon.js HARDCODES every parsed CSV row to `status: 'REJECTED'` with the comment `// check the complete enum for order status` — it ignores column 9 entirely. It builds a Map keyed by tag with NO array (later rows for the same tag silently overwrite earlier ones). Its fixBatchByTradebook has NO --save gate and a 3000ms timeout. Query: {broker:'sbi', date:{$gte:--from,$lt:--to}, status:{$ne:'COMPLETED'}}. Running this job marks matched legs REJECTED regardless of their real broker status.  
  `jobs/reconciliations/sbiUnplacedRecon.js:44-56, 83-106, 125-132`

### job-inventory-3feb

- sbiDealerRecon3Feb2025.js is a one-off backfill with NO jobName const and NO logger — it uses console.log exclusively. Hardcoded local file './jobs/reconciliations/dealerRecon2.csv' and hardcoded date new Date('2025-02-03T05:00:00Z') for batch.date/completedDate/orderTimestamp. Synthesizes batches with status:'PLACED', then POSTs /v2/internal/orders/autosip/preorder followed by /v2/internal/batch/apply?broker=sbi against platform-api. Because it never uses the Logger, its output carries NO jobs.jobName envelope and cannot be filtered by jobName.  
  `jobs/reconciliations/sbiDealerRecon3Feb2025.js:18, 146-152, 183-205, 314-315, 350, 361`

### job-inventory-generateTestBatches

- **!** DANGEROUS: generateTestBatches.js has NO save/dryRun guard at all — it unconditionally calls models.Order.create(batch) for a set of hardcoded broker:'sbi' batches with brokeruserId '1002906895'. Running it against prod inserts fake SBI batches. It logs `Created test batch: ${batch.description}` with {batchId}.  
  `jobs/reconciliations/generateTestBatches.js:5-6, 28, 67, 253-264`

### job-inventory-markUnfilled

- markBatchesAsUnfilled.js (jobName 'markDealerBatchesAsUnfilledEOD') does NOT touch SBI. Its query is {status:'ERROR', date:{$lte:now}, broker:{$in:['axis','hdfc','hdfc-mtf']}, dealer:true}. It has no --save gate and always POSTs the fix API with an EMPTY tradebook ({force:true, fixBy:'orderbook', tradebook:[]}). Mentioned only so an investigator does not chase it for an SBI order.  
  `jobs/reconciliations/markBatchesAsUnfilled.js:2, 17-27, 35-46`

### job-inventory-recreateInvestments

- recreateInvestments.js accepts --broker (demandOption, so it CAN target sbi/sbi-mtf), --platformUtilsApiToken (demandOption), --from (default '2025-12-30'), --to. It reads only iscids and POSTs pf-utils recreation per iscid. It is effectively INVISIBLE in structured logs: all progress goes through console.log/console.error, never through the Logger — so there is no jobs.jobName envelope for its per-iscid output. It retries each failure exactly once, inline, with identical params.  
  `jobs/reconciliations/recreateInvestments.js:1-34, 70-79, 82-125`

### job-inventory-sanity

- **!** jobs/sanity/ contains NO SBI-mutating job. hangingOrderEodReport.js and databaseSanityChecks.js are read+report only (email/Slack), grouping by broker; databaseSanityChecks has one hardcoded `broker: "sbi"` sub-query. batchAndPlacedOrdersMismatch.js is read-only and console-only. iscAndBatchStatus.js CAN write, but to User.investedSmallcases[].status = 'VALID' and Redis lock `API:SCL:<userId>:<lockKey>` — never to the Order document — and only under --updateStatusInDB (default false). twoStepRebalanceReconcile.js is broker-agnostic and gated on --save.  
  `jobs/sanity/databaseSanityChecks.js:1, 28, 119; jobs/sanity/batchAndPlacedOrdersMismatch.js:1-46; jobs/sanity/iscAndBatchStatus.js:6-10, 78-104; jobs/sanity/twoStepRebalanceReconcile.js:11-12, 34-37`
- twoStepRebalanceReconcile.js selects batches with completedDate missing AND either (meta.twoStep.phase='SELL_COMPLETE' with buyLegScheduledFor <= now-30min and a BUY leg in status 'ACKED') or (meta.twoStep.phase='BUY_LEG' with buyLegStartedAt <= now-30min). STUCK_AFTER_MS = 30*60*1000. Without --save it only logs '[DRY RUN] Two-step batch requires recovery'. With --save it calls orderUpdatesService.placeTwoStepBuyLeg or orderUpdatesService.triggerPoll.  
  `jobs/sanity/twoStepRebalanceReconcile.js:13-53`

### adhoc-mutators

- **!** scripts/adhoc/orders/sbi/markPartialStatuses.js — brokers hardcoded to ['sbi','sbi-mtf'], operates on both Order and SSTOrder. Sets leg status='PARTIAL' and batch status='PARTIALLYFILLED'. It REQUIRES exactly one of --dryRun or --save (throws 'Either --dryRun=true or --save=true must be specified' and 'Specify only one of --dryRun or --save'), and requires either --batchIds or both --from and --to (dates parsed as IST day start via `${dateStr}T00:00:00+05:30`). Also accepts --limit, --batchSize (default 500).  
  `scripts/adhoc/orders/sbi/markPartialStatuses.js:24-46, 60-86, 150-230`
- **!** scripts/adhoc/orders/sbiMtfBackfillOrderMargins.js — broker:'sbi-mtf' ONLY. Reads margin CSVs from bucket config.jobs.putBrokerMtfsInRedis.sbi.s3Bucket (default 'sc-integrations-sbi-attachments') prefix `mtf_security_margin/<YYYY-MM-DD>/`. Writes Order.updateOne($set:{orders,unplaced}) with strict:false. UNLIKE markPartialStatuses it does NOT require a flag: dryRun and save both default false, validateInputs never checks them, and the write is gated by `if (!save) continue` — so running it with no flags silently does nothing while logging 'Updated margin/product for batch' for every candidate.  
  `scripts/adhoc/orders/sbiMtfBackfillOrderMargins.js:26, 46-64, 340-360, 466-480, 540-553`
- **!** scripts/adhoc/orders/markBatchAsError.js (jobName 'markBatchToError') has NO --save flag — it always writes. --batchIds is required (logs error 'No batch IDs provided.' and returns if empty); --tags and --markAll select scope. With --markAll it sets batch status='ERROR' plus 'orders.$[].status'='ERROR' and 'unplaced.$[].status'='ERROR' on BOTH Order and SSTOrder; with --tags it uses arrayFilters to hit only matching legs. It also decrements batch.filled.  
  `scripts/adhoc/orders/markBatchAsError.js:1-5, 17-24, 33-38, 45-105`
- scripts/adhoc/orders/sbi/fixDoubleBuy.js requires exactly one of --dryRun / --save (throws otherwise), accepts --batchLimit, and operates on a HARDCODED list of (userId, scid) pairs (TARGET_ENTRIES) derived from a redash query on 2026-04-01 — it does not scan. It skips a duplicate-iscid group when the conflict is SELLALL-explainable (a batch with label or originalLabel 'SELLALL' and status 'COMPLETED').  
  `scripts/adhoc/orders/sbi/fixDoubleBuy.js:1-30, 59-60, 205-212, 296-301`

### reporting-destinations

- Slack goes to channel key 'sbi-sec-integration-dev-team' (webhook from env SBI_SEC_INTEGRATION_NOTIFICATION_HOOK). Every message is suffixed `\ncc: <@U08ACEVT78B> <@U08JL7VEWQM> <@U08JL7NM961> <@U07U2NK2E86>`. Email in production goes to integrations-reports@smallcase.com, bcc qa@smallcase.com, from '"Integration Jobs" <notifications@smallcase.com>'; in local it goes to rishi.datta@smallcase.com. Subject format: `${env} ${subject} ${new Date(--date).toDateString()}`.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconReporting.js:6-9, 31-40, 769-787; config.js:385-388`
- The sbiReconAllOrders Slack report is split into three sections whose counters map 1:1 to reportData keys: GLOBAL (totalOrders, failedOrders, duplicateTags, recreationAPIFailures, missingBatches, supersededBatches), DEALER and NON-DEALER (successfulFixedOrders, ordersInPlaced, ordersInError, completedOrdersInReconButRejectedOrUnplacedInDB, completedDateMismatch, orderTimestampMismatch, priceMismatch, ordersWithoutOrderId, missingTagsInCSVSuccess/NonSuccess, dummyOrders, inconsistentOrderTimestamps, quantityMismatch, filledQuantityMismatch, isinMismatch, terminalStatusChanges, hangingOrders, foundInDealerLogs, createdBatches, failedBatchCreations, dealerDoubleOrder*, skippedBatches). Dealer/non-dealer split is purely by batch.dealer===true.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconReporting.js:44-95; jobs/reconciliations/sbiReconAllOrders.js:918-1099`

### validation-semantics

- **!** Meaning of each sbiReconAllOrders validation for an investigator: missingBatches = CSV row whose tag/orderId matched NO Order doc (order exists at SBI, not at smallcase). missingTagsInCSVSuccess = our leg is COMPLETE but absent from SBI's file (we think it filled, SBI does not). missingTagsInCSVNonSuccess = same but our leg is non-COMPLETE and non-PLACED. completedOrdersInReconButRejectedOrUnplacedInDB = SBI says COMPLETE, we say REJECTED (dealer) or anything-but-COMPLETE (non-dealer). dummyOrders = a real SBI trade exists for a batch flagged batch.dummy. quantityMismatch = CSV qty != DB qty. filledQuantityMismatch = SBI filled > our filled. priceMismatch = |avgPrice delta| > 1.00 rupee.  
  `jobs/reconciliations/sbiReconAllOrders.js:303-358 (qty, 1.00 threshold at :376), 391-421, 423-478, 480-530, 695-753`
- missingTagsInCSVSuccess/NonSuccess are computed against ordersForToday (date-filtered) while every other validation uses dealerOrders (tag-filtered, NOT date-filtered). So the 'missing in SBI file' counters only ever cover batches dated on --date, while mismatch counters can cover batches from any date.  
  `jobs/reconciliations/sbiReconAllOrders.js:1159-1183, 1210-1212`

### batch-creation-from-logs

- **!** checkDealerOrderDownloadLogs queries the RAW collection `dealerOrderDownloadLogs` (via dbConnection.db.collection, not a model) with {broker:{$in:['sbi','sbi-mtf']}, 'payload.dealerOrders.tag':{$in:<missing tags>}}. A hit yields iscid/scid/did/userId/dealerId/smallcaseName/label from log.payload. This is the only mechanism that resurrects a batch SBI executed but smallcase never recorded.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconBatchCreation.js:6-50`
- Idempotency guard before inserting a reconstructed batch: findOne with {broker:{$in:['sbi','sbi-mtf']}, brokeruserId, $and:[{orders:{$elemMatch:{tag,orderId}}} per order]}. A hit, or a groupKey literally equal to the string 'nan', pushes to skippedBatches with reason 'Batch already exists' or 'Group key not found' and continues. groupKey = iscid || did || logId.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconBatchCreation.js:52-97`
- Timestamp assignment for reconstructed batches: if no iscid, 9:30 AM IST (= 04:00 UTC) of the CSV trade date. If an iscid already has a batch on that date, the new batch gets that batch's date + 5 minutes. Label: 'INVESTMORE' if iscid present, else 'BUY' if buyAmount>0 else 'MANAGE' — overridden by firstOrder.label from the dealer log when present.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconBatchCreation.js:136-141, 171-174, 215-237; sbiReconHelperFiles/sbiReconDependencies.js:105-109`

### recreation-api

- Recreation target is hardcoded: POST https://pf-utils-api.util.smallcase.com/api/user/investment/recreation with body {recreationFromDate:'2024-10-01', createEmpty:true, iscid, excludeBatchIds:[], update:true}, Authorization Bearer config.platformApiService.pfUtilsApiToken (env PF_UTILS_API_TOKEN, default ''), timeout 5000ms. Retries up to 3 times (4 attempts) with 500/1000/2000ms backoff on 5xx or on ECONNRESET/ECONNABORTED/ETIMEDOUT/ENOTFOUND/EAI_AGAIN or no-response; 401/403 and other non-5xx are NOT retried.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:11-17, 21-89, 111-132; config.js:341`

### date-defaults

- **!** --date semantics differ per job and this causes off-by-one-day hunts: sbiReconAllOrders defaults to `new Date().toISOString().split('T')[0]` (UTC today — before 05:30 IST this is YESTERDAY in IST). sbiRejectedAmoOrdersIngest defaults to IST-shifted today (now + 5.5h). markPartialStatuses parses --from/--to as IST day start. sbiReconAllOrders' ordersForTodayQuery window is `${date}T00:00:00.000Z` to +1 day, i.e. a UTC day, not an IST trading day.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:2-4; jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:4-8; scripts/adhoc/orders/sbi/markPartialStatuses.js:56-63; jobs/reconciliations/sbiReconAllOrders.js:1169-1171`

### mongo-debug-noise

- config.mongodb.debug is `process.env.MONGODB_DEBUG || true` — it defaults to TRUE and is truthy for any non-empty env value including the string 'false'. Mongoose query debug output is therefore on by default, flooding job logs with query lines. Expect high log volume per job run.  
  `config.js:28`

### duplicate-tag-detection

- validateDuplicateTags classifies a CSV tag two ways against DB legs sharing that tag: Case 1 (duplicateTags) = same brokeruserId but every DB orderId differs from the CSV orderId (and is not 'NA') -> SBI executed a second order under the same tag. Case 2 (differentBrokerUserIdTags) = some DB leg has a different brokeruserId -> tag collision across clients. Only Case 1 feeds reconcileDealerDoubleOrders.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconDealerDuplicate.js:6-93, 95-96`
- LIKELY BUG: reconcileDealerDoubleOrders matches batches with `duplicate.dbOrders.some(dbOrder => dbOrder.batchId === batch.batchId)`, but dbOrders[].batchId was populated from `batch._id.toString()` in validateDuplicateTags. Any batch whose `batchId` string field is absent or not identical to its stringified _id will not match, and the duplicate is silently dropped via the `if (!iscid || !latestBatch) continue;` branch with no log line. `[INFERRED]`  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconDealerDuplicate.js:20, 104-106, 126-128`

### silent-nothing

- **!** Complete list of ways an SBI job in this repo can appear to run and change nothing: (1) sbiReconAllOrders without --save — fix POST skipped, still logs success; (2) without --createMissingBatches / --createDealerDuplicateBatches — inserts skipped, counters still incremented; (3) without --recreateInvestment — recreation skipped after its request is logged; (4) empty tradebook because DB status already equals CSV status; (5) all CSV rows dropped by validateOrderFields (zero-fill orders); (6) S3 prefix empty -> throws and aborts before any work; (7) sbiMtfBackfillOrderMargins with neither flag; (8) cleanupMtfNonTerminalBatches without --save (honest); (9) sbiRejectedAmoOrdersIngest without --save (honest); (10) reconcileDealerDoubleOrders dropping a duplicate with no log when it cannot resolve an iscid.  
  `jobs/reconciliations/sbiReconAllOrders.js:114-116, 604-614, 1243-1248; sbiReconHelperFiles/sbiReconBatchCreation.js:177-186; sbiReconHelperFiles/sbiReconDealerDuplicate.js:126-128, 342-345; sbiReconHelperFiles/sbiReconDependencies.js:128-130; scripts/adhoc/orders/sbiMtfBackfillOrderMargins.js:550-553`

### exit-behaviour

- sbiReconAllOrders exits via process.exit(0) inside the sendReport email callback — the email send is what terminates the process. If sendReport's callback never fires, the job hangs. dbConnection.close() runs in the finally block BEFORE the async email callback resolves, so the DB connection is already closed when the process exits.  
  `jobs/reconciliations/sbiReconAllOrders.js:1395-1402, 1463-1466`
- **!** scheduler-agent logs a job's completion under the `scheduler-agent` envelope (not `jobs`): `{ 'scheduler-agent': { jobName, jobType: 'script', statusCode, duration } }` at info on exit code 0 or a killed child, at error otherwise, with the rejection reason 'Process exited with code: <n>'. jobName here is job.data.name = the FILENAME.  
  `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:116-147`


## Grep targets (89)

Search with `fetch-by-identifier.js --service <svc> --text "<string>"`.

| String | Means | Emitted by | Citation |
|---|---|---|---|
| `Batch updated successfully` | THE trap line. Emitted whether or not the fix API was actually called. Only proves a write when the adjacent 'Fix batch response' line carries a non-empty response. | fixBatchByTradebook, sbiReconAllOrders _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:612` |
| `Fix batch response` | Data carries {request:{url,body}, response, batchId}. If response is undefined/absent, the job ran WITHOUT --save and no HTTP call happened. This is the definitive dry-run-vs-real discriminator for sbiReconAllOrders. | fixBatchByTradebook, sbiReconAllOrders (and sbiDealerRecon.js / sbiUnplacedRecon.js, which always post) _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:610; jobs/reconciliations/sbiDealerRecon.js:181; jobs/reconciliations/sbiUnplacedRecon.js:94` |
| `Tradebook for batch` | Data {batchId, tradebook} — the exact legs recon intended to overwrite, with sid/orderId/exchangeOrderId/filledQuantity/averagePrice/status/tag/orderTimestamp. Logged BEFORE the save gate, so present in dry runs too. | fixBatchByTradebook, sbiReconAllOrders _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:601` |
| `Error in fixBatchByTradebook` | Fix API call failed. Data {batchId, error, response}. The function SWALLOWS this and returns the error object rather than throwing, so the caller's try/catch does NOT fire and the batch is still counted in successfulFixedOrders. | fixBatchByTradebook, sbiReconAllOrders _(lvl error (message in jobs.msg))_ | `jobs/reconciliations/sbiReconAllOrders.js:617-623` |
| `Skipping batch superseded by dummy order — broker update received for archived batch` | The ONLY per-batch skip guard in the fix loop. Data {batchId, label, iscid, supersededByDummyBatchId}. Note the em-dash. Means meta.supersededByDummyBatchId was set on the doc by another system. | main loop, sbiReconAllOrders _(lvl warn (message in jobs.msg))_ | `jobs/reconciliations/sbiReconAllOrders.js:1229-1234` |
| `No matching orders found, no reconciliation required` | Empty tradebook — either no CSV row matched any leg, or every matched leg already had the same status as the CSV. NOTE: this text sits in data.error; the log MESSAGE is the bare batchId string, so grep the batchId or this phrase, not a message prefix. | main loop, sbiReconAllOrders _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:1245-1248` |
| `Batch state before fix` | Full pre-fix snapshot: {batchId, label, orders:[{orderId,tag,status,quantity,averagePrice}], unplaced:[...]}. The best single artefact for reconstructing what a batch looked like before recon touched it. | main loop, sbiReconAllOrders _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:1252-1269` |
| `Batch state after fix` | Post-fix snapshot, re-read via models.Order.findById (PRIMARY, unlike the secondary reads elsewhere). Diff against 'Batch state before fix' to see exactly what changed. In a dry run these two are identical — another dry-run tell. | main loop, sbiReconAllOrders _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:1276, 1283-1300` |
| `No files found in S3 bucket for date:` | Thrown as an Error, so it surfaces as `Error in sbiReconAllOrders: No files found in S3 bucket for date: <YYYY-MM-DD>` plus a Slack alert. Means neither sbi_recon/<date>/ nor mtf_recon/<date>/ had any object — SBI did not deliver the file. Job did zero work. | readReconCSV, sbiReconAllOrders _(lvl error)_ | `jobs/reconciliations/sbiReconAllOrders.js:115, 1406` |
| `S3 files found` | Data {date, prefixes:['sbi_recon/<d>/','mtf_recon/<d>/'], counts:{sbi:N,'sbi-mtf':M}, fileCount, files:[keys]}. Tells you exactly which CSVs this run consumed — the starting point for 'was this order even in the file?'. | readReconCSV, sbiReconAllOrders _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:118-127` |
| `Completed processCSVContent` | Data {filename, totalOrders, failedOrders}. A large failedOrders count here is usually zero-fill orders being dropped by validateOrderFields, i.e. rejected SBI orders recon cannot see. | processCSVContent, sbiReconAllOrders _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:273-277` |
| `Completed readReconCSV from S3` | Data {totalOrders, uniqueTags, duplicateOrders, failedOrders} — the consolidated parse result across all files. | readReconCSV, sbiReconAllOrders _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:197-202` |
| `Error processing file ${file}:` | One S3 file blew up during download/parse; the run continues with the others and fires a Slack alert. Template literal — grep the constant prefix 'Error processing file'. | readReconCSV catch, sbiReconAllOrders _(lvl error)_ | `jobs/reconciliations/sbiReconAllOrders.js:180-186` |
| `Dealer orders fetched from secondary` | Data {count, date}. count is the number of Order docs matching the tag/brokeruserId query. count===0 means no DB batch shares any tag with the CSV — usually a tag-format or brokeruserId mismatch, not a missing order. | main, sbiReconAllOrders _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:1184` |
| `Fetching fresh orders after reconciliation` | Marks the boundary between the fix phase and the post-fix validation phase. Everything logged after this reflects post-fix state (read from a SECONDARY, so possibly lagged). | main, sbiReconAllOrders _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:1325` |
| `Fresh orders fetched after reconciliation` | Data {freshDealerOrdersCount, freshOrdersForTodayCount}. | main, sbiReconAllOrders _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:1332-1335` |
| `Error in sbiReconAllOrders:` | Top-level fatal for the recon job (template `Error in ${jobName}: ${error.message \|\| error}`). Also triggers a Slack alert and an error email. Everything after the throw point was skipped. | main catch, sbiReconAllOrders _(lvl error)_ | `jobs/reconciliations/sbiReconAllOrders.js:1406` |
| `Completed main reconciliation job successfully` | Clean end of the recon job. NOTE it is logged AFTER sendReport is invoked but the process actually exits inside sendReport's callback, so this line can be the last thing you see even on a successful run. | main, sbiReconAllOrders _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:1404` |
| `Recreation API request` | Data {batchId, url, body:{recreationFromDate,createEmpty,iscid,excludeBatchIds,update}}. LOGGED BEFORE the --recreateInvestment check, so its presence does NOT mean a call was made. Look for the paired 'Recreation API response' to confirm. | callRecreationAPI, sbiReconDependencies _(lvl info)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:122-126` |
| `Recreation API response` | Data {batchId, attempt, status, data}. Only present when --recreateInvestment was passed AND the POST succeeded. Its absence after 'Recreation API request' means the flag was off. | postRecreationWithRetry, sbiReconDependencies _(lvl info)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:59-64` |
| `Retrying recreation API` | Data {batchId, attempt, nextAttempt, delayMs, status, code, reason, message}. reason is one of 'http_5xx' \| 'network_error' \| 'no_response'. Max 4 attempts, delays 500/1000/2000ms. | postRecreationWithRetry, sbiReconDependencies _(lvl warn (message in jobs.msg))_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:75-84` |
| `Error calling recreation API` | Recreation failed terminally. Data {batchId, error, response}. Also appended to reportData.recreationAPIFailures which surfaces as the Slack counter 'Failed Recreation API Calls'. | callRecreationAPI, sbiReconDependencies _(lvl error)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:134-138` |
| `Created new batch for dealer double orders` | Data {batchId, iscid, orderCount, iteration}. EMITTED EVEN IN DRY RUN — the insert is gated on --createDealerDuplicateBatches but this log and the counter are not. | reconcileDealerDoubleOrders, sbiReconDealerDuplicate _(lvl info)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconDealerDuplicate.js:182-187, 342-345` |
| `Starting dealer double order reconciliation` | Data {duplicateTagsCount}. Beginning of the duplicate-tag repair phase. | reconcileDealerDoubleOrders, sbiReconDealerDuplicate _(lvl info)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconDealerDuplicate.js:96` |
| `Will create ${maxDuplicateCount} batches for iscid ${iscid}` | Template literal, grep 'batches for iscid'. Data {tagCounts, maxDuplicateCount}. One new batch per duplicate occurrence of the most-duplicated tag. | reconcileDealerDoubleOrders, sbiReconDealerDuplicate _(lvl info)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconDealerDuplicate.js:157-160` |
| `Batch already exists, skipping` | Idempotency hit in the dealer-duplicate path. Data {batchId (the EXISTING one), iscid}. Returns null so nothing is created or counted. | processDuplicateTagOrdersForIteration, sbiReconDealerDuplicate _(lvl info)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconDealerDuplicate.js:335-338` |
| `All duplicates for tag already processed, skipping` | Data {tag}. This iteration had no unconsumed duplicate left for that tag. | processDuplicateTagOrdersForIteration, sbiReconDealerDuplicate _(lvl info)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconDealerDuplicate.js:261` |
| `Duplicate tag found, skipping` | Data {tag}. The new batch already contains a leg with this tag. | processDuplicateTagOrdersForIteration, sbiReconDealerDuplicate _(lvl info)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconDealerDuplicate.js:251` |
| `Error processing duplicate tags for iscid` | Data {iscid, error}. Feeds the 'Dealer Double Order Failed Batches' Slack counter. | reconcileDealerDoubleOrders, sbiReconDealerDuplicate _(lvl error)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconDealerDuplicate.js:191-194` |
| `Error creating batch from logs` | Data {error, groupKey, orderCount}. The dealerOrderDownloadLogs-based reconstruction failed for one group; feeds 'Failed Batch Creations'. | createBatchesFromLogs, sbiReconBatchCreation _(lvl error)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconBatchCreation.js:189-193` |
| `Starting sendIngestionSlackReport` | Data {filename}. The report phase has begun; all fix work is already done by this point. | sendIngestionSlackReport, sbiReconReporting _(lvl info)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconReporting.js:43` |
| `Reconciliation Report:` | Data {markdownTable} — the ENTIRE Slack report body inline in the log. If Slack delivery failed you can still recover every counter from this one line. Same literal is used by sbiDealerRecon.js. | sendIngestionSlackReport, sbiReconReporting; and sbiDealerRecon.js _(lvl info)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconReporting.js:118; jobs/reconciliations/sbiDealerRecon.js:79` |
| `Error in SBI All Orders Reconciliation:` | Slack message text (not a log line) sent on fatal error, followed by 'Stack Trace:' and 'File:'. Posted to channel sbi-sec-integration-dev-team. | sendIngestionSlackReport error branch, sbiReconReporting _(lvl n/a (Slack))_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconReporting.js:33-36` |
| `Skipped Superseded Batches (Dummy Order Placed)` | Slack counter. When >0 the report also prints 'Superseded batch details (broker update received for archived batch, recreation skipped):' followed by 'batchId=<id> label=<l> iscid=<i> supersededBy=<id>' lines. | sendIngestionSlackReport, sbiReconReporting _(lvl n/a (Slack))_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconReporting.js:87-91` |
| `[DRY-RUN] Would call fix API` | sbiRejectedAmoOrdersIngest ran without --save. Data {url, body}. Unambiguous — this job is honest about dry runs. | fixBatch, sbiRejectedAmoOrdersIngest _(lvl info)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:261` |
| `[DRY-RUN] Would update statusMessage for already-rejected order` | Data {batchId, tag, arrayName, statusMessage}. The direct Mongo statusMessage write was skipped for lack of --save. | processBatchGroup, sbiRejectedAmoOrdersIngest _(lvl info)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:310` |
| `Skipping batch — not an AMO batch` | Data {batchId, variety}. sbiRejectedAmoOrdersIngest refuses anything where batch.variety !== 'amo'. Note the em-dash. | processBatchGroup, sbiRejectedAmoOrdersIngest _(lvl info)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:283-286` |
| `Skipping order — already COMPLETE in DB` | Data {batchId, tag, orderId}. SBI's rejection file names a leg we already have as filled — a genuine conflict worth escalating, not a benign skip. | processBatchGroup, sbiRejectedAmoOrdersIngest _(lvl info)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:295` |
| `Skipping order — partially filled in DB` | Data {batchId, tag, orderId, filledQuantity}. filledQuantity>0 so the job refuses to mark it REJECTED. | processBatchGroup, sbiRejectedAmoOrdersIngest _(lvl info)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:300` |
| `Successfully updated statusMessage for already-rejected order` | Data {batchId, tag, arrayName, statusMessage}. A REAL direct Mongo write happened (modifiedCount>0), setting statusMessage and errorCode on the leg. | saveStatusMessage, sbiRejectedAmoOrdersIngest _(lvl info)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:187` |
| `statusMessage already up to date, no change needed` | matchedCount>0 but modifiedCount===0 — the leg already had that exact statusMessage. | saveStatusMessage, sbiRejectedAmoOrdersIngest _(lvl info)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:185` |
| `statusMessage update matched no document` | matchedCount===0 — the {broker,brokeruserId,<array>.tag} filter found nothing. Usually the tag lives in the other array (orders vs unplaced) or brokeruserId differs. | saveStatusMessage, sbiRejectedAmoOrdersIngest _(lvl warn (message in jobs.msg))_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:191` |
| `No eligible orders to fix for batch` | Data {batchId}. Every CSV-matched leg in the batch was skipped (COMPLETE, partially filled, or already REJECTED-and-handled). | processBatchGroup, sbiRejectedAmoOrdersIngest _(lvl info)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:316` |
| `Batch not found in DB` | A CSV row's (brokeruserId, tag) matched no Order document at all — the AMO order exists at SBI but not at smallcase. | main, sbiRejectedAmoOrdersIngest _(lvl warn (message in jobs.msg))_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:528` |
| `No CSV files found in S3 for the given date` | Data {date, prefix}. Prefix is sbi_rejected_amo_orders/<date>/. SBI did not deliver a rejection file. | main, sbiRejectedAmoOrdersIngest _(lvl warn (message in jobs.msg))_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:500-502` |
| `CSV row has too few columns, skipping` | Data {filename, lineNumber, line}. Fewer than 8 comma-separated fields. | parseCSV, sbiRejectedAmoOrdersIngest _(lvl warn (message in jobs.msg))_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:83` |
| `CSV row has empty ORD_EXT_REF_NO, skipping` | Data {filename, lineNumber, brokeruserId}. Column 6 (the tag) was blank — the row cannot be matched to a leg. Sibling messages: 'CSV row has empty ORD_CLIENT_ID, skipping' and 'CSV row has empty ERROR_OR_REASON, skipping'. | parseCSV, sbiRejectedAmoOrdersIngest _(lvl warn (message in jobs.msg))_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:102, 116, 131` |
| `Skipping CSV header row` | Data {filename, header}. Confirms this job (unlike sbiReconAllOrders) drops line 1. | parseCSV, sbiRejectedAmoOrdersIngest _(lvl info)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:67-70` |
| `Failed to fix batch` | Data {batchId, error, stack}. The fix API returned non-success or threw. Feeds reportData.fixErrors. | processBatchGroup, sbiRejectedAmoOrdersIngest _(lvl error)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:329` |
| `DRY RUN MODE: No database changes will be made. Pass --save to apply.` | cleanupMtfNonTerminalBatches ran without --save. REMEMBER this job inverts logger args, so on most of its other lines the message is in jobs.data — but this one has no data object so it lands in jobs.info. | run, cleanupMtfNonTerminalBatches _(lvl info)_ | `jobs/cleanup/cleanupMtfNonTerminalBatches.js:49` |
| `[DRY RUN] Would mark batch as MARKEDCOMPLETE` | Paired with 'Marking batch as MARKEDCOMPLETE' for the --save case (ternary on the same call). Context object {batchId, iscid, currentStatus, userId, label} is in jobs.info because of the arg inversion. | run, cleanupMtfNonTerminalBatches _(lvl info)_ | `jobs/cleanup/cleanupMtfNonTerminalBatches.js:88-91` |
| `Marking batch as MARKEDCOMPLETE` | A REAL status write is about to happen for this MTF batch (--save was passed). | run, cleanupMtfNonTerminalBatches _(lvl info)_ | `jobs/cleanup/cleanupMtfNonTerminalBatches.js:90` |
| `Skipping: this is the latest batch for iscid` | The non-terminal batch is the newest for its iscid, so cleanup refuses to touch it. This is the main reason a genuinely stuck sbi-mtf batch is NOT cleaned up. | run, cleanupMtfNonTerminalBatches _(lvl info)_ | `jobs/cleanup/cleanupMtfNonTerminalBatches.js:77-80` |
| `Non-terminal MTF batches found` | Context {count, brokers} (in jobs.info due to inversion). The candidate pool before the latest-batch filter. | run, cleanupMtfNonTerminalBatches _(lvl info)_ | `jobs/cleanup/cleanupMtfNonTerminalBatches.js:62` |
| `Dry run complete. Re-run with --save to apply.` | Context {count, batchIds} — the full list of batchIds that WOULD have been marked MARKEDCOMPLETE. The single most useful line from a dry run of this job. | run, cleanupMtfNonTerminalBatches _(lvl info)_ | `jobs/cleanup/cleanupMtfNonTerminalBatches.js:117-119` |
| `Marked MARKEDCOMPLETE by cleanup job cleanupMtfNonTerminalBatches. Was in non-terminal state` | NOT a log line — this is the text written into meta.updates[].update ON THE ORDER DOCUMENT. Grep Mongo, not logs, for this to prove the cleanup job touched a batch. Full template: `Marked MARKEDCOMPLETE by cleanup job ${jobName}. Was in non-terminal state '${batch.status}' but is not the last batch for its iscid.` | run, cleanupMtfNonTerminalBatches (Mongo write) _(lvl n/a (DB field))_ | `jobs/cleanup/cleanupMtfNonTerminalBatches.js:99-103` |
| `No valid MTF brokers specified` | Context {given, valid}. --brokers contained nothing in MTF_BROKERS; job exits(1) having done nothing. | run, cleanupMtfNonTerminalBatches _(lvl error)_ | `jobs/cleanup/cleanupMtfNonTerminalBatches.js:41` |
| `Fatal error in cleanup job` | Context {err, message, stack}. Unhandled rejection from run(); exit code 1. | top-level catch, cleanupMtfNonTerminalBatches _(lvl error)_ | `jobs/cleanup/cleanupMtfNonTerminalBatches.js:125` |
| `reconInsert ` | NOT a log line — the meta.type value stamped on batches created from dealerOrderDownloadLogs. Full form `reconInsert YYYY-MM-DD` (note the space). Grep Mongo meta.type with /^reconInsert/ to find every batch sbiReconAllOrders fabricated, and which day's run did it. | createBatchesFromLogs, sbiReconBatchCreation (Mongo write) _(lvl n/a (DB field))_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconBatchCreation.js:145` |
| `_DuplicateDealerOrder` | NOT a log line — meta.type suffix on batches created by the dealer-duplicate path. Full form `${day}${MonShort}_DuplicateDealerOrder`, e.g. '3Feb_DuplicateDealerOrder', derived from --date. Grep Mongo meta.type with /_DuplicateDealerOrder$/. | getFormattedDateForMetaType, sbiReconDealerDuplicate (Mongo write) _(lvl n/a (DB field))_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconDealerDuplicate.js:219, 363-368` |
| `Adhoc fix: normalized duplicate ISCID for SBI/SBI-MTF double buy orders` | NOT a log line — meta.updates[].update text from fixDoubleBuy.js. Full template appends ` for iscid: <oldIscid> with label: <oldLabel>`. Accompanied by meta.sbiMtfDoubleBuyOrders=true and label rewritten to 'MANAGE'. | buildRepairOperations, scripts/adhoc/orders/sbi/fixDoubleBuy.js (Mongo write) _(lvl n/a (DB field))_ | `scripts/adhoc/orders/sbi/fixDoubleBuy.js:64, 315-318` |
| `meta.sbiMtfDoubleBuyOrders` | Boolean true stamped on any batch whose iscid was normalized by the SBI-MTF double-buy adhoc fix. Presence proves human adhoc intervention, not an automated job. | buildRepairOperations, scripts/adhoc/orders/sbi/fixDoubleBuy.js (Mongo write) _(lvl n/a (DB field))_ | `scripts/adhoc/orders/sbi/fixDoubleBuy.js:312` |
| `Starting targeted duplicate ISCID fix job` | Data {dryRun, save, totalEntries, batchLimit, logSampleSize}. fixDoubleBuy.js beginning; jobs.jobName will read 'fixDuplicateIscidsCopy', not the filename. | run, scripts/adhoc/orders/sbi/fixDoubleBuy.js _(lvl info)_ | `scripts/adhoc/orders/sbi/fixDoubleBuy.js:340-346` |
| `Starting markPartialStatuses job` | Data {brokers:['sbi','sbi-mtf'], from, to, fromUtc, toUtcExclusive, batchIdsCount, dryRun, save, limit, batchSize, collections:['Order','SSTOrder']}. The single best line for reconstructing exactly what this adhoc run targeted. | main, scripts/adhoc/orders/sbi/markPartialStatuses.js _(lvl info)_ | `scripts/adhoc/orders/sbi/markPartialStatuses.js:239-252` |
| `Fix preview` | Data {model, batchId, broker, date, ordersCount, ordersUpdated, oldBatchStatus, newBatchStatus:'PARTIALLYFILLED', dryRun, save}. Emitted for every candidate whether or not it is written. | processModel, scripts/adhoc/orders/sbi/markPartialStatuses.js _(lvl info)_ | `scripts/adhoc/orders/sbi/markPartialStatuses.js:185-191` |
| `Update result` | Data {model, batchId, acknowledged, matchedCount, modifiedCount, ordersUpdated, batchStatusUpdated}. Proof of an actual Mongo write by markPartialStatuses — only emitted when not dryRun. | processModel, scripts/adhoc/orders/sbi/markPartialStatuses.js _(lvl info)_ | `scripts/adhoc/orders/sbi/markPartialStatuses.js:212-220` |
| `Either --dryRun=true or --save=true must be specified` | Thrown by markPartialStatuses.js, fixDoubleBuy.js. Sibling: 'Specify only one of --dryRun or --save'. These two scripts are the only SBI mutators that REFUSE to run flagless. | validateInputs, markPartialStatuses.js / fixDoubleBuy.js _(lvl error)_ | `scripts/adhoc/orders/sbi/markPartialStatuses.js:81-86; scripts/adhoc/orders/sbi/fixDoubleBuy.js:207-212` |
| `Starting SBI MTF margin backfill adhoc script` | Data {dryRun, save, force, limit, from, to, ...}. Note both dryRun and save can be false here — the script runs and writes nothing while still logging per-batch 'Updated margin/product for batch'. | run, scripts/adhoc/orders/sbiMtfBackfillOrderMargins.js _(lvl info)_ | `scripts/adhoc/orders/sbiMtfBackfillOrderMargins.js:494-500` |
| `Updated margin/product for batch` | MISLEADING NAME. Data {batchId, dateKey, updatedOrderElements, marginElementsUpdated, productElementsUpdated, marginCsvKey}. Logged BEFORE the `if (!save) continue` gate, so it appears even when nothing is persisted. | run, scripts/adhoc/orders/sbiMtfBackfillOrderMargins.js _(lvl info)_ | `scripts/adhoc/orders/sbiMtfBackfillOrderMargins.js:540-548, 550-553` |
| `No margin CSV found for date` | Data {dateKey, prefix}. Prefix is mtf_security_margin/<YYYY-MM-DD>/ in sc-integrations-sbi-attachments. Margins for that day cannot be backfilled. | getCachedMarginMap, scripts/adhoc/orders/sbiMtfBackfillOrderMargins.js _(lvl warn (message in jobs.msg))_ | `scripts/adhoc/orders/sbiMtfBackfillOrderMargins.js:418` |
| `Failed to update batch with backfilled margins` | Data {batchId, error}. The Order.updateOne($set:{orders,unplaced}) threw. | persistBatchUpdate, scripts/adhoc/orders/sbiMtfBackfillOrderMargins.js _(lvl error)_ | `scripts/adhoc/orders/sbiMtfBackfillOrderMargins.js:477-480` |
| `No orders to reconcile` | Data {batchId}. sbiUnplacedRecon.js (which logs under jobName 'sbiDealerRecon') found no CSV tag matching any leg of this batch. | main, sbiUnplacedRecon.js _(lvl info)_ | `jobs/reconciliations/sbiUnplacedRecon.js:145` |
| `tag to order map created` | Data {tag2OrderMap, size}. Emitted by both sbiUnplacedRecon.js and sbiDealerRecon.js (both under jobName 'sbiDealerRecon'). | main, sbiUnplacedRecon.js / sbiDealerRecon.js _(lvl info)_ | `jobs/reconciliations/sbiUnplacedRecon.js:122; jobs/reconciliations/sbiDealerRecon.js:501` |
| `Reconciliation completed` | Data {fixedOrders, unfixedOrders, errorOrders} — arrays of batch _ids. Emitted by sbiUnplacedRecon.js and sbiDealerRecon.js. | main, sbiUnplacedRecon.js / sbiDealerRecon.js _(lvl info)_ | `jobs/reconciliations/sbiUnplacedRecon.js:157; jobs/reconciliations/sbiDealerRecon.js:537` |
| `Unconsumed orders` | Data {unconsumedOrders}. ONLY sbiDealerRecon.js emits this — use it to tell sbiDealerRecon.js apart from sbiUnplacedRecon.js, which shares its jobName. Paired with 'Validation results' and 'Validating yargs'. | main, sbiDealerRecon.js _(lvl info)_ | `jobs/reconciliations/sbiDealerRecon.js:538, 542, 489` |
| `filepath is required` | Thrown by both sbiUnplacedRecon.js and sbiDealerRecon.js when --filepath is missing; surfaces as `Error in sbiDealerRecon: filepath is required`. | main, sbiUnplacedRecon.js / sbiDealerRecon.js _(lvl error)_ | `jobs/reconciliations/sbiUnplacedRecon.js:115-117, 160; jobs/reconciliations/sbiDealerRecon.js:493` |
| `CSV read` | Data {filepath, csvString} — the ENTIRE CSV body inlined into the log. Present in sbiDealerRecon.js and sbiUnplacedRecon.js (not sbiReconAllOrders). Lets you recover the exact input file from logs alone. | readReconCSV, sbiDealerRecon.js / sbiUnplacedRecon.js _(lvl info)_ | `jobs/reconciliations/sbiDealerRecon.js:97; jobs/reconciliations/sbiUnplacedRecon.js:31` |
| `error while fixing batch` | Data {batchId, error, response}. sbiDealerRecon/sbiUnplacedRecon fix failure. Note logger.error(error, 'error while fixing batch', {...}) passes THREE args; the Logger only accepts two, so the third object is dropped and the string lands in jobs.data. | fixBatchByTradebook, sbiDealerRecon.js / sbiUnplacedRecon.js _(lvl error)_ | `jobs/reconciliations/sbiDealerRecon.js:190; jobs/reconciliations/sbiUnplacedRecon.js:103; utils/loggerHelper.js:26` |
| `Created test batch:` | generateTestBatches.js inserted a FAKE broker:'sbi' batch with brokeruserId 1002906895. Full template `Created test batch: ${batch.description}` with data {batchId}. Seeing this in a prod log means synthetic data was written to the orders collection. | main, jobs/reconciliations/generateTestBatches.js _(lvl info)_ | `jobs/reconciliations/generateTestBatches.js:261` |
| `[DRY RUN] Two-step batch requires recovery` | Data {batchId, broker, phase}. twoStepRebalanceReconcile ran without --save. phase is 'SELL_COMPLETE' or 'BUY_LEG'. | recover, jobs/sanity/twoStepRebalanceReconcile.js _(lvl info)_ | `jobs/sanity/twoStepRebalanceReconcile.js:35` |
| `Two-step recovery completed` | Data {scanned, failures, shouldSave}. failures is an array of batchIds. | run, jobs/sanity/twoStepRebalanceReconcile.js _(lvl info)_ | `jobs/sanity/twoStepRebalanceReconcile.js:68` |
| `scheduler-agent` | Top-level log key (sibling of 'jobs'). `{'scheduler-agent':{jobName, jobType:'script', statusCode, duration}}` at info on clean exit, at error otherwise. jobName here is the FILENAME (job.data.name), so this is how you correlate an S3 job-log object to a run duration and exit code. | runCliJob child exit handler, @smallcase/scheduler-agent _(lvl info / error)_ | `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:120-147` |
| `Process exited with code: ` | Bull job rejection reason when a job script exits non-zero and sent no structured _error message. | runCliJob child exit handler, @smallcase/scheduler-agent _(lvl n/a (rejection reason))_ | `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:137` |
| `Job ${job.data.name} will run on PID:` | Grep 'will run on PID' in the scheduler agent's own stdout to confirm a job was actually launched and get its pid. | runCliJob, @smallcase/scheduler-agent _(lvl n/a (console.log))_ | `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:71` |
| `running job sbiReconAllOrders with params:` | THE FIRST LINE of every sbiReconAllOrders run: `running job ${jobName} with params: ${JSON.stringify(yargs)}` — the JSON contains every CLI flag actually passed. This is the definitive way to learn whether --save / --createMissingBatches / --createDealerDuplicateBatches / --recreateInvestment were set for a given prod run. | module top-level, sbiReconAllOrders _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:4` |
| `Running job sbiRejectedAmoOrdersIngest` | First line of the AMO ingest, data {params:{date, save, filepath}} — capital R, unlike sbiReconAllOrders' lowercase 'running job'. Gives you the save flag directly. | module top-level, sbiRejectedAmoOrdersIngest _(lvl info)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:12-18` |
| `Order Rejected: ` | The statusMessage prefix written onto SBI legs by sbiRejectedAmoOrdersIngest (constant REJECTED_STATUS_MESSAGE_PREFIX). Full value is `Order Rejected: <ERROR_OR_REASON from CSV>`. Chosen so it matches broker-lib's SBI invalidOrder regex. Grep both logs and the Order document's orders[].statusMessage / unplaced[].statusMessage. | buildTradebookEntries / updateStatusMessage, sbiRejectedAmoOrdersIngest _(lvl n/a (DB field + log data))_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:41-43, 230, 242` |
| `Database connection opened, starting main job` | sbiReconAllOrders' Mongo connection is up and main() is about to run. If a run's log ends before this, the failure was in connection setup, not in recon logic. | dbConnection.once('open'), sbiReconAllOrders _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:1470` |
| `Closing database connection` | finally block of sbiReconAllOrders' main(). Note it runs BEFORE the email callback that calls process.exit(0). | main finally, sbiReconAllOrders _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:1464` |


## Corrections (13)

Where the old `SBI_LOG_INVESTIGATION_GUIDE.md`, or an obvious assumption, is provably wrong.


**Claimed:** SBI_LOG_INVESTIGATION_GUIDE.md §1.3.6 table (line 219): sbiReconAllOrders.js 'Always writes (no dry-run flag on the fix call itself); --recreateInvestment, --createMissingBatches, --createDealerDuplicateBatches gate sub-features'.

**Actually:** FLATLY WRONG AND THE MOST DANGEROUS ERROR IN THE GUIDE. The fix POST is gated on `yargs.save`: `let res = {}; if (yargs.save) { res = await axios.post(url, body, {...}) }`. With no --save, NO HTTP call is made and NOTHING is written — yet the job still logs 'Batch updated successfully' because the success test is `if (!yargs.save || (res && res.data && res.data.success))`. An investigator following the guide would conclude a batch was fixed when it was not. The gate is original to the job's first commit (adaf7941), not a recent change.

`jobs/reconciliations/sbiReconAllOrders.js:592-614`


**Claimed:** Research brief / common assumption: sbiReconAllOrders has 'a terminal-state list that makes it skip a batch'.

**Actually:** There is no such skip. `orderTerminalStates = ['COMPLETED','FIXED','MARKEDCOMPLETE','CANCELLED']` is referenced in exactly four places, all reporting: the const, isTerminalStatus(), and two calls inside checkTerminalStatusChanges() which merely records terminal->terminal transitions into reportData.terminalStatusChanges. A batch already in COMPLETED or MARKEDCOMPLETE IS still passed to getFixTradebook and CAN be overwritten (the fix body sets force:true). The only real skip is `batch.meta.supersededByDummyBatchId`.

`jobs/reconciliations/sbiReconAllOrders.js:31-36, 533, 536-553, 598, 1227-1242`


**Claimed:** Guide line 221: 'sbiDealerRecon3Feb2025.js (predecessor) hardcodes every parsed row to status:\'REJECTED\' regardless of actual CSV content (// check the complete enum for order status — unresolved TODO); current sbiDealerRecon.js maps T->COMPLETE correctly'.

**Actually:** Wrong file attributed. sbiDealerRecon3Feb2025.js parses no CSV status at all — it reads a local file and synthesizes batches with status:'PLACED'. The file that hardcodes `status: 'REJECTED'` with the comment `// check the complete enum for order status` is jobs/reconciliations/sbiUnplacedRecon.js:52-53. Also, sbiDealerRecon.js maps `parts[9] === 'T' ? 'COMPLETE' : 'PENDING'` — PENDING, not REJECTED — and carries the same stale TODO comment.

`jobs/reconciliations/sbiUnplacedRecon.js:52-53; jobs/reconciliations/sbiDealerRecon.js:121-122; jobs/reconciliations/sbiDealerRecon3Feb2025.js:314-315, 361`


**Claimed:** Guide lines 300 and 519 cite 'JOBS/jobs/sanity/cleanupMtfNonTerminalBatches.js:26'.

**Actually:** Wrong path. The file is jobs/cleanup/cleanupMtfNonTerminalBatches.js. jobs/sanity/ contains no such file and contains no SBI-mutating job at all. The line number (26 for NON_TERMINAL_STATES) is correct.

`jobs/cleanup/cleanupMtfNonTerminalBatches.js:26; ls jobs/sanity/`


**Claimed:** Guide line 511: 'Research found no cron/scheduler wiring for any of them' (sbiReconAllOrders, sbiDealerRecon, sbiRejectedAmoOrdersIngest) — i.e. the recon jobs are manual-only.

**Actually:** They ARE run by a scheduler. The repo's entry point is bootstrap-agent.js: `require('@smallcase/scheduler-agent').init()`, and scheduler-agent's runCliJob forks each job file with job.data.args and uploads its stdout to S3. The guide contradicts itself: its own §3.3 (line 737) correctly describes the same scheduler-agent. What is genuinely unknown is WHICH flags each scheduled run passes, since job.data lives in the scheduler's Bull/Redis config, not in this repo.

`bootstrap-agent.js:1-2; package.json:20 ('@smallcase/scheduler-agent': '^2.2.0'); node_modules/@smallcase/scheduler-agent/utils/job-runner.js:36-92`


**Claimed:** Implicit assumption throughout the guide that a job's per-invocation S3 log object contains everything the job printed.

**Actually:** Only stdout is uploaded. `child.stdout.pipe(zlib.createGzip()).pipe(upload)` — child.stderr goes only to the Redis pub/sub stream and the parent's stderr. Anything on stderr (console.error, node's uncaught-exception trace) is MISSING from the per-run S3 object. Since Bunyan writes to process.stdout, logger.error IS captured; raw console.error is not.

`node_modules/@smallcase/scheduler-agent/utils/job-runner.js:92, 113-114; node_modules/@smallcase/sc-integrations-babel/src/logger/logger.js:35-38`


**Claimed:** Obvious assumption that logger.error / logger.warn messages are greppable in the same field as logger.info.

**Actually:** They are not. logger.info puts the message in `jobs.info`; logger.error and logger.warn put it in `jobs.msg` (with `jobs.stack`). A filter on jobs.info misses every error and warning. Separately, cleanupMtfNonTerminalBatches.js calls the logger with arguments reversed (`logger.info(obj, 'message')`), so for THAT job the message string lands in `jobs.data` and the context object in `jobs.info`.

`utils/loggerHelper.js:14-50; jobs/cleanup/cleanupMtfNonTerminalBatches.js:46, 62, 77-80, 88-91, 115, 118`


**Claimed:** Guide line 219 implies sbiReconAllOrders can fix any discrepancy found in the SBI CSV.

**Actually:** It structurally cannot fix a never-traded order. validateOrderFields drops any row with averagePrice <= 0 or NaN, and column 5 is the weighted average TRADE price, which is empty for an order with no trades. Rejected/cancelled/zero-fill SBI orders are discarded at parse time into failedOrders and never reach the matching or tradebook stages. Separately, getFixTradebook only emits an entry when the CSV status differs from the DB status, so quantity, filledQuantity and price mismatches are reported but never repaired.

`jobs/reconciliations/sbiReconAllOrders.js:46-73, 255-264, 556-589 (esp. 573)`


**Claimed:** Guide line 220-222 implies createMissingBatches / createDealerDuplicateBatches behave like honest dry-run flags (nothing reported when off).

**Actually:** Both report phantom work when off. createBatchesFromLogs gates only `insertOne` on --createMissingBatches but pushes into `createdBatches` unconditionally two lines later; processDuplicateTagOrdersForIteration gates only `insertOne` on --createDealerDuplicateBatches but still returns the batch so it is counted and logged as 'Created new batch for dealer double orders'. The Slack counters 'Created Missing Batches' and 'Dealer Double Order Created Batches' are therefore not evidence of writes, and recreateInvestmentsForIscids is subsequently called against batchIds that do not exist in Mongo.

`jobs/reconciliations/sbiReconHelperFiles/sbiReconBatchCreation.js:177-186; jobs/reconciliations/sbiReconHelperFiles/sbiReconDealerDuplicate.js:174-188, 342-345; jobs/reconciliations/sbiReconAllOrders.js:1201-1207, 1348`


**Claimed:** The field name `isin` in sbiReconAllOrders (and any reader assuming CSV column 6 holds an ISIN).

**Actually:** Column 6 (ORD_SEM_SMST_SECURITY_ID) holds the NSE symbol with an 'EQ' series suffix — real prod values in the checked-in sample are 'PNBEQ', 'WIPROEQ', 'COHANCEEQ'. The code stores it as `order.isin` and then does `.slice(0,-2)` to recover the tradingsymbol. Nothing in this pipeline handles an INE-prefixed ISIN; the dealer match key is `${tag}|${brokeruserId}|${symbolWithoutEQ}`.

`jobs/reconciliations/sbiReconAllOrders.js:246, 315, 334; jobs/reconciliations/sbi_all.csv:1-2`


**Claimed:** Guide line 221 groups sbiDealerRecon.js with sbiReconAllOrders as if their dry-run and scope behaviour matched.

**Actually:** They differ on three axes. (a) sbiDealerRecon.js and sbiUnplacedRecon.js have NO --save gate — they always POST the fix API (timeout 3000ms vs sbiReconAllOrders' 9000ms). (b) Their Mongo query is `broker: 'sbi'` only — sbi-mtf batches are never touched, whereas sbiReconAllOrders uses `{$in:['sbi','sbi-mtf']}`. (c) They read from a DIFFERENT bucket: config.jobs.sbiIngestUpdates.orderBookS3Bucket (env SBI_ORDERBOOK_BUCKET, default 'smallcase-trash'), not sbiAllOrdersS3Bucket.

`jobs/reconciliations/sbiDealerRecon.js:86-97, 169-193, 505-510; jobs/reconciliations/sbiUnplacedRecon.js:23-27, 83-106, 125-132; jobs/reconciliations/sbiReconAllOrders.js:1160, 604-609; config.js:298-299`


**Claimed:** Reasonable assumption that markBatchesAsUnfilled.js ('markDealerBatchesAsUnfilledEOD') is part of the SBI EOD cleanup path.

**Actually:** It never touches SBI. Its query is `{status:'ERROR', date:{$lte:new Date()}, broker:{$in:['axis','hdfc','hdfc-mtf']}, dealer:true}`. It also has no --save gate and POSTs the fix API with an empty tradebook and force:true. Do not chase it for an SBI or SBI-MTF order.

`jobs/reconciliations/markBatchesAsUnfilled.js:17-27, 35-46`


**Claimed:** Assumption that a job's S3 log key and the jobName inside its log lines identify the same thing.

**Actually:** They disagree for many jobs, because the S3 key uses job.data.name (the physical filename) while log bodies use the file's internal `jobName` const. Confirmed SBI-relevant mismatches: sbiUnplacedRecon.js -> 'sbiDealerRecon' (collides with the real sbiDealerRecon.js); markBatchesAsUnfilled.js -> 'markDealerBatchesAsUnfilledEOD'; scripts/adhoc/orders/sbi/fixDoubleBuy.js -> 'fixDuplicateIscidsCopy'; scripts/adhoc/orders/sbi/rerunsbiautosip.js -> 'placeSbiAutosips'; scripts/adhoc/orders/markBatchAsError.js -> 'markBatchToError'; scripts/adhoc/users/sbiInvalidScidsFix.js -> 'fixInvalidScidsAndArchiveSIPs'; jobs/activations/sbi/ingestUsers.js AND jobs/activations/sbiV2/ingestUsers.js BOTH -> 'sbiActivation'; jobs/autosips/sbi/createSbiAutosipOrders.js AND createSBIAutosipOrders-NonWorkingDay.js BOTH -> 'placeSbiAutosips'. sbiReconAllOrders.js is NOT affected.

`automated basename-vs-jobName scan across jobs/ and scripts/; jobs/reconciliations/sbiUnplacedRecon.js:1; jobs/reconciliations/markBatchesAsUnfilled.js:2; scripts/adhoc/orders/sbi/fixDoubleBuy.js:30; scripts/adhoc/orders/markBatchAsError.js:1; node_modules/@smallcase/scheduler-agent/utils/job-runner.js:76`


## Open questions (10)

Genuinely unresolved. Report these as unknown rather than guessing.

- WHICH CLI FLAGS DO THE SCHEDULED PROD RUNS ACTUALLY PASS? This is the single highest-value unknown. job.data.args lives in the scheduler-agent's Bull/Redis job config, not in this repo, so source alone cannot tell you whether the nightly sbiReconAllOrders run includes --save, --createMissingBatches, --createDealerDuplicateBatches or --recreateInvestment. Resolve it empirically from a real S3 job log: the first line `running job sbiReconAllOrders with params: {...}` contains the parsed yargs object verbatim. Until that is checked, treat every sbiReconAllOrders fix as UNPROVEN.
- The guide (§3.3) reports a second live job config named 'sbiReconAllOrders-batchCreation' pointing at the same file with different flags. Not verifiable from this repo. If it exists, it is almost certainly the --createMissingBatches / --createDealerDuplicateBatches variant, and the plain 'sbiReconAllOrders' run is probably the --save one — but this is a guess. Confirm by comparing the 'running job ... with params' line across both S3 key prefixes.
- Who WRITES meta.supersededByDummyBatchId? Nothing in sc-integrations-jobs sets it — the field is only read (sbiReconAllOrders.js:1228) and rendered in reports. The writer is presumably sc-integrations-order-updates or sc-platform-api. Needed to explain why a batch gets archived in favour of a dummy batch.
- Which service writes the CSVs into s3://<sbiAllOrdersS3Bucket>/sbi_recon/<date>/, mtf_recon/<date>/ and sbi_rejected_amo_orders/<date>/? No job in this repo calls putFileToS3 for any SBI prefix (only kotakErrorOrderReconciliation.js and aspOfflineCompute.js write to S3 at all). Delivery is external — SBI-side SFTP/upload or another repo. Unconfirmed.
- Does the `orders` collection use 'COMPLETE' or 'COMPLETED' on the BATCH document vs the LEG? Observed usage in this repo is consistent (batch.status uses COMPLETED/PARTIALLYFILLED/UNFILLED/MARKEDCOMPLETE/FIXED/CANCELLED/ERROR/PLACED; leg.status uses COMPLETE/REJECTED/PARTIAL/PLACED/ACKED/ERROR) but no schema file is present in this repo — the Order model comes from @smallcase/sc-integrations-babel and @smallcase/sc-platform-babel. Verify against the babel package before writing a query.
- REQUIRED_FIELDS[8] in sbiReconAllOrders is named 'REPLACE(UPPER(ORD_REMARKS||ORD_EXT_REF_NO)' implying SBI uppercases the tag in its SQL export, but the real checked-in sample sbi_all.csv contains mixed-case tags ('sc_Wektwsk1z'). Either the constant is stale or the export changed. If SBI ever does start uppercasing, every tag match in this job breaks silently (tags are compared with === throughout). Unconfirmed which is current.
- sbiReconAllOrders reads from a Mongo SECONDARY (readPreference:'secondary' plus explicit .read('secondary')) for both the pre-fix and the post-fix 'fresh' queries, while the per-batch post-fix re-read uses models.Order.findById (primary). How much replication lag exists in prod, and therefore how many post-fix mismatch counters are false positives, is unmeasured.
- Suspected bug, not proven at runtime: reconcileDealerDoubleOrders matches candidate batches with `dbOrder.batchId === batch.batchId` where dbOrder.batchId came from `batch._id.toString()`. If any Order doc has a missing or divergent `batchId` string field, its duplicate is dropped with no log line at all (the `if (!iscid || !latestBatch) continue` branch is silent). Worth a Mongo check for sbi/sbi-mtf docs where batchId != _id.toString().
- No test coverage exists for any SBI recon job — tests/ contains only angelbroking, amoPoll and brokerAsServiceFunds. Any behaviour described here is unguarded by CI.
- config.mongodb.debug is `process.env.MONGODB_DEBUG || true`, which is truthy even when the env var is the string 'false'. Whether mongoose query debug is genuinely on in prod (and thus how noisy job logs are) depends on how the deployment sets that var; not determinable from source.
