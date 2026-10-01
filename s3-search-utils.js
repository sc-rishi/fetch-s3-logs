'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { StringDecoder } = require('string_decoder');
const zlib = require('zlib');
const { GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const COMPACT_JSONL = 'compact-jsonl';

function logInputStream(readable, gzip) {
  if (!gzip) return readable;
  const input = zlib.createGunzip();
  readable.once('error', (error) => input.destroy(error));
  input.once('close', () => readable.destroy());
  return readable.pipe(input);
}

function validateSelectComplete({ ended, stats }, expectedSize) {
  const scanned = stats?.BytesScanned;
  if (!ended || !Number.isFinite(scanned) || scanned < 0 ||
      (Number.isFinite(expectedSize) && scanned < expectedSize)) {
    throw new Error('Incomplete S3 Select response.');
  }
}

function compactJsonSelectExpression(predicate) {
  // A malformed/extra CSV column must reach the decoder even when it does not match the query.
  // Unsupported CSV MISSING semantics fail Select and use the existing full-object fallback.
  return `SELECT * FROM S3Object s WHERE (${predicate}) OR s._2 IS NOT MISSING OR s._1 NOT LIKE '{%}'`;
}

function compactJsonLine(record) {
  if (!record || Object.keys(record).length !== 1 || typeof record._1 !== 'string' ||
      !record._1.startsWith('{') || !record._1.endsWith('}') || /[\u0000-\u001f]/.test(record._1)) {
    throw new Error('Source does not satisfy the compact JSONL format.');
  }
  const parsed = JSON.parse(record._1);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Source does not satisfy the compact JSONL format.');
  }
  return record._1;
}

async function listObjects(s3, { bucket, prefix, filter = () => true }) {
  const objects = [];
  let continuationToken;
  do {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const item of response.Contents || []) {
      if (!item.Key || item.Key.endsWith('/') || !filter(item.Key)) continue;
      objects.push({
        bucket,
        key: item.Key,
        size: item.Size,
        etag: item.ETag,
        lastModified: item.LastModified ? new Date(item.LastModified) : undefined,
      });
    }
    if (response.IsTruncated && !response.NextContinuationToken) {
      throw new Error('Incomplete S3 object listing.');
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return objects;
}

async function listCommonPrefixes(s3, { bucket, prefix }) {
  const prefixes = [];
  let continuationToken;
  do {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
      ContinuationToken: continuationToken,
    }));
    prefixes.push(...(response.CommonPrefixes || []).map((item) => item.Prefix).filter(Boolean));
    if (response.IsTruncated && !response.NextContinuationToken) {
      throw new Error('Incomplete S3 prefix listing.');
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return prefixes;
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function forEachConcurrent(items, concurrency, worker) {
  let next = 0;
  async function run() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

async function readSelectPayload(payload) {
  const decoder = new StringDecoder('utf8');
  let output = '';
  let stats;
  let ended = false;
  for await (const event of payload || []) {
    if (event.Records?.Payload) output += decoder.write(Buffer.from(event.Records.Payload));
    if (event.Stats?.Details) stats = event.Stats.Details;
    if (event.End) ended = true;
  }
  return { output: output + decoder.end(), stats, ended };
}

// Streams an S3 Select JSON-record payload, decoding across chunk boundaries (a record can split
// mid-multibyte-character between Payload events), and calls onRecord(parsedRecord) for each
// complete record. Returns { ended, stats } so the caller can detect a truncated/incomplete response.
async function forEachSelectRecord(payload, onRecord) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let ended = false;
  let stats = null;
  for await (const event of payload || []) {
    if (event.Records?.Payload) {
      pending += decoder.write(Buffer.from(event.Records.Payload));
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const recordText = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (recordText.trim()) onRecord(JSON.parse(recordText));
        newline = pending.indexOf('\n');
      }
    }
    if (event.Stats?.Details) stats = event.Stats.Details;
    if (event.End) ended = true;
  }
  pending += decoder.end();
  if (pending.trim()) onRecord(JSON.parse(pending));
  return { ended, stats };
}

async function downloadObject(s3, { bucket, key, outputPath }) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(response.Body, fs.createWriteStream(outputPath, { mode: 0o600 }));
  fs.chmodSync(outputPath, 0o600);
  return outputPath;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

module.exports = {
  COMPACT_JSONL,
  compactJsonLine,
  compactJsonSelectExpression,
  downloadObject,
  forEachConcurrent,
  forEachSelectRecord,
  listCommonPrefixes,
  listObjects,
  logInputStream,
  mapConcurrent,
  readSelectPayload,
  validateSelectComplete,
  writeJson,
};
