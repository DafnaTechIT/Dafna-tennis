'use strict';
// Dafna courts & hall — Vercel serverless API.
// Venues: tennis (bookable court) and hall (read-only schedule, admin-edited).
// Storage: Upstash Redis over its REST API (no npm dependencies). Keys are prefixed per venue.
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TZ = 'Asia/Jerusalem';
const SESS = 'tennis:sess:'; // admin sessions are shared by all venues (kept under the original prefix)
const RL = 'tennis:rl:';
const SESSION_TTL = 30 * 86400; // seconds
const DAYS_AHEAD = +process.env.DAYS_AHEAD || 7;

// Opening hours per weekday, 0 = Sunday … 6 = Saturday: [open, close) in whole hours.
const HOURS = (() => {
  try { const h = JSON.parse(process.env.HOURS_JSON || ''); if (Array.isArray(h) && h.length === 7) return h; } catch (_) {}
  return [[7, 21], [7, 21], [7, 21], [7, 21], [7, 21], [8, 19], [8, 21]];
})();
const MIN_OPEN = Math.min(...HOURS.map(h => h[0])), MAX_CLOSE = Math.max(...HOURS.map(h => h[1]));

const COURT_COLL = ['bookings', 'joins', 'wanted', 'blocks', 'recurring'];
const VENUES = {
  // Tennis is not seeded: its 14:00–16:00 blocks (and a real class in that slot) were already set up by the admin.
  tennis: {
    kind: 'court', prefix: 'tennis:', name: 'מגרש הטניס', courtName: process.env.COURT_NAME || 'מגרש הטניס',
    price: +process.env.GUEST_PRICE || 100, seed: null,
  },
  hall: { kind: 'hall', prefix: 'hall:', name: 'אולם הספורט', coll: ['recurring', 'exceptions'], seed: 'hall' },
};
const MAX_PER_DAY = +process.env.MAX_PER_DAY || 0;

// One-time seed data, written the first time each venue is used (guarded by a Redis SET NX flag).
const T = (h, m) => h * 60 + m;
const HALL_SEED = [
  [0, T(17, 30), T(18, 45), 'ג׳–ד׳ דפנה'],
  [0, T(18, 45), T(20, 15), 'קטסל ב׳ הגושרים/דפנה'],
  [1, T(14, 0), T(16, 30), 'ילדי דואון ג׳–ד׳'],
  [1, T(16, 30), T(17, 30), 'א׳–ב׳ בנות דפנה'],
  [1, T(17, 30), T(18, 30), 'ג׳–ד׳ בנות דפנה'],
  [1, T(18, 30), T(19, 30), 'כדורעף אורן הוד'],
  [1, T(19, 30), T(21, 0), 'טניס שולחן'],
  [1, T(21, 0), T(23, 0), 'כדורסל בוגרים'],
  [2, T(14, 0), T(16, 0), 'ילדי דואון א׳–ו׳'],
  [2, T(16, 15), T(20, 15), 'התעמלות עם רותם ברק'],
  [2, T(20, 15), T(22, 15), 'אימון מ.כ דפנה'],
  [3, T(14, 0), T(16, 30), 'ילדי דואון א׳–ו׳'],
  [3, T(16, 30), T(17, 30), 'א׳–ב׳ דפנה'],
  [3, T(17, 30), T(18, 45), 'ג׳–ד׳ דפנה'],
  [3, T(18, 45), T(20, 15), 'קטסל ב׳ הגושרים/דפנה'],
  [3, T(20, 30), T(22, 30), 'פוטסל בוגרים דפנה'],
  [4, T(14, 0), T(16, 30), 'ילדי דואון א׳–ב׳'],
  [4, T(16, 30), T(19, 30), 'התעמלות עם רותם ברק'],
  [4, T(19, 30), T(21, 0), 'טניס שולחן'],
  [5, T(16, 0), T(17, 30), 'אימון מ.כ דפנה כדורסל'],
  [6, T(18, 0), T(19, 30), 'משחקי בית מ.כ דפנה כדורסל'],
  [6, T(20, 30), T(22, 30), 'פוטסל בוגרים דפנה'],
].map(([day, from, to, label], i) => ['seed-' + String(i + 1).padStart(2, '0'), { day, from, to, label }]);

// ---------- Redis (Upstash REST) ----------
async function redis(path, body) {
  const r = await fetch(REDIS_URL.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('redis ' + r.status + ' ' + (j.error || ''));
  return j;
}
const cmd = async (...args) => { const j = await redis('', args); if (j.error) throw new Error(j.error); return j.result; };
async function pipeline(cmds) {
  if (!cmds.length) return [];
  const out = await redis('/pipeline', cmds);
  return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const hashToObj = arr => { const o = {}; for (let i = 0; i < (arr || []).length; i += 2) { try { o[arr[i]] = JSON.parse(arr[i + 1]); } catch (_) {} } return o; };

// ---------- time (always Israel time, independent of server TZ) ----------
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function ilNow() {
  const p = {}; for (const x of fmt.formatToParts(new Date())) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour };
}
const dayStr = i => { const n = ilNow(); return new Date(Date.UTC(n.y, n.m - 1, n.d + i)).toISOString().slice(0, 10); };
const nowHour = () => ilNow().h;
const weekday = date => new Date(date + 'T12:00:00Z').getUTCDay();

const pad = n => (n < 10 ? '0' : '') + n;
const bkey = (date, hour) => date + '_' + pad(hour);
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const digits = s => String(s).replace(/\D/g, '');
const newId = p => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

class HttpErr extends Error { constructor(c, m) { super(m); this.code = c; } }
const need = (c, code, msg) => { if (!c) throw new HttpErr(code, msg); };

const hset = (V, c, id, v) => ['HSET', V.prefix + c, id, JSON.stringify(v)];
const hdel = (V, c, id) => ['HDEL', V.prefix + c, id];
const collsOf = V => V.coll || COURT_COLL;

const seeded = {};
async function ensureSeed(vname) {
  if (seeded[vname]) return;
  const V = VENUES[vname];
  if (!V.seed) { seeded[vname] = true; return; }
  const first = await cmd('SET', V.prefix + 'seed:v1', '1', 'NX');
  if (first === 'OK') {
    const rows = HALL_SEED;
    await pipeline(rows.map(([id, r]) => ['HSETNX', V.prefix + 'recurring', id, JSON.stringify(r)]));
  }
  seeded[vname] = true;
}

// Loads every collection of a venue (+ admin session) in a single Redis round trip.
async function loadDb(V, token) {
  const colls = collsOf(V);
  const cmds = colls.map(c => ['HGETALL', V.prefix + c]);
  if (token) cmds.push(['GET', SESS + token]);
  const res = await pipeline(cmds);
  const db = {};
  colls.forEach((c, i) => { db[c] = hashToObj(res[i]); });
  db.admin = !!(token && res[colls.length]);
  return db;
}

function configFor(vname) {
  const V = VENUES[vname];
  if (V.kind === 'hall') return { venue: vname, kind: 'hall', name: V.name, daysAhead: DAYS_AHEAD, start: 14 * 60, end: 23 * 60 };
  return {
    venue: vname, kind: 'court', name: V.name, courtName: V.courtName, price: V.price, daysAhead: DAYS_AHEAD,
    hours: HOURS, maxPerDay: MAX_PER_DAY,
    // kept for older cached pages
    open: MIN_OPEN, close: MAX_CLOSE,
  };
}

// ---------- court (tennis) ----------
function blockInfo(db, date, hour) {
  const bk = db.blocks[bkey(date, hour)];
  if (bk) return bk.released ? null : { label: bk.label || 'חוג' };
  const wd = weekday(date);
  for (const id in db.recurring) {
    const r = db.recurring[id];
    if (r.day === wd && hour >= r.from && hour < r.to) return { label: r.label || 'חוג' };
  }
  return null;
}

function courtState(db, cid) {
  const admin = db.admin, today = dayStr(0);
  const bookings = Object.values(db.bookings).filter(b => b.date >= today).map(b => {
    const mine = !!cid && b.cid === cid, see = mine || admin;
    return { id: b.id, date: b.date, hour: b.hour, name: b.name, seeking: !!b.seeking, partner: b.partner || '', mine, phone: see ? b.phone : undefined, resident: see ? b.resident : undefined };
  });
  const joins = Object.values(db.joins).filter(j => db.bookings[j.bid]).flatMap(j => {
    const b = db.bookings[j.bid], mine = !!cid && j.cid === cid, owner = !!cid && b.cid === cid;
    if (!(mine || owner || admin)) return [];
    return [{ id: j.id, bid: j.bid, status: j.status, mine, name: (owner || admin) ? j.name : undefined, phone: (owner || admin) ? j.phone : undefined }];
  });
  const wanted = Object.values(db.wanted).map(w => ({ id: w.id, name: w.name, phone: w.phone, note: w.note, createdAt: w.createdAt, mine: !!cid && w.id === cid }));
  const blocks = Object.values(db.blocks).filter(b => b.date >= today).map(b => ({ date: b.date, hour: b.hour, label: b.label, released: !!b.released }));
  const recurring = Object.entries(db.recurring).map(([id, r]) => Object.assign({ id }, r));
  return { me: { admin }, bookings, joins, wanted, blocks, recurring };
}

function validSlot(b) {
  const hour = b.hour;
  need(/^\d{4}-\d{2}-\d{2}$/.test(b.date || ''), 400, 'תאריך לא תקין');
  need(Number.isInteger(hour), 400, 'שעה לא תקינה');
  need(b.date >= dayStr(0) && b.date <= dayStr(DAYS_AHEAD), 400, 'אפשר להזמין עד ' + DAYS_AHEAD + ' ימים קדימה');
  const [open, close] = HOURS[weekday(b.date)];
  need(hour >= open && hour < close, 400, 'השעה מחוץ לשעות הפעילות');
  need(!(b.date === dayStr(0) && hour < nowHour()), 400, 'השעה הזו כבר עברה');
}

async function courtRoute(V, req, body, sub, cid, db) {
  const m = req.method, admin = db.admin;
  let r;
  if (m === 'GET' && sub === '/state') return courtState(db, cid);

  if (m === 'POST' && sub === '/bookings') {
    need(cid, 400, 'מזהה מכשיר חסר');
    const b = { date: body.date, hour: body.hour };
    validSlot(b);
    const name = clean(body.name, 60), phone = clean(body.phone, 20);
    need(name.length >= 2, 400, 'נא להזין שם');
    need(digits(phone).length >= 9, 400, 'נא להזין טלפון תקין');
    need(body.rules === true, 400, 'יש לאשר שקראתם את כללי ההתנהגות');
    need(!blockInfo(db, b.date, b.hour), 409, 'השעה הזו חסומה');
    const id = bkey(b.date, b.hour);
    need(!db.bookings[id], 409, 'השעה הזו כבר נתפסה');
    if (MAX_PER_DAY) need(Object.values(db.bookings).filter(x => x.cid === cid && x.date === b.date).length < MAX_PER_DAY, 409, 'הגעתם למכסת ההזמנות ליום');
    const rec = { id, date: b.date, hour: b.hour, name, phone, resident: !!body.resident, seeking: !!body.seeking, partner: '', rules: true, cid, createdAt: Date.now() };
    // HSETNX is atomic: two people racing for the same slot can't both win.
    const won = await cmd('HSETNX', V.prefix + 'bookings', id, JSON.stringify(rec));
    need(won === 1, 409, 'השעה הזו כבר נתפסה');
    return { ok: true };
  }
  if ((r = sub.match(/^\/bookings\/([\w-]+)$/)) && m === 'DELETE') {
    const b = db.bookings[r[1]]; need(b, 404, 'ההזמנה לא נמצאה');
    need(admin || (cid && b.cid === cid), 403, 'אפשר לבטל רק הזמנה שלכם');
    const ops = [hdel(V, 'bookings', b.id)];
    for (const k in db.joins) if (db.joins[k].bid === b.id) ops.push(hdel(V, 'joins', k));
    await pipeline(ops); return { ok: true };
  }

  if (m === 'POST' && sub === '/joins') {
    need(cid, 400, 'מזהה מכשיר חסר');
    const b = db.bookings[body.bid]; need(b, 404, 'ההזמנה לא נמצאה');
    need(b.seeking && !b.partner, 409, 'ההזמנה הזו לא מחפשת שותף');
    need(b.cid !== cid, 400, 'זו ההזמנה שלכם');
    const name = clean(body.name, 60), phone = clean(body.phone, 20);
    need(name.length >= 2 && digits(phone).length >= 9, 400, 'נא למלא שם וטלפון תקין');
    const id = b.id + '_' + cid;
    need(!db.joins[id] || db.joins[id].status === 'declined', 409, 'כבר שלחתם בקשה');
    await pipeline([hset(V, 'joins', id, { id, bid: b.id, name, phone, status: 'pending', cid, createdAt: Date.now() })]);
    return { ok: true };
  }
  if ((r = sub.match(/^\/joins\/([\w-]+)\/answer$/)) && m === 'POST') {
    const j = db.joins[r[1]]; need(j, 404, 'הבקשה לא נמצאה');
    const b = db.bookings[j.bid]; need(b, 404, 'ההזמנה לא נמצאה');
    need(admin || (cid && b.cid === cid), 403, 'אין הרשאה');
    const ops = [];
    if (body.approve) {
      need(!b.partner, 409, 'כבר אושר שותף');
      j.status = 'approved'; b.partner = j.name; b.seeking = false;
      ops.push(hset(V, 'bookings', b.id, b));
      for (const k in db.joins) {
        const o = db.joins[k];
        if (o.bid === b.id && k !== j.id && o.status === 'pending') { o.status = 'declined'; ops.push(hset(V, 'joins', k, o)); }
      }
    } else j.status = 'declined';
    ops.push(hset(V, 'joins', j.id, j));
    await pipeline(ops); return { ok: true };
  }

  if (m === 'POST' && sub === '/wanted') {
    need(cid, 400, 'מזהה מכשיר חסר');
    const name = clean(body.name, 60), phone = clean(body.phone, 20), note = clean(body.note, 100);
    need(name.length >= 2 && digits(phone).length >= 9, 400, 'נא למלא שם וטלפון תקין');
    await pipeline([hset(V, 'wanted', cid, { id: cid, name, phone, note, createdAt: Date.now() })]);
    return { ok: true };
  }
  if ((r = sub.match(/^\/wanted\/([\w-]+)$/)) && m === 'DELETE') {
    need(admin || (cid && r[1] === cid), 403, 'אין הרשאה');
    await pipeline([hdel(V, 'wanted', r[1])]); return { ok: true };
  }

  // admin-only
  if (sub.startsWith('/blocks') || sub.startsWith('/recurring')) need(admin, 403, 'פעולה למנהל בלבד');
  if (m === 'POST' && sub === '/blocks') {
    validSlot(body);
    await pipeline([hset(V, 'blocks', bkey(body.date, body.hour), { date: body.date, hour: body.hour, label: clean(body.label, 40) || 'חוג' })]);
    return { ok: true };
  }
  if (m === 'POST' && sub === '/blocks/release') {
    validSlot(body);
    await pipeline([hset(V, 'blocks', bkey(body.date, body.hour), { date: body.date, hour: body.hour, released: true })]);
    return { ok: true };
  }
  if (m === 'POST' && sub === '/recurring') {
    const day = body.day, from = body.from, to = body.to;
    need(Number.isInteger(day) && day >= 0 && day <= 6, 400, 'יום לא תקין');
    need(Number.isInteger(from) && Number.isInteger(to) && from >= MIN_OPEN && to <= MAX_CLOSE && to > from, 400, 'שעות לא תקינות');
    await pipeline([hset(V, 'recurring', newId('r'), { day, from, to, label: clean(body.label, 40) || 'חוג' })]);
    return { ok: true };
  }
  if ((r = sub.match(/^\/recurring\/([\w-]+)$/)) && m === 'DELETE') {
    await pipeline([hdel(V, 'recurring', r[1])]); return { ok: true };
  }
  throw new HttpErr(404, 'לא נמצא');
}

// ---------- hall (read-only schedule, admin edits) ----------
function hallState(db) {
  const today = dayStr(0);
  return {
    me: { admin: db.admin },
    recurring: Object.entries(db.recurring).map(([id, r]) => Object.assign({ id }, r)),
    exceptions: Object.values(db.exceptions).filter(e => e.date >= today),
  };
}

function validClass(body) {
  const day = body.day, from = body.from, to = body.to, label = clean(body.label, 60);
  need(Number.isInteger(day) && day >= 0 && day <= 6, 400, 'יום לא תקין');
  need(Number.isInteger(from) && Number.isInteger(to) && from % 15 === 0 && to % 15 === 0 && from >= 0 && to <= 24 * 60 && to > from, 400, 'שעות לא תקינות');
  need(label.length >= 2, 400, 'נא להזין שם לחוג');
  return { day, from, to, label };
}

async function hallRoute(V, req, body, sub, db) {
  const m = req.method;
  let r;
  if (m === 'GET' && sub === '/state') return hallState(db);
  need(db.admin, 403, 'פעולה למנהל בלבד');
  if (m === 'POST' && sub === '/recurring') {
    await pipeline([hset(V, 'recurring', newId('h'), validClass(body))]);
    return { ok: true };
  }
  if ((r = sub.match(/^\/recurring\/([\w-]+)$/))) {
    need(db.recurring[r[1]], 404, 'החוג לא נמצא');
    if (m === 'POST') { await pipeline([hset(V, 'recurring', r[1], validClass(body))]); return { ok: true }; }
    if (m === 'DELETE') {
      const ops = [hdel(V, 'recurring', r[1])];
      for (const k in db.exceptions) if (db.exceptions[k].recId === r[1]) ops.push(hdel(V, 'exceptions', k));
      await pipeline(ops); return { ok: true };
    }
  }
  if (m === 'POST' && sub === '/release') {
    const date = body.date, recId = String(body.recId || '');
    need(/^\d{4}-\d{2}-\d{2}$/.test(date || '') && date >= dayStr(0) && date <= dayStr(DAYS_AHEAD), 400, 'תאריך לא תקין');
    const rec = db.recurring[recId]; need(rec, 404, 'החוג לא נמצא');
    need(rec.day === weekday(date), 400, 'החוג לא מתקיים ביום הזה');
    const key = date + '_' + recId;
    await pipeline([body.released === false ? hdel(V, 'exceptions', key) : hset(V, 'exceptions', key, { date, recId, released: true })]);
    return { ok: true };
  }
  throw new HttpErr(404, 'לא נמצא');
}

// ---------- cleanup ----------
async function prune() {
  const today = dayStr(0);
  let removed = 0;
  for (const vname of Object.keys(VENUES)) {
    const V = VENUES[vname], db = await loadDb(V), ops = [];
    if (V.kind === 'hall') {
      for (const k in db.exceptions) if (db.exceptions[k].date < today) ops.push(hdel(V, 'exceptions', k));
    } else {
      for (const k in db.bookings) if (db.bookings[k].date < today) { ops.push(hdel(V, 'bookings', k)); delete db.bookings[k]; }
      for (const k in db.blocks) if (db.blocks[k].date < today) ops.push(hdel(V, 'blocks', k));
      for (const k in db.joins) if (!db.bookings[db.joins[k].bid]) ops.push(hdel(V, 'joins', k));
    }
    await pipeline(ops); removed += ops.length;
  }
  return { ok: true, removed };
}

function passOk(p) {
  const a = crypto.createHash('sha256').update(String(p)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

async function route(req, body, p) {
  const c = req.headers['x-client-id'] || '';
  const cid = /^[a-f0-9-]{16,64}$/i.test(c) ? c : null;
  const tok = String(req.headers['x-admin-token'] || '');
  const token = /^[a-f0-9]{48}$/.test(tok) ? tok : null;

  // /api/<venue>/<sub>; older pages call /api/<sub>, which means tennis.
  const vm = p.match(/^\/api\/(tennis|hall)(\/.*)?$/);
  const vname = vm ? vm[1] : 'tennis';
  const sub = vm ? (vm[2] || '') : p.replace(/^\/api/, '');
  const V = VENUES[vname];

  if (sub === '/cron/prune') {
    const secret = process.env.CRON_SECRET;
    need(!secret || req.headers.authorization === 'Bearer ' + secret, 401, 'unauthorized');
    return prune();
  }
  if (req.method === 'GET' && sub === '/config') return configFor(vname);

  if (req.method === 'POST' && sub === '/admin/login') {
    const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
    const n = await cmd('INCR', RL + ip);
    if (n === 1) await cmd('EXPIRE', RL + ip, 900);
    need(n <= 10, 429, 'יותר מדי ניסיונות, נסו מאוחר יותר');
    need(passOk(body.password), 401, 'סיסמה שגויה');
    const t = crypto.randomBytes(24).toString('hex');
    await cmd('SET', SESS + t, '1', 'EX', SESSION_TTL);
    return { token: t };
  }

  await ensureSeed(vname);
  const db = await loadDb(V, token);
  return V.kind === 'hall' ? hallRoute(V, req, body, sub, db) : courtRoute(V, req, body, sub, cid, db);
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  let b;
  try { b = req.body; } catch (_) { throw new SyntaxError('bad json'); } // Vercel's getter throws on bad JSON
  if (b === undefined) {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 10000) throw new HttpErr(413, 'בקשה גדולה מדי'); }
    return raw ? JSON.parse(raw) : {};
  }
  if (typeof b === 'string') return b ? JSON.parse(b) : {};
  if (Buffer.isBuffer(b)) return b.length ? JSON.parse(b.toString('utf8')) : {};
  return b && typeof b === 'object' ? b : {};
}

module.exports = async function handler(req, res) {
  let code = 200, out;
  try {
    need(REDIS_URL && REDIS_TOKEN, 500, 'מסד הנתונים לא מוגדר');
    need(ADMIN_PASSWORD.length >= 6, 500, 'לא הוגדרה סיסמת מנהל (ADMIN_PASSWORD)');
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    need(JSON.stringify(body).length <= 10000, 413, 'בקשה גדולה מדי');
    out = await route(req, body, url.pathname.replace(/\/+$/, ''));
  } catch (e) {
    code = e instanceof HttpErr ? e.code : (e instanceof SyntaxError ? 400 : 500);
    out = { error: e instanceof HttpErr ? e.message : code === 400 ? 'בקשה לא תקינה' : 'שגיאת שרת' };
    if (code === 500) console.error(e);
  }
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(out));
};
module.exports._test = { dayStr, nowHour, blockInfo, HOURS };
