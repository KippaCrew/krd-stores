/* Kippa Crew — DEMO backend.
   A faithful in-browser copy of the database functions in supabase/schema.sql,
   so the app can be tried with no setup. Data is kept on this device only. */
(function (global) {
  'use strict';

  var KEY = 'krd_demo_v8';
  var memory = null;
  var fileMem = {};   // demo attachments live in memory only (phone storage is too small for PDFs)
  var imgMem = {};    // demo item photos, same reason

  function uid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  function now() { return new Date().toISOString(); }
  function fail(msg) { throw new Error(msg); }
  function lc(s) { return String(s || '').toLowerCase(); }
  function int(v, d) { var n = parseInt(v, 10); return isNaN(n) ? d : n; }

  function seed() {
    var admin = { id: uid(), name: 'Manager (demo)', pin: '1234', role: 'admin', active: true, failed: 0, locked_until: null, last_login: null, can_broadcast: true, position: 'other' };
    var sam = { id: uid(), name: 'Sam Smith', pin: '1111', role: 'staff', active: true, failed: 0, locked_until: null, last_login: null, position: 'driver', union_affiliation: 'rtbu' };
    var alex = { id: uid(), name: 'Alex Brown', pin: '2222', role: 'staff', active: true, failed: 0, locked_until: null, last_login: null, position: 'guard', union_affiliation: 'afule' };
    var pat = { id: uid(), name: 'Pat Admin (demo)', pin: '3333', role: 'administrator', active: true, failed: 0, locked_until: null, last_login: null, position: 'other' };
    var items = [
      ['Sunscreen SPF50+ 1L pump', 'Sun & Bugs', 'bottle', 9, 4, 12],
      ['Sunscreen SPF50+ 100ml tube', 'Sun & Bugs', 'tube', 22, 10, 40],
      ['Insect repellent (aerosol)', 'Sun & Bugs', 'can', 5, 6, 18],
      ['Lip balm SPF30', 'Sun & Bugs', 'each', 14, 6, 20],
      ['Batteries AA (4 pack)', 'Batteries', 'pack', 11, 5, 20],
      ['Batteries AAA (4 pack)', 'Batteries', 'pack', 3, 4, 16],
      ['Batteries 9V', 'Batteries', 'each', 6, 2, 8],
      ['Pens – blue', 'Stationery', 'each', 48, 20, 100],
      ['Pens – black', 'Stationery', 'each', 35, 20, 100],
      ['Notebook A5', 'Stationery', 'each', 12, 5, 20],
      ['Permanent marker', 'Stationery', 'each', 9, 5, 20],
      ['Hand sanitiser 500ml', 'Hygiene', 'bottle', 7, 4, 12],
      ['Disposable earplugs', 'PPE', 'pair', 140, 50, 200],
      ['Nitrile gloves (L)', 'PPE', 'box', 4, 3, 10],
      ['Safety glasses – clear', 'PPE', 'each', 10, 5, 20],
      ['Cable ties (pack)', 'General', 'pack', 6, 2, 8]
    ].map(function (r) {
      return { id: uid(), name: r[0], category: r[1], unit: r[2], code: null, on_hand: r[3], par: r[4], order_up_to: r[5],
               max_per_take: null, active: true, below_par_alerted: r[3] <= r[4], created_at: now() };
    });
    var tx = [], id = 1, t0 = Date.now();
    function addTx(item, staff, kind, qty, note, minsAgo) {
      tx.push({ id: id++, item_id: item.id, staff_id: staff.id, kind: kind, qty: qty, note: note || null,
                stocktake_id: null, undone: false, exported_at: null, created_at: new Date(t0 - minsAgo * 60000).toISOString() });
    }
    addTx(items[0], sam, 'take', -1, 'Truck 7', 60 * 26);
    addTx(items[4], alex, 'take', -2, null, 60 * 25);
    addTx(items[7], sam, 'take', -3, null, 60 * 5);
    addTx(items[2], alex, 'take', -2, 'Track inspection', 90);
    addTx(items[5], sam, 'take', -1, null, 40);
    var msgs = [
      { id: 1, sender_id: admin.id, recipient_id: null, body: 'Welcome to Kippa Crew! Log everything you take from the store room here instead of on the paper sheet. Thanks all 👍', created_at: new Date(t0 - 3 * 3600000).toISOString() },
      { id: 2, sender_id: sam.id, recipient_id: admin.id, body: 'Insect repellent is nearly out on the shelf', created_at: new Date(t0 - 30 * 60000).toISOString() },
      { id: 3, sender_id: admin.id, recipient_id: null, group_id: 1, body: 'Drivers – new sunscreen pumps are on the top shelf.', created_at: new Date(t0 - 50 * 60000).toISOString() }
    ];
    return {
      staff: [admin, sam, alex, pat], sessions: {}, items: items, tx: tx, nextTx: id,
      stocktakes: [], counts: [], msgs: msgs, nextMsg: 4, reads: {},
      groups: [{ id: 1, name: 'Drivers', kind: 'driver', archived: false }, { id: 2, name: 'Guards', kind: 'guard', archived: false },
               { id: 3, name: 'RTBU', kind: 'rtbu', archived: false }, { id: 4, name: 'AFULE', kind: 'afule', archived: false }],
      gmembers: [], nextG: 5, itemImg: {},
      notes: [{ id: 1, title: 'Welcome to Kippa Crew', created_by: admin.id, published_at: now(), deleted: false,
                points: ['Kippa Crew is the new name for the depot app, with a new logo', 'Log anything you take from the store room — no more paper sheet',
                         'TOI Broadcasts: important notices, with PDFs and photos', 'Group chats, plus automatic Drivers and Guards chats',
                         'Updates like this one will pop up here — tap "Got it" when you\'ve read it'] }],
      noteAcks: [{ note_id: 1, staff_id: admin.id }], nextNote: 2,
      broadcasts: [{ id: 1, sender_id: admin.id, title: 'Welcome to TOI Broadcasts', urgent: false, require_ack: true, published: true, deleted: false,
                     body: 'Important notices from the depot will appear here.\nPlease open each one and tap "I have read and understood".',
                     created_at: new Date(t0 - 2 * 3600000).toISOString(), published_at: new Date(t0 - 2 * 3600000).toISOString() }],
      bfiles: [], breads: [{ broadcast_id: 1, staff_id: admin.id, seen_at: now(), acked_at: now() }], nextB: 2, nextF: 1,
      settings: { alert_email: '', resend_api_key: '', email_from: 'Kippa Crew <onboarding@resend.dev>',
                  instant_alerts: 'true', daily_summary: 'true', app_url: '', default_pin: '0000' },
      emails: [],
      uniforms: [
        { id: 1, order_number: 'ORD-2026-004821', person_name: 'Smith, Sam', staff_id: sam.id, items: 3, depot: 'Kippa Ring', status: 'in_transit', source: 'tracks', note: null,
          tracks_updates: 1, created_at: new Date(t0 - 26 * 3600000).toISOString(), updated_at: new Date(t0 - 26 * 3600000).toISOString(), tracks_done: false },
        { id: 2, order_number: 'ORD-2026-004719', person_name: 'Brown, Alex', staff_id: alex.id, items: 1, depot: 'Kippa Ring', status: 'arrived', source: 'tracks', note: null,
          tracks_updates: 1, created_at: new Date(t0 - 3 * 86400000).toISOString(), updated_at: new Date(t0 - 5 * 3600000).toISOString(),
          arrived_at: new Date(t0 - 5 * 3600000).toISOString(), arrived_by: admin.id, notified_at: new Date(t0 - 5 * 3600000).toISOString(), tracks_done: false },
        { id: 3, order_number: 'ORD-2026-004866', person_name: 'Jordan Lee', staff_id: null, items: 2, depot: 'Kippa Ring', status: 'in_transit', source: 'tracks', note: null,
          tracks_updates: 1, created_at: new Date(t0 - 4 * 3600000).toISOString(), updated_at: new Date(t0 - 4 * 3600000).toISOString(), tracks_done: false }
      ],
      nextU: 4, nameLinks: {}
    };
  }

  function load() {
    if (memory) return memory;
    try { var raw = localStorage.getItem(KEY); if (raw) memory = JSON.parse(raw); } catch (_) {}
    if (!memory) { memory = seed(); save(); }
    return memory;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch (_) {} }

  function auth(db, token, admin) {
    var sid = db.sessions[token];
    var s = sid && db.staff.find(function (x) { return x.id === sid && x.active; });
    if (!s) fail('SESSION_EXPIRED');
    if (s.must_change_pin) fail('PIN_CHANGE_REQUIRED');
    if (admin && s.role !== 'admin') fail('ADMIN_ONLY');
    return s;
  }
  function authOffice(db, token) {
    var s = auth(db, token);
    if (s.role !== 'admin' && s.role !== 'administrator') fail('ADMIN_ONLY');
    return s;
  }
  function isOfficeRole(r) { return r === 'admin' || r === 'administrator'; }
  function kindLabel(k) { return k === 'depot' ? 'Depot Announcement' : 'TOI Broadcast'; }
  function meJson(s) { return { id: s.id, name: s.name, role: s.role, can_broadcast: isOfficeRole(s.role) || !!s.can_broadcast, broadcast_kind: s.role === 'administrator' ? 'depot' : 'toi', must_change_pin: !!s.must_change_pin, position: s.position || 'other', union_affiliation: s.union_affiliation || 'none', union_affiliation: s.union_affiliation || 'none' }; }
  function defaultPin(db) { return /^\d{4}$/.test(db.settings.default_pin || '') ? db.settings.default_pin : '0000'; }
  function canSend(s) { return isOfficeRole(s.role) || !!s.can_broadcast; }
  function bread(db, bid, sid) { return db.breads.find(function (r) { return r.broadcast_id === bid && r.staff_id === sid; }); }
  function bJson(db, b, me) {
    var manage = b.sender_id === me.id || me.role === 'admin', r = bread(db, b.id, me.id);
    var aud = db.staff.filter(function (x) { return x.active && x.id !== b.sender_id; });
    var rs = db.breads.filter(function (x) { return x.broadcast_id === b.id && aud.some(function (a) { return a.id === x.staff_id; }); });
    return { id: b.id, title: b.title, body: b.body, urgent: b.urgent, require_ack: b.require_ack, published_at: b.published_at,
             kind: b.kind || 'toi', kind_label: kindLabel(b.kind),
             sender: staffName(db, b.sender_id), mine: b.sender_id === me.id, can_manage: manage,
             files: db.bfiles.filter(function (f) { return f.broadcast_id === b.id; }).map(function (f) { return { id: f.id, name: f.name, mime: f.mime, size: f.size }; }),
             seen_at: r ? r.seen_at : null, acked_at: r ? r.acked_at : null,
             audience: manage ? aud.length : null,
             seen_count: manage ? rs.filter(function (x) { return x.seen_at; }).length : null,
             ack_count: manage ? rs.filter(function (x) { return x.acked_at; }).length : null };
  }
  function liveB(db) { return db.broadcasts.filter(function (b) { return b.published && !b.deleted; }); }
  function pendingNotes(db, s) {
    return db.notes.filter(function (n) {
      return !n.deleted && (!s.created_at || n.published_at >= s.created_at) && !db.noteAcks.some(function (x) { return x.note_id === n.id && x.staff_id === s.id; });
    }).sort(function (x, y) { return y.published_at.localeCompare(x.published_at); }).slice(0, 5);
  }
  function noteJson(db, n, me) {
    var adm = me.role === 'admin', act = db.staff.filter(function (x) { return x.active && (!x.created_at || x.created_at <= n.published_at); });
    return { id: n.id, title: n.title, points: n.points, published_at: n.published_at, by: staffName(db, n.created_by),
             acked: db.noteAcks.some(function (x) { return x.note_id === n.id && x.staff_id === me.id; }),
             seen_count: adm ? db.noteAcks.filter(function (x) { return x.note_id === n.id && db.staff.some(function (st) { return st.id === x.staff_id && st.active; }); }).length : null,
             audience: adm ? act.length : null };
  }
  function staffName(db, id) { var s = db.staff.find(function (x) { return x.id === id; }); return s ? s.name : null; }
  function itemById(db, id) { return db.items.find(function (i) { return i.id === id; }); }
  function suggest(i) { return Math.max((i.order_up_to != null ? i.order_up_to : i.par * 2) - i.on_hand, 1); }
  function itemJson(i, admin) {
    if (admin) return { id: i.id, name: i.name, category: i.category, unit: i.unit, code: i.code, on_hand: i.on_hand, par: i.par,
                        order_up_to: i.order_up_to, max_per_take: i.max_per_take, active: i.active,
                        low: i.par > 0 && i.on_hand <= i.par, suggest: suggest(i), img: imgVer(i.id) };
    return { id: i.id, name: i.name, category: i.category, unit: i.unit, max_per_take: i.max_per_take, img: imgVer(i.id) };
  }
  function imgVer(id) { var d = memory && memory.itemImg && memory.itemImg[id]; return d && imgMem[id] ? d.ver : null; }
  function sortItems(a, b) { return lc(a.category).localeCompare(lc(b.category)) || lc(a.name).localeCompare(lc(b.name)); }
  function addTx(db, item, staff, kind, qty, note, stId) {
    var t = { id: db.nextTx++, item_id: item.id, staff_id: staff ? staff.id : null, kind: kind, qty: qty, note: note || null,
              stocktake_id: stId || null, undone: false, exported_at: null, created_at: now() };
    db.tx.push(t); return t;
  }
  function refreshAlerts(db) {
    var newly = [];
    db.items.forEach(function (i) {
      if (i.below_par_alerted && (i.on_hand > i.par || !i.active || i.par <= 0)) i.below_par_alerted = false;
      if (i.active && i.par > 0 && i.on_hand <= i.par && !i.below_par_alerted) { i.below_par_alerted = true; newly.push(i); }
    });
    if (newly.length && db.settings.instant_alerts === 'true') {
      db.emails.unshift({ id: db.emails.length + 1, subject: 'Reorder needed: ' + newly.length + ' item' + (newly.length === 1 ? '' : 's') + ' at or below par',
                          created_at: now(), status_code: null, detail: 'Demo mode — no email actually sent' });
    }
  }
  function brisbaneDayStart(dateStr) { return new Date(dateStr + 'T00:00:00+10:00').getTime(); }
  function canChat(db, me, otherId) {
    var o = db.staff.find(function (x) { return x.id === otherId && x.active; });
    return !!o && o.id !== me.id && (isOfficeRole(me.role) || isOfficeRole(o.role));
  }
  function inGroup(db, st, gid) {
    var g = db.groups.find(function (x) { return x.id === gid && !x.archived; }); if (!g) return false;
    if (g.kind === 'custom') return db.gmembers.some(function (m) { return m.group_id === gid && m.staff_id === st.id; });
    if (g.kind === 'rtbu' || g.kind === 'afule') return (st.union_affiliation || 'none') === g.kind;
    return (st.position || 'other') === g.kind;
  }
  function groupMembers(db, gid) { return db.staff.filter(function (st) { return st.active && inGroup(db, st, gid); }); }
  function isTeam(m) { return m.recipient_id == null && m.group_id == null; }
  function checkConvo(db, me, key) {
    if (key === 'team') return null;
    if (/^g\d+$/.test(key)) { var gid = +key.slice(1); if (!inGroup(db, me, gid)) fail('You are not in this group.'); return gid; }
    if (!canChat(db, me, key)) fail('You cannot message this person.');
    return null;
  }
  function lastRead(db, sid, convo) { return (db.reads[sid] && db.reads[sid][convo]) || 0; }
  function unreadTotal(db, s) {
    return db.msgs.filter(function (m) {
      if (m.group_id != null) return m.sender_id !== s.id && inGroup(db, s, m.group_id) && m.id > lastRead(db, s.id, 'g' + m.group_id);
      if (m.recipient_id == null) return m.sender_id !== s.id && m.id > lastRead(db, s.id, 'team');
      return m.recipient_id === s.id && m.id > lastRead(db, s.id, m.sender_id);
    }).length;
  }

  // ---- uniform collections (mirror of schema.sql) ----
  function normName(t) {
    var x = String(t || '').replace(/\([^)]*\)/g, '').trim();
    if (x.indexOf(',') >= 0) x = x.split(',')[1].trim() + ' ' + x.split(',')[0].trim();
    return x.toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function matchStaff(db, name) {
    var k = normName(name); if (!k) return null;
    var l = (db.nameLinks || {})[k];
    if (l && db.staff.some(function (s) { return s.id === l && s.active; })) return l;
    var m = db.staff.filter(function (s) { return s.active && normName(s.name) === k; });
    return m.length === 1 ? m[0].id : null;
  }
  function uniJson(db, u) {
    return { id: u.id, order_number: u.order_number, person_name: u.person_name, staff_id: u.staff_id || null,
      staff_name: u.staff_id ? staffName(db, u.staff_id) : null, items: u.items == null ? null : u.items, depot: u.depot || null, status: u.status, source: u.source,
      note: u.note || null, tracks_updates: u.tracks_updates || 0, created_at: u.created_at, updated_at: u.updated_at, arrived_at: u.arrived_at || null,
      arrived_by_name: u.arrived_by ? staffName(db, u.arrived_by) : null, notified_at: u.notified_at || null, collected_at: u.collected_at || null,
      collected_by_name: u.collected_by ? staffName(db, u.collected_by) : null, collected_self: !!u.collected_self, tracks_done: !!u.tracks_done, push_on: false };
  }
  function uniRelink(db) {
    db.uniforms.forEach(function (u) {
      if (!u.staff_id && (u.status === 'in_transit' || u.status === 'arrived')) {
        var v = matchStaff(db, u.person_name);
        if (v) { u.staff_id = v; u.updated_at = now(); if (u.status === 'arrived') u.notified_at = now(); }
      }
    });
  }
  function uniOpen(db) { return db.uniforms.filter(function (u) { return u.status === 'in_transit' || u.status === 'arrived'; }); }
  function uniInbound(db, ev, order, name, depot, items) {
    order = String(order || '').trim().slice(0, 40); name = String(name || '').trim().slice(0, 120);
    if (!order) fail('Order number is required.');
    if (ev === 'cancelled') {
      var c = uniOpen(db).filter(function (u) { return lc(u.order_number) === lc(order); }).pop();
      if (!c) return { ok: true, ticket: null };
      c.status = 'cancelled'; c.note = ((c.note || '') + ' Cancelled in TRACKS.').trim(); c.updated_at = now();
      return { ok: true, ticket: c.id, status: 'cancelled' };
    }
    if (ev !== 'dispatched') fail('Unknown event.');
    var st = matchStaff(db, name);
    var u = db.uniforms.filter(function (x) { return x.status === 'in_transit' && lc(x.order_number) === lc(order); }).pop();
    if (u) {
      u.person_name = name || u.person_name; u.staff_id = u.staff_id || st;
      u.items = items != null ? items : u.items; u.depot = depot || u.depot; u.tracks_updates++; u.updated_at = now();
      return { ok: true, ticket: u.id, new: false, matched: !!u.staff_id };
    }
    u = { id: db.nextU++, order_number: order, person_name: name, staff_id: st, items: items == null ? null : items, depot: depot || null,
          status: 'in_transit', source: 'tracks', tracks_updates: 1, created_at: now(), updated_at: now(), tracks_done: false };
    db.uniforms.push(u);
    return { ok: true, ticket: u.id, new: true, matched: !!st };
  }
  function stocktakeReport(db, st) {
    var counts = db.counts.filter(function (c) { return c.stocktake_id === st.id; });
    return {
      id: st.id, status: st.status, note: st.note, started_at: st.started_at, completed_at: st.completed_at,
      started_by: staffName(db, st.started_by), completed_by: staffName(db, st.completed_by),
      lines: counts.map(function (c) {
        var i = itemById(db, c.item_id);
        return { item: i.name, category: i.category, unit: i.unit, code: i.code, expected: c.expected_at_count, counted: c.counted,
                 variance: c.counted - c.expected_at_count, who: staffName(db, c.counted_by), counted_at: c.counted_at };
      }).sort(function (a, b) { return Math.abs(b.variance) - Math.abs(a.variance) || lc(a.item).localeCompare(lc(b.item)); }),
      not_counted: db.items.filter(function (i) { return i.active && !counts.some(function (c) { return c.item_id === i.id; }); })
                     .map(function (i) { return i.name; }).sort()
    };
  }

  var F = {
    app_status: function (db) { return { needs_setup: db.staff.length === 0, version: 1 }; },
    setup_first_admin: function (db, a) {
      if (db.staff.length) fail('Setup has already been done.');
      var s = { id: uid(), name: a.p_name.trim(), pin: a.p_pin, role: 'admin', active: true, failed: 0 };
      db.staff.push(s); var t = uid(); db.sessions[t] = s.id;
      return { token: t, me: meJson(s) };
    },
    list_people: function (db) {
      return db.staff.filter(function (s) { return s.active; }).map(function (s) { return { id: s.id, name: s.name }; })
        .sort(function (a, b) { return lc(a.name).localeCompare(lc(b.name)); });
    },
    login: function (db, a) {
      var s = db.staff.find(function (x) { return x.id === a.p_staff_id && x.active; });
      if (!s) fail('Unknown person.');
      if (s.locked_until && new Date(s.locked_until) > new Date()) fail('Too many wrong PINs. Try again in ' + Math.ceil((new Date(s.locked_until) - new Date()) / 60000) + ' min.');
      if (s.pin !== a.p_pin) {
        s.failed = (s.failed || 0) + 1;
        if (s.failed >= 5) { s.locked_until = new Date(Date.now() + 5 * 60000).toISOString(); return { error: 'Too many wrong PINs. Locked for 5 minutes.' }; }
        return { error: 'Wrong PIN. Please try again.' };
      }
      s.failed = 0; s.locked_until = null; s.last_login = now();
      var t = uid(); db.sessions[t] = s.id;
      return { token: t, me: meJson(s) };
    },
    logout: function (db, a) { delete db.sessions[a.p_token]; },
    whats_new_pending: function (db, a) {
      var s = auth(db, a.p_token);
      return pendingNotes(db, s).map(function (n) { return noteJson(db, n, s); });
    },
    ack_whats_new: function (db, a) {
      var s = auth(db, a.p_token);
      (a.p_ids || []).forEach(function (id) { if (!db.noteAcks.some(function (x) { return x.note_id === id && x.staff_id === s.id; })) db.noteAcks.push({ note_id: id, staff_id: s.id }); });
    },
    list_whats_new: function (db, a) {
      var s = auth(db, a.p_token);
      return db.notes.filter(function (n) { return !n.deleted; }).sort(function (x, y) { return y.published_at.localeCompare(x.published_at); }).slice(0, 50)
        .map(function (n) { return noteJson(db, n, s); });
    },
    publish_whats_new: function (db, a) {
      var s = auth(db, a.p_token, true);
      if (!String(a.p_title || '').trim()) fail('Give the update a title.');
      var pts = (a.p_points || []).map(function (x) { return String(x).trim().slice(0, 300); }).filter(Boolean);
      if (!pts.length) fail('Add at least one point.');
      if (pts.length > 25) fail('Keep it to 25 points or fewer.');
      var n = { id: db.nextNote++, title: String(a.p_title).trim().slice(0, 120), points: pts, created_by: s.id, published_at: now(), deleted: false };
      db.notes.push(n); db.noteAcks.push({ note_id: n.id, staff_id: s.id }); return n.id;
    },
    delete_whats_new: function (db, a) { auth(db, a.p_token, true); var n = db.notes.find(function (x) { return x.id === a.p_id; }); if (n) n.deleted = true; },
    me: function (db, a) {
      var sid = db.sessions[a.p_token], s = sid && db.staff.find(function (x) { return x.id === sid && x.active; });
      if (!s) fail('SESSION_EXPIRED'); return meJson(s);
    },
    staff_default_pin: function (db, a) { authOffice(db, a.p_token); return defaultPin(db); },
    set_own_pin: function (db, a) {
      var sid = db.sessions[a.p_token], s = sid && db.staff.find(function (x) { return x.id === sid && x.active; });
      if (!s) fail('SESSION_EXPIRED');
      if (!s.must_change_pin) fail('Use Me → Change my PIN instead.');
      if (!/^\d{4}$/.test(a.p_new || '')) fail('PIN must be 4 digits.');
      if (a.p_new === s.pin) fail('Choose a PIN that is different from your temporary PIN.');
      if (['0000','1111','2222','3333','4444','5555','6666','7777','8888','9999','1234','4321', defaultPin(db)].indexOf(a.p_new) >= 0) fail('That PIN is too easy to guess. Please choose another.');
      s.pin = a.p_new; s.must_change_pin = false; return meJson(s);
    },
    reset_pin: function (db, a) {
      var me = authOffice(db, a.p_token);
      if (a.p_staff_id === me.id) fail('To change your own PIN, use Me → Change my PIN.');
      var t = db.staff.find(function (x) { return x.id === a.p_staff_id; }); if (!t) fail('Person not found.');
      if (me.role === 'administrator' && t.role === 'admin') fail('Only a Manager can reset a Manager\'s PIN.');
      t.pin = defaultPin(db); t.must_change_pin = true; t.failed = 0; t.locked_until = null;
      Object.keys(db.sessions).forEach(function (k) { if (db.sessions[k] === t.id) delete db.sessions[k]; });
      return { name: t.name, pin: t.pin };
    },
    heartbeat: function (db, a) {
      var s = auth(db, a.p_token);
      var fortnight = Date.now() - 14 * 86400000;
      return { unread: unreadTotal(db, s), low: s.role === 'admin' ? db.items.filter(function (i) { return i.active && i.par > 0 && i.on_hand <= i.par; }).length : 0,
        broadcasts: liveB(db).filter(function (b) { var r = bread(db, b.id, s.id); return b.sender_id !== s.id && !(r && r.seen_at); }).length,
        urgent: liveB(db).filter(function (b) {
          var r = bread(db, b.id, s.id);
          return b.urgent && b.sender_id !== s.id && new Date(b.published_at).getTime() > fortnight && (b.require_ack ? !(r && r.acked_at) : !(r && r.seen_at));
        }).sort(function (x, y) { return y.published_at.localeCompare(x.published_at); })
          .map(function (b) { return { id: b.id, title: b.title, at: b.published_at, who: staffName(db, b.sender_id), kind_label: kindLabel(b.kind) }; }),
        whats_new: pendingNotes(db, s).length,
        uniforms_ready: (db.uniforms || []).filter(function (u) { return u.staff_id === s.id && u.status === 'arrived'; }).length,
        uniforms_open: isOfficeRole(s.role) ? uniOpen(db).length : 0 };
    },
    change_my_pin: function (db, a) {
      var s = auth(db, a.p_token);
      if (s.pin !== a.p_old) fail('Current PIN is wrong.');
      if (!/^[0-9]{4,8}$/.test(a.p_new || '')) fail('PIN must be 4 to 8 digits.');
      s.pin = a.p_new;
    },
    list_items: function (db, a) {
      var s = auth(db, a.p_token);
      return db.items.filter(function (i) { return i.active; }).sort(sortItems).map(function (i) { return itemJson(i, s.role === 'admin'); });
    },
    take_items: function (db, a) {
      var s = auth(db, a.p_token), n = 0;
      if (!Array.isArray(a.p_lines) || !a.p_lines.length) fail('Nothing selected.');
      a.p_lines.forEach(function (l) {
        var q = int(l.qty, 0);
        if (q < 1 || q > 999) fail('Quantity must be between 1 and 999.');
        var i = itemById(db, l.item_id);
        if (!i || !i.active) fail('An item is no longer available. Refresh and try again.');
        if (i.max_per_take != null && q > i.max_per_take) fail(i.name + ': max ' + i.max_per_take + ' per take. Message the manager if you need more.');
      });
      a.p_lines.forEach(function (l) {
        var i = itemById(db, l.item_id), q = int(l.qty, 0);
        i.on_hand -= q; addTx(db, i, s, 'take', -q, (a.p_note || '').trim() || null); n += q;
      });
      refreshAlerts(db);
      return { ok: true, units: n };
    },
    my_history: function (db, a) {
      var s = auth(db, a.p_token), lim = Math.min(Math.max(a.p_limit || 50, 1), 200);
      return db.tx.filter(function (t) { return t.staff_id === s.id && t.kind === 'take'; }).sort(function (x, y) { return y.id - x.id; }).slice(0, lim)
        .map(function (t) { var i = itemById(db, t.item_id);
          return { id: t.id, kind: t.kind, qty: -t.qty, note: t.note, created_at: t.created_at, undone: t.undone, item: i.name, unit: i.unit,
                   can_undo: !t.undone && !t.exported_at && (Date.now() - new Date(t.created_at)) < 15 * 60000 }; });
    },
    undo_take: function (db, a) {
      var s = auth(db, a.p_token), t = db.tx.find(function (x) { return x.id === a.p_tx_id; });
      if (!t || t.kind !== 'take' || t.undone) fail('That entry cannot be undone.');
      if (t.staff_id !== s.id && s.role !== 'admin') fail('You can only undo your own entries.');
      if (s.role !== 'admin' && Date.now() - new Date(t.created_at) > 15 * 60000) fail('Too late to undo (15 min). Message the manager.');
      if (t.exported_at) fail('Already entered into TRACKS — ask the manager to adjust.');
      t.undone = true; var i = itemById(db, t.item_id); i.on_hand -= t.qty;
      addTx(db, i, s, 'undo', -t.qty, 'Undo of entry #' + t.id); refreshAlerts(db);
    },
    admin_dashboard: function (db, a) {
      auth(db, a.p_token, true);
      var start = brisbaneDayStart(new Date(Date.now() + 10 * 3600000).toISOString().slice(0, 10));
      var open = db.stocktakes.find(function (x) { return x.status === 'open'; });
      return {
        low: db.items.filter(function (i) { return i.active && i.par > 0 && i.on_hand <= i.par; })
              .sort(function (x, y) { return x.on_hand / x.par - y.on_hand / y.par || lc(x.name).localeCompare(lc(y.name)); })
              .map(function (i) { return itemJson(i, true); }),
        recent: db.tx.slice().sort(function (x, y) { return y.id - x.id; }).slice(0, 40).map(function (t) {
          var i = itemById(db, t.item_id);
          return { id: t.id, kind: t.kind, qty: t.qty, note: t.note, created_at: t.created_at, undone: t.undone, item: i.name, unit: i.unit, who: staffName(db, t.staff_id) };
        }),
        today_takes: db.tx.filter(function (t) { return t.kind === 'take' && !t.undone && new Date(t.created_at).getTime() >= start; })
                       .reduce(function (s, t) { return s - t.qty; }, 0),
        unexported: db.tx.filter(function (t) { return t.kind === 'take' && !t.undone && !t.exported_at; }).length,
        item_count: db.items.filter(function (i) { return i.active; }).length,
        staff_count: db.staff.filter(function (s) { return s.active; }).length,
        open_stocktake: open ? open.id : null,
        uniforms_open: uniOpen(db).length
      };
    },
    save_item: function (db, a) {
      var s = auth(db, a.p_token, true), p = a.p_item || {}, i;
      var name = String(p.name || '').trim();
      if (!name) fail('Item name is required.');
      var dup = db.items.find(function (x) { return x.active && lc(x.name) === lc(name) && x.id !== p.id; });
      if (dup) fail('An item with that name already exists.');
      function nn(v) { return v === '' || v == null ? null : int(v, null); }
      if (!p.id) {
        i = { id: uid(), name: name, category: String(p.category || '').trim() || 'General', unit: String(p.unit || '').trim() || 'each',
              code: String(p.code || '').trim() || null, on_hand: int(p.on_hand, 0), par: Math.max(int(p.par, 0), 0),
              order_up_to: nn(p.order_up_to), max_per_take: nn(p.max_per_take), active: true, below_par_alerted: false, created_at: now() };
        db.items.push(i);
        if (i.on_hand !== 0) addTx(db, i, s, 'adjust', i.on_hand, 'Opening stock');
      } else {
        i = itemById(db, p.id); if (!i) fail('Item not found.');
        var newOn = p.on_hand == null || p.on_hand === '' ? i.on_hand : int(p.on_hand, i.on_hand);
        if (newOn !== i.on_hand) addTx(db, i, s, 'adjust', newOn - i.on_hand, (p.adjust_note || '').trim() || 'Manual adjustment');
        i.name = name; i.category = String(p.category || '').trim() || 'General'; i.unit = String(p.unit || '').trim() || 'each';
        i.code = String(p.code || '').trim() || null; i.on_hand = newOn; i.par = Math.max(p.par == null || p.par === '' ? i.par : int(p.par, i.par), 0);
        i.order_up_to = nn(p.order_up_to); i.max_per_take = nn(p.max_per_take);
      }
      refreshAlerts(db);
      return itemJson(i, true);
    },
    archive_item: function (db, a) { auth(db, a.p_token, true); var i = itemById(db, a.p_item_id); if (i) i.active = false; refreshAlerts(db); },
    import_items: function (db, a) {
      auth(db, a.p_token, true); var added = 0, updated = 0;
      (a.p_rows || []).forEach(function (r) {
        var name = String(r.name || '').trim(); if (!name) return;
        var ex = db.items.find(function (x) { return x.active && lc(x.name) === lc(name); });
        if (!ex) { F.save_item(db, { p_token: a.p_token, p_item: Object.assign({}, r, { id: null }) }); added++; }
        else {
          var merged = Object.assign({}, ex);
          Object.keys(r).forEach(function (k) { if (k !== 'name' && k !== 'id' && r[k] !== null && r[k] !== '') merged[k] = r[k]; });
          merged.adjust_note = 'Import';
          F.save_item(db, { p_token: a.p_token, p_item: merged }); updated++;
        }
      });
      return { added: added, updated: updated };
    },
    receive_stock: function (db, a) {
      var s = authOffice(db, a.p_token), n = 0;
      (a.p_lines || []).forEach(function (l) {
        var q = int(l.qty, 0); if (!q) return;
        if (q < 0 || q > 100000) fail('Invalid quantity.');
        var i = itemById(db, l.item_id); if (!i || !i.active) fail('Item not found.');
        i.on_hand += q; addTx(db, i, s, 'receive', q, (a.p_note || '').trim() || null); n++;
      });
      refreshAlerts(db); return { lines: n };
    },
    list_transactions: function (db, a) {
      auth(db, a.p_token, true);
      var from = brisbaneDayStart(a.p_from), to = brisbaneDayStart(a.p_to) + 86400000;
      return db.tx.filter(function (t) { var ms = new Date(t.created_at).getTime(); return ms >= from && ms < to && (!a.p_kind || t.kind === a.p_kind); })
        .sort(function (x, y) { return y.id - x.id; }).map(function (t) {
          var i = itemById(db, t.item_id);
          return { id: t.id, kind: t.kind, qty: t.qty, note: t.note, created_at: t.created_at, undone: t.undone, exported_at: t.exported_at,
                   item_id: i.id, item: i.name, category: i.category, unit: i.unit, code: i.code, who: staffName(db, t.staff_id) };
        });
    },
    tracks_pending: function (db, a) {
      auth(db, a.p_token, true);
      var pend = db.tx.filter(function (t) { return t.kind === 'take' && !t.undone && !t.exported_at; });
      var by = {};
      pend.forEach(function (t) {
        var i = itemById(db, t.item_id), b = by[i.id] || (by[i.id] = { item: i.name, code: i.code, unit: i.unit, qty: 0, entries: 0, first_at: t.created_at, last_at: t.created_at });
        b.qty += -t.qty; b.entries++; if (t.created_at < b.first_at) b.first_at = t.created_at; if (t.created_at > b.last_at) b.last_at = t.created_at;
      });
      return {
        by_item: Object.keys(by).map(function (k) { return by[k]; }).sort(function (x, y) { return lc(x.item).localeCompare(lc(y.item)); }),
        lines: pend.sort(function (x, y) { return x.id - y.id; }).map(function (t) { var i = itemById(db, t.item_id);
          return { id: t.id, created_at: t.created_at, item: i.name, code: i.code, unit: i.unit, qty: -t.qty, who: staffName(db, t.staff_id), note: t.note }; }),
        max_id: pend.length ? Math.max.apply(null, pend.map(function (t) { return t.id; })) : null
      };
    },
    tracks_mark_entered: function (db, a) {
      auth(db, a.p_token, true); var n = 0;
      db.tx.forEach(function (t) { if (t.kind === 'take' && !t.undone && !t.exported_at && t.id <= a.p_max_id) { t.exported_at = now(); n++; } });
      return { marked: n };
    },
    start_stocktake: function (db, a) {
      var s = authOffice(db, a.p_token), open = db.stocktakes.find(function (x) { return x.status === 'open'; });
      if (open) return open.id;
      var st = { id: uid(), status: 'open', note: (a.p_note || '').trim() || null, started_by: s.id, started_at: now(), completed_by: null, completed_at: null };
      db.stocktakes.push(st); return st.id;
    },
    get_stocktake: function (db, a) {
      authOffice(db, a.p_token);
      var st = db.stocktakes.find(function (x) { return x.status === 'open'; }); if (!st) return null;
      return { id: st.id, note: st.note, started_at: st.started_at, started_by: staffName(db, st.started_by),
               items: db.items.filter(function (i) { return i.active; }).sort(sortItems).map(function (i) {
                 var c = db.counts.find(function (c) { return c.stocktake_id === st.id && c.item_id === i.id; });
                 return { id: i.id, name: i.name, category: i.category, unit: i.unit, counted: c ? c.counted : null, img: imgVer(i.id) }; }) };
    },
    save_count: function (db, a) {
      var s = authOffice(db, a.p_token);
      var st = db.stocktakes.find(function (x) { return x.id === a.p_stocktake_id && x.status === 'open'; });
      if (!st) fail('This stocktake is no longer open.');
      db.counts = db.counts.filter(function (c) { return !(c.stocktake_id === st.id && c.item_id === a.p_item_id); });
      if (a.p_counted === null || a.p_counted === undefined) return;
      if (a.p_counted < 0 || a.p_counted > 1000000) fail('Invalid count.');
      var i = itemById(db, a.p_item_id);
      db.counts.push({ stocktake_id: st.id, item_id: i.id, counted: a.p_counted, expected_at_count: i.on_hand, counted_by: s.id, counted_at: now() });
    },
    complete_stocktake: function (db, a) {
      var s = authOffice(db, a.p_token);
      var st = db.stocktakes.find(function (x) { return x.id === a.p_stocktake_id && x.status === 'open'; });
      if (!st) fail('This stocktake is no longer open.');
      db.counts.filter(function (c) { return c.stocktake_id === st.id; }).forEach(function (c) {
        var d = c.counted - c.expected_at_count;
        if (d) { var i = itemById(db, c.item_id); i.on_hand += d; addTx(db, i, s, 'stocktake', d, 'Stocktake variance', st.id); }
      });
      st.status = 'completed'; st.completed_by = s.id; st.completed_at = now();
      refreshAlerts(db);
      return stocktakeReport(db, st);
    },
    cancel_stocktake: function (db, a) {
      var s = authOffice(db, a.p_token), st = db.stocktakes.find(function (x) { return x.id === a.p_stocktake_id && x.status === 'open'; });
      if (st) { st.status = 'cancelled'; st.completed_by = s.id; st.completed_at = now(); }
    },
    stocktake_report: function (db, a) {
      authOffice(db, a.p_token);
      var st = db.stocktakes.find(function (x) { return x.id === a.p_stocktake_id; });
      if (!st) fail('Stocktake not found.');
      if (st.status === 'open') fail('Results are hidden until the stocktake is completed.');
      return stocktakeReport(db, st);
    },
    list_stocktakes: function (db, a) {
      authOffice(db, a.p_token);
      return db.stocktakes.slice().sort(function (x, y) { return y.started_at.localeCompare(x.started_at); }).map(function (st) {
        var c = db.counts.filter(function (c) { return c.stocktake_id === st.id; });
        return { id: st.id, status: st.status, note: st.note, started_at: st.started_at, completed_at: st.completed_at, started_by: staffName(db, st.started_by),
                 counted: c.length, variances: c.filter(function (x) { return x.counted !== x.expected_at_count; }).length };
      });
    },
    list_staff: function (db, a) {
      authOffice(db, a.p_token);
      return db.staff.map(function (s) { return { id: s.id, name: s.name, role: s.role, active: s.active, last_login: s.last_login || null, can_broadcast: !!s.can_broadcast, must_change_pin: !!s.must_change_pin, position: s.position || 'other', union_affiliation: s.union_affiliation || 'none',
        locked: !!(s.locked_until && new Date(s.locked_until) > new Date()) }; })
        .sort(function (x, y) { return (y.active - x.active) || lc(x.name).localeCompare(lc(y.name)); });
    },
    save_staff: function (db, a) {
      var me = authOffice(db, a.p_token), p = a.p_person || {}, name = String(p.name || '').trim();
      if (!name) fail('Name is required.');
      if (p.pin && !/^[0-9]{4,8}$/.test(p.pin)) fail('PIN must be 4 to 8 digits.');
      var role = p.role || 'staff', active = p.active !== false, pos = p.position || 'other';
      if (['staff', 'administrator', 'admin'].indexOf(role) < 0) fail('Invalid role.');
      var target = p.id ? db.staff.find(function (x) { return x.id === p.id; }) : null;
      if (me.role === 'administrator') {
        if (role === 'admin') fail('Only a Manager can make someone a Manager.');
        if (target && target.role === 'admin') fail('Only a Manager can change a Manager\'s details.');
        p.can_broadcast = target ? !!target.can_broadcast : false;
      }
      if (['driver', 'guard', 'other'].indexOf(pos) < 0) fail('Position must be Driver, Guard or Other.');
      var uni = p.union_affiliation || 'none';
      if (['none', 'rtbu', 'afule'].indexOf(uni) < 0) fail('Union affiliation must be None, RTBU or AFULE.');
      if (db.staff.some(function (x) { return lc(x.name) === lc(name) && x.id !== p.id; })) fail('Someone with that name already exists.');
      if (!p.id) {
        var pin = p.pin || defaultPin(db);
        var s = { id: uid(), name: name, pin: pin, role: role, active: active, failed: 0, locked_until: null, last_login: null, can_broadcast: !!p.can_broadcast, must_change_pin: true, position: pos, union_affiliation: uni, created_at: now() };
        db.staff.push(s); uniRelink(db); return { id: s.id, pin: pin };
      }
      if (p.id === me.id && (role !== me.role || !active)) fail('You can\'t change your own access level or remove yourself.');
      var t = db.staff.find(function (x) { return x.id === p.id; });
      t.name = name; t.role = role; t.active = active; t.can_broadcast = !!p.can_broadcast; t.position = pos; t.union_affiliation = uni;
      if (p.pin) { t.pin = p.pin; t.failed = 0; t.locked_until = null; if (t.id !== me.id) t.must_change_pin = true; }
      if (!active || p.pin) Object.keys(db.sessions).forEach(function (k) { if (db.sessions[k] === t.id && t.id !== me.id) delete db.sessions[k]; });
      if (!active) db.gmembers = db.gmembers.filter(function (m) { return m.staff_id !== t.id; });
      uniRelink(db);
      return { id: t.id };
    },
    get_settings: function (db, a) {
      auth(db, a.p_token, true); var st = db.settings, k = st.resend_api_key || '';
      return { alert_email: st.alert_email, email_from: st.email_from, instant_alerts: st.instant_alerts === 'true', daily_summary: st.daily_summary === 'true',
               app_url: st.app_url, default_pin: defaultPin(db), resend_key_set: !!k, resend_key_hint: k.length > 6 ? '••••' + k.slice(-4) : '',
               email_ready: !!(k && st.alert_email), cron_ready: true, net_ready: true };
    },
    save_settings: function (db, a) {
      auth(db, a.p_token, true); var p = a.p_settings || {};
      ['alert_email', 'email_from', 'app_url'].forEach(function (k) { if (k in p) db.settings[k] = String(p[k] || '').trim(); });
      ['instant_alerts', 'daily_summary'].forEach(function (k) { if (k in p) db.settings[k] = p[k] ? 'true' : 'false'; });
      if ('default_pin' in p) { if (!/^\d{4}$/.test(p.default_pin || '')) fail('Default PIN must be 4 digits.'); db.settings.default_pin = p.default_pin; }
      if (String(p.resend_api_key || '').trim()) db.settings.resend_api_key = String(p.resend_api_key).trim();
    },
    send_test_email: function (db, a) {
      auth(db, a.p_token, true);
      if (!db.settings.resend_api_key || !db.settings.alert_email) fail('Add your alert email and Resend API key first.');
      db.emails.unshift({ id: db.emails.length + 1, subject: 'Test email from Kippa Crew', created_at: now(), status_code: null, detail: 'Demo mode — no email actually sent' });
      return { request_id: null };
    },
    email_status: function (db, a) { auth(db, a.p_token, true); return db.emails.slice(0, 10); },
    list_conversations: function (db, a) {
      var s = auth(db, a.p_token);
      var team = db.msgs.filter(isTeam);
      var tl = team[team.length - 1];
      return {
        team: { key: 'team', name: 'Team (everyone)', last: tl ? { body: tl.body, at: tl.created_at, who: staffName(db, tl.sender_id) } : null,
                unread: team.filter(function (m) { return m.sender_id !== s.id && m.id > lastRead(db, s.id, 'team'); }).length },
        groups: db.groups.filter(function (g) { return !g.archived && inGroup(db, s, g.id); }).map(function (g) {
          var th = db.msgs.filter(function (m) { return m.group_id === g.id; }), l = th[th.length - 1];
          return { key: 'g' + g.id, name: g.name, kind: g.kind, sys: g.kind !== 'custom', members: groupMembers(db, g.id).length,
                   last: l ? { body: l.body, at: l.created_at, who: staffName(db, l.sender_id), mine: l.sender_id === s.id } : null,
                   unread: th.filter(function (m) { return m.sender_id !== s.id && m.id > lastRead(db, s.id, 'g' + g.id); }).length };
        }).sort(function (x, y) { return (y.sys - x.sys) || ((y.last && y.last.at) || '').localeCompare((x.last && x.last.at) || '') || lc(x.name).localeCompare(lc(y.name)); }),
        people: db.staff.filter(function (o) { return canChat(db, s, o.id); }).map(function (o) {
          var th = db.msgs.filter(function (m) { return m.group_id == null && ((m.sender_id === s.id && m.recipient_id === o.id) || (m.sender_id === o.id && m.recipient_id === s.id)); });
          var l = th[th.length - 1];
          return { key: o.id, name: o.name, role: o.role, last: l ? { body: l.body, at: l.created_at, mine: l.sender_id === s.id } : null,
                   unread: th.filter(function (m) { return m.sender_id === o.id && m.id > lastRead(db, s.id, o.id); }).length };
        }).sort(function (x, y) { return ((y.last && y.last.at) || '').localeCompare((x.last && x.last.at) || '') || lc(x.name).localeCompare(lc(y.name)); })
      };
    },
    get_messages: function (db, a) {
      var s = auth(db, a.p_token), w = a.p_with, gid = checkConvo(db, s, w);
      var list = db.msgs.filter(function (m) {
        if (m.id <= (a.p_after || 0)) return false;
        if (w === 'team') return isTeam(m);
        if (gid != null) return m.group_id === gid;
        return m.group_id == null && ((m.sender_id === s.id && m.recipient_id === w) || (m.sender_id === w && m.recipient_id === s.id));
      }).slice(-200).map(function (m) { return { id: m.id, body: m.body, created_at: m.created_at, mine: m.sender_id === s.id, who: staffName(db, m.sender_id) }; });
      if (list.length) { db.reads[s.id] = db.reads[s.id] || {}; db.reads[s.id][w] = Math.max(lastRead(db, s.id, w), list[list.length - 1].id); }
      return list;
    },
    create_broadcast: function (db, a) {
      var s = auth(db, a.p_token);
      if (!canSend(s)) fail('You are not allowed to send TOI broadcasts.');
      if (!String(a.p_title || '').trim()) fail('Give the broadcast a title.');
      var b = { id: db.nextB++, sender_id: s.id, kind: s.role === 'administrator' ? 'depot' : 'toi', title: String(a.p_title).trim().slice(0, 150), body: String(a.p_body || '').trim().slice(0, 5000),
                urgent: !!a.p_urgent, require_ack: a.p_require_ack !== false, published: false, deleted: false, created_at: now(), published_at: null };
      db.broadcasts.push(b); return b.id;
    },
    add_broadcast_file: function (db, a) {
      var s = auth(db, a.p_token), b = db.broadcasts.find(function (x) { return x.id === a.p_broadcast_id; });
      if (!b || b.sender_id !== s.id || b.published) fail('Draft not found.');
      if (['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'].indexOf(a.p_mime) < 0) fail('Only PDF and image files (JPG, PNG, WebP, GIF) can be attached.');
      if (db.bfiles.filter(function (f) { return f.broadcast_id === b.id; }).length >= 6) fail('Maximum 6 attachments.');
      var size = Math.floor(String(a.p_data || '').length * 3 / 4);
      if (size > 10 * 1024 * 1024) fail(a.p_name + ' is larger than 10 MB.');
      if (a.p_mime === 'application/pdf' && String(a.p_data).slice(0, 6) !== 'JVBERi') fail(a.p_name + ' is not a valid PDF.');
      var f = { id: db.nextF++, broadcast_id: b.id, name: String(a.p_name || 'attachment').slice(0, 200), mime: a.p_mime, size: size };
      db.bfiles.push(f); fileMem[f.id] = a.p_data; return f.id;
    },
    publish_broadcast: function (db, a) {
      var s = auth(db, a.p_token), b = db.broadcasts.find(function (x) { return x.id === a.p_broadcast_id && x.sender_id === s.id && !x.published; });
      if (!b) fail('Draft not found.');
      b.published = true; b.published_at = now();
      db.breads.push({ broadcast_id: b.id, staff_id: s.id, seen_at: now(), acked_at: now() });
      return bJson(db, b, s);
    },
    list_broadcasts: function (db, a) {
      var s = auth(db, a.p_token);
      return { can_send: canSend(s), send_kind: s.role === 'administrator' ? 'depot' : 'toi', items: liveB(db).sort(function (x, y) { return y.published_at.localeCompare(x.published_at); }).slice(0, 100).map(function (b) { return bJson(db, b, s); }) };
    },
    get_broadcast: function (db, a) {
      var s = auth(db, a.p_token), b = liveB(db).find(function (x) { return x.id === a.p_broadcast_id; });
      if (!b) fail('This broadcast is no longer available.');
      var r = bread(db, b.id, s.id);
      if (!r) db.breads.push({ broadcast_id: b.id, staff_id: s.id, seen_at: now(), acked_at: null }); else if (!r.seen_at) r.seen_at = now();
      return bJson(db, b, s);
    },
    ack_broadcast: function (db, a) {
      var s = auth(db, a.p_token), b = liveB(db).find(function (x) { return x.id === a.p_broadcast_id; });
      if (!b) fail('This broadcast is no longer available.');
      var r = bread(db, b.id, s.id);
      if (!r) db.breads.push({ broadcast_id: b.id, staff_id: s.id, seen_at: now(), acked_at: now() });
      else { r.seen_at = r.seen_at || now(); r.acked_at = r.acked_at || now(); }
    },
    get_broadcast_file: function (db, a) {
      auth(db, a.p_token);
      var f = db.bfiles.find(function (x) { return x.id === a.p_file_id; });
      if (!f) fail('File not found.');
      if (!fileMem[f.id]) fail('Demo mode keeps attachments only until the page is reloaded. In the real app they are stored permanently.');
      return { name: f.name, mime: f.mime, data: fileMem[f.id] };
    },
    broadcast_receipts: function (db, a) {
      var s = auth(db, a.p_token), b = db.broadcasts.find(function (x) { return x.id === a.p_broadcast_id && x.published; });
      if (!b) fail('Broadcast not found.');
      if (b.sender_id !== s.id && s.role !== 'admin') fail('Only the sender or a manager can see this.');
      return db.staff.filter(function (x) { return x.active && x.id !== b.sender_id; }).map(function (x) {
        var r = bread(db, b.id, x.id); return { name: x.name, seen_at: r ? r.seen_at : null, acked_at: r ? r.acked_at : null };
      }).sort(function (x, y) { return (!x.acked_at - !y.acked_at) || (!x.seen_at - !y.seen_at) || lc(x.name).localeCompare(lc(y.name)); });
    },
    delete_broadcast: function (db, a) {
      var s = auth(db, a.p_token), b = db.broadcasts.find(function (x) { return x.id === a.p_broadcast_id; });
      if (!b) return;
      if (b.sender_id !== s.id && s.role !== 'admin') fail('Only the sender or a manager can delete this.');
      b.deleted = true;
      db.bfiles.filter(function (f) { return f.broadcast_id === b.id; }).forEach(function (f) { delete fileMem[f.id]; });
      db.bfiles = db.bfiles.filter(function (f) { return f.broadcast_id !== b.id; });
    },
    chat_people: function (db, a) {
      var s = auth(db, a.p_token);
      return db.staff.filter(function (x) { return x.active && x.id !== s.id; }).map(function (x) { return { id: x.id, name: x.name, position: x.position || 'other', role: x.role }; })
        .sort(function (x, y) { return lc(x.name).localeCompare(lc(y.name)); });
    },
    create_group: function (db, a) {
      var s = auth(db, a.p_token), name = String(a.p_name || '').trim();
      if (!name) fail('Give the group a name.');
      if (!(a.p_members || []).length) fail('Add at least one other person.');
      var g = { id: db.nextG++, name: name.slice(0, 60), kind: 'custom', created_by: s.id, archived: false };
      db.groups.push(g);
      [s.id].concat(a.p_members).forEach(function (id) {
        if (db.staff.some(function (x) { return x.id === id && x.active; }) && !db.gmembers.some(function (m) { return m.group_id === g.id && m.staff_id === id; }))
          db.gmembers.push({ group_id: g.id, staff_id: id });
      });
      return 'g' + g.id;
    },
    group_info: function (db, a) {
      var s = auth(db, a.p_token), gid = checkConvo(db, s, a.p_key);
      if (gid == null) fail('Not a group.');
      var g = db.groups.find(function (x) { return x.id === gid; });
      return { key: a.p_key, name: g.name, kind: g.kind, sys: g.kind !== 'custom', created_by: staffName(db, g.created_by),
               can_manage: g.kind === 'custom' && (g.created_by === s.id || s.role === 'admin'),
               members: groupMembers(db, gid).map(function (m) { return { id: m.id, name: m.name, position: m.position || 'other', role: m.role, me: m.id === s.id }; })
                 .sort(function (x, y) { return lc(x.name).localeCompare(lc(y.name)); }) };
    },
    update_group: function (db, a) {
      var s = auth(db, a.p_token), gid = checkConvo(db, s, a.p_key), g = db.groups.find(function (x) { return x.id === gid; });
      if (gid == null || g.kind !== 'custom') fail('This group is managed automatically.');
      if (g.created_by !== s.id && s.role !== 'admin') fail('Only the person who made the group or a manager can change it.');
      if (!String(a.p_name || '').trim()) fail('Give the group a name.');
      g.name = String(a.p_name).trim().slice(0, 60);
      var keep = (a.p_members || []).concat([s.id]);
      db.gmembers = db.gmembers.filter(function (m) { return m.group_id !== gid || keep.indexOf(m.staff_id) >= 0; });
      keep.forEach(function (id) { if (!db.gmembers.some(function (m) { return m.group_id === gid && m.staff_id === id; })) db.gmembers.push({ group_id: gid, staff_id: id }); });
    },
    leave_group: function (db, a) {
      var s = auth(db, a.p_token), gid = checkConvo(db, s, a.p_key), g = db.groups.find(function (x) { return x.id === gid; });
      if (gid == null || g.kind !== 'custom') fail('This chat is set automatically by position or union, so you can\'t leave it.');
      db.gmembers = db.gmembers.filter(function (m) { return !(m.group_id === gid && m.staff_id === s.id); });
      if (!groupMembers(db, gid).length) g.archived = true;
    },
    delete_group: function (db, a) {
      var s = auth(db, a.p_token), gid = checkConvo(db, s, a.p_key), g = db.groups.find(function (x) { return x.id === gid; });
      if (gid == null || g.kind !== 'custom') fail('This group can\'t be deleted.');
      if (g.created_by !== s.id && s.role !== 'admin') fail('Only the person who made the group or a manager can delete it.');
      g.archived = true;
    },
    set_item_image: function (db, a) {
      auth(db, a.p_token, true);
      if (!itemById(db, a.p_item_id)) fail('Item not found.');
      if (['image/jpeg', 'image/png', 'image/webp'].indexOf(a.p_mime) < 0) fail('Photos must be JPG, PNG or WebP.');
      if (String(a.p_data || '').length * 3 / 4 > 1536 * 1024) fail('That photo is too large (max 1.5 MB).');
      var ver = Date.now(); db.itemImg[a.p_item_id] = { ver: ver, mime: a.p_mime }; imgMem[a.p_item_id] = a.p_data; return ver;
    },
    remove_item_image: function (db, a) { auth(db, a.p_token, true); delete db.itemImg[a.p_item_id]; delete imgMem[a.p_item_id]; },
    item_images: function (db, a) {
      auth(db, a.p_token);
      return (a.p_ids || []).slice(0, 40).filter(function (id) { return db.itemImg[id] && imgMem[id]; })
        .map(function (id) { return { id: id, ver: db.itemImg[id].ver, mime: db.itemImg[id].mime, data: imgMem[id] }; });
    },
    list_uniform_orders: function (db, a) {
      authOffice(db, a.p_token);
      var rank = { arrived: 1, in_transit: 2 };
      var list = db.uniforms.filter(function (u) { return a.p_done ? (u.status === 'collected' || u.status === 'cancelled') : (u.status === 'in_transit' || u.status === 'arrived'); })
        .sort(function (x, y) { return ((rank[x.status] || 3) - (rank[y.status] || 3)) || String(y.collected_at || y.arrived_at || y.created_at).localeCompare(String(x.collected_at || x.arrived_at || x.created_at)); });
      return { tickets: list.map(function (u) { return uniJson(db, u); }), open: uniOpen(db).length,
               tracks_todo: db.uniforms.filter(function (u) { return u.status === 'collected' && !u.tracks_done; }).length,
               linked: !!db.settings.tracks_key, last_seen: db.settings.tracks_last_seen || null };
    },
    uniform_set_status: function (db, a) {
      var s = authOffice(db, a.p_token), u = db.uniforms.find(function (x) { return x.id === a.p_id; }), notified = false;
      if (!u) fail('That ticket no longer exists.');
      if (a.p_status === 'arrived') {
        if (u.status === 'cancelled') fail('That order was cancelled.');
        if (u.status === 'in_transit') { u.arrived_at = now(); u.arrived_by = s.id; if (u.staff_id) { u.notified_at = now(); notified = true; } }
        u.status = 'arrived'; u.collected_at = null; u.collected_by = null; u.collected_self = false;
      } else if (a.p_status === 'collected') {
        if (u.status !== 'arrived') fail('Tick it as arrived first.');
        u.status = 'collected'; u.collected_at = now(); u.collected_by = s.id; u.collected_self = false;
      } else if (a.p_status === 'in_transit') {
        if (u.status !== 'arrived') fail('Only an arrived order can be put back to "on its way".');
        u.status = 'in_transit'; u.arrived_at = null; u.arrived_by = null; u.notified_at = null;
      } else if (a.p_status === 'cancelled') {
        u.status = 'cancelled'; u.note = ((u.note || '') + ' Closed by ' + s.name + '.').trim();
      } else fail('Unknown status.');
      u.updated_at = now();
      var r = uniJson(db, u); r.notified = notified; return r;
    },
    uniform_link_person: function (db, a) {
      authOffice(db, a.p_token);
      var u = db.uniforms.find(function (x) { return x.id === a.p_id; });
      if (!u) fail('That ticket no longer exists.');
      if (a.p_staff_id && !db.staff.some(function (x) { return x.id === a.p_staff_id && x.active; })) fail('That person is not in Kippa Crew.');
      u.staff_id = a.p_staff_id || null; u.updated_at = now();
      if (u.source === 'tracks' && normName(u.person_name)) { db.nameLinks = db.nameLinks || {}; if (u.staff_id) db.nameLinks[normName(u.person_name)] = u.staff_id; else delete db.nameLinks[normName(u.person_name)]; uniRelink(db); }
      var notified = !!(u.status === 'arrived' && u.staff_id); if (notified) u.notified_at = now();
      var r = uniJson(db, u); r.notified = notified; return r;
    },
    uniform_add: function (db, a) {
      var s = authOffice(db, a.p_token), order = String(a.p_order || '').trim();
      if (!order) fail('Order number is required.');
      if (!a.p_staff_id && !String(a.p_name || '').trim()) fail('Choose who it is for.');
      if (a.p_items != null && (a.p_items < 0 || a.p_items > 999)) fail('Items must be 0 to 999.');
      if (uniOpen(db).some(function (u) { return lc(u.order_number) === lc(order); })) fail('There is already an open ticket for that order.');
      var u = { id: db.nextU++, order_number: order.slice(0, 40), person_name: staffName(db, a.p_staff_id) || String(a.p_name).trim(), staff_id: a.p_staff_id || null,
                items: a.p_items == null ? null : a.p_items, status: 'in_transit', source: 'manual', note: a.p_note || null, tracks_updates: 0,
                created_by: s.id, created_at: now(), updated_at: now(), tracks_done: false };
      db.uniforms.push(u); return uniJson(db, u);
    },
    uniform_tracks_done: function (db, a) {
      authOffice(db, a.p_token);
      db.uniforms.forEach(function (u) { if ((a.p_ids || []).indexOf(u.id) >= 0 && u.status === 'collected') u.tracks_done = a.p_done !== false; });
    },
    my_uniform_orders: function (db, a) {
      var s = auth(db, a.p_token), rank = { arrived: 1, in_transit: 2 }, cut = Date.now() - 60 * 86400000;
      return db.uniforms.filter(function (u) { return u.staff_id === s.id && (u.status === 'in_transit' || u.status === 'arrived' || (u.status === 'collected' && new Date(u.collected_at).getTime() > cut)); })
        .sort(function (x, y) { return ((rank[x.status] || 3) - (rank[y.status] || 3)) || y.id - x.id; })
        .map(function (u) { return { id: u.id, order_number: u.order_number, items: u.items, status: u.status, created_at: u.created_at, arrived_at: u.arrived_at || null, collected_at: u.collected_at || null }; });
    },
    uniform_got_it: function (db, a) {
      var s = auth(db, a.p_token), u = db.uniforms.find(function (x) { return x.id === a.p_id && x.staff_id === s.id && x.status === 'arrived'; });
      if (!u) fail('That order isn\'t waiting for you.');
      u.status = 'collected'; u.collected_at = now(); u.collected_by = s.id; u.collected_self = true; u.updated_at = now();
    },
    tracks_link_info: function (db, a) {
      auth(db, a.p_token, true);
      return { key: db.settings.tracks_key || '', last_seen: db.settings.tracks_last_seen || null, last_event: db.settings.tracks_last_event || null,
               unmatched: uniOpen(db).filter(function (u) { return !u.staff_id; }).length,
               remembered: Object.keys(db.nameLinks || {}).length };
    },
    tracks_link_set: function (db, a) {
      auth(db, a.p_token, true);
      var k = 'krd_'; for (var i = 0; i < 48; i++) k += '0123456789abcdef'[Math.random() * 16 | 0];
      db.settings.tracks_key = a.p_on ? k : '';
      return F.tracks_link_info(db, a);
    },
    tracks_inbound: function (db, a) {
      if (!db.settings.tracks_key) fail('TRACKS_LINK_OFF');
      if (a.p_key !== db.settings.tracks_key) fail('BAD_KEY');
      db.settings.tracks_last_seen = now(); db.settings.tracks_last_event = a.p_event + ' ' + a.p_order;
      if (a.p_event === 'ping') return { ok: true, event: 'ping' };
      return uniInbound(db, a.p_event, a.p_order, a.p_name, a.p_depot, a.p_items);
    },
    demo_simulate_tracks: function (db, a) {
      authOffice(db, a.p_token);
      var crew = db.staff.filter(function (s) { return s.active && s.role === 'staff'; });
      var who = crew[Math.floor(Math.random() * crew.length)] || db.staff[0];
      var parts = who.name.split(' ');
      db.settings.tracks_last_seen = now(); db.settings.tracks_last_event = 'dispatched (demo)';
      return uniInbound(db, 'dispatched', 'ORD-2026-' + String(4900 + db.nextU).padStart(6, '0'), parts.length > 1 ? parts.slice(1).join(' ') + ', ' + parts[0] : who.name,
                        'Kippa Ring', 1 + Math.floor(Math.random() * 4));
    },
    send_message: function (db, a) {
      var s = auth(db, a.p_token), body = String(a.p_body || '').trim();
      if (!body) fail('Message is empty.');
      var gid = checkConvo(db, s, a.p_to);
      var m = { id: db.nextMsg++, sender_id: s.id, recipient_id: (a.p_to === 'team' || gid != null) ? null : a.p_to, group_id: gid, body: body.slice(0, 2000), created_at: now() };
      db.msgs.push(m); return { id: m.id };
    }
  };

  global.KRDDemo = {
    call: function (fn, args) {
      var db = load();
      if (!F[fn]) throw new Error('Unknown function ' + fn);
      var out = F[fn](db, args);
      save();
      return out;
    },
    reset: function () { memory = seed(); save(); },
    pins: function () { return load().staff.map(function (s) { return s.name + ': ' + s.pin; }); }
  };
})(window);
