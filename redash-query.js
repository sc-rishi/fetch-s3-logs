#!/usr/bin/env node
/**
 * Query the prod Mongo DB (orders, users, activations, sips, placedOrders, ...) via Redash's
 * ad-hoc query API — this is the org's only sanctioned path to prod DB access.
 *
 * Flow (Redash API): POST /api/query_results (submit) -> poll GET /api/jobs/:id -> GET
 * /api/query_results/:id (fetch). See SBI_LOG_INVESTIGATION_GUIDE.md for why you'd want this
 * alongside fetch-by-identifier.js — logs show what happened over time, this shows the
 * document's current state (status, meta.updates, meta.source, etc) directly.
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
      '  --broker <sbi|sbi-mtf> broker field equals this',
      '  --status <value>       status field equals this',
      '  --from <YYYY-MM-DD>    date field >= this (IST-assumed midnight)',
      '  --to <YYYY-MM-DD>      date field <= this (IST-assumed end of day)',
      '',
      'Escape hatch:',
      '  --match \'<json>\'       raw MongoDB $match filter object, merged with any shortcuts above',
      '  --limit <n>            adds a $limit pipeline stage',
      '',
      'Output:',
      '  --out <file>           write full raw JSON result here instead of printing rows to stdout',
      '  --raw                  print the full Redash response (columns + rows) instead of just row data',
      '',
      'Config (from .env or env vars): REDASH_URL, REDASH_API_KEY, REDASH_DATA_SOURCE_ID',
    ].join('\n')
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = { limit: undefined };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') printHelpAndExit(0);
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
    else if (a === '--raw') args.raw = true;
    else console.warn(`Unknown argument: ${a}`);
  }
  return args;
}

// IST midnight / end-of-day, expressed as UTC ISO (IST = UTC+5:30)
function istDayStartUTC(dateStr) {
  return new Date(`${dateStr}T00:00:00+05:30`).toISOString();
}
function istDayEndUTC(dateStr) {
  return new Date(`${dateStr}T23:59:59.999+05:30`).toISOString();
}

function buildMatch(args) {
  const clauses = [];
  if (args.match) {
    try {
      clauses.push(JSON.parse(args.match));
    } catch (e) {
      console.error(`Error: --match is not valid JSON: ${e.message}`);
      process.exit(1);
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

function httpRequest(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
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
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse response from ${url}: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runRedashQuery(queryObj) {
  const body = JSON.stringify({
    query: JSON.stringify(queryObj),
    data_source_id: Number(REDASH_DATA_SOURCE_ID),
    max_age: 0,
  });
  const submitResp = await httpRequest('POST', `${REDASH_URL}/api/query_results`, { body });

  // A cache hit (max_age satisfied) returns query_result directly; otherwise a job to poll.
  if (submitResp.query_result) return submitResp.query_result;

  const jobId = submitResp.job.id;
  const POLL_INTERVAL_MS = 800;
  // orders.tag/unplaced.tag have no index (confirmed empirically: a 30-day-bounded tag query took
  // ~44s, 60-day timed out at the old 48s ceiling) — give real queries enough headroom rather than
  // fail right at the boundary of a query that would have succeeded a few seconds later.
  const MAX_POLLS = 150; // ~120s
  for (let i = 0; i < MAX_POLLS; i += 1) {
    const jobResp = await httpRequest('GET', `${REDASH_URL}/api/jobs/${jobId}`);
    const { status, query_result_id: queryResultId, error } = jobResp.job;
    if (status === 3) {
      const resultResp = await httpRequest('GET', `${REDASH_URL}/api/query_results/${queryResultId}`);
      return resultResp.query_result;
    }
    if (status === 4) {
      throw new Error(`Redash query failed: ${error || 'unknown error'}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Redash query did not complete within ${(MAX_POLLS * POLL_INTERVAL_MS) / 1000}s (job ${jobId})`);
}

function isConfigured() {
  return Boolean(REDASH_URL && REDASH_API_KEY && REDASH_DATA_SOURCE_ID);
}

/**
 * Find the `date` field of the first matching order, bounded to the last `lookbackDays` days so
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
async function findOrderAnchorDate({ tag, orderId, batchId, lookbackDays = 30 } = {}) {
  if (!isConfigured()) return { date: null, reason: 'redash-not-configured' };
  const to = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const from = fromDate.toISOString().slice(0, 10);
  const args = { tag, orderId, batchId };
  // batchId is already a precise single-document lookup — no date bound needed/helpful there,
  // but this helper is only meant to be called for tag/order-id, so bound defensively regardless.
  if (!batchId) Object.assign(args, { from, to });
  const match = buildMatch(args);
  const queryObj = { collection: 'orders', aggregate: [{ $match: match }, { $limit: 1 }], allowDiskUse: true };
  const result = await runRedashQuery(queryObj);
  const rows = (result.data && result.data.rows) || [];
  if (!rows.length || !rows[0].date) return { date: null, reason: 'not-found-in-lookback-window', lookbackDays };
  return { date: new Date(rows[0].date), reason: 'found' };
}

// orders.tag/unplaced.tag are unindexed (confirmed empirically: cost scales with date-range width
// — 30d~44s, 60d+ times out even with a 120s poll ceiling; fully unbounded would scan the whole
// production collection). This is the org's only sanctioned path to prod DB access, so the CLI
// refuses this case rather than let it silently run long or get retried into worse load.
function requiresDateBound(args) {
  return Boolean((args.tag || args.orderId) && !args.batchId && !(args.from || args.to));
}

async function main() {
  const args = parseArgs(process.argv);
  if (!isConfigured()) {
    console.error('Error: REDASH_URL, REDASH_API_KEY, REDASH_DATA_SOURCE_ID must be set (.env or env vars).');
    process.exit(1);
  }
  if (!args.collection) {
    console.error('Error: --collection is required.');
    process.exit(1);
  }
  if (requiresDateBound(args)) {
    console.error('Error: --tag/--order-id without --batch-id requires --from and/or --to.');
    console.error('These fields are unindexed and live inside arrays — an unbounded query is a full');
    console.error('collection scan on production. Use search-s3-logs.js if you don\'t know the date; it');
    console.error('resolves one via a tiered bounded lookup (see SBI_LOG_INVESTIGATION_GUIDE.md §3).');
    process.exit(1);
  }

  const match = buildMatch(args);
  const pipeline = [{ $match: match }];
  if (args.limit) pipeline.push({ $limit: args.limit });
  const queryObj = { collection: args.collection, aggregate: pipeline, allowDiskUse: true };

  console.error(`Querying collection=${args.collection}, match=${JSON.stringify(match)}${args.limit ? `, limit=${args.limit}` : ''}`);

  const result = await runRedashQuery(queryObj);
  const rows = (result.data && result.data.rows) || [];
  console.error(`${rows.length} row(s) returned.`);

  const output = args.raw ? result : rows;
  const text = JSON.stringify(output, null, 2);

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, text);
    console.error(`Written to ${args.out}`);
  } else {
    console.log(text);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  buildMatch,
  findOrderAnchorDate,
  isConfigured,
  istDayEndUTC,
  istDayStartUTC,
  parseArgs,
  requiresDateBound,
  runRedashQuery,
};
