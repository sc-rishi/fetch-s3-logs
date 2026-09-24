# tooling-cli

The fetch-s3-logs toolkit itself, audited from source (not just --help output).

**branch when read:** main @ e16f7889c89cb8c7830d5064f33d7f339bfefdc9 — WORKING TREE IS DIRTY. `git status` shows ` M fetch-s3-logs.js`, ` M s3-search-utils.js`, ` M search-s3-logs.js`, ` M SBI_LOG_INVESTIGATION_GUIDE.md`, `?? test/fetch-s3-logs.test.js`, `?? AGENTS.md`, `?? .claude/`. Every fact below was read from the WORKING TREE files, not from the committed blobs at e16f788. If the skill is shipped against a fresh clone of `main`, three of the four scripts will differ from what is cited here. (Verified: `git -C /Users/rishidatta/Desktop/integrations/fetch-s3-logs rev-parse --abbrev-ref HEAD` → `main`.)

This repo is the read-only forensics toolkit the SBI skill drives. Four entry points: `fetch-by-identifier.js` (a 7-line shim that calls `cli()` from `search-s3-logs.js`) is the primary S3 log search — it maps a service name to 1-3 S3 surfaces, pushes a case-insensitive literal substring match down into S3 Select, and falls back to a full GetObject scan per object when Select can't be trusted; `redash-query.js` is the only sanctioned prod Mongo path (Redash ad-hoc aggregate API) and also supplies the anchor-date lookup that `search-s3-logs.js` uses when no date is given; `search-s3-recon.js` S3-Selects the SBI/MTF broker recon CSVs with exact-equality `IN (...)` predicates and downloads only matching files; `fetch-s3-logs.js` is the original low-level fetcher that the other tools reuse pure helpers from, and is the one the `server.js` web UI drives. The critical operational facts for an agent are: exit codes are meaningful and distinct (0 complete / 1 validation / 2 incomplete-scan / 3 not-found-in-DB), `--service all` is unusable without `--job-name`, `fetch-s3-logs.js` carries a hardcoded `DEFAULTS.FILTER_TEXT = "sc_rXWoyJfoH"` and a hardcoded `DEFAULTS.S3_URL` dated `2026-06-05` that silently apply when the corresponding flags are omitted, and `all-logs.filtered.log` is pretty-printed objects each followed by a trailing comma with no `[...]` wrapper — not parseable as one JSON document. Several ways an empty result can be a false negative exist (expired SSO surfaces as exit 2 with a `Listing failed:` line, `--service jobs --env staging` builds zero sources and exits 0 with zero results, a missing `.env` silently downgrades auto-scope to a flat 30-day window). 48 tests exist and all pass; they guarantee the date/tier/Select-fallback logic but cover none of `fetch-s3-logs.js`'s `run()` path or `server.js`.

Confidence markers are the researcher's own: unmarked = confirmed from source, `[INFERRED]` = deduced but unproven, `[UNCONFIRMED]` = a lead, not a fact. `!` marks facts flagged critical.


## Facts (86)


### toolkit-layout

- **!** `fetch-by-identifier.js` is a 7-line shim containing only `const { cli } = require('./search-s3-logs'); cli();`. All behaviour, flags, exit codes and output live in `search-s3-logs.js`. Reading `fetch-by-identifier.js` tells you nothing.  
  `fetch-by-identifier.js:1-7`
- package.json script aliases: `npm run logs:search` → `node fetch-by-identifier.js`; `npm run recon:search` → `node search-s3-recon.js`; `npm test` → `node --test`; `npm run ui` → `node server.js`. Dependencies are only `@aws-sdk/client-s3 ^3.936.0` and `express ^5.2.1`. `main` points at a file `s3-logs-fetch.js` that does not exist in the repo.  
  `package.json:3-17`
- Two further scripts exist that are NOT part of the documented toolkit and have no CLI flags — `fetch-s3-logs-unzip.js` (236 lines, hardcoded `JOB_CONFIG.S3_URL = 's3://sc-pm2logs-new/PROD/2025-11-21/sc-integrations-broker-api/'`, `FILTER: 'hdfcsky'`) and `extract-trading-accounts.js` (165 lines, a hardcoded list of ~24 `X_REQ_UIDS`). Both are one-off scratch scripts, superseded by `fetch-s3-logs.js --force-gunzip`. The skill should never invoke them.  
  `fetch-s3-logs-unzip.js:17-24, extract-trading-accounts.js:7-30`

### fetch-by-identifier-flags

- **!** Search flags — EXACTLY ONE of `--tag <v>`, `--order-id <v>`, `--batch-id <v>`, `--text <literal>` is required. Zero or two or more throws `Pass exactly one of --tag, --order-id, --batch-id, or --text.` and exits 1. There are no aliases and no short forms except `-h` for `--help`.  
  `search-s3-logs.js:121-124, search-s3-logs.js:141-143`
- **!** `--service` is REQUIRED with no default. Valid values are `order-updates`, `broker-api`, `platform-api`, `jobs`, `jobs-recon`, or the literal `all`. Multiple services may be comma-separated (`--service order-updates,jobs`), trimmed and de-duplicated. Any unrecognised entry throws `Invalid --service value.` and exits 1.  
  `search-s3-logs.js:49-67, search-s3-logs.js:145-147, search-s3-logs.js:164-173`
- **!** Full flag list (there are NO flags hidden from `--help` in this script): `--tag`, `--order-id`, `--batch-id`, `--text`, `--date`, `--from`, `--to`, `--month`, `--service`, `--job-name`, `--env`, `--out`, `--concurrency`, `--help`/`-h`. Any other token throws `Unknown option: <token>` and exits 1 — unlike redash-query.js, an unknown flag is fatal here, not a warning.  
  `search-s3-logs.js:114-138`
- Every flag requires a value, and the parser rejects a value that itself begins with `--`: `if (!value || value.startsWith('--')) throw new ValidationError('Missing value for ' + option)`. So `--text --foo` or a trailing flag with no value exits 1 with `Error: Missing value for --text`. A search term legitimately starting with `--` cannot be passed.  
  `search-s3-logs.js:119-120`
- `--env` accepts only `prod` (default) or `staging`; anything else exits 1 with `--env must be prod or staging.`. `--concurrency` defaults to 16 and must be an integer 1..50 inclusive; out of range exits 1 with `--concurrency must be an integer from 1 to 50.`  
  `search-s3-logs.js:29-30, search-s3-logs.js:115, search-s3-logs.js:148-153`
- `--out` defaults to `path.join(__dirname, 'logs', 'lookup-<kind>-<Date.now()>')` where `<kind>` is one of `tag|orderId|batchId|text` — i.e. relative to the REPO directory, not the cwd. An explicit `--out` is `path.resolve()`d against the cwd instead.  
  `search-s3-logs.js:631, search-s3-logs.js:783`
- **!** Date scope is mutually exclusive: only one of `--date <YYYY-MM-DD>`, `--from`+`--to`, or `--month <YYYY-MM>` may be given; two or more throws `Use only one of --date, --from/--to, or --month.`. `--from` and `--to` must be supplied together (`--from and --to must be supplied together.`). `--from`/`--to` may span at most 30 days inclusive; `--month` is rejected outright for any 31-day month with `--month <m> contains more than 30 days; use a <=30-day --from/--to range.`  
  `search-s3-logs.js:201-229`

### fetch-by-identifier-traps

- **!** TRAP: `--service all` expands to ALL of SERVICE_KEYS including `jobs-recon`, and `jobs-recon` requires `--job-name`. Therefore `--service all` ALWAYS fails with exit 1 unless `--job-name` is also passed. Verified by running it: `node fetch-by-identifier.js --service all --batch-id 6a221fb2d963eea6efaeabfa --from 2026-09-18 --to 2026-09-20` → `Error: --service jobs-recon requires --job-name.` EXIT=1.  
  `search-s3-logs.js:67, search-s3-logs.js:154-157, search-s3-logs.js:165-166`
- **!** TRAP (silent false negative): `--service jobs --env staging` builds ZERO sources. The `jobs` entry in APP_SERVICES has no `eksPod` key, so no EKS source is added, and the EC2 block is guarded by `if (env === 'prod')`. The run then lists 0 objects, scans 0, and `manifest.status` is `complete` because `scanned === listed`, so it EXITS 0 reporting zero matches. An empty result here means "no such surface", not "no such order".  
  `search-s3-logs.js:65, search-s3-logs.js:269-292, search-s3-logs.js:732`
- **!** TRAP: the match is a case-insensitive SUBSTRING match, never an exact field match. S3 Select uses `LOWER(s._1) LIKE '%<value>%'` and the local re-check is `line.toLowerCase().includes(needle)`. `--order-id 12345` therefore matches any log line containing `12345` anywhere — inside a price, a timestamp, an unrelated id. The manifest's `query.literal: true` means "literal, not regex", NOT "exact".  
  `search-s3-logs.js:345-348, search-s3-logs.js:423, search-s3-logs.js:612`
- `escapeLikeLiteral()` lowercases the search value and escapes LIKE metacharacters `!`, `%`, `_` as `!!`, `!%`, `!_`, with `ESCAPE '!'`. Every `sc_`/`scmtf_` tag contains an underscore, so this escaping is load-bearing — without it `sc_x` would LIKE-match `scZx`. Confirmed by test asserting `'%sc!_rxwoyjfoh%'`.  
  `search-s3-logs.js:337-339, test/fetch-s3-logs.test.js:83-88`
- **!** TRAP: because `jobs-recon` sets `dated: false`, `listSourceObjects` takes the `if (!source.dated)` branch and lists EVERY object under `sc-integrations-jobs/<jobName>` — the job's complete history — ignoring `--date`/`--from`/`--to`/`--month` at the listing stage. Date scoping is applied only per-line afterwards via `lineIsInScope`. So a one-day `jobs-recon` search still scans every run of that job ever logged.  
  `search-s3-logs.js:311-315, search-s3-logs.js:407-413`
- TRAP (misleading console output): `discoverObjects` prints `Listing <surface> for N date(s)...` whenever `dates` is truthy — and `args.dates` is always populated. For a `jobs-recon` source this line claims a date-scoped listing while the code is actually listing the entire prefix. Do not trust that line as evidence of scope for jobs-recon.  
  `search-s3-logs.js:329, search-s3-logs.js:311-315, search-s3-logs.js:160`
- **!** TRAP (stale-result contamination): in auto-scope mode the merged `<out>/matches.jsonl` and `<out>/all-logs.filtered.log` are written with `fs.appendFileSync` and are NEVER truncated first. Re-running auto-scope into the same `--out` directory APPENDS to the previous run's results, producing duplicates. Explicit-date runs (`runSearch`) truncate (`BufferedFileWriter` opens with `'w'`). The two modes are asymmetric — always use a fresh `--out` for auto-scope.  
  `search-s3-logs.js:748-753, search-s3-logs.js:827-828, search-s3-logs.js:369`
- **!** TRAP: if no tier matched anything, `mergeJsonlInto` returns early on empty content, so `<out>/matches.jsonl` and `<out>/all-logs.filtered.log` MAY NOT EXIST AT ALL after an auto-scope run. Only `manifest.json` is guaranteed. A missing matches.jsonl is a legitimate "zero matches", not a crash.  
  `search-s3-logs.js:748-753, search-s3-logs.js:827-828`
- TRAP: `finalExitCode` in `runAutoSearch` is overwritten by EVERY tier, so a failing early tier's exit code 2 is masked if a later tier completes cleanly. Combined with the deletion of per-tier manifests, an S3 failure inside tier 1 can vanish from the record entirely when tiers 2-4 run.  
  `search-s3-logs.js:809, search-s3-logs.js:824, search-s3-logs.js:834-841`

### fetch-by-identifier-surfaces

- **!** Service → S3 surface mapping (prod). `order-updates` → 3 surfaces: `order-updates/eks` = s3://sc-eks-pod-logs/production/<date>/integrations/sc-integrations-order-updates-pod/, `order-updates/ec2/out` = s3://sc-pm2logs-new/PROD/<date>/sc-integrations-order-updates/Out-logs/, `order-updates/ec2/err` = .../Error-logs/. `broker-api` and `platform-api` follow the same shape (platform-api's EKS namespace is `platform`, pod `sc-platform-api-pod`). In staging only the EKS surface exists, rooted at `staging/` instead of `production/`.  
  `search-s3-logs.js:49-66, search-s3-logs.js:269-292`
- **!** `jobs-recon` is a completely different source shape: bucket `sc-prod-logs`, prefix `sc-integrations-jobs/<jobName>` (NO trailing slash), `dated: false`, `forceGzip: true`, `filterLineDate: true`. Because the prefix has no trailing slash it is a prefix-substring match — `--job-name sbiRecon` would also list `sbiReconAllOrders`, `sbiReconXyz`, etc. `--env` is ignored entirely for this surface; it is always the prod bucket.  
  `search-s3-logs.js:257-267`

### fetch-by-identifier-linefilter

- **!** `lineIsInScope()` only applies when `source.filterLineDate` is set (i.e. only jobs-recon). It parses the line's JSON `time` field, converts to IST by adding 330 minutes, takes the `YYYY-MM-DD`, and requires membership in the date set. If the line has no parseable `time`, it falls back to the object's S3 `LastModified` converted the same way; if that is also absent the line is DROPPED. Test asserts a UTC `2026-06-04T19:00:00Z` line is IN scope for IST date `2026-06-05`.  
  `search-s3-logs.js:392-413, search-s3-logs.js:401-405, test/search-s3-logs.test.js:257-262`

### fetch-by-identifier-select

- The S3 Select input serialization is a deliberate hack that treats each whole log line as one CSV field `_1`: `RAW_LINE_CSV = { FileHeaderInfo:'NONE', RecordDelimiter:'\n', FieldDelimiter:'\t', QuoteCharacter:'\r', QuoteEscapeCharacter:'\r' }`. `FileHeaderInfo:'NONE'` means the first line is treated as data, so no line is skipped.  
  `search-s3-logs.js:68-74, search-s3-logs.js:433-439`
- The Select expression deliberately ORs in a tab detector: `SELECT * FROM S3Object s WHERE LOWER(s._1) LIKE '<pat>' ESCAPE '!' OR CHAR_LENGTH(s._2) > 0`. Any log line containing a literal TAB splits into `_2`, is returned, sets `state.tabCollision`, and throws `SelectFallbackError('Unexpected tab-delimited record detected.')` — forcing a full GetObject download of that object. So one tab anywhere in an object costs a full download of it.  
  `search-s3-logs.js:345-348, search-s3-logs.js:415-427, search-s3-logs.js:470-472`
- A Select result is distrusted (and the object re-scanned by full download) if ANY of: no `End` event, no `Stats` event, `Stats.BytesScanned < object.size`, a tab collision, or a JSON parse error on a record. Auth errors are the exception — they short-circuit to a fatal `failed` result rather than falling back. Four separate tests pin each fallback trigger.  
  `search-s3-logs.js:466-472, search-s3-logs.js:542-553, test/search-s3-logs.test.js:196-255`
- **!** `isAuthError()` treats only these as fatal: `AccessDenied`, `CredentialsProviderError`, `ExpiredToken`, `InvalidAccessKeyId`, `SignatureDoesNotMatch` (matched against `error.name || error.Code`). An AWS SSO expiry that surfaces under a different name (e.g. `SSOTokenProviderFailure`, `ExpiredTokenException`) is NOT recognised as fatal and degrades into per-object `failed` results instead of stopping the run.  
  `search-s3-logs.js:497-500`

### fetch-by-identifier-exit-codes

- **!** Exit codes: 0 = `manifest.status === 'complete'`; 1 = any ValidationError or unexpected throw (set in `cli()`); 2 = incomplete — either the listing phase threw, or `objects.scanned !== objects.listed`, or an output write/close failed; 3 = `not_found_in_db` (auto-scope only: Redash found no order across all three lookback tiers, so S3 was never touched). Exit 2 does NOT mean "no results" — matches may still have been written.  
  `search-s3-logs.js:647, search-s3-logs.js:732, search-s3-logs.js:745, search-s3-logs.js:798, search-s3-logs.js:869-881`

### fetch-by-identifier-stdout

- **!** On a non-auto-scope run, the LAST thing printed to stdout is a pretty-printed JSON object with exactly these keys: `status`, `listedObjects`, `scannedObjects`, `fallbackObjects`, `failedObjects`, `matchedObjects`, `matchedLines`, `outputDir`. On an auto-scope run the final object instead has: `status`, `anchorDate`, `tiersRun`, `totalDatesSearched` (a COUNT, not the array), `totalMatched`, `outputDir`.  
  `search-s3-logs.js:735-744, search-s3-logs.js:851-858`
- **!** TRAP for stdout parsing: in auto-scope mode `runSearch` is called once per tier and each call prints its OWN summary JSON blob before the final auto-scope summary. stdout therefore contains multiple concatenated pretty-printed JSON objects. Parse `<out>/manifest.json` instead of scraping stdout, or take only the last blob.  
  `search-s3-logs.js:735-744, search-s3-logs.js:824, search-s3-logs.js:851-858`

### fetch-by-identifier-artefacts

- **!** `<out>/matches.jsonl` is genuine JSON Lines. Each line is `{ s3Uri, service, surface, objectLastModified, time, log }` where `s3Uri` is `s3://<bucket>/<key>`, `surface` is e.g. `order-updates/eks`, `objectLastModified` is an ISO string or null, `time` is the log line's own `time` field or null, and `log` is the parsed line. Parse it with one `JSON.parse` per line.  
  `search-s3-logs.js:567-576, search-s3-logs.js:594`
- **!** `matchEntry().log` is produced by `parseLog()`: it `JSON.parse`s the line; if that fails it returns `{ raw: line }`; and if `log.message` is a STRING that itself parses as JSON it is replaced in place by the parsed object. So EKS-wrapped lines (where the real payload is a JSON string in `message`) come back already un-nested, while EC2 lines keep their native shape. A test pins both.  
  `search-s3-logs.js:555-565, test/search-s3-logs.test.js:172-179`
- **!** `<out>/all-logs.filtered.log` is NOT valid JSON as a whole file — it is each `match.log` pretty-printed with `JSON.stringify(x, null, 2)` followed by a literal `,\n`, with NO enclosing `[...]` and a trailing comma on the last record. Verified on a real artefact: `tail -c 120 logs/new-tags-2026-06-01/order-updates/all-logs.filtered.log` ends `..."v": 0\n},`. Parse it by brace-depth scanning (as server.js does) or by stripping the trailing comma and wrapping in brackets.  
  `search-s3-logs.js:595, fetch-s3-logs.js:686, server.js:149-182`
- **!** `<out>/manifest.json` from a non-auto run has: `status`, `snapshotStartedAt`, `completedAt`, `outputDir`, `query {kind, value, caseInsensitive:true, literal:true}`, `scope {services[], environment, dateScope, dates[], jobName}`, `sources[] {surface,bucket,root}`, `objects {listed,scanned,selected,fallback,failed,matched}`, `lines {matched}`, `bytes {scanned,processed,returned,fallbackDownloaded}`, `matchedKeys[]` (sorted s3 URIs), `fallbacks[]`, `errors[]`, plus `errorDetailsTruncated`/`fallbackDetailsTruncated` when over 100 entries.  
  `search-s3-logs.js:606-628, search-s3-logs.js:601-604, search-s3-logs.js:728-732`
- **!** The auto-scope `manifest.json` is a COMPLETELY DIFFERENT schema and overwrites the per-tier one: `{ status, query, anchor:{date,note}, tiers:[{label,daysBack,daysForward,newDates[],matched,status}], totalDatesSearched:[dates], totalMatched, completedAt, outputDir }`. It has NO `objects`, `bytes`, `errors`, `matchedKeys` or `sources`. Any per-object error detail from a tier is destroyed when the `.tier-N` scratch dir is removed.  
  `search-s3-logs.js:840-850, search-s3-logs.js:834-837`
- `manifest.totalMatched` in auto-scope mode counts matched OBJECTS (`tierManifest.objects.matched` summed), not matched lines. A test asserts `totalMatched === 3` for a single matching log line, because the same line was found across 3 surfaces (eks / ec2-out / ec2-err).  
  `search-s3-logs.js:829, test/search-s3-logs.test.js:440`

### auto-scope

- **!** Auto-scope is entered only when `args.dateScope !== 'explicit'` AND the identifier kind is one of `tag`, `orderId`, `batchId`. `--text` is NEVER auto-scoped — it always uses the flat latest-30-days window. `dateScope` is `'explicit'` iff `--date` or `--month` or `--from` was supplied.  
  `search-s3-logs.js:159, search-s3-logs.js:862-867`
- **!** `decodeObjectIdDate(value)`: returns null unless the value matches `/^[0-9a-fA-F]{24}$/`; otherwise parses the first 8 hex chars as Unix SECONDS and returns `new Date(seconds * 1000)`. This works because `order._id = order.batchId` (verified: sc-integrations-babel/src/models/Order.js:33, on branch `production`). Cost: zero network calls. A 23-char value returns null.  
  `search-s3-logs.js:231-239, test/search-s3-logs.test.js:324-333`
- **!** `resolveAnchorDate` branches on kind. `batchId` → local ObjectId decode only, note `batchId-objectid-timestamp` on success or `batchId-not-a-valid-objectid` on failure — Redash is NEVER consulted for a batchId (pinned by a test that asserts `isConfigured()` was not even called). `tag`/`orderId` → `redash.isConfigured()` first (note `redash-not-configured` if false), then the tiered lookup.  
  `search-s3-logs.js:757-780, test/search-s3-logs.test.js:352-359`
- **!** `REDASH_LOOKBACK_TIERS_DAYS = [7, 14, 30]`. `resolveAnchorDate` calls `redash.findOrderAnchorDate({ tag|orderId, lookbackDays })` at 7, then 14, then 30, STOPPING at the first tier that returns a date. Notes are `redash-lookup-7d` / `-14d` / `-30d`. If a tier returns a date that is not a valid Date, it sets `redash-lookup-invalid-date` and BREAKS without trying wider tiers. Tier order and early-stop are both pinned by tests.  
  `search-s3-logs.js:38, search-s3-logs.js:768-779, test/search-s3-logs.test.js:361-388`
- **!** Documented cost per Redash lookback tier (empirical, recorded in the source comments): 7d ≈ 20s, 14d ≈ 24s, 30d ≈ 44s, 60d+ unreliable/timeout. `orders.tag` / `unplaced.tag` / `.orderId` are unindexed array fields so cost scales with the date-range width. Worst case for an auto-scope tag lookup is roughly 20+24+44 ≈ 88s of Redash time before S3 is touched at all.  
  `search-s3-logs.js:33-38, search-s3-logs.js:765-767, redash-query.js:226-230`
- **!** S3 tier widths (`AUTO_SCOPE_TIERS`): tier1_3d = {back 1, forward 2} → 4 days; tier2_9d = {1, 7} → 9 days; tier3_17d = {1, 15} → 17 days; tier4_30d_max = {1, DEFAULT_SEARCH_DAYS-2 = 28} → 30 days. NOTE the label `tier1_3d` understates its true 4-day width (the test computes width as daysBack+daysForward+1 and asserts monotonic growth capped at 30). The bias is deliberately FORWARD because a delayed update or fix appears after placement.  
  `search-s3-logs.js:39-48, test/search-s3-logs.test.js:345-350`
- **!** `datesAroundAnchor(anchor, back, forward)` returns an inclusive ascending `YYYY-MM-DD` list, CLAMPED so the end never exceeds today in IST (`istDate(new Date())`), and returns `[]` if start > end. Each tier searches only the NEW dates not covered by a narrower tier (`triedDates` set); a tier whose new-date set is empty is recorded as `{ skipped: 'no-new-dates' }` and does not run.  
  `search-s3-logs.js:241-252, search-s3-logs.js:812-819, test/search-s3-logs.test.js:335-343`
- The widening loop bails as soon as `matchedSoFar > 0` OR the last tier has run. Both the early-stop and the full-widen paths are pinned by tests, as is the cleanup of `.tier-N` scratch directories.  
  `search-s3-logs.js:832-838, test/search-s3-logs.test.js:411-466`
- **!** Bail-out matrix when no anchor is resolved: note `not-found-in-lookback-window` → writes a `{status:'not_found_in_db', query, note, completedAt}` manifest, NEVER touches S3, exits 3. ANY other note (`redash-not-configured`, `batchId-not-a-valid-objectid`, a Redash error) → prints `No anchor date available (<note>); falling back to the flat latest-30-days window.` and runs the plain 30-day search. Both pinned by tests (exit 3 asserts `s3Called === false`).  
  `search-s3-logs.js:786-804, test/search-s3-logs.test.js:468-508`

### redash-query-flags

- **!** `redash-query.js` flags: `--collection <name>` (REQUIRED), `--tag`, `--batch-id`, `--order-id`, `--broker`, `--status`, `--from <YYYY-MM-DD>`, `--to <YYYY-MM-DD>`, `--match '<json>'`, `--limit <n>`, `--out <file>`, `--raw`, `--help`/`-h`. All shortcuts AND together. There is no `--service` and no concurrency flag.  
  `redash-query.js:76-96, redash-query.js:46-74`
- **!** `buildMatch()` shapes: `--tag X` → `{$or:[{'orders.tag':X},{'unplaced.tag':X}]}`; `--batch-id X` → `{$or:[{batchId:X}]}` plus `{_id:{$oid:X}}` ONLY when X is 24 hex chars; `--order-id X` → `{$or:[{'orders.orderId':X},{'unplaced.orderId':X},{'orders.exchangeOrderId':X},{'unplaced.exchangeOrderId':X}]}`; `--broker`/`--status` → plain equality on the top-level field; `--from`/`--to` → `{date:{$gte:{$date:<IST midnight as UTC>}, $lte:{$date:<IST 23:59:59.999 as UTC>}}}`. Multiple clauses wrap in `$and`. Pinned by tests, including that `2026-06-05` → `2026-06-04T18:30:00.000Z`..`2026-06-05T18:29:59.999Z`.  
  `redash-query.js:106-146, redash-query.js:98-104, test/redash-query.test.js:17-36`

### redash-query-traps

- **!** GUARD: `requiresDateBound()` blocks `(--tag || --order-id) && !--batch-id && !(--from || --to)` — exits 1 with a four-line explanation before any query runs. Passing `--batch-id` alongside a tag, OR either of `--from`/`--to` (only one is enough), lifts the guard. A bare `--match` is the documented escape hatch and is NEVER blocked — so `--match '{"orders.tag":"sc_x"}'` bypasses the safety rail entirely and WILL full-scan production.  
  `redash-query.js:249-255, redash-query.js:267-273, test/redash-query.test.js:7-15`
- **!** TRAP: an unrecognised flag in `redash-query.js` only emits `console.warn('Unknown argument: <x>')` and the run CONTINUES with that flag silently dropped. A typo like `--batchid` therefore produces a query with no batch filter — potentially an unbounded collection query that the `requiresDateBound` guard will not catch. Contrast `search-s3-logs.js`, where an unknown flag is fatal.  
  `redash-query.js:93, search-s3-logs.js:134`
- TRAP: `--limit` is `Number(argv[++i])`; a non-numeric value becomes NaN, and `if (args.limit) pipeline.push({$limit:...})` treats NaN as falsy — so the limit stage is silently omitted and the query returns everything it matches, with no warning.  
  `redash-query.js:90, redash-query.js:277`

### redash-query-protocol

- **!** Redash protocol: `POST <REDASH_URL>/api/query_results` with body `{query: JSON.stringify(queryObj), data_source_id: Number(REDASH_DATA_SOURCE_ID), max_age: 0}`. If the response carries `query_result` it is returned directly (a cache hit — unlikely with `max_age:0`); otherwise poll `GET /api/jobs/<id>` every 800 ms for up to 150 polls (~120 s). Job `status === 3` means success → `GET /api/query_results/<query_result_id>`; `status === 4` means failure → throws `Redash query failed: <error>`. Timeout throws `Redash query did not complete within 120s (job <id>)`.  
  `redash-query.js:184-214`

### redash-query-output

- **!** Output contract: rows go to STDOUT as `JSON.stringify(rows, null, 2)` (or the full Redash response when `--raw`), while ALL progress/diagnostic text goes to STDERR — `Querying collection=<c>, match=<json>[, limit=<n>]`, `<n> row(s) returned.`, `Written to <path>`. So `node redash-query.js ... > out.json` yields clean JSON. With `--out <file>` nothing is printed to stdout at all.  
  `redash-query.js:280-295`
- **!** `findOrderAnchorDate({tag|orderId|batchId, lookbackDays=30})` returns `{date: Date, reason:'found'}` or `{date:null, reason:'not-found-in-lookback-window', lookbackDays}` or `{date:null, reason:'redash-not-configured'}`. It always queries the `orders` collection with `aggregate:[{$match},{$limit:1}], allowDiskUse:true`, and it omits the date bound only when `batchId` is supplied. The window is `from = today - lookbackDays` to `to = today`, both converted through `buildMatch`'s IST day boundaries.  
  `redash-query.js:232-247`

### search-s3-recon

- **!** `search-s3-recon.js` flags: `--tag`, `--order-id`, `--exchange-order-id` (each REPEATABLE — repeat the flag, do not comma-separate), `--out <dir>` (default `./logs/recon-search`, resolved against the CWD not `__dirname`), `--concurrency <n>` (default 8, must be an integer 1..50), `--help`. At least one identifier is required. Bucket is hardcoded `sc-integrations-sbi-attachments`; prefixes are hardcoded `sbi_recon/` and `mtf_recon/`.  
  `search-s3-recon.js:22-42, search-s3-recon.js:65-93, search-s3-recon.js:152`
- **!** `predicate()` builds `s._9 IN (tags) OR s._4 IN (orderIds) OR s._11 IN (exchangeOrderIds)` — an OR union across field groups, and EXACT equality within each (`IN`, not `LIKE`). Unlike the log search, this is NOT a substring match: a tag with any surrounding whitespace or differing case in the CSV will not match. Column order is documented as `buy_sell_ind, qty_original, client_id, order_no, average_price, security_id, trade_date, traded_qty, tag_or_remarks, status, exchange_order_no, source_flag` (so _4 = order_no, _9 = tag_or_remarks, _11 = exchange_order_no).  
  `search-s3-recon.js:25-38, search-s3-recon.js:99-107`
- **!** Recon search has NO date scoping at all — it lists and S3-Selects every `.csv` under both prefixes for all of history, every run. Batch many identifiers into ONE invocation (one `IN (...)` clause per field) rather than looping. It downloads only objects that had matching rows, to `<out>/<sbi|mtf>/<key with non-[A-Za-z0-9._-] runs replaced by __>`.  
  `search-s3-recon.js:109-116, search-s3-recon.js:140-148, search-s3-recon.js:168-189`
- **!** Recon artefacts: `<out>/matches.json` = `[{surface, key, rows:[raw CSV line strings], downloadedFile}]`; `<out>/manifest.json` = `{bucket, searchedPrefixes[], query:{tags,orderIds,exchangeOrderIds}, columnOrder[], scannedFiles, matchedFiles, downloadedFiles[], errors[]}`. Both are ordinary JSON (written via `writeJson`, pretty-printed). Stdout gets `{scannedFiles, matchedFiles, downloadedFiles, errors, outputDir}`.  
  `search-s3-recon.js:156-201, s3-search-utils.js:123-125`
- **!** Recon exit codes: 0 when `manifest.errors` is empty, 2 when it is not, 1 when `parseArgs` throws (message `Recon search failed: <msg>`). A per-object Select failure is captured as `{surface,key,error}` in `manifest.errors` rather than aborting — so an access failure is never silently reported as "no match", it forces exit 2. A whole-prefix listing failure is also captured and that prefix is skipped.  
  `search-s3-recon.js:131-138, search-s3-recon.js:168-176, search-s3-recon.js:201-211`
- **!** The recon Select uses `InputSerialization: { CSV: { FileHeaderInfo: 'IGNORE' } }`. Under S3 Select semantics IGNORE means "a header line is present; skip it and address columns positionally". If the recon CSVs are in fact headerless, the FIRST DATA ROW of every CSV is silently dropped from every search. I could not verify whether these CSVs carry a header — no recon CSV exists under logs/ in this checkout. `[INFERRED]`  
  `search-s3-recon.js:118-129`

### fetch-s3-logs-defaults

- **!** THE most dangerous trap in the toolkit: `fetch-s3-logs.js` carries `DEFAULTS.FILTER_TEXT = "sc_rXWoyJfoH"` — a specific historical tag. If `--filter-text` is omitted, this filter is applied SILENTLY (`if (!args.noFilterText && filterText is empty && DEFAULTS.FILTER_TEXT) args.filterText = normalize(DEFAULTS.FILTER_TEXT)`). Every run without an explicit `--filter-text` searches for someone else's tag and returns nothing, which reads exactly like "this order has no logs".  
  `fetch-s3-logs.js:102, fetch-s3-logs.js:924-927`
- **!** The escape hatch for the above is `--no-filter-text`, which is parsed but is NOT documented in `--help`. `--no-sort` is likewise parsed and undocumented. These are the only two hidden flags in the script.  
  `fetch-s3-logs.js:297-298, fetch-s3-logs.js:112-171`
- **!** Other silent DEFAULTS applied when the flag is omitted: `S3_URL = 's3://sc-pm2logs-new/PROD/2026-06-05/sc-integrations-order-updates/'` (a FIXED historical date, `const DATE = '2026-06-05'`) applied only when neither `--s3-url` nor `--bucket` was given; `OUT_DIR='./logs'`; `IST: true` (so `--from`/`--to`/`--modified-*` are ALWAYS interpreted as IST unless they carry an explicit timezone); `CONCURRENCY: 120`; `SORT: 'nf'` (newest first, always on); `CI: true` (always case-insensitive); `PARSE_MESSAGE: true`. `DATE_FROM`/`DATE_TO`/`FROM`/`TO`/`FILTER_NOT_TEXT`/`FILTER_FIELD`/`DIR` are empty or commented out.  
  `fetch-s3-logs.js:57-110, fetch-s3-logs.js:915-960`
- `DEFAULTS.CONCURRENCY = 120` beats the `DEFAULT_CONCURRENCY = 4` constant, and unlike `search-s3-logs.js` there is NO upper-bound validation on `--concurrency` in this script. 120 concurrent S3 GetObject/Select requests is the default behaviour.  
  `fetch-s3-logs.js:64, fetch-s3-logs.js:105, fetch-s3-logs.js:947-948`

### fetch-s3-logs-traps

- **!** TRAP (silent OR→AND narrowing, a real bug): the local filter combines text and field matches with OR — `includeByContent = hasContentFilter ? (textMatch || fieldMatch) : true`. But the S3 Select push-down applies ONLY the `--filter-text` AND-clause, so when Select succeeds the field filter is evaluated exclusively on lines that already matched the text. Combined with the always-on `DEFAULTS.FILTER_TEXT`, a `--filter-field batchId=X`-only invocation returns only lines containing `sc_rXWoyJfoH` AND matching the field — i.e. almost always nothing. Results also differ depending on whether Select happened to succeed or fall back.  
  `fetch-s3-logs.js:657, fetch-s3-logs.js:810-838, fetch-s3-logs.js:752-757, fetch-s3-logs.js:924-927`
- **!** TRAP: `fetch-s3-logs.js` exits 0 even when individual objects failed. Per-object errors are caught, counted, and reported as `Completed with N failure(s).` on stdout — the process still exits 0. Only argument/date/URL validation errors and a top-level throw produce exit 1. A partial scan is indistinguishable from a clean one by exit code alone; you must grep stdout for `Failed for key=` or `Completed with`.  
  `fetch-s3-logs.js:1132-1135, fetch-s3-logs.js:1183-1187, fetch-s3-logs.js:1190-1195`
- **!** TRAP: with sorting active (and `DEFAULTS.SORT='nf'` means it always is unless `--no-sort`), EVERY matching line from EVERY object is buffered in memory in a `globalBuffer` before anything is written. A wide `--date-from`/`--date-to` scan can exhaust memory. Also, if the buffer ends up empty, NOTHING is written and the pre-existing `all-logs.filtered.log` was already unlinked at the start — so zero matches leaves NO output file at all.  
  `fetch-s3-logs.js:1049-1053, fetch-s3-logs.js:1098, fetch-s3-logs.js:1148-1179`
- TRAP (unsorted mode only): all objects append to the SAME `all-logs.filtered.log` via separate `fs.createWriteStream` handles — the first gets flag `'w'`, the rest `'a'` — while up to `concurrency` (default 120) of them run in parallel. The `'w'` stream is not guaranteed to be the first to finish, and concurrent buffered appends can interleave, so the aggregated file can be truncated or contain spliced records. The default `SORT:'nf'` masks this by routing through the in-memory buffer instead. `[INFERRED]`  
  `fetch-s3-logs.js:1105-1145, fetch-s3-logs.js:546-550`

### fetch-s3-logs-flags

- **!** `--region` is accepted by the parser but has NO effect — the help text says `Ignored. Region is hardcoded to ap-south-1.` and the S3Client is constructed with a literal `{ region: 'ap-south-1' }`. Unlike the other scripts, `fetch-s3-logs.js` sets `AWS_PROFILE='smallcase'`, `AWS_REGION`/`AWS_DEFAULT_REGION='ap-south-1'` UNCONDITIONALLY, overriding whatever the caller's environment had.  
  `fetch-s3-logs.js:52-56, fetch-s3-logs.js:122, fetch-s3-logs.js:986-988`
- **!** `--date`/`--date-from`/`--date-to` select which S3 DAY-PARTITION to scan, by substituting a literal `{date}` placeholder in `--s3-url`/`--bucket`/`--prefix`; output nests as `<out>/<date>/all-logs.filtered.log`. Range cap is 30 days. Mismatch is fatal in both directions: dates given with no `{date}` placeholder, or a `{date}` placeholder with no dates, each exit 1. These are NOT `--from`/`--to`, which filter individual log lines by their JSON `time`.  
  `fetch-s3-logs.js:128-134, fetch-s3-logs.js:968-984, fetch-s3-logs.js:1001-1033`
- **!** `--filter-text` values are ANDed: comma-separated values within one flag AND repeats of the flag all accumulate into one array, and every term must match. The S3 Select push-down mirrors this with `AND`-joined `LOWER(s._1) LIKE ... ESCAPE '!'` clauses and is ALWAYS case-insensitive (a deliberate safe superset — `--ci`/`--whole-word` are re-applied locally afterwards). `--whole-word` is local-only, implemented as `new RegExp('\\b'+escaped+'\\b')`, and is never pushed to Select.  
  `fetch-s3-logs.js:136-137, fetch-s3-logs.js:257-262, fetch-s3-logs.js:469-473, fetch-s3-logs.js:749-757`
- `--filter-field k=v` matches RECURSIVELY at any depth, descending through nested objects and arrays (`deepFieldEquals`), with key and value comparison both lowercased when `--ci` is on (and `CI:true` is the default). It also accepts boolean expressions: `--filter-field 'k1=v1 and k2=v2 or k3=v3'` parses into OR-of-AND clauses, and the flag is repeatable with repeats ORing together. A spec with no `=` is warned about and ignored.  
  `fetch-s3-logs.js:175-190, fetch-s3-logs.js:270-285, fetch-s3-logs.js:553-575, fetch-s3-logs.js:635-656`
- `--from`/`--to` filter individual lines by the JSON `time` field. A line with NO `time` field, or unparseable JSON, is EXCLUDED whenever a time filter is active. `--ist` (on by default via `DEFAULTS.IST`) parses a naive `YYYY-MM-DDTHH:mm[:ss]` as IST→UTC; a value ending in `Z` or `±hh:mm` is honoured as-is; 10-digit input is epoch seconds and 13+ is epoch ms.  
  `fetch-s3-logs.js:422-458, fetch-s3-logs.js:580-595, fetch-s3-logs.js:917`
- **!** `--force-gunzip` bypasses all gzip auto-detection. It is REQUIRED for `s3://sc-prod-logs/sc-integrations-jobs/...` per-run job logs, which are genuinely gzip but carry no `.gz` extension, no `ContentEncoding` and `ContentType: application/octet-stream`. Without it you get binary garbage. `--modified-after`/`--modified-before` filter by the S3 object's `LastModified` (also IST-interpreted) and exist for exactly these non-date-partitioned prefixes.  
  `fetch-s3-logs.js:90-94, fetch-s3-logs.js:145-149, fetch-s3-logs.js:846-850, fetch-s3-logs.js:1069-1088`

### prerequisites

- **!** AWS env setup differs per script. `search-s3-logs.js` and `search-s3-recon.js` use `process.env.X = process.env.X || <default>` for `AWS_PROFILE='smallcase'`, `AWS_REGION='ap-south-1'`, and set `AWS_SDK_LOAD_CONFIG='1'` — so a caller's existing `AWS_PROFILE`/`AWS_REGION` WINS. `fetch-s3-logs.js` assigns unconditionally and cannot be redirected to another profile or region.  
  `search-s3-logs.js:25-27, search-s3-recon.js:18-20, fetch-s3-logs.js:52-56`
- **!** The `smallcase` AWS profile in ~/.aws/config is SSO-based: `sso_account_id = 736414281642`, `sso_role_name = ineq-dev-sso`, `region = ap-south-1`, and it carries BOTH a legacy `sso_start_url = https://smallcase.awsapps.com/start` and a modern `sso_session = case-platforms` whose own start URL is `https://case-platforms.awsapps.com/start`. Modern SDKs prefer the `sso_session`, so `aws sso login --profile smallcase` authenticates against case-platforms. Re-auth is `aws sso login --profile smallcase`.  
  `~/.aws/config:1-10 (profile smallcase / sso-session case-platforms)`
- **!** Expired-SSO failure signature for `fetch-by-identifier.js`: the failure lands in the LISTING phase, so the run prints `Listing failed: <message>` to stderr, writes EMPTY `matches.jsonl` and `all-logs.filtered.log`, writes a manifest with `status:'incomplete'` and `errors[0].phase === 'listing'`, and exits 2. The skill must treat exit 2 + `errors[0].phase === 'listing'` as "re-authenticate", never as "order not found". Pinned by a test.  
  `search-s3-logs.js:637-648, test/search-s3-logs.test.js:533-545`
- **!** Redash credentials: `REDASH_URL`, `REDASH_API_KEY`, `REDASH_DATA_SOURCE_ID`, loaded by `loadEnvFile()` from `path.join(__dirname, '.env')` — i.e. the repo's own `.env` regardless of cwd — with `if (!(key in process.env))`, so real environment variables WIN over the file. `.env` is gitignored. All three keys are present in this checkout. Auth header is `Authorization: Key <REDASH_API_KEY>` over HTTPS.  
  `redash-query.js:27-44, redash-query.js:156-157, .gitignore:3`
- **!** Missing-`.env` failure signatures differ by entry point. Standalone: `node redash-query.js ...` exits 1 with `Error: REDASH_URL, REDASH_API_KEY, REDASH_DATA_SOURCE_ID must be set (.env or env vars).`. Via auto-scope: NO error — `isConfigured()` returns false, note becomes `redash-not-configured`, and the run prints `No anchor date available (redash-not-configured); falling back to the flat latest-30-days window.` and proceeds. A missing `.env` therefore silently degrades a targeted 4-day search into a 30-day one rather than failing.  
  `redash-query.js:216-218, redash-query.js:259-262, search-s3-logs.js:763, search-s3-logs.js:800-803`
- Required S3 permissions: `s3:ListBucket` + `s3:GetObject` + `s3:SelectObjectContent` on buckets `sc-eks-pod-logs`, `sc-pm2logs-new`, `sc-prod-logs` (log search) and `sc-integrations-sbi-attachments` (recon). `search-s3-logs.js` constructs its S3Client with `maxAttempts: 5`; `search-s3-recon.js` uses the SDK default.  
  `search-s3-logs.js:634, search-s3-recon.js:154, search-s3-logs.js:254-295, search-s3-recon.js:22`

### tests

- **!** 48 tests exist across 4 files and ALL PASS on this checkout (verified: `node --test` → `# pass 48 # fail 0`). Guaranteed-by-test behaviours: the 30-day cap and calendar-date validation; service→surface mapping (order-updates prod = 3 surfaces, jobs prod = out+err only, platform-api staging = eks only, jobs-recon forceGzip); Select expression escaping; continuation-token paging; all four Select→fallback triggers; jobs-recon IST line filtering; both output files written in one pass; exit 2 on unsearchable objects; ObjectId decode incl. rejection of 23-char input; `datesAroundAnchor` future clamp; tier monotonicity ≤30 days; Redash tier order 7→14→30 with early stop; exit 3 with `s3Called === false`; flat fallback when Redash unconfigured; explicit `--date` never calling Redash; recon scanning both prefixes and downloading only matches; the `requiresDateBound` matrix; `buildMatch` output shapes.  
  `test/search-s3-logs.test.js:1-546, test/fetch-s3-logs.test.js:1-131, test/redash-query.test.js:1-36, test/search-s3-recon.test.js:1-54`
- **!** NOT covered by any test (therefore incidental, not guaranteed): the entirety of `fetch-s3-logs.js`'s `run()`/`runForScope()` — the DEFAULTS merge, the text-OR-field combination, the concurrency/append behaviour, the global sort, the progress bar; all of `server.js`; `runRedashQuery`'s HTTP and polling logic; the auto-scope append-to-existing-outputDir behaviour. Only `resolveDateList`, `substitutePlaceholder`, `buildScopedArgs`, `buildTextSelectExpression` and `trySelectMatchingLines` are exported from `fetch-s3-logs.js` and tested.  
  `fetch-s3-logs.js:1197-1204, test/fetch-s3-logs.test.js:5-12, redash-query.js:305-314`

### server-ui

- `server.js` (`npm run ui`, `PORT` env or 3000) serves a single 50 KB `public/index.html` and exposes exactly five endpoints: `GET /api/defaults`, `GET /api/logs`, `GET /api/logs/content?file=`, `GET /api/tail?outDir=` (SSE), `POST /api/run` (SSE). It is strictly WEAKER than the CLI for SBI investigation — see the next fact.  
  `server.js:24-25, server.js:268, server.js:284-286`
- **!** `POST /api/run` spawns ONLY `node fetch-s3-logs.js` — never `fetch-by-identifier.js`, `redash-query.js` or `search-s3-recon.js`. So the UI offers NO auto-scope, NO Redash anchor lookup, NO recon CSV search. It passes only: `--s3-url`, `--out`, `--from`, `--to`, `--ist`, `--filter-text`, `--filter-field`, `--sort`, `--concurrency`, `--raw-field`, `--dir` (only when `s3Url` was explicit), `--ci`, `--parse-message`, `--start-after`, `--max-keys`. It never passes `--no-filter-text`, `--force-gunzip`, `--date*`, `--filter-not-text`, `--whole-word` or `--modified-*`, so it inherits every `DEFAULTS` trap. For any SBI order question, use the CLI.  
  `server.js:216-252`
- `GET /api/tail?outDir=` contains the reference implementation for reading `all-logs.filtered.log`: poll the file every 300 ms from a byte offset and brace-depth-scan the text, emitting each balanced `{...}` as one object. This is the correct way to parse that artefact incrementally. `GET /api/defaults` REGEX-scrapes the `DEFAULTS` block out of `fetch-s3-logs.js` source text (substituting `${DATE}`) and skips array/object values entirely — it is a fragile source parse, not a runtime read.  
  `server.js:133-200, server.js:28-87`
- `server.js` installs `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers that both `process.exit(1)` — the UI server dies on any unhandled error. Also `res.on('close', () => child.kill())` on `/api/run`: closing the browser tab kills the running fetch job mid-write.  
  `server.js:265, server.js:270-283`

### artefact-parsing

- `s3-search-utils.js` holds the shared primitives: `listObjects` (paginates all continuation tokens, skips keys ending `/`, applies an optional key filter, returns `{bucket,key,size,etag,lastModified}`), `listCommonPrefixes` (Delimiter '/'), `mapConcurrent`/`forEachConcurrent` (bounded worker pools), `readSelectPayload` (buffers everything), `forEachSelectRecord` (streams records with a `StringDecoder` so multibyte chars split across Payload events do not corrupt), `downloadObject`, and `writeJson` (pretty-printed + trailing newline).  
  `s3-search-utils.js:9-136`
- **!** Confirmed real log-line shape in a live artefact (bunyan): `{"name":"sc.service.sc-integrations-order-updates","hostname":"ip-10-137-1-148","pid":2142,"level":30,"type":"APPLICATION_LOGS","message":"Broker Poll initiated","trace.id":"...","transaction.id":"...","context":{"batchId":"...","orderStatusOptions":{"apiKey":"","accessToken":"X","orderKey":"sc_UNPzPQJY7","batchId":"..."}},"msg":"","time":"2026-06-01T10:31:52.856Z","v":0}`. Note the tag appears as `context.orderStatusOptions.orderKey`, and `msg` is empty while the human-readable text lives in `message`.  
  `logs/new-tags-2026-06-01/order-updates/all-logs.filtered.log:1-20 (real artefact in this checkout)`


## Grep targets (63)

| String | Means | Emitted by | Citation |
|---|---|---|---|
| `Error: --service jobs-recon requires --job-name.` | Fatal. You passed --service all (or jobs-recon) without --job-name. --service all ALWAYS produces this. Exit 1. | validateArgs() via cli() catch, search-s3-logs.js | `search-s3-logs.js:156, search-s3-logs.js:874` |
| `Error: Pass exactly one of --tag, --order-id, --batch-id, or --text.` | Zero or >1 search identifiers given. Exit 1. | validateArgs(), search-s3-logs.js | `search-s3-logs.js:142-143` |
| `Error: --service is required. Choose one or more of: order-updates, broker-api, platform-api, jobs, jobs-recon, or all.` | No --service given. Exit 1. There is no default service. | validateArgs(), search-s3-logs.js | `search-s3-logs.js:146` |
| `Valid services: order-updates, broker-api, platform-api, jobs, jobs-recon, or all.` | Second line printed after ANY ValidationError from fetch-by-identifier.js. Its presence identifies a validation failure (exit 1) vs a runtime failure. | cli() catch, search-s3-logs.js | `search-s3-logs.js:875` |
| `Error: Missing value for ${option}` | A flag was last on the command line, or its value started with '--'. Exit 1. | parseArgs(), search-s3-logs.js | `search-s3-logs.js:120` |
| `Error: Unknown option: ${option}` | Unrecognised flag — FATAL in search-s3-logs.js (unlike redash-query.js which only warns). Exit 1. | parseArgs(), search-s3-logs.js | `search-s3-logs.js:134` |
| `Error: --from/--to may cover at most 30 days.` | Explicit window exceeded DEFAULT_SEARCH_DAYS. Exit 1. Split into multiple runs. | buildDateList(), search-s3-logs.js | `search-s3-logs.js:209` |
| `Error: --month ${month} contains more than 30 days; use a <=30-day --from/--to range.` | --month was a 31-day month. Exit 1. --month only works for 28/29/30-day months. | buildDateList(), search-s3-logs.js | `search-s3-logs.js:226` |
| `Error: Use only one of --date, --from/--to, or --month.` | Mutually exclusive date selectors combined. Exit 1. | buildDateList(), search-s3-logs.js | `search-s3-logs.js:204` |
| `Error: --from and --to must be supplied together.` | Only one half of the range was given. Exit 1. | buildDateList(), search-s3-logs.js | `search-s3-logs.js:202` |
| `Listing ${source.surface} for ${dates.length} date(s)...` | Per-surface listing has started. For jobs-recon this line LIES about scope — that source ignores dates and lists the whole prefix. | discoverObjects(), search-s3-logs.js | `search-s3-logs.js:329` |
| `Listing ${source.surface} for complete history...` | Printed only when `dates` is null. In the CLI path args.dates is always set, so this branch is effectively unreachable from the command line. | discoverObjects(), search-s3-logs.js | `search-s3-logs.js:329` |
| `Listing failed: ${error.message}` | THE expired-SSO / access-denied signature. The whole listing phase aborted; manifest.status='incomplete', errors[0].phase='listing', both output files empty, exit 2. Never read this as 'order not found'. | runSearch() listing catch, search-s3-logs.js | `search-s3-logs.js:646` |
| `Searching ${n} object(s) with concurrency=${c}...` | Listing succeeded; n is the total objects about to be scanned. n===0 here means the prefixes are genuinely empty for the chosen dates/services. | runSearch(), search-s3-logs.js | `search-s3-logs.js:651` |
| `Scanned ${completed}/${total} objects.` | Progress, printed every 100 objects and once at the end. Numbers are locale-formatted (thousands separators). | runSearch() forEachConcurrent callback, search-s3-logs.js | `search-s3-logs.js:716` |
| `Anchor date resolved: ${YYYY-MM-DD} (${note}). Starting narrow, widening only if empty...` | Auto-scope engaged. `note` is one of batchId-objectid-timestamp \| redash-lookup-7d \| redash-lookup-14d \| redash-lookup-30d, and tells you exactly how the date was obtained and what it cost. | runAutoSearch(), search-s3-logs.js | `search-s3-logs.js:806` |
| `No anchor date available (${note}); falling back to the flat latest-30-days window.` | Auto-scope gave up but did NOT fail. `note` is redash-not-configured (missing .env), batchId-not-a-valid-objectid, or redash-lookup-invalid-date. The search still runs, just 30 days flat and much more slowly. | runAutoSearch(), search-s3-logs.js | `search-s3-logs.js:802` |
| `[${tier.label}] searching ${n} new date(s): ${first}..${last}` | One auto-scope tier starting. labels are literally tier1_3d, tier2_9d, tier3_17d, tier4_30d_max. Count these lines to see how far the search had to widen. | runAutoSearch() tier loop, search-s3-logs.js | `search-s3-logs.js:822` |
| `"status": "not_found_in_db"` | Exit 3. Redash found no order matching this tag/order-id in the last 30 days, so S3 was deliberately NOT scanned. Pass an explicit --date/--from+--to/--month if the order is older. | runAutoSearch() no-anchor branch, search-s3-logs.js | `search-s3-logs.js:790, search-s3-logs.js:797-798` |
| `No matching order found via Redash within the last 30 days. Not scanning S3 blindly on a guess` | The `note` text inside the not_found_in_db manifest, explaining the exit-3 decision. | runAutoSearch(), search-s3-logs.js | `search-s3-logs.js:792-793` |
| `Log search failed: ${error.message}` | A non-ValidationError escaped main(). Exit 1. Distinguishable from a validation failure by the ABSENCE of the 'Valid services:' line. | cli() catch, search-s3-logs.js | `search-s3-logs.js:877` |
| `S3 Select response was incomplete.` | Recorded in manifest.fallbacks[].reason (prefixed 'S3 Select: '). Means no End event, no Stats, or BytesScanned < object size — the object was re-scanned by full download. Costs bandwidth but is not an error. | selectObject(), search-s3-logs.js | `search-s3-logs.js:468` |
| `Unexpected tab-delimited record detected.` | In manifest.fallbacks[].reason. A log line contained a literal TAB, which broke the one-line-as-one-CSV-field hack, so the object was fully downloaded instead. | selectObject(), search-s3-logs.js | `search-s3-logs.js:471` |
| `; GetObject fallback: ` | Appears inside manifest.errors[].error. BOTH S3 Select and the full-download fallback failed for this object. The part before it is the Select reason, after it the GetObject reason. | scanObject() fallback catch, search-s3-logs.js | `search-s3-logs.js:537` |
| `Skipped after fatal error: ` | In manifest.errors[].error. An auth error stopped the run and every remaining object was skipped without being scanned. Exit 2. Re-authenticate and re-run. | runSearch() forEachConcurrent callback, search-s3-logs.js | `search-s3-logs.js:700` |
| `Output write failed: ` | In manifest.errors[].error, and sets fatalError. The count of lines written did not match the count found, or a write threw. Results are untrustworthy; status becomes incomplete, exit 2. | recordResult(), search-s3-logs.js | `search-s3-logs.js:674-679` |
| `Expected ${n} matches but wrote ${m}.` | Integrity check failure between the temp scan file and the aggregated output. Never ignore this — the result set is incomplete. | recordResult(), search-s3-logs.js | `search-s3-logs.js:674` |
| `Error: REDASH_URL, REDASH_API_KEY, REDASH_DATA_SOURCE_ID must be set (.env or env vars).` | redash-query.js has no credentials. Exit 1. Check for .env in the fetch-s3-logs directory (it is gitignored). | main(), redash-query.js | `redash-query.js:260` |
| `Error: --collection is required.` | redash-query.js needs an explicit collection (orders, users, activations, sips, placedOrders, jobs...). Exit 1. | main(), redash-query.js | `redash-query.js:264` |
| `Error: --tag/--order-id without --batch-id requires --from and/or --to.` | The production-safety guard fired. These fields are unindexed array fields; an unbounded query is a full collection scan. Exit 1. Add a date bound, or use fetch-by-identifier.js's auto-scope instead. | main() via requiresDateBound(), redash-query.js | `redash-query.js:268` |
| `Unknown argument: ${a}` | NON-FATAL in redash-query.js — the flag is dropped and the query runs anyway, silently missing that filter. Grep for this whenever a redash-query result looks wrong. | parseArgs(), redash-query.js | `redash-query.js:93` |
| `Error: --match is not valid JSON: ` | The raw --match escape hatch failed to parse. Exit 1, before any query is sent. | buildMatch(), redash-query.js | `redash-query.js:112` |
| `Querying collection=${collection}, match=${json}[, limit=${n}]` | STDERR echo of the exact Mongo $match that will run. This is the single best line for verifying the query actually contained the filter you intended (catches the silent Unknown-argument drop). | main(), redash-query.js | `redash-query.js:280` |
| `${n} row(s) returned.` | STDERR row count. '0 row(s) returned.' with a correct-looking match line is a genuine not-found for that date window. | main(), redash-query.js | `redash-query.js:284` |
| `Written to ${path}` | --out was used; the JSON went to a file and NOTHING was printed to stdout. | main(), redash-query.js | `redash-query.js:292` |
| `Redash query failed: ` | Redash job status 4. The message after the colon is Redash's own error (often a Mongo timeout). Exit 1. | runRedashQuery(), redash-query.js | `redash-query.js:209` |
| `Redash query did not complete within 120s (job ${jobId})` | 150 polls at 800 ms elapsed without status 3 or 4. Almost always an unindexed scan over too wide a date range — narrow --from/--to. | runRedashQuery(), redash-query.js | `redash-query.js:213` |
| `HTTP ${statusCode} from ${url}: ` | Redash returned >=400. 401/403 means a bad or revoked REDASH_API_KEY. Body is truncated to 500 chars. Exit 1. | httpRequest(), redash-query.js | `redash-query.js:167` |
| `Failed to parse response from ${url}: ` | Redash returned a non-JSON body (often an HTML login/error page — check REDASH_URL and the API key). Exit 1. | httpRequest(), redash-query.js | `redash-query.js:173` |
| `Recon search failed: ` | search-s3-recon.js argument validation threw. Exit 1. Most commonly 'Provide at least one --tag, --order-id, or --exchange-order-id'. | cli() catch, search-s3-recon.js | `search-s3-recon.js:208` |
| `Provide at least one --tag, --order-id, or --exchange-order-id` | No recon identifier given. Exit 1. | parseArgs(), search-s3-recon.js | `search-s3-recon.js:87` |
| `--concurrency must be an integer from 1 to 50` | recon concurrency out of range. Exit 1. (Default is 8.) | parseArgs(), search-s3-recon.js | `search-s3-recon.js:90` |
| `"matchedFiles": 0` | In search-s3-recon.js stdout/manifest. Combined with a non-empty "errors" array this is NOT a clean not-found — check errors first. With empty errors and a plausible scannedFiles count it is a real not-found. | main(), search-s3-recon.js | `search-s3-recon.js:191-200` |
| `Processing s3://${bucket}/${key} -> ${aggregatedOutPath}` | fetch-s3-logs.js per-object start line. Count these to see how many objects were actually touched. | processObject(), fetch-s3-logs.js | `fetch-s3-logs.js:808` |
| `Queried via S3 Select: ${n} candidate line(s) (no full download).` | fetch-s3-logs.js pushed --filter-text down to S3. IMPORTANT: when this appears, any --filter-field you also passed was evaluated ONLY on these already-text-matching lines, silently ANDing what the help documents as an OR. | processObject(), fetch-s3-logs.js | `fetch-s3-logs.js:815` |
| `S3 Select query failed for s3://${bucket}/${key} (${msg}); falling back to full download.` | This object was downloaded whole. Results for this object DO honour the documented text-OR-field semantics, unlike objects that went through Select — so a run can be internally inconsistent. | processObject(), fetch-s3-logs.js | `fetch-s3-logs.js:840` |
| `No matching lines in s3://${bucket}/${key}; skipping file creation.` | Zero matches for this object. Expect one of these per empty object; it is not an error. | processObject(), fetch-s3-logs.js | `fetch-s3-logs.js:835, fetch-s3-logs.js:872` |
| `Failed for key=${key}:` | A per-object failure in fetch-s3-logs.js. THE PROCESS STILL EXITS 0. Grep for this line to detect a partial scan — the exit code will not tell you. | runForScope() concurrency catch, fetch-s3-logs.js | `fetch-s3-logs.js:1134` |
| `Completed with ${n} failure(s).` | fetch-s3-logs.js finished but n objects failed. Exit code is still 0. Treat any n>0 as an incomplete result set. | runForScope(), fetch-s3-logs.js | `fetch-s3-logs.js:1184` |
| `Completed successfully.` | fetch-s3-logs.js finished with zero per-object failures. The only clean-run signal this script emits. | runForScope(), fetch-s3-logs.js | `fetch-s3-logs.js:1186` |
| `Aggregated filtered logs stored at ${aggregatedOutPath}` | Names the output file. NOTE: with sorting on (the default) and zero matches, this line still prints but the file does NOT exist. | runForScope(), fetch-s3-logs.js | `fetch-s3-logs.js:1181` |
| `No objects found.` | The S3 prefix listed zero keys. Wrong bucket/date/service — NOT evidence about the order. Exit 0. | runForScope(), fetch-s3-logs.js | `fetch-s3-logs.js:1066` |
| `No objects matched the filters.` | Objects existed but --dir and/or --modified-after/--modified-before excluded all of them. Exit 0. Check --dir spelling (Out-logs / Error-logs are case-sensitive). | runForScope(), fetch-s3-logs.js | `fetch-s3-logs.js:1090` |
| `Error: S3 URL/bucket and output directory are required.` | fetch-s3-logs.js could not resolve a target even after DEFAULTS. Exit 1. | run(), fetch-s3-logs.js | `fetch-s3-logs.js:964` |
| `Error: --date/--date-from/--date-to given but --s3-url/--bucket/--prefix has no {date} placeholder to substitute.` | You passed date flags but left a concrete date baked into the URL. Exit 1. Replace the date segment with the literal string {date}. | run(), fetch-s3-logs.js | `fetch-s3-logs.js:978` |
| `Error: --s3-url/--bucket/--prefix contains a {date} placeholder; pass --date or --date-from/--date-to.` | The inverse mismatch. Exit 1. | run(), fetch-s3-logs.js | `fetch-s3-logs.js:982` |
| `Invalid --s3-url. Expected format: s3://bucket/prefix/` | The --s3-url did not begin with s3://. Exit 1. | runForScope(), fetch-s3-logs.js | `fetch-s3-logs.js:1040` |
| `Ignoring --filter-field: expected key=value or an expression with and/or` | A --filter-field spec had no '=' and was SILENTLY DROPPED — the run continues unfiltered on that dimension. | parseArgs(), fetch-s3-logs.js | `fetch-s3-logs.js:283` |
| `Ignoring --sort: expected "nf" or "of"` | An invalid --sort value was dropped; DEFAULTS.SORT='nf' then applies anyway. | parseArgs(), fetch-s3-logs.js | `fetch-s3-logs.js:293` |
| `Unable to reset existing aggregated log file: ` | The previous all-logs.filtered.log could not be deleted, so this run may APPEND to stale results from a prior run. | runForScope(), fetch-s3-logs.js | `fetch-s3-logs.js:1052` |
| `Downloading [` | fetch-s3-logs.js progress bar prefix. On a TTY it rewrites one line; when piped it prints a new line per change. Filter these out when parsing piped stdout. | createDownloadProgressBar(), fetch-s3-logs.js | `fetch-s3-logs.js:352-360` |
| `fetch-s3-logs UI running at http://localhost:${PORT}` | server.js started. PORT defaults to 3000. | server.listen callback, server.js | `server.js:285` |
| `readDefaults parse error:` | server.js could not regex-scrape the DEFAULTS block out of fetch-s3-logs.js; /api/defaults returns {} and the UI shows blank defaults while the script still applies the real ones. | readDefaults(), server.js | `server.js:69` |


## Corrections (11)


**Claimed:** SBI_LOG_INVESTIGATION_GUIDE.md:20 gives this as a working example: `node fetch-by-identifier.js --batch-id 6a221fb2d963eea6efaeabfa --from 2026-09-18 --to 2026-09-20 --service all`

**Actually:** This command ALWAYS fails, exit 1, before touching S3. `--service all` expands to SERVICE_KEYS which includes `jobs-recon`, and `jobs-recon` requires `--job-name`. Verified by running it: output was `Error: --service jobs-recon requires --job-name.` / `Valid services: order-updates, broker-api, platform-api, jobs, jobs-recon, or all.` EXIT=1. `--service all` is only usable with `--job-name` also supplied; otherwise enumerate services explicitly (`--service order-updates,broker-api,platform-api,jobs`).

`search-s3-logs.js:67, search-s3-logs.js:154-157, search-s3-logs.js:165-166 (verified by execution)`


**Claimed:** SBI_LOG_INVESTIGATION_GUIDE.md:761 — "Narrow by ... the object's S3 `LastModified` metadata via the now-added `--modified-after`/`--modified-before` flags ... `fetch-by-identifier.js` passes these automatically from your `--date`/`--from`/`--to`/`--month`."

**Actually:** `fetch-by-identifier.js` / `search-s3-logs.js` has NO `--modified-after`/`--modified-before` flag and never passes one — those flags exist only in `fetch-s3-logs.js`, which `search-s3-logs.js` does not shell out to. What actually happens for `jobs-recon` is entirely different: the source is built with `dated: false`, so `listSourceObjects` lists EVERY object under `sc-integrations-jobs/<jobName>` (the job's complete history, no LastModified filter at all), and scoping is applied afterwards per LINE by `lineIsInScope()` using the log line's own `time` field converted to IST (falling back to the object's LastModified only when the line has no `time`). A one-day jobs-recon search therefore still downloads and scans every logged run of that job.

`search-s3-logs.js:114-136 (no such flag), search-s3-logs.js:257-267, search-s3-logs.js:311-315, search-s3-logs.js:407-413`


**Claimed:** SBI_LOG_INVESTIGATION_GUIDE.md:934 — "Note `--filter-field` (unlike `--filter-text`) is not pushed into S3 Select, so this still fully downloads each date's objects"

**Actually:** Both halves are wrong in practice. (a) Because `DEFAULTS.FILTER_TEXT = "sc_rXWoyJfoH"` is applied whenever `--filter-text` is absent, a `--filter-field`-only invocation DOES take the Select path — it is not a full download. (b) Worse, S3 Select returns only lines matching the (defaulted) text terms, so the `--filter-field` predicate is then evaluated ONLY against lines containing `sc_rXWoyJfoH`. The documented OR semantics (`includeByContent = textMatch || fieldMatch`) silently collapse to an AND. A `--filter-field batchId=<X>` search will return essentially nothing unless that batch happens to belong to tag sc_rXWoyJfoH. Pass `--no-filter-text` (an undocumented flag) to get the documented behaviour.

`fetch-s3-logs.js:102, fetch-s3-logs.js:924-927, fetch-s3-logs.js:810-838, fetch-s3-logs.js:657, fetch-s3-logs.js:297`


**Claimed:** `fetch-s3-logs.js --help` line: `--dir <name>  Only include this first-level subdirectory under the prefix (default: Out-logs)`

**Actually:** There is NO default. `DEFAULTS.DIR` is commented out (`// DIR: 'Out-logs',`), so `if (!args.dir && DEFAULTS.DIR)` never fires and omitting `--dir` pulls ALL first-level subfolders — including `code-deploy-logs/` and `script-logs/` noise. The script's own help text is wrong; the guide's §3.2 prose (line 630) is right. Always pass `--dir Out-logs` explicitly.

`fetch-s3-logs.js:107 (commented out), fetch-s3-logs.js:127 (help text), fetch-s3-logs.js:958-960`


**Claimed:** `fetch-s3-logs.js --help` line: `--filter-field <k=v>  Create an additional filtered copy with lines where JSON field k===v`

**Actually:** No additional copy is created. There is exactly ONE output file per scope, `<outDir>/all-logs.filtered.log`, and `--filter-field` matches are merged into it (ORed with `--filter-text` matches locally, though see the Select-narrowing correction above). The `.raw.log`/`.filtered.log` per-object path helpers (`computeOutputPath`, `computeFilteredOutputPath`) are defined but never called by `run()`.

`fetch-s3-logs.js:139, fetch-s3-logs.js:1048, fetch-s3-logs.js:310-327 (dead helpers), fetch-s3-logs.js:657`


**Claimed:** SBI_LOG_INVESTIGATION_GUIDE.md:679 — auto-scope "results accumulate into the same `matches.jsonl`/`all-logs.filtered.log`/`manifest.json` in the requested `--out` directory regardless of which tier found them"

**Actually:** True for the two JSONL files, but with two caveats the guide omits. (1) `manifest.json` is NOT accumulated — the auto-scope manifest is a different schema entirely (`{status, query, anchor, tiers[], totalDatesSearched[], totalMatched, completedAt, outputDir}`) with no `objects`/`bytes`/`errors`/`matchedKeys`/`sources`, and the per-tier manifests (which hold the error detail) are deleted with their `.tier-N` directories. (2) The merge uses `fs.appendFileSync` and never truncates, so re-running auto-scope into an existing `--out` APPENDS to the previous run's results. Explicit-date runs truncate; auto-scope runs do not.

`search-s3-logs.js:748-753, search-s3-logs.js:827-828, search-s3-logs.js:834-837, search-s3-logs.js:840-850`


**Claimed:** Obvious assumption: a non-zero exit from these tools means "failed", and exit 0 means "the scan was complete".

**Actually:** Neither holds uniformly. `fetch-by-identifier.js` exit 2 means "incomplete scan" and STILL may have written real matches to `matches.jsonl` — treat it as "these results are partial", not "no results". Conversely `fetch-s3-logs.js` exits 0 even when individual objects failed: per-object errors only print `Failed for key=<k>:` and a final `Completed with N failure(s).` The only way to detect a partial `fetch-s3-logs.js` run is to grep stdout.

`search-s3-logs.js:728-745, fetch-s3-logs.js:1132-1135, fetch-s3-logs.js:1183-1195`


**Claimed:** Obvious assumption: `--order-id`/`--tag` in `fetch-by-identifier.js` match the corresponding field exactly.

**Actually:** Every search in `search-s3-logs.js` is a case-insensitive SUBSTRING match over the raw log line — `LOWER(s._1) LIKE '%value%'` server-side and `line.toLowerCase().includes(needle)` locally. There is no field targeting at all. `--order-id 12345` matches any line containing `12345` anywhere, including inside prices, timestamps and unrelated ids. The manifest field `query.literal: true` means "literal, not regex", not "exact".

`search-s3-logs.js:345-348, search-s3-logs.js:423, search-s3-logs.js:612`


**Claimed:** Obvious assumption: the `server.js` web UI (`npm run ui`) is a faster front-end for the same investigation.

**Actually:** It is strictly weaker. `POST /api/run` spawns ONLY `node fetch-s3-logs.js` — it can never reach `fetch-by-identifier.js` (so no auto-scope, no Redash anchor lookup, no service→surface mapping), `redash-query.js` or `search-s3-recon.js`. It also never passes `--no-filter-text`, `--force-gunzip`, `--date`/`--date-from`/`--date-to`, `--filter-not-text`, `--whole-word` or `--modified-*`, so every `DEFAULTS` trap applies to every UI run. The one genuinely useful thing in it is `GET /api/tail`, whose brace-depth scanner is the reference implementation for parsing `all-logs.filtered.log`.

`server.js:216-252, server.js:133-200`


**Claimed:** Obvious assumption: setting `AWS_PROFILE` or `AWS_REGION` in the environment redirects these tools.

**Actually:** Only two of the three do. `search-s3-logs.js:25-27` and `search-s3-recon.js:18-20` use `process.env.X = process.env.X || <default>`, so a caller's env wins. `fetch-s3-logs.js:52-56` assigns `AWS_PROFILE='smallcase'`, `AWS_REGION` and `AWS_DEFAULT_REGION='ap-south-1'` UNCONDITIONALLY, and its S3Client is constructed with a literal `{region:'ap-south-1'}` — `--region` is parsed and ignored, as its own help text admits. There is no way to point `fetch-s3-logs.js` at another account or region.

`search-s3-logs.js:25-27, search-s3-recon.js:18-20, fetch-s3-logs.js:52-56, fetch-s3-logs.js:122, fetch-s3-logs.js:986-988`


**Claimed:** Obvious assumption: `--service jobs --env staging` searches the staging jobs logs.

**Actually:** It builds ZERO sources and silently succeeds. The `jobs` entry in APP_SERVICES has no `eksPod`, and the EC2 block is gated on `env === 'prod'`, so `buildSources(['jobs'], 'staging')` returns `[]`. The run lists 0 objects, `scanned === listed === 0`, `manifest.status` is `complete`, and it exits 0 reporting zero matches — indistinguishable from a genuine not-found.

`search-s3-logs.js:65, search-s3-logs.js:269-292, search-s3-logs.js:732`



## Open questions (6)

- Do the SBI/MTF recon CSVs under s3://sc-integrations-sbi-attachments/{sbi_recon,mtf_recon}/ carry a header row? `search-s3-recon.js:124` passes `FileHeaderInfo: 'IGNORE'`, which under S3 Select semantics SKIPS the first line. If those CSVs are headerless, the first data row of every file is silently dropped from every recon search. No recon CSV exists in this checkout's logs/ directory to verify against, and I did not hit live S3.
- For the DATED sources (sc-eks-pod-logs, sc-pm2logs-new), is the `<date>` path segment an IST calendar day or a UTC one? `search-s3-logs.js` applies no line-level date filtering to these (`lineIsInScope` returns true unless `source.filterLineDate`), so if the partitions are UTC-boundaried, a `--date 2026-06-05` search will miss events between 00:00 and 05:30 IST on 2026-06-06 and include the equivalent slice of 2026-06-05. The auto-scope tiers' forward bias partly compensates, but a single `--date` search does not. This needs one live cross-check against a known-timestamp order.
- Does the `orders` collection's top-level `broker` field ever hold the literal value `sbi-mtf`? `redash-query.js:55` documents `--broker <sbi|sbi-mtf>`, but broker-lib's `sbi-mtf/config.js:19` sets `brokerName = 'sbi'` for non-leprechaun, which is what appears in LOG lines. Whether the Mongo document field (written by platform/babel, not broker-lib) uses `sbi-mtf` is outside what I could verify from this repo. If it does not, `--broker sbi-mtf` returns zero rows always.
- Do the concurrent flag-'a' write streams in `fetch-s3-logs.js:1105-1145` actually interleave in practice at the default concurrency of 120? O_APPEND makes individual write(2) calls atomic, but Node's stream buffering can split a single pretty-printed record across multiple writes. The default `SORT:'nf'` routes everything through the in-memory buffer and masks this, so the race is only live with `--no-sort`. I reasoned this from the code; I did not reproduce it.
- What is the actual value of REDASH_DATA_SOURCE_ID in this checkout's .env? I deliberately did not read the .env values (the file also holds REDASH_API_KEY). SBI_LOG_INVESTIGATION_GUIDE.md:26 claims data source id 35 ("Atlas Mongo") but I did not confirm that against the file.
- `search-s3-logs.js:497-500` recognises only five error names as fatal-auth. What error name does an expired AWS SSO session actually surface as through @aws-sdk/client-s3 v3.936 for SelectObjectContent and GetObject? If it is `SSOTokenProviderFailure` or a bare `Error`, the run will not short-circuit and will instead produce a large `failed` count with fallback attempts. In practice the listing phase fails first (producing the clean `Listing failed:` signature), but a token that expires MID-RUN would take the unrecognised path. Not reproducible without letting a token expire during a run.
