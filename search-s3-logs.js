#!/usr/bin/env node

/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { StringDecoder } = require('string_decoder');
const zlib = require('zlib');
const {
  GetObjectCommand,
  S3Client,
  SelectObjectContentCommand,
} = require('@aws-sdk/client-s3');
const {
  forEachConcurrent,
  listCommonPrefixes,
  listObjects,
  mapConcurrent,
  writeJson,
} = require('./s3-search-utils');

process.env.AWS_PROFILE = process.env.AWS_PROFILE || 'smallcase';
process.env.AWS_SDK_LOAD_CONFIG = '1';
process.env.AWS_REGION = process.env.AWS_REGION || 'ap-south-1';

const DEFAULT_CONCURRENCY = 16;
const MAX_CONCURRENCY = 50;
const DEFAULT_SEARCH_DAYS = 30;
const WRITE_BUFFER_BYTES = 1024 * 1024;
// orders.tag/unplaced.tag are unindexed in Mongo — cost scales with date-range width (empirically:
// 7d~20s, 14d~24s, 30d~44s, 60d+ unreliable). Tier the Redash anchor-lookup itself for the same
// reason the S3 search is tiered: try cheap/fast first, only widen if it found nothing. 30 days is
// also the system's existing cap on any explicit --from/--to window, so this doesn't reach further
// back than a user could already reach by hand.
const REDASH_LOOKBACK_TIERS_DAYS = [7, 14, 30];
// Auto-scope tiers for when no --date/--from-to/--month is given and the identifier is a
// tag/order-id/batch-id: start as narrow as plausible, widen only if the narrower tier found
// nothing. Biased forward (daysForward > daysBack) because a delayed update/fix appears AFTER
// placement, essentially never before it.
const AUTO_SCOPE_TIERS = [
  { label: 'tier1_3d', daysBack: 1, daysForward: 2 },
  { label: 'tier2_9d', daysBack: 1, daysForward: 7 },
  { label: 'tier3_17d', daysBack: 1, daysForward: 15 },
  { label: 'tier4_30d_max', daysBack: 1, daysForward: DEFAULT_SEARCH_DAYS - 2 },
];
const APP_SERVICES = {
  'order-updates': {
    ec2Name: 'sc-integrations-order-updates',
    eksNamespace: 'integrations',
    eksPod: 'sc-integrations-order-updates-pod',
  },
  'broker-api': {
    ec2Name: 'sc-integrations-broker-api',
    eksNamespace: 'integrations',
    eksPod: 'sc-integrations-broker-api-pod',
  },
  'platform-api': {
    ec2Name: 'sc-platform-api',
    eksNamespace: 'platform',
    eksPod: 'sc-platform-api-pod',
  },
  jobs: { ec2Name: 'sc-integrations-jobs' },
};
const SERVICE_KEYS = [...Object.keys(APP_SERVICES), 'jobs-recon'];
const RAW_LINE_CSV = {
  FileHeaderInfo: 'NONE',
  RecordDelimiter: '\n',
  FieldDelimiter: '\t',
  QuoteCharacter: '\r',
  QuoteEscapeCharacter: '\r',
};

class ValidationError extends Error {}
class SelectFallbackError extends Error {}

function help() {
  console.log([
    'Search service logs by identifier or literal text.',
    '',
    'Usage:',
    '  node fetch-by-identifier.js --service order-updates --tag sc_xxx --date 2026-06-05',
    '  node fetch-by-identifier.js --service order-updates --tag sc_xxx',
    '  node fetch-by-identifier.js --service order-updates --text "broker action - orderStatus"',
    '',
    'Search (exactly one required):',
    '  --tag <value>',
    '  --order-id <value>',
    '  --batch-id <value>',
    '  --text <literal>',
    '',
    `Required: --service <list|all> (${SERVICE_KEYS.join(', ')})`,
    '',
    'Optional date scope (--date / --from+--to / --month) — if omitted for --tag/--order-id/',
    '--batch-id, the real order date is looked up automatically (instant local decode for',
    `--batch-id, a tiered Redash lookup for --tag/--order-id trying the last ${REDASH_LOOKBACK_TIERS_DAYS.join('/')} days`,
    'in turn), then the search starts at a narrow window around that date and widens in tiers only',
    `if empty (up to ${DEFAULT_SEARCH_DAYS} days max). Omitted for --text: flat latest-${DEFAULT_SEARCH_DAYS}-days window.`,
    '  --date <YYYY-MM-DD>',
    '  --from <YYYY-MM-DD> --to <YYYY-MM-DD>    (max 30 days)',
    '  --month <YYYY-MM>',
    '',
    'Options:',
    '  --job-name <name>      Required for jobs-recon',
    '  --env <prod|staging>   Default: prod',
    '  --out <dir>            Default: ./logs/lookup-<kind>-<timestamp>',
    `  --concurrency <n>      Default: ${DEFAULT_CONCURRENCY}; maximum: ${MAX_CONCURRENCY}`,
    '  --help',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = { env: 'prod', concurrency: DEFAULT_CONCURRENCY };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help' || option === '-h') return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new ValidationError(`Missing value for ${option}`);
    if (option === '--tag') args.tag = value;
    else if (option === '--order-id') args.orderId = value;
    else if (option === '--batch-id') args.batchId = value;
    else if (option === '--text') args.text = value;
    else if (option === '--date') args.date = value;
    else if (option === '--from') args.from = value;
    else if (option === '--to') args.to = value;
    else if (option === '--month') args.month = value;
    else if (option === '--service') args.service = value;
    else if (option === '--job-name') args.jobName = value;
    else if (option === '--env') args.env = value;
    else if (option === '--out') args.out = value;
    else if (option === '--concurrency') args.concurrency = Number(value);
    else throw new ValidationError(`Unknown option: ${option}`);
    index += 1;
  }
  return validateArgs(args);
}

function validateArgs(args) {
  const identifiers = ['tag', 'orderId', 'batchId', 'text'].filter((key) => args[key]);
  if (identifiers.length !== 1) {
    throw new ValidationError('Pass exactly one of --tag, --order-id, --batch-id, or --text.');
  }
  if (!args.service) {
    throw new ValidationError(`--service is required. Choose one or more of: ${SERVICE_KEYS.join(', ')}, or all.`);
  }
  if (!['prod', 'staging'].includes(args.env)) {
    throw new ValidationError('--env must be prod or staging.');
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > MAX_CONCURRENCY) {
    throw new ValidationError(`--concurrency must be an integer from 1 to ${MAX_CONCURRENCY}.`);
  }
  args.services = resolveServices(args.service);
  if (args.services.includes('jobs-recon') && !args.jobName) {
    throw new ValidationError('--service jobs-recon requires --job-name.');
  }
  args.query = { kind: identifiers[0], value: args[identifiers[0]] };
  args.dateScope = args.date || args.month || args.from ? 'explicit' : `latest-${DEFAULT_SEARCH_DAYS}-days`;
  args.dates = buildDateList(args);
  return args;
}

function resolveServices(serviceArg) {
  const services = serviceArg === 'all'
    ? SERVICE_KEYS.slice()
    : serviceArg.split(',').map((value) => value.trim()).filter(Boolean);
  const invalid = services.filter((service) => !SERVICE_KEYS.includes(service));
  if (!services.length || invalid.length) {
    throw new ValidationError(`Invalid --service value. Valid choices: ${SERVICE_KEYS.join(', ')}, or all.`);
  }
  return [...new Set(services)];
}

function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) throw new ValidationError(`Invalid date: ${value}. Expected YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`Invalid calendar date: ${value}.`);
  }
  return date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function dateRange(from, to) {
  const current = parseIsoDate(from);
  const end = parseIsoDate(to);
  if (current > end) throw new ValidationError('--from must not be after --to.');
  const dates = [];
  while (current <= end) {
    dates.push(formatDate(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function buildDateList(args) {
  if (!!args.from !== !!args.to) throw new ValidationError('--from and --to must be supplied together.');
  const selectors = [args.date, args.month, args.from && args.to].filter(Boolean);
  if (selectors.length > 1) throw new ValidationError('Use only one of --date, --from/--to, or --month.');
  if (args.date) return [formatDate(parseIsoDate(args.date))];
  if (args.from) {
    const dates = dateRange(args.from, args.to);
    if (dates.length > DEFAULT_SEARCH_DAYS) {
      throw new ValidationError(`--from/--to may cover at most ${DEFAULT_SEARCH_DAYS} days.`);
    }
    return dates;
  }
  if (!args.month) {
    const today = istDate(new Date());
    const start = parseIsoDate(today);
    start.setUTCDate(start.getUTCDate() - (DEFAULT_SEARCH_DAYS - 1));
    return dateRange(formatDate(start), today);
  }
  const match = /^(\d{4})-(\d{2})$/.exec(args.month);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
    throw new ValidationError('--month must be YYYY-MM.');
  }
  const lastDay = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
  const dates = dateRange(`${args.month}-01`, `${args.month}-${String(lastDay).padStart(2, '0')}`);
  if (dates.length > DEFAULT_SEARCH_DAYS) {
    throw new ValidationError(`--month ${args.month} contains more than ${DEFAULT_SEARCH_DAYS} days; use a <=30-day --from/--to range.`);
  }
  return dates;
}

// A Mongo ObjectId's first 4 bytes (8 hex chars) are a Unix timestamp (seconds) — batchId IS the
// order document's _id (`order._id = order.batchId`, sc-integrations-babel/src/models/Order.js:33),
// so this recovers the order's real creation date with zero network calls and zero scan risk.
function decodeObjectIdDate(value) {
  if (!/^[0-9a-fA-F]{24}$/.test(value || '')) return null;
  const seconds = parseInt(value.slice(0, 8), 16);
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Inclusive date list from (anchor - daysBack) to (anchor + daysForward), never past "today" in
// IST (future S3 date-partitions cannot exist yet).
function datesAroundAnchor(anchor, daysBack, daysForward) {
  const start = new Date(anchor);
  start.setUTCDate(start.getUTCDate() - daysBack);
  const end = new Date(anchor);
  end.setUTCDate(end.getUTCDate() + daysForward);
  const todayIst = parseIsoDate(istDate(new Date()));
  if (end > todayIst) end.setTime(todayIst.getTime());
  if (start > end) return [];
  return dateRange(formatDate(start), formatDate(end));
}

function buildSources(services, env, jobName) {
  const sources = [];
  for (const service of services) {
    if (service === 'jobs-recon') {
      sources.push({
        service,
        surface: `${service}/${jobName}`,
        bucket: 'sc-prod-logs',
        dated: false,
        prefix: `sc-integrations-jobs/${jobName}`,
        forceGzip: true,
        filterLineDate: true,
      });
      continue;
    }
    const config = APP_SERVICES[service];
    if (config.eksPod) {
      const eksEnv = env === 'prod' ? 'production' : 'staging';
      sources.push({
        service,
        surface: `${service}/eks`,
        bucket: 'sc-eks-pod-logs',
        dated: true,
        dateRoot: `${eksEnv}/`,
        prefixForDate: (date) => `${eksEnv}/${date}/${config.eksNamespace}/${config.eksPod}/`,
      });
    }
    if (env === 'prod') {
      for (const directory of ['Out-logs', 'Error-logs']) {
        sources.push({
          service,
          surface: `${service}/ec2/${directory === 'Out-logs' ? 'out' : 'err'}`,
          bucket: 'sc-pm2logs-new',
          dated: true,
          dateRoot: 'PROD/',
          prefixForDate: (date) => `PROD/${date}/${config.ec2Name}/${directory}/`,
        });
      }
    }
  }
  return sources;
}

function dateFromPrefix(prefix, root) {
  const value = prefix.slice(root.length).split('/')[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

async function datesForSource(s3, source, cache) {
  const cacheKey = `${source.bucket}/${source.dateRoot}`;
  if (!cache.has(cacheKey)) {
    const prefixes = await listCommonPrefixes(s3, { bucket: source.bucket, prefix: source.dateRoot });
    cache.set(cacheKey, prefixes.map((prefix) => dateFromPrefix(prefix, source.dateRoot)).filter(Boolean));
  }
  return cache.get(cacheKey);
}

async function listSourceObjects(s3, source, dates, concurrency, dateCache) {
  if (!source.dated) {
    const objects = await listObjects(s3, { bucket: source.bucket, prefix: source.prefix });
    return objects.map((object) => ({ ...object, source }));
  }
  const datesToList = dates || await datesForSource(s3, source, dateCache);
  const listed = await mapConcurrent(datesToList, Math.min(concurrency, 16), async (date) => {
    const prefix = source.prefixForDate(date);
    const objects = await listObjects(s3, { bucket: source.bucket, prefix });
    return objects.map((object) => ({ ...object, date, source }));
  });
  return listed.flat();
}

async function discoverObjects(s3, sources, dates, concurrency) {
  const dateCache = new Map();
  const listed = [];
  for (const source of sources) {
    console.log(`Listing ${source.surface}${dates ? ` for ${dates.length} date(s)` : ' for complete history'}...`);
    listed.push(...await listSourceObjects(s3, source, dates, concurrency, dateCache));
  }
  const unique = new Map();
  for (const object of listed) unique.set(`${object.bucket}/${object.key}`, object);
  return [...unique.values()];
}

function escapeLikeLiteral(value) {
  return String(value).toLowerCase().replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildSelectExpression(value) {
  const pattern = sqlString(`%${escapeLikeLiteral(value)}%`);
  return `SELECT * FROM S3Object s WHERE LOWER(s._1) LIKE ${pattern} ESCAPE '!' OR CHAR_LENGTH(s._2) > 0`;
}

function isGzipObject(object) {
  return object.source.forceGzip || /\.(gz|gzip)$/i.test(object.key);
}

function parseOutputRecords(output) {
  if (!output.trim()) return [];
  return output.trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

class BufferedFileWriter {
  constructor(filePath, handle) {
    this.filePath = filePath;
    this.handle = handle;
    this.parts = [];
    this.bytes = 0;
  }

  static async create(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return new BufferedFileWriter(filePath, await fs.promises.open(filePath, 'w'));
  }

  async write(value) {
    this.parts.push(value);
    this.bytes += Buffer.byteLength(value);
    if (this.bytes >= WRITE_BUFFER_BYTES) await this.flush();
  }

  async flush() {
    if (!this.parts.length) return;
    const output = this.parts.join('');
    this.parts = [];
    this.bytes = 0;
    await this.handle.writeFile(output);
  }

  async close() {
    await this.flush();
    await this.handle.close();
  }
}

function lineTime(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed.time || null;
  } catch {
    return null;
  }
}

function istDate(timestamp) {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return null;
  return new Date(value.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

function lineIsInScope(line, object, dateSet) {
  if (!object.source.filterLineDate || !dateSet) return true;
  const timestamp = lineTime(line);
  if (timestamp) return dateSet.has(istDate(timestamp));
  if (!object.lastModified) return false;
  return dateSet.has(istDate(object.lastModified));
}

async function writeSelectedRecord(recordText, writer, state, object, needle, dateSet) {
  if (!recordText.trim()) return;
  const record = JSON.parse(recordText);
  if (record._2 !== undefined && String(record._2).length > 0) {
    state.tabCollision = true;
    return;
  }
  const line = record._1;
  if (typeof line !== 'string' || !line.toLowerCase().includes(needle)) return;
  if (!lineIsInScope(line, object, dateSet)) return;
  await writer.write(`${line}\n`);
  state.lineCount += 1;
}

async function selectObject(s3, object, searchValue, dateSet, matchPath) {
  const response = await s3.send(new SelectObjectContentCommand({
    Bucket: object.bucket,
    Key: object.key,
    Expression: buildSelectExpression(searchValue),
    ExpressionType: 'SQL',
    InputSerialization: {
      CompressionType: isGzipObject(object) ? 'GZIP' : 'NONE',
      CSV: RAW_LINE_CSV,
    },
    OutputSerialization: { JSON: { RecordDelimiter: '\n' } },
  }));

  const writer = await BufferedFileWriter.create(matchPath);
  const decoder = new StringDecoder('utf8');
  const state = { ended: false, lineCount: 0, stats: null, tabCollision: false };
  let pending = '';
  try {
    for await (const event of response.Payload || []) {
      if (event.Records?.Payload) {
        pending += decoder.write(Buffer.from(event.Records.Payload));
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
          await writeSelectedRecord(pending.slice(0, newline), writer, state, object, searchValue.toLowerCase(), dateSet);
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
      }
      if (event.Stats?.Details) state.stats = event.Stats.Details;
      if (event.End) state.ended = true;
    }
    pending += decoder.end();
    await writeSelectedRecord(pending, writer, state, object, searchValue.toLowerCase(), dateSet);
  } finally {
    await writer.close();
  }

  const scanned = Number(state.stats?.BytesScanned);
  if (!state.ended || !state.stats || (Number.isFinite(object.size) && scanned < object.size)) {
    throw new SelectFallbackError('S3 Select response was incomplete.');
  }
  if (state.tabCollision) {
    throw new SelectFallbackError('Unexpected tab-delimited record detected.');
  }
  return { lineCount: state.lineCount, stats: state.stats };
}

async function localScanObject(s3, object, searchValue, dateSet, matchPath) {
  const response = await s3.send(new GetObjectCommand({ Bucket: object.bucket, Key: object.key }));
  const writer = await BufferedFileWriter.create(matchPath);
  const gzipHeader = [response.ContentEncoding, response.ContentType]
    .filter(Boolean).join(' ').toLowerCase().includes('gzip');
  const input = isGzipObject(object) || gzipHeader ? response.Body.pipe(zlib.createGunzip()) : response.Body;
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  const needle = searchValue.toLowerCase();
  let lineCount = 0;
  try {
    for await (const line of reader) {
      if (!line.toLowerCase().includes(needle) || !lineIsInScope(line, object, dateSet)) continue;
      await writer.write(`${line}\n`);
      lineCount += 1;
    }
  } finally {
    await writer.close();
  }
  return lineCount;
}

function isAuthError(error) {
  return ['AccessDenied', 'CredentialsProviderError', 'ExpiredToken', 'InvalidAccessKeyId', 'SignatureDoesNotMatch']
    .includes(error?.name || error?.Code);
}

function removeFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function linesFromFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content ? content.replace(/\n$/, '').split('\n') : [];
}

async function scanObject(s3, object, searchValue, dateSet, requestedMatchPath) {
  const ownDirectory = requestedMatchPath ? null : fs.mkdtempSync(path.join(os.tmpdir(), 's3-log-scan-'));
  const matchPath = requestedMatchPath || path.join(ownDirectory, 'matches.jsonl');
  const finish = (result) => {
    if (!ownDirectory || result.method === 'failed') return result;
    const withLines = { ...result, lines: linesFromFile(matchPath) };
    fs.rmSync(ownDirectory, { recursive: true, force: true });
    delete withLines.matchPath;
    return withLines;
  };
  const fallback = async (reason) => {
    removeFile(matchPath);
    try {
      const lineCount = await localScanObject(s3, object, searchValue, dateSet, matchPath);
      return finish({ object, method: 'fallback', matchPath, lineCount, selectError: reason });
    } catch (fallbackError) {
      removeFile(matchPath);
      if (ownDirectory) fs.rmSync(ownDirectory, { recursive: true, force: true });
      return {
        object,
        method: 'failed',
        fatal: isAuthError(fallbackError),
        error: `${reason}; GetObject fallback: ${fallbackError.message}`,
      };
    }
  };

  try {
    const selected = await selectObject(s3, object, searchValue, dateSet, matchPath);
    return finish({ object, method: 'select', matchPath, lineCount: selected.lineCount, stats: selected.stats });
  } catch (selectError) {
    if (isAuthError(selectError)) {
      removeFile(matchPath);
      if (ownDirectory) fs.rmSync(ownDirectory, { recursive: true, force: true });
      return { object, method: 'failed', fatal: true, error: `S3 Select: ${selectError.message}` };
    }
    return fallback(`S3 Select: ${selectError.message}`);
  }
}

function parseLog(line) {
  try {
    const log = JSON.parse(line);
    if (typeof log.message === 'string') {
      try { log.message = JSON.parse(log.message); } catch { /* literal message */ }
    }
    return log;
  } catch {
    return { raw: line };
  }
}

function matchEntry(result, line) {
  return {
    s3Uri: `s3://${result.object.bucket}/${result.object.key}`,
    service: result.object.source.service,
    surface: result.object.source.surface,
    objectLastModified: result.object.lastModified?.toISOString() || null,
    time: lineTime(line),
    log: parseLog(line),
  };
}

function writeMatches(outputDir, matches) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonl = matches.map((match) => JSON.stringify(match)).join('\n');
  fs.writeFileSync(path.join(outputDir, 'matches.jsonl'), jsonl ? `${jsonl}\n` : '');
  const compatible = matches.map((match) => `${JSON.stringify(match.log, null, 2)},`).join('\n');
  fs.writeFileSync(path.join(outputDir, 'all-logs.filtered.log'), compatible ? `${compatible}\n` : '');
}

async function appendMatchFile(result, matchesWriter, compatibleWriter) {
  const reader = readline.createInterface({
    input: fs.createReadStream(result.matchPath),
    crlfDelay: Infinity,
  });
  let count = 0;
  for await (const line of reader) {
    const match = matchEntry(result, line);
    await matchesWriter.write(`${JSON.stringify(match)}\n`);
    await compatibleWriter.write(`${JSON.stringify(match.log, null, 2)},\n`);
    count += 1;
  }
  return count;
}

function addManifestError(manifest, error) {
  if (manifest.errors.length < 100) manifest.errors.push(error);
  else manifest.errorDetailsTruncated = true;
}

function createManifest(args, sources, outputDir) {
  return {
    status: 'running',
    snapshotStartedAt: new Date().toISOString(),
    completedAt: null,
    outputDir,
    query: { ...args.query, caseInsensitive: true, literal: true },
    scope: {
      services: args.services,
      environment: args.env,
      dateScope: args.dateScope,
      dates: args.dates,
      jobName: args.jobName || null,
    },
    sources: sources.map(({ surface, bucket, dateRoot, prefix }) => ({ surface, bucket, root: dateRoot || prefix })),
    objects: { listed: 0, scanned: 0, selected: 0, fallback: 0, failed: 0, matched: 0 },
    lines: { matched: 0 },
    bytes: { scanned: 0, processed: 0, returned: 0, fallbackDownloaded: 0 },
    matchedKeys: [],
    fallbacks: [],
    errors: [],
  };
}

async function runSearch(args, dependencies = {}) {
  const outputDir = path.resolve(args.out || path.join(__dirname, 'logs', `lookup-${args.query.kind}-${Date.now()}`));
  const sources = buildSources(args.services, args.env, args.jobName);
  const manifest = createManifest(args, sources, outputDir);
  const s3 = dependencies.s3 || new S3Client({ region: process.env.AWS_REGION, maxAttempts: 5 });
  fs.mkdirSync(outputDir, { recursive: true });

  let objects;
  try {
    objects = await discoverObjects(s3, sources, args.dates, args.concurrency);
  } catch (error) {
    manifest.status = 'incomplete';
    manifest.completedAt = new Date().toISOString();
    addManifestError(manifest, { phase: 'listing', error: error.message });
    writeMatches(outputDir, []);
    writeJson(path.join(outputDir, 'manifest.json'), manifest);
    console.error(`Listing failed: ${error.message}`);
    return 2;
  }

  manifest.objects.listed = objects.length;
  console.log(`Searching ${objects.length.toLocaleString()} object(s) with concurrency=${args.concurrency}...`);
  const dateSet = args.dates ? new Set(args.dates) : null;
  const matchedKeys = new Set();
  let completed = 0;
  let fatalError;
  const temporaryDirectory = path.join(outputDir, '.scan-tmp');
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  const matchesWriter = await BufferedFileWriter.create(path.join(outputDir, 'matches.jsonl'));
  const compatibleWriter = await BufferedFileWriter.create(path.join(outputDir, 'all-logs.filtered.log'));
  let outputQueue = Promise.resolve();
  let outputError;

  const recordResult = async (result) => {
    const s3Uri = `s3://${result.object.bucket}/${result.object.key}`;
    if (result.method === 'failed' || result.method === 'skipped') {
      manifest.objects.failed += 1;
      addManifestError(manifest, { s3Uri, error: result.error });
      return;
    }
    let written;
    try {
      written = await appendMatchFile(result, matchesWriter, compatibleWriter);
      if (written !== result.lineCount) throw new Error(`Expected ${result.lineCount} matches but wrote ${written}.`);
    } catch (error) {
      outputError = error;
      fatalError = `Output write failed: ${error.message}`;
      manifest.objects.failed += 1;
      addManifestError(manifest, { s3Uri, error: fatalError });
      return;
    }
    manifest.objects.scanned += 1;
    if (result.method === 'select') {
      manifest.objects.selected += 1;
      manifest.bytes.scanned += Number(result.stats.BytesScanned) || 0;
      manifest.bytes.processed += Number(result.stats.BytesProcessed) || 0;
      manifest.bytes.returned += Number(result.stats.BytesReturned) || 0;
    } else {
      manifest.objects.fallback += 1;
      manifest.bytes.fallbackDownloaded += Number(result.object.size) || 0;
      if (manifest.fallbacks.length < 100) manifest.fallbacks.push({ s3Uri, reason: result.selectError });
    }
    if (written) matchedKeys.add(s3Uri);
    manifest.lines.matched += written;
  };

  await forEachConcurrent(objects, args.concurrency, async (object, index) => {
    let result;
    if (fatalError) {
      result = { object, method: 'skipped', error: `Skipped after fatal error: ${fatalError}` };
    } else {
      const matchPath = path.join(temporaryDirectory, `${index}.jsonl`);
      try {
        result = await scanObject(s3, object, args.query.value, dateSet, matchPath);
      } catch (error) {
        result = { object, method: 'failed', fatal: isAuthError(error), error: error.message };
      }
      if (result.fatal) fatalError = result.error;
    }
    const queued = outputQueue.then(() => recordResult(result));
    outputQueue = queued.catch(() => {});
    await queued;
    if (result.matchPath) removeFile(result.matchPath);
    completed += 1;
    if (completed % 100 === 0 || completed === objects.length) {
      console.log(`Scanned ${completed.toLocaleString()}/${objects.length.toLocaleString()} objects.`);
    }
  });
  await outputQueue;
  const closeResults = await Promise.allSettled([matchesWriter.close(), compatibleWriter.close()]);
  for (const closeResult of closeResults) {
    if (closeResult.status !== 'rejected') continue;
    outputError = closeResult.reason;
    addManifestError(manifest, { phase: 'output', error: closeResult.reason.message });
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });

  manifest.objects.matched = matchedKeys.size;
  manifest.matchedKeys = [...matchedKeys].sort();
  manifest.fallbackDetailsTruncated = manifest.objects.fallback > manifest.fallbacks.length;
  manifest.completedAt = new Date().toISOString();
  manifest.status = manifest.objects.scanned === manifest.objects.listed && !outputError ? 'complete' : 'incomplete';
  writeJson(path.join(outputDir, 'manifest.json'), manifest);

  console.log(JSON.stringify({
    status: manifest.status,
    listedObjects: manifest.objects.listed,
    scannedObjects: manifest.objects.scanned,
    fallbackObjects: manifest.objects.fallback,
    failedObjects: manifest.objects.failed,
    matchedObjects: manifest.objects.matched,
    matchedLines: manifest.lines.matched,
    outputDir,
  }, null, 2));
  return manifest.status === 'complete' ? 0 : 2;
}

function mergeJsonlInto(targetPath, sourcePath) {
  if (!fs.existsSync(sourcePath)) return;
  const content = fs.readFileSync(sourcePath, 'utf8');
  if (!content) return;
  fs.appendFileSync(targetPath, content);
}

// Resolve an anchor Date with zero S3/Redash cost for --batch-id (ObjectId-embedded timestamp),
// or via a bounded Redash lookup for --tag/--order-id. Returns { anchor: Date|null, note }.
async function resolveAnchorDate(args, dependencies) {
  if (args.query.kind === 'batchId') {
    const anchor = decodeObjectIdDate(args.query.value);
    return anchor ? { anchor, note: 'batchId-objectid-timestamp' } : { anchor: null, note: 'batchId-not-a-valid-objectid' };
  }
  const redash = dependencies.redash || require('./redash-query');
  if (!redash.isConfigured()) return { anchor: null, note: 'redash-not-configured' };
  const field = args.query.kind === 'tag' ? { tag: args.query.value } : { orderId: args.query.value };
  // orders.tag/unplaced.tag are unindexed — a single wide-bound lookup is slow/unreliable
  // (empirically: 30d~44s, 60d+ times out). Tier the lookback itself, same philosophy as the S3
  // search below: try the cheapest bound first, widen only if it truly found nothing.
  let lastReason = 'redash-lookup-empty';
  for (const lookbackDays of REDASH_LOOKBACK_TIERS_DAYS) {
    const lookup = await redash.findOrderAnchorDate({ ...field, lookbackDays });
    if (lookup.date) {
      const anchor = lookup.date instanceof Date ? lookup.date : new Date(lookup.date);
      if (!Number.isNaN(anchor.getTime())) return { anchor, note: `redash-lookup-${lookbackDays}d` };
      lastReason = 'redash-lookup-invalid-date';
      break;
    }
    lastReason = lookup.reason || lastReason;
  }
  return { anchor: null, note: lastReason };
}

async function runAutoSearch(args, dependencies = {}) {
  const outputDir = path.resolve(args.out || path.join(__dirname, 'logs', `lookup-${args.query.kind}-${Date.now()}`));
  const { anchor, note } = await resolveAnchorDate(args, dependencies);

  if (!anchor) {
    if (note === 'not-found-in-lookback-window') {
      fs.mkdirSync(outputDir, { recursive: true });
      const manifest = {
        status: 'not_found_in_db',
        query: args.query,
        note: `No matching order found via Redash within the last ${REDASH_LOOKBACK_TIERS_DAYS[REDASH_LOOKBACK_TIERS_DAYS.length - 1]} days. Not scanning S3 ` +
          'blindly on a guess — if you know this is older, pass an explicit --date/--from+--to/--month.',
        completedAt: new Date().toISOString(),
      };
      writeJson(path.join(outputDir, 'manifest.json'), manifest);
      console.log(JSON.stringify(manifest, null, 2));
      return 3;
    }
    // redash unreachable/unconfigured, or a malformed batch-id: fall back to the flat default
    // window (identical to the pre-auto-scope behavior) rather than failing outright.
    console.log(`No anchor date available (${note}); falling back to the flat latest-${DEFAULT_SEARCH_DAYS}-days window.`);
    return runSearch(args, dependencies);
  }

  console.log(`Anchor date resolved: ${formatDate(anchor)} (${note}). Starting narrow, widening only if empty...`);
  const triedDates = new Set();
  const tierSummaries = [];
  let finalExitCode = 0;
  let matchedSoFar = 0;

  for (const [tierIndex, tier] of AUTO_SCOPE_TIERS.entries()) {
    const tierDates = datesAroundAnchor(anchor, tier.daysBack, tier.daysForward);
    const newDates = tierDates.filter((date) => !triedDates.has(date));
    newDates.forEach((date) => triedDates.add(date));
    if (!newDates.length) {
      tierSummaries.push({ ...tier, newDates: [], matched: 0, skipped: 'no-new-dates' });
      continue;
    }

    const tierDir = path.join(outputDir, `.tier-${tierIndex}`);
    console.log(`[${tier.label}] searching ${newDates.length} new date(s): ${newDates[0]}..${newDates[newDates.length - 1]}`);
    const tierArgs = { ...args, dates: newDates, out: tierDir };
    finalExitCode = await runSearch(tierArgs, dependencies);
    const tierManifest = JSON.parse(fs.readFileSync(path.join(tierDir, 'manifest.json'), 'utf8'));

    mergeJsonlInto(path.join(outputDir, 'matches.jsonl'), path.join(tierDir, 'matches.jsonl'));
    mergeJsonlInto(path.join(outputDir, 'all-logs.filtered.log'), path.join(tierDir, 'all-logs.filtered.log'));
    matchedSoFar += tierManifest.objects?.matched || 0;
    tierSummaries.push({ ...tier, newDates, matched: tierManifest.objects?.matched || 0, status: tierManifest.status });

    const isLastTier = tierIndex === AUTO_SCOPE_TIERS.length - 1;
    if (matchedSoFar > 0 || isLastTier) {
      fs.rmSync(tierDir, { recursive: true, force: true });
      break;
    }
    fs.rmSync(tierDir, { recursive: true, force: true });
  }

  const manifest = {
    status: finalExitCode === 0 ? 'complete' : 'incomplete',
    query: args.query,
    anchor: { date: formatDate(anchor), note },
    tiers: tierSummaries,
    totalDatesSearched: [...triedDates].sort(),
    totalMatched: matchedSoFar,
    completedAt: new Date().toISOString(),
    outputDir,
  };
  writeJson(path.join(outputDir, 'manifest.json'), manifest);
  console.log(JSON.stringify({
    status: manifest.status,
    anchorDate: manifest.anchor.date,
    tiersRun: tierSummaries.filter((t) => !t.skipped).length,
    totalDatesSearched: manifest.totalDatesSearched.length,
    totalMatched: matchedSoFar,
    outputDir,
  }, null, 2));
  return finalExitCode;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  if (args.help) { help(); return 0; }
  const autoScopeEligible = args.dateScope !== 'explicit' && ['tag', 'orderId', 'batchId'].includes(args.query.kind);
  return autoScopeEligible ? runAutoSearch(args, dependencies) : runSearch(args, dependencies);
}

async function cli() {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error(`Error: ${error.message}`);
      console.error(`Valid services: ${SERVICE_KEYS.join(', ')}, or all.`);
    } else {
      console.error(`Log search failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) cli();

module.exports = {
  AUTO_SCOPE_TIERS,
  ValidationError,
  buildDateList,
  buildSelectExpression,
  buildSources,
  cli,
  datesAroundAnchor,
  decodeObjectIdDate,
  discoverObjects,
  escapeLikeLiteral,
  lineIsInScope,
  main,
  parseArgs,
  parseOutputRecords,
  resolveAnchorDate,
  runAutoSearch,
  runSearch,
  scanObject,
};
