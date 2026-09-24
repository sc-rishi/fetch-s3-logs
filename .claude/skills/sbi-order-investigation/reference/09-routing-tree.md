# Routing Tree — identifier to answer

The full decision procedure for every starting point an investigator can be handed. SKILL.md carries the condensed version; this is the complete tree, including the fallback chains and the rules for telling "does not exist" apart from "searched the wrong place".

_Resolved: yes. Source-verified 2026-09-23._


## Always-applies rules

Never ask for the date, the service, the bucket, or cash-vs-MTF — all four are derivable; ask only per §8.
Run the preflight (`aws sts get-caller-identity --profile smallcase`, `ls .env`) before the first search, because expired SSO and a missing .env both look exactly like "order not found".
Pivot to a batchId as early as possible: it decodes its own date locally, needs no date bound in Redash, and is immune to Order.date drift.
For a tag or orderId with no date, just omit the date flags and let auto-scope resolve it; for --text always pin --date or --from/--to, because --text never auto-scopes.
Never hand-pick EKS vs EC2 when using fetch-by-identifier.js — with --env prod it already searches both generations plus Error-logs in one run.
Never pass --service all (it expands to jobs-recon and always throws without --job-name); use an explicit comma list.
Never search broker-api for an order tag — it has no Orders binding and returns zero rows every time.
In Redash use `--match '{"broker":{"$in":["sbi","sbi-mtf"]}}'` for any sweep; `--broker sbi` silently drops every MTF batch even though logs label both "sbi".
Query batches with `{status:'COMPLETED'}` and legs with `{'orders.status':'COMPLETE'}` — the enums differ by one letter and the wrong one returns zero rows.
Before reporting an absence, read manifest.json: status must be "complete" and objects.listed must be > 0; exit 2 is inconclusive and exit 3 means "not in Mongo's last 30 days", not "does not exist".
On exit 3, recover the date from the recon CSVs (search-s3-recon.js has no date cap and the matched S3 key is the date) or from an index-prefixed brokeruserId query, before escalating.
Batch every identifier into a single search-s3-recon.js call — the flags are repeatable and become one SQL IN clause.
Never conclude a recon job fixed a batch from `Batch updated successfully`; read the run's first line, `running job ... with params:`, for the actual --save flag, and read the `msg` field rather than the HTTP status on /errors/fix.
Cite evidence from matches.jsonl with its time and s3Uri, sort by time yourself, and never copy a token, account number, client id or dealer password into a report.


## Detail

# Core decision logic

Everything below is verified against the toolkit source on branch `main` of
`/Users/rishidatta/Desktop/integrations/fetch-s3-logs` and against `sc-integrations-babel`
(`production`) and `sc-integrations-jobs` (`production`). Run every command from the repo root.

---

## 0. Preflight — once per session, before the first search

Two failures produce results that are **indistinguishable from "the order does not exist"**. Rule
them out first or every negative you report is worthless.

```bash
aws sts get-caller-identity --profile smallcase   # expired SSO -> zero objects listed, exit 0
ls .env                                           # missing -> Redash silently degrades
```

- The profile (`smallcase`) and region (`ap-south-1`) are forced in-process
  (`search-s3-logs.js:25-27`); `--region` on `fetch-s3-logs.js` is parsed and ignored.
- If `.env` lacks `REDASH_URL` / `REDASH_API_KEY` / `REDASH_DATA_SOURCE_ID`, `isConfigured()`
  returns false (`redash-query.js:216-218`), `resolveAnchorDate` returns
  `note: 'redash-not-configured'` and `runAutoSearch` **falls back to a flat latest-30-day scan
  without failing** (`search-s3-logs.js:800-803`). You get a slow scan over the wrong window and
  no error. Check the printed line `No anchor date available (redash-not-configured)` in every run.

---

## 1. Classify what you were handed

| Pattern | It is | Toolkit handle |
|---|---|---|
| `sc_` + ~9 alnum | SBI **cash** leg tag | `--tag` |
| `scmtf_` + ~9 alnum | SBI-**MTF** leg tag | `--tag` |
| 24 hex chars | `batchId` — equals `Order._id` | `--batch-id` (best identifier) |
| 12–16 digits | SBI internal `orderId` | `--order-id` |
| other numeric, from an exchange/broker report | `exchangeOrderId` | `--order-id` (matches both fields) |
| 24 hex, seen in platform-api logs / `PlacedOrders` | `correlationId` = `meta.correlationId` | Redash `--match` only |
| 24 hex, called "smallcase id" / "isc" | `iscid` | Redash `--match` only |
| 24 hex, called "user" | `userId` | Redash `--match` only |
| alphanumeric broker account id | `brokeruserId` (broker client id) | Redash `--match` only |
| prose (`"Order Rejected: ..."`) | status/error message | `--text` |
| bare integer 1–11 | raw broker `orderStatus` code | no search — read `reference/02-status-codes.md` |
| CSV row | recon row | col 9 = tag, col 4 = order_no, col 11 = exchange_order_no |

Three hard facts that govern everything below:

1. **`order._id = order.batchId`** (`sc-integrations-babel/src/models/Order.js:33` and `:110`),
   and a Mongo ObjectId's first 8 hex chars are a Unix timestamp in seconds. A batchId therefore
   **carries its own creation date with zero network calls** (`search-s3-logs.js:234-239`).
2. **The tag prefix is the only cash-vs-MTF discriminator in a log line** — both adapters stamp
   `broker: "sbi"` (`broker-lib/src/brokers/sbi-mtf/config.js:19`).
3. **In Mongo the two ARE distinct**: MTF batches store `broker: "sbi-mtf"`
   (`sc-integrations-jobs/jobs/reconciliations/sbiReconAllOrders.js:1160,1174` query
   `broker: {$in: ['sbi','sbi-mtf']}`). So `redash-query.js --broker sbi` **silently excludes every
   MTF batch**. For any sweep use `--match '{"broker":{"$in":["sbi","sbi-mtf"]}}'` instead of
   `--broker`. This is the inverse of the log-side rule and getting it backwards costs you the
   whole MTF population.

---

## 2. The spine — four moves, in this order, for every entry point

**Move 1. Get a `batchId` as fast as possible.** The guide's claim that batchId is the most
reliable identifier is correct, and the reasoning is verifiable in three separate places:

- its date is decoded locally, so it cannot be wrong or slow (`search-s3-logs.js:234-239, 757-761`);
- in Redash it hits `_id` / the indexed `batchId` field and therefore needs **no date bound** —
  `requiresDateBound()` returns false whenever `--batch-id` is present (`redash-query.js:253-255`);
- it is immune to the `date`-field drift described in §3, because no date is involved.

By contrast `--tag` / `--order-id` resolve through `orders.tag` / `unplaced.tag` / `.orderId` /
`.exchangeOrderId` (`redash-query.js:116-134`), which are unindexed fields **inside arrays**.

**Move 2. Resolve the date yourself** (§3). Never ask for it first.

**Move 3. Search `order-updates` first, always** (§4).

**Move 4. Pull the live document from Redash to complement the logs.** Logs give the sequence;
the document gives where it landed (`status`, `meta.updates`, `meta.source`, `orders[].status`).
Do both before concluding anything.

---

## 3. Deciding the date when you were not given one

### 3a. Do nothing — let auto-scope do it

`main()` routes to `runAutoSearch` whenever no `--date`/`--from`+`--to`/`--month` was passed **and**
the identifier is `--tag`, `--order-id` or `--batch-id` (`search-s3-logs.js:865-866`).

```bash
node fetch-by-identifier.js --service order-updates --batch-id 6a221fb2d963eea6efaeabfa
node fetch-by-identifier.js --service order-updates --tag sc_rXWoyJfoH
```

| Kind | Anchor mechanism | Cost | Failure mode |
|---|---|---|---|
| `--batch-id` | local ObjectId decode | instant, no network | malformed id → `note: batchId-not-a-valid-objectid` → falls back to flat 30-day scan (`:760`, `:800-803`) |
| `--tag` / `--order-id` | Redash `findOrderAnchorDate`, tried at lookback **7 → 14 → 30 days**, stopping at the first hit (`:38`, `:769-778`) | ~20s / ~24s / ~44s per tier attempted | older than 30 days → exit **3**, `not_found_in_db`, S3 never touched (`:786-799`) |

Then S3 is searched in widening tiers around the anchor, stopping at the first tier with any match
(`AUTO_SCOPE_TIERS`, `:43-48`): anchor−1..+2 (4d) → −1..+7 (9d) → −1..+15 (17d) → −1..+28 (30d).
Forward-biased on purpose: a late status update or a recon fix lands *after* placement, never
before. Each tier scans only its incremental new dates (`:812-838`); `manifest.json.tiers[]`
records exactly which ran.

### 3b. Critical: `--text` never auto-scopes

`autoScopeEligible` excludes `text` (`:865`), so a `--text` run with no date flags is a **flat
latest-30-calendar-day scan** (`buildDateList`, `:213-218`). If you know roughly when, always pin
`--text` with `--date` or `--from`/`--to`.

### 3c. An explicit date always wins

`args.dateScope` becomes `'explicit'` the moment `--date`, `--month` or `--from` is present
(`:159`), and `main()` dispatches straight to single-shot `runSearch` — no Redash call, no tiering.
Auto-scope exists for "I don't know the date", never to second-guess one you were given.

Hard caps: `--from`/`--to` ≤ 30 days (`:208-210`); a 31-day `--month` is rejected outright
(`:225-227`).

### 3d. When exit 3 (`not_found_in_db`) comes back — do NOT escalate yet

The order is simply not in the last 30 days of the `orders` collection. Two unbounded-history
recoveries exist before you need a human:

**(i) Recon CSVs have no date cap at all.** `search-s3-recon.js` lists *every* CSV under both
prefixes and S3-Selects each one (`search-s3-recon.js:39-42, 109-129`) — no date scoping anywhere
in the file. The matched object key **is** the date:

```bash
node search-s3-recon.js --tag sc_rXWoyJfoH --out ./logs/recon-probe
# match key: sbi_recon/2026-06-05/<file>.csv   -> the date, straight from the key
# row col 7 = trade_date, col 4 = order_no, col 11 = exchange_order_no, col 3 = client_id
```

Then re-run the log search pinned: `--date 2026-06-05`.

**(ii) If you know the broker client id**, query Redash unbounded via the index (§5f).

Only if both come back empty is a date genuinely unrecoverable.

### 3e. Two date traps that produce false negatives

- **`Order.date` is not the day a human associates with the order.** It is stamped once at
  placement (`_schema.js:116`, `default: Date.now`). A batch placed 00:12 IST carries the previous
  UTC day. A date-bound Redash query then misses it entirely. Recovery: search OU logs by
  *content* for the date you believe is right, lift `context.batchId` from any matched line, then
  query `--batch-id` with **no date bound at all**.
- **The recon jobs disagree about what day it is.** `sbiReconAllOrders` builds its window as a UTC
  day (`sbiReconAllOrders.js:1169-1171`, `new Date(yargs.date + 'T00:00:00.000Z')`) while
  `sbiRejectedAmoOrdersIngest` computes today in IST. Between 00:00 and 05:30 IST they pick
  different days and orders placed in that window fall outside `sbiReconAllOrders`' query.

---

## 4. Service routing — and why you almost never route buckets by hand

`--service` is mandatory and accepts `order-updates | broker-api | platform-api | jobs | jobs-recon`,
a comma list, or `all` (`search-s3-logs.js:49-67, 145-147, 164-173`).

**`fetch-by-identifier.js` already searches both hosting generations in one run.** For
`--env prod` (the default) `buildSources` emits, per app service, the EKS prefix **plus**
EC2 `Out-logs` **plus** EC2 `Error-logs` — three sources for `order-updates`
(`:269-293`; asserted in `test/search-s3-logs.test.js:92`). So the EKS-vs-EC2 rule is *already
encoded*; do not hand-pick a bucket, and do not skip a run because "that date is pre-migration".

The routing rule only matters when you drop to `fetch-s3-logs.js` for a surface the wrapper does
not cover:

```
EKS  (recent):  s3://sc-eks-pod-logs/production/{date}/integrations/sc-integrations-order-updates-pod/
EC2  (older):   s3://sc-pm2logs-new/PROD/{date}/sc-integrations-order-updates/      --dir Out-logs
platform-api:   dual-running on BOTH for every date — check both, merge, neither is a fallback
jobs daemon:    EC2/PM2 only (no eksPod entry, search-s3-logs.js:65)
```

**`--env staging` drops the EC2 sources entirely** — they are added only when `env === 'prod'`
(`:281`). A staging search is EKS-only by construction.

Order of service preference:

| Rank | Service | For |
|---|---|---|
| 1 | `order-updates` | placement, polling, raw SBI wire traffic, batch state, the fix endpoint. broker-lib runs **in-process** here. |
| 2 | `platform-api` | the upstream placement call, batch-apply, `PlacedOrders` state. Check both buckets. |
| 3 | `jobs-recon` | did a recon run touch this batch (needs `--job-name`) |
| 4 | `jobs` | AMO poll / AutoSIP / cleanup daemon logs |
| never | `broker-api` | **any order tag — guaranteed zero rows.** No `Orders.*` binding, no `/orders` route (`sc-integrations-broker-api/src/services/brokerLib.ts:120-151`). The old guide sends you here in eight scenarios; all eight are wrong. |

**`--service all` is a trap**: `all` expands to include `jobs-recon`, and validation then throws
`--service jobs-recon requires --job-name` (`:155-157`). `all` therefore **always errors** unless
you also pass `--job-name`. Use an explicit comma list instead:
`--service order-updates,platform-api`.

**`jobs-recon` is not date-partitioned.** Its source is `dated: false` with
`prefix: sc-integrations-jobs/<jobName>` (`:257-266`), so it lists *the entire prefix* — every
historical run of that job — and then filters matching **lines** by IST timestamp
(`filterLineDate`, `lineIsInScope`, `:407-413`). It is complete but slow; expect it. It also forces
gzip (`forceGzip: true`, `:264`) because those objects carry no `.gz` and no gzip metadata.

---

## 5. Entry points — first command, verbatim

Throughout: `<T>` = tag, `<B>` = batchId, `<D>` = date.

### 5a. A tag (`sc_` or `scmtf_`)

```bash
# 1. no date needed — auto-scope resolves it and searches
node fetch-by-identifier.js --service order-updates --tag <T> --out ./logs/<T>/ou

# 2. pivot to batchId from any matched line, then get live state (no date bound)
jq -r '.log.context.batchId // .log.batchId' ./logs/<T>/ou/matches.jsonl | sort -u | head
node redash-query.js --collection orders --batch-id <B> --out ./logs/<T>/order.json
```

If step 1 exits **3**: go to §3d. If it exits 0 with zero matches: go to §6.

### 5b. An internal `orderId` or an `exchangeOrderId`

Same shape — `--order-id` covers both fields on both arrays
(`orders.orderId`, `unplaced.orderId`, `orders.exchangeOrderId`, `unplaced.exchangeOrderId`,
`redash-query.js:125-134`), so you do not need to know which one you were handed.

```bash
node fetch-by-identifier.js --service order-updates --order-id <ID> --out ./logs/<ID>/ou
```

Then pivot to batchId exactly as in 5a. If nothing, try the recon CSVs — they carry the broker's
own `order_no` (col 4) and `exchange_order_no` (col 11) and reach back further than 30 days:

```bash
node search-s3-recon.js --order-id <ID> --exchange-order-id <ID> --out ./logs/<ID>/recon
```

### 5c. A `batchId` / Mongo `_id` — the best case

```bash
node redash-query.js --collection orders --batch-id <B> --out ./logs/<B>/order.json   # ~1-2s, no date bound
node fetch-by-identifier.js --service order-updates --batch-id <B> --out ./logs/<B>/ou
```

Do the Redash call **first** here: it is near-instant, and the document tells you the tags, the
legs, the broker (`sbi` vs `sbi-mtf`), and `meta.source` before you spend minutes on S3.

### 5d. An `iscid`

Not a toolkit flag. Indexed ObjectId (`_schema.js:106`), so no date bound is needed:

```bash
node redash-query.js --collection orders \
  --match '{"iscid":{"$oid":"<ISCID>"},"broker":{"$in":["sbi","sbi-mtf"]}}' --limit 20
```

That returns every batch for the smallcase; pick the one in question by `date`/`status` and
continue at 5c. Sibling batches matter: `cleanupMtfNonTerminalBatches` only force-closes a stale
MTF batch when a **newer** batch exists for the same `iscid`.

### 5e. A `correlationId`

It lives at `meta.correlationId` — indexed, unique, sparse (`_schema.js:68`), **not** top level:

```bash
node redash-query.js --collection orders --match '{"meta.correlationId":"<CID>"}'
node redash-query.js --collection placedOrders --match '{"_id":{"$oid":"<CID>"}}'
```

`correlationId` is the `PlacedOrders._id`, so the second query gives you the platform-api side of
the same event. Pivot to `batchId` and continue at 5c.

### 5f. A `userId` or a broker client id (`brokeruserId`)

`userId` is an indexed ObjectId (`_schema.js:105`); `brokeruserId` is a plain String but is the
second key of the `{broker, brokeruserId}` compound index:

```bash
# by platform user
node redash-query.js --collection orders \
  --match '{"userId":{"$oid":"<UID>"},"broker":{"$in":["sbi","sbi-mtf"]}}' --limit 50

# by broker client id — index-supported, needs NO date bound
node redash-query.js --collection orders \
  --match '{"broker":{"$in":["sbi","sbi-mtf"]},"brokeruserId":"<CLIENTID>"}' --limit 50
```

This is exactly the shape production uses: `sbiReconAllOrders.js:1159-1166` queries
`{broker: {$in:['sbi','sbi-mtf']}, brokeruserId: {$in:[...]}, $or:[{'orders.tag':...},
{'unplaced.tag':...}]}` with **no date bound at all**.

Note the CLI guard is purely syntactic — `requiresDateBound()` trips on the *flags* `--tag`/
`--order-id`, not on the query shape (`redash-query.js:253-255`). Expressing the same filter
through a bare `--match` is the sanctioned escape hatch, because `buildMatch` returns the parsed
object as-is when it is the only clause (`:106-118, 143-145`). Use it only with the
`brokeruserId`/`userId`/`iscid`/`meta.correlationId` prefix — never to run a naked unbounded tag
scan.

### 5g. A free-text error or status message

```bash
node fetch-by-identifier.js --service order-updates --text "Dealer session not found" \
  --from 2026-09-15 --to 2026-09-20 --out ./logs/text-probe
```

Matching is literal and case-insensitive: the expression is
`LOWER(s._1) LIKE '%<escaped>%' ESCAPE '!'` (`search-s3-logs.js:337-348`), with `%`, `_` and `!`
escaped for you — so paste the message verbatim, including punctuation. **Always pin a date range**
(§3b). Then lift `batchId` from the hits and continue at 5c.

### 5h. A raw broker status code (bare `4`, `11`, `5`, `7`, `8`)

Do not search for it — a bare integer matches every log line in the bucket. Read
`reference/02-status-codes.md`. Codes `5` (TRANSIT), `7` (EXPIRED) and `8` (FREEZED) are unmapped
and surface as a generic `status: 'ERROR'` with no further broker-side detail; that is the answer,
not a missing log.

### 5i. "All failures on date D"

```bash
node redash-query.js --collection orders \
  --match '{"broker":{"$in":["sbi","sbi-mtf"]},"status":"ERROR"}' \
  --from <D> --to <D> --limit 200 --out ./logs/<D>/error-batches.json
```

`--broker sbi` alone would drop every MTF batch (§1.3). `status` here is the **batch** enum, so
terminal success is `COMPLETED`; on a leg (`orders.status`) it is `COMPLETE`. Wrong one, zero rows.

Then batch the recovered tags into **one** recon call — the flags are repeatable and become a
single SQL `IN (...)` per field (`search-s3-recon.js:99-107`); 44 identifiers scanned 2,555 CSVs in
under a minute:

```bash
node search-s3-recon.js --tag <T1> --tag <T2> --tag <T3> ... --out ./logs/<D>/recon
```

### 5j. A support-ticket screenshot's worth of partial info

Take identifiers in this order of preference and stop at the first you have:
`batchId` → `correlationId`/`iscid` → tag → orderId/exchangeOrderId → brokeruserId → userId →
error text + date. Anything on that list is enough. Do not ask for more until §6 is exhausted.

### 5k. A recon CSV row

The row already carries the pivot. Columns are fixed (`search-s3-recon.js:25-38`):

```
1 buy_sell_ind  2 qty_original  3 client_id  4 order_no  5 average_price  6 security_id
7 trade_date    8 traded_qty    9 tag_or_remarks  10 status  11 exchange_order_no  12 source_flag
```

Column 9 is the tag; column 7 and the S3 key both give the date. Jump straight to a pinned search:
`--tag <col9> --date <col7>`.

Note `search-s3-recon.js` scans **only** `sbi_recon/` and `mtf_recon/` (`:39-42`). The rejected-AMO
CSVs at `sbi_rejected_amo_orders/<date>/` are **not** covered — reach them with
`fetch-s3-logs.js --s3-url s3://sc-integrations-sbi-attachments/sbi_rejected_amo_orders/<D>/
--no-filter-text`.

### 5l. Nothing but "this user's order is stuck"

Ask for exactly **one** thing and nothing else: any identifier at all — email, userId, broker
client id, tag, or a date. With a client id or userId, §5f gets you the whole batch list; with a
date, §5i does. Only a genuinely empty-handed request escalates.

---

## 6. When the first search returns nothing

Run this chain in order. Do not skip step 1 — it is what separates "does not exist" from
"searched wrong".

**Step 1 — was the run actually complete?** Read `manifest.json`:

- `status: "complete"` is set only when `objects.scanned === objects.listed` and no output error
  (`search-s3-logs.js:732`). Exit **2** / `"incomplete"` means at least one object was never
  searched — **never** read that as "not found".
- `objects.listed: 0` with `status: "complete"` means S3 returned no objects at all for those
  prefixes. That is the expired-SSO signature, not an absence of logs.
- `errors[]` entries naming `AccessDenied` / `ExpiredToken` / `CredentialsProviderError` are
  treated as fatal and abort the run (`isAuthError`, `:497-500`, `:706-708`) — a credentials
  problem shows up here, loudly, not as silence.
- Exit **3** is `not_found_in_db` — Redash, not S3. Go to §3d, not to §6.

**Step 2 — widen the window, not the service.** If auto-scope stopped at tier 4 with nothing, the
30-day cap is the binding constraint. Pin an explicit older window:
`--from <D-29> --to <D>` or `--month <YYYY-MM>`.

**Step 3 — add the sibling services.** `--service order-updates,platform-api`. If the batch never
reached broker-lib, its only trace is upstream in platform-api's apply chain. Never add
`broker-api` — it cannot match a tag.

**Step 4 — change identifier, not window.** A tag search can miss where a batchId search hits
(different fields are logged at different stages). Pivot per §2 Move 1.

**Step 5 — recon CSVs.** Unbounded history, broker-sourced, independent of our logging
(§3d(i)). A hit here proves the order reached SBI even when our logs are gone.

**Step 6 — is it deleted rather than absent?** Two smallboard endpoints permanently `deleteOne`
the Order document. Check `placedOrders` for `status: "REVERSED"`, and grep order-updates for
`Delete Batch Request receivied` (the typo is in the source) and `Deleted Batch`.

**Step 7 — only now is "does not exist" a defensible conclusion**, and only stated as: *not present
in `<services>` between `<from>` and `<to>`, run complete, N objects scanned, and not present in
the recon CSVs for the full available history*.

### Distinguishing the three failure classes at a glance

| Symptom | Diagnosis |
|---|---|
| `objects.listed: 0`, status complete | wrong prefix, wrong env, or expired SSO — **not** absence |
| status `incomplete` / exit 2 | partial scan — inconclusive, re-run |
| exit 3 `not_found_in_db` | not in Mongo's last 30 days — S3 was never touched |
| `No anchor date available (redash-not-configured)` in stdout | `.env` missing; the window searched was arbitrary |
| complete, listed > 0, matched 0, across two services and the recon CSVs | genuine absence |

---

## 7. When to stop, and what a complete answer looks like

Stop when you can state all five of these, or state precisely which one you cannot:

1. **What the order is** — batchId, tags, broker (`sbi` vs `sbi-mtf`), date, current batch status
   and per-leg statuses.
2. **What happened**, as an ordered sequence of cited log lines (each with its `time` and `s3Uri`
   from `matches.jsonl`).
3. **Why** — the specific failure, mapped to a status/error code, not a paraphrase.
4. **Whether it self-resolves** — which job, if any, would touch it, and whether that job actually
   ran and actually wrote.
5. **What a human should do next.**

Two verification rules before you commit to (4):

- `sbiReconAllOrders` gates its fix POST on `--save` yet logs `Batch updated successfully` either
  way. Read the run's first line, `running job sbiReconAllOrders with params: {...}`, which prints
  the parsed yargs verbatim — that is the only proof a write happened.
- HTTP 200 from `/errors/fix/:batchId` covers both `msg: 'Error Batch fixed'` and
  `msg: 'Error Batch already fixed'` (wrote nothing). Read `msg`, never the status code.

Output layout:

```
logs/findings/sbi_order_investigation_<YYYY-MM-DD>.md     (or _<from>_to_<to>.md)
logs/findings/broker-logs/<tag>.json                      one per tag, flat
```

Prefer `matches.jsonl` as evidence (valid JSON Lines, carries `s3Uri`, `surface`, `time`).
`all-logs.filtered.log` is pretty-printed objects with trailing commas and no `[...]` wrapper — not
`JSON.parse`-able whole. Output order is concurrent-completion order, not chronological: sort by
`time` yourself.

**Never copy a credential into the report.** SBI logs carry `Authorization: Bearer <token>`,
`tradingAccountNumber`, `depositoryAccountNumber`, `clientId` and, on the dealer-details call, the
dealer's plaintext password. You will see them; cite the line by `trace.id`/`transaction.id`
instead of quoting it.

---

## 8. Escalate to a human only for these four

1. **A write.** Any fix, any `--save`, any `POST /errors/fix/:batchId`. Recommend it; never do it.
2. **A date that cannot be recovered** — exit 3 *and* zero recon-CSV hits *and* no brokeruserId.
   Ask for a date or a batchId, naming both, and say what you already tried.
3. **Operator identity** beyond what Mongo holds. `sc-smallboard-be` is not in the `--service`
   registry (`search-s3-logs.js:49-67`), so its `REQUEST_LOG`/`RESPONSE_LOG` attribution trail is
   genuinely unreachable by these tools. Say that plainly rather than implying you checked.
4. **No identifier of any kind** — not a tag, batchId, user, client id, or date.

Everything else you work out. In particular, do **not** ask for: the date (§3), which service
(§4), which bucket or hosting generation (§4 — the wrapper covers both), cash vs MTF (the tag
prefix says), or whether the order "really exists" before running §6.


## Evidence (31)

- fetch-by-identifier.js is a 7-line shim over search-s3-logs.js's cli(); all real logic is in search-s3-logs.js  
  `fetch-s3-logs/fetch-by-identifier.js:1-7`
- Exactly one of --tag/--order-id/--batch-id/--text is required, and --service is mandatory with no default  
  `fetch-s3-logs/search-s3-logs.js:140-153`
- Valid services are order-updates, broker-api, platform-api, jobs, jobs-recon (plus the literal 'all')  
  `fetch-s3-logs/search-s3-logs.js:49-67`
- --service all expands to include jobs-recon, which then throws unless --job-name is also passed — so 'all' always errors without --job-name  
  `fetch-s3-logs/search-s3-logs.js:154-157, 164-173`
- For --env prod, each app service emits three sources: the EKS prefix plus EC2 Out-logs plus EC2 Error-logs; EC2 sources are added only when env==='prod', so --env staging is EKS-only  
  `fetch-s3-logs/search-s3-logs.js:269-293; asserted in fetch-s3-logs/test/search-s3-logs.test.js:91-99`
- jobs has no eksPod entry, so it is EC2/PM2 only  
  `fetch-s3-logs/search-s3-logs.js:65, 275-280`
- jobs-recon is not date-partitioned: dated:false with prefix sc-integrations-jobs/<jobName>, forceGzip true, and per-line IST date filtering instead  
  `fetch-s3-logs/search-s3-logs.js:257-266, 311-323, 407-413`
- A batchId is the Order document's _id, so the Mongo ObjectId's first 8 hex chars decode to its creation date with zero network calls  
  `fetch-s3-logs/search-s3-logs.js:231-239; sc-integrations-babel/src/models/Order.js:33, 110`
- Auto-scope applies only when no explicit date was given AND the identifier is tag/orderId/batchId — --text is excluded and falls back to a flat latest-30-day window  
  `fetch-s3-logs/search-s3-logs.js:159, 213-218, 865-866`
- The Redash anchor lookup is tiered at 7, then 14, then 30 days, stopping at the first tier that returns a match  
  `fetch-s3-logs/search-s3-logs.js:33-38, 757-780; fetch-s3-logs/redash-query.js:220-247`
- S3 auto-scope tiers are anchor-1..+2, -1..+7, -1..+15, -1..+28, forward-biased, stopping at the first tier with a match  
  `fetch-s3-logs/search-s3-logs.js:39-48, 812-838`
- If all three Redash tiers find nothing, the run exits 3 with status not_found_in_db and never touches S3  
  `fetch-s3-logs/search-s3-logs.js:786-799`
- If Redash is unconfigured or the batch-id is malformed, the run silently degrades to a flat 30-day S3 scan and prints 'No anchor date available (<note>)'  
  `fetch-s3-logs/search-s3-logs.js:760, 800-803; fetch-s3-logs/redash-query.js:216-218, 233`
- manifest.status is 'complete' only when objects.scanned === objects.listed and no output error occurred; otherwise the run exits 2 and must not be read as 'not found'  
  `fetch-s3-logs/search-s3-logs.js:728-746`
- AccessDenied/ExpiredToken/CredentialsProviderError are treated as fatal, abort the run and are recorded in manifest.errors — so a credentials failure is visible, not silent  
  `fetch-s3-logs/search-s3-logs.js:497-500, 545-552, 697-709`
- The S3 Select predicate is a literal, case-insensitive LIKE with %, _ and ! escaped, so a free-text message can be pasted verbatim  
  `fetch-s3-logs/search-s3-logs.js:337-348`
- --from/--to is capped at 30 days and a 31-day --month is rejected  
  `fetch-s3-logs/search-s3-logs.js:201-229`
- redash-query --tag matches orders.tag OR unplaced.tag; --order-id matches orderId and exchangeOrderId on both arrays; --batch-id matches batchId OR _id as an ObjectId  
  `fetch-s3-logs/redash-query.js:116-134`
- requiresDateBound() trips only on the --tag/--order-id flags without --batch-id; a bare --match with an index-prefixed shape bypasses it legitimately, because buildMatch returns a lone clause as-is  
  `fetch-s3-logs/redash-query.js:106-118, 143-145, 253-255, 267-273`
- The {broker, brokeruserId} + tag, no-date query shape is exactly what production recon uses  
  `sc-integrations-jobs/jobs/reconciliations/sbiReconAllOrders.js:1159-1166`
- MTF batches store broker:'sbi-mtf' in Mongo, so redash-query --broker sbi silently excludes every MTF batch — the inverse of the log-side rule where both adapters log broker:'sbi'  
  `sc-integrations-jobs/jobs/reconciliations/sbiReconAllOrders.js:1160, 1174; sc-integrations-broker-lib/src/brokers/sbi-mtf/config.js:19`
- sbiReconAllOrders builds its DB window as a UTC day  
  `sc-integrations-jobs/jobs/reconciliations/sbiReconAllOrders.js:1169-1176`
- correlationId lives at meta.correlationId and is indexed, unique and sparse; iscid and userId are indexed ObjectIds; brokeruserId is a top-level String  
  `sc-integrations-babel/src/models/_schema.js:68, 104-109`
- Leg fields (tag, orderId, exchangeOrderId, status, statusMessage, filledQuantity) live inside the orders[]/unplaced[] subdocuments, not at batch level  
  `sc-integrations-babel/src/models/_schema.js:32-62, 104-133`
- search-s3-recon.js scans only sbi_recon/ and mtf_recon/, has no date scoping of any kind, and its repeatable flags become one SQL IN(...) per field  
  `fetch-s3-logs/search-s3-recon.js:39-42, 65-107, 109-129`
- The recon CSV column order is fixed: 3=client_id, 4=order_no, 7=trade_date, 9=tag_or_remarks, 11=exchange_order_no  
  `fetch-s3-logs/search-s3-recon.js:25-38`
- fetch-s3-logs.js ships hardcoded development scratch DEFAULTS — FILTER_TEXT 'sc_rXWoyJfoH', DATE '2026-06-05', an EC2 order-updates S3_URL and no DIR — which apply silently whenever the matching flag is omitted  
  `fetch-s3-logs/fetch-s3-logs.js:57, 66-108, 913-960`
- AWS profile 'smallcase' and region ap-south-1 are forced in-process by the search scripts  
  `fetch-s3-logs/search-s3-logs.js:25-27; fetch-s3-logs/search-s3-recon.js:18-20`
- matches.jsonl is valid JSON Lines carrying s3Uri, surface, object and log timestamps; all-logs.filtered.log is pretty-printed objects with trailing commas and no array wrapper  
  `fetch-s3-logs/search-s3-logs.js:567-599`
- sc-integrations-broker-api has no Orders.* binding and no /orders route, so any tag search against it returns zero rows  
  `fetch-s3-logs/.claude/skills/sbi-order-investigation/reference/00-corrections.md:14-28 citing sc-integrations-broker-api/src/services/brokerLib.ts:120-151`
- Branches at time of reading: fetch-s3-logs main, broker-lib development, order-updates/jobs/platform-api/smallboard-be/babel production, leprechaun rebalance-in-amo, mindmap master  
  `git -C <repo> rev-parse --abbrev-ref HEAD, run 2026-09-23 across all nine checkouts`


## Still unknown (6)

Report these as unknown rather than guessing.

- Whether the Redash Mongo data source accepts {"$oid": ...} extended JSON for fields other than _id (iscid, userId). buildMatch uses it for _id only (redash-query.js:120); the iscid/userId --match examples in §5d/§5f are constructed by analogy and were NOT executed against Redash. If they return zero rows, retry with the bare 24-hex string.
- The users-collection field name for looking a person up by email was not verified — no example in redash-query.js and the users schema was not read. §5l deliberately avoids depending on it.
- The empirical Redash tier timings (7d~20s, 14d~24s, 30d~44s, 60d+ unreliable) are code comments (redash-query.js:225-230, search-s3-logs.js:33-37), not measurements taken during this pass.
- No command in this tree was executed — AWS SSO state and Redash reachability were not tested in this session. Flags, exit codes, tiers and prefixes are read from source; wall-clock behaviour is not re-verified.
- The auto-scope tier loop calls fs.rmSync on the tier dir in both branches of its terminating if (search-s3-logs.js:832-838), which is harmless but means a failed tier leaves no artefact to inspect. Not confirmed whether this ever loses evidence in practice.
- Whether the EKS prefix for staging order-updates is populated at all (buildSources emits it, but no listing was performed).
