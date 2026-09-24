# Provenance — who changed this order?

Answering "was this fixed manually, by an automated job, or never touched?" — and, where possible,
*by whom*.

The old guide's headline answer was too pessimistic in two directions. It said `meta.updates`
can never identify a writer (false — see below), and that human identity exists only in Mattermost
(also false — four persisted, queryable sources exist).

## Decision procedure

Work down this list. Stop at the first signal that fires.

### 1. Read `meta.updates[]` and check whether the text is a template

The `Order` model itself emits exactly four strings, and these genuinely carry **no** writer identity:

```
Order saved initially with status <status>     (INITIAL)
Order saved with status <status>               (PLACED)
Order saved finally with status <status>       (FINAL — used by the fix flow)
Auto order saved with status <status>          (AUTO)
```

`sc-integrations-babel/src/models/Order.js:38,67,104,116`

**If the text is anything other than those four, it names its own writer — read it.** A whole class
of jobs bypasses `saveOrder` and `$push`es identity-bearing text directly. Confirmed in production:

| Text | Written by |
|---|---|
| `Marked MARKEDCOMPLETE by cleanup job cleanupMtfNonTerminalBatches. Was in non-terminal state '<status>'...` | `jobs/cleanup/cleanupMtfNonTerminalBatches.js:99-102` |
| `forcePlaced: status changed from <x> to PLACED via triggerManualPoll` | `jobs/triggerManualPoll.js:96,105` |
| `Attributed the order with <gateway>` | `order-updates/services/gatewayServices.js:152-162` |
| `Adhoc fix: normalized duplicate ISCID for SBI/SBI-MTF double buy orders for iscid: <old> with label: <old>` | `jobs/scripts/adhoc/orders/sbi/fixDoubleBuy.js:66,315-319` |
| `Price for tag <tag> (<side>) updated to <price>` | `jobs/scripts/adhoc/orders/updateOrderPrice.js:53-57` |
| `Batch created using backdated run <iso> by sc-integrations-jobs` | `jobs/autosips/icici/createIciciAutoSipOrders.js:113-118` |

### 2. Read `meta.source`

Set in exactly one place: `errors.js` `handle()`, behind `POST /errors/fix/:batchId`, from the
`x-request-source` header (defaulting to `'smallboard'` when the header is absent).

| Value | Meaning |
|---|---|
| `'smallboard'` | a support operator fixed it, or the header was simply missing |
| `'sc-integrations-jobs'` | one of the recon scripts — but **not which one**, see below |
| absent | never went through `/errors/fix` — either healthy, or a quiet path (step 4) |

`order-updates/services/errors.js:509-534`, header read at `ou-server/controller.js:17-22`.

### 3. If it was a recon job, narrow down which

All three active SBI recon scripts send the identical `x-request-source: sc-integrations-jobs`, so
`meta.source` alone cannot separate them. Discriminators:

| Signal | Job |
|---|---|
| `statusMessage: "Order Rejected: <real reason>"` | `sbiRejectedAmoOrdersIngest.js` — AMO rejection path, reason supplied by the broker |
| `statusMessage: "Marked as rejected as no update received from the broker"` | `sbiReconAllOrders.js` **or** `sbiDealerRecon.js` — ambiguous, correlate by timestamp. Misleading text: an update *was* received, from the CSV; the message only reads that way because the tradebook entry omitted the field |
| `meta.type: "reconInsert <date>"` | `sbiReconBatchCreation.js` — a **newly created** batch, not a fix |
| `meta.type: "<day><Mon>_DuplicateDealerOrder"` | `sbiReconDealerDuplicate.js` — newly created |

To attribute an in-place fix to a specific run, correlate the `meta.updates` timestamp against that
job's S3 stdout object and grep for the batchId in its `Batch state before fix` / `Batch state
after fix` lines.

**Before concluding any recon job fixed anything, verify it actually wrote.** `sbiReconAllOrders`
gates its fix POST on `--save` yet logs `Batch updated successfully` regardless. Read the run's
first line — `running job sbiReconAllOrders with params: {...}` — which prints the parsed yargs
object verbatim. Without `--save` in there, **nothing was written**.

`sbiDealerRecon.js` and `sbiUnplacedRecon.js` have **no** `--save` gate and always POST.

### 4. If nothing above fired, check the quiet paths

Writes that leave little or no trace in the document. There are five reachable from smallboard;
only the first was in the old guide.

| Path | What it writes | Trace |
|---|---|---|
| `POST /updateBatchStatus` → `PATCH /smallboard/orders` | **only** `status: 'ERROR'`, and only from current status `PLACED`/`PARTIALLYPLACED`/`ACKED`. A Joi allowlist strips everything else. Fires at both `Order` and `SSTOrder`. | order-updates log line `Received request from smallboard to update batch fields -> ` |
| `POST /api/support/updateSmallcaseName` | `Order.updateMany({iscid},{$set:{name}})` plus five more direct writes | none |
| `POST /api/IndianEq/broker/migration` | `Order.updateMany({userId},{$set:{userId, broker, brokeruserId}})` — **rewrites the broker field on every order of a user**, fire-and-forget so it can report success and fail silently | none |
| `POST /api/leprechaun/marketStatus` | Config `<broker>_marketStatus` — controls isMarketOpen/isAmoOpen/isCancelOpen for SBI | Redis publish to `API:REDIS_EVENTS` |
| `POST /api/broker/autoSipStatus` | Config `<broker>_dr_isPrimary` | Mattermost notification renders as **empty text** (missing switch case) |

### 5. Check whether the order was deleted

A batchId that returns nothing from Mongo is **not** proof it never existed. Two smallboard
endpoints permanently `deleteOne` the Order:

- `POST /api/support/order/dummy/reverse` (permission `reverseDummyOrder`, granted broadly)
- `POST /api/support/approveReverseSupportRequest` case 2

Check `placedOrders` for status `REVERSED`, and grep order-updates for `Delete Batch Request
receivied` (sic, typo is in the source) and `Deleted Batch`.

## Human identity — where it actually lives

Four persisted, queryable sources. Mattermost should be the **last** resort, not the first.

1. **`supportRequests.openedBy.{name,userId}`** — also `bulkSupportRequests`, `reverseSupportRequests`.
   Populated from `req.user`. Caveat: both *trades* branches of `POST /api/support/newRequest` were
   rewritten to call platform-api directly and **no longer create a supportRequests document at all**.
   For a modern manual SBI trade, the only operator record is the `DUMMY_ORDER_AUDIT` log line.
   `DELETE /api/support/request` also hard-deletes these under an ordinary user permission.
2. **`brokerAutoReconPendingApprovals.actionedBy` / `.pricedBy`** — the operator's **email**, plus
   `actionedAt` / `pricedAt`.
3. **`DUMMY_ORDER_AUDIT`** — smallboard's structured log with `operatorId`, `operatorName`,
   `batchId`, `tradeSource`.
4. **`REQUEST_LOG` / `RESPONSE_LOG`** — smallboard's universal middleware stamps `message.user.email`
   and the full request body (batchId included) on **every** authenticated `/api` call, including
   the quiet paths.

Sources 3 and 4 are the strongest, and both are currently **unreachable by this toolkit** —
smallboard is not in the `--service` registry. Say so rather than implying you checked.

The `fix-error-order` Mattermost channel carries `req.user.email` for `updateErrorOrder` and
`updateBatchStatus`. You have no tool to query it.

## The auto-recon approval path — a human-in-the-loop SBI-MTF order creator

Entirely absent from the old guide, and its default broker is **`sbimtf`**.

Smallboard surface `/api/autoRecon/*` (permissions `autoReconListApprovals`, `autoReconApprove`,
`autoReconReject`, `autoReconUpdatePrice`, `autoReconBulkApprove`) writes the operator's email into
`brokerAutoReconPendingApprovals`. Approval emits Kafka `AUTO_RECON_CORP_ACTION_APPROVED
{approvalId, broker}`, which places a real order: `label:'MANAGE'`, SELL-only, `dummy:true`,
`isGroupOrder:true`, `dummySource:'AUTO_POSITIONS_RECON'` or `'AUTO_POSITIONS_RECON_OHLC'`.

`sc-platform-api/app/services/brokerAutoRecon/brokerAutoRecon.service.js:46-136,251-301`

If you find an SBI-MTF dummy SELL batch with that `dummySource`, this is where it came from, and
`actionedBy` names the human.

## Leg-level marker: `meta.reconciled`

`markOrderSettled` / `markOrderUnplaced` / `markOrderNettedComplete` all set
`stockOrder.meta.reconciled = true` regardless of `requestSource`
(`order-updates/services/errors.js:407,435,467`).

Use it as a first filter — "was this leg fixed by anything at all" — never as an answer to "by
what". It is broker-agnostic and source-agnostic.

## SSTOrder — a separate mechanism with its own fingerprint

If the document is an `SSTOrder` rather than a plain `Order`, smallboard bypasses `/errors/fix`
entirely and goes to platform-api's `v1/internal/smallboard/reconcile`.

- `statusMessage: 'Order fixed by support request.'` is a genuine manual-fix marker — **and it is
  set on both the legs it filled and the legs it could not** (which get pushed to `unplaced` with
  status ERROR). Seeing it on an unfilled leg still means a manual fix.
  The plain-`Order` analogue `integrationsUtil.fixBatch()` sets the same string but is **never
  called** — so this string only ever appears on the SST path.
- `fixSSTBatch` appends a `meta.updates` entry **client-side** reading `Order saved initially with
  status <status>`. Since that wording is otherwise only emitted when constructing a brand-new
  order, a *second* or late-dated "saved initially" entry — especially one after a "saved finally"
  — is a positive document-level fingerprint of a manual SST fix. **This is the one case where
  `meta.updates` does answer "who".**
- No `meta.source` is set anywhere in the SST flow.

Open question: whether ordinary SBI/SBI-MTF basket orders ever live in `sstOrders` at all.
`SSTOrder` has no iscid/scid/label/dummy/dealer fields, which argues no. Unresolved.

## Cancel via smallboard

`cancelBatch` calls raw `batch.save()`, **not** `saveOrder()`/`recordUpdate()` — so it appends
nothing to `meta.updates`. The full fingerprint is:

```
status === 'MARKEDCOMPLETE'  AND  meta.source === 'smallboard'  AND  no new meta.updates row at that timestamp
```

It also mutates the User document (isc status → `VALID`, `actions.fix` entries spliced out,
possibly the whole investedSmallcase removed), flips
`PlacedOrders[meta.correlationId].status` to `COMPLETED`, and may emit Kafka `ISC_deleted`. The
operator id *is* captured as `archivedBy: req.user.id` but is discarded unless the isc was deleted
and had `flags.sip`.

## Summary table

| Signal | Location | Means |
|---|---|---|
| `meta.updates` text not one of the four templates | Order doc | the text names its own writer — read it |
| `meta.source === 'smallboard'` | Order doc | manual fix via smallboard, or a missing header |
| `meta.source === 'sc-integrations-jobs'` | Order doc | a recon script — correlate by timestamp for which |
| `meta.source` absent | — | never went through `/errors/fix`, or a quiet path |
| `meta.type` present | Order doc, **raw reads only** | batch was *created* by recon, not fixed. No `meta.updates` array at all |
| `statusMessage: "Order Rejected: <reason>"` | leg | `sbiRejectedAmoOrdersIngest.js` |
| `statusMessage: "Order fixed by support request."` | SSTOrder leg | manual SST fix, filled or not |
| `meta.reconciled === true` | leg | fixed by something — not by what |
| second "saved initially" entry | SSTOrder `meta.updates` | manual SST fix |
| `MARKEDCOMPLETE` + `smallboard` + no updates row | Order doc | smallboard cancel |
| `dummySource: AUTO_POSITIONS_RECON*` | Order doc | auto-recon approval — `actionedBy` names the human |
| doc missing entirely | — | may have been deleted; check `placedOrders` for `REVERSED` |
