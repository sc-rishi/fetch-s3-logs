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
const readline = require('readline');
const { pipeline } = require('stream');
const { promisify } = require('util');
const zlib = require('zlib');
const { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const pipe = promisify(pipeline);

// Hardcoded AWS environment for this job/script
process.env.AWS_PROFILE = 'smallcase';
process.env.AWS_SDK_LOAD_CONFIG = '1';
process.env.AWS_REGION = 'ap-south-1';
process.env.AWS_DEFAULT_REGION = 'ap-south-1';

// Script-level defaults (can be edited directly instead of passing CLI flags)
const DEFAULTS = {
  S3_URL: 's3://sc-pm2logs-new/PROD/2025-11-20/sc-integrations-broker-api/',
  OUT_DIR: './logs',
  IST: true,
  FROM: '2025-11-20T13:00:00',
  TO: '2025-11-20T15:00:00',
  FILTER_TEXT: undefined, // e.g. 'hdfcsky'
  FILTER_FIELD: 'broker=hdfcsky, brokerName=hdfcsky', // string, comma-separated, or array of 'k=v'
  CONCURRENCY: 4,
  SORT: 'nf', // 'nf' | 'of' (new first | old first)
  CI: false, // case-insensitive matching for text and field
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
      '  --region <aws-region>      Ignored. Region is hardcoded to ap-south-1.',
      '  --concurrency <n>          Parallel downloads (default: 4)',
      '  --raw-field <a,b,c>        Comma-separated field names to try for raw logs (default: raw,message,msg,log)',
      '  --start-after <key>        Start after this key when listing (optional)',
      '  --max-keys <n>             Max keys per list page (default: 1000)',
      '  --dir <name>               Only include this first-level subdirectory under the prefix',
      '  --from <ISO|epochMs>       Filter lines whose JSON "time" >= this',
      '  --to <ISO|epochMs>         Filter lines whose JSON "time" <= this',
      '  --ist                      Interpret --from/--to as IST (UTC+05:30)',
      '  --filter-text <substr>     Create an additional filtered copy with lines containing this substring',
      '  --filter-field <k=v>       Create an additional filtered copy with lines where JSON field k===v',
      '                              Supports expressions like: key1=val1 and key2=val2 or key3=val3',
      '                              (repeatable; repeats OR with expression result)',
      '  --sort <nf|of>             Optional: sort by JSON "time" (nf=new first, of=old first)',
      '  --ci                       Case-insensitive matching for --filter-text and --filter-field',
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
      '',
      'Notes:',
      '  - This script writes ONLY a filtered output file per S3 object.',
      '  - If no filters are provided, all lines are included into the filtered file.',
      '  - JSON lines are pretty-printed. Non-JSON lines are wrapped as {"raw": "..."} and pretty-printed.',
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

function parseArgs(argv) {
  const args = {
    s3Url: undefined,
    bucket: undefined,
    prefix: '',
    outDir: undefined,
    region: undefined,
    concurrency: 4,
    rawFields: ['raw', 'message', 'msg', 'log'],
    startAfter: undefined,
    maxKeys: 1000,
    dir: undefined,
    from: undefined,
    to: undefined,
    filterText: undefined,
    filterFields: [],
    filterFieldExprClauses: [],
    ist: false,
    sort: undefined,
    ci: undefined,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') printHelpAndExit(0);
    if (a === '--s3-url') args.s3Url = argv[++i];
    else if (a === '--bucket') args.bucket = argv[++i];
    else if (a === '--prefix') args.prefix = argv[++i] || '';
    else if (a === '--out') args.outDir = argv[++i];
    else if (a === '--region') args.region = argv[++i];
    else if (a === '--concurrency') args.concurrency = Number(argv[++i] || '4');
    else if (a === '--raw-field') {
      const v = argv[++i] || '';
      args.rawFields = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--start-after') args.startAfter = argv[++i];
    else if (a === '--max-keys') args.maxKeys = Number(argv[++i] || '1000');
    else if (a === '--dir') args.dir = argv[++i];
    else if (a === '--from') args.from = argv[++i];
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--filter-text') args.filterText = argv[++i];
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
    else if (a === '--sort') {
      const mode = String(argv[++i] || '').toLowerCase();
      if (mode === 'nf' || mode === 'of') args.sort = mode;
      else console.warn('Ignoring --sort: expected "nf" or "of"');
    } else if (a === '--ci') args.ci = true;
    else {
      console.warn(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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
  if (firstSlash === -1) return { bucket: withoutScheme, prefix: '' };
  const bucket = withoutScheme.slice(0, firstSlash);
  let prefix = withoutScheme.slice(firstSlash + 1);
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
  if (!assumeIST) {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  // If input has explicit timezone (Z or +/-hh:mm), honor it directly
  if (/[zZ]$/.test(input) || /[+\-]\d{2}:\d{2}$/.test(input)) {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  // Parse naive "YYYY-MM-DDTHH:mm[:ss]" as IST and convert to UTC
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]); // 1-12
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = m[6] ? Number(m[6]) : 0;
    // IST (UTC+05:30) -> UTC
    const utcMs = Date.UTC(year, month - 1, day, hour - 5, minute - 30, second, 0);
    return new Date(utcMs);
  }
  // Fallback to Date parse then shift (best-effort)
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return undefined;
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  return new Date(d.getTime() - IST_OFFSET_MS);
}

function parseKeyValue(spec) {
  if (!spec || typeof spec !== 'string') return [undefined, undefined];
  const eq = spec.indexOf('=');
  if (eq <= 0) return [undefined, undefined];
  const k = spec.slice(0, eq);
  const v = spec.slice(eq + 1);
  return [k, v];
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

async function writeRawLogsFromStreamToFile(readable, outFilePath, shouldGunzip) {
  const outStream = fs.createWriteStream(outFilePath, { flags: 'w' });
  const source = shouldGunzip ? readable.pipe(zlib.createGunzip()) : readable;
  await pipe(source, outStream);
}

async function writeFilteredLogsFromStreamToFile(readable, outFilePath, shouldGunzip, filterText, filterFieldSpecs, fromDate, toDate, sortMode, caseInsensitive, filterFieldExprClauses) {
  return new Promise((resolve, reject) => {
    let outStream;
    let matches = 0;
    const buffer = sortMode ? [] : null;
    const createOut = () => {
      if (outStream) return;
      outStream = fs.createWriteStream(outFilePath, { flags: 'w' });
      outStream.on('error', reject);
      outStream.on('finish', () => resolve(matches));
    };
    const source = shouldGunzip ? readable.pipe(zlib.createGunzip()) : readable;
    const rl = readline.createInterface({ input: source });
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
    rl.on('line', (line) => {
      // Time filter using obj.time (UTC). If from/to are not provided, skip time check.
      const includeByTime = true;
      const hasTimeFilter = !!fromDate || !!toDate;
      let parsedObj;
      if (hasTimeFilter) {
        try {
          parsedObj = JSON.parse(line);
          const t = parsedObj && parsedObj.time;
          if (!t) return; // missing time => exclude when time filter requested
          const tDate = new Date(t);
          if (Number.isNaN(tDate.getTime())) return;
          if (fromDate && tDate < fromDate) return;
          if (toDate && tDate > toDate) return;
        } catch {
          return;
        }
      }

      // Content filters (OR)
      const hasFieldSpecs = Array.isArray(filterFieldSpecs) && filterFieldSpecs.length > 0;
      const hasFieldExpr = Array.isArray(filterFieldExprClauses) && filterFieldExprClauses.length > 0;
      const hasContentFilter = !!filterText || hasFieldSpecs || hasFieldExpr;
      let textMatch = false;
      if (filterText) {
        if (caseInsensitive) {
          textMatch = String(line).toLowerCase().includes(String(filterText).toLowerCase());
        } else {
          textMatch = String(line).includes(filterText);
        }
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
      if (!(includeByTime && includeByContent)) return;

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
          const obj = parsedObj ?? JSON.parse(line);
          outStream.write(`${JSON.stringify(obj, null, 2)},\n`);
        } catch {
          const wrapped = { raw: line };
          outStream.write(`${JSON.stringify(wrapped, null, 2)},\n`);
        }
        matches += 1;
      }
    });
    rl.on('close', () => {
      if (buffer) {
        if (buffer.length === 0) {
          resolve(0);
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
              outStream.write(`${JSON.stringify(item.obj, null, 2)},\n`);
            } else {
              const wrapped = { raw: item.line };
              outStream.write(`${JSON.stringify(wrapped, null, 2)},\n`);
            }
          } catch {
            const wrapped = { raw: item.line };
            outStream.write(`${JSON.stringify(wrapped, null, 2)},\n`);
          }
        }
        outStream.end();
      } else if (outStream) {
        outStream.end();
      } else {
        resolve(matches); // no matches -> no file created
      }
    });
    rl.on('error', reject);
  });
}

async function processObject(s3, bucket, key, outDir, rawFields, filterText, filterFieldSpecs, fromDate, toDate, sortMode, caseInsensitive, filterFieldExprClauses) {
  const rawOutPath = computeOutputPath(outDir, key);
  const outDirName = path.dirname(rawOutPath);
  ensureDir(outDirName);
  const filteredOut = computeFilteredOutputPath(rawOutPath);
  console.log(`Processing s3://${bucket}/${key} -> ${filteredOut}`);

  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bodyStream = resp.Body;
  const shouldGunzip =
    looksLikeGzipKey(key) ||
    (resp.ContentEncoding && String(resp.ContentEncoding).toLowerCase().includes('gzip')) ||
    (resp.ContentType && String(resp.ContentType).toLowerCase().includes('gzip'));

  // Always write ONLY filtered/prettified output (if no filters provided, include all lines)
  const matched = await writeFilteredLogsFromStreamToFile(
    bodyStream,
    filteredOut,
    shouldGunzip,
    filterText,
    filterFieldSpecs,
    fromDate,
    toDate,
    sortMode,
    caseInsensitive,
    filterFieldExprClauses
  );
  if (!matched) {
    console.log(`No matching lines in s3://${bucket}/${key}; skipping file creation.`);
  }
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
    const resp = await s3.send(new ListObjectsV2Command(params));
    const contents = resp.Contents || [];
    for (const item of contents) {
      if (item && item.Key) {
        // skip "directory" placeholders
        if (item.Key.endsWith('/')) continue;
        items.push({
          key: item.Key,
          lastModified: item.LastModified ? new Date(item.LastModified) : undefined,
        });
      }
    }
    if (!resp.IsTruncated) break;
    continuationToken = resp.NextContinuationToken;
    isFirst = false;
  }
  return items;
}

async function run() {
  const args = parseArgs(process.argv);

  // Apply script-level defaults if not provided via CLI
  if (!args.s3Url && DEFAULTS.S3_URL) args.s3Url = DEFAULTS.S3_URL;
  if (!args.outDir && DEFAULTS.OUT_DIR) args.outDir = DEFAULTS.OUT_DIR;
  if (args.ist === false && DEFAULTS.IST) args.ist = true;
  if (!args.from && DEFAULTS.FROM) args.from = DEFAULTS.FROM;
  if (!args.to && DEFAULTS.TO) args.to = DEFAULTS.TO;
  if (!args.filterText && DEFAULTS.FILTER_TEXT) args.filterText = DEFAULTS.FILTER_TEXT;
  if (args.filterFields.length === 0 && DEFAULTS.FILTER_FIELD) {
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
  if (!args.sort && DEFAULTS.SORT && (DEFAULTS.SORT === 'nf' || DEFAULTS.SORT === 'of')) {
    args.sort = DEFAULTS.SORT;
  }
  if (args.ci === undefined && typeof DEFAULTS.CI === 'boolean') {
    args.ci = DEFAULTS.CI;
  }

  if ((!args.s3Url && !args.bucket) || !args.outDir) {
    console.error('Error: S3 URL/bucket and output directory are required.');
    process.exit(1);
  }

  // Resolve bucket/prefix from --s3-url if provided
  if (args.s3Url) {
    const parsed = parseS3Url(args.s3Url);
    if (!parsed) {
      console.error('Invalid --s3-url. Expected format: s3://bucket/prefix/');
      process.exit(1);
    }
    args.bucket = parsed.bucket;
    args.prefix = parsed.prefix || '';
  }

  ensureDir(args.outDir);

  const s3 = new S3Client({
    region: 'ap-south-1',
  });

  console.log(
    `Listing objects in bucket=${args.bucket} prefix=${args.prefix ? args.prefix : '(none)'} ...`
  );
  const allItems = await listAllObjects({
    s3,
    bucket: args.bucket,
    prefix: args.prefix,
    startAfter: args.startAfter,
    maxKeys: args.maxKeys,
  });
  if (!allItems.length) {
    console.log('No objects found.');
    return;
  }
  // Apply directory filter only at object level. Time filtering is done per line using JSON "time".
  const fromDate = parseDateWithIST(args.from, args.ist);
  const toDate = parseDateWithIST(args.to, args.ist);
  const filtered = allItems.filter((it) => {
    // Directory filter: match first segment under prefix
    if (args.dir) {
      const rel = it.key.startsWith(args.prefix) ? it.key.slice(args.prefix.length) : it.key;
      const firstSeg = rel.split('/')[0] || '';
      if (firstSeg !== args.dir) return false;
    }
    return true;
  });
  if (!filtered.length) {
    console.log('No objects matched the filters.');
    return;
  }
  console.log(`Found ${filtered.length} object(s) after filtering. Starting download with concurrency=${args.concurrency} ...`);

  // Simple concurrency control
  let inFlight = 0;
  let idx = 0;
  let failed = 0;
  await new Promise((resolve) => {
    const maybeStartNext = () => {
      while (inFlight < args.concurrency && idx < filtered.length) {
        const { key } = filtered[idx++];
        inFlight += 1;
        processObject(
          s3,
          args.bucket,
          key,
          args.outDir,
          args.rawFields,
          args.filterText,
          args.filterFields,
          fromDate,
          toDate,
          args.sort,
          !!args.ci,
          args.filterFieldExprClauses
        )
          .catch((err) => {
            failed += 1;
            console.error(`Failed for key=${key}:`, err && err.message ? err.message : err);
          })
          .finally(() => {
            inFlight -= 1;
            if (idx >= filtered.length && inFlight === 0) resolve();
            else maybeStartNext();
          });
      }
    };
    maybeStartNext();
  });

  if (failed > 0) {
    console.log(`Completed with ${failed} failure(s).`);
  } else {
    console.log('Completed successfully.');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});



