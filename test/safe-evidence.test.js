'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { exactMatchPaths, hashRef, loadEvidenceOptions, loadValidatedEnums, parseEvidenceSpec,
  projectEvidence, safeError } = require('../safe-evidence');

const SOURCE = `service@${'a'.repeat(40)}:src/constants.js:12`;
const evidenceValues = ({ projection, ...evidence }) => evidence;

test('shared projection keeps timestamps and only source-validated enums', () => {
  const raw = {
    s3Uri: 's3://bucket/user-account-123456789012/order.log',
    service: 'order-updates', surface: 'order-updates/eks',
    time: '2026-09-29T09:00:00+05:30',
    log: {
      event: 'ORDER_FAILED', status: 'REJECTED', code: 'BROKER_TIMEOUT', level: 'error',
      message: 'Bearer abc-secret; dealer password=hunter2; account 123456789012',
      token: 'abc-secret', accountNumber: '123456789012',
    },
  };
  const safe = projectEvidence(raw, { sourceAlias: raw.service + '/eks' });
  assert.deepEqual(evidenceValues(safe), {
    timestamp: '2026-09-29T03:30:00.000Z', sourceAlias: 'order-updates/eks',
    objectRef: hashRef(raw.s3Uri), level: 'ERROR',
  });
  assert.deepEqual(evidenceValues(projectEvidence(raw, {
    sourceAlias: raw.service + '/eks',
    validatedEnums: {
      event: new Set(['ORDER_FAILED']),
      status: new Set(['REJECTED']),
      code: new Set(['BROKER_TIMEOUT']),
    },
  })), { ...evidenceValues(safe), event: 'ORDER_FAILED', status: 'REJECTED', code: 'BROKER_TIMEOUT' });
  assert.deepEqual(safe.projection, { status: 'partial', scannedValues: 7, projectedValues: 1,
    omittedValues: 6, missingPaths: 0, truncated: false });
  assert.doesNotMatch(JSON.stringify(safe), /abc-secret|hunter2|123456789012|s3:\/\//);
  assert.deepEqual(evidenceValues(projectEvidence({ event: 'PASSWORD', status: 'MYSECRET', code: 'TOKEN' })), {});
  assert.deepEqual(evidenceValues(projectEvidence({ timestamp: '2026-02-31T12:00:00Z' })), {});
  assert.deepEqual(evidenceValues(projectEvidence({ timestamp: '2026-09-29T24:00:00Z' })), {});
  assert.deepEqual(evidenceValues(projectEvidence({
    event: 'Bearer abc-secret', status: 'clientJaneDoe', code: 'account123456789',
    sourceAlias: 'user-account-123456789012',
  })), {});
  assert.equal(safeError({ name: 'InvalidObjectState', message: 'Bearer secret' }), 'InvalidObjectState');
  assert.equal(safeError({ name: 'ServerSaidBearerSecret' }), 'ExternalRequestFailed');
});

test('exact match paths include only validated field names and never values', () => {
  const record = { log: {
    orders: [{ tag: 'sc_secret' }],
    '123456789012': 'sc_secret',
    message: 'prefix sc_secret suffix',
  } };
  assert.deepEqual(exactMatchPaths(record, 'sc_secret'), ['orders[].tag']);
  assert.deepEqual(exactMatchPaths(record, 'missing'), []);
  assert.deepEqual(exactMatchPaths({ 'orders[0].tag': 'sc_secret' }, 'sc_secret'), []);
});

test('reviewed typed fields preserve array identity without emitting identifiers or arbitrary text', () => {
  const evidenceSpec = parseEvidenceSpec({
    fields: [
      { path: 'orders[].status', kind: 'status', values: [3, 4], source: SOURCE },
      { path: 'orders[].code', kind: 'code', values: [false, true], source: SOURCE },
      { path: 'orders[].event', kind: 'event', values: ['CANCELLED AMO', 'rejected'], source: SOURCE },
    ],
    identifiers: [{ path: 'orders[].tag', source: SOURCE }],
  });
  const record = { timestamp: '2026-09-29T00:00:00Z', orders: [
    { tag: 'private-target', status: 3, code: false, event: 'CANCELLED AMO', message: 'password=hidden' },
    { tag: 'private-other', status: 4, code: true, event: 'rejected' },
    { tag: 'private-third', status: '3', code: 'true', event: 'unreviewed' },
  ] };
  const safe = projectEvidence(record, { evidenceSpec, queryValue: 'private-target' });
  assert.equal(safe.evidence.length, 6);
  assert.deepEqual(safe.evidence[0], { kind: 'status', value: 3, path: 'orders[0].status',
    source: SOURCE, correlation: 'matched_element' });
  assert.equal(safe.evidence[1].correlation, 'other_element');
  assert.equal(safe.evidence.find((field) => field.path === 'orders[0].code').value, false);
  assert.equal(safe.evidence.find((field) => field.path === 'orders[1].event').value, 'rejected');
  assert.equal(safe.projection.projectedValues, 7);
  assert.equal(safe.projection.omittedValues, 7);
  assert.doesNotMatch(JSON.stringify(safe), /private-|password=hidden|unreviewed/);
  const uncorrelated = projectEvidence(record, { evidenceSpec, queryValue: 'missing' });
  assert.ok(uncorrelated.evidence.every((field) => field.correlation === 'unverified'));
  assert.deepEqual(projectEvidence({ 'orders[0].status': 3 }, { evidenceSpec }).evidence, []);
});

test('reviewed paths require pinned sources and reject executable paths and non-scalar allowlists', () => {
  const base = { path: 'status', kind: 'status', values: ['rejected'], source: SOURCE };
  for (const change of [
    { source: undefined }, { source: 'service@production:src/a.js:1' },
    { source: `service@${'a'.repeat(40)}:../private:1` },
    { path: '$.status' }, { path: 'orders[0].status' }, { path: 'orders[?(@.tag)].status' },
    { path: '__proto__.status' }, { path: 'status;process.exit()' },
    { values: [{ secret: 'hidden' }] }, { values: [Infinity] }, { values: ['line\nbreak'] },
  ]) assert.throws(() => parseEvidenceSpec({ fields: [{ ...base, ...change }] }));
  assert.throws(() => parseEvidenceSpec({ fields: [base], identifiers: [{ path: 'tag' }] }));
  assert.throws(() => loadEvidenceOptions({ evidenceSpecPath: 'a', validatedEnumsPath: 'b' }));
});

test('matching parent or sibling array identifiers cannot establish a child element identity', () => {
  const record = { batches: [{
    orders: [{ tag: 'private-target' }],
    trades: [{ status: 3 }],
  }] };
  const siblingSpec = parseEvidenceSpec({ fields: [
    { path: 'batches[].trades[].status', kind: 'status', values: [3], source: SOURCE },
  ],
    identifiers: [{ path: 'batches[].orders[].tag', source: SOURCE }] });
  const siblingMatched = projectEvidence(record, { evidenceSpec: siblingSpec, queryValue: 'private-target' });
  assert.equal(siblingMatched.evidence[0].correlation, 'record_match_only');
  const childRecord = { orders: [{ tag: 'private-target', fills: [{ status: 3, tag: 'private-fill' }] }] };
  const fields = [{ path: 'orders[].fills[].status', kind: 'status', values: [3], source: SOURCE }];
  const parentSpec = parseEvidenceSpec({ fields, identifiers: [{ path: 'orders[].tag', source: SOURCE }] });
  const parentMatched = projectEvidence(childRecord, { evidenceSpec: parentSpec, queryValue: 'private-target' });
  assert.equal(parentMatched.evidence[0].correlation, 'record_match_only');
  const childSpec = parseEvidenceSpec({ fields,
    identifiers: [{ path: 'orders[].fills[].tag', source: SOURCE }] });
  const childMatched = projectEvidence(childRecord, { evidenceSpec: childSpec, queryValue: 'private-fill' });
  assert.equal(childMatched.evidence[0].correlation, 'matched_element');
  assert.doesNotMatch(JSON.stringify(parentMatched) + JSON.stringify(childMatched), /private-/);
});

test('projection records missing reviewed paths and bounded traversal independently of retrieval', () => {
  const evidenceSpec = parseEvidenceSpec({ fields: [
    { path: 'orders[].status', kind: 'status', values: [3], source: SOURCE },
    { path: 'missing.code', kind: 'code', values: ['FAILED'], source: SOURCE },
  ] });
  const safe = projectEvidence({ timestamp: '2026-09-29T00:00:00Z',
    orders: Array.from({ length: 600 }, () => ({ status: 3, password: 'hidden' })) }, { evidenceSpec });
  assert.equal(safe.projection.status, 'partial');
  assert.equal(safe.projection.truncated, true);
  assert.equal(safe.projection.missingPaths, 1);
  assert.ok(safe.projection.scannedValues < 500);
  assert.ok(safe.projection.omittedValues > 0);
  assert.doesNotMatch(JSON.stringify(safe), /hidden/);
  assert.equal(safe.retrieval, undefined);
});

test('safe-evidence CLI loads reviewed evidence specs and rejects competing options before writing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-spec-test-'));
  try {
    const input = path.join(dir, 'input.json');
    const spec = path.join(dir, 'spec.json');
    const output = path.join(dir, 'safe.jsonl');
    const identifier = path.join(dir, 'identifier.txt');
    fs.writeFileSync(identifier, 'private-target\n', { mode: 0o600 });
    fs.writeFileSync(input, JSON.stringify({ orders: [{ tag: 'private-target', status: 3 },
      { tag: 'private-other', status: 3 }], secret: 'private-value' }));
    fs.writeFileSync(spec, JSON.stringify({ fields: [
      { path: 'orders[].status', kind: 'status', values: [3], source: SOURCE },
    ], identifiers: [{ path: 'orders[].tag', source: SOURCE }] }));
    const script = path.join(__dirname, '..', 'safe-evidence.js');
    const run = spawnSync(process.execPath, [script, '--input', input, '--out', output,
      '--evidence-spec', spec, '--identifier-file', identifier], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    const summary = JSON.parse(run.stdout);
    assert.equal(summary.status, 'complete');
    assert.equal(summary.projection.status, 'partial');
    const safe = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(safe.evidence[0].value, 3);
    assert.equal(safe.evidence[0].correlation, 'matched_element');
    assert.equal(safe.evidence[1].correlation, 'other_element');
    assert.doesNotMatch(run.stdout + run.stderr + fs.readFileSync(output, 'utf8'), /private-/);
    const rejectedOutput = path.join(dir, 'rejected.jsonl');
    const rejected = spawnSync(process.execPath, [script, '--input', input, '--out', rejectedOutput,
      '--evidence-spec', spec, '--validated-enums', spec], { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.equal(fs.existsSync(rejectedOutput), false);
    fs.chmodSync(identifier, 0o644);
    const publicIdentifier = spawnSync(process.execPath, [script, '--input', input, '--out', rejectedOutput,
      '--evidence-spec', spec, '--identifier-file', identifier], { encoding: 'utf8' });
    assert.equal(publicIdentifier.status, 1);
    assert.equal(fs.existsSync(rejectedOutput), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('safe-evidence CLI projects supported raw formats and counts unknown lines without echoing them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-evidence-test-'));
  try {
    const input = path.join(dir, 'raw.jsonl');
    const output = path.join(dir, 'safe.jsonl');
    fs.writeFileSync(input, [
      JSON.stringify({ timestamp: '2026-09-29T00:00:00Z', status: 'FAILED', password: 'hunter2' }),
      'Bearer supersecret',
    ].join('\n'));
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'safe-evidence.js'),
      '--input', input, '--out', output], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.deepEqual(JSON.parse(run.stdout), { status: 'incomplete', projected: 1, withheld: 1,
      projection: { status: 'partial', scannedValues: 3, projectedValues: 1,
        omittedValues: 2, missingPaths: 0, truncated: false } });
    assert.doesNotMatch(run.stdout + run.stderr + fs.readFileSync(output, 'utf8'), /hunter2|supersecret/);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);

    const legacyInput = path.join(dir, 'all-logs.filtered.log');
    const legacyOut = path.join(dir, 'legacy-safe.jsonl');
    fs.writeFileSync(legacyInput, '{\n  "time": "2026-09-29T00:00:00Z",\n  "event": "ORDER_FAILED",\n  "password": "hunter2"\n},\n');
    const legacy = spawnSync(process.execPath, [path.join(__dirname, '..', 'safe-evidence.js'),
      '--input', legacyInput, '--out', legacyOut], { encoding: 'utf8' });
    assert.equal(legacy.status, 0);
    assert.doesNotMatch(fs.readFileSync(legacyOut, 'utf8'), /ORDER_FAILED/);
    assert.match(fs.readFileSync(legacyOut, 'utf8'), /2026-09-29T00:00:00.000Z/);
    assert.doesNotMatch(fs.readFileSync(legacyOut, 'utf8'), /hunter2/);

    const enumsFile = path.join(dir, 'source-enums.json');
    const validatedOut = path.join(dir, 'validated-safe.jsonl');
    fs.writeFileSync(enumsFile, JSON.stringify({ event: ['ORDER_FAILED'] }));
    const validated = spawnSync(process.execPath, [path.join(__dirname, '..', 'safe-evidence.js'),
      '--input', legacyInput, '--out', validatedOut, '--validated-enums', enumsFile], { encoding: 'utf8' });
    assert.equal(validated.status, 0);
    assert.match(fs.readFileSync(validatedOut, 'utf8'), /ORDER_FAILED/);
    assert.doesNotMatch(fs.readFileSync(validatedOut, 'utf8'), /hunter2/);
    const invalidEnumsFile = path.join(dir, 'invalid-enums.json');
    fs.writeFileSync(invalidEnumsFile, JSON.stringify({ status: ['MY SECRET'] }));
    assert.throws(() => loadValidatedEnums(invalidEnumsFile));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
