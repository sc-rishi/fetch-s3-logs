'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { compactJsonLine, listCommonPrefixes, listObjects, readSelectPayload, validateSelectComplete } = require('../s3-search-utils');

test('truncated S3 listings without continuation tokens fail closed', async () => {
  const s3 = { send: async () => ({
    IsTruncated: true,
    Contents: [{ Key: 'day/first.log' }],
    CommonPrefixes: [{ Prefix: 'day/' }],
  }) };
  await assert.rejects(listObjects(s3, { bucket: 'bucket', prefix: 'day/' }), /Incomplete S3 object listing/);
  await assert.rejects(listCommonPrefixes(s3, { bucket: 'bucket', prefix: '' }), /Incomplete S3 prefix listing/);
});

test('Select completeness requires finite byte coverage and an end event', () => {
  for (const scanned of [undefined, null, NaN, Infinity, -1, 99, '100']) {
    assert.throws(() => validateSelectComplete({ ended: true, stats: { BytesScanned: scanned } }, 100));
  }
  assert.throws(() => validateSelectComplete({ ended: false, stats: { BytesScanned: 100 } }, 100));
  assert.doesNotThrow(() => validateSelectComplete({ ended: true, stats: { BytesScanned: 100 } }, 100));
});

test('compact JSONL rejects consecutive CSV tabs and non-JSON/comment records', () => {
  for (const record of [
    { _1: '{}', _2: '', _3: 'target' }, { _1: '{}', _2: '' }, { _1: '#target' },
    { _1: '{not-json}' }, { _1: '{"field":\t"target"}' }, { _1: 'null' },
  ]) assert.throws(() => compactJsonLine(record));
  const line = JSON.stringify({ message: 'escaped\ttarget' });
  assert.equal(compactJsonLine({ _1: line }), line);
});

test('Select payload preserves a multibyte character split across events', async () => {
  const encoded = Buffer.from('₹\n');
  const payload = (async function* () {
    yield { Records: { Payload: encoded.subarray(0, 1) } };
    yield { Records: { Payload: encoded.subarray(1) } };
  }());
  assert.equal((await readSelectPayload(payload)).output, '₹\n');
});

test('gzip input and decompression failures produce sanitized incomplete manifests in both CLIs', () => {
  const script = `
    const { Readable } = require('node:stream');
    const [tool, mode, out] = process.argv.slice(1);
    const s3 = { send: async (command) => {
      if (command.constructor.name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: 'fixture.gz', Size: 100 }] };
      }
      const Body = mode === 'source' ? new Readable({ read() {
        this.destroy(new Error('synthetic-private-stream-detail'));
      } }) : Readable.from(['synthetic-private-gzip-detail']);
      return { Body };
    } };
    const task = tool === 'fetch'
      ? require('./fetch-s3-logs').run(['node', 'fetch-s3-logs.js', '--s3-url', 's3://synthetic/logs/',
          '--out', out, '--no-filter-text', '--no-sort'], { s3 })
      : require('./search-s3-logs').main(['--service', 'platform-api', '--env', 'staging', '--text', 'target',
          '--date', '2026-09-01', '--out', out], { s3 });
    task.then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 99; });
  `;
  for (const tool of ['fetch', 'search']) for (const mode of ['source', 'gzip']) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-stream-error-'));
    try {
      const result = spawnSync(process.execPath, ['-e', script, tool, mode, outDir], {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000,
      });
      assert.equal(result.status, 2, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private|Unhandled/);
      const manifestText = fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8');
      const manifest = JSON.parse(manifestText);
      assert.equal(manifest.status, 'incomplete');
      assert.equal(manifest.objects.failed, 1);
      assert.doesNotMatch(manifestText, /synthetic-private/);
    } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
  }
});
