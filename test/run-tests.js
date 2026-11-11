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
  check('tennis: Monday practice seeded (4 classes, 16:30–19:30)', st.recurring.filter(r => r.day === 1).length === 4 && st.recurring.some(r => r.day === 1 && r.from === 990) && st.recurring.some(r => r.day === 1 && r.to === 1170));
  const monSegs = st.days.find(d => d.date === MON).segs;
  check('tennis: Monday has a 16:00–16:30 free slot', monSegs.some(g => g.type === 'free' && g.start === 960 && g.end === 990), monSegs);
  check('tennis: Monday has a 19:30–20:00 free slot', monSegs.some(g => g.type === 'free' && g.start === 1170 && g.end === 1200));
  check('tennis: Monday practice shown as 4 blocks', monSegs.filter(g => g.type === 'block').length === 4);
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
  const at = (date, start, extra) => Object.assign(bk(date, undefined, extra), { start });
  check('tennis: 16:00 half-hour slot bookable', (await call('POST', '/api/tennis/bookings', A, at(MON, 960))).status === 200);
  check('tennis: 16:30 (practice) rejected', (await call('POST', '/api/tennis/bookings', A, at(MON, 990))).status === 409);
  check('tennis: 17:00 (inside practice) rejected', (await call('POST', '/api/tennis/bookings', A, at(MON, 1020))).status === 409);
  check('tennis: 19:30 half-hour slot bookable', (await call('POST', '/api/tennis/bookings', A, at(MON, 1170))).status === 200);
  check('tennis: 20:00 full hour bookable', (await call('POST', '/api/tennis/bookings', A, at(MON, 1200))).status === 200);
  check('tennis: start inside a booked slot rejected', (await call('POST', '/api/tennis/bookings', A, at(MON, 1230))).status === 400);
  const sb = (await call('GET', '/api/tennis/state', A)).json.bookings.find(b => b.date === MON && b.start === 960);
  check('tennis: half-hour booking stored as 16:00–16:30', sb && sb.end === 990 && sb.id === MON + '_16');
  check('tennis: 19:30 booking id', (await call('GET', '/api/tennis/state', A)).json.bookings.some(b => b.id === MON + '_1930'));
  const pr = (await call('GET', '/api/tennis/state', A, null, tok)).json.recurring.find(r => r.day === 1 && r.from === 990);
  check('tennis: release needs admin', (await call('POST', '/api/tennis/release', A, { date: MON, recId: pr.id })).status === 403);
  check('tennis: admin releases a practice for one date', (await call('POST', '/api/tennis/release', A, { date: MON, recId: pr.id }, tok)).status === 200);
  check('tennis: released time becomes bookable', (await call('POST', '/api/tennis/bookings', Z, at(MON, 990))).status === 200);
  const rs = (await call('GET', '/api/tennis/state', A)).json.days.find(d => d.date === MON).segs;
  check('tennis: existing 16:00–16:30 booking keeps its slot after release', rs.some(g => g.start === 960 && g.end === 990) && rs.some(g => g.start === 990 && g.end === 1020));
  check('tennis: admin restores the practice', (await call('POST', '/api/tennis/release', A, { date: MON, recId: pr.id, released: false }, tok)).status === 200);
  check('tennis: admin adds a block in minutes', (await call('POST', '/api/tennis/recurring', A, { day: 3, from: 990, to: 1035, unit: 'min', label: 'חוג' }, tok)).status === 200);
  check('tennis: non-15-minute block rejected', (await call('POST', '/api/tennis/recurring', A, { day: 3, from: 991, to: 1035, unit: 'min', label: 'חוג' }, tok)).status === 400);
  check('others cannot cancel', (await call('DELETE', '/api/tennis/bookings/' + id, Z)).status === 403);
  check('owner cancels', (await call('DELETE', '/api/tennis/bookings/' + id, A)).status === 200);
  check('past date rejected', (await call('POST', '/api/tennis/bookings', A, bk('2020-01-01', 10))).status === 400);

  // --- hall ---
  const hs = (await call('GET', '/api/hall/state', Z)).json;
  check('hall: 24 classes from the sheet', hs.recurring.length === 24, hs.recurring.length);
  check('hall: Sunday 20:15–21:30 class', hs.recurring.some(r => r.day === 0 && r.from === 20 * 60 + 15 && r.to === 21 * 60 + 30));
  check('hall: Thursday adult volleyball 21:00–23:00', hs.recurring.some(r => r.day === 4 && r.from === 21 * 60 && r.to === 23 * 60));
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
  check('hall: 24 classes after add+delete', (await call('GET', '/api/hall/state')).json.recurring.length === 24);

  // --- contacts (people who can open) ---
  check('contacts: empty by default', (await call('GET', '/api/tennis/state')).json.contacts.length === 0);
  check('contacts: add needs admin', (await call('POST', '/api/tennis/contacts', A, { name: 'Opener One', phone: '0501111111' })).status === 403);
  check('contacts: bad phone rejected', (await call('POST', '/api/tennis/contacts', A, { name: 'Opener One', phone: '123' }, tok)).status === 400);
  check('contacts: admin adds', (await call('POST', '/api/tennis/contacts', A, { name: 'Opener One', phone: '0501111111', note: 'ערבים' }, tok)).status === 200);
  check('contacts: admin adds a second', (await call('POST', '/api/tennis/contacts', A, { name: 'Opener Two', phone: '0502222222' }, tok)).status === 200);
  const cs = (await call('GET', '/api/tennis/state', Z)).json.contacts;
  check('contacts: visible to everyone, in order', cs.length === 2 && cs[0].name === 'Opener One' && cs[0].phone === '0501111111' && cs[0].note === 'ערבים');
  check('contacts: edit needs admin', (await call('POST', '/api/tennis/contacts/' + cs[0].id, A, { name: 'X Y', phone: '0503333333' })).status === 403);
  check('contacts: admin edits', (await call('POST', '/api/tennis/contacts/' + cs[0].id, A, { name: 'Opener Uno', phone: '0503333333' }, tok)).status === 200);
  const cs2 = (await call('GET', '/api/tennis/state')).json.contacts;
  check('contacts: edit keeps order', cs2[0].name === 'Opener Uno' && cs2[0].phone === '0503333333');
  check('contacts: admin deletes', (await call('DELETE', '/api/tennis/contacts/' + cs[1].id, A, null, tok)).status === 200);
  check('contacts: hall has its own list', (await call('GET', '/api/hall/state')).json.contacts.length === 0);
  check('contacts: hall admin adds', (await call('POST', '/api/hall/contacts', A, { name: 'Hall Opener', phone: '0504444444' }, tok)).status === 200);
  check('contacts: hall list', (await call('GET', '/api/hall/state')).json.contacts.length === 1);

  check('cron prune runs', (await call('GET', '/api/cron/prune')).json.ok === true);

  console.log(failed ? `\n${failed} test(s) FAILED` : '\nAll tests passed');
  server.close(); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
