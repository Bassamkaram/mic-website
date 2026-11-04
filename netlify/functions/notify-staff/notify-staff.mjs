// POST /.netlify/functions/notify-staff   { "task_id": "<uuid>" }
//   Sends a push notification about one task to the staff who should see it.
//   Called by the booking console straight after an admin creates a task.
//
// GET /.netlify/functions/notify-staff
//   { ready, publicKey } — whether sending is set up, and the public key the
//   staff tablet subscribes with. Public information; no sign-in needed.
//
// It holds no database secret. It acts with the caller's own sign-in, so the
// database decides everything: only an admin can read a task's push targets,
// and a stranger calling this URL gets nothing but a 401 or 403.
//
// Environment variables on Netlify. The pair is made in the admin's own
// browser (console, Staff tab) and pasted in by them; nobody else handles it.
//   VAPID_PUBLIC_KEY   (65-byte P-256 point, base64url)
//   VAPID_PRIVATE_KEY  (32-byte P-256 scalar, base64url — secret)
//   VAPID_SUBJECT      (optional mailto: address push services may contact)

import crypto from 'node:crypto';
import { sendPush } from './webpush.mjs';

const SUPABASE_URL = 'https://xnegzvpuagxgahlbtzaf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhuZWd6dnB1YWd4Z2FobGJ0emFmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzODk0NDIsImV4cCI6MjA5Mzk2NTQ0Mn0.RXBD_LxrZiv0tQfX7W6S9wT8JKNMPd5xB3LBlV50lAE';

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

function dueText(iso) {
  if (!iso) return '';
  try {
    return 'Due ' + new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Asia/Beirut', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
}

// Are both keys there, and do they belong together? A pasting slip shows up
// here, not as a mysterious refusal from Apple or Google later.
function keyStatus() {
  const pub = String(process.env.VAPID_PUBLIC_KEY || '').trim();
  const priv = String(process.env.VAPID_PRIVATE_KEY || '').trim();
  if (!pub || !priv) return { ready: false, problem: 'missing', pub, priv };
  try {
    const e = crypto.createECDH('prime256v1');
    e.setPrivateKey(Buffer.from(priv, 'base64url'));
    if (e.getPublicKey().toString('base64url') !== pub) return { ready: false, problem: 'mismatch', pub, priv };
  } catch { return { ready: false, problem: 'invalid', pub, priv }; }
  return { ready: true, pub, priv };
}
const NOT_READY = {
  missing: 'Notifications are not set up yet. Finish the setup in the console, under Staff.',
  mismatch: 'The two notification keys in Netlify do not belong together. Make a new pair in the console, under Staff, and paste both again.',
  invalid: 'The notification key in Netlify is not valid. Make a new pair in the console, under Staff.',
};

export default async (req) => {
  if (req.method === 'GET') {
    const k = keyStatus();
    return json(200, k.ready ? { ready: true, publicKey: k.pub } : { ready: false, problem: k.problem });
  }
  if (req.method !== 'POST') return json(405, { error: 'GET or POST only' });

  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+$/.test(auth)) return json(401, { error: 'Sign in first.' });

  let input;
  try { input = await req.json(); } catch { return json(400, { error: 'Expected a JSON body.' }); }
  const taskId = String((input && input.task_id) || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) {
    return json(400, { error: 'task_id is required.' });
  }

  const k = keyStatus();
  if (!k.ready) return json(503, { error: NOT_READY[k.problem] });
  const vapid = {
    publicKey: k.pub,
    privateKey: k.priv,
    subject: String(process.env.VAPID_SUBJECT || '').trim() || 'mailto:info@mic-lb.com',
  };

  const h = { apikey: SUPABASE_ANON_KEY, Authorization: auth, 'Content-Type': 'application/json' };
  const rest = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: h, ...opts });

  // 1. Only admins send. The database answers that, from the caller's own sign-in.
  const who = await rest('rpc/is_booking_staff', { method: 'POST', body: '{}' });
  if (who.status === 401) return json(401, { error: 'Your session has expired. Sign in again.' });
  if (!who.ok || (await who.json()) !== true) return json(403, { error: 'Only admins can notify staff.' });

  // 2. The task, read with the same sign-in.
  const t = await rest(`staff_tasks?id=eq.${taskId}&select=id,title,details,priority,due_at,assigned_to,status`);
  const tasks = t.ok ? await t.json() : [];
  if (!tasks.length) return json(404, { error: 'Task not found.' });
  const task = tasks[0];
  if (task.status !== 'open') return json(200, { sent: 0, devices: 0, note: 'Task is already done.' });

  // 3. Who: the assignee if there is one, otherwise every active viewer.
  const staffQuery = task.assigned_to
    ? `email=eq.${encodeURIComponent(task.assigned_to)}&active=eq.true`
    : 'role=eq.viewer&active=eq.true';
  const st = await rest(`booking_staff?${staffQuery}&select=email`);
  const emails = st.ok ? (await st.json()).map((r) => r.email) : [];
  if (!emails.length) return json(200, { sent: 0, devices: 0, note: 'No staff to notify.' });

  const inList = encodeURIComponent('(' + emails.map((e) => `"${e.replace(/"/g, '')}"`).join(',') + ')');
  const sb = await rest(`push_subscriptions?email=in.${inList}&select=endpoint,p256dh,auth,email`);
  const subs = sb.ok ? await sb.json() : [];
  if (!subs.length) return json(200, { sent: 0, devices: 0, note: 'No device has notifications switched on yet.' });

  // 4. Send to every device at once.
  const urgent = task.priority === 'urgent';
  const payload = {
    title: (urgent ? 'Urgent: ' : 'New task: ') + task.title,
    body: [task.details, dueText(task.due_at)].filter(Boolean).join(' — ').slice(0, 240) || 'Open the staff screen for details.',
    url: '/staff.html#task-' + task.id,
    tag: 'task-' + task.id,
    urgent,
  };
  const results = await Promise.all(subs.map((s) =>
    sendPush(s, payload, vapid, { urgency: urgent ? 'high' : 'normal' })
      .catch((e) => ({ status: -1, gone: false, error: String(e && e.message || e) }))));

  // 5. Forget devices the push service says are gone.
  const gone = subs.filter((_, i) => results[i].gone);
  await Promise.all(gone.map((s) =>
    rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'DELETE' }).catch(() => null)));

  const sent = results.filter((r) => r.status >= 200 && r.status < 300).length;
  return json(200, {
    sent, devices: subs.length, removed: gone.length,
    failed: results.filter((r) => !(r.status >= 200 && r.status < 300) && !r.gone).map((r) => r.status),
  });
};
