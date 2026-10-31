'use strict';
// API smoke tests against the local dev server (fake Redis). Run: npm test
process.env.PORT = process.env.PORT || '3456';
const server = require('./dev-server');
const B = 'http://127.0.0.1:' + process.env.PORT;
const A = 'aaaaaaaaaaaaaaaa-1111', Z = 'bbbbbbbbbbbbbbbb-2222';

async function call(method, path, cid, body, token) {
  const h = { 'Content-Type': 'application/json' };
  if (cid) h['X-Client-Id'] = cid;
  if (token) h['X-Admin-Token'] = token;
  const r = await fetch(B + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

let failed = 0;
function check(name, cond) { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) failed++; }

(async () => {
  await new Promise(r => setTimeout(r, 300));
  // Tomorrow in Israel time, 10:00, is always inside the booking window.
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });
  const t = new Date(f.format(new Date()) + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + 1);
  const D = t.toISOString().slice(0, 10), id = D + '_10';

  check('page loads', (await fetch(B + '/')).status === 200);
  check('logo loads', (await fetch(B + '/logo.png')).status === 200);
  check('config', (await call('GET', '/api/config')).json.open === 7);
  check('book a slot', (await call('POST', '/api/bookings', A, { date: D, hour: 10, name: 'Test', phone: '0501234567', seeking: true })).status === 200);
  check('double booking rejected', (await call('POST', '/api/bookings', Z, { date: D, hour: 10, name: 'Other', phone: '0501234567' })).status === 409);
  check('phone hidden from others', (await call('GET', '/api/state', Z)).json.bookings.every(b => b.phone === undefined));
  check('join request', (await call('POST', '/api/joins', Z, { bid: id, name: 'Other', phone: '0507654321' })).status === 200);
  check('owner approves join', (await call('POST', '/api/joins/' + id + '_' + Z + '/answer', A, { approve: true })).status === 200);
  check('wrong admin password rejected', (await call('POST', '/api/admin/login', A, { password: 'nope' })).status === 401);
  const tok = (await call('POST', '/api/admin/login', A, { password: process.env.ADMIN_PASSWORD })).json.token;
  check('admin login', !!tok);
  check('recurring needs admin', (await call('POST', '/api/recurring', A, { day: 1, from: 17, to: 19, label: 'x' })).status === 403);
  check('admin adds recurring', (await call('POST', '/api/recurring', A, { day: 1, from: 17, to: 19, label: 'x' }, tok)).status === 200);
  check('others cannot cancel', (await call('DELETE', '/api/bookings/' + id, Z)).status === 403);
  check('owner cancels', (await call('DELETE', '/api/bookings/' + id, A)).status === 200);
  check('past date rejected', (await call('POST', '/api/bookings', A, { date: '2020-01-01', hour: 10, name: 'Test', phone: '0501234567' })).status === 400);

  console.log(failed ? `\n${failed} test(s) FAILED` : '\nAll tests passed');
  server.close(); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
