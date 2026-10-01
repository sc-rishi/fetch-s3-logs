'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const test = require('node:test');
const { main, scanObject } = require('../search-s3-recon');

function payload(output) {
  return (async function* generate() {
    if (output) yield { Records: { Payload: Buffer.from(output) } };
    yield { Stats: { Details: { BytesScanned: Math.max(10, output.length) } } };
    yield { End: {} };
  }());
}

test('recon search still scans both unlimited prefixes and downloads only matching CSVs', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-recon-search-test-'));
  const listPrefixes = [];
  const downloadedKeys = [];
  const s3 = {
    async send(command) {
      if (command.constructor.name === 'ListObjectsV2Command') {
        listPrefixes.push(command.input.Prefix);
        return {
          Contents: [
            { Key: `${command.input.Prefix}account-123456789.csv`, Size: 10 },
            { Key: `${command.input.Prefix}ignored.txt`, Size: 10 },
          ],
        };
      }
      if (command.constructor.name === 'SelectObjectContentCommand') {
        const output = command.input.Key.startsWith('sbi_recon/') ? 'B,1,C,4,5,6,7,8,synthetic-secret-tag,10,11,12\n' : '';
        return { Payload: payload(output) };
      }
      downloadedKeys.push(command.input.Key);
      return { Body: Readable.from(['complete,csv\n']) };
    },
  };

  try {
    const exitCode = await main(['--tag', 'synthetic-secret-tag', '--out', outputDir], { s3 });
    assert.equal(exitCode, 0);
    assert.deepEqual(listPrefixes.sort(), ['mtf_recon/', 'sbi_recon/']);
    assert.deepEqual(downloadedKeys, ['sbi_recon/account-123456789.csv']);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.scannedFiles, 2);
    assert.equal(manifest.matchedFiles, 1);
    assert.deepEqual(manifest.errors, []);
    assert.equal(manifest.status, 'complete');
    assert.equal(manifest.query.tags, 1);
    const shareable = fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8') +
      fs.readFileSync(path.join(outputDir, 'safe-matches.json'), 'utf8');
    assert.doesNotMatch(shareable, /123456789|synthetic-secret-tag/);
    assert.ok(fs.readdirSync(path.join(outputDir, 'sbi')).every((name) => !name.includes('123456789')));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('recon scan refuses incomplete Select streams and missing stats', async () => {
  for (const events of [
    [{ Stats: { Details: { BytesScanned: 1 } } }],
    [{ End: {} }],
    [{ Stats: { Details: { BytesScanned: null } } }, { End: {} }],
    [{ Stats: { Details: { BytesScanned: 9 } } }, { End: {} }],
  ]) {
    const s3 = { send: async () => ({ Payload: (async function* generate() { yield* events; }()) }) };
    const result = await scanObject(s3, { name: 'sbi' }, 'sbi_recon/sample.csv', "s._9 IN ('synthetic')", 10);
    assert.equal(result.error, 'ExternalRequestFailed');
  }
});

test('recon search refuses a reused output folder before listing S3', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-recon-reused-'));
  let called = false;
  try {
    fs.writeFileSync(path.join(outputDir, 'manifest.json'), 'old evidence');
    await assert.rejects(() => main(['--tag', 'synthetic', '--out', outputDir], {
      s3: { send: async () => { called = true; return { Contents: [] }; } },
    }), /Output directory must be empty/);
    assert.equal(called, false);
    assert.equal(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'), 'old evidence');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
