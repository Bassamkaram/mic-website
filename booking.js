/* ============================================================
   MIC — room booking
   Talks to the same Supabase project as the rest of the platform.
   The anon key below is public by design: the database refuses, via
   row level security, to let it read anyone's details or to confirm
   a booking. Confirming is staff-only, in booking-admin.html.
   Schema: mic_booking_2026-11-02.sql
   ============================================================ */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://xnegzvpuagxgahlbtzaf.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhuZWd6dnB1YWd4Z2FobGJ0emFmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzODk0NDIsImV4cCI6MjA5Mzk2NTQ0Mn0.RXBD_LxrZiv0tQfX7W6S9wT8JKNMPd5xB3LBlV50lAE';

  /* ---- the only numbers to change if pricing moves ---- */
  var RATE_MEETING_HOUR = 20;    // $ per hour
  var RATE_WORKSHOP_HALF = 100;  // $ per half-day, so a full day is 200
  var CAP = { meeting: 15, workshop: { ushape: 30, classroom: 40 } };
  var HALF = {
    am: { label: 'Morning',   time: '08:00 – 14:00' },
    pm: { label: 'Afternoon', time: '14:00 – 20:00' }
  };

  var $ = function (id) { return document.getElementById(id); };
  var api = SUPABASE_URL + '/rest/v1/';
  var headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    'Content-Type': 'application/json'
  };

  var state = {
    room: null,
    month: startOfMonth(new Date()),
    date: null,          // 'YYYY-MM-DD'
    slots: [],           // selected slot keys
    waitlist: false,     // true when the selection is on taken slots
    setup: null,
    taken: {},           // 'YYYY-MM-DD' -> { slotKey: true }
    cat: 'none',         // 'none' | 'pkg:<id>' | 'custom' | 'special' — one or the other, never both
    items: {},           // build-your-own items, only counted while cat is 'custom'
    extras: {},          // equipment and setup, independent of the catering choice
    special: '',         // special-order text, only counted while cat is 'special'
    fac: {},             // Event Space: chosen facility codes -> true
    avail: {}            // 'YYYY-MM-DD' -> [{ room, slot }] as the public calendar shows them
  };
  // Event Space facilities, as rooms booked by the hour (see mic_events_SETUP.sql).
  // Names, descriptions and prices come from the catalogue the admins edit.
  var EVENT_UNITS = ['ev_cowork', 'ev_workshop', 'ev_play_full', 'ev_play_part', 'ev_kitchen', 'ev_coffee'];

  var MENU = [];         // catering packages, items and extras, from the database

  /* ---------------------------------------------------------- helpers -- */
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }
  function todayISO() { return iso(new Date()); }
  function prettyDate(s) {
    return new Date(s + 'T00:00:00').toLocaleDateString('en-GB',
      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function slotLabel(k) {
    if (state.room === 'workshop') return HALF[k].label + ' (' + HALF[k].time + ')';
    return k + ':00 – ' + String((+k + 1) % 24).padStart(2, '0') + ':00';
  }
  function allSlots() {
    if (state.room === 'workshop') return ['am', 'pm'];
    var out = []; for (var h = 0; h < 24; h++) out.push(String(h).padStart(2, '0'));
    return out;
  }
  function two(n) { return String(n).padStart(2, '0'); }
  function isEvent() { return state.room === 'event'; }
  function facilities() {   // the facility lines the admins have switched on, in their order
    return MENU.filter(function (m) { return m.kind === 'facility' && m.code && EVENT_UNITS.indexOf(m.code) !== -1; });
  }
  function facByCode(code) { return facilities().filter(function (m) { return m.code === code; })[0] || null; }
  function chosenFac() { return EVENT_UNITS.filter(function (c) { return state.fac[c]; }); }
  function facName(code) {
    var m = facByCode(code);
    return m ? m.name : code;
  }
  /* ['18','19','21'] -> [[18,20],[21,22]] */
  function hourRanges(slots) {
    var out = [];
    slots.map(Number).sort(function (a, b) { return a - b; }).forEach(function (h) {
      var last = out[out.length - 1];
      if (last && last[1] === h) last[1] = h + 1; else out.push([h, h + 1]);
    });
    return out;
  }
  function rangesText(slots) {
    return hourRanges(slots).map(function (r) { return two(r[0]) + ':00 – ' + two(r[1] % 24) + ':00'; }).join(', ');
  }
  function msg(kind, text) {
    $('bkMsg').innerHTML = text
      ? '<div class="bk-msg bk-msg--' + kind + '">' + text + '</div>' : '';
  }

  /* ------------------------------------------------- availability load -- */
  // The workshop room is shared: half-day workshops and events by the hour
  // block each other, so each needs to see the other's bookings.
  function roomsToLoad() {
    if (isEvent()) return EVENT_UNITS.concat(['workshop']);
    if (state.room === 'workshop') return ['workshop', 'ev_workshop'];
    return [state.room];
  }
  var loadSeq = 0;   // only the newest month's answer may be drawn, however the replies arrive
  function loadMonth() {
    if (!state.room) return Promise.resolve();
    var seq = ++loadSeq;
    var from = iso(state.month);
    var last = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 0);
    var to = iso(last);
    var url = api + 'room_availability?room=in.(' + roomsToLoad().join(',') + ')' +
              '&booking_date=gte.' + from + '&booking_date=lte.' + to +
              '&select=room,booking_date,slot';
    return fetch(url, { headers: headers })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (rows) {
        if (seq !== loadSeq) return;
        state.avail = {};
        rows.forEach(function (row) { (state.avail[row.booking_date] = state.avail[row.booking_date] || []).push(row); });
        computeTaken();
        msg('', '');
      })
      .catch(function () {
        if (seq !== loadSeq) return;
        state.avail = {}; state.taken = {};
        msg('warn', 'We could not load live availability just now, so every slot is shown as ' +
            'free. Send your request anyway and we will tell you if the time is already taken.');
      });
  }

  /* Which slots are taken for what is being asked for. The database applies
     exactly the same rules when a booking is confirmed. */
  function count(rows, room, slot) {
    var n = 0; rows.forEach(function (r) { if (r.room === room && r.slot === slot) n++; }); return n;
  }
  function facTaken(code, rows, hh) {
    var h = +hh;
    if (code === 'ev_play_part') return count(rows, 'ev_play_full', hh) > 0 || count(rows, 'ev_play_part', hh) >= 2;
    if (code === 'ev_play_full') return count(rows, 'ev_play_full', hh) > 0 || count(rows, 'ev_play_part', hh) > 0;
    if (code === 'ev_workshop') {
      return count(rows, 'ev_workshop', hh) > 0 ||
        (h >= 8 && h < 14 && count(rows, 'workshop', 'am') > 0) ||
        (h >= 14 && h < 20 && count(rows, 'workshop', 'pm') > 0);
    }
    return count(rows, code, hh) > 0;
  }
  function computeTaken() {
    state.taken = {};
    var codes = chosenFac();
    Object.keys(state.avail).forEach(function (d) {
      var rows = state.avail[d], t = {};
      if (isEvent()) {
        for (var h = 0; h < 24; h++) {
          var hh = two(h);
          if (codes.some(function (c) { return facTaken(c, rows, hh); })) t[hh] = true;
        }
      } else if (state.room === 'workshop') {
        rows.forEach(function (r) {
          if (r.room === 'workshop') t[r.slot] = true;
          else if (r.room === 'ev_workshop') {
            var x = +r.slot;
            if (x >= 8 && x < 14) t.am = true; else if (x >= 14 && x < 20) t.pm = true;
          }
        });
      } else {
        rows.forEach(function (r) { if (r.room === state.room) t[r.slot] = true; });
      }
      state.taken[d] = t;
    });
  }

  /* --------------------------------------------------------- calendar -- */
  function renderCalendar() {
    var dowWrap = $('bkDow');
    if (!dowWrap.childNodes.length) {
      ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(function (d) {
        var c = document.createElement('div'); c.className = 'bk-dow'; c.textContent = d;
        dowWrap.appendChild(c);
      });
    }
    var y = state.month.getFullYear(), m = state.month.getMonth();
    $('bkMonth').textContent = state.month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    var thisMonth = startOfMonth(new Date());
    $('bkPrev').disabled = state.month <= thisMonth;

    var first = new Date(y, m, 1);
    var lead = (first.getDay() + 6) % 7;             // Monday-first
    var days = new Date(y, m + 1, 0).getDate();
    var total = allSlots().length;
    var today = todayISO();
    var grid = $('bkDays');
    grid.innerHTML = '';

    for (var i = 0; i < lead; i++) {
      var pad = document.createElement('div'); pad.className = 'bk-day is-empty'; grid.appendChild(pad);
    }
    for (var d = 1; d <= days; d++) {
      var key = iso(new Date(y, m, d));
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'bk-day'; b.textContent = d;
      b.setAttribute('aria-pressed', String(state.date === key));
      b.dataset.date = key;
      if (key < today) { b.disabled = true; }
      else {
        var n = Object.keys(state.taken[key] || {}).length;
        if (n >= total) b.className += ' is-full';
        else if (n > 0) b.className += ' is-part';
        b.addEventListener('click', onPickDate);
      }
      grid.appendChild(b);
    }
  }

  function onPickDate(e) {
    state.date = e.currentTarget.dataset.date;
    state.slots = []; state.waitlist = false;
    renderCalendar(); renderSlots(); renderSummary();
    $('bkStepSlots').hidden = false;
    $('bkStepSlots').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ------------------------------------------------------------ slots -- */
  function renderSlots() {
    var wrap = $('bkSlots');
    wrap.className = 'bk-slots' + (state.room === 'workshop' ? ' bk-slots--half' : '');
    wrap.innerHTML = '';
    var taken = state.taken[state.date] || {};

    $('bkSlotHint').textContent = state.room === 'workshop'
      ? prettyDate(state.date) + ' — pick one half-day, or both for a full day at $200.'
      : isEvent()
        ? prettyDate(state.date) + ' — pick the hours of your event, setting up included. The spaces are available around the clock.'
        : prettyDate(state.date) + ' — pick one or more hours. The room is available around the clock.';

    allSlots().forEach(function (k) {
      var isTaken = !!taken[k];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'bk-slot' + (isTaken ? ' is-taken' : '');
      b.dataset.slot = k;
      b.setAttribute('aria-pressed', String(state.slots.indexOf(k) !== -1));
      if (state.room === 'workshop') {
        b.innerHTML = HALF[k].label + '<span class="sub">' + HALF[k].time +
                      (isTaken ? ' · taken' : '') + '</span>';
      } else {
        b.innerHTML = k + ':00<span class="sub">' + (isTaken ? 'taken' : 'free') + '</span>';
      }
      b.title = isTaken ? 'Already booked — select it to join the waitlist' : slotLabel(k);
      b.addEventListener('click', function () { toggleSlot(k, isTaken); });
      wrap.appendChild(b);
    });
  }

  function toggleSlot(k, isTaken) {
    var taken = state.taken[state.date] || {};
    var selectingTaken = !!isTaken;
    // A request is either for free slots or a waitlist on taken ones, never both.
    if (state.slots.length && selectingTaken !== state.waitlist) { state.slots = []; }
    state.waitlist = selectingTaken;

    var at = state.slots.indexOf(k);
    if (at === -1) state.slots.push(k); else state.slots.splice(at, 1);
    if (!state.slots.length) state.waitlist = false;
    state.slots.sort();

    renderSlots(); renderSummary();
    $('bkStepForm').hidden = state.slots.length === 0;
    $('bkSummary').hidden  = state.slots.length === 0;
    if (state.slots.length) {
      msg(state.waitlist ? 'warn' : '',
          state.waitlist
            ? 'Those hours are already booked. Send this as a waitlist request and we will contact ' +
              'you first if the booking is cancelled.'
            : '');
    } else { msg('', ''); }
  }

  /* ---------------------------------------------------------- summary -- */
  /* Event Space: one line per facility, priced per hour, or null when quoted */
  function facilityCosts() {
    return chosenFac().map(function (c) {
      var m = facByCode(c);
      var cost = (m && m.price != null)
        ? (m.unit === 'flat' ? Number(m.price) : Number(m.price) * state.slots.length)
        : null;
      return { code: c, name: facName(c), cost: cost };
    });
  }
  function priceRooms() {
    if (!state.slots.length) return 0;
    if (isEvent()) return facilityCosts().reduce(function (s, f) { return s + (f.cost || 0); }, 0);
    return state.room === 'workshop'
      ? state.slots.length * RATE_WORKSHOP_HALF
      : state.slots.length * RATE_MEETING_HOUR;
  }
  function headcount() { return parseInt($('bkHeads') && $('bkHeads').value, 10) || 0; }

  function renderSummary() {
    if (!state.slots.length) { $('bkSummary').hidden = true; return; }
    var rows = [];
    rows.push(['Room', state.room === 'meeting' ? 'Meeting Room' : state.room === 'workshop' ? 'Workshop Room' : 'Event Space']);
    if (isEvent()) rows.push(['Spaces', chosenFac().map(function (c) { return escHtml(facName(c)); }).join('<br/>')]);
    rows.push(['Date', prettyDate(state.date)]);
    if (isEvent()) {
      rows.push(['Time', rangesText(state.slots)]);
      rows.push(['Hours', String(state.slots.length)]);
    } else if (state.room === 'workshop') {
      rows.push(['Time', state.slots.length === 2 ? 'Full day (08:00 – 20:00)'
                                                  : slotLabel(state.slots[0])]);
    } else {
      rows.push(['Time', state.slots.map(function (s) { return s + ':00'; }).join(', ')]);
      rows.push(['Hours', String(state.slots.length)]);
    }
    if (state.setup) rows.push(['Setup', state.setup === 'ushape' ? 'U-shape' : 'Classroom']);

    var roomCost = priceRooms();
    var extras   = chosen();
    var extraSum = addonsTotal();

    var html = rows.map(function (r) {
      return '<div class="bk-line"><span>' + r[0] + '</span><span>' + r[1] + '</span></div>';
    }).join('');

    if (state.waitlist) {
      html += '<div class="bk-line is-muted"><span>Waitlist request</span><span>no charge</span></div>';
    } else {
      if (isEvent()) {
        facilityCosts().forEach(function (f) {
          html += f.cost === null
            ? '<div class="bk-line is-muted"><span>' + escHtml(f.name) + '</span><span>on request</span></div>'
            : '<div class="bk-line"><span>' + escHtml(f.name) + '</span><span>' + money(f.cost) + '</span></div>';
        });
      } else {
        html += '<div class="bk-line"><span>Room</span><span>' + money(roomCost) + '</span></div>';
      }
      extras.forEach(function (m) {
        var c = lineCost(m);
        if (c === null) {
          html += '<div class="bk-line is-muted"><span>' + escHtml(m.name) + '</span><span>on request</span></div>';
        } else if (c > 0) {
          html += '<div class="bk-line"><span>' + escHtml(m.name) +
                  (m.unit === 'per_person' ? ' &times; ' + headcount() : '') +
                  '</span><span>' + money(c) + '</span></div>';
        } else {
          html += '<div class="bk-line is-muted"><span>' + escHtml(m.name) + '</span><span>included</span></div>';
        }
      });
      if (specialText()) {
        html += '<div class="bk-line is-muted"><span>Special order</span><span>on request</span></div>';
      }
    }
    $('bkSumBody').innerHTML = html;
    $('bkTotal').textContent = state.waitlist ? '\u2014' : money(roomCost + extraSum);
    $('bkTotalNote').textContent = state.waitlist
      ? 'Joining the waitlist costs nothing and commits you to nothing. We contact waitlist requests in the order they arrive.'
      : (anyOnRequest()
          ? 'An estimate. Anything marked on request is quoted separately once we know what you need.'
          : 'An estimate, not an invoice. We confirm availability and the final figure within one working day, and nothing is charged before you agree it.');
  }

  /* -------------------------------------------------------- capacity -- */
  function capacityLimit() {
    if (isEvent()) return 1000;
    if (state.room === 'meeting') return CAP.meeting;
    if (state.setup) return CAP.workshop[state.setup];
    return CAP.workshop.classroom;
  }
  function refreshCapHint() {
    var el = $('bkCapHint'); if (!el) return;
    var lim = capacityLimit(), n = headcount();
    if (isEvent()) {
      el.textContent = 'Roughly is fine. We plan the spaces around it.';
      el.className = 'hint';
    } else if (state.room === 'workshop' && !state.setup) {
      el.textContent = 'Pick a setup above — 30 in U-shape, 40 classroom.';
      el.className = 'hint';
    } else if (n > lim) {
      el.textContent = 'This room holds ' + lim + ' people in that setup.';
      el.className = 'hint bad';
    } else {
      el.textContent = 'Maximum ' + lim + ' people.';
      el.className = 'hint';
    }
    $('bkHeads').max = String(lim);
  }
  function refreshCatHint() {
    var el = $('bkCatHint'); if (!el) return;
    var n = chosen().length;
    el.textContent = n ? n + (n === 1 ? ' extra chosen' : ' extras chosen') : '';
  }

  /* ------------------------------------------- catering and extras -- */
  function loadMenu() {
    return fetch(api + 'booking_addons?select=*&order=kind.asc,sort.asc', { headers: headers })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) { MENU = d; })
      .catch(function () { MENU = []; });
  }
  function byKind(k) { return MENU.filter(function (m) { return m.kind === k; }); }
  function addonById(id) {
    for (var i = 0; i < MENU.length; i++) if (MENU[i].id === id) return MENU[i];
    return null;
  }
  function money(n) {
    n = Number(n);
    return '$' + (n % 1 === 0 ? n.toFixed(0) : n.toFixed(2));
  }
  /* what one chosen line costs for this booking; null means quoted separately */
  function lineCost(m) {
    if (m.price == null) return null;
    var p = Number(m.price);
    if (m.unit === 'per_person') return p * headcount();
    if (m.unit === 'per_hour')   return p * (state.room === 'workshop' ? state.slots.length * 6 : state.slots.length);
    return p;
  }
  function chosen() {
    var out = [], m;
    if (state.cat.indexOf('pkg:') === 0) { m = addonById(state.cat.slice(4)); if (m) out.push(m); }
    if (state.cat === 'custom') {
      Object.keys(state.items).forEach(function (id) { if (state.items[id]) { m = addonById(id); if (m) out.push(m); } });
    }
    Object.keys(state.extras).forEach(function (id) { if (state.extras[id]) { m = addonById(id); if (m) out.push(m); } });
    return out;
  }
  function addonsTotal() {
    return chosen().reduce(function (sum, m) { var c = lineCost(m); return sum + (c || 0); }, 0);
  }
  function specialText() { return state.cat === 'special' ? String(state.special || '').trim() : ''; }
  function anyOnRequest() {
    return chosen().some(function (m) { return m.price == null; }) || state.cat === 'special' ||
      (isEvent() && facilityCosts().some(function (f) { return f.cost === null; }));
  }

  /* the price shown on the right of each option */
  function amtHtml(m) {
    if (m.price == null) return '<span class="amt quote">On request</span>';
    var p = Number(m.price);
    if (p === 0) return '<span class="amt free">Included</span>';
    var unit = m.unit === 'per_person' ? 'per person' : m.unit === 'per_hour' ? 'per hour' : 'flat fee';
    return '<span class="amt"><b>' + money(p) + '</b><small>' + unit + '</small></span>';
  }
  function opt(type, name, value, checked, title, desc, right) {
    return '<label class="pick"><input type="' + type + '" name="' + name + '" value="' + escHtml(value) + '"' +
      (checked ? ' checked' : '') + '/>' +
      '<span class="lab">' + escHtml(title) + (desc ? '<small>' + escHtml(desc) + '</small>' : '') + '</span>' +
      (right || '') + '</label>';
  }

  function renderMenu() {
    var box = $('bkMenu');
    if (!box) return;
    if (!MENU.length) {
      box.innerHTML = '<p class="bk-muted" style="font-size:13px;">Tell us in the notes below if you need refreshments or equipment.</p>';
      return;
    }
    var packs = byKind('package'), items = byKind('item'), extras = byKind('extra');

    /* Refreshments: ONE radio group, so a package, your own selection and a
       special order can never be chosen together. */
    var html = '<div class="pick-group"><h5>Refreshments</h5><div class="pick-list">';
    html += opt('radio', 'bkcat', 'none', state.cat === 'none', 'No refreshments', '', '');
    packs.forEach(function (m) {
      html += opt('radio', 'bkcat', 'pkg:' + m.id, state.cat === 'pkg:' + m.id, m.name, m.description, amtHtml(m));
    });
    if (items.length) {
      html += opt('radio', 'bkcat', 'custom', state.cat === 'custom', 'Build your own', 'Pick individual items', '');
    }
    html += opt('radio', 'bkcat', 'special', state.cat === 'special', 'Special order',
                'Tell us what you need and we will quote it', '<span class="amt quote">On request</span>');
    html += '</div>';

    html += '<div class="pick-sub" id="bkCustomPanel"' + (state.cat === 'custom' ? '' : ' hidden') + '>' +
              '<div class="pick-list">' + items.map(function (m) {
                return opt('checkbox', 'bkitem', m.id, !!state.items[m.id], m.name, m.description, amtHtml(m));
              }).join('') + '</div></div>';

    html += '<div class="pick-sub" id="bkSpecialPanel"' + (state.cat === 'special' ? '' : ' hidden') + '>' +
              '<input id="bkSpecial" type="text" maxlength="300" ' +
              'placeholder="e.g. a Lebanese breakfast for 20, four of them vegetarian" value="' + escHtml(state.special) + '"/>' +
              '<div class="hint">We will price this and send it with your confirmation.</div></div>';
    html += '</div>';

    if (extras.length) {
      html += '<div class="pick-group"><h5>Equipment and setup</h5><div class="pick-list">' +
        extras.map(function (m) {
          return opt('checkbox', 'bkextra', m.id, !!state.extras[m.id], m.name, m.description, amtHtml(m));
        }).join('') + '</div></div>';
    }
    box.innerHTML = html;

    box.querySelectorAll('input[name="bkcat"]').forEach(function (i) {
      i.addEventListener('change', function () {
        state.cat = i.value;
        if (state.cat !== 'custom') {            // leaving "build your own" clears it
          state.items = {};
          box.querySelectorAll('input[name="bkitem"]').forEach(function (c) { c.checked = false; });
        }
        $('bkCustomPanel').hidden  = state.cat !== 'custom';
        $('bkSpecialPanel').hidden = state.cat !== 'special';
        if (state.cat === 'special') $('bkSpecial').focus();
        renderSummary();
      });
    });
    box.querySelectorAll('input[name="bkitem"]').forEach(function (i) {
      i.addEventListener('change', function () { state.items[i.value] = i.checked; renderSummary(); });
    });
    box.querySelectorAll('input[name="bkextra"]').forEach(function (i) {
      i.addEventListener('change', function () { state.extras[i.value] = i.checked; renderSummary(); });
    });
    var sp = $('bkSpecial');
    if (sp) sp.addEventListener('input', function () { state.special = sp.value; renderSummary(); });
  }
  function escHtml(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------------------------------------- Event Space spaces -- */
  function renderFacilities() {
    var box = $('bkFac'), list = facilities();
    var play = { full: facByCode('ev_play_full'), part: facByCode('ev_play_part') };
    var playOn = !!(state.fac.ev_play_full || state.fac.ev_play_part);
    // The playground's two lines become one choice, "all of it" or "part of it",
    // shown where the playground sits in the catalogue's order.
    var html = '', playDone = false;
    list.forEach(function (m) {
      if (m.code !== 'ev_play_full' && m.code !== 'ev_play_part') {
        html += opt('checkbox', 'bkfac', m.code, !!state.fac[m.code], m.name, m.description, amtHtml(m));
        return;
      }
      if (playDone) return;
      playDone = true;
      html += opt('checkbox', 'bkfac', 'play', playOn, 'Outdoor playground', 'All of it, or a part shared with one other event', '');
      html += '<div class="pick-sub" id="bkPlaySub"' + (playOn ? '' : ' hidden') + '><div class="pick-list">' +
        (play.full ? opt('radio', 'bkplay', 'ev_play_full', !!state.fac.ev_play_full, 'All of it', play.full.description, amtHtml(play.full)) : '') +
        (play.part ? opt('radio', 'bkplay', 'ev_play_part', !!state.fac.ev_play_part, 'Part of it', play.part.description || 'Shared with at most one other event.', amtHtml(play.part)) : '') +
        '</div></div>';
    });
    box.innerHTML = html;
    box.querySelectorAll('input[name="bkfac"]').forEach(function (i) {
      i.addEventListener('change', function () {
        if (i.value === 'play') {
          delete state.fac.ev_play_full; delete state.fac.ev_play_part;
          if (i.checked) state.fac[play.part ? 'ev_play_part' : 'ev_play_full'] = true;   // part is the gentler default
          renderFacilities();
        } else {
          if (i.checked) state.fac[i.value] = true; else delete state.fac[i.value];
        }
        facilitiesChanged();
      });
    });
    box.querySelectorAll('input[name="bkplay"]').forEach(function (i) {
      i.addEventListener('change', function () {
        delete state.fac.ev_play_full; delete state.fac.ev_play_part;
        state.fac[i.value] = true;
        facilitiesChanged();
      });
    });
  }
  // A different set of spaces means different free hours.
  function facilitiesChanged() {
    computeTaken();
    var any = chosenFac().length > 0;
    $('bkStepDate').hidden = !any;
    if (!any) {
      state.date = null; state.slots = []; state.waitlist = false;
      $('bkStepSlots').hidden = true; $('bkStepForm').hidden = true; $('bkSummary').hidden = true;
      msg('', '');
      return;
    }
    if (state.slots.length) {
      var taken = state.taken[state.date] || {};
      var n = state.slots.filter(function (k) { return taken[k]; }).length;
      if (n === 0) state.waitlist = false;
      else if (n === state.slots.length) state.waitlist = true;
      else {
        state.slots = []; state.waitlist = false;
        $('bkStepForm').hidden = true; $('bkSummary').hidden = true;
        msg('warn', 'Some of the hours you picked are not free for those spaces. Pick your time again.');
      }
    }
    renderCalendar();
    if (state.date) renderSlots();
    renderSummary();
  }

  /* ------------------------------------------------- email the team -- */
  /* Netlify Forms already powers every other form on the site, so a booking
     that has safely reached the database is copied here purely so Netlify
     can email it out. Deliberately fire-and-forget: the booking is already
     saved, and a failure to send the notification must never be shown to the
     person or undo anything. */
  function notifyTeam(name, email, phone) {
    try {
      var people = headcount();
      var time = state.room === 'workshop'
        ? (state.slots.length === 2 ? 'Full day (08:00-20:00)' : slotLabel(state.slots[0]))
        : isEvent()
          ? rangesText(state.slots) + '  (' + state.slots.length + 'h)'
          : state.slots.map(function (s) { return s + ':00'; }).join(', ') + '  (' + state.slots.length + 'h)';
      // (named "estimate", not "money": a local "money" would hide the money()
      //  function below and silently stop this email for every normal booking)
      var estimate = state.waitlist ? 'waitlist, no charge'
        : money(priceRooms() + addonsTotal()) + (anyOnRequest() ? ' plus items to quote' : '');
      var picked = chosen().map(function (m) {
        var c = lineCost(m);
        return m.name + (c === null ? ' (on request)' : c > 0 ? ' ' + money(c) : ' (included)');
      });
      if (specialText()) picked.push('SPECIAL ORDER: ' + specialText());
      var body = {
        'form-name': 'room-booking',
        room:     state.room === 'meeting' ? 'Meeting Room' : state.room === 'workshop' ? 'Workshop Room'
                  : 'Event Space: ' + chosenFac().map(facName).join(', '),
        event:    isEvent() ? ($('bkEvent').value.trim() || '-') : '-',
        date:     prettyDate(state.date),
        time:     time,
        request:  state.waitlist ? 'WAITLIST request' : 'Booking request',
        name:     name, email: email, phone: phone,
        org:      $('bkOrg').value.trim() || '-',
        people:   String(people),
        setup:    state.setup ? (state.setup === 'ushape' ? 'U-shape' : 'Classroom') : '-',
        catering: picked.length ? picked.join('; ') : 'none',
        estimate: estimate,
        special:  specialText() || '-',
        notes:    $('bkNotes').value.trim() || '-'
      };
      fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString()
      }).catch(function () {});
    } catch (_) {}
  }

  /* ---------------------------------------------------------- submit -- */
  function showDone(phone) {
    $('bkApp').hidden = true;
    $('bkDone').hidden = false;
    $('bkDoneTitle').textContent = state.waitlist ? 'You are on the waitlist.' : 'Request received.';
    $('bkDoneText').textContent = state.waitlist
      ? 'If that booking is cancelled we will contact you first' + (phone ? ', on ' + phone : '') +
        '. Nothing is charged for a waitlist place.'
      : 'We will confirm ' + (state.room === 'meeting' ? 'the meeting room' : state.room === 'workshop' ? 'the workshop room' : 'your event space') +
        ' for ' + prettyDate(state.date) + ' within one working day, by email and phone. ' +
        'Nothing is charged until you agree the final figure.';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function submit(e) {
    e.preventDefault();
    var btn = $('bkSubmit');
    msg('', '');   // clear any earlier error, so a stale one can never look like a fresh one

    // Spam trap. The field is off-screen, untabbable and named so that no browser
    // autofill recognises it, so a real person cannot trip it. If something does,
    // show the normal confirmation rather than a clue.
    var trap = $('bkForm').querySelector('[name="mic_hp_leave_blank"]');
    if (trap && trap.value) { showDone(''); return; }

    var name = $('bkName').value.trim(), email = $('bkEmail').value.trim(),
        phone = $('bkPhone').value.trim(), heads = headcount();
    if (!name || !email || !phone) { msg('err', 'Please fill in your name, email and phone.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg('err', 'That email address does not look right.'); return; }
    if (!heads) { msg('err', 'Please tell us how many people are coming.'); return; }
    if (state.room === 'workshop' && !state.setup) { msg('err', 'Please choose U-shape or classroom.'); return; }
    if (isEvent() && !chosenFac().length) { msg('err', 'Pick at least one space for your event.'); return; }
    if (isEvent() && !$('bkEvent').value.trim()) { msg('err', 'What is the event called? A few words is enough.'); $('bkEvent').focus(); return; }
    if (heads > capacityLimit()) { msg('err', 'That room holds ' + capacityLimit() + ' people in the setup you picked.'); return; }
    if (state.cat === 'custom' && !Object.keys(state.items).some(function (k) { return state.items[k]; })) {
      msg('err', 'Tick at least one item to build your own, or pick another refreshments option.'); return;
    }
    if (state.cat === 'special' && !specialText()) {
      msg('err', 'Tell us what you need for your special order.'); return;
    }

    // Freeze what was chosen, and what it cost today, onto the booking itself,
    // so editing the menu later never rewrites an old booking.
    var snapshot = chosen().map(function (m) {
      return { id: m.id, name: m.name, kind: m.kind, unit: m.unit,
               price: m.price == null ? null : Number(m.price),
               qty: m.unit === 'per_person' ? heads : 1,
               line: lineCost(m) };
    });
    var quote = state.waitlist ? null : priceRooms() + addonsTotal();
    var special = specialText();

    var reqId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : null;
    // An event is one request: every chosen space, for every chosen hour.
    var units = isEvent() ? chosenFac() : [state.room];
    var pairs = [];
    units.forEach(function (u) { state.slots.forEach(function (k) { pairs.push([u, k]); }); });
    var rows = pairs.map(function (pk) {
      var k = pk[1];
      var r = {
        room: pk[0], booking_date: state.date, slot: k,
        status: 'pending', kind: state.waitlist ? 'waitlist' : 'booking',
        name: name, email: email, phone: phone,
        org: $('bkOrg').value.trim() || null,
        headcount: heads,
        setup: state.room === 'workshop' ? state.setup : null,
        // 'catering' is the column the original four fixed tiers used. What was
        // ordered now lives in 'addons' below, so this stays 'none' — the
        // database only accepts the old tier names here, and sending anything
        // else is what made bookings fail.
        catering: 'none',
        catering_people: null,
        catering_quote: (state.waitlist || anyOnRequest()) ? null : quote,
        addons: snapshot,
        addons_note: special || null,
        notes: $('bkNotes').value.trim() || null
      };
      if (isEvent()) r.event_name = $('bkEvent').value.trim();
      if (reqId) r.request_id = reqId;
      return r;
    });

    btn.disabled = true; btn.textContent = 'Sending…';
    fetch(api + 'room_bookings', {
      method: 'POST',
      headers: Object.assign({}, headers, { Prefer: 'return=minimal' }),
      body: JSON.stringify(rows)
    })
      .then(function (r) {
        if (r.status === 409) throw new Error('taken');
        if (!r.ok) {
          return r.text().then(function (t) {
            if (window.console) console.error('Booking was refused (HTTP ' + r.status + '):', t);
            throw new Error('HTTP ' + r.status);
          });
        }
        notifyTeam(name, email, phone);
        showDone(phone);
      })
      .catch(function (err) {
        btn.disabled = false; btn.textContent = 'Request this booking →';
        msg('err', err.message === 'taken'
          ? 'Someone booked that time while you were filling this in. Pick another slot, or select the taken one to join the waitlist.'
          : 'We could not send that just now. Please try again, or reach us on ' +
            '<a href="tel:+96171040640">+961 71 040 640</a> or ' +
            '<a href="mailto:info@mic-lb.com">info@mic-lb.com</a>.');
        if (err.message === 'taken') { loadMonth().then(function () { renderCalendar(); renderSlots(); }); }
      });
  }

  /* ------------------------------------------------------------ wire -- */
  function init() {
    if (!$('bkApp')) return;
    var want = new URLSearchParams(location.search).get('room');

    document.querySelectorAll('.bk-room').forEach(function (b) {
      b.addEventListener('click', function () {
        state.room = b.dataset.room;
        state.date = null; state.slots = []; state.setup = null; state.waitlist = false;
        document.querySelectorAll('.bk-room').forEach(function (o) {
          o.setAttribute('aria-pressed', String(o === b));
        });
        $('bkSetupRow').hidden = state.room !== 'workshop';
        $('bkEventRow').hidden = !isEvent();
        $('bkFacPanel').hidden = !isEvent();
        if (isEvent()) renderFacilities();
        $('bkHeads').placeholder = isEvent() ? 'e.g. 80' : 'e.g. 12';
        $('bkStepDate').hidden = isEvent() && !chosenFac().length;
        $('bkStepSlots').hidden = true;
        $('bkStepForm').hidden = true;
        $('bkSummary').hidden = true;
        refreshCapHint();
        if (!MENU.length) { loadMenu().then(renderMenu); } else { renderMenu(); }
        loadMonth().then(renderCalendar);
        (isEvent() ? $('bkFacPanel') : $('bkStepDate')).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });

    // Event Space is offered once its facilities are in the catalogue
    // (mic_events_SETUP.sql). Prices shown on the tile follow the catalogue.
    loadMenu().then(function () {
      var list = facilities();
      if (!list.length) return;
      $('bkEventTile').hidden = false;
      var priced = list.filter(function (m) { return m.price != null; }).map(function (m) { return Number(m.price); });
      if (priced.length === list.length && priced.length) {
        $('bkEventRate').innerHTML = 'From ' + money(Math.min.apply(null, priced)) + ' <span>/ hour per space</span>';
      }
      if (want === 'event') $('bkEventTile').click();
    });

    $('bkPrev').addEventListener('click', function () {
      state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
      loadMonth().then(renderCalendar);
    });
    $('bkNext').addEventListener('click', function () {
      state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1);
      loadMonth().then(renderCalendar);
    });

    document.querySelectorAll('[data-setup]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.setup = b.dataset.setup;
        document.querySelectorAll('[data-setup]').forEach(function (o) {
          o.setAttribute('aria-pressed', String(o === b));
        });
        refreshCapHint(); renderSummary();
      });
    });

    ['bkHeads'].forEach(function (id) {
      $(id).addEventListener('input', function () { refreshCapHint(); refreshCatHint(); renderSummary(); });
      $(id).addEventListener('change', function () { refreshCapHint(); refreshCatHint(); renderSummary(); });
    });

    $('bkForm').addEventListener('submit', submit);

    // deep link: booking.html?room=meeting (or workshop, or event once offered)
    if (want === 'meeting' || want === 'workshop') {
      var t = document.querySelector('.bk-room[data-room="' + want + '"]');
      if (t) t.click();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
