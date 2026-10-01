'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { checkAccess, checkGitRef, checkS3Prefix, githubRepoIdentity, parseArgs } = require('../access-check');

const SHA = 'a'.repeat(40);

test('access check accepts selected probes and rejects incomplete or repeated input', () => {
  assert.deepEqual(parseArgs(['--repo', '../service', '--ref', 'rc-2026-09-30-hotfix', '--s3-url', 's3://bucket/day/', '--redash']), {
    repo: '../service', ref: 'rc-2026-09-30-hotfix', s3Url: 's3://bucket/day/', redash: true,
  });
  assert.equal(parseArgs(['--repo', '../service', '--ref', 'production']).repo, '../service');
  assert.equal(parseArgs(['--s3-url', 's3://bucket/day/']).s3Url, 's3://bucket/day/');
  assert.equal(parseArgs(['--redash']).redash, true);
  assert.throws(() => parseArgs([]), /Usage:/);
  assert.throws(() => parseArgs(['--repo', '../service']), /Usage:/);
  assert.throws(() => parseArgs(['--ref', 'production']), /Usage:/);
  assert.throws(() => parseArgs(['--repo', '../service', '--ref', 'production', '--s3-url', 'https://example.test']), /Usage:/);
  for (const options of [
    ['--repo', '../one', '--ref', 'production', '--repo', '../two'],
    ['--s3-url', 's3://bucket/day/', '--s3-url', 's3://bucket/other/'],
    ['--redash', '--redash'],
  ]) assert.throws(() => parseArgs(options), /Usage:/);
});

test('Git check accepts only the exact online branch ref and hides remote errors', async () => {
  const git = async (_program, args) => {
    if (args[2] === 'remote') return { stdout: 'git@github.com:smallcase/service.git\n' };
    assert.deepEqual(args.slice(0, 5), ['-C', '../service', 'ls-remote', '--heads', 'origin']);
    assert.equal(args[5], 'refs/heads/rc-2026-09-30-hotfix');
    return { stdout: `${SHA}\trefs/heads/rc-2026-09-30-hotfix\n` };
  };
  const verified = await checkGitRef('../service', 'rc-2026-09-30-hotfix', git);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.reason, 'online-ref-found');
  assert.equal(verified.sha, SHA);
  assert.equal(verified.remoteRepo, 'github.com/smallcase/service');
  assert.match(verified.nextAction, /pinned SHA/);
  const missing = await checkGitRef('../service', 'production', async (_program, args) => ({
    stdout: args[2] === 'remote' ? 'https://token@github.com:443/fork/service.git\n'
      : `${SHA}\trefs/heads/production-old\n`,
  }));
  assert.equal(missing.status, 'failed');
  assert.equal(missing.reason, 'ref-not-found');
  assert.equal(missing.remoteRepo, 'github.com/fork/service');
  assert.equal(githubRepoIdentity('https://token@github.com:443/fork/service.git'), 'github.com/fork/service');
  assert.equal(githubRepoIdentity('https://github.com.evil.test/fork/service.git'), null);
  const unavailable = await checkGitRef('../service', 'production', async () => { throw new Error('secret remote body'); });
  assert.equal(unavailable.reason, 'remote-unavailable');
  assert.doesNotMatch(JSON.stringify(unavailable), /secret/);
});

test('S3 check lists one key through the SDK and does not return keys or remote errors', async () => {
  const s3 = {
    async send(command) {
      assert.equal(command.constructor.name, 'ListObjectsV2Command');
      assert.deepEqual(command.input, { Bucket: 'bucket', Prefix: 'day/', MaxKeys: 1 });
      return { Contents: [{ Key: 'day/account-secret.log' }] };
    },
  };
  const verified = await checkS3Prefix('s3://bucket/day/', s3);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.objectsVisible, 1);
  assert.match(verified.nextAction, /coverage/);
  const failed = await checkS3Prefix('s3://bucket/day/', { send: async () => { throw new Error('secret remote body'); } });
  assert.equal(failed.reason, 'listing-failed');
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
  assert.equal((await checkS3Prefix('s3://bucket/day/', { send: async () => ({ Contents: 'invalid' }) })).reason,
    'malformed-response');
});

test('combined probes run independently and omit Redash unless selected', async () => {
  const args = parseArgs(['--repo', '../service', '--ref', 'production', '--s3-url', 's3://bucket/day/']);
  const dependencies = {
    git: async (_program, args) => ({ stdout: args[2] === 'remote' ? 'git@github.com:smallcase/service.git\n'
      : `${SHA}\trefs/heads/production\n` }),
    s3: { send: async () => ({ Contents: [] }) },
    checkRedash: async () => { throw new Error('secret response body'); },
  };
  const omitted = await checkAccess(args, dependencies);
  assert.equal(omitted.redash.status, 'not checked');
  const checked = await checkAccess({ ...args, redash: true }, dependencies);
  assert.equal(checked.git.status, 'verified');
  assert.equal(checked.s3.status, 'verified');
  assert.equal(checked.s3.objectsVisible, 0);
  assert.equal(checked.redash.reason, 'redash-query-failed');
  assert.doesNotMatch(JSON.stringify(checked), /secret/);
});

test('a failed Git ref does not hide successful S3 and Redash probes', async () => {
  const args = parseArgs(['--repo', '../service', '--ref', 'production', '--s3-url', 's3://bucket/day/', '--redash']);
  const results = await checkAccess(args, {
    git: async (_program, argv) => ({ stdout: argv[2] === 'remote' ? 'git@github.com:smallcase/service.git\n' : '' }),
    s3: { send: async () => ({ Contents: [] }) },
    checkRedash: async () => ({ status: 'verified', reason: 'read-only-query-succeeded' }),
  });
  assert.equal(results.git.status, 'failed');
  assert.equal(results.s3.objectsVisible, 0);
  assert.equal(results.redash.status, 'verified');
  assert.ok(Object.values(results).every((result) => result.nextAction));
});

test('Git-only, S3-only, and Redash-only calls leave other probes not checked', async () => {
  const dependencies = {
    git: async (_program, argv) => ({ stdout: argv[2] === 'remote' ? 'git@github.com:smallcase/service.git\n'
      : `${SHA}\trefs/heads/production\n` }),
    s3: { send: async () => ({ Contents: [] }) },
    checkRedash: async () => ({ status: 'verified', reason: 'read-only-query-succeeded' }),
  };
  const git = await checkAccess(parseArgs(['--repo', '../service', '--ref', 'production']), dependencies);
  assert.deepEqual(Object.values(git).map((result) => result.status), ['verified', 'not checked', 'not checked']);
  const s3 = await checkAccess(parseArgs(['--s3-url', 's3://bucket/day/']), dependencies);
  assert.deepEqual(Object.values(s3).map((result) => result.status), ['not checked', 'verified', 'not checked']);
  const redash = await checkAccess(parseArgs(['--redash']), dependencies);
  assert.deepEqual(Object.values(redash).map((result) => result.status), ['not checked', 'not checked', 'verified']);
  assert.ok([...Object.values(git), ...Object.values(s3), ...Object.values(redash)]
    .every((result) => result.reason && result.nextAction));
});
