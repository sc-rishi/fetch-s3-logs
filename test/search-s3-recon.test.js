'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const test = require('node:test');
const { main } = require('../search-s3-recon');

function payload(output) {
  return (async function* generate() {
    if (output) yield { Records: { Payload: Buffer.from(output) } };
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
            { Key: `${command.input.Prefix}orders.csv`, Size: 10 },
            { Key: `${command.input.Prefix}ignored.txt`, Size: 10 },
          ],
        };
      }
      if (command.constructor.name === 'SelectObjectContentCommand') {
        const output = command.input.Key.startsWith('sbi_recon/') ? 'B,1,C,4,5,6,7,8,sc_tag,10,11,12\n' : '';
        return { Payload: payload(output) };
      }
      downloadedKeys.push(command.input.Key);
      return { Body: Readable.from(['complete,csv\n']) };
    },
  };

  try {
    const exitCode = await main(['--tag', 'sc_tag', '--out', outputDir], { s3 });
    assert.equal(exitCode, 0);
    assert.deepEqual(listPrefixes.sort(), ['mtf_recon/', 'sbi_recon/']);
    assert.deepEqual(downloadedKeys, ['sbi_recon/orders.csv']);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.scannedFiles, 2);
    assert.equal(manifest.matchedFiles, 1);
    assert.deepEqual(manifest.errors, []);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
