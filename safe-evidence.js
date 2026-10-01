'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const EVENT_TOKEN = /^(?=.{2,40}$)(?!.*\d{5})[A-Z][A-Z0-9_]*$/;
const SOURCE_TOKEN = /^[A-Za-z][A-Za-z0-9_/-]{0,63}$/;
const ISO_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const LOG_LEVELS = new Set(['TRACE', 'DEBUG', 'INFO', 'WARN', 'WARNING', 'ERROR', 'FATAL']);
const SAFE_ERROR_NAMES = new Set([
  'AccessDenied', 'CredentialsProviderError', 'ExpiredToken', 'InvalidAccessKeyId', 'InvalidObjectState',
  'NetworkError', 'NoSuchBucket', 'NoSuchKey', 'RequestTimeout', 'ServiceUnavailable',
  'SlowDown', 'ThrottlingException', 'TimeoutError', 'RedashHttpError', 'RedashProtocolError',
]);
const MAX_WHOLE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_VALIDATED_VALUES = 100;
const MAX_EXACT_PATHS = 8;
const MAX_SEARCH_NODES = 500;
const MAX_SEARCH_DEPTH = 6;
const MAX_SPEC_FIELDS = 32;
const MAX_REVIEWED_STRING_LENGTH = 80;
const MAX_REVIEWED_PATH_LENGTH = 160;
const MAX_IDENTIFIER_BYTES = 1024;
const FIELD_KINDS = new Set(['event', 'status', 'code']);
const LEGACY_FIELDS = { event: 'eventName', status: null, code: 'errorCode' };
const FIELD_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const PINNED_SOURCE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?@[a-f0-9]{40}:[A-Za-z0-9_./-]+:[1-9]\d*$/;
const SAFE_PATH_SEGMENTS = new Set([
  'activation', 'activations', 'batch', 'batchId', 'body', 'clientOrderId',
  'correlationId', 'data', 'details', 'exchangeOrderId', 'id', 'jobId',
  'message', 'meta', 'order', 'orderId', 'orders', 'payload', 'records',
  'referenceId', 'requestId', 'result', 'sip', 'sipId', 'sips', 'tag',
  'unplaced', 'updates', 'userId',
]);

function hashRef(value) {
  return `ref-${createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
}

function safeTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const match = typeof value === 'string' ? ISO_TIME.exec(value) : null;
  if (!match) return undefined;
  const [, day, hour, minute, second, zone] = match;
  const calendarDay = new Date(`${day}T00:00:00Z`);
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      Number.isNaN(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== day ||
      (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function safeToken(value, pattern = EVENT_TOKEN) {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function loadValidatedEnums(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).some((name) => !['event', 'status', 'code'].includes(name))) {
    throw new Error('Validated enum file must contain only event, status, and code arrays.');
  }
  const result = {};
  for (const [name, values] of Object.entries(parsed)) {
    if (!Array.isArray(values) || values.length > MAX_VALIDATED_VALUES ||
        values.some((value) => !safeToken(value))) {
      throw new Error('Validated enum values must be short uppercase tokens.');
    }
    result[name] = new Set(values);
  }
  return result;
}

function reviewedPath(value) {
  if (typeof value !== 'string' || value.length > MAX_REVIEWED_PATH_LENGTH ||
      !/^[A-Za-z_][A-Za-z0-9_]*(?:\[\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\])?)*$/.test(value)) {
    throw new Error('Evidence paths must use field names, dots, and [] only.');
  }
  const segments = value.replace(/\[\]/g, '').split('.');
  if (segments.length > MAX_SEARCH_DEPTH || segments.some((part) => UNSAFE_SEGMENTS.has(part))) {
    throw new Error('Evidence path is unsupported.');
  }
  return new RegExp(`^${value.replace(/\./g, '\\.').replace(/\[\]/g, '\\[\\d+\\]')}$`);
}

function reviewedValue(value) {
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length > 0 && value.length <= MAX_REVIEWED_STRING_LENGTH &&
      !/[\x00-\x1f\x7f]/.test(value));
}

function reviewedRule(rule, identifier = false) {
  const keys = identifier ? ['path', 'source'] : ['path', 'kind', 'values', 'source'];
  if (!rule || typeof rule !== 'object' || Array.isArray(rule) ||
      Object.keys(rule).some((key) => !keys.includes(key)) ||
      typeof rule.source !== 'string' || !PINNED_SOURCE.test(rule.source) ||
      rule.source.split(':')[1].split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('Every evidence rule requires a pinned repo@SHA:path:line source citation.');
  }
  const matcher = reviewedPath(rule.path);
  if (!identifier && (!FIELD_KINDS.has(rule.kind) || !Array.isArray(rule.values) ||
      !rule.values.length || rule.values.length > MAX_VALIDATED_VALUES || !rule.values.every(reviewedValue))) {
    throw new Error('Evidence fields require an event/status/code kind and exact scalar values.');
  }
  return { ...rule, matcher, ...(identifier ? {} : { allowed: new Set(rule.values) }) };
}

// Citations establish provenance syntax; the investigator must review their pinned source.
function parseEvidenceSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) ||
      Object.keys(spec).some((key) => !['fields', 'identifiers'].includes(key)) ||
      !Array.isArray(spec.fields) || !spec.fields.length || spec.fields.length > MAX_SPEC_FIELDS ||
      (spec.identifiers !== undefined && (!Array.isArray(spec.identifiers) || spec.identifiers.length > MAX_SPEC_FIELDS))) {
    throw new Error('Evidence spec requires a bounded fields array and optional identifiers array.');
  }
  return {
    fields: spec.fields.map((rule) => reviewedRule(rule)),
    identifiers: (spec.identifiers || []).map((rule) => reviewedRule(rule, true)),
  };
}

function loadEvidenceOptions({ evidenceSpecPath, validatedEnumsPath } = {}) {
  if (evidenceSpecPath && validatedEnumsPath) throw new Error('Use only one evidence spec or legacy enum file.');
  if (evidenceSpecPath) return { evidenceSpec: parseEvidenceSpec(JSON.parse(fs.readFileSync(evidenceSpecPath, 'utf8'))) };
  return validatedEnumsPath ? { validatedEnums: loadValidatedEnums(validatedEnumsPath) } : {};
}

function scalarLeaves(record) {
  const leaves = [];
  let visited = 0;
  let truncated = false;
  const seen = new WeakSet();
  function visit(value, location, depth, reviewable = true) {
    if (++visited > MAX_SEARCH_NODES || depth > MAX_SEARCH_DEPTH) { truncated = true; return; }
    if (!value || typeof value !== 'object') { leaves.push({ location, value, reviewable }); return; }
    if (seen.has(value)) { truncated = true; return; }
    seen.add(value);
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (visited >= MAX_SEARCH_NODES) { truncated = true; break; }
      const child = Array.isArray(value) ? `${location}[${key}]` : (location ? `${location}.${key}` : key);
      const supportedKey = Array.isArray(value) ? /^\d+$/.test(key) : FIELD_SEGMENT.test(key) && !UNSAFE_SEGMENTS.has(key);
      visit(value[key], child, depth + 1, reviewable && supportedKey);
    }
  }
  visit(record, '', 0);
  return { leaves, truncated };
}

function arrayScopes(location) {
  const scopes = new Map();
  for (const match of location.matchAll(/\[(\d+)\]/g)) {
    scopes.set(location.slice(0, match.index).replace(/\[\d+\]/g, '[]'), match[1]);
  }
  return scopes;
}

function elementCorrelation(location, identifiers, queryValue) {
  if (queryValue === undefined) return 'not_checked';
  if (!identifiers.length) return 'unverified';
  const scopes = arrayScopes(location);
  if (!scopes.size) return 'record_match';
  let related = false;
  for (const identifier of identifiers) {
    const other = arrayScopes(identifier.location);
    const ancestry = [...scopes.keys()];
    if (scopes.size !== other.size || !ancestry.every((key) => other.has(key))) continue;
    related = true;
    if (ancestry.every((key) => scopes.get(key) === other.get(key))) return 'matched_element';
  }
  return related ? 'other_element' : 'record_match_only';
}

function projectReviewedFields(leaves, spec, queryValue, projectedLocations) {
  const identifiers = leaves.filter(({ location, value, reviewable }) => reviewable && value === queryValue &&
    spec.identifiers.some(({ matcher }) => matcher.test(location)));
  const evidence = [];
  let missingPaths = 0;
  for (const rule of spec.fields) {
    const matches = leaves.filter(({ location, reviewable }) => reviewable && rule.matcher.test(location));
    if (!matches.length) missingPaths += 1;
    for (const { location, value } of matches) {
      if (!rule.allowed.has(value)) continue;
      projectedLocations.add(location);
      evidence.push({ kind: rule.kind, value, path: location, source: rule.source,
        correlation: elementCorrelation(location, identifiers, queryValue) });
    }
  }
  return { evidence, missingPaths };
}

function projectionCoverage(scannedValues, projectedValues, truncated, missingPaths = 0) {
  const omittedValues = scannedValues - projectedValues;
  return { status: truncated || omittedValues || missingPaths ? 'partial' : 'complete',
    scannedValues, projectedValues, omittedValues, missingPaths, truncated };
}

function projectLegacyFields(source, log, root, validatedEnums, projectedLocations) {
  const leaves = [];
  const fields = [];
  for (const [name, alternative] of Object.entries(LEGACY_FIELDS)) {
    const supplied = validatedEnums[name];
    if (!(supplied instanceof Set)) continue;
    const value = log[name] ?? source[name] ?? (alternative ? log[alternative] ?? source[alternative] : undefined);
    const location = [name, alternative].find((key) => key && root[key] === value) || name;
    leaves.push({ location, value, reviewable: true });
    fields.push({ kind: name, matcher: reviewedPath(location), allowed: new Set([...supplied].filter((value) => safeToken(value))) });
  }
  const { evidence } = projectReviewedFields(leaves, { fields, identifiers: [] }, undefined, projectedLocations);
  return Object.fromEntries(evidence.map(({ kind, value }) => [kind, value]));
}

function projectMetadata(source, log, trustedSourceAlias) {
  const output = {};
  const timestamp = safeTimestamp(source.time) || safeTimestamp(log.time) ||
    safeTimestamp(log.timestamp) || safeTimestamp(source.timestamp) ||
    safeTimestamp(source.date) || safeTimestamp(source.createdAt);
  const sourceAlias = safeToken(trustedSourceAlias, SOURCE_TOKEN);
  const objectLastModified = safeTimestamp(source.objectLastModified);
  const level = safeToken(String(log.level ?? source.level ?? '').toUpperCase());
  if (timestamp) output.timestamp = timestamp;
  if (sourceAlias) output.sourceAlias = sourceAlias;
  if (typeof source.s3Uri === 'string') output.objectRef = hashRef(source.s3Uri);
  if (objectLastModified) output.objectLastModified = objectLastModified;
  if (level && LOG_LEVELS.has(level)) output.level = level;
  return output;
}

function markMetadataLocations(leaves, output, projectedLocations) {
  for (const leaf of leaves) {
    if (output.timestamp && ['time', 'timestamp', 'date', 'createdAt'].includes(leaf.location) && safeTimestamp(leaf.value) === output.timestamp) {
      projectedLocations.add(leaf.location);
    }
    if (leaf.location === 'level' && output.level && String(leaf.value).toUpperCase() === output.level) {
      projectedLocations.add(leaf.location);
    }
  }
}

function projectEvidence(record, { sourceAlias, validatedEnums = {}, evidenceSpec, queryValue } = {}) {
  if (evidenceSpec && Object.keys(validatedEnums).length) throw new Error('Use only one evidence spec or legacy enum file.');
  const source = record && typeof record === 'object' ? record : {};
  const log = source.log && typeof source.log === 'object' && !Array.isArray(source.log) ? source.log : {};
  const root = source.log === log ? log : source;
  const { leaves, truncated } = scalarLeaves(root);
  const projectedLocations = new Set();
  const output = projectMetadata(source, log, sourceAlias);
  markMetadataLocations(leaves, output, projectedLocations);
  let missingPaths = 0;
  if (evidenceSpec) {
    const reviewed = projectReviewedFields(leaves, evidenceSpec, queryValue, projectedLocations);
    output.evidence = reviewed.evidence;
    missingPaths = reviewed.missingPaths;
  } else {
    Object.assign(output, projectLegacyFields(source, log, root, validatedEnums, projectedLocations));
  }
  const projectedCount = leaves.filter(({ location }) => projectedLocations.has(location)).length;
  output.projection = projectionCoverage(leaves.length, projectedCount, truncated, missingPaths);
  return output;
}

function safeError(error) {
  const name = [error && error.name, error && error.code].find((value) => SAFE_ERROR_NAMES.has(value));
  return name || 'ExternalRequestFailed';
}

function exactMatchPaths(record, queryValue) {
  if (typeof queryValue !== 'string' || !queryValue) return [];
  const root = record && typeof record.log === 'object' ? record.log : record;
  const { leaves } = scalarLeaves(root);
  const paths = leaves.filter(({ value, location, reviewable }) => reviewable && value === queryValue &&
    location.replace(/\[\d+\]/g, '').split('.').filter(Boolean).every((part) => SAFE_PATH_SEGMENTS.has(part)))
    .map(({ location }) => location.replace(/\[\d+\]/g, '[]'));
  return [...new Set(paths)].slice(0, MAX_EXACT_PATHS);
}

function parseWholeFile(content) {
  const trimmed = content.trim();
  try { return JSON.parse(trimmed); } catch { /* JSONL or comma-separated objects */ }
  try { return JSON.parse(`[${trimmed.replace(/,\s*$/, '')}]`); } catch { return null; }
}

async function projectFile(inputPath, outputPath, options = {}) {
  // Preserve the original programmatic third argument while sharing the projection path.
  const projectionOptions = Object.keys(options).some((key) => FIELD_KINDS.has(key)) ? { validatedEnums: options } : options;
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw new Error('Input and output must differ.');
  const stat = await fs.promises.stat(inputPath);
  if (stat.size > MAX_WHOLE_FILE_BYTES && path.basename(inputPath) === 'all-logs.filtered.log') {
    throw new Error('Large concatenated JSON input cannot be projected safely.');
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const output = await fs.promises.open(outputPath, 'wx', 0o600);
  let projected = 0;
  let withheld = 0;
  const coverage = { scannedValues: 0, projectedValues: 0, missingPaths: 0, truncated: false };
  async function writeRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) { withheld += 1; return; }
    const evidence = projectEvidence(record, projectionOptions);
    for (const key of ['scannedValues', 'projectedValues', 'missingPaths']) coverage[key] += evidence.projection[key];
    coverage.truncated ||= evidence.projection.truncated;
    if (!Object.keys(evidence).some((key) => key !== 'projection' && (key !== 'evidence' || evidence.evidence.length))) {
      withheld += 1;
      return;
    }
    await output.write(`${JSON.stringify(evidence)}\n`);
    projected += 1;
  }
  try {
    if (stat.size <= MAX_WHOLE_FILE_BYTES) {
      const content = await fs.promises.readFile(inputPath, 'utf8');
      const parsed = parseWholeFile(content);
      if (parsed !== null) {
        for (const record of Array.isArray(parsed) ? parsed : [parsed]) await writeRecord(record);
      } else {
        for (const line of content.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let record;
          try { record = JSON.parse(line); } catch { withheld += 1; continue; }
          await writeRecord(record);
        }
      }
    } else {
      const lines = readline.createInterface({ input: fs.createReadStream(inputPath), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { withheld += 1; continue; }
        await writeRecord(record);
      }
    }
  } finally {
    await output.close();
  }
  return { status: withheld ? 'incomplete' : 'complete', projected, withheld,
    projection: projectionCoverage(coverage.scannedValues, coverage.projectedValues, coverage.truncated, coverage.missingPaths) };
}

function readIdentifier(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || (stat.mode & 0o077) || stat.size > MAX_IDENTIFIER_BYTES) {
    throw new Error('Identifier input must be a small private file.');
  }
  const value = fs.readFileSync(filePath, 'utf8').replace(/\r?\n$/, '');
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Identifier input must contain one value.');
  return value;
}

async function main(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log([
      'Project raw evidence without exposing unreviewed values.',
      'Usage: node safe-evidence.js --input <raw-file> --out <new-safe.jsonl>',
      '  --evidence-spec <file>       Source-cited paths and exact typed values',
      '  --validated-enums <file>     Legacy uppercase enums (cannot combine with spec)',
      '  --identifier-file <file>     Private one-line identifier for exact correlation',
      'Inspect projection omissions and truncation separately from retrieval coverage.',
    ].join('\n'));
    return;
  }
  const names = { '--input': 'inputPath', '--out': 'outputPath',
    '--validated-enums': 'validatedEnumsPath', '--evidence-spec': 'evidenceSpecPath', '--identifier-file': 'identifierPath' };
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = names[argv[index]];
    if (!name || args[name] || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('Expected --input <raw> --out <safe.jsonl> and at most one evidence options file.');
    }
    args[name] = argv[index + 1];
  }
  if (!args.inputPath || !args.outputPath) throw new Error('Input and output paths are required.');
  const options = loadEvidenceOptions(args);
  if (args.identifierPath) options.queryValue = readIdentifier(args.identifierPath);
  const result = await projectFile(args.inputPath, args.outputPath, options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'incomplete') process.exitCode = 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Evidence projection failed. Check input format and output path.\n');
    process.exitCode = 1;
  });
}

module.exports = { exactMatchPaths, hashRef, loadEvidenceOptions, loadValidatedEnums, parseEvidenceSpec,
  projectEvidence, projectFile, safeError, safeTimestamp };
