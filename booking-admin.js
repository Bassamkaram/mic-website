/* ============================================================
   MIC — booking admin (staff only)
   Signs in against Supabase Auth. Everything it can do is granted by
   the database to the staff emails in mic_booking_SETUP.sql, so this
   page holds no secret of its own: without a real sign-in by a listed
   person it can read nothing.
   ============================================================ */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://xnegzvpuagxgahlbtzaf.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhuZWd6dnB1YWd4Z2FobGJ0emFmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzODk0NDIsImV4cCI6MjA5Mzk2NTQ0Mn0.RXBD_LxrZiv0tQfX7W6S9wT8JKNMPd5xB3LBlV50lAE';

  var RATE_MEETING_HOUR = 20, RATE_WORKSHOP_HALF = 100;
  var CATPP = { none: 0, refreshments: 3, coffee_break: 5, premium: 10, meal: null };
  var CAT = {
    none: 'None', refreshments: 'Refreshments ($3pp)', coffee_break: 'Coffee break ($5pp)',
    premium: 'Premium coffee break ($10pp)', meal: 'Meal break (on request)'
  };
  var HALF = { am: 'Morning 08:00–14:00', pm: 'Afternoon 14:00–20:00' };
  var DOT = { pending: 'var(--amber)', confirmed: 'var(--cedar-light)', blocked: 'var(--blue)', waitlist: 'var(--rose)' };
  var LS = 'mic_adm_token';

  var $ = function (id) { return document.getElementById(id); };
  var token = null, view = 'calendar', rows = [];
  var cal = { month: new Date(new Date().getFullYear(), new Date().getMonth(), 1), day: null, room: 'all' };
  var add = { kind: 'booking', slots: [], setup: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function msg(kind, text) {
    $('admMsg').innerHTML = text ? '<div class="bk-msg bk-msg--' + kind + '">' + text + '</div>' : '';
    if (text) window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function hdrs() {
    return { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  }
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function slotsFor(room) {
    if (room === 'workshop') return ['am', 'pm'];
    var o = []; for (var h = 0; h < 24; h++) o.push(String(h).padStart(2, '0'));
    return o;
  }
  function slotText(r) { return r.room === 'workshop' ? (HALF[r.slot] || r.slot) : r.slot + ':00 – ' + String((+r.slot + 1) % 24).padStart(2, '0') + ':00'; }
  function dateText(d) {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function statusOf(r) { return (r.kind === 'waitlist' && r.status === 'pending') ? 'waitlist' : r.status; }

  /* ------------------------------------------------------------ auth -- */
  function signIn(e) {
    e.preventDefault();
    var btn = $('admGo'); btn.disabled = true; btn.textContent = 'Signing in…';
    fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('admEmail').value.trim(), password: $('admPass').value })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = 'Sign in';
        if (!res.ok || !res.j.access_token) {
          msg('err', esc(res.j.error_description || res.j.msg || 'Those details were not accepted.')); return;
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
  // Only admins get the console. Staff accounts are pointed to their own screen,
  // because here every button would be refused by the database anyway.
  function open_() {
    msg('', '');
    var rpc = function (fn) {
      return fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, { method: 'POST', headers: hdrs(), body: '{}' })
        .then(function (r) { if (r.status === 401) throw 'expired'; return r.ok ? r.json() : false; });
    };
    rpc('is_booking_staff').then(function (isAdmin) {
      if (isAdmin === true) {
        $('admLogin').hidden = true; $('admPanel').hidden = false; $('admOut').hidden = false;
        load();
        return;
      }
      return rpc('is_booking_member').then(function (isMember) {
        signOut();
        msg('err', isMember === true
          ? 'This is a staff account. It works on the staff screen, not here: <a href="/staff">mic-lb.com/staff</a>.'
          : 'This account is not on the staff list. An admin can add it under Staff.');
      });
    }).catch(function (e) {
      signOut();
      msg('err', e === 'expired' ? 'Your session expired. Please sign in again.' : 'Could not reach the server. Check your connection and try again.');
    });
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
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(function (d) { if (!d) return; rows = d; return Promise.all([loadMenu(), loadTasks(), loadStaff()]); })
      .then(function () { render(); })
      .catch(function () { msg('err', 'Could not load bookings. Try again in a moment.'); });
  }
  function patch(ids, body, label) {
    return fetch(SUPABASE_URL + '/rest/v1/room_bookings?id=in.(' + ids.join(',') + ')', {
      method: 'PATCH', headers: Object.assign(hdrs(), { Prefer: 'return=minimal' }), body: JSON.stringify(body)
    }).then(function (r) {
      if (r.status === 409) { msg('err', 'That slot already has a confirmed booking. Cancel it first.'); return; }
      if (!r.ok) throw new Error();
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

    $('cTasks').textContent = String(stasks ? stasks.filter(function (t) { return t.status === 'open'; }).length : 0);

    $('admCal').hidden   = view !== 'calendar';
    $('admAdd').hidden   = view !== 'add';
    $('admMenu').hidden  = view !== 'menu';
    $('admTasks').hidden = view !== 'tasks';
    $('admStaff').hidden = view !== 'staff';
    $('admList').hidden  = ['calendar','add','menu','tasks','staff'].indexOf(view) !== -1;

    if (view === 'calendar') { renderCal(); return; }
    if (view === 'add') { renderAdd(); return; }
    if (view === 'menu') { renderMenu(); return; }
    if (view === 'tasks') { renderTasks(); return; }
    if (view === 'staff') { renderStaff(); return; }

    var set = view === 'pending' ? pending : view === 'waitlist' ? waits : view === 'confirmed' ? conf : rows;
    var gs = groups(set);
    $('admList').innerHTML = gs.length ? gs.map(card).join('')
      : '<p class="bk-muted" style="padding:28px 0;">Nothing here.</p>';
    wireActs($('admList'));
  }

  function groups(list) {
    var by = {};
    list.forEach(function (r) { (by[r.request_id] = by[r.request_id] || []).push(r); });
    return Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) { return (a[0].booking_date + a[0].slot) < (b[0].booking_date + b[0].slot) ? -1 : 1; });
  }

  function wireActs(root) {
    root.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var ids = b.dataset.ids.split(','), a = b.dataset.act;
        if (a === 'confirm') patch(ids, { status: 'confirmed' }, 'Confirmed. The slot is now closed on the public calendar.');
        if (a === 'reject')  patch(ids, { status: 'rejected' },  'Rejected.');
        if (a === 'cancel')  patch(ids, { status: 'cancelled' }, 'Cancelled. The slot is open again.');
        if (a === 'reopen')  patch(ids, { status: 'pending' },   'Moved back to pending.');
      });
    });
  }

  function card(g) {
    var r = g[0], ids = g.map(function (x) { return x.id; }).join(',');
    var slots = g.map(slotText).join(', '), isBlock = r.status === 'blocked', st = statusOf(r);
    var acts = '';
    if (r.status === 'pending' && r.kind === 'booking') {
      acts = '<button class="ok" data-act="confirm" data-ids="' + ids + '">Confirm</button>' +
             '<button class="no" data-act="reject" data-ids="' + ids + '">Reject</button>';
    } else if (r.status === 'pending') {
      acts = '<button class="no" data-act="reject" data-ids="' + ids + '">Remove from waitlist</button>';
    } else if (r.status === 'confirmed' || isBlock) {
      acts = '<button class="no" data-act="cancel" data-ids="' + ids + '">' + (isBlock ? 'Re-open this slot' : 'Cancel booking') + '</button>';
    } else {
      acts = '<button data-act="reopen" data-ids="' + ids + '">Move back to pending</button>';
    }
    var detail = isBlock ? '' :
      '<dl class="adm-dl">' +
        '<dt>Contact</dt><dd>' + esc(r.name) + (r.org ? ' &middot; ' + esc(r.org) : '') + '</dd>' +
        (r.phone ? '<dt>Phone</dt><dd><a href="tel:' + esc(r.phone) + '">' + esc(r.phone) + '</a></dd>' : '') +
        (r.email ? '<dt>Email</dt><dd><a href="mailto:' + esc(r.email) + '">' + esc(r.email) + '</a></dd>' : '') +
        '<dt>People</dt><dd>' + esc(r.headcount) + (r.setup ? ' &middot; ' + (r.setup === 'ushape' ? 'U-shape' : 'Classroom') : '') + '</dd>' +
        (r.addons && r.addons.length
           ? '<dt>Ordered</dt><dd>' + r.addons.map(function (a) {
               return esc(a.name) + (a.line === null ? ' <em>(quote)</em>' : a.line > 0 ? ' $' + (Number(a.line) % 1 === 0 ? Number(a.line).toFixed(0) : Number(a.line).toFixed(2)) : ' (incl.)');
             }).join('<br/>') + '</dd>'
           : '<dt>Catering</dt><dd>' + esc(CAT[r.catering] || r.catering) + (r.catering_people ? ' for ' + esc(r.catering_people) : '') + '</dd>') +
        (r.addons_note ? '<dt>Special order</dt><dd>' + esc(r.addons_note) + '</dd>' : '') +
        (r.catering_quote ? '<dt>Quoted</dt><dd>$' + esc(r.catering_quote) + '</dd>' : '') +
        (r.notes ? '<dt>Notes</dt><dd>' + esc(r.notes) + '</dd>' : '') +
      '</dl>';
    return '<div class="adm-card"><div style="display:flex;justify-content:space-between;gap:12px;align-items:start;">' +
      '<div><h4>' + (r.room === 'meeting' ? 'Meeting Room' : 'Workshop Room') + '</h4>' +
      '<div class="when">' + dateText(r.booking_date) + ' &middot; ' + esc(slots) + '</div></div>' +
      '<span class="adm-pill ' + st + '">' + st + '</span></div>' + detail +
      (r.admin_note ? '<p class="bk-muted" style="margin-bottom:10px;">' + esc(r.admin_note) + '</p>' : '') +
      '<div class="adm-acts">' + acts + '</div></div>';
  }

  /* -------------------------------------------------------- calendar -- */
  function visible() {
    return rows.filter(function (r) {
      return (cal.room === 'all' || r.room === cal.room) &&
             ['pending', 'confirmed', 'blocked'].indexOf(r.status) !== -1;
    });
  }

  function renderCal() {
    var dow = $('admDow');
    if (!dow.childNodes.length) {
      ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(function (d) {
        var c = document.createElement('div'); c.className = 'bk-dow'; c.textContent = d; dow.appendChild(c);
      });
    }
    var y = cal.month.getFullYear(), m = cal.month.getMonth();
    $('admMonth').textContent = cal.month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    var byDay = {};
    visible().forEach(function (r) { (byDay[r.booking_date] = byDay[r.booking_date] || []).push(r); });

    var lead = (new Date(y, m, 1).getDay() + 6) % 7;
    var days = new Date(y, m + 1, 0).getDate(), today = iso(new Date());
    var grid = $('admDays'); grid.innerHTML = '';
    for (var i = 0; i < lead; i++) {
      var p = document.createElement('div'); p.className = 'bk-day is-empty'; grid.appendChild(p);
    }
    for (var d = 1; d <= days; d++) {
      var key = iso(new Date(y, m, d));
      var list = byDay[key] || [];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'bk-day' + (key < today ? ' is-past' : '');
      b.dataset.date = key;
      b.setAttribute('aria-pressed', String(cal.day === key));
      var seen = {}, dots = '';
      list.forEach(function (r) {
        var s = statusOf(r);
        if (!seen[s]) { seen[s] = 1; dots += '<i style="background:' + DOT[s] + '"></i>'; }
      });
      b.innerHTML = d + (dots ? '<span class="dots">' + dots + '</span>' : '');
      b.addEventListener('click', function (e) { cal.day = e.currentTarget.dataset.date; renderCal(); });
      grid.appendChild(b);
    }
    renderDay(byDay);
  }

  function renderDay(byDay) {
    var box = $('admDayView');
    if (!cal.day) { box.innerHTML = '<p class="bk-muted">Pick a day to see what is booked.</p>'; return; }
    var list = (byDay[cal.day] || []).slice().sort(function (a, b) {
      return (a.room + a.slot) < (b.room + b.slot) ? -1 : 1;
    });
    var html = '<h3>' + dateText(cal.day) + '</h3>' +
      '<p class="sub">' + (list.length ? list.length + ' slot' + (list.length > 1 ? 's' : '') + ' taken' : 'Nothing booked — the whole day is free.') + '</p>';
    html += list.map(function (r) {
      var st = statusOf(r);
      var acts = st === 'pending'
        ? '<button class="ok" data-act="confirm" data-ids="' + r.id + '">Confirm</button><button class="no" data-act="reject" data-ids="' + r.id + '">Reject</button>'
        : '<button class="no" data-act="cancel" data-ids="' + r.id + '">' + (r.status === 'blocked' ? 'Re-open' : 'Cancel') + '</button>';
      if (r.status !== 'blocked' && stasks) acts = '<button data-mktask="' + r.request_id + '" title="A task for staff about this booking">+ Task</button>' + acts;
      return '<div class="adm-slotrow">' +
        '<span class="t">' + esc(slotText(r)) + '</span>' +
        '<span class="who">' + (r.status === 'blocked' ? '<em>Closed</em>' : esc(r.name || '—')) +
          '<small>' + (r.room === 'meeting' ? 'Meeting Room' : 'Workshop Room') +
          (r.headcount ? ' · ' + esc(r.headcount) + ' people' : '') +
          (r.admin_note ? ' · ' + esc(r.admin_note) : '') + '</small></span>' +
        '<span class="adm-pill ' + st + '">' + st + '</span>' +
        '<span class="acts">' + acts + '</span></div>';
    }).join('');
    html += '<p style="margin-top:14px;"><button class="adm-tab" id="admAddHere">+ Add a booking on this day</button></p>';
    box.innerHTML = html;
    wireActs(box);
    box.querySelectorAll('[data-mktask]').forEach(function (b) {
      b.addEventListener('click', function () {
        resetTaskForm();
        tk.link = { request_id: b.getAttribute('data-mktask') };
        setView('tasks');
        $('tkTitle').focus();
      });
    });
    var jump = $('admAddHere');
    if (jump) jump.addEventListener('click', function () {
      setView('add'); $('addDate').value = cal.day; renderAdd();
    });
  }

  /* ------------------------------------------------------ add booking -- */
  function addLimit() {
    if ($('addRoom').value === 'meeting') return 15;
    return add.setup === 'ushape' ? 30 : 40;
  }
  function renderAdd() {
    var room = $('addRoom').value;
    $('addSetupRow').hidden = room !== 'workshop';
    $('addWho').hidden = add.kind === 'blocked';
    $('addSlotHint').textContent = room === 'workshop' ? 'pick one half-day, or both' : 'pick one or more hours';

    var date = $('addDate').value;
    var taken = {};
    rows.forEach(function (r) {
      if (r.room === room && r.booking_date === date && ['confirmed', 'blocked'].indexOf(r.status) !== -1) taken[r.slot] = true;
    });

    var wrap = $('addSlots');
    wrap.className = 'bk-slots' + (room === 'workshop' ? ' bk-slots--half' : '');
    wrap.innerHTML = '';
    slotsFor(room).forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'bk-slot' + (taken[k] ? ' is-taken' : '');
      b.dataset.slot = k;
      b.disabled = !!taken[k];
      b.setAttribute('aria-pressed', String(add.slots.indexOf(k) !== -1));
      b.innerHTML = room === 'workshop'
        ? (HALF[k].split(' ')[0] + '<span class="sub">' + HALF[k].split(' ')[1] + (taken[k] ? ' · taken' : '') + '</span>')
        : (k + ':00<span class="sub">' + (taken[k] ? 'taken' : 'free') + '</span>');
      if (!taken[k]) b.addEventListener('click', function () {
        var i = add.slots.indexOf(k);
        if (i === -1) add.slots.push(k); else add.slots.splice(i, 1);
        add.slots.sort(); renderAdd();
      });
      wrap.appendChild(b);
    });

    var lim = addLimit(), n = parseInt($('addHeads').value, 10) || 0;
    $('addCapHint').textContent = (room === 'workshop' && !add.setup)
      ? 'Pick a setup — 30 U-shape, 40 classroom.'
      : (n > lim ? 'Room holds ' + lim + '.' : 'Maximum ' + lim + '.');
    $('addCapHint').className = 'hint' + (n > lim ? ' bad' : '');
    $('addHeads').max = String(lim);

    if (add.kind === 'blocked' || !add.slots.length) { $('addTotal').textContent = '—'; return; }
    var rooms = add.slots.length * (room === 'workshop' ? RATE_WORKSHOP_HALF : RATE_MEETING_HOUR);
    var pp = CATPP[$('addCat').value];
    var food = (pp && n) ? pp * n : 0;
    $('addTotal').textContent = ($('addCat').value === 'meal')
      ? '$' + rooms + ' + meal on request' : '$' + (rooms + food);
  }

  function addGo() {
    var room = $('addRoom').value, date = $('addDate').value;
    if (!date) { msg('err', 'Pick a date.'); return; }
    if (!add.slots.length) { msg('err', 'Pick at least one time slot.'); return; }
    var n = parseInt($('addHeads').value, 10) || null;
    if (add.kind === 'booking') {
      if (!$('addName').value.trim()) { msg('err', 'Who is the room for? Add a name.'); return; }
      if (room === 'workshop' && !add.setup) { msg('err', 'Pick U-shape or classroom.'); return; }
      if (n && n > addLimit()) { msg('err', 'That room holds ' + addLimit() + ' people in this setup.'); return; }
    }
    var reqId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : null;
    var rooms = add.slots.length * (room === 'workshop' ? RATE_WORKSHOP_HALF : RATE_MEETING_HOUR);
    var pp = CATPP[$('addCat').value];
    var quote = add.kind === 'blocked' ? null : rooms + ((pp && n) ? pp * n : 0);

    var payload = add.slots.map(function (k) {
      var r = {
        room: room, booking_date: date, slot: k,
        status: add.kind === 'blocked' ? 'blocked' : 'confirmed', kind: 'booking',
        admin_note: $('addNote').value.trim() || (add.kind === 'blocked' ? 'Closed by staff' : 'Added by staff')
      };
      if (reqId) r.request_id = reqId;
      if (add.kind === 'booking') {
        r.name = $('addName').value.trim();
        r.phone = $('addPhone').value.trim() || null;
        r.email = $('addEmail').value.trim() || null;
        r.org = $('addOrg').value.trim() || null;
        r.headcount = n;
        r.setup = room === 'workshop' ? add.setup : null;
        r.catering = $('addCat').value;
        r.catering_people = $('addCat').value === 'none' ? null : n;
        r.catering_quote = $('addCat').value === 'meal' ? null : quote;
      }
      return r;
    });

    var btn = $('addGo'); btn.disabled = true; btn.textContent = 'Adding…';
    fetch(SUPABASE_URL + '/rest/v1/room_bookings', {
      method: 'POST', headers: Object.assign(hdrs(), { Prefer: 'return=minimal' }), body: JSON.stringify(payload)
    }).then(function (r) {
      btn.disabled = false; btn.textContent = 'Add to the calendar';
      if (r.status === 409) { msg('err', 'One of those slots is already taken. Refresh and pick another.'); load(); return; }
      if (!r.ok) throw new Error();
      msg('ok', (add.kind === 'blocked' ? 'Room closed' : 'Booking added') + ' for ' + dateText(date) + '. It shows as taken on the public calendar now.');
      ['addName','addPhone','addEmail','addOrg','addHeads','addNote'].forEach(function (i) { $(i).value = ''; });
      add.slots = []; add.setup = null;
      document.querySelectorAll('#addSetup [data-s]').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
      cal.day = date; load();
    }).catch(function () {
      btn.disabled = false; btn.textContent = 'Add to the calendar';
      msg('err', 'Could not add that. Try again.');
    });
  }

  /* ----------------------------------------- catering & extras menu -- */
  var menu = [];
  var KINDLABEL = { package: 'Catering packages', item: 'Catering items (build your own)', extra: 'Equipment and services' };

  function loadMenu() {
    return fetch(SUPABASE_URL + '/rest/v1/booking_addons?select=*&order=kind.asc,sort.asc', { headers: hdrs() })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) { menu = d; })
      .catch(function () {
        msg('err', 'Could not load the catering menu. If this is the first time, run mic_booking_EXTRAS.sql in Supabase.');
        menu = [];
      });
  }

  function renderMenu() {
    var box = $('menuGroups');
    if (!menu.length) { box.innerHTML = '<p class="bk-muted">Nothing on the menu yet.</p>'; return; }
    box.innerHTML = ['package','item','extra'].map(function (k) {
      var set = menu.filter(function (m) { return m.kind === k; });
      if (!set.length) return '';
      return '<div class="menu-group"><h4>' + KINDLABEL[k] + '</h4>' + set.map(function (m) {
        return '<div class="menu-row' + (m.active ? '' : ' is-off') + '" data-id="' + m.id + '">' +
          '<input data-f="name" value="' + esc(m.name) + '" maxlength="80"/>' +
          '<input data-f="description" value="' + esc(m.description || '') + '" maxlength="200" placeholder="Description"/>' +
          '<input data-f="price" type="number" min="0" step="0.5" value="' + (m.price == null ? '' : m.price) + '" placeholder="on req"/>' +
          '<select data-f="unit">' +
            ['per_person','flat','per_hour'].map(function (u) {
              return '<option value="' + u + '"' + (m.unit === u ? ' selected' : '') + '>' +
                     (u === 'per_person' ? 'per person' : u === 'flat' ? 'flat' : 'per hour') + '</option>';
            }).join('') +
          '</select>' +
          '<label class="m-toggle"><input type="checkbox" data-f="active"' + (m.active ? ' checked' : '') + '/>live</label>' +
          '<span class="m-act"><button class="save" data-m="save">Save</button>' +
          '<button class="del" data-m="del">Delete</button></span></div>';
      }).join('') + '</div>';
    }).join('');

    box.querySelectorAll('[data-m]').forEach(function (b) {
      b.addEventListener('click', function () {
        var row = b.closest('.menu-row'), id = row.dataset.id;
        if (b.dataset.m === 'del') {
          if (!window.confirm('Delete this permanently? Switching it off instead keeps it out of the public page without touching past bookings.')) return;
          fetch(SUPABASE_URL + '/rest/v1/booking_addons?id=eq.' + id, { method: 'DELETE', headers: hdrs() })
            .then(function (r) { if (!r.ok) throw new Error(); msg('ok', 'Deleted.'); return loadMenu().then(renderMenu); })
            .catch(function () { msg('err', 'Could not delete that.'); });
          return;
        }
        var g = function (f) { return row.querySelector('[data-f="' + f + '"]'); };
        var priceRaw = g('price').value.trim();
        var body = {
          name: g('name').value.trim(),
          description: g('description').value.trim() || null,
          price: priceRaw === '' ? null : Number(priceRaw),
          unit: g('unit').value,
          active: g('active').checked
        };
        if (!body.name) { msg('err', 'It needs a name.'); return; }
        fetch(SUPABASE_URL + '/rest/v1/booking_addons?id=eq.' + id, {
          method: 'PATCH', headers: Object.assign(hdrs(), { Prefer: 'return=minimal' }), body: JSON.stringify(body)
        }).then(function (r) { if (!r.ok) throw new Error(); msg('ok', 'Saved. It is live on the booking page now.'); return loadMenu().then(renderMenu); })
          .catch(function () { msg('err', 'Could not save that.'); });
      });
    });
  }

  function menuAdd() {
    var name = $('newName').value.trim();
    if (!name) { msg('err', 'Give it a name first.'); return; }
    var priceRaw = $('newPrice').value.trim();
    var kind = $('newKind').value;
    var sort = 10 + 10 * menu.filter(function (m) { return m.kind === kind; }).length;
    fetch(SUPABASE_URL + '/rest/v1/booking_addons', {
      method: 'POST', headers: Object.assign(hdrs(), { Prefer: 'return=minimal' }),
      body: JSON.stringify([{
        kind: kind, name: name,
        description: $('newDesc').value.trim() || null,
        price: priceRaw === '' ? null : Number(priceRaw),
        unit: $('newUnit').value, active: true, sort: sort
      }])
    }).then(function (r) {
      if (!r.ok) throw new Error();
      msg('ok', '"' + name + '" added and live on the booking page.');
      ['newName','newDesc','newPrice'].forEach(function (i) { $(i).value = ''; });
      return loadMenu().then(renderMenu);
    }).catch(function () { msg('err', 'Could not add that.'); });
  }

  /* ------------------------------------------------------ staff tasks -- */
  var TZ = 'Asia/Beirut';
  var stasks = null, staff = null, subs = [], proofUrl = {};
  var tk = { edit: null, prio: 'normal', link: null };
  var stf = { role: 'viewer' };

  function myEmail() {
    try { return String(JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email || '').toLowerCase(); }
    catch (_) { return ''; }
  }
  function beirut(iso) {
    return new Date(iso).toLocaleString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  function staffName(email) {
    if (!email) return '';
    if (email === myEmail()) return 'you';
    var s = (staff || []).filter(function (x) { return x.email === email; })[0];
    return s && s.name ? s.name : email.split('@')[0];
  }
  function hh(h) { return String(h % 24).padStart(2, '0') + ':00'; }
  function bookingLabel(reqId) {
    var g = rows.filter(function (r) { return r.request_id === reqId && r.status !== 'cancelled' && r.status !== 'rejected'; });
    if (!g.length) return null;
    var from = 24, to = 0;
    g.forEach(function (r) {
      var s = r.slot === 'am' ? [8, 14] : r.slot === 'pm' ? [14, 20] : [+r.slot, +r.slot + 1];
      from = Math.min(from, s[0]); to = Math.max(to, s[1]);
    });
    return (g[0].room === 'meeting' ? 'Meeting Room' : g[0].room === 'workshop' ? 'Workshop Room' : g[0].room) + ' · ' +
      new Date(g[0].booking_date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) +
      ' ' + hh(from) + '–' + hh(to) + (g[0].name ? ' · ' + g[0].name : '');
  }
  // a second tap within four seconds confirms
  function confirmTap(btn, label) {
    if (btn._armed && Date.now() - btn._armed < 4000) return true;
    var was = btn.textContent;
    btn._armed = Date.now(); btn.textContent = label; btn.classList.add('arm');
    setTimeout(function () { if (btn.isConnected) { btn._armed = 0; btn.textContent = was; btn.classList.remove('arm'); } }, 4000);
    return false;
  }
  function expired() { signOut(); msg('err', 'Your session expired. Please sign in again.'); }
  function errText(r) {
    return r.json().catch(function () { return {}; }).then(function (j) { return j.code === 'P0001' && j.message ? j.message : ''; });
  }

  function loadTasks() {
    var since = new Date(Date.now() - 30 * 864e5).toISOString();
    return fetch(SUPABASE_URL + '/rest/v1/staff_tasks?select=*&order=created_at.desc&or=' +
                 encodeURIComponent('(status.eq.open,done_at.gte."' + since + '")'), { headers: hdrs() })
      .then(function (r) { if (r.status === 404) return null; if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) { stasks = d; })
      .catch(function () { stasks = stasks || []; });
  }
  function loadStaff() {
    return Promise.all([
      fetch(SUPABASE_URL + '/rest/v1/booking_staff?select=*&order=role.asc,email.asc', { headers: hdrs() })
        .then(function (r) { if (r.status === 404) return null; if (!r.ok) throw new Error(); return r.json(); }),
      fetch(SUPABASE_URL + '/rest/v1/push_subscriptions?select=email,created_at', { headers: hdrs() })
        .then(function (r) { return r.ok ? r.json() : []; })
    ]).then(function (res) { staff = res[0]; subs = res[1] || []; })
      .catch(function () { staff = staff || []; });
  }

  // Ask the server to ping the devices of whoever the task is for.
  function notify(id) {
    return fetch('/.netlify/functions/notify-staff', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: id })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) return 'The notification could not be sent (' + (j.error || 'error ' + r.status) + '). It still shows on the staff screen.';
        if (j.sent > 0) return (j.sent === 1 ? 'One device was' : j.sent + ' devices were') + ' notified.';
        if (j.devices > 0) return 'No device accepted the notification. It still shows on the staff screen.';
        return 'No staff device has notifications on yet, so it shows on the staff screen without a ping.';
      });
    }).catch(function () { return 'The notification service could not be reached. It still shows on the staff screen.'; });
  }

  function isUrgentTask(t) { return t.priority === 'urgent'; }
  function taskOrder(a, b) {
    var ua = isUrgentTask(a) ? 0 : 1, ub = isUrgentTask(b) ? 0 : 1;
    if (ua !== ub) return ua - ub;
    var da = a.due_at ? Date.parse(a.due_at) : ua === 0 ? Date.parse(a.created_at) : Infinity;
    var db = b.due_at ? Date.parse(b.due_at) : ub === 0 ? Date.parse(b.created_at) : Infinity;
    if (da !== db) return da < db ? -1 : 1;
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  }

  function taskCard(t) {
    var open = t.status === 'open', tags = [];
    if (isUrgentTask(t)) tags.push('<span class="tk-tag urgent">Urgent</span>');
    if (t.due_at && open) {
      var ms = Date.parse(t.due_at) - Date.now();
      tags.push('<span class="tk-tag' + (ms < 0 ? ' late' : ms < 2 * 3600e3 ? ' soon' : '') + '">' +
        (ms < 0 ? 'Overdue · was due ' : 'Due ') + esc(beirut(t.due_at)) + '</span>');
    }
    tags.push('<span class="tk-tag muted">For ' + esc(t.assigned_to ? staffName(t.assigned_to) : 'all staff') + '</span>');
    var bl = t.booking_request && bookingLabel(t.booking_request);
    if (bl) tags.push('<span class="tk-tag">' + esc(bl) + '</span>');
    var html = '<h5>' + esc(t.title) + '</h5>' + (t.details ? '<p class="det">' + esc(t.details) + '</p>' : '') +
      '<div class="tk-meta">' + tags.join('') + '</div>';
    if (!open) {
      html += '<p class="tk-done-note"><b>Done</b> ' + esc(beirut(t.done_at)) + (t.done_by ? ' by ' + esc(staffName(t.done_by)) : '') +
        (t.done_note ? ': &ldquo;' + esc(t.done_note) + '&rdquo;' : '') + '</p>' +
        (t.proof_path ? '<div class="tk-proof" data-proof="' + esc(t.proof_path) + '" data-type="' + (t.proof_type === 'video' ? 'video' : 'image') + '">' +
          '<span class="bk-muted">Loading the ' + (t.proof_type === 'video' ? 'video' : 'photo') + '…</span></div>' : '');
    }
    var id = esc(t.id);
    var acts = open
      ? '<button data-tk="edit" data-id="' + id + '">Edit</button>' +
        '<button data-tk="ping" data-id="' + id + '">Notify again</button>' +
        '<button class="ok" data-tk="done" data-id="' + id + '">Mark done</button>' +
        '<button class="no" data-tk="del" data-id="' + id + '">Delete</button>'
      : '<button data-tk="reopen" data-id="' + id + '">Reopen</button>' +
        '<button class="no" data-tk="del" data-id="' + id + '">Delete</button>';
    return '<div class="adm-card tk-card' + (open && isUrgentTask(t) ? ' is-urgent' : '') + (open ? '' : ' is-done') + '" id="tk-' + id + '">' + html +
      '<p class="tk-by">Added ' + esc(beirut(t.created_at)) + (t.created_by ? ' by ' + esc(staffName(t.created_by)) : '') + '</p>' +
      '<div class="adm-acts">' + acts + '</div></div>';
  }

  function fillWho() {
    var sel = $('tkWho'), cur = sel.value;
    var people = (staff || []).filter(function (s) { return s.active; })
      .sort(function (a, b) { return a.role === b.role ? 0 : a.role === 'viewer' ? -1 : 1; });
    sel.innerHTML = '<option value="">All staff</option>' + people.map(function (s) {
      return '<option value="' + esc(s.email) + '">' + esc(s.name || s.email) + (s.role === 'admin' ? ' (admin)' : '') + '</option>';
    }).join('');
    sel.value = people.some(function (s) { return s.email === cur; }) ? cur : '';
  }
  function renderLink() {
    var box = $('tkLink');
    if (!tk.link) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<span>About <b>' + esc(bookingLabel(tk.link.request_id) || 'a booking') + '</b></span>' +
      '<button type="button" id="tkUnlink" aria-label="Not about this booking">&times;</button>';
    $('tkUnlink').addEventListener('click', function () { tk.link = null; renderLink(); });
  }
  function setPrio() {
    document.querySelectorAll('#tkPrio [data-p]').forEach(function (o) { o.setAttribute('aria-pressed', String(o.dataset.p === tk.prio)); });
  }
  function two(n) { return String(n).padStart(2, '0'); }
  function toLocalInput(isoStr) {
    var d = new Date(isoStr);
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + 'T' + two(d.getHours()) + ':' + two(d.getMinutes());
  }
  function resetTaskForm() {
    tk.edit = null; tk.prio = 'normal'; tk.link = null;
    ['tkTitle', 'tkDetails', 'tkDue'].forEach(function (i) { $(i).value = ''; });
    $('tkWho').value = ''; $('tkAgain').checked = false;
    $('tkFormTitle').textContent = 'New task for staff';
    $('tkGo').textContent = 'Send to staff';
    $('tkCancel').hidden = true; $('tkAgainRow').hidden = true;
    setPrio(); renderLink();
  }
  function startEdit(t) {
    resetTaskForm();
    tk.edit = t.id; tk.prio = t.priority; tk.link = t.booking_request ? { request_id: t.booking_request } : null;
    $('tkTitle').value = t.title; $('tkDetails').value = t.details || '';
    $('tkWho').value = t.assigned_to || '';
    $('tkDue').value = t.due_at ? toLocalInput(t.due_at) : '';
    $('tkFormTitle').textContent = 'Edit task';
    $('tkGo').textContent = 'Save changes';
    $('tkCancel').hidden = false; $('tkAgainRow').hidden = false;
    setPrio(); renderLink();
    $('tkForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('tkTitle').focus();
  }

  function renderTasks() {
    var ready = stasks !== null && staff !== null;
    $('tkSetup').hidden = ready;
    $('tkGo').disabled = !ready;
    if (!ready) {
      $('tkSetup').innerHTML = '<div class="bk-msg bk-msg--warn">Tasks need a one-time setup: run <b>mic_staff_SETUP.sql</b> in the Supabase SQL editor, then reload this page.</div>';
      $('tkOpen').innerHTML = ''; $('tkDone').innerHTML = '';
      return;
    }
    fillWho(); renderLink(); setPrio();
    var open = stasks.filter(function (t) { return t.status === 'open'; }).sort(taskOrder);
    var done = stasks.filter(function (t) { return t.status === 'done'; })
      .sort(function (a, b) { return Date.parse(b.done_at) - Date.parse(a.done_at); });
    $('tkOpenN').textContent = open.length ? '(' + open.length + ')' : '';
    $('tkOpen').innerHTML = open.length ? open.map(taskCard).join('')
      : '<p class="bk-muted" style="padding:4px 0 16px;">Nothing open. New tasks show here and on the staff screen.</p>';
    $('tkDone').innerHTML = done.length ? done.map(taskCard).join('') : '<p class="bk-muted">Nothing done in the last 30 days.</p>';
    document.querySelectorAll('#admTasks [data-tk]').forEach(function (b) {
      b.addEventListener('click', function () { taskAct(b.dataset.tk, b.dataset.id, b); });
    });
    loadProofs();
  }

  function loadProofs() {
    document.querySelectorAll('#tkDone .tk-proof[data-proof]').forEach(function (box) {
      var path = box.getAttribute('data-proof'), type = box.getAttribute('data-type');
      var show = function (url) {
        box.innerHTML = (type === 'video'
          ? '<video src="' + esc(url) + '" controls preload="metadata" playsinline></video>'
          : '<a href="' + esc(url) + '" target="_blank" rel="noopener"><img src="' + esc(url) + '" alt="Photo sent as proof" loading="lazy"/></a>') +
          '<a class="full" href="' + esc(url) + '" target="_blank" rel="noopener">Open full size</a>';
      };
      var c = proofUrl[path];
      if (c && c.exp > Date.now()) { show(c.url); return; }
      fetch(SUPABASE_URL + '/storage/v1/object/sign/task-proof/' + path.split('/').map(encodeURIComponent).join('/'), {
        method: 'POST', headers: hdrs(), body: JSON.stringify({ expiresIn: 3600 })
      }).then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
        .then(function (j) {
          var url = SUPABASE_URL + '/storage/v1' + (j.signedURL || j.signedUrl);
          proofUrl[path] = { url: url, exp: Date.now() + 55 * 60000 };
          show(url);
        })
        .catch(function () { box.innerHTML = '<span class="bk-muted">The proof file could not be loaded.</span>'; });
    });
  }

  function taskAct(a, id, btn) {
    var t = (stasks || []).filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var reload = function (text) { return loadTasks().then(function () { render(); if (text) msg('ok', text); }); };
    if (a === 'edit') { startEdit(t); return; }
    if (a === 'ping') {
      btn.disabled = true; btn.textContent = 'Sending…';
      notify(id).then(function (m) { btn.disabled = false; btn.textContent = 'Notify again'; msg('ok', esc(m)); });
      return;
    }
    if (a === 'done') {
      fetch(SUPABASE_URL + '/rest/v1/rpc/complete_staff_task', {
        method: 'POST', headers: hdrs(), body: JSON.stringify({ p_task: id, p_note: null, p_proof_path: null, p_proof_type: null })
      }).then(function (r) {
        if (r.status === 401) { expired(); return; }
        if (!r.ok) throw new Error();
        return reload('Marked done.');
      }).catch(function () { msg('err', 'Could not mark that done. Try again.'); });
      return;
    }
    if (a === 'reopen') {
      fetch(SUPABASE_URL + '/rest/v1/staff_tasks?id=eq.' + id, {
        method: 'PATCH', headers: Object.assign(hdrs(), { Prefer: 'return=minimal' }),
        body: JSON.stringify({ status: 'open', done_at: null, done_by: null, done_note: null, proof_path: null, proof_type: null })
      }).then(function (r) {
        if (r.status === 401) { expired(); return; }
        if (!r.ok) throw new Error();
        return reload('Reopened. It is back on the staff screen.');
      }).catch(function () { msg('err', 'Could not reopen that. Try again.'); });
      return;
    }
    if (a === 'del') {
      if (!confirmTap(btn, 'Tap again to delete')) return;
      fetch(SUPABASE_URL + '/rest/v1/staff_tasks?id=eq.' + id, { method: 'DELETE', headers: hdrs() })
        .then(function (r) {
          if (r.status === 401) { expired(); return; }
          if (!r.ok) throw new Error();
          if (t.proof_path) {   // the photo or video goes too
            fetch(SUPABASE_URL + '/storage/v1/object/task-proof/' + t.proof_path.split('/').map(encodeURIComponent).join('/'),
                  { method: 'DELETE', headers: hdrs() }).catch(function () {});
          }
          if (tk.edit === id) resetTaskForm();
          return reload('Deleted.');
        }).catch(function () { msg('err', 'Could not delete that. Try again.'); });
    }
  }

  function taskSubmit() {
    var title = $('tkTitle').value.trim();
    if (!title) { msg('err', 'Write what needs doing.'); $('tkTitle').focus(); return; }
    var due = null;
    if ($('tkDue').value) {
      var d = new Date($('tkDue').value);
      if (isNaN(d.getTime())) { msg('err', 'That due time is not valid.'); return; }
      due = d.toISOString();
    }
    var body = {
      title: title, details: $('tkDetails').value.trim() || null, priority: tk.prio, due_at: due,
      assigned_to: $('tkWho').value || null, booking_request: tk.link ? tk.link.request_id : null
    };
    var editing = tk.edit, again = $('tkAgain').checked, btn = $('tkGo');
    btn.disabled = true; btn.textContent = editing ? 'Saving…' : 'Sending…';
    fetch(SUPABASE_URL + '/rest/v1/staff_tasks' + (editing ? '?id=eq.' + editing : ''), {
      method: editing ? 'PATCH' : 'POST',
      headers: Object.assign(hdrs(), { Prefer: 'return=representation' }), body: JSON.stringify(body)
    }).then(function (r) {
      if (r.status === 401) { expired(); throw 'handled'; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (back) {
      var t = back && back[0];
      if (!t) throw new Error('nothing saved');
      return ((!editing || again) ? notify(t.id) : Promise.resolve('')).then(function (m) {
        btn.disabled = false;
        resetTaskForm();
        return loadTasks().then(function () {
          render();
          msg('ok', (editing ? 'Saved.' : 'Task sent.') + (m ? ' ' + esc(m) : ''));
        });
      });
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = editing ? 'Save changes' : 'Send to staff';
      if (e !== 'handled') msg('err', 'Could not save the task. Try again.');
    });
  }

  /* ------------------------------------------------------------ staff -- */
  function renderStaff() {
    var box = $('stfList');
    $('stfGo').disabled = staff === null;
    if (staff === null) {
      box.innerHTML = '<div class="bk-msg bk-msg--warn">The staff list needs a one-time setup: run <b>mic_staff_SETUP.sql</b> in the Supabase SQL editor, then reload this page.</div>';
      return;
    }
    var me = myEmail(), devs = {};
    subs.forEach(function (x) { devs[x.email] = (devs[x.email] || 0) + 1; });
    box.innerHTML = staff.map(function (s) {
      var self = s.email === me, n = devs[s.email] || 0, e = esc(s.email);
      var acts = self
        ? '<span class="bk-muted" style="font-size:12.5px;">This is you</span>'
        : '<button data-sf="role" data-email="' + e + '">' + (s.role === 'admin' ? 'Make staff' : 'Make admin') + '</button>' +
          '<button data-sf="active" data-email="' + e + '">' + (s.active ? 'Switch off' : 'Switch on') + '</button>' +
          '<button class="no" data-sf="del" data-email="' + e + '">Remove</button>';
      return '<div class="adm-card stf-row' + (s.active ? '' : ' is-off') + '">' +
        '<div class="who"><b>' + esc(s.name || s.email.split('@')[0]) + '</b><small>' + e + '</small></div>' +
        '<span class="adm-pill ' + (s.active ? (s.role === 'admin' ? 'admin' : 'viewer') : 'off') + '">' +
          (!s.active ? 'Switched off' : s.role === 'admin' ? 'Admin' : 'Staff') + '</span>' +
        '<span class="stf-dev">' + (n ? 'Notifications on ' + n + ' device' + (n > 1 ? 's' : '') : s.role === 'viewer' ? 'No device with notifications yet' : '') + '</span>' +
        '<div class="adm-acts">' + acts + '</div></div>';
    }).join('') || '<p class="bk-muted">No one yet.</p>';
    box.querySelectorAll('[data-sf]').forEach(function (b) {
      b.addEventListener('click', function () { staffAct(b.dataset.sf, b.dataset.email, b); });
    });
  }

  function staffAct(a, email, btn) {
    var s = (staff || []).filter(function (x) { return x.email === email; })[0];
    if (!s) return;
    var url = SUPABASE_URL + '/rest/v1/booking_staff?email=eq.' + encodeURIComponent(email);
    var done = function (text) { return loadStaff().then(function () { render(); msg('ok', text); }); };
    var fail = function (r) {
      return errText(r).then(function (t) { msg('err', t ? esc(t) : 'That did not go through. Try again.'); });
    };
    if (a === 'del') {
      if (!confirmTap(btn, 'Tap again to remove')) return;
      fetch(url, { method: 'DELETE', headers: Object.assign(hdrs(), { Prefer: 'return=representation' }) })
        .then(function (r) {
          if (r.status === 401) { expired(); return; }
          if (!r.ok) return fail(r);
          return done(esc(s.name || s.email) + ' no longer has access.');
        }).catch(function () { msg('err', 'That did not go through. Try again.'); });
      return;
    }
    var body = a === 'role' ? { role: s.role === 'admin' ? 'viewer' : 'admin' } : { active: !s.active };
    fetch(url, { method: 'PATCH', headers: Object.assign(hdrs(), { Prefer: 'return=representation' }), body: JSON.stringify(body) })
      .then(function (r) {
        if (r.status === 401) { expired(); return; }
        if (!r.ok) return fail(r);
        var who = esc(s.name || s.email);
        return done(a === 'role'
          ? who + (body.role === 'admin' ? ' is now an admin.' : ' is now staff, with the tablet screen only.')
          : who + (body.active ? ' can sign in again.' : ' is switched off and can no longer sign in to anything here.'));
      }).catch(function () { msg('err', 'That did not go through. Try again.'); });
  }

  function staffAdd() {
    var email = $('stfEmail').value.trim().toLowerCase(), name = $('stfName').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg('err', 'Enter their email address.'); $('stfEmail').focus(); return; }
    var btn = $('stfGo'); btn.disabled = true;
    fetch(SUPABASE_URL + '/rest/v1/booking_staff', {
      method: 'POST', headers: Object.assign(hdrs(), { Prefer: 'return=minimal' }),
      body: JSON.stringify([{ email: email, name: name || null, role: stf.role, active: true }])
    }).then(function (r) {
      btn.disabled = false;
      if (r.status === 401) { expired(); return; }
      if (r.status === 409) { msg('err', 'That email is already on the list.'); return; }
      if (!r.ok) throw new Error();
      $('stfEmail').value = ''; $('stfName').value = '';
      return loadStaff().then(function () {
        render();
        msg('ok', esc(name || email) + ' added. ' + (stf.role === 'admin'
          ? 'They can sign in to this console.'
          : 'They can sign in at <a href="/staff">mic-lb.com/staff</a> with the email and password you set in Supabase.'));
      });
    }).catch(function () { btn.disabled = false; msg('err', 'Could not add that person. Try again.'); });
  }

  /* ------------------------------------------------------------ wire -- */
  function setView(v) {
    view = v;
    document.querySelectorAll('.adm-tab[data-view]').forEach(function (t) {
      t.setAttribute('aria-pressed', String(t.dataset.view === v));
    });
    render();
  }

  function init() {
    if (!$('admForm')) return;
    $('admForm').addEventListener('submit', signIn);
    $('admOut').addEventListener('click', signOut);

    document.querySelectorAll('.adm-tab[data-view]').forEach(function (t) {
      t.addEventListener('click', function () { setView(t.dataset.view); });
    });
    $('admPrev').addEventListener('click', function () {
      cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth() - 1, 1); renderCal();
    });
    $('admNext').addEventListener('click', function () {
      cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth() + 1, 1); renderCal();
    });
    $('admToday').addEventListener('click', function () {
      var n = new Date(); cal.month = new Date(n.getFullYear(), n.getMonth(), 1); cal.day = iso(n); renderCal();
    });
    document.querySelectorAll('[data-rf]').forEach(function (b) {
      b.addEventListener('click', function () {
        cal.room = b.dataset.rf;
        document.querySelectorAll('[data-rf]').forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
        renderCal();
      });
    });

    document.querySelectorAll('#addKind [data-kind]').forEach(function (b) {
      b.addEventListener('click', function () {
        add.kind = b.dataset.kind;
        document.querySelectorAll('#addKind [data-kind]').forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
        renderAdd();
      });
    });
    document.querySelectorAll('#addSetup [data-s]').forEach(function (b) {
      b.addEventListener('click', function () {
        add.setup = b.dataset.s;
        document.querySelectorAll('#addSetup [data-s]').forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
        renderAdd();
      });
    });
    ['addRoom','addDate','addHeads','addCat'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        if (id === 'addRoom' || id === 'addDate') add.slots = [];
        if (id === 'addRoom') {   // setup belongs to the workshop room only
          add.setup = null;
          document.querySelectorAll('#addSetup [data-s]').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
        }
        renderAdd();
      });
      $(id).addEventListener('input',  function () { renderAdd(); });
    });
    $('addGo').addEventListener('click', addGo);
    $('newGo').addEventListener('click', menuAdd);

    $('tkGo').addEventListener('click', taskSubmit);
    $('tkCancel').addEventListener('click', resetTaskForm);
    document.querySelectorAll('#tkPrio [data-p]').forEach(function (b) {
      b.addEventListener('click', function () { tk.prio = b.dataset.p; setPrio(); });
    });
    $('stfGo').addEventListener('click', staffAdd);
    document.querySelectorAll('#stfRole [data-r]').forEach(function (b) {
      b.addEventListener('click', function () {
        stf.role = b.dataset.r;
        document.querySelectorAll('#stfRole [data-r]').forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
      });
    });
    // Staff finish tasks on the tablet; keep this list current while it is on screen.
    setInterval(function () {
      if (!token || view !== 'tasks' || document.visibilityState !== 'visible') return;
      loadTasks().then(function () { if (view === 'tasks') render(); });
    }, 30000);
    $('addDate').value = iso(new Date());

    try { var saved = sessionStorage.getItem(LS); if (saved) { token = saved; open_(); } } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
