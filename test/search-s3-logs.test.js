'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const test = require('node:test');
const zlib = require('zlib');
const {
  AUTO_SCOPE_TIERS,
  ValidationError,
  buildSelectExpression,
  buildSources,
  datesAroundAnchor,
  decodeObjectIdDate,
  discoverObjects,
  lineIsInScope,
  main,
  parseArgs,
  resolveAnchorDate,
  runAutoSearch,
  runSearch,
  scanObject,
} = require('../search-s3-logs');
const { listObjects } = require('../s3-search-utils');

function payload(events) {
  return (async function* generate() { yield* events; }());
}

function selectEvents(lines, size = 100) {
  const output = lines.map((line) => JSON.stringify({ _1: line })).join('\n');
  return payload([
    { Records: { Payload: Buffer.from(output ? `${output}\n` : '') } },
    { Stats: { Details: { BytesScanned: size, BytesProcessed: size * 2, BytesReturned: output.length } } },
    { End: {} },
  ]);
}

function searchResponse(lines) {
  return { Payload: selectEvents(lines), Body: Readable.from([zlib.gzipSync(`${lines.join('\n')}\n`)]) };
}

function object(overrides = {}) {
  return {
    bucket: 'bucket',
    key: 'logs/file.gz',
    size: 100,
    lastModified: new Date('2026-06-05T09:00:00Z'),
    source: { service: 'order-updates', surface: 'order-updates/eks' },
    ...overrides,
  };
}

test('requires one search value and an explicit service', () => {
  assert.throws(() => parseArgs(['--tag', 'sc_x']), ValidationError);
  assert.throws(
    () => parseArgs(['--service', 'order-updates', '--tag', 'sc_x', '--text', 'x']),
    ValidationError
  );
  const args = parseArgs(['--service', 'order-updates', '--tag', 'sc_x']);
  assert.equal(args.query.value, 'sc_x');
  assert.equal(args.dateScope, 'latest-30-days');
  assert.equal(args.dates.length, 30);
});

test('validates and expands date selectors', () => {
  assert.deepEqual(
    parseArgs(['--service', 'jobs', '--text', 'needle', '--date', '2026-06-05']).dates,
    ['2026-06-05']
  );
  assert.deepEqual(
    parseArgs(['--service', 'jobs', '--text', 'needle', '--from', '2026-06-05', '--to', '2026-06-07']).dates,
    ['2026-06-05', '2026-06-06', '2026-06-07']
  );
  assert.equal(
    parseArgs(['--service', 'jobs', '--text', 'needle', '--month', '2026-02']).dates.length,
    28
  );
  assert.throws(
    () => parseArgs(['--service', 'jobs', '--text', 'needle', '--date', '2026-02-30']),
    ValidationError
  );
  assert.throws(
    () => parseArgs(['--service', 'jobs', '--text', 'needle', '--from', '2026-06-01', '--to', '2026-07-01']),
    ValidationError
  );
  assert.throws(
    () => parseArgs(['--service', 'jobs', '--text', 'needle', '--month', '2026-07']),
    ValidationError
  );
});

test('maps every service to the required log surfaces', () => {
  assert.equal(buildSources(['order-updates'], 'prod').length, 3);
  assert.deepEqual(
    buildSources(['jobs'], 'prod').map((source) => source.surface),
    ['jobs/ec2/out', 'jobs/ec2/err']
  );
  assert.deepEqual(
    buildSources(['platform-api'], 'staging').map((source) => source.surface),
    ['platform-api/eks']
  );
  assert.equal(buildSources(['jobs-recon'], 'prod', 'sbiReconAllOrders')[0].forceGzip, true);
  assert.throws(() => parseArgs(['--service', 'jobs', '--text', 'x', '--env', 'staging']), ValidationError);
  assert.throws(() => parseArgs(['--service', 'jobs-recon', '--job-name', 'recon', '--text', 'x', '--env', 'staging']), ValidationError);
  assert.throws(() => parseArgs(['--service', 'all', '--text', 'x', '--env', 'staging']), ValidationError);
});

test('builds a literal case-insensitive S3 Select expression', () => {
  const expression = buildSelectExpression("Sc_%!O'Reilly");
  assert.match(expression, /LOWER\(s\._1\)/);
  assert.match(expression, /sc!_!%!!o''reilly/);
  assert.match(expression, /ESCAPE '!'/);
  assert.match(expression, /s\._2 IS NOT MISSING/);
  assert.match(expression, /s\._1 NOT LIKE/);
});

test('date-scoped discovery lists only the requested prefix', async () => {
  const calls = [];
  const s3 = {
    async send(command) {
      calls.push(command.input.Prefix);
      return { Contents: [{ Key: `${command.input.Prefix}one.gz`, Size: 10 }] };
    },
  };
  const source = {
    service: 'order-updates',
    surface: 'order-updates/eks',
    bucket: 'bucket',
    dated: true,
    dateRoot: 'production/',
    prefixForDate: (date) => `production/${date}/service/`,
  };
  const objects = await discoverObjects(s3, [source], ['2026-06-05'], 2);
  assert.deepEqual(calls, ['production/2026-06-05/service/']);
  assert.equal(objects.length, 1);
});

test('date-less CLI scope enumerates only the latest 30 date prefixes', async () => {
  const calls = [];
  const s3 = {
    async send(command) {
      calls.push(command.input.Prefix);
      return { Contents: [{ Key: `${command.input.Prefix}one.gz`, Size: 10 }] };
    },
  };
  const source = {
    service: 'order-updates',
    surface: 'order-updates/eks',
    bucket: 'bucket',
    dated: true,
    dateRoot: 'production/',
    prefixForDate: (date) => `production/${date}/service/`,
  };
  const dates = parseArgs(['--service', 'order-updates', '--tag', 'sc_x']).dates;
  const objects = await discoverObjects(s3, [source], dates, 2);
  assert.equal(calls.length, 30);
  assert.equal(calls.includes('production/'), false);
  assert.equal(objects.length, 30);
});

test('object listing follows every continuation token', async () => {
  const tokens = [];
  const s3 = {
    async send(command) {
      tokens.push(command.input.ContinuationToken || null);
      if (!command.input.ContinuationToken) {
        return { Contents: [{ Key: 'prefix/one.gz', Size: 1 }], NextContinuationToken: 'next' };
      }
      return { Contents: [{ Key: 'prefix/two.gz', Size: 2 }] };
    },
  };
  const objects = await listObjects(s3, { bucket: 'bucket', prefix: 'prefix/' });
  assert.deepEqual(tokens, [null, 'next']);
  assert.deepEqual(objects.map((item) => item.key), ['prefix/one.gz', 'prefix/two.gz']);
});

test('S3 Select returns complete EC2 and wrapped EKS lines', async () => {
  const ec2 = JSON.stringify({ context: { deeply: { tag: 'sc_nested' } }, time: '2026-06-05T09:00:00Z' });
  const eks = JSON.stringify({ time: '2026-06-05T09:01:00Z', message: JSON.stringify({ tag: 'sc_nested' }) });
  const s3 = { async send() { return { Payload: selectEvents([ec2, eks]) }; } };
  const result = await scanObject(s3, object(), 'sc_nested', null, undefined, 'compact-jsonl');
  assert.equal(result.method, 'select');
  assert.deepEqual(result.lines, [ec2, eks]);
});

test('Select failure falls back to gzip download and exact local matching', async () => {
  const matching = JSON.stringify({ tag: 'sc_fallback', time: '2026-06-05T09:00:00Z' });
  let calls = 0;
  const s3 = {
    async send() {
      calls += 1;
      if (calls === 1) throw new Error('invalid Select serialization');
      return { Body: Readable.from([zlib.gzipSync(Buffer.from(`${matching}\nother\n`))]) };
    },
  };
  const result = await scanObject(s3, object(), 'SC_FALLBACK', null, undefined, 'compact-jsonl');
  assert.equal(result.method, 'fallback');
  assert.deepEqual(result.lines, [matching]);
});

test('tab collision triggers whole-object fallback', async () => {
  const line = JSON.stringify({ tag: 'sc_tab', time: '2026-06-05T09:00:00Z' });
  let calls = 0;
  const s3 = {
    async send() {
      calls += 1;
      if (calls === 1) {
        return {
          Payload: payload([
            { Records: { Payload: Buffer.from(`${JSON.stringify({ _1: 'prefix', _2: 'collision' })}\n`) } },
            { Stats: { Details: { BytesScanned: 100, BytesProcessed: 100, BytesReturned: 10 } } },
            { End: {} },
          ]),
        };
      }
      return { Body: Readable.from([zlib.gzipSync(Buffer.from(`${line}\n`))]) };
    },
  };
  const result = await scanObject(s3, object(), 'sc_tab', null, undefined, 'compact-jsonl');
  assert.equal(result.method, 'fallback');
  assert.deepEqual(result.lines, [line]);
});

test('malformed Select output triggers whole-object fallback', async () => {
  const line = JSON.stringify({ tag: 'sc_malformed', time: '2026-06-05T09:00:00Z' });
  let calls = 0;
  const s3 = {
    async send() {
      calls += 1;
      if (calls === 1) {
        return {
          Payload: payload([
            { Records: { Payload: Buffer.from('not-json\n') } },
            { Stats: { Details: { BytesScanned: 100, BytesProcessed: 100, BytesReturned: 9 } } },
            { End: {} },
          ]),
        };
      }
      return { Body: Readable.from([zlib.gzipSync(Buffer.from(`${line}\n`))]) };
    },
  };
  const result = await scanObject(s3, object(), 'sc_malformed', null, undefined, 'compact-jsonl');
  assert.equal(result.method, 'fallback');
  assert.deepEqual(result.lines, [line]);
});

test('missing Select completion event triggers whole-object fallback', async () => {
  const line = JSON.stringify({ tag: 'sc_incomplete', time: '2026-06-05T09:00:00Z' });
  let calls = 0;
  const s3 = {
    async send() {
      calls += 1;
      if (calls === 1) return { Payload: payload([{ Records: { Payload: Buffer.from('') } }]) };
      return { Body: Readable.from([zlib.gzipSync(Buffer.from(`${line}\n`))]) };
    },
  };
  const result = await scanObject(s3, object(), 'sc_incomplete', null, undefined, 'compact-jsonl');
  assert.equal(result.method, 'fallback');
  assert.deepEqual(result.lines, [line]);
});

test('jobs-recon date filtering uses the log timestamp in IST', () => {
  const reconObject = object({ source: { filterLineDate: true } });
  const dates = new Set(['2026-06-05']);
  assert.equal(lineIsInScope(JSON.stringify({ time: '2026-06-04T19:00:00Z' }), reconObject, dates), true);
  assert.equal(lineIsInScope(JSON.stringify({ time: '2026-06-05T19:00:00Z' }), reconObject, dates), false);
});

test('successful searches stream complete records to both output files', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-log-search-test-'));
  const line = JSON.stringify({ time: '2026-06-05T09:00:00Z', context: { tag: 'sc_streamed' } });
  const s3 = {
    async send(command) {
      if (command.constructor.name === 'ListObjectsV2Command') {
        return {
          Contents: [{
            Key: `${command.input.Prefix}one.gz`,
            Size: 100,
            LastModified: new Date('2026-06-05T09:00:00Z'),
          }],
        };
      }
      return searchResponse([line]);
    },
  };
  try {
    const args = parseArgs([
      '--service', 'order-updates', '--tag', 'sc_streamed', '--date', '2026-06-05', '--out', outputDir,
    ]);
    const exitCode = await runSearch(args, { s3 });
    assert.equal(exitCode, 0);
    const matches = fs.readFileSync(path.join(outputDir, 'matches.jsonl'), 'utf8').trim().split('\n');
    assert.equal(matches.length, 3);
    assert.equal(JSON.parse(matches[0]).log.context.tag, 'sc_streamed');
    assert.match(fs.readFileSync(path.join(outputDir, 'all-logs.filtered.log'), 'utf8'), /sc_streamed/);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'complete');
    assert.equal(manifest.lines.matched, 3);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('an object that Select and GetObject cannot search makes the run incomplete', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-log-search-test-'));
  const s3 = {
    async send(command) {
      if (command.constructor.name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: `${command.input.Prefix}one.gz`, Size: 100 }] };
      }
      throw new Error('object unavailable');
    },
  };
  try {
    const args = parseArgs([
      '--service', 'order-updates', '--tag', 'sc_missing', '--date', '2026-06-05', '--out', outputDir,
    ]);
    const exitCode = await runSearch(args, { s3 });
    assert.equal(exitCode, 2);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'incomplete');
    assert.equal(manifest.objects.listed, 3);
    assert.equal(manifest.objects.failed, 3);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('decodeObjectIdDate recovers the embedded creation timestamp, rejects non-ObjectIds', () => {
  // 6a221fb2... -> hex seconds 0x6a221fb2 = 1780023730 -> 2026-05-26T14:22:10Z (a real batchId used
  // throughout SBI_LOG_INVESTIGATION_GUIDE.md's worked examples)
  const date = decodeObjectIdDate('6a221fb2d963eea6efaeabfa');
  assert.equal(date.toISOString(), new Date(parseInt('6a221fb2', 16) * 1000).toISOString());
  assert.equal(decodeObjectIdDate('not-an-object-id'), null);
  assert.equal(decodeObjectIdDate(''), null);
  assert.equal(decodeObjectIdDate(undefined), null);
  assert.equal(decodeObjectIdDate('6a221fb2d963eea6efaeabf'), null); // 23 chars, too short
});

test('datesAroundAnchor is inclusive, ordered, and never lists a future date', () => {
  const anchor = new Date('2026-06-05T01:00:00.000Z');
  const dates = datesAroundAnchor(anchor, 1, 2);
  assert.deepEqual(dates, ['2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07']);

  const todayIst = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
  const farFuture = datesAroundAnchor(new Date(), 1, 365);
  assert.ok(farFuture[farFuture.length - 1] <= todayIst, 'must not list dates beyond today (IST)');
});

test('AUTO_SCOPE_TIERS widen monotonically and cap near the 30-day max', () => {
  assert.equal(AUTO_SCOPE_TIERS.length, 4);
  const widths = AUTO_SCOPE_TIERS.map((t) => t.daysBack + t.daysForward + 1);
  for (let i = 1; i < widths.length; i += 1) assert.ok(widths[i] > widths[i - 1], 'each tier must be wider than the last');
  assert.ok(widths[widths.length - 1] <= 30, 'the widest tier must not exceed the 30-day cap');
});

test('resolveAnchorDate decodes batch-id locally without calling Redash', async () => {
  const args = parseArgs(['--service', 'order-updates', '--batch-id', '6a221fb2d963eea6efaeabfa']);
  let redashCalled = false;
  const result = await resolveAnchorDate(args, { redash: { isConfigured: () => { redashCalled = true; return true; } } });
  assert.equal(redashCalled, false);
  assert.equal(result.note, 'batchId-objectid-timestamp');
  assert.ok(result.anchor instanceof Date);
});

test('resolveAnchorDate tries the narrowest Redash lookback first and stops once it finds a match', async () => {
  const calls = [];
  const redash = {
    isConfigured: () => true,
    findOrderAnchorDate: async (opts) => { calls.push(opts); return { date: '2026-06-05T01:00:00.000Z' }; },
  };
  const args = parseArgs(['--service', 'order-updates', '--tag', 'sc_x']);
  const result = await resolveAnchorDate(args, { redash });
  assert.equal(calls.length, 1, 'must not try wider tiers once the narrowest one already found a match');
  assert.deepEqual(calls[0], { tag: 'sc_x', lookbackDays: 7 });
  assert.equal(result.note, 'redash-lookup-7d');
  assert.equal(result.anchor.toISOString(), '2026-06-05T01:00:00.000Z');
});

test('resolveAnchorDate widens the Redash lookback tier-by-tier when narrower ones find nothing', async () => {
  const calls = [];
  const redash = {
    isConfigured: () => true,
    findOrderAnchorDate: async (opts) => {
      calls.push(opts.lookbackDays);
      if (opts.lookbackDays === 30) return { date: '2026-05-20T00:00:00.000Z' };
      return { date: null, reason: 'not-found-in-lookback-window' };
    },
  };
  const result = await resolveAnchorDate(parseArgs(['--service', 'order-updates', '--order-id', '123']), { redash });
  assert.deepEqual(calls, [7, 14, 30], 'must try tiers in increasing order, not skip ahead');
  assert.equal(result.note, 'redash-lookup-30d');
});

test('resolveAnchorDate reports not-found (after exhausting every tier) and unconfigured distinctly, never guesses', async () => {
  const calls = [];
  const notFound = await resolveAnchorDate(
    parseArgs(['--service', 'order-updates', '--tag', 'sc_x']),
    { redash: {
      isConfigured: () => true,
      findOrderAnchorDate: async (opts) => { calls.push(opts.lookbackDays); return { date: null, reason: 'not-found-in-lookback-window' }; },
    } }
  );
  assert.equal(notFound.anchor, null);
  assert.equal(notFound.note, 'not-found-in-lookback-window');
  assert.deepEqual(calls, [7, 14, 30], 'must exhaust every tier before reporting not-found');

  const unconfigured = await resolveAnchorDate(
    parseArgs(['--service', 'order-updates', '--order-id', '123']),
    { redash: { isConfigured: () => false } }
  );
  assert.equal(unconfigured.anchor, null);
  assert.equal(unconfigured.note, 'redash-not-configured');
});

test('runAutoSearch stops at the first tier that finds a match and merges only what was scanned', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-auto-search-test-'));
  const listedPrefixes = [];
  const line = JSON.stringify({ time: '2026-06-08T09:00:00Z', context: { tag: 'sc_auto' } });
  const s3 = {
    async send(command) {
      if (command.constructor.name === 'ListObjectsV2Command') {
        listedPrefixes.push(command.input.Prefix);
        // Only the 2026-06-08 prefix (inside tier1's window) has an object; everything else is empty.
        if (command.input.Prefix.includes('2026-06-08')) {
          return { Contents: [{ Key: `${command.input.Prefix}one.gz`, Size: 10 }] };
        }
        return { Contents: [] };
      }
      return searchResponse([line]);
    },
  };
  const redash = {
    isConfigured: () => true,
    findOrderAnchorDate: async () => ({ date: '2026-06-06T00:00:00.000Z' }), // tier1 window: 06-05..06-08
  };
  try {
    const args = parseArgs(['--service', 'order-updates', '--tag', 'sc_auto', '--out', outputDir]);
    const exitCode = await runAutoSearch(args, { s3, redash });
    assert.equal(exitCode, 0);
    // tier1 (3 forward days from 06-05..06-08) already contains the match -> must not widen to tier2/3/4.
    assert.ok(listedPrefixes.some((p) => p.includes('2026-06-08')));
    assert.ok(!listedPrefixes.some((p) => p.includes('2026-06-13')), 'must not have run tier2 after tier1 matched');
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.totalMatched, 3); // 3 log surfaces (eks/ec2-out/ec2-err) each return the 1 line
    assert.equal(manifest.tiers.length, 1);
    assert.match(fs.readFileSync(path.join(outputDir, 'matches.jsonl'), 'utf8'), /sc_auto/);
    assert.equal(fs.existsSync(path.join(outputDir, '.tier-0')), false, 'tier scratch dir must be cleaned up');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('runAutoSearch widens through every tier when nothing matches, then stops at the cap', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-auto-search-test-'));
  const s3 = { async send(command) {
    if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [] };
    return searchResponse([]);
  } };
  const redash = { isConfigured: () => true, findOrderAnchorDate: async () => ({ date: '2026-06-06T00:00:00.000Z' }) };
  try {
    const args = parseArgs(['--service', 'jobs', '--order-id', '999', '--out', outputDir]);
    const exitCode = await runAutoSearch(args, { s3, redash });
    assert.equal(exitCode, 2);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'no_objects');
    assert.equal(manifest.totalMatched, 0);
    assert.equal(manifest.tiers.length, 4, 'must have tried every tier up to the cap');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('runAutoSearch retains failed and zero-object tier coverage after a later match', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-auto-search-test-'));
  const line = JSON.stringify({ time: '2026-06-14T09:00:00Z', tag: 'sc_later' });
  const s3 = { async send(command) {
    if (command.constructor.name === 'ListObjectsV2Command') {
      const { Prefix } = command.input;
      if (Prefix.includes('2026-06-08') || Prefix.includes('2026-06-14')) {
        return { Contents: [{ Key: `${Prefix}one.gz`, Size: 10 }] };
      }
      return { Contents: [] };
    }
    if (command.input.Key.includes('2026-06-08')) throw new Error('object unavailable');
    return searchResponse([line]);
  } };
  const redash = { isConfigured: () => true, findOrderAnchorDate: async () => ({ date: '2026-06-06T00:00:00.000Z' }) };
  try {
    const args = parseArgs(['--service', 'order-updates', '--tag', 'sc_later', '--out', outputDir]);
    const exitCode = await runAutoSearch(args, { s3, redash });
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.equal(exitCode, 2);
    assert.equal(manifest.status, 'incomplete');
    assert.equal(manifest.tiers.length, 3);
    assert.equal(manifest.tiers[0].status, 'incomplete');
    assert.equal(manifest.tiers[0].objects.failed, 3);
    assert.equal(manifest.tiers[0].errors.length, 3);
    assert.deepEqual(
      [manifest.tiers[1].objects.listed, manifest.tiers[1].objects.scanned, manifest.tiers[1].objects.failed],
      [0, 0, 0]
    );
    assert.equal(manifest.tiers[2].objects.scanned, 3);
    assert.equal(manifest.totalMatched, 3);
    assert.equal(fs.existsSync(path.join(outputDir, '.tier-0')), false);
    assert.equal(fs.existsSync(path.join(outputDir, '.tier-1')), false);
    assert.equal(fs.existsSync(path.join(outputDir, '.tier-2')), false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('runAutoSearch never touches S3 when Redash finds no record at all (no blind guessing)', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-auto-search-test-'));
  let s3Called = false;
  const s3 = { async send() { s3Called = true; return { Contents: [] }; } };
  const redash = { isConfigured: () => true, findOrderAnchorDate: async () => ({ date: null, reason: 'not-found-in-lookback-window' }) };
  try {
    const args = parseArgs(['--service', 'order-updates', '--tag', 'sc_ghost', '--out', outputDir]);
    const exitCode = await runAutoSearch(args, { s3, redash });
    assert.equal(exitCode, 3);
    assert.equal(s3Called, false);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'not_found_in_db');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('runAutoSearch falls back to the flat 30-day window when Redash is not configured', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-auto-search-test-'));
  const listedPrefixes = [];
  const s3 = {
    async send(command) {
      if (command.constructor.name === 'ListObjectsV2Command') {
        listedPrefixes.push(command.input.Prefix);
        return { Contents: [] };
      }
      return searchResponse([]);
    },
  };
  const redash = { isConfigured: () => false };
  try {
    const args = parseArgs(['--service', 'order-updates', '--tag', 'sc_x', '--out', outputDir]);
    const exitCode = await runAutoSearch(args, { s3, redash });
    assert.equal(exitCode, 2);
    // flat fallback lists 30 distinct date prefixes per dated source, same as the pre-auto-scope path.
    const uniqueDates = new Set(listedPrefixes.map((p) => p.match(/\d{4}-\d{2}-\d{2}/)?.[0]).filter(Boolean));
    assert.equal(uniqueDates.size, 30);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.anchorLookup, { status: 'unavailable', reason: 'redash-not-configured' });
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('main() bypasses auto-scope entirely when an explicit date is given', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-auto-search-test-'));
  let redashCalled = false;
  const s3 = {
    async send(command) {
      if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [] };
      return searchResponse([]);
    },
  };
  const redash = { isConfigured: () => { redashCalled = true; return true; } };
  try {
    const exitCode = await main(
      ['--service', 'order-updates', '--tag', 'sc_x', '--date', '2026-06-05', '--out', outputDir],
      { s3, redash }
    );
    assert.equal(exitCode, 2);
    assert.equal(redashCalled, false, 'an explicit date must never trigger a Redash lookup');
    assert.equal(fs.existsSync(path.join(outputDir, '.tier-0')), false, 'must not use tiered output layout');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('listing failures produce an incomplete manifest and exit code 2', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-log-search-test-'));
  try {
    const args = parseArgs(['--service', 'order-updates', '--tag', 'sc_x', '--date', '2026-06-05', '--out', outputDir]);
    const exitCode = await runSearch(args, { s3: { async send() { throw new Error('Access denied'); } } });
    assert.equal(exitCode, 2);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'incomplete');
    assert.equal(manifest.errors[0].phase, 'listing');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('zero listed objects differs from a complete search with zero matching lines', async () => {
  const noObjectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-no-objects-'));
  const noMatchDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-no-match-'));
  const s3 = (hasObjects) => ({ async send(command) {
    if (command.constructor.name === 'ListObjectsV2Command') {
      return { Contents: hasObjects ? [{ Key: `${command.input.Prefix}one.gz`, Size: 10 }] : [] };
    }
    return searchResponse([]);
  } });
  try {
    const args = (out) => parseArgs(['--service', 'order-updates', '--text', 'absent', '--date', '2026-06-05', '--out', out]);
    assert.equal(await runSearch(args(noObjectsDir), { s3: s3(false) }), 2);
    assert.equal(await runSearch(args(noMatchDir), { s3: s3(true) }), 0);
    const noObjects = JSON.parse(fs.readFileSync(path.join(noObjectsDir, 'manifest.json'), 'utf8'));
    const noMatch = JSON.parse(fs.readFileSync(path.join(noMatchDir, 'manifest.json'), 'utf8'));
    assert.equal(noObjects.status, 'no_objects');
    assert.ok(noObjects.coverage.every((scope) => scope.status === 'no_objects'));
    assert.equal(noMatch.status, 'complete');
    assert.equal(noMatch.lines.matched, 0);
    assert.ok(noMatch.coverage.every((scope) => scope.scannedObjects === 1));
  } finally {
    fs.rmSync(noObjectsDir, { recursive: true, force: true });
    fs.rmSync(noMatchDir, { recursive: true, force: true });
  }
});

test('manifest and safe evidence omit raw identifiers while marking exact matches', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-safe-evidence-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-safe-enums-'));
  const enumPath = path.join(configDir, 'source-enums.json');
  fs.writeFileSync(enumPath, JSON.stringify({ event: ['ORDER_FAILED'] }));
  const exact = JSON.stringify({ time: '2026-06-05T09:00:00Z', tag: 'sc_secret', event: 'ORDER_FAILED', status: 'MYSECRET', message: 'password=hidden' });
  const substring = JSON.stringify({ time: '2026-06-05T09:01:00Z', message: 'prefix sc_secret suffix' });
  const s3 = { async send(command) {
    if (command.constructor.name === 'ListObjectsV2Command') {
      return { Contents: [{ Key: `${command.input.Prefix}private-account-123.gz`, Size: 10 }] };
    }
    return searchResponse([exact, substring]);
  } };
  try {
    const args = parseArgs(['--service', 'order-updates', '--tag', 'sc_secret', '--date', '2026-06-05', '--out', outputDir,
      '--validated-enums', enumPath]);
    assert.equal(await runSearch(args, { s3 }), 0);
    const manifestText = fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8');
    const safeText = fs.readFileSync(path.join(outputDir, 'safe-matches.jsonl'), 'utf8');
    assert.doesNotMatch(manifestText + safeText, /sc_secret|private-account-123|password=hidden/);
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.query.kind, 'tag');
    assert.equal(manifest.query.value, undefined);
    assert.equal(manifest.coverage.length, 3);
    assert.equal(manifest.matchedObjectRefs.length, 3);
    const safeMatches = safeText.trim().split('\n').map(JSON.parse);
    assert.equal(safeMatches.length, 6);
    assert.deepEqual(safeMatches[0].exactMatchPaths, ['tag']);
    assert.equal(safeMatches[0].event, 'ORDER_FAILED');
    assert.equal(safeMatches[0].status, undefined);
    assert.equal(safeMatches[1].correlation, 'substring-candidate');
    assert.match(fs.readFileSync(path.join(outputDir, 'matches.jsonl'), 'utf8'), /password=hidden/);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a failed source-date listing remains visible without leaking its error message', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-coverage-'));
  const s3 = { async send(command) {
    if (command.constructor.name === 'ListObjectsV2Command') {
      if (command.input.Prefix.includes('Out-logs')) {
        const error = new Error('Access denied for private-account-123');
        error.name = 'AccessDenied';
        throw error;
      }
      return { Contents: [{ Key: `${command.input.Prefix}one.gz`, Size: 10 }] };
    }
    return searchResponse([]);
  } };
  try {
    const args = parseArgs(['--service', 'order-updates', '--text', 'absent', '--date', '2026-06-05', '--out', outputDir]);
    assert.equal(await runSearch(args, { s3 }), 2);
    const manifestText = fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.status, 'incomplete');
    assert.equal(manifest.coverage.length, 3);
    assert.equal(manifest.coverage.filter((scope) => scope.status === 'listing_failed').length, 1);
    assert.equal(manifest.errors[0].error, 'AccessDenied');
    assert.doesNotMatch(manifestText, /private-account-123/);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('nonempty output roots and ambiguous anchors stop before S3 access', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-existing-'));
  fs.writeFileSync(path.join(outputDir, 'sentinel'), 'existing evidence');
  let s3Called = false;
  const s3 = { async send() { s3Called = true; return { Contents: [] }; } };
  try {
    const args = parseArgs(['--service', 'order-updates', '--tag', 'sc_secret', '--date', '2026-06-05', '--out', outputDir]);
    await assert.rejects(() => runSearch(args, { s3 }), ValidationError);
    assert.equal(s3Called, false);
    assert.equal(fs.readFileSync(path.join(outputDir, 'sentinel'), 'utf8'), 'existing evidence');
    fs.rmSync(path.join(outputDir, 'sentinel'));
    const autoArgs = parseArgs(['--service', 'order-updates', '--tag', 'sc_secret', '--out', outputDir]);
    const redash = { isConfigured: () => true, findOrderAnchorDate: async () => ({ date: null, reason: 'ambiguous' }) };
    assert.equal(await runAutoSearch(autoArgs, { s3, redash }), 3);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'ambiguous_anchor');
    assert.equal(manifest.query.value, undefined);
    assert.match(manifest.note, /explicit date or batchId/);
    assert.equal(s3Called, false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('default identifier search streams tabs, empty CSV columns, and comment lines without Select', async () => {
  const lines = ['prefix\ttarget', 'prefix\t\ttarget', '#target'];
  const calls = [];
  const s3 = { async send(command) {
    calls.push(command.constructor.name);
    return { Body: Readable.from([lines.join('\n') + '\n']) };
  } };
  const result = await scanObject(s3, object({ key: 'plain.log' }), 'target', null);
  assert.equal(result.method, 'local');
  assert.deepEqual(result.lines, lines);
  assert.deepEqual(calls, ['GetObjectCommand']);
  assert.equal(parseArgs(['--service', 'jobs', '--text', 'target']).selectFormat, undefined);
  assert.throws(() => parseArgs(['--service', 'jobs', '--text', 'target', '--select-format', 'auto']), ValidationError);
});

test('incomplete Select statistics discard partial candidates before local fallback', async () => {
  for (const scanned of [undefined, null, NaN, Infinity, -1, 99]) {
    let calls = 0;
    const stale = JSON.stringify({ message: 'target partial' });
    const actual = JSON.stringify({ message: 'target complete' });
    const s3 = { async send(command) {
      calls += 1;
      if (command.constructor.name === 'SelectObjectContentCommand') return { Payload: payload([
        { Records: { Payload: Buffer.from(JSON.stringify({ _1: stale }) + '\n') } },
        { Stats: { Details: { BytesScanned: scanned } } }, { End: {} },
      ]) };
      return { Body: Readable.from([actual + '\n']) };
    } };
    const result = await scanObject(s3, object({ key: 'plain.log' }), 'target', null, undefined, 'compact-jsonl');
    assert.equal(result.method, 'fallback');
    assert.equal(calls, 2);
    assert.deepEqual(result.lines, [actual]);
  }
});

test('job event time remains unverified when only upload time or unsupported timestamps are available', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-job-time-'));
  const lines = [
    '2026-09-01T12:00:00Z target job failed',
    JSON.stringify({ timestamp: '2026-09-01T12:00:00Z', message: 'target' }),
    JSON.stringify({ time: '2026-09-01T12:00:00', message: 'target' }),
    JSON.stringify({ time: '2026-09-02T12:00:00Z', message: 'target' }),
  ];
  const s3 = { async send(command) {
    if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [
      { Key: 'job-output', Size: 100, LastModified: new Date('2026-09-02T12:00:00Z') },
    ] };
    return { Body: Readable.from([zlib.gzipSync(lines.join('\n') + '\n')]) };
  } };
  try {
    const exitCode = await main(['--service', 'jobs-recon', '--job-name', 'example', '--text', 'target',
      '--date', '2026-09-01', '--out', outputDir], { s3 });
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json')));
    assert.equal(exitCode, 2);
    assert.equal(manifest.status, 'incomplete');
    assert.equal(manifest.lines.matched, 3);
    assert.equal(manifest.lines.timeUnverified, 3);
    assert.equal(manifest.coverage[0].timeUnverified, 3);
    const safe = fs.readFileSync(path.join(outputDir, 'safe-matches.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(safe.every((record) => record.timeStatus === 'unverified'));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('evidence specs retain array locations and correlate only the matching order element', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's3-spec-pipeline-'));
  const outputDir = path.join(root, 'out');
  const specPath = path.join(root, 'spec.json');
  const source = `orders@${'a'.repeat(40)}:src/order.js:10`;
  fs.writeFileSync(specPath, JSON.stringify({ fields: [
    { path: 'orders[].status', kind: 'status', values: ['FAILED'], source },
  ], identifiers: [{ path: 'orders[].tag', source }] }));
  const line = JSON.stringify({ orders: [
    { tag: 'target', status: 'FAILED' }, { tag: 'other', status: 'FAILED' },
  ] });
  const calls = [];
  const s3 = { async send(command) {
    calls.push(command.constructor.name);
    if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [{ Key: 'one.log', Size: 100 }] };
    return { Payload: selectEvents([line]) };
  } };
  try {
    const code = await main(['--service', 'platform-api', '--env', 'staging', '--tag', 'target',
      '--date', '2026-06-05', '--out', outputDir, '--evidence-spec', specPath,
      '--select-format', 'compact-jsonl'], { s3 });
    assert.equal(code, 0);
    assert.deepEqual(calls, ['ListObjectsV2Command', 'SelectObjectContentCommand']);
    const safe = JSON.parse(fs.readFileSync(path.join(outputDir, 'safe-matches.jsonl'), 'utf8'));
    assert.deepEqual(safe.evidence.map(({ path: location, correlation }) => [location, correlation]), [
      ['orders[0].status', 'matched_element'], ['orders[1].status', 'other_element'],
    ]);
    assert.equal(safe.exactMatchPaths, undefined);
    assert.equal(safe.projection.status, 'partial');
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json')));
    assert.equal(manifest.selectFormat, 'compact-jsonl');
    assert.equal(manifest.objects.selected, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
