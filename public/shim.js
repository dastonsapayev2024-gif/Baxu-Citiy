/* Baxu City: claude.ai ma'lumotlar bazasi o'rniga o'z serveringiz bilan ishlovchi qatlam.
   O'yin kodi o'zgarmaydi: window.claude.use('db'|'user') xuddi avvalgidek ishlaydi. */
(function () {
  'use strict';
  var tg = window.Telegram && window.Telegram.WebApp;
  var INIT = (tg && tg.initData) || '';
  var DEVU = new URLSearchParams(location.search).get('dev') || '';
  if (tg) {
    try { tg.ready(); tg.expand(); } catch (e) {}
    try { if (tg.requestWriteAccess && !localStorage.getItem('wa1')) { localStorage.setItem('wa1', '1'); setTimeout(function () { try { tg.requestWriteAccess(function () {}); } catch (e) {} }, 4000); } } catch (e) {}
    try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) {}
    try {
      var sp = tg.initDataUnsafe && tg.initDataUnsafe.start_param;
      if (sp && /^[rb]-[a-z0-9]+$/.test(sp)) location.hash = '#' + sp;
    } catch (e) {}
  }

  // Telefon soati o'zgartirilsa ham o'yin SERVER vaqti bilan ishlaydi
  var _D = window.Date, _N = _D.now, off = 0;
  function SN() { return _N.call(_D) + off; }
  function FD() {
    var a = arguments;
    if (!(this instanceof FD)) return new _D(SN()).toString();
    if (a.length === 0) return new _D(SN());
    if (a.length === 1) return new _D(a[0]);
    return new _D(a[0], a[1], a[2] === undefined ? 1 : a[2], a[3] || 0, a[4] || 0, a[5] || 0, a[6] || 0);
  }
  FD.prototype = _D.prototype; FD.UTC = _D.UTC; FD.parse = _D.parse; FD.now = SN;
  window.Date = FD;

  var wseq = 0, busy = false, timer = null, uid = null, admin = false, idle = 0, fails = 0;
  var cache = {}, ver = {}, subs = {};

  function raw(body, ms) {
    var h = { 'content-type': 'application/json' };
    if (INIT) h['x-tg-init'] = INIT;
    if (DEVU) h['x-dev-user'] = DEVU;
    var ac = window.AbortController ? new AbortController() : null;
    var t0 = _N.call(_D);
    var tm = ac ? setTimeout(function () { ac.abort(); }, ms) : 0;
    return fetch('/api/db', { method: 'POST', headers: h, body: JSON.stringify(body), signal: ac ? ac.signal : undefined }).then(function (r) {
      clearTimeout(tm);
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (j && typeof j.now === 'number') off = j.now - (t0 + _N.call(_D)) / 2;
        if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    }, function (e) { clearTimeout(tm); throw e; });
  }
  // O'qish so'rovlari server band bo'lsa 2 martagacha o'zi qayta uriniladi; yozish qayta yuborilmaydi
  function api(body) {
    if (body.op !== 'sync' && body.op !== 'me' && body.op !== 'get') return raw(body, 20000);
    var n = 0;
    function go() {
      return raw(body, 12000).catch(function (e) {
        if ((!e.status || e.status >= 500) && n < 2) {
          n++;
          return new Promise(function (r) { setTimeout(r, 600 * n + Math.random() * 600); }).then(go);
        }
        throw e;
      });
    }
    return go();
  }
  function write(body) {
    wseq++;
    return api(body).then(function (r) { wseq++; kick(150); return r; }, function (e) { wseq++; kick(300); throw e; });
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
      fails = 0;
      if (s0 !== wseq) return;
      var ks = Object.keys(j.cols || {}), redo = false;
      idle = ks.length ? 0 : Math.min(idle + 1, 30);
      ks.forEach(function (c) {
        var x = j.cols[c];
        ver[c] = { v: x.v, n: x.n };
        if (x.delta && cache[c]) {
          var ids = {};
          x.docs.forEach(function (d) { ids[d.id] = 1; });
          cache[c] = x.docs.concat(cache[c].filter(function (d) { return !ids[d.id]; }));
          // Hujjat o'chirilgan yoki yetishmasa: to'liq qayta yuklash
          if (cache[c].length > x.n || cache[c].length < Math.min(x.n, 1500)) { delete ver[c]; redo = true; }
        } else cache[c] = x.docs;
        emit(c);
      });
      if (redo) kick(0);
    }).catch(function (e) { fails++; if (fails >= 3) errAll(e); }).then(function () { busy = false; });
  }
  function kick(ms) { setTimeout(sync, ms || 0); }
  // Xato bo'lsa so'rovlar orasi uzayadi (server bosimini oshirmaslik uchun); tasodifiy qo'shimcha hamma bir vaqtda urilmasligi uchun
  function tick() {
    if (!document.hidden) sync();
    var d = fails ? Math.min(30000, 3000 * Math.pow(2, Math.min(fails, 4))) : (idle > 10 ? 6000 : 3000);
    // Harakatsiz o'yinchi (60 s ekranga tegmagan, chat yopiq): so'rov orasi uzayadi
    if (!fails && Date.now() - lastAct > 60000 && !chatOpen()) d = idle > 10 ? 20000 : 12000;
    timer = setTimeout(tick, d + Math.random() * 1000);
  }
  var lastAct = Date.now();
  function chatOpen() { try { return !!document.querySelector('#tq button[data-t="chat"].on'); } catch (e) { return false; } }
  function act() { var was = Date.now() - lastAct > 60000; lastAct = Date.now(); if (was) kick(0); }
  ['pointerdown', 'touchstart', 'keydown', 'wheel'].forEach(function (ev) { document.addEventListener(ev, act, { passive: true, capture: true }); });
  function start() { if (!timer) { timer = 1; tick(); } else kick(0); }
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
    update: function (d, cb) { var q = { op: 'update', col: this.c, id: this.i, data: d }; if (typeof cb === 'number') q.cb = cb; return write(q); },
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
    call: function (b) { return api(b); },
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
    }).catch(function (e) { console.error(e); window.__ie = String(e && e.message || e); initP = null; return false; });
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
