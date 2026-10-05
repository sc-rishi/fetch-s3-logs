#!/usr/bin/env node
/**
 * Query staging Mongo (orders, users, activations, sips, placedOrders, ...) directly via the
 * official Node driver. Staging is not prod — this bypasses Redash, the org's sanctioned path
 * to PROD Mongo only (see redash-query.js); staging has no such restriction. Same filter
 * shortcuts, read-only pipeline validation, and evidence projection as redash-query.js, reused
 * directly rather than duplicated.
 *
 * Config: reads MONGO_STAGING_URL from .env (gitignored) in this directory, or the same-named
 * environment variable.
 *
 * Usage:
 *   node mongo-query.js --collection orders --batch-id 6a221fb2d963eea6efaeabfa
 *   node mongo-query.js --collection orders --tag sc_rXWoyJfoH
 *   node mongo-query.js --collection orders --order-id 26060500005371
 *   node mongo-query.js --collection orders --tag scmtf_xxx --broker sbi-mtf --from 2026-09-01 --to 2026-09-20
 *   node mongo-query.js --collection orders --match '{"broker":"sbi","status":"ERROR"}' --limit 20
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const { EJSON } = require('bson');
const { loadEvidenceOptions, projectEvidence, safeError } = require('./safe-evidence');
const {
  buildMatch, DEFAULT_RESULT_LIMIT, loadEnvFile, MAX_RESULT_LIMIT, parseArgs, requiresDateBound,
  validateReadOnlyQuery,
} = require('./redash-query');

loadEnvFile();

const MONGO_STAGING_URL = process.env.MONGO_STAGING_URL;
const CONNECT_TIMEOUT_MS = 15 * 1000;

function printHelpAndExit(code) {
  console.log(
    [
      'Query staging Mongo directly (official driver) — not prod; see redash-query.js for prod.',
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
      'Config (from .env or env var): MONGO_STAGING_URL',
    ].join('\n')
  );
  process.exit(code);
}

function isConfigured() {
  return Boolean(MONGO_STAGING_URL);
}

// queryObj's $match uses the same MongoDB Extended JSON shortcuts as Redash's query language
// ({$oid: ...}, {$date: ...}); EJSON.deserialize turns those into real ObjectId/Date instances
// for the driver. Stages outside that shape (e.g. {$match: ...}, {$exists: true}) pass through
// unchanged. Read-only enforcement is validateReadOnlyQuery's stage whitelist, not a connection
// option — the configured credential's own grants are not assumed to be read-only.
async function runMongoQuery(queryObj, { url = MONGO_STAGING_URL } = {}) {
  validateReadOnlyQuery(queryObj);
  const client = new MongoClient(url, {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    readPreference: 'secondaryPreferred',
  });
  try {
    await client.connect();
    const { collection, aggregate: pipeline, allowDiskUse } = EJSON.deserialize(queryObj);
    const rows = await client.db().collection(collection).aggregate(pipeline, { allowDiskUse }).toArray();
    return { data: { rows } };
  } finally {
    await client.close();
  }
}

async function checkMongoStagingConnectivity({ configured = isConfigured, query = runMongoQuery } = {}) {
  if (!configured()) return { status: 'failed', reason: 'mongo-staging-not-configured' };
  const readOnlyQuery = {
    collection: 'orders',
    aggregate: [
      { $match: { $and: [{ _id: { $exists: true } }, { _id: { $exists: false } }] } },
      { $project: { _id: 0 } },
      { $limit: 1 },
    ],
  };
  try {
    const result = await query(readOnlyQuery);
    if (result.data.rows.length) {
      const error = new Error('Mongo returned a malformed response.');
      error.name = 'MongoProtocolError';
      throw error;
    }
    return { status: 'verified', reason: 'read-only-query-succeeded' };
  } catch (error) {
    return { status: 'failed', reason: safeError(error) };
  }
}

async function main({ argv = process.argv, configured = isConfigured, query = runMongoQuery } = {}) {
  const args = parseArgs(argv, () => printHelpAndExit(0));
  if (!configured()) {
    console.error('Error: MONGO_STAGING_URL must be set (.env or env var).');
    process.exit(1);
  }
  if (!args.collection) {
    console.error('Error: --collection is required.');
    process.exit(1);
  }
  if (requiresDateBound(args)) {
    console.error('Error: --tag/--order-id without --batch-id requires both valid --from and --to within 30 days.');
    console.error('These fields are unindexed and live inside arrays — an unbounded query can be a full');
    console.error('collection scan. Use search-s3-logs.js if you don\'t know the date; it resolves one via');
    console.error('a tiered bounded lookup; check its coverage manifest.');
    process.exit(1);
  }

  const match = buildMatch(args);
  const evidenceOptions = loadEvidenceOptions(args);
  const pipeline = [{ $match: match }, { $limit: args.limit }];
  const queryObj = { collection: args.collection, aggregate: pipeline, allowDiskUse: true };

  console.error('Submitting bounded read-only staging Mongo query.');

  const result = await query(queryObj);
  const rows = result.data.rows;
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
  checkMongoStagingConnectivity,
  isConfigured,
  main,
  runMongoQuery,
};
