'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildMatch, requiresDateBound } = require('../redash-query');

test('requiresDateBound blocks unbounded tag/order-id but allows batch-id or a date bound', () => {
  assert.equal(requiresDateBound({ tag: 'sc_x' }), true);
  assert.equal(requiresDateBound({ orderId: '123' }), true);
  assert.equal(requiresDateBound({ tag: 'sc_x', batchId: 'abc' }), false, 'batch-id makes it a precise lookup');
  assert.equal(requiresDateBound({ tag: 'sc_x', from: '2026-06-01' }), false);
  assert.equal(requiresDateBound({ tag: 'sc_x', to: '2026-06-01' }), false);
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
});
