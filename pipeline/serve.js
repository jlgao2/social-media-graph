#!/usr/bin/env node
/**
 * Tiny static file server for pipeline/output/.
 *
 *   npm run serve              # default port 8765
 *   PORT=4242 npm run serve    # custom port
 *
 * Serves pipeline/output/ at the root. Also exposes:
 *   /photo/<base64url-encoded-absolute-path>   → the photo bytes
 *
 * The /photo/ endpoint is needed because the rendered event HTML uses
 * file:// URLs to reference photos by absolute path, and browsers block
 * file:// from http://localhost. The server can rewrite those URLs at
 * request time, OR you can pre-render with a flag (not done here).
 *
 * Bind to 127.0.0.1 only — no network exposure.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'output');
const PORT = parseInt(process.env.PORT || '8765', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif':  'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4':  'video/mp4',
  '.mov':  'video/quicktime',
};

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

function listDirHtml(reqPath, absDir) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true })
    .sort((a, b) => {
      // dirs first, then files, alpha
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  const items = entries
    .filter(e => !e.name.startsWith('.'))
    .map(e => {
      const slash = e.isDirectory() ? '/' : '';
      const href = encodeURIComponent(e.name) + slash;
      return `<li><a href="${href}">${e.name}${slash}</a></li>`;
    }).join('\n');
  const parent = reqPath === '/' ? '' : '<li><a href="../">..</a></li>';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${reqPath}</title>
<style>body{font-family:ui-monospace,monospace;max-width:720px;margin:2rem auto;padding:0 1.5rem;line-height:1.7}h1{font-size:1.1rem}ul{list-style:none;padding:0}li{padding:0.1rem 0}a{text-decoration:none;color:#0066cc}a:hover{text-decoration:underline}</style>
</head><body><h1>Index of ${reqPath}</h1><ul>${parent}${items}</ul></body></html>`;
}

function rewriteHtmlFileUrls(html) {
  // Rewrite file:// URLs to /photo/<encoded-path> so the browser will load them.
  return html.replace(/file:\/\/([^"'\s]+)/g, (_, absPath) => {
    return '/photo/' + Buffer.from(absPath).toString('base64url');
  });
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400); res.end('bad url'); return;
  }

  // Special endpoint: /photo/<base64url>
  if (urlPath.startsWith('/photo/')) {
    const encoded = urlPath.slice('/photo/'.length);
    let abs;
    try {
      abs = Buffer.from(encoded, 'base64url').toString('utf-8');
    } catch {
      res.writeHead(400); res.end('bad photo path'); return;
    }
    if (!fs.existsSync(abs)) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, {
      'Content-Type': mimeFor(abs),
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(abs).pipe(res);
    return;
  }

  // Normal serve under ROOT
  const safe = path.normalize(path.join(ROOT, urlPath)).replace(/\\/g, '/');
  if (!safe.startsWith(ROOT)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (!fs.existsSync(safe)) {
    res.writeHead(404); res.end('not found'); return;
  }
  const stat = fs.statSync(safe);

  if (stat.isDirectory()) {
    // Try index.html
    const indexPath = path.join(safe, 'index.html');
    if (fs.existsSync(indexPath)) {
      const html = rewriteHtmlFileUrls(fs.readFileSync(indexPath, 'utf-8'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(html);
      return;
    }
    // Otherwise list
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(listDirHtml(urlPath, safe));
    return;
  }

  // File
  const mime = mimeFor(safe);
  if (mime.startsWith('text/html')) {
    const html = rewriteHtmlFileUrls(fs.readFileSync(safe, 'utf-8'));
    res.writeHead(200, { 'Content-Type': mime });
    res.end(html);
  } else {
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(safe).pipe(res);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`pipeline/output served at http://127.0.0.1:${PORT}/`);
  console.log(`  portraits: http://127.0.0.1:${PORT}/portraits/`);
  console.log(`  events:    http://127.0.0.1:${PORT}/events/`);
});
