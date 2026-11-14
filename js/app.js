/* =====================================================================
   KRD Stores — Kippa Ring Depot Stores app
   Single-page app, no build step. Hash routes, TRACKS styling.
   ===================================================================== */
(function () {
  'use strict';

  var api = window.KRDApi;
  var $app = document.getElementById('app');
  var $nav = document.getElementById('bottomNav');
  var $topRight = document.getElementById('topRight');
  var $sheetHost = document.getElementById('sheetHost');
  var $toastHost = document.getElementById('toastHost');

  // ------------------------------------------------------------------
  //  State & storage
  // ------------------------------------------------------------------
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem('krd_' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set: function (k, v) { try { localStorage.setItem('krd_' + k, JSON.stringify(v)); } catch (_) {} },
    del: function (k) { try { localStorage.removeItem('krd_' + k); } catch (_) {} }
  };
  var S = {
    token: LS.get('token', null),
    me: LS.get('me', null),
    cart: {},                 // itemId -> qty
    items: [],                // last loaded item list
    pulse: { unread: 0, low: 0, broadcasts: 0, urgent: [] },
    urgentShown: {},          // urgent broadcast ids already popped up this session
    fileCache: {},            // attachment id -> blob URL
    chatTimer: null,
    viewCleanup: null,
    defaultPin: '0000'
  };
  var isAdmin = function () { return S.me && S.me.role === 'admin'; };

  // ------------------------------------------------------------------
  //  Helpers
  // ------------------------------------------------------------------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function initials(n) { return String(n || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0].toUpperCase(); }).join(''); }
  function plural(n, w, p) { return n + ' ' + (n === 1 ? w : (p || w + 's')); }
  function int(v) { var n = parseInt(v, 10); return isNaN(n) ? null : n; }
  var TZ = 'Australia/Brisbane';
  function fmtTime(iso) { return new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: TZ }); }
  function fmtDay(iso) { return new Date(iso).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ }); }
  function fmtDate(iso) { return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ }); }
  function dayKey(iso) { return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ }); }
  function todayKey() { return dayKey(new Date().toISOString()); }
  function addDays(key, n) { var d = new Date(key + 'T12:00:00+10:00'); d.setUTCDate(d.getUTCDate() + n); return dayKey(d.toISOString()); }
  function when(iso) {
    var k = dayKey(iso), t = todayKey();
    if (k === t) return 'Today ' + fmtTime(iso);
    if (k === addDays(t, -1)) return 'Yesterday ' + fmtTime(iso);
    return fmtDay(iso) + ' ' + fmtTime(iso);
  }
  function ago(iso) {
    var s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return fmtDay(iso);
  }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function on(root, ev, sel, fn) {
    root.addEventListener(ev, function (e) { var t = e.target.closest(sel); if (t && root.contains(t)) fn(e, t); });
  }

  function toast(msg, isError) {
    var d = document.createElement('div');
    d.className = 'toast-msg' + (isError ? ' error' : '');
    d.textContent = msg;
    $toastHost.appendChild(d);
    setTimeout(function () { d.remove(); }, isError ? 5000 : 2800);
  }

  async function call(fn, args, opts) {
    args = args || {};
    if (S.token && !('p_token' in args) && !(opts && opts.noToken)) args.p_token = S.token;
    // A screen's request that finishes after the user has moved to another
    // screen throws 'stale', which quietly stops that old screen from drawing.
    // Background work (polling, uploads, offline sync) passes {bg:true} and always completes.
    var started = routeSeq, bg = !!(opts && opts.bg);
    function stale() { var x = new Error('stale view'); x.kind = 'stale'; return x; }
    try {
      var out = await api.rpc(fn, args);
    } catch (e) {
      if (e.kind === 'session') { signOutLocal(); toast(e.message, true); route(); }
      if (e.kind === 'pin' && S.me) { S.me.must_change_pin = true; LS.set('me', S.me); route(); }
      if (!bg && started !== routeSeq && e.kind !== 'session' && e.kind !== 'pin') throw stale();
      throw e;
    }
    if (!bg && started !== routeSeq) throw stale();
    return out;
  }
  window.addEventListener('unhandledrejection', function (ev) { if (ev.reason && ev.reason.kind === 'stale') ev.preventDefault(); });
  function errToast(e) { if (e && e.kind !== 'session' && e.kind !== 'stale' && e.kind !== 'pin') toast(e.message || String(e), true); }

  function csvCell(v) { var s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function toCsv(rows) { return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n'); }
  function download(name, text, type) {
    var blob = new Blob(['﻿' + text], { type: type || 'text/csv;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied — paste it where you need it'); }
    catch (_) {
      var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copied'); } catch (__) { toast('Could not copy on this device', true); }
      ta.remove();
    }
  }

  // ------------------------------------------------------------------
  //  Icons (simple stroke icons)
  // ------------------------------------------------------------------
  function ico(p) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>'; }
  var I = {
    take: ico('<path d="M5 8h14l-1.5 11a2 2 0 0 1-2 1.7h-7a2 2 0 0 1-2-1.7z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'),
    history: ico('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    chat: ico('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
    me: ico('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
    home: ico('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'),
    stock: ico('<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>'),
    count: ico('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 11l2 2 4-4"/><path d="M9 17h6"/>'),
    more: ico('<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'),
    truck: ico('<path d="M3 6h11v10H3z"/><path d="M14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>'),
    chart: ico('<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>'),
    export: ico('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 18v-6"/><path d="M9 15l3-3 3 3"/>'),
    users: ico('<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14a6 6 0 0 1 4 6"/>'),
    gear: ico('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    upload: ico('<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/>'),
    check: ico('<path d="M5 12l5 5 9-10"/>'),
    alert: ico('<path d="M12 3l10 18H2z"/><path d="M12 10v4"/><path d="M12 18h.01"/>'),
    back: ico('<path d="M15 18l-6-6 6-6"/>'),
    send: ico('<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>'),
    search: ico('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
    plus: ico('<path d="M12 5v14"/><path d="M5 12h14"/>'),
    print: ico('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>'),
    copy: ico('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
    download: ico('<path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>'),
    megaphone: ico('<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
    clip: ico('<path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L14 4.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.7a1.7 1.7 0 0 1-2.4-2.4L15.5 7.6"/>'),
    pdf: ico('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 15h1.5a1.5 1.5 0 0 0 0-3H8v5"/><path d="M13 12v5h1a2 2 0 0 0 2-2v-1a2 2 0 0 0-2-2z"/>'),
    camera: ico('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>')
  };

  // ------------------------------------------------------------------
  //  Sheets (bottom modals)
  // ------------------------------------------------------------------
  function sheet(opts) {
    closeSheet();
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<div class="sheet-backdrop" data-close></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">' +
        '<div class="sheet-head"><h5 id="sheetTitle">' + esc(opts.title) + '</h5>' +
          '<button type="button" class="btn-close" data-close aria-label="Close"></button></div>' +
        '<div class="sheet-body">' + (opts.body || '') + '</div>' +
        (opts.foot ? '<div class="sheet-foot">' + opts.foot + '</div>' : '') +
      '</div>';
    $sheetHost.appendChild(wrap);
    document.body.style.overflow = 'hidden';
    on(wrap, 'click', '[data-close]', function () { closeSheet(); if (opts.onClose) opts.onClose(); });
    var first = wrap.querySelector('[autofocus]');
    if (first) setTimeout(function () { first.focus(); }, 60);
    if (opts.onOpen) opts.onOpen(wrap);
    return wrap;
  }
  function closeSheet() { $sheetHost.innerHTML = ''; document.body.style.overflow = ''; }
  function confirmSheet(title, html, okLabel, danger) {
    return new Promise(function (resolve) {
      var w = sheet({ title: title, body: html,
        foot: '<button class="btn btn-outline-secondary" data-close>Cancel</button><button class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '" id="cfOk">' + esc(okLabel || 'OK') + '</button>',
        onClose: function () { resolve(false); } });
      qs('#cfOk', w).addEventListener('click', function () { closeSheet(); resolve(true); });
    });
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $sheetHost.innerHTML) closeSheet(); });

  // ------------------------------------------------------------------
  //  Offline outbox for takes (so no-signal never means no record)
  // ------------------------------------------------------------------
  function outbox() { return LS.get('outbox', []); }
  function updateOfflineBanner() {
    var b = document.getElementById('offlineBanner'), n = outbox().length;
    if (!navigator.onLine) { b.textContent = 'No connection — takes will be saved on this phone and sent automatically.'; b.classList.remove('d-none'); }
    else if (n) { b.textContent = plural(n, 'take') + ' waiting to send… '; b.classList.remove('d-none'); }
    else b.classList.add('d-none');
  }
  var flushing = false;
  async function flushOutbox() {
    if (flushing || !S.token) return;
    var box = outbox(); if (!box.length) { updateOfflineBanner(); return; }
    flushing = true;
    try {
      while (box.length) {
        var job = box[0];
        if (job.staff_id !== (S.me && S.me.id)) { box.shift(); LS.set('outbox', box); continue; } // signed in as someone else
        try {
          await call('take_items', { p_lines: job.lines, p_note: job.note }, { bg: true });
        } catch (e) {
          if (e.kind === 'network') break;
          toast('A saved take could not be sent: ' + e.message, true);
        }
        box.shift(); LS.set('outbox', box);
        toast('Saved take sent ✓');
      }
    } finally { flushing = false; updateOfflineBanner(); }
  }
  window.addEventListener('online', function () { updateOfflineBanner(); flushOutbox(); });
  window.addEventListener('offline', updateOfflineBanner);

  // ------------------------------------------------------------------
  //  Heartbeat (unread messages, low stock)
  // ------------------------------------------------------------------
  async function pulse() {
    if (!S.token || document.hidden) return;
    try { S.pulse = await call('heartbeat', null, { bg: true }); renderNav(); flushOutbox(); maybeUrgentPopup(); paintBroadcastBanner(); } catch (_) {}
  }
  setInterval(pulse, 25000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pulse(); });

  // ------------------------------------------------------------------
  //  Chrome: top bar & bottom nav
  // ------------------------------------------------------------------
  function navItems() {
    if (!S.me) return [];
    if (isAdmin()) return [
      { href: '#/', label: 'Home', icon: I.home, match: /^#\/?$/ },
      { href: '#/take', label: 'Take', icon: I.take, match: /^#\/take/ },
      { href: '#/stock', label: 'Stock', icon: I.stock, match: /^#\/(stock|import)/, dot: S.pulse.low },
      { href: '#/count', label: 'Count', icon: I.count, match: /^#\/count/ },
      { href: '#/messages', label: 'Messages', icon: I.chat, match: /^#\/(chat|messages|broadcast)/, dot: (S.pulse.unread || 0) + (S.pulse.broadcasts || 0) },
      { href: '#/more', label: 'More', icon: I.more, match: /^#\/(more|receive|reports|tracks|staff|settings|me|history)/ }
    ];
    return [
      { href: '#/take', label: 'Take', icon: I.take, match: /^#\/(take)?\/?$/ },
      { href: '#/history', label: 'My history', icon: I.history, match: /^#\/history/ },
      { href: '#/messages', label: 'Messages', icon: I.chat, match: /^#\/(chat|messages|broadcast)/, dot: (S.pulse.unread || 0) + (S.pulse.broadcasts || 0) },
      { href: '#/me', label: 'Me', icon: I.me, match: /^#\/me/ }
    ];
  }
  function renderNav() {
    var items = (S.me && S.me.must_change_pin) ? [] : navItems(), h = location.hash || '#/';
    if (!items.length) { $nav.classList.add('d-none'); $topRight.innerHTML = ''; return; }
    $nav.classList.remove('d-none');
    $nav.innerHTML = items.map(function (n) {
      var act = n.match.test(h);
      return '<a href="' + n.href + '"' + (act ? ' class="active" aria-current="page"' : '') + '>' + n.icon +
             '<span>' + esc(n.label) + '</span>' + (n.dot ? '<span class="dot">' + (n.dot > 99 ? '99+' : n.dot) + '</span>' : '') + '</a>';
    }).join('');
    $topRight.innerHTML = '<a class="btn btn-link d-flex align-items-center gap-2" href="#/me" title="My account">' +
      '<span class="avatar' + (isAdmin() ? ' admin' : '') + '" style="width:1.9rem;height:1.9rem;border:2px solid #fff">' + esc(initials(S.me.name)) + '</span>' +
      '<span class="top-user d-none d-sm-inline">' + esc(S.me.name) + '</span></a>';
  }

  // ------------------------------------------------------------------
  //  Router
  // ------------------------------------------------------------------
  var ROUTES = [
    [/^#\/?$/, function () { return isAdmin() ? viewHome() : viewTake(); }],
    [/^#\/take$/, function () { return viewTake(); }],
    [/^#\/history$/, function () { return viewHistory(); }],
    [/^#\/messages$/, function () { location.replace(S.pulse.broadcasts || !S.pulse.unread ? '#/broadcasts' : '#/chat'); }],
    [/^#\/broadcasts$/, function () { return viewBroadcasts(); }],
    [/^#\/broadcasts\/new$/, function () { return viewNewBroadcast(); }],
    [/^#\/broadcast\/(\d+)$/, function (m) { return viewBroadcast(+m[1]); }],
    [/^#\/chat$/, function () { return viewChatList(); }],
    [/^#\/chat\/(.+)$/, function (m) { return viewChat(decodeURIComponent(m[1])); }],
    [/^#\/me$/, function () { return viewMe(); }],
    [/^#\/more$/, function () { return adminOnly(viewMore); }],
    [/^#\/stock(?:\?(low))?$/, function (m) { return adminOnly(function () { return viewStock(m[1]); }); }],
    [/^#\/import$/, function () { return adminOnly(viewImport); }],
    [/^#\/receive$/, function () { return adminOnly(viewReceive); }],
    [/^#\/count$/, function () { return adminOnly(viewCount); }],
    [/^#\/count\/(.+)$/, function (m) { return adminOnly(function () { return viewCountReport(m[1]); }); }],
    [/^#\/reports$/, function () { return adminOnly(viewReports); }],
    [/^#\/tracks$/, function () { return adminOnly(viewTracks); }],
    [/^#\/staff$/, function () { return adminOnly(viewStaff); }],
    [/^#\/settings$/, function () { return adminOnly(viewSettings); }]
  ];
  function adminOnly(fn) { if (!isAdmin()) { location.hash = '#/take'; return; } return fn(); }

  var routeSeq = 0;
  async function route() {
    var seq = ++routeSeq;
    if (S.viewCleanup) { try { S.viewCleanup(); } catch (_) {} S.viewCleanup = null; }
    closeSheet();
    renderNav();
    if (!S.token || !S.me) { try { await viewSignIn(); } catch (e) { if (e.kind !== 'stale') errToast(e); } return; }
    if (S.me.must_change_pin) { $nav.classList.add('d-none'); viewSetOwnPin(); return; }
    var h = location.hash || '#/';
    for (var i = 0; i < ROUTES.length; i++) {
      var m = h.match(ROUTES[i][0]);
      if (m) {
        try { await ROUTES[i][1](m); }
        catch (e) { if (seq === routeSeq && e.kind !== 'stale') { errToast(e); if (e.kind === 'network') $app.innerHTML = offlineView(); } }
        if (seq === routeSeq) window.scrollTo(0, 0);
        return;
      }
    }
    location.hash = '#/';
  }
  window.addEventListener('hashchange', route);
  // Each render swaps in a fresh <main> so event handlers from the previous
  // screen can never pile up, and stops any timers that screen left running.
  function render(html) {
    if (S.viewCleanup) { var c = S.viewCleanup; S.viewCleanup = null; try { c(); } catch (_) {} }
    var fresh = $app.cloneNode(false);
    fresh.innerHTML = html;
    $app.parentNode.replaceChild(fresh, $app);
    $app = fresh;
  }
  function offlineView() {
    return '<div class="empty"><div class="mb-2" style="width:48px;margin:0 auto;color:var(--qr-orange)">' + I.alert + '</div>' +
      '<h5>No connection</h5><p>Check your signal, then try again.</p><button class="btn btn-primary" onclick="location.reload()">Try again</button></div>';
  }
  function loading() { render('<div class="empty">Loading…</div>'); }

  // ------------------------------------------------------------------
  //  SIGN IN / SETUP
  // ------------------------------------------------------------------
  function signOutLocal() {
    S.token = null; S.me = null; S.cart = {}; LS.del('token'); LS.del('me'); renderNav();
  }
  function setSession(r) {
    S.token = r.token; S.me = r.me; LS.set('token', r.token); LS.set('me', r.me); LS.set('lastPerson', r.me.id);
  }

  async function viewSignIn() {
    $nav.classList.add('d-none');
    loading();
    var st;
    try { st = await api.rpc('app_status', {}); }
    catch (e) { render(offlineView() + '<p class="text-center small text-muted">' + esc(e.message) + '</p>'); return; }
    if (st && st.needs_setup) return viewSetup();
    var people = await api.rpc('list_people', {});
    var last = LS.get('lastPerson', null);
    var lastP = people.find(function (p) { return p.id === last; });
    if (lastP) return viewPin(lastP, people);
    viewPeople(people);
  }

  function viewPeople(people) {
    var demo = api.isDemo ? '<div class="alert alert-warning small">Demo PINs — Manager (demo): <b>1234</b> · Sam Smith: <b>1111</b> · Alex Brown: <b>2222</b></div>' : '';
    render('<div class="signin-wrap">' +
      '<h4 class="mb-1">Who are you?</h4><p class="text-muted mb-3">Tap your name to sign in.</p>' + demo +
      (people.length > 8 ? '<input class="form-control mb-3" id="pSearch" type="search" placeholder="Search names…" autocomplete="off">' : '') +
      '<div class="people" id="people">' + peopleHtml(people) + '</div>' +
      (people.length ? '' : '<div class="alert alert-info">No one has been added yet. Ask the manager to add you.</div>') +
      '</div>');
    var s = qs('#pSearch');
    if (s) s.addEventListener('input', function () {
      var q = s.value.toLowerCase();
      qs('#people').innerHTML = peopleHtml(people.filter(function (p) { return p.name.toLowerCase().indexOf(q) >= 0; }));
    });
    on($app, 'click', '[data-person]', function (e, b) {
      var p = people.find(function (x) { return x.id === b.getAttribute('data-person'); });
      if (p) viewPin(p, people);
    });
  }
  function peopleHtml(list) {
    return list.map(function (p) {
      return '<button type="button" class="person" data-person="' + esc(p.id) + '"><span class="avatar">' + esc(initials(p.name)) + '</span><span>' + esc(p.name) + '</span></button>';
    }).join('');
  }

  function viewPin(person, people) {
    var pin = '', busy = false;
    render('<div class="signin-wrap text-center">' +
      '<span class="avatar mb-2" style="width:3.4rem;height:3.4rem;font-size:1.2rem">' + esc(initials(person.name)) + '</span>' +
      '<h4 class="mb-0 text-center">Hi, ' + esc(person.name.split(' ')[0]) + '</h4>' +
      '<p class="text-muted text-center mb-0">Enter your 4-digit PIN</p>' +
      '<div class="pin-dots" id="dots" aria-live="polite"><span></span><span></span><span></span><span></span></div>' +
      '<div class="small text-danger mb-2 text-center" id="pinErr" role="alert" style="min-height:1.4em"></div>' +
      '<div class="keypad">' +
        [1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (n) { return '<button type="button" data-k="' + n + '">' + n + '</button>'; }).join('') +
        '<button type="button" class="k-fn" id="notMe">Not ' + esc(person.name.split(' ')[0]) + '?</button>' +
        '<button type="button" data-k="0">0</button>' +
        '<button type="button" class="k-fn" data-k="del" aria-label="Delete">⌫</button>' +
      '</div>' +
      (api.isDemo ? '<p class="small text-muted mt-3 text-center">Demo PINs: Manager 1234 · Sam 1111 · Alex 2222</p>' : '') +
      '<input type="tel" id="pinKb" inputmode="numeric" autocomplete="one-time-code" aria-label="PIN" style="position:absolute;opacity:0;width:1px;height:1px">' +
      '</div>');
    function paint() { qsa('#dots span').forEach(function (d, i) { d.classList.toggle('on', i < pin.length); }); }
    async function submit() {
      busy = true;
      try {
        var r = await api.rpc('login', { p_staff_id: person.id, p_pin: pin });
        if (r && r.error) throw new Error(r.error);
        setSession(r); toast('Signed in as ' + r.me.name);
        location.hash = isAdmin() ? '#/' : '#/take';
        route(); flushOutbox(); pulse();
      } catch (e) {
        qs('#pinErr').textContent = e.message;
        var d = qs('#dots'); d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake');
        pin = ''; paint();
      } finally { busy = false; }
    }
    function press(k) {
      if (busy) return;
      qs('#pinErr').textContent = '';
      if (k === 'del') pin = pin.slice(0, -1);
      else if (pin.length < 4) pin += k;
      paint();
      if (pin.length === 4) submit();
    }
    on($app, 'click', '[data-k]', function (e, b) { press(b.getAttribute('data-k')); });
    qs('#notMe').addEventListener('click', function () { LS.del('lastPerson'); viewPeople(people); });
    var kbHandler = function (e) {
      if (!qs('#dots')) { document.removeEventListener('keydown', kbHandler); return; }
      if (/^[0-9]$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del');
    };
    document.addEventListener('keydown', kbHandler);
    S.viewCleanup = function () { document.removeEventListener('keydown', kbHandler); };
  }

  // First sign-in / after a reset: choose your own PIN (keypad, entered twice)
  function viewSetOwnPin() {
    var first = null, pin = '', busy = false;
    function screen() {
      render('<div class="signin-wrap text-center">' +
        '<span class="avatar mb-2" style="width:3.4rem;height:3.4rem;font-size:1.2rem">' + esc(initials(S.me.name)) + '</span>' +
        '<h4 class="mb-0 text-center">' + (first ? 'Enter it again' : 'Welcome, ' + esc(S.me.name.split(' ')[0]) + '!') + '</h4>' +
        '<p class="text-muted text-center mb-0">' + (first ? 'Type your new PIN once more to confirm' : 'Choose your own 4-digit PIN. You\'ll use it every time you sign in.') + '</p>' +
        '<div class="pin-dots" id="dots"><span></span><span></span><span></span><span></span></div>' +
        '<div class="small text-danger mb-2 text-center" id="pinErr" role="alert" style="min-height:1.4em"></div>' +
        '<div class="keypad">' + [1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (n) { return '<button type="button" data-k="' + n + '">' + n + '</button>'; }).join('') +
          '<button type="button" class="k-fn" id="spCancel">' + (first ? 'Start again' : 'Sign out') + '</button><button type="button" data-k="0">0</button>' +
          '<button type="button" class="k-fn" data-k="del" aria-label="Delete">⌫</button></div>' +
        '<p class="small text-muted mt-3 text-center">Don\'t use 1234, 0000 or your temporary PIN.</p></div>');
      pin = '';
      on($app, 'click', '[data-k]', function (e, b) { press(b.getAttribute('data-k')); });
      qs('#spCancel').addEventListener('click', async function () {
        if (first) { first = null; screen(); return; }
        try { await call('logout'); } catch (_) {}
        signOutLocal(); route();
      });
    }
    function paint() { qsa('#dots span').forEach(function (d, i) { d.classList.toggle('on', i < pin.length); }); }
    function shake(msg) {
      qs('#pinErr').textContent = msg; var d = qs('#dots'); d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake'); pin = ''; paint();
    }
    async function press(k) {
      if (busy) return;
      qs('#pinErr').textContent = '';
      if (k === 'del') pin = pin.slice(0, -1); else if (pin.length < 4) pin += k;
      paint();
      if (pin.length < 4) return;
      if (!first) { first = pin; screen(); return; }
      if (pin !== first) { first = null; screen(); qs('#pinErr').textContent = 'Those didn\'t match. Let\'s try again.'; return; }
      busy = true;
      try {
        S.me = await call('set_own_pin', { p_new: pin }); LS.set('me', S.me);
        toast('PIN set — welcome aboard!');
        location.hash = isAdmin() ? '#/' : '#/take'; route(); pulse();
      } catch (e) { first = null; screen(); qs('#pinErr').textContent = e.message; }
      finally { busy = false; }
    }
    var kb = function (e) {
      if (!qs('#dots')) { document.removeEventListener('keydown', kb); return; }
      if (/^[0-9]$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del');
    };
    screen();
    document.addEventListener('keydown', kb);
    S.viewCleanup = function () { document.removeEventListener('keydown', kb); };
  }

  function viewSetup() {
    render('<div class="signin-wrap">' +
      '<h4>Welcome to KRD Stores</h4>' +
      '<p>Let\'s set up the first manager account. This is a one-time step.</p>' +
      '<form id="setupForm" class="card"><div class="card-body">' +
        '<div class="mb-3"><label class="form-label" for="suName">Your name</label><input class="form-control" id="suName" required autocomplete="name"></div>' +
        '<div class="mb-3"><label class="form-label" for="suPin">Choose a 4-digit PIN</label><input class="form-control" id="suPin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required type="password"></div>' +
        '<div class="mb-3"><label class="form-label" for="suPin2">PIN again</label><input class="form-control" id="suPin2" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required type="password"></div>' +
        '<button class="btn btn-primary btn-lg w-100">Create manager account</button>' +
      '</div></form></div>');
    qs('#setupForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var p = qs('#suPin').value;
      if (!/^\d{4}$/.test(p)) return toast('PIN must be 4 digits', true);
      if (p !== qs('#suPin2').value) return toast('PINs do not match', true);
      try {
        var r = await api.rpc('setup_first_admin', { p_name: qs('#suName').value, p_pin: p });
        setSession(r); location.hash = '#/settings'; toast('Account created. Next: set up email alerts.'); route();
      } catch (err) { errToast(err); }
    });
  }

  // ------------------------------------------------------------------
  //  TAKE ITEMS
  // ------------------------------------------------------------------
  var takeFilter = { q: '', cat: '' };
  async function viewTake() {
    loading();
    S.items = await call('list_items');
    var cats = Array.from(new Set(S.items.map(function (i) { return i.category; })));
    if (takeFilter.cat && cats.indexOf(takeFilter.cat) < 0) takeFilter.cat = '';
    // drop cart lines for items that no longer exist
    Object.keys(S.cart).forEach(function (id) { if (!S.items.some(function (i) { return i.id === id; })) delete S.cart[id]; });

    render(
      '<div id="bcBanner"></div>' +
      '<div class="page-title"><h4>Take items</h4>' + (isAdmin() ? '' : '<a href="#/history" class="small">My history</a>') + '</div>' +
      '<p class="text-muted mb-1" style="margin-top:-.5rem">Tap <b>+</b> for each thing you take, then press <b>Review</b>.</p>' +
      '<div class="search-bar">' +
        '<input class="form-control mb-2" id="tSearch" type="search" placeholder="Search items…" autocomplete="off" value="' + esc(takeFilter.q) + '">' +
        (cats.length > 1 ? '<div class="chips" role="tablist"><button class="chip' + (!takeFilter.cat ? ' active' : '') + '" data-cat="">All</button>' +
          cats.map(function (c) { return '<button class="chip' + (takeFilter.cat === c ? ' active' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div>' : '') +
      '</div>' +
      '<div id="itemList" class="item-list"></div>' +
      '<div class="cart-bar" id="cartBar"></div>');
    paintItems(); paintCart(); paintBroadcastBanner();

    qs('#tSearch').addEventListener('input', debounce(function (e) { takeFilter.q = e.target.value; paintItems(); }, 120));
    on($app, 'click', '[data-cat]', function (e, b) {
      takeFilter.cat = b.getAttribute('data-cat');
      qsa('[data-cat]').forEach(function (x) { x.classList.toggle('active', x === b); });
      paintItems();
    });
    on($app, 'click', '[data-step]', function (e, b) {
      var id = b.getAttribute('data-id'), d = +b.getAttribute('data-step'), it = S.items.find(function (i) { return i.id === id; });
      var q = Math.max(0, (S.cart[id] || 0) + d);
      if (it && it.max_per_take != null && q > it.max_per_take) { toast('Max ' + it.max_per_take + ' per take for ' + it.name, true); q = it.max_per_take; }
      if (q) S.cart[id] = q; else delete S.cart[id];
      paintRow(id); paintCart();
      if (navigator.vibrate) navigator.vibrate(8);
    });
    qs('#cartBar').addEventListener('click', function (e) { if (e.target.closest('button')) openReview(); });
  }
  function itemRowHtml(i) {
    var q = S.cart[i.id] || 0;
    return '<div class="item-row' + (q ? ' has-qty' : '') + '" id="row-' + i.id + '">' +
      '<div class="grow"><div class="item-name">' + esc(i.name) + '</div><div class="item-meta">' + esc(i.unit) +
      (i.max_per_take != null ? ' · max ' + i.max_per_take : '') + (isAdmin() && i.low ? ' · <span class="text-danger fw-bold">low</span>' : '') + '</div></div>' +
      '<div class="stepper">' +
        '<button type="button" data-step="-1" data-id="' + i.id + '" aria-label="One less ' + esc(i.name) + '"' + (q ? '' : ' disabled') + '>−</button>' +
        '<span class="qty" aria-live="polite">' + (q || '') + '</span>' +
        '<button type="button" class="plus" data-step="1" data-id="' + i.id + '" aria-label="One more ' + esc(i.name) + '">+</button>' +
      '</div></div>';
  }
  function paintRow(id) {
    var i = S.items.find(function (x) { return x.id === id; }), row = document.getElementById('row-' + id);
    if (i && row) row.outerHTML = itemRowHtml(i);
  }
  function paintItems() {
    var q = takeFilter.q.trim().toLowerCase(), cat = takeFilter.cat, lastCat = null, html = '';
    var list = S.items.filter(function (i) {
      return (!cat || i.category === cat) && (!q || (i.name + ' ' + i.category).toLowerCase().indexOf(q) >= 0);
    });
    list.forEach(function (i) {
      if (!cat && i.category !== lastCat) { html += '<div class="cat-head">' + esc(i.category) + '</div>'; lastCat = i.category; }
      html += itemRowHtml(i);
    });
    if (!S.items.length) html = '<div class="empty">No items have been set up yet.' + (isAdmin() ? ' <a href="#/stock">Add items</a> or <a href="#/import">import a list</a>.' : '') + '</div>';
    else if (!list.length) html = '<div class="empty">Nothing matches “' + esc(takeFilter.q) + '”.<br>Can\'t find it? Use <a href="#/chat">Chat</a> to tell the manager.</div>';
    qs('#itemList').innerHTML = html;
  }
  function cartLines() {
    return Object.keys(S.cart).map(function (id) { return { item: S.items.find(function (i) { return i.id === id; }), qty: S.cart[id] }; })
      .filter(function (l) { return l.item; });
  }
  function paintCart() {
    var lines = cartLines(), units = lines.reduce(function (s, l) { return s + l.qty; }, 0);
    qs('#cartBar').innerHTML = lines.length ?
      '<button class="btn btn-primary btn-lg" type="button"><span>Review ' + plural(lines.length, 'item') + ' (' + units + ')</span><span>→</span></button>' : '';
  }
  function openReview() {
    var lines = cartLines(); if (!lines.length) return;
    var w = sheet({
      title: 'Check and confirm',
      body:
        '<table class="table"><thead><tr><th>Item</th><th class="num">Qty</th></tr></thead><tbody>' +
        lines.map(function (l) { return '<tr><td>' + esc(l.item.name) + '<div class="small text-muted">' + esc(l.item.unit) + '</div></td><td class="num fs-5 fw-bold">' + l.qty + '</td></tr>'; }).join('') +
        '</tbody></table>' +
        '<label class="form-label mt-3" for="takeNote">Note <span class="fw-normal text-muted">(optional)</span></label>' +
        '<input class="form-control" id="takeNote" maxlength="200" placeholder="e.g. vehicle, job, who it\'s for">' +
        '<p class="small text-muted mt-2 mb-0">Logged as <b>' + esc(S.me.name) + '</b> · ' + when(new Date().toISOString()) + '</p>',
      foot: '<button class="btn btn-outline-secondary" data-close>Back</button><button class="btn btn-success btn-lg" id="takeGo">' + I.check.replace('<svg', '<svg width="20" height="20"') + ' Log these items</button>'
    });
    qs('#takeGo', w).addEventListener('click', async function (e) {
      var btn = e.currentTarget; btn.disabled = true;
      var payload = lines.map(function (l) { return { item_id: l.item.id, qty: l.qty }; });
      var note = qs('#takeNote', w).value.trim();
      try {
        await call('take_items', { p_lines: payload, p_note: note || null });
        closeSheet(); showDone(lines, false);
      } catch (err) {
        if (err.kind === 'network') {
          var box = outbox();
          var stamp = new Date().toLocaleString('en-AU', { timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
          box.push({ staff_id: S.me.id, lines: payload, note: ((note ? note + ' ' : '') + '(logged offline ' + stamp + ')').trim() });
          LS.set('outbox', box); updateOfflineBanner(); closeSheet(); showDone(lines, true);
        } else { btn.disabled = false; errToast(err); }
      }
    });
  }
  function showDone(lines, offline) {
    S.cart = {};
    render('<div class="done-screen">' +
      '<div class="done-tick">' + I.check + '</div>' +
      '<h4 class="text-center">' + (offline ? 'Saved on this phone' : 'Logged — thanks, ' + esc(S.me.name.split(' ')[0]) + '!') + '</h4>' +
      (offline ? '<p class="text-center">No signal right now. It will send automatically when you\'re back online.</p>' : '') +
      '<ul class="list-unstyled my-3">' + lines.map(function (l) { return '<li><b>' + l.qty + ' ×</b> ' + esc(l.item.name) + '</li>'; }).join('') + '</ul>' +
      '<div class="d-grid gap-2" style="max-width:340px;margin:0 auto">' +
        '<a class="btn btn-primary btn-lg" href="#/take" id="again">Take something else</a>' +
        '<a class="btn btn-outline-secondary" href="#/history">See my history</a>' +
      '</div></div>');
    qs('#again').addEventListener('click', function (e) { e.preventDefault(); route(); });
  }

  // ------------------------------------------------------------------
  //  MY HISTORY
  // ------------------------------------------------------------------
  async function viewHistory() {
    loading();
    var rows = await call('my_history', { p_limit: 100 });
    var pend = outbox().filter(function (j) { return S.me && j.staff_id === S.me.id; });
    var lastDay = null, html = '';
    rows.forEach(function (r) {
      var d = dayKey(r.created_at);
      if (d !== lastDay) { html += '<div class="cat-head">' + esc(d === todayKey() ? 'Today' : fmtDay(r.created_at)) + '</div>'; lastDay = d; }
      html += '<div class="list-row" style="border:1px solid var(--qr-line);border-radius:.5rem;margin-bottom:.4rem">' +
        '<div class="grow"><div class="ttl"' + (r.undone ? ' style="text-decoration:line-through;opacity:.6"' : '') + '>' + r.qty + ' × ' + esc(r.item) + '</div>' +
        '<div class="sub">' + fmtTime(r.created_at) + (r.note ? ' · ' + esc(r.note) : '') + (r.undone ? ' · undone' : '') + '</div></div>' +
        (r.can_undo ? '<button class="btn btn-sm btn-outline-danger" data-undo="' + r.id + '">Undo</button>' : '') + '</div>';
    });
    render('<div class="page-title"><h4>My history</h4></div>' +
      (pend.length ? '<div class="alert alert-warning">' + plural(pend.length, 'take') + ' saved on this phone, waiting for signal to send.</div>' : '') +
      '<p class="small text-muted">Made a mistake? You can undo an entry for 15 minutes. After that, message the manager.</p>' +
      (html || '<div class="empty">You haven\'t logged anything yet.</div>'));
    on($app, 'click', '[data-undo]', async function (e, b) {
      if (!(await confirmSheet('Undo this entry?', '<p>The items will be put back on the shelf count.</p>', 'Undo', true))) return;
      try { await call('undo_take', { p_tx_id: +b.getAttribute('data-undo') }); toast('Entry undone'); viewHistory(); } catch (err) { errToast(err); }
    });
  }

  // ------------------------------------------------------------------
  //  CHAT
  // ------------------------------------------------------------------
  async function viewChatList() {
    loading();
    var c = await call('list_conversations');
    function row(cv, team) {
      var last = cv.last ? (team && cv.last.who ? cv.last.who.split(' ')[0] + ': ' : (cv.last.mine ? 'You: ' : '')) + cv.last.body : (team ? 'Messages to everyone' : 'No messages yet');
      return '<a class="list-row" href="#/chat/' + encodeURIComponent(cv.key) + '">' +
        '<span class="avatar' + (team ? ' admin' : (cv.role === 'admin' ? ' admin' : '')) + '">' + (team ? '👥' : esc(initials(cv.name))) + '</span>' +
        '<div class="grow"><div class="ttl">' + esc(cv.name) + (cv.role === 'admin' ? ' <span class="badge bg-navy">Manager</span>' : '') + '</div>' +
        '<div class="sub">' + esc(last) + '</div></div>' +
        '<div class="text-end">' + (cv.last ? '<div class="small text-muted">' + esc(ago(cv.last.at)) + '</div>' : '') +
        (cv.unread ? '<span class="badge bg-danger">' + cv.unread + '</span>' : '') + '</div></a>';
    }
    render(msgTabs('chat') +
      '<div class="list mb-3">' + row(c.team, true) + '</div>' +
      '<div class="section-title">' + (isAdmin() ? 'Direct messages' : 'Message a manager') + '</div>' +
      (c.people.length ? '<div class="list">' + c.people.map(function (p) { return row(p, false); }).join('') + '</div>' : '<div class="empty">No one to message yet.</div>'));
    var t = setInterval(async function () {
      try { var n = await call('list_conversations', null, { bg: true }); if (JSON.stringify(n) !== JSON.stringify(c)) viewChatList(); } catch (_) {}
    }, 12000);
    S.viewCleanup = function () { clearInterval(t); };
  }

  async function viewChat(key) {
    var c = await call('list_conversations');
    var conv = key === 'team' ? c.team : c.people.find(function (p) { return p.key === key; });
    if (!conv) { toast('Conversation not found', true); location.hash = '#/chat'; return; }
    var lastId = 0, lastDay = null;
    render('<div class="chat-wrap">' +
      '<div class="chat-head"><a href="#/chat" class="btn btn-sm btn-outline-secondary" aria-label="Back" style="width:40px">' + I.back + '</a>' +
      '<span class="avatar' + (key === 'team' || conv.role === 'admin' ? ' admin' : '') + '">' + (key === 'team' ? '👥' : esc(initials(conv.name))) + '</span>' +
      '<div><div class="fw-bold">' + esc(conv.name) + '</div><div class="small text-muted">' + (key === 'team' ? 'Everyone sees these messages' : 'Private conversation') + '</div></div></div>' +
      '<div class="chat-scroll" id="chatScroll"><div class="empty" id="chatEmpty">No messages yet — say hello 👋</div></div>' +
      '<form class="chat-input" id="chatForm"><textarea class="form-control" id="chatText" rows="1" maxlength="2000" placeholder="Type a message…" aria-label="Message"></textarea>' +
      '<button class="btn btn-primary" aria-label="Send" style="width:56px">' + I.send + '</button></form></div>');
    var box = qs('#chatScroll'), ta = qs('#chatText');
    function fit() {
      var wrap = qs('.chat-wrap'); if (!wrap) return;
      var navH = $nav.classList.contains('d-none') ? 0 : $nav.getBoundingClientRect().height;
      wrap.style.height = Math.max(260, window.innerHeight - wrap.getBoundingClientRect().top - navH - 12) + 'px';
    }
    window.scrollTo(0, 0); fit();
    window.addEventListener('resize', fit);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fit);

    function add(msgs) {
      if (!msgs.length) return;
      var empty = qs('#chatEmpty'); if (empty) empty.remove();
      var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120 || lastId === 0;
      var html = '';
      msgs.forEach(function (m) {
        if (m.id <= lastId) return;
        var d = dayKey(m.created_at);
        if (d !== lastDay) { html += '<div class="day-sep">' + (d === todayKey() ? 'Today' : esc(fmtDay(m.created_at))) + '</div>'; lastDay = d; }
        html += '<div class="bubble' + (m.mine ? ' mine' : '') + '">' + (key === 'team' && !m.mine ? '<div class="who">' + esc(m.who) + '</div>' : '') +
          esc(m.body) + '<div class="at">' + fmtTime(m.created_at) + '</div></div>';
        lastId = Math.max(lastId, m.id);
      });
      box.insertAdjacentHTML('beforeend', html);
      if (nearBottom) box.scrollTop = box.scrollHeight;
    }
    async function poll() { try { add(await call('get_messages', { p_with: key, p_after: lastId }, { bg: true })); } catch (_) {} }
    add(await call('get_messages', { p_with: key, p_after: 0 }));
    pulse();
    var timer = setInterval(poll, 4000);
    S.viewCleanup = function () {
      clearInterval(timer); window.removeEventListener('resize', fit);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', fit);
    };

    ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer:fine)').matches) { e.preventDefault(); qs('#chatForm').requestSubmit(); }
    });
    qs('#chatForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var body = ta.value.trim(); if (!body) return;
      ta.value = ''; ta.style.height = '';
      try { await call('send_message', { p_to: key, p_body: body }); await poll(); box.scrollTop = box.scrollHeight; }
      catch (err) { ta.value = body; errToast(err); }
    });
  }

  // ------------------------------------------------------------------
  //  ME
  // ------------------------------------------------------------------
  function viewMe() {
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    render('<div class="page-title"><h4>My account</h4></div>' +
      '<div class="card mb-3"><div class="card-body d-flex align-items-center gap-3">' +
        '<span class="avatar' + (isAdmin() ? ' admin' : '') + '" style="width:3rem;height:3rem;font-size:1.1rem">' + esc(initials(S.me.name)) + '</span>' +
        '<div><div class="fw-bold fs-5">' + esc(S.me.name) + '</div><div class="text-muted">' + (isAdmin() ? 'Manager' : 'Staff') + '</div></div>' +
        '<button class="btn btn-outline-danger ms-auto" id="signOut">Sign out</button></div></div>' +
      '<div class="card mb-3"><div class="card-header">Change my PIN</div><div class="card-body">' +
        '<form id="pinForm" class="row g-2">' +
          '<div class="col-6"><label class="form-label" for="oldPin">Current PIN</label><input class="form-control" id="oldPin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" required></div>' +
          '<div class="col-6"><label class="form-label" for="newPin">New PIN</label><input class="form-control" id="newPin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" required></div>' +
          '<div class="col-12"><button class="btn btn-primary">Change PIN</button></div></form></div></div>' +
      '<div class="card mb-3"><div class="card-header">Put KRD Stores on your home screen</div><div class="card-body">' +
        (ios ? '<p class="mb-0">In <b>Safari</b>, tap the <b>Share</b> button (square with an arrow), then <b>Add to Home Screen</b>.</p>'
             : '<p class="mb-0">In <b>Chrome</b>, tap the <b>⋮</b> menu, then <b>Install app</b> or <b>Add to Home screen</b>.</p>') +
        '<p class="small text-muted mt-2 mb-0">It then opens like a normal app, and you stay signed in.</p></div></div>' +
      (api.isDemo ? '<div class="card mb-3"><div class="card-header">Demo mode</div><div class="card-body"><p>This is a demo running only on this device. Nothing is shared.</p>' +
        '<button class="btn btn-outline-danger" id="resetDemo">Reset demo data</button></div></div>' : '') +
      '<p class="small text-muted text-center">KRD Stores · Kippa Ring Depot</p>');
    qs('#signOut').addEventListener('click', async function () {
      try { await call('logout'); } catch (_) {}
      signOutLocal(); location.hash = '#/'; route();
    });
    qs('#pinForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      try { await call('change_my_pin', { p_old: qs('#oldPin').value, p_new: qs('#newPin').value }); toast('PIN changed'); e.target.reset(); }
      catch (err) { errToast(err); }
    });
    var rd = qs('#resetDemo');
    if (rd) rd.addEventListener('click', function () { window.KRDDemo.reset(); signOutLocal(); LS.del('lastPerson'); location.hash = '#/'; route(); });
  }

  // ------------------------------------------------------------------
  //  ADMIN HOME
  // ------------------------------------------------------------------
  function kindLabel(k) { return { take: 'Taken', receive: 'Received', adjust: 'Adjusted', stocktake: 'Stocktake', undo: 'Undo' }[k] || k; }
  function kindBadge(k) { return { take: 'bg-primary', receive: 'bg-success', adjust: 'bg-warning', stocktake: 'bg-info', undo: 'bg-secondary' }[k] || 'bg-secondary'; }
  function reorderText(low) {
    return 'Kippa Ring Depot Stores — reorder list ' + fmtDate(new Date().toISOString()) + '\n\n' +
      low.map(function (i) { return '• ' + i.name + (i.code ? ' [' + i.code + ']' : '') + ' — order ' + i.suggest + ' ' + i.unit + ' (on hand ' + i.on_hand + ', par ' + i.par + ')'; }).join('\n');
  }

  async function viewHome() {
    loading();
    var d = await call('admin_dashboard');
    S.pulse.low = d.low.length; renderNav();
    render(
      '<div id="bcBanner"></div>' +
      '<div class="page-title"><h4>G\'day, ' + esc(S.me.name.split(' ')[0]) + '</h4><span class="small text-muted">' + esc(fmtDay(new Date().toISOString())) + '</span></div>' +
      '<div class="tiles mb-3">' +
        '<a class="tile' + (d.low.length ? ' is-alert' : '') + '" href="#/stock?low"><div class="tile-n">' + d.low.length + '</div><div class="tile-l">To reorder</div></a>' +
        '<a class="tile" href="#/reports"><div class="tile-n">' + d.today_takes + '</div><div class="tile-l">Taken today</div></a>' +
        '<a class="tile' + (d.unexported ? ' is-warn' : '') + '" href="#/tracks"><div class="tile-n">' + d.unexported + '</div><div class="tile-l">To enter in TRACKS</div></a>' +
      '</div>' +
      (d.open_stocktake ? '<div class="alert alert-info d-flex align-items-center justify-content-between gap-2"><span>A stocktake is in progress.</span><a class="btn btn-sm btn-primary" href="#/count">Continue</a></div>' : '') +
      '<div class="action-grid mb-3">' +
        '<a class="action primary" href="#/take">' + I.take + 'Take items</a>' +
        '<a class="action" href="#/receive">' + I.truck + 'Receive delivery</a>' +
        '<a class="action" href="#/count">' + I.count + 'Stocktake</a>' +
        '<a class="action" href="#/tracks">' + I.export + 'TRACKS entry</a>' +
        '<a class="action" href="#/broadcasts/new" style="grid-column:1/-1">' + I.megaphone + 'Send a TOI broadcast</a>' +
      '</div>' +
      '<div class="card mb-3"><div class="card-header d-flex justify-content-between align-items-center"><span>Reorder list</span>' +
        (d.low.length ? '<span class="d-flex gap-1"><button class="btn btn-sm btn-outline-primary" id="copyOrder">' + 'Copy</button><button class="btn btn-sm btn-outline-primary" id="csvOrder">CSV</button></span>' : '') + '</div>' +
        (d.low.length ?
          '<div class="table-responsive"><table class="table table-stack"><thead><tr><th>Item</th><th class="num">On hand</th><th class="num">Par</th><th class="num">Order</th></tr></thead><tbody>' +
          d.low.map(function (i) {
            return '<tr><td>' + esc(i.name) + '</td><td class="num text-danger fw-bold" data-label="On hand">' + i.on_hand + '</td><td class="num" data-label="Par">' + i.par +
              '</td><td class="num fw-bold" data-label="Order">' + i.suggest + ' ' + esc(i.unit) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
          : '<div class="card-body text-success fw-bold">' + I.check.replace('<svg', '<svg width="20" height="20"') + ' Everything is above par.</div>') +
      '</div>' +
      '<div class="section-title">Recent activity</div>' +
      (d.recent.length ? '<div class="list">' + d.recent.slice(0, 15).map(function (t) {
        return '<div class="list-row"><span class="badge ' + kindBadge(t.kind) + '" style="min-width:5.6rem">' + kindLabel(t.kind) + '</span>' +
          '<div class="grow"><div class="ttl"' + (t.undone ? ' style="text-decoration:line-through;opacity:.6"' : '') + '>' + Math.abs(t.qty) + ' × ' + esc(t.item) + '</div>' +
          '<div class="sub">' + esc(t.who || '—') + ' · ' + esc(when(t.created_at)) + (t.note ? ' · ' + esc(t.note) : '') + '</div></div></div>';
      }).join('') + '</div><div class="text-center mt-2"><a href="#/reports">See all activity →</a></div>' : '<div class="empty">No activity yet.</div>'));
    paintBroadcastBanner();
    var co = qs('#copyOrder'); if (co) co.addEventListener('click', function () { copyText(reorderText(d.low)); });
    var cc = qs('#csvOrder'); if (cc) cc.addEventListener('click', function () {
      download('KRD-reorder-' + todayKey() + '.csv', toCsv([['Item', 'Code', 'Category', 'Unit', 'On hand', 'Par', 'Suggested order']].concat(
        d.low.map(function (i) { return [i.name, i.code || '', i.category, i.unit, i.on_hand, i.par, i.suggest]; }))));
    });
  }

  // ------------------------------------------------------------------
  //  MORE (admin menu)
  // ------------------------------------------------------------------
  function viewMore() {
    function row(href, icon, t, s) { return '<a class="list-row" href="' + href + '"><span style="width:26px;color:var(--qr-light-blue)">' + icon + '</span><div class="grow"><div class="ttl">' + t + '</div><div class="sub">' + s + '</div></div><span class="text-muted">›</span></a>'; }
    render('<div class="page-title"><h4>More</h4></div>' +
      '<div class="list mb-3">' +
        row('#/broadcasts', I.megaphone, 'TOI Broadcasts', 'Notices to everyone, with PDFs & photos') +
        row('#/receive', I.truck, 'Receive a delivery', 'Add stock that has arrived') +
        row('#/tracks', I.export, 'TRACKS entry', 'Everything taken since you last entered it') +
        row('#/reports', I.chart, 'Reports', 'Usage by item and by person, CSV export') +
        row('#/stock', I.stock, 'Items & par levels', 'Add, edit, adjust stock') +
        row('#/import', I.upload, 'Import items', 'Paste your list from Excel') +
      '</div><div class="list mb-3">' +
        row('#/staff', I.users, 'Staff', 'Add people, reset PINs') +
        row('#/settings', I.gear, 'Settings', 'Reorder emails and daily summary') +
        row('#/history', I.history, 'My takes', 'What you have logged yourself') +
        row('#/me', I.me, 'My account', 'Change PIN, sign out, install app') +
      '</div>');
  }

  // ------------------------------------------------------------------
  //  STOCK (items & par)
  // ------------------------------------------------------------------
  var stockFilter = { q: '', low: false };
  async function viewStock(lowParam) {
    if (lowParam) stockFilter.low = true;
    loading();
    var items = await call('list_items');
    S.items = items;
    render('<div class="page-title"><h4>Items & stock</h4><button class="btn btn-primary" id="addItem">' + '+ Add item</button></div>' +
      '<div class="search-bar"><input class="form-control mb-2" id="sSearch" type="search" placeholder="Search items…" value="' + esc(stockFilter.q) + '">' +
      '<div class="seg mb-1"><button data-f="all" class="' + (stockFilter.low ? '' : 'active') + '">All (' + items.length + ')</button>' +
      '<button data-f="low" class="' + (stockFilter.low ? 'active' : '') + '">At or below par (' + items.filter(function (i) { return i.low; }).length + ')</button></div></div>' +
      '<div id="stockList"></div>' +
      '<div class="d-flex gap-2 mt-3 flex-wrap"><a class="btn btn-outline-primary" href="#/import">' + 'Import list</a>' +
      '<button class="btn btn-outline-primary" id="expItems">Download items CSV</button></div>');
    function paint() {
      var q = stockFilter.q.toLowerCase(), lastCat = null, html = '';
      var list = items.filter(function (i) { return (!stockFilter.low || i.low) && (!q || (i.name + ' ' + i.category + ' ' + (i.code || '')).toLowerCase().indexOf(q) >= 0); });
      list.forEach(function (i) {
        if (i.category !== lastCat) { if (lastCat !== null) html += '</div>'; html += '<div class="cat-head">' + esc(i.category) + '</div><div class="list">'; lastCat = i.category; }
        var pct = i.par > 0 ? Math.min(100, Math.round(i.on_hand / (Math.max(i.order_up_to || i.par * 2, 1)) * 100)) : 100;
        html += '<button class="list-row" data-edit="' + i.id + '"><div class="grow"><div class="ttl">' + esc(i.name) + '</div>' +
          '<div class="sub">' + esc(i.unit) + (i.code ? ' · ' + esc(i.code) : '') + ' · par ' + i.par + '</div>' +
          (i.par > 0 ? '<div class="low-bar' + (i.low ? ' is-low' : '') + '"><span style="width:' + Math.max(pct, 3) + '%"></span></div>' : '') + '</div>' +
          '<div class="text-end"><div class="fs-4 fw-bold' + (i.low ? ' text-danger' : '') + '" style="line-height:1">' + i.on_hand + '</div>' +
          (i.low ? '<span class="badge bg-danger">Order ' + i.suggest + '</span>' : '<div class="small text-muted">on hand</div>') + '</div></button>';
      });
      if (lastCat !== null) html += '</div>';
      qs('#stockList').innerHTML = html || '<div class="empty">' + (items.length ? 'Nothing matches.' : 'No items yet. Add one or import your list.') + '</div>';
    }
    paint();
    qs('#sSearch').addEventListener('input', debounce(function (e) { stockFilter.q = e.target.value; paint(); }, 120));
    on($app, 'click', '[data-f]', function (e, b) { stockFilter.low = b.getAttribute('data-f') === 'low'; qsa('[data-f]').forEach(function (x) { x.classList.toggle('active', x === b); }); paint(); });
    on($app, 'click', '[data-edit]', function (e, b) { editItem(items.find(function (i) { return i.id === b.getAttribute('data-edit'); }), items); });
    qs('#addItem').addEventListener('click', function () { editItem(null, items); });
    qs('#expItems').addEventListener('click', function () {
      download('KRD-items-' + todayKey() + '.csv', toCsv([['name', 'category', 'unit', 'code', 'on_hand', 'par', 'order_up_to', 'max_per_take']].concat(
        items.map(function (i) { return [i.name, i.category, i.unit, i.code || '', i.on_hand, i.par, i.order_up_to == null ? '' : i.order_up_to, i.max_per_take == null ? '' : i.max_per_take]; }))));
    });
  }

  function editItem(item, items) {
    var isNew = !item; item = item || { name: '', category: '', unit: 'each', code: '', on_hand: 0, par: 0, order_up_to: null, max_per_take: null };
    var cats = Array.from(new Set(items.map(function (i) { return i.category; }))).sort();
    var units = Array.from(new Set(['each', 'pack', 'box', 'bottle', 'can', 'pair', 'roll', 'tube'].concat(items.map(function (i) { return i.unit; })))).sort();
    function f(id, label, val, type, extra) {
      return '<div class="' + (extra && extra.col || 'col-12') + '"><label class="form-label" for="' + id + '">' + label + '</label>' +
        '<input class="form-control" id="' + id + '" value="' + esc(val == null ? '' : val) + '" ' + (type === 'num' ? 'type="number" inputmode="numeric" min="0" step="1"' : 'type="text"') +
        (extra && extra.list ? ' list="' + extra.list + '"' : '') + (extra && extra.req ? ' required' : '') + '>' + (extra && extra.help ? '<div class="form-text">' + extra.help + '</div>' : '') + '</div>';
    }
    var w = sheet({
      title: isNew ? 'Add item' : 'Edit item',
      body: '<form id="itemForm" class="row g-3">' +
        f('iName', 'Item name', item.name, 'text', { req: true }) +
        f('iCat', 'Category', item.category, 'text', { col: 'col-6', list: 'catList' }) +
        f('iUnit', 'Unit', item.unit, 'text', { col: 'col-6', list: 'unitList' }) +
        f('iOn', 'On hand now', item.on_hand, 'num', { col: 'col-6' }) +
        f('iPar', 'Par level', item.par, 'num', { col: 'col-6', help: 'Reorder alert at or below this' }) +
        f('iUpTo', 'Order up to', item.order_up_to, 'num', { col: 'col-6', help: 'Blank = 2 × par' }) +
        f('iMax', 'Max per take', item.max_per_take, 'num', { col: 'col-6', help: 'Blank = no limit' }) +
        f('iCode', 'TRACKS / supplier code', item.code, 'text', { help: 'Optional — shown on the TRACKS entry sheet' }) +
        '<div class="col-12 d-none" id="adjWrap"><label class="form-label" for="iAdj">Reason for stock change</label><input class="form-control" id="iAdj" placeholder="e.g. found extra, damaged, correction"></div>' +
        '<datalist id="catList">' + cats.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>' +
        '<datalist id="unitList">' + units.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>' +
        '</form>',
      foot: (isNew ? '' : '<button class="btn btn-outline-danger me-auto" id="iArchive">Remove</button>') +
        '<button class="btn btn-outline-secondary" data-close>Cancel</button><button class="btn btn-primary" id="iSave">Save</button>'
    });
    var onIn = qs('#iOn', w);
    if (!isNew) onIn.addEventListener('input', function () { qs('#adjWrap', w).classList.toggle('d-none', int(onIn.value) === item.on_hand); });
    qs('#iSave', w).addEventListener('click', async function () {
      var form = qs('#itemForm', w); if (!form.reportValidity()) return;
      try {
        await call('save_item', { p_item: {
          id: isNew ? null : item.id, name: qs('#iName', w).value, category: qs('#iCat', w).value, unit: qs('#iUnit', w).value,
          code: qs('#iCode', w).value, on_hand: int(onIn.value) || 0, par: int(qs('#iPar', w).value) || 0,
          order_up_to: int(qs('#iUpTo', w).value), max_per_take: int(qs('#iMax', w).value), adjust_note: qs('#iAdj', w).value } });
        closeSheet(); toast(isNew ? 'Item added' : 'Saved'); route();
      } catch (err) { errToast(err); }
    });
    var ar = qs('#iArchive', w);
    if (ar) ar.addEventListener('click', async function () {
      if (!(await confirmSheet('Remove ' + item.name + '?', '<p>It will disappear from the list. Its history stays in reports.</p>', 'Remove', true))) return;
      try { await call('archive_item', { p_item_id: item.id }); toast('Removed'); route(); } catch (err) { errToast(err); }
    });
  }

  // ------------------------------------------------------------------
  //  IMPORT ITEMS (paste from Excel / CSV)
  // ------------------------------------------------------------------
  var HEADS = {
    name: /^(item|item ?name|name|description|product)$/,
    category: /^(category|cat|group|type)$/,
    unit: /^(unit|uom|unit of measure|units)$/,
    code: /^(code|sku|tracks ?code|item ?code|part ?(no|number)|supplier ?code)$/,
    on_hand: /^(on ?hand|soh|stock|qty|quantity|stock on hand|current)$/,
    par: /^(par|par ?level|min|minimum|reorder ?(point|level)?)$/,
    order_up_to: /^(order ?up ?to|max|maximum|target)$/,
    max_per_take: /^(max ?per ?take|limit|take ?limit)$/
  };
  function parseTable(text) {
    var lines = text.replace(/\r/g, '').split('\n').filter(function (l) { return l.trim(); });
    if (!lines.length) return { rows: [], cols: [] };
    var delim = lines[0].indexOf('\t') >= 0 ? '\t' : ',';
    function split(line) {
      if (delim === '\t') return line.split('\t');
      var out = [], cur = '', q = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
        else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
      }
      out.push(cur); return out;
    }
    var head = split(lines[0]).map(function (h) { return h.trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' '); });
    var cols = head.map(function (h) { for (var k in HEADS) if (HEADS[k].test(h)) return k; return null; });
    var hasHeader = cols.indexOf('name') >= 0;
    if (!hasHeader) cols = ['name', 'category', 'unit', 'on_hand', 'par', 'order_up_to', 'code', 'max_per_take'];
    var rows = (hasHeader ? lines.slice(1) : lines).map(function (l) {
      var cells = split(l), r = {};
      cols.forEach(function (c, i) {
        if (!c) return; var v = (cells[i] || '').trim();
        if (/^(on_hand|par|order_up_to|max_per_take)$/.test(c)) { v = v === '' ? null : int(v.replace(/[^\d\-]/g, '')); }
        r[c] = v;
      });
      return r;
    }).filter(function (r) { return r.name; });
    return { rows: rows, cols: cols.filter(Boolean), hasHeader: hasHeader };
  }
  function viewImport() {
    render('<div class="page-title"><h4>Import items</h4></div>' +
      '<div class="alert alert-info"><b>Easiest way:</b> select your list in Excel (including the heading row) → Copy → paste below.<br>' +
      'Recognised headings: <b>Item</b>, Category, Unit, Code, On hand, Par, Order up to, Max per take. Only <b>Item</b> is required.<br>' +
      'Items that already exist (same name) are <b>updated</b>; blank cells keep the current value.</div>' +
      '<textarea class="form-control mb-2" id="impText" rows="9" placeholder="Item\tCategory\tUnit\tOn hand\tPar\nSunscreen 1L\tSun & Bugs\tbottle\t10\t4"></textarea>' +
      '<div class="d-flex gap-2 flex-wrap mb-3"><button class="btn btn-primary" id="impPreview">Preview</button>' +
      '<button class="btn btn-outline-primary" id="impTemplate">Download template</button>' +
      '<label class="btn btn-outline-primary mb-0">Open CSV file<input type="file" accept=".csv,.txt,text/csv" id="impFile" hidden></label></div>' +
      '<div id="impOut"></div>');
    var parsed = null;
    function preview() {
      parsed = parseTable(qs('#impText').value);
      if (!parsed.rows.length) { qs('#impOut').innerHTML = '<div class="alert alert-warning">No rows found. Make sure there is an <b>Item</b> column.</div>'; return; }
      var cols = ['name', 'category', 'unit', 'code', 'on_hand', 'par', 'order_up_to', 'max_per_take'].filter(function (c) { return parsed.cols.indexOf(c) >= 0; });
      var labels = { name: 'Item', category: 'Category', unit: 'Unit', code: 'Code', on_hand: 'On hand', par: 'Par', order_up_to: 'Up to', max_per_take: 'Max/take' };
      var existing = S.items.map(function (i) { return i.name.toLowerCase(); });
      qs('#impOut').innerHTML = (parsed.hasHeader ? '' : '<div class="alert alert-warning">No heading row found — columns were read in the template order.</div>') +
        '<div class="card"><div class="card-header">' + plural(parsed.rows.length, 'row') + ' ready</div><div class="table-responsive"><table class="table table-stack"><thead><tr><th></th>' +
        cols.map(function (c) { return '<th>' + labels[c] + '</th>'; }).join('') + '</tr></thead><tbody>' +
        parsed.rows.map(function (r) {
          var upd = existing.indexOf(String(r.name).toLowerCase()) >= 0;
          return '<tr><td><span class="badge ' + (upd ? 'bg-warning' : 'bg-success') + '">' + (upd ? 'Update' : 'New') + '</span></td>' +
            cols.map(function (c) { return '<td data-label="' + labels[c] + '">' + esc(r[c] == null ? '' : r[c]) + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody></table></div><div class="card-body"><button class="btn btn-success btn-lg w-100" id="impGo">Import ' + plural(parsed.rows.length, 'item') + '</button></div></div>';
      qs('#impGo').addEventListener('click', async function (e) {
        e.currentTarget.disabled = true;
        try { var r = await call('import_items', { p_rows: parsed.rows }); toast(r.added + ' added, ' + r.updated + ' updated'); location.hash = '#/stock'; }
        catch (err) { e.currentTarget.disabled = false; errToast(err); }
      });
    }
    qs('#impPreview').addEventListener('click', preview);
    qs('#impTemplate').addEventListener('click', function () {
      download('KRD-items-template.csv', toCsv([['Item', 'Category', 'Unit', 'Code', 'On hand', 'Par', 'Order up to', 'Max per take'],
        ['Sunscreen SPF50+ 1L pump', 'Sun & Bugs', 'bottle', '', 10, 4, 12, ''], ['Batteries AA (4 pack)', 'Batteries', 'pack', '', 12, 5, 20, 2]]));
    });
    qs('#impFile').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      var rd = new FileReader(); rd.onload = function () { qs('#impText').value = String(rd.result).replace(/^﻿/, ''); preview(); }; rd.readAsText(f);
    });
    if (!S.items.length) call('list_items').then(function (x) { S.items = x; }).catch(function () {});
  }

  // ------------------------------------------------------------------
  //  RECEIVE DELIVERY
  // ------------------------------------------------------------------
  async function viewReceive() {
    loading();
    var items = await call('list_items'), qty = {}, q = '';
    render('<div class="page-title"><h4>Receive a delivery</h4></div>' +
      '<p class="text-muted" style="margin-top:-.5rem">Enter how many of each item arrived. Low items are listed first.</p>' +
      '<div class="search-bar"><input class="form-control" id="rSearch" type="search" placeholder="Search items…"></div>' +
      '<div id="rList" class="item-list"></div>' +
      '<div class="cart-bar" id="rBar"></div>');
    var sorted = items.slice().sort(function (a, b) { return (b.low - a.low) || a.name.localeCompare(b.name); });
    function paint() {
      var ql = q.toLowerCase();
      qs('#rList').innerHTML = sorted.filter(function (i) { return !ql || i.name.toLowerCase().indexOf(ql) >= 0; }).map(function (i) {
        return '<div class="count-row' + (qty[i.id] ? ' is-counted' : '') + '"><div class="grow"><div class="item-name">' + esc(i.name) + '</div>' +
          '<div class="item-meta">' + esc(i.unit) + ' · on hand ' + i.on_hand + (i.low ? ' · <span class="text-danger fw-bold">suggest ' + i.suggest + '</span>' : '') + '</div></div>' +
          '<input class="form-control" type="number" inputmode="numeric" min="0" placeholder="0" data-r="' + i.id + '" value="' + (qty[i.id] || '') + '" aria-label="Received ' + esc(i.name) + '"></div>';
      }).join('') || '<div class="empty">No items.</div>';
    }
    function bar() {
      var n = Object.keys(qty).length;
      qs('#rBar').innerHTML = n ? '<button class="btn btn-success btn-lg" type="button"><span>Save delivery (' + plural(n, 'line') + ')</span><span>→</span></button>' : '';
    }
    paint(); bar();
    qs('#rSearch').addEventListener('input', debounce(function (e) { q = e.target.value; paint(); }, 120));
    on($app, 'input', '[data-r]', function (e, inp) {
      var v = int(inp.value); if (v > 0) qty[inp.getAttribute('data-r')] = v; else delete qty[inp.getAttribute('data-r')];
      inp.closest('.count-row').classList.toggle('is-counted', v > 0); bar();
    });
    qs('#rBar').addEventListener('click', function (e) {
      if (!e.target.closest('button')) return;
      var lines = Object.keys(qty).map(function (id) { return { item: items.find(function (i) { return i.id === id; }), qty: qty[id] }; });
      var w = sheet({ title: 'Confirm delivery',
        body: '<table class="table"><thead><tr><th>Item</th><th class="num">Received</th></tr></thead><tbody>' +
          lines.map(function (l) { return '<tr><td>' + esc(l.item.name) + '</td><td class="num fw-bold">+' + l.qty + ' ' + esc(l.item.unit) + '</td></tr>'; }).join('') + '</tbody></table>' +
          '<label class="form-label mt-3" for="rNote">Delivery note <span class="fw-normal text-muted">(optional)</span></label><input class="form-control" id="rNote" placeholder="e.g. supplier, docket number">',
        foot: '<button class="btn btn-outline-secondary" data-close>Back</button><button class="btn btn-success" id="rGo">Add to stock</button>' });
      qs('#rGo', w).addEventListener('click', async function (ev) {
        ev.currentTarget.disabled = true;
        try {
          await call('receive_stock', { p_lines: lines.map(function (l) { return { item_id: l.item.id, qty: l.qty }; }), p_note: qs('#rNote', w).value });
          closeSheet(); toast('Delivery added to stock'); location.hash = '#/stock';
        } catch (err) { ev.currentTarget.disabled = false; errToast(err); }
      });
    });
  }

  // ------------------------------------------------------------------
  //  BLIND STOCKTAKE
  // ------------------------------------------------------------------
  async function viewCount() {
    loading();
    var st = await call('get_stocktake');
    if (!st) return viewCountStart();
    var filter = { q: '', uncounted: false }, pending = {};
    function counted() { return st.items.filter(function (i) { return i.counted != null; }).length; }
    render('<div class="page-title"><h4>Stocktake</h4><span class="badge bg-info">Blind count</span></div>' +
      '<div class="card mb-2"><div class="card-body py-2">' +
        '<div class="d-flex justify-content-between small fw-bold mb-1"><span id="cProg"></span><span class="text-muted">Started ' + esc(when(st.started_at)) + (st.started_by ? ' by ' + esc(st.started_by) : '') + '</span></div>' +
        '<div class="progress"><div class="progress-bar" id="cBar"></div></div>' +
        (st.note ? '<div class="small text-muted mt-1">' + esc(st.note) + '</div>' : '') +
      '</div></div>' +
      '<div class="search-bar"><input class="form-control mb-2" id="cSearch" type="search" placeholder="Search items…">' +
        '<div class="seg mb-1"><button data-cf="all" class="active">All</button><button data-cf="todo">Not counted yet</button></div></div>' +
      '<p class="small text-muted mb-2">Count what is physically on the shelf. System quantities are hidden until you finish. Counts save automatically.</p>' +
      '<div id="cList" class="item-list"></div>' +
      '<div class="d-grid gap-2 mt-3"><button class="btn btn-success btn-lg" id="cFinish">Finish & see results</button>' +
      '<button class="btn btn-link text-danger" id="cCancel">Cancel this stocktake</button></div>');
    function prog() {
      var n = counted(), t = st.items.length;
      qs('#cProg').textContent = n + ' of ' + t + ' counted';
      qs('#cBar').style.width = (t ? Math.round(n / t * 100) : 0) + '%';
    }
    function paint() {
      var q = filter.q.toLowerCase(), lastCat = null, html = '';
      st.items.filter(function (i) { return (!filter.uncounted || i.counted == null) && (!q || i.name.toLowerCase().indexOf(q) >= 0); }).forEach(function (i) {
        if (i.category !== lastCat) { html += '<div class="cat-head">' + esc(i.category) + '</div>'; lastCat = i.category; }
        html += '<div class="count-row' + (i.counted != null ? ' is-counted' : '') + '" id="c-' + i.id + '"><div class="grow"><div class="item-name">' + esc(i.name) + '</div><div class="item-meta">' + esc(i.unit) + ' <span data-state></span></div></div>' +
          '<input class="form-control" type="number" inputmode="numeric" min="0" step="1" placeholder="–" data-c="' + i.id + '" value="' + (i.counted == null ? '' : i.counted) + '" aria-label="Count for ' + esc(i.name) + '"></div>';
      });
      qs('#cList').innerHTML = html || '<div class="empty">' + (filter.uncounted ? 'Everything has been counted 🎉' : 'Nothing matches.') + '</div>';
      prog();
    }
    var saveCount = async function (id, inp) {
      var raw = inp.value.trim(), v = raw === '' ? null : int(raw);
      if (raw !== '' && (v == null || v < 0)) { toast('Enter a whole number', true); return; }
      var row = qs('#c-' + id), stEl = row && qs('[data-state]', row);
      if (stEl) stEl.textContent = '· saving…';
      try {
        await call('save_count', { p_stocktake_id: st.id, p_item_id: id, p_counted: v });
        var it = st.items.find(function (i) { return i.id === id; }); it.counted = v;
        if (row) row.classList.toggle('is-counted', v != null);
        if (stEl) stEl.textContent = v != null ? '· saved ✓' : '';
        prog();
      } catch (err) { if (stEl) stEl.textContent = '· not saved'; errToast(err); }
      delete pending[id];
    };
    paint();
    qs('#cSearch').addEventListener('input', debounce(function (e) { filter.q = e.target.value; paint(); }, 150));
    on($app, 'click', '[data-cf]', function (e, b) { filter.uncounted = b.getAttribute('data-cf') === 'todo'; qsa('[data-cf]').forEach(function (x) { x.classList.toggle('active', x === b); }); paint(); });
    on($app, 'input', '[data-c]', function (e, inp) {
      var id = inp.getAttribute('data-c'); clearTimeout(pending[id]);
      pending[id] = setTimeout(function () { saveCount(id, inp); }, 700);
    });
    on($app, 'keydown', '[data-c]', function (e, inp) {
      if (e.key !== 'Enter') return; e.preventDefault();
      var all = qsa('[data-c]'), i = all.indexOf(inp); if (all[i + 1]) all[i + 1].focus(); else inp.blur();
    });
    qs('#cFinish').addEventListener('click', async function () {
      // flush pending saves first
      await Promise.all(Object.keys(pending).map(function (id) { clearTimeout(pending[id]); return saveCount(id, qs('[data-c="' + id + '"]')); }));
      var todo = st.items.length - counted();
      var ok = await confirmSheet('Finish stocktake?',
        '<p><b>' + counted() + '</b> of ' + st.items.length + ' items counted.</p>' +
        (todo ? '<div class="alert alert-warning">' + plural(todo, 'item is', 'items are') + ' not counted. Their stock will stay as it is.</div>' : '') +
        '<p class="mb-0">Stock on hand will be updated to your counts (allowing for anything taken while you were counting). You will then see the variances.</p>', 'Finish stocktake');
      if (!ok) return;
      try { await call('complete_stocktake', { p_stocktake_id: st.id }); toast('Stocktake completed'); location.hash = '#/count/' + st.id; }
      catch (err) { errToast(err); }
    });
    qs('#cCancel').addEventListener('click', async function () {
      if (!(await confirmSheet('Cancel stocktake?', '<p>All counts in this stocktake will be thrown away. Stock levels will not change.</p>', 'Cancel stocktake', true))) return;
      try { await call('cancel_stocktake', { p_stocktake_id: st.id }); toast('Stocktake cancelled'); viewCount(); } catch (err) { errToast(err); }
    });
    S.viewCleanup = function () { Object.keys(pending).forEach(function (id) { clearTimeout(pending[id]); var inp = qs('[data-c="' + id + '"]'); if (inp) saveCount(id, inp); }); };
  }

  async function viewCountStart() {
    var past = await call('list_stocktakes');
    render('<div class="page-title"><h4>Stocktake</h4></div>' +
      '<div class="card mb-3"><div class="card-body">' +
        '<h5>Start a blind stocktake</h5>' +
        '<p>You\'ll count each item on the shelf without seeing what the system expects. When you finish, the app shows the variances and updates stock on hand.</p>' +
        '<p class="small text-muted">Staff can keep logging takes while you count — the app allows for them.</p>' +
        '<label class="form-label" for="stNote">Name / note <span class="fw-normal text-muted">(optional)</span></label>' +
        '<input class="form-control mb-3" id="stNote" placeholder="e.g. End of month – November">' +
        '<button class="btn btn-primary btn-lg w-100" id="stStart">Start stocktake</button>' +
      '</div></div>' +
      '<div class="section-title">Previous stocktakes</div>' +
      (past.length ? '<div class="list">' + past.map(function (p) {
        return '<a class="list-row" href="#/count/' + p.id + '"><div class="grow"><div class="ttl">' + esc(p.note || 'Stocktake') + '</div>' +
          '<div class="sub">' + esc(fmtDay(p.started_at)) + ' · ' + plural(p.counted, 'item') + ' counted' + (p.started_by ? ' · ' + esc(p.started_by) : '') + '</div></div>' +
          (p.status === 'cancelled' ? '<span class="badge bg-secondary">Cancelled</span>' : '<span class="badge ' + (p.variances ? 'bg-warning' : 'bg-success') + '">' + plural(p.variances, 'variance') + '</span>') + '</a>';
      }).join('') + '</div>' : '<div class="empty">No stocktakes yet.</div>'));
    qs('#stStart').addEventListener('click', async function () {
      try { await call('start_stocktake', { p_note: qs('#stNote').value }); viewCount(); } catch (err) { errToast(err); }
    });
  }

  async function viewCountReport(id) {
    loading();
    var r = await call('stocktake_report', { p_stocktake_id: id });
    var withVar = r.lines.filter(function (l) { return l.variance !== 0; });
    var net = r.lines.reduce(function (s, l) { return s + l.variance; }, 0);
    function v(n) { return n > 0 ? '<span class="var-pos">+' + n + '</span>' : n < 0 ? '<span class="var-neg">' + n + '</span>' : '<span class="text-muted">0</span>'; }
    render('<div class="page-title"><h4>Stocktake results</h4><a href="#/count" class="small no-print">All stocktakes</a></div>' +
      '<p class="mb-2"><b>' + esc(r.note || 'Stocktake') + '</b> · ' + esc(fmtDay(r.started_at)) +
      (r.status === 'cancelled' ? ' · <span class="badge bg-secondary">Cancelled</span>' : ' · completed ' + esc(when(r.completed_at)) + (r.completed_by ? ' by ' + esc(r.completed_by) : '')) + '</p>' +
      '<div class="tiles mb-3"><div class="tile"><div class="tile-n">' + r.lines.length + '</div><div class="tile-l">Counted</div></div>' +
        '<div class="tile' + (withVar.length ? ' is-warn' : '') + '"><div class="tile-n">' + withVar.length + '</div><div class="tile-l">With variance</div></div>' +
        '<div class="tile' + (net < 0 ? ' is-alert' : '') + '"><div class="tile-n">' + (net > 0 ? '+' : '') + net + '</div><div class="tile-l">Net units</div></div></div>' +
      '<div class="d-flex gap-2 mb-3 no-print flex-wrap"><button class="btn btn-outline-primary" id="rpCsv">Download CSV</button><button class="btn btn-outline-primary" onclick="window.print()">Print</button></div>' +
      (r.lines.length ? '<div class="card mb-3"><div class="table-responsive"><table class="table table-stack"><thead><tr><th>Item</th><th class="num">System</th><th class="num">Counted</th><th class="num">Variance</th></tr></thead><tbody>' +
        r.lines.map(function (l) {
          return '<tr><td>' + esc(l.item) + '<div class="small text-muted fw-normal">' + esc(l.unit) + (l.code ? ' · ' + esc(l.code) : '') + '</div></td>' +
            '<td class="num" data-label="System">' + l.expected + '</td><td class="num fw-bold" data-label="Counted">' + l.counted + '</td><td class="num" data-label="Variance">' + v(l.variance) + '</td></tr>';
        }).join('') + '</tbody></table></div></div>' : '') +
      (r.not_counted.length && r.status !== 'cancelled' ? '<div class="alert alert-secondary"><b>Not counted (unchanged):</b> ' + r.not_counted.map(esc).join(', ') + '</div>' : ''));
    qs('#rpCsv').addEventListener('click', function () {
      download('KRD-stocktake-' + dayKey(r.started_at) + '.csv', toCsv([['Item', 'Code', 'Category', 'Unit', 'System qty', 'Counted', 'Variance', 'Counted by', 'Counted at']].concat(
        r.lines.map(function (l) { return [l.item, l.code || '', l.category, l.unit, l.expected, l.counted, l.variance, l.who || '', when(l.counted_at)]; }))));
    });
  }

  // ------------------------------------------------------------------
  //  TRACKS ENTRY
  // ------------------------------------------------------------------
  async function viewTracks() {
    loading();
    var p = await call('tracks_pending'), detail = false;
    var total = p.by_item.reduce(function (s, r) { return s + r.qty; }, 0);
    function tableHtml() {
      if (!detail) return '<table class="table table-stack"><thead><tr><th>Item</th><th>Code</th><th class="num">Qty</th><th>Unit</th></tr></thead><tbody>' +
        p.by_item.map(function (r) { return '<tr><td>' + esc(r.item) + '</td><td data-label="Code">' + esc(r.code || '—') + '</td><td class="num fw-bold fs-5" data-label="Qty">' + r.qty + '</td><td data-label="Unit">' + esc(r.unit) + '</td></tr>'; }).join('') + '</tbody></table>';
      return '<table class="table table-stack"><thead><tr><th>Item</th><th>When</th><th>Who</th><th class="num">Qty</th><th>Note</th></tr></thead><tbody>' +
        p.lines.map(function (r) { return '<tr><td>' + esc(r.item) + '</td><td data-label="When">' + esc(when(r.created_at)) + '</td><td data-label="Who">' + esc(r.who || '') + '</td><td class="num fw-bold" data-label="Qty">' + r.qty + '</td><td data-label="Note">' + esc(r.note || '') + '</td></tr>'; }).join('') + '</tbody></table>';
    }
    if (!p.by_item.length) {
      render('<div class="page-title"><h4>TRACKS entry</h4></div><div class="done-screen"><div class="done-tick">' + I.check + '</div>' +
        '<h5 class="text-center">All caught up</h5><p class="text-center">Everything taken has been marked as entered into TRACKS.</p></div>');
      return;
    }
    render('<div class="page-title"><h4>TRACKS entry</h4></div>' +
      '<div class="alert alert-info">These takes have <b>not</b> been entered into TRACKS yet. Enter the totals, then press <b>Mark as entered</b> so they don\'t show up again.</div>' +
      '<div class="tiles mb-3" style="grid-template-columns:repeat(2,1fr)"><div class="tile"><div class="tile-n">' + p.by_item.length + '</div><div class="tile-l">Items</div></div>' +
      '<div class="tile"><div class="tile-n">' + total + '</div><div class="tile-l">Units taken since ' + esc(fmtDay(p.lines[0].created_at)) + '</div></div></div>' +
      '<div class="seg"><button data-v="sum" class="active">Totals by item</button><button data-v="det">Every entry</button></div>' +
      '<div class="card mb-3"><div class="table-responsive" id="trTable">' + tableHtml() + '</div></div>' +
      '<div class="d-flex gap-2 flex-wrap mb-3 no-print"><button class="btn btn-outline-primary" id="trCopy">Copy for Excel</button>' +
      '<button class="btn btn-outline-primary" id="trCsv">Download CSV</button><button class="btn btn-outline-primary" onclick="window.print()">Print</button></div>' +
      '<button class="btn btn-success btn-lg w-100 no-print" id="trMark">Mark as entered in TRACKS</button>');
    on($app, 'click', '[data-v]', function (e, b) { detail = b.getAttribute('data-v') === 'det'; qsa('[data-v]').forEach(function (x) { x.classList.toggle('active', x === b); }); qs('#trTable').innerHTML = tableHtml(); });
    function rows() {
      return detail ? [['Date', 'Time', 'Item', 'Code', 'Qty', 'Unit', 'Taken by', 'Note']].concat(p.lines.map(function (r) { return [fmtDate(r.created_at), fmtTime(r.created_at), r.item, r.code || '', r.qty, r.unit, r.who || '', r.note || '']; }))
                    : [['Item', 'Code', 'Qty', 'Unit']].concat(p.by_item.map(function (r) { return [r.item, r.code || '', r.qty, r.unit]; }));
    }
    qs('#trCopy').addEventListener('click', function () { copyText(rows().map(function (r) { return r.join('\t'); }).join('\n')); });
    qs('#trCsv').addEventListener('click', function () { download('KRD-for-TRACKS-' + todayKey() + '.csv', toCsv(rows())); });
    qs('#trMark').addEventListener('click', async function () {
      if (!(await confirmSheet('Mark as entered?', '<p>Mark these <b>' + plural(p.lines.length, 'entry', 'entries') + '</b> (' + total + ' units) as entered into TRACKS?</p><p class="small text-muted mb-0">Anything taken after you opened this page is not included and will show next time.</p>', 'Mark as entered'))) return;
      try { var r = await call('tracks_mark_entered', { p_max_id: p.max_id }); toast(plural(r.marked, 'entry', 'entries') + ' marked'); viewTracks(); } catch (err) { errToast(err); }
    });
  }

  // ------------------------------------------------------------------
  //  REPORTS
  // ------------------------------------------------------------------
  var rep = { from: null, to: null, view: 'item', preset: '30' };
  async function viewReports() {
    if (!rep.from) { rep.to = todayKey(); rep.from = addDays(rep.to, -29); }
    render('<div class="page-title"><h4>Reports</h4></div>' +
      '<div class="seg" id="presets">' + [['0', 'Today'], ['7', '7 days'], ['30', '30 days'], ['m', 'This month'], ['c', 'Custom']].map(function (p) {
        return '<button data-p="' + p[0] + '" class="' + (rep.preset === p[0] ? 'active' : '') + '">' + p[1] + '</button>'; }).join('') + '</div>' +
      '<div class="row g-2 mb-2' + (rep.preset === 'c' ? '' : ' d-none') + '" id="custom"><div class="col-6"><label class="form-label" for="rFrom">From</label><input type="date" class="form-control" id="rFrom" value="' + rep.from + '"></div>' +
      '<div class="col-6"><label class="form-label" for="rTo">To</label><input type="date" class="form-control" id="rTo" value="' + rep.to + '"></div></div>' +
      '<div id="repOut"><div class="empty">Loading…</div></div>');
    on($app, 'click', '[data-p]', function (e, b) {
      var p = b.getAttribute('data-p'), t = todayKey(); rep.preset = p;
      qsa('[data-p]').forEach(function (x) { x.classList.toggle('active', x === b); });
      qs('#custom').classList.toggle('d-none', p !== 'c');
      if (p === '0') { rep.from = rep.to = t; } else if (p === '7') { rep.to = t; rep.from = addDays(t, -6); }
      else if (p === '30') { rep.to = t; rep.from = addDays(t, -29); } else if (p === 'm') { rep.to = t; rep.from = t.slice(0, 8) + '01'; }
      qs('#rFrom').value = rep.from; qs('#rTo').value = rep.to;
      if (p !== 'c') load();
    });
    ['#rFrom', '#rTo'].forEach(function (s) { qs(s).addEventListener('change', function () { rep.from = qs('#rFrom').value; rep.to = qs('#rTo').value; if (rep.from && rep.to) load(); }); });
    async function load() {
      qs('#repOut').innerHTML = '<div class="empty">Loading…</div>';
      try { paint(await call('list_transactions', { p_from: rep.from, p_to: rep.to, p_kind: null })); } catch (err) { errToast(err); }
    }
    function paint(tx) {
      var takes = tx.filter(function (t) { return t.kind === 'take' && !t.undone; });
      var byItem = {}, byWho = {};
      takes.forEach(function (t) {
        var a = byItem[t.item_id] || (byItem[t.item_id] = { item: t.item, unit: t.unit, cat: t.category, qty: 0, n: 0 }); a.qty -= t.qty; a.n++;
        var w = byWho[t.who || '—'] || (byWho[t.who || '—'] = { who: t.who || '—', qty: 0, n: 0, items: {} }); w.qty -= t.qty; w.n++; w.items[t.item] = (w.items[t.item] || 0) - t.qty;
      });
      var items = Object.keys(byItem).map(function (k) { return byItem[k]; }).sort(function (a, b) { return b.qty - a.qty; });
      var who = Object.keys(byWho).map(function (k) { return byWho[k]; }).sort(function (a, b) { return b.qty - a.qty; });
      var max = items.length ? items[0].qty : 1;
      var units = takes.reduce(function (s, t) { return s - t.qty; }, 0);
      var body;
      if (rep.view === 'item') body = items.length ? '<div class="table-responsive"><table class="table table-stack"><thead><tr><th>Item</th><th class="num">Taken</th><th class="num">Times</th><th style="width:30%">&nbsp;</th></tr></thead><tbody>' +
        items.map(function (i) { return '<tr><td>' + esc(i.item) + '</td><td class="num fw-bold" data-label="Taken">' + i.qty + ' ' + esc(i.unit) + '</td><td class="num" data-label="Times">' + i.n + '</td><td class="d-none d-md-table-cell"><div class="low-bar"><span style="width:' + Math.round(i.qty / max * 100) + '%"></span></div></td></tr>'; }).join('') + '</tbody></table></div>' : '<div class="empty">Nothing taken in this period.</div>';
      else if (rep.view === 'who') body = who.length ? '<div class="list">' + who.map(function (w) {
        var top = Object.keys(w.items).sort(function (a, b) { return w.items[b] - w.items[a]; }).slice(0, 4).map(function (k) { return w.items[k] + '× ' + k; }).join(', ');
        return '<div class="list-row"><span class="avatar">' + esc(initials(w.who)) + '</span><div class="grow"><div class="ttl">' + esc(w.who) + '</div><div class="sub">' + esc(top) + '</div></div><div class="text-end"><div class="fw-bold fs-5">' + w.qty + '</div><div class="small text-muted">' + plural(w.n, 'take') + '</div></div></div>';
      }).join('') + '</div>' : '<div class="empty">Nothing taken in this period.</div>';
      else body = tx.length ? '<div class="list">' + tx.map(function (t) {
        return '<div class="list-row"><span class="badge ' + kindBadge(t.kind) + '" style="min-width:5.6rem">' + kindLabel(t.kind) + '</span><div class="grow"><div class="ttl"' + (t.undone ? ' style="text-decoration:line-through;opacity:.6"' : '') + '>' + (t.qty > 0 ? '+' : '') + t.qty + ' ' + esc(t.item) + '</div><div class="sub">' + esc(t.who || '—') + ' · ' + esc(when(t.created_at)) + (t.note ? ' · ' + esc(t.note) : '') + '</div></div></div>';
      }).join('') + '</div>' : '<div class="empty">No activity in this period.</div>';
      qs('#repOut').innerHTML =
        '<div class="tiles mb-3"><div class="tile"><div class="tile-n">' + units + '</div><div class="tile-l">Units taken</div></div>' +
        '<div class="tile"><div class="tile-n">' + takes.length + '</div><div class="tile-l">Takes logged</div></div>' +
        '<div class="tile"><div class="tile-n">' + who.length + '</div><div class="tile-l">People</div></div></div>' +
        '<div class="seg"><button data-rv="item" class="' + (rep.view === 'item' ? 'active' : '') + '">By item</button><button data-rv="who" class="' + (rep.view === 'who' ? 'active' : '') + '">By person</button><button data-rv="all" class="' + (rep.view === 'all' ? 'active' : '') + '">All activity</button></div>' +
        '<div class="card mb-3">' + body + '</div>' +
        '<button class="btn btn-outline-primary" id="repCsv">Download all activity (CSV)</button>';
      qsa('[data-rv]').forEach(function (b) { b.addEventListener('click', function () { rep.view = b.getAttribute('data-rv'); paint(tx); }); });
      qs('#repCsv').addEventListener('click', function () {
        download('KRD-activity-' + rep.from + '-to-' + rep.to + '.csv', toCsv([['Date', 'Time', 'Type', 'Item', 'Code', 'Category', 'Qty change', 'Unit', 'Person', 'Note', 'Undone', 'Entered in TRACKS']].concat(
          tx.map(function (t) { return [fmtDate(t.created_at), fmtTime(t.created_at), kindLabel(t.kind), t.item, t.code || '', t.category, t.qty, t.unit, t.who || '', t.note || '', t.undone ? 'yes' : '', t.exported_at ? fmtDate(t.exported_at) : '']; }))));
      });
    }
    load();
  }

  // ------------------------------------------------------------------
  //  STAFF
  // ------------------------------------------------------------------
  async function viewStaff() {
    loading();
    var list = await call('list_staff');
    var st = await call('get_settings'); S.defaultPin = st.default_pin || '0000';
    render('<div class="page-title"><h4>Staff</h4><button class="btn btn-primary" id="addP">+ Add person</button></div>' +
      '<p class="text-muted" style="margin-top:-.5rem">Everyone signs in by tapping their name and entering their 4-digit PIN.</p>' +
      '<div class="list">' + list.map(function (p) {
        return '<button class="list-row" data-p="' + p.id + '"' + (p.active ? '' : ' style="opacity:.55"') + '><span class="avatar' + (p.role === 'admin' ? ' admin' : '') + '">' + esc(initials(p.name)) + '</span>' +
          '<div class="grow"><div class="ttl">' + esc(p.name) + '</div><div class="sub">' + (p.last_login ? 'Last signed in ' + esc(ago(p.last_login)) : 'Never signed in') + '</div></div>' +
          (p.locked ? '<span class="badge bg-danger">Locked</span> ' : '') + (p.active && p.must_change_pin ? '<span class="badge bg-warning me-1">New PIN needed</span>' : '') + (p.active && p.role !== 'admin' && p.can_broadcast ? '<span class="badge bg-info me-1">Broadcaster</span>' : '') + (!p.active ? '<span class="badge bg-secondary">Inactive</span>' : p.role === 'admin' ? '<span class="badge bg-navy">Manager</span>' : '') + '</button>';
      }).join('') + '</div>' +
      '<div class="alert alert-secondary mt-3 small mb-0">New people start with the default PIN <b>' + esc(S.defaultPin) + '</b> (change it in <a href="#/settings">Settings</a>). ' +
      'The first time they sign in, the app makes them choose their own. If someone forgets their PIN, tap their name → <b>Reset PIN</b>.</div>');
    qs('#addP').addEventListener('click', function () { editPerson(null); });
    on($app, 'click', '[data-p]', function (e, b) { editPerson(list.find(function (x) { return x.id === b.getAttribute('data-p'); })); });
  }
  function editPerson(p) {
    var isNew = !p; p = p || { name: '', role: 'staff', active: true };
    var w = sheet({
      title: isNew ? 'Add person' : 'Edit ' + p.name,
      body: '<form id="pForm" class="row g-3">' +
        '<div class="col-12"><label class="form-label" for="pName">Name</label><input class="form-control" id="pName" required value="' + esc(p.name) + '" autocomplete="off"><div class="form-text">As it should appear on the sign-in screen.</div></div>' +
        '<div class="col-6"><label class="form-label" for="pRole">Access</label><select class="form-select" id="pRole"><option value="staff"' + (p.role === 'staff' ? ' selected' : '') + '>Staff</option><option value="admin"' + (p.role === 'admin' ? ' selected' : '') + '>Manager</option></select></div>' +
        (isNew ? '<div class="col-6"><label class="form-label" for="pPin">Starting PIN</label><input class="form-control" id="pPin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="' + esc(S.defaultPin || '0000') + '" autocomplete="off">' +
          '<div class="form-text">Blank = default PIN</div></div>'
               : '<div class="col-6"><div class="form-label">PIN</div>' + (p.id === S.me.id ? '<a class="btn btn-outline-secondary w-100" href="#/me">Change mine</a>' : '<button type="button" class="btn btn-outline-danger w-100" id="pReset">Reset PIN</button>') +
          '<div class="form-text">' + (p.locked ? '<span class="text-danger fw-bold">Locked out</span> — reset unlocks' : p.must_change_pin ? 'Hasn\'t chosen their own yet' : 'Forgotten? Reset it') + '</div></div>') +
        (isNew ? '<div class="col-12 small text-muted" style="margin-top:.25rem">They\'ll choose their own PIN the first time they sign in.</div>' : '') +
        '<div class="col-12" id="pBcWrap"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="pBc"' + (p.can_broadcast ? ' checked' : '') + '><label class="form-check-label" for="pBc"><b>Can send TOI broadcasts</b> (e.g. depot supervisor)</label></div></div>' +
        '<div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="pActive"' + (p.active ? ' checked' : '') + '><label class="form-check-label" for="pActive">Active (can sign in)</label></div></div>' +
        '<div class="col-12 small text-muted">Managers can see stock levels, do stocktakes, change items, read everyone\'s activity and send TOI broadcasts.</div>' +
        '</form>',
      foot: '<button class="btn btn-outline-secondary" data-close>Cancel</button><button class="btn btn-primary" id="pSave">Save</button>'
    });
    function bcVis() { var adm = qs('#pRole', w).value === 'admin'; qs('#pBcWrap', w).classList.toggle('d-none', adm); }
    qs('#pRole', w).addEventListener('change', bcVis); bcVis();
    var rb = qs('#pReset', w);
    if (rb) rb.addEventListener('click', async function () {
      if (!(await confirmSheet('Reset ' + p.name + '\'s PIN?', '<p>Their PIN goes back to the default PIN <b>' + esc(S.defaultPin || '0000') + '</b> and they\'re signed out on their phone. When they next sign in, they\'ll choose a new PIN.</p>', 'Reset PIN', true))) return;
      try {
        var r = await call('reset_pin', { p_staff_id: p.id });
        sheet({ title: 'PIN reset', body: '<p>Tell <b>' + esc(r.name) + '</b> to sign in with:</p><p class="display-5 fw-bold text-center" style="letter-spacing:.3em;color:var(--qr-dark-blue)">' + esc(r.pin) + '</p>' +
          '<p class="small text-muted mb-0">They\'ll be asked to choose a new PIN straight away.</p>', foot: '<button class="btn btn-primary" data-close>Done</button>', onClose: route });
      } catch (err) { errToast(err); }
    });
    qs('#pSave', w).addEventListener('click', async function () {
      if (!qs('#pForm', w).reportValidity()) return;
      var pinEl = qs('#pPin', w), pin = pinEl ? pinEl.value.trim() : '', name = qs('#pName', w).value.trim();
      try {
        var res = await call('save_staff', { p_person: { id: isNew ? null : p.id, name: name, role: qs('#pRole', w).value, active: qs('#pActive', w).checked, can_broadcast: qs('#pBc', w).checked, pin: pin || null } });
        closeSheet();
        if (isNew) {
          sheet({ title: name + ' added', body: '<p>Send <b>' + esc(name) + '</b> the app link and tell them to sign in with:</p><p class="display-5 fw-bold text-center" style="letter-spacing:.3em;color:var(--qr-dark-blue)">' + esc(res.pin || pin) + '</p>' +
            '<p class="small text-muted mb-0">The first time they sign in, they\'ll choose their own PIN.</p>', foot: '<button class="btn btn-primary" data-close>Done</button>', onClose: route });
        } else { toast('Saved'); route(); }
      } catch (err) { errToast(err); }
    });
  }

  // ------------------------------------------------------------------
  //  SETTINGS
  // ------------------------------------------------------------------
  async function viewSettings() {
    loading();
    var s = await call('get_settings');
    var appUrl = s.app_url || (location.origin + location.pathname);
    render('<div class="page-title"><h4>Settings</h4></div>' +
      (api.isDemo ? '<div class="alert alert-warning">Demo mode — emails are not really sent.</div>' : '') +
      '<form id="setForm"><div class="card mb-3"><div class="card-header">Reorder emails</div><div class="card-body">' +
        '<div class="mb-3"><label class="form-label" for="sEmail">Send alerts to</label><input class="form-control" id="sEmail" type="text" inputmode="email" value="' + esc(s.alert_email) + '" placeholder="you@example.com">' +
          '<div class="form-text">Separate several addresses with commas.</div></div>' +
        '<div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" role="switch" id="sInstant"' + (s.instant_alerts ? ' checked' : '') + '><label class="form-check-label" for="sInstant"><b>Instant alert</b> when an item reaches its par level</label></div>' +
        '<div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" role="switch" id="sDaily"' + (s.daily_summary ? ' checked' : '') + '><label class="form-check-label" for="sDaily"><b>Daily summary</b> at 7:00am (reorder list + what was taken yesterday)</label></div>' +
      '</div></div>' +
      '<div class="card mb-3"><div class="card-header">Staff sign-in</div><div class="card-body">' +
        '<label class="form-label" for="sDefPin">Default PIN for new staff & PIN resets</label><input class="form-control" id="sDefPin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required value="' + esc(s.default_pin || '0000') + '" style="max-width:9rem">' +
        '<div class="form-text">People sign in with this once, then must choose their own PIN.</div></div></div>' +
      '<div class="card mb-3"><div class="card-header">Email sending (Resend)</div><div class="card-body">' +
        '<div class="mb-3"><label class="form-label" for="sKey">Resend API key</label><input class="form-control" id="sKey" type="password" autocomplete="off" placeholder="' + (s.resend_key_set ? 'Saved (' + esc(s.resend_key_hint) + ') — paste to replace' : 're_...') + '">' +
          '<div class="form-text">Free at resend.com — see the setup guide. Stored in your database, never shown again.</div></div>' +
        '<div class="mb-3"><label class="form-label" for="sFrom">From</label><input class="form-control" id="sFrom" value="' + esc(s.email_from) + '"><div class="form-text">Keep <code>onboarding@resend.dev</code> unless you verify your own domain in Resend.</div></div>' +
        '<div class="mb-0"><label class="form-label" for="sUrl">App link (used in emails)</label><input class="form-control" id="sUrl" value="' + esc(appUrl) + '"></div>' +
      '</div></div>' +
      '<div class="d-flex gap-2 flex-wrap mb-3"><button class="btn btn-primary">Save settings</button><button type="button" class="btn btn-outline-primary" id="sTest">Send test email</button></div></form>' +
      '<div class="card mb-3"><div class="card-header d-flex justify-content-between align-items-center">Recent emails <button class="btn btn-sm btn-outline-primary" id="sRefresh">Refresh</button></div><div id="sLog"><div class="empty">Loading…</div></div></div>' +
      (!api.isDemo && (!s.net_ready || !s.cron_ready) ? '<div class="alert alert-warning">' + (!s.net_ready ? 'The <b>pg_net</b> extension is off, so emails can\'t be sent. ' : '') + (!s.cron_ready ? 'The <b>pg_cron</b> extension is off, so the daily summary won\'t run. ' : '') + 'Turn them on in Supabase → Database → Extensions, then run schema.sql again.</div>' : '') +
      '<div class="card"><div class="card-header">Share the app</div><div class="card-body"><p class="mb-2">Send staff this link. They open it on their phone and add it to their home screen:</p>' +
        '<div class="input-group"><input class="form-control" readonly value="' + esc(appUrl) + '" id="shareUrl"><button class="btn btn-outline-primary" id="copyUrl">Copy</button></div></div></div>');
    async function log() {
      try {
        var l = await call('email_status');
        qs('#sLog').innerHTML = l.length ? '<div class="list" style="border:0;border-radius:0">' + l.map(function (e) {
          var ok = e.status_code >= 200 && e.status_code < 300, bad = e.status_code && !ok || /^FAILED/.test(e.subject);
          return '<div class="list-row"><div class="grow"><div class="ttl">' + esc(e.subject) + '</div><div class="sub">' + esc(when(e.created_at)) + (bad && e.detail ? ' · ' + esc(e.detail) : '') + '</div></div>' +
            '<span class="badge ' + (ok ? 'bg-success' : bad ? 'bg-danger' : 'bg-secondary') + '">' + (ok ? 'Sent' : bad ? 'Failed' : (api.isDemo ? 'Demo' : 'Pending')) + '</span></div>';
        }).join('') + '</div>' : '<div class="empty">No emails sent yet.</div>';
      } catch (err) { errToast(err); }
    }
    log();
    qs('#sRefresh').addEventListener('click', log);
    qs('#copyUrl').addEventListener('click', function () { copyText(qs('#shareUrl').value); });
    qs('#setForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      try {
        await call('save_settings', { p_settings: { alert_email: qs('#sEmail').value, instant_alerts: qs('#sInstant').checked, daily_summary: qs('#sDaily').checked,
          resend_api_key: qs('#sKey').value, email_from: qs('#sFrom').value, app_url: qs('#sUrl').value, default_pin: qs('#sDefPin').value } });
        toast('Settings saved'); viewSettings();
      } catch (err) { errToast(err); }
    });
    qs('#sTest').addEventListener('click', async function () {
      try { await call('send_test_email'); toast('Test email sent — check your inbox (and junk folder)'); setTimeout(log, 2500); } catch (err) { errToast(err); }
    });
  }

  // ------------------------------------------------------------------
  //  TOI BROADCASTS
  // ------------------------------------------------------------------
  function msgTabs(active) {
    var nb = S.pulse.broadcasts || 0, nc = S.pulse.unread || 0;
    return '<div class="page-title"><h4>Messages</h4></div>' +
      '<div class="seg"><a href="#/broadcasts" class="' + (active === 'bc' ? 'active' : '') + '">📣 TOI Broadcasts' + (nb ? ' <span class="badge bg-danger">' + nb + '</span>' : '') + '</a>' +
      '<a href="#/chat" class="' + (active === 'chat' ? 'active' : '') + '">Chat' + (nc ? ' <span class="badge bg-danger">' + nc + '</span>' : '') + '</a></div>';
  }
  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function linkify(text) {
    return esc(text).replace(/(https?:\/\/[^\s<]+)/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>'; });
  }
  function paintBroadcastBanner() {
    var el = document.getElementById('bcBanner'); if (!el) return;
    var n = S.pulse.broadcasts || 0;
    el.innerHTML = n ? '<a href="#/broadcasts" class="alert alert-warning d-flex align-items-center gap-2 text-decoration-none mb-3" style="color:var(--qr-ink)">' +
      '<span style="width:26px;flex:none;color:#9a4a10">' + I.megaphone + '</span><span class="flex-grow-1"><b>' + plural(n, 'new TOI broadcast') + '</b> — tap to read</span><span>›</span></a>' : '';
  }
  function maybeUrgentPopup() {
    var list = (S.pulse.urgent || []).filter(function (u) { return !S.urgentShown[u.id] && location.hash !== '#/broadcast/' + u.id; });
    if (!list.length || $sheetHost.innerHTML) return;
    var u = list[0]; S.urgentShown[u.id] = true;
    var w = sheet({
      title: '📣 URGENT TOI BROADCAST',
      body: '<p class="fs-5 fw-bold mb-1" style="color:var(--qr-dark-blue)">' + esc(u.title) + '</p>' +
            '<p class="text-muted mb-0">From ' + esc(u.who || '—') + ' · ' + esc(when(u.at)) + '</p>' +
            (list.length > 1 ? '<p class="small mt-2 mb-0">+ ' + plural(list.length - 1, 'other urgent broadcast') + '</p>' : ''),
      foot: '<button class="btn btn-outline-secondary" data-close>Later</button><a class="btn btn-danger btn-lg" href="#/broadcast/' + u.id + '">Read now</a>'
    });
    qs('.sheet-head', w).style.background = 'var(--qr-red)';
  }

  async function viewBroadcasts() {
    loading();
    var r = await call('list_broadcasts');
    render(msgTabs('bc') +
      (r.can_send ? '<a class="btn btn-primary btn-lg w-100 mb-3 d-flex align-items-center justify-content-center gap-2" href="#/broadcasts/new"><span style="width:24px">' + I.megaphone + '</span>New TOI broadcast</a>' : '') +
      (r.items.length ? '<div class="d-flex flex-column gap-2">' + r.items.map(function (b) {
        var needAck = !b.mine && b.require_ack && !b.acked_at, isNew = !b.mine && !b.seen_at;
        var status = b.can_manage && b.require_ack ? '<span class="badge bg-navy">' + b.ack_count + '/' + b.audience + ' acknowledged</span>'
          : b.can_manage ? '<span class="badge bg-navy">' + b.seen_count + '/' + b.audience + ' opened</span>'
          : needAck ? '<span class="badge bg-warning">Please acknowledge</span>'
          : b.acked_at && b.require_ack ? '<span class="badge bg-success">✓ Acknowledged</span>' : '';
        return '<a class="bc-card' + (b.urgent ? ' is-urgent' : '') + (isNew ? ' is-new' : '') + '" href="#/broadcast/' + b.id + '">' +
          '<div class="d-flex justify-content-between gap-2 align-items-start"><div class="bc-title">' + (isNew ? '<span class="new-dot" aria-label="New"></span>' : '') + esc(b.title) + '</div>' +
          (b.urgent ? '<span class="badge bg-danger flex-none">URGENT</span>' : '') + '</div>' +
          '<div class="bc-meta">' + esc(b.sender) + ' · ' + esc(when(b.published_at)) + (b.files.length ? ' · <span style="display:inline-block;width:14px;vertical-align:-2px">' + I.clip + '</span>' + b.files.length : '') + '</div>' +
          (b.body ? '<div class="bc-snip">' + esc(b.body.slice(0, 140)) + (b.body.length > 140 ? '…' : '') + '</div>' : '') +
          (status ? '<div class="mt-1">' + status + '</div>' : '') + '</a>';
      }).join('') + '</div>' : '<div class="empty">No broadcasts yet.</div>'));
  }

  async function loadFile(f) {
    if (S.fileCache[f.id]) return S.fileCache[f.id];
    var r = await call('get_broadcast_file', { p_file_id: f.id }, { bg: true });
    var bin = atob(r.data), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    S.fileCache[f.id] = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
    return S.fileCache[f.id];
  }

  async function viewBroadcast(id) {
    loading();
    var b = await call('get_broadcast', { p_broadcast_id: id });
    pulse();
    var needAck = !b.mine && b.require_ack && !b.acked_at;
    render('<div class="d-flex align-items-center gap-2 mb-2"><a href="#/broadcasts" class="btn btn-sm btn-outline-secondary" aria-label="Back" style="width:40px">' + I.back + '</a>' +
        '<span class="small text-muted">TOI Broadcast</span>' + (b.urgent ? '<span class="badge bg-danger ms-auto">URGENT</span>' : '') + '</div>' +
      '<article class="card mb-3' + (b.urgent ? ' border-danger' : '') + '" style="' + (b.urgent ? 'border-left:6px solid var(--qr-red)' : 'border-left:6px solid var(--qr-light-blue)') + '"><div class="card-body">' +
        '<h4 class="mb-1">' + esc(b.title) + '</h4>' +
        '<div class="small text-muted mb-3">From <b>' + esc(b.sender) + '</b> · ' + esc(when(b.published_at)) + '</div>' +
        (b.body ? '<div class="bc-body">' + linkify(b.body) + '</div>' : '') +
        (b.files.length ? '<div class="section-title mt-3">Attachments</div><div class="bc-files">' + b.files.map(function (f) {
          var img = /^image\//.test(f.mime);
          return '<div class="bc-file' + (img ? ' is-img' : '') + '" data-file="' + f.id + '">' +
            (img ? '<div class="bc-img-ph">Loading photo…</div>'
                 : '<span class="bc-pdf-ico">' + I.pdf + '</span><div class="grow"><div class="fw-bold text-break">' + esc(f.name) + '</div><div class="small text-muted">PDF · ' + fmtSize(f.size) + '</div></div>' +
                   '<span class="btn btn-sm btn-outline-primary disabled" data-open>Loading…</span>') + '</div>';
        }).join('') + '</div>' : '') +
      '</div></article>' +
      '<div id="ackArea">' + ackHtml(b) + '</div>' +
      (b.can_manage ? '<div class="card mb-3"><div class="card-header d-flex justify-content-between align-items-center"><span>Read receipts</span><span class="badge bg-navy">' +
          (b.require_ack ? b.ack_count + '/' + b.audience + ' acknowledged' : b.seen_count + '/' + b.audience + ' opened') + '</span></div><div id="receipts"><div class="empty">Loading…</div></div></div>' +
        '<button class="btn btn-outline-danger w-100 mb-3" id="bcDelete">Delete this broadcast for everyone</button>' : ''));
    function ackHtml(x) {
      if (x.mine) return '';
      if (needAck) return '<button class="btn btn-success btn-lg w-100 mb-3" id="bcAck">' + I.check.replace('<svg', '<svg width="22" height="22"') + ' I have read and understood</button>';
      if (x.require_ack && x.acked_at) return '<div class="alert alert-success">✓ You acknowledged this ' + esc(when(x.acked_at)) + '.</div>';
      return '';
    }
    var ab = qs('#bcAck');
    if (ab) ab.addEventListener('click', async function () {
      ab.disabled = true;
      try { await call('ack_broadcast', { p_broadcast_id: b.id }); b.acked_at = new Date().toISOString(); needAck = false; qs('#ackArea').innerHTML = ackHtml(b); toast('Thanks — acknowledged'); pulse(); }
      catch (err) { ab.disabled = false; errToast(err); }
    });
    var del = qs('#bcDelete');
    if (del) del.addEventListener('click', async function () {
      if (!(await confirmSheet('Delete broadcast?', '<p>It will be removed from everyone\'s phone, along with its attachments.</p>', 'Delete', true))) return;
      try { await call('delete_broadcast', { p_broadcast_id: b.id }); toast('Broadcast deleted'); location.hash = '#/broadcasts'; } catch (err) { errToast(err); }
    });
    if (b.can_manage) {
      call('broadcast_receipts', { p_broadcast_id: b.id }, { bg: true }).then(function (rows) {
        var el = qs('#receipts'); if (!el) return;
        el.innerHTML = rows.length ? '<div class="list" style="border:0;border-radius:0">' + rows.map(function (r) {
          var st = r.acked_at ? '<span class="badge bg-success">✓ ' + esc(when(r.acked_at)) + '</span>'
                 : r.seen_at ? '<span class="badge bg-warning">' + (b.require_ack ? 'Opened, not acknowledged' : 'Opened ' + esc(when(r.seen_at))) + '</span>'
                 : '<span class="badge bg-secondary">Not opened</span>';
          if (!b.require_ack && r.acked_at) st = '<span class="badge bg-success">Opened ' + esc(when(r.seen_at)) + '</span>';
          return '<div class="list-row"><span class="avatar">' + esc(initials(r.name)) + '</span><div class="grow ttl">' + esc(r.name) + '</div>' + st + '</div>';
        }).join('') + '</div>' : '<div class="empty">No one else is set up yet.</div>';
      }).catch(errToast);
    }
    // load attachments one by one
    for (var i = 0; i < b.files.length; i++) {
      var f = b.files[i], box = qs('[data-file="' + f.id + '"]');
      try {
        var url = await loadFile(f);
        box = qs('[data-file="' + f.id + '"]'); if (!box) return;   // user left the page
        if (/^image\//.test(f.mime)) box.innerHTML = '<a href="' + url + '" target="_blank" rel="noopener" title="Open full size"><img src="' + url + '" alt="' + esc(f.name) + '"></a>';
        else { var o = qs('[data-open]', box); o.outerHTML = '<a class="btn btn-sm btn-primary" href="' + url + '" target="_blank" rel="noopener" download="' + esc(f.name) + '">Open</a>'; }
      } catch (err) {
        if (box) box.insertAdjacentHTML('beforeend', '<div class="small text-danger w-100">' + esc(err.message) + '</div>');
        var oo = box && qs('[data-open]', box); if (oo) oo.remove();
        var ph = box && qs('.bc-img-ph', box); if (ph) ph.textContent = 'Photo unavailable';
      }
    }
  }

  // Shrink phone photos before upload (keeps uploads fast on mobile data).
  function compressImage(file) {
    return new Promise(function (resolve) {
      if (file.type === 'image/gif') return resolve(file);
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = 1800, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
        var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
        var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (blob) {
          if (!blob || (blob.size >= file.size && /^image\/(jpeg|png|webp)$/.test(file.type))) return resolve(file);
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
        }, 'image/jpeg', 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }
  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader(); r.onload = function () { resolve(String(r.result).split(',')[1] || ''); }; r.onerror = reject; r.readAsDataURL(blob);
    });
  }

  function viewNewBroadcast() {
    if (!S.me.can_broadcast && !isAdmin()) { location.hash = '#/broadcasts'; return; }
    var files = [];   // {file, url}
    render('<div class="d-flex align-items-center gap-2 mb-2"><a href="#/broadcasts" class="btn btn-sm btn-outline-secondary" aria-label="Back" style="width:40px">' + I.back + '</a><h4 class="m-0">New TOI broadcast</h4></div>' +
      '<p class="text-muted">Goes to <b>everyone</b> in KRD Stores.</p>' +
      '<form id="bcForm" class="card mb-3"><div class="card-body">' +
        '<div class="mb-3"><label class="form-label" for="bcTitle">Title</label><input class="form-control" id="bcTitle" maxlength="150" required placeholder="e.g. Track work Saturday – Petrie to Kippa-Ring"></div>' +
        '<div class="mb-3"><label class="form-label" for="bcBody">Message</label><textarea class="form-control" id="bcBody" rows="6" maxlength="5000" placeholder="What does everyone need to know?"></textarea></div>' +
        '<div class="mb-3"><div class="form-label mb-1">Attachments <span class="fw-normal text-muted">(PDF or photos, up to 6, max 10 MB each)</span></div>' +
          '<div id="bcFileList" class="bc-files mb-2"></div>' +
          '<label class="btn btn-outline-primary d-inline-flex align-items-center gap-2 mb-0"><span style="width:20px">' + I.clip + '</span>Add PDF or photo' +
            '<input type="file" id="bcFiles" accept="application/pdf,image/*" multiple hidden></label></div>' +
        '<div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" role="switch" id="bcAckReq" checked><label class="form-check-label" for="bcAckReq"><b>Require “read & understood”</b> — see who has acknowledged</label></div>' +
        '<div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" role="switch" id="bcUrgent"><label class="form-check-label" for="bcUrgent"><b>Urgent</b> — pops up on everyone\'s screen until they read it</label></div>' +
      '</div></form>' +
      '<div id="bcProgress" class="small text-muted mb-2"></div>' +
      '<button class="btn btn-primary btn-lg w-100 d-flex align-items-center justify-content-center gap-2" id="bcSend"><span style="width:22px">' + I.send + '</span>Send to everyone</button>');
    function paintFiles() {
      qs('#bcFileList').innerHTML = files.map(function (x, i) {
        var img = /^image\//.test(x.file.type);
        return '<div class="bc-file">' + (img ? '<img class="bc-thumb" src="' + x.url + '" alt="">' : '<span class="bc-pdf-ico">' + I.pdf + '</span>') +
          '<div class="grow"><div class="fw-bold text-break">' + esc(x.file.name) + '</div><div class="small text-muted">' + (img ? 'Photo' : 'PDF') + ' · ' + fmtSize(x.file.size) + '</div></div>' +
          '<button type="button" class="btn btn-sm btn-outline-danger" data-rm="' + i + '" aria-label="Remove ' + esc(x.file.name) + '">Remove</button></div>';
      }).join('');
    }
    qs('#bcFiles').addEventListener('change', async function (e) {
      var picked = Array.prototype.slice.call(e.target.files || []); e.target.value = '';
      for (var i = 0; i < picked.length; i++) {
        var f = picked[i];
        if (files.length >= 6) { toast('Maximum 6 attachments', true); break; }
        var isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name), isImg = /^image\//.test(f.type);
        if (!isPdf && !isImg) { toast(f.name + ': only PDFs and photos can be attached', true); continue; }
        if (isImg) f = await compressImage(f);
        if (isPdf && f.type !== 'application/pdf') f = new File([f], f.name, { type: 'application/pdf' });
        if (f.size > 10 * 1024 * 1024) { toast(f.name + ' is larger than 10 MB', true); continue; }
        files.push({ file: f, url: URL.createObjectURL(f) });
      }
      paintFiles();
    });
    on($app, 'click', '[data-rm]', function (e, b) { files.splice(+b.getAttribute('data-rm'), 1); paintFiles(); });
    qs('#bcSend').addEventListener('click', async function () {
      if (!qs('#bcForm').reportValidity()) return;
      var urgent = qs('#bcUrgent').checked, ack = qs('#bcAckReq').checked;
      var ok = await confirmSheet('Send to everyone?',
        '<p class="fw-bold mb-1">' + esc(qs('#bcTitle').value) + '</p><p class="small text-muted">' + (files.length ? plural(files.length, 'attachment') + ' · ' : '') +
        (urgent ? '<span class="text-danger fw-bold">Urgent pop-up</span> · ' : '') + (ack ? 'Acknowledgement required' : 'No acknowledgement') + '</p>', 'Send broadcast');
      if (!ok) return;
      var btn = qs('#bcSend'), prog = qs('#bcProgress'); btn.disabled = true;
      try {
        prog.textContent = 'Creating broadcast…';
        var id = await call('create_broadcast', { p_title: qs('#bcTitle').value, p_body: qs('#bcBody').value, p_urgent: urgent, p_require_ack: ack }, { bg: true });
        for (var i = 0; i < files.length; i++) {
          prog.textContent = 'Uploading ' + (i + 1) + ' of ' + files.length + ' — ' + files[i].file.name + '…';
          await call('add_broadcast_file', { p_broadcast_id: id, p_name: files[i].file.name, p_mime: files[i].file.type, p_data: await toBase64(files[i].file) }, { bg: true });
        }
        prog.textContent = 'Sending…';
        await call('publish_broadcast', { p_broadcast_id: id }, { bg: true });
        toast('Broadcast sent to everyone 📣');
        location.hash = '#/broadcast/' + id;
      } catch (err) {
        btn.disabled = false; prog.textContent = '';
        errToast(err.kind === 'network' ? { message: 'No connection — the broadcast was NOT sent. Try again when you have signal.' } : err);
      }
    });
  }

  // ------------------------------------------------------------------
  //  Boot
  // ------------------------------------------------------------------
  if (api.isDemo) {
    var db = document.getElementById('demoBanner');
    db.innerHTML = 'DEMO MODE — data stays on this device. <a href="#/me" style="color:#000">Reset</a>';
    db.classList.remove('d-none');
  }
  updateOfflineBanner();
  (async function boot() {
    if (S.token) {
      try { S.me = await call('me'); LS.set('me', S.me); }
      catch (e) { if (e.kind === 'network' && S.me) { /* offline: keep cached identity */ } else if (e.kind !== 'session') { signOutLocal(); } }
    }
    await route();
    pulse(); flushOutbox();
  })();
})();
