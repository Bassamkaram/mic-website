/* ============================================================
   MIC — staff tablet (staff.html)

   A screen that lives on a tablet at the front desk:
     · today's and this week's bookings, read-only
     · tasks from the admins, which ring and notify when they arrive
     · "Mark as done", with an optional photo or video as proof

   Like the booking console it holds no secret. Every read and write is
   made with the staff member's own sign-in, and the database decides
   what that sign-in may see and do (mic_staff_SETUP.sql). A viewer can
   look at bookings, and can complete a task; nothing else.
   ============================================================ */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://xnegzvpuagxgahlbtzaf.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhuZWd6dnB1YWd4Z2FobGJ0emFmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzODk0NDIsImV4cCI6MjA5Mzk2NTQ0Mn0.RXBD_LxrZiv0tQfX7W6S9wT8JKNMPd5xB3LBlV50lAE';
  // The public half of the push key pair comes from the server, so the pair can
  // be replaced in Netlify without touching this file. The private half never
  // leaves Netlify.
  var NOTIFY_URL = '/.netlify/functions/notify-staff';
  var vapidKey = null, keyCheckedAt = 0;

  var TZ = 'Asia/Beirut';
  var POLL_MS = 20000;
  var MAX_VIDEO = 50 * 1024 * 1024;
  var LS_SESSION = 'mic_staff_session', LS_SEEN = 'mic_staff_seen', LS_SAFARI = 'mic_staff_use_safari';

  var ROOMS = { meeting: 'Meeting Room', workshop: 'Workshop Room',
                // Event Space facilities (mic_events_SETUP.sql)
                ev_cowork: 'Coworking space', ev_workshop: 'Workshop room', ev_play_full: 'Playground (all)',
                ev_play_part: 'Playground (part)', ev_kitchen: 'Kitchen', ev_coffee: 'Coffee shop' };
  var EV_ORDER = ['ev_cowork', 'ev_workshop', 'ev_play_full', 'ev_play_part', 'ev_kitchen', 'ev_coffee'];
  function isEv(room) { return /^ev_/.test(room || ''); }
  var SETUP = { ushape: 'U-shape', classroom: 'Classroom' };
  var CAT = { refreshments: 'Refreshments', coffee_break: 'Coffee break', premium: 'Premium coffee break', meal: 'Meal break' };

  var $ = function (id) { return document.getElementById(id); };
  var S = null;                 // { access_token, refresh_token, expires_at, email }
  var me = null;                // this person's row in booking_staff
  var tasks = [], bookings = [], alertIds = [];
  var started = false, pollTimer = null, refreshing = null, audio = null, wakeLock = null;
  var push = { state: 'checking', reg: null };
  var sheet = {};
  var lastHtml = { tasks: '', done: '', bookings: '', alert: '' };
  var focusAfterLoad = null;   // a task to scroll to once the data is in (from a notification)

  /* ---------------------------------------------------------- helpers -- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (_) {} }
  function noop() {}

  function toast(text, ms) {
    var old = document.querySelector('.st-toast'); if (old) old.remove();
    var t = document.createElement('div'); t.className = 'st-toast'; t.setAttribute('role', 'status'); t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 4500);
  }

  // Wall-clock time in Beirut, whatever the tablet's own setting.
  var PARTS = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  function local(d) {
    var o = {};
    PARTS.formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
    return { ymd: o.year + '-' + o.month + '-' + o.day, h: (+o.hour) % 24, m: +o.minute };
  }
  function addDays(ymd, n) {
    var d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
  }
  function dayName(ymd, opts) {
    return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-GB', Object.assign({ timeZone: 'UTC' }, opts));
  }
  function two(n) { return String(n).padStart(2, '0'); }
  function whenText(iso) {
    var L = local(new Date(iso)), today = local(new Date()).ymd, hm = two(L.h) + ':' + two(L.m);
    if (L.ymd === today) return 'today ' + hm;
    if (L.ymd === addDays(today, 1)) return 'tomorrow ' + hm;
    if (L.ymd === addDays(today, -1)) return 'yesterday ' + hm;
    return dayName(L.ymd, { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + hm;
  }

  /* ------------------------------------------------------------- auth -- */
  function saveSession(j) {
    S = {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: j.expires_at ? j.expires_at * 1000 : Date.now() + (j.expires_in || 3600) * 1000,
      email: String((j.user && j.user.email) || (S && S.email) || '').toLowerCase()
    };
    lsSet(LS_SESSION, S);
  }
  function authCall(grant, body) {
    return fetch(SUPABASE_URL + '/auth/v1/token?grant_type=' + grant, {
      method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    });
  }
  function signedOutError() { var e = new Error('signed out'); e.signedOut = true; return e; }
  function offlineError() { var e = new Error('offline'); e.offline = true; return e; }

  // One refresh at a time. Supabase rotates the refresh token on every use,
  // so two refreshes racing each other would sign the tablet out.
  function refresh() {
    if (refreshing) return refreshing;
    if (!S || !S.refresh_token) return Promise.reject(signedOutError());
    refreshing = authCall('refresh_token', { refresh_token: S.refresh_token }).then(function (res) {
      refreshing = null;
      if (res.ok && res.j.access_token) { saveSession(res.j); return; }
      // a refused refresh token means signed out; "too many requests" only means wait
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw signedOutError();
      throw offlineError();
    }, function () { refreshing = null; throw offlineError(); });
    return refreshing;
  }
  function ensureFresh() {
    if (!S) return Promise.reject(signedOutError());
    return (S.expires_at - Date.now() > 120000) ? Promise.resolve() : refresh();
  }

  // A database call made with this person's sign-in. After a 401 it refreshes once and retries.
  function api(path, opts, retried) {
    opts = opts || {};
    return ensureFresh().then(function () {
      var h = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + S.access_token };
      if (opts.body !== undefined) h['Content-Type'] = 'application/json';
      return fetch(SUPABASE_URL + path, { method: opts.method || 'GET', headers: h, body: opts.body })
        .catch(function () { throw offlineError(); });
    }).then(function (r) {
      if (r.status === 401 && !retried) return refresh().then(function () { return api(path, opts, true); });
      return r;
    });
  }
  // Functions that return nothing answer with an empty body, so parse by hand.
  function json(r) {
    return r.text().then(function (t) {
      if (r.ok) { if (!t) return null; try { return JSON.parse(t); } catch (_) { return t; } }
      var e = new Error('HTTP ' + r.status + ' ' + t.slice(0, 200)); e.status = r.status;
      try { var j = JSON.parse(t); e.code = j.code; e.detail = j.message; } catch (_) {}
      throw e;
    });
  }

  function loginMsg(html) {
    $('stLoginMsg').innerHTML = html ? '<div class="bk-msg bk-msg--err">' + html + '</div>' : '';
  }
  function signIn(e) {
    e.preventDefault();
    var btn = $('stGo'); btn.disabled = true; btn.textContent = 'Signing in…'; loginMsg('');
    authCall('password', { email: $('stEmail').value.trim(), password: $('stPass').value }).then(function (res) {
      btn.disabled = false; btn.textContent = 'Sign in';
      if (!res.ok || !res.j.access_token) {
        var code = res.j.error_code || '', text = String(res.j.error_description || res.j.msg || '');
        loginMsg(code === 'email_not_confirmed' || /confirm/i.test(text)
          ? 'This account has not been confirmed yet. An admin can confirm it in Supabase, under Authentication.'
          : res.status === 400 ? 'That email and password do not match.' : esc(text || 'Sign-in failed. Try again.'));
        return;
      }
      $('stPass').value = '';
      saveSession(res.j);
      enter();
    }).catch(function () {
      btn.disabled = false; btn.textContent = 'Sign in';
      loginMsg('Could not reach the server. Check the Wi-Fi and try again.');
    });
  }

  // After sign-in, or on launch with a saved session: is this person on the staff list?
  function enter() {
    api('/rest/v1/booking_staff?select=email,name,role,active&email=eq.' + encodeURIComponent(S.email))
      .then(json)
      .then(function (rows) {
        me = rows && rows[0];
        if (!me || !me.active) {
          var who = S.email;
          signOut();
          loginMsg('<b>' + esc(who) + '</b> is not on the staff list. An admin can add it in the booking console, under Staff.');
          return;
        }
        showApp();
      })
      .catch(function (e) {
        if (e && e.signedOut) { signOut(); loginMsg('Please sign in again.'); return; }
        showApp();   // offline at launch: open anyway, it fills in when the connection is back
      });
  }

  var outArmed = 0;
  function askSignOut() {
    if (Date.now() - outArmed < 4000) { signOut(); return; }
    outArmed = Date.now();
    $('stOut').textContent = 'Tap again to sign out';
    setTimeout(function () { $('stOut').textContent = 'Sign out'; }, 4000);
  }
  function signOut() {
    clearTimeout(pollTimer); pollTimer = null;
    var old = S;
    S = null; me = null; started = false; tasks = []; bookings = []; alertIds = [];
    lastHtml = { tasks: '', done: '', bookings: '', alert: '' };
    lsDel(LS_SESSION);
    releaseWake();
    // This device stops receiving this account's notifications.
    if (old && push.reg && push.reg.pushManager) {
      push.reg.pushManager.getSubscription().then(function (sub) {
        if (!sub) return;
        var h = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + old.access_token, 'Content-Type': 'application/json' };
        return fetch(SUPABASE_URL + '/rest/v1/rpc/remove_push_subscription', {
          method: 'POST', headers: h, body: JSON.stringify({ p_endpoint: sub.endpoint })
        }).catch(noop).then(function () { return sub.unsubscribe(); });
      }).catch(noop).then(function () { if (push.state === 'on') setPush('off'); });
    }
    if (old) {
      fetch(SUPABASE_URL + '/auth/v1/logout', {
        method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + old.access_token }
      }).catch(noop);
    }
    $('stOut').textContent = 'Sign out';
    $('stApp').hidden = true; $('stInstall').hidden = true; $('stLogin').hidden = false;
    $('stAlertBox').innerHTML = '';
    $('stSheet').hidden = true;
  }

  /* -------------------------------------------------------- screens -- */
  function showApp() {
    $('stLogin').hidden = true; $('stInstall').hidden = true; $('stApp').hidden = false;
    $('stHello').textContent = me && me.name ? ', ' + String(me.name).split(' ')[0] : '';
    $('stStartBar').hidden = started;
    checkPush();
    tick();
    poll();
  }

  function tick() {
    var now = new Date();
    $('stTime').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    $('stDate').textContent = now.toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  }

  /* ------------------------------------------------------------ data -- */
  function poll() {
    clearTimeout(pollTimer); pollTimer = null;
    if (!S) return Promise.resolve();
    var today = local(new Date()).ymd;
    var since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    var bkCols = '*';
    return Promise.all([
      api('/rest/v1/rpc/is_booking_member', { method: 'POST', body: '{}' }).then(json),
      api('/rest/v1/staff_tasks?select=*&order=created_at.desc&or=' +
          encodeURIComponent('(status.eq.open,done_at.gte."' + since + '")')).then(json),
      api('/rest/v1/room_bookings?select=' + bkCols +
          '&kind=eq.booking&status=in.(confirmed,blocked,pending)' +
          '&booking_date=gte.' + today + '&booking_date=lte.' + addDays(today, 6) +
          '&order=booking_date.asc,slot.asc').then(json)
    ]).then(function (res) {
      if (res[0] !== true) {
        var who = S && S.email;
        signOut();
        loginMsg('<b>' + esc(who) + '</b> no longer has access to the staff screen. Ask an admin if this is a mistake.');
        return;
      }
      tasks = res[1] || []; bookings = res[2] || [];
      setSync('ok');
      if (push.state === 'notset' && Date.now() - keyCheckedAt > 5 * 60000) checkPush();
      spotNew();
      render();
      if (focusAfterLoad) { var id = focusAfterLoad; focusAfterLoad = null; focusTask(id); }
    }).catch(function (e) {
      if (e && e.signedOut) { signOut(); loginMsg('Your sign-in has expired. Please sign in again.'); return; }
      if (e && e.offline) setSync('offline');
      else { setSync('error'); console.error('Staff screen could not load:', e); }
    }).then(function () {
      if (S) pollTimer = setTimeout(poll, POLL_MS);
    });
  }

  function setSync(kind) {
    var c = $('chipSync');
    c.className = 'st-chip' + (kind === 'ok' ? '' : ' is-warn');
    c.querySelector('.tx').textContent = kind === 'ok'
      ? 'Updated ' + new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
      : kind === 'offline' ? 'No connection — retrying' : 'Could not load — retrying';
  }

  // Tasks this device has not shown before ring and raise the banner. The very
  // first time an account signs in here, what is already open is taken as seen.
  function spotNew() {
    var store = lsGet(LS_SEEN);
    var known = store && store.email === S.email ? store.ids : null;
    var fresh = known ? tasks.filter(function (t) { return t.status === 'open' && !known[t.id]; }) : [];
    var ids = {};
    tasks.forEach(function (t) { ids[t.id] = 1; });
    lsSet(LS_SEEN, { email: S.email, ids: ids });
    if (!fresh.length) return;
    fresh.forEach(function (t) { if (alertIds.indexOf(t.id) === -1) alertIds.push(t.id); });
    ring(fresh.some(isUrgent));
  }

  /* ---------------------------------------------------------- render -- */
  function isUrgent(t) { return t.priority === 'urgent'; }
  function findTask(id) { for (var i = 0; i < tasks.length; i++) if (tasks[i].id === id) return tasks[i]; return null; }
  // Urgent first, then by deadline. An urgent task with no deadline means "now";
  // an ordinary one with no deadline can wait behind those that have one.
  function dueKey(t) { return t.due_at ? Date.parse(t.due_at) : isUrgent(t) ? Date.parse(t.created_at) : Infinity; }
  function byUrgency(a, b) {
    var ua = isUrgent(a) ? 0 : 1, ub = isUrgent(b) ? 0 : 1;
    if (ua !== ub) return ua - ub;
    var da = dueKey(a), db = dueKey(b);
    if (da !== db) return da < db ? -1 : 1;
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  }

  function render() {
    renderAlert();
    renderTasks();
    renderBookings();
    var open = tasks.filter(function (t) { return t.status === 'open'; }).length;
    document.title = (open ? '(' + open + ') ' : '') + 'MIC Staff';
  }

  function renderAlert() {
    var list = alertIds.map(findTask).filter(function (t) { return t && t.status === 'open'; });
    alertIds = list.map(function (t) { return t.id; });
    if (!list.length) { lastHtml.alert = ''; $('stAlertBox').innerHTML = ''; return; }
    var urgent = list.some(isUrgent), top = list.slice().sort(byUrgency)[0];
    var html =
      '<div class="st-alert' + (urgent ? ' is-urgent' : '') + '" role="alert">' +
        '<span class="ic" aria-hidden="true">' + (urgent ? '&#9888;' : '&#9679;') + '</span>' +
        '<span class="tx"><small>' + (list.length > 1 ? list.length + ' new tasks' : urgent ? 'Urgent task' : 'New task') + '</small>' +
        '<b>' + esc(top.title) + '</b></span>' +
        '<button type="button" id="alertShow" data-task="' + esc(top.id) + '">Show me</button>' +
      '</div>';
    if (html === lastHtml.alert) return;   // unchanged: do not re-announce it
    lastHtml.alert = html;
    $('stAlertBox').innerHTML = html;
    $('alertShow').addEventListener('click', function (e) {
      var id = e.currentTarget.getAttribute('data-task');
      alertIds = []; lastHtml.alert = ''; $('stAlertBox').innerHTML = ''; focusTask(id);
    });
  }

  function linkedBooking(requestId) {
    if (!requestId) return '';
    var rows = bookings.filter(function (b) { return b.request_id === requestId; });
    if (!rows.length) return '';
    var spans = merge(rows.map(spanOf).filter(Boolean));
    var today = local(new Date()).ymd, d = rows[0].booking_date;
    var day = d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : dayName(d, { weekday: 'short', day: 'numeric', month: 'short' });
    return (isEv(rows[0].room) ? 'Event Space' : (ROOMS[rows[0].room] || rows[0].room)) + ' · ' + day + ' ' +
           (spans.length ? hh(spans[0][0]) + '–' + hh(spans[0][1]) : '') +
           ((rows[0].event_name || rows[0].name) ? ' · ' + (rows[0].event_name || rows[0].name) : '');
  }

  function taskCard(t) {
    var tags = [];
    if (isUrgent(t)) tags.push('<span class="st-tag urgent">Urgent</span>');
    if (t.due_at) {
      var ms = Date.parse(t.due_at) - Date.now();
      tags.push('<span class="st-tag' + (ms < 0 ? ' late' : ms < 2 * 3600e3 ? ' soon' : '') + '">' +
        (ms < 0 ? 'Overdue — was due ' : 'Due ') + esc(whenText(t.due_at)) + '</span>');
    }
    if (t.assigned_to && S && t.assigned_to === S.email) tags.push('<span class="st-tag mine">For you</span>');
    var bk = linkedBooking(t.booking_request);
    if (bk) tags.push('<span class="st-tag">' + esc(bk) + '</span>');
    return '<article class="st-task' + (isUrgent(t) ? ' is-urgent' : '') + '" id="task-' + esc(t.id) + '">' +
      '<h3>' + esc(t.title) + '</h3>' +
      (t.details ? '<p class="det">' + esc(t.details) + '</p>' : '') +
      (tags.length ? '<div class="st-tags">' + tags.join('') + '</div>' : '') +
      '<button class="btn btn--primary btn--block go" type="button" data-done="' + esc(t.id) + '">Mark as done</button>' +
    '</article>';
  }

  function renderTasks() {
    var open = tasks.filter(function (t) { return t.status === 'open'; }).sort(byUrgency);
    var c = $('cTasks'); c.textContent = String(open.length); c.classList.toggle('is-zero', !open.length);
    var html = open.length ? open.map(taskCard).join('')
      : '<div class="st-empty">No tasks right now. New ones will ring and appear here.</div>';
    if (html !== lastHtml.tasks) {
      lastHtml.tasks = html;
      $('stTasks').innerHTML = html;
      $('stTasks').querySelectorAll('[data-done]').forEach(function (b) {
        b.addEventListener('click', function () { openSheet(b.getAttribute('data-done')); });
      });
    }

    var done = tasks.filter(function (t) { return t.status === 'done'; })
      .sort(function (a, b) { return Date.parse(b.done_at) - Date.parse(a.done_at); });
    $('stDoneWrap').hidden = !done.length;
    $('stDoneSum').textContent = 'Done in the last 24 hours (' + done.length + ')';
    var dhtml = done.map(function (t) {
      var who = !t.done_by ? '' : (S && t.done_by === S.email) ? 'you' : t.done_by.split('@')[0];
      return '<div class="st-doneitem"><s>' + esc(t.title) + '</s><small>' +
        esc(whenText(t.done_at)) + (who ? ' · ' + esc(who) : '') +
        (t.proof_type ? ' · with ' + (t.proof_type === 'video' ? 'video' : 'photo') : '') + '</small></div>';
    }).join('');
    if (dhtml !== lastHtml.done) { lastHtml.done = dhtml; $('stDone').innerHTML = dhtml; }
  }

  /* bookings: one line per continuous stretch of time */
  function spanOf(r) {
    if (r.slot === 'am') return [8, 14];
    if (r.slot === 'pm') return [14, 20];
    var h = parseInt(r.slot, 10);
    return isNaN(h) ? null : [h, h + 1];
  }
  function merge(spans) {
    spans.sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    spans.forEach(function (s) {
      var last = out[out.length - 1];
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else out.push([s[0], s[1]]);
    });
    return out;
  }
  function hh(h) { return two(h % 24) + ':00'; }

  function ordered(r) {
    var bits = [];
    if (r.addons && r.addons.length) {
      r.addons.forEach(function (a) {
        bits.push(esc(a.name) + (a.unit === 'per_person' && a.qty ? ' for ' + esc(a.qty) : ''));
      });
    } else if (r.catering && r.catering !== 'none') {
      bits.push(esc(CAT[r.catering] || r.catering) + (r.catering_people ? ' for ' + esc(r.catering_people) : ''));
    }
    return bits;
  }

  function renderBookings() {
    var now = local(new Date()), nowH = now.h + now.m / 60, today = now.ymd;
    var entries = {};
    bookings.forEach(function (r) {
      // an event is one entry, however many spaces it uses
      var k = r.booking_date + '|' + r.request_id + '|' + (isEv(r.room) ? 'event' : r.room) + '|' + r.status;
      (entries[k] = entries[k] || []).push(r);
    });

    var byDay = {};
    Object.keys(entries).forEach(function (k) {
      var rows = entries[k], r = rows[0];
      var spaces = isEv(r.room) ? EV_ORDER.filter(function (c) { return rows.some(function (x) { return x.room === c; }); }) : null;
      merge(rows.map(spanOf).filter(Boolean)).forEach(function (s) {
        (byDay[r.booking_date] = byDay[r.booking_date] || []).push({ r: r, s: s, spaces: spaces });
      });
    });

    var days = Object.keys(byDay).sort();
    if (days.indexOf(today) === -1) days.unshift(today);
    var todayCount = (byDay[today] || []).filter(function (e) { return e.r.status === 'confirmed'; }).length;
    var c = $('cBk'); c.textContent = String(todayCount); c.classList.toggle('is-zero', !todayCount);

    var html = days.map(function (d) {
      var list = (byDay[d] || []).sort(function (a, b) { return a.s[0] - b.s[0] || (a.r.room < b.r.room ? -1 : 1); });
      var head = d === today ? '<b>Today</b> · ' + dayName(d, { weekday: 'long', day: 'numeric', month: 'long' })
               : d === addDays(today, 1) ? '<b>Tomorrow</b> · ' + dayName(d, { weekday: 'long', day: 'numeric', month: 'long' })
               : dayName(d, { weekday: 'long', day: 'numeric', month: 'long' });
      if (!list.length) return '<div class="st-day"><h3>' + head + '</h3><div class="st-empty" style="padding:16px;">Nothing booked today.</div></div>';
      return '<div class="st-day"><h3>' + head + '</h3>' + list.map(function (e) {
        var r = e.r, s = e.s, cls = 'st-bk', tags = [];
        var isToday = d === today, past = isToday && s[1] <= nowH, live = isToday && s[0] <= nowH && nowH < s[1];
        if (r.status === 'pending') { cls += ' is-pending'; tags.push('<span class="st-tag soon">Not confirmed yet</span>'); }
        if (r.status === 'blocked') cls += ' is-closed';
        if (live && r.status !== 'pending') { cls += ' is-now'; tags.push('<span class="st-tag">Happening now</span>'); }
        if (past) cls += ' is-past';

        var label = r.room === 'workshop'
          ? (s[0] === 8 && s[1] === 20 ? 'Full day' : s[0] === 8 && s[1] === 14 ? 'Morning' : s[0] === 14 && s[1] === 20 ? 'Afternoon' : '')
          : '';
        var t = '<div class="t">' + hh(s[0]) + '–' + hh(s[1]) +
                '<small>' + (e.spaces ? 'Event Space' : esc(ROOMS[r.room] || r.room)) + (label ? ' · ' + label : '') + '</small></div>';

        var w;
        if (r.status === 'blocked') {
          w = '<div class="w"><b>' + (e.spaces ? 'Closed: ' + e.spaces.map(function (c) { return ROOMS[c]; }).join(', ') : 'Room closed') + '</b>' +
              (r.admin_note && r.admin_note !== 'Closed by staff' ? '<small>' + esc(r.admin_note) + '</small>' : '') + '</div>';
        } else {
          var facts = [];
          if (r.headcount) facts.push(esc(r.headcount) + ' people');
          if (r.setup) facts.push(esc(SETUP[r.setup] || r.setup));
          var order = ordered(r);
          if (e.spaces && r.partnership) tags.push('<span class="st-tag mine">Partnership with MIC</span>');
          w = '<div class="w">' + (e.spaces && r.event_name ? '<b>' + esc(r.event_name) + '</b> · ' : '') +
            esc(r.name || 'Guest') + (r.org ? ' · ' + esc(r.org) : '') +
            (e.spaces ? '<small><b>Spaces:</b> ' + e.spaces.map(function (c) { return esc(ROOMS[c]); }).join(' · ') + '</small>' : '') +
            (facts.length ? '<small>' + facts.join(' · ') + '</small>' : '') +
            (order.length ? '<small><b>Prepare:</b> ' + order.join(' · ') + '</small>' : '') +
            (r.addons_note ? '<small><b>Special order:</b> ' + esc(r.addons_note) + '</small>' : '') +
            (r.notes ? '<small><b>Their note:</b> ' + esc(r.notes) + '</small>' : '') +
            (r.admin_note && r.admin_note !== 'Added by staff' ? '<small><b>Office note:</b> ' + esc(r.admin_note) + '</small>' : '') +
            (r.phone ? '<small><a href="tel:' + esc(String(r.phone).replace(/[^\d+]/g, '')) + '">' + esc(r.phone) + '</a></small>' : '') +
            (tags.length ? '<div class="st-tags">' + tags.join('') + '</div>' : '') +
          '</div>';
        }
        return '<div class="' + cls + '">' + t + w + '</div>';
      }).join('') + '</div>';
    }).join('');

    if (html !== lastHtml.bookings) { lastHtml.bookings = html; $('stBookings').innerHTML = html; }
  }

  function focusTask(id) {
    var el = document.getElementById('task-' + id);
    if (!el) {
      var t = findTask(id);
      if (t && t.status === 'done') toast('That task has already been done.');
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('is-flash'); void el.offsetWidth; el.classList.add('is-flash');
    setTimeout(function () { el.classList.remove('is-flash'); }, 3000);
  }

  /* ---------------------------------------------- sound and wake lock -- */
  function unlockAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audio = audio || new AC();
      if (audio.state !== 'running') audio.resume();
      var o = audio.createOscillator(), g = audio.createGain();   // a silent blip completes the unlock on iOS
      g.gain.value = 0.0001; o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.03);
    } catch (_) {}
  }
  function tone(freq, at, dur) {
    var o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.4, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(audio.destination);
    o.start(at); o.stop(at + dur + 0.05);
  }
  function ring(urgent) {
    try { if (navigator.vibrate) navigator.vibrate(urgent ? [220, 120, 220, 120, 220] : 220); } catch (_) {}
    if (!audio || !started) return;
    try {
      if (audio.state !== 'running') audio.resume();
      var t = audio.currentTime + 0.05;
      for (var i = 0; i < (urgent ? 3 : 1); i++) { tone(880, t, 0.2); tone(1318.5, t + 0.17, 0.42); t += 0.8; }
    } catch (_) {}
  }

  function keepAwake() {
    if (!('wakeLock' in navigator)) { setWake(false); return; }
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock; setWake(true);
      lock.addEventListener('release', function () { wakeLock = null; setWake(false); });
    }).catch(function () { setWake(false); });
  }
  function releaseWake() { if (wakeLock) { try { wakeLock.release(); } catch (_) {} wakeLock = null; } setWake(false); }
  function setWake(on) {
    var c = $('chipWake');
    c.className = 'st-chip' + (on ? '' : ' is-off');
    c.querySelector('.tx').textContent = on ? 'Screen stays on' : 'Screen may sleep';
  }

  /* ---------------------------------------------- push notifications -- */
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function isInstalled() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }
  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  function keyBytes(b64) {
    var s = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var raw = atob(s), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function sameKey(sub) {
    try {
      var k = sub.options && sub.options.applicationServerKey;
      if (!k) return true;
      var a = new Uint8Array(k), b = keyBytes(vapidKey);
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    } catch (_) { return true; }
  }

  var PUSH_LABEL = {
    checking: 'Notifications…', on: 'Notifications on', off: 'Turn on notifications', denied: 'Notifications blocked',
    notset: 'Notifications not set up',
    install: 'No notifications in Safari', unsupported: 'No notifications here', error: 'Notifications failed — tap to retry'
  };
  function setPush(state) {
    push.state = state;
    var c = $('chipPush');
    c.className = 'st-chip' + (state === 'on' ? '' : (state === 'off' || state === 'error') ? ' is-warn' : ' is-off');
    c.querySelector('.tx').textContent = PUSH_LABEL[state] || 'Notifications';
    $('stStartWhy').textContent = state === 'off' || state === 'error'
      ? 'Turns on notifications and the chime for new tasks, and keeps this screen awake.'
      : 'Turns on the chime for new tasks and keeps this screen awake.';
  }

  function registerWorker() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    return navigator.serviceWorker.register('/sw.js', { scope: '/staff' })
      .then(function (reg) { push.reg = reg; return reg; })
      .catch(function (e) { console.error('Service worker did not register:', e); return null; });
  }

  // Is sending set up on the server, and with which public key?
  function fetchKey() {
    keyCheckedAt = Date.now();
    return fetch(NOTIFY_URL, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (j) { vapidKey = j && j.ready && j.publicKey ? j.publicKey : null; return vapidKey; })
      .catch(function () { return vapidKey; });
  }

  // Works out where notifications stand, without asking anything.
  function checkPush() {
    if (isIOS() && !isInstalled()) { setPush('install'); return; }
    if (!pushSupported()) { setPush('unsupported'); return; }
    if (Notification.permission === 'denied') { setPush('denied'); return; }
    Promise.all([push.reg ? Promise.resolve(push.reg) : registerWorker(), fetchKey()]).then(function (got) {
      var reg = got[0];
      if (!reg) { setPush('unsupported'); return; }
      if (!got[1]) { setPush('notset'); return; }
      return navigator.serviceWorker.ready.then(function (r) { return r.pushManager.getSubscription(); }).then(function (sub) {
        if (sub && Notification.permission === 'granted' && sameKey(sub)) {
          // re-saved on every launch, so the database always knows this device
          return saveSub(sub).then(function () { setPush('on'); }, function () { setPush('error'); });
        }
        setPush('off');
      });
    }).catch(function () { setPush('error'); });
  }

  // Must run inside a tap: browsers only show the permission prompt in answer to one.
  function turnOnPush() {
    if (!pushSupported() || !push.reg) return;
    if (!vapidKey) { setPush('notset'); return; }
    var ask = Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission();
    setPush('checking');
    Promise.resolve(ask).then(function (perm) {
      if (perm !== 'granted') { setPush(perm === 'denied' ? 'denied' : 'off'); return; }
      return push.reg.pushManager.getSubscription().then(function (old) {
        if (old && !sameKey(old)) {
          // made with an earlier key pair: useless now, so drop it here and in the database
          api('/rest/v1/rpc/remove_push_subscription', { method: 'POST', body: JSON.stringify({ p_endpoint: old.endpoint }) }).catch(noop);
          return old.unsubscribe().then(function () { return null; });
        }
        return old;
      }).then(function (sub) {
        return sub || push.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidKey) });
      }).then(saveSub).then(function () {
        setPush('on');
        toast('Notifications are on. New tasks will reach this device even when the screen is off.');
      });
    }).catch(function (e) {
      console.error('Could not turn on notifications:', e);
      setPush(window.Notification && Notification.permission === 'denied' ? 'denied' : 'error');
    });
  }

  function saveSub(sub) {
    var j = sub.toJSON();
    return api('/rest/v1/rpc/save_push_subscription', {
      method: 'POST',
      body: JSON.stringify({ p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth,
                             p_user_agent: String(navigator.userAgent || '').slice(0, 300) })
    }).then(json);
  }

  function pushChipTapped() {
    var s = push.state;
    if (s === 'off' || s === 'error') { turnOnPush(); return; }
    if (s === 'on') { toast('Notifications are on for this device.'); return; }
    if (s === 'denied') {
      toast(isIOS() ? 'Notifications are switched off for MIC Staff. Turn them on in the iPad Settings → Notifications → MIC Staff.'
                    : 'Notifications are blocked for this site. Allow them in the browser’s site settings, then reload.', 8000);
      return;
    }
    if (s === 'install') { toast('To get notifications, add this page to the Home Screen: Share → Add to Home Screen. Then open it from there.', 8000); return; }
    if (s === 'notset') {
      toast('Notifications are not switched on for MIC yet. An admin does this once in the booking console, under Staff. New tasks still ring here while the screen is on.', 9000);
      fetchKey().then(function (k) { if (k) checkPush(); });
      return;
    }
    if (s === 'unsupported') toast('This browser cannot receive notifications. Keep this screen open: new tasks still ring here.', 7000);
  }

  function onWorkerMessage(e) {
    var d = e.data || {};
    if (d.type === 'mic-push') poll();
    if (d.type === 'mic-open') {
      var m = /#task-([0-9a-f-]{36})/i.exec(d.url || '');
      if (m) { focusAfterLoad = m[1]; poll(); }
    }
  }

  /* ------------------------------------------------------ start shift -- */
  function startShift() {
    // These three need the tap itself, so they go first, before anything waits.
    if (push.state === 'off' || push.state === 'error') turnOnPush();
    unlockAudio();
    keepAwake();
    started = true;
    $('stStartBar').hidden = true;
    toast('Shift started. New tasks will ring.');
  }

  /* -------------------------------------------------- mark a task done -- */
  function sheetMsg(html, kind) {
    $('sheetMsg').innerHTML = html ? '<div class="bk-msg bk-msg--' + (kind || 'err') + '" style="margin:12px 0 0;">' + html + '</div>' : '';
  }
  function setBar(f) {
    $('sheetBar').hidden = f == null;
    $('sheetBar').firstElementChild.style.width = Math.round((f || 0) * 100) + '%';
  }
  function clearProof() {
    if (sheet.url) URL.revokeObjectURL(sheet.url);
    sheet.file = null; sheet.kind = null; sheet.ready = null; sheet.url = null;
    $('sheetFile').value = '';
    $('sheetPrev').hidden = true; $('sheetPrev').innerHTML = '';
    $('sheetPick').hidden = false;
  }
  function openSheet(id) {
    var t = findTask(id);
    if (!t || t.status !== 'open') { toast('That task has already been done.'); return; }
    if (sheet.url) URL.revokeObjectURL(sheet.url);
    sheet = { task: t, busy: false };
    $('sheetTask').textContent = t.title;
    $('sheetNote').value = '';
    clearProof(); sheetMsg(''); setBar(null);
    $('sheetGo').disabled = false; $('sheetGo').textContent = 'Mark as done';
    $('stSheet').hidden = false;
  }
  function closeSheet() {
    if (sheet.busy) return;
    clearProof();
    $('stSheet').hidden = true;
  }

  function pickFile() {
    var f = $('sheetFile').files && $('sheetFile').files[0];
    sheetMsg('');
    if (!f) return;
    var kind = /^video\//.test(f.type) ? 'video' : /^image\//.test(f.type) ? 'image' : null;
    if (!kind) { clearProof(); sheetMsg('That file is not a photo or a video.'); return; }
    if (kind === 'video' && f.size > MAX_VIDEO) {
      clearProof(); sheetMsg('That video is too big to send (over 50 MB). A shorter clip of about 30 seconds works.'); return;
    }
    if (sheet.url) URL.revokeObjectURL(sheet.url);
    sheet.file = f; sheet.kind = kind; sheet.url = URL.createObjectURL(f);
    sheet.ready = kind === 'image' ? shrink(f) : Promise.resolve(f);
    $('sheetPrev').innerHTML = (kind === 'image'
      ? '<img alt="The photo you picked" src="' + sheet.url + '" />'
      : '<video src="' + sheet.url + '" controls playsinline muted></video>') +
      '<button type="button" id="sheetRemove">Remove</button>';
    $('sheetPrev').hidden = false; $('sheetPick').hidden = true;
    $('sheetRemove').addEventListener('click', function () { if (!sheet.busy) clearProof(); });
  }

  // Phone and tablet photos are several megabytes. 1600 px is plenty to prove a job was done.
  function shrink(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, 1600 / Math.max(w, h));
          if (k === 1 && file.size < 1500000 && file.type === 'image/jpeg') { URL.revokeObjectURL(url); resolve(file); return; }
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          c.toBlob(function (b) { URL.revokeObjectURL(url); resolve(b && b.size < file.size ? b : file); }, 'image/jpeg', 0.82);
        } catch (_) { URL.revokeObjectURL(url); resolve(file); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };   // a format this browser cannot draw: send as is
      img.src = url;
    });
  }

  var EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp', 'image/gif': 'gif',
              'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp' };
  function upload(taskId, blob, kind) {
    var type = blob.type || (kind === 'video' ? 'video/mp4' : 'image/jpeg');
    var path = 'tasks/' + taskId + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' +
               (EXT[type] || (kind === 'video' ? 'mp4' : 'jpg'));
    return ensureFresh().then(function () {
      return new Promise(function (resolve, reject) {
        var x = new XMLHttpRequest();
        x.open('POST', SUPABASE_URL + '/storage/v1/object/task-proof/' + path);
        x.setRequestHeader('apikey', SUPABASE_ANON_KEY);
        x.setRequestHeader('Authorization', 'Bearer ' + S.access_token);
        x.setRequestHeader('Content-Type', type);
        x.setRequestHeader('x-upsert', 'false');
        x.upload.onprogress = function (e) { if (e.lengthComputable) setBar(e.loaded / e.total); };
        x.onload = function () {
          if (x.status >= 200 && x.status < 300) resolve(path);
          else reject(new Error('Upload refused (HTTP ' + x.status + '): ' + String(x.responseText || '').slice(0, 200)));
        };
        x.onerror = function () { reject(new Error('Upload failed: no connection')); };
        x.send(blob);
      });
    });
  }

  function complete(taskId, note, path, kind) {
    return api('/rest/v1/rpc/complete_staff_task', {
      method: 'POST',
      body: JSON.stringify({ p_task: taskId, p_note: note || null, p_proof_path: path || null, p_proof_type: path ? kind : null })
    }).then(json);
  }

  function submitDone(skipProof) {
    if (sheet.busy || !sheet.task) return;
    var t = sheet.task, note = $('sheetNote').value.trim(), kind = sheet.kind;
    var go = $('sheetGo');
    sheet.busy = true; go.disabled = true; sheetMsg('');
    var proof = (!skipProof && sheet.ready)
      ? sheet.ready.then(function (blob) {
          go.textContent = kind === 'video' ? 'Sending video…' : 'Sending photo…';
          setBar(0);
          return upload(t.id, blob, kind);
        })
      : Promise.resolve(null);

    proof.then(function (path) {
      go.textContent = 'Saving…';
      return complete(t.id, note, path, kind).then(function () {
        sheet.busy = false;
        t.status = 'done'; t.done_at = new Date().toISOString(); t.done_by = S && S.email; t.proof_type = path ? kind : null;
        closeSheet(); render();
        toast('Done. Thank you!');
        poll();
      }, function (e) {
        sheet.busy = false; go.disabled = false; go.textContent = 'Mark as done'; setBar(null);
        if (e && e.signedOut) { signOut(); loginMsg('Your sign-in has expired. Please sign in again.'); return; }
        if (e && e.code === 'P0002') { closeSheet(); toast('Someone else already marked that done.'); poll(); return; }
        console.error('Could not complete the task:', e);
        sheetMsg(e && e.offline ? 'No connection. Check the Wi-Fi and tap Mark as done again.' : 'That did not save. Try again in a moment.');
      });
    }, function (e) {
      // The photo or video did not go up. Offer to finish without it.
      console.error(e);
      sheet.busy = false; go.disabled = false; go.textContent = 'Try again'; setBar(null);
      sheetMsg((e && /no connection|offline/i.test(e.message) ? 'The ' + (kind === 'video' ? 'video' : 'photo') + ' could not be sent: no connection.'
               : 'The ' + (kind === 'video' ? 'video' : 'photo') + ' could not be sent.') +
               ' <button type="button" class="st-link" id="sheetNoProof" style="display:inline;width:auto;padding:0 4px;margin:0;">Mark done without it</button>', 'warn');
      var b = $('sheetNoProof');
      if (b) b.addEventListener('click', function () { submitDone(true); });
    });
  }

  /* ------------------------------------------------------------ start -- */
  function init() {
    $('stForm').addEventListener('submit', signIn);
    $('stOut').addEventListener('click', askSignOut);
    $('stStartGo').addEventListener('click', startShift);
    $('chipPush').addEventListener('click', pushChipTapped);
    $('chipWake').addEventListener('click', function () {
      if (wakeLock) { toast('The screen will stay on while this page is open.'); return; }
      keepAwake();
      setTimeout(function () {
        if (!wakeLock) toast('This device will not keep the screen on by itself. In Settings → Display & Brightness, set Auto-Lock to Never.', 8000);
      }, 900);
    });
    $('stSkipInstall').addEventListener('click', function () {
      lsSet(LS_SAFARI, 1); $('stInstall').hidden = true; $('stLogin').hidden = false;
    });
    $('sheetCancel').addEventListener('click', closeSheet);
    $('sheetGo').addEventListener('click', function () { submitDone(false); });
    $('sheetFile').addEventListener('change', pickFile);
    $('stSheet').addEventListener('click', function (e) { if (e.target === $('stSheet')) closeSheet(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('stSheet').hidden) closeSheet(); });

    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', onWorkerMessage);
    registerWorker();

    // Back from sleep or from another app: catch up at once instead of waiting for the next poll.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible' || !S) return;
      if (started && !wakeLock) keepAwake();
      poll();
    });
    window.addEventListener('online', function () { if (S) poll(); });
    // a task link opened while this screen is already up
    window.addEventListener('hashchange', function () {
      var m = /^#task-([0-9a-f-]{36})$/i.exec(location.hash || '');
      if (m && S) { focusAfterLoad = m[1]; poll(); }
    });
    setInterval(function () { if (S) { tick(); renderBookings(); } }, 15000);

    var hash = /^#task-([0-9a-f-]{36})$/i.exec(location.hash || '');
    if (hash) focusAfterLoad = hash[1];

    S = lsGet(LS_SESSION);
    if (S && S.refresh_token) { enter(); return; }
    S = null;
    if (isIOS() && !isInstalled() && !lsGet(LS_SAFARI)) { $('stInstall').hidden = false; return; }
    $('stLogin').hidden = false;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
