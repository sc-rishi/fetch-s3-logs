#!/usr/bin/env node

/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  S3Client,
  SelectObjectContentCommand,
} = require('@aws-sdk/client-s3');
const {
  downloadObject,
  listObjects,
  mapConcurrent,
  readSelectPayload,
  validateSelectComplete,
  writeJson,
} = require('./s3-search-utils');
const { safeError } = require('./safe-evidence');

const BUCKET = 'sc-integrations-sbi-attachments';
const DEFAULT_OUTPUT_DIR = './logs/recon-search';
const DEFAULT_CONCURRENCY = 8;
const CSV_COLUMNS = [
  'buy_sell_ind',
  'qty_original',
  'client_id',
  'order_no',
  'average_price',
  'security_id',
  'trade_date',
  'traded_qty',
  'tag_or_remarks',
  'status',
  'exchange_order_no',
  'source_flag',
];
const SOURCES = [
  { name: 'sbi', prefix: 'sbi_recon/' },
  { name: 'mtf', prefix: 'mtf_recon/' },
];

function help() {
  console.log([
    'Search SBI/MTF recon CSVs in S3 with S3 Select.',
    '',
    'Usage:',
    '  node search-s3-recon.js --tag <tag> [--tag <tag> ...]',
    '  node search-s3-recon.js --order-id <id> [--exchange-order-id <id>]',
    '',
    'Options:',
    '  --tag <value>                 Search column 9 (tag/reference) (repeatable)',
    '  --order-id <value>            Search column 4 (internal order) (repeatable)',
    '  --exchange-order-id <value>  Search column 11 (exchange order) (repeatable)',
    '  --out <dir>                   Output directory for matched CSVs and JSON',
    '  --concurrency <n>             Concurrent S3 Select requests (default: 8)',
    '  --help                        Show this help',
    '',
    'The command scans every CSV below both recon prefixes, then downloads only',
    'objects with matching rows. It never downloads non-matching CSVs.',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {
    tags: [],
    orderIds: [],
    exchangeOrderIds: [],
    out: DEFAULT_OUTPUT_DIR,
    concurrency: DEFAULT_CONCURRENCY,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const option = argv[i];
    if (option === '--help') { help(); process.exit(0); }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + option);
    if (option === '--tag') args.tags.push(value);
    else if (option === '--order-id') args.orderIds.push(value);
    else if (option === '--exchange-order-id') args.exchangeOrderIds.push(value);
    else if (option === '--out') args.out = value;
    else if (option === '--concurrency') args.concurrency = Number(value);
    else throw new Error('Unknown option: ' + option);
    i += 1;
  }
  if (!args.tags.length && !args.orderIds.length && !args.exchangeOrderIds.length) {
    throw new Error('Provide at least one --tag, --order-id, or --exchange-order-id');
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 50) {
    throw new Error('--concurrency must be an integer from 1 to 50');
  }
  return args;
}

function sqlLiteral(value) {
  return "'" + value.replace(/'/g, "''") + "'";
}

function predicate(args) {
  const terms = [];
  if (args.tags.length) terms.push('s._9 IN (' + args.tags.map(sqlLiteral).join(',') + ')');
  if (args.orderIds.length) terms.push('s._4 IN (' + args.orderIds.map(sqlLiteral).join(',') + ')');
  if (args.exchangeOrderIds.length) {
    terms.push('s._11 IN (' + args.exchangeOrderIds.map(sqlLiteral).join(',') + ')');
  }
  return terms.join(' OR ');
}

async function listCsvObjects(s3, source) {
  return listObjects(s3, {
    bucket: BUCKET,
    prefix: source.prefix,
    filter: (key) => key.toLowerCase().endsWith('.csv'),
  });
}

async function selectRows(s3, key, where, size) {
  const response = await s3.send(new SelectObjectContentCommand({
    Bucket: BUCKET,
    Key: key,
    Expression: 'SELECT * FROM S3Object s WHERE ' + where,
    ExpressionType: 'SQL',
    InputSerialization: { CSV: { FileHeaderInfo: 'IGNORE' } },
    OutputSerialization: { CSV: {} },
  }));
  const { output, ended, stats } = await readSelectPayload(response.Payload);
  validateSelectComplete({ ended, stats }, size);
  return output.trim() ? output.trim().split(/\r?\n/) : [];
}

async function scanObject(s3, source, key, where, size) {
  try {
    const rows = await selectRows(s3, key, where, size);
    return rows.length ? { surface: source.name, key, rows } : null;
  } catch (error) {
    return { surface: source.name, key, error: safeError(error) };
  }
}

function matchedFileName(key) {
  return `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}.csv`;
}

function objectRef(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

async function downloadMatch(s3, match, outDir) {
  const targetDir = path.join(outDir, match.surface);
  const outputPath = path.join(targetDir, matchedFileName(match.key));
  return downloadObject(s3, { bucket: BUCKET, key: match.key, outputPath });
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const outputDir = path.resolve(args.out);
  if (fs.existsSync(outputDir) && (!fs.statSync(outputDir).isDirectory() || fs.readdirSync(outputDir).length)) {
    throw new Error('Output directory must be empty.');
  }
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const s3 = dependencies.s3 || new S3Client({});
  const where = predicate(args);
  const manifest = {
    bucket: BUCKET,
    searchedPrefixes: SOURCES.map((source) => source.prefix),
    query: { tags: args.tags.length, orderIds: args.orderIds.length, exchangeOrderIds: args.exchangeOrderIds.length },
    columnOrder: CSV_COLUMNS,
    sources: [],
    listedFiles: 0,
    scannedFiles: 0,
    matchedFiles: 0,
    downloadedFiles: [],
    errors: [],
  };
  const matches = [];

  for (const source of SOURCES) {
    const coverage = { surface: source.name, listed: 0, scanned: 0, matched: 0, failed: 0, status: 'running' };
    manifest.sources.push(coverage);
    let objects;
    try {
      objects = await listCsvObjects(s3, source);
    } catch (error) {
      coverage.failed += 1;
      coverage.status = 'incomplete';
      manifest.errors.push({ surface: source.name, error: safeError(error) });
      continue;
    }
    coverage.listed = objects.length;
    manifest.listedFiles += objects.length;
    const results = await mapConcurrent(objects, args.concurrency, ({ key, size }) => scanObject(s3, source, key, where, size));
    for (const result of results) {
      if (result?.error) {
        coverage.failed += 1;
        manifest.errors.push({ surface: result.surface, objectRef: objectRef(result.key), error: result.error });
        continue;
      }
      coverage.scanned += 1;
      manifest.scannedFiles += 1;
      if (!result) continue;
      try {
        const outputPath = await downloadMatch(s3, result, outputDir);
        matches.push({ ...result, downloadedFile: outputPath });
        coverage.matched += 1;
        manifest.downloadedFiles.push({ surface: result.surface, objectRef: objectRef(result.key) });
      } catch (error) {
        coverage.failed += 1;
        manifest.errors.push({ surface: result.surface, objectRef: objectRef(result.key), error: safeError(error) });
      }
    }
    coverage.status = coverage.failed ? 'incomplete' : objects.length ? 'complete' : 'empty';
  }

  manifest.matchedFiles = matches.length;
  manifest.status = manifest.errors.length ? 'incomplete' : manifest.scannedFiles ? 'complete' : 'empty';
  writeJson(path.join(outputDir, 'matches.json'), matches);
  writeJson(path.join(outputDir, 'manifest.json'), manifest);
  writeJson(path.join(outputDir, 'safe-matches.json'), matches.map((match) => ({
    surface: match.surface,
    objectRef: objectRef(match.key),
    matchedRows: match.rows.length,
  })));
  console.log(JSON.stringify({
    status: manifest.status,
    scannedFiles: manifest.scannedFiles,
    matchedFiles: manifest.matchedFiles,
    failedFiles: manifest.errors.length,
  }, null, 2));
  return manifest.status === 'incomplete' ? 2 : manifest.status === 'empty' ? 3 : 0;
}

async function cli() {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error('Recon search failed: ' + safeError(error));
    process.exitCode = 1;
  }
}

if (require.main === module) cli();

module.exports = { listCsvObjects, main, parseArgs, predicate, scanObject };
