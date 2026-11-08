'use strict';
const crypto = require('crypto');
const L = require('../lib/server');

const bad = (res, code, msg) => res.status(code).json({ error: msg });

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
      return res.json({ uid: a.uid, admin: a.admin, appLink: process.env.APP_LINK || '' });
    }

    if (b.op === 'sync') {
      const vs = b.v || {};
      const cols = L.KNOWN.filter(c => L.canRead(c, a));
      const r = await pool.query('select col,max(updated)::text v,count(*)::int n from docs where col=any($1) group by col', [cols]);
      const cur = {};
      r.rows.forEach(x => { cur[x.col] = { v: Number(x.v), n: x.n }; });
      const out = {};
      for (const c of cols) {
        const k = cur[c] || { v: 0, n: 0 };
        const o = vs[c];
        if (o && o.v === k.v && o.n === k.n) continue;
        const d = await pool.query('select id,data from docs where col=$1 order by updated desc limit 1500', [c]);
        const slim = x => (c === 'orders' || c === 'reqs') && x.data && x.data.rc ? Object.assign({}, x.data, { rc: 1 }) : x.data;
        out[c] = { v: k.v, n: k.n, docs: d.rows.filter(x => L.visible(c, x.data, a)).map(x => ({ id: x.id, data: slim(x) })) };
      }
      return res.json({ cols: out });
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
      const cl = await pool.connect();
      try {
        await cl.query('begin');
        const cur = await cl.query('select data from docs where col=$1 and id=$2 for update', [col, id]);
        const old = cur.rows[0] ? cur.rows[0].data : null;
        let nd = null;
        if (b.op === 'update') { if (!old) { await cl.query('rollback'); return bad(res, 404, 'Topilmadi'); } nd = Object.assign({}, old, patch); }
        else if (b.op !== 'delete') nd = patch;
        if (nd && JSON.stringify(nd).length > (col === 'orders' || col === 'reqs' ? 150000 : 30000)) { await cl.query('rollback'); return bad(res, 413, 'Juda katta'); }
        if (!L.allowed(col, b.op, a, id, old, patch, nd)) { await cl.query('rollback'); return bad(res, 403, 'Ruxsat yo‘q'); }
        if (b.op === 'delete') await cl.query('delete from docs where col=$1 and id=$2', [col, id]);
        else await cl.query(
          'insert into docs(col,id,data,updated) values($1,$2,$3,$4) on conflict(col,id) do update set data=excluded.data,updated=excluded.updated',
          [col, id, JSON.stringify(nd), Date.now()]);
        await cl.query('commit');
        return res.json({ ok: true, id });
      } catch (e) { try { await cl.query('rollback'); } catch (_) {} throw e; }
      finally { cl.release(); }
    }

    return bad(res, 400, 'Noma’lum amal');
  } catch (e) {
    console.error(e);
    return bad(res, 500, 'Server xatosi');
  }
};
