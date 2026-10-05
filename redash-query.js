#!/usr/bin/env node
/**
 * Query the prod Mongo DB (orders, users, activations, sips, placedOrders, ...) via Redash's
 * ad-hoc query API — this is the org's only sanctioned path to prod DB access.
 *
 * Flow (Redash API): POST /api/query_results (submit) -> poll GET /api/jobs/:id -> GET
 * /api/query_results/:id (fetch). CLI output is a conservative evidence projection; raw rows
 * remain in memory only while the query runs.
 *
 * Config: reads REDASH_URL / REDASH_API_KEY / REDASH_DATA_SOURCE_ID from .env (gitignored) in
 * this directory, or the same-named environment variables.
 *
 * Usage:
 *   node redash-query.js --collection orders --batch-id 6a221fb2d963eea6efaeabfa
 *   node redash-query.js --collection orders --tag sc_rXWoyJfoH
 *   node redash-query.js --collection orders --order-id 26060500005371
 *   node redash-query.js --collection orders --tag scmtf_xxx --broker sbi-mtf --from 2026-09-01 --to 2026-09-20
 *   node redash-query.js --collection orders --match '{"broker":"sbi","status":"ERROR"}' --limit 20
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const { loadEvidenceOptions, projectEvidence, safeError, safeTimestamp } = require('./safe-evidence');

const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 100;
const MAX_UNINDEXED_LOOKUP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const QUERY_TIMEOUT_MS = 120 * 1000;
const POLL_INTERVAL_MS = 800;
const MATCH_OPERATORS = new Set([
  '$and', '$or', '$nor', '$eq', '$ne', '$in', '$nin', '$gt', '$gte', '$lt', '$lte',
  '$exists', '$elemMatch', '$oid', '$date',
]);

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

const REDASH_URL = process.env.REDASH_URL;
const REDASH_API_KEY = process.env.REDASH_API_KEY;
const REDASH_DATA_SOURCE_ID = process.env.REDASH_DATA_SOURCE_ID;

function printHelpAndExit(code) {
  console.log(
    [
      'Query prod Mongo via Redash ad-hoc query API.',
      '',
      'Required: --collection <name> (e.g. orders, users, activations, sips, placedOrders, jobs)',
      '',
      'Identifier shortcuts (combine freely, all AND\'d together; omit for a bare --match query):',
      '  --tag <value>          orders.tag OR unplaced.tag equals this (orders collection)',
      '  --batch-id <value>     _id OR batchId equals this (orders collection)',
      '  --order-id <value>     orders/unplaced .orderId OR .exchangeOrderId equals this (orders collection)',
      '  --broker <name>        broker field equals this',
      '  --status <value>       status field equals this',
      '  --from <YYYY-MM-DD>    date field >= this (IST-assumed midnight)',
      '  --to <YYYY-MM-DD>      date field <= this (IST-assumed end of day)',
      '',
      'Escape hatch:',
      '  --match \'<json>\'       raw MongoDB $match filter object, merged with any shortcuts above',
      `  --limit <n>            maximum rows (default ${DEFAULT_RESULT_LIMIT}, max ${MAX_RESULT_LIMIT})`,
      '',
      'Output:',
      '  --out <file>           write sanitized evidence rows instead of printing them',
      '  --evidence-spec <file>  source-cited field rules for typed safe evidence',
      '  --validated-enums <file>  source-derived event/status/code allowlist for safe evidence',
      '',
      'Config (from .env or env vars): REDASH_URL, REDASH_API_KEY, REDASH_DATA_SOURCE_ID',
    ].join('\n')
  );
  process.exit(code);
}

function parseArgs(argv, onHelp = () => printHelpAndExit(0)) {
  const args = { limit: DEFAULT_RESULT_LIMIT };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') onHelp();
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Missing CLI option value.');
    else if (a === '--collection') args.collection = argv[++i];
    else if (a === '--tag') args.tag = argv[++i];
    else if (a === '--batch-id') args.batchId = argv[++i];
    else if (a === '--order-id') args.orderId = argv[++i];
    else if (a === '--broker') args.broker = argv[++i];
    else if (a === '--status') args.status = argv[++i];
    else if (a === '--from') args.from = argv[++i];
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--match') args.match = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--evidence-spec') args.evidenceSpecPath = argv[++i];
    else if (a === '--validated-enums') args.validatedEnumsPath = argv[++i];
    else throw new Error('Unsupported argument. Use --help for accepted options.');
  }
  return args;
}

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Expected a YYYY-MM-DD calendar date.');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid calendar date.');
  }
  return date;
}

function validateDateRange(args) {
  const from = args.from ? calendarDate(args.from) : null;
  const to = args.to ? calendarDate(args.to) : null;
  if (from && to && from > to) throw new Error('--from must not follow --to.');
  return { from, to };
}

function validAnchorDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    try { return calendarDate(value); } catch { return null; }
  }
  const timestamp = safeTimestamp(value);
  return timestamp ? new Date(timestamp) : null;
}

// IST midnight / end-of-day, expressed as UTC ISO (IST = UTC+5:30)
function istDayStartUTC(dateStr) {
  calendarDate(dateStr);
  return new Date(`${dateStr}T00:00:00+05:30`).toISOString();
}
function istDayEndUTC(dateStr) {
  calendarDate(dateStr);
  return new Date(`${dateStr}T23:59:59.999+05:30`).toISOString();
}

function buildMatch(args) {
  validateDateRange(args);
  const clauses = [];
  if (args.match) {
    try {
      clauses.push(JSON.parse(args.match));
    } catch {
      throw new Error('--match must contain a valid JSON object.');
    }
  }
  if (args.tag) {
    clauses.push({ $or: [{ 'orders.tag': args.tag }, { 'unplaced.tag': args.tag }] });
  }
  if (args.batchId) {
    const oidClause = /^[0-9a-fA-F]{24}$/.test(args.batchId) ? { _id: { $oid: args.batchId } } : null;
    const orClauses = [{ batchId: args.batchId }];
    if (oidClause) orClauses.push(oidClause);
    clauses.push({ $or: orClauses });
  }
  if (args.orderId) {
    clauses.push({
      $or: [
        { 'orders.orderId': args.orderId },
        { 'unplaced.orderId': args.orderId },
        { 'orders.exchangeOrderId': args.orderId },
        { 'unplaced.exchangeOrderId': args.orderId },
      ],
    });
  }
  if (args.broker) clauses.push({ broker: args.broker });
  if (args.status) clauses.push({ status: args.status });
  if (args.from || args.to) {
    const dateClause = {};
    if (args.from) dateClause.$gte = { $date: istDayStartUTC(args.from) };
    if (args.to) dateClause.$lte = { $date: istDayEndUTC(args.to) };
    clauses.push({ date: dateClause });
  }
  if (!clauses.length) return {};
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

function protocolError() {
  const error = new Error('Redash returned a malformed response.');
  error.name = 'RedashProtocolError';
  return error;
}

function timeoutError() {
  const error = new Error('Redash request timed out.');
  error.name = 'RequestTimeout';
  return error;
}

function validateQueryResult(result) {
  if (!result || typeof result !== 'object' || !result.data ||
      !Array.isArray(result.data.rows) ||
      result.data.rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw protocolError();
  }
  return result;
}

function httpRequest(method, url, { headers = {}, body, deadline, transport = https.request } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') {
      reject(new Error('Redash requires HTTPS.'));
      return;
    }
    const timeLeft = Math.min(REQUEST_TIMEOUT_MS, deadline ? deadline - Date.now() : REQUEST_TIMEOUT_MS);
    if (timeLeft <= 0) { reject(timeoutError()); return; }
    const req = transport(
      {
        method,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers: {
          Authorization: `Key ${REDASH_API_KEY}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          clearTimeout(timer);
          if (res.statusCode >= 400) {
            const error = new Error('Redash request failed.');
            error.name = 'RedashHttpError';
            reject(error);
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(protocolError());
          }
        });
        res.on('error', () => { clearTimeout(timer); reject(protocolError()); });
      }
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy(timeoutError());
    }, timeLeft);
    req.on('error', (error) => {
      clearTimeout(timer);
      if (timedOut || error.name === 'RequestTimeout') reject(timeoutError());
      else {
        const networkError = new Error('Redash connection failed.');
        networkError.name = 'NetworkError';
        reject(networkError);
      }
    });
    if (body) req.write(body);
    req.end();
  });
}

function validateMatch(match) {
  if (!match || typeof match !== 'object' || Array.isArray(match) || !Object.keys(match).length) {
    throw new Error('A nonempty $match object is required.');
  }
  for (const [key, value] of Object.entries(match)) {
    if (key.startsWith('$') && !MATCH_OPERATORS.has(key)) throw new Error('Unsupported match operator.');
    if (key === '$date') {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) ||
          new Date(value).toISOString() !== value) throw new Error('Invalid $date value.');
    }
    if (key === '$oid' && (typeof value !== 'string' || !/^[0-9a-fA-F]{24}$/.test(value))) {
      throw new Error('Invalid $oid value.');
    }
    if (Array.isArray(value)) {
      if (!value.length || value.length > MAX_RESULT_LIMIT) throw new Error('Match array is empty or too large.');
      value.forEach((entry) => { if (entry && typeof entry === 'object') validateMatch(entry); });
    } else if (value && typeof value === 'object') {
      validateMatch(value);
    }
  }
}

function validateReadOnlyQuery(queryObj) {
  const allowedKeys = new Set(['collection', 'aggregate', 'allowDiskUse']);
  if (!queryObj || Object.keys(queryObj).some((key) => !allowedKeys.has(key)) ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(queryObj.collection || '')) {
    throw new Error('A supported collection and aggregate query are required.');
  }
  const pipeline = queryObj.aggregate;
  if (!Array.isArray(pipeline) || pipeline.length < 2 || pipeline.length > 3 ||
      !pipeline[0] || !Object.hasOwn(pipeline[0], '$match')) {
    throw new Error('Query must start with $match and end with $limit.');
  }
  validateMatch(pipeline[0].$match);
  for (const stage of pipeline) {
    const entries = Object.entries(stage || {});
    if (entries.length !== 1 || !['$match', '$project', '$limit'].includes(entries[0][0])) {
      throw new Error('Only read-only aggregate stages are supported.');
    }
  }
  for (const stage of pipeline.slice(1, -1)) {
    const [operator, fields] = Object.entries(stage)[0];
    if (operator !== '$project' || !fields || typeof fields !== 'object' || Array.isArray(fields) ||
        !Object.keys(fields).length || Object.values(fields).some((value) => ![0, 1].includes(value))) {
      throw new Error('Only simple $project stages are supported.');
    }
  }
  const limit = pipeline[pipeline.length - 1].$limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULT_LIMIT) {
    throw new Error('A bounded $limit is required.');
  }
}

async function runRedashQuery(queryObj, {
  request = httpRequest, now = Date.now,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
} = {}) {
  validateReadOnlyQuery(queryObj);
  const deadline = now() + QUERY_TIMEOUT_MS;
  const call = async (method, suffix, options = {}) => {
    if (now() >= deadline) throw timeoutError();
    const response = await request(method, `${REDASH_URL}${suffix}`, { ...options, deadline });
    if (now() > deadline) throw timeoutError();
    return response;
  };
  const body = JSON.stringify({
    query: JSON.stringify(queryObj),
    data_source_id: Number(REDASH_DATA_SOURCE_ID),
    max_age: 0,
  });
  const submitResp = await call('POST', '/api/query_results', { body });

  // A cache hit (max_age satisfied) returns query_result directly; otherwise a job to poll.
  if (!submitResp || typeof submitResp !== 'object') throw protocolError();
  if (submitResp.query_result != null) return validateQueryResult(submitResp.query_result);

  const jobId = submitResp.job?.id;
  if (!/^[A-Za-z0-9_-]+$/.test(String(jobId || ''))) throw protocolError();
  while (now() < deadline) {
    const jobResp = await call('GET', `/api/jobs/${jobId}`);
    const { status, query_result_id: queryResultId } = jobResp?.job || {};
    if (status === 3) {
      if (!/^[A-Za-z0-9_-]+$/.test(String(queryResultId || ''))) throw protocolError();
      const resultResp = await call('GET', `/api/query_results/${queryResultId}`);
      return validateQueryResult(resultResp?.query_result);
    }
    if (status === 4) throw new Error('Redash query failed.');
    if (status !== 1 && status !== 2) throw protocolError();
    await sleep(Math.min(POLL_INTERVAL_MS, deadline - now()));
  }
  throw timeoutError();
}

function isConfigured() {
  return Boolean(REDASH_URL && REDASH_API_KEY && REDASH_DATA_SOURCE_ID);
}

/**
 * Find the `date` field of an unambiguous matching order, bounded to the last `lookbackDays` days so
 * this can never become the unbounded-scan the CLI's --tag/--order-id guard rejects. Used by
 * search-s3-logs.js to get a real anchor date before scoping an S3 search, when the caller didn't
 * supply one. Returns null if nothing matched.
 *
 * lookbackDays default is deliberately small (30, not months) — orders.tag/unplaced.tag are NOT
 * indexed, so cost scales with the date range scanned (empirically: 7d~20s, 14d~24s, 30d~44s,
 * 60d+ unreliable even with a 120s poll ceiling). search-s3-logs.js's resolveAnchorDate() tiers
 * this call (7 -> 14 -> 30 days) rather than passing a single wide bound, so each attempt stays
 * in the fast, reliable range and only widens when the narrower one truly found nothing.
 */
async function findOrderAnchorDate({ tag, orderId, batchId, lookbackDays = 30 } = {},
  { configured = isConfigured, query = runRedashQuery } = {}) {
  if (!tag && !orderId && !batchId) throw new Error('An order identifier is required.');
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 30) {
    throw new Error('lookbackDays must be between 1 and 30.');
  }
  if (!configured()) return { date: null, reason: 'redash-not-configured' };
  const to = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const from = fromDate.toISOString().slice(0, 10);
  const args = { tag, orderId, batchId };
  // batchId is already a precise single-document lookup — no date bound needed/helpful there,
  // but this helper is only meant to be called for tag/order-id, so bound defensively regardless.
  if (!batchId) Object.assign(args, { from, to });
  const match = buildMatch(args);
  const queryObj = {
    collection: 'orders',
    aggregate: [{ $match: match }, { $project: { date: 1, _id: 0 } }, { $limit: 2 }],
    allowDiskUse: true,
  };
  const rows = validateQueryResult(await query(queryObj)).data.rows;
  if (rows.length > 1) return { date: null, reason: 'ambiguous', lookbackDays };
  if (!rows.length) return { date: null, reason: 'not-found-in-lookback-window', lookbackDays };
  const date = validAnchorDate(rows[0].date);
  if (!date) return { date: null, reason: 'invalid-date', lookbackDays };
  return { date, reason: 'found' };
}

async function checkRedashConnectivity({ configured = isConfigured, query = runRedashQuery } = {}) {
  if (!configured()) return { status: 'failed', reason: 'redash-not-configured' };
  const readOnlyQuery = {
    collection: 'orders',
    aggregate: [
      { $match: { $and: [{ _id: { $exists: true } }, { _id: { $exists: false } }] } },
      { $project: { _id: 0 } },
      { $limit: 1 },
    ],
  };
  try {
    if (validateQueryResult(await query(readOnlyQuery)).data.rows.length) throw protocolError();
    return { status: 'verified', reason: 'read-only-query-succeeded' };
  } catch (error) {
    return { status: 'failed', reason: safeError(error) };
  }
}

// orders.tag/unplaced.tag are unindexed (confirmed empirically: cost scales with date-range width
// — 30d~44s, 60d+ times out even with a 120s poll ceiling; fully unbounded would scan the whole
// production collection). This is the org's only sanctioned path to prod DB access, so the CLI
// refuses this case rather than let it silently run long or get retried into worse load.
function requiresDateBound(args) {
  if (!(args.tag || args.orderId) || args.batchId) return false;
  if (!args.from || !args.to) return true;
  try {
    const { from, to } = validateDateRange(args);
    return (to - from) / DAY_MS >= MAX_UNINDEXED_LOOKUP_DAYS;
  } catch {
    return true;
  }
}

async function main({ argv = process.argv, configured = isConfigured, query = runRedashQuery } = {}) {
  const args = parseArgs(argv);
  if (!configured()) {
    console.error('Error: REDASH_URL, REDASH_API_KEY, REDASH_DATA_SOURCE_ID must be set (.env or env vars).');
    process.exit(1);
  }
  if (!args.collection) {
    console.error('Error: --collection is required.');
    process.exit(1);
  }
  if (requiresDateBound(args)) {
    console.error('Error: --tag/--order-id without --batch-id requires both valid --from and --to within 30 days.');
    console.error('These fields are unindexed and live inside arrays — an unbounded query is a full');
    console.error('collection scan on production. Use search-s3-logs.js if you don\'t know the date; it');
    console.error('resolves one via a tiered bounded lookup; check its coverage manifest.');
    process.exit(1);
  }

  const match = buildMatch(args);
  const evidenceOptions = loadEvidenceOptions(args);
  const pipeline = [{ $match: match }];
  pipeline.push({ $limit: args.limit });
  const queryObj = { collection: args.collection, aggregate: pipeline, allowDiskUse: true };

  console.error('Submitting bounded read-only Redash query.');

  const result = await query(queryObj);
  const rows = validateQueryResult(result).data.rows;
  console.error(`${rows.length} row(s) returned.`);

  const identifiers = [args.tag, args.batchId, args.orderId].filter(Boolean);
  const queryValue = identifiers.length === 1 ? identifiers[0] : undefined;
  const output = rows.map((row) => projectEvidence(row, {
    ...evidenceOptions, sourceAlias: args.collection, queryValue,
  }));
  const text = JSON.stringify(output, null, 2);

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true, mode: 0o700 });
    fs.writeFileSync(args.out, text, { mode: 0o600, flag: 'wx' });
    console.error('Sanitized evidence file written.');
  } else {
    console.log(text);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(safeError(err));
    process.exit(1);
  });
}

module.exports = {
  buildMatch,
  checkRedashConnectivity,
  DEFAULT_RESULT_LIMIT,
  findOrderAnchorDate,
  httpRequest,
  isConfigured,
  istDayEndUTC,
  istDayStartUTC,
  loadEnvFile,
  main,
  MAX_RESULT_LIMIT,
  parseArgs,
  requiresDateBound,
  runRedashQuery,
  validateReadOnlyQuery,
};
