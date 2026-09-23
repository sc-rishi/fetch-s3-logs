#!/usr/bin/env node
/* eslint-disable no-console */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Request logger middleware
app.use((req, _res, next) => {
  const { method, path: p, query, body } = req;
  const args = {};
  if (Object.keys(query).length) args.query = query;
  if (body && Object.keys(body).length) args.body = body;
  const hasArgs = Object.keys(args).length > 0;
  console.log(`[${new Date().toISOString()}] ${method} ${p}${hasArgs ? ' ' + JSON.stringify(args) : ''}`);
  next();
});

const SCRIPT_PATH = path.join(__dirname, 'fetch-s3-logs.js');
const LOG_DIR = path.join(__dirname, 'logs');

// Parse DEFAULTS out of fetch-s3-logs.js by regex extraction of individual key-value pairs
function readDefaults() {
  try {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    // Extract DATE value so template literals referencing it can be resolved
    const dateMatch = src.match(/const DATE\s*=\s*'([^'\n]+)'/);
    const DATE = dateMatch ? dateMatch[1] : '';
    // Extract the DEFAULTS block text
    const blockMatch = src.match(/const DEFAULTS\s*=\s*\{([\s\S]*?)\n\};/);
    if (!blockMatch) return {};
    const block = blockMatch[1];
    const result = {};
    // Replace ${DATE} template variables with actual value
    const resolved = block.replace(/\$\{DATE\}/g, DATE);
    // Extract each key: value pair — handles string, number, boolean values
    const lineRe = /^\s+(\w+)\s*:\s*(.+)$/gm;
    let m;
    while ((m = lineRe.exec(resolved)) !== null) {
      const key = m[1];
      // Strip trailing ", // comment" (comma before the comment marker)
      let raw = m[2].trim().replace(/,\s*\/\/.*$/, '').trim().replace(/,$/, '').trim();
      // Skip commented keys (lines that were originally comments are already stripped by block extraction,
      // but double-check)
      if (raw === '') continue;
      // Backtick template string (after DATE substitution, no more ${...})
      if (raw.startsWith('`') && raw.endsWith('`')) {
        result[key] = raw.slice(1, -1);
      } else if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        result[key] = raw.slice(1, -1);
      } else if (raw === 'true') {
        result[key] = true;
      } else if (raw === 'false') {
        result[key] = false;
      } else if (raw === 'null' || raw === 'undefined') {
        result[key] = null;
      } else if (/^-?\d+(\.\d+)?$/.test(raw)) {
        result[key] = Number(raw);
      }
      // skip complex values (arrays, nested objects)
    }
    return result;
  } catch (e) {
    console.warn('readDefaults parse error:', e.message);
    return {};
  }
}

function readDateDefault() {
  try {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    const m = src.match(/const DATE\s*=\s*['"`]([^'"`]+)['"`]/);
    return m ? m[1] : '';
  } catch { return ''; }
}

// GET /api/defaults  — return current DEFAULTS from the script
app.get('/api/defaults', (req, res) => {
  const defaults = readDefaults();
  const date = readDateDefault();
res.json({ defaults, date });
});

// GET /api/logs  — list output log files
app.get('/api/logs', (req, res) => {
  try {
    if (!fs.existsSync(LOG_DIR)) return res.json([]);
    const walk = (dir, base = '') => {
      const results = [];
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const rel = base ? `${base}/${name}` : name;
        if (fs.statSync(full).isDirectory()) {
          results.push(...walk(full, rel));
        } else {
          const stat = fs.statSync(full);
          results.push({ name: rel, size: stat.size, mtime: stat.mtimeMs });
        }
      }
      return results;
    };
    res.json(walk(LOG_DIR));
  } catch (e) {
    res.json([]);
  }
});

// GET /api/logs/content?file=... — read a log file
app.get('/api/logs/content', (req, res) => {
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'file required' });
  const abs = path.resolve(LOG_DIR, file);
  if (!abs.startsWith(LOG_DIR)) return res.status(403).json({ error: 'forbidden' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'not found' });
  const stat = fs.statSync(abs);
  const MAX = 5 * 1024 * 1024; // 5 MB preview
  if (stat.size > MAX) {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(MAX);
    fs.readSync(fd, buf, 0, MAX, 0);
    fs.closeSync(fd);
    return res.json({ content: buf.toString('utf8'), truncated: true, size: stat.size });
  }
  res.json({ content: fs.readFileSync(abs, 'utf8'), truncated: false, size: stat.size });
});

// GET /api/tail?outDir=...  — SSE stream of new JSON objects appended to all-logs.filtered.log
app.get('/api/tail', (req, res) => {
  const outDirParam = (req.query.outDir || './logs').trim();
  const abs = path.isAbsolute(outDirParam)
    ? path.join(outDirParam, 'all-logs.filtered.log')
    : path.join(__dirname, outDirParam, 'all-logs.filtered.log');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let position = 0;
  let pending = '';
  let depth = 0;
  let objStart = -1;

  const parseAndSend = (text) => {
    pending += text;
    let i = 0;
    while (i < pending.length) {
      const ch = pending[i];
      if (ch === '{' && depth === 0) {
        objStart = i;
        depth = 1;
      } else if (depth > 0) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0 && objStart >= 0) {
            const objStr = pending.slice(objStart, i + 1);
            try {
              const obj = JSON.parse(objStr);
              res.write(`data: ${JSON.stringify(obj)}\n\n`);
            } catch { /* skip malformed */ }
            pending = pending.slice(i + 1);
            objStart = -1;
            i = -1;
          }
        }
      }
      i++;
    }
    // Retain only unparsed content that started an object
    if (depth > 0 && objStart >= 0) {
      pending = pending.slice(objStart);
      objStart = 0;
    } else if (depth === 0) {
      pending = '';
    }
  };

  const readNew = () => {
    if (!fs.existsSync(abs)) return;
    try {
      const stat = fs.statSync(abs);
      if (stat.size <= position) return;
      const fd = fs.openSync(abs, 'r');
      const chunk = Buffer.alloc(stat.size - position);
      fs.readSync(fd, chunk, 0, chunk.length, position);
      fs.closeSync(fd);
      position = stat.size;
      parseAndSend(chunk.toString('utf8'));
    } catch { /* file not ready yet */ }
  };

  const interval = setInterval(readNew, 300);
  req.on('close', () => clearInterval(interval));
});

// POST /api/run  — run fetch-s3-logs.js and stream output via SSE
app.post('/api/run', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  const body = req.body || {};

  // Build argv
  const args = [SCRIPT_PATH];
  if (body.s3Url) {
    args.push('--s3-url', body.s3Url);
  } else if (body.bucket) {
    // Construct full s3Url so it overrides DEFAULTS.S3_URL in the script
    const prefix = body.prefix || '';
    const dir = body.dir ? `${body.dir}/` : '';
    const s3Url = `s3://${body.bucket}/${prefix}${dir}`;
    args.push('--s3-url', s3Url);
  }
  if (body.outDir) args.push('--out', body.outDir);
  if (body.from) args.push('--from', body.from);
  if (body.to) args.push('--to', body.to);
  if (body.ist) args.push('--ist');
  if (body.filterText) args.push('--filter-text', body.filterText);
  if (body.filterField) args.push('--filter-field', body.filterField);
  if (body.sort) args.push('--sort', body.sort);
  if (body.concurrency) args.push('--concurrency', String(body.concurrency));
  if (body.rawFields) args.push('--raw-field', body.rawFields);
  // --dir is folded into --s3-url above; only pass it when s3Url was explicitly provided by FE
  if (body.s3Url && body.dir) args.push('--dir', body.dir);
  if (body.ci) args.push('--ci');
  if (body.parseMessage) args.push('--parse-message');
  if (body.startAfter) args.push('--start-after', body.startAfter);
  if (body.maxKeys) args.push('--max-keys', String(body.maxKeys));

  send('cmd', `node ${[path.basename(SCRIPT_PATH), ...args.slice(1)].map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);

  const env = {
    ...process.env,
    AWS_PROFILE: 'smallcase',
    AWS_SDK_LOAD_CONFIG: '1',
    AWS_REGION: 'ap-south-1',
    AWS_DEFAULT_REGION: 'ap-south-1',
  };

  const child = spawn('node', args, { env });

  child.stdout.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach((line) => send('stdout', line));
  });
  child.stderr.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach((line) => send('stderr', line));
  });
  child.on('close', (code) => {
    send('done', code === 0 ? 'Completed successfully.' : `Exited with code ${code}`);
    res.end();
  });

  res.on('close', () => child.kill());
});

const PORT = process.env.PORT || 3000;

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  process.exit(1);
});

const server = http.createServer(app);
server.on('error', (err) => {
  console.error('[server error]', err);
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`fetch-s3-logs UI running at http://localhost:${PORT}`);
});
