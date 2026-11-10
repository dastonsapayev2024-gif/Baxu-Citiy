'use strict';
const crypto = require('crypto');
const { Pool } = require('pg');

// ---- Ma'lumotlar bazasi ----
let pool, ready;
function pg() {
  if (!pool) {
    const cs = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!cs) throw new Error('DATABASE_URL sozlanmagan');
    pool = new Pool({ connectionString: cs, max: 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000, ssl: { rejectUnauthorized: false } });
    // Neon bo'sh ulanishni yopib qo'ysa, 'error' hodisasi tutilmasa funksiya qulaydi
    pool.on('error', e => { console.error('pg idle error', e && e.message); });
  }
  return pool;
}
function ensure() {
  if (!ready) {
    // Har sovuq startda jadval yaratishga urinmaymiz (bir vaqtda ko'p odam kirganda bloklanib qoladi)
    ready = pg().query('select 1 from docs limit 1').catch(e => {
      if (e && e.code === '42P01') {
        return pg().query(
          'create table if not exists docs(col text not null,id text not null,data jsonb not null,updated bigint not null,primary key(col,id))'
        ).then(() => pg().query('create index if not exists docs_col_upd on docs(col,updated)'));
      }
      throw e;
    }).catch(e => { ready = null; throw e; });
  }
  return ready;
}

// ---- Telegram initData tekshiruvi (server tomonida) ----
function verifyInitData(initData, token, maxAgeSec) {
  if (!initData || !token) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  const a = Buffer.from(calc, 'hex'), b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const ad = +p.get('auth_date');
  if (!ad || Date.now() / 1000 - ad > (maxAgeSec || 86400)) return null;
  let user;
  try { user = JSON.parse(p.get('user') || ''); } catch (e) { return null; }
  if (!user || !user.id) return null;
  return user;
}

function auth(req) {
  const env = process.env;
  const init = req.headers['x-tg-init'];
  const u = verifyInitData(init, String(env.BOT_TOKEN || '').replace(/\s+/g, ''), 86400);
  if (u) {
    const id = String(u.id);
    return { uid: 'tg' + id, admin: !!env.ADMIN_TG_ID && id === String(env.ADMIN_TG_ID).trim(), name: u.first_name || '' };
  }
  // Faqat sinov uchun: DEV_MODE=1 bo'lsa. Ishlab chiqarishda O'CHIRIB QO'YING.
  if (env.DEV_MODE === '1' && req.headers['x-dev-user']) {
    const n = String(req.headers['x-dev-user']).replace(/[^A-Za-z0-9_]/g, '').slice(0, 20);
    if (n) return { uid: 'dev' + n, admin: false, name: n };
  }
  return null;
}

// ---- Ruxsat qoidalari ----
const KNOWN = ['config', 'players', 'b', 'reqs', 'cq', 'trades', 'chat', 'inbox', 'likes', 'approvals', 'orders', 'ledger', 'audit'];
const ADMIN_ONLY = ['config', 'approvals', 'ledger', 'audit'];
const COIN_GIFT_MAX = 100;

function visible(col, d, a) {
  if (a.admin) return true;
  if (ADMIN_ONLY.includes(col)) return col === 'config' || col === 'approvals';
  if (col === 'inbox') return d.to === a.uid;
  if (col === 'orders' || col === 'cq') return d.uid === a.uid;
  if (col === 'reqs') return d.from === a.uid || d.to === a.uid;
  return true;
}
function canRead(col, a) { return a.admin || !['ledger', 'audit'].includes(col); }

function allowed(col, op, a, id, old, patch, nd) {
  if (a.admin) return true;
  if (!KNOWN.includes(col) || ADMIN_ONLY.includes(col)) return false;
  const uid = a.uid;
  const del = op === 'delete';
  switch (col) {
    case 'players': {
      if (del) return false;
      if (id === uid) {
        if (nd && nd.adm) return false;
        if (!old) return typeof nd.coins === 'number' && nd.coins <= 300 && !nd.blocked && !nd.purged && (nd.gf === undefined || nd.gf === 1);
        // O'yinchi o'zini bloklay/blokdan chiqara olmaydi
        if (!!nd.blocked !== !!old.blocked || !!nd.purged !== !!old.purged) return false;
        // Yangi o'yinchi sovg'asi bayrog'i faqat 1 -> 2 ga o'zgarishi mumkin
        if (nd.gf !== old.gf && !(old.gf === 1 && nd.gf === 2)) return false;
        // Haftalik turnir: bir yozuvda faqat +1 qavat, o'tgan hafta nusxasi faqat eski hisoblagichdan
        {
          const W = Math.floor((Date.now() + 5 * 3600e3 + 3 * 864e5) / (7 * 864e5));
          if (JSON.stringify(nd.wk) !== JSON.stringify(old.wk)) {
            if (!nd.wk || nd.wk.w !== W) return false;
            const base = old.wk && old.wk.w === W ? (old.wk.f || 0) : 0;
            if (!(nd.wk.f >= base && nd.wk.f <= base + 1)) return false;
          }
          if (JSON.stringify(nd.wp) !== JSON.stringify(old.wp)) {
            if (!(old.wk && nd.wp && old.wk.w < W && nd.wp.w === old.wk.w && nd.wp.f === old.wk.f)) return false;
          }
          // Sovrin: har hafta bir marta, 7000 coindan oshmaydi
          if (nd.pz !== old.pz) {
            if (nd.pz !== W - 1 || old.pz === W - 1) return false;
            if ((nd.coins || 0) - (old.coins || 0) > 7000) return false;
          }
        }
        return true;
      }
      // Boshqa o'yinchiga faqat kichik coin sovg'asi
      if (op !== 'update' || !old) return false;
      const ks = Object.keys(patch || {});
      if (!ks.includes('coins') || !ks.every(k => k === 'coins' || k === 'hr')) return false;
      if (ks.includes('hr') && !(patch.hr && typeof patch.hr.d === 'string' && typeof patch.hr.n === 'number' && patch.hr.n >= 1 && patch.hr.n <= 10)) return false;
      const dlt = patch.coins - (old.coins || 0);
      return typeof patch.coins === 'number' && dlt >= 0 && dlt <= COIN_GIFT_MAX;
    }
    case 'b': {
      if (del) return false;
      if (!old) return id === uid && nd.owner === uid && !nd.ctr;
      if (old.owner !== uid) return false;
      if (nd.ctr && !old.ctr) return false;
      return true;
    }
    case 'reqs':
      if (del) return !!old && (old.from === uid || old.to === uid);
      return nd.from === uid && (!old || old.from === uid);
    case 'cq':
      return !del && !old && nd.uid === uid;
    case 'trades':
      return !del && !old && nd.from === uid;
    case 'chat':
      return !del && !old && nd.uid === uid && typeof nd.text === 'string' && nd.text.length <= 200;
    case 'inbox':
      if (!old) return !del && nd.from === uid && typeof nd.to === 'string';
      return old.to === uid;
    case 'likes':
      if (del) return !!old && old.uid === uid;
      return nd.uid === uid && (!old || old.uid === uid);
    case 'orders':
      return !del && !old && nd.uid === uid;
  }
  return false;
}

// Coin bilan firibgarlikni aniqlash (o'yinchining o'z hujjatiga yozishda). Sababni qaytaradi yoki null.
const CHEAT_MAX_GAIN = 25000, CHEAT_MAX_COINS = 500000;
function cheat(old, nd) {
  if (!nd || nd.coins === undefined) return null;
  const c = nd.coins;
  if (typeof c !== 'number' || !isFinite(c)) return 'coin qiymati noto‘g‘ri';
  const o = old && typeof old.coins === 'number' ? old.coins : 0;
  if (c < 0 && o >= 0) return 'manfiy coin (' + c + ')';
  if (c > CHEAT_MAX_COINS) return 'juda katta coin (' + c + ')';
  if (c - o > CHEAT_MAX_GAIN) return 'bir yozuvda ' + (c - o) + ' coin qo‘shildi';
  return null;
}

module.exports = { pg, ensure, verifyInitData, auth, allowed, visible, canRead, cheat, KNOWN, ADMIN_ONLY };
