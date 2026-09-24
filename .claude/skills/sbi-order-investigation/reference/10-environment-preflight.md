# Environment Preflight and Self-Diagnosis

What must be true for the toolkit to work, what each failure looks like, and — most importantly — which failures produce a SILENT EMPTY RESULT indistinguishable from a genuine "not found".

_Resolved: yes. Source-verified 2026-09-23._


## Always-applies rules

PREFLIGHT - run before every investigation, ~5 seconds total:
1. `npm test` in /Users/rishidatta/Desktop/integrations/fetch-s3-logs. Expect `# pass 48` / `# fail 0`. No network, no credentials. Proves the toolkit code is intact.
2. AWS probe via the NODE SDK, never the aws CLI: a ListObjectsV2 on sc-eks-pod-logs prefix production/ with Delimiter '/'. Expect CommonPrefixes ['development/','production/']. NEVER run `aws sts get-caller-identity --profile smallcase` or `aws configure list --profile smallcase` as a health check - both exit 255 on this machine with "sso_start_url is inconsistent" while the toolkit itself works fine. That is a false alarm, and acting on it wastes the operator's time.
3. `ls .env && node -e "console.log(require('./redash-query').isConfigured())"`. Expect true. Never cat .env, never echo REDASH_API_KEY, never run `env | grep REDASH`.
4. `node redash-query.js --collection orders --match '{}' --limit 1`. Expect exactly `1 row(s) returned.` in ~2s. This one command proves .env loaded, VPN up, API key valid, data source id valid and the collection name correct. `0 row(s)` here means the environment is broken, not that the DB is empty.
5. `env | grep ^AWS` - expect NO output. A stray AWS_PROFILE or AWS_REGION silently retargets every search (search-s3-logs.js:25-27 uses `||`, so your env wins).

WHEN A SEARCH RETURNS ZERO, verify these SEVEN things before writing "not found":

1. `listedObjects` in the manifest / stdout JSON. If it is 0, the run scanned NOTHING and exit 0 + status "complete" is meaningless (search-s3-logs.js:732 evaluates 0 === 0). Wrong date, wrong service, or a surface that has no data for that date. Not a negative result.
2. `failedObjects` and `status`. `status: "incomplete"` with failedObjects > 0 means objects existed and could not be read. Open manifest.errors: "We do not support DEEP_ARCHIVE storage class" means the data is in Glacier Deep Archive and needs a restore - report that, never "not found".
3. Exit code. 0 = searched cleanly; 2 = listing failed or objects failed; 3 = Redash found no such order in the last 30 days (status "not_found_in_db"); 1 = a crash, usually a bad REDASH_API_KEY surfacing as `Log search failed: HTTP 404 ...`.
4. Did the run print "No anchor date available (redash-not-configured); falling back to the flat latest-30-days window."? If so, .env is missing and the search only covered the last 30 days. For any older order that zero is meaningless. Fix .env or pass --date/--from+--to explicitly.
5. Right surface for that date. order-updates and broker-api are EKS-only for recent dates and EC2-only for dates before roughly 2026-08; platform-api is dual-running on both. Probe both buckets with a list-only call before concluding anything. EC2-bucket objects dated on or before roughly 2026-05-15 are DEEP_ARCHIVE and unreadable.
6. Redash collection spelling and case. `orders` returns rows, `Orders` and `order` silently return zero with exit 0. Same for `placedOrders` vs `placedorders`.
7. Is the output file empty because nothing matched, or because the run aborted? A failed listing STILL writes an empty matches.jsonl (search-s3-logs.js:644). Always read manifest.json, never trust matches.jsonl alone.

NEVER retry in a loop:
- Redash polls for at most 120s (150 x 800ms) then throws. orders.tag / unplaced.tag are unindexed: 7d ~20s, 14d ~24s, 30d ~44s, 60d+ unreliable. Widen the date bound rather than re-running the same query; never bypass the guard that refuses --tag/--order-id without --from/--to.
- An S3 log search is time-bound, not cost-bound: one service-day is 2,304 objects / 0.58 GB / 33 seconds, so a flat 30-day window is ~16 minutes. Let the built-in auto-scope tiers (3d, 9d, 17d, 30d) do the widening.
- search-s3-recon.js scans all 2,565 recon CSVs (383 MB, ~80s) on every invocation regardless of arguments. --tag is repeatable: batch every tag into ONE run rather than one run per tag.

SECRET HANDLING: .env is gitignored (.gitignore:3) and untracked. Check its presence with isConfigured() only. Never print, copy, commit or transmit REDASH_API_KEY or any AWS SSO token. Redash error messages contain only the hostname, never the key, so they are safe to quote in a report. The same never-reproduce rule applies to the unredacted bearer tokens, account numbers and dealer password that appear in SBI logs themselves.

REMEDIATION: credentials -> `aws sso login --profile smallcase` (verified working; only sts/configure trip the config bug). If the operator is annoyed by that CLI error, suggest they delete the stale sso_start_url and sso_region lines from [profile smallcase] in ~/.aws/config so the sso_session block is authoritative - suggest it, do not edit their AWS config. Redash -> create ./.env with the three keys, asking the human for the values.


## Detail

« # Toolkit environment: dependencies, failure symptoms, preflight

Repo `/Users/rishidatta/Desktop/integrations/fetch-s3-logs`, branch `main`. Everything below was executed live against production on 2026-09-23 unless marked `inferred` or `unconfirmed`.

---

## 1. Dependencies

- **AWS profile `smallcase`** — `search-s3-logs.js:25` and `search-s3-recon.js:18` both set `process.env.AWS_PROFILE = process.env.AWS_PROFILE || 'smallcase'`, so an operator-set `AWS_PROFILE` **silently wins**. `fetch-s3-logs.js:53` hardcodes it with no `||` fallback, so that one script ignores your `AWS_PROFILE`. The two scripts disagree. (confirmed)
- **AWS region `ap-south-1`** — `search-s3-logs.js:27`, `search-s3-recon.js:20`, `fetch-s3-logs.js:55-56`. Same `||` override pattern in the first two. (confirmed)
- **AWS credentials: SSO only.** `~/.aws/credentials` is 0 bytes. `[profile smallcase]` uses `sso_session = case-platforms`, start URL `https://case-platforms.awsapps.com/start`, sso_region `ap-south-1`, account `736414281642`, role `ineq-dev-sso`. (confirmed)
- **`REDASH_URL` / `REDASH_API_KEY` / `REDASH_DATA_SOURCE_ID`** — read from `./.env` in the repo root, or the same-named env vars. `redash-query.js:27-44`. `loadEnvFile()` does NOT override an already-set `process.env` (`redash-query.js:37`: `if (!(key in process.env))`). (confirmed)
- **Node** — v18.20.8 installed. `fetch-s3-logs.js:7` says ">= 16"; `npm test` runs `node --test` (`package.json:8`) which needs Node >= 18. (confirmed)
- **npm deps** — only `@aws-sdk/client-s3 ^3.936.0` (3.936.0 installed) and `express ^5.2.1` (UI only). `package.json`. (confirmed)
- **Network, S3** — public AWS endpoints, no VPN needed. (confirmed)
- **Network, Redash** — `redash.util.smallcase.com` resolves to **10.1.2.82**, a private RFC1918 address. **VPN or office network is required.** (confirmed via DNS lookup)

### S3 IAM permissions per surface (all four verified working today)

| Bucket | Used by | Needs |
|---|---|---|
| `sc-eks-pod-logs` | EKS pod logs, `search-s3-logs.js:274` | ListBucket, GetObject, SelectObjectContent |
| `sc-pm2logs-new` | EC2/PM2 logs, `search-s3-logs.js:287` | ListBucket, GetObject, SelectObjectContent |
| `sc-prod-logs` | jobs-recon per-run logs, `search-s3-logs.js:261` | ListBucket, GetObject, SelectObjectContent |
| `sc-integrations-sbi-attachments` | recon CSVs, `search-s3-recon.js:22` | ListBucket, GetObject, SelectObjectContent |

`s3:SelectObjectContent` is not optional on the log path: if S3 Select fails with an auth-class error, `search-s3-logs.js:546-550` marks the whole run fatal and **skips every remaining object** rather than falling back to GetObject. The GetObject fallback only runs for non-auth Select failures (`search-s3-logs.js:551`).

---

## 2. Failure symptoms — SAFE (crashes) vs DANGEROUS (silent empty)

### DANGEROUS — indistinguishable from "not found"

**D1. Zero objects listed for the date/service.** `manifest.objects.scanned === manifest.objects.listed` is `0 === 0`, so `search-s3-logs.js:732` sets `status: "complete"`, prints `matchedLines: 0`, and **returns exit 0**. Byte-identical to a genuine no-match. The ONLY tell is `listedObjects: 0` in the stdout JSON / manifest. This is the single most dangerous state in the toolkit.

**D2. Missing `.env` degrades the log search silently.** `redash-query.js:216-218 isConfigured()` returns false, `search-s3-logs.js:763` returns `note: 'redash-not-configured'`, and `search-s3-logs.js:800-803` prints one line — `No anchor date available (redash-not-configured); falling back to the flat latest-30-days window.` — then runs a flat 30-day search and exits 0. For an order older than 30 days this reports zero matches with no error at all.

**D3. A misspelled or wrong-cased Redash collection returns 0 rows, exit 0.** Measured: `orders` -> 1 row, `Orders` -> 0 rows, `order` -> 0 rows, `placedOrders` -> 1 row, `placedorders` -> 0 rows. Mongo collection names are case-sensitive and Redash reports no error for a nonexistent one.

**D4. DEEP_ARCHIVE objects fail per-object while the run still reports `matchedLines: 0`.** Measured on `--date 2024-01-01`: 46 objects listed, all 46 failed with `S3 Select: We do not support DEEP_ARCHIVE storage class. Please check the service documentation and try again.; GetObject fallback: The operation is not valid for the object's storage class`. Manifest `status: "incomplete"`, `failedObjects: 46`, `matchedLines: 0`, exit 2. An agent reading only `matchedLines` concludes "not found" when the truth is "the data is in Glacier Deep Archive and needs a restore". The tells are `failedObjects > 0` and `status: "incomplete"`.

**D5. An operator's stray `AWS_PROFILE` / `AWS_REGION` env var silently retargets the search** (`search-s3-logs.js:25-27`). Static `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env vars would also beat the SSO profile in the SDK v3 credential chain. (chain-order: inferred; the `||` override: confirmed)

**D6. `redash-query.js` has no socket timeout.** `httpRequest` (`redash-query.js:148-182`) sets no `timeout` option and never calls `req.setTimeout`. Off-VPN, a blackholed TCP connect hangs until the OS connect timeout (~75s on macOS) — and indefinitely if something accepts the connection and never replies. Since `fetch-by-identifier.js --tag` calls Redash for its anchor date (`search-s3-logs.js:762-779`), an off-VPN tag search **hangs with no output** rather than failing.

### SAFE — they crash or exit non-zero

- **Missing/unusable credentials:** `CredentialsProviderError: Could not load credentials from any providers` (measured). Thrown in the listing phase, caught at `search-s3-logs.js:640-647`, prints `Listing failed: Could not load credentials from any providers` to stderr, `status: "incomplete"`, exit 2. **It still writes an empty `matches.jsonl`** (`search-s3-logs.js:644`) — so the output file alone lies; read the manifest.
- **Expired SSO session that cannot refresh:** standard SDK v3 text `The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.` (inferred — could not be reproduced without invalidating the live token). `CredentialsProviderError` is in `isAuthError` (`search-s3-logs.js:497-500`), so it is fatal and loud.
- **Wrong region:** `PermanentRedirect: The bucket you are attempting to access must be addressed using the specified endpoint. Please send all future requests to this endpoint.` HTTP 301 (measured). NOT in `isAuthError`, so it surfaces as a listing failure, exit 2, empty `matches.jsonl`.
- **Wrong bucket:** `NoSuchBucket: The specified bucket does not exist`, HTTP 404 (measured).
- **Redash config entirely absent, direct CLI use:** `Error: REDASH_URL, REDASH_API_KEY, REDASH_DATA_SOURCE_ID must be set (.env or env vars).` exit 1 (`redash-query.js:259-262`).
- **Bad Redash API key:** `HTTP 404 from https://redash.util.smallcase.com/api/query_results: {"message":"Couldn't find resource. Please login and try again."}` (measured). **404, not 401** — counterintuitive. Note the asymmetry: a *missing* key degrades silently (D2), a *wrong* key propagates uncaught through `resolveAnchorDate` to the CLI catch and kills the whole log search with `Log search failed: HTTP 404 ...` exit 1.
- **Bad `REDASH_DATA_SOURCE_ID`:** `HTTP 500 from https://redash.util.smallcase.com/api/query_results: {"message": "Internal Server Error"}` (measured).
- **Bad Mongo pipeline:** `Redash query failed: Unrecognized pipeline stage name: '$nosuchstage'` via the job `status === 4` path (`redash-query.js:208-210`).
- **Off-VPN / bad host:** `getaddrinfo ENOTFOUND <host>` (measured).
- **Unbounded tag/order-id Redash query:** refused before it runs — `Error: --tag/--order-id without --batch-id requires --from and/or --to.` exit 1 (`redash-query.js:253-255, 267-273`).

---

## 3. PREFLIGHT — the cheapest sequence that proves the environment

Total ~5 seconds. Run it before any real investigation, and again before reporting a zero result.

**Step 0 — code intact (0.2s, no network, no credentials).**
`npm test` in the repo root. Expect exactly `# pass 48` / `# fail 0`. All 48 tests mock S3 and Redash via injected `dependencies`, so this never touches production.

**Step 1 — AWS reachable and credentials live (~1s).** Use the **Node SDK**, not the AWS CLI:
```
node -e "process.env.AWS_PROFILE=process.env.AWS_PROFILE||'smallcase';const{S3Client,ListObjectsV2Command}=require('@aws-sdk/client-s3');new S3Client({region:'ap-south-1'}).send(new ListObjectsV2Command({Bucket:'sc-eks-pod-logs',Prefix:'production/',Delimiter:'/',MaxKeys:2})).then(r=>console.log('AWS OK',(r.CommonPrefixes||[]).map(p=>p.Prefix))).catch(e=>console.log('AWS FAIL',e.name,e.message))"
```
Known-good output: `AWS OK [ 'development/', 'production/' ]`.

**DO NOT use `aws sts get-caller-identity --profile smallcase` as the preflight.** On this machine it exits **255** with `The value for sso_start_url is inconsistent between profile (https://smallcase.awsapps.com/start) and sso-session (https://case-platforms.awsapps.com/start).` while the Node SDK works perfectly against the same profile. `aws configure list --profile smallcase` fails the same way. The AWS CLI produces a **false alarm** here; only the SDK path reflects what the toolkit actually does.

**Step 2 — Redash config present, without printing it.**
```
ls .env && node -e "console.log('REDASH configured:', require('./redash-query').isConfigured())"
```
Expect `REDASH configured: true`. Never `cat .env`, never `env | grep REDASH`.

**Step 3 — Redash end-to-end, one command, ~2s.**
```
node redash-query.js --collection orders --match '{}' --limit 1
```
Known-good output on stderr: `Querying collection=orders, match={}, limit=1` then `1 row(s) returned.`, followed by one order document. This single command proves `.env` loaded, VPN reachable, API key valid, data source id valid, and the `orders` collection name correct. `1 row(s)` is the assertion — `0 row(s)` here means the environment is broken, not that the DB is empty.

**Step 4 — only when a search comes back empty: prove the date partition has data.** A list-only probe costs one API call:
```
node -e "const{listObjects}=require('./s3-search-utils');const{S3Client}=require('@aws-sdk/client-s3');const d=process.argv[1];new Promise(async r=>{const s3=new S3Client({region:'ap-south-1'});for(const[b,p]of[['sc-eks-pod-logs',`production/${d}/integrations/sc-integrations-order-updates-pod/`],['sc-pm2logs-new',`PROD/${d}/sc-integrations-order-updates/Out-logs/`]]){const o=await listObjects(s3,{bucket:b,prefix:p});console.log(b,o.length,'objects');}r()})" 2026-09-22
```
Known-good for 2026-09-22: `sc-eks-pod-logs 2304 objects` / `sc-pm2logs-new 0 objects`.

Do **not** use a full real search as the preflight: one service-day of order-updates is 2,304 objects and takes 33 seconds.

---

## 4. Remediation

| Failure | Fix |
|---|---|
| Credentials missing/expired | `aws sso login --profile smallcase` — **verified working**: it correctly uses the `sso-session case-platforms` block and opens the OIDC flow. (Only `sts`/`configure` trip the consistency check.) |
| `sso_start_url is inconsistent` from any `aws` CLI command | Optional cleanup for the human: delete the stale `sso_start_url` and `sso_region` lines from `[profile smallcase]` in `~/.aws/config` so the `sso_session` block is the single source. **Recommend it; the skill must not edit the user's AWS config.** |
| Redash not configured | Create `/Users/rishidatta/Desktop/integrations/fetch-s3-logs/.env` with `REDASH_URL=`, `REDASH_API_KEY=`, `REDASH_DATA_SOURCE_ID=`. Ask the human for the values — the API key is per-user and is on the Redash profile page. Never guess, never reuse one seen in a log. |
| Off-VPN (`ENOTFOUND`, or a hang) | Connect the VPN. S3 keeps working without it, so log search still functions with `--date` supplied explicitly; only the auto-anchor lookup needs Redash. |
| DEEP_ARCHIVE object errors | The data is not lost, it is archived. Report that a Glacier Deep Archive restore is required (hours of latency); do not report "not found". |
| Stray AWS env vars | `env | grep ^AWS` — expect **no output** on a clean machine (verified). |

---

## 5. `.env` and secret handling

- `.env` is gitignored: `.gitignore:3` is `.env`, confirmed by `git check-ignore -v .env` -> `.gitignore:3:.env`. It is **untracked**: `git ls-files --error-unmatch .env` fails with "did not match any file(s) known to git". (confirmed)
- It holds exactly three keys: `REDASH_API_KEY`, `REDASH_URL`, `REDASH_DATA_SOURCE_ID`.
- The toolkit never leaks the key: it goes in the `Authorization: Key ...` header (`redash-query.js:157`), and error text interpolates only the URL (`redash-query.js:167`). **Redash error messages are therefore safe to paste into a report; `.env` contents are not.**
- Rule for the skill: never `cat .env`, never echo `REDASH_API_KEY`, never `env | grep REDASH`, never write the value into a report/manifest/commit, never send it to any host other than `REDASH_URL`. Check presence only via `require('./redash-query').isConfigured()`, which returns a boolean. Same rule for AWS SSO tokens under `~/.aws/sso/cache/`.
- Separately: `AGENTS.md:19-22` warns that SBI logs themselves carry unredacted bearer tokens, account numbers and a dealer plaintext password. The same never-reproduce rule applies to anything pulled out of the logs.

---

## 6. Rate limits, timeouts, cost ceilings — why not to retry in a loop

**Redash**
- Poll ceiling: `POLL_INTERVAL_MS = 800`, `MAX_POLLS = 150` -> **120 seconds**, then `Redash query did not complete within 120s (job <id>)` (`redash-query.js:196, 200, 213`).
- `orders.tag` and `unplaced.tag` are **unindexed** and live inside arrays. Measured empirically and recorded in-source (`redash-query.js:197-199, 226-230`): 7d ~20s, 14d ~24s, 30d ~44s, 60d+ unreliable even at the 120s ceiling. Cost scales with the date range scanned, so a retry loop is strictly worse load on production.
- Hence the hard guard at `redash-query.js:253-255`: `--tag`/`--order-id` without `--batch-id` requires `--from`/`--to`. Never work around it with `--match`.
- The anchor lookup tiers the lookback itself: `REDASH_LOOKBACK_TIERS_DAYS = [7, 14, 30]` (`search-s3-logs.js:38`, used at `:769`). Widening beyond 30 days is deliberately not offered.
- Cheap queries (indexed `_id`, or `--match '{}' --limit 1`) return in ~2s (measured).

**S3**
- Retries: `maxAttempts: 5` in `search-s3-logs.js:634`. `search-s3-recon.js:154` constructs its client with **no** `maxAttempts`, so it uses the SDK default of 3. (confirmed)
- Concurrency caps: log search default 16, max 50 (`search-s3-logs.js:29-30`); recon default 8, valid 1-50 (`search-s3-recon.js:24, 89-91`).
- Date-window caps: `--from/--to` at most 30 days (`search-s3-logs.js:208-209`); `--month` rejected if the month exceeds 30 days (`:225-227`).
- Measured throughput: one service-day of order-updates on EKS = **2,304 objects / 594.8 MB**, a full search scanned **0.581 GB in 33 s** at concurrency 16, exit 0. platform-api is larger: **3,186 objects / 1,675 MB per day**.
- Extrapolated (inferred from those measurements): a flat 30-day window for one service is ~69,000 objects, ~17 GB scanned, **~16 minutes**. At the ap-south-1 S3 Select rate of roughly $0.00225/GB scanned that is about **$0.04** — money is not the ceiling, **wall-clock is**. That is the whole reason for the tiered auto-scope (`AUTO_SCOPE_TIERS`, `search-s3-logs.js:43-48`: 3d, 9d, 17d, 30d).
- Recon has **no date bound at all** — every run lists and S3-Selects every CSV under both prefixes (`search-s3-recon.js:39-42, 109-116`). Measured today: `sbi_recon/` 1,656 CSVs / 285.8 MB, `mtf_recon/` 909 CSVs / 97.1 MB — **2,565 files, 383 MB, every single run**. A single Select on one recon CSV took 251 ms, so a full run is ~80 s at concurrency 8, about $0.001. Batch all your tags into one invocation (`--tag` is repeatable) rather than running it once per tag.

---

## 7. Log coverage matrix — the biggest single source of false negatives

Measured live 2026-09-23. **This is a moving target; probe, do not hardcode.**

**Where order-updates logs actually are, by date:**
- EKS `sc-eks-pod-logs production/<date>/integrations/sc-integrations-order-updates-pod/`: **0 objects** for 2025-12-01, 2026-01-15, 2026-02-01, 2026-03-01, 2026-05-01, 2026-06-05, 2026-07-01. **427 objects** on 2026-08-01, and populated every day after.
- EC2 `sc-pm2logs-new PROD/<date>/sc-integrations-order-updates/Out-logs/`: populated for all those earlier dates (5-30 objects/day), **0 objects** on 2026-09-22, and the `sc-integrations-order-updates/` partition disappears entirely between 2026-08-15 and 2026-09-01.
- `sc-integrations-broker-api/` disappears from the EC2 bucket between 2026-07-15 and 2026-08-01.
- `sc-platform-api/` is **still writing to the EC2 bucket on 2026-09-23** as well as EKS — platform-api is dual-running; check both.
- This matches the in-source note at `fetch-s3-logs.js:68-74, 82`.

**Storage class on `sc-pm2logs-new` (the archive cliff):**
- 2026-03-01, 2026-04-01, 2026-05-01, 2026-05-15 -> **100% DEEP_ARCHIVE** -> unreadable by both S3 Select and GetObject.
- 2026-06-01 onward -> `GLACIER_IR` / `STANDARD`.
- **`GLACIER_IR` is fully readable** — verified: a Select on a 2026-08-15 `GLACIER_IR` object returned `ended=true, BytesScanned=2143775` and GetObject succeeded. Only `DEEP_ARCHIVE` fails.
- The boundary sits roughly 4 months back from today and moves daily. Do not hardcode it — probe `StorageClass` from a `ListObjectsV2` response.
- `sc-eks-pod-logs`, `sc-prod-logs` and `sc-integrations-sbi-attachments` were all `STANDARD` in every sample taken.

**Partition inventory:** `sc-eks-pod-logs production/` has 1,121 date partitions, 2023-08-30 to 2026-09-23, **no missing days**. `sc-pm2logs-new PROD/` has 1,167 partitions, 2023-07-15 to 2026-09-23.

Net effect: for an order-updates order dated roughly 2025-09 through 2026-05, EKS is empty (no error) and the EC2 copy is DEEP_ARCHIVE (exit 2, 100% failed objects). Both look like "no logs" to a careless reader.

---

## 8. Corrections to the existing skill file

`/Users/rishidatta/Desktop/integrations/fetch-s3-logs/.claude/skills/sbi-order-investigation/reference/06-tooling.md` is wrong in three places:

1. **Line 10 says an expired AWS session "returns zero objects, not an error".** False. It throws `CredentialsProviderError: Could not load credentials from any providers`, which `search-s3-logs.js:640-647` turns into stderr `Listing failed: ...`, `status: "incomplete"` and **exit 2**. It is loud. The real silent-empty cases are D1 (zero objects listed in a healthy environment), D2 (missing `.env`), D3 (wrong collection name) and D4 (DEEP_ARCHIVE). The caveat that survives: an empty `matches.jsonl` is still written on that failure path, so the output file alone is misleading.
2. **Lines 22-23 prescribe `aws sts get-caller-identity --profile smallcase` as the preflight.** On this machine it exits 255 with an `sso_start_url is inconsistent` error while the toolkit itself works fine. Following that instruction produces a false "AWS is broken" diagnosis and a pointless `aws sso login`. Replace it with the Node SDK probe in section 3. (`aws sso login --profile smallcase` itself is fine and remains the correct remediation.)
3. **Line 11's symptom for a missing `.env` is right but incomplete.** A *missing* key degrades silently to a flat 30-day scan; a *wrong* key crashes the entire log search with `Log search failed: HTTP 404 ...` exit 1. Both need stating, because they look nothing alike. »


## Evidence (32)

- AWS profile and region are defaulted with an env-var override in two scripts but hardcoded without override in a third  
  `search-s3-logs.js:25-27 (process.env.AWS_PROFILE = process.env.AWS_PROFILE || 'smallcase'); search-s3-recon.js:18-20 (same); fetch-s3-logs.js:53-56 (process.env.AWS_PROFILE = 'smallcase', no fallback)`
- Credentials come only from AWS SSO; the shared credentials file is empty  
  `~/.aws/credentials is 0 bytes (ls -la ~/.aws/); ~/.aws/config [profile smallcase] with sso_session = case-platforms, sso_account_id 736414281642, sso_role_name ineq-dev-sso, region ap-south-1`
- The Node SDK silently auto-refreshes an expired SSO token via its refresh token  
  `~/.aws/sso/cache/2526eccbcb219dcb0b5f5a4cb886b3a5ed6948b0.json expiresAt moved from 2026-09-23T08:41:08Z to 2026-09-23T11:42:20.030Z after a single ListObjectsV2 call at 10:41Z; hasRefresh=true`
- The AWS CLI refuses the smallcase profile while the Node SDK succeeds against it  
  `aws sts get-caller-identity --profile smallcase -> exit 255, 'The value for sso_start_url is inconsistent between profile (https://smallcase.awsapps.com/start) and sso-session (https://case-platforms.awsapps.com/start).'; the same profile via @aws-sdk/client-s3 ListObjectsV2 on sc-eks-pod-logs -> OK {"keyCount":1,"prefixes":1}`
- aws sso login --profile smallcase works correctly despite the CLI consistency error  
  `aws sso login --profile smallcase --no-browser printed the OIDC authorize URL (https://oidc.ap-south-1.amazonaws.com/authorize?...) and waited for the callback rather than erroring`
- Missing credentials produce a literal CredentialsProviderError, not an empty result  
  `HOME=/tmp/nohome AWS_CONFIG_FILE=/tmp/nohome/config AWS_PROFILE=smallcase node probe -> ERRNAME=CredentialsProviderError |MSG=Could not load credentials from any providers; handled at search-s3-logs.js:640-647 (Listing failed: ..., status incomplete, return 2)`
- A wrong region yields PermanentRedirect, which is NOT treated as an auth error  
  `AWS_REGION=us-east-1 probe -> ERRNAME=PermanentRedirect |HTTP=301 |MSG=The bucket you are attempting to access must be addressed using the specified endpoint...; isAuthError list at search-s3-logs.js:497-500 contains only AccessDenied, CredentialsProviderError, ExpiredToken, InvalidAccessKeyId, SignatureDoesNotMatch`
- A run that lists zero objects reports status complete and exit 0, identical to a genuine no-match  
  `search-s3-logs.js:732 manifest.status = manifest.objects.scanned === manifest.objects.listed && !outputError ? 'complete' : 'incomplete'; :745 return manifest.status === 'complete' ? 0 : 2`
- A listing failure still writes an empty matches.jsonl before exiting 2  
  `search-s3-logs.js:644 writeMatches(outputDir, []) inside the listing catch block`
- DEEP_ARCHIVE objects fail both S3 Select and the GetObject fallback, producing exit 2 with matchedLines 0  
  `node fetch-by-identifier.js --service order-updates --date 2024-01-01 --text anything -> exit 2, listedObjects 46, failedObjects 46, matchedLines 0; manifest.errors[0].error = 'S3 Select: We do not support DEEP_ARCHIVE storage class. Please check the service documentation and try again.; GetObject fallback: The operation is not valid for the object'\''s storage class'`
- GLACIER_IR objects are fully readable by both S3 Select and GetObject  
  `SelectObjectContent on s3://sc-pm2logs-new/PROD/2026-08-15/sc-integrations-order-updates/Out-logs/...gz (class=GLACIER_IR) -> SELECT OK ended=true stats={"BytesScanned":2143775,...}; GetObject on the same key -> GET OK`
- The DEEP_ARCHIVE cliff on sc-pm2logs-new sits between 2026-05-15 and 2026-06-01  
  `ListObjectsV2 StorageClass survey of PROD/<date>/sc-integrations-order-updates/Out-logs/: 2026-03-01 {DEEP_ARCHIVE:2}, 2026-04-01 {DEEP_ARCHIVE:28}, 2026-05-01 {DEEP_ARCHIVE:6}, 2026-05-15 {DEEP_ARCHIVE:14}, 2026-06-01 {GLACIER_IR:27}, 2026-06-05 {STANDARD:2,GLACIER_IR:16}, 2026-08-01 {GLACIER_IR:2}`
- order-updates logs are on EC2 only before ~2026-08 and on EKS only after, with no overlap for most of 2026  
  `Full listObjects counts: 2025-12-01 eks=0/pm2Out=30, 2026-01-15 eks=0/pm2Out=5, 2026-03-01 eks=0/pm2Out=2, 2026-06-05 eks=0/pm2Out=18, 2026-07-01 eks=0/pm2Out=22, 2026-08-01 eks=427/pm2Out=2; 2026-09-22 eks=2304/pm2Out=0`
- platform-api still dual-writes to the EC2 bucket while order-updates and broker-api no longer do  
  `listCommonPrefixes on sc-pm2logs-new PROD/<date>/: 2026-09-23 -> only PROD/2026-09-23/sc-platform-api/; 2026-06-01 -> broker-api, order-updates and platform-api all present; broker-api last seen 2026-07-15, order-updates last seen 2026-08-15. Matches the in-source note at fetch-s3-logs.js:68-74`
- Redash config is read from a gitignored, untracked .env holding exactly three keys  
  `redash-query.js:27-44 loadEnvFile() reading path.join(__dirname, '.env'); .gitignore:3 = .env; git check-ignore -v .env -> .gitignore:3:.env; git ls-files --error-unmatch .env -> 'did not match any file(s) known to git'; keys present: REDASH_API_KEY, REDASH_URL, REDASH_DATA_SOURCE_ID`
- A missing .env silently degrades the log search to a flat 30-day scan instead of failing  
  `redash-query.js:216-218 isConfigured(); search-s3-logs.js:763 return { anchor: null, note: 'redash-not-configured' }; search-s3-logs.js:802-803 console.log('No anchor date available (...); falling back to the flat latest-30-days window.') then return runSearch(args, dependencies)`
- A wrong Redash API key returns HTTP 404 (not 401) and crashes the whole log search  
  `REDASH_API_KEY=deadbeef... runRedashQuery -> ERR: HTTP 404 from https://redash.util.smallcase.com/api/query_results: {"message":"Couldn't find resource. Please login and try again."}; thrown at redash-query.js:167, uncaught through findOrderAnchorDate (:243) and resolveAnchorDate (:770) to the cli catch at search-s3-logs.js:872-879`
- A wrong REDASH_DATA_SOURCE_ID returns HTTP 500  
  `REDASH_DATA_SOURCE_ID=99999 runRedashQuery -> ERR: HTTP 500 from https://redash.util.smallcase.com/api/query_results: {"message": "Internal Server Error"}`
- A nonexistent or wrong-cased Mongo collection returns zero rows with exit 0 and no error  
  `runRedashQuery per collection: orders -> rows=1, Orders -> rows=0, order -> rows=0, placedOrders -> rows=1, placedorders -> rows=0, users/activations/jobs -> rows=1; nosuchcollection_xyz -> OK rows=0`
- Redash is only reachable on the corporate network and redash-query.js sets no socket timeout  
  `dns.lookup('redash.util.smallcase.com') -> 10.1.2.82 (RFC1918); redash-query.js:148-182 https.request options contain no timeout field and there is no req.setTimeout call; bad host -> getaddrinfo ENOTFOUND`
- The Redash poll ceiling is 120 seconds and the unindexed tag-query cost is documented in-source  
  `redash-query.js:196 POLL_INTERVAL_MS = 800; :200 MAX_POLLS = 150; :213 'Redash query did not complete within 120s (job ...)'; :197-199 and :226-230 record 7d~20s, 14d~24s, 30d~44s, 60d+ unreliable for the unindexed orders.tag/unplaced.tag`
- Unbounded tag/order-id Redash queries are refused outright  
  `redash-query.js:253-255 requiresDateBound(); :267-273 'Error: --tag/--order-id without --batch-id requires --from and/or --to.' then process.exit(1)`
- One service-day of order-updates EKS logs is 2,304 objects / 0.581 GB scanned in 33 seconds  
  `node fetch-by-identifier.js --service order-updates --date 2026-09-22 --text zzz_no_such_string_zzz -> exit 0, status complete, listedObjects 2304, scannedObjects 2304, failedObjects 0, matchedLines 0, manifest.bytes.scanned 0.581 GB, elapsed 33s at concurrency 16`
- search-s3-recon.js scans all 2,565 recon CSVs (383 MB) on every single run, with no date bound  
  `search-s3-recon.js:39-42 SOURCES = sbi_recon/ and mtf_recon/ with no date component; :109-116 listCsvKeys lists the whole prefix; measured sbi_recon 1656 CSVs / 285.8 MB, mtf_recon 909 CSVs / 97.1 MB; one SelectObjectContent on a 256 KB recon CSV took 251 ms`
- Retry budget differs between the two S3 clients  
  `search-s3-logs.js:634 new S3Client({ region: process.env.AWS_REGION, maxAttempts: 5 }); search-s3-recon.js:154 new S3Client({ region: process.env.AWS_REGION }) with no maxAttempts (SDK default 3)`
- Concurrency and date-window ceilings  
  `search-s3-logs.js:29-30 DEFAULT_CONCURRENCY 16 / MAX_CONCURRENCY 50; :208-209 --from/--to at most 30 days; :225-227 --month rejected above 30 days; search-s3-recon.js:24 DEFAULT_CONCURRENCY 8, :89-91 concurrency must be 1-50`
- Missing SelectObjectContent permission aborts the entire log search rather than falling back to GetObject  
  `search-s3-logs.js:546-550 - if isAuthError(selectError) the object is returned with fatal:true (no fallback call); :708 if (result.fatal) fatalError = result.error; :699-700 every subsequent object is marked 'skipped'`
- The test suite is a valid zero-cost preflight: it passes offline with no credentials  
  `npm test -> '# tests 48 / # pass 48 / # fail 0 / # duration_ms 181.210875'; test/search-s3-recon.test.js:22-43 and test/redash-query.test.js inject a mock s3 / call pure functions only`
- Credentials are never interpolated into error text, so Redash errors are safe to quote  
  `redash-query.js:157 Authorization: `Key ${REDASH_API_KEY}` is set as a header only; :167 the thrown message is `HTTP ${res.statusCode} from ${url}: ${data.slice(0, 500)}` where url is REDASH_URL + path`
- The existing skill's tooling reference misstates the expired-credentials symptom and prescribes a preflight that fails on this machine  
  `.claude/skills/sbi-order-investigation/reference/06-tooling.md:10 ('expired session returns zero objects, not an error') contradicted by the measured CredentialsProviderError + exit 2; :22 ('aws sts get-caller-identity --profile smallcase') exits 255 on this machine while the toolkit works`
- Node version floor  
  `fetch-s3-logs.js:7 'Node.js >= 16'; package.json:8 "test": "node --test" which requires Node >= 18; installed node --version = v18.20.8; package.json declares no engines field`
- All four buckets are currently listable and Select-able with the smallcase profile  
  `ListObjectsV2 OK on sc-eks-pod-logs (development/, production/), sc-pm2logs-new, sc-prod-logs, sc-integrations-sbi-attachments; SelectObjectContent OK on sbi_recon/2025-05-13/daily_data_smallcase_20250513_1540.csv returning BytesScanned 256322`


## Still unknown (8)

Report these as unknown rather than guessing.

- The exact SDK v3 error text for an SSO session whose REFRESH token has expired (as opposed to the access token, which auto-refreshes) could not be reproduced without invalidating the live token. Expect 'The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.' and note that CredentialsProviderError is in isAuthError (search-s3-logs.js:497-500), so it is loud either way. Marked inferred.
- The exact AccessDenied behaviour for a partially-scoped IAM role was not reproducible - the current role (ineq-dev-sso) has full access to all four buckets. The code path is read (AccessDenied is fatal at search-s3-logs.js:546-550) but the literal S3 message was not observed.
- The S3 Select price per GB in ap-south-1 is from general AWS pricing knowledge, not from anything in this repo. The dollar figures in section 6 are order-of-magnitude only; the measured byte and time figures are exact.
- Whether the org has an S3 lifecycle policy document defining the DEEP_ARCHIVE transition age - the ~4-month boundary is inferred from the measured storage-class survey across eight dates, not read from a policy.
- The exact day order-updates cut over from EC2 to EKS was bracketed to 2026-07-01 (eks=0) .. 2026-08-01 (eks=427) but not pinned to a single date.
- 06-tooling.md:14 claims '--region is parsed and then ignored'. Not verified in this pass - fetch-s3-logs.js:55-56 does hardcode AWS_REGION after the requires, which is consistent with the claim, but the argument-parsing path was not traced.
- Whether REDASH_DATA_SOURCE_ID differs between the prod Mongo data source and any other Redash data source was not investigated; only that a wrong value returns HTTP 500. The real value was deliberately not read out of .env.
- Whether Redash enforces any per-user API rate limit or concurrent-query cap beyond the client-side 120s poll ceiling. Nothing in the repo documents one and none was triggered during testing.
