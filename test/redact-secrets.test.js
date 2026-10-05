'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { redactSecrets, redactSecretsLine } = require('../redact-secrets');

test('redacts known secret keys but keeps correlation identifiers', () => {
  const out = redactSecrets({
    accessToken: 'abc123', apiSecret: 'shh', Authorization: 'token key:abc',
    password: 'hunter2', reqToken: '6abb62926e32139290765338', client_id: '6abb62926e32139290765338',
    checksum: 'f2d14074', batchId: 'abc', userId: 'xyz',
  });
  assert.equal(out.accessToken, 'REDACTED');
  assert.equal(out.apiSecret, 'REDACTED');
  assert.equal(out.Authorization, 'REDACTED');
  assert.equal(out.password, 'REDACTED');
  assert.equal(out.reqToken, '6abb62926e32139290765338');
  assert.equal(out.client_id, '6abb62926e32139290765338');
  assert.equal(out.checksum, 'f2d14074');
  assert.equal(out.batchId, 'abc');
  assert.equal(out.userId, 'xyz');
});

test('recurses into a nested stringified JSON field and redacts inside it', () => {
  const nested = JSON.stringify({ req: { body: { requestToken: '123', accessToken: 'live-secret' } } });
  const out = redactSecrets({ context: nested });
  const reparsed = JSON.parse(out.context);
  assert.equal(reparsed.req.body.accessToken, 'REDACTED');
  assert.equal(reparsed.req.body.requestToken, '123');
});

test('redacts a bare JWT or Bearer header found in free text, not just under a named key', () => {
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(20)}.${'b'.repeat(20)}`;
  const out = redactSecrets({ message: `auth failed for Bearer ${jwt}` });
  assert.ok(!out.message.includes(jwt));
  assert.match(out.message, /\[REDACTED_JWT\]/);
});

test('redactSecretsLine handles a JSON line and a non-JSON line without throwing', () => {
  const jsonLine = JSON.stringify({ apiKey: 'live', orderId: 'ord-1' });
  const redacted = JSON.parse(redactSecretsLine(jsonLine));
  assert.equal(redacted.apiKey, 'REDACTED');
  assert.equal(redacted.orderId, 'ord-1');

  const freeText = 'plain log line, no json here';
  assert.equal(redactSecretsLine(freeText), freeText);
});
