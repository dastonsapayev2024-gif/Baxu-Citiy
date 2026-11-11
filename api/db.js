'use strict';
const crypto = require('crypto');
const L = require('../lib/server');

const bad = (res, code, msg) => res.status(code).json({ error: msg });
// ---- Telegram bildirishnoma (inbox -> botdan xabar) ----
const ICON = { like: '❤️', coin: '🪙', buy: '🛒', deal: '🎉', no: '❌', bz: '💥' };
const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function pushTg(pool, nd) {
  try {
    const token = String(process.env.BOT_TOKEN || '').replace(/\s+/g, '');
    if (!token || !nd || typeof nd.to !== 'string' || !/^tg\d{1,15}$/.test(nd.to) || nd.to === nd.from) return;
    if (nd.type === 'like' || nd.type === 'coin') {
      const r = await pool.query("select count(*)::int n from docs where col='inbox' and data->>'to'=$1 and data->>'from'=$2 and data->>'type'=$3 and updated>$4", [nd.to, String(nd.from), nd.type, Date.now() - 30 * 60 * 1000]);
      if (r.rows[0].n > 1) return;
    }
    const nick = /^[A-Za-z0-9_]{3,32}$/.test(String(nd.fromTg || '').replace('@', '')) ? String(nd.fromTg).replace('@', '') : '';
    const text = (ICON[nd.type] || '🔔') + ' <b>' + esc(String(nd.fromName || 'O‘yinchi').slice(0, 40)) + '</b>\n' + esc(String(nd.text || '').slice(0, 300));
    const row = [];
    const app = String(process.env.APP_LINK || '').replace(/\?startapp=.*$/, '');
    if (nick) row.push({ text: '💬 @' + nick + ' bilan gaplashish', url: 'https://t.me/' + nick });
    if (app) row.push({ text: '🎮 O‘yinni ochish', url: app });
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 2500);
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal,
      body: JSON.stringify({ chat_id: nd.to.slice(2), text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: row.length ? { inline_keyboard: row.map(b => [b]) } : undefined })
    }).catch(() => {});
    clearTimeout(tm);
  } catch (e) { /* bildirishnoma xato bersa, o'yin ishlashiga xalaqit bermaydi */ }
}


// ---- Bir vaqtdagi ko'p so'rovni bitta so'rovga birlashtirish (12+ odam birdan kirganda) ----
const AGG = new Map();
function aggregate(pool, cols) {
  const key = cols.join(',');
  const e = AGG.get(key);
  if (e && Date.now() - e.t < 800) return e.p;
  const p = pool.query('select col,max(updated)::text v,count(*)::int n from docs where col=any($1) group by col', [cols]).then(r => r.rows);
  const ne = { t: Date.now(), p };
  AGG.set(key, ne);
  p.catch(() => { if (AGG.get(key) === ne) AGG.delete(key); });
  return p;
}
const FULL = new Map();
function fullRows(pool, c, k) {
  const key = k.v + '|' + k.n;
  const e = FULL.get(c);
  if (e && e.key === key) return e.p;
  const p = pool.query('select id,data from docs where col=$1 order by updated desc limit 1500', [c]).then(r => r.rows);
  const ne = { key, p };
  FULL.set(c, ne);
  p.catch(() => { if (FULL.get(c) === ne) FULL.delete(c); });
  return p;
}

// ---- Bloklangan o'yinchilar va firibgarlikni avtomatik bloklash ----
const BL = new Map();
async function isBlocked(pool, uid) {
  const e = BL.get(uid);
  if (e && Date.now() - e.t < 5000) return e.b;
  const r = await pool.query("select data->>'blocked' b from docs where col='players' and id=$1", [uid]);
  const b = !!(r.rows[0] && r.rows[0].b === 'true');
  BL.set(uid, { t: Date.now(), b });
  return b;
}
async function tgAdmin(text) {
  try {
    const token = String(process.env.BOT_TOKEN || '').replace(/\s+/g, ''), to = String(process.env.ADMIN_TG_ID || '').trim();
    if (!token || !/^\d{1,15}$/.test(to)) return;
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 2500);
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal,
      body: JSON.stringify({ chat_id: to, text: String(text).slice(0, 500), disable_web_page_preview: true })
    }).catch(() => {});
    clearTimeout(tm);
  } catch (e) { /* ahamiyatsiz */ }
}
async function autoBlock(pool, uid, name, why) {
  try {
    const now = Date.now();
    await pool.query("update docs set data = data || $1::jsonb, updated=$2 where col='players' and id=$3",
      [JSON.stringify({ blocked: true, bwhy: 'auto: ' + why }), now, uid]);
    await pool.query("insert into docs(col,id,data,updated) values('audit',$1,$2,$3)",
      [crypto.randomBytes(10).toString('hex'), JSON.stringify({ ts: now, text: 'AVTO-BLOK: ' + (name || uid) + ' — ' + why, by: 'server' }), now]);
    BL.set(uid, { t: now, b: true });
    AGG.clear();
    await tgAdmin('🚫 Avto-blok: ' + (name || uid) + '\n' + why);
  } catch (e) { console.error('avto-blok xatosi', e && e.message); }
}

// ---- Chatni avtomatik tozalash: 1 soatdan eski xabarlar bazadan o'chadi (daqiqada ko'pi bilan 1 marta tekshiriladi) ----
const CHAT_TTL = 60 * 60 * 1000;
let lastClean = 0;
async function cleanChat(pool) {
  if (Date.now() - lastClean < 60000) return;
  lastClean = Date.now();
  try {
    const r = await pool.query("delete from docs where col='chat' and updated<$1", [Date.now() - CHAT_TTL]);
    if (r.rowCount) AGG.clear();
  } catch (e) { console.error('chat tozalash xatosi', e && e.message); }
}

// ---- Eski xabarlar (5 soat) va 10 kun kirmagan o'yinchilarning binolari (10 daqiqada 1 marta) ----
const INBOX_TTL = 5 * 60 * 60 * 1000, IDLE_TTL = 10 * 24 * 60 * 60 * 1000;
let lastOld = 0;
async function cleanOld(pool) {
  if (Date.now() - lastOld < 600000) return;
  lastOld = Date.now();
  try {
    let ch = 0;
    const r = await pool.query("delete from docs where col='inbox' and updated<$1", [Date.now() - INBOX_TTL]);
    if (r.rowCount) ch = 1;
    const ra = await pool.query("delete from docs where col='aid' and updated<$1", [Date.now() - 3 * 864e5]);
    if (ra.rowCount) ch = 1;
    const rz = await pool.query("delete from docs where col='bz' and updated<$1", [Date.now() - 3 * 864e5]);
    if (rz.rowCount) ch = 1;
    const q = await pool.query("select b.id, b.data bd from docs b join docs p on p.col='players' and p.id=b.data->>'owner' where b.col='b' and b.id=b.data->>'owner' and coalesce((b.data->>'ctr')::boolean,false)=false and coalesce((p.data->>'adm')::boolean,false)=false and coalesce((p.data->>'blocked')::boolean,false)=false and greatest(coalesce((p.data->>'seen')::bigint,0), p.updated) < $1 limit 50", [Date.now() - IDLE_TTL]);
    for (const row of q.rows) {
      // bino nusxasi o'yinchi hujjatiga saqlanadi: qaytib kirsa tiklanadi
      await pool.query("update docs set data=jsonb_set(data,'{ab}',$2::jsonb,true), updated=$3 where col='players' and id=$1", [row.id, JSON.stringify(row.bd), Date.now()]);
      await pool.query("delete from docs where col='b' and id=$1", [row.id]);
      ch = 1;
    }
    if (ch) AGG.clear();
  } catch (e) { console.error('eski ma\'lumotlarni tozalash xatosi', e && e.message); }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return bad(res, 405, 'POST kerak');
  const a = L.auth(req);
  if (!a) {
    const why = !req.headers['x-tg-init'] ? 'initData yo‘q (Telegram ma’lumot yubormadi)' : !process.env.BOT_TOKEN ? 'BOT_TOKEN sozlanmagan' : 'imzo mos emas (token boshqa bot tokeni)';
    return bad(res, 401, 'Telegram orqali kiring: ' + why);
  }
  let b = req.body;
  try { if (typeof b === 'string') b = JSON.parse(b); } catch (e) { return bad(res, 400, 'Noto‘g‘ri so‘rov'); }
  b = b || {};
  try {
    await L.ensure();
    const pool = L.pg();

    if (b.op === 'me') {
      return res.json({ now: Date.now(), uid: a.uid, admin: a.admin, appLink: process.env.APP_LINK || '' });
    }

    if (b.op === 'sync') {
      const vs = b.v || {};
      const cols = L.KNOWN.filter(c => L.canRead(c, a));
      await cleanChat(pool);
      await cleanOld(pool);
      const rws = await aggregate(pool, cols);
      const cur = {};
      rws.forEach(x => { cur[x.col] = { v: Number(x.v), n: x.n }; });
      const out = {};
      // Faqat o'zgargan bo'limlar; ommaviy bo'limlarda faqat o'zgargan hujjatlar (delta)
      const DELTA = ['players', 'b', 'likes', 'chat', 'trades', 'config', 'approvals', 'aid', 'bz'];
      const RESTR = { inbox: "data->>'to'=$2", orders: "data->>'uid'=$2", cq: "data->>'uid'=$2", reqs: "(data->>'from'=$2 or data->>'to'=$2)" };
      for (const c of cols) {
        const k = cur[c] || { v: 0, n: 0 };
        const o = vs[c];
        if (o && o.v === k.v && o.n === k.n) continue;
        const slim = x => (c === 'orders' || c === 'reqs') && x.data && x.data.rc ? Object.assign({}, x.data, { rc: 1 }) : x.data;
        let rows, delta = false;
        if (!a.admin && RESTR[c]) {
          rows = (await pool.query('select id,data from docs where col=$1 and ' + RESTR[c] + ' order by updated desc limit 1500', [c, a.uid])).rows;
        } else {
          if (o && typeof o.v === 'number' && o.v > 0 && o.v <= k.v && DELTA.includes(c)) {
            rows = (await pool.query('select id,data from docs where col=$1 and updated>=$2 order by updated desc limit 1500', [c, o.v - 5000])).rows;
            delta = rows.length < 1500;
          }
          if (!delta) rows = await fullRows(pool, c, k);
        }
        out[c] = { v: k.v, n: k.n, delta, docs: rows.filter(x => L.visible(c, x.data, a)).map(x => ({ id: x.id, data: slim(x) })) };
      }
      return res.json({ now: Date.now(), cols: out });
    }

    const col = String(b.col || '');
    if (!L.KNOWN.includes(col)) return bad(res, 400, 'Noma’lum bo‘lim');

    if (b.op === 'get') {
      if (!L.canRead(col, a)) return bad(res, 403, 'Ruxsat yo‘q');
      const r = await pool.query('select data from docs where col=$1 and id=$2', [col, String(b.id || '')]);
      const d = r.rows[0] && r.rows[0].data;
      if (!d || !L.visible(col, d, a)) return res.json({ exists: false });
      return res.json({ exists: true, data: d });
    }

    if (['set', 'update', 'delete', 'add'].includes(b.op)) {
      const id = b.op === 'add' ? crypto.randomBytes(10).toString('hex') : String(b.id || '');
      if (!id || id.length > 128) return bad(res, 400, 'ID noto‘g‘ri');
      const patch = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : null;
      if (b.op !== 'delete' && !patch) return bad(res, 400, 'Ma’lumot noto‘g‘ri');
      if (!a.admin && await isBlocked(pool, a.uid)) return bad(res, 403, 'Siz bloklangansiz');
      const cl = await pool.connect();
      let pushNd = null;
      try {
        await cl.query('begin');
        const cur = await cl.query('select data from docs where col=$1 and id=$2 for update', [col, id]);
        const old = cur.rows[0] ? cur.rows[0].data : null;
        let nd = null;
        if (b.op === 'update') { if (!old) { await cl.query('rollback'); return bad(res, 404, 'Topilmadi'); } nd = Object.assign({}, old, patch); }
        else if (b.op !== 'delete') nd = patch;
        if (nd && JSON.stringify(nd).length > (col === 'orders' || col === 'reqs' ? 150000 : 30000)) { await cl.query('rollback'); return bad(res, 413, 'Juda katta'); }
        // Hokim so'rovni tasdiqlaydi/rad etadi: faqat faol hokim, kuniga 10 ta, TOP-5 dan pastdagilarga 4000 coin (server tekshiradi)
        let mayorOk = false;
        if (col === 'aid' && !a.admin && old && b.op === 'update') {
          const bye = async m => { await cl.query('rollback'); return bad(res, 403, m); };
          const day = L.hday();
          const keys = Object.keys(patch || {});
          if (keys.length !== 1 || keys[0] !== 'st' || (patch.st !== 'ok' && patch.st !== 'no') || old.st !== 'p') return bye('Ruxsat yo‘q');
          const cf = await cl.query("select data from docs where col='config' and id='main'");
          const mc = cf.rows[0] && cf.rows[0].data && cf.rows[0].data.mayor;
          if (!mc || mc.st !== 'active' || mc.id !== a.uid) return bye('Faqat hokim tasdiqlay oladi');
          if (old.day !== day) return bye('So‘rov eskirgan');
          if (patch.st === 'ok') {
            const rid = old.uid;
            if (rid === a.uid) return bye('O‘zingizga bera olmaysiz');
            const rp = await cl.query("select data from docs where col='players' and id=$1 for update", [rid]);
            const pd = rp.rows[0] && rp.rows[0].data;
            if (!pd || pd.blocked || pd.adm) return bye('O‘yinchiga berib bo‘lmaydi');
            const t5 = await cl.query("select id from docs where col='players' and coalesce(data->>'adm','false')<>'true' and coalesce(data->>'blocked','false')<>'true' order by coalesce((data->>'coins')::numeric,0) desc, id limit 5");
            if (t5.rows.some(r => r.id === rid)) return bye('Coin bo‘yicha TOP-5 dagilarga berib bo‘lmaydi');
            const cnt = await cl.query("select count(*)::int n from docs where col='aid' and data->>'day'=$1 and data->>'st'='ok' and data->>'by'=$2", [day, a.uid]);
            if (cnt.rows[0].n >= L.MAYOR_DAILY) return bye('Bugungi limit (10 ta) tugagan');
            const now2 = Date.now(), after = (typeof pd.coins === 'number' ? pd.coins : 0) + L.MAYOR_GIVE;
            await cl.query("update docs set data=$1, updated=$2 where col='players' and id=$3", [JSON.stringify(Object.assign({}, pd, { coins: after })), now2, rid]);
            await cl.query("insert into docs(col,id,data,updated) values('ledger',$1,$2,$3)", [crypto.randomBytes(10).toString('hex'), JSON.stringify({ ts: now2, type: 'mayor', uid: rid, name: pd.name || '?', delta: L.MAYOR_GIVE, after, ref: 'hokim:' + a.uid, by: 'server' }), now2]);
            await cl.query("insert into docs(col,id,data,updated) values('inbox',$1,$2,$3)", [crypto.randomBytes(10).toString('hex'), JSON.stringify({ to: rid, from: a.uid, fromName: 'Hokim', fromTg: '', type: 'coin', text: '👑 Hokim sizga ' + L.MAYOR_GIVE + ' coin berdi', coins: L.MAYOR_GIVE, ts: now2, read: false }), now2]);
            nd.by = a.uid; nd.ts2 = now2;
          }
          mayorOk = true;
        }
        // Bino buzish: 1000 coin evaziga boshqa o'yinchi binosidan 1 qavat (server hammasini tekshiradi)
        let bzOk = false;
        if (col === 'bz' && !a.admin) {
          const bye = async m => { await cl.query('rollback'); return bad(res, 403, m); };
          if (b.op !== 'add' || typeof patch.b !== 'string' || patch.b.length > 128) return bye('Ruxsat yo‘q');
          const bid = patch.b, day = L.hday();
          const rb = await cl.query("select data from docs where col='b' and id=$1 for update", [bid]);
          const bd = rb.rows[0] && rb.rows[0].data;
          if (!bd) return bye('Bino topilmadi');
          const victim = bd.owner;
          if (!victim || victim === a.uid) return bye('O‘z binongizni buzib bo‘lmaydi');
          if (bd.ctr) return bye('Bu binoni buzib bo‘lmaydi');
          if ((bd.floors || 0) <= 1) return bye('Bino 1 qavatgacha qolgan, buzib bo‘lmaydi');
          const vp = await cl.query("select data from docs where col='players' and id=$1", [victim]);
          if (!vp.rows[0] || vp.rows[0].data.adm) return bye('Bu binoni buzib bo‘lmaydi');
          const c1 = await cl.query("select count(*)::int n from docs where col='bz' and data->>'b'=$1 and data->>'day'=$2", [bid, day]);
          if (c1.rows[0].n >= L.BZ_PER_B) return bye('Bu bino bugun ' + L.BZ_PER_B + ' marta buzilgan, ertaga yana');
          const c2 = await cl.query("select count(*)::int n from docs where col='bz' and data->>'by'=$1 and data->>'day'=$2", [a.uid, day]);
          if (c2.rows[0].n >= L.BZ_DAILY) return bye('Bugungi limit (' + L.BZ_DAILY + ' qavat) tugagan');
          const ap = await cl.query("select data from docs where col='players' and id=$1 for update", [a.uid]);
          const pd = ap.rows[0] && ap.rows[0].data;
          if (!pd || pd.blocked) return bye('Ruxsat yo‘q');
          if ((pd.coins || 0) < L.BZ_COST) return bye('Coin yetarli emas: kerak ' + L.BZ_COST);
          const now2 = Date.now(), nf = (bd.floors || 0) - 1, after = pd.coins - L.BZ_COST;
          await cl.query("update docs set data=$1, updated=$2 where col='b' and id=$3", [JSON.stringify(Object.assign({}, bd, { floors: nf })), now2, bid]);
          await cl.query("update docs set data=$1, updated=$2 where col='players' and id=$3", [JSON.stringify(Object.assign({}, pd, { coins: after })), now2, a.uid]);
          await cl.query("insert into docs(col,id,data,updated) values('ledger',$1,$2,$3)", [crypto.randomBytes(10).toString('hex'), JSON.stringify({ ts: now2, type: 'bz', uid: a.uid, name: pd.name || '?', delta: -L.BZ_COST, after, ref: 'buzish:' + bid, by: 'server' }), now2]);
          const msg = (pd.name || 'O‘yinchi') + ' binongizning 1 qavatini buzdi (endi ' + nf + ' qavat)';
          const ib = { to: victim, from: a.uid, fromName: pd.name || 'O‘yinchi', fromTg: pd.tg || '', type: 'bz', text: msg, coins: 0, ts: now2, read: false };
          await cl.query("insert into docs(col,id,data,updated) values('inbox',$1,$2,$3)", [crypto.randomBytes(10).toString('hex'), JSON.stringify(ib), now2]);
          nd = { b: bid, t: victim, by: a.uid, day, ts: now2, f: nf };
          pushNd = ib; bzOk = true;
        }
        if (!mayorOk && !bzOk && !L.allowed(col, b.op, a, id, old, patch, nd)) { await cl.query('rollback'); return bad(res, 403, 'Ruxsat yo‘q'); }
        if (!a.admin && col === 'players' && id === a.uid && b.op !== 'delete' && old && patch && patch.coins !== undefined) {
          const why = L.cheat(old, nd);
          if (why) {
            await cl.query('rollback');
            await autoBlock(pool, a.uid, old.name, why);
            return bad(res, 403, 'Qoidabuzarlik aniqlandi: hisobingiz bloklandi');
          }
        }
        if (!a.admin && col === 'players' && id === a.uid && old && nd && b.op !== 'delete') {
          // Vaqt maydonlari faqat oldinga va server vaqtidan oshmasligi kerak (soatni o'zgartirib coin olishga qarshi)
          const sn = Date.now();
          for (const k of ['st', 'ct', 'ch', 'sty']) {
            if (typeof nd[k] === 'number') { let v = nd[k]; if (typeof old[k] === 'number' && v < old[k]) v = old[k]; if (v > sn) v = sn; nd[k] = v; }
          }
        }
        if (b.op === 'delete') await cl.query('delete from docs where col=$1 and id=$2', [col, id]);
        else await cl.query(
          'insert into docs(col,id,data,updated) values($1,$2,$3,$4) on conflict(col,id) do update set data=excluded.data,updated=excluded.updated',
          [col, id, JSON.stringify(nd), Date.now()]);
        await cl.query('commit');
        AGG.clear();
        if (col === 'players') BL.clear();
        if (col === 'inbox' && b.op === 'add') pushNd = nd;
      } catch (e) { try { await cl.query('rollback'); } catch (_) {} throw e; }
      finally { cl.release(); }
      // Bog'lanish bo'shatilgandan keyin yuboramiz (kutish paytida ulanishni band qilmaslik uchun)
      if (pushNd) await pushTg(pool, pushNd);
      return res.json({ now: Date.now(), ok: true, id });
    }

    return bad(res, 400, 'Noma’lum amal');
  } catch (e) {
    console.error(e);
    return bad(res, 500, 'Server xatosi');
  }
};
