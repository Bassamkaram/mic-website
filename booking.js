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
  var CATERING = {
    none:         { label: 'No refreshments',      pp: 0 },
    refreshments: { label: 'Refreshments',          pp: 3 },
    coffee_break: { label: 'Coffee break',          pp: 5 },
    premium:      { label: 'Premium coffee break',  pp: 10 },
    meal:         { label: 'Meal break',            pp: null }   // quoted on request
  };
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
    taken: {}            // 'YYYY-MM-DD' -> { slotKey: true }
  };

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
  function msg(kind, text) {
    $('bkMsg').innerHTML = text
      ? '<div class="bk-msg bk-msg--' + kind + '">' + text + '</div>' : '';
  }

  /* ------------------------------------------------- availability load -- */
  function loadMonth() {
    if (!state.room) return Promise.resolve();
    var from = iso(state.month);
    var last = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 0);
    var to = iso(last);
    var url = api + 'room_availability?room=eq.' + state.room +
              '&booking_date=gte.' + from + '&booking_date=lte.' + to +
              '&select=booking_date,slot';
    return fetch(url, { headers: headers })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (rows) {
        state.taken = {};
        rows.forEach(function (row) {
          (state.taken[row.booking_date] = state.taken[row.booking_date] || {})[row.slot] = true;
        });
        msg('', '');
      })
      .catch(function () {
        state.taken = {};
        msg('warn', 'We could not load live availability just now, so every slot is shown as ' +
            'free. Send your request anyway and we will tell you if the time is already taken.');
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
  function priceRooms() {
    if (!state.slots.length) return 0;
    return state.room === 'workshop'
      ? state.slots.length * RATE_WORKSHOP_HALF
      : state.slots.length * RATE_MEETING_HOUR;
  }
  function cateringChoice() { return $('bkCatering') ? $('bkCatering').value : 'none'; }
  function headcount() { return parseInt($('bkHeads') && $('bkHeads').value, 10) || 0; }

  function renderSummary() {
    if (!state.slots.length) { $('bkSummary').hidden = true; return; }
    var rows = [];
    rows.push(['Room', state.room === 'meeting' ? 'Meeting Room' : 'Workshop Room']);
    rows.push(['Date', prettyDate(state.date)]);
    if (state.room === 'workshop') {
      rows.push(['Time', state.slots.length === 2 ? 'Full day (08:00 – 20:00)'
                                                  : slotLabel(state.slots[0])]);
    } else {
      rows.push(['Time', state.slots.map(function (s) { return s + ':00'; }).join(', ')]);
      rows.push(['Hours', String(state.slots.length)]);
    }
    if (state.setup) rows.push(['Setup', state.setup === 'ushape' ? 'U-shape' : 'Classroom']);

    var roomCost = priceRooms();
    var cat = CATERING[cateringChoice()];
    var people = headcount();
    var catCost = (cat && cat.pp && people) ? cat.pp * people : 0;

    var html = rows.map(function (r) {
      return '<div class="bk-line"><span>' + r[0] + '</span><span>' + r[1] + '</span></div>';
    }).join('');

    if (state.waitlist) {
      html += '<div class="bk-line is-muted"><span>Waitlist request</span><span>no charge</span></div>';
    } else {
      html += '<div class="bk-line"><span>Room</span><span>$' + roomCost + '</span></div>';
      if (cateringChoice() === 'meal') {
        html += '<div class="bk-line is-muted"><span>' + cat.label + '</span><span>on request</span></div>';
      } else if (catCost) {
        html += '<div class="bk-line"><span>' + cat.label + ' &times; ' + people +
                '</span><span>$' + catCost + '</span></div>';
      }
    }
    $('bkSumBody').innerHTML = html;
    $('bkTotal').textContent = state.waitlist ? '—' : ('$' + (roomCost + catCost));
    $('bkTotalNote').textContent = state.waitlist
      ? 'Joining the waitlist costs nothing and commits you to nothing. We contact waitlist requests in the order they arrive.'
      : (cateringChoice() === 'meal'
          ? 'An estimate. The meal break is quoted separately once we know what you need.'
          : 'An estimate, not an invoice. We confirm availability and the final figure within one working day, and nothing is charged before you agree it.');
  }

  /* -------------------------------------------------------- capacity -- */
  function capacityLimit() {
    if (state.room === 'meeting') return CAP.meeting;
    if (state.setup) return CAP.workshop[state.setup];
    return CAP.workshop.classroom;
  }
  function refreshCapHint() {
    var el = $('bkCapHint'); if (!el) return;
    var lim = capacityLimit(), n = headcount();
    if (state.room === 'workshop' && !state.setup) {
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
    var cat = CATERING[cateringChoice()], n = headcount(), el = $('bkCatHint');
    if (!el) return;
    if (cateringChoice() === 'meal') el.textContent = 'We will quote this with your confirmation.';
    else if (cat.pp && n) el.textContent = '$' + cat.pp + ' × ' + n + ' = $' + (cat.pp * n) + '.';
    else if (cat.pp) el.textContent = '$' + cat.pp + ' per person.';
    else el.textContent = '';
  }

  /* ---------------------------------------------------------- submit -- */
  function submit(e) {
    e.preventDefault();
    var btn = $('bkSubmit');
    if ($('bkForm').querySelector('[name="website"]').value) return;   // honeypot

    var name = $('bkName').value.trim(), email = $('bkEmail').value.trim(),
        phone = $('bkPhone').value.trim(), heads = headcount();
    if (!name || !email || !phone) { msg('err', 'Please fill in your name, email and phone.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg('err', 'That email address does not look right.'); return; }
    if (!heads) { msg('err', 'Please tell us how many people are coming.'); return; }
    if (state.room === 'workshop' && !state.setup) { msg('err', 'Please choose U-shape or classroom.'); return; }
    if (heads > capacityLimit()) { msg('err', 'That room holds ' + capacityLimit() + ' people in the setup you picked.'); return; }

    var cat = CATERING[cateringChoice()];
    var quote = (!state.waitlist && cat.pp) ? cat.pp * heads + priceRooms()
              : (!state.waitlist ? priceRooms() : null);

    var reqId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : null;
    var rows = state.slots.map(function (k) {
      var r = {
        room: state.room, booking_date: state.date, slot: k,
        status: 'pending', kind: state.waitlist ? 'waitlist' : 'booking',
        name: name, email: email, phone: phone,
        org: $('bkOrg').value.trim() || null,
        headcount: heads,
        setup: state.room === 'workshop' ? state.setup : null,
        catering: cateringChoice(),
        catering_people: cateringChoice() === 'none' ? null : heads,
        catering_quote: (cateringChoice() === 'meal' || state.waitlist) ? null : quote,
        notes: $('bkNotes').value.trim() || null
      };
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
        if (!r.ok) throw new Error('HTTP ' + r.status);
        $('bkApp').hidden = true;
        $('bkDone').hidden = false;
        $('bkDoneTitle').textContent = state.waitlist ? 'You are on the waitlist.' : 'Request received.';
        $('bkDoneText').textContent = state.waitlist
          ? 'If that booking is cancelled we will contact you first, on ' + phone + '. Nothing is charged for a waitlist place.'
          : 'We will confirm ' + (state.room === 'meeting' ? 'the meeting room' : 'the workshop room') +
            ' for ' + prettyDate(state.date) + ' within one working day, by email and phone. Nothing is charged until you agree the final figure.';
        window.scrollTo({ top: 0, behavior: 'smooth' });
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

    document.querySelectorAll('.bk-room').forEach(function (b) {
      b.addEventListener('click', function () {
        state.room = b.dataset.room;
        state.date = null; state.slots = []; state.setup = null; state.waitlist = false;
        document.querySelectorAll('.bk-room').forEach(function (o) {
          o.setAttribute('aria-pressed', String(o === b));
        });
        $('bkSetupRow').hidden = state.room !== 'workshop';
        $('bkStepDate').hidden = false;
        $('bkStepSlots').hidden = true;
        $('bkStepForm').hidden = true;
        $('bkSummary').hidden = true;
        refreshCapHint();
        loadMonth().then(renderCalendar);
        $('bkStepDate').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
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

    ['bkHeads', 'bkCatering'].forEach(function (id) {
      $(id).addEventListener('input', function () { refreshCapHint(); refreshCatHint(); renderSummary(); });
      $(id).addEventListener('change', function () { refreshCapHint(); refreshCatHint(); renderSummary(); });
    });

    $('bkForm').addEventListener('submit', submit);

    // deep link: booking.html?room=meeting
    var want = new URLSearchParams(location.search).get('room');
    if (want === 'meeting' || want === 'workshop') {
      var t = document.querySelector('.bk-room[data-room="' + want + '"]');
      if (t) t.click();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
