'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EJSON } = require('bson');
const { checkMongoStagingConnectivity, main } = require('../mongo-query');
const { validateReadOnlyQuery } = require('../redash-query');

test('EJSON.deserialize turns Redash-style $oid/$date shortcuts into real driver values', () => {
  const deserialized = EJSON.deserialize({
    collection: 'orders',
    aggregate: [
      { $match: { $and: [
        { _id: { $oid: '6a221fb2d963eea6efaeabfa' } },
        { date: { $gte: { $date: '2026-06-04T18:30:00.000Z' } } },
      ] } },
      { $limit: 2 },
    ],
  });
  const conditions = deserialized.aggregate[0].$match.$and;
  assert.equal(conditions[0]._id.constructor.name, 'ObjectId');
  assert.equal(conditions[0]._id.toHexString(), '6a221fb2d963eea6efaeabfa');
  assert.ok(conditions[1].date.$gte instanceof Date);
  assert.equal(conditions[1].date.$gte.toISOString(), '2026-06-04T18:30:00.000Z');
});

test('connectivity probe rejects malformed rows and requires configuration', async () => {
  const unconfigured = await checkMongoStagingConnectivity({ configured: () => false });
  assert.equal(unconfigured.reason, 'mongo-staging-not-configured');
  const result = await checkMongoStagingConnectivity({ configured: () => true, query: async (queryObject) => {
    validateReadOnlyQuery(queryObject);
    return { data: { rows: [] } };
  } });
  assert.equal(result.status, 'verified');
  const unexpected = await checkMongoStagingConnectivity({ configured: () => true,
    query: async () => ({ data: { rows: [{ secret: 'withheld-value' }] } }),
  });
  assert.equal(unexpected.reason, 'MongoProtocolError');
  assert.ok(!JSON.stringify(unexpected).includes('withheld-value'));
});

test('CLI builds a bounded read-only pipeline and projects sanitized evidence', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-query-evidence-'));
  const outputPath = path.join(directory, 'evidence.json');
  try {
    await main({
      argv: ['node', 'mongo-query.js', '--collection', 'orders', '--batch-id', '6a221fb2d963eea6efaeabfa',
        '--out', outputPath],
      configured: () => true,
      query: async (queryObject) => {
        assert.doesNotThrow(() => validateReadOnlyQuery(queryObject));
        assert.equal(queryObject.collection, 'orders');
        return { data: { rows: [{ batchId: '6a221fb2d963eea6efaeabfa', status: 'COMPLETE' }] } };
      },
    });
    const saved = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(saved.length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
