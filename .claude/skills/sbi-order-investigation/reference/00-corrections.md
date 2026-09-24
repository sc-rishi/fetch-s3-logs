# Corrections — read this first

`SBI_LOG_INVESTIGATION_GUIDE.md` in the repo root was built by an earlier research pass that did
**not** have these repos checked out locally. A second pass on 2026-09-23 read the actual source
and found 108 provable corrections.

Below are the ones that change what you do. The rest live in the `## Corrections` section of each
file under `reference/services/`.

Where the guide and the source disagree, **the source wins.**

---

## Round 2 — corrections to THIS SKILL, not just the old guide

An adversarial verifier checked `order-updates`'s critical facts on 2026-09-25 and refuted 6 of
them — two of which are already shipped in `SKILL.md` and `01-architecture.md`. Read these before
trusting either file on batch-finalization timing or the Redis/broker-api claims.

### R1. Not every SBI batch self-finalizes ~75s after placement — only MARKET batches do

`SKILL.md` and `01-architecture.md` both implied SBI batches force-finalize quickly on the last
poll. **True only when `hasDayOrder` is false** (MARKET batches, or any batch where
`order.validity` was left undefined). The predicate is
`!hasDayOrder && pollCount === 1 && orderStatusMethodsAllowed.polling && !orderStatusMethodsAllowed.postback`
(`order-updates/services/orders.js:3802-3804`).

The catch: **for an SBI *LIMIT* batch on the production broker-lib artifact (16.11.15),
`limitBatchConfig.default.validity` is `'DAY'`, not `'IOC'`.** Every leg is DAY validity,
`hasDayOrder` is true, the fast-finalize branch never runs, and the batch is instead carried by
the **day queue** — 30 polls × 10 min, roughly **5 hours** — after which it simply stops being
polled with its bits still set. No log line marks this stop.

The `'IOC'` value existed only in the pre-release `16.11.13-rebalance-in-amo.1` build installed in
this checkout's `node_modules`; it is **not** what production runs. This is a second, narrower
instance of the branch-vs-node_modules hazard already documented in `01-architecture.md`'s
"Version hazard" section — diffing `development` (what package-lock pins) against the installed
copy shows exactly two differences in `sbi/config.js`, and this line is one of them.

`sc-integrations-broker-lib` (branch `development`, v16.11.15) `src/brokers/sbi/config.js:137-139`;
`sc-integrations-order-updates/services/orders.js:1222-1229,3802-3804`

**Practical rule:** before telling anyone an SBI batch "should have finalized by now," check
whether it was a LIMIT or MARKET order. A stuck LIMIT batch past its ~5h day-queue window with no
terminal status is the real "silently stopped polling" case — not a 75-second one.

### R2. order-updates *does* have one legitimate HTTP client aimed at broker-api

`01-architecture.md` says "broker-api is not on this path" and that's still true for order
*placement and status* — but it is not quite "no reference anywhere." `services/brokerAsService.js`
makes real HTTP calls to `sc-integrations-broker-api` (prod base URL
`https://scb.prod.smallcase.com`, auth via `x-domain-token` / `BROKER_AS_SERVICE_SECRET`), used
**only** by `services/rebalanceSipService.js` for two endpoints:
`/api/v1/sip/rebalanceSip` and `/api/v1/sip/rebalanceSip/delete`.

This does not change the routing rule for order tags (broker-api still never sees one) — it only
matters if you are specifically chasing an SBI **rebalance-SIP** problem, in which case broker-api
logs around those two endpoints are worth pulling.

`order-updates/services/brokerAsService.js:1-27,52`; `services/rebalanceSipService.js:3,7`

### R3. Redis cleanup does NOT run when a batch finalizes in ERROR — this is good news

Claimed: cleanup runs on every FINAL save. **Actually:** `redisCleanup` runs on a FINAL save
**only when `savedFinalBatch.errorStatus` is falsy** — a batch that finalizes in ERROR **skips
cleanup entirely**, so its Redis hashes survive.

**This means for a stuck-in-ERROR SBI batch, `BB:order:sbi:<tag>` is still readable** for the last
state the broker reported, even after the batch is "done." Also runs on error-fix success and on
`deleteBatch`.

`order-updates/services/orders.js:3444-3454`; `services/errors.js:501-507`; `services/orders.js:1953`

### R4. `BB:lock:<batchId>`'s 7-day-TTL citation was wrong — same fact, right location

The mechanism and consequence are correct (a batch whose lock was already consumed cannot be
re-finalized by the normal path), but the citation pointed at an unrelated autosip helper.
Corrected: `setLockForBatch` is at `order-updates/lib/utils.js:545-547`. Claimed elsewhere it
was `:744-746` — that line is inside `getAutoSipStockExtraDetails` and has nothing to do with the
batch lock.

### R5. `markOrderUnplaced` has two escape hatches the shipped facts skip

Stated unconditionally elsewhere as "sets leg status='ERROR', deletes orderId." Two branches
change that:

- if the leg is fully netted, it returns **early** via `markOrderNettedComplete` and is never set
  to ERROR at all (`errors.js:414-416`).
- if `nettedOffQuantity > 0`, the ERROR status just set is **overridden** to `PARTIAL` with
  `filledQuantity = nettedOffQuantity` (`errors.js:429-433`).

`order-updates/services/errors.js:411-437`

### R6. `fixBy: 'none'` is not a safe no-op — it silently falls through to real triage

`FIXBY.NONE` is the number `0`, which is falsy, so `FIXBY[options.fixBy?.toUpperCase()] ||
triageErrorBatch(batch)` discards it and runs triage instead. `01-architecture.md` already
documents this as "a live bug, harmless for SBI only by coincidence" — this verification confirms
it and adds the practical danger: **on any POLLING broker other than SBI, `fixBy: 'none'` performs
live broker polls and can write.** Do not assume `'none'` is inert for a broker you have not checked.

### Nine additional findings surfaced during verification, not in the original extract

- **A third silent finalization abort exists**, beyond the two already documented:
  `orders.js:3330-3331` bails via `canFinalizeBatch` before the lock is even claimed, and **logs
  nothing on the success path**. Combined with R4 and the existing "redis contains null elements"
  / "Batch update lock did not exist" lines, there are now three distinct greppable explanations
  for a batch stuck pre-FINAL.
- **SBI autosip/activated batches can skip polling entirely, silently.** Before the queue-selection
  logic, an earlier guard fires on `label === AUTOSIP || activated || batch.autoSip`, logs
  `Batch polling skipped`, and returns — no poll queue of any kind was ever entered. A stuck SBI
  autosip batch may never have been a broker or queue failure; check this line first.
  `order-updates/services/orders.js:1208-1217`
- **Two new greppable strings for a batch stuck mid-save:** `'Order still in ACKED state.
  BatchId: <id>'` (babel's `saveFinalOrder` retries up to 5 times with backoff, then gives up) and
  `'Order not found. BatchId: <id>'` (from `savePlacedOrder`). `sc-integrations-babel/src/models/Order.js:84-95,48-51,80-83`
- **"Malformed order update" has two distinct emitters with different meanings** —
  `orders.js:1491-1494` (`logError`, fires on a missing tag/orderKey or an unknown broker name)
  vs. `:1508-1511` (a different check, different level). Same searchable phrase, two root causes.
- **A `fixBy: 'orderbook'` request against SBI with no tradebook does not fail cleanly — it becomes
  a retry loop.** `getOrderBook` throws `'order book api not supported by this broker'`,
  `fixBatchByOrderBook` catches it and logs `'Error fetching tradebook'`, and the batch is
  rescheduled for the full ~6.6h retry cycle rather than erroring immediately.
  `order-updates/services/errors.js:296-304,472-477,523-527`
- **The `type` field inventory is incomplete.** Also present: `MONGOOSE_DEBUG`
  (`connections/mongo.js:4`), `BABEL_LOGS` (`connections/redis.js:8`), and a second
  `APPLICATION_LOGS` emitter in `lib/poll.js:47` that is a *separate* stringified logger
  (`getStringifiedLogger`) from the main `jsonLogger`. Filtering on only the documented five types
  drops Mongo/Redis driver output and the poll-queue lines — exactly the lines you want when a
  batch is stuck on the queue rather than at the broker.
- **SBI and SBI-MTF `statusMessageMap` regexes differ, so identical broker rejection text can
  classify to a different `errorCode` on each broker.** Already partly covered in
  `02-status-codes.md`'s divergence list (6 vs 10 keys) — this confirms the practical
  consequence: the same "Order Rejected" text can be `otherError` on cash and something more
  specific on MTF, or vice versa. Check the broker before trusting a classified `errorCode`
  across brokers.
- The narrow node_modules-vs-production divergence in broker-lib is now mapped exactly to **two**
  config lines (`rebalanceInAMOEnabled` and the LIMIT validity in R1) — every other broker-lib SBI
  fact already shipped is confirmed safe as production truth.

### R7. `gap:failure-mode-catalogue` spot-checked the playbook instead of rewriting it

Rather than re-deriving the catalogue from scratch, this pass read `04-playbook.md` in full,
spot-checked its highest-risk claims directly against source, found all of them accurate, and made
two additive, source-cited edits to that same file — recorded here because they close real gaps
the original build had:

- **The full `SCBAT*` catalogue.** Only `SCBAT0002`/`SCBAT0003` were previously documented.
  The complete enum (`sc-platform-api/lib/exceptions/batch.js:1-58`) is `SCBAT0001` BatchNotFound,
  `0002` PlacedOrderNotFound, `0003` InconsistentOrderState, `0004` FailedToArchive, `0005`
  IscidInPlacedStatus, `0007` RetryOrderExecution — **`SCBAT0006` does not exist at all**, not
  merely unused. `SCBAT0003` is also thrown from a second, unrelated gate in
  `smallboard.service.js:1655` with a synthetic `correlationId: 'RDOIOS_0001'` — do not assume
  every `SCBAT0003` traces back to `markPlacedOrderCompleted`. Now in scenario 10 of
  `04-playbook.md`.
- **Cash and MTF have different funds-shortfall math, not just different config.** SBI cash's
  `fund.js:181-287` has a `rebalanceBasketFlag`-gated fallback that retries at T1 settlement using
  `minRequiredFunds` (`config.dpCharges`, `config.nextDayBufferWithClosePrice`). **SBI-MTF's
  `fund.js` has no equivalent branch at all** — its funds-hold call is one-shot. Neither adapter
  logs anything distinguishing which path ran. This is a silent behavioural difference with no
  discriminating log line — exactly the kind of trap this skill exists to catch, and it was not
  previously called out anywhere. Now split into playbook scenarios 5 (shared shortfall
  mechanics + this divergence) and 5b (the pre-existing MTF-specific margin content, unchanged).

Also newly confirmed, not previously stated together: `NRI_STRING_TO_CODE` (`{NRE:3, NRO:2}`) as
a per-order override via `options.nri` exists in SBI cash's `order.js`/`fund.js` and is **entirely
absent** from SBI-MTF's — MTF always uses the token's raw `nriFlag`, ignoring any per-order
override.

**Verification note:** this pass explicitly did not re-read all 14 playbook scenarios line-by-line
— it spot-checked the highest-stakes ones (triage/`FIXBY.NONE`, the `markPlacedOrderCompleted`
stall, shortfall mapping, the `timeout:0` placement calls, the SCBAT codes, the NRI override, the
cash funds fallback) against source and found no contradictions. The remainder carry their
original citations from the first build and have not been independently re-verified.

---

## 1. The guide sends you to the wrong service, in eight places

The guide says *"Fetch: `sc-integrations-broker-api`, `--filter-text "<tag>"`"* in scenarios 4.1,
4.2, 4.3, 4.4, 4.5, 4.6, 4.8 and 4.9.

**Every one of those searches returns zero rows.** `sc-integrations-broker-api` has no `Orders.*`
binding at all and no `/orders` route; grepping the whole repo for `tag` returns only AES-GCM
auth-tag handling. It never sees an order tag.

Use `order-updates` instead — broker-lib runs in-process there, so the raw SBI wire traffic is
logged by order-updates itself.

`sc-integrations-broker-api/src/services/brokerLib.ts:120-151`

The guide is self-contradictory here: its own §1.2 correctly says broker-api is not on the SBI path.

---

## 2. `sbiReconAllOrders` writes nothing without `--save` — and says it did anyway

The guide states: *"Always writes (no dry-run flag on the fix call itself)."*

**Flatly wrong, and the most dangerous error in the document.** The fix POST is gated:

```js
let res = {}; if (yargs.save) { res = await axios.post(url, body, {...}) }
```

…and the success test is `if (!yargs.save || (res && res.data && res.data.success))`, so the job
logs **`Batch updated successfully` even when it wrote nothing at all.**

An investigator following the guide concludes a batch was fixed when it was not. This gate is
original to the job's first commit, not a recent change.

To know what actually ran, read the run's first line — `running job sbiReconAllOrders with
params: {...}` — which prints the parsed yargs object verbatim.

`jobs/reconciliations/sbiReconAllOrders.js:592-614`

(`sbiDealerRecon.js` and `sbiUnplacedRecon.js` have **no** `--save` gate and always POST.)

---

## 3. COMPLETE vs COMPLETED — resolved, and they are not the same concept

The guide flags this as an unresolved inconsistency. It is neither inconsistent nor unresolved:
they are two distinct enums on two distinct fields.

```
Order.status       (batch)  terminal success = COMPLETED
orders[].status    (leg)    terminal success = COMPLETE
```

Using the wrong one on the wrong field returns zero rows. Full enums are in `02-status-codes.md`.

`sc-integrations-babel/src/constants/order.js:19-32` and `:58-67`

---

## 4. `meta.updates` CAN identify a writer

The guide's §5 headline says it never can. That is true only of the four strings the model itself
emits (`Order saved initially/with/finally...`, `Auto order saved with status...`).

A whole class of jobs bypasses `saveOrder` and pushes identity-bearing text directly —
`Marked MARKEDCOMPLETE by cleanup job cleanupMtfNonTerminalBatches...`,
`forcePlaced: status changed from <x> to PLACED via triggerManualPoll`, and others.

**If the text is not one of the four templates, it names its own writer. Read it first.**

The guide even quotes the cleanup-job string in §4 while denying the category exists in §5.

---

## 5. Human identity is not Mattermost-only

The guide says the document and logs cannot tell you who fixed an order, and to check Mattermost.
Four persisted, queryable sources exist: `supportRequests.openedBy`,
`brokerAutoReconPendingApprovals.actionedBy` (an email), smallboard's `DUMMY_ORDER_AUDIT` log, and
its universal `REQUEST_LOG`/`RESPONSE_LOG` middleware, which stamps `user.email` plus the full
request body on **every** authenticated call.

Caveat: the two strongest sources are smallboard logs, and smallboard is **not in the toolkit's
`--service` registry** — currently unreachable. See `05-provenance.md`.

---

## 6. HTTP 200 from `/errors/fix/:batchId` does not mean fixed

200 covers both `msg: 'Error Batch fixed'` and `msg: 'Error Batch already fixed'` (guard bailed,
nothing written). **Read the `msg` field, never the status code.**

`order-updates/services/errors.js:107-123, 523-530`

---

## 7. SBI's fix mechanism is not really "NONE"

`triageErrorBatch` does return `FIXBY.NONE` for `sbi` — but triage is only consulted when the
caller omits `fixBy`:

```js
const fixBy = FIXBY[options.fixBy && options.fixBy.toUpperCase()] || triageErrorBatch(batch)
```

Every real SBI recon job passes `fixBy: 'orderbook'` explicitly, so SBI batches **are** fixed.
"NONE" describes only the unattended retry-queue default path.

Also: `tradebook` is **not** a fixBy mode — it is a separate body parameter, and the only way SBI
can be fixed at all, since SBI has no `Orders.list` endpoint.

`order-updates/services/errors.js:118-119, 126-160`

---

## 8. broker-lib's `production` branch is two years stale and has no `sbi-mtf`

`origin/production` last moved 2024-09-25 at v15.22.0 and **does not contain
`src/brokers/sbi-mtf/` at all**. broker-lib ships via npm; consumers pin `^16.11.x`, matching the
`development` branch.

Reading `production` gives wrong validity codes (DAY:0/IOC:1 instead of DAY:1/IOC:2), wrong variety
casing, `getOrderKey` returning `orderId` instead of `tag`, and a **completely empty**
`statusMessageMap` so every error classifies as `otherError`.

**For SBI, `development` is the prod truth.** Run `git rev-parse --abbrev-ref HEAD`; never assume.

---

## 9. A hung placement leaves no error line at all

`placeOrder`, `getDealerDetails` and `placeDealerOrder` are forced to `timeout: 0` — axios waits
indefinitely. No timeout, no `ECONNABORTED`, no log. Just silence after the request.

The 9000ms figure applies only to order-status and the other calls.

`broker-lib/src/brokers/sbi/services/request.js:106,114-116`

---

## 10. Credentials are logged in full

Redaction is **key-name-only**, and SBI's key names are not on the blacklist. Verified by executing
the logger against the SBI config: full `Authorization: Bearer <token>`, `X-IP-ADDRESS`,
`tradingAccountNumber`, `depositoryAccountNumber`, `depositoryCode`, `clientId`, and on the
dealer-details call the dealer's **plaintext login password**.

You will see these. Never copy them anywhere.

`broker-lib/src/lib/log.js:3-46`

---

## 11. The shortfallFlag dead end is not a dead end

The guide says an unrecognised `shortfallFlag` value "is never logged" and the raw body is the only
hope. The raw body **is** logged, unconditionally, on every successful SBI call:

```
grep msg == 'sending success response'
read details.responseBody.result.shortfallDetails.shortfallFlag
```

`broker-lib/src/brokers/sbi/services/request.js:160-163`

---

## 12. `Order.quantity` and `Order.filled` are leg counts, not share counts

`quantity` is the number of stocks in the basket. `filled` increments once per **fully** filled
leg — a partially filled leg contributes zero. The share-level total is computed as `totalFilled`
and never persisted.

Reading these as shares makes every partial-fill diagnosis wrong.

---

## 13. SBI-MTF legs store `product: 'EMARGIN'`, not `'MTF'`

The babel product enum is `[CNC, NRML, EMARGIN]` and has no `MTF` value, so a leg with
`product: 'MTF'` cannot be saved through that model. (sc-babel v18.x is the exception and does
include `MTF`.) Query `product ∈ {EMARGIN, MTF}` to be safe.

---

## 14. An order missing from Mongo may have been deleted

Two smallboard endpoints permanently `deleteOne` the Order document. Absence is not proof of
never-existed. Check `placedOrders` for status `REVERSED` and grep order-updates for
`Delete Batch Request receivied` (typo is in the source) and `Deleted Batch`.

---

## 15. The unbounded-Redash-query refusal is over-broad

The guide presents "tag and orderId are unindexed, so always require a date bound" as absolute.
The unindexed claim is right; the conclusion is not. `{broker, brokeruserId}` is a compound index,
so a tag query prefixed by it is index-supported and needs **no date bound** — this is exactly the
pattern the rejected-AMO ingest job uses in production.

The date requirement only applies when you have neither `brokeruserId` nor `batchId`.

---

## 16. `meta.type` is invisible through a normal mongoose read

It is **not declared in any of the three Order schemas**. It survives only because
`sbiReconBatchCreation` writes with the raw driver, bypassing mongoose validation. Consequences:
it shows only in Redash / raw / `.lean()` reads, and batches carrying it have **no `meta.updates`
array at all** — an empty audit trail is itself the fingerprint.

---

## 17. The "quiet path" can only ever set ERROR

The guide says it can force "ERROR (or whatever status)". A Joi allowlist permits **only** `status`,
and only the literal value `ERROR`, and only when the batch's current status is one of
`PLACED` / `PARTIALLYPLACED` / `ACKED`.

`order-updates/lib/utils.js:887-926`, `services/orders.js:2173-2197`

---

## 18. A job's `jobName` does not identify the file that produced it

`sbiUnplacedRecon.js` logs as `sbiDealerRecon`. `placeSbiAutosips`, `sbiActivation` and `amoPoll`
are each shared by two or three files. **Identify the job from the S3 object key.**

---

## 19. The recon jobs disagree about what day it is

`sbiReconAllOrders` computes "today" in **UTC**; `sbiRejectedAmoOrdersIngest` computes it in **IST**.
Between 00:00 and 05:30 IST they pick different days, and `sbiReconAllOrders` builds its DB window
as a UTC day — so SBI orders placed in that window fall outside it entirely.

---

## 20. `batchId` and `correlationId` are minted in the opposite places from what the guide says

- `batchId` is minted in **order-updates** (`new mongoose.Types.ObjectId()`), not downstream by
  `smallcaseOrderFlow` — babel only reads it off the response.
- `correlationId` is minted **inside** the babel package platform-api calls (it is the
  `PlacedOrders._id`), not upstream of platform-api.

And `smallcaseOrderFlow` is not an opaque external package — it is plain source at
`sc-platform-babel/others/smallcaseOrderFlow.js`, 838 lines.

---

## Also worth knowing

- `sc-integrations-broker-api`'s log `name` is `sc.service.sc-integrations-brokers-api` — **plural**,
  while its S3 path is singular.
- Only **stdout** reaches a job's S3 object; stderr is dropped.
- `polling limit reached for the following batch` is **normal** on the error-retry lane; the real
  give-up line is `[ERRORS] Retry limit reached`.
- `POST /errors/fix/:batchId` has **no authentication** and also accepts GET.
- Three different packages register an `Order` model over the same collection with different
  schemas, different save state machines and different lookup keys.
- `mongoose.set('autoIndex', false)` means declared indexes create nothing at runtime — the
  declared list is intent, not a guarantee.
- The error-retry backoff is **6.5 hours** over 34 attempts, not the "~6 hours" the in-repo doc says.

---

## Citation drift

Several of the guide's `file:line` citations no longer resolve — the guide was written against a
different tree. Examples: `statusMessageMap` is at `sbi/config.js:176-184`, not `:170-178`;
`generateTag` is at `:109-113`, not `:114`; `cleanupMtfNonTerminalBatches.js` is in `jobs/cleanup/`,
not `jobs/sanity/`.

**Re-verify any line citation against the checked-out SHA before quoting it.**

---

## Coverage of this research pass

Built across three workflow launches on the same run id (`wf_467d8a1e-892`): an initial 27-agent
parallel run on 2026-09-23 (cut short by an account spend limit at 9/27), and two sequential
resumes on 2026-09-23 to 09-24 that ran the remaining agents one at a time so a limit hit would
only cost its current step. The user paused the run twice — at 4/18 and again at 5/18 — to resume
once usage resets. What that means for how much you should trust this:

**Fully researched** — a dedicated agent read the source and produced cited facts:
order-updates (extract **and** adversarially verified), broker-lib SBI, broker-lib SBI-MTF,
jobs (recon), jobs (scheduling/AMO/AutoSIP), sc-integrations-babel Order model, sc-platform-babel
smallcaseOrderFlow, sc-smallboard-be, sc-integrations-broker-api, the `fetch-s3-logs` toolkit
itself (line-by-line, not just `--help`). That is 729+86 facts, 795+63 grep targets, and
108+11 corrections, plus 6 refutations and 9 additional findings from the order-updates
verification pass and a further spot-check pass over the playbook itself (both folded into
"Round 2" above, R1-R7).

**Also done:** the identifier-routing-tree, environment-readiness, and failure-mode-catalogue gap
investigations (`09-routing-tree.md`, `10-environment-preflight.md`, and two additive edits to
`04-playbook.md` — the full `SCBAT*` catalogue and the cash-vs-MTF funds-shortfall split, see R7).

**Not researched — treat as inherited from the old guide and unverified:**

- `sc-platform-api` internals. Its batch-apply and PlacedOrders facts here come from the old guide,
  what the babel and smallboard agents saw from outside, and a handful of spot-checks made in
  passing during the failure-mode-catalogue pass (SCBAT catalogue, `markPlacedOrderCompleted`) —
  not a dedicated read of the repo.
- `sc-integrations-leprechaun` (the staging mock).
- `sc-mindmap` cross-check, beyond the one broker-api contradiction which was settled directly.

**Not run at all — paused before these reached the front of the queue:**
adversarial verification of broker-lib-sbi, broker-lib-mtf, jobs-recon, jobs-scheduling,
babel-order-model, platform-babel-orderflow, smallboard-provenance, and broker-api-path; and the
`extract:platform-api`, `gap:order-mutation-census`, `gap:timing-and-freshness`,
`extract:mindmap-architecture` and `extract:leprechaun-mock` steps.

**To resume:** relaunch with
`Workflow({scriptPath: ".../workflows/scripts/sbi-skill-knowledge-harvest-wf_467d8a1e-892.js", resumeFromRunId: "wf_467d8a1e-892"})`.
The queue in that script is ordered by value, so it picks up at `extract:platform-api`
(item 6 of 18) — everything before it replays from cache for free.

**A note on how these agents work, seen directly in this pass:** the `gap:failure-mode-catalogue`
agent had file-write access and, on finding `04-playbook.md` already comprehensive and accurate
under spot-check, edited it in place with surgical additions rather than returning a parallel
document to merge by hand. Future resumes may do the same to other files under `reference/` —
check `git diff` / file mtimes after a resume rather than assuming only new files appeared.

Nothing in this skill is invented — every fact carries a citation and every uncertainty is marked.
But the facts have been read once, not twice, for everything still listed above as unverified.
Where a claim matters enough to act on, open the cited file.
