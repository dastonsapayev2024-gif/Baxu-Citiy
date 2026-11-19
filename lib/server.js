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
const KNOWN = ['config', 'players', 'b', 'reqs', 'cq', 'trades', 'chat', 'inbox', 'likes', 'approvals', 'orders', 'ledger', 'audit', 'aid', 'bz', 'act'];
const ADMIN_ONLY = ['config', 'approvals', 'ledger', 'audit', 'act'];
const COIN_GIFT_MAX = 100;
// Hokim: kuniga 10 kishiga 4000 coin (Toshkent kuni, UTC+5)
const MAYOR_GIVE = 4000, MAYOR_DAILY = 10;
// Bino buzish: 1 qavat = 20000 coin, bitta bino kuniga ko'pi bilan 2 qavat (hamma buzuvchilar bo'yicha), bir o'yinchi kuniga jami 2 qavat
const BZ_COST = 20000, BZ_PER_B = 2, BZ_DAILY = 2;
const hday = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);

function visible(col, d, a) {
  if (a.admin) return true;
  if (ADMIN_ONLY.includes(col)) return col === 'config' || col === 'approvals';
  if (col === 'inbox') return d.to === a.uid;
  if (col === 'orders' || col === 'cq') return d.uid === a.uid;
  if (col === 'reqs') return d.from === a.uid || d.to === a.uid;
  return true;
}
function canRead(col, a) { return a.admin || !['ledger', 'audit', 'act'].includes(col); }

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
        if (!old) return !nd.prem && !nd.shp && typeof nd.coins === 'number' && nd.coins <= 300 && !nd.blocked && !nd.purged && (nd.gf === undefined || nd.gf === 1);
        // O'yinchi o'zini bloklay/blokdan chiqara olmaydi
        if (!!nd.blocked !== !!old.blocked || !!nd.purged !== !!old.purged) return false;
        // Yangi o'yinchi sovg'asi bayrog'i faqat 1 -> 2 ga o'zgarishi mumkin
        if (nd.gf !== old.gf && !(old.gf === 1 && nd.gf === 2)) return false;
        // Do'kon (2-fasl): faqat admin beradi; o'yinchi faqat to'ldirish / daromad olish / darajani ko'tarish / pulga sotish so'rovi
        if (JSON.stringify(nd.shp) !== JSON.stringify(old.shp)) {
          const v = nd.shp, o = old.shp;
          if (!o || !v || typeof v !== 'object' || typeof nd.coins !== 'number') return false;
          const IN = [500, 1100, 2400], CO = [300, 600, 1200], CAP = [25000, 40000, 65000], MINW = 10000;
          const nz = (x) => Math.max(0, +x || 0), L = (x) => Math.min(3, Math.max(1, +x || 1));
          const ol = L(o.lv), vl = L(v.lv), oc = old.coins || 0, jw = (x) => JSON.stringify(x || []);
          const up = vl !== ol, rs = (v.d || '') !== (o.d || ''), cl = (v.c || 0) !== (o.c || 0), wd = nz(v.b) !== nz(o.b) && !cl;
          if ([up, rs, cl, wd].filter(Boolean).length !== 1) return false;
          const same = (...k) => k.every((x) => JSON.stringify(v[x] === undefined ? (x === 'w' ? [] : 0) : v[x]) === JSON.stringify(o[x] === undefined ? (x === 'w' ? [] : 0) : o[x]));
          if (up) {
            return false; // darajani faqat admin beradi (pul bilan sotib olinadi)
          } else if (rs) {
            if (v.d !== hday() || v.c || typeof v.t !== 'number' || Math.abs(v.t - Date.now()) > 10000 || nd.coins > oc - CO[ol - 1]) return false;
            if (!same('b', 'e', 'w') || vl !== ol) return false;
          } else if (cl) {
            const g = nz(v.b) - nz(o.b);
            if (v.c !== 1 || o.c || o.d !== hday() || v.t !== o.t || Date.now() - (o.t || 0) < 4 * 3600e3 - 5000) return false;
            if (!(g > 0 && g <= IN[ol - 1] && nz(v.e) - nz(o.e) === g && nz(o.e) + g <= CAP[ol - 1]) || nd.coins > oc) return false;
            if (!same('w') || vl !== ol || (v.d || '') !== (o.d || '')) return false;
          } else if (jw(v.w) === jw(o.w)) {
            // Binoga sarflash: faqat hisob kamayadi, boshqa hech narsa o'zgarmaydi, coin oshmaydi
            if (!(nz(v.b) < nz(o.b)) || nd.coins > oc || vl !== ol || !same('e', 'w', 'c', 't') || (v.d || '') !== (o.d || '')) return false;
          } else {
            const w = Array.isArray(v.w) ? v.w : [], last = w[w.length - 1];
            if (nz(v.b) !== 0 || nz(o.b) < MINW || nd.coins > oc || vl !== ol || (v.d || '') !== (o.d || '') || (v.c || 0) !== (o.c || 0) || (v.t || 0) !== (o.t || 0)) return false;
            if (!same('e') || w.length < 1 || w.length > 10 || !last || typeof last.id !== 'string' || !/^WD-[A-Z0-9]{3,20}$/.test(last.id) || last.a !== nz(o.b)) return false;
            const prev = Array.isArray(o.w) ? o.w : [];
            if (!w.slice(0, -1).every((x) => prev.some((y) => y && y.id === x.id && y.a === x.a)) || prev.some((y) => y && y.id === last.id)) return false;
          }
        }
        // Premium faqat admin tomonidan beriladi
        if ((nd.prem || 0) !== (old.prem || 0)) return false;
        // Bezaklar (nik rangi/belgi): faqat ro'yxatdagilar, yangi sotib olinganlar narxiga coin kamayishi shart, olingan bezaklar yo'qolmaydi
        if (JSON.stringify(nd.cos) !== JSON.stringify(old.cos)) {
          const COS = { c1: 10000, c2: 10000, c3: 10000, c4: 15000, c5: 15000, b1: 5000, b2: 5000, b3: 10000, b4: 25000, b5: 50000 };
          const COSV = { c1: '#ff5a5f', c2: '#3ddc84', c3: '#4dabf7', c4: '#ffd23f', c5: '#b388ff', b1: '🔥', b2: '⭐', b3: '🚀', b4: '👑', b5: '💎' };
          const v = nd.cos;
          if (!v || typeof v !== 'object' || !Array.isArray(v.o) || v.o.length > 12) return false;
          const oo = old.cos && Array.isArray(old.cos.o) ? old.cos.o : [];
          if (!v.o.every((x) => typeof x === 'string' && COS[x] !== undefined) || new Set(v.o).size !== v.o.length) return false;
          if (!oo.every((x) => v.o.includes(x))) return false;
          const cost = v.o.filter((x) => !oo.includes(x)).reduce((a, x) => a + COS[x], 0);
          if (cost > 0 && !(typeof nd.coins === 'number' && nd.coins <= (old.coins || 0) - cost)) return false;
          const okEq = (val, pre) => val === undefined || val === '' || (typeof val === 'string' && Object.keys(COSV).some((k) => k[0] === pre && COSV[k] === val && v.o.includes(k)));
          if (!okEq(v.c, 'c') || !okEq(v.b, 'b')) return false;
        }
        // Reklama topshirig'i: kuniga ko'pi bilan 20 ta, bir yozuvda +1, har bir ko'rish orasida kamida 10 soniya, mukofot (paid) kuniga bir marta
        if (JSON.stringify(nd.adv) !== JSON.stringify(old.adv)) {
          const v = nd.adv;
          if (!v || typeof v !== 'object' || typeof v.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.d)) return false;
          if (!Number.isInteger(v.n) || v.n < 0 || v.n > 20 || typeof v.ts !== 'number' || v.ts > Date.now() + 5000) return false;
          const same = !!(old.adv && old.adv.d === v.d), base = same ? (old.adv.n || 0) : 0;
          if (v.n > base + 1 || (same && v.n < base)) return false;
          if (v.n > base && v.ts - (same ? (old.adv.ts || 0) : 0) < 10000) return false;
          if (same && old.adv.paid && !v.paid) return false;
          if (v.paid && !(same && old.adv.paid) && v.n < 1) return false;
        }
        // Haftalik turnir: bir yozuvda ko'pi bilan +10 qavat (1/5/10 qavat sotib olish), o'tgan hafta nusxasi faqat eski hisoblagichdan
        {
          const W = Math.floor((Date.now() + 5 * 3600e3 + 3 * 864e5) / (7 * 864e5));
          if (JSON.stringify(nd.wk) !== JSON.stringify(old.wk)) {
            if (!nd.wk || nd.wk.w !== W) return false;
            const base = old.wk && old.wk.w === W ? (old.wk.f || 0) : 0;
            if (!(nd.wk.f >= base && nd.wk.f <= base + 10)) return false;
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
      return !del && !old && nd.uid === uid && (nd.pm === undefined || (Number.isInteger(nd.pm) && nd.pm >= 1 && nd.pm <= 3)) && (nd.sp === undefined || nd.sp === 1) && (nd.up === undefined || nd.up === 2 || nd.up === 3) && (nd.wd === undefined || (Number.isInteger(nd.wd) && nd.wd >= 10000 && nd.wd <= 1000000 && nd.price === nd.wd));
    case 'aid':
      // So'rovni faqat o'yinchining o'zi yaratadi (kuniga 1 ta). Tasdiqlash/rad etish db.js da hokim tekshiruvi bilan.
      return !del && !old && nd.uid === uid && nd.st === 'p' && nd.day === hday() && id === nd.day + '_' + uid &&
        Object.keys(nd).every(k => ['uid', 'name', 'day', 'ts', 'st'].includes(k)) && typeof nd.name === 'string' && nd.name.length <= 40;
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
  // Yangi o'yinchi sovg'asi (gf 1 -> 2) bir marta, 250 000 coin gacha (40 qavatga yetadigan miqdor)
  const gift = old && old.gf === 1 && nd.gf === 2;
  if (c - o > (gift ? 250000 : CHEAT_MAX_GAIN)) return 'bir yozuvda ' + (c - o) + ' coin qo‘shildi';
  return null;
}

module.exports = { pg, ensure, verifyInitData, auth, allowed, visible, canRead, cheat, hday, BZ_COST, BZ_PER_B, BZ_DAILY, MAYOR_GIVE, MAYOR_DAILY, KNOWN, ADMIN_ONLY };
