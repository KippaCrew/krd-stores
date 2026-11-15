/* =====================================================================
   Kippa Crew — Kippa Ring Depot crew app
   Single-page app, no build step. Hash routes, TRACKS styling.
   ===================================================================== */
(function () {
  'use strict';

  var api = window.KRDApi;
  var APP_VERSION = '1.2';
  // Changes in this version of the app, offered when writing a "What's New" update.
  var APP_CHANGES = [
    'Uniform orders: when the uniform store sends your order to Kippa Ring, you\'ll get a notification as soon as it arrives',
    'See your uniform orders any time under Me → My uniform orders, and tap "I\'ve picked it up" when you collect it',
    'Report a fault: Me → Report a fault opens the facilities fault form for the depot or office buildings',
    'Suggestion box: share ideas or concerns anonymously under Me → Suggestion box. Your name is never saved with it',
    'Union chats: RTBU and AFULE members are added to their union\'s chat automatically'
  ];
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
  var isAdmin = function () { return S.me && S.me.role === 'admin'; };            // Manager
  var isAdministrator = function () { return S.me && S.me.role === 'administrator'; };
  var isOffice = function () { return isAdmin() || isAdministrator(); };          // Manager or Administrator
  function roleLabel(r) { return r === 'admin' ? 'Manager' : r === 'administrator' ? 'Administrator' : 'Staff'; }
  function sendLabel() { return S.me && S.me.broadcast_kind === 'depot' ? 'Depot Announcement' : 'TOI Broadcast'; }

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
    wrench: ico('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>'),
    bulb: ico('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/>'),
    shirt: ico('<path d="M8 3L3 6l2 4 3-1v12h8V9l3 1 2-4-5-3a4 4 0 0 1-8 0z"/>'),
    camera: ico('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>')
  };

  // ------------------------------------------------------------------
  //  Sheets (bottom modals)
  // ------------------------------------------------------------------
  function sheet(opts) {
    closeSheet();
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<div class="sheet-backdrop"' + (opts.locked ? '' : ' data-close') + '></div>' +
      '<div class="sheet' + (opts.locked ? ' is-locked' : '') + '" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">' +
        '<div class="sheet-head"><h5 id="sheetTitle">' + esc(opts.title) + '</h5>' +
          (opts.locked ? '' : '<button type="button" class="btn-close" data-close aria-label="Close"></button>') + '</div>' +
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
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $sheetHost.innerHTML && !qs('.sheet.is-locked')) closeSheet(); });

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
    try { S.pulse = await call('heartbeat', null, { bg: true }); renderNav(); flushOutbox(); maybeUrgentPopup(); maybeWhatsNew(); paintBroadcastBanner(); } catch (_) {}
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
      { href: '#/more', label: 'More', icon: I.more, match: /^#\/(more|receive|reports|tracks|staff|settings|share|me|history|whatsnew|uniforms|my-uniforms|suggest|faults)/, dot: S.pulse.suggestions_new }
    ];
    if (isAdministrator()) return [
      { href: '#/', label: 'Home', icon: I.home, match: /^#\/?$/ },
      { href: '#/take', label: 'Take', icon: I.take, match: /^#\/take/ },
      { href: '#/count', label: 'Count', icon: I.count, match: /^#\/count/ },
      { href: '#/messages', label: 'Messages', icon: I.chat, match: /^#\/(chat|messages|broadcast)/, dot: (S.pulse.unread || 0) + (S.pulse.broadcasts || 0) },
      { href: '#/more', label: 'More', icon: I.more, match: /^#\/(more|receive|staff|share|me|history|whatsnew|uniforms|my-uniforms|suggest|faults)/ }
    ];
    return [
      { href: '#/take', label: 'Take', icon: I.take, match: /^#\/(take)?\/?$/ },
      { href: '#/history', label: 'My history', icon: I.history, match: /^#\/history/ },
      { href: '#/messages', label: 'Messages', icon: I.chat, match: /^#\/(chat|messages|broadcast)/, dot: (S.pulse.unread || 0) + (S.pulse.broadcasts || 0) },
      { href: '#/me', label: 'Me', icon: I.me, match: /^#\/(me|whatsnew|my-uniforms|suggest|faults)/, dot: S.pulse.uniforms_ready }
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
    [/^#\/?$/, function () { return isAdmin() ? viewHome() : isAdministrator() ? viewOfficeHome() : viewTake(); }],
    [/^#\/take$/, function () { return viewTake(); }],
    [/^#\/history$/, function () { return viewHistory(); }],
    [/^#\/messages$/, function () { location.replace(S.pulse.broadcasts || !S.pulse.unread ? '#/broadcasts' : '#/chat'); }],
    [/^#\/broadcasts$/, function () { return viewBroadcasts(); }],
    [/^#\/broadcasts\/new$/, function () { return viewNewBroadcast(); }],
    [/^#\/broadcast\/(\d+)$/, function (m) { return viewBroadcast(+m[1]); }],
    [/^#\/chat$/, function () { return viewChatList(); }],
    [/^#\/chat\/(.+)$/, function (m) { return viewChat(decodeURIComponent(m[1])); }],
    [/^#\/me$/, function () { return viewMe(); }],
    [/^#\/whatsnew$/, function () { return viewWhatsNew(); }],
    [/^#\/more$/, function () { return officeOnly(viewMore); }],
    [/^#\/share$/, function () { return officeOnly(viewShare); }],
    [/^#\/stock(?:\?(low))?$/, function (m) { return adminOnly(function () { return viewStock(m[1]); }); }],
    [/^#\/import$/, function () { return adminOnly(viewImport); }],
    [/^#\/receive$/, function () { return officeOnly(viewReceive); }],
    [/^#\/count$/, function () { return officeOnly(viewCount); }],
    [/^#\/count\/(.+)$/, function (m) { return officeOnly(function () { return viewCountReport(m[1]); }); }],
    [/^#\/reports$/, function () { return adminOnly(viewReports); }],
    [/^#\/tracks$/, function () { return adminOnly(viewTracks); }],
    [/^#\/staff$/, function () { return officeOnly(viewStaff); }],
    [/^#\/settings(?:#tracks)?$/, function () { return adminOnly(viewSettings); }],
    [/^#\/uniforms(\/done)?$/, function (m) { return officeOnly(function () { return viewUniforms(!!m[1]); }); }],
    [/^#\/my-uniforms$/, function () { return viewMyUniforms(); }],
    [/^#\/suggest$/, function () { return viewSuggest(); }],
    [/^#\/faults$/, function () { return viewFaults(); }],
    [/^#\/suggestions(\/done)?$/, function (m) { return adminOnly(function () { return viewSuggestions(!!m[1]); }); }]
  ];
  function adminOnly(fn) { if (!isAdmin()) { location.hash = isOffice() ? '#/' : '#/take'; return; } return fn(); }
  function officeOnly(fn) { if (!isOffice()) { location.hash = '#/take'; return; } return fn(); }

  var routeSeq = 0;
  async function route() {
    var seq = ++routeSeq;
    if (S.viewCleanup) { try { S.viewCleanup(); } catch (_) {} S.viewCleanup = null; }
    if (!qs('.sheet.is-locked')) closeSheet();
    renderNav();
    if (!S.token || !S.me) { try { await viewSignIn(); } catch (e) { if (e.kind !== 'stale') errToast(e); } return; }
    if (S.me.must_change_pin) { $nav.classList.add('d-none'); viewSetOwnPin(); return; }
    setTimeout(maybeWhatsNew, 600);
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
    var demo = api.isDemo ? '<div class="alert alert-warning small">Demo PINs — Manager (demo): <b>1234</b> · Pat Admin (demo): <b>3333</b> · Sam Smith: <b>1111</b> · Alex Brown: <b>2222</b></div>' : '';
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
      (api.isDemo ? '<p class="small text-muted mt-3 text-center">Demo PINs: Manager 1234 · Pat Admin 3333 · Sam 1111 · Alex 2222</p>' : '') +
      '<input type="tel" id="pinKb" inputmode="numeric" autocomplete="one-time-code" aria-label="PIN" style="position:absolute;opacity:0;width:1px;height:1px">' +
      '</div>');
    function paint() { qsa('#dots span').forEach(function (d, i) { d.classList.toggle('on', i < pin.length); }); }
    async function submit() {
      busy = true;
      try {
        var r = await api.rpc('login', { p_staff_id: person.id, p_pin: pin });
        if (r && r.error) throw new Error(r.error);
        setSession(r); toast('Signed in as ' + r.me.name);
        location.hash = isOffice() ? '#/' : '#/take';
        route(); flushOutbox(); pulse(); syncPush();
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
        location.hash = isOffice() ? '#/' : '#/take'; route(); pulse();
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
      '<h4>Welcome to Kippa Crew</h4>' +
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
  //  ITEM PHOTOS — cached on the phone (Cache Storage) after first load
  // ------------------------------------------------------------------
  var IMG = {};   // itemId -> { ver, url }
  var IMG_CACHE = 'krd-item-photos-v1';
  function imgKey(id, ver) { return location.origin + '/__krd_img/' + id + '/' + ver; }
  function b64ToBlob(b64, mime) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  function setImg(id, ver, blob) {
    if (IMG[id] && IMG[id].url) URL.revokeObjectURL(IMG[id].url);
    IMG[id] = { ver: ver, url: URL.createObjectURL(blob) };
  }
  function thumbHtml(i, anyImg) {
    if (!i.img) return anyImg ? '<span class="thumb thumb-empty" aria-hidden="true">' + I.stock + '</span>' : '';
    var have = IMG[i.id] && IMG[i.id].ver === i.img;
    return '<button type="button" class="thumb" data-zoom="' + i.id + '" data-img="' + i.id + '" aria-label="Photo of ' + esc(i.name) + '">' +
      (have ? '<img src="' + IMG[i.id].url + '" alt="">' : '') + '</button>';
  }
  function paintThumbs() {
    qsa('[data-img]').forEach(function (el) {
      var id = el.getAttribute('data-img');
      if (IMG[id] && !el.querySelector('img')) el.innerHTML = '<img src="' + IMG[id].url + '" alt="">';
    });
  }
  async function loadThumbs(items) {
    var need = items.filter(function (i) { return i.img && !(IMG[i.id] && IMG[i.id].ver === i.img); });
    if (!need.length) return;
    var cache = null;
    try { cache = await caches.open(IMG_CACHE); } catch (_) { cache = null; }
    var missing = [];
    for (var k = 0; k < need.length; k++) {
      var it = need[k], hit = null;
      try { hit = cache && await cache.match(imgKey(it.id, it.img)); } catch (_) {}
      if (hit) setImg(it.id, it.img, await hit.blob()); else missing.push(it);
    }
    paintThumbs();
    for (var c = 0; c < missing.length; c += 30) {
      var chunk = missing.slice(c, c + 30);
      try {
        var rows = await call('item_images', { p_ids: chunk.map(function (i) { return i.id; }) }, { bg: true });
        rows.forEach(function (r) {
          var blob = b64ToBlob(r.data, r.mime);
          setImg(r.id, r.ver, blob);
          if (cache) { try { cache.put(imgKey(r.id, r.ver), new Response(blob, { headers: { 'Content-Type': r.mime } })); } catch (_) {} }
        });
        paintThumbs();
      } catch (_) { break; }
    }
  }
  function zoomPhoto(item) {
    if (!item || !IMG[item.id]) return;
    sheet({ title: item.name, body: '<img src="' + IMG[item.id].url + '" alt="' + esc(item.name) + '" style="width:100%;height:auto;border-radius:.5rem">' +
      '<p class="text-muted mt-2 mb-0">' + esc(item.unit) + (item.category ? ' · ' + esc(item.category) : '') + '</p>',
      foot: '<button class="btn btn-primary" data-close>Close</button>' });
  }
  // Resize a phone photo to a small, sharp JPEG for an item
  function itemPhotoBlob(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = 800, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
        var cv = document.createElement('canvas'); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
        var ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        cv.toBlob(function (b) { b ? resolve(b) : reject(new Error('Could not read that photo')); }, 'image/jpeg', 0.8);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file is not a photo this phone can read.')); };
      img.src = url;
    });
  }
  async function uploadItemPhoto(itemId, file) {
    var blob = await itemPhotoBlob(file);
    var ver = await call('set_item_image', { p_item_id: itemId, p_mime: 'image/jpeg', p_data: await toBase64(blob) }, { bg: true });
    setImg(itemId, ver, blob);
    try { var cache = await caches.open(IMG_CACHE); cache.put(imgKey(itemId, ver), new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } })); } catch (_) {}
    return ver;
  }

  // ------------------------------------------------------------------
  //  TAKE ITEMS
  // ------------------------------------------------------------------
  var takeFilter = { q: '', cat: '' };
  async function viewTake() {
    loading();
    S.items = await call('list_items');
    S.anyImg = S.items.some(function (i) { return i.img; });
    var cats = Array.from(new Set(S.items.map(function (i) { return i.category; })));
    if (takeFilter.cat && cats.indexOf(takeFilter.cat) < 0) takeFilter.cat = '';
    // drop cart lines for items that no longer exist
    Object.keys(S.cart).forEach(function (id) { if (!S.items.some(function (i) { return i.id === id; })) delete S.cart[id]; });

    render(
      '<div id="bcBanner"></div><div id="pushPrompt"></div>' +
      '<div class="page-title"><h4>Take items</h4>' + (isAdmin() ? '' : '<a href="#/history" class="small">My history</a>') + '</div>' +
      '<p class="text-muted mb-1" style="margin-top:-.5rem">Tap <b>+</b> for each thing you take, then press <b>Review</b>.</p>' +
      '<div class="search-bar">' +
        '<input class="form-control mb-2" id="tSearch" type="search" placeholder="Search items…" autocomplete="off" value="' + esc(takeFilter.q) + '">' +
        (cats.length > 1 ? '<div class="chips" role="tablist"><button class="chip' + (!takeFilter.cat ? ' active' : '') + '" data-cat="">All</button>' +
          cats.map(function (c) { return '<button class="chip' + (takeFilter.cat === c ? ' active' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div>' : '') +
      '</div>' +
      '<div id="itemList" class="item-list"></div>' +
      (isOffice() ? '' : '<div class="mt-4">' + faultBlock() + '</div>') +
      '<div class="cart-bar" id="cartBar"></div>');
    paintItems(); paintCart(); paintBroadcastBanner(); loadThumbs(S.items); paintPushPrompt();
    on($app, 'click', '[data-zoom]', function (e, b) { zoomPhoto(S.items.find(function (i) { return i.id === b.getAttribute('data-zoom'); })); });

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
    return '<div class="item-row' + (q ? ' has-qty' : '') + '" id="row-' + i.id + '">' + thumbHtml(i, S.anyImg) +
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
    paintThumbs();
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
    function row(cv, team, group) {
      var last = cv.last ? ((team || group) && cv.last.who && !cv.last.mine ? cv.last.who.split(' ')[0] + ': ' : (cv.last.mine ? 'You: ' : '')) + cv.last.body
               : (team ? 'Messages to everyone' : group ? plural(cv.members, 'member') : 'No messages yet');
      if (group) {
        return '<a class="list-row" href="#/chat/' + encodeURIComponent(cv.key) + '">' +
          groupAvatar(cv) +
          '<div class="grow"><div class="ttl">' + esc(cv.name) + (cv.sys ? ' <span class="badge bg-info">Auto</span>' : '') + '</div>' +
          '<div class="sub">' + esc(last) + '</div></div>' +
          '<div class="text-end">' + (cv.last ? '<div class="small text-muted">' + esc(ago(cv.last.at)) + '</div>' : '') +
          (cv.unread ? '<span class="badge bg-danger">' + cv.unread + '</span>' : '') + '</div></a>';
      }
      return '<a class="list-row" href="#/chat/' + encodeURIComponent(cv.key) + '">' +
        '<span class="avatar' + (team ? ' admin' : (cv.role === 'admin' || cv.role === 'administrator' ? ' admin' : '')) + '">' + (team ? '👥' : esc(initials(cv.name))) + '</span>' +
        '<div class="grow"><div class="ttl">' + esc(cv.name) + (cv.role === 'admin' || cv.role === 'administrator' ? ' <span class="badge bg-navy">' + roleLabel(cv.role) + '</span>' : '') + '</div>' +
        '<div class="sub">' + esc(last) + '</div></div>' +
        '<div class="text-end">' + (cv.last ? '<div class="small text-muted">' + esc(ago(cv.last.at)) + '</div>' : '') +
        (cv.unread ? '<span class="badge bg-danger">' + cv.unread + '</span>' : '') + '</div></a>';
    }
    render(msgTabs('chat') +
      '<div class="list mb-3">' + row(c.team, true) + '</div>' +
      '<div class="d-flex justify-content-between align-items-center"><div class="section-title">Groups</div>' +
        '<button class="btn btn-sm btn-outline-primary" id="newGroup">+ New group</button></div>' +
      (c.groups.length ? '<div class="list mb-3">' + c.groups.map(function (g) { return row(g, false, true); }).join('') + '</div>'
                       : '<div class="empty py-3">You\'re not in any groups yet.</div>') +
      '<div class="section-title">' + (isOffice() ? 'Direct messages' : 'Message a manager or administrator') + '</div>' +
      (c.people.length ? '<div class="list">' + c.people.map(function (p) { return row(p, false); }).join('') + '</div>' : '<div class="empty">No one to message yet.</div>'));
    qs('#newGroup').addEventListener('click', function () { groupEditor(null); });
    var t = setInterval(async function () {
      if ($sheetHost.innerHTML) return;   // don't redraw under an open sheet
      try { var n = await call('list_conversations', null, { bg: true }); if (JSON.stringify(n) !== JSON.stringify(c)) viewChatList(); } catch (_) {}
    }, 12000);
    S.viewCleanup = function () { clearInterval(t); };
  }

  async function viewChat(key) {
    var c = await call('list_conversations');
    var isGroup = /^g\d+$/.test(key);
    var conv = key === 'team' ? c.team : isGroup ? c.groups.find(function (g) { return g.key === key; }) : c.people.find(function (p) { return p.key === key; });
    if (!conv) { toast('Conversation not found', true); location.hash = '#/chat'; return; }
    var lastId = 0, lastDay = null;
    render('<div class="chat-wrap">' +
      '<div class="chat-head"><a href="#/chat" class="btn btn-sm btn-outline-secondary" aria-label="Back" style="width:40px">' + I.back + '</a>' +
      (isGroup ? groupAvatar(conv)
               : '<span class="avatar' + (key === 'team' || conv.role === 'admin' || conv.role === 'administrator' ? ' admin' : '') + '">' + (key === 'team' ? '👥' : esc(initials(conv.name))) + '</span>') +
      '<div class="flex-grow-1"><div class="fw-bold">' + esc(conv.name) + '</div><div class="small text-muted">' +
        (key === 'team' ? 'Everyone sees these messages' : isGroup ? plural(conv.members, 'member') + (conv.sys ? ' · automatic' : '') : 'Private conversation') + '</div></div>' +
      (isGroup ? '<button class="btn btn-sm btn-outline-secondary" id="grpInfo">Info</button>' : '') + '</div>' +
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
        html += '<div class="bubble' + (m.mine ? ' mine' : '') + '">' + ((key === 'team' || isGroup) && !m.mine ? '<div class="who">' + esc(m.who) + '</div>' : '') +
          esc(m.body) + '<div class="at">' + fmtTime(m.created_at) + '</div></div>';
        lastId = Math.max(lastId, m.id);
      });
      box.insertAdjacentHTML('beforeend', html);
      if (nearBottom) box.scrollTop = box.scrollHeight;
    }
    async function poll() { try { add(await call('get_messages', { p_with: key, p_after: lastId }, { bg: true })); } catch (_) {} }
    var timer = null;
    S.viewCleanup = function () {
      clearInterval(timer); window.removeEventListener('resize', fit);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', fit);
    };

    var gi = qs('#grpInfo'); if (gi) gi.addEventListener('click', function () { groupInfoSheet(key); });
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
    // load the conversation last, so the buttons above work immediately
    add(await call('get_messages', { p_with: key, p_after: 0 }));
    pulse();
    timer = setInterval(poll, 4000);
  }

  // Icon for a group chat: union logos for RTBU / AFULE, short labels for Drivers / Guards, initials otherwise
  function groupAvatar(g) {
    if (g.kind === 'rtbu' || g.kind === 'afule') return '<span class="avatar group union"><img src="icons/chat-' + g.kind + '.png" alt="' + (g.kind === 'rtbu' ? 'RTBU' : 'AFULE') + '"></span>';
    return '<span class="avatar group' + (g.sys ? ' sys' : '') + '">' + esc(g.sys ? (g.kind === 'driver' ? 'DRV' : 'GRD') : initials(g.name)) + '</span>';
  }

  // ------------------------------------------------------------------
  //  GROUP CHATS
  // ------------------------------------------------------------------
  async function groupEditor(existing) {
    var people;
    try { people = await call('chat_people', null, { bg: true }); } catch (err) { return errToast(err); }
    var picked = {};
    if (existing) existing.members.forEach(function (m) { if (!m.me) picked[m.id] = true; });
    var w = sheet({
      title: existing ? 'Edit group' : 'New group',
      body: '<label class="form-label" for="gName">Group name</label>' +
        '<input class="form-control mb-3" id="gName" maxlength="60" placeholder="e.g. Night shift crew" value="' + esc(existing ? existing.name : '') + '">' +
        '<div class="form-label mb-1">Members <span class="fw-normal text-muted" id="gCount"></span></div>' +
        '<input class="form-control mb-2" id="gSearch" type="search" placeholder="Search names…">' +
        '<div class="list" id="gPeople" style="max-height:45vh;overflow:auto"></div>' +
        '<p class="small text-muted mt-2 mb-0">You\'re added automatically. Only members can see the group.</p>',
      foot: '<button class="btn btn-outline-secondary" data-close>Cancel</button><button class="btn btn-primary" id="gSave">' + (existing ? 'Save' : 'Create group') + '</button>'
    });
    function paint() {
      var q = qs('#gSearch', w).value.toLowerCase();
      qs('#gPeople', w).innerHTML = people.filter(function (p) { return !q || p.name.toLowerCase().indexOf(q) >= 0; }).map(function (p) {
        return '<label class="list-row" style="cursor:pointer"><input class="form-check-input flex-none" type="checkbox" data-gp="' + p.id + '"' + (picked[p.id] ? ' checked' : '') + '>' +
          '<span class="avatar' + (p.role === 'admin' ? ' admin' : '') + '">' + esc(initials(p.name)) + '</span><div class="grow"><div class="ttl">' + esc(p.name) + '</div>' +
          '<div class="sub">' + esc(posLabel(p.position)) + (p.role !== 'staff' ? ' · ' + roleLabel(p.role) : '') + '</div></div></label>';
      }).join('') || '<div class="empty">No one found.</div>';
      var n = Object.keys(picked).length; qs('#gCount', w).textContent = n ? '(' + n + ' selected)' : '';
    }
    paint();
    qs('#gSearch', w).addEventListener('input', paint);
    on(w, 'change', '[data-gp]', function (e, cb) { if (cb.checked) picked[cb.getAttribute('data-gp')] = true; else delete picked[cb.getAttribute('data-gp')]; paint(); });
    qs('#gSave', w).addEventListener('click', async function (e) {
      var name = qs('#gName', w).value.trim(), ids = Object.keys(picked);
      if (!name) return toast('Give the group a name', true);
      if (!ids.length) return toast('Tick at least one person', true);
      e.currentTarget.disabled = true;
      try {
        if (existing) { await call('update_group', { p_key: existing.key, p_name: name, p_members: ids }, { bg: true }); closeSheet(); toast('Group updated'); route(); }
        else { var key = await call('create_group', { p_name: name, p_members: ids }, { bg: true }); closeSheet(); toast('Group created'); location.hash = '#/chat/' + key; }
      } catch (err) { e.currentTarget.disabled = false; errToast(err); }
    });
  }

  async function groupInfoSheet(key) {
    var g;
    try { g = await call('group_info', { p_key: key }, { bg: true }); } catch (err) { return errToast(err); }
    var w = sheet({
      title: g.name,
      body: (g.sys ? '<div class="alert alert-info small">' + (g.kind === 'rtbu' || g.kind === 'afule'
                     ? 'Everyone whose union affiliation is <b>' + unionLabel(g.kind) + '</b> is in this chat automatically. Change it under Staff to move someone.'
                     : 'Everyone whose position is <b>' + (g.kind === 'driver' ? 'Driver' : 'Guard') + '</b> is in this chat automatically. Change a person\'s position under Staff to move them.') + '</div>'
                   : '<p class="small text-muted">Made by ' + esc(g.created_by || '—') + '. Only members can see this group.</p>') +
        '<div class="form-label mb-1">' + plural(g.members.length, 'member') + '</div>' +
        '<div class="list">' + g.members.map(function (m) {
          return '<div class="list-row"><span class="avatar' + (m.role === 'admin' ? ' admin' : '') + '">' + esc(initials(m.name)) + '</span><div class="grow"><div class="ttl">' + esc(m.name) + (m.me ? ' (you)' : '') + '</div>' +
            '<div class="sub">' + esc(posLabel(m.position)) + (m.role !== 'staff' ? ' · ' + roleLabel(m.role) : '') + '</div></div></div>';
        }).join('') + '</div>',
      foot: g.sys ? '<button class="btn btn-primary" data-close>Close</button>'
        : (g.can_manage ? '<button class="btn btn-outline-danger" id="gDel">Delete group</button><button class="btn btn-primary" id="gEdit">Edit name & members</button>' : '') +
          '<button class="btn btn-outline-secondary" id="gLeave">Leave group</button>'
    });
    var ed = qs('#gEdit', w); if (ed) ed.addEventListener('click', function () { groupEditor(g); });
    var dl = qs('#gDel', w);
    if (dl) dl.addEventListener('click', async function () {
      if (!(await confirmSheet('Delete ' + g.name + '?', '<p>The group and its messages disappear for everyone in it.</p>', 'Delete group', true))) return;
      try { await call('delete_group', { p_key: key }, { bg: true }); toast('Group deleted'); location.hash = '#/chat'; } catch (err) { errToast(err); }
    });
    var lv = qs('#gLeave', w);
    if (lv) lv.addEventListener('click', async function () {
      if (!(await confirmSheet('Leave ' + g.name + '?', '<p>You won\'t see its messages any more unless someone adds you back.</p>', 'Leave group', true))) return;
      try { await call('leave_group', { p_key: key }, { bg: true }); toast('You left ' + g.name); location.hash = '#/chat'; } catch (err) { errToast(err); }
    });
  }

  // ------------------------------------------------------------------
  //  ME
  // ------------------------------------------------------------------
  async function viewMe() {
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent), seq0 = routeSeq;
    var notif = await notifCardHtml();
    if (seq0 !== routeSeq) return;   // user moved on while we checked
    render('<div class="page-title"><h4>My account</h4></div>' +
      '<div class="card mb-3"><div class="card-body d-flex align-items-center gap-3">' +
        '<span class="avatar' + (isOffice() ? ' admin' : '') + '" style="width:3rem;height:3rem;font-size:1.1rem">' + esc(initials(S.me.name)) + '</span>' +
        '<div><div class="fw-bold fs-5">' + esc(S.me.name) + '</div><div class="text-muted">' + roleLabel(S.me.role) + '</div></div>' +
        '<button class="btn btn-outline-danger ms-auto" id="signOut">Sign out</button></div></div>' +
      notif +
      '<div class="card mb-3"><div class="card-header">Change my PIN</div><div class="card-body">' +
        '<form id="pinForm" class="row g-2">' +
          '<div class="col-6"><label class="form-label" for="oldPin">Current PIN</label><input class="form-control" id="oldPin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" required></div>' +
          '<div class="col-6"><label class="form-label" for="newPin">New PIN</label><input class="form-control" id="newPin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" required></div>' +
          '<div class="col-12"><button class="btn btn-primary">Change PIN</button></div></form></div></div>' +
      '<div class="card mb-3"><div class="card-header">Put Kippa Crew on your home screen</div><div class="card-body">' +
        (ios ? '<p class="mb-0">In <b>Safari</b>, tap the <b>Share</b> button (square with an arrow), then <b>Add to Home Screen</b>.</p>'
             : '<p class="mb-0">In <b>Chrome</b>, tap the <b>⋮</b> menu, then <b>Install app</b> or <b>Add to Home screen</b>.</p>') +
        '<p class="small text-muted mt-2 mb-0">It then opens like a normal app, and you stay signed in.</p></div></div>' +
      '<a class="list-row mb-2" style="border:1px solid var(--qr-line);border-radius:.5rem" href="#/faults"><span style="width:26px;color:var(--qr-light-blue)">' + I.wrench + '</span><div class="grow"><div class="ttl">Report a fault</div><div class="sub">Facilities fault forms for depots and buildings</div></div><span class="text-muted">›</span></a>' +
      (!isAdmin() ? '<a class="list-row mb-2" style="border:1px solid var(--qr-line);border-radius:.5rem" href="#/suggest"><span style="width:26px;color:var(--qr-light-blue)">' + I.bulb + '</span><div class="grow"><div class="ttl">Suggestion box</div><div class="sub">Share an idea or concern — anonymously</div></div><span class="text-muted">›</span></a>' : '') +
      '<a class="list-row mb-2" style="border:1px solid var(--qr-line);border-radius:.5rem" href="#/my-uniforms"><span style="width:26px;color:var(--qr-light-blue)">' + I.shirt + '</span><div class="grow"><div class="ttl">My uniform orders' + (S.pulse.uniforms_ready ? ' <span class="badge bg-danger">' + S.pulse.uniforms_ready + ' ready</span>' : '') + '</div><div class="sub">Orders sent to the depot for you</div></div><span class="text-muted">›</span></a>' +
      '<a class="list-row mb-3" style="border:1px solid var(--qr-line);border-radius:.5rem" href="#/whatsnew"><span style="width:26px;color:var(--qr-light-blue)">' + I.megaphone + '</span><div class="grow"><div class="ttl">What\'s New</div><div class="sub">Past updates and changes</div></div><span class="text-muted">›</span></a>' +
      (api.isDemo ? '<div class="card mb-3"><div class="card-header">Demo mode</div><div class="card-body"><p>This is a demo running only on this device. Nothing is shared.</p>' +
        '<button class="btn btn-outline-danger" id="resetDemo">Reset demo data</button></div></div>' : '') +
      '<p class="small text-muted text-center">Kippa Crew · Kippa Ring Depot · v' + APP_VERSION + '</p>');
    wireNotifCard(viewMe);
    qs('#signOut').addEventListener('click', async function () {
      await disablePush(true);   // so the next person on this phone doesn't get your notifications
      S.pushCfg = null;
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
    return 'Kippa Ring Depot — stores reorder list ' + fmtDate(new Date().toISOString()) + '\n\n' +
      low.map(function (i) { return '• ' + i.name + (i.code ? ' [' + i.code + ']' : '') + ' — order ' + i.suggest + ' ' + i.unit + ' (on hand ' + i.on_hand + ', par ' + i.par + ')'; }).join('\n');
  }

  async function viewHome() {
    loading();
    var d = await call('admin_dashboard');
    S.pulse.low = d.low.length; renderNav();
    render(
      '<div id="bcBanner"></div><div id="pushPrompt"></div>' +
      '<div class="page-title"><h4>G\'day, ' + esc(S.me.name.split(' ')[0]) + '</h4><span class="small text-muted">' + esc(fmtDay(new Date().toISOString())) + '</span></div>' +
      '<div class="tiles mb-3">' +
        '<a class="tile' + (d.low.length ? ' is-alert' : '') + '" href="#/stock?low"><div class="tile-n">' + d.low.length + '</div><div class="tile-l">To reorder</div></a>' +
        '<a class="tile" href="#/reports"><div class="tile-n">' + d.today_takes + '</div><div class="tile-l">Taken today</div></a>' +
        '<a class="tile' + (d.unexported ? ' is-warn' : '') + '" href="#/tracks"><div class="tile-n">' + d.unexported + '</div><div class="tile-l">To enter in TRACKS</div></a>' +
      '</div>' +
      (d.open_stocktake ? '<div class="alert alert-info d-flex align-items-center justify-content-between gap-2"><span>A stocktake is in progress.</span><a class="btn btn-sm btn-primary" href="#/count">Continue</a></div>' : '') +
      (d.suggestions_new ? '<a href="#/suggestions" class="alert alert-info d-flex align-items-center gap-2 text-decoration-none" style="color:var(--qr-ink)"><span style="width:26px;flex:none">' + I.bulb + '</span><span class="flex-grow-1"><b>' + plural(d.suggestions_new, 'new suggestion') + '</b> in the suggestion box</span><span>›</span></a>' : '') +
      '<div class="action-grid mb-3">' +
        '<a class="action primary" href="#/take">' + I.take + 'Take items</a>' +
        '<a class="action" href="#/receive">' + I.truck + 'Receive delivery</a>' +
        '<a class="action" href="#/count">' + I.count + 'Stocktake</a>' +
        '<a class="action" href="#/tracks">' + I.export + 'TRACKS entry</a>' +
        '<a class="action" href="#/broadcasts/new">' + I.megaphone + 'TOI broadcast</a>' +
        uniAction(d.uniforms_open) +
        '<a class="action" href="#/suggestions" style="grid-column:1/-1">' + I.bulb + 'Suggestion box' + (d.suggestions_new ? ' <span class="badge bg-danger ms-1">' + d.suggestions_new + '</span>' : '') + '</a>' +
      '</div>' +
      faultBlock() +
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
    paintBroadcastBanner(); paintPushPrompt();
    var co = qs('#copyOrder'); if (co) co.addEventListener('click', function () { copyText(reorderText(d.low)); });
    var cc = qs('#csvOrder'); if (cc) cc.addEventListener('click', function () {
      download('KRD-reorder-' + todayKey() + '.csv', toCsv([['Item', 'Code', 'Category', 'Unit', 'On hand', 'Par', 'Suggested order']].concat(
        d.low.map(function (i) { return [i.name, i.code || '', i.category, i.unit, i.on_hand, i.par, i.suggest]; }))));
    });
  }

  // ------------------------------------------------------------------
  //  ADMINISTRATOR HOME & SHARE THE APP
  // ------------------------------------------------------------------
  function uniAction(n) { return '<a class="action" href="#/uniforms">' + I.shirt + 'Uniforms' + (n ? ' <span class="badge bg-danger ms-1">' + n + '</span>' : '') + '</a>'; }
  async function viewOfficeHome() {
    loading();
    var st = await call('list_stocktakes');
    try { S.pulse = await call('heartbeat', null, { bg: true }); } catch (_) {}
    var open = st.find(function (x) { return x.status === 'open'; });
    render('<div id="bcBanner"></div><div id="pushPrompt"></div>' +
      '<div class="page-title"><h4>G\'day, ' + esc(S.me.name.split(' ')[0]) + '</h4><span class="small text-muted">' + esc(fmtDay(new Date().toISOString())) + '</span></div>' +
      (open ? '<div class="alert alert-info d-flex align-items-center justify-content-between gap-2"><span>A stocktake is in progress.</span><a class="btn btn-sm btn-primary" href="#/count">Continue</a></div>' : '') +
      '<div class="action-grid mb-3">' +
        '<a class="action primary" href="#/take">' + I.take + 'Take items</a>' +
        '<a class="action" href="#/receive">' + I.truck + 'Receive delivery</a>' +
        '<a class="action" href="#/count">' + I.count + 'Stocktake</a>' +
        '<a class="action" href="#/staff">' + I.users + 'Staff</a>' +
        '<a class="action" href="#/broadcasts/new">' + I.megaphone + 'Depot Announcement</a>' +
        uniAction(S.pulse.uniforms_open) +
      '</div>' +
      faultBlock() +
      '<div class="list"><a class="list-row" href="#/share"><span style="width:26px;color:var(--qr-light-blue)">' + I.export + '</span><div class="grow"><div class="ttl">Share the app</div><div class="sub">Send the link to the crew</div></div><span class="text-muted">›</span></a></div>');
    paintBroadcastBanner(); paintPushPrompt();
  }

  function viewShare() {
    var url = location.origin + location.pathname;
    render('<div class="page-title"><h4>Share the app</h4></div>' +
      '<div class="card mb-3"><div class="card-body">' +
        '<p class="mb-2">Send the crew this link. They open it on their phone, tap their name, and sign in with the PIN you give them.</p>' +
        '<div class="input-group mb-3"><input class="form-control" readonly value="' + esc(url) + '" id="shareUrl" aria-label="App link"><button class="btn btn-outline-primary" id="shareCopy">Copy</button></div>' +
        (navigator.share ? '<button class="btn btn-primary w-100 mb-2" id="shareNative">Share by text, email or Teams…</button>' : '') +
        '<a class="btn btn-outline-secondary w-100" href="sms:?&body=' + encodeURIComponent('Kippa Crew app: ' + url) + '">Send as a text message</a>' +
      '</div></div>' +
      '<div class="card"><div class="card-header">Tell them to</div><div class="card-body"><ol class="mb-0">' +
        '<li>Open the link on their phone.</li>' +
        '<li>Tap their name and enter their PIN, then choose their own.</li>' +
        '<li>Add it to the home screen. <b>iPhone:</b> Safari → Share → Add to Home Screen. <b>Android:</b> ⋮ → Install app.</li>' +
        '<li>Go to <b>Me → Turn on notifications</b>.</li></ol></div></div>');
    qs('#shareCopy').addEventListener('click', function () { copyText(url); });
    var sn = qs('#shareNative');
    if (sn) sn.addEventListener('click', function () { navigator.share({ title: 'Kippa Crew', text: 'Kippa Crew – the Kippa Ring Depot app', url: url }).catch(function () {}); });
  }

  // ------------------------------------------------------------------
  //  MORE (admin menu)
  // ------------------------------------------------------------------
  function viewMore() {
    function row(href, icon, t, s) { return '<a class="list-row" href="' + href + '"><span style="width:26px;color:var(--qr-light-blue)">' + icon + '</span><div class="grow"><div class="ttl">' + t + '</div><div class="sub">' + s + '</div></div><span class="text-muted">›</span></a>'; }
    if (isAdministrator()) {
      render('<div class="page-title"><h4>More</h4></div>' +
        '<div class="list mb-3">' +
          row('#/broadcasts/new', I.megaphone, 'Send a Depot Announcement', 'A notice to everyone, with PDFs & photos') +
          row('#/receive', I.truck, 'Receive a delivery', 'Add stock that has arrived') +
          row('#/uniforms', I.shirt, 'Uniform collections', 'Orders from TRACKS coming to the depot') +
          row('#/faults', I.wrench, 'Report a fault', 'Facilities fault forms') +
          row('#/count', I.count, 'Stocktake', 'Blind count of the store room') +
        '</div><div class="list mb-3">' +
          row('#/staff', I.users, 'Staff', 'Add people, reset PINs') +
          row('#/share', I.export, 'Share the app', 'Send the link to the crew') +
          row('#/history', I.history, 'My takes', 'What you have logged yourself') +
          row('#/me', I.me, 'My account', 'Change PIN, notifications, sign out') +
        '</div>');
      return;
    }
    render('<div class="page-title"><h4>More</h4></div>' +
      '<div class="list mb-3">' +
        row('#/broadcasts', I.megaphone, 'TOI Broadcasts', 'Notices to everyone, with PDFs & photos') +
        row('#/receive', I.truck, 'Receive a delivery', 'Add stock that has arrived') +
        row('#/uniforms', I.shirt, 'Uniform collections', 'Orders from TRACKS coming to the depot') +
        row('#/faults', I.wrench, 'Report a fault', 'Facilities fault forms') +
        row('#/tracks', I.export, 'TRACKS entry', 'Everything taken since you last entered it') +
        row('#/reports', I.chart, 'Reports', 'Usage by item and by person, CSV export') +
        row('#/stock', I.stock, 'Items & par levels', 'Add, edit, adjust stock') +
        row('#/import', I.upload, 'Import items', 'Paste your list from Excel') +
      '</div><div class="list mb-3">' +
        row('#/staff', I.users, 'Staff', 'Add people, reset PINs') +
        row('#/suggestions', I.bulb, 'Suggestion box' + (S.pulse.suggestions_new ? ' <span class="badge bg-danger">' + S.pulse.suggestions_new + ' new</span>' : ''), 'Anonymous ideas and feedback from the crew') +
        row('#/whatsnew', I.megaphone, 'What\'s New', 'Post app updates & notes everyone sees once') +
        row('#/share', I.export, 'Share the app', 'Send the link to the crew') +
        row('#/settings', I.gear, 'Settings', 'Emails, notifications, TRACKS link') +
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
    S.items = items; S.anyImg = items.some(function (i) { return i.img; });
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
        html += '<button class="list-row" data-edit="' + i.id + '">' + thumbHtml(i, S.anyImg).replace('<button type="button" class="thumb"', '<span class="thumb"').replace('</button>', '</span>').replace(/ data-zoom="[^"]*"/, '') + '<div class="grow"><div class="ttl">' + esc(i.name) + '</div>' +
          '<div class="sub">' + esc(i.unit) + (i.code ? ' · ' + esc(i.code) : '') + ' · par ' + i.par + '</div>' +
          (i.par > 0 ? '<div class="low-bar' + (i.low ? ' is-low' : '') + '"><span style="width:' + Math.max(pct, 3) + '%"></span></div>' : '') + '</div>' +
          '<div class="text-end"><div class="fs-4 fw-bold' + (i.low ? ' text-danger' : '') + '" style="line-height:1">' + i.on_hand + '</div>' +
          (i.low ? '<span class="badge bg-danger">Order ' + i.suggest + '</span>' : '<div class="small text-muted">on hand</div>') + '</div></button>';
      });
      if (lastCat !== null) html += '</div>';
      qs('#stockList').innerHTML = html || '<div class="empty">' + (items.length ? 'Nothing matches.' : 'No items yet. Add one or import your list.') + '</div>';
      paintThumbs();
    }
    paint(); loadThumbs(items);
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
      body: '<div class="item-photo mb-3"><div class="item-photo-box" id="iPhotoBox">' +
          (item.img && IMG[item.id] ? '<img src="' + IMG[item.id].url + '" alt="">' : '<span class="text-muted small">No photo</span>') + '</div>' +
          '<div class="d-flex flex-column gap-2"><label class="btn btn-outline-primary mb-0">' + (item.img ? 'Change photo' : 'Add photo') +
          '<input type="file" accept="image/*" id="iPhoto" hidden></label>' +
          '<button type="button" class="btn btn-outline-danger' + (item.img ? '' : ' d-none') + '" id="iPhotoRm">Remove photo</button>' +
          '<div class="small text-muted" id="iPhotoMsg">Staff see this when taking items.</div></div></div>' +
        '<form id="itemForm" class="row g-3">' +
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
      onClose: function () { if (changedPhoto) route(); },
      foot: (isNew ? '' : '<button class="btn btn-outline-danger me-auto" id="iArchive">Remove</button>') +
        '<button class="btn btn-outline-secondary" data-close>Cancel</button><button class="btn btn-primary" id="iSave">Save</button>'
    });
    var onIn = qs('#iOn', w), pendingPhoto = null;
    qs('#iPhoto', w).addEventListener('change', async function (e) {
      var file = e.target.files && e.target.files[0]; e.target.value = ''; if (!file) return;
      var box = qs('#iPhotoBox', w), msg = qs('#iPhotoMsg', w);
      try {
        if (isNew) {
          pendingPhoto = file; var prev = await itemPhotoBlob(file);
          box.innerHTML = '<img src="' + URL.createObjectURL(prev) + '" alt="">'; msg.textContent = 'Photo will be saved with the item.';
        } else {
          msg.textContent = 'Uploading…';
          await uploadItemPhoto(item.id, file);
          box.innerHTML = '<img src="' + IMG[item.id].url + '" alt="">'; msg.textContent = 'Photo saved ✓';
          qs('#iPhotoRm', w).classList.remove('d-none'); changedPhoto = true;
          qs('.item-photo label', w).firstChild.nodeValue = 'Change photo';
        }
      } catch (err) { msg.textContent = ''; errToast(err); }
    });
    var changedPhoto = false;
    qs('#iPhotoRm', w).addEventListener('click', async function () {
      if (isNew) { pendingPhoto = null; qs('#iPhotoBox', w).innerHTML = '<span class="text-muted small">No photo</span>'; return; }
      try {
        await call('remove_item_image', { p_item_id: item.id }, { bg: true }); delete IMG[item.id];
        qs('#iPhotoBox', w).innerHTML = '<span class="text-muted small">No photo</span>'; qs('#iPhotoRm', w).classList.add('d-none');
        qs('#iPhotoMsg', w).textContent = 'Photo removed'; changedPhoto = true;
      } catch (err) { errToast(err); }
    });
    if (!isNew) onIn.addEventListener('input', function () { qs('#adjWrap', w).classList.toggle('d-none', int(onIn.value) === item.on_hand); });
    qs('#iSave', w).addEventListener('click', async function () {
      var form = qs('#itemForm', w); if (!form.reportValidity()) return;
      try {
        var saved = await call('save_item', { p_item: {
          id: isNew ? null : item.id, name: qs('#iName', w).value, category: qs('#iCat', w).value, unit: qs('#iUnit', w).value,
          code: qs('#iCode', w).value, on_hand: int(onIn.value) || 0, par: int(qs('#iPar', w).value) || 0,
          order_up_to: int(qs('#iUpTo', w).value), max_per_take: int(qs('#iMax', w).value), adjust_note: qs('#iAdj', w).value } });
        if (isNew && pendingPhoto) { try { await uploadItemPhoto(saved.id, pendingPhoto); } catch (err) { toast('Item saved, but the photo failed: ' + err.message, true); } }
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
      '<p class="text-muted" style="margin-top:-.5rem">Enter how many of each item arrived.' + (isAdmin() ? ' Low items are listed first.' : '') + '</p>' +
      '<div class="search-bar"><input class="form-control" id="rSearch" type="search" placeholder="Search items…"></div>' +
      '<div id="rList" class="item-list"></div>' +
      '<div class="cart-bar" id="rBar"></div>');
    var sorted = items.slice().sort(function (a, b) { return ((b.low ? 1 : 0) - (a.low ? 1 : 0)) || a.name.localeCompare(b.name); });
    function paint() {
      var ql = q.toLowerCase();
      qs('#rList').innerHTML = sorted.filter(function (i) { return !ql || i.name.toLowerCase().indexOf(ql) >= 0; }).map(function (i) {
        return '<div class="count-row' + (qty[i.id] ? ' is-counted' : '') + '"><div class="grow"><div class="item-name">' + esc(i.name) + '</div>' +
          '<div class="item-meta">' + esc(i.unit) + (i.on_hand != null ? ' · on hand ' + i.on_hand : '') + (i.low ? ' · <span class="text-danger fw-bold">suggest ' + i.suggest + '</span>' : '') + '</div></div>' +
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
          closeSheet(); toast('Delivery added to stock'); location.hash = isAdmin() ? '#/stock' : '#/';
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
        html += '<div class="count-row' + (i.counted != null ? ' is-counted' : '') + '" id="c-' + i.id + '">' + thumbHtml(i, anyImg) + '<div class="grow"><div class="item-name">' + esc(i.name) + '</div><div class="item-meta">' + esc(i.unit) + ' <span data-state></span></div></div>' +
          '<input class="form-control" type="number" inputmode="numeric" min="0" step="1" placeholder="–" data-c="' + i.id + '" value="' + (i.counted == null ? '' : i.counted) + '" aria-label="Count for ' + esc(i.name) + '"></div>';
      });
      qs('#cList').innerHTML = html || '<div class="empty">' + (filter.uncounted ? 'Everything has been counted 🎉' : 'Nothing matches.') + '</div>';
      prog(); paintThumbs();
    }
    var anyImg = st.items.some(function (i) { return i.img; });
    loadThumbs(st.items);
    on($app, 'click', '[data-zoom]', function (e, b) { zoomPhoto(st.items.find(function (i) { return i.id === b.getAttribute('data-zoom'); })); });
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
    S.defaultPin = await call('staff_default_pin');
    render('<div class="page-title"><h4>Staff</h4><button class="btn btn-primary" id="addP">+ Add person</button></div>' +
      '<p class="text-muted" style="margin-top:-.5rem">Everyone signs in by tapping their name and entering their 4-digit PIN.</p>' +
      '<div class="list">' + list.filter(function (p) { return p.active; }).map(function (p) {
        return '<button class="list-row" data-p="' + p.id + '"' + (p.active ? '' : ' style="opacity:.55"') + '><span class="avatar' + (p.role === 'admin' ? ' admin' : '') + '">' + esc(initials(p.name)) + '</span>' +
          '<div class="grow"><div class="ttl">' + esc(p.name) + '</div><div class="sub">' + esc(posLabel(p.position)) + (unionLabel(p.union_affiliation) ? ' · ' + unionLabel(p.union_affiliation) : '') + ' · ' + (p.last_login ? 'Last signed in ' + esc(ago(p.last_login)) : 'Never signed in') + '</div></div>' +
          (p.locked ? '<span class="badge bg-danger">Locked</span> ' : '') + (p.active && p.role === 'administrator' ? '<span class="badge bg-info me-1">Administrator</span>' : '') + (p.active && p.must_change_pin ? '<span class="badge bg-warning me-1">New PIN needed</span>' : '') + (p.active && p.role !== 'admin' && p.can_broadcast ? '<span class="badge bg-info me-1">Broadcaster</span>' : '') + (!p.active ? '<span class="badge bg-secondary">Inactive</span>' : p.role === 'admin' ? '<span class="badge bg-navy">Manager</span>' : '') + '</button>';
      }).join('') + '</div>' +
      (list.some(function (p) { return !p.active; }) ? '<details class="mt-3"><summary>Former staff (' + list.filter(function (p) { return !p.active; }).length + ')</summary><div class="list mt-2">' +
        list.filter(function (p) { return !p.active; }).map(function (p) {
          return '<button class="list-row" data-p="' + p.id + '"><span class="avatar" style="background:var(--qr-dark-grey)">' + esc(initials(p.name)) + '</span><div class="grow"><div class="ttl">' + esc(p.name) + '</div><div class="sub">' + esc(posLabel(p.position)) + ' · removed</div></div><span class="small text-muted">Bring back ›</span></button>';
        }).join('') + '</div></details>' : '') +
      '<div class="alert alert-secondary mt-3 small mb-0">New people start with the default PIN <b>' + esc(S.defaultPin) + '</b> (change it in <a href="#/settings">Settings</a>). ' +
      'The first time they sign in, the app makes them choose their own. If someone forgets their PIN, tap their name → <b>Reset PIN</b>.</div>');
    qs('#addP').addEventListener('click', function () { editPerson(null); });
    on($app, 'click', '[data-p]', function (e, b) {
      var who = list.find(function (x) { return x.id === b.getAttribute('data-p'); });
      if (isAdministrator() && who.role === 'admin') return toast('Only a Manager can change a Manager\'s details.', true);
      editPerson(who);
    });
  }
  function posLabel(p) { return { driver: 'Driver', guard: 'Guard' }[p] || 'Other'; }
  function unionLabel(u) { return { rtbu: 'RTBU', afule: 'AFULE' }[u] || ''; }
  function editPerson(p) {
    var isNew = !p; p = p || { name: '', role: 'staff', active: true };
    var w = sheet({
      title: isNew ? 'Add person' : 'Edit ' + p.name,
      body: '<form id="pForm" class="row g-3">' +
        '<div class="col-12"><label class="form-label" for="pName">Name</label><input class="form-control" id="pName" required value="' + esc(p.name) + '" autocomplete="off"><div class="form-text">As it should appear on the sign-in screen. Use the same first and last name as in TRACKS so uniform orders match.</div></div>' +
        '<div class="col-6"><label class="form-label" for="pPos">Position</label><select class="form-select" id="pPos">' +
          [['driver', 'Driver'], ['guard', 'Guard'], ['other', 'Other']].map(function (o) { return '<option value="' + o[0] + '"' + ((p.position || (isNew ? '' : 'other')) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
          '</select><div class="form-text">Puts them in the Drivers or Guards chat</div></div>' +
        '<div class="col-6"><label class="form-label" for="pUnion">Union affiliation</label><select class="form-select" id="pUnion">' +
          [['none', 'None'], ['rtbu', 'RTBU'], ['afule', 'AFULE']].map(function (o) { return '<option value="' + o[0] + '"' + ((p.union_affiliation || 'none') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
          '</select><div class="form-text">Adds them to that union\'s chat</div></div>' +
        '<div class="col-6"><label class="form-label" for="pRole">Access</label><select class="form-select" id="pRole"' + (p.id === S.me.id ? ' disabled' : '') + '><option value="staff"' + (p.role === 'staff' ? ' selected' : '') + '>Staff</option><option value="administrator"' + (p.role === 'administrator' ? ' selected' : '') + '>Administrator</option>' + (isAdmin() ? '<option value="admin"' + (p.role === 'admin' ? ' selected' : '') + '>Manager</option>' : '') + '</select></div>' +
        (isNew ? '<div class="col-6"><label class="form-label" for="pPin">Starting PIN</label><input class="form-control" id="pPin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="' + esc(S.defaultPin || '0000') + '" autocomplete="off">' +
          '<div class="form-text">Blank = default PIN</div></div>'
               : '<div class="col-6"><div class="form-label">PIN</div>' + (p.id === S.me.id ? '<a class="btn btn-outline-secondary w-100" href="#/me">Change mine</a>' : '<button type="button" class="btn btn-outline-danger w-100" id="pReset">Reset PIN</button>') +
          '<div class="form-text">' + (p.locked ? '<span class="text-danger fw-bold">Locked out</span> — reset unlocks' : p.must_change_pin ? 'Hasn\'t chosen their own yet' : 'Forgotten? Reset it') + '</div></div>') +
        (isNew ? '<div class="col-12 small text-muted" style="margin-top:.25rem">They\'ll choose their own PIN the first time they sign in.</div>' : '') +
        '<div class="col-12" id="pBcWrap"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="pBc"' + (p.can_broadcast ? ' checked' : '') + '><label class="form-check-label" for="pBc"><b>Can send TOI broadcasts</b> (e.g. depot supervisor)</label></div></div>' +
        '<input type="checkbox" id="pActive" hidden' + (p.active ? ' checked' : '') + '>' +
        (!isNew && !p.active ? '<div class="col-12"><div class="alert alert-warning mb-0">' + esc(p.name) + ' was removed (left the depot). Press <b>Bring back</b> to let them sign in again.</div></div>' : '') +
        '<div class="col-12 small text-muted"><b>Administrators</b> can receive deliveries, run stocktakes, manage staff and send Depot Announcements. <b>Managers</b> can also see stock levels, items, reports, TRACKS entry and settings, and send TOI Broadcasts.</div>' +
        '</form>',
      foot: (!isNew && p.id !== S.me.id ? (p.active ? '<button class="btn btn-outline-danger me-auto" id="pRemove">Remove (left depot)</button>'
                                                      : '<button class="btn btn-success me-auto" id="pBack">Bring back</button>') : '') +
        '<button class="btn btn-outline-secondary" data-close>Cancel</button><button class="btn btn-primary" id="pSave">Save</button>'
    });
    var rmv = qs('#pRemove', w);
    if (rmv) rmv.addEventListener('click', async function () {
      if (!(await confirmSheet('Remove ' + p.name + '?',
        '<p>Use this when someone leaves Kippa Ring Depot. They will:</p><ul>' +
        '<li>be signed out straight away and can\'t sign in again</li><li>disappear from the sign-in list, chats and groups</li>' +
        '<li>stop counting in broadcast and What\'s New read counts</li></ul>' +
        '<p class="mb-0">Everything they logged stays in your reports and TRACKS history. You can bring them back later from <b>Former staff</b>.</p>', 'Remove', true))) return;
      try { await call('save_staff', { p_person: { id: p.id, name: p.name, role: p.role, active: false, can_broadcast: p.can_broadcast, position: p.position || 'other', union_affiliation: p.union_affiliation || 'none' } }); toast(p.name + ' removed'); route(); }
      catch (err) { errToast(err); }
    });
    var bk = qs('#pBack', w);
    if (bk) bk.addEventListener('click', async function () {
      try { await call('save_staff', { p_person: { id: p.id, name: p.name, role: p.role, active: true, can_broadcast: p.can_broadcast, position: p.position || 'other', union_affiliation: p.union_affiliation || 'none' } }); toast(p.name + ' is back — their old PIN still works'); route(); }
      catch (err) { errToast(err); }
    });
    // TOI-broadcast permission: Managers decide it, and only for Staff (others already send their own kind)
    function bcVis() { qs('#pBcWrap', w).classList.toggle('d-none', !isAdmin() || qs('#pRole', w).value !== 'staff'); }
    qs('#pRole', w).addEventListener('change', bcVis); bcVis();
    if (isNew) { var ps = qs('#pPos', w); ps.insertAdjacentHTML('afterbegin', '<option value="" selected disabled>Choose…</option>'); ps.required = true; }
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
        var res = await call('save_staff', { p_person: { id: isNew ? null : p.id, name: name, role: qs('#pRole', w).value, active: qs('#pActive', w).checked, can_broadcast: qs('#pBc', w).checked, position: qs('#pPos', w).value, union_affiliation: qs('#pUnion', w).value, pin: pin || null } });
        closeSheet();
        if (isNew) {
          sheet({ title: name + ' added', body: '<p>Send <b>' + esc(name) + '</b> the app link and tell them to sign in with:</p><p class="display-5 fw-bold text-center" style="letter-spacing:.3em;color:var(--qr-dark-blue)">' + esc(res.pin || pin) + '</p>' +
            '<p class="small text-muted mb-0">The first time they sign in, they\'ll choose their own PIN.</p>', foot: '<button class="btn btn-primary" data-close>Done</button>', onClose: route });
        } else { toast('Saved'); route(); }
      } catch (err) { errToast(err); }
    });
  }

  // ------------------------------------------------------------------
  //  UNIFORM COLLECTIONS — tickets TRACKS sends when an order is
  //  dispatched to Kippa Ring. Office ticks "arrived", the person is
  //  notified, then it's handed over.
  // ------------------------------------------------------------------
  function uniWho(t) { return t.staff_name || t.person_name || 'Unknown person'; }
  function uniItems(n) { return n == null ? '' : ' · ' + plural(n, 'item'); }
  function uniBadge(st) {
    return { in_transit: '<span class="badge bg-warning">On its way</span>', arrived: '<span class="badge bg-primary">Waiting for pickup</span>',
             collected: '<span class="badge bg-success">Collected</span>', cancelled: '<span class="badge bg-secondary">Cancelled</span>' }[st] || '';
  }
  function daysSince(iso) { return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); }
  function uniCardHtml(t) {
    var detail = '', acts = '';
    if (t.status === 'in_transit') {
      var age = daysSince(t.created_at);
      detail = (t.source === 'manual' ? 'Added by hand ' : 'Sent by TRACKS ') + esc(when(t.created_at)) +
        (t.tracks_updates > 1 ? ' · updated ' + plural(t.tracks_updates - 1, 'time') : '') +
        (age >= 7 ? '<div class="text-danger fw-bold mt-1">Still not here after ' + age + ' days — check with the uniform store.</div>' : '');
      acts = '<button class="btn btn-primary" data-u-arrived="' + t.id + '">' + I.check.replace('<svg', '<svg width="18" height="18"') + ' It\'s arrived</button>' +
             '<button class="btn btn-link btn-sm text-muted ms-auto" data-u-close="' + t.id + '">Close ticket</button>';
    } else if (t.status === 'arrived') {
      detail = 'Arrived ' + esc(when(t.arrived_at)) + (t.arrived_by_name ? ' · ticked by ' + esc(t.arrived_by_name) : '') +
        (!t.staff_id ? '' : t.push_on ? '<div class="text-success mt-1">📲 ' + esc(uniWho(t).split(' ')[0]) + ' has been sent a notification.</div>'
                                      : '<div class="mt-1" style="color:#9a4a10">' + esc(uniWho(t).split(' ')[0]) + ' doesn\'t have notifications on — they\'ll see it next time they open the app. You may want to tell them too.</div>');
      acts = '<button class="btn btn-primary" data-u-collected="' + t.id + '">Handed over</button>' +
             '<button class="btn btn-outline-secondary btn-sm ms-auto" data-u-undo="' + t.id + '">Undo arrived</button>';
    } else if (t.status === 'collected') {
      detail = 'Collected ' + esc(when(t.collected_at)) + (t.collected_self ? ' · ' + esc(uniWho(t).split(' ')[0]) + ' confirmed in the app' : t.collected_by_name ? ' · handed over by ' + esc(t.collected_by_name) : '');
      acts = '<div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" role="switch" id="ut' + t.id + '" data-u-tracks="' + t.id + '"' + (t.tracks_done ? ' checked' : '') + '>' +
             '<label class="form-check-label small" for="ut' + t.id + '">Marked <b>Collected</b> in TRACKS</label></div>' +
             '<button class="btn btn-link btn-sm text-muted ms-auto" data-u-reopen="' + t.id + '">Undo</button>';
    } else {
      detail = esc(t.note || 'Closed') + ' · ' + esc(when(t.updated_at));
    }
    return '<div class="card mb-2"><div class="card-body py-2">' +
      '<div class="d-flex justify-content-between align-items-start gap-2"><div><div class="fw-bold fs-6">' + esc(uniWho(t)) + '</div>' +
        '<div class="small text-muted">Order <b style="color:var(--qr-ink)">' + esc(t.order_number) + '</b>' + uniItems(t.items) + '</div></div>' + uniBadge(t.status) + '</div>' +
      '<div class="small mt-1">' + detail + '</div>' +
      (!t.staff_id && (t.status === 'in_transit' || t.status === 'arrived')
        ? '<div class="alert alert-warning py-2 px-2 small mt-2 mb-0 d-flex align-items-center gap-2"><span class="flex-grow-1">' + (t.person_name ? '"' + esc(t.person_name) + '" isn\'t matched to anyone in Kippa Crew' : 'Not matched to anyone in Kippa Crew') + ', so no one will be notified.</span>' +
          '<button class="btn btn-sm btn-outline-dark" data-u-link="' + t.id + '">Choose person</button></div>' : '') +
      (acts ? '<div class="d-flex align-items-center gap-2 mt-2">' + acts + '</div>' : '') +
      '</div></div>';
  }
  async function viewUniforms(done) {
    loading();
    var d = await call('list_uniform_orders', { p_done: !!done });
    S.pulse.uniforms_open = d.open; renderNav();
    var list = d.tickets;
    var waiting = list.filter(function (t) { return t.status === 'arrived'; }), coming = list.filter(function (t) { return t.status === 'in_transit'; });
    render('<div class="page-title"><h4>Uniform collections</h4><button class="btn btn-primary" id="uAdd">+ Add</button></div>' +
      '<div class="seg"><a href="#/uniforms" class="' + (done ? '' : 'active') + '">To do (' + d.open + ')</a><a href="#/uniforms/done" class="' + (done ? 'active' : '') + '">Collected' +
        (d.tracks_todo ? ' <span class="badge bg-warning">' + d.tracks_todo + '</span>' : '') + '</a></div>' +
      (!d.linked ? '<div class="alert alert-info small">TRACKS isn\'t connected yet, so orders only show here when you add them. ' +
        (isAdmin() ? '<a href="#/settings#tracks">Connect TRACKS</a>' : 'Ask a manager to connect it in Settings.') + '</div>' : '') +
      (api.isDemo && !done ? '<button class="btn btn-outline-secondary btn-sm mb-3" id="uSim">Demo: pretend TRACKS just dispatched an order</button>' : '') +
      (done
        ? (d.tracks_todo ? '<div class="alert alert-warning d-flex align-items-center gap-2"><span class="flex-grow-1">' + plural(d.tracks_todo, 'order') + ' still to mark as <b>Collected</b> in TRACKS.</span><button class="btn btn-sm btn-dark" id="uTracksAll">All done</button></div>' : '') +
          (list.length ? list.map(uniCardHtml).join('') : '<div class="empty">Nothing collected yet.</div>')
        : (waiting.length ? '<div class="section-title">Waiting for pickup (' + waiting.length + ')</div>' + waiting.map(uniCardHtml).join('') : '') +
          (coming.length ? '<div class="section-title">On the way to the depot (' + coming.length + ')</div>' + coming.map(uniCardHtml).join('') : '') +
          (!list.length ? '<div class="empty">No uniform orders on the way.<br><span class="small">When the uniform store dispatches an order to Kippa Ring, it appears here.</span></div>' : '')));

    async function act(fn, args, msg) {
      try { var r = await call(fn, args); if (msg) toast(typeof msg === 'function' ? msg(r) : msg); viewUniforms(done); }
      catch (err) { errToast(err); }
    }
    function find(id) { return list.find(function (t) { return t.id === +id; }); }
    on($app, 'click', '[data-u-arrived]', function (e, b) {
      b.disabled = true;
      act('uniform_set_status', { p_id: +b.getAttribute('data-u-arrived'), p_status: 'arrived' }, function (r) {
        return !r.staff_id ? 'Ticked as arrived. Choose who it\'s for so they get told.'
             : r.notified && r.push_on ? '📲 ' + uniWho(r) + ' has been told it\'s ready to collect'
             : 'Ticked. ' + uniWho(r) + ' will see it when they open the app';
      });
    });
    on($app, 'click', '[data-u-collected]', function (e, b) { b.disabled = true; act('uniform_set_status', { p_id: +b.getAttribute('data-u-collected'), p_status: 'collected' }, 'Marked as collected ✓ — remember TRACKS'); });
    on($app, 'click', '[data-u-undo]', function (e, b) { act('uniform_set_status', { p_id: +b.getAttribute('data-u-undo'), p_status: 'in_transit' }, 'Put back to "on its way"'); });
    on($app, 'click', '[data-u-reopen]', function (e, b) { act('uniform_set_status', { p_id: +b.getAttribute('data-u-reopen'), p_status: 'arrived' }, 'Back to waiting for pickup'); });
    on($app, 'change', '[data-u-tracks]', function (e, b) { act('uniform_tracks_done', { p_ids: [+b.getAttribute('data-u-tracks')], p_done: b.checked }); });
    on($app, 'click', '[data-u-close]', async function (e, b) {
      var t = find(b.getAttribute('data-u-close'));
      if (!(await confirmSheet('Close this ticket?', '<p>Order <b>' + esc(t.order_number) + '</b> for <b>' + esc(uniWho(t)) + '</b> will be marked as cancelled. Use this if it was sent here by mistake or won\'t be coming.</p>', 'Close ticket', true))) return;
      act('uniform_set_status', { p_id: t.id, p_status: 'cancelled' }, 'Ticket closed');
    });
    on($app, 'click', '[data-u-link]', function (e, b) { uniLinkPerson(find(b.getAttribute('data-u-link')), function () { viewUniforms(done); }); });
    var ta = qs('#uTracksAll');
    if (ta) ta.addEventListener('click', function () {
      act('uniform_tracks_done', { p_ids: list.filter(function (t) { return t.status === 'collected' && !t.tracks_done; }).map(function (t) { return t.id; }), p_done: true }, 'All marked as done in TRACKS');
    });
    qs('#uAdd').addEventListener('click', function () { uniAdd(function () { location.hash = '#/uniforms'; viewUniforms(false); }); });
    var sim = qs('#uSim');
    if (sim) sim.addEventListener('click', function () { act('demo_simulate_tracks', {}, '🚚 TRACKS sent an order (demo)'); });
  }
  async function uniPeopleOptions(selected) {
    var people = (await call('list_staff')).filter(function (p) { return p.active; });
    return '<option value="">Choose…</option>' + people.map(function (p) {
      return '<option value="' + p.id + '"' + (p.id === selected ? ' selected' : '') + '>' + esc(p.name) + '</option>';
    }).join('');
  }
  async function uniLinkPerson(t, done) {
    var opts = await uniPeopleOptions(t.staff_id);
    var w = sheet({ title: 'Who is order ' + t.order_number + ' for?',
      body: (t.person_name ? '<p class="small text-muted">TRACKS says: <b>' + esc(t.person_name) + '</b></p>' : '') +
        '<label class="form-label" for="ulP">Person</label><select class="form-select" id="ulP">' + opts + '</select>' +
        '<div class="form-text">Kippa Crew will remember this, so future orders under ' + (t.person_name ? '"' + esc(t.person_name) + '"' : 'this name') + ' go straight to them.</div>',
      foot: '<button class="btn btn-outline-secondary" data-close>Cancel</button><button class="btn btn-primary" id="ulSave">Save</button>' });
    qs('#ulSave', w).addEventListener('click', async function () {
      var v = qs('#ulP', w).value; if (!v) { qs('#ulP', w).focus(); return; }
      try { var r = await call('uniform_link_person', { p_id: t.id, p_staff_id: v }); closeSheet();
            toast(r.notified ? (r.push_on ? '📲 ' + r.staff_name + ' has been told it\'s ready' : 'Saved — ' + r.staff_name + ' will see it in the app') : 'Saved'); done(); }
      catch (err) { errToast(err); }
    });
  }
  async function uniAdd(done) {
    var opts = await uniPeopleOptions(null);
    var w = sheet({ title: 'Add a uniform order',
      body: '<p class="small text-muted">For an order TRACKS didn\'t send (or anything else coming to the depot for someone).</p><form id="uaForm" class="row g-3">' +
        '<div class="col-7"><label class="form-label" for="uaO">Order number</label><input class="form-control" id="uaO" required maxlength="40" autocomplete="off"></div>' +
        '<div class="col-5"><label class="form-label" for="uaN">Items <span class="text-muted">(optional)</span></label><input class="form-control" id="uaN" type="number" min="0" max="999" inputmode="numeric"></div>' +
        '<div class="col-12"><label class="form-label" for="uaP">For</label><select class="form-select" id="uaP" required>' + opts + '</select></div>' +
        '<div class="col-12"><label class="form-label" for="uaNote">Note <span class="text-muted">(optional)</span></label><input class="form-control" id="uaNote" maxlength="300"></div></form>',
      foot: '<button class="btn btn-outline-secondary" data-close>Cancel</button><button class="btn btn-primary" id="uaSave">Add</button>' });
    qs('#uaSave', w).addEventListener('click', async function () {
      if (!qs('#uaForm', w).reportValidity()) return;
      try { await call('uniform_add', { p_order: qs('#uaO', w).value.trim(), p_staff_id: qs('#uaP', w).value, p_items: int(qs('#uaN', w).value), p_note: qs('#uaNote', w).value.trim() || null });
            closeSheet(); toast('Added — tick it when it arrives'); done(); }
      catch (err) { errToast(err); }
    });
  }
  async function viewMyUniforms() {
    loading();
    var list = await call('my_uniform_orders');
    render('<div class="page-title"><h4>My uniform orders</h4></div>' +
      (list.length ? list.map(function (t) {
        var body = t.status === 'arrived'
          ? '<div class="fw-bold text-success fs-5 mb-1">📦 Ready to collect</div><div class="small mb-2">Arrived at Kippa Ring Depot ' + esc(when(t.arrived_at)) + '.</div>' +
            '<button class="btn btn-primary w-100" data-got="' + t.id + '">I\'ve picked it up</button>'
          : t.status === 'in_transit'
          ? '<div class="fw-bold mb-1" style="color:#9a4a10">🚚 On its way to the depot</div><div class="small text-muted">Sent ' + esc(when(t.created_at)) + '. You\'ll get a notification when it arrives.</div>'
          : '<div class="fw-bold text-muted mb-1">✓ Collected</div><div class="small text-muted">' + esc(when(t.collected_at)) + '</div>';
        return '<div class="card mb-2"' + (t.status === 'arrived' ? ' style="border:2px solid var(--qr-light-blue)"' : '') + '><div class="card-body">' +
          '<div class="small text-muted mb-1">Uniform order <b style="color:var(--qr-ink)">' + esc(t.order_number) + '</b>' + uniItems(t.items) + '</div>' + body + '</div></div>';
      }).join('') : '<div class="empty">No uniform orders coming to the depot for you right now.<br><span class="small">When the uniform store sends one to Kippa Ring, it shows here and you\'ll get a notification when it arrives.</span></div>'));
    on($app, 'click', '[data-got]', async function (e, b) {
      b.disabled = true;
      try { await call('uniform_got_it', { p_id: +b.getAttribute('data-got') }); toast('Thanks — marked as collected'); pulse(); viewMyUniforms(); }
      catch (err) { b.disabled = false; errToast(err); }
    });
  }

  // Settings > TRACKS link (Managers)
  function tracksCode(key) {
    var c = window.KRD_CONFIG || {};
    return '    KIPPA_CREW: {\n' +
           "      URL: '" + String(c.SUPABASE_URL || 'https://YOUR-PROJECT.supabase.co').replace(/\/+$/, '') + "',\n" +
           "      ANON_KEY: '" + String(c.SUPABASE_ANON_KEY || 'YOUR-PUBLISHABLE-KEY') + "',\n" +
           "      LINK_KEY: '" + key + "',\n" +
           "      DEPOTS: ['Kippa Ring']\n" +
           '    },';
  }
  async function paintTracksLink() {
    var host = qs('#tracksLink'); if (!host) return;
    var seq0 = routeSeq, t;
    try { t = await call('tracks_link_info', null, { bg: true }); } catch (err) { host.innerHTML = ''; return; }
    if (seq0 !== routeSeq || !document.body.contains(host)) return;
    host.innerHTML = '<div class="card mb-3" id="tracks"><div class="card-header">👕 TRACKS link (uniform orders)</div><div class="card-body">' +
      (!t.key
        ? '<p>When TRACKS dispatches a uniform order to Kippa Ring Depot, it can make a ticket here with the person\'s name and order number. You tick it when it arrives, and Kippa Crew tells them it\'s ready to collect.</p>' +
          '<p class="small text-muted">TRACKS only <b>sends</b> to Kippa Crew — Kippa Crew can\'t see or change anything in TRACKS.</p>' +
          '<button type="button" class="btn btn-primary" id="tlOn">Turn on TRACKS link</button>'
        : '<p class="mb-2">' + (t.last_seen ? '✅ Last heard from TRACKS <b>' + esc(ago(t.last_seen)) + '</b>' + (t.last_event ? ' <span class="small text-muted">(' + esc(t.last_event) + ')</span>' : '')
                                           : '⏳ <b>Waiting for TRACKS.</b> Nothing received yet.') + '</p>' +
          '<p class="small mb-1">In TRACKS <code>admin.aspx</code>, find <code>KIPPA_CREW</code> near the top (in <code>var CONFIG</code>) and replace it with:</p>' +
          '<pre class="small p-2 mb-2" style="background:#F7F6F2;border:1px solid var(--qr-line);border-radius:.4rem;white-space:pre-wrap;word-break:break-all" id="tlCode">' + esc(tracksCode(t.key)) + '</pre>' +
          '<div class="d-flex gap-2 flex-wrap mb-2"><button type="button" class="btn btn-primary btn-sm" id="tlCopy">' + 'Copy</button>' +
          '<button type="button" class="btn btn-outline-secondary btn-sm" id="tlNew">Make a new key</button>' +
          '<button type="button" class="btn btn-outline-danger btn-sm" id="tlOff">Turn off</button></div>' +
          '<p class="small text-muted mb-0">Keep the link key private. If it gets out, press <b>Make a new key</b> and paste the new code into TRACKS.</p>' +
          (t.remembered ? '<p class="small text-muted mt-2 mb-0">' + plural(t.remembered, 'TRACKS name') + ' linked to people by hand and remembered.</p>' : '') +
          (t.unmatched ? '<div class="alert alert-warning small mt-2 mb-0"><a href="#/uniforms">' + plural(t.unmatched, 'uniform order') + '</a> couldn\'t be matched to anyone.</div>' : '')) +
      '</div></div>';
    if (location.hash === '#/settings#tracks') host.scrollIntoView();
    var on1 = qs('#tlOn', host), nw = qs('#tlNew', host), off = qs('#tlOff', host), cp = qs('#tlCopy', host);
    if (on1) on1.addEventListener('click', async function () { try { await call('tracks_link_set', { p_on: true }); paintTracksLink(); } catch (err) { errToast(err); } });
    if (cp) cp.addEventListener('click', function () { copyText(tracksCode(t.key)); });
    if (nw) nw.addEventListener('click', async function () {
      if (!(await confirmSheet('Make a new link key?', '<p>TRACKS will stop being able to send orders until you paste the new code into it.</p>', 'Make new key', true))) return;
      try { await call('tracks_link_set', { p_on: true }); toast('New key made — paste the new code into TRACKS'); paintTracksLink(); } catch (err) { errToast(err); }
    });
    if (off) off.addEventListener('click', async function () {
      if (!(await confirmSheet('Turn off the TRACKS link?', '<p>TRACKS won\'t be able to send uniform orders here. Tickets you already have stay.</p>', 'Turn off', true))) return;
      try { await call('tracks_link_set', { p_on: false }); paintTracksLink(); } catch (err) { errToast(err); }
    });
  }

  // ------------------------------------------------------------------
  //  REPORT A FAULT — opens QR's facilities fault forms (ServiceNow)
  // ------------------------------------------------------------------
  var FAULT_FORMS = [
    { title: 'Yards & depots', sub: 'Including Kippa Ring Depot', icon: '🚉',
      url: 'https://queenslandrail.service-now.com/service_management?id=sc_cat_item&sys_id=ecc0e3511b6b9610a0519687b04bcb6d' },
    { title: 'BHAB, BHI Platform, Abbotsford Rd & Rail Centres', sub: 'Office and rail centre buildings', icon: '🏢',
      url: 'https://queenslandrail.service-now.com/service_management?id=sc_cat_item&sys_id=311320bd1b4eb1501ee87510dc4bcbde' }
  ];
  // Safety-orange "Report a fault" buttons used on the home screens
  function faultBlock() {
    return '<div class="fault-block mb-3"><div class="section-title d-flex align-items-center gap-2"><span style="width:22px;color:#B4560F">' + I.wrench + '</span>Report a fault</div>' +
      '<div class="fault-grid">' + FAULT_FORMS.map(function (f) {
        return '<a class="btn btn-safety fault-link" href="' + esc(f.url) + '" target="_blank" rel="noopener noreferrer">' +
          '<span class="fw-bold">' + esc(f.title) + ' ↗</span><span class="small">' + esc(f.sub) + '</span></a>';
      }).join('') + '</div></div>';
  }
  function viewFaults() {
    render('<div class="page-title"><h4>Report a fault</h4></div>' +
      '<p class="text-muted">Broken light, leaking tap, faulty door or anything else that needs fixing? Pick the location to open the QR facilities fault form.</p>' +
      FAULT_FORMS.map(function (f) {
        return '<a class="card mb-3 text-decoration-none fault-link" href="' + esc(f.url) + '" target="_blank" rel="noopener noreferrer" style="border:2px solid var(--qr-orange)">' +
          '<div class="card-body"><div class="d-flex align-items-center gap-3 mb-3">' +
          '<span style="font-size:2rem;line-height:1">' + f.icon + '</span>' +
          '<div><div class="fw-bold fs-5" style="color:var(--qr-ink);line-height:1.25">' + esc(f.title) + '</div><div class="small text-muted">' + esc(f.sub) + '</div></div></div>' +
          '<span class="btn btn-safety w-100">Report a fault here ↗</span></div></a>';
      }).join('') +
      '<div class="alert alert-light border small"><b>Good to know</b><ul class="mb-0 ps-3 mt-1">' +
        '<li>The form opens on the QR website. You may need to sign in with your QR account.</li>' +
        '<li>Kippa Crew doesn\'t see or keep anything you put in the form.</li>' +
        '<li>Anything unsafe? Report it to your TOI or supervisor straight away as well.</li></ul></div>');
  }

  // ------------------------------------------------------------------
  //  SUGGESTION BOX (anonymous)
  // ------------------------------------------------------------------
  var SUG_CATS = [['stores', 'Store room'], ['rosters', 'Rosters & shifts'], ['facilities', 'Facilities'], ['safety', 'Safety'], ['communication', 'Communication'], ['other', 'Other']];
  function sugCat(c) { var f = SUG_CATS.find(function (x) { return x[0] === c; }); return f ? f[1] : 'Other'; }
  var SUG_STATUS = { 'new': ['New', 'bg-danger'], seen: ['Read', 'bg-secondary'], planned: ['Working on it', 'bg-warning'], done: ['Done', 'bg-success'], not_doing: ['Not going ahead', 'bg-dark'] };
  function sugBadge(st) { var x = SUG_STATUS[st] || SUG_STATUS.seen; return '<span class="badge ' + x[1] + '">' + x[0] + '</span>'; }

  async function viewSuggest() {
    loading();
    var shared = await call('shared_suggestions');
    render('<div class="page-title"><h4>Suggestion box</h4></div>' +
      '<div class="card mb-3" style="border:2px solid var(--qr-light-blue)"><div class="card-body">' +
        '<div class="d-flex gap-2 align-items-start mb-3"><span style="font-size:1.6rem;line-height:1">🔒</span><div><b>Anonymous.</b> Your name is not saved with your suggestion, so no one — not even the managers — can see who sent it.' +
        ' <span class="text-muted">Tip: leave out details only you would know if you want to stay anonymous.</span></div></div>' +
        '<form id="sgForm">' +
          '<label class="form-label">What\'s it about?</label><div class="d-flex flex-wrap gap-2 mb-3" id="sgCats">' +
            SUG_CATS.map(function (c, i) { return '<button type="button" class="btn btn-sm ' + (c[0] === 'other' ? 'btn-primary' : 'btn-outline-primary') + '" data-cat="' + c[0] + '">' + c[1] + '</button>'; }).join('') + '</div>' +
          '<label class="form-label" for="sgBody">Your suggestion</label>' +
          '<textarea class="form-control" id="sgBody" rows="5" maxlength="1000" required placeholder="An idea, something that bugs you, something we could do better…"></textarea>' +
          '<div class="d-flex justify-content-between align-items-center mt-2"><span class="small text-muted" id="sgCount">0 / 1000</span>' +
          '<button class="btn btn-primary" id="sgSend">Send anonymously</button></div>' +
        '</form></div></div>' +
      '<div class="section-title">You said, we did</div>' +
      (shared.length ? shared.map(function (x) {
        return '<div class="card mb-2"><div class="card-body py-2">' +
          '<div class="d-flex justify-content-between align-items-center mb-1"><span class="small text-muted">' + esc(sugCat(x.category)) + '</span>' + sugBadge(x.status) + '</div>' +
          '<div class="mb-2" style="white-space:pre-wrap">“' + esc(x.body) + '”</div>' +
          '<div class="p-2 small" style="background:#F7F6F2;border-left:4px solid var(--qr-light-blue);border-radius:.3rem;white-space:pre-wrap"><b>Reply:</b> ' + esc(x.reply) + '</div>' +
          '</div></div>';
      }).join('') : '<div class="empty">Nothing here yet. When a manager replies to a suggestion and shares it, it shows here.</div>'));
    var cat = 'other', body = qs('#sgBody'), count = qs('#sgCount');
    on($app, 'click', '[data-cat]', function (e, b) {
      cat = b.getAttribute('data-cat');
      qsa('[data-cat]').forEach(function (x) { x.className = 'btn btn-sm ' + (x === b ? 'btn-primary' : 'btn-outline-primary'); });
    });
    body.addEventListener('input', function () { count.textContent = body.value.length + ' / 1000'; });
    qs('#sgForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = qs('#sgSend');
      if (body.value.trim().length < 3) { body.focus(); return; }
      btn.disabled = true;
      try {
        await call('send_suggestion', { p_body: body.value.trim(), p_category: cat });
        body.value = ''; count.textContent = '0 / 1000';
        sheet({ title: 'Thanks — suggestion sent', body: '<p>It\'s gone into the suggestion box with no name on it.</p><p class="mb-0 text-muted small">If a manager replies and shares it, you\'ll see it under <b>You said, we did</b>.</p>',
                foot: '<button class="btn btn-primary" data-close>OK</button>' });
      } catch (err) { errToast(err); }
      btn.disabled = false;
    });
  }

  async function viewSuggestions(done) {
    loading();
    var d = await call('list_suggestions', { p_done: !!done });
    if (d.new) { try { await call('seen_suggestions', null, { bg: true }); } catch (_) {} }
    S.pulse.suggestions_new = 0; renderNav();
    render('<div class="page-title"><h4>Suggestion box</h4></div>' +
      '<div class="seg"><a href="#/suggestions" class="' + (done ? '' : 'active') + '">Open (' + d.open + ')</a><a href="#/suggestions/done" class="' + (done ? 'active' : '') + '">Closed</a></div>' +
      '<p class="small text-muted">🔒 These are anonymous: the app doesn\'t record who sent them, so there\'s no way to reply to one person. Reply here and tick <b>Share with the crew</b> to show it to everyone under <b>You said, we did</b>.</p>' +
      (d.items.length ? d.items.map(function (x) {
        return '<div class="card mb-2" data-s="' + x.id + '"><div class="card-body py-2">' +
          '<div class="d-flex justify-content-between align-items-center mb-1"><span class="small text-muted">' + esc(sugCat(x.category)) + ' · ' + esc(fmtDay(x.created_on)) + '</span>' + sugBadge(x.status) + '</div>' +
          '<div class="mb-2 fs-6" style="white-space:pre-wrap">' + esc(x.body) + '</div>' +
          '<details' + (x.reply ? ' open' : '') + '><summary class="small fw-bold" style="cursor:pointer;color:var(--qr-light-blue)">' + (x.reply ? 'Your reply' : 'Reply / update') + '</summary>' +
            '<div class="row g-2 mt-1"><div class="col-12"><select class="form-select form-select-sm" data-st>' +
              Object.keys(SUG_STATUS).filter(function (k) { return k !== 'new'; }).map(function (k) { return '<option value="' + k + '"' + (x.status === k || (x.status === 'new' && k === 'seen') ? ' selected' : '') + '>' + SUG_STATUS[k][0] + '</option>'; }).join('') +
            '</select></div>' +
            '<div class="col-12"><textarea class="form-control form-control-sm" rows="3" maxlength="1000" data-reply placeholder="What you\'re doing about it (optional)">' + esc(x.reply || '') + '</textarea></div>' +
            '<div class="col-12 d-flex align-items-center gap-2"><div class="form-check form-switch mb-0 flex-grow-1"><input class="form-check-input" type="checkbox" role="switch" id="sh' + x.id + '" data-share' + (x.shared ? ' checked' : '') + '>' +
              '<label class="form-check-label small" for="sh' + x.id + '">Share with the crew</label></div>' +
              '<button class="btn btn-link btn-sm text-danger" data-del>Delete</button><button class="btn btn-primary btn-sm" data-save>Save</button></div></div>' +
          '</details></div></div>';
      }).join('') : '<div class="empty">' + (done ? 'Nothing closed yet.' : 'No suggestions yet. Let the crew know the box is there — try a TOI broadcast.') + '</div>'));
    on($app, 'click', '[data-save]', async function (e, b) {
      var c = b.closest('[data-s]');
      b.disabled = true;
      try {
        await call('update_suggestion', { p_id: +c.getAttribute('data-s'), p_status: qs('[data-st]', c).value, p_reply: qs('[data-reply]', c).value.trim() || null, p_shared: qs('[data-share]', c).checked });
        toast(qs('[data-share]', c).checked ? 'Saved and shared with the crew' : 'Saved'); viewSuggestions(done);
      } catch (err) { b.disabled = false; errToast(err); }
    });
    on($app, 'click', '[data-del]', async function (e, b) {
      var c = b.closest('[data-s]');
      if (!(await confirmSheet('Delete this suggestion?', '<p>Use this for anything offensive or sent by mistake. It can\'t be undone.</p>', 'Delete', true))) return;
      try { await call('delete_suggestion', { p_id: +c.getAttribute('data-s') }); toast('Deleted'); viewSuggestions(done); } catch (err) { errToast(err); }
    });
  }

  // ------------------------------------------------------------------
  //  SETTINGS
  // ------------------------------------------------------------------
  async function viewSettings() {
    loading();
    var s = await call('get_settings');
    var appUrl = s.app_url || (location.origin + location.pathname);
    var seq0 = routeSeq, pc = await pushCfg(true);
    if (seq0 !== routeSeq) return;
    var fnUrl = String((window.KRD_CONFIG || {}).SUPABASE_URL || '').replace(/\/+$/, '') + '/functions/v1/kippa-push';
    var pushCard = '<div class="card mb-3"><div class="card-header">🔔 Phone notifications</div><div class="card-body">' +
      (api.isDemo ? '<p class="mb-0">Available in the live app.</p>'
       : pc.ready ? '<p class="mb-2">✅ <b>Connected.</b> ' + pc.people_on + ' of ' + pc.people_total + ' people have turned notifications on.</p>' +
                    '<p class="small text-muted mb-2">Banners go out for new TOI broadcasts, chat messages, and (to managers) items reaching par. Each person turns them on under <b>Me</b>.</p>' +
                    '<button type="button" class="btn btn-outline-primary btn-sm" id="pushReconnect">Re-check connection</button>'
       : '<p>Not connected yet. First add the <b>kippa-push</b> function in Supabase (see the setup guide), then press:</p>' +
         '<button type="button" class="btn btn-primary" id="pushConnect">Connect notifications</button>') +
      '</div></div>';
    render('<div class="page-title"><h4>Settings</h4></div>' +
      (api.isDemo ? '<div class="alert alert-warning">Demo mode — emails are not really sent.</div>' : '') +
      '<form id="setForm"><div class="card mb-3"><div class="card-header">Reorder emails</div><div class="card-body">' +
        '<div class="mb-3"><label class="form-label" for="sEmail">Send alerts to</label><input class="form-control" id="sEmail" type="text" inputmode="email" value="' + esc(s.alert_email) + '" placeholder="you@example.com">' +
          '<div class="form-text">Separate several addresses with commas.</div></div>' +
        '<div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" role="switch" id="sInstant"' + (s.instant_alerts ? ' checked' : '') + '><label class="form-check-label" for="sInstant"><b>Instant alert</b> when an item reaches its par level</label></div>' +
        '<div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" role="switch" id="sDaily"' + (s.daily_summary ? ' checked' : '') + '><label class="form-check-label" for="sDaily"><b>Daily summary</b> at 7:00am (reorder list + what was taken yesterday)</label></div>' +
      '</div></div>' +
      pushCard +
      '<div id="tracksLink"></div>' +
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
    log(); paintTracksLink();
    async function connectPush(btn) {
      btn.disabled = true;
      try {
        var k = String((window.KRD_CONFIG || {}).SUPABASE_ANON_KEY || '');
        var res = await fetch(fnUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: k }, body: JSON.stringify({ action: 'init' }) });
        var out = {}; try { out = await res.json(); } catch (_) {}
        if (res.status === 401) throw new Error('Supabase blocked it: turn OFF "Verify JWT" for the kippa-push function, then try again.');
        if (res.status === 404) throw new Error('No kippa-push function found. Check it\'s deployed with exactly that name.');
        if (!res.ok || !out.ok) throw new Error(out.error || ('Connection failed (' + res.status + ')'));
        toast('🔔 Notifications connected. Now turn them on under Me.');
        viewSettings();
      } catch (err) { btn.disabled = false; errToast(err.message === 'Failed to fetch' ? { message: 'Couldn\'t reach the kippa-push function. Check it\'s deployed and "Verify JWT" is off.' } : err); }
    }
    var pcb = qs('#pushConnect') || qs('#pushReconnect');
    if (pcb) pcb.addEventListener('click', function () { connectPush(pcb); });
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
      '<div class="seg"><a href="#/broadcasts" class="' + (active === 'bc' ? 'active' : '') + '">📣 Broadcasts' + (nb ? ' <span class="badge bg-danger">' + nb + '</span>' : '') + '</a>' +
      '<a href="#/chat" class="' + (active === 'chat' ? 'active' : '') + '">Chat' + (nc ? ' <span class="badge bg-danger">' + nc + '</span>' : '') + '</a></div>';
  }
  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function linkify(text) {
    return esc(text).replace(/(https?:\/\/[^\s<]+)/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>'; });
  }
  function paintBroadcastBanner() {
    var el = document.getElementById('bcBanner'); if (!el) return;
    var n = S.pulse.broadcasts || 0;
    var u = S.pulse.uniforms_ready || 0;
    el.innerHTML = (u ? '<a href="#/my-uniforms" class="alert alert-success d-flex align-items-center gap-2 text-decoration-none mb-3" style="color:var(--qr-ink)">' +
      '<span style="width:26px;flex:none">' + I.shirt + '</span><span class="flex-grow-1"><b>' + (u === 1 ? 'Your uniform order is' : u + ' uniform orders are') + ' ready to collect</b> at the depot</span><span>›</span></a>' : '') +
      (n ? '<a href="#/broadcasts" class="alert alert-warning d-flex align-items-center gap-2 text-decoration-none mb-3" style="color:var(--qr-ink)">' +
      '<span style="width:26px;flex:none;color:#9a4a10">' + I.megaphone + '</span><span class="flex-grow-1"><b>' + plural(n, 'new broadcast') + '</b> — tap to read</span><span>›</span></a>' : '');
  }
  function maybeUrgentPopup() {
    var list = (S.pulse.urgent || []).filter(function (u) { return !S.urgentShown[u.id] && location.hash !== '#/broadcast/' + u.id; });
    if (!list.length || $sheetHost.innerHTML) return;
    var u = list[0]; S.urgentShown[u.id] = true;
    var w = sheet({
      title: '📣 URGENT ' + String(u.kind_label || 'TOI Broadcast').toUpperCase(),
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
      (r.can_send ? '<a class="btn btn-primary btn-lg w-100 mb-3 d-flex align-items-center justify-content-center gap-2" href="#/broadcasts/new"><span style="width:24px">' + I.megaphone + '</span>New ' + (r.send_kind === 'depot' ? 'Depot Announcement' : 'TOI Broadcast') + '</a>' : '') +
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
        '<span class="small text-muted">' + esc(b.kind_label || 'TOI Broadcast') + '</span>' + (b.urgent ? '<span class="badge bg-danger ms-auto">URGENT</span>' : '') + '</div>' +
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
    if (!S.me.can_broadcast) { location.hash = '#/broadcasts'; return; }
    var files = [];   // {file, url}
    render('<div class="d-flex align-items-center gap-2 mb-2"><a href="#/broadcasts" class="btn btn-sm btn-outline-secondary" aria-label="Back" style="width:40px">' + I.back + '</a><h4 class="m-0">New ' + sendLabel() + '</h4></div>' +
      '<p class="text-muted">Goes to <b>everyone</b> in Kippa Crew.</p>' +
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
  //  PHONE NOTIFICATIONS (Web Push)
  // ------------------------------------------------------------------
  var IS_IOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function isInstalled() { return window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); }
  function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext; }
  function u8FromB64url(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    var bin = atob(s), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
  }
  function deviceLabel() {
    var ua = navigator.userAgent;
    var m = /iPhone|iPad|Android|Windows|Macintosh/.exec(ua); var b = /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    return (m ? m[0] : 'Device') + ' · ' + b;
  }
  async function pushCfg(force) {
    if (api.isDemo) return { ready: false, demo: true };
    if (!S.pushCfg || force) { try { S.pushCfg = await call('push_config', null, { bg: true }); } catch (_) { S.pushCfg = { ready: false }; } }
    return S.pushCfg;
  }
  // Never waits on a background helper that isn't running (that would hang sign-out)
  async function currentSub() {
    if (!pushSupported()) return null;
    try {
      var reg = await navigator.serviceWorker.getRegistration();
      return reg ? await reg.pushManager.getSubscription() : null;
    } catch (_) { return null; }
  }
  async function readyRegistration() {
    var reg = await navigator.serviceWorker.getRegistration();
    if (!reg) reg = await navigator.serviceWorker.register('sw.js');
    return Promise.race([navigator.serviceWorker.ready, new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error('This phone couldn\'t start notifications. Close the app fully, reopen it and try again.')); }, 10000);
    })]);
  }
  // Must be called from a button tap (iPhone requires it)
  async function enablePush() {
    if (api.isDemo) return toast('Phone notifications work in the live app, not the demo.', true);
    if (!pushSupported()) {
      if (IS_IOS && !isInstalled()) return toast('On iPhone, first add Kippa Crew to your Home Screen, then open it from there.', true);
      return toast('This browser can\'t show notifications. Try Chrome or Samsung Internet.', true);
    }
    var cfg = await pushCfg(true);
    if (!cfg.ready) return toast('Notifications aren\'t set up yet — a manager needs to connect them in Settings.', true);
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast(perm === 'denied' ? 'Notifications are blocked for this app. Allow them in your phone\'s settings, then try again.' : 'Notifications not turned on.', true);
    var reg = await readyRegistration();
    var sub = await reg.pushManager.getSubscription();
    if (sub && sub.options && sub.options.applicationServerKey) {
      var have = new Uint8Array(sub.options.applicationServerKey), want = u8FromB64url(cfg.public_key);
      if (have.length !== want.length || have.some(function (b, i) { return b !== want[i]; })) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8FromB64url(cfg.public_key) });
    var j = sub.toJSON();
    await call('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_device: deviceLabel() }, { bg: true });
    LS.set('pushOn', true);
    toast('🔔 Notifications are on for this phone');
    return true;
  }
  async function disablePush(quiet) {
    var sub = await currentSub();
    if (sub) {
      try { await api.rpc('remove_push_subscription', { p_endpoint: sub.endpoint }); } catch (_) {}
      try { await sub.unsubscribe(); } catch (_) {}
    }
    LS.del('pushOn');
    if (!quiet) toast('Notifications turned off for this phone');
  }
  // Keep this phone linked to whoever is signed in (endpoints can change over time)
  async function syncPush() {
    if (api.isDemo || !S.token || !pushSupported() || Notification.permission !== 'granted') return;
    var sub = await currentSub(); if (!sub) return;
    var cfg = await pushCfg(); if (!cfg.ready) return;
    var j = sub.toJSON();
    try { await call('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_device: deviceLabel() }, { bg: true }); } catch (_) {}
  }
  // Small "turn on" card for the Take / Home screens
  async function paintPushPrompt() {
    var el = document.getElementById('pushPrompt'); if (!el || api.isDemo || LS.get('pushPromptHidden', false)) return;
    if (pushSupported() && Notification.permission !== 'default') return;
    if (!pushSupported() && !(IS_IOS && !isInstalled())) return;
    var cfg = await pushCfg(); if (!cfg.ready) return;
    el = document.getElementById('pushPrompt'); if (!el) return;
    var ios = IS_IOS && !isInstalled();
    el.innerHTML = '<div class="alert alert-info d-flex gap-2 align-items-start mb-3"><span style="font-size:1.4rem;line-height:1">🔔</span><div class="flex-grow-1">' +
      '<b>Get a banner on your phone</b> for new TOI broadcasts and messages' + (isAdmin() ? ' (and low stock)' : '') + '.' +
      (ios ? '<div class="small mt-1">On iPhone: tap <b>Share</b> → <b>Add to Home Screen</b>, open Kippa Crew from there, then turn this on.</div>' : '') +
      '<div class="d-flex gap-2 mt-2">' + (ios ? '' : '<button class="btn btn-sm btn-primary" id="ppOn">Turn on</button>') +
      '<button class="btn btn-sm btn-outline-secondary" id="ppLater">Not now</button></div></div></div>';
    var on1 = document.getElementById('ppOn');
    if (on1) on1.addEventListener('click', async function () { try { if (await enablePush()) el.innerHTML = ''; } catch (e) { errToast(e); } });
    document.getElementById('ppLater').addEventListener('click', function () { LS.set('pushPromptHidden', true); el.innerHTML = ''; });
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      var m = e.data || {};
      if (m.type === 'push') pulse();
      if (m.type === 'open' && m.hash) { location.hash = m.hash; pulse(); }
    });
  }
  async function notifCardHtml() {
    if (api.isDemo) return '<div class="card mb-3"><div class="card-header">🔔 Phone notifications</div><div class="card-body"><p class="mb-0">Banner notifications work in the live app (not in this demo).</p></div></div>';
    var cfg = await pushCfg(true), sub = await currentSub(), perm = ('Notification' in window) ? Notification.permission : 'unsupported';
    var on1 = sub && perm === 'granted' && cfg.my_devices > 0, body;
    if (!cfg.ready) body = '<p class="mb-0">Not set up yet. ' + (isAdmin() ? 'Connect them in <a href="#/settings">Settings</a>.' : 'Ask a manager to connect them.') + '</p>';
    else if (!pushSupported() && IS_IOS && !isInstalled()) body = '<p class="mb-0">On iPhone, notifications only work from the Home Screen app: tap <b>Share</b> → <b>Add to Home Screen</b>, open Kippa Crew from there, and come back here.</p>';
    else if (!pushSupported()) body = '<p class="mb-0">This browser can\'t show notifications. Use Chrome or Samsung Internet (Android), or the Home Screen app (iPhone).</p>';
    else if (perm === 'denied') body = '<p class="mb-0">Notifications are <b>blocked</b> for this app. Open your phone\'s <b>Settings → Notifications</b> (or the browser\'s site settings), allow Kippa Crew, then come back.</p>';
    else body = '<p>' + (on1 ? '✅ <b>On</b> for this phone.' : 'Off for this phone.') + ' You\'ll get a banner for new TOI broadcasts and messages' + (isAdmin() ? ', and when stock drops to its par level' : '') + '.</p>' +
      '<div class="d-flex gap-2 flex-wrap">' + (on1 ? '<button class="btn btn-outline-primary" id="nTest">Send me a test</button><button class="btn btn-outline-danger" id="nOff">Turn off</button>'
                                                    : '<button class="btn btn-primary" id="nOn">🔔 Turn on notifications</button>') + '</div>';
    return '<div class="card mb-3" id="notifCard"><div class="card-header">🔔 Phone notifications</div><div class="card-body">' + body + '</div></div>';
  }
  function wireNotifCard(rerender) {
    var a = qs('#nOn'), b = qs('#nOff'), c = qs('#nTest');
    if (a) a.addEventListener('click', async function () { a.disabled = true; try { await enablePush(); } catch (e) { errToast(e); } rerender(); });
    if (b) b.addEventListener('click', async function () { await disablePush(); S.pushCfg = null; rerender(); });
    if (c) c.addEventListener('click', async function () { try { await call('push_test', null, { bg: true }); toast('Test sent — it should pop up in a few seconds'); } catch (e) { errToast(e); } });
  }

  // ------------------------------------------------------------------
  //  WHAT'S NEW (patch notes pop-up)
  // ------------------------------------------------------------------
  var whatsNewBusy = false;
  function noteHtml(n) {
    return '<div class="wn-note"><div class="wn-title">' + esc(n.title) + '</div>' +
      '<div class="small text-muted mb-2">' + esc(fmtDay(n.published_at)) + (n.by ? ' · ' + esc(n.by) : '') + '</div>' +
      '<ul class="wn-points">' + n.points.map(function (p) { return '<li>' + linkify(p) + '</li>'; }).join('') + '</ul></div>';
  }
  async function maybeWhatsNew() {
    if (whatsNewBusy || !S.token || !S.me || S.me.must_change_pin || !(S.pulse.whats_new > 0) || $sheetHost.innerHTML) return;
    if (/^#\/broadcast(s\/new|\/)/.test(location.hash)) return;   // don't interrupt someone reading or writing a broadcast
    whatsNewBusy = true;
    try {
      var notes = await call('whats_new_pending', null, { bg: true });
      if (!notes.length || $sheetHost.innerHTML) return;
      var w = sheet({ title: '✨ What\'s New', locked: true,
        body: notes.map(noteHtml).join('<hr>'),
        foot: '<button class="btn btn-primary btn-lg w-100" id="wnOk">Got it</button>' });
      qs('#wnOk', w).addEventListener('click', async function (e) {
        e.currentTarget.disabled = true;
        try { await call('ack_whats_new', { p_ids: notes.map(function (n) { return n.id; }) }, { bg: true }); S.pulse.whats_new = 0; closeSheet(); maybeUrgentPopup(); }
        catch (err) { e.currentTarget.disabled = false; errToast(err); }
      });
    } catch (_) {} finally { whatsNewBusy = false; }
  }

  async function viewWhatsNew() {
    loading();
    var notes = await call('list_whats_new');
    var today = fmtDay(new Date().toISOString());
    render('<div class="page-title"><h4>What\'s New</h4></div>' +
      (isAdmin() ? '<div class="card mb-3"><div class="card-header">Post an update</div><div class="card-body">' +
          '<p class="small text-muted">Everyone sees this as a pop-up the next time they open the app, and taps <b>Got it</b> to close it. It only shows once per person.</p>' +
          '<label class="form-label" for="wnTitle">Title</label><input class="form-control mb-3" id="wnTitle" maxlength="120" value="Update – ' + esc(today) + '">' +
          '<label class="form-label" for="wnPoints">Points <span class="fw-normal text-muted">(one per line)</span></label>' +
          '<textarea class="form-control mb-2" id="wnPoints" rows="7" placeholder="New: item photos on the Take screen&#10;Fixed: chat badge now clears straight away&#10;Reminder: log everything you take"></textarea>' +
          '<div class="d-flex gap-2 flex-wrap"><button class="btn btn-outline-primary" id="wnFill">Fill in this version\'s app changes</button>' +
          '<button class="btn btn-outline-secondary" id="wnPreview">Preview</button><button class="btn btn-primary" id="wnPost">Post to everyone</button></div>' +
        '</div></div>' : '') +
      '<div class="section-title">' + (isAdmin() ? 'Past updates' : 'Updates') + '</div>' +
      (notes.length ? notes.map(function (n) {
        return '<div class="card mb-2"><div class="card-body">' + noteHtml(n) +
          (isAdmin() ? '<div class="d-flex justify-content-between align-items-center mt-2"><span class="badge bg-navy">Seen by ' + n.seen_count + ' of ' + n.audience + '</span>' +
            '<button class="btn btn-sm btn-outline-danger" data-wndel="' + n.id + '">Delete</button></div>' : '') + '</div></div>';
      }).join('') : '<div class="empty">No updates yet.</div>'));
    if (!isAdmin()) return;
    function points() { return qs('#wnPoints').value.split('\n').map(function (x) { return x.replace(/^\s*[-•*]\s*/, '').trim(); }).filter(Boolean); }
    qs('#wnFill').addEventListener('click', function () {
      var ta = qs('#wnPoints'), cur = ta.value.trim();
      ta.value = (cur ? cur + '\n' : '') + APP_CHANGES.join('\n');
      if (/^Update – /.test(qs('#wnTitle').value)) qs('#wnTitle').value = 'Kippa Crew v' + APP_VERSION + ' – ' + today;
    });
    qs('#wnPreview').addEventListener('click', function () {
      if (!points().length) return toast('Add at least one point', true);
      sheet({ title: '✨ What\'s New', body: '<div class="alert alert-secondary small">Preview — this is what everyone will see.</div>' +
        noteHtml({ title: qs('#wnTitle').value, published_at: new Date().toISOString(), by: S.me.name, points: points() }),
        foot: '<button class="btn btn-primary btn-lg w-100" data-close>Got it</button>' });
    });
    qs('#wnPost').addEventListener('click', async function () {
      var pts = points(), title = qs('#wnTitle').value.trim();
      if (!title) return toast('Give the update a title', true);
      if (!pts.length) return toast('Add at least one point', true);
      if (!(await confirmSheet('Post to everyone?', '<p>Everyone will see <b>' + esc(title) + '</b> (' + plural(pts.length, 'point') + ') next time they open the app.</p>', 'Post update'))) return;
      try { await call('publish_whats_new', { p_title: title, p_points: pts }); toast('Update posted ✨'); viewWhatsNew(); } catch (err) { errToast(err); }
    });
    on($app, 'click', '[data-wndel]', async function (e, b) {
      if (!(await confirmSheet('Delete this update?', '<p>It will be removed from everyone\'s history. People who haven\'t seen it yet won\'t get the pop-up.</p>', 'Delete', true))) return;
      try { await call('delete_whats_new', { p_id: +b.getAttribute('data-wndel') }); toast('Deleted'); viewWhatsNew(); } catch (err) { errToast(err); }
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
    pulse(); flushOutbox(); syncPush();
  })();
})();
