/* ============================================================
   MIC — booking admin (staff only)
   Signs in against Supabase Auth. Everything it can do is granted by
   the database to the "authenticated" role, so this page holds no
   secret of its own: without a real sign-in it can read nothing.
   Schema: mic_booking_2026-11-02.sql
   ============================================================ */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://xnegzvpuagxgahlbtzaf.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhuZWd6dnB1YWd4Z2FobGJ0emFmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzODk0NDIsImV4cCI6MjA5Mzk2NTQ0Mn0.RXBD_LxrZiv0tQfX7W6S9wT8JKNMPd5xB3LBlV50lAE';

  var HALF = { am: 'Morning 08:00–14:00', pm: 'Afternoon 14:00–20:00' };
  var CAT = {
    none: 'None', refreshments: 'Refreshments ($3pp)', coffee_break: 'Coffee break ($5pp)',
    premium: 'Premium coffee break ($10pp)', meal: 'Meal break (on request)'
  };
  var LS = 'mic_adm_token';
  var $ = function (id) { return document.getElementById(id); };
  var token = null, view = 'pending', rows = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function msg(kind, text) {
    $('admMsg').innerHTML = text ? '<div class="bk-msg bk-msg--' + kind + '">' + text + '</div>' : '';
  }
  function hdrs() {
    return {
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    };
  }
  function slotText(r) { return r.room === 'workshop' ? (HALF[r.slot] || r.slot) : r.slot + ':00'; }
  function dateText(d) {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-GB',
      { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  /* ------------------------------------------------------------ auth -- */
  function signIn(e) {
    e.preventDefault();
    var btn = $('admGo'); btn.disabled = true; btn.textContent = 'Signing in…';
    fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('admEmail').value.trim(), password: $('admPass').value })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = 'Sign in';
        if (!res.ok || !res.j.access_token) {
          msg('err', esc(res.j.error_description || res.j.msg || 'Those details were not accepted.'));
          return;
        }
        token = res.j.access_token;
        try { sessionStorage.setItem(LS, token); } catch (_) {}
        open_();
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = 'Sign in';
        msg('err', 'Could not reach the server. Check your connection and try again.');
      });
  }

  function open_() {
    msg('', '');
    $('admLogin').hidden = true;
    $('admPanel').hidden = false;
    $('admOut').hidden = false;
    load();
  }
  function signOut() {
    token = null;
    try { sessionStorage.removeItem(LS); } catch (_) {}
    $('admLogin').hidden = false; $('admPanel').hidden = true; $('admOut').hidden = true;
  }

  /* ------------------------------------------------------------ data -- */
  function load() {
    fetch(SUPABASE_URL + '/rest/v1/room_bookings?select=*&order=booking_date.asc,slot.asc', { headers: hdrs() })
      .then(function (r) {
        if (r.status === 401) { signOut(); msg('err', 'Your session expired. Please sign in again.'); return null; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) { if (!data) return; rows = data; render(); })
      .catch(function () { msg('err', 'Could not load bookings. Try again in a moment.'); });
  }

  function patch(ids, body, label) {
    var q = 'id=in.(' + ids.join(',') + ')';
    return fetch(SUPABASE_URL + '/rest/v1/room_bookings?' + q, {
      method: 'PATCH', headers: Object.assign(hdrs(), { Prefer: 'return=minimal' }),
      body: JSON.stringify(body)
    }).then(function (r) {
      if (r.status === 409) { msg('err', 'That slot already has a confirmed booking. Reject one of them first.'); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      msg('ok', label); load();
    }).catch(function () { msg('err', 'That did not go through. Try again.'); });
  }

  /* ---------------------------------------------------------- render -- */
  function render() {
    var pending = rows.filter(function (r) { return r.status === 'pending' && r.kind === 'booking'; });
    var waits   = rows.filter(function (r) { return r.kind === 'waitlist' && r.status === 'pending'; });
    var conf    = rows.filter(function (r) { return r.status === 'confirmed'; });
    $('cPending').textContent = String(groups(pending).length);
    $('cWait').textContent    = String(groups(waits).length);
    $('cConf').textContent    = String(groups(conf).length);

    $('admBlock').hidden = view !== 'block';
    $('admList').hidden  = view === 'block';
    if (view === 'block') { fillSlots(); return; }

    var set = view === 'pending' ? pending
            : view === 'waitlist' ? waits
            : view === 'confirmed' ? conf
            : rows;
    var gs = groups(set);
    if (!gs.length) {
      $('admList').innerHTML = '<p class="bk-muted" style="padding:28px 0;">Nothing here.</p>';
      return;
    }
    $('admList').innerHTML = gs.map(card).join('');
    $('admList').querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var ids = b.dataset.ids.split(',');
        var a = b.dataset.act;
        if (a === 'confirm') patch(ids, { status: 'confirmed' }, 'Confirmed. The slot is now closed on the public calendar.');
        if (a === 'reject')  patch(ids, { status: 'rejected' },  'Rejected.');
        if (a === 'cancel')  patch(ids, { status: 'cancelled' }, 'Cancelled. The slot is open again.');
        if (a === 'reopen')  patch(ids, { status: 'pending' },   'Moved back to pending.');
      });
    });
  }

  // one submission can cover several slots; show it as one card
  function groups(list) {
    var by = {};
    list.forEach(function (r) { (by[r.request_id] = by[r.request_id] || []).push(r); });
    return Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) { return (a[0].booking_date + a[0].slot) < (b[0].booking_date + b[0].slot) ? -1 : 1; });
  }

  function card(g) {
    var r = g[0];
    var ids = g.map(function (x) { return x.id; }).join(',');
    var slots = g.map(slotText).join(', ');
    var isBlock = r.status === 'blocked';
    var pill = r.kind === 'waitlist' && r.status === 'pending' ? 'waitlist' : r.status;

    var acts = '';
    if (r.status === 'pending' && r.kind === 'booking') {
      acts = '<button class="ok" data-act="confirm" data-ids="' + ids + '">Confirm</button>' +
             '<button class="no" data-act="reject"  data-ids="' + ids + '">Reject</button>';
    } else if (r.status === 'pending' && r.kind === 'waitlist') {
      acts = '<button class="no" data-act="reject" data-ids="' + ids + '">Remove from waitlist</button>';
    } else if (r.status === 'confirmed' || isBlock) {
      acts = '<button class="no" data-act="cancel" data-ids="' + ids + '">' +
             (isBlock ? 'Re-open this slot' : 'Cancel booking') + '</button>';
    } else {
      acts = '<button data-act="reopen" data-ids="' + ids + '">Move back to pending</button>';
    }

    var detail = isBlock ? '' :
      '<dl class="adm-dl">' +
        '<dt>Contact</dt><dd>' + esc(r.name) + (r.org ? ' &middot; ' + esc(r.org) : '') + '</dd>' +
        '<dt>Phone</dt><dd><a href="tel:' + esc(r.phone) + '">' + esc(r.phone) + '</a></dd>' +
        '<dt>Email</dt><dd><a href="mailto:' + esc(r.email) + '">' + esc(r.email) + '</a></dd>' +
        '<dt>People</dt><dd>' + esc(r.headcount) + (r.setup ? ' &middot; ' + (r.setup === 'ushape' ? 'U-shape' : 'Classroom') : '') + '</dd>' +
        '<dt>Catering</dt><dd>' + esc(CAT[r.catering] || r.catering) +
          (r.catering_people ? ' for ' + esc(r.catering_people) : '') + '</dd>' +
        (r.catering_quote ? '<dt>Quoted</dt><dd>$' + esc(r.catering_quote) + '</dd>' : '') +
        (r.notes ? '<dt>Notes</dt><dd>' + esc(r.notes) + '</dd>' : '') +
      '</dl>';

    return '<div class="adm-card">' +
      '<div style="display:flex;justify-content:space-between;gap:12px;align-items:start;">' +
        '<div><h4>' + (r.room === 'meeting' ? 'Meeting Room' : 'Workshop Room') + '</h4>' +
        '<div class="when">' + dateText(r.booking_date) + ' &middot; ' + esc(slots) + '</div></div>' +
        '<span class="adm-pill ' + pill + '">' + pill + '</span>' +
      '</div>' + detail +
      (r.admin_note ? '<p class="bk-muted" style="margin-bottom:10px;">' + esc(r.admin_note) + '</p>' : '') +
      '<div class="adm-acts">' + acts + '</div></div>';
  }

  /* ------------------------------------------------------ block slot -- */
  function fillSlots() {
    var room = $('blkRoom').value, sel = $('blkSlot');
    sel.innerHTML = '';
    var opts = room === 'workshop'
      ? [['am', HALF.am], ['pm', HALF.pm]]
      : Array.from({ length: 24 }, function (_, h) {
          var k = String(h).padStart(2, '0');
          return [k, k + ':00 – ' + String((h + 1) % 24).padStart(2, '0') + ':00'];
        });
    opts.forEach(function (o) {
      var el = document.createElement('option'); el.value = o[0]; el.textContent = o[1]; sel.appendChild(el);
    });
  }

  function blockSlot() {
    if (!$('blkDate').value) { msg('err', 'Pick a date first.'); return; }
    fetch(SUPABASE_URL + '/rest/v1/room_bookings', {
      method: 'POST', headers: Object.assign(hdrs(), { Prefer: 'return=minimal' }),
      body: JSON.stringify([{
        room: $('blkRoom').value, booking_date: $('blkDate').value, slot: $('blkSlot').value,
        status: 'blocked', kind: 'booking',
        admin_note: $('blkNote').value.trim() || 'Closed by staff'
      }])
    }).then(function (r) {
      if (r.status === 409) { msg('err', 'That slot is already taken.'); return; }
      if (!r.ok) throw new Error();
      msg('ok', 'Slot closed. It now shows as taken on the public calendar.');
      $('blkNote').value = ''; load();
    }).catch(function () { msg('err', 'Could not close that slot. Try again.'); });
  }

  /* ------------------------------------------------------------ wire -- */
  function init() {
    if (!$('admForm')) return;
    $('admForm').addEventListener('submit', signIn);
    $('admOut').addEventListener('click', signOut);
    $('blkRoom').addEventListener('change', fillSlots);
    $('blkGo').addEventListener('click', blockSlot);
    $('blkDate').min = new Date().toISOString().slice(0, 10);
    document.querySelectorAll('.adm-tab').forEach(function (t) {
      t.addEventListener('click', function () {
        view = t.dataset.view;
        document.querySelectorAll('.adm-tab').forEach(function (o) {
          o.setAttribute('aria-pressed', String(o === t));
        });
        render();
      });
    });
    fillSlots();
    try {
      var saved = sessionStorage.getItem(LS);
      if (saved) { token = saved; open_(); }
    } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
