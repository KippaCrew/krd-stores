/* KRD Stores — API layer.
   Calls the Supabase database functions (RPC). If no Supabase details are
   configured, calls go to the in-browser demo backend instead. */
(function (global) {
  'use strict';

  var cfg = global.KRD_CONFIG || {};
  var URL_BASE = String(cfg.SUPABASE_URL || '').replace(/\/+$/, '');
  var KEY = String(cfg.SUPABASE_ANON_KEY || '');
  var DEMO = !URL_BASE || !KEY;

  function ApiError(message, kind) {
    var e = new Error(message);
    e.kind = kind || 'app';   // 'app' | 'network' | 'session'
    return e;
  }

  async function rpc(fn, args) {
    if (DEMO) {
      // small delay so the demo feels like the real thing
      await new Promise(function (r) { setTimeout(r, 120); });
      try {
        var out = global.KRDDemo.call(fn, args || {});
        return JSON.parse(JSON.stringify(out === undefined ? null : out));
      } catch (err) {
        if (String(err.message) === 'SESSION_EXPIRED') throw ApiError('Your session has expired. Please sign in again.', 'session');
        if (String(err.message) === 'PIN_CHANGE_REQUIRED') throw ApiError('Please choose your own PIN first.', 'pin');
        throw ApiError(err.message || String(err));
      }
    }

    var headers = { 'Content-Type': 'application/json', 'apikey': KEY, 'Accept': 'application/json' };
    // Legacy anon keys are JWTs and also go in Authorization; new publishable keys only need apikey.
    if (/^eyJ/.test(KEY)) headers['Authorization'] = 'Bearer ' + KEY;

    var res;
    try {
      res = await fetch(URL_BASE + '/rest/v1/rpc/' + fn, {
        method: 'POST', headers: headers, body: JSON.stringify(args || {}), cache: 'no-store'
      });
    } catch (netErr) {
      throw ApiError('No connection. Check your signal and try again.', 'network');
    }
    var text = await res.text();
    var body = null;
    if (text) { try { body = JSON.parse(text); } catch (_) { body = text; } }
    if (!res.ok) {
      var msg = (body && (body.message || body.error_description || body.hint)) || ('Server error ' + res.status);
      if (/SESSION_EXPIRED/.test(msg)) throw ApiError('Your session has expired. Please sign in again.', 'session');
      if (/PIN_CHANGE_REQUIRED/.test(msg)) throw ApiError('Please choose your own PIN first.', 'pin');
      if (/ADMIN_ONLY/.test(msg)) throw ApiError('Only managers can do that.');
      if (res.status === 404 && /function/i.test(msg)) msg = 'The database is not set up yet (run schema.sql in Supabase).';
      throw ApiError(msg);
    }
    return body;
  }

  global.KRDApi = { rpc: rpc, isDemo: DEMO };
})(window);
