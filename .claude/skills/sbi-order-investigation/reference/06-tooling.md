# Tooling

The CLI toolkit in this repo. All read-only. Run `--help` on any of them for the authoritative
current flag list — this file explains *when* and *why*, plus the traps.

## Prerequisites

| Dependency | How it is supplied | Symptom when missing |
|---|---|---|
| AWS credentials | SSO profile `smallcase`, region `ap-south-1` — both **hardcoded** in the scripts | expired session returns **zero objects**, not an error — looks exactly like "not found" |
| `REDASH_URL`, `REDASH_API_KEY`, `REDASH_DATA_SOURCE_ID` | `.env` in the repo root (gitignored) | auto-scope silently degrades to a flat 30-day S3 scan |
| node + `@aws-sdk/client-s3` | `npm install` | crashes loudly — safe |

`--region` is parsed and then ignored. Passing it does nothing.

**The dangerous failures are the silent ones.** Expired SSO and a missing `.env` both produce
empty results that are indistinguishable from a genuine absence. Check both before reporting that
an order could not be found.

```bash
aws sts get-caller-identity --profile smallcase
aws sso login --profile smallcase      # if the above fails
ls .env
```

## fetch-by-identifier.js

The main entry point. A thin CLI over `search-s3-logs.js`.

```bash
node fetch-by-identifier.js --service order-updates --tag sc_xxxxxxxxx --date 2026-06-05
node fetch-by-identifier.js --service order-updates --tag sc_xxxxxxxxx
node fetch-by-identifier.js --service order-updates --text "broker action - orderStatus"
node fetch-by-identifier.js --service all --batch-id <id> --from 2026-09-18 --to 2026-09-20
node fetch-by-identifier.js --service jobs-recon --job-name sbiReconAllOrders --tag <t> --month 2026-06
```

Exactly one of `--tag`, `--order-id`, `--batch-id`, `--text` is required.
`--service` is always required: `order-updates | broker-api | platform-api | jobs | jobs-recon | all`.
`jobs-recon` additionally requires `--job-name`.

Date scope is optional: `--date` | `--from`+`--to` (max 30 days) | `--month`. Omitted, behaviour
splits by identifier kind — see **auto-scope** below.

Other flags: `--env prod|staging` (default prod), `--out <dir>`, `--concurrency <n>` (default 16,
max 50).

### Auto-scope — how a date gets resolved when you don't give one

Only applies to `--tag` / `--order-id` / `--batch-id`. For `--text` it is a flat latest-30-days scan.

**Anchor date:**

| Identifier | Mechanism | Cost |
|---|---|---|
| `--batch-id` | decodes the Mongo ObjectId's first 4 bytes (a Unix timestamp) | instant, local, no network |
| `--tag` / `--order-id` | Redash lookup tried at 7, then 14, then 30 days back | ~20s / ~24s / ~44s per tier attempted |

The tag/orderId fields are unindexed arrays, so cost scales with the window. 60 days+ is
unreliable even against the 120s poll ceiling. Tiering keeps each attempt in the fast range.

**S3 tiers around the anchor** — stops at the first tier with any match:

| Tier | Window | Width |
|---|---|---|
| 1 | anchor−1 .. anchor+2 | 4 days |
| 2 | anchor−1 .. anchor+7 | 9 days |
| 3 | anchor−1 .. anchor+15 | 17 days |
| 4 | anchor−1 .. anchor+28 | 30 days (system cap) |

Biased forward deliberately: a delayed status update or a fix appears *after* placement, never
before. Each tier searches only the incremental new dates. `manifest.json`'s `tiers[]` records
which ran and what each found. Dates are never generated past today (IST).

**Exit code 3 / `not_found_in_db`** means Redash found no matching order in 30 days. It does *not*
mean the order does not exist — pass an explicit date for anything older.

### Output

| File | Shape |
|---|---|
| `matches.jsonl` | valid JSON Lines: source S3 URI, surface, object + log timestamps, full record. **Prefer this.** |
| `manifest.json` | query, scope, and counts: listed / scanned / fallback / failed / matched / bytes |
| `all-logs.filtered.log` | legacy compatibility output — pretty-printed objects with trailing commas and **no `[...]` wrapper**, so not `JSON.parse`-able whole |

**Completeness contract:** exit `0` means every object in the run's S3 snapshot was searched. Exit
`2` with `manifest.status: "incomplete"` means at least one was not — **never read an incomplete
zero-match run as "not found"**.

Output order reflects concurrent completion, not chronology. Sort by each record's `time`.

## redash-query.js

Live Mongo state through Redash — the org's only sanctioned prod DB path (data source 35, "Atlas
Mongo"). Complementary to logs: logs give you the sequence of events, this gives you where things
actually landed.

```bash
node redash-query.js --collection orders --batch-id <id>
node redash-query.js --collection orders --tag sc_xxx --from 2026-06-05 --to 2026-06-05
node redash-query.js --collection orders --broker sbi --status ERROR --from 2026-09-01 --to 2026-09-20 --limit 20
node redash-query.js --collection orders --match '<raw $match json>'
```

`--tag` / `--order-id` **without** `--batch-id` require `--from` and/or `--to`. The script refuses
the unbounded case rather than risking a full collection scan on production.

`--batch-id` needs no date bound and is fast (~1-2s) regardless — another reason to pivot to a
batchId early.

**The refusal is slightly over-broad:** a tag query prefixed by the indexed `{broker, brokeruserId}`
compound index is cheap and needs no date. If you know the `brokeruserId`, use `--match` to express
that shape.

Output: `--out <file>` for full raw JSON, `--raw` to include columns as well as rows.

## search-s3-recon.js

S3 Select over the SBI broker recon CSVs. Searches server-side and downloads only matching objects.

```bash
node search-s3-recon.js --tag sc_a --tag sc_b --order-id 123 --exchange-order-id 456 --out ./logs/recon
```

Flags are **repeatable** and become one SQL `IN (...)` per field. A single call with 44 combined
identifiers scanned 2,555 CSVs in under a minute. **Always batch identifiers into one call** rather
than looping.

Column mapping: 9 = tag/reference, 4 = internal order number, 11 = exchange order number. The
broker's header for column 9 is `ORD_REMARKS` or `ORD_EXT_REF_NO` depending on the file.

Not subject to the 30-day cap — recon CSV history is searchable in full.

Note: column 6 is labelled `isin` in the job code but actually holds the **NSE symbol with an `EQ`
suffix** (`PNBEQ`, `WIPROEQ`). Nothing in the pipeline handles a real INE-prefixed ISIN.

## fetch-s3-logs.js

The low-level fetcher the others build on. Reach for it when you need a bucket or prefix the
higher-level tools do not cover.

```bash
node fetch-s3-logs.js --s3-url s3://<bucket>/<prefix> --out <dir> --filter-text "<tag>" --ci --sort of
```

Traps, all of which have produced wrong conclusions before:

- **Hardcoded `DEFAULTS`** for date and filter-text are development scratch values that silently
  apply when you omit the flags. Always pass `--s3-url` and either `--filter-text` or
  `--no-filter-text` explicitly.
- **`--filter-text` and `--filter-field` are OR'd, not AND'd.** To combine conditions, filter
  broadly once then inspect the output.
- **Failed S3 GETs are not retried** and the run still exits 0. A thin result may be partial
  failure, not absence.
- `--dir Out-logs` is required on the EC2/PM2 path or you pull deploy and cron-script noise.
- `--force-gunzip` is needed for the jobs per-run surface: those objects are genuinely gzip but
  carry `ContentType: application/octet-stream`, no `ContentEncoding` and no `.gz` extension, so
  auto-detection fails.
- A `{date}` placeholder in the URL plus `--date-from`/`--date-to` scans a range in one invocation
  (max 30 days), writing `<out>/<date>/`. Do not confuse with `--from`/`--to`, which filter log
  lines by timestamp rather than selecting day partitions.
- `--filter-text` is pushed into S3 Select server-side; `--filter-field` is not, so field filters
  still download full objects.

## Known capability gap

`sc-smallboard-be` is **not** in the `--service` registry (which holds only order-updates,
broker-api, platform-api, jobs, jobs-recon). Since smallboard's `REQUEST_LOG` / `RESPONSE_LOG`
middleware is the primary operator-attribution trail, this is a real gap.

Its logger name is `sc.service.smallboard`; its prod k8s env is `util`, team `platform`, so the
prefix is *probably* `s3://sc-eks-pod-logs/util/<date>/platform/sc-smallboard-be-pod/` — this is
**unverified**. Someone needs to list `s3://sc-eks-pod-logs/` and confirm whether `util` is a
top-level partition alongside `production` and `staging`.
