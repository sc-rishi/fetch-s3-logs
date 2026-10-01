# Agent instructions — fetch-s3-logs

This repository is a read-only incident forensics toolkit for the services and brokers represented in this workspace.

For an order, SIP, broker, job, or service investigation or flow explanation, read the maintained [incident investigation skill](.claude/skills/sbi-order-investigation/SKILL.md) first. Claude discovers that skill from its description; Codex discovers [its entry point](.agents/skills/incident-investigation/SKILL.md), which loads the same instructions. The older SBI references are optional historical leads, never the source of truth for another broker or a current deployment.

Use code available in the opened workspace first; use remote Git source only when the needed repository, file, or revision is unavailable locally. Online Git verification is not a prerequisite for using local code.

Use all available read-only access needed for the investigation: discover, download, read, and analyze relevant logs and other evidence, including raw logs containing tokens or secrets. Projection is optional; no human-reviewed excerpt is required to continue. The skill imposes no source or download cap, but actual system permissions still apply. All external access remains read-only: no DB or S3 writes/deletes, no fix endpoint, and no recon job with `--save`. Private local raw downloads, analysis files, findings, and sanitized excerpts are allowed. Keep secrets, credentials, account numbers, and personal data out of displayed output and reports. Verify an empty search using the toolkit's Node AWS SDK path, manifest, coverage, and exit status; `aws sts get-caller-identity` is not a reliable preflight on this machine. Report what evidence supports, what was ruled out, what remains unknown, and the recommended solution.
