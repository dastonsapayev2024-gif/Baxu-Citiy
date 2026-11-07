/* Baxu City: claude.ai ma'lumotlar bazasi o'rniga o'z serveringiz bilan ishlovchi qatlam.
   O'yin kodi o'zgarmaydi: window.claude.use('db'|'user') xuddi avvalgidek ishlaydi. */
(function () {
  'use strict';
  var tg = window.Telegram && window.Telegram.WebApp;
  var INIT = (tg && tg.initData) || '';
  var DEVU = new URLSearchParams(location.search).get('dev') || '';
  if (tg) {
    try { tg.ready(); tg.expand(); } catch (e) {}
    try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) {}
    try {
      var sp = tg.initDataUnsafe && tg.initDataUnsafe.start_param;
      if (sp && /^[rb]-[a-z0-9]+$/.test(sp)) location.hash = '#' + sp;
    } catch (e) {}
  }

  var wseq = 0, busy = false, timer = null, uid = null, admin = false;
  var cache = {}, ver = {}, subs = {};

  function api(body) {
    var h = { 'content-type': 'application/json' };
    if (INIT) h['x-tg-init'] = INIT;
    if (DEVU) h['x-dev-user'] = DEVU;
    return fetch('/api/db', { method: 'POST', headers: h, body: JSON.stringify(body) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function write(body) {
    wseq++;
    return api(body).then(function (r) { wseq++; kick(150); return r; }, function (e) { wseq++; throw e; });
  }

  function snapOf(c, q) {
    var a = (cache[c] || []).slice();
    if (q && q.o) {
      var f = q.o[0], d = q.o[1] === 'desc' ? -1 : 1;
      a.sort(function (x, y) { var p = x.data[f], r = y.data[f]; return (p > r ? 1 : p < r ? -1 : 0) * d; });
    }
    if (q && q.l) a = a.slice(0, q.l);
    return {
      docs: a.map(function (d) { return { id: d.id, exists: true, data: function () { return JSON.parse(JSON.stringify(d.data)); } }; }),
      size: a.length, empty: !a.length
    };
  }
  function emit(c) {
    (subs[c] || []).slice().forEach(function (s) {
      try {
        if (s.id != null) {
          var d = (cache[c] || []).filter(function (x) { return x.id === s.id; })[0];
          s.cb({ id: s.id, exists: !!d, data: function () { return d ? JSON.parse(JSON.stringify(d.data)) : undefined; } });
        } else s.cb(snapOf(c, s.q));
      } catch (e) { console.error(e); }
    });
  }
  function errAll(e) {
    Object.keys(subs).forEach(function (c) { subs[c].forEach(function (s) { if (s.eb && !s.failed) { s.failed = 1; try { s.eb(e); } catch (_) {} } }); });
  }
  function sync() {
    if (busy || (document.hidden && Object.keys(cache).length)) return;
    busy = true;
    var s0 = wseq;
    api({ op: 'sync', v: ver }).then(function (j) {
      if (s0 !== wseq) return;
      Object.keys(j.cols || {}).forEach(function (c) {
        ver[c] = { v: j.cols[c].v, n: j.cols[c].n };
        cache[c] = j.cols[c].docs;
        emit(c);
      });
    }).catch(errAll).then(function () { busy = false; });
  }
  function kick(ms) { setTimeout(sync, ms || 0); }
  function start() { if (!timer) timer = setInterval(sync, 3000); kick(0); }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) kick(0); });

  function sub(c, q, id, cb, eb) {
    var s = { q: q, id: id, cb: cb, eb: eb };
    (subs[c] = subs[c] || []).push(s);
    start();
    if (cache[c]) setTimeout(function () { emit(c); }, 0);
    return function () { subs[c] = (subs[c] || []).filter(function (x) { return x !== s; }); };
  }

  function Doc(c, i) { this.c = c; this.i = i; }
  Doc.prototype = {
    get: function () {
      var me = this;
      return api({ op: 'get', col: this.c, id: this.i }).then(function (r) {
        return { id: me.i, exists: !!r.exists, data: function () { return r.data; } };
      });
    },
    set: function (d) { return write({ op: 'set', col: this.c, id: this.i, data: d }); },
    update: function (d) { return write({ op: 'update', col: this.c, id: this.i, data: d }); },
    delete: function () { return write({ op: 'delete', col: this.c, id: this.i }); },
    onSnapshot: function (cb, eb) { return sub(this.c, null, this.i, cb, eb); }
  };
  function Col(c, q) { this.c = c; this.q = q || {}; }
  Col.prototype = {
    doc: function (i) { return new Doc(this.c, i); },
    add: function (d) { var c = this.c; return write({ op: 'add', col: c, data: d }).then(function (r) { return new Doc(c, r.id); }); },
    orderBy: function (f, d) { return new Col(this.c, Object.assign({}, this.q, { o: [f, d || 'asc'] })); },
    limit: function (n) { return new Col(this.c, Object.assign({}, this.q, { l: n })); },
    onSnapshot: function (cb, eb) { return sub(this.c, this.q, null, cb, eb); }
  };
  var db = {
    collection: function (c) { return new Col(c); },
    doc: function (p) { var a = String(p).split('/'); return new Doc(a[0], a[1]); }
  };
  var user = {
    id: function () { return Promise.resolve(uid); },
    me: function () { return Promise.resolve({ id: uid }); },
    isOwner: function () { return admin; },
    canEdit: function () { return admin; },
    can: function () { return true; }
  };

  var initP = null;
  function init() {
    if (!initP) initP = api({ op: 'me' }).then(function (r) {
      uid = r.uid; admin = !!r.admin;
      if (r.appLink) window.APP_LINK = r.appLink;
      return true;
    }).catch(function (e) { console.error(e); return false; });
    return initP;
  }
  window.claude = {
    use: function (n) {
      return init().then(function (ok) {
        if (!ok) return null;
        return n === 'user' ? user : n === 'db' ? db : null;
      });
    }
  };
})();
