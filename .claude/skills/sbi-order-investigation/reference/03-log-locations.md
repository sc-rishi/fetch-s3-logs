# Log Locations

Four structurally different S3 surfaces. Picking the wrong one silently returns nothing useful.

| # | Surface | Bucket | Contents |
|---|---|---|---|
| 1 | Legacy EC2/PM2 app logs | `sc-pm2logs-new` | per-service, date-partitioned stdout/stderr |
| 2 | Kubernetes/EKS app logs | `sc-eks-pod-logs` | per-service, date-partitioned pod logs |
| 3 | jobs per-invocation logs | `sc-prod-logs` | one gzip object **per job run**, not date-partitioned |
| 4 | SBI recon / master data | `sc-integrations-sbi-attachments`, `smallcase-trash` | broker CSV exports, not log lines at all |

## Surfaces 1 & 2 — application logs

Live-verified routing. The EKS migration is **not uniform** — do not assume one bucket.

| Service | Current | Rule |
|---|---|---|
| `sc-integrations-order-updates` | EKS only | fully migrated — pick by date, do not try both |
| `sc-integrations-broker-api` | EKS only | same (rarely useful anyway — see below) |
| `sc-platform-api` | **both, actively written** | **always query both and merge.** Neither is a fallback for the other |
| `sc-integrations-jobs` (daemon) | EC2/PM2 only | never migrated; not a persistent pod |

```
EKS:      s3://sc-eks-pod-logs/production/{YYYY-MM-DD}/integrations/sc-integrations-order-updates-pod/
          s3://sc-eks-pod-logs/production/{YYYY-MM-DD}/integrations/sc-integrations-broker-api-pod/
          s3://sc-eks-pod-logs/production/{YYYY-MM-DD}/platform/sc-platform-api-pod/
          (staging: replace "production" with "staging")

EC2/PM2:  s3://sc-pm2logs-new/PROD/{YYYY-MM-DD}/sc-integrations-order-updates/
          s3://sc-pm2logs-new/PROD/{YYYY-MM-DD}/sc-platform-api/
          s3://sc-pm2logs-new/PROD/{YYYY-MM-DD}/sc-integrations-jobs/
```

The `integrations` / `platform` namespace segments are confirmed verbatim by live listing.

**PM2 sub-folders** under each service directory: `Error-logs/`, `Out-logs/`, `code-deploy-logs/`,
`script-logs/`. Without `--dir Out-logs` you pull all four, mixing deploy and cron-backup noise
into the results. Always pass `--dir Out-logs`; add a second run with `--dir Error-logs` if you
specifically want the error stream. EKS pod logs have no equivalent split.

### Identifying a service in a mixed dump

Match on the bunyan `name` field:

| Service | `name` |
|---|---|
| order-updates | `sc.service.sc-integrations-order-updates` |
| broker-api | `sc.service.sc-integrations-brokers-api` — **BROKERS, plural** |
| smallboard | `sc.service.smallboard` |

The broker-api mismatch between its log name (plural) and its S3 path (singular) will silently
return nothing if you search by the wrong one.

### Log record shape

Every order-updates line carries `type` (default `APPLICATION_LOGS`), `message`, APM trace ids, and
a `context` object. Known non-default `type` values: `API_REQUEST`, `RESPONSE_LOG`,
`DEBUG_MESSAGES`, `SC_BROKER`, `SC_BROKER_META`.

`SC_BROKER` lines are the richest for status questions — they carry the **raw outbound HTTP
request and response to SBI**, including the full broker response body.

## Surface 3 — jobs per-invocation logs

Not date-partitioned. One gzip object per job *run*, written by `@smallcase/scheduler-agent`:

```
s3://sc-prod-logs/<repo>/<jobName>_<bullJobId>
s3://sc-prod-logs/sc-integrations-jobs/sbiReconAllOrders-batchCreation_repeat:<hash>:<epochMs>
```

- The first key segment is `job.data.repo` — a scheduler-side field, **not** the agent's computed
  repo name. The prod IAM policy grants both `sc-prod-logs/sc-integrations-jobs/*` **and**
  `sc-prod-logs/integration-jobs/*`, so **list both prefixes** before concluding a job produced no log.
- For repeatable jobs the key ends in `:<epochMs>` — the scheduled run time, giving you a date
  without needing S3 `LastModified`.
- **Only stdout is captured.** stderr goes to the parent process and a Redis pub/sub stream, never
  to S3. Bunyan writes to stdout so `logger.error` *is* captured; a raw `console.error` or an
  uncaught exception trace is **not**.
- Objects are genuinely gzip but carry `ContentType: application/octet-stream`, no
  `ContentEncoding` and no `.gz` extension — auto-detection fails, so `--force-gunzip` is required.
  `fetch-by-identifier.js --service jobs-recon` passes it automatically.
- Upload is **unconditional** in every environment (the in-source comment claiming "production and
  critical only" is stale). Staging lands in `sc-stag-logs`; with the bucket env unset, in
  `smallcase-trash`.

### Job log field placement

`logger.info` puts its message in `jobs.info`. `logger.error` and `logger.warn` put it in
`jobs.msg`, with `jobs.stack`. **A filter on `jobs.info` misses every error and warning.**

`cleanupMtfNonTerminalBatches.js` calls the logger with its arguments reversed, so for that job
the message lands in `jobs.data` and the context object in `jobs.info`.

### A job's `jobName` does not identify its file

The S3 key uses the physical filename; log bodies use the file's internal `jobName` constant.
Confirmed SBI-relevant collisions:

| File | Logs as |
|---|---|
| `sbiUnplacedRecon.js` | `sbiDealerRecon` — collides with the real `sbiDealerRecon.js` |
| `createSbiAutosipOrders.js` **and** `createSBIAutosipOrders-NonWorkingDay.js` | both `placeSbiAutosips` |
| `activations/sbi/ingestUsers.js` **and** `activations/sbiV2/ingestUsers.js` | both `sbiActivation` |
| `triggerAmoPoll.js`, `triggerAmoPollNonMarketDay.js`, `triggerAmoPollKite.js` | all `amoPoll` |
| `markBatchesAsUnfilled.js` | `markDealerBatchesAsUnfilledEOD` |
| `scripts/adhoc/orders/sbi/fixDoubleBuy.js` | `fixDuplicateIscidsCopy` |

`sbiReconAllOrders.js` is **not** affected. For the two `ingestUsers` jobs, disambiguate by the URL
inside the `Order count response` line: `/api/v1/Smallcase_CGS/` = v1,
`/KycKraApi/api/v1/smallcaseCallback/` = v2.

**Identify the producing job from the S3 object key, never from the log field.**

## Surface 4 — SBI recon and master data

```
s3://sc-integrations-sbi-attachments/
    sbi_recon/<YYYY-MM-DD>/               daily SBI order-status CSV export
    mtf_recon/<YYYY-MM-DD>/               same schema, SBI-MTF orders
    sbi_rejected_amo_orders/<YYYY-MM-DD>/ AMO rejection CSV
    sbi_masterscrip/ , masterscrip/       instrument symbol master data
    mtf_security_margin/                  per-security MTF margin percentages
```

`sbiReconAllOrders.js` reads and merges both `sbi_recon/` and `mtf_recon/` for a date.
`sbiDealerRecon.js` and `sbiUnplacedRecon.js` read from a **different** bucket —
`SBI_ORDERBOOK_BUCKET`, default `smallcase-trash` — via an explicit `--filepath`, no fixed prefix.

These are broker CSV, not JSON. Search with `search-s3-recon.js` (S3 Select, server-side), or with
`--filter-text` / `--no-filter-text` if you must use `fetch-s3-logs.js`. `--filter-field` does JSON
key matching and will not parse CSV usefully.

**Who writes these files is unknown.** Nothing in `sc-integrations-jobs` puts anything into these
prefixes — it only reads them. Delivery is external (likely an SES/Lambda email-attachment pipeline,
given the sibling `sc-integrations-sbi-emails` bucket in the IAM policy). So "why is today's SBI
file missing?" cannot be answered from any checked-out repo.

SBI has **no SFTP reconciliation channel** (unlike Kotak). Its recon retrieval is entirely
S3-file-based.

## Absence of evidence

An empty result is the most likely wrong answer you can give. Before reporting "not found":

1. Confirm AWS SSO has not expired — an expired session returns zero objects, not an error.
2. Confirm `.env` exists — without it, Redash lookups silently degrade.
3. Confirm the exit code was `0`. Exit `2` / `manifest.status: "incomplete"` means at least one
   object was not searched.
4. Confirm you searched the right bucket for the date (EKS vs EC2, and **both** for platform-api).
5. Confirm you were not searching broker-api for an order tag — that is guaranteed empty.
6. For a recent order, check whether the evidence could exist yet: today's recon CSV may not have
   arrived, and the recon job may not have run.
7. For a job log, list **both** the `sc-integrations-jobs/` and `integration-jobs/` prefixes.

S3 also cannot expose logs that were deleted, expired, or had not yet been uploaded when the run's
snapshot was listed.
