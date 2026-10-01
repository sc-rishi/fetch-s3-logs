'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildMatch, checkRedashConnectivity, findOrderAnchorDate, httpRequest, main, parseArgs, requiresDateBound,
  runRedashQuery, validateReadOnlyQuery,
} = require('../redash-query');

test('requiresDateBound enforces a finite 30-day window for unindexed identifiers', () => {
  assert.equal(requiresDateBound({ tag: 'sc_x' }), true);
  assert.equal(requiresDateBound({ orderId: '123' }), true);
  assert.equal(requiresDateBound({ tag: 'sc_x', batchId: 'abc' }), false, 'batch-id makes it a precise lookup');
  assert.equal(requiresDateBound({ tag: 'sc_x', from: '2026-06-01' }), true);
  assert.equal(requiresDateBound({ tag: 'sc_x', to: '2026-06-01' }), true);
  assert.equal(requiresDateBound({ tag: 'sc_x', from: '2026-06-01', to: '2026-06-30' }), false);
  assert.equal(requiresDateBound({ tag: 'sc_x', from: '2026-06-01', to: '2026-07-01' }), true);
  assert.equal(requiresDateBound({ tag: 'sc_x', from: '2026-06-31', to: '2026-07-01' }), true);
  assert.equal(requiresDateBound({ batchId: 'abc' }), false, 'batch-id alone never needs a bound');
  assert.equal(requiresDateBound({ match: '{"broker":"sbi"}' }), false, 'bare --match is the documented escape hatch');
});

test('buildMatch matches batchId against both the batchId field and _id as ObjectId', () => {
  const match = buildMatch({ batchId: '6a221fb2d963eea6efaeabfa' });
  assert.deepEqual(match, {
    $or: [{ batchId: '6a221fb2d963eea6efaeabfa' }, { _id: { $oid: '6a221fb2d963eea6efaeabfa' } }],
  });
  // a non-ObjectId-shaped batchId (e.g. a legacy/test value) must not synthesize an invalid $oid clause
  const looseMatch = buildMatch({ batchId: 'not-24-hex-chars' });
  assert.deepEqual(looseMatch, { $or: [{ batchId: 'not-24-hex-chars' }] });
});

test('buildMatch ANDs multiple shortcuts and applies IST day boundaries to from/to', () => {
  const match = buildMatch({ tag: 'sc_x', broker: 'sbi', from: '2026-06-05', to: '2026-06-05' });
  assert.deepEqual(match, {
    $and: [
      { $or: [{ 'orders.tag': 'sc_x' }, { 'unplaced.tag': 'sc_x' }] },
      { broker: 'sbi' },
      { date: { $gte: { $date: '2026-06-04T18:30:00.000Z' }, $lte: { $date: '2026-06-05T18:29:59.999Z' } } },
    ],
  });
  for (const args of [
    { batchId: 'abc', from: '2026-02-30' },
    { broker: 'sbi', to: '2026-06-31' },
    { status: 'ERROR', from: '2026-06-06', to: '2026-06-05' },
  ]) assert.throws(() => buildMatch(args));
});

test('Redash aggregate guard permits bounded reads and rejects writes and executable match operators', () => {
  const match = { _id: { $oid: '000000000000000000000000' } };
  const base = { collection: 'orders', aggregate: [{ $match: match }, { $limit: 2 }] };
  assert.doesNotThrow(() => validateReadOnlyQuery(base));
  assert.doesNotThrow(() => validateReadOnlyQuery({
    ...base, aggregate: [{ $match: match }, { $project: { date: 1, _id: 0 } }, { $limit: 2 }],
  }));
  for (const aggregate of [
    [{ $match: match }, { $out: 'orders' }],
    [{ $match: match }, { $merge: 'orders' }, { $limit: 2 }],
    [{ $match: match }, { $lookup: { from: 'users', pipeline: [{ $out: 'users' }] } }, { $limit: 2 }],
    [{ $match: { $where: 'function() { return true; }' } }, { $limit: 2 }],
    [{ $match: { $expr: { $function: { body: 'return true' } } } }, { $limit: 2 }],
    [{ $match: {} }, { $limit: 2 }],
    [{ $match: match }],
    [{ $match: match }, { $limit: 101 }],
    [{ $match: { date: { $gte: { $date: '2026-02-30T00:00:00.000Z' } } } }, { $limit: 2 }],
  ]) {
    assert.throws(() => validateReadOnlyQuery({ collection: 'orders', aggregate }));
  }
  assert.throws(() => validateReadOnlyQuery({ ...base, update: { status: 'COMPLETE' } }));
});

test('anchor lookup projects only date and refuses ambiguous matches', async () => {
  const calls = [];
  const query = async (queryObject) => {
    calls.push(queryObject);
    return { data: { rows: [{ date: '2026-06-05T00:00:00.000Z' }, { date: '2026-06-06T00:00:00.000Z' }] } };
  };
  const result = await findOrderAnchorDate({ tag: 'sc_private', lookbackDays: 7 },
    { configured: () => true, query });
  assert.deepEqual(result, { date: null, reason: 'ambiguous', lookbackDays: 7 });
  assert.deepEqual(calls[0].aggregate.slice(1), [{ $project: { date: 1, _id: 0 } }, { $limit: 2 }]);
  assert.doesNotThrow(() => validateReadOnlyQuery(calls[0]));
  assert.deepEqual(await findOrderAnchorDate({ tag: 'sc_private', lookbackDays: 7 }, {
    configured: () => true, query: async () => ({ data: { rows: [{ date: null }] } }),
  }), { date: null, reason: 'invalid-date', lookbackDays: 7 });
  for (const invalidDate of ['2026-02-30', '2026-02-30T00:00:00.000Z']) {
    assert.deepEqual(await findOrderAnchorDate({ tag: 'sc_private', lookbackDays: 7 }, {
      configured: () => true, query: async () => ({ data: { rows: [{ date: invalidDate }] } }),
    }), { date: null, reason: 'invalid-date', lookbackDays: 7 });
  }
  const validDate = await findOrderAnchorDate({ batchId: 'batch', lookbackDays: 7 }, {
    configured: () => true, query: async () => ({ data: { rows: [{ date: '2026-06-05' }] } }),
  });
  assert.equal(validDate.date.toISOString(), '2026-06-05T00:00:00.000Z');
  await assert.rejects(findOrderAnchorDate({}, { configured: () => true, query }));
  await assert.rejects(findOrderAnchorDate({ tag: 'sc_private', lookbackDays: 7 }, {
    configured: () => true, query: async () => ({ data: { rows: null } }),
  }), { name: 'RedashProtocolError' });
});

test('cache hits and completed jobs require a valid rows envelope', async () => {
  const queryObject = { collection: 'orders', aggregate: [
    { $match: { _id: { $oid: '000000000000000000000000' } } }, { $limit: 2 },
  ] };
  const requestFor = (responses) => async () => responses.shift();
  for (const response of [{ query_result: {} }, { query_result: { data: { rows: null } } }, {}]) {
    await assert.rejects(runRedashQuery(queryObject, { request: requestFor([response]) }),
      { name: 'RedashProtocolError' });
  }
  const completed = await runRedashQuery(queryObject, { request: requestFor([
    { job: { id: 'job1' } },
    { job: { status: 3, query_result_id: 'result1' } },
    { query_result: { data: { rows: [{ date: '2026-06-05' }] } } },
  ]) });
  assert.equal(completed.data.rows.length, 1);
  await assert.rejects(runRedashQuery(queryObject, { request: requestFor([
    { job: { id: 'job1' } },
    { job: { status: 3, query_result_id: 'result1' } },
    { query_result: { data: { rows: 'not an array' } } },
  ]) }), { name: 'RedashProtocolError' });
});

test('overall Redash deadline uses elapsed time, including request time', async () => {
  const queryObject = { collection: 'orders', aggregate: [
    { $match: { _id: { $oid: '000000000000000000000000' } } }, { $limit: 1 },
  ] };
  let elapsed = 0;
  let calls = 0;
  await assert.rejects(runRedashQuery(queryObject, {
    now: () => elapsed,
    sleep: async (duration) => { elapsed += duration; },
    request: async (_method, _url, options) => {
      calls += 1;
      assert.equal(options.deadline, 120000);
      elapsed += 50000;
      return calls === 1 ? { job: { id: 'job1' } } : { job: { status: 2 } };
    },
  }), { name: 'RequestTimeout' });
  assert.equal(calls, 3);
});

test('per-request deadline aborts a stalled request and HTTP errors omit response bodies', async () => {
  const stalledTransport = () => {
    const request = new EventEmitter();
    request.end = () => {};
    request.destroy = (error) => request.emit('error', error);
    return request;
  };
  await assert.rejects(httpRequest('GET', 'https://example.test/api', {
    deadline: Date.now() + 5, transport: stalledTransport,
  }), { name: 'RequestTimeout' });
  const rejectedTransport = (_options, respond) => {
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 403;
      respond(response);
      response.emit('data', 'secret remote body');
      response.emit('end');
    });
    return request;
  };
  await assert.rejects(httpRequest('GET', 'https://example.test/api', { transport: rejectedTransport }),
    (error) => error.name === 'RedashHttpError' && !error.message.includes('secret'));
});

test('connectivity probe rejects malformed rows and CLI accepts evidence spec', async () => {
  assert.equal((await checkRedashConnectivity({ configured: () => true,
    query: async () => ({ data: { rows: null } }),
  })).reason, 'RedashProtocolError');
  assert.equal(parseArgs(['node', 'redash-query.js', '--collection', 'orders', '--evidence-spec', '/tmp/spec.json'])
    .evidenceSpecPath, '/tmp/spec.json');
  assert.throws(() => parseArgs(['node', 'redash-query.js', '--evidence-spec']));
});

test('connectivity probe uses a contradictory read-only filter and rejects unexpected records', async () => {
  const result = await checkRedashConnectivity({ configured: () => true, query: async (queryObject) => {
    validateReadOnlyQuery(queryObject);
    const conditions = queryObject.aggregate[0].$match.$and;
    for (const exists of [true, false]) {
      assert.equal(conditions.every((condition) => condition._id.$exists === exists), false);
    }
    return { data: { rows: [] } };
  } });
  assert.equal(result.status, 'verified');
  const unexpected = await checkRedashConnectivity({ configured: () => true,
    query: async () => ({ data: { rows: [{ secret: 'withheld-value' }] } }),
  });
  assert.equal(unexpected.reason, 'RedashProtocolError');
  assert.ok(!JSON.stringify(unexpected).includes('withheld-value'));
});

test('CLI projects source-reviewed evidence and correlates the matched array element', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'redash-evidence-'));
  const specPath = path.join(directory, 'spec.json');
  const outputPath = path.join(directory, 'evidence.json');
  const source = `orders@${'a'.repeat(40)}:src/orders.js:12`;
  try {
    fs.writeFileSync(specPath, JSON.stringify({
      fields: [{ path: 'orders[].status', kind: 'status', values: ['ERROR'], source }],
      identifiers: [{ path: 'orders[].tag', source }],
    }));
    await main({
      argv: ['node', 'redash-query.js', '--collection', 'orders', '--tag', 'sc_private',
        '--from', '2026-06-05', '--to', '2026-06-05', '--evidence-spec', specPath, '--out', outputPath],
      configured: () => true,
      query: async (queryObject) => {
        assert.doesNotThrow(() => validateReadOnlyQuery(queryObject));
        return { data: { rows: [{ orders: [
          { tag: 'sc_private', status: 'ERROR', secret: 'Bearer secret' },
          { tag: 'another_order', status: 'ERROR' },
        ] }] } };
      },
    });
    const saved = fs.readFileSync(outputPath, 'utf8');
    const [record] = JSON.parse(saved);
    assert.deepEqual(record.evidence.map(({ path: fieldPath, correlation }) => [fieldPath, correlation]), [
      ['orders[0].status', 'matched_element'],
      ['orders[1].status', 'other_element'],
    ]);
    assert.equal(record.evidence[0].value, 'ERROR');
    assert.equal(record.evidence[0].source, source);
    assert.ok(!saved.includes('sc_private'));
    assert.ok(!saved.includes('Bearer secret'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
