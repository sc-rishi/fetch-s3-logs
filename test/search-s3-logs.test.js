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
});

test('builds a literal case-insensitive S3 Select expression', () => {
  const expression = buildSelectExpression("Sc_%!O'Reilly");
  assert.match(expression, /LOWER\(s\._1\)/);
  assert.match(expression, /sc!_!%!!o''reilly/);
  assert.match(expression, /ESCAPE '!'/);
  assert.match(expression, /CHAR_LENGTH\(s\._2\) > 0/);
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
  const result = await scanObject(s3, object(), 'sc_nested', null);
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
  const result = await scanObject(s3, object(), 'SC_FALLBACK', null);
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
  const result = await scanObject(s3, object(), 'sc_tab', null);
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
  const result = await scanObject(s3, object(), 'sc_malformed', null);
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
  const result = await scanObject(s3, object(), 'sc_incomplete', null);
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
      return { Payload: selectEvents([line]) };
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
      return { Payload: selectEvents([line]) };
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
    return { Payload: selectEvents([]) };
  } };
  const redash = { isConfigured: () => true, findOrderAnchorDate: async () => ({ date: '2026-06-06T00:00:00.000Z' }) };
  try {
    const args = parseArgs(['--service', 'jobs', '--order-id', '999', '--out', outputDir]);
    const exitCode = await runAutoSearch(args, { s3, redash });
    assert.equal(exitCode, 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.totalMatched, 0);
    assert.equal(manifest.tiers.length, 4, 'must have tried every tier up to the cap');
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
      return { Payload: selectEvents([]) };
    },
  };
  const redash = { isConfigured: () => false };
  try {
    const args = parseArgs(['--service', 'order-updates', '--tag', 'sc_x', '--out', outputDir]);
    const exitCode = await runAutoSearch(args, { s3, redash });
    assert.equal(exitCode, 0);
    // flat fallback lists 30 distinct date prefixes per dated source, same as the pre-auto-scope path.
    const uniqueDates = new Set(listedPrefixes.map((p) => p.match(/\d{4}-\d{2}-\d{2}/)?.[0]).filter(Boolean));
    assert.equal(uniqueDates.size, 30);
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
      return { Payload: selectEvents([]) };
    },
  };
  const redash = { isConfigured: () => { redashCalled = true; return true; } };
  try {
    const exitCode = await main(
      ['--service', 'order-updates', '--tag', 'sc_x', '--date', '2026-06-05', '--out', outputDir],
      { s3, redash }
    );
    assert.equal(exitCode, 0);
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
