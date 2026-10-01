#!/usr/bin/env node
'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ListObjectsV2Command, S3Client } = require('@aws-sdk/client-s3');
const { parseS3Url } = require('./fetch-s3-logs');

const execGit = promisify(execFile);
const GIT_TIMEOUT_MS = 15000;
const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const S3_PROBE_MAX_KEYS = 1;
const USAGE = 'Usage: npm run access:check -- [--repo <path> --ref <branch>] [--s3-url <s3://bucket/prefix/>] [--redash]';
const NEXT_ACTION = {
  'online-ref-found': 'Read the pinned SHA and verify the deployed revision before citing code.',
  'origin-is-not-github': 'Select the GitHub origin for this repository.',
  'ref-not-found': 'Check the exact online branch name or deployed commit.',
  'remote-unavailable': 'Check your GitHub access and network, then retry.',
  'prefix-list-succeeded': 'Check date and object coverage before an absence claim.',
  'invalid-s3-url': 'Select a valid S3 bucket and prefix.',
  'listing-failed': 'Check your own AWS profile, permissions, region, and network.',
  'malformed-response': 'Check the selected source and client response before trusting an empty result.',
  CredentialsProviderError: 'Refresh your own AWS credentials, then retry the read-only probe.',
  AccessDenied: 'Check your own bucket permissions for this prefix.',
  'redash-not-configured': 'Configure your own REDASH_* access before a DB check.',
  RedashProtocolError: 'Check the Redash response before treating a query as empty.',
  RequestTimeout: 'Check Redash connectivity and retry the bounded read-only probe.',
  'read-only-query-succeeded': 'Use bounded read-only queries for relevant records.',
};

function withAction(result) {
  return { ...result, nextAction: NEXT_ACTION[result.reason] ||
    (result.status === 'failed' ? 'Check your own credentials, permissions, region, and network.' :
      'Continue with read-only investigation.') };
}

function githubRepoIdentity(remoteUrl) {
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  if (ssh) return `github.com/${ssh[1]}/${ssh[2]}`;
  try {
    const url = new URL(remoteUrl.trim());
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
    return url.hostname === 'github.com' && ['https:', 'ssh:'].includes(url.protocol) && match
      ? `github.com/${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { repo: undefined, ref: undefined, s3Url: undefined, redash: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (seen.has(option)) throw new Error(USAGE);
    seen.add(option);
    if (option === '--redash') {
      args.redash = true;
      continue;
    }
    if (!['--repo', '--ref', '--s3-url'].includes(option) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(USAGE);
    }
    const value = argv[index + 1];
    if (option === '--repo') args.repo = value;
    else if (option === '--ref') args.ref = value;
    else args.s3Url = value;
    index += 1;
  }
  if (Boolean(args.repo) !== Boolean(args.ref) || (!args.repo && !args.s3Url && !args.redash) ||
      (args.s3Url && !parseS3Url(args.s3Url))) throw new Error(USAGE);
  return args;
}

async function checkGitRef(repo, ref, git = execGit) {
  try {
    const { stdout: remoteUrl } = await git('git', ['-C', repo, 'remote', 'get-url', 'origin'], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
    });
    const remoteRepo = githubRepoIdentity(remoteUrl);
    if (!remoteRepo) return withAction({ status: 'failed', reason: 'origin-is-not-github' });
    const { stdout } = await git('git', ['-C', repo, 'ls-remote', '--heads', 'origin', `refs/heads/${ref}`], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
    });
    const line = stdout.split('\n').find((entry) => entry.endsWith(`\trefs/heads/${ref}`));
    const sha = line && line.split('\t')[0];
    return /^[0-9a-f]{40}$/.test(sha)
      ? withAction({ status: 'verified', reason: 'online-ref-found', sha, remoteRepo })
      : withAction({ status: 'failed', reason: 'ref-not-found', remoteRepo });
  } catch {
    return withAction({ status: 'failed', reason: 'remote-unavailable' });
  }
}

async function checkS3Prefix(s3Url, s3) {
  const source = parseS3Url(s3Url);
  if (!source) return withAction({ status: 'failed', reason: 'invalid-s3-url' });
  const { bucket, prefix } = source;
  const client = s3 || new S3Client({});
  try {
    const response = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: S3_PROBE_MAX_KEYS }));
    if (!response || (response.Contents !== undefined && !Array.isArray(response.Contents))) {
      return withAction({ status: 'failed', reason: 'malformed-response' });
    }
    return withAction({ status: 'verified', reason: 'prefix-list-succeeded',
      objectsVisible: Math.min(S3_PROBE_MAX_KEYS, (response.Contents || []).length) });
  } catch (error) {
    return withAction({ status: 'failed', reason: error?.name === 'CredentialsProviderError' ?
      'CredentialsProviderError' : error?.name === 'AccessDenied' ? 'AccessDenied' : 'listing-failed' });
  } finally {
    if (!s3) client.destroy();
  }
}

async function checkAccess(args, dependencies = {}) {
  const redashCheck = dependencies.checkRedash || (() => require('./redash-query').checkRedashConnectivity());
  const [git, s3, redash] = await Promise.all([
    args.repo ? checkGitRef(args.repo, args.ref, dependencies.git) : Promise.resolve({
      status: 'not checked', reason: 'not-requested', nextAction: 'Pass --repo and --ref to check a Git branch.',
    }),
    args.s3Url ? checkS3Prefix(args.s3Url, dependencies.s3) : Promise.resolve({
      status: 'not checked', reason: 'not-requested', nextAction: 'Pass --s3-url to check an S3 prefix.',
    }),
    args.redash ? Promise.resolve().then(redashCheck)
      .then(withAction).catch(() => withAction({ status: 'failed', reason: 'redash-query-failed' }))
      : Promise.resolve({ status: 'not checked', reason: 'not-requested',
        nextAction: 'Pass --redash when a database check is needed.' }),
  ]);
  return { git, s3, redash };
}

function printResults(results) {
  console.log(JSON.stringify(results, null, 2));
}

if (require.main === module) {
  (async () => {
    try {
      if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
        console.log(USAGE);
        return;
      }
      const results = await checkAccess(parseArgs(process.argv.slice(2)));
      printResults(results);
      process.exitCode = Object.values(results)
        .some((result) => result.status === 'failed') ? 2 : 0;
    } catch {
      console.error(USAGE);
      process.exitCode = 1;
    }
  })();
}

module.exports = { checkAccess, checkGitRef, checkS3Prefix, githubRepoIdentity, parseArgs, printResults };
