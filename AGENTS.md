# Agent instructions — fetch-s3-logs

This repo is a read-only forensics toolkit for investigating production SBI and SBI-MTF order
problems at smallcase.

## Investigating an SBI or SBI-MTF order

**Read `.claude/skills/sbi-order-investigation/SKILL.md` first**, then load whichever file under
`.claude/skills/sbi-order-investigation/reference/` the task needs. That skill is the source of
truth for this work — it carries the decision tree, the bucket routing, the status enums and the
traps that produce confidently wrong answers.

Claude Code loads it automatically from the skill description. Other agents (Codex included) should
read it explicitly before starting.

Start at `reference/00-corrections.md` if you have previously read
`SBI_LOG_INVESTIGATION_GUIDE.md` — several of that document's instructions are wrong and are
corrected there.

## Non-negotiable rules

1. **Read-only, permanently.** Search S3, query Redash, write report files. Never call
   `POST /errors/fix/:batchId`, never run a recon job with `--save`, never write to Mongo, never
   change order or batch state. Recommend the fix; do not perform it.
2. **Never reproduce credentials.** SBI logs are not redacted the way you would expect — bearer
   tokens, trading and depository account numbers, client ids and the dealer's plaintext login
   password all appear in full. You will see them. Never copy them into a report, a message or a file.
3. **Report honestly and stop.** State what you searched, what you ruled out, and what you could not
   determine. Never fill a gap with a plausible guess.
4. **An empty result is probably wrong.** Run the preflight checks in the skill before concluding
   that an order does not exist — expired AWS SSO and a missing `.env` both look exactly like
   "not found".

## Scope

SBI and SBI-MTF only. Do not extrapolate any of this to other brokers.

## The one-line version

`sc-integrations-order-updates` holds essentially every order log, because broker-lib runs
in-process there and the raw SBI wire traffic is logged by order-updates itself.
`sc-integrations-broker-api` is **not** on the order path and never sees an order tag.
