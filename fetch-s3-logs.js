#!/usr/bin/env node
/* eslint-disable no-plusplus */
/**
 * Fetch S3 log files and produce per-file "raw logs" outputs.
 *
 * Requirements:
 * - Node.js >= 16
 * - npm i -D @aws-sdk/client-s3 (installed in the repo's package.json)
 *
 * AWS Credentials/Region:
 * - Use standard AWS environment/config resolution (env vars, shared credentials file, IAM role).
 * - You can also pass --region to override.
 *
 * Usage:
 *   node scripts/fetch-s3-logs.js \\
 *     --bucket my-logs-bucket \\
 *     --prefix path/to/logs/2025-11-20/ \\
 *     --out ./out-raw-logs \\
 *     --region ap-south-1 \\
 *     --concurrency 5 \\
 *     --raw-field raw,message,msg,log
 *
 * Notes:
 * - If an S3 object ends with .gz or has gzip content-encoding, it will be transparently decompressed.
 * - Each S3 object produces one output file that contains only "raw" log lines.
 * - For JSONL inputs, the script will try to extract one of the provided raw fields.
 * - For non-JSON lines, the line is written as-is.
 */

/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { pipeline, Readable } = require('stream');
const { promisify } = require('util');
const { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, SelectObjectContentCommand } = require('@aws-sdk/client-s3');
const {
  COMPACT_JSONL, compactJsonLine, compactJsonSelectExpression, forEachSelectRecord, logInputStream, validateSelectComplete,
} = require('./s3-search-utils');
const { safeTimestamp } = require('./safe-evidence');
const { redactSecrets, redactFreeText } = require('./redact-secrets');
const {
  DEFAULT_SEARCH_DAYS,
  RAW_LINE_CSV,
  ValidationError,
  dateRange,
  escapeLikeLiteral,
  formatDate,
  parseIsoDate,
  sqlString,
} = require('./search-s3-logs');

const pipe = promisify(pipeline);
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SOURCE_ALIAS_BYTES = 8;

const DATE = null;
// Set BOTH of these (e.g. '2026-06-01' / '2026-06-24') to scan a day range by default with no CLI
// args — the script then substitutes each day into a literal "{date}" placeholder in S3_URL below
// (swap the active S3_URL's `${DATE}` for `{date}` when using this). Leave both empty ('') to keep
// today's single fixed-date behavior driven by DATE above. Overridden by --date/--date-from/--date-to.
const DATE_FROM = '2026-09-01';
const DATE_TO = '2026-09-30';
const DEFAULT_CONCURRENCY = 4;
// Script-level defaults (can be edited directly instead of passing CLI flags)
const DEFAULTS = {
  // --- EC2/PM2 (legacy hosting, bucket sc-pm2logs-new, flat PROD/<date>/<service>/ layout) ---
  // Verified live 2026-09-22: order-updates & broker-api are now EMPTY here (fully migrated to EKS below).
  // platform-api is still DUAL-RUNNING here (actively written) alongside EKS — check both for platform-api.
  // Remember --dir Out-logs (or Error-logs) or you'll also pull code-deploy-logs/ and script-logs/ noise.
  // DATE below is still 2026-06-05 (pre-migration for order-updates/broker-api) so the EC2 path is the one
  // that actually has data for it — that's how the checked-in sample log was generated. If you bump DATE to
  // something recent, switch the active default to the EKS block below instead (order-updates/broker-api are
  // EKS-only for recent dates — verified live 2026-09-22).
  // S3_URL: `s3://sc-pm2logs-new/PROD/${DATE}/sc-integrations-order-updates/`, //ec2, has data for DATE=2026-06-05
  // S3_URL: 's3://sc-pm2logs-new/PROD/{date}/sc-integrations-order-updates/', //ec2, use with DATE_FROM/DATE_TO set above for a day-range scan
  // S3_URL: `s3://sc-pm2logs-new/PROD/${DATE}/sc-integrations-broker-api/`, //ec2, has data for DATE=2026-06-05
  // S3_URL: `s3://sc-pm2logs-new/PROD/${DATE}/sc-platform-api/`, //ec2, still live (dual-running, any date)
  // S3_URL: `s3://sc-pm2logs-new/PROD/${DATE}/sc-integrations-jobs/`, //ec2, jobs daemon logs (not per-job-run output, see below)

  // --- Kubernetes/EKS (current hosting, bucket sc-eks-pod-logs, namespaced <staging|production>/<date>/<ns>/<service>-pod/) ---
  // Verified live 2026-09-22: order-updates & broker-api are EKS-only for RECENT dates (empty on EC2 above). platform-api also live here (dual-running).
  S3_URL: 's3://sc-eks-pod-logs/production/{date}/integrations/sc-integrations-order-updates-pod/',
  // S3_URL: `s3://sc-eks-pod-logs/production/${DATE}/integrations/sc-integrations-broker-api-pod/`, //eks production, use for recent dates
  // S3_URL: `s3://sc-eks-pod-logs/production/${DATE}/platform/sc-platform-api-pod/`, //eks production (current)
  // S3_URL: `s3://sc-eks-pod-logs/production/${DATE}/integrations/sc-integrations-postback-interface-pod/`, //eks production, postback interface
  // S3_URL: `s3://sc-eks-pod-logs/staging/${DATE}/integrations/sc-integrations-order-updates-pod/`, //eks staging
  // S3_URL: `s3://sc-eks-pod-logs/staging/${DATE}/integrations/sc-integrations-broker-api-pod/`, //eks staging
  // S3_URL: `s3://sc-eks-pod-logs/staging/${DATE}/platform/sc-platform-api-pod/`, //eks staging

  // --- sc-integrations-jobs per-run logs (DIFFERENT bucket+shape: one gzip object per job invocation, NOT date-partitioned) ---
  // Key = sc-integrations-jobs/<jobFileName>_<bullJobId> (bullJobId often embeds an epoch-ms timestamp for repeatable jobs).
  // No .gz extension and no gzip Content-Type/Content-Encoding header — this script's auto-gunzip detection MISSES these
  // objects (verified live); do not point S3_URL here without also forcing gunzip, or you'll get raw binary garbage.
  // S3_URL: `s3://sc-prod-logs/sc-integrations-jobs/`, //ec2 production (jobs per-run stdout, needs forced gunzip)
  // S3_URL: `s3://sc-stag-logs/sc-integrations-jobs/`, //staging (same per-run format as production, needs forced gunzip)

  OUT_DIR: './logs',
  IST: true,
  DATE_FROM: DATE_FROM || undefined,
  DATE_TO: DATE_TO || undefined,
  // FROM: `${DATE}T00:00:01`,
  // TO: `${DATE}T24:59:59`,
  FILTER_TEXT: "no records found, axis", // e.g. 'hdfcsky'
  // FILTER_NOT_TEXT: 'dealerId', // exclude lines containing any of these (comma-separated or array)
  // FILTER_FIELD: 'broker=hdfcsky, brokerName=hdfcsky', // string, comma-separated, or array of 'k=v'
  CONCURRENCY: 120,
  SORT: 'nf', // 'nf' | 'of' (new first | old first)
  CI: true, // case-insensitive matching for text and field,
  // DIR: 'Out-logs',
  PARSE_MESSAGE: true, // parse JSON strings in message/raw fields into nested objects
};

function printHelpAndExit(code = 1) {
  console.log(
    [
      'Fetch S3 log files and produce per-file "raw logs" outputs.',
      '',
      'Options:',
      '  --s3-url <s3://bucket/prefix/>  S3 URL (overrides --bucket/--prefix if provided)',
      '  --bucket <name>            S3 bucket name (required)',
      '  --prefix <path>            S3 prefix to list (optional, default: empty)',
      '  --out <dir>                Output directory for raw logs (required)',
      '  --region <aws-region>      Override the AWS SDK region resolution',
      '  --concurrency <n>          Parallel downloads (default: 4)',
      '  --raw-field <a,b,c>        Comma-separated field names to try for raw logs (default: raw,message,msg,log)',
      '  --start-after <key>        Start after this key when listing (optional)',
      '  --max-keys <n>             Max keys per list page (default: 1000)',
      '  --dir <name>               Only include this first-level subdirectory under the prefix (default: Out-logs)',
      '  --date <YYYY-MM-DD>        Substitute into a {date} placeholder in --s3-url/--bucket/--prefix (single day)',
      '  --date-from <YYYY-MM-DD>   Start of a date range to substitute into {date} (pair with --date-to, max 30 days)',
      '  --date-to <YYYY-MM-DD>     End of a date range to substitute into {date} (pair with --date-from)',
      '                              One run per day; output goes to <out>/<date>/all-logs.filtered.log.',
      '                              Not the same as --from/--to below, which filter individual log lines.',
      '  --from <ISO|epochMs>       Filter lines whose JSON "time" >= this',
      '  --to <ISO|epochMs>         Filter lines whose JSON "time" <= this',
      '  --ist                      Interpret --from/--to as IST (UTC+05:30)',
      '  --filter-text <a,b>        Substring filter (comma-separated values must ALL match)',
      '  --no-filter-text           Disable the built-in source text filter',
      '  --whole-word              Match --filter-text values as whole words instead of substrings',
      '  --select-format compact-jsonl  Opt in only for a source format verified for this case',
      '  --filter-not-text <a,b>    Exclude lines matching ANY of these substrings (comma-separated)',
      '  --filter-field <k=v>       Create an additional filtered copy with lines where JSON field k===v',
      '                              Supports expressions like: key1=val1 and key2=val2 or key3=val3',
      '                              (repeatable; repeats OR with expression result)',
      '  --sort <nf|of>             Optional: sort by JSON "time" (nf=new first, of=old first)',
      '  --ci                       Case-insensitive matching for --filter-text and --filter-field',
      '  --parse-message            Parse JSON strings in raw/message fields into nested objects',
      '  --force-gunzip             Always gunzip objects regardless of key/Content-Encoding/Content-Type',
      '                              (needed for buckets like sc-prod-logs where gzip objects carry no hint)',
      '  --modified-after <ISO>     Only include S3 objects whose LastModified >= this (for non-date-partitioned',
      '                              prefixes, e.g. sc-integrations-jobs per-run logs)',
      '  --modified-before <ISO>    Only include S3 objects whose LastModified <= this',
      '  --no-redact-secrets        Write raw credential values (access tokens, secrets, passwords,',
      '                              cookies, JWTs) instead of "REDACTED". Redaction is ON by default;',
      '                              only disable when you specifically need a credential value itself.',
      '  --help                     Show this help',
      '',
      'Examples:',
      '  node scripts/fetch-s3-logs.js --s3-url s3://my-bucket/app/logs/ --out ./raw-logs',
      '  node scripts/fetch-s3-logs.js --bucket my-bucket --prefix app/logs/ --out ./raw-logs',
      '  node scripts/fetch-s3-logs.js --bucket my-bucket --out ./raw-logs --raw-field message',
      '  node scripts/fetch-s3-logs.js --s3-url s3://bucket/prefix/ --dir folder1 --from 2025-11-20T10:00:00Z --to 2025-11-20T12:00:00Z --out ./raw',
      '  node scripts/fetch-s3-logs.js --s3-url s3://bucket/prefix/ --filter-text hdfcsky --out ./raw',
      '  node scripts/fetch-s3-logs.js --s3-url s3://bucket/prefix/ --filter-field broker=hdfcsky --out ./raw',
      '  node scripts/fetch-s3-logs.js --s3-url s3://sc-pm2logs-new/PROD/2025-11-20/sc-integrations-broker-api/ --out ./raw-logs --filter-text hdfcsky',
      '  node scripts/fetch-s3-logs.js --s3-url "s3://sc-pm2logs-new/PROD/{date}/sc-integrations-order-updates/" --dir Out-logs --date-from 2026-06-01 --date-to 2026-06-24 --filter-text sc_rXWoyJfoH --out ./logs',
      '',
      'Notes:',
      '  - This script writes ONLY a filtered output file per S3 object.',
      '  - If no filters are provided, all lines are included into the filtered file.',
      '  - JSON lines are pretty-printed. Non-JSON lines are wrapped as {"raw": "..."} and pretty-printed.',
      '  - Downloads stream locally by default. Verified compact JSONL may opt in to Select.',
      '    Field alternatives always use local filtering. Select format/completeness failures',
      '    discard partial candidates and retry the complete object locally.',
    ].join('\n')
  );
  process.exit(code);
}

function parseFilterExpression(expr) {
  // Returns OR-of-AND clauses: Array<Array<{name,value}>>
  if (!expr || typeof expr !== 'string') return [];
  const orParts = expr.split(/\s+or\s+/i).map((s) => s.trim()).filter(Boolean);
  const clauses = [];
  for (const orPart of orParts) {
    const andParts = orPart.split(/\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
    const clause = [];
    for (const p of andParts) {
      const [k, v] = parseKeyValue(p);
      if (k && v !== undefined) clause.push({ name: k, value: v });
    }
    if (clause.length > 0) clauses.push(clause);
  }
  return clauses;
}

function normalizeFilterText(input) {
  if (!input) return undefined;
  if (Array.isArray(input)) {
    const cleaned = input.map((s) => String(s).trim()).filter(Boolean);
    return cleaned.length ? cleaned : undefined;
  }
  const str = String(input);
  if (str.includes(',')) {
    const parts = str.split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  }
  const trimmed = str.trim();
  return trimmed ? [trimmed] : undefined;
}

function parseArgs(argv) {
  const args = {
    s3Url: undefined,
    bucket: undefined,
    prefix: '',
    outDir: undefined,
    region: undefined,
    concurrency: undefined,
    rawFields: [],
    startAfter: undefined,
    maxKeys: 1000,
    dir: undefined,
    date: undefined,
    dateFrom: undefined,
    dateTo: undefined,
    from: undefined,
    to: undefined,
    filterText: undefined,
    wholeWord: false,
    filterNotText: undefined,
    filterFields: [],
    filterFieldExprClauses: [],
    ist: false,
    sort: undefined,
    ci: undefined,
    parseMessage: false,
    forceGunzip: false,
    modifiedAfter: undefined,
    modifiedBefore: undefined,
    redactSecrets: true,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') printHelpAndExit(0);
    if (a === '--s3-url') args.s3Url = argv[++i];
    else if (a === '--bucket') args.bucket = argv[++i];
    else if (a === '--prefix') args.prefix = argv[++i] || '';
    else if (a === '--out') args.outDir = argv[++i];
    else if (a === '--region') args.region = argv[++i];
    else if (a === '--concurrency') args.concurrency = Number(argv[++i] || String(DEFAULT_CONCURRENCY));
    else if (a === '--raw-field') {
      const v = argv[++i] || '';
      args.rawFields = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--start-after') args.startAfter = argv[++i];
    else if (a === '--max-keys') args.maxKeys = Number(argv[++i] || '1000');
    else if (a === '--dir') args.dir = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--date-from') args.dateFrom = argv[++i];
    else if (a === '--date-to') args.dateTo = argv[++i];
    else if (a === '--from') args.from = argv[++i];
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--filter-text') {
      const parsed = normalizeFilterText(argv[++i]);
      if (parsed && parsed.length) {
        if (!args.filterText) args.filterText = [];
        args.filterText.push(...parsed);
      }
    } else if (a === '--filter-not-text') {
      const parsed = normalizeFilterText(argv[++i]);
      if (parsed && parsed.length) {
        if (!args.filterNotText) args.filterNotText = [];
        args.filterNotText.push(...parsed);
      }
    }
    else if (a === '--filter-field') {
      const spec = argv[++i] || '';
      // Accept expressions with 'and'/'or' or single 'k=v'
      if (/\s+(and|or)\s+/i.test(spec)) {
        const clauses = parseFilterExpression(spec);
        args.filterFieldExprClauses.push(...clauses);
      } else {
        const eq = spec.indexOf('=');
        if (eq > 0) {
          const k = spec.slice(0, eq);
          const v = spec.slice(eq + 1);
          args.filterFields.push({ name: k, value: v });
        } else {
          console.warn('Ignoring --filter-field: expected key=value or an expression with and/or');
        }
      }
    } else if (a === '--ist') args.ist = true;
    else if (a === '--force-gunzip') args.forceGunzip = true;
    else if (a === '--modified-after') args.modifiedAfter = argv[++i];
    else if (a === '--modified-before') args.modifiedBefore = argv[++i];
    else if (a === '--sort') {
      const mode = String(argv[++i] || '').toLowerCase();
      if (mode === 'nf' || mode === 'of') args.sort = mode;
      else console.warn('Ignoring --sort: expected "nf" or "of"');
    } else if (a === '--ci') args.ci = true;
    else if (a === '--whole-word') args.wholeWord = true;
    else if (a === '--select-format') args.selectFormat = argv[++i];
    else if (a === '--parse-message') args.parseMessage = true;
    else if (a === '--no-filter-text') args.noFilterText = true;
    else if (a === '--no-redact-secrets') args.redactSecrets = false;
    else if (a === '--no-sort') args.noSort = true;
    else {
      throw new ValidationError('Unknown option; run --help for supported flags.');
    }
  }
  if (args.selectFormat && args.selectFormat !== COMPACT_JSONL) {
    throw new ValidationError('--select-format must be compact-jsonl; omit it for local streaming.');
  }
  return args;
}

function applyDefaultDateRange(args, defaults = DEFAULTS) {
  if (args.s3Url || args.bucket) return;
  if (!args.date && !args.dateFrom && !args.dateTo && defaults.DATE_FROM && defaults.DATE_TO) {
    args.dateFrom = defaults.DATE_FROM;
    args.dateTo = defaults.DATE_TO;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
}

function computeOutputPath(baseDir, key) {
  // Preserve directory structure, convert typical log extensions to .raw.log
  const outFull = path.join(baseDir, key);
  const dir = path.dirname(outFull);
  ensureDir(dir);
  const name = path.basename(outFull);
  if (name.endsWith('.log.gz')) return path.join(dir, name.replace(/\.log\.gz$/, '.raw.log'));
  if (name.endsWith('.json.gz')) return path.join(dir, name.replace(/\.json\.gz$/, '.raw.log'));
  if (name.endsWith('.gz')) return path.join(dir, name.replace(/\.gz$/, '.raw.log'));
  if (name.endsWith('.log')) return path.join(dir, name.replace(/\.log$/, '.raw.log'));
  if (name.endsWith('.json')) return path.join(dir, name.replace(/\.json$/, '.raw.log'));
  return `${outFull}.raw.log`;
}

function computeFilteredOutputPath(rawOutPath) {
  if (rawOutPath.endsWith('.raw.log')) return rawOutPath.replace(/\.raw\.log$/, '.filtered.log');
  return `${rawOutPath}.filtered.log`;
}

function createDownloadProgressBar(total) {
  if (!Number.isFinite(total) || total <= 0) {
    return {
      render: () => {},
      tick: () => {},
    };
  }
  const width = 32;
  const isTTY = !!process.stdout.isTTY;
  let completed = 0;
  let lastLogged = '';
  const filledGlyph = isTTY ? '\x1b[47m \x1b[0m' : '#';
  const emptyGlyph = isTTY ? '\x1b[40m \x1b[0m' : '-';
  const makeBar = (count, glyph) => {
    if (count <= 0) return '';
    if (!isTTY) return glyph.repeat(count);
    return Array.from({ length: count }, () => glyph).join('');
  };

  const draw = () => {
    const ratio = total === 0 ? 0 : completed / total;
    const filled = Math.round(ratio * width);
    const bar = `${makeBar(filled, filledGlyph)}${makeBar(Math.max(0, width - filled), emptyGlyph)}`;
    const line = `Downloading [${bar}] ${(ratio * 100).toFixed(1)}% (${completed}/${total})`;
    if (isTTY) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(line);
    } else if (line !== lastLogged) {
      console.log(line);
      lastLogged = line;
    }
  };

  return {
    render: () => {
      draw();
    },
    tick: () => {
      completed = Math.min(total, completed + 1);
      draw();
      if (isTTY && completed === total) {
        process.stdout.write('\n');
      }
    },
  };
}

function looksLikeGzipKey(key) {
  return key.endsWith('.gz') || key.endsWith('.gzip');
}

async function isGzipEncodedHead(s3, bucket, key) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const ce = head.ContentEncoding || head.ContentType || '';
    if (typeof ce === 'string') {
      const val = ce.toLowerCase();
      return val.includes('gzip') || val.includes('x-gzip');
    }
    return false;
  } catch (err) {
    // If HEAD fails (permissions), fallback to key-based detection
    return false;
  }
}

function parseS3Url(url) {
  // s3://bucket/prefix...
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith('s3://')) return null;
  const withoutScheme = trimmed.slice('s3://'.length);
  const firstSlash = withoutScheme.indexOf('/');
  if (firstSlash === -1) return withoutScheme && !/[\s?#@]/.test(withoutScheme) ? { bucket: withoutScheme, prefix: '' } : null;
  const bucket = withoutScheme.slice(0, firstSlash);
  if (!bucket || /[\s?#@]/.test(bucket)) return null;
  let prefix = withoutScheme.slice(firstSlash + 1);
  if (/[?#]/.test(prefix)) return null;
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  return { bucket, prefix };
}

function parseDateMaybe(input) {
  if (!input) return undefined;
  // Try epoch milliseconds
  if (/^\d{10,}$/.test(input)) {
    const ms = Number(input);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parseDateWithIST(input, assumeIST) {
  if (!input) return undefined;
  // Epoch seconds (10) or ms (13+)
  if (/^\d{10,}$/.test(input)) {
    const num = Number(input);
    const ms = input.length === 10 ? num * 1000 : num;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const calendar = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
  if (calendar) {
    const [year, month, day] = calendar.slice(1).map(Number);
    const checked = new Date(Date.UTC(year, month - 1, day));
    if (checked.getUTCFullYear() !== year || checked.getUTCMonth() + 1 !== month || checked.getUTCDate() !== day) {
      return undefined;
    }
  }
  if (!assumeIST) {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  // If input has explicit timezone (Z or +/-hh:mm), honor it directly
  if (/[zZ]$/.test(input) || /[+\-]\d{2}:\d{2}$/.test(input)) {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  // Parse timezone-free ISO input as IST without depending on the host timezone.
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/.exec(input);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]); // 1-12
    const day = Number(m[3]);
    const hour = m[4] ? Number(m[4]) : 0;
    const minute = m[5] ? Number(m[5]) : 0;
    const second = m[6] ? Number(m[6]) : 0;
    const millisecond = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
    if (hour > 23 || minute > 59 || second > 59) return undefined;
    // IST (UTC+05:30) -> UTC
    const utcMs = Date.UTC(year, month - 1, day, hour - 5, minute - 30, second, millisecond);
    return new Date(utcMs);
  }
  return undefined;
}

function parseKeyValue(spec) {
  if (!spec || typeof spec !== 'string') return [undefined, undefined];
  const eq = spec.indexOf('=');
  if (eq <= 0) return [undefined, undefined];
  const k = spec.slice(0, eq);
  const v = spec.slice(eq + 1);
  return [k, v];
}

function includesFilterTerm(haystack, needle, wholeWord) {
  if (!wholeWord) return haystack.includes(needle);
  const escapedNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escapedNeedle}\\b`).test(haystack);
}

function tryExtractRawFromJsonLine(line, rawFields) {
  try {
    const obj = JSON.parse(line);
    for (const field of rawFields) {
      if (obj && Object.prototype.hasOwnProperty.call(obj, field)) {
        const value = obj[field];
        if (value === null || value === undefined) continue;
        if (typeof value === 'string') return value;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }
    }
    // Fallback: if it contains "message" nested or typical common patterns
    if (obj && obj.message && typeof obj.message === 'string') return obj.message;
    if (obj && obj.msg && typeof obj.msg === 'string') return obj.msg;
    return null;
  } catch {
    return null;
  }
}

function tryParseNestedJsonFields(obj, rawFields) {
  if (!obj || typeof obj !== 'object') return obj;
  const fieldsToCheck = [...rawFields, 'message', 'msg'];
  const result = { ...obj };
  for (const field of fieldsToCheck) {
    if (typeof result[field] === 'string') {
      try {
        const parsed = JSON.parse(result[field]);
        if (parsed && typeof parsed === 'object') {
          result[field] = parsed;
        }
      } catch { /* not JSON, leave as-is */ }
    }
  }
  return result;
}

async function writeRawLogsFromStreamToFile(readable, outFilePath, shouldGunzip) {
  const outStream = fs.createWriteStream(outFilePath, { flags: 'w', mode: PRIVATE_FILE_MODE });
  const source = logInputStream(readable, shouldGunzip);
  await pipe(source, outStream);
}

async function writeFilteredLogsFromStreamToFile(
  readable,
  outFilePath,
  shouldGunzip,
  filterTextTerms,
  filterNotTextTerms,
  filterFieldSpecs,
  fromDate,
  toDate,
  sortMode,
  caseInsensitive,
  wholeWord,
  filterFieldExprClauses,
  parseMessage = false,
  rawFields = [],
  fileMode = 'w',
  externalBuffer = null,
  redact = true
) {
  return new Promise((resolve, reject) => {
    let outStream;
    let failed = false;
    let matches = 0;
    let timeUnverified = 0;
    const result = () => ({ matched: matches, timeUnverified });
    // When an externalBuffer is provided (global sort), we never write to file here
    const buffer = (sortMode && externalBuffer) ? externalBuffer : (sortMode ? [] : null);
    const createOut = () => {
      if (outStream) return;
      outStream = fs.createWriteStream(outFilePath, { flags: fileMode, mode: PRIVATE_FILE_MODE });
      outStream.on('error', fail);
      outStream.on('finish', () => resolve(result()));
    };
    const source = logInputStream(readable, shouldGunzip);
    const rl = readline.createInterface({ input: source });
    function fail(error) {
      if (failed) return;
      failed = true;
      reject(error);
      rl.close();
      source.destroy();
      outStream?.destroy();
    }
    function deepFieldEquals(obj, key, expected) {
      const keyNorm = caseInsensitive ? String(key).toLowerCase() : key;
      const expectedNorm = caseInsensitive ? String(expected).toLowerCase() : String(expected);
      if (obj === null || typeof obj !== 'object') return false;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          if (deepFieldEquals(item, key, expected)) return true;
        }
        return false;
      }
      for (const k of Object.keys(obj)) {
        const val = obj[k];
        const kMatch = caseInsensitive ? String(k).toLowerCase() === keyNorm : k === key;
        if (kMatch) {
          const vStr = String(val);
          if ((caseInsensitive ? vStr.toLowerCase() : vStr) === expectedNorm) return true;
        }
        if (val && typeof val === 'object') {
          if (deepFieldEquals(val, key, expected)) return true;
        }
      }
      return false;
    }
    const hasTextFilter = Array.isArray(filterTextTerms) && filterTextTerms.length > 0;
    const hasNotTextFilter = Array.isArray(filterNotTextTerms) && filterNotTextTerms.length > 0;
    rl.on('line', (line) => {
      // Time filter using obj.time (UTC). If from/to are not provided, skip time check.
      const hasTimeFilter = !!fromDate || !!toDate;
      let parsedObj;
      let unverifiedTime = false;
      if (hasTimeFilter) {
        try {
          parsedObj = JSON.parse(line);
          const timestamp = safeTimestamp(parsedObj?.time);
          unverifiedTime = !timestamp;
          if (timestamp) {
            const eventDate = new Date(timestamp);
            if (fromDate && eventDate < fromDate) return;
            if (toDate && eventDate > toDate) return;
          }
        } catch {
          unverifiedTime = true;
        }
      }

      // Content filters (OR)
      const hasFieldSpecs = Array.isArray(filterFieldSpecs) && filterFieldSpecs.length > 0;
      const hasFieldExpr = Array.isArray(filterFieldExprClauses) && filterFieldExprClauses.length > 0;
      const hasContentFilter = hasTextFilter || hasFieldSpecs || hasFieldExpr;
      let textMatch = false;
      if (hasTextFilter) {
        const haystack = caseInsensitive ? String(line).toLowerCase() : String(line);
        textMatch = true;
        let requiredTerms = 0;
        for (const term of filterTextTerms) {
          const rawTerm = term === undefined || term === null ? '' : String(term);
          const needle = caseInsensitive ? rawTerm.toLowerCase() : rawTerm;
          if (!needle) continue;
          requiredTerms += 1;
          if (!includesFilterTerm(haystack, needle, wholeWord)) {
            textMatch = false;
            break;
          }
        }
        if (requiredTerms === 0) textMatch = true;
      }
      let fieldMatch = false;
      if (hasFieldSpecs) {
        try {
          parsedObj = parsedObj ?? JSON.parse(line);
          if (parsedObj) {
            for (const spec of filterFieldSpecs) {
              if (deepFieldEquals(parsedObj, spec.name, spec.value)) {
                fieldMatch = true;
                break;
              }
            }
          }
        } catch {
          fieldMatch = false;
        }
      }
      // Evaluate OR-of-AND expression
      if (!fieldMatch && hasFieldExpr) {
        try {
          parsedObj = parsedObj ?? JSON.parse(line);
          if (parsedObj) {
            for (const clause of filterFieldExprClauses) {
              let allOk = true;
              for (const spec of clause) {
                if (!deepFieldEquals(parsedObj, spec.name, spec.value)) {
                  allOk = false;
                  break;
                }
              }
              if (allOk) {
                fieldMatch = true;
                break;
              }
            }
          }
        } catch {
          // ignore parse errors -> no field match
        }
      }
      const includeByContent = hasContentFilter ? (textMatch || fieldMatch) : true;
      if (hasNotTextFilter) {
        const haystackEx = caseInsensitive ? String(line).toLowerCase() : String(line);
        for (const term of filterNotTextTerms) {
          const needle = caseInsensitive ? String(term).toLowerCase() : String(term);
          if (needle && haystackEx.includes(needle)) return;
        }
      }
      if (!includeByContent) return;
      if (unverifiedTime) timeUnverified += 1;

      // Buffer or write
      if (buffer) {
        // Determine time for sorting if present
        let objForSort = parsedObj;
        if (!objForSort) {
          try { objForSort = JSON.parse(line); } catch { objForSort = null; }
        }
        let tMs = NaN;
        if (objForSort && objForSort.time) {
          const tDate = new Date(objForSort.time);
          tMs = tDate.getTime();
        }
        buffer.push({ line, obj: objForSort, tMs, idx: matches });
        matches += 1;
      } else {
        createOut();
        try {
          let obj = parsedObj ?? JSON.parse(line);
          if (parseMessage) obj = tryParseNestedJsonFields(obj, rawFields);
          if (redact) obj = redactSecrets(obj);
          outStream.write(`${JSON.stringify(obj, null, 2)},\n`);
        } catch {
          const wrapped = { raw: redact ? redactFreeText(line) : line };
          outStream.write(`${JSON.stringify(wrapped, null, 2)},\n`);
        }
        matches += 1;
      }
    });
    rl.on('close', () => {
      if (failed) return;
      if (buffer && externalBuffer) {
        // Items were pushed into the shared externalBuffer; global sort/write happens in run()
        resolve(result());
      } else if (buffer) {
        if (buffer.length === 0) {
          resolve(result());
          return;
        }
        // Sort: invalid times go last
        buffer.sort((a, b) => {
          const aValid = Number.isFinite(a.tMs);
          const bValid = Number.isFinite(b.tMs);
          if (aValid && bValid) {
            // 'nf' -> newer first (desc), 'of' -> older first (asc)
            return sortMode === 'of' ? a.tMs - b.tMs : b.tMs - a.tMs;
          }
          if (aValid && !bValid) return -1;
          if (!aValid && bValid) return 1;
          // Both invalid: keep original order (by idx)
          return a.idx - b.idx;
        });
        createOut();
        for (const item of buffer) {
          try {
            if (item.obj) {
              let outObj = parseMessage ? tryParseNestedJsonFields(item.obj, rawFields) : item.obj;
              if (redact) outObj = redactSecrets(outObj);
              outStream.write(`${JSON.stringify(outObj, null, 2)},\n`);
            } else {
              const wrapped = { raw: redact ? redactFreeText(item.line) : item.line };
              outStream.write(`${JSON.stringify(wrapped, null, 2)},\n`);
            }
          } catch {
            const wrapped = { raw: redact ? redactFreeText(item.line) : item.line };
            outStream.write(`${JSON.stringify(wrapped, null, 2)},\n`);
          }
        }
        outStream.end();
      } else if (outStream) {
        outStream.end();
      } else {
        resolve(result()); // no matches -> no file created
      }
    });
    rl.on('error', fail);
  });
}

function stringToReadable(text) {
  const stream = new Readable({ read() {} });
  stream.push(text);
  stream.push(null);
  return stream;
}

// AND-of-LIKE expression across all --filter-text terms, same substring semantics the local text
// filter already enforces. Always case-insensitive (a safe superset): the local filter re-applies
// --ci/whole-word exactly afterward, so a broader Select match here can never drop a true match.
function buildTextSelectExpression(filterTextTerms) {
  const clauses = (filterTextTerms || [])
    .map((term) => String(term).trim())
    .filter(Boolean)
    .map((term) => `LOWER(s._1) LIKE ${sqlString(`%${escapeLikeLiteral(term)}%`)} ESCAPE '!'`);
  return clauses.length ? compactJsonSelectExpression(clauses.join(' AND ')) : null;
}

// Queries the object server-side via S3 Select instead of downloading it whole. Returns the
// matching lines (possibly empty — a real "no match"), or null if Select can't be used/trusted
// for this object, meaning the caller should fall back to a full download.
async function trySelectMatchingLines(s3, bucket, key, filterTextTerms, isGzip, objectSize) {
  const expression = buildTextSelectExpression(filterTextTerms);
  if (!expression) return null;
  const response = await s3.send(new SelectObjectContentCommand({
    Bucket: bucket,
    Key: key,
    Expression: expression,
    ExpressionType: 'SQL',
    InputSerialization: { CompressionType: isGzip ? 'GZIP' : 'NONE', CSV: RAW_LINE_CSV },
    OutputSerialization: { JSON: { RecordDelimiter: '\n' } },
  }));
  const lines = [];
  const completion = await forEachSelectRecord(response.Payload, (record) => lines.push(compactJsonLine(record)));
  validateSelectComplete(completion, objectSize);
  return lines;
}

async function processObject(
  s3,
  bucket,
  key,
  aggregatedOutPath,
  rawFields,
  filterText,
  filterNotText,
  filterFieldSpecs,
  fromDate,
  toDate,
  sortMode,
  caseInsensitive,
  wholeWord,
  filterFieldExprClauses,
  parseMessage,
  fileMode,
  externalBuffer = null,
  forceGunzip = false,
  selectFormat,
  objectSize,
  redact = true
) {
  ensureDir(path.dirname(aggregatedOutPath));

  const selectEligible = selectFormat === COMPACT_JSONL && filterText?.length &&
    !filterFieldSpecs?.length && !filterFieldExprClauses?.length;
  let selectedLines = null;
  let method = 'local';
  if (selectEligible) {
    method = 'fallback';
    try {
      const isGzip = forceGunzip || looksLikeGzipKey(key);
      selectedLines = await trySelectMatchingLines(s3, bucket, key, filterText, isGzip, objectSize);
    } catch {
      console.warn('S3 Select could not verify the object; trying a full download.');
    }
    if (selectedLines) {
      console.log(`  Queried via S3 Select: ${selectedLines.length} candidate line(s) (no full download).`);
      const matched = await writeFilteredLogsFromStreamToFile(
        stringToReadable(selectedLines.length ? `${selectedLines.join('\n')}\n` : ''),
        aggregatedOutPath,
        false,
        filterText,
        filterNotText,
        filterFieldSpecs,
        fromDate,
        toDate,
        sortMode,
        caseInsensitive,
        wholeWord,
        filterFieldExprClauses,
        parseMessage,
        rawFields,
        fileMode,
        externalBuffer,
        redact
      );
      return { ...matched, method: 'select' };
    }
  }

  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bodyStream = resp.Body;
  const shouldGunzip =
    forceGunzip ||
    looksLikeGzipKey(key) ||
    (resp.ContentEncoding && String(resp.ContentEncoding).toLowerCase().includes('gzip')) ||
    (resp.ContentType && String(resp.ContentType).toLowerCase().includes('gzip'));

  // Always write ONLY filtered/prettified output (if no filters provided, include all lines)
  const matched = await writeFilteredLogsFromStreamToFile(
    bodyStream,
    aggregatedOutPath,
    shouldGunzip,
    filterText,
    filterNotText,
    filterFieldSpecs,
    fromDate,
    toDate,
    sortMode,
    caseInsensitive,
    wholeWord,
    filterFieldExprClauses,
    parseMessage,
    rawFields,
    fileMode,
    externalBuffer,
    redact
  );
  return { ...matched, method };
}

async function listAllObjects({ s3, bucket, prefix, startAfter, maxKeys }) {
  const items = [];
  let continuationToken;
  // startAfter is only for the first call
  let isFirst = true;
  while (true) {
    const params = {
      Bucket: bucket,
      Prefix: prefix || '',
      MaxKeys: maxKeys || 1000,
    };
    if (continuationToken) params.ContinuationToken = continuationToken;
    if (isFirst && startAfter) params.StartAfter = startAfter;
    let resp;
    try {
      resp = await s3.send(new ListObjectsV2Command(params));
    } catch {
      const error = new Error('listing-failed');
      error.listed = items.length;
      throw error;
    }
    const contents = resp.Contents || [];
    for (const item of contents) {
      if (item && item.Key) {
        // skip "directory" placeholders
        if (item.Key.endsWith('/')) continue;
        items.push({
          key: item.Key,
          size: item.Size,
          lastModified: item.LastModified ? new Date(item.LastModified) : undefined,
        });
      }
    }
    if (!resp.IsTruncated) break;
    continuationToken = resp.NextContinuationToken;
    if (!continuationToken) {
      const error = new Error('listing-incomplete');
      error.listed = items.length;
      throw error;
    }
    isFirst = false;
  }
  return items;
}

async function run(argv = process.argv, dependencies = {}) {
  const args = parseArgs(argv);
  const explicitSource = Boolean(args.s3Url || args.bucket);

  applyDefaultDateRange(args);

  // Apply script-level defaults if not provided via CLI
  // Only fall back to the hardcoded default when the user gave neither --s3-url nor --bucket —
  // an explicit --bucket (with or without --prefix) must win over DEFAULTS.S3_URL, same as every
  // other overridable default below.
  if (!args.s3Url && !args.bucket && DEFAULTS.S3_URL) args.s3Url = DEFAULTS.S3_URL;
  if (!args.outDir && DEFAULTS.OUT_DIR) args.outDir = DEFAULTS.OUT_DIR;
  if (args.ist === false && DEFAULTS.IST) args.ist = true;
  if (!args.from && DEFAULTS.FROM) args.from = DEFAULTS.FROM;
  if (!args.to && DEFAULTS.TO) args.to = DEFAULTS.TO;
  if (!explicitSource && !args.noFilterText && (!Array.isArray(args.filterText) || args.filterText.length === 0) && DEFAULTS.FILTER_TEXT) {
    const defaults = normalizeFilterText(DEFAULTS.FILTER_TEXT);
    if (defaults) args.filterText = defaults;
  }
  if (!explicitSource && (!Array.isArray(args.filterNotText) || args.filterNotText.length === 0) && DEFAULTS.FILTER_NOT_TEXT) {
    const defaults = normalizeFilterText(DEFAULTS.FILTER_NOT_TEXT);
    if (defaults) args.filterNotText = defaults;
  }
  if (!explicitSource && args.filterFields.length === 0 && DEFAULTS.FILTER_FIELD) {
    const src = DEFAULTS.FILTER_FIELD;
    if (/\s+(and|or)\s+/i.test(String(src))) {
      const clauses = parseFilterExpression(String(src));
      args.filterFieldExprClauses.push(...clauses);
    } else {
      const specs = Array.isArray(src) ? src : String(src).split(',').map((s) => s.trim()).filter(Boolean);
      for (const spec of specs) {
        const [k, v] = parseKeyValue(spec);
        if (k && v !== undefined) {
          args.filterFields.push({ name: k, value: v });
        }
      }
    }
  }
  if (!args.concurrency && DEFAULTS.CONCURRENCY) args.concurrency = DEFAULTS.CONCURRENCY;
  if (!args.concurrency) args.concurrency = DEFAULT_CONCURRENCY;
  if (!args.noSort && !args.sort && DEFAULTS.SORT && (DEFAULTS.SORT === 'nf' || DEFAULTS.SORT === 'of')) {
    args.sort = DEFAULTS.SORT;
  }
  if (args.ci === undefined && typeof DEFAULTS.CI === 'boolean') {
    args.ci = DEFAULTS.CI;
  }
  if (!args.parseMessage && typeof DEFAULTS.PARSE_MESSAGE === 'boolean') {
    args.parseMessage = DEFAULTS.PARSE_MESSAGE;
  }
  if (!explicitSource && !args.dir && DEFAULTS.DIR) {
    args.dir = DEFAULTS.DIR;
  }
  args.filterText = normalizeFilterText(args.filterText);
  args.sourceAlias = crypto.randomBytes(SOURCE_ALIAS_BYTES).toString('hex');

  if ((!args.s3Url && !args.bucket) || !args.outDir) {
    throw new ValidationError('S3 URL/bucket and output directory are required.');
  }

  const dateList = resolveDateList(args);
  const placeholderSource = `${args.s3Url || ''} ${args.bucket || ''} ${args.prefix || ''}`;
  const hasPlaceholder = placeholderSource.includes('{date}');
  if (dateList && !hasPlaceholder) {
    throw new ValidationError('--date/--date-from/--date-to requires a {date} placeholder in the source.');
  }
  if (!dateList && hasPlaceholder) {
    throw new ValidationError('Source has a {date} placeholder; pass --date or --date-from/--date-to.');
  }

  const dates = dateList || [null];
  if (dateList) assertEmptyOutputDir(args.outDir);
  const s3 = dependencies.s3 || new S3Client(args.region ? { region: args.region } : {});
  let incomplete = false;
  for (const date of dates) {
    if (date) console.log(`\n=== ${date} ===`);
    const result = await runForScope(s3, buildScopedArgs(args, date));
    if (result.status === 'incomplete') incomplete = true;
  }
  return incomplete ? 2 : 0;
}

// Resolves the day(s) to scan: --date wins as a single day, --date-from/--date-to as an inclusive
// range (max DEFAULT_SEARCH_DAYS, same cap fetch-by-identifier.js uses), or null if neither was
// given (today's single-static-prefix behavior, unchanged). Throws ValidationError on bad input;
// callers decide how to report it (matches search-s3-logs.js's buildDateList convention).
function resolveDateList(args) {
  if (args.date && (args.dateFrom || args.dateTo)) {
    throw new ValidationError('Use either --date or --date-from/--date-to, not both.');
  }
  if (args.date) return [formatDate(parseIsoDate(args.date))];
  if (args.dateFrom || args.dateTo) {
    if (!args.dateFrom || !args.dateTo) {
      throw new ValidationError('--date-from and --date-to must be supplied together.');
    }
    const dates = dateRange(args.dateFrom, args.dateTo);
    if (dates.length > DEFAULT_SEARCH_DAYS) {
      throw new ValidationError(`--date-from/--date-to may cover at most ${DEFAULT_SEARCH_DAYS} days.`);
    }
    return dates;
  }
  return null;
}

function substitutePlaceholder(value, date) {
  return typeof value === 'string' ? value.split('{date}').join(date) : value;
}

// date === null -> no date scoping, args pass through unchanged (today's behavior).
function buildScopedArgs(args, date) {
  if (!date) return args;
  return {
    ...args,
    s3Url: substitutePlaceholder(args.s3Url, date),
    bucket: substitutePlaceholder(args.bucket, date),
    prefix: substitutePlaceholder(args.prefix, date),
    outDir: path.join(args.outDir, date),
    scopeDate: date,
  };
}

function validateTimeFilters(args) {
  const filters = {};
  for (const [name, flag] of [
    ['from', '--from'], ['to', '--to'],
    ['modifiedAfter', '--modified-after'], ['modifiedBefore', '--modified-before'],
  ]) {
    if (args[name] === undefined) continue;
    const parsed = parseDateWithIST(args[name], args.ist);
    if (!parsed) throw new ValidationError(`Invalid ${flag} timestamp; expected ISO date/time or epoch.`);
    filters[name] = parsed;
  }
  if (filters.from && filters.to && filters.from > filters.to) throw new ValidationError('--from must not be after --to.');
  if (filters.modifiedAfter && filters.modifiedBefore && filters.modifiedAfter > filters.modifiedBefore) {
    throw new ValidationError('--modified-after must not be after --modified-before.');
  }
  return filters;
}

function safeManifest(args, filters) {
  const toIso = (date) => date ? date.toISOString() : null;
  return {
    status: 'incomplete',
    sourceAlias: args.sourceAlias || crypto.randomBytes(SOURCE_ALIAS_BYTES).toString('hex'),
    date: args.scopeDate || null,
    lineWindowUTC: { from: toIso(filters.from), to: toIso(filters.to) },
    modifiedWindowUTC: { from: toIso(filters.modifiedAfter), to: toIso(filters.modifiedBefore) },
    objects: { listed: 0, selected: 0, scanned: 0, failed: 0 },
    lines: { matched: 0, timeUnverified: 0 },
    selectFormat: args.selectFormat || null,
    methods: { local: 0, select: 0, fallback: 0 },
  };
}

function writeManifest(outDir, manifest) {
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
}

function assertEmptyOutputDir(outDir) {
  if (fs.existsSync(outDir) && (!fs.statSync(outDir).isDirectory() || fs.readdirSync(outDir).length > 0)) {
    throw new ValidationError('Output directory is not empty; choose a fresh temporary directory.');
  }
}

async function runForScope(s3, args) {
  // Resolve bucket/prefix from --s3-url if provided
  if (args.s3Url) {
    const parsed = parseS3Url(args.s3Url);
    if (!parsed) {
      throw new ValidationError('Invalid --s3-url. Expected format: s3://bucket/prefix/');
    }
    args.bucket = parsed.bucket;
    args.prefix = parsed.prefix || '';
  }

  const filters = validateTimeFilters(args);
  assertEmptyOutputDir(args.outDir);
  ensureDir(args.outDir);
  const manifest = safeManifest(args, filters);
  const aggregatedOutPath = path.join(args.outDir, 'all-logs.filtered.log');
  let allItems;
  try {
    console.log('Listing selected S3 prefix.');
    allItems = await listAllObjects({
      s3,
      bucket: args.bucket,
      prefix: args.prefix,
      startAfter: args.startAfter,
      maxKeys: args.maxKeys,
    });
  } catch (error) {
    manifest.error = 'listing-failed';
    manifest.objects.listed = error.listed || 0;
    writeManifest(args.outDir, manifest);
    console.error('S3 listing failed; check credentials, access, region, and connectivity.');
    return manifest;
  }
  manifest.objects.listed = allItems.length;
  if (!allItems.length) {
    manifest.status = 'empty_source';
    writeManifest(args.outDir, manifest);
    console.log('No objects listed in the selected S3 prefix.');
    return manifest;
  }
  // Apply directory + LastModified filters at object level. Time filtering by JSON "time" is done per line.
  const fromDate = filters.from;
  const toDate = filters.to;
  const modifiedAfterDate = filters.modifiedAfter;
  const modifiedBeforeDate = filters.modifiedBefore;
  const filtered = allItems.filter((it) => {
    // Directory filter: match first segment under prefix
    if (args.dir) {
      const rel = it.key.startsWith(args.prefix) ? it.key.slice(args.prefix.length) : it.key;
      const firstSeg = rel.split('/')[0] || '';
      if (firstSeg !== args.dir) return false;
    }
    // LastModified filter: for non-date-partitioned prefixes (e.g. sc-integrations-jobs per-run logs)
    // where the S3 key itself carries no reliable date segment.
    if ((modifiedAfterDate || modifiedBeforeDate) && it.lastModified) {
      if (modifiedAfterDate && it.lastModified < modifiedAfterDate) return false;
      if (modifiedBeforeDate && it.lastModified > modifiedBeforeDate) return false;
    }
    return true;
  });
  manifest.objects.selected = filtered.length;
  if (!filtered.length) {
    manifest.status = 'no_objects_after_filters';
    writeManifest(args.outDir, manifest);
    console.log('No listed objects passed the object filters.');
    return manifest;
  }
  // ponytail: serialize unsorted writes to one file; use per-object temp outputs if throughput matters.
  const effectiveConcurrency = args.sort ? args.concurrency : 1;
  console.log(`Found ${filtered.length} object(s) after filtering. Starting download with concurrency=${effectiveConcurrency} ...`);
  const progressBar = createDownloadProgressBar(filtered.length);
  progressBar.render();

  // When sorting, collect all entries globally so the final output is sorted across all S3 objects
  const globalBuffer = args.sort ? [] : null;

  // Simple concurrency control
  let inFlight = 0;
  let idx = 0;
  let failed = 0;
  let writeCount = 0;
  await new Promise((resolve) => {
    const maybeStartNext = () => {
      while (inFlight < effectiveConcurrency && idx < filtered.length) {
        const { key, size } = filtered[idx++];
        const fileMode = writeCount === 0 ? 'w' : 'a';
        writeCount += 1;
        inFlight += 1;
        processObject(
          s3,
          args.bucket,
          key,
          aggregatedOutPath,
          args.rawFields,
          args.filterText,
          args.filterNotText,
          args.filterFields,
          fromDate,
          toDate,
          args.sort,
          !!args.ci,
          args.wholeWord,
          args.filterFieldExprClauses,
          !!args.parseMessage,
          fileMode,
          globalBuffer,
          !!args.forceGunzip,
          args.selectFormat,
          size,
          args.redactSecrets
        )
          .then((result) => {
            manifest.objects.scanned += 1;
            manifest.lines.matched += result.matched;
            manifest.lines.timeUnverified += result.timeUnverified;
            manifest.methods[result.method] += 1;
          })
          .catch(() => {
            failed += 1;
            manifest.objects.failed += 1;
            console.error('S3 object scan failed; source details withheld.');
          })
          .finally(() => {
            inFlight -= 1;
            progressBar.tick();
            if (idx >= filtered.length && inFlight === 0) resolve();
            else maybeStartNext();
          });
      }
    };
    maybeStartNext();
  });

  // Perform global sort and write once after all objects are processed
  if (globalBuffer) {
    globalBuffer.sort((a, b) => {
      const aValid = Number.isFinite(a.tMs);
      const bValid = Number.isFinite(b.tMs);
      if (aValid && bValid) {
        return args.sort === 'of' ? a.tMs - b.tMs : b.tMs - a.tMs;
      }
      if (aValid && !bValid) return -1;
      if (!aValid && bValid) return 1;
      return a.idx - b.idx;
    });
    if (globalBuffer.length > 0) {
      const outStream = fs.createWriteStream(aggregatedOutPath, { flags: 'w', mode: PRIVATE_FILE_MODE });
      for (const item of globalBuffer) {
        try {
          if (item.obj) {
            let outObj = args.parseMessage ? tryParseNestedJsonFields(item.obj, args.rawFields) : item.obj;
            if (args.redactSecrets) outObj = redactSecrets(outObj);
            outStream.write(`${JSON.stringify(outObj, null, 2)},\n`);
          } else {
            const raw = args.redactSecrets ? redactFreeText(item.line) : item.line;
            outStream.write(`${JSON.stringify({ raw }, null, 2)},\n`);
          }
        } catch {
          const raw = args.redactSecrets ? redactFreeText(item.line) : item.line;
          outStream.write(`${JSON.stringify({ raw }, null, 2)},\n`);
        }
      }
      await new Promise((resolve, reject) => {
        outStream.end();
        outStream.on('finish', resolve);
        outStream.on('error', reject);
      });
    }
  }

  if (failed > 0 || manifest.lines.timeUnverified) {
    manifest.status = 'incomplete';
    console.log(`Incomplete: ${failed} object scan(s) failed; ${manifest.lines.timeUnverified} candidate timestamp(s) unverified.`);
  } else {
    manifest.status = 'complete';
    console.log('Completed successfully.');
  }
  writeManifest(args.outDir, manifest);
  return manifest;
}

if (require.main === module) {
  run()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      const message = err instanceof ValidationError
        ? (/^Invalid (calendar )?date:/.test(err.message) ? 'Invalid date. Expected YYYY-MM-DD.' : err.message)
        : 'Log fetch failed; check the local output directory and selected source.';
      console.error(message);
      process.exitCode = 1;
    });
}

module.exports = {
  applyDefaultDateRange,
  buildScopedArgs,
  buildTextSelectExpression,
  parseArgs,
  parseS3Url,
  resolveDateList,
  run,
  runForScope,
  substitutePlaceholder,
  trySelectMatchingLines,
};
