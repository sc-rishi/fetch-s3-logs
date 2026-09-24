'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildScopedArgs,
  buildTextSelectExpression,
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
    { Stats: { Details: {} } },
    { End: {} },
  ]);
}

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

test('trySelectMatchingLines: tab-collision or an incomplete response signal "fall back" via null', async () => {
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
  assert.equal(await trySelectMatchingLines(tabCollision, 'bucket', 'key.log', ['sc_x'], false), null);

  const incomplete = { async send() { return { Payload: payload([{ Records: { Payload: Buffer.from('') } }]) }; } };
  assert.equal(await trySelectMatchingLines(incomplete, 'bucket', 'key.log', ['sc_x'], false), null);
});

test('trySelectMatchingLines: no filter terms skips Select entirely (returns null)', async () => {
  let called = false;
  const s3 = { async send() { called = true; return { Payload: selectEvents([]) }; } };
  assert.equal(await trySelectMatchingLines(s3, 'bucket', 'key.log', [], false), null);
  assert.equal(called, false);
});
