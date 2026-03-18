#!/usr/bin/env node
/* eslint-disable no-console, no-plusplus */
const fs = require('fs');
const path = require('path');
const { pipeline, Transform } = require('stream');
const { promisify } = require('util');
const zlib = require('zlib');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

const pipe = promisify(pipeline);

process.env.AWS_PROFILE = 'smallcase';
process.env.AWS_SDK_LOAD_CONFIG = '1';
process.env.AWS_REGION = 'ap-south-1';
process.env.AWS_DEFAULT_REGION = 'ap-south-1';

const JOB_CONFIG = {
  S3_URL: 's3://sc-pm2logs-new/PROD/2025-11-21/sc-integrations-broker-api/',
  OUT_DIR: './gzip-logs',
  CONCURRENCY: 4,
  MAX_KEYS: 1000,
  DIR: undefined,
  FILTER: 'hdfcsky',
  START_AFTER: undefined,
};

function parseS3Url(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith('s3://')) return null;
  const withoutScheme = trimmed.slice('s3://'.length);
  const firstSlash = withoutScheme.indexOf('/');
  if (firstSlash === -1) return { bucket: withoutScheme, prefix: '' };
  const bucket = withoutScheme.slice(0, firstSlash);
  let prefix = withoutScheme.slice(firstSlash + 1);
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  return { bucket, prefix };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureLogExtension(filePath) {
  if (!filePath) return filePath;
  if (filePath.endsWith('.log')) return filePath;
  return `${filePath}.log`;
}

function computeDownloadPath(outDir, key, isGzip) {
  const targetPath = path.join(outDir, key);
  const dirName = path.dirname(targetPath);
  ensureDir(dirName);
  if (isGzip && targetPath.endsWith('.gz')) {
    return ensureLogExtension(targetPath.slice(0, -3));
  }
  return ensureLogExtension(targetPath);
}

function looksLikeGzipKey(key) {
  return key.endsWith('.gz') || key.endsWith('.gzip');
}

function createBeautifyTransform(filterTerm) {
  let leftover = '';
  const filterNeedle = filterTerm ? String(filterTerm).toLowerCase() : null;
  const formatLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return '\n';
    try {
      const parsed = JSON.parse(line);
      return `${JSON.stringify(parsed, null, 2)}\n`;
    } catch {
      return `${line}\n`;
    }
  };
  return new Transform({
    readableHighWaterMark: 64 * 1024,
    writableHighWaterMark: 64 * 1024,
    transform(chunk, encoding, callback) {
      const data = leftover + chunk.toString('utf8');
      const parts = data.split(/\r?\n/);
      leftover = parts.pop();
      for (const part of parts) {
        if (filterNeedle && !part.toLowerCase().includes(filterNeedle)) {
          // skip line
          continue;
        }
        this.push(formatLine(part));
      }
      callback();
    },
    flush(callback) {
      if (leftover) {
        if (!filterNeedle || leftover.toLowerCase().includes(filterNeedle)) {
          this.push(formatLine(leftover));
        }
      }
      callback();
    },
  });
}

async function listAllObjects({ s3, bucket, prefix, startAfter, maxKeys }) {
  const items = [];
  let continuationToken;
  let isFirst = true;
  while (true) {
    const params = {
      Bucket: bucket,
      Prefix: prefix || '',
      MaxKeys: maxKeys || 1000,
    };
    if (continuationToken) params.ContinuationToken = continuationToken;
    if (isFirst && startAfter) params.StartAfter = startAfter;
    const resp = await s3.send(new ListObjectsV2Command(params));
    const contents = resp.Contents || [];
    for (const item of contents) {
      if (item && item.Key && !item.Key.endsWith('/')) {
        items.push({ key: item.Key });
      }
    }
    if (!resp.IsTruncated) break;
    continuationToken = resp.NextContinuationToken;
    isFirst = false;
  }
  return items;
}

async function downloadAndMaybeGunzip({ s3, bucket, key, outDir, filter }) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bodyStream = resp.Body;
  const shouldGunzip =
    looksLikeGzipKey(key) ||
    (resp.ContentEncoding && String(resp.ContentEncoding).toLowerCase().includes('gzip')) ||
    (resp.ContentType && String(resp.ContentType).toLowerCase().includes('gzip'));
  const outPath = computeDownloadPath(outDir, key, shouldGunzip);
  const writeStream = fs.createWriteStream(outPath, { flags: 'w' });
  const beautifyStream = createBeautifyTransform(filter);
  const source = shouldGunzip ? bodyStream.pipe(zlib.createGunzip()) : bodyStream;
  await pipe(source, beautifyStream, writeStream);
  console.log(`Fetched s3://${bucket}/${key} -> ${outPath}`);
}

async function run() {
  const config = { ...JOB_CONFIG };
  if (!config.S3_URL && (!config.bucket || !config.prefix)) {
    console.error('Error: S3_URL (or explicit bucket/prefix) and OUT_DIR are required.');
    process.exit(1);
  }
  if (!config.OUT_DIR) {
    console.error('Error: OUT_DIR is required.');
    process.exit(1);
  }

  if (config.S3_URL) {
    const parsed = parseS3Url(config.S3_URL);
    if (!parsed) {
      console.error('Invalid S3_URL. Expected format: s3://bucket/prefix/');
      process.exit(1);
    }
    config.bucket = parsed.bucket;
    config.prefix = parsed.prefix || '';
  }

  const resolvedOutDir = path.isAbsolute(config.OUT_DIR) ? config.OUT_DIR : path.resolve(__dirname, config.OUT_DIR);
  config.OUT_DIR = resolvedOutDir;
  ensureDir(config.OUT_DIR);

  const s3 = new S3Client({ region: 'ap-south-1' });
  console.log(`Listing objects in bucket=${config.bucket} prefix=${config.prefix || '(none)'} ...`);
  const allItems = await listAllObjects({
    s3,
    bucket: config.bucket,
    prefix: config.prefix,
    startAfter: config.START_AFTER,
    maxKeys: config.MAX_KEYS,
  });
  if (!allItems.length) {
    console.log('No objects found.');
    return;
  }

  const filtered = allItems.filter((item) => {
    if (!config.DIR) return true;
    const rel = item.key.startsWith(config.prefix) ? item.key.slice(config.prefix.length) : item.key;
    const firstSeg = rel.split('/')[0] || '';
    return firstSeg === config.DIR;
  });
  if (!filtered.length) {
    console.log('No objects matched the directory filter.');
    return;
  }

  console.log(`Found ${filtered.length} object(s). Downloading into ${config.OUT_DIR} with concurrency=${config.CONCURRENCY} ...`);
  let inFlight = 0;
  let idx = 0;
  let failed = 0;
  await new Promise((resolve) => {
    const maybeStartNext = () => {
      while (inFlight < config.CONCURRENCY && idx < filtered.length) {
        const { key } = filtered[idx++];
        inFlight += 1;
        downloadAndMaybeGunzip({
          s3,
          bucket: config.bucket,
          key,
          outDir: config.OUT_DIR,
          filter: config.FILTER,
        })
          .catch((err) => {
            failed += 1;
            console.error(`Failed for key=${key}:`, err && err.message ? err.message : err);
          })
          .finally(() => {
            inFlight -= 1;
            if (idx >= filtered.length && inFlight === 0) resolve();
            else maybeStartNext();
          });
      }
    };
    maybeStartNext();
  });

  if (failed > 0) {
    console.log(`Completed with ${failed} failure(s).`);
  } else {
    console.log('Completed successfully.');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

