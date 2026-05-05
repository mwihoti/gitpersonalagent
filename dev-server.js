'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const scanHandler = require('./api/scan');
const healthHandler = require('./api/health');
const opportunitiesHandler = require('./api/opportunities/index');
const opportunityHandler = require('./api/opportunities/[id]');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function serveFile(res, targetPath) {
  const ext = path.extname(targetPath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const stream = fs.createReadStream(targetPath);
  stream.on('error', () => {
    res.statusCode = 404;
    res.end('Not found');
  });
  res.setHeader('Content-Type', contentType);
  stream.pipe(res);
}

function resolvePublicFile(pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
  return path.join(PUBLIC_DIR, safePath);
}

async function routeApi(req, res, pathname, query) {
  req.query = query;

  if (pathname === '/api/scan') {
    return scanHandler(req, res);
  }
  if (pathname === '/api/health') {
    return healthHandler(req, res);
  }
  if (pathname === '/api/opportunities') {
    return opportunitiesHandler(req, res);
  }

  const match = pathname.match(/^\/api\/opportunities\/(.+)$/);
  if (match) {
    req.query = { ...query, id: decodeURIComponent(match[1]) };
    return opportunityHandler(req, res);
  }

  res.statusCode = 404;
  res.end('Not found');
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname || '/';
  const query = Object.fromEntries(parsed.searchParams.entries());

  if (pathname.startsWith('/api/')) {
    try {
      await routeApi(req, res, pathname, query);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  const targetPath = resolvePublicFile(pathname);
  if (!targetPath.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  fs.stat(targetPath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    serveFile(res, targetPath);
  });
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
