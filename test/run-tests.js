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
function check(name, cond, extra) { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !extra ? '' : '  ' + JSON.stringify(extra))); if (!cond) failed++; }

// Israel-time dates: the next date (1..7 days ahead) falling on a given weekday.
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });
function nextDay(weekday) {
  const t = new Date(fmt.format(new Date()) + 'T12:00:00Z');
  for (let i = 1; i <= 7; i++) { t.setUTCDate(t.getUTCDate() + 1); if (t.getUTCDay() === weekday) return t.toISOString().slice(0, 10); }
}
const bk = (date, hour, extra) => Object.assign({ date, hour, name: 'Test', phone: '0501234567', rules: true }, extra);

(async () => {
  await new Promise(r => setTimeout(r, 300));
  const MON = nextDay(1), FRI = nextDay(5), SAT = nextDay(6), id = MON + '_10';

  check('page loads', (await fetch(B + '/')).status === 200);
  check('logo loads', (await fetch(B + '/logo.png')).status === 200);
  const cfg = (await call('GET', '/api/tennis/config')).json;
  check('config has per-day hours', Array.isArray(cfg.hours) && cfg.hours[5][0] === 8 && cfg.hours[5][1] === 19, cfg);
  check('old /api/config path still works', (await call('GET', '/api/config')).json.venue === 'tennis');

  // --- tennis bookings ---
  check('book a slot', (await call('POST', '/api/tennis/bookings', A, bk(MON, 10, { seeking: true }))).status === 200);
  check('booking without rules rejected', (await call('POST', '/api/tennis/bookings', A, bk(MON, 11, { rules: undefined }))).status === 400);
  check('double booking rejected', (await call('POST', '/api/tennis/bookings', Z, bk(MON, 10))).status === 409);
  check('weekday 21:00 rejected (closes 21)', (await call('POST', '/api/tennis/bookings', A, bk(MON, 21))).status === 400);
  check('Friday 07:00 rejected', (await call('POST', '/api/tennis/bookings', A, bk(FRI, 7))).status === 400);
  check('Friday 19:00 rejected', (await call('POST', '/api/tennis/bookings', A, bk(FRI, 19))).status === 400);
  check('Friday 18:00 accepted', (await call('POST', '/api/tennis/bookings', A, bk(FRI, 18))).status === 200);
  check('Saturday 20:00 accepted', (await call('POST', '/api/tennis/bookings', A, bk(SAT, 20))).status === 200);
  const st = (await call('GET', '/api/tennis/state', Z)).json;
  check('phone hidden from others', st.bookings.every(b => b.phone === undefined));
  check('tennis is not auto-seeded (admin already set its blocks)', st.recurring.length === 0);
  check('join request', (await call('POST', '/api/tennis/joins', Z, { bid: id, name: 'Other', phone: '0507654321' })).status === 200);
  check('owner approves join', (await call('POST', '/api/tennis/joins/' + id + '_' + Z + '/answer', A, { approve: true })).status === 200);

  check('combined court removed', (await call('GET', '/api/multi/config')).json.venue === undefined);

  // --- admin ---
  check('wrong admin password rejected', (await call('POST', '/api/admin/login', A, { password: 'nope' })).status === 401);
  const tok = (await call('POST', '/api/admin/login', A, { password: process.env.ADMIN_PASSWORD })).json.token;
  check('admin login', !!tok);
  check('recurring needs admin', (await call('POST', '/api/tennis/recurring', A, { day: 1, from: 17, to: 19, label: 'x' })).status === 403);
  check('admin adds recurring', (await call('POST', '/api/tennis/recurring', A, { day: 1, from: 14, to: 16, label: 'חוג' }, tok)).status === 200);
  check('tennis: booking inside an admin block rejected', (await call('POST', '/api/tennis/bookings', A, bk(MON, 14))).status === 409);
  check('others cannot cancel', (await call('DELETE', '/api/tennis/bookings/' + id, Z)).status === 403);
  check('owner cancels', (await call('DELETE', '/api/tennis/bookings/' + id, A)).status === 200);
  check('past date rejected', (await call('POST', '/api/tennis/bookings', A, bk('2020-01-01', 10))).status === 400);

  // --- hall ---
  const hs = (await call('GET', '/api/hall/state', Z)).json;
  check('hall: 22 seeded classes', hs.recurring.length === 22, hs.recurring.length);
  check('hall: times in minutes', hs.recurring.some(r => r.day === 0 && r.from === 17 * 60 + 30 && r.to === 18 * 60 + 45));
  check('hall: no bookings endpoint', (await call('POST', '/api/hall/bookings', A, bk(MON, 15))).status === 403);
  const mon = hs.recurring.find(r => r.day === 1);
  check('hall: release needs admin', (await call('POST', '/api/hall/release', A, { date: MON, recId: mon.id })).status === 403);
  check('hall: add class needs admin', (await call('POST', '/api/hall/recurring', A, { day: 2, from: 900, to: 960, label: 'חוג חדש' })).status === 403);
  check('hall: edit class needs admin', (await call('POST', '/api/hall/recurring/' + mon.id, A, { day: 1, from: 840, to: 900, label: 'x' })).status === 403);
  check('hall: admin releases a single date', (await call('POST', '/api/hall/release', A, { date: MON, recId: mon.id }, tok)).status === 200);
  check('hall: release is visible', (await call('GET', '/api/hall/state')).json.exceptions.some(e => e.date === MON && e.recId === mon.id && e.released));
  check('hall: release on wrong weekday rejected', (await call('POST', '/api/hall/release', A, { date: FRI, recId: mon.id }, tok)).status === 400);
  check('hall: admin restores the date', (await call('POST', '/api/hall/release', A, { date: MON, recId: mon.id, released: false }, tok)).status === 200);
  check('hall: admin adds a class (15-min steps)', (await call('POST', '/api/hall/recurring', A, { day: 2, from: 22 * 60 + 15, to: 23 * 60, label: 'חוג חדש' }, tok)).status === 200);
  check('hall: non-15-minute time rejected', (await call('POST', '/api/hall/recurring', A, { day: 2, from: 22 * 60 + 10, to: 23 * 60, label: 'x חוג' }, tok)).status === 400);
  check('hall: admin edits a class', (await call('POST', '/api/hall/recurring/' + mon.id, A, { day: 1, from: 840, to: 900, label: 'שם חדש' }, tok)).status === 200);
  check('hall: admin deletes a class', (await call('DELETE', '/api/hall/recurring/' + mon.id, A, null, tok)).status === 200);
  check('hall: 22 classes after add+delete', (await call('GET', '/api/hall/state')).json.recurring.length === 22);

  check('cron prune runs', (await call('GET', '/api/cron/prune')).json.ok === true);

  console.log(failed ? `\n${failed} test(s) FAILED` : '\nAll tests passed');
  server.close(); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
