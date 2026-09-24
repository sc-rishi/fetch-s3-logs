---
name: sbi-order-investigation
description: Investigate production SBI and SBI-MTF order problems end to end — stuck orders, error batches, rejections, AMO non-execution, margin and funds shortfalls, dealer failures, partial fills, and "who changed this order". Use whenever someone supplies an SBI order identifier (a tag like sc_xxx or scmtf_xxx, a batchId, an orderId, an exchangeOrderId, an iscid or a correlationId) or asks where SBI order logs live, what a broker status code means, whether a recon job fixed something, or why an order is stuck. Also use for "pull the logs for this order", "what happened to this batch", "was this fixed manually or by a job".
---

# SBI / SBI-MTF Order Investigation

You investigate production order problems for SBI and SBI-MTF using the CLI toolkit in this
repo. You already know where everything lives — **work it out rather than asking.**

Scope is SBI and SBI-MTF only. Do not extrapolate any of this to other brokers.

## Hard rules

**Read-only, permanently.** You may search S3, query Redash, and write report files. You must
never call `POST /errors/fix/:batchId`, never run a recon job with `--save`, never write to
Mongo, never change order or batch state. When you conclude a fix is needed, say so and stop —
recommending an action is your job, performing it is not.

**Never print or copy credentials.** SBI logs are *not* redacted the way you would assume:
`Authorization: Bearer <token>`, `tradingAccountNumber`, `depositoryAccountNumber`, `clientId`
and — on the dealer-details call — the dealer's **plaintext login password** all appear in full
(`broker-lib/src/lib/log.js:3-46` blacklists key *names* only, and SBI's key names are not on it).
You will see these while reading logs. Never reproduce them in a report, a message, or a file.

**Report honestly and stop.** If you cannot determine something, say what you searched, what you
ruled out, and what remains unknown. Never fill a gap with a plausible guess. The old guide's
honesty convention holds: "not found" and "unconfirmed" are real answers.

**Verify before concluding "not found".** An empty result is the failure mode most likely to be
wrong. Run the preflight checks below before reporting an absence.

## Preflight

Do this once per session, before the first real search:

```bash
aws sts get-caller-identity --profile smallcase   # expired SSO = silent empty results
ls .env                                            # REDASH_URL / REDASH_API_KEY / REDASH_DATA_SOURCE_ID
```

If SSO has expired: `aws sso login --profile smallcase`. Region and profile are hardcoded in the
scripts (`ap-south-1`, `smallcase`); `--region` is parsed but ignored.

If `.env` is missing, Redash lookups degrade to a flat 30-day S3 scan rather than failing loudly —
so a missing `.env` looks like "order not found". Check it exists before trusting a negative.

## Step 1 — identify what you were given

| Looks like | It is | First move |
|---|---|---|
| `sc_` + 9 alphanumerics | SBI **cash** tag | resolve a date (step 2) |
| `scmtf_` + 9 alphanumerics | SBI-**MTF** tag | resolve a date (step 2) |
| 24 hex chars | `batchId` = the Mongo `Order._id` | decode the date locally — no network call |
| 14-ish digits | SBI internal `orderId` | resolve a date (step 2) |
| other numeric | possibly `exchangeOrderId` | try `--order-id`, it matches either field |
| 24 hex, from platform-api logs | `correlationId` = `PlacedOrders._id` | query `placedOrders`, then pivot to batchId |

**The tag prefix is the only reliable cash-vs-MTF discriminator in a raw log.** Both adapters
stamp `broker: "sbi"` — there is no `broker: "sbi-mtf"` value in real logs
(`broker-lib/src/brokers/sbi-mtf/config.js:19`). Never filter by broker to separate them. The
secondary discriminators are wire `product` 1 (cash) vs 6 (MTF), and stored product `CNC` vs
`EMARGIN` in Mongo.

**Pivot to a `batchId` as early as you can.** It decodes its own creation date with zero network
calls, it needs no date bound in Redash, and it is immune to the date-field drift in step 2.

## Step 2 — resolve the date yourself

Ask the operator for a date only if they volunteered nothing at all. If they do not have one,
**do not ask again — resolve it.**

```bash
# batchId: date is embedded in the ObjectId. Instant, local, no network.
node fetch-by-identifier.js --service order-updates --batch-id <id>

# tag / orderId: tiered Redash lookup (7d ~20s, then 14d ~24s, then 30d ~44s), then
# a narrow S3 window that widens only if empty.
node fetch-by-identifier.js --service order-updates --tag <tag>
```

Auto-scope searches S3 in widening tiers around the anchor date — 4 days, then 9, then 17, then
30 — biased forward, because a late status update or fix lands *after* placement, never before.
It stops at the first tier that finds anything.

If Redash finds nothing across all three tiers it exits **3** with `not_found_in_db` rather than
crawling S3 on a guess. That is not "the order does not exist" — it means "not in the last 30
days". Pass an explicit `--date` / `--from`+`--to` / `--month` for anything older.

**An explicit date always bypasses auto-scope entirely.** The machinery exists for "I don't know
the date", never to second-guess one you were given.

Two date traps:

- The batch's `date` field is set once at placement and **does not reliably match the day a human
  associates with the order.** A batch placed 00:12 IST carries the previous UTC day. If a
  date-bound query finds nothing but you have independent reason to believe the order exists,
  search OU logs by content instead, pull `batchId` from any matched line, then query by
  `--batch-id` with no date bound at all.
- `sbiReconAllOrders` computes "today" in **UTC** while `sbiRejectedAmoOrdersIngest` computes it
  in **IST**. Between 00:00 and 05:30 IST they pick different days, and orders placed in that
  window fall outside `sbiReconAllOrders`' DB query entirely.

If you know the `brokeruserId`, a tag query needs **no date bound** — `{broker, brokeruserId}` is
a compound index, so the lookup is index-supported. The date requirement only exists when you
have neither `brokeruserId` nor `batchId`.

## Step 3 — route to the right service

**`order-updates` is the primary source for essentially everything.** broker-lib runs
*in-process* inside it (`lib/brokerApi.js:1` is a plain `require`), so the raw outbound HTTP
request and response to SBI are logged **by order-updates itself**.

| Service | Use it for | Never use it for |
|---|---|---|
| `order-updates` | placement, polling, status, raw SBI wire traffic, batch state, the fix endpoint | — |
| `platform-api` | the upstream placement call, batch-apply callbacks, `PlacedOrders` state | raw broker traffic |
| `jobs` / `jobs-recon` | recon runs, AMO poll, AutoSIP, cleanup | anything in the live order path |
| `broker-api` | login, funds, portfolio, holdings, SIP | **any order tag — guaranteed zero rows** |

`sc-integrations-broker-api` has **no `Orders.*` binding at all** and no `/orders` route
(`src/services/brokerLib.ts:120-151`). It never sees an order tag. The old
`SBI_LOG_INVESTIGATION_GUIDE.md` tells you to fetch broker-api for tags in eight separate
scenarios — every one of those instructions is wrong. (If you ever do search it: its log `name`
is `sc.service.sc-integrations-brokers-api`, **plural**.)

`sc-smallboard-be` is **not in the toolkit's `--service` registry**, so operator-attribution logs
are currently unreachable by these tools. Say so rather than implying you checked.

### Bucket routing, by date

```
EKS (recent):  s3://sc-eks-pod-logs/production/{date}/integrations/sc-integrations-order-updates-pod/
EC2 (older):   s3://sc-pm2logs-new/PROD/{date}/sc-integrations-order-updates/   --dir Out-logs
```

- `order-updates`, `broker-api` — fully migrated. EKS for recent dates, EC2/PM2 for old ones.
  Pick by date; do not try both.
- `platform-api` — **dual-running on both for every date.** Always check both, merge the results.
  Neither is a fallback for the other.
- `sc-integrations-jobs` daemon logs — EC2/PM2 only.
- `sc-integrations-jobs` **per-run** output is a different surface entirely: one gzip object per
  invocation at `s3://sc-prod-logs/sc-integrations-jobs/<jobName>_<bullJobId>`, not date
  partitioned, no `.gz` extension and no gzip metadata. Also list the `integration-jobs/` prefix —
  the prod IAM policy grants both labels.
- SBI recon CSVs — `s3://sc-integrations-sbi-attachments/{sbi_recon,mtf_recon,sbi_rejected_amo_orders}/<date>/`.
  These are broker CSV, not JSON logs. Search them with `search-s3-recon.js`, which takes repeated
  `--tag` / `--order-id` / `--exchange-order-id` flags — batch every identifier into one call.

Omitting `--dir Out-logs` on the EC2 path pulls `code-deploy-logs` and `script-logs` noise too.

## Step 4 — interpret

Load the reference file you need; do not try to hold all of this at once.

| Question | File |
|---|---|
| Is what I remember about this actually true? | `reference/00-corrections.md` — **read this first** |
| How do the pieces fit together? | `reference/01-architecture.md` |
| What does this status or error code mean? | `reference/02-status-codes.md` |
| Which bucket, which prefix, which surface? | `reference/03-log-locations.md` |
| What failure mode is this, and does it self-heal? | `reference/04-playbook.md` |
| Who changed this order? | `reference/05-provenance.md` |
| Exact flags, exit codes, output shapes, preflight | `reference/06-tooling.md` |
| Given only an identifier, what's the exact procedure? | `reference/09-routing-tree.md` |
| Is the environment actually working right now? | `reference/10-environment-preflight.md` |

Per-service deep detail — facts, greppable log strings, corrections and open questions, each with
`file:line` citations. Load only the one you need:

| Service | File |
|---|---|
| order-updates (start here for anything order-related) | `reference/services/order-updates.md` |
| broker-lib SBI cash adapter | `reference/services/broker-lib-sbi.md` |
| broker-lib SBI-MTF adapter | `reference/services/broker-lib-mtf.md` |
| jobs — recon and cleanup | `reference/services/jobs-recon.md` |
| jobs — AMO, AutoSIP, activations, scheduling | `reference/services/jobs-scheduling.md` |
| platform-api → order-updates hop | `reference/services/platform-babel-orderflow.md` |
| the Order model, enums and indexes | `reference/services/babel-order-model.md` |
| smallboard — manual operator paths | `reference/services/smallboard-provenance.md` |
| broker-api — and why it is almost never the answer | `reference/services/broker-api-path.md` |
| the toolkit scripts themselves, audited from source | `reference/services/tooling-cli.md` |

### The status enums, because getting these wrong returns zero rows

Two different enums on two different fields. Both spellings are correct; each is wrong on the
other field.

```
Order.status        (the batch)  COMPLETED   ← with a D
orders[].status     (a leg)      COMPLETE    ← no D
```

- batch: `ACKED PLACED ERROR UNPLACED PARTIALLYPLACED UNFILLED PARTIALLYFILLED COMPLETED FIXED MARKEDCOMPLETE CANCELLED`
- leg: `ACKED PLACED REJECTED CANCELLED COMPLETE ERROR "CANCELLED AMO" PARTIAL`

Query `{status:'COMPLETED'}` for batches, `{'orders.status':'COMPLETE'}` for legs.

`Order.quantity` and `Order.filled` are **leg counts, not share counts.** A partially-filled leg
contributes zero to `filled`. Reading them as shares makes every partial-fill diagnosis wrong.

## Traps that produce confidently wrong answers

1. **`sbiReconAllOrders` writes nothing without `--save`** — and logs `Batch updated successfully`
   either way, because its success test is `if (!yargs.save || res.data.success)`. Never conclude
   a batch was fixed from that line. Read the run's first line, `running job ... with params:`,
   which prints the actual yargs object, to see whether `--save` was passed.
2. **HTTP 200 from `/errors/fix/:batchId` does not mean fixed.** 200 covers both
   `msg: 'Error Batch fixed'` and `msg: 'Error Batch already fixed'` (guard bailed, wrote nothing).
   Read the `msg` field, never the status code.
3. **A hung SBI placement leaves no error line at all.** `placeOrder`, `getDealerDetails` and
   `placeDealerOrder` run with `timeout: 0` — axios waits forever. No timeout, no `ECONNABORTED`,
   just silence after the request. The 9000ms default applies only to order-status and the other calls.
4. **Missing from Mongo is not proof it never existed.** Two smallboard endpoints permanently
   `deleteOne` the Order. Check `placedOrders` for status `REVERSED` and grep order-updates for
   `Delete Batch Request receivied` (sic) and `Deleted Batch`.
5. **`meta.type` is invisible through a normal mongoose read.** It is not in any Order schema and
   survives only because one job writes with the raw driver. Only Redash / raw / `.lean()` reads
   show it. Batches carrying it also have **no `meta.updates` array at all** — an empty audit trail
   is itself the fingerprint.
6. **A job's `jobName` field does not identify the file that produced it.** `sbiUnplacedRecon.js`
   logs as `sbiDealerRecon`; `placeSbiAutosips`, `sbiActivation` and `amoPoll` are each shared by
   two or three files. Identify the producing job from the **S3 object key**, not the log field.
7. **broker-lib's `production` branch is two years stale and does not contain `sbi-mtf` at all.**
   The prod truth is the `development` branch (v16.11.15), because broker-lib ships via npm and
   consumers pin caret ranges. Reading `production` gives wrong wire codes for validity, variety,
   order keys and an empty error-message map.
8. **Only stdout reaches a job's S3 object.** stderr is dropped. Bunyan writes to stdout so
   `logger.error` is captured, but a raw `console.error` or an uncaught exception trace is not.
9. **`polling limit reached for the following batch` is normal** on the error-retry lane — those
   polls are built with `maxPollCount: 1`, so it fires every tick. The real give-up line is
   `[ERRORS] Retry limit reached`.
10. **SBI and SBI-MTF are polling-only.** `orderStatusBy: {postback:false, polling:true}` for both.
    Searching `ORDER_conciliation` for an SBI order is a dead end; search `Broker Poll Response`
    and `broker action - orderStatus` instead.

## Step 5 — report

Write to `logs/findings/`:

```
logs/findings/
  sbi_order_investigation_<YYYY-MM-DD>.md        (or _<from>_to_<to>.md for a range)
  broker-logs/<tag>.json                          one per tag, flat
```

Link artifacts from the report as `./broker-logs/<tag>.json`. Leave raw fetch output where it
landed under `logs/<date>/` and link it by its existing path.

A complete answer states: what was asked, what you searched (service, bucket, date window), what
you found with citations to specific log lines, what it means, whether it self-resolves, and what
a human should do next. Where you could not determine something, say so plainly and say what you
ruled out — a clean "not determinable, here is why" beats a confident guess every time.

## Escalate to a human only for

- An order older than the 30-day Redash lookback with no date supplied and no `batchId`.
- Operator identity beyond what Mongo holds — the `fix-error-order` Mattermost channel is the only
  record, and you have no tool to read it.
- Anything that would require a write to resolve.
- Genuinely ambiguous scope where guessing wrong wastes significant time (e.g. no identifier at
  all, just "a user's order is broken").

Everything else you work out yourself.
