'use strict';

// Denylist-based value redaction for downloaded log content: the opposite shape of
// safe-evidence.js's allowlist projector (which keeps only pre-reviewed fields and is optional,
// so it never hides the error Claude needs). This instead keeps everything EXCEPT known
// credential-shaped keys/values, so live secrets never reach disk - not business identifiers
// like reqToken/client_id/batchId, which investigations correlate on and must stay visible.
// On by default for every tool that writes downloaded logs; pass --no-redact-secrets to disable.

const SECRET_KEY_NAMES = [
  'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
  'apikey', 'api_key', 'apisecret', 'api_secret',
  'clientsecret', 'client_secret', 'privatekey', 'private_key',
  'encat', 'authorization', 'password', 'secret', 'jwt', 'cookie',
  'x-sc-jwt', 'x-domain-token', 'x-client-secret',
];
const SECRET_KEY_SET = new Set(SECRET_KEY_NAMES);

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-_.~+/]+=*/gi;

function redactFreeText(text) {
  if (typeof text !== 'string') return text;
  return text.replace(JWT_PATTERN, '[REDACTED_JWT]').replace(BEARER_PATTERN, 'Bearer [REDACTED]');
}

function tryParseJsonContainer(value) {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Walks a parsed JS value (object/array/primitive) and returns a redacted deep copy. Known
// secret keys are replaced outright; string values are checked for nested stringified JSON
// (services like broker-api double-stringify a request/response blob into one field) and
// recursed into, otherwise scanned for bare JWT/Bearer patterns that slipped in under an
// unlisted key (e.g. inside a free-text "message" field).
function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (SECRET_KEY_SET.has(key.toLowerCase())) {
        out[key] = v === undefined || v === null ? v : 'REDACTED';
        continue;
      }
      if (typeof v === 'string') {
        const nested = tryParseJsonContainer(v);
        out[key] = nested !== undefined ? JSON.stringify(redactSecrets(nested)) : redactFreeText(v);
      } else {
        out[key] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

// Line-level redaction for raw/mixed-format text (used where content isn't guaranteed to be one
// parseable JSON object): JSON lines get structurally redacted and re-serialized; anything else
// falls back to the free-text JWT/Bearer scan so a malformed line still can't leak a live token.
function redactSecretsLine(line) {
  if (typeof line !== 'string' || !line) return line;
  const trimmed = line.trim();
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try {
      return JSON.stringify(redactSecrets(JSON.parse(trimmed)));
    } catch {
      // not actually valid JSON despite looking like it - fall through
    }
  }
  return redactFreeText(line);
}

module.exports = { redactSecrets, redactSecretsLine, redactFreeText, SECRET_KEY_NAMES };
