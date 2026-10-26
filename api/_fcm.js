// Sends pushes to the Camplugie Android app through Firebase Cloud Messaging (FCM, HTTP v1).
// Needs ONE Vercel environment variable: FIREBASE_SERVICE_ACCOUNT = the whole JSON file you
// download from Firebase → Project settings → Service accounts → "Generate new private key".
// Without it this module simply reports "not ready" and web push keeps working as before.
//
// `google-auth-library` is required lazily, inside the function that needs it, so a missing
// package can never stop the payment routes (which share _lib.js) from loading.

let cached = null;
let jwtClient = null;

function account() {
  if (cached !== null) return cached || null;
  cached = false;
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) return null;
  try {
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');   // plain JSON or base64 of it
    const j = JSON.parse(text);
    if (!j.client_email || !j.private_key || !j.project_id) return null;
    j.private_key = String(j.private_key).replace(/\\n/g, '\n');
    cached = j;
  } catch (e) { console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON:', e.message); }
  return cached || null;
}

const ready = () => !!account();
const status = () => { const a = account(); return { ready: !!a, project: a ? a.project_id : null }; };

async function accessToken() {
  const a = account();
  if (!jwtClient) {
    const { JWT } = require('google-auth-library');
    jwtClient = new JWT({ email: a.client_email, key: a.private_key, scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
  }
  const t = await jwtClient.getAccessToken();
  return typeof t === 'string' ? t : t.token;
}

// Which Android notification channel (created by the app on first launch) each kind of push lands in.
const CHANNEL = {
  message: 'messages', group_message: 'messages', mention: 'messages', group_added: 'messages',
  call: 'calls', group_call: 'calls',
};
const channelFor = (type) => CHANNEL[type] || 'updates';

// Chats and calls are sent as plain data to phones running the app version with notification
// buttons (Reply / Answer / Decline), so the app can build the notification itself. Everyone else
// still gets the ordinary notification the phone shows on its own.
const ACTIONABLE = new Set(['message', 'group_message', 'mention', 'call', 'group_call']);
const wantsData = (type) => ACTIONABLE.has(type);

// FCM "data" values must all be strings.
const strs = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));

function buildMessage(token, msg, opts = {}) {
  const isCall = msg.type === 'call' || msg.type === 'group_call';
  const ttl = Math.max(30, msg.ttl || 86400);
  const common = { url: msg.url || '/notifications.html', type: msg.type || 'general', tag: msg.tag || '', ts: Date.now(), ev: msg.eventAt ? new Date(msg.eventAt).getTime() : '' };
  if (opts.dataOnly) {
    return {
      message: {
        token,
        data: strs({ cp: '1', title: String(msg.title || 'Camplugie').slice(0, 100), body: String(msg.body || '').slice(0, 180), ...common, ...(msg.data || {}) }),
        android: { priority: 'HIGH', ttl: `${ttl}s`, ...(msg.tag ? { collapse_key: String(msg.tag).slice(0, 60) } : {}) },
      },
    };
  }
  return {
    message: {
      token,
      notification: { title: String(msg.title || 'Camplugie').slice(0, 100), body: String(msg.body || '').slice(0, 180) },
      data: strs({ ...common, ...(msg.data || {}) }),
      android: {
        priority: (msg.urgency || 'high') === 'high' ? 'HIGH' : 'NORMAL',
        ttl: `${ttl}s`,
        ...(msg.tag ? { collapse_key: String(msg.tag).slice(0, 60) } : {}),
        notification: {
          channel_id: channelFor(msg.type),
          ...(msg.tag ? { tag: String(msg.tag).slice(0, 60) } : {}),           // same tag = replaces the previous alert
          color: '#7C3AED',
          visibility: 'PUBLIC',
          notification_priority: isCall ? 'PRIORITY_MAX' : 'PRIORITY_HIGH',
          default_sound: true,
          default_vibrate_timings: true,
          sticky: false,
        },
      },
    },
  };
}

// Sends one message to one phone. Returns { ok, dead, status, error }.
async function sendOne(token, msg, bearer, opts = {}) {
  const a = account();
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildMessage(token, msg, opts)),
  });
  if (res.ok) return { ok: true };
  let body = {};
  try { body = await res.json(); } catch (_) {}
  const code = body && body.error && body.error.details && body.error.details.find(d => d.errorCode) ;
  const errorCode = (code && code.errorCode) || (body.error && body.error.status) || '';
  // UNREGISTERED = app uninstalled / token expired. INVALID_ARGUMENT on a token = malformed.
  const dead = res.status === 404 || errorCode === 'UNREGISTERED' || (res.status === 400 && /token/i.test(JSON.stringify(body.error || {})));
  return { ok: false, dead, status: res.status, error: String((body.error && body.error.message) || errorCode || res.status).slice(0, 160) };
}

module.exports = { ready, status, accessToken, buildMessage, sendOne, channelFor, wantsData };
