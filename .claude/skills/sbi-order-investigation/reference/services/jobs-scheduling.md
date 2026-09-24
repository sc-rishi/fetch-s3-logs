# jobs-scheduling

sc-integrations-jobs — AMO poll, AutoSIP, activations, and how job logs reach S3.

**branch when read:** production (HEAD 5bd80bd034be5e8d8a8bfb112d8d7494a723ee98, 2026-09-18 15:50:36 +0530). NOTE: the installed node_modules are feature-branch prereleases that do NOT satisfy package.json — @smallcase/sc-integrations-broker-lib 16.11.13-rebalance-in-amo.0 (package.json wants ^16.11.14), @smallcase/sc-platform-babel 6.3.1-rebalance-in-amo.0 (wants ^6.1.1), @smallcase/sc-integrations-babel 6.3.3-rebalance-in-amo.1 (wants ^6.3.2). Only @smallcase/scheduler-agent 2.2.0 matches its range (^2.2.0). Any fact sourced from node_modules other than scheduler-agent is from a feature build, not necessarily prod.

sc-integrations-jobs is the batch/cron arm of smallcase's broker integrations. For SBI it owns four things an investigator cares about: (1) AMO polling — the job that wakes up after market open and asks order-updates/BB to re-poll yesterday-evening's AMO batches; (2) AutoSIP order creation for SBI (SBI-MTF has NO autosip job at all); (3) SBI activation user ingestion and activation order placement (BUY/FIX); (4) the SBI/SBI-MTF recon jobs that read broker CSVs from S3 and call /errors/fix to reconcile batches. Critically, this repo contains NO cron expressions and NO job registry — every schedule lives in the external scheduler service (SCHEDULER_HOST) as Bull repeatable jobs; the repo only ships bootstrap-agent.js, which starts @smallcase/scheduler-agent to receive POST /jobs and fork the named script. That same agent is what captures each run's stdout, gzips it, and writes one object to s3://sc-prod-logs/sc-integrations-jobs/<jobName>_<bullJobId> — so the per-run log surface is one gzip blob per invocation with no .gz extension and no gzip metadata, and stderr is NOT in it. Almost all date arithmetic in these jobs uses server-local or raw-UTC Date constructors rather than IST, so "today" means different things in different jobs and off-by-one-day errors around 00:00–05:30 IST are a real, provable failure mode.

Confidence markers are the researcher's own: unmarked = confirmed from source, `[INFERRED]` = deduced but unproven, `[UNCONFIRMED]` = a lead, not a fact. `!` marks facts flagged critical. Re-verify line numbers against the checked-out SHA.


## Facts (96)


### scheduling-where-it-lives

- **!** There are NO cron expressions, no jobsConfig, and no job registry anywhere in this repo. An exhaustive grep for /cron|repeat.*(every|interval)/i across all .js/.md/.json/.yml (excluding node_modules) returns exactly one hit: a comment. Therefore a TIMETABLE cannot be produced from this repo — schedules live in the external scheduler service.  
  `jobs/sanity/stalePriceAlert.js:1`
- **!** Schedules are held by a separate scheduler service reached at config.scheduler.host = process.env.SCHEDULER_HOST (default 'http://127.0.0.1:8104'), authenticated with process.env.SCHEDULER_TOKEN sent as the 'x-jwt' header. Staging value observed: https://scheduler.stag.smallcase.com. To get real cron times you must query that service (or its Bull/Redis backing store at SCHEDULER_REDIS_HOST / SCHEDULER_REDIS_PORT), not this repo.  
  `config.js:42-45`
- Scheduler Redis (the Bull queue that holds repeatable-job definitions) is configured separately from the app Redis: SCHEDULER_REDIS_HOST / SCHEDULER_REDIS_PORT / SCHEDULER_REDIS_AUTH, with an optional sentinel via SCHEDULER_REDIS_SENTINEL_CONNECTION_STRING and REDIS_SENTINEL_ENABLED_FOR_SCHEDULER.  
  `node_modules/@smallcase/scheduler-agent/config.js:24-46`

### scheduling-agent

- The repo's entrypoint for scheduled execution is bootstrap-agent.js, which is two lines: `require('@smallcase/scheduler-agent').init()`. Nothing else in the repo starts a scheduler.  
  `bootstrap-agent.js:1-2`
- On init the agent registers itself with the scheduler (POST ${SCHEDULER_HOST}/agent with instanceId, agentTag, repoName, instanceIp, port), receives a token back, then fetches GET ${SCHEDULER_HOST}/config/paths to learn where each repo and each repo's env file live on disk. config.paths.repo[<repo>] + job.data.path is the script that gets forked.  
  `node_modules/@smallcase/scheduler-agent/index.js:21-31; node_modules/@smallcase/scheduler-agent/utils/agent.js:5-26; node_modules/@smallcase/scheduler-agent/utils/job-runner.js:37-43`
- The agent exposes an HTTP API on AGENT_PORT (default 8109; staging env sets 8105): POST /jobs runs a job, DELETE /jobs/:jobId kills it (kill -9 on the recorded child PID), GET /healthCheck returns 200. A job can therefore be force-killed mid-run by an operator, leaving a truncated S3 log object.  
  `node_modules/@smallcase/scheduler-agent/api/index.js:7-27; node_modules/@smallcase/scheduler-agent/utils/job-runner.js:187-202; node_modules/@smallcase/scheduler-agent/config.js:11`
- **!** Jobs are forked with childProcess.fork(filePath, job.data.args, { silent: true, env }) when job.data.cmd is absent or 'node'. job.data.args is how --date / --save / --parallelism style flags reach the script — those args come from the scheduler's job definition, NOT from this repo.  
  `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:58-70`
- **!** If job.data.killInterval is set, the agent SIGINTs the child after killInterval MINUTES and resolves the job as successful. A long-running SBI job (e.g. a 5800-SIP autosip run) that hits this limit will look like a clean completion to the scheduler while its S3 log just stops mid-stream.  
  `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:102-109`
- The child process env is built ONLY from the repo's env file (parsed by envParser) plus DEPLOYMENT_GROUP_NAME, HOME and PATH. NODE_ENV is not injected by the agent. So `config.deployment` (= DEPLOYMENT_GROUP_NAME) is the environment discriminator inside jobs, not NODE_ENV.  
  `node_modules/@smallcase/scheduler-agent/utils/envParser.js:56-70; config.js:7`

### scheduling-trigger-chain

- **!** A job can trigger another job: services.triggerSchedulerJob(jobName, logger) does GET ${SCHEDULER_HOST}/run/<jobName> with the x-jwt header. For SBI this is used exactly once — sbiRebalanceSipOrderPlace triggers 'placeSbiAutosips'.  
  `services/index.js:348-362; jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js:258-263`
- **!** That chaining is gated by a STRING comparison: `if (runAutoSipJob === 'true')`. The yargs default is boolean false (`getArgv({ runAutoSipJob: false })`), so a boolean-true flag will not satisfy it — the arg must arrive as the literal string 'true'. If it does not, the job logs 'Skipping Auto SIP job as runAutoSipJob is false' and placeSbiAutosips never runs from this path.  
  `jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js:3-7,258-264`

### s3-job-logs

- **!** The S3 key for a job run is exactly `job.data.repo + '/' + job.data.name + '_' + job.id` — i.e. <repo>/<jobName>_<bullJobId>. job.data.name is the scheduler's name for the job, which need NOT equal the jobName constant inside the script.  
  `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:74-77`
- **!** The bucket is config.aws.logsUploadBucket = process.env.SCHEDULER_LOGS_BUCKET, defaulting to 'smallcase-trash' when the env var is unset.  
  `node_modules/@smallcase/scheduler-agent/config.js:54; node_modules/@smallcase/scheduler-agent/utils/job-runner.js:75`
- **!** Prod bucket is sc-prod-logs and the prefix is sc-integrations-jobs/. Proven from the IAM policy in a sibling repo: 'arn:aws:s3:::sc-prod-logs/sc-integrations-jobs/*' is granted s3:GetObject/ListBucket to the sc_integrations_dev and sc_integrations_senior_dev SSO roles.  
  `/Users/rishidatta/Desktop/integrations/sc-infra-cdk-prod-sso/src/constructs/policies/sc_integrations_dev.ts:76; /Users/rishidatta/Desktop/integrations/sc-infra-cdk-prod-sso/src/constructs/policies/sc_integrations_senior_dev.ts:87`
- A SECOND prod prefix exists for job logs: 'arn:aws:s3:::sc-prod-logs/integration-jobs/*' (no 'sc-' prefix, singular 'integration') is granted alongside sc-integrations-jobs/ in the senior-dev policy. If a job's scheduler config carries repo='integration-jobs', its logs land there instead — worth listing both prefixes when a job's object cannot be found.  
  `/Users/rishidatta/Desktop/integrations/sc-infra-cdk-prod-sso/src/constructs/policies/sc_integrations_senior_dev.ts:87-88`
- Staging bucket is sc-stag-logs, from the checked-in staging env file (`export SCHEDULER_LOGS_BUCKET=sc-stag-logs`). Same file sets AGENT_PORT=8105 and SCHEDULER_HOST=https://scheduler.stag.smallcase.com.  
  `.staging_sc-integrations-jobs (SCHEDULER_LOGS_BUCKET / AGENT_PORT / SCHEDULER_HOST lines)`
- **!** Only stdout reaches S3: `child.stdout && child.stdout.pipe(zlib.createGzip()).pipe(upload)`. stderr is piped to the Redis pub/sub stream and to the agent's own process.stderr, never to the S3 object. An uncaught exception's stack trace printed to stderr will therefore be ABSENT from the S3 log — look for it in the agent/PM2 logs instead.  
  `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:91,98-99,114-115`
- **!** The upload destination params are only { Bucket, Key } — no ContentEncoding, no ContentType, no .gz suffix. The object is gzip bytes with no metadata declaring it, so any fetcher must force gunzip rather than sniff ContentEncoding.  
  `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:74-79`
- The comment above the upload reads '//upload logs only when in production and critical' but there is NO condition guarding it — the s3Stream.upload() and the gzip pipe run for every CLI job in every environment. The comment is stale.  
  `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:73-91`
- Every job's stdout is ALSO mirrored into a Redis pub/sub channel named after job.id (RedisPubSubStream with channel: job.id), carrying BOTH stdout and stderr. This is the live-tail surface; it is ephemeral and not queryable after the fact.  
  `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:93-99`
- On child exit the agent logs a structured line under the key 'scheduler-agent' with { jobName, jobType: 'script', statusCode: <exit code>, duration: <seconds> } — info on success (exit 0 or killed), error otherwise. This is emitted by the AGENT process, so it is in the agent's logs, not in the job's own S3 object.  
  `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:117-149`

### job-logging-format

- **!** Jobs log through utils/loggerHelper.js, a thin wrapper over bunyan obtained from @smallcase/sc-integrations-babel. Every call wraps the payload as { jobs: { jobName, info|msg, [stack], data } }. So the greppable envelope in every line is "jobs":{"jobName":"<name>" and the human message is in jobs.info (for .info) or jobs.msg (for .error/.warn).  
  `utils/loggerHelper.js:14-58`
- **!** Because logger.info({jobs:{...}}) is called with an object and no message string, bunyan sets the top-level "msg" field to the empty string. Grepping on "msg" for job log text will find nothing — grep jobs.info / jobs.msg instead. `[INFERRED]`  
  `utils/loggerHelper.js:16-22; node_modules/@smallcase/sc-integrations-babel/src/logger/logger.js:50-54`
- The bunyan logger name on every line is `sc.service.${process.env.APPLICATION_NAME || <basename of the dir containing config.js>}`. On a standard deploy to /deployments/sc-integrations-jobs that resolves to "name":"sc.service.sc-integrations-jobs".  
  `config.js:9-14,17; appspec.yml:4-6`
- **!** Bunyan level is hard-set to 'info' in config.logger.level. logger.debug(...) output therefore never appears in prod S3 job logs unless a job constructs `new Logger(name, true)`. Only ONE job in the repo does that (aspOfflineCompute, via --debug); every SBI job passes only the name.  
  `config.js:11; utils/loggerHelper.js:7-10,52-58; jobs/reconciliations/aspOfflineCompute.js:16`
- Bunyan writes to TWO streams: process.stdout (level from config.stdoutLevel, default 'info') and, whenever config.logger.env !== 'local', a rotating file at /deployments/logs/sclogs_<APPLICATION_NAME>, period 1d, count 2. The S3 object captures only the stdout copy.  
  `node_modules/@smallcase/sc-integrations-babel/src/logger/logger.js:33-57; config.js:12-13`
- **!** Some jobs call the logger bunyan-style with (object, message) — e.g. logger.info({ batchId, iscid, currentStatus }, 'Marking batch as MARKEDCOMPLETE'). The wrapper's signature is (info, data), so the OBJECT lands in jobs.info and the MESSAGE STRING lands in jobs.data. For these files, grep jobs.data for the message text. Known offenders: cleanupMtfNonTerminalBatches.js and markBatchesAsUnfilled.js.  
  `utils/loggerHelper.js:14-24; jobs/cleanup/cleanupMtfNonTerminalBatches.js:46,62,77-80,88-91,115; jobs/reconciliations/markBatchesAsUnfilled.js:80`

### job-name-collisions

- **!** The jobName tag inside logs collides across files. 'placeSbiAutosips' is used by BOTH jobs/autosips/sbi/createSbiAutosipOrders.js and jobs/autosips/sbi/createSBIAutosipOrders-NonWorkingDay.js. 'sbiActivation' is used by BOTH jobs/activations/sbi/ingestUsers.js and jobs/activations/sbiV2/ingestUsers.js. 'sbiDealerRecon' is used by BOTH jobs/reconciliations/sbiDealerRecon.js and jobs/reconciliations/sbiUnplacedRecon.js. 'amoPoll' is used by triggerAmoPoll.js, triggerAmoPollNonMarketDay.js and triggerAmoPollKite.js. Identify the producing job by the S3 key filename, never by the jobName field.  
  `jobs/autosips/sbi/createSbiAutosipOrders.js:2; jobs/autosips/sbi/createSBIAutosipOrders-NonWorkingDay.js:2; jobs/activations/sbi/ingestUsers.js:1; jobs/activations/sbiV2/ingestUsers.js:3; jobs/reconciliations/sbiDealerRecon.js:1; jobs/reconciliations/sbiUnplacedRecon.js:1; jobs/triggerAmoPoll.js:7; jobs/triggerAmoPollNonMarketDay.js:12; jobs/triggerAmoPollKite.js:7`

### amo-poll-brokers

- **!** triggerAmoPoll builds its broker list as Object.keys(config.brokers).filter(b => brokerLib[b] && brokerLib[b].config && brokerLib[b].config.amoAllowed).concat(['sbi','sbi-mtf']). Evaluated against the installed lib this yields: kite, leprechaun, hdfc, axis, kite-leprechaun, hdfc-leprechaun, kotak-leprechaun, axis-leprechaun, groww, paytm, icici, kotak, dhan, fisdom, upstox, sbi, sbi, sbi-mtf. Note 'sbi' appears twice (harmless in a $in) and 'sbi-mtf' is present ONLY because of the hardcoded concat.  
  `jobs/triggerAmoPoll.js:106-113; config.js:53-135`
- 'sbi-mtf' is NOT a key of config.brokers (config.brokers has sbi but no sbi-mtf), which is why the hardcoded .concat(['sbi','sbi-mtf']) is required for MTF to be polled at all. 'axis-mtf' IS a config.brokers key but its broker-lib config has amoAllowed falsy, so axis-mtf is never AMO-polled — a useful contrast when someone asks why SBI-MTF behaves unlike the other MTF brokers.  
  `config.js:71-83,125-133; jobs/triggerAmoPoll.js:108-112`

### amo-poll-activated

- **!** CONFIRMED: the activated-order exception list is ['sbi','axis'] — sbi-mtf is NOT in it. The query clause is: $or: [ { activated: { $ne: true } }, { activated: true, broker: { $in: ['sbi','axis'] } } ]. Consequence: an SBI-MTF order with activated:true is never picked up by triggerAmoPoll, no matter its status.  
  `jobs/triggerAmoPoll.js:80-90`

### amo-poll-query

- **!** triggerAmoPoll only considers batches whose status is one of PLACED, PARTIALLYPLACED, ERROR. Anything already in a terminal state (COMPLETED, UNFILLED, MARKEDCOMPLETE, CANCELLED, FIXED) is untouched.  
  `jobs/triggerAmoPoll.js:67-74`
- **!** AMO eligibility is: (variety === 'amo' AND date in range) OR (meta.twoStep.buyLegMechanism in ['AMO','REBALANCE_SIP'] AND meta.twoStep.buyLegPlacedAt in range). Two-step rebalance-SIP buy legs are therefore polled by the same job even though their variety may not be 'amo'.  
  `services/amoPoll.js:1-14; jobs/triggerAmoPoll.js:79`

### amo-poll-window

- **!** The AMO date window is { $gte: lastMarketClose, $lte: todayMarketOpen } where lastMarketClose = new Date(lastActiveDay.getFullYear(), month, date, 10, 0, 0) and todayMarketOpen = new Date(today..., 3, 30, 0) IN PRODUCTION ONLY; in non-production todayMarketOpen is `new Date()` (now). These are LOCAL-time constructors — on a UTC server 10:00 = 15:30 IST (market close) and 03:30 = 09:00 IST. On a non-UTC server the window silently shifts.  
  `jobs/triggerAmoPoll.js:62-65`
- **!** An order placed AFTER 09:00 IST on the current day falls outside todayMarketOpen and will not be polled by triggerAmoPoll that day — one of the commonest reasons a 'hanging' SBI AMO order is never picked up. `[INFERRED]`  
  `jobs/triggerAmoPoll.js:62-65,79`
- **!** triggerAmoPoll refuses to run on a non-working day: if (!babel.activeDays.isWorkingDay(date)) it logs the error 'AMO polling skipped as it's not a working day.' and REJECTS, which propagates to handleFailure → process.exit(1). The job therefore exits non-zero on holidays and its S3 object contains only that error.  
  `jobs/triggerAmoPoll.js:57-61,122-126`

### amo-poll-action

- **!** For each matched order, pollOrdersStream branches on status. If status === 'ERROR' it calls GET ${BB_SERVICE_HOST}/errors/fix/<batchId> with header x-request-source: sc-integrations-jobs (no body, no force). Otherwise it refreshes the broker session and calls GET ${BB_SERVICE_HOST}/orders/poll/<batchId>?accessToken=... (or produces a Kafka ORDER_amoPoll event when --kafka is passed).  
  `services/index.js:305-338,120-142,144-155`
- triggerAmoPoll runs TWO streams in parallel — Order (normal) and SSTOrder — via Promise.all([processOrdersStream(false), processOrdersStream(true)]). SST batches poll ${BB_SERVICE_HOST}/sst/orders/poll/<batchId>.  
  `jobs/triggerAmoPoll.js:48,52-54; services/index.js:125-126`
- Kafka mode is OFF by default: argv default { kafka: false }. Without --kafka the job uses the HTTP BB path and never connects to Kafka at all (init() resolves immediately).  
  `jobs/triggerAmoPoll.js:18-21,25-41,93`

### amo-poll-nonmarketday

- **!** triggerAmoPollNonMarketDay.js is the muhurat/working-weekend variant. Its getAmoAllowedBrokers has NO .concat(['sbi','sbi-mtf']) — it returns only config.brokers keys with amoAllowed, i.e. sbi IS included (sbi has amoAllowed:true in broker-lib) but sbi-mtf is NOT included at all.  
  `jobs/triggerAmoPollNonMarketDay.js:90-100; node_modules/@smallcase/sc-integrations-broker-lib/src/brokers/sbi-mtf/config.js:77`
- **!** triggerAmoPollNonMarketDay hard-filters `activated: { $ne: true }` with no SBI exception, so ACTIVATED SBI orders are never polled on a muhurat/exception trading day. It also has no upper date bound ({ $gte: lastMarketClose } only) and always uses Kafka (ORDER_amoPoll), never the HTTP BB path. Its working-day check is commented out.  
  `jobs/triggerAmoPollNonMarketDay.js:46-70,102-108`

### manual-poll

- **!** jobs/triggerManualPoll.js is the operator's re-poll hammer. Flags: --broker (required), --date (YYYY-MM-DD, defaults to today, then setHours(0,0,0,0) LOCAL), --batchIds (comma separated), --sessionless, --forcePlaced, --lock. --forcePlaced MUTATES the DB: any order/SSTOrder not already PLACED is rewritten to status PLACED with a recordUpdate audit line 'forcePlaced: status changed from <old> to PLACED via triggerManualPoll'. --lock writes Redis key BB:lock:<batchId> = 'lock' with 300s TTL.  
  `jobs/triggerManualPoll.js:41-49,56-65,90-117`
- triggerManualPoll reads the access token from Redis hash AT:<userId>, picking the entry with the highest expireAt. It uses console.log/console.error throughout, NOT the bunyan logger, so its S3 object contains plain unstructured lines with no jobs.jobName envelope.  
  `jobs/triggerManualPoll.js:14-36,55,65,88,95,131,135`

### autosip-sbi-coverage

- **!** SBI-MTF has NO autosip job. Every SBI autosip job queries `'broker.name': 'sbi'` literally — createSbiAutosipOrders.js, createSBIAutosipOrders-NonWorkingDay.js and createSbiAutosipOrdersByIscids.js all do. sbiRebalanceSipOrderPlace.js likewise sets `const brokerName = 'sbi'`.  
  `jobs/autosips/sbi/createSbiAutosipOrders.js:133-139; jobs/autosips/sbi/createSBIAutosipOrders-NonWorkingDay.js:134-140; jobs/autosips/sbi/createSbiAutosipOrdersByIscids.js:241-245; jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js:27`

### autosip-sbi-main

- **!** jobs/autosips/sbi/createSbiAutosipOrders.js (jobName 'placeSbiAutosips') is the main daily SBI autosip job. Query: { type:'SHARES', 'broker.name':'sbi', scheduledDate: { $lte: date }, $or: [ { sipFailedCount: { $lt: THRESHOLD } }, { sipFailedCount: { $exists: false } } ] }. THRESHOLD = config.autosip.maxConsecutiveFailures (env AUTOSIP_MAX_CONSECUTIVE_FAILURES, default 6). Optional --userId narrows to one user. Processes with eachAsync({ parallel: --parallelism, default 10 }).  
  `jobs/autosips/sbi/createSbiAutosipOrders.js:2,10-15,132-154,315-320; config.js:370-376`
- **!** Per SIP the job: getUser → getCurrentIscid → build batch { label:'AUTOSIP', variety:'amo', orders from sipDoc.sharesConfig with transactionType 'BUY', exchange 'NSE' } → encode a dummy SBI access token → holdFunds (funds check) → platformApi prePlaceOrder → orderUpdatesService.placeOrders → update Sip dates. It never calls the broker directly for placement; placement is POST ${BB_SERVICE_HOST}/orders/place.  
  `jobs/autosips/sbi/createSbiAutosipOrders.js:60-94,105-125,171-305; services/orderUpdatesService.js:4-19,22-69`
- **!** The dummy access token for SBI autosip is broker.sbi.api.Misc.encodeAccessToken({ accessToken: 'dummy_autosip_token', userId: user.broker.userId, dealerId: '', nriFlag }) where nriFlag is '3' for iscid.flags.nri === 'NRE', '2' for 'NRO', else '0'. (The NonWorkingDay variant hardcodes nriFlag '0' — an NRI bug in that variant.)  
  `jobs/autosips/sbi/createSbiAutosipOrders.js:261-268; jobs/autosips/sbi/createSBIAutosipOrders-NonWorkingDay.js:196-201`
- **!** DESTRUCTIVE PATH: when the iscid is already PLACED and the latest batch has originalLabel 'AUTOSIP' and status ERROR or PLACED, the job force-unlocks and re-places — POST ${BB_SERVICE_HOST}/errors/fix/<latestBatchId> with body { force: true, fixBy: 'unlocking' }, DELETEs Redis key API:SCL:<userId>:<scid>, calls platformApi archiveBatch, and then places a brand-new AUTOSIP batch. This is how a SIP can double-place if the PLACED batch was genuinely live at the broker.  
  `jobs/autosips/sbi/createSbiAutosipOrders.js:182-244`
- **!** If the latest batch's label is 'REBALANCE', the job does NOT place — it rolls scheduledDate forward AND does $inc: { sipFailedCount: 1 }. Six such days in a row (default THRESHOLD 6) silently drop the SIP out of the query entirely, and cancelFailedAutosipsEod will then archive it.  
  `jobs/autosips/sbi/createSbiAutosipOrders.js:223-233,145-149; jobs/autosips/cancelFailedAutosipsEod.js:248-260`
- **!** SILENT-FAILURE MODE: createSbiAutosipOrders calls activeDays.initCalender(async () => {...}) WITHOUT an err parameter, discarding the calendar-load error. If the Holidays fetch fails, fullCalender stays empty, isWorkingDay() returns false for every date, and the job logs only 'Auto Sip place orders postponed to next working day' and exits having placed ZERO SIPs — indistinguishable in the log from a genuine holiday.  
  `jobs/autosips/sbi/createSbiAutosipOrders.js:528-556; node_modules/@smallcase/sc-platform-babel/activeDays/activeDays.js:63-115,165-190`

### autosip-sbi-nonworkingday

- **!** createSBIAutosipOrders-NonWorkingDay.js shares jobName 'placeSbiAutosips' but has NO working-day check at all (it runs straight off dbConnection.once('open')), NO sipFailedCount threshold in its query, parallel:1 instead of 10, and hardcodes nriFlag '0'. On an already-PLACED iscid it simply rolls scheduledDate forward and never re-places.  
  `jobs/autosips/sbi/createSBIAutosipOrders-NonWorkingDay.js:2,134-140,159,170-180,196-201,248,346-359`

### autosip-sbi-byiscids

- createSbiAutosipOrdersByIscids.js (jobName 'placeSbiAutosipsByIscids') is a backfill/repair tool with a LITERAL HARDCODED LIST of iscid ObjectIds baked into the source (hundreds of entries starting at line 31). It is not schedule-driven in any useful sense — whoever runs it edits the array. Flags: --iscids, --debug, --parallelism (default 10).  
  `jobs/autosips/sbi/createSbiAutosipOrdersByIscids.js:2,10-14,31-130,241-249`

### autosip-sbi-rebalance

- **!** sbiRebalanceSipOrderPlace.js (jobName 'sbiRebalanceSipOrderPlace') processes RebalanceSip docs where { broker:'sbi', active:true, status:'CREATED', 'config.scheduledDate': { $lte: date-at-UTC-midnight } }. Statuses: CREATED, PROCESSING, EXECUTED, ERROR, INITIALIZED, DELETED, CANCELLED. It marks CREATED→PROCESSING first for idempotency, then places a batch with label 'FIX', originalLabel 'REBALANCE', variety 'amo', autoSip: true. It SKIPS entirely on a non-working day.  
  `jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js:1,55-63,124-137,148-167,330-352`
- **!** Two-step rebalance SIPs take a different path: processTwoStepSip picks the batch's BUY orders with status 'ACKED', runs fundsService.checkFundsWithBrokerage, then calls orderUpdatesService.placeTwoStepBuyLeg → POST ${BB_SERVICE_HOST}/orders/twostep/buy-leg with { batchId, variety:'REBALANCE_SIP', accessToken }. Success (or status 'SKIPPED') sets the RebalanceSip to EXECUTED + active:false; failure sets ERROR + active:false.  
  `jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js:294-330; services/orderUpdatesService.js:119-128`

### autosip-eod-cancel

- **!** cancelFailedAutosipsEod.js archives SIPs with sipFailedCount >= THRESHOLD for brokers in config.autosip.enableForBrokers (env AUTOSIP_ENABLE_FOR_BROKERS, default 'axis,kotak,sbi,kite' — sbi IS included, sbi-mtf is NOT). It calls platformApiService.archiveSip(sip.iscid). For kite it also deletes the SIP at the broker first; SBI has no broker-side deletion.  
  `jobs/autosips/cancelFailedAutosipsEod.js:2,241-315; config.js:370-376; services/platformApiService.js:6,329-355`
- **!** cancelFailedAutosipsEod's working-day guard is COMMENTED OUT (lines 243-246), so it runs on holidays too. The file has also been repurposed as an ad-hoc tool: it carries a hardcoded `reconciliationEvents` array of Kite order payloads and four mutually exclusive modes selected by flags — --publishEvents, --printEnv [--envName], --getAccessToken --userId, else runCancellation(). --printEnv without --envName logs the ENTIRE process.env.  
  `jobs/autosips/cancelFailedAutosipsEod.js:43-89,241-246,317-347`

### config-autosip

- config.autosip.eodCutoffTime (env AUTOSIP_EOD_CUTOFF_TIME, default '16:00') is declared in config.js but a repo-wide grep finds NO consumer. It is dead config — do not reason about autosip EOD timing from it.  
  `config.js:372`

### activation-sbi-ingest

- **!** Two SBI activation ingestion jobs share jobName 'sbiActivation'. v1 (jobs/activations/sbi/ingestUsers.js) hits ${SBI_ACTIVATION_BASE_URL}/api/v1/Smallcase_CGS/GetOrderCountData then .../FetchDataFromSmallcaseDetails and writes Activation docs with meta.apiVersion 'v1'. v2 (jobs/activations/sbiV2/ingestUsers.js) hits ${SBI_ACTIVATION_V2_BASE_URL}/KycKraApi/api/v1/smallcaseCallback/GetOrderCountData and .../FetchDataFromSmallcaseDetails and writes meta.apiVersion 'v2'. Order PLACEMENT for both still uses the v1 setup (stated in the v2 file's header comment).  
  `jobs/activations/sbi/ingestUsers.js:1,39,94,333-335; jobs/activations/sbiV2/ingestUsers.js:1-3,41,96,336; config.js:125-131`
- **!** Ticker→sid resolution during ingest reads Redis key SYMBOL2SID:ticker.nse:<Ticker>. If missing, the job logs 'sid not found for ticker' with { ticker } and throws — the whole user's activation row is skipped. Activation docs are keyed on { 'broker.userId', 'broker.name':'sbi', scid } and carry processed:false, attempt:0, sip: (SipSet === 'True').  
  `jobs/activations/sbi/ingestUsers.js:141-154,314-342`

### activation-sbi-place

- **!** jobs/activations/sbi/placeActivatedOrders.js (jobName 'placeSbiActivatedOrders') selects { processed:false, 'broker.name':'sbi', attempt: { $lt: maxOrderRetry }, createdAt: { $lte: activationDate } }. maxOrderRetry comes from the Mongo Config doc with key 'sbi_activation' (.value.maxAttempts) — an operator can change retry behaviour by editing that document, with no deploy.  
  `jobs/activations/sbi/placeActivatedOrders.js:1,74-90`
- **!** The activation cutoff is computed as `date.setDate(date.getDate() - 3)` then `activationDate.setUTCHours(18,30,0,0)` — i.e. 3 CALENDAR days back, then 18:30 UTC = 00:00 IST of the following day. The surrounding JSDoc says 'go back 3 working days' and the inline comment says 'workingDays'; the code does no working-day arithmetic at all. After a long weekend the effective wait is shorter in trading days than the doc claims.  
  `jobs/activations/sbi/placeActivatedOrders.js:51-63,76-78`
- **!** Branch logic per activation: iscid INVALID + shouldFixBatch(latestBatch, batches) → label FIX; iscid VALID → mark Activation processed:true and count as success without placing; iscid PLACED → skip, count into skippedAlreadyPlaced, log 'iscid: <id> is already in placed status'; no iscid but scid in exitedSmallcases → mark processed and skip; no iscid and no smallcase doc → fail with 'Invalid activation document: Smallcase not found'; otherwise → label BUY.  
  `jobs/activations/sbi/placeActivatedOrders.js:126-193; jobs/activations/common.js:6-22,36-47`
- **!** shouldFixBatch returns true only when the latest batch's status is one of UNPLACED / PARTIALLYFILLED / UNFILLED AND some batch in the iscid's history has activated===true, batchId===latestBatch.originalBatchId and label==='BUY'. Otherwise the job logs "won't fix batch" and does nothing.  
  `jobs/activations/common.js:36-47; jobs/activations/sbi/placeActivatedOrders.js:135-146`
- The attempt counter is incremented on BOTH success and failure of a placement (`$inc: { attempt: 1 }` in both branches of handleOrderPlacement), so a repeatedly-succeeding-then-failing activation burns through maxAttempts either way.  
  `jobs/activations/sbi/placeActivatedOrders.js:225-237`
- **!** Run metrics are persisted to the raw Mongo collection 'integrations-activationMetrics' as { broker:'sbi', date, success, failures, total, failureList:[{ userId(=brokeruserId), scid, status, userIngestionDate }] }. This is a queryable audit trail of every activation run's failures, independent of the S3 logs.  
  `jobs/activations/sbi/placeActivatedOrders.js:728-742; jobs/activations/common.js:49-55`
- calculateFunds for SBI activation sums prices from Redis hash QTS:<sid>, field = 'sbi' if broker-lib's sbi config has pricesAvailable, else 'kite'. It sums PRICE PER SHARE and ignores quantity — the funds figure logged as 'funds required before adding buffer' is not a real order value.  
  `jobs/activations/sbi/placeActivatedOrders.js:366-388`

### reports-sbi-external

- **!** Two jobs email SBI directly. createSbiAutosipOrders sends 'Daily SBI SIP Orders Summary for <d MMM yyyy>' with six counters: totalScheduled, skippedAlreadyPlaced, triggerFailed, apiTriggered, successfullyPlaced, unsuccessful. placeActivatedOrders sends 'Daily SBI Activation Orders Summary for <d MMM yyyy>' with the same six shapes. Recipients come from the Mongo Config doc key 'sbi_activation_autosip_report_emails' (.value array joined by comma), falling back to a hardcoded list including risk.backoffice@sbicapsec.com.  
  `jobs/autosips/sbi/createSbiAutosipOrders.js:443-498; jobs/activations/sbi/placeActivatedOrders.js:580-635`
- **!** The 'successfullyPlaced'/'unsuccessful' counters in those SBI emails are NOT in-process counters — they are Mongo countDocuments run immediately after placement over an IST day window: autosip counts { broker:'sbi', label:'AUTOSIP', date in [IST today 00:00, IST tomorrow 00:00) } split by status in [PLACED,PARTIALLYPLACED] vs [ERROR,UNPLACED]; activation counts the same window with { activated:true, label: { $in: ['BUY','FIX'] } }. They include batches placed by OTHER jobs in the same window, and exclude batches whose status changes later.  
  `jobs/autosips/sbi/createSbiAutosipOrders.js:332-345; jobs/activations/sbi/placeActivatedOrders.js:694-707`
- **!** jobs/reports/sbiActivationAutosipReport.js (jobName 'sbiActivationAutosipReport') is a THIRD, standalone report: 'Daily SIP & Activation Orders Summary for <Do MMM YYYY>' with just two numbers — Order.countDocuments({ label:'AUTOSIP', broker:'sbi', date in IST-day }) and Order.countDocuments({ activated:true, broker:'sbi', date in IST-day }). It skips entirely on non-working days. Same Config email key.  
  `jobs/reports/sbiActivationAutosipReport.js:3,16-18,45-95,154-182,341-352`

### reports-internal-email

- All internal job emails go to integrations-reports@smallcase.com in production (bcc qa@smallcase.com), from '"Integration Jobs" <notifications@smallcase.com>'. The subject prefix is '' in production and '<deployment> | ' elsewhere, so a production subject begins with a LEADING SPACE, e.g. ' SBI Auto Sip Orders Placement Report Mon Sep 22 2025'.  
  `services/emailService.js:38-40,44-46,64-70; jobs/autosips/sbi/createSbiAutosipOrders.js:413-427`

### reports-slack-sbi-alert

- **!** A dedicated SBI AMO alert fires from the hanging-orders Slack message when (sbi dealer + sbi nonDealer hanging AMO) / (total sbi AMO batches) * 100 exceeds config.brokers.sbi.SBI_AMO_PERCENTAGE_THRESHOLD (env SBI_AMO_PERCENTAGE_THRESHOLD, default '10'). Message text: '*@channel SBI ALERT:* AMO hanging orders. (*Hanging*: N, *Total*: M, *Percentage*: P%)'. The totalAMO denominator is computed by databaseSanityChecks as countDocuments({ date: <amo window>, variety:'amo', broker:'sbi' }).  
  `services/slackService.js:277-293; jobs/sanity/databaseSanityChecks.js:114-131; config.js:132`

### reports-hanging-eod

- **!** jobs/sanity/hangingOrderEodReport.js (jobName 'hangingOrderEodReport') defines hanging as status in [ERROR, PLACED, PARTIALLYPLACED]. Regular window: yesterday local 18:30 → now-1min, variety != 'amo'. AMO window: last active day local 10:30 → today local 03:30, variety == 'amo'. On a UTC server those are 00:00 IST → now, and 16:00 IST(prev trading day) → 09:00 IST. It exits(0) on non-working days via activeDayCheck.  
  `jobs/sanity/hangingOrderEodReport.js:1,19-27,120-132,150-180,204-206; utils/activeDayCheck.js:3-12`
- **!** databaseSanityChecks suppresses AMO alerts until 50 minutes after market open: amoSettledTime = activeDays.marketHours().start + 50min, and shouldSkipAMO = now < amoSettledTime. marketHours() returns local 03:45 → 10:00, i.e. 09:15–15:30 IST on a UTC server, so AMO alerts start around 10:05 IST.  
  `jobs/sanity/databaseSanityChecks.js:277-283; node_modules/@smallcase/sc-platform-babel/activeDays/activeDays.js:434-451`

### recon-timing

- **!** sbiReconAllOrders reads broker CSVs from S3 bucket config.jobs.sbiIngestUpdates.sbiAllOrdersS3Bucket (env SBI_ALL_ORDERS_S3_BUCKET, default 'sc-integrations-sbi-attachments') under TWO prefixes for the run date: `sbi_recon/<YYYY-MM-DD>/` and `mtf_recon/<YYYY-MM-DD>/`. If both list empty it throws 'No files found in S3 bucket for date: <date>'. Listing those prefixes is the direct way to answer 'has the SBI file even arrived today?'.  
  `jobs/reconciliations/sbiReconAllOrders.js:86-116; config.js:297-301`
- **!** sbiReconAllOrders' default date is `new Date().toISOString().split('T')[0]` — the UTC date, with NO IST adjustment. Any run between 00:00 and 05:30 IST therefore defaults to YESTERDAY's IST date and will read the previous day's recon prefix. By contrast sbiRejectedAmoOrdersIngest adds 5.5h before taking the date. The two SBI recon jobs disagree about what 'today' means.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:1-4; jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:3-8`
- **!** sbiReconAllOrders' DB comparison window is startDate = new Date(yargs.date + 'T00:00:00.000Z') to +1 day, i.e. a UTC day, applied to { broker: { $in: ['sbi','sbi-mtf'] }, date: {...} } with read preference 'secondary'. Orders placed between 00:00 and 05:30 IST fall into the previous UTC day and are outside the window.  
  `jobs/reconciliations/sbiReconAllOrders.js:1169-1183`

### recon-write-gates

- **!** sbiReconAllOrders writes nothing unless explicitly flagged. --save gates the actual POST to /errors/fix (without it the job logs the intended tradebook and then treats it as success). --createMissingBatches gates the direct insertOne into the raw 'orders' collection. --recreateInvestment gates the pf-utils recreation API. --createDealerDuplicateBatches gates dealer-double batch creation.  
  `jobs/reconciliations/sbiReconAllOrders.js:604-614; jobs/reconciliations/sbiReconHelperFiles/sbiReconBatchCreation.js:176-179; jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:128-131; jobs/reconciliations/sbiReconHelperFiles/sbiReconDealerDuplicate.js:342`
- **!** When it does write, sbiReconAllOrders calls POST ${BB_SERVICE_HOST}/errors/fix/<batchId> with body { fixBy: 'orderbook', tradebook: [...], force: true } and a 9000ms timeout, header x-request-source: sc-integrations-jobs. The tradebook entries carry { sid, orderId, exchangeOrderId, filledQuantity, averagePrice, status, tag, orderTimestamp } and are built ONLY for orders whose CSV status differs from the DB status.  
  `jobs/reconciliations/sbiReconAllOrders.js:556-616`

### recon-csv-format

- **!** The SBI recon CSV has exactly 13 columns in this order: ORD_BUY_SELL_IND, ORD_QTY_ORIGINAL, ORD_CLIENT_ID, ORD_ORDER_NO, SUM(ORD_TRD_TRADE_QTY*ORD_TRD_TRADE_PRICE)/SUM(ORD_TRD_TRADE_QTY), ORD_SEM_SMST_SECURITY_ID, TRUNC(ORD_TRD_TRADE_TIME), SUM(ORD_TRD_TRADE_QTY), REPLACE(UPPER(ORD_REMARKS||ORD_EXT_REF_NO), ORD_STATUS, ORD_EXCH_ORDER_NO, ORD_SOURCE_FLG. Any row whose field count differs is dropped with 'Invalid number of fields'. Mapping: index 0 'B'→BUY else SELL, 2→brokeruserId, 3→orderId, 5→isin, 8→tag, 9 'T'→COMPLETE else REJECTED.  
  `jobs/reconciliations/sbiReconAllOrders.js:14-28,229-253`
- **!** Dealer orders are matched on the composite key `${tag}|${brokeruserId}|${tradingsymbol}` where tradingsymbol is derived from the CSV ISIN by stripping the last TWO characters (isin.slice(0,-2)). Non-dealer orders are matched on orderId alone. A batch counts as dealer when batch.dealer === true OR the order has no orderId or orderId === 'NA'.  
  `jobs/reconciliations/sbiReconAllOrders.js:38-44,285-301,315-319`

### recon-rejected-amo

- **!** sbiRejectedAmoOrdersIngest reads s3://<SBI_ALL_ORDERS_S3_BUCKET>/sbi_rejected_amo_orders/<YYYY-MM-DD>/ (IST-adjusted date). Columns used: index 0 ORD_CLIENT_ID→brokeruserId, index 6 ORD_EXT_REF_NO→tag, index 7 ERROR_OR_REASON→statusMessage. It prefixes every message with 'Order Rejected: ' so it matches the SBI broker config's invalidOrder regex, and derives errorCode via brokerConfig.getErrorCode({ statusMessage }). It targets brokers ['sbi','sbi-mtf'] and is DRY-RUN by default — --save is required for any write.  
  `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:3-8,31-43,169-196,255-270`

### recon-dealer-logs

- **!** When recon finds a CSV order with no matching batch, it looks it up in the raw Mongo collection 'dealerOrderDownloadLogs' filtered by { broker: { $in: ['sbi','sbi-mtf'] }, 'payload.dealerOrders.tag': { $in: <missing tags> } }. A hit yields dealerId, userId, payload.iscid, payload.scid, payload.smallcaseName, payload.did, payload.label — and (under --createMissingBatches) a synthetic batch is inserted directly into the 'orders' collection with status 'COMPLETED', dealer: true, source 'PROFESSIONAL', tier 'BASIC'.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconBatchCreation.js:6-48,140-179`

### recon-slack

- SBI recon Slack goes to channel 'sbi-sec-integration-dev-team' via config.slack.notificationHook (env SBI_SEC_INTEGRATION_NOTIFICATION_HOOK), always appending 'cc: <@U08ACEVT78B> <@U08JL7VEWQM> <@U08JL7NM961> <@U07U2NK2E86>'. The recon email subject is 'SBI All Orders Reconciliation Report' to integrations-reports@smallcase.com in prod.  
  `jobs/reconciliations/sbiReconHelperFiles/sbiReconReporting.js:6-9,632-634,769-786; jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:33-34; config.js:384-388`

### mtf-cleanup

- **!** jobs/cleanup/cleanupMtfNonTerminalBatches.js is the only job that specifically fixes SBI-MTF batches. It takes every batch with broker in ['axis-mtf','sbi-mtf','hdfc-mtf','axis-mtf-leprechaun','sbi-mtf-leprechaun','hdfc-mtf-leprechaun'] and status in [UNPLACED, UNFILLED, PARTIALLYFILLED], skips the one that is the LATEST batch for its iscid, and (only with --save) sets the rest to status 'MARKEDCOMPLETE' plus a meta.updates entry.  
  `jobs/cleanup/cleanupMtfNonTerminalBatches.js:1-11,26,53-107`
- **!** The audit line cleanupMtfNonTerminalBatches pushes into meta.updates is the exact string: `Marked MARKEDCOMPLETE by cleanup job cleanupMtfNonTerminalBatches. Was in non-terminal state '<oldStatus>' but is not the last batch for its iscid.` — a definitive fingerprint for 'who changed this SBI-MTF batch to MARKEDCOMPLETE'.  
  `jobs/cleanup/cleanupMtfNonTerminalBatches.js:98-104`

### who-can-write

- **!** markDealerBatchesAsUnfilledEOD (jobs/reconciliations/markBatchesAsUnfilled.js) does NOT touch SBI. Its query is hardcoded to broker: { $in: ['axis','hdfc','hdfc-mtf'] }, dealer: true, status: 'ERROR'. Do not attribute an SBI batch's status change to this job.  
  `jobs/reconciliations/markBatchesAsUnfilled.js:1,16-26`

### ist-vs-utc

- **!** Three different date conventions coexist in this repo. (a) LOCAL-time constructors — new Date(y, m, d, 3, 30, 0) / setHours(18,30,0,0) — used by triggerAmoPoll, hangingOrderEodReport, databaseSanityChecks and sc-platform-babel's marketHours/lastActiveDay; correct only if the server TZ is UTC. (b) RAW UTC — setUTCHours(0,0,0,0) / toISOString().split('T')[0] — used by autosip argv defaults, sbiReconAllOrders and utils/lib.js updateSipDates. (c) EXPLICIT IST via moment.tz('Asia/Kolkata') — used only by the report counters and sbiActivationAutosipReport.  
  `jobs/triggerAmoPoll.js:62-64; jobs/sanity/hangingOrderEodReport.js:120-128,150-166; jobs/autosips/sbi/createSbiAutosipOrders.js:13,334-336; utils/lib.js:21-22; jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:2-4; jobs/reports/sbiActivationAutosipReport.js:24-37`
- **!** activeDays.isWorkingDay normalises the input with setUTCHours(0,0,0,0) but the in-memory calendar is built with LOCAL-midnight Date objects (new Date(year, 0, 1, 0, 0, 0, 0)) and compared by exact getTime(). The two agree only when the server timezone is UTC; on any other TZ every isWorkingDay() lookup misses and returns false.  
  `node_modules/@smallcase/sc-platform-babel/activeDays/activeDays.js:82-112,165-190,125-132`
- **!** The trading calendar is loaded from the Mongo 'Holidays' collection (year, dates, exceptionMarketDays, exceptionalWorkingHourDays) by activeDays.initCalender. Every job that calls initCalender depends on that document existing and being current for the year — a missing/stale year makes every day a non-working day.  
  `node_modules/@smallcase/sc-platform-babel/activeDays/tasks/setHolidays.js:38-65; node_modules/@smallcase/sc-platform-babel/activeDays/activeDays.js:63-115`

### redis-keys

- **!** Redis keys touched by SBI jobs: QTS:<sid> (hash; field 'kite' or broker name → JSON with .price) for pricing; SID:<sid> (hash) for sid metadata; SYMBOL2SID:ticker.nse:<TICKER> (string → sid) during activation ingest; AT:<userId> (hash of session JSON with .at and .expireAt) for access tokens; API:SCL:<userId>:<scid> the iscid placement lock that createSbiAutosipOrders DELETEs on the re-place path; BB:lock:<batchId> written by triggerManualPoll --lock with a 300s TTL.  
  `jobs/autosips/sbi/utils.js:13-22,40-50; jobs/activations/sbi/ingestUsers.js:142; jobs/triggerManualPoll.js:15,116; jobs/autosips/sbi/createSbiAutosipOrders.js:209-219; jobs/activations/sbi/placeActivatedOrders.js:368-373`

### config-sbi

- **!** SBI-specific config keys: config.brokers.sbi.activation.baseUrl (SBI_ACTIVATION_BASE_URL), config.brokers.sbi.activationV2.baseUrl (SBI_ACTIVATION_V2_BASE_URL), config.brokers.sbi.SBI_AMO_PERCENTAGE_THRESHOLD (default '10'), config.jobs.sbiIngestUpdates.orderBookS3Bucket (SBI_ORDERBOOK_BUCKET, default 'smallcase-trash'), .sbiAllOrdersS3Bucket (SBI_ALL_ORDERS_S3_BUCKET, default 'sc-integrations-sbi-attachments'), .mattermostWebhookUrl (SBI_MATTERMOST_WEBHOOK_URL).  
  `config.js:125-133,297-301`
- SBI symbol/margin loaders: config.jobs.putBrokerSymbolsInRedis.sbi reads 'sbi_masterscrip' from bucket SBI_SYMBOLS_S3_BUCKET (default sc-integrations-sbi-attachments) requiring headers FESEM_SECURITY_ID, FESEM_ISIN. config.jobs.putBrokerMtfsInRedis.sbi reads SBI_MTF_SYMBOLS_REMOTE_FILE_PATH (default 'mtf_security_margin') from SBI_MTF_SYMBOLS_S3_BUCKET requiring SMST_SECURITY_ID, SMST_ISIN_CODE, RPWMP_NSE_MARGIN_PCT.  
  `config.js:177-183,209-214`

### config-general

- **!** config.deployment = process.env.DEPLOYMENT_GROUP_NAME || 'local' and drives every environment branch (email recipients, Slack sending, the AMO todayMarketOpen cutoff). config.logger.env is the same value. There is NO config.environment key anywhere in config.js.  
  `config.js:6-14,17-19; jobs/triggerAmoPoll.js:62; jobs/sanity/databaseSanityChecks.js:303`

### downstream-endpoints

- **!** Every write these jobs make goes through one of: BB/order-updates at config.BB_SERVICE_HOST.url (POST /orders/place, GET|POST /errors/fix/<batchId>, GET /orders/poll/<batchId>, GET /sst/orders/poll/<batchId>, POST /orders/twostep/buy-leg, POST /orders/getstatus) or platform-api at config.platformApiService.url (POST /v2/internal/orders/autosip/preorder, POST /v2/internal/user/sc/archiveBatch, DELETE /v1/internal/integrations/user/sip/delete, POST /internal/user/signup, POST /bam/internal/lookup, POST /v2/internal/auto-recon/place-dummy-orders).  
  `services/orderUpdatesService.js:7,69,76,106-117,119-128; services/platformApiService.js:4-31,192,222; services/index.js:125-126,309`
- **!** All BB calls from this repo carry the header 'x-request-source': 'sc-integrations-jobs' (on /errors/fix). That header is the cleanest way to attribute a batch mutation in order-updates logs to a jobs-repo run rather than to a user action.  
  `services/index.js:310; jobs/autosips/sbi/createSbiAutosipOrders.js:204; jobs/reconciliations/sbiReconAllOrders.js:607; jobs/reconciliations/markBatchesAsUnfilled.js:43`

### deployment

- Deploys are manual: both .github/workflows/production-node18-deploy.yaml and the staging one trigger only on workflow_dispatch, running Node 18.6.0 via smallcase/sc-infra-configs Builder-v5. Code lands at /deployments/sc-integrations-jobs/ per appspec.yml, which matches config.js's pathHome of '/deployments/'.  
  `.github/workflows/production-node18-deploy.yaml:3-16; appspec.yml:3-6; config.js:6`


## Grep targets (130)

Search with `fetch-by-identifier.js --service <svc> --text "<string>"`.

| String | Means | Emitted by | Citation |
|---|---|---|---|
| `Amo Poll(${sstOrder ? 'SSTOrders' : 'Normal Orders'}) Triggered for brokers ${amoAllowedBrokers}` | triggerAmoPoll started one of its two streams. The interpolated broker array is the definitive record of whether sbi and sbi-mtf were in scope for THAT run — read it rather than assuming. | triggerAmoPoll.processOrdersStream (jobName 'amoPoll') _(lvl info)_ | `jobs/triggerAmoPoll.js:55` |
| `AMO polling skipped as it's not a working day.` | triggerAmoPoll refused to run. Either a genuine holiday or the Holidays calendar failed to load. The job then exits 1. | triggerAmoPoll.processOrdersStream _(lvl error)_ | `jobs/triggerAmoPoll.js:58-60` |
| `${sstOrder ? 'SST AMOs' : 'Normal AMOs'}: Stream Processed` | That AMO stream finished cleanly. Absence of both 'Normal AMOs: Stream Processed' and 'SST AMOs: Stream Processed' means the run died mid-stream. | triggerAmoPoll.processOrdersStream _(lvl info)_ | `jobs/triggerAmoPoll.js:97` |
| `AMO Stream Processed` | triggerAmoPollNonMarketDay (muhurat variant) finished. Note the text differs from the normal job's 'Normal AMOs: Stream Processed'. | triggerAmoPollNonMarketDay.processOrdersStream (jobName 'amoPoll') _(lvl info)_ | `jobs/triggerAmoPollNonMarketDay.js:81` |
| `Successfully completed Polling for Orders Stream` | services.pollOrdersStream drained the cursor without throwing. | services/index.js pollOrdersStream _(lvl info)_ | `services/index.js:340` |
| `Polling for Orders Stream failed` | The whole AMO poll stream aborted. Everything after this point in the run was not polled. | services/index.js pollOrdersStream _(lvl error)_ | `services/index.js:344` |
| `Error in errors/fix request for batchId: ${order.batchId}` | An ERROR-status AMO batch's automatic /errors/fix call failed. The batch stays in ERROR. | services/index.js pollOrdersStream (ERROR branch) _(lvl error)_ | `services/index.js:312` |
| `Error in http order poll for batchId: ${order.batchId}` | The GET /orders/poll/<batchId> to BB failed for this batch during AMO polling. | services/index.js pollOrdersStream _(lvl error)_ | `services/index.js:332` |
| `Error in kafka event produce for order poll of batchId: ${order.batchId}` | Kafka-mode AMO poll failed to publish ORDER_amoPoll for this batch. | services/index.js pollOrdersStream (kafka branch) _(lvl error)_ | `services/index.js:324` |
| `Refresh session failed for user: ${order.userId}: ${err.message}` | Broker session refresh failed before polling — the batch was skipped entirely. For SBI this should be rare since SBI uses sessionless polling. | services/index.js pollOrdersStream / triggerAmoPollNonMarketDay _(lvl error)_ | `services/index.js:336; jobs/triggerAmoPollNonMarketDay.js:78` |
| `Autosips to be ingested` | createSbiAutosipOrders start-of-run marker. The accompanying data carries { total, parallelism } — the count of SBI SIPs matched by the scheduledDate query. | createSbiAutosipOrders.placeAutosipOrders (jobName 'placeSbiAutosips') _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:156-159` |
| `Autosips to be ingested (by ISCIDs)` | The byIscids backfill variant started (jobName 'placeSbiAutosipsByIscids'), not the daily job. | createSbiAutosipOrdersByIscids.placeAutosipOrders _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrdersByIscids.js:252` |
| `Processing sip` | Per-SIP marker carrying data.sipId. Count these to see how far a truncated run got. | createSbiAutosipOrders / createSBIAutosipOrders-NonWorkingDay / createSbiAutosipOrdersByIscids _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:172` |
| `Auto Sip Orders Placement Completed` | createSbiAutosipOrders finished the SIP loop. data carries failedAutoSipMap, successAutoSipList, autoSipExecutedCount, autoSipErroredCount, placedSips. Absence = the job died or was killed mid-loop. | createSbiAutosipOrders.placeAutosipOrders _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:322-330` |
| `Auto Sip Orders Placement Completed (By ISCIDs)` | Same completion marker for the byIscids variant. | createSbiAutosipOrdersByIscids.placeAutosipOrders _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrdersByIscids.js:385` |
| `Auto Sip place orders postponed to next working day` | createSbiAutosipOrders decided today is not a working day and placed NOTHING. Beware: this is also what you see when the Holidays calendar failed to load, because the err from initCalender is discarded. | createSbiAutosipOrders top-level initCalender callback _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:554` |
| `iscid already in placed state` | The SIP's iscid was already PLACED. In createSbiAutosipOrders this is logged at ERROR level and then the job decides whether to force-unlock and re-place or to skip. | createSbiAutosipOrders / createSBIAutosipOrders-NonWorkingDay / createSbiAutosipOrdersByIscids _(lvl error)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:184` |
| `Marking orders as rejected and re-placing for AUTOSIP Error batch` | THE destructive autosip path. The job is about to POST /errors/fix with force:true + fixBy:'unlocking', delete the iscid Redis lock, archive the batch, and place a fresh AUTOSIP batch. If you are investigating a duplicate SBI SIP order, find this line. | createSbiAutosipOrders.placeAutosipOrders _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:196-198` |
| `PLACED iscid has stale AUTOSIP batch - calling fix/errors and unlocking` | Same destructive re-place path in the byIscids variant. | createSbiAutosipOrdersByIscids _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrdersByIscids.js:282` |
| `Unlocked iscid redis key` | The API:SCL:<userId>:<scid> placement lock was deleted by the autosip job. data.key holds the exact key. | createSbiAutosipOrders / createSbiAutosipOrdersByIscids _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:216` |
| `Error unlocking iscid redis key: ${key}` | Redis DEL of the iscid lock failed; the job continues anyway and will attempt placement with the lock still held. | createSbiAutosipOrders / createSbiAutosipOrdersByIscids _(lvl error)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:213` |
| `Updating SBI SIP scheduled date for already placed iscid with REBALANCE label` | The SIP was skipped because a REBALANCE batch holds the iscid; scheduledDate rolls forward AND sipFailedCount is incremented. Six of these kills the SIP. | createSbiAutosipOrders.placeAutosipOrders _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:227-231` |
| `Skipping SIP date update - iscid already in placed status with non-REBALANCE label` | SIP skipped and scheduledDate NOT advanced — it will be retried on the next run with the same scheduledDate. | createSbiAutosipOrders.placeAutosipOrders _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:237-241` |
| `Updating SBI SIP dates after order placement` | Placement succeeded; triggerDate, instalmentCount and scheduledDate are being written. data.updateFields shows the new scheduledDate. | createSbiAutosipOrders.placeAutosipOrders _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:297-300` |
| `Sip orders placed successfully` | An SBI AUTOSIP batch was created. data.batchId is the batch id — the primary link from a SIP to an order. | createSbiAutosipOrders / createSBIAutosipOrders-NonWorkingDay / createSbiAutosipOrdersByIscids _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:293` |
| `no last batch found for placed iscid` | The iscid is PLACED but no Order document exists for it — data inconsistency; the SIP is counted as errored. | createSbiAutosipOrders.placeAutosipOrders _(lvl error)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:188` |
| `no last batch found for invalid iscid` | The iscid is INVALID with no batch history; the SIP is counted as errored and skipped. | createSbiAutosipOrders / createSBIAutosipOrders-NonWorkingDay / createSbiAutosipOrdersByIscids _(lvl error)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:254` |
| `No shares found for sip: ${sipDoc._id}` | The SIP document has an empty sharesConfig — thrown as an Error and recorded in failedAutoSipMap. | createSbiAutosipOrders.getBatchToBePlaced _(lvl error)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:83` |
| `user: ${userId} not found while processing sip` | The SIP references a userId with no User document. | createSbiAutosipOrders.getUser _(lvl error)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:51` |
| `iscid: ${iscid} does not exist for user: ${user._id}` | The SIP's iscid is not in the user's investedSmallcases array — thrown from getCurrentIscid. | jobs/autosips/sbi/utils.js getCurrentIscid _(lvl error)_ | `jobs/autosips/sbi/utils.js:41` |
| `User: ${user._id} iscids empty` | The user has no investedSmallcases at all. | jobs/autosips/sbi/utils.js getCurrentIscid _(lvl error)_ | `jobs/autosips/sbi/utils.js:37` |
| `Funds check successful` | broker.sbi.api.Funds.check returned. data.fundsRes carries { code, sufficientFunds, ... }. NOTE: this line is logged even when funds are insufficient — it only means the call returned. | createSbiAutosipOrders.holdFunds / NonWorkingDay / sbiRebalanceSipOrderPlace _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:121` |
| `Insufficient funds for auto sip` | The SBI funds check reported code falsy or sufficientFunds false. CRITICAL: the job logs this and then PLACES THE ORDER ANYWAY — there is no return/throw after it. | createSbiAutosipOrders.holdFunds _(lvl error)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:122-124` |
| `invalid funds check response` | broker.sbi.api.Funds.check returned a falsy response; execution then throws on the next property access. | createSbiAutosipOrders.holdFunds _(lvl error)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:118-120` |
| `Insufficient funds for rebalance sip` | Same non-blocking funds warning on the SBI rebalance-SIP path. | sbiRebalanceSipOrderPlace.holdFunds _(lvl error)_ | `jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js:119` |
| `Starting SBI Rebalance SIP Order Place job` | sbiRebalanceSipOrderPlace start marker; the payload includes runAutoSipJob, telling you whether placeSbiAutosips will be chained afterwards. | sbiRebalanceSipOrderPlace _(lvl info)_ | `jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js:150` |
| `${jobName} skipped as it's not a working day.` | sbiRebalanceSipOrderPlace refused to run (jobName interpolates to 'sbiRebalanceSipOrderPlace'). | sbiRebalanceSipOrderPlace _(lvl error)_ | `jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js:153-155` |
| `Triggering Auto SIP job` | sbiRebalanceSipOrderPlace is about to call GET ${SCHEDULER_HOST}/run/placeSbiAutosips. Its absence means the chain did not fire. | sbiRebalanceSipOrderPlace _(lvl info)_ | `jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js:259` |
| `Skipping Auto SIP job as runAutoSipJob is false` | The rebalance-SIP → autosip chain did NOT fire because --runAutoSipJob was not the literal string 'true'. | sbiRebalanceSipOrderPlace _(lvl info)_ | `jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js:262` |
| `Triggered ${jobName}` | services.triggerSchedulerJob succeeded; data.body is the scheduler's raw response. For SBI, jobName will be 'placeSbiAutosips'. | services/index.js triggerSchedulerJob _(lvl info)_ | `services/index.js:358` |
| `Failed to trigger ${jobName} due to ${err.message}` | The scheduler /run/<jobName> call failed — the downstream job never started. | services/index.js triggerSchedulerJob _(lvl error)_ | `services/index.js:354` |
| `Rebalance SIP with correlationId ${sip.correlationId} unable to mark as processing` | The CREATED→PROCESSING claim failed, meaning another run already claimed it (or the status was not CREATED). | sbiRebalanceSipOrderPlace _(lvl warn)_ | `jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js:194` |
| `Two-step funds check failed` | fundsService.checkFundsWithBrokerage rejected the two-step SBI rebalance buy leg; the RebalanceSip goes to ERROR + active:false. | sbiRebalanceSipOrderPlace.processTwoStepSip _(lvl error)_ | `jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js:310` |
| `Two-step buy leg was not placed` | POST /orders/twostep/buy-leg returned neither success nor status 'SKIPPED'. | sbiRebalanceSipOrderPlace.processTwoStepSip _(lvl error)_ | `jobs/autosips/sbi/sbiRebalanceSipOrderPlace.js:327` |
| `Two-step buy leg request` | About to POST ${BB_SERVICE_HOST}/orders/twostep/buy-leg; data carries { batchId, variety }. | services/orderUpdatesService.js placeTwoStepBuyLeg _(lvl info)_ | `services/orderUpdatesService.js:120` |
| `BB request` | Every order placement logs this immediately before POSTing to ${BB_SERVICE_HOST}/orders/place. data.request holds the full payload including batch.label, batch.variety and the orders array — the single most useful line for 'what exactly did we send?'. | services/orderUpdatesService.js sendBBRequest _(lvl info)_ | `services/orderUpdatesService.js:11` |
| `PLACE ORDER FAILED` | The /orders/place POST failed AND the follow-up /orders/getstatus lookup by correlationId also failed to find a batch. No batch exists. | services/orderUpdatesService.js placeOrders _(lvl error)_ | `services/orderUpdatesService.js:93-95` |
| `Pre-Placement request` | About to POST platform-api /v2/internal/orders/autosip/preorder. Carries userId and iscid at the top level of jobs.data. | services/platformApiService.js prePlaceOrder _(lvl info)_ | `services/platformApiService.js:123-127` |
| `Pre-Placement request successful.` | Platform returned a correlationId (and newIscid for BUY batches). Note the trailing period. | services/platformApiService.js prePlaceOrder _(lvl info)_ | `services/platformApiService.js:143` |
| `Pre-Placement request Failed` | Platform rejected pre-placement; the batch is never sent to BB. | services/platformApiService.js prePlaceOrder _(lvl error)_ | `services/platformApiService.js:151` |
| `newIscid not received BUY batch pre-placement` | A BUY (activation) pre-placement came back without a newIscid — placement aborts. | services/platformApiService.js prePlaceOrder _(lvl error)_ | `services/platformApiService.js:137-140` |
| `preplacement successful` | The autosip jobs' own wrapper confirmation after prePlaceOrder resolved; data.response holds the correlationId. | createSbiAutosipOrders / NonWorkingDay / byIscids / sbiRebalanceSipOrderPlace prePlaceOrder _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:39` |
| `Archive Batch request` | About to POST platform-api /v2/internal/user/sc/archiveBatch — an SBI batch is being archived by a job. | services/platformApiService.js archiveBatch _(lvl info)_ | `services/platformApiService.js:61-63` |
| `Archive Batch Failed` | archiveBatch returned without success:true; the autosip re-place path throws here. | services/platformApiService.js archiveBatch _(lvl error)_ | `services/platformApiService.js:69` |
| `archive sip failed due to ${err.message}` | cancelFailedAutosipsEod could not archive the SIP via DELETE /v1/internal/integrations/user/sip/delete. | services/platformApiService.js archiveSip _(lvl error)_ | `services/platformApiService.js:347-351` |
| `Finding SIPs eligible for EOD cancellation` | cancelFailedAutosipsEod start marker; data.query shows the exact broker list and sipFailedCount threshold used that run. | cancelFailedAutosipsEod.runCancellation _(lvl info)_ | `jobs/autosips/cancelFailedAutosipsEod.js:262` |
| `SIPs found for cancellation` | Count of SIPs about to be archived, plus the THRESHOLD value. If SBI SIPs vanished, this is the line that proves it. | cancelFailedAutosipsEod.runCancellation _(lvl info)_ | `jobs/autosips/cancelFailedAutosipsEod.js:266` |
| `Archived SIP via platform API` | A SIP was archived because sipFailedCount hit the threshold. data carries iscid and sipId. | cancelFailedAutosipsEod.runCancellation _(lvl info)_ | `jobs/autosips/cancelFailedAutosipsEod.js:308` |
| `Today is not a working day` | placeSbiActivatedOrders exited before doing anything. Distinct wording from the autosip job's 'Auto Sip place orders postponed to next working day'. | placeActivatedOrders.placeSbiActivationOrders (jobName 'placeSbiActivatedOrders') _(lvl info)_ | `jobs/activations/sbi/placeActivatedOrders.js:71` |
| `job execution params` | placeSbiActivatedOrders logs its full Mongo query, date and jobName. The query object reveals the exact createdAt cutoff and maxAttempts used that run. | placeActivatedOrders.placeSbiActivationOrders _(lvl info)_ | `jobs/activations/sbi/placeActivatedOrders.js:103` |
| `Activations to be processed` | Count of due SBI activations plus the parallelism setting. | placeActivatedOrders.placeSbiActivationOrders _(lvl info)_ | `jobs/activations/sbi/placeActivatedOrders.js:109-112` |
| `processing activation` | Per-activation marker carrying userId and scid. | placeActivatedOrders.placeSbiActivationOrders _(lvl info)_ | `jobs/activations/sbi/placeActivatedOrders.js:116-119` |
| `Placing BUY order` | A first-time SBI activation order is being placed (label BUY, variety amo, activated:true). | placeActivatedOrders.placeBuyOrder _(lvl info)_ | `jobs/activations/sbi/placeActivatedOrders.js:255-258` |
| `Placing FIX order` | A retry of a previously incomplete SBI activation batch (label FIX, carries previousBatchId/originalBatchId). | placeActivatedOrders.placeFixOrder _(lvl info)_ | `jobs/activations/sbi/placeActivatedOrders.js:305-309` |
| `won't fix batch` | The iscid is INVALID but shouldFixBatch returned false, so nothing was placed. Payload has userId, iscid, batchId. | placeActivatedOrders.placeSbiActivationOrders _(lvl info)_ | `jobs/activations/sbi/placeActivatedOrders.js:141-145` |
| `Marking the activation as processed since the iscid is already in VALID status for the iscid: ` | The activation is closed out without placing anything because the investment is already valid. Note the trailing space and colon. | placeActivatedOrders.placeSbiActivationOrders _(lvl warn)_ | `jobs/activations/sbi/placeActivatedOrders.js:148-151` |
| `iscid: ${iscid._id} is already in placed status` | The activation was skipped and counted into the external report's 'ISCIDs already in placed status' bucket. | placeActivatedOrders.placeSbiActivationOrders _(lvl warn)_ | `jobs/activations/sbi/placeActivatedOrders.js:158-159` |
| `user has already exited the smallcase` | The activation targets a scid the user has exited; the Activation is marked processed and no order is placed. | placeActivatedOrders.placeSbiActivationOrders _(lvl warn)_ | `jobs/activations/sbi/placeActivatedOrders.js:168-169` |
| `Invalid activation document: Smallcase not found` | The activation's scid has no Smallcase document — permanent failure, nothing placed. | placeActivatedOrders.placeSbiActivationOrders _(lvl warn)_ | `jobs/activations/sbi/placeActivatedOrders.js:177-178` |
| `Invalid userId in activation document: User does not exist!` | The Activation row points at a non-existent user. | placeActivatedOrders.placeSbiActivationOrders _(lvl warn)_ | `jobs/activations/sbi/placeActivatedOrders.js:190-191` |
| `funds required before adding buffer` | The SBI activation funds estimate. Carries { fundsRequired, userId }. Remember this figure sums price-per-share only, ignoring quantity. | placeActivatedOrders.placeOrder _(lvl info)_ | `jobs/activations/sbi/placeActivatedOrders.js:412` |
| `insufficient funds` | SBI reported insufficient funds for an activation order — logged at INFO and the order is placed anyway. | placeActivatedOrders.placeOrder _(lvl info)_ | `jobs/activations/sbi/placeActivatedOrders.js:421-423` |
| `Successfully placed orders for activated users` | placeSbiActivatedOrders completed its main loop without throwing. | placeActivatedOrders top-level _(lvl info)_ | `jobs/activations/sbi/placeActivatedOrders.js:684` |
| `metrics saved to db` | The run's success/failure counts were written to the integrations-activationMetrics collection. Query that collection for the historical record. | placeActivatedOrders finally block _(lvl info)_ | `jobs/activations/sbi/placeActivatedOrders.js:742` |
| `Error in placeSbiActivationOrders` | The SBI activation placement job threw at the top level. Appears in jobs.data.message. | placeActivatedOrders top-level catch _(lvl error)_ | `jobs/activations/sbi/placeActivatedOrders.js:718,747` |
| `Order count response` | SBI activation ingest called GetOrderCountData. data.response has TotalNoOfRecords/StartIndex/EndIndex; data.request.url tells you whether this was the v1 (/api/v1/Smallcase_CGS/) or v2 (/KycKraApi/api/v1/smallcaseCallback/) endpoint — the ONLY way to tell the two 'sbiActivation' jobs apart in logs. | jobs/activations/sbi/ingestUsers.js and jobs/activations/sbiV2/ingestUsers.js (both jobName 'sbiActivation') _(lvl info)_ | `jobs/activations/sbi/ingestUsers.js:52-59; jobs/activations/sbiV2/ingestUsers.js:54-61` |
| `Order list response` | One page of FetchDataFromSmallcaseDetails came back; data.response.data is the raw SBI rows (Entity_id, user_name, SCID, SipSet, Ticker, Quantity). | SBI activation ingest getOrders _(lvl info)_ | `jobs/activations/sbi/ingestUsers.js:106-114` |
| `Invalid response from getOrderCount` | SBI's activation count API returned nothing usable — the whole ingest aborts without processing any user. | SBI activation ingest main _(lvl error)_ | `jobs/activations/sbi/ingestUsers.js:263` |
| `Invalid response from getOrders` | A page fetch failed mid-pagination; the ingest RETURNS immediately, so later pages are silently dropped. | SBI activation ingest main _(lvl error)_ | `jobs/activations/sbi/ingestUsers.js:273` |
| `sid not found for ticker` | Redis lookup SYMBOL2SID:ticker.nse:<Ticker> missed; that user's activation row is dropped. data.ticker names the symbol. | SBI activation ingest getSmallcaseOrderConfig _(lvl error)_ | `jobs/activations/sbi/ingestUsers.js:144` |
| `Activation already exists` | A duplicate (brokerUserId, scid) pair — counted as a duplicate, no new Activation created. | SBI activation ingest main _(lvl info)_ | `jobs/activations/sbi/ingestUsers.js:324` |
| `Activation successful` | A new Activation document was saved with processed:false, attempt:0. Carries userId, brokerUserId, scid. | SBI activation ingest main _(lvl info)_ | `jobs/activations/sbi/ingestUsers.js:347` |
| `failed to save activation doc` | Activation.save() rejected — the user will not get an order placed. | SBI activation ingest main _(lvl warn)_ | `jobs/activations/sbi/ingestUsers.js:350` |
| `Failed to create user` | platform-api /internal/user/signup did not return a userId for this SBI broker user; all their scids go to failedActivations. | SBI activation ingest main _(lvl error)_ | `jobs/activations/sbi/ingestUsers.js:360` |
| `SBI SIP report: email recipients not in Config, using defaults` | The Mongo Config doc key 'sbi_activation_autosip_report_emails' is missing/empty, so the hardcoded sbicapsec.com list was used for the external SBI SIP email. | createSbiAutosipOrders.fetchSbiSipEmailRecipients _(lvl warn)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:466` |
| `SBI SIP external report: email sent successfully` | The 'Daily SBI SIP Orders Summary' email actually went out to SBI. | createSbiAutosipOrders.sendExternalSbiReport _(lvl info)_ | `jobs/autosips/sbi/createSbiAutosipOrders.js:521` |
| `SBI Activation external report: email sent successfully` | The 'Daily SBI Activation Orders Summary' email went out to SBI. | placeActivatedOrders.sendExternalSbiActivationReport _(lvl info)_ | `jobs/activations/sbi/placeActivatedOrders.js:658` |
| `Starting SBI Activation and Autosip Report generation` | jobs/reports/sbiActivationAutosipReport.js started (the standalone 'Daily SIP & Activation Orders Summary' report). | sbiActivationAutosipReport.generateReport _(lvl info)_ | `jobs/reports/sbiActivationAutosipReport.js:225` |
| `Today is not a working day, skipping report generation` | sbiActivationAutosipReport exited 0 without emailing anything. | sbiActivationAutosipReport calenderInit callback _(lvl info)_ | `jobs/reports/sbiActivationAutosipReport.js:349` |
| `IST date range calculated` | The report's IST day window. data.startDate/endDate are ISO UTC strings — comparing them against the order dates you are chasing tells you whether the report window covered them. | sbiActivationAutosipReport.getTodayISTDateRange _(lvl info)_ | `jobs/reports/sbiActivationAutosipReport.js:31-35` |
| `running job sbiReconAllOrders with params:` | First line of every sbiReconAllOrders run; the JSON that follows is the full yargs object, revealing --date, --save, --filepath, --local, --createMissingBatches, --recreateInvestment for that run. | jobs/reconciliations/sbiReconAllOrders.js top-level _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:4` |
| `No files found in S3 bucket for date: ${todayDate}` | Neither sbi_recon/<date>/ nor mtf_recon/<date>/ contained any object — the SBI file did not arrive (or the job used the wrong, UTC-shifted date). Recon did NOT run for that day. | sbiReconAllOrders.readReconCSV _(lvl error)_ | `jobs/reconciliations/sbiReconAllOrders.js:114-116` |
| `S3 files found` | Recon listed the day's CSVs. data.counts.sbi and data.counts['sbi-mtf'] give the per-prefix file counts and data.files lists the keys. | sbiReconAllOrders.readReconCSV _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:118-127` |
| `Dealer orders fetched from secondary` | Recon pulled the candidate SBI/SBI-MTF batches from the secondary replica. data.count and data.date pin the comparison set. | sbiReconAllOrders.main _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:1184` |
| `Batch state before fix` | Recon is about to mutate this batch. The payload snapshots every order's orderId/tag/status/quantity/averagePrice — pair it with 'Batch state after fix' to see exactly what recon changed. | sbiReconAllOrders.main _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:1252-1269` |
| `Batch state after fix` | Post-mutation snapshot of the same batch. | sbiReconAllOrders.main _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:1283-1300` |
| `Tradebook for batch` | The exact tradebook recon is sending to /errors/fix. Only orders whose CSV status differs from the DB status appear here. | sbiReconAllOrders.fixBatchByTradebook _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:601` |
| `Fix batch response` | Result of POST /errors/fix from recon. Carries request.url, request.body and response.data. | sbiReconAllOrders.fixBatchByTradebook / sbiUnplacedRecon _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:610; jobs/reconciliations/sbiUnplacedRecon.js:94` |
| `Batch updated successfully` | Recon considers the batch fixed. Beware: without --save this line is emitted after making NO HTTP call at all. | sbiReconAllOrders.fixBatchByTradebook _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:611-613` |
| `Error in fixBatchByTradebook` | The /errors/fix POST failed; the batch is recorded in reportData.hangingOrders. | sbiReconAllOrders.fixBatchByTradebook _(lvl error)_ | `jobs/reconciliations/sbiReconAllOrders.js:618-623` |
| `Skipping batch superseded by dummy order — broker update received for archived batch` | The batch carries meta.supersededByDummyBatchId, so recon deliberately leaves it alone. Payload names the superseding dummy batch id. | sbiReconAllOrders.main _(lvl warn)_ | `jobs/reconciliations/sbiReconAllOrders.js:1229-1234` |
| `No matching orders found, no reconciliation required` | A candidate batch had no status differences against the CSV. Logged with the batchId as jobs.info and this string inside jobs.data.error. | sbiReconAllOrders.main _(lvl info)_ | `jobs/reconciliations/sbiReconAllOrders.js:1245-1248` |
| `Recreation API response` | pf-utils investment recreation succeeded for a batch (only runs with --recreateInvestment). Carries batchId, attempt, status. | sbiReconDependencies.postRecreationWithRetry _(lvl info)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:59-64` |
| `Retrying recreation API` | A transient failure calling https://pf-utils-api.util.smallcase.com/api/user/investment/recreation; backoff is 500ms, 1000ms, 2000ms over max 4 attempts. | sbiReconDependencies.postRecreationWithRetry _(lvl warn)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:75-84` |
| `Error calling recreation API` | Investment recreation permanently failed for a batch; recorded in reportData.recreationAPIFailures and surfaced in the recon email. | sbiReconDependencies.callRecreationAPI _(lvl error)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:133-138` |
| `Error creating batch from logs` | Recon failed to synthesise a missing dealer batch from dealerOrderDownloadLogs. | sbiReconBatchCreation.createBatchesFromLogs _(lvl error)_ | `jobs/reconciliations/sbiReconHelperFiles/sbiReconBatchCreation.js:189-193` |
| `[DRY-RUN] Would call fix API` | sbiRejectedAmoOrdersIngest ran WITHOUT --save. Nothing was written. Seeing this means the rejected-AMO ingest did not actually fix anything. | sbiRejectedAmoOrdersIngest _(lvl info)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:261` |
| `[DRY-RUN] Would update statusMessage for already-rejected order` | Same dry-run marker for the statusMessage-enrichment path. | sbiRejectedAmoOrdersIngest _(lvl info)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:310` |
| `No CSV files found in S3 for the given date` | s3://<bucket>/sbi_rejected_amo_orders/<date>/ was empty — SBI did not deliver a rejected-AMO file (or the date was wrong). | sbiRejectedAmoOrdersIngest.main _(lvl warn)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:500-503` |
| `Skipping batch — not an AMO batch` | sbiRejectedAmoOrdersIngest refuses to touch non-AMO batches. | sbiRejectedAmoOrdersIngest _(lvl info)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:283` |
| `Skipping order — already COMPLETE in DB` | SBI's rejected-AMO file lists an order we already have as COMPLETE; the job leaves it alone (a real SBI-vs-us disagreement worth escalating). | sbiRejectedAmoOrdersIngest _(lvl info)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:295` |
| `Updating statusMessage for already-rejected order` | The order was already REJECTED on our side; only statusMessage and errorCode are being enriched from SBI's ERROR_OR_REASON column. | sbiRejectedAmoOrdersIngest _(lvl info)_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:306` |
| `Order Rejected: ` | The literal prefix prepended to every SBI rejection reason so it matches the SBI broker config's invalidOrder regex. Any statusMessage in the DB starting with this string was written by sbiRejectedAmoOrdersIngest, not by the live order flow. | sbiRejectedAmoOrdersIngest (REJECTED_STATUS_MESSAGE_PREFIX) _(lvl n/a (data written to DB))_ | `jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:42-43,230,242-243` |
| `Non-terminal MTF batches found` | cleanupMtfNonTerminalBatches listed stuck sbi-mtf/axis-mtf/hdfc-mtf batches. NOTE: this job logs bunyan-style, so the message text is in jobs.data and { count, brokers } is in jobs.info. | cleanupMtfNonTerminalBatches.run _(lvl info)_ | `jobs/cleanup/cleanupMtfNonTerminalBatches.js:62` |
| `[DRY RUN] Would mark batch as MARKEDCOMPLETE` | cleanupMtfNonTerminalBatches ran without --save; no SBI-MTF batch was changed. | cleanupMtfNonTerminalBatches.run _(lvl info)_ | `jobs/cleanup/cleanupMtfNonTerminalBatches.js:88-91` |
| `Marking batch as MARKEDCOMPLETE` | cleanupMtfNonTerminalBatches with --save is rewriting an SBI-MTF batch's status. Definitive attribution for an unexplained MARKEDCOMPLETE on an MTF batch. | cleanupMtfNonTerminalBatches.run _(lvl info)_ | `jobs/cleanup/cleanupMtfNonTerminalBatches.js:88-91` |
| `Skipping: this is the latest batch for iscid` | The stuck MTF batch was left alone because it is the most recent one for its iscid. | cleanupMtfNonTerminalBatches.run _(lvl info)_ | `jobs/cleanup/cleanupMtfNonTerminalBatches.js:77-80` |
| `${jobName} job postponed to next working day` | Emitted by the shared utils/activeDayCheck helper just before process.exit(0). Used by hangingOrderEodReport and databaseSanityChecks — jobName interpolates to the calling job's name. | utils/activeDayCheck.js _(lvl info)_ | `utils/activeDayCheck.js:6` |
| `Hanging SMT orders` | hangingOrderEodReport / databaseSanityChecks found hanging orders. The payload is grouped by broker with { dealer, nonDealer, activated, nonActivated, autoSIP, nonAutoSIP, normal, limit, market } — look at the 'sbi' key. databaseSanityChecks additionally adds sbi.totalAMO. | jobs/sanity/hangingOrderEodReport.js and jobs/sanity/databaseSanityChecks.js _(lvl info)_ | `jobs/sanity/hangingOrderEodReport.js:225; jobs/sanity/databaseSanityChecks.js:307` |
| `No hanging SMT orders were found.` | The hanging-order sweep found nothing for the configured window. Note: the window is timezone-sensitive, so this can be a false negative. | hangingOrderEodReport / databaseSanityChecks _(lvl info)_ | `jobs/sanity/hangingOrderEodReport.js:220; jobs/sanity/databaseSanityChecks.js:304` |
| `*@channel SBI ALERT:* AMO hanging orders. (*Hanging*: ${sbiHangingAmoOrders}, *Total*: ${sbiTotalAmoOrders}, *Percentage*: ${hangingPercentage.toFixed(2)}%)` | Slack text for the SBI-specific AMO hanging threshold breach. Only fires when the percentage exceeds SBI_AMO_PERCENTAGE_THRESHOLD (default 10). | services/slackService.js buildHangingOrdersMessage _(lvl n/a (Slack message))_ | `services/slackService.js:284-291` |
| `scheduler-agent` | Top-level key on every log line the scheduler AGENT emits (not the job). Payload is { jobName, jobType: 'script', statusCode, duration } on exit, or { jobName, err, stack } on failure. Grep this in the agent/PM2 logs to get a job's exit code and wall-clock duration. | node_modules/@smallcase/scheduler-agent/utils/job-runner.js and api/controllers/index.js _(lvl info on success, error on failure)_ | `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:124-147; node_modules/@smallcase/scheduler-agent/api/controllers/index.js:10-16,23-29` |
| `Job ${job.data.name} will run on PID: ${child.pid}` | Agent stdout line recording the forked PID — correlates an S3 log object to an OS process. | scheduler-agent job-runner.runCliJob _(lvl n/a (console.log on agent stdout))_ | `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:71` |
| `[jobRunner] This job needs to be streamed` | Agent stdout marker emitted for every CLI job just before the Redis pub/sub tail is attached. Its presence confirms the S3 upload pipe was also set up. | scheduler-agent job-runner.runCliJob _(lvl n/a (console.log on agent stdout))_ | `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:93` |
| `Error on upload : ${error}` | The gzip→S3 upload of a job's stdout failed. The job itself ran fine but its log object may be missing or truncated in sc-prod-logs. | scheduler-agent job-runner.runCliJob upload error handler _(lvl n/a (console.log on agent stdout))_ | `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:81-83` |
| `Invalid repo in job config` | The scheduler's job definition had no repo field — the job never started, so NO S3 log object exists for it. | scheduler-agent job-runner.runCliJob _(lvl n/a (promise rejection → agent error log))_ | `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:39` |
| `Invalid repo in agent config` | The agent's /config/paths map has no entry for the job's repo — job never started, no S3 log object. | scheduler-agent job-runner.runCliJob _(lvl n/a (promise rejection → agent error log))_ | `node_modules/@smallcase/scheduler-agent/utils/job-runner.js:40` |
| `forcePlaced: status changed from ${order.status} to PLACED via triggerManualPoll` | Written into the order's recordUpdate audit trail. Definitive proof a human ran triggerManualPoll --forcePlaced against this batch. | jobs/triggerManualPoll.js startManualPolling _(lvl n/a (DB audit string + console.log))_ | `jobs/triggerManualPoll.js:96,105` |
| `Set lock for batchId:` | triggerManualPoll --lock wrote BB:lock:<batchId> in Redis with a 300s TTL before polling. | jobs/triggerManualPoll.js _(lvl n/a (console.log))_ | `jobs/triggerManualPoll.js:117` |
| `x-request-source` | Header value 'sc-integrations-jobs' on every /errors/fix call this repo makes. Search order-updates/BB logs for it to attribute a batch mutation to a jobs-repo run rather than a user or another service. | services/index.js, createSbiAutosipOrders, sbiReconAllOrders, markBatchesAsUnfilled _(lvl n/a (HTTP header))_ | `services/index.js:310; jobs/autosips/sbi/createSbiAutosipOrders.js:204; jobs/reconciliations/sbiReconAllOrders.js:607` |


## Corrections (13)

Where the old `SBI_LOG_INVESTIGATION_GUIDE.md`, or an obvious assumption, is provably wrong.


**Claimed:** The task brief states that broker-lib, broker-api and leprechaun are all on the 'rebalance-in-amo' branch.

**Actually:** Only sc-integrations-leprechaun is on rebalance-in-amo. sc-integrations-broker-lib is on 'development'. sc-integrations-jobs, sc-integrations-order-updates, sc-platform-api and sc-integrations-babel are all on 'production'. Separately — and this IS a real prod-fidelity risk — the node_modules INSTALLED inside sc-integrations-jobs are rebalance-in-amo prereleases (broker-lib 16.11.13-rebalance-in-amo.0, platform-babel 6.3.1-rebalance-in-amo.0, integrations-babel 6.3.3-rebalance-in-amo.1) that do not satisfy package.json's ranges. Facts read out of those node_modules are from a feature build. @smallcase/scheduler-agent 2.2.0 does satisfy ^2.2.0, so the S3-logging facts are prod-faithful.

`git -C <each repo> rev-parse --abbrev-ref HEAD; package.json:14-19; node_modules/@smallcase/sc-integrations-broker-lib/package.json (version field)`


**Claimed:** docs/logging-guide.md: 'Local env (NODE_ENV=local): logs via console so output is readable without Bunyan formatting.' and README.md: 'Running with NODE_ENV as local will replace bunyan logger with console'.

**Actually:** FALSE. utils/loggerHelper.js tests `config.environment === 'local'`, but config.js exports no `environment` key at all — it exports `deployment` and `serviceName`. `config.environment` is always undefined, so the console fallback NEVER triggers and Bunyan is used in every environment including local. The env discriminator that actually works is `config.deployment` (= DEPLOYMENT_GROUP_NAME).

`utils/loggerHelper.js:12; config.js:1-390 (no `environment` key); docs/logging-guide.md:19-21,31; README.md:21`


**Claimed:** docs/logging-guide.md documents `logger.warn = (warn) => logger.warn({ jobs: { jobName, msg, stack } })` — a one-argument signature with no data field.

**Actually:** The actual implementation takes two arguments, `this.warn = (warn, data = {}) => ...`, and emits jobs.data alongside jobs.msg and jobs.stack. Callers do pass a second argument (e.g. logger.warn('CSV row has too few columns, skipping', { filename, lineNumber, line })), so jobs.data on a warn line is real and searchable.

`utils/loggerHelper.js:39-50; docs/logging-guide.md:25; jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:83-88`


**Claimed:** The scheduler-agent comment '//upload logs only when in production and critical' implies job logs are only shipped to S3 in production, or only for jobs flagged critical.

**Actually:** There is no condition. s3Stream.upload(bucketConfig) and child.stdout.pipe(gzip).pipe(upload) execute unconditionally for every CLI job in every environment. In staging they land in sc-stag-logs; with SCHEDULER_LOGS_BUCKET unset they land in smallcase-trash. The comment is stale.

`node_modules/@smallcase/scheduler-agent/utils/job-runner.js:73-91; node_modules/@smallcase/scheduler-agent/config.js:54`


**Claimed:** Reasonable assumption: the folder under sc-prod-logs is derived from the repo name the agent computes at startup (app-root-path basename), so it is always 'sc-integrations-jobs'.

**Actually:** The S3 key's first segment is `job.data.repo` — a field on the scheduler's job definition, not the agent's computed repoName. config.repoName (from app-root-path) is used only for agent REGISTRATION. The prod IAM policy grants both 'sc-prod-logs/sc-integrations-jobs/*' AND 'sc-prod-logs/integration-jobs/*', so at least two repo labels are in use. List both prefixes before concluding a job produced no log.

`node_modules/@smallcase/scheduler-agent/utils/job-runner.js:76; node_modules/@smallcase/scheduler-agent/index.js:15-19; /Users/rishidatta/Desktop/integrations/sc-infra-cdk-prod-sso/src/constructs/policies/sc_integrations_senior_dev.ts:87-88`


**Claimed:** Guide §7 open question: 'Whether sbiReconAllOrders.js / sbiDealerRecon.js run on any cron/schedule in prod — Not found in research (no scheduler config seen)'.

**Actually:** This cannot be answered from this repo and never will be: the repo contains zero cron definitions for ANY job, SBI or otherwise. Every schedule is a Bull repeatable job held by the external scheduler service at SCHEDULER_HOST, whose jobs carry { repo, path, args, cmd, killInterval }. The S3 key `<repo>/<name>_<bullJobId>` is in fact the best available evidence that a given job IS scheduled — a repeatable Bull id proves a cron entry exists. To get the actual cron expression you must query the scheduler service or its Redis. The right skill behaviour is to infer schedule from observed S3 object keys/timestamps, not to look for cron in this repo.

`jobs/sanity/stalePriceAlert.js:1 (the only cron string in the repo); config.js:42-45; node_modules/@smallcase/scheduler-agent/utils/job-runner.js:37-43,74-77`


**Claimed:** The guide's framing that SBI recon is 'manual, not scheduled' because the recon jobs are yargs-flag-driven CLI scripts.

**Actually:** Being yargs-driven says nothing about whether a job is scheduled — EVERY job in this repo is a yargs-driven CLI script, including the unambiguously scheduled ones like triggerAmoPoll and placeSbiAutosips. The scheduler passes flags via job.data.args. The correct statement is: the recon jobs' WRITE paths are opt-in (--save, --createMissingBatches, --recreateInvestment, --createDealerDuplicateBatches), so a scheduled recon run that lacks those args reports without fixing anything.

`node_modules/@smallcase/scheduler-agent/utils/job-runner.js:58-70; jobs/reconciliations/sbiReconAllOrders.js:604-614; jobs/reconciliations/sbiReconHelperFiles/sbiReconBatchCreation.js:176-179; jobs/triggerAmoPoll.js:18-21`


**Claimed:** Assumption (and the file's own JSDoc/comment) that SBI activation orders are placed 3 WORKING days after ingestion.

**Actually:** The code does `date.setDate(date.getDate() - 3)` — three CALENDAR days. There is no activeDays call in getActivationDate. After a weekend or a holiday run the effective wait is shorter in trading days than documented. The only working-day logic in the job is the top-level `if (!scBabel.activeDays.isWorkingDay())` gate on whether the job runs at all.

`jobs/activations/sbi/placeActivatedOrders.js:51-63,70-73`


**Claimed:** Assumption that a job's jobName field in the logs identifies which file produced them.

**Actually:** Four jobName values are shared across multiple files: 'placeSbiAutosips' (createSbiAutosipOrders.js AND createSBIAutosipOrders-NonWorkingDay.js), 'sbiActivation' (activations/sbi/ingestUsers.js AND activations/sbiV2/ingestUsers.js), 'sbiDealerRecon' (sbiDealerRecon.js AND sbiUnplacedRecon.js), 'amoPoll' (triggerAmoPoll.js, triggerAmoPollNonMarketDay.js AND triggerAmoPollKite.js). Identify the file from the S3 object key, or — for the two ingestUsers jobs — from the URL inside the 'Order count response' line (/api/v1/Smallcase_CGS/ = v1, /KycKraApi/api/v1/smallcaseCallback/ = v2).

`jobs/autosips/sbi/createSbiAutosipOrders.js:2; jobs/autosips/sbi/createSBIAutosipOrders-NonWorkingDay.js:2; jobs/activations/sbi/ingestUsers.js:1,39; jobs/activations/sbiV2/ingestUsers.js:3,41; jobs/reconciliations/sbiDealerRecon.js:1; jobs/reconciliations/sbiUnplacedRecon.js:1; jobs/triggerAmoPoll.js:7; jobs/triggerAmoPollNonMarketDay.js:12; jobs/triggerAmoPollKite.js:7`


**Claimed:** Reasonable assumption: an 'Insufficient funds' error in an SBI autosip/activation log means the order was not placed.

**Actually:** WRONG in both jobs. In createSbiAutosipOrders.holdFunds the insufficient-funds branch only calls logger.error and falls through — prePlaceOrder and placeOrders run regardless. In placeActivatedOrders.placeOrder the equivalent check logs at INFO ('insufficient funds') and likewise continues to pre-placement and placement. A funds warning is NOT a placement blocker in this repo; the broker rejects (or does not) downstream.

`jobs/autosips/sbi/createSbiAutosipOrders.js:117-125,274-291; jobs/activations/sbi/placeActivatedOrders.js:413-433`


**Claimed:** Reasonable assumption: the EOD job that marks stuck dealer batches as unfilled covers SBI.

**Actually:** markDealerBatchesAsUnfilledEOD's query is hardcoded to broker: { $in: ['axis','hdfc','hdfc-mtf'] } with dealer:true and status 'ERROR'. SBI and SBI-MTF are excluded. The only SBI-MTF equivalent is cleanupMtfNonTerminalBatches, which marks batches MARKEDCOMPLETE (not UNFILLED) and only when they are not the latest batch for their iscid.

`jobs/reconciliations/markBatchesAsUnfilled.js:16-26; jobs/cleanup/cleanupMtfNonTerminalBatches.js:5,26,53-107`


**Claimed:** Reasonable assumption: the two SBI recon jobs agree on what date 'today' is.

**Actually:** They do not. sbiReconAllOrders defaults --date to `new Date().toISOString().split('T')[0]` (raw UTC date). sbiRejectedAmoOrdersIngest defaults it to `new Date(now.getTime() + 5.5h).toISOString().split('T')[0]` (IST-adjusted). Between 00:00 and 05:30 IST the two pick DIFFERENT days. sbiReconAllOrders additionally builds its DB window as `new Date(yargs.date + 'T00:00:00.000Z')` to +1 day — a UTC day, not an IST day — so SBI orders placed between 00:00 and 05:30 IST land outside it.

`jobs/reconciliations/sbiReconHelperFiles/sbiReconDependencies.js:1-4; jobs/reconciliations/sbiRejectedAmoOrdersIngest.js:3-8; jobs/reconciliations/sbiReconAllOrders.js:1169-1179`


**Claimed:** Reasonable assumption: a 'postponed to next working day' log line means today is genuinely a market holiday.

**Actually:** createSbiAutosipOrders registers its initCalender callback WITHOUT the err parameter (`activeDays.initCalender(async () => {...})`), silently discarding a calendar-load failure. activeDays.initCalender does pass err as its first callback argument. If the Holidays fetch fails or the Holidays document for the current year is missing, fullCalender stays empty, isWorkingDay() returns false for every date, and the job emits exactly the same 'Auto Sip place orders postponed to next working day' line while placing zero SIPs. Confirm against the Holidays collection, not against the log line.

`jobs/autosips/sbi/createSbiAutosipOrders.js:528-556; node_modules/@smallcase/sc-platform-babel/activeDays/activeDays.js:63-115,125-132,165-190; node_modules/@smallcase/sc-platform-babel/activeDays/tasks/setHolidays.js:38-65`


## Open questions (9)

Genuinely unresolved. Report these as unknown rather than guessing.

- The actual cron expressions / IST run times for every SBI job (placeSbiAutosips, placeSbiActivatedOrders, sbiActivation, sbiRebalanceSipOrderPlace, sbiReconAllOrders, sbiRejectedAmoOrdersIngest, amoPoll, cancelFailedAutosipsEod, sbiActivationAutosipReport, cleanupMtfNonTerminalBatches) are NOT in this repo. They live in the scheduler service's Bull queue. Unresolved: does the org have a UI/API to dump them, and is the scheduler service source checked out anywhere? Until then the skill should derive schedules empirically from the epoch-ms suffix in sc-prod-logs object keys and from S3 LastModified, and should say so rather than quoting invented times.
- What `job.data.name` is for each SBI script in the prod scheduler — i.e. the exact S3 filename prefix. The repo's internal jobName constants (placeSbiAutosips, sbiActivation, ...) are only a hint; the guide's own example key 'sbiReconAllOrders-batchCreation_repeat:...' shows the scheduler uses names like <script>-<variant> that appear nowhere in this repo.
- Which SBI jobs, if any, are configured with a killInterval in the scheduler. This determines whether a long autosip/activation run can be silently truncated mid-loop while still being reported as successful. Nothing in this repo can answer it.
- Whether the rotating bunyan file at /deployments/logs/sclogs_sc-integrations-jobs is shipped anywhere (e.g. to sc-pm2logs-new). If it is, it would be a second copy of job logs that survives an S3 upload failure — but I found no shipper config in this repo.
- Whether the prod env file sets APPLICATION_NAME. If unset, the bunyan logger name falls back to the directory basename ('sc.service.sc-integrations-jobs'); if set to something else, the greppable "name" field differs. Only the staging env file is checked in, and it does not set APPLICATION_NAME.
- Whether prod actually runs scheduler-agent 2.2.0 or a newer version. The installed copy matches package.json's ^2.2.0 so the S3 key format and stdout-only capture are almost certainly prod-accurate, but a newer 2.x could have changed the upload path and nothing here proves the deployed version.
- Whether the deployed EC2 hosts run in UTC. Enormous amounts of date logic (triggerAmoPoll's 03:30/10:00 constructors, hangingOrderEodReport's setHours(18,30), activeDays' local-midnight calendar) are correct ONLY under UTC. I could not verify the instance timezone from any file in the workspace. If any host is on IST, isWorkingDay() would return false universally on that host.
- What populates s3://sc-integrations-sbi-attachments/sbi_recon/<date>/, mtf_recon/<date>/ and sbi_rejected_amo_orders/<date>/. Nothing in sc-integrations-jobs writes those prefixes — it only reads them. The producer (an SES/Lambda email-attachment pipeline, given the sibling buckets sc-integrations-sbi-emails / sc-integrations-sbi-attachments in the IAM policy) is outside this repo, so 'why is today's SBI file missing?' cannot be answered from here.
- Whether the SBI-MTF AMO gap is intentional. triggerAmoPoll includes sbi-mtf in amoAllowedBrokers but excludes it from the activated-order exception, and triggerAmoPollNonMarketDay omits sbi-mtf entirely. I can prove the behaviour; I cannot prove whether it is a deliberate product decision or an oversight when sbi-mtf was bolted on via the hardcoded concat.
