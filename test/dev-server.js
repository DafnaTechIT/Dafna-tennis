'use strict';
// Local dev server: serves public/ and the real api/index.js, backed by an
// in-memory fake of the Upstash Redis REST API. No real database needed.
// Usage: node test/dev-server.js   (then open http://localhost:3000)
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = +process.env.PORT || 3000, REDIS_PORT = PORT + 79;
const store = new Map(), hashes = new Map();

function run([c, ...x]) {
  const h = k => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
  switch (String(c).toUpperCase()) {
    case 'HGETALL': return [...(hashes.get(x[0]) || new Map())].flat();
    case 'HSET': h(x[0]).set(x[1], x[2]); return 1;
    case 'HSETNX': if (h(x[0]).has(x[1])) return 0; h(x[0]).set(x[1], x[2]); return 1;
    case 'HDEL': return h(x[0]).delete(x[1]) ? 1 : 0;
    case 'GET': return store.has(x[0]) ? store.get(x[0]) : null;
    case 'SET': store.set(x[0], x[1]); return 'OK';
    case 'INCR': { const v = (+store.get(x[0]) || 0) + 1; store.set(x[0], String(v)); return v; }
    case 'EXPIRE': return 1;
    default: throw new Error('unsupported command ' + c);
  }
}

http.createServer((q, s) => {
  let b = ''; q.on('data', d => b += d); q.on('end', () => {
    const body = JSON.parse(b || 'null'); let out;
    try { out = q.url === '/pipeline' ? body.map(c => ({ result: run(c) })) : { result: run(body) }; }
    catch (e) { out = { error: e.message }; }
    s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify(out));
  });
}).listen(REDIS_PORT, '127.0.0.1');

process.env.KV_REST_API_URL = 'http://127.0.0.1:' + REDIS_PORT;
process.env.KV_REST_API_TOKEN = 'dev';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'devpass123';
const handler = require(path.join(ROOT, 'api', 'index.js'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

const server = http.createServer((q, s) => {
  if (q.url.startsWith('/api/')) return handler(q, s);
  let p = q.url.split('?')[0]; if (p === '/') p = '/index.html';
  const f = path.join(ROOT, 'public', path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(f, (err, data) => {
    if (err) { s.writeHead(404); return s.end('Not found'); }
    s.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); s.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log('Dev server on http://localhost:' + PORT + ' (admin password: ' + process.env.ADMIN_PASSWORD + ')'));

module.exports = server;
