// Local dev server for /addiction/ and the api/addiction/* handlers.
//
// Why this exists: Vercel CLI requires login + project link to run
// `vercel dev`. This is a minimal stand-in that mounts the same
// serverless handlers and serves the static files. Not used in
// production — Vercel wires the api/ handlers directly.
//
// Run with:
//   node --env-file=.env.local dev-server.js
//
// Then open: http://localhost:3000/addiction/

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const ROUTES = {
  '/api/addiction/next-question': './api/addiction/next-question.js',
  '/api/addiction/analyze': './api/addiction/analyze.js',
};

// Polyfill the Vercel-style res.status().json() chain on top of node:http.
function attachVercelResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    if (!res.headersSent) res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        req.destroy();
        reject(new Error('payload too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  let p = pathname;
  if (p === '/' || p === '') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const safe = normalize(p).replace(/^[\\/]+/, '');
  const full = join(__dirname, safe);
  if (!full.startsWith(__dirname)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  try {
    const buf = await readFile(full);
    res.statusCode = 200;
    res.setHeader('content-type', MIME[extname(full)] || 'application/octet-stream');
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  attachVercelResponse(res);

  if (ROUTES[pathname]) {
    if (req.method === 'POST') {
      let body = null;
      try {
        const raw = await readBody(req);
        if (raw) {
          try { body = JSON.parse(raw); } catch { body = raw; }
        }
      } catch {
        res.statusCode = 413;
        res.end('Payload too large');
        return;
      }
      req.body = body;
    }
    try {
      const mod = await import(ROUTES[pathname]);
      await mod.default(req, res);
    } catch (err) {
      // Don't leak details to the client. Console only.
      console.error(`[dev-server] handler error for ${pathname}:`, err.message);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'Handler crashed' } }));
      }
    }
    return;
  }

  await serveStatic(req, res, pathname);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[dev-server] port ${PORT} is already in use`);
  } else {
    console.error('[dev-server] error:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`[dev-server] listening on http://localhost:${PORT}`);
  console.log(`[dev-server] open: http://localhost:${PORT}/addiction/`);
  console.log(`[dev-server] api:  POST http://localhost:${PORT}/api/addiction/{next-question,analyze}`);
});
