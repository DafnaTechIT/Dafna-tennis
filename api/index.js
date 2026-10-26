'use strict';
// Dafna tennis court booking — Vercel serverless version.
// Storage: Upstash Redis over its REST API (no npm dependencies).
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TZ = 'Asia/Jerusalem';
const P = 'tennis:'; // key prefix
const COLL = ['bookings', 'joins', 'wanted', 'blocks', 'recurring'];
const SESSION_TTL = 30 * 86400; // seconds
const CFG = {
  open: +process.env.OPEN_HOUR || 7,
  close: +process.env.CLOSE_HOUR || 22,
  daysAhead: +process.env.DAYS_AHEAD || 7,
  price: +process.env.GUEST_PRICE || 100,
  courtName: process.env.COURT_NAME || 'המגרש',
  maxPerDay: +process.env.MAX_PER_DAY || 0,
};

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
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
function ilNow() {
  const p = {}; for (const x of fmt.formatToParts(new Date())) p[x.type] = +x.value || x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour };
}
const dayStr = i => { const n = ilNow(); return new Date(Date.UTC(n.y, n.m - 1, n.d + i)).toISOString().slice(0, 10); };
const nowHour = () => ilNow().h;

const pad = n => (n < 10 ? '0' : '') + n;
const bkey = (date, hour) => date + '_' + pad(hour);
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const digits = s => String(s).replace(/\D/g, '');

class HttpErr extends Error { constructor(c, m) { super(m); this.code = c; } }
const need = (c, code, msg) => { if (!c) throw new HttpErr(code, msg); };

// Loads every collection (+ admin session) in a single Redis round trip.
async function loadDb(token) {
  const cmds = COLL.map(c => ['HGETALL', P + c]);
  if (token) cmds.push(['GET', P + 'sess:' + token]);
  const res = await pipeline(cmds);
  const db = {};
  COLL.forEach((c, i) => { db[c] = hashToObj(res[i]); });
  db.admin = !!(token && res[COLL.length]);
  return db;
}

function blockInfo(db, date, hour) {
  const bk = db.blocks[bkey(date, hour)];
  if (bk) return bk.released ? null : { label: bk.label || 'חוג' };
  const wd = new Date(date + 'T12:00:00Z').getUTCDay();
  for (const id in db.recurring) {
    const r = db.recurring[id];
    if (r.day === wd && hour >= r.from && hour < r.to) return { label: r.label || 'חוג' };
  }
  return null;
}

function stateFor(db, cid) {
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
  need(Number.isInteger(hour) && hour >= CFG.open && hour < CFG.close, 400, 'שעה לא תקינה');
  need(b.date >= dayStr(0) && b.date <= dayStr(CFG.daysAhead), 400, 'אפשר להזמין עד ' + CFG.daysAhead + ' ימים קדימה');
  need(!(b.date === dayStr(0) && hour < nowHour()), 400, 'השעה הזו כבר עברה');
}

const hset = (c, id, v) => ['HSET', P + c, id, JSON.stringify(v)];
const hdel = (c, id) => ['HDEL', P + c, id];

function passOk(p) {
  const a = crypto.createHash('sha256').update(String(p)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

async function prune() {
  const db = await loadDb();
  const today = dayStr(0), ops = [];
  for (const k in db.bookings) if (db.bookings[k].date < today) { ops.push(hdel('bookings', k)); delete db.bookings[k]; }
  for (const k in db.blocks) if (db.blocks[k].date < today) ops.push(hdel('blocks', k));
  for (const k in db.joins) if (!db.bookings[db.joins[k].bid]) ops.push(hdel('joins', k));
  await pipeline(ops);
  return { ok: true, removed: ops.length };
}

async function route(req, body, p) {
  const m = req.method;
  const c = req.headers['x-client-id'] || '';
  const cid = /^[a-f0-9-]{16,64}$/i.test(c) ? c : null;
  const tok = String(req.headers['x-admin-token'] || '');
  const token = /^[a-f0-9]{48}$/.test(tok) ? tok : null;
  let r;

  if (m === 'GET' && p === '/api/config') return CFG;

  if (p === '/api/cron/prune') {
    const secret = process.env.CRON_SECRET;
    need(!secret || req.headers.authorization === 'Bearer ' + secret, 401, 'unauthorized');
    return prune();
  }

  if (m === 'POST' && p === '/api/admin/login') {
    const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
    const n = await cmd('INCR', P + 'rl:' + ip);
    if (n === 1) await cmd('EXPIRE', P + 'rl:' + ip, 900);
    need(n <= 10, 429, 'יותר מדי ניסיונות, נסו מאוחר יותר');
    need(passOk(body.password), 401, 'סיסמה שגויה');
    const t = crypto.randomBytes(24).toString('hex');
    await cmd('SET', P + 'sess:' + t, '1', 'EX', SESSION_TTL);
    return { token: t };
  }

  const db = await loadDb(token);
  const admin = db.admin;
  if (m === 'GET' && p === '/api/state') return stateFor(db, cid);

  if (m === 'POST' && p === '/api/bookings') {
    need(cid, 400, 'מזהה מכשיר חסר');
    const b = { date: body.date, hour: body.hour };
    validSlot(b);
    const name = clean(body.name, 60), phone = clean(body.phone, 20);
    need(name.length >= 2, 400, 'נא להזין שם');
    need(digits(phone).length >= 9, 400, 'נא להזין טלפון תקין');
    need(!blockInfo(db, b.date, b.hour), 409, 'השעה הזו חסומה');
    const id = bkey(b.date, b.hour);
    need(!db.bookings[id], 409, 'השעה הזו כבר נתפסה');
    if (CFG.maxPerDay) need(Object.values(db.bookings).filter(x => x.cid === cid && x.date === b.date).length < CFG.maxPerDay, 409, 'הגעתם למכסת ההזמנות ליום');
    const rec = { id, date: b.date, hour: b.hour, name, phone, resident: !!body.resident, seeking: !!body.seeking, partner: '', cid, createdAt: Date.now() };
    // HSETNX is atomic: two people racing for the same slot can't both win.
    const won = await cmd('HSETNX', P + 'bookings', id, JSON.stringify(rec));
    need(won === 1, 409, 'השעה הזו כבר נתפסה');
    return { ok: true };
  }
  if ((r = p.match(/^\/api\/bookings\/([\w-]+)$/)) && m === 'DELETE') {
    const b = db.bookings[r[1]]; need(b, 404, 'ההזמנה לא נמצאה');
    need(admin || (cid && b.cid === cid), 403, 'אפשר לבטל רק הזמנה שלכם');
    const ops = [hdel('bookings', b.id)];
    for (const k in db.joins) if (db.joins[k].bid === b.id) ops.push(hdel('joins', k));
    await pipeline(ops); return { ok: true };
  }

  if (m === 'POST' && p === '/api/joins') {
    need(cid, 400, 'מזהה מכשיר חסר');
    const b = db.bookings[body.bid]; need(b, 404, 'ההזמנה לא נמצאה');
    need(b.seeking && !b.partner, 409, 'ההזמנה הזו לא מחפשת שותף');
    need(b.cid !== cid, 400, 'זו ההזמנה שלכם');
    const name = clean(body.name, 60), phone = clean(body.phone, 20);
    need(name.length >= 2 && digits(phone).length >= 9, 400, 'נא למלא שם וטלפון תקין');
    const id = b.id + '_' + cid;
    need(!db.joins[id] || db.joins[id].status === 'declined', 409, 'כבר שלחתם בקשה');
    await pipeline([hset('joins', id, { id, bid: b.id, name, phone, status: 'pending', cid, createdAt: Date.now() })]);
    return { ok: true };
  }
  if ((r = p.match(/^\/api\/joins\/([\w-]+)\/answer$/)) && m === 'POST') {
    const j = db.joins[r[1]]; need(j, 404, 'הבקשה לא נמצאה');
    const b = db.bookings[j.bid]; need(b, 404, 'ההזמנה לא נמצאה');
    need(admin || (cid && b.cid === cid), 403, 'אין הרשאה');
    const ops = [];
    if (body.approve) {
      need(!b.partner, 409, 'כבר אושר שותף');
      j.status = 'approved'; b.partner = j.name; b.seeking = false;
      ops.push(hset('bookings', b.id, b));
      for (const k in db.joins) {
        const o = db.joins[k];
        if (o.bid === b.id && k !== j.id && o.status === 'pending') { o.status = 'declined'; ops.push(hset('joins', k, o)); }
      }
    } else j.status = 'declined';
    ops.push(hset('joins', j.id, j));
    await pipeline(ops); return { ok: true };
  }

  if (m === 'POST' && p === '/api/wanted') {
    need(cid, 400, 'מזהה מכשיר חסר');
    const name = clean(body.name, 60), phone = clean(body.phone, 20), note = clean(body.note, 100);
    need(name.length >= 2 && digits(phone).length >= 9, 400, 'נא למלא שם וטלפון תקין');
    await pipeline([hset('wanted', cid, { id: cid, name, phone, note, createdAt: Date.now() })]);
    return { ok: true };
  }
  if ((r = p.match(/^\/api\/wanted\/([\w-]+)$/)) && m === 'DELETE') {
    need(admin || (cid && r[1] === cid), 403, 'אין הרשאה');
    await pipeline([hdel('wanted', r[1])]); return { ok: true };
  }

  // admin-only
  if (p.startsWith('/api/blocks') || p.startsWith('/api/recurring')) need(admin, 403, 'פעולה למנהל בלבד');
  if (m === 'POST' && p === '/api/blocks') {
    validSlot(body);
    await pipeline([hset('blocks', bkey(body.date, body.hour), { date: body.date, hour: body.hour, label: clean(body.label, 40) || 'חוג' })]);
    return { ok: true };
  }
  if (m === 'POST' && p === '/api/blocks/release') {
    validSlot(body);
    await pipeline([hset('blocks', bkey(body.date, body.hour), { date: body.date, hour: body.hour, released: true })]);
    return { ok: true };
  }
  if (m === 'POST' && p === '/api/recurring') {
    const day = body.day, from = body.from, to = body.to;
    need(Number.isInteger(day) && day >= 0 && day <= 6, 400, 'יום לא תקין');
    need(Number.isInteger(from) && Number.isInteger(to) && from >= CFG.open && to <= CFG.close && to > from, 400, 'שעות לא תקינות');
    await pipeline([hset('recurring', 'r' + Date.now(), { day, from, to, label: clean(body.label, 40) || 'חוג' })]);
    return { ok: true };
  }
  if ((r = p.match(/^\/api\/recurring\/([\w-]+)$/)) && m === 'DELETE') {
    await pipeline([hdel('recurring', r[1])]); return { ok: true };
  }
  throw new HttpErr(404, 'לא נמצא');
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
module.exports._test = { dayStr, nowHour, blockInfo };
