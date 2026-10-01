'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const {
  applyDefaultDateRange,
  buildScopedArgs,
  buildTextSelectExpression,
  parseArgs,
  run,
  runForScope,
  resolveDateList,
  substitutePlaceholder,
  trySelectMatchingLines,
} = require('../fetch-s3-logs');
const { ValidationError } = require('../search-s3-logs');

function payload(events) {
  return (async function* generate() { yield* events; }());
}

function selectEvents(lines) {
  const output = lines.map((line) => JSON.stringify({ _1: line })).join('\n');
  return payload([
    { Records: { Payload: Buffer.from(output ? `${output}\n` : '') } },
    { Stats: { Details: { BytesScanned: 100 } } },
    { End: {} },
  ]);
}

test('explicit S3 sources do not inherit default dates, while the default source does', () => {
  const defaults = { DATE_FROM: '2026-09-01', DATE_TO: '2026-09-30' };
  for (const source of [
    ['--s3-url', 's3://bucket/literal/'],
    ['--bucket', 'bucket', '--prefix', 'literal/'],
    ['--s3-url', 's3://bucket/{date}/'],
    ['--bucket', 'bucket', '--prefix', '{date}/'],
  ]) {
    const args = parseArgs(['node', 'fetch-s3-logs.js', ...source]);
    applyDefaultDateRange(args, defaults);
    assert.equal(resolveDateList(args), null);
  }

  const defaultSource = parseArgs(['node', 'fetch-s3-logs.js']);
  applyDefaultDateRange(defaultSource, defaults);
  assert.deepEqual([defaultSource.dateFrom, defaultSource.dateTo], ['2026-09-01', '2026-09-30']);
});

test('resolveDateList: --date resolves a single day', () => {
  assert.deepEqual(resolveDateList({ date: '2026-06-05' }), ['2026-06-05']);
});

test('resolveDateList: --date-from/--date-to resolves an inclusive range', () => {
  assert.deepEqual(resolveDateList({ dateFrom: '2026-06-01', dateTo: '2026-06-03' }), [
    '2026-06-01', '2026-06-02', '2026-06-03',
  ]);
});

test('resolveDateList: neither given returns null (today\'s single-prefix behavior)', () => {
  assert.equal(resolveDateList({}), null);
});

test('resolveDateList: rejects --date combined with --date-from/--date-to', () => {
  assert.throws(
    () => resolveDateList({ date: '2026-06-05', dateFrom: '2026-06-01', dateTo: '2026-06-02' }),
    ValidationError
  );
});

test('resolveDateList: rejects a lone --date-from or --date-to', () => {
  assert.throws(() => resolveDateList({ dateFrom: '2026-06-01' }), ValidationError);
  assert.throws(() => resolveDateList({ dateTo: '2026-06-01' }), ValidationError);
});

test('resolveDateList: rejects a range over 30 days', () => {
  assert.throws(
    () => resolveDateList({ dateFrom: '2026-01-01', dateTo: '2026-06-01' }),
    ValidationError
  );
});

test('resolveDateList: rejects a malformed date', () => {
  assert.throws(() => resolveDateList({ date: '05-06-2026' }), ValidationError);
});

test('substitutePlaceholder: replaces every {date} occurrence, passes through non-strings', () => {
  assert.equal(substitutePlaceholder('s3://b/{date}/svc/{date}.log', '2026-06-05'), 's3://b/2026-06-05/svc/2026-06-05.log');
  assert.equal(substitutePlaceholder(undefined, '2026-06-05'), undefined);
});

test('buildScopedArgs: null date passes args through unchanged', () => {
  const args = { s3Url: 's3://b/{date}/svc/', outDir: './logs' };
  assert.equal(buildScopedArgs(args, null), args);
});

test('buildScopedArgs: substitutes {date} and nests outDir per day', () => {
  const args = { s3Url: 's3://b/{date}/svc/', bucket: undefined, prefix: undefined, outDir: './logs', filterText: ['x'] };
  const scoped = buildScopedArgs(args, '2026-06-05');
  assert.equal(scoped.s3Url, 's3://b/2026-06-05/svc/');
  assert.equal(scoped.outDir, require('path').join('./logs', '2026-06-05'));
  assert.deepEqual(scoped.filterText, ['x'], 'unrelated fields must carry through');
  assert.equal(args.s3Url, 's3://b/{date}/svc/', 'must not mutate the original args');
});

test('buildTextSelectExpression: ANDs every term as a case-insensitive LIKE, escapes SQL/LIKE specials', () => {
  const expression = buildTextSelectExpression(["sc_rXWoyJfoH", "O'Reilly"]);
  assert.match(expression, /LOWER\(s\._1\) LIKE '%sc!_rxwoyjfoh%' ESCAPE '!'/);
  assert.match(expression, /LOWER\(s\._1\) LIKE '%o''reilly%' ESCAPE '!'/);
  assert.match(expression, / AND /);
});

test('buildTextSelectExpression: returns null for no/empty terms', () => {
  assert.equal(buildTextSelectExpression([]), null);
  assert.equal(buildTextSelectExpression(['', '  ']), null);
});

test('trySelectMatchingLines: returns matching lines from a well-formed Select response', async () => {
  const lines = [JSON.stringify({ tag: 'sc_x', time: '2026-06-05T09:00:00Z' })];
  const s3 = { async send() { return { Payload: selectEvents(lines) }; } };
  const result = await trySelectMatchingLines(s3, 'bucket', 'key.log', ['sc_x'], false);
  assert.deepEqual(result, lines);
});

test('trySelectMatchingLines: a real no-match returns an empty array, not null', async () => {
  const s3 = { async send() { return { Payload: selectEvents([]) }; } };
  const result = await trySelectMatchingLines(s3, 'bucket', 'key.log', ['sc_x'], false);
  assert.deepEqual(result, []);
});

test('trySelectMatchingLines: format violations and incomplete responses reject for full-object fallback', async () => {
  const tabCollision = {
    async send() {
      return {
        Payload: payload([
          { Records: { Payload: Buffer.from(`${JSON.stringify({ _1: 'prefix', _2: 'collision' })}\n`) } },
          { Stats: { Details: {} } },
          { End: {} },
        ]),
      };
    },
  };
  await assert.rejects(trySelectMatchingLines(tabCollision, 'bucket', 'key.log', ['sc_x'], false));

  const incomplete = { async send() { return { Payload: payload([{ Records: { Payload: Buffer.from('') } }]) }; } };
  await assert.rejects(trySelectMatchingLines(incomplete, 'bucket', 'key.log', ['sc_x'], false));
});

test('trySelectMatchingLines: no filter terms skips Select entirely (returns null)', async () => {
  let called = false;
  const s3 = { async send() { called = true; return { Payload: selectEvents([]) }; } };
  assert.equal(await trySelectMatchingLines(s3, 'bucket', 'key.log', [], false), null);
  assert.equal(called, false);
});

test('fetch manifest records empty coverage separately from a completed negative scan', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-coverage-'));
  try {
    const args = { s3Url: 's3://bucket/sensitive-id/', outDir, concurrency: 1, rawFields: [], filterFields: [] };
    const s3 = { send: async () => ({ Contents: [] }) };
    const result = await runForScope(s3, args);
    assert.equal(result.status, 'empty_source');
    assert.deepEqual(result.objects, { listed: 0, selected: 0, scanned: 0, failed: 0 });
    const manifest = fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8');
    assert.doesNotMatch(manifest, /sensitive-id|bucket/);
    assert.equal(fs.statSync(path.join(outDir, 'manifest.json')).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('failed object scan is incomplete and raw object keys and remote errors stay out of manifest', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-incomplete-'));
  const s3 = {
    async send(command) {
      if (command.constructor.name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: 'sensitive-id/password-bearing.log' }] };
      }
      throw new Error('broker password=secret');
    },
  };
  try {
    const result = await runForScope(s3, {
      s3Url: 's3://bucket/sensitive-id/', outDir, concurrency: 1, rawFields: [], filterFields: [],
    });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.objects, { listed: 1, selected: 1, scanned: 0, failed: 1 });
    const manifest = fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8');
    assert.doesNotMatch(manifest, /sensitive-id|password|secret|bucket/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('multi-date fetch returns a failing code when any date is incomplete', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-multidate-'));
  const s3 = {
    async send(command) {
      if (command.constructor.name === 'ListObjectsV2Command') {
        if (command.input.Prefix.includes('2026-06-06')) throw new Error('secret listing body');
        return { Contents: [{ Key: '2026-06-05/secret-id.log' }] };
      }
      return { Body: Readable.from([`${JSON.stringify({ time: '2026-06-05T00:00:00Z', message: 'secret' })}\n`]) };
    },
  };
  try {
    const code = await run([
      'node', 'fetch-s3-logs.js', '--s3-url', 's3://bucket/{date}/', '--out', outDir,
      '--date-from', '2026-06-05', '--date-to', '2026-06-06', '--no-filter-text', '--no-sort', '--concurrency', '1',
    ], { s3 });
    assert.equal(code, 2);
    const first = JSON.parse(fs.readFileSync(path.join(outDir, '2026-06-05', 'manifest.json'), 'utf8'));
    const second = JSON.parse(fs.readFileSync(path.join(outDir, '2026-06-06', 'manifest.json'), 'utf8'));
    assert.equal(first.status, 'complete');
    assert.equal(first.objects.scanned, 1);
    assert.equal(second.status, 'incomplete');
    assert.equal(first.sourceAlias, second.sourceAlias);
    assert.equal(second.error, 'listing-failed');
    assert.equal(fs.statSync(path.join(outDir, '2026-06-05', 'all-logs.filtered.log')).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fetch refuses to reuse a nonempty output directory', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-reused-'));
  try {
    fs.writeFileSync(path.join(outDir, 'old.log'), 'old evidence');
    await assert.rejects(() => runForScope({ send: async () => ({ Contents: [] }) }, {
      s3Url: 's3://bucket/day/', outDir,
    }), /Output directory is not empty/);
    assert.equal(fs.readFileSync(path.join(outDir, 'old.log'), 'utf8'), 'old evidence');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('unsorted concurrent fetch retains every object when the first download finishes last', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-unsorted-'));
  const s3 = {
    async send(command) {
      if (command.constructor.name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: 'first.log' }, { Key: 'second.log' }] };
      }
      if (command.input.Key === 'first.log') await new Promise((resolve) => setTimeout(resolve, 50));
      const event = command.input.Key === 'first.log' ? 'FIRST' : 'SECOND';
      return { Body: Readable.from([`${JSON.stringify({ time: '2026-06-05T00:00:00Z', event })}\n`]) };
    },
  };
  try {
    const manifest = await runForScope(s3, {
      s3Url: 's3://bucket/', outDir, concurrency: 2, rawFields: [], filterFields: [],
    });
    const output = fs.readFileSync(path.join(outDir, 'all-logs.filtered.log'), 'utf8');
    assert.equal(manifest.status, 'complete');
    assert.equal(manifest.lines.matched, 2);
    assert.match(output, /FIRST/);
    assert.match(output, /SECOND/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('multi-date fetch rejects a nonempty parent directory before any S3 request', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-reused-parent-'));
  let called = false;
  try {
    fs.mkdirSync(path.join(outDir, 'old-date'));
    await assert.rejects(() => run([
      'node', 'fetch-s3-logs.js', '--s3-url', 's3://bucket/{date}/', '--out', outDir,
      '--date-from', '2026-06-05', '--date-to', '2026-06-06',
    ], { s3: { send: async () => { called = true; return { Contents: [] }; } } }),
    /Output directory is not empty/);
    assert.equal(called, false);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('invalid and inverted time filters fail before S3 listing', async () => {
  let called = false;
  const s3 = { send: async () => { called = true; return { Contents: [] }; } };
  for (const filters of [
    ['--from', 'not-a-time'],
    ['--to', 'not-a-time'],
    ['--modified-after', 'not-a-time'],
    ['--modified-before', 'not-a-time'],
    ['--from', '2026-02-30T10:00'],
    ['--from', '2026-09-29T25:00'],
    ['--ist', '--from', '2026/09/29 10:00:00'],
    ['--from', '2026-09-30T00:00', '--to', '2026-09-29T00:00'],
  ]) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-invalid-time-'));
    try {
      await assert.rejects(() => run([
        'node', 'fetch-s3-logs.js', '--s3-url', 's3://bucket/day/', '--out', outDir, ...filters,
      ], { s3 }), /Invalid --|must not be after/);
      assert.equal(called, false);
      assert.deepEqual(fs.readdirSync(outDir), []);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
});

test('fractional timezone-free IST filters do not depend on the host timezone', async () => {
  const previousTimezone = process.env.TZ;
  const outputDirs = [];
  try {
    for (const timezone of ['UTC', 'Asia/Kolkata']) {
      process.env.TZ = timezone;
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-ist-time-'));
      outputDirs.push(outDir);
      const manifest = await runForScope({ send: async () => ({ Contents: [] }) }, {
        s3Url: 's3://bucket/day/', outDir, ist: true,
        from: '2026-09-29T10:00:00.123456',
      });
      assert.equal(manifest.lineWindowUTC.from, '2026-09-29T04:30:00.123Z');
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
    for (const outDir of outputDirs) fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('explicit S3 sources do not inherit the built-in content filter', async () => {
  for (const source of [
    ['--s3-url', 's3://bucket/day/'],
    ['--bucket', 'bucket', '--prefix', 'day/'],
  ]) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-explicit-source-'));
    let selectCalled = false;
    const s3 = {
      async send(command) {
        if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [{ Key: 'day/log.json' }] };
        if (command.constructor.name === 'SelectObjectContentCommand') selectCalled = true;
        return { Body: Readable.from([`${JSON.stringify({ time: '2026-06-05T00:00:00Z', event: 'OTHER' })}\n`]) };
      },
    };
    try {
      const code = await run([
        'node', 'fetch-s3-logs.js', ...source, '--out', outDir, '--no-sort',
      ], { s3 });
      const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
      const output = fs.readFileSync(path.join(outDir, 'all-logs.filtered.log'), 'utf8');
      assert.equal(code, 0);
      assert.equal(selectCalled, false);
      assert.equal(manifest.lines.matched, 1);
      assert.match(output, /OTHER/);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
});

test('generic fetch defaults to local streaming and preserves text OR field alternatives', async () => {
  for (const fieldOptions of [
    {},
    { filterFields: [{ name: 'status', value: 'FAILED' }], selectFormat: 'compact-jsonl' },
    { filterFieldExprClauses: [[{ name: 'status', value: 'FAILED' }]], selectFormat: 'compact-jsonl' },
  ]) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-local-filter-'));
    const lines = ['prefix\ttarget', 'prefix\t\ttarget', '#target', '{"status":"FAILED"}'];
    let selectCalls = 0;
    const s3 = { async send(command) {
      if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [{ Key: 'plain.log', Size: 100 }] };
      if (command.constructor.name === 'SelectObjectContentCommand') { selectCalls += 1; throw new Error('unexpected Select'); }
      return { Body: Readable.from([lines.join('\n') + '\n']) };
    } };
    try {
      const manifest = await runForScope(s3, { bucket: 'bucket', outDir, concurrency: 1, rawFields: [],
        filterText: ['target'], ...fieldOptions });
      assert.equal(manifest.status, 'complete');
      assert.equal(manifest.lines.matched, fieldOptions.selectFormat ? 4 : 3);
      assert.equal(manifest.methods.local, 1);
      assert.equal(selectCalls, 0);
    } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
  }
});

test('generic fetch supports explicit compact JSONL Select and reapplies exact local filters', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-select-verified-'));
  const lines = [JSON.stringify({ message: 'target' }), JSON.stringify({ message: 'targeting' })];
  const calls = [];
  const s3 = { async send(command) {
    calls.push(command.constructor.name);
    if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [{ Key: 'plain.log', Size: 100 }] };
    return { Payload: selectEvents(lines) };
  } };
  try {
    const code = await run(['node', 'fetch-s3-logs.js', '--s3-url', 's3://bucket/logs/', '--out', outDir,
      '--filter-text', 'target', '--whole-word', '--select-format', 'compact-jsonl'], { s3 });
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json')));
    assert.equal(code, 0);
    assert.equal(manifest.selectFormat, 'compact-jsonl');
    assert.equal(manifest.methods.select, 1);
    assert.equal(manifest.lines.matched, 1);
    assert.deepEqual(calls, ['ListObjectsV2Command', 'SelectObjectContentCommand']);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

test('generic Select discards partial responses and falls back to the whole object', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-select-fallback-'));
  const stale = JSON.stringify({ message: 'target partial' });
  const actual = JSON.stringify({ message: 'target complete' });
  const s3 = { async send(command) {
    if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [{ Key: 'plain.log', Size: 100 }] };
    if (command.constructor.name === 'SelectObjectContentCommand') return { Payload: payload([
      { Records: { Payload: Buffer.from(JSON.stringify({ _1: stale }) + '\n') } },
      { Stats: { Details: {} } }, { End: {} },
    ]) };
    return { Body: Readable.from([actual + '\n']) };
  } };
  try {
    const manifest = await runForScope(s3, { bucket: 'bucket', outDir, concurrency: 1, rawFields: [],
      filterText: ['target'], filterFields: [], selectFormat: 'compact-jsonl' });
    assert.equal(manifest.status, 'complete');
    assert.equal(manifest.lines.matched, 1);
    assert.equal(manifest.methods.fallback, 1);
    const output = fs.readFileSync(path.join(outDir, 'all-logs.filtered.log'), 'utf8');
    assert.match(output, /target complete/);
    assert.doesNotMatch(output, /target partial/);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

test('generic time filters preserve candidates with unknown event times and return incomplete', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-event-time-'));
  const lines = ['target without timestamp',
    JSON.stringify({ time: '2026-09-01T12:00:00', message: 'target' }),
    JSON.stringify({ time: '2026-09-02T12:00:00Z', message: 'target' })];
  const s3 = { async send(command) {
    if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [
      { Key: 'plain.log', LastModified: new Date('2026-09-02T12:00:00Z') },
    ] };
    return { Body: Readable.from([lines.join('\n') + '\n']) };
  } };
  try {
    const code = await run(['node', 'fetch-s3-logs.js', '--s3-url', 's3://bucket/logs/', '--out', outDir,
      '--filter-text', 'target', '--from', '2026-09-01T00:00:00Z', '--to', '2026-09-01T23:59:59Z'], { s3 });
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json')));
    assert.equal(code, 2);
    assert.equal(manifest.status, 'incomplete');
    assert.equal(manifest.lines.matched, 2);
    assert.equal(manifest.lines.timeUnverified, 2);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});
