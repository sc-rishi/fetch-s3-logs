'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { StringDecoder } = require('string_decoder');
const { GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

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
  let output = '';
  let stats;
  let ended = false;
  for await (const event of payload || []) {
    if (event.Records?.Payload) output += Buffer.from(event.Records.Payload).toString('utf8');
    if (event.Stats?.Details) stats = event.Stats.Details;
    if (event.End) ended = true;
  }
  return { output, stats, ended };
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
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(response.Body, fs.createWriteStream(outputPath));
  return outputPath;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

module.exports = {
  downloadObject,
  forEachConcurrent,
  forEachSelectRecord,
  listCommonPrefixes,
  listObjects,
  mapConcurrent,
  readSelectPayload,
  writeJson,
};
