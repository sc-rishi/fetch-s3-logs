#!/usr/bin/env node
/* eslint-disable no-console */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 4000);
const REPO_ROOT = __dirname;
const FRONTEND_DIR = path.join(REPO_ROOT, 'frontend');
const LOG_DIR = path.join(REPO_ROOT, 'logs');
const ENTRY_SCRIPT = path.join(REPO_ROOT, 'fetch-s3-logs.js');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
};

function safeJoin(base, target) {
  const normalized = target.startsWith('/') ? target.slice(1) : target;
  const resolved = path.resolve(base, normalized);
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

function sendNotFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function sendError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message || 'Internal server error');
}

function serveStaticFile(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendNotFound(res);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
}

function resolveStaticPath(urlPath) {
  if (urlPath === '/' || urlPath === '') {
    return path.join(FRONTEND_DIR, 'index.html');
  }
  if (urlPath === '/log-explorer.html') {
    return path.join(FRONTEND_DIR, 'log-explorer.html');
  }
  if (urlPath.startsWith('/logs/')) {
    const target = safeJoin(REPO_ROOT, urlPath);
    if (!target) return null;
    return target;
  }
  if (urlPath.startsWith('/frontend/')) {
    const rel = urlPath.replace(/^\/frontend\//, '');
    const target = safeJoin(FRONTEND_DIR, rel);
    return target;
  }
  const fallback = urlPath.replace(/^\//, '');
  return path.join(FRONTEND_DIR, fallback);
}

function buildCliArgs(payload = {}) {
  const cfg = { ...payload };
  const args = [];
  const push = (flag, value) => {
    if (value === undefined || value === null || value === '') return;
    args.push(flag, String(value));
  };
  if (cfg.s3Url) push('--s3-url', cfg.s3Url);
  else {
    if (cfg.bucket) push('--bucket', cfg.bucket);
    if (cfg.prefix) push('--prefix', cfg.prefix);
  }
  push('--out', cfg.outDir || './logs');
  if (cfg.dir) push('--dir', cfg.dir);
  if (cfg.startAfter) push('--start-after', cfg.startAfter);
  if (Number.isFinite(cfg.maxKeys) && cfg.maxKeys > 0) push('--max-keys', cfg.maxKeys);
  if (cfg.from) push('--from', cfg.from);
  if (cfg.to) push('--to', cfg.to);
  if (cfg.ist) args.push('--ist');
  if (cfg.filterText) push('--filter-text', cfg.filterText);
  if (Array.isArray(cfg.filterFields)) {
    cfg.filterFields.forEach((spec) => {
      if (spec && spec.name && spec.value !== undefined) {
        push('--filter-field', `${spec.name}=${spec.value}`);
      }
    });
  }
  if (Array.isArray(cfg.filterFieldExprClauses)) {
    cfg.filterFieldExprClauses.forEach((clause) => {
      if (!Array.isArray(clause) || !clause.length) return;
      const clauseText = clause
        .filter((spec) => spec && spec.name && spec.value !== undefined)
        .map((spec) => `${spec.name}=${spec.value}`)
        .join(' and ');
      if (clauseText) push('--filter-field', clauseText);
    });
  }
  if (Array.isArray(cfg.rawFields) && cfg.rawFields.length) {
    push('--raw-field', cfg.rawFields.join(','));
  }
  if (cfg.sort && cfg.sort !== 'off') push('--sort', cfg.sort);
  if (cfg.ci) args.push('--ci');
  if (Number.isFinite(cfg.concurrency) && cfg.concurrency > 0) push('--concurrency', cfg.concurrency);
  return args;
}

function handleJobRequest(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 2 * 1024 * 1024) {
      req.socket.destroy();
    }
  });
  req.on('end', () => {
    let payload = {};
    try {
      payload = body ? JSON.parse(body) : {};
    } catch (err) {
      sendError(res, 400, 'Invalid JSON payload');
      return;
    }
    const args = buildCliArgs(payload);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
    });
    res.write(`Running: node fetch-s3-logs.js ${args.join(' ')}\n\n`);
    const child = spawn(process.execPath, [ENTRY_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    child.stdout.on('data', (chunk) => res.write(chunk));
    child.stderr.on('data', (chunk) => res.write(chunk));
    child.on('error', (err) => {
      res.write(`\nFailed to start process: ${err.message || err}\n`);
    });
    child.on('close', (code) => {
      res.end(`\nProcess exited with code ${code}\n`);
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'POST' && url.pathname === '/api/fetch-s3-logs') {
    handleJobRequest(req, res);
    return;
  }
  if (req.method === 'GET') {
    const targetPath = resolveStaticPath(url.pathname);
    if (!targetPath) {
      sendNotFound(res);
      return;
    }
    serveStaticFile(res, targetPath);
    return;
  }
  sendNotFound(res);
});

server.listen(PORT, () => {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Serving frontend from ${FRONTEND_DIR}`);
  console.log(`Serving logs from ${LOG_DIR}`);
});

