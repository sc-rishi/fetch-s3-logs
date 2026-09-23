#!/usr/bin/env node

/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const {
  S3Client,
  SelectObjectContentCommand,
} = require('@aws-sdk/client-s3');
const {
  downloadObject,
  listObjects,
  mapConcurrent,
  readSelectPayload,
  writeJson,
} = require('./s3-search-utils');

process.env.AWS_PROFILE = process.env.AWS_PROFILE || 'smallcase';
process.env.AWS_SDK_LOAD_CONFIG = '1';
process.env.AWS_REGION = process.env.AWS_REGION || 'ap-south-1';

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

async function listCsvKeys(s3, source) {
  const objects = await listObjects(s3, {
    bucket: BUCKET,
    prefix: source.prefix,
    filter: (key) => key.toLowerCase().endsWith('.csv'),
  });
  return objects.map((object) => object.key);
}

async function selectRows(s3, key, where) {
  const response = await s3.send(new SelectObjectContentCommand({
    Bucket: BUCKET,
    Key: key,
    Expression: 'SELECT * FROM S3Object s WHERE ' + where,
    ExpressionType: 'SQL',
    InputSerialization: { CSV: { FileHeaderInfo: 'IGNORE' } },
    OutputSerialization: { CSV: {} },
  }));
  const { output } = await readSelectPayload(response.Payload);
  return output.trim() ? output.trim().split(/\r?\n/) : [];
}

async function scanObject(s3, source, key, where) {
  try {
    const rows = await selectRows(s3, key, where);
    return rows.length ? { surface: source.name, key, rows } : null;
  } catch (error) {
    return { surface: source.name, key, error: error.message };
  }
}

function matchedFileName(key) {
  return key.replace(/[^A-Za-z0-9._-]+/g, '__');
}

async function downloadMatch(s3, match, outDir) {
  const targetDir = path.join(outDir, match.surface);
  const outputPath = path.join(targetDir, matchedFileName(match.key));
  return downloadObject(s3, { bucket: BUCKET, key: match.key, outputPath });
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const outputDir = path.resolve(args.out);
  fs.mkdirSync(outputDir, { recursive: true });
  const s3 = dependencies.s3 || new S3Client({ region: process.env.AWS_REGION });
  const where = predicate(args);
  const manifest = {
    bucket: BUCKET,
    searchedPrefixes: SOURCES.map((source) => source.prefix),
    query: { tags: args.tags, orderIds: args.orderIds, exchangeOrderIds: args.exchangeOrderIds },
    columnOrder: CSV_COLUMNS,
    scannedFiles: 0,
    matchedFiles: 0,
    downloadedFiles: [],
    errors: [],
  };
  const matches = [];

  for (const source of SOURCES) {
    let keys;
    try {
      keys = await listCsvKeys(s3, source);
    } catch (error) {
      manifest.errors.push({ surface: source.name, key: null, error: error.message });
      continue;
    }
    manifest.scannedFiles += keys.length;
    const results = await mapConcurrent(keys, args.concurrency, (key) => scanObject(s3, source, key, where));
    for (const result of results) {
      if (!result) continue;
      if (result.error) { manifest.errors.push(result); continue; }
      try {
        const outputPath = await downloadMatch(s3, result, outputDir);
        matches.push({ ...result, downloadedFile: outputPath });
        manifest.downloadedFiles.push(outputPath);
      } catch (error) {
        manifest.errors.push({ surface: result.surface, key: result.key, error: error.message });
      }
    }
  }

  manifest.matchedFiles = matches.length;
  writeJson(path.join(outputDir, 'matches.json'), matches);
  writeJson(path.join(outputDir, 'manifest.json'), manifest);
  console.log(JSON.stringify({
    scannedFiles: manifest.scannedFiles,
    matchedFiles: manifest.matchedFiles,
    downloadedFiles: manifest.downloadedFiles,
    errors: manifest.errors,
    outputDir,
  }, null, 2));
  return manifest.errors.length ? 2 : 0;
}

async function cli() {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error('Recon search failed: ' + error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) cli();

module.exports = { listCsvKeys, main, parseArgs, predicate, scanObject };
