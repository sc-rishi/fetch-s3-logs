# Incident investigation toolkit

This workspace contains one maintained [investigation skill](.claude/skills/sbi-order-investigation/SKILL.md) for Claude and a [Codex entry point](.agents/skills/incident-investigation/SKILL.md) that loads it. Ask either agent an order, SIP, broker, job, or service question, or ask how a flow works. The agent should investigate relevant source and evidence, then write a short report under `logs/findings/` with sanitized excerpts under `logs/findings/logs/<report-name>/`.

Example question: “Why did this SIP run two days late? Expected 29 September around 09:00 IST; observed 1 October. Production, broker XYZ, request ID available in the ticket.” An ID, a log excerpt, or an approximate time helps, but the agent should ask only for a detail that changes the search. Reports begin with a direct answer, then give evidence and coverage, what remains unknown, and a short summary ready to paste into a ticket.

## Start an investigation

Launch Claude or Codex in this repository so project skills are discovered. Use `/incident-investigation` in Claude, `$incident-investigation` in Codex, or ask naturally: “How does an auto-SIP reach the broker?” Flow explanations need no incident ID. For date-based questions, include the year and timezone when known.

From a sibling repository, explicitly ask the agent to read this repository's maintained skill by its actual path; sibling project skills are not automatically discovered. The skill resolves tools and findings from its own location. No per-user absolute paths are stored in the instructions. The Claude directory retains its historical SBI name, but its skill name and scope are generic. Codex uses the current [`.agents/skills` discovery location](https://learn.chatgpt.com/docs/build-skills).

## Set up access on each person's machine

1. Install Node.js 18 or newer and run `npm ci` in this repository.
2. Use source already available in the opened workspace, including sibling repositories and local Git history. Record its path, revision when known, and relevant working-tree changes; online Git access is not required. Only if the needed repository, file, or revision is missing locally, use **your own** GitHub read access through SSH or a Git credential manager. Confirm the correct owner/repository for that fallback and inspect a pinned SHA through the API or an isolated cache; the skill does not pull into a working tree.
3. Obtain an approved AWS read-only role or SSO profile with `s3:ListBucket` and, for investigated objects, `s3:GetObject` and any needed S3 Select permission. Select your profile with `AWS_PROFILE` or the standard AWS credential chain and set a suitable region with `AWS_REGION` or your AWS config. Renew SSO sessions when they expire. The toolkit does not choose a profile for you. Historical code proof may also need approved read access to CodeDeploy, Kubernetes rollout/image history, Airflow/Jenkins run metadata, or artifact versions; report missing grants instead of guessing the deployed SHA.
4. If database evidence is needed, obtain your own Redash read-only query access and set `REDASH_URL`, `REDASH_API_KEY`, and `REDASH_DATA_SOURCE_ID` in the environment or a local gitignored `.env`. Use an HTTPS Redash URL. Keep credentials out of commands, tickets, and reports.

Check access for the **specific** remote source you intend to inspect; omit the Git probe when using local code. For example, when remote source, S3, and Redash are all needed:

```sh
npm run access:check -- --repo ../sc-integrations-order-updates --ref production --s3-url s3://example-bucket/production/2026-09-29/service/ --redash
```

Select only needed probes: Git-only uses `--repo <path> --ref <branch>`, S3-only uses `--s3-url <url>`, and Redash-only uses `--redash`. At least one probe is required; Git's two flags must be supplied together. The check reports `verified`, `failed`, or `not checked`, with a safe failure category and next action. S3 verification lists at most one object and does not read content; zero objects does not prove an incident did not occur. The Redash probe submits a validated read-only query that cannot match a record. Connectivity does not prove read-only grants, collection access, object-read access, deployed code, or complete coverage. Read-only permissions must be provisioned by the organization; this toolkit never tests grants by attempting a write.

If a check fails, request the missing **read-only** repository, bucket/prefix, or Redash grant from the appropriate owner. Share the source name and failure category, never a token or raw log. A PM or QA colleague who lacks source or production access can ask an authorized investigator to run the skill and attach the reviewed, sanitized report to the existing ticket. Local `logs/` reports are gitignored and are not automatically shared.

## Raw fetches and reports

Use a new private temporary output directory for every raw fetch, for example `mktemp -d`. Both agents may discover, download, read, and analyze complete raw logs, including logs containing credentials or personal information, using all available read-only tools and sources. There is no skill-imposed source or download cap; actual system permissions still apply. Toolkit projection is optional, and omitted fields do not require human review before continuing. Keep raw data local, redact sensitive values from displayed output and report excerpts, do not attach raw data to tickets, and remove temporary copies created for the investigation when done. A fetch writes `manifest.json` with a random source alias, date/window, counts, and completeness status; it intentionally omits S3 keys, identifiers, and remote error bodies. An `incomplete` manifest or nonzero exit status cannot support a “not found” conclusion. `empty_source` and `no_objects_after_filters` mean the selected scope provided no searchable objects.

Generic log searches stream objects locally. `--select-format compact-jsonl` is an optional optimization only after pinned producer and shipper code/configuration prove that every selected record is one compact JSON object per LF-delimited line without literal tabs, CR, or comment records. Record that proof in the investigation; a sample, filename, or flag is insufficient. Field alternatives use local streaming to retain text OR field semantics. Check actual method, fallbacks, statistics, and coverage in the manifest. Matching records with unknown event time remain candidates; upload time is metadata, not event time.

The optional safe-evidence projector includes timestamps and source references. Its event, status, and error-code values are withheld until reviewed against identified source; this limits projected output, not access to raw logs. Use `--evidence-spec <private-json-file>` with the identifier search, Redash CLI, or `safe-evidence.js`. For example (replace the synthetic citation with the actual inspected source):

```json
{
  "fields": [{
    "path": "orders[].status",
    "kind": "status",
    "values": [3, "rejected", "CANCELLED AMO"],
    "source": "example-service@0123456789abcdef0123456789abcdef01234567:src/orders.js:42"
  }],
  "identifiers": [{
    "path": "orders[].tag",
    "source": "example-service@0123456789abcdef0123456789abcdef01234567:src/orders.js:41"
  }]
}
```

Paths refer to the log object (inside the toolkit's `log` wrapper when present). Exact values retain their types; numeric `3` differs from string `"3"`. `kind` is `event`, `status`, or `code`. Paths support dots and `[]`, not executable expressions. Identifier rules establish correlation without emitting identifier values. For standalone projection, pass `--identifier-file <private-one-line-file>` containing the exact search identifier (maximum 1 KiB, owner-only permissions); the identifier search already supplies its query value. Never put a sensitive identifier in command arguments. Concrete element paths and correlation labels keep one order's status separate from another's. Never use unreviewed logs to create a spec or include sensitive values in one.

Legacy `--validated-enums <file>` still accepts uppercase maps such as `{"status":["FAILED"]}`; it cannot be combined with `--evidence-spec`. Inspect projection omissions, missing requested paths, and truncation separately from fetch completeness. Projection counts describe inspected payload scalar values, not objects fetched or search coverage. Intentional withholding is not evidence of absence. Inspect raw data directly when a decisive field is omitted and produce a sanitized excerpt for the report.

A generic `fetch-s3-logs.js` aggregate proves a match within its selected prefix/window only; obtain an exact object for an object-level citation or state that limit. Reports use relative evidence links (`logs/<report-name>/<file>`) and local source paths with line numbers and revisions when known. Mark relevant uncommitted changes or unknown revisions explicitly. Verified GitHub commit links are optional for local source and useful for remote fallback. Record inspected source and deployed artifact/SHA separately; record an online branch tip only when actually checked. Local source is sufficient for a flow explanation, while historical deployment claims still need runtime evidence.

Redash enforces read-only stages, validates dates, and limits request/poll duration. A row limit bounds output, not database scan work; use a justified date window or source-verified indexed lookup. Neither a missing order nor an empty log search alone proves a SIP was never scheduled.

The optional raw-log UI (`npm run ui`) binds to `127.0.0.1` by default. It serves raw local logs and is for the investigator's machine only. Share the reviewed Markdown report and sanitized evidence, not the UI or raw output.

## Verification

Run `npm test` for synthetic toolkit regressions. Agent behavior and live activation are separate checks in [the evaluation guide](evals/incident-investigation.md); see the [29 September verification results](evals/verification-2026-09-29.md). Logged-out agents, unavailable source access, and unavailable approved S3 fixtures are recorded as unverified, never as passing checks. Production data is not needed for synthetic evaluations.
