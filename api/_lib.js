// Shared helpers for all /api/paystack-* and /api/wallet-* functions.
// These run server-side on Vercel only — never imported by frontend code.

const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');

// Web Push — VAPID_PUBLIC_KEY must match the key hardcoded in pwa.js.
// VAPID_PRIVATE_KEY is a secret: set it as a Vercel env var, never commit it.
// Keys pasted into Vercel often carry a stray space / newline / quote, so they are
// cleaned here. A bad key must NEVER crash this file — it is imported by the payment
// routes too — so any problem is recorded in `vapid.error` instead of thrown.
const cleanEnv = (v) => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
const vapid = {
  publicKey: cleanEnv(process.env.VAPID_PUBLIC_KEY),
  privateKey: cleanEnv(process.env.VAPID_PRIVATE_KEY),
  ready: false,
  error: null,
};
if (vapid.publicKey && vapid.privateKey) {
  try {
    webpush.setVapidDetails(cleanEnv(process.env.VAPID_SUBJECT) || 'mailto:info@camplugie.com', vapid.publicKey, vapid.privateKey);
    vapid.ready = true;
  } catch (err) { vapid.error = err.message; console.error('VAPID setup failed:', err.message); }
}
let fcm = null;
try { fcm = require('./_fcm'); } catch (e) { console.error('FCM module unavailable:', e.message); }
function fcmStatus() { return fcm ? fcm.status() : { ready: false, project: null }; }
function vapidStatus() {
  return { public: !!vapid.publicKey, private: !!vapid.privateKey, ready: vapid.ready, error: vapid.error, publicKey: vapid.publicKey };
}

const PAYSTACK_BASE = 'https://api.paystack.co';
const COMMISSION_RATE = 0.05; // 5% platform commission
const AMBASSADOR_SHARE = 0.20; // ambassadors get 20% of the platform's 5% cut, per sale their referred student makes

function supabaseAdmin() {
  // Service-role key bypasses RLS — this is the ONLY place it should be used.
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function paystack(path, options = {}) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok || data.status === false) {
    throw new Error(data.message || `Paystack error on ${path}`);
  }
  return data;
}

function computeCommission(amountKobo) {
  const commission = Math.round(amountKobo * COMMISSION_RATE);
  return { commission, payout: amountKobo - commission };
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  // 'Authorization' added so the admin dashboard — deployed on its own,
  // separate Vercel domain — can call admin-only endpoints (like
  // admin-wallet-adjust) that need to send the admin's Supabase access
  // token. Without this, the browser's CORS preflight rejects the request
  // before it ever reaches this function.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// --- Notifications (in-app + email) ---
// Sends via Resend (https://resend.com) — free tier covers 3,000 emails/month
// and, unlike Formspree, can send to any address dynamically (each seller's
// own inbox), not just one fixed address configured ahead of time.
// Requires RESEND_API_KEY and RESEND_FROM env vars (see notes at bottom of file).
async function sendEmail({ to, subject, text }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping email notification');
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'Camplugie <onboarding@resend.dev>',
      to,
      subject,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend error (${res.status}): ${body}`);
  }
}

// Which profile toggle (Settings → Notifications) governs which kind of push.
// Anything not listed here (security alerts, admin messages, tests…) always goes
// through as long as the master "push_enabled" switch is on.
const PUSH_PREF_BY_TYPE = {
  message: 'notify_messages',
  group_message: 'notify_groups', mention: 'notify_groups', group_added: 'notify_groups',
  call: 'notify_calls', group_call: 'notify_calls',
  listing: 'notify_listings', post: 'notify_posts',
  order: 'notify_orders', swift: 'notify_orders', payment: 'notify_orders', escrow: 'notify_orders',
  like: 'notify_yard', comment: 'notify_yard', follow: 'notify_yard', yard: 'notify_yard',
};

// Pushes ONE message to MANY people at once (new listing, new post, group chat, call…).
//  • 2 bulk database reads instead of 2 per person  → fast even for big campuses
//  • honours each person's Settings switches
//  • sends with limited parallelism so a big fan-out finishes inside the function time limit
//  • dead subscriptions (410/404) are deleted in one go
// msg: { title, body, url, type, tag, icon, eventAt, ttl, urgency, requireInteraction, actions, data }
// Returns { targets, users, sent, failed, skipped, errors }.
async function pushToUsers(sb, userIds, msg, opts = {}) {
  const out = { targets: 0, users: 0, sent: 0, failed: 0, native: 0, skipped: null, errors: [] };
  const webOk = vapid.ready, fcmOk = !!(fcm && fcm.ready());
  if (!webOk && !fcmOk) { out.skipped = vapid.error ? 'vapid-invalid' : 'vapid-not-configured'; return out; }
  const ids = [...new Set((userIds || []).filter(Boolean))];
  out.targets = ids.length;
  if (!ids.length) { out.skipped = 'no-recipients'; return out; }

  const prefKey = PUSH_PREF_BY_TYPE[msg.type];
  const concurrency = opts.concurrency || 40;
  const deadWeb = [], deadTokens = [];
  const webJobs = [], nativeJobs = [];
  const payload = JSON.stringify({
    title: msg.title || 'Camplugie',
    body: String(msg.body || '').slice(0, 180),
    url: msg.url || '/notifications.html',
    type: msg.type || 'general',
    tag: msg.tag || msg.type || 'camplugie',
    icon: msg.icon, ts: Date.now(), ev: msg.eventAt ? new Date(msg.eventAt).getTime() : null,
    requireInteraction: !!msg.requireInteraction, actions: msg.actions || undefined, data: msg.data || undefined,
  });
  const sendOpts = { TTL: msg.ttl || 60 * 60 * 24, urgency: msg.urgency || 'high' };

  try {
    for (let i = 0; i < ids.length; i += 150) {
      const chunk = ids.slice(i, i + 150);
      const [{ data: profs }, { data: subs }, tokRes] = await Promise.all([
        sb.from('profiles').select('*').in('id', chunk),
        webOk ? sb.from('push_subscriptions').select('*').in('user_id', chunk) : Promise.resolve({ data: [] }),
        fcmOk ? sb.from('device_tokens').select('*').in('user_id', chunk) : Promise.resolve({ data: [] }),
      ]);
      const toks = (tokRes && !tokRes.error && tokRes.data) || [];     // table not created yet → just no phones
      const allowed = new Set((profs || [])
        .filter(p => p.push_enabled !== false && (!prefKey || p[prefKey] !== false))
        .map(p => p.id));
      const hasApp = new Set(toks.map(t => t.user_id));
      const seenUsers = new Set();
      for (const t of toks) { if (allowed.has(t.user_id)) { seenUsers.add(t.user_id); nativeJobs.push(t); } }
      for (const sub of (subs || [])) {
        if (!allowed.has(sub.user_id)) continue;
        // Someone with the Android app gets their phone alerts from the app. Skip their OLD
        // phone-browser/web-app subscription, or every alert would arrive twice. Desktop
        // browsers (no "Android" in the user agent) keep working.
        if (hasApp.has(sub.user_id) && (!sub.user_agent || /android/i.test(sub.user_agent))) continue;
        seenUsers.add(sub.user_id);
        webJobs.push(sub);
      }
      out.users += seenUsers.size;
    }
    if (!webJobs.length && !nativeJobs.length) { out.skipped = 'no-subscriptions-or-switched-off'; return out; }

    const runPool = async (jobs, fn) => {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
        while (next < jobs.length) await fn(jobs[next++]);
      }));
    };
    const noteError = (status, message) => { if (out.errors.length < 5) out.errors.push({ status: status || null, message: String(message || '').slice(0, 160) }); };

    await Promise.all([
      runPool(webJobs, async (sub) => {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, sendOpts);
          out.sent++;
        } catch (err) {
          out.failed++;
          if (err.statusCode === 404 || err.statusCode === 410) deadWeb.push(sub.endpoint);
          else console.error('push delivery failed:', err.statusCode, err.message);
          noteError(err.statusCode, err.body || err.message);
        }
      }),
      (async () => {
        if (!nativeJobs.length) return;
        let bearer;
        try { bearer = await fcm.accessToken(); }
        catch (err) { out.failed += nativeJobs.length; noteError(null, 'Firebase sign-in failed: ' + err.message); console.error('FCM auth failed:', err.message); return; }
        await runPool(nativeJobs, async (t) => {
          try {
            const r = await fcm.sendOne(t.token, msg, bearer);
            if (r.ok) { out.sent++; out.native++; }
            else { out.failed++; if (r.dead) deadTokens.push(t.token); else console.error('FCM delivery failed:', r.status, r.error); noteError(r.status, r.error); }
          } catch (err) { out.failed++; noteError(null, err.message); }
        });
      })(),
    ]);

    for (let i = 0; i < deadWeb.length; i += 100) await sb.from('push_subscriptions').delete().in('endpoint', deadWeb.slice(i, i + 100)).then(() => {}, () => {});
    for (let i = 0; i < deadTokens.length; i += 100) await sb.from('device_tokens').delete().in('token', deadTokens.slice(i, i + 100)).then(() => {}, () => {});
  } catch (err) {
    console.error('pushToUsers failed:', err.message);
    out.skipped = 'error';
  }
  return out;
}

// One person (kept for the existing callers: send-push.js, push-test.js, notify-*).
async function sendPush(sb, userId, msg) {
  return pushToUsers(sb, [userId], msg);
}

// Writes the in-app notification row and emails the user. The device push
// is handled separately by a Supabase Database Webhook that fires on every
// INSERT into `notifications` (see sql/camplugie-push-webhook.sql +
// /api/send-push.js) — that way ANY notification, from this function or
// any other insert anywhere in the app (likes, comments, follows, swift
// status, admin actions...), pushes automatically with zero extra code per
// call site. `url` still gets stored in `data.url` so send-push.js and the
// notifications page both know where a tap should go.
async function notifySeller(sb, { sellerId, type = 'order', title, body, url, data = {} }) {
  try {
    await sb.from('notifications').insert({
      user_id: sellerId, type, title, body, is_read: false,
      data: url ? { ...data, url } : data,
    });
  } catch (err) {
    console.error('notifySeller: in-app notification failed:', err.message);
  }

  try {
    const { data: seller } = await sb.from('profiles').select('email').eq('id', sellerId).maybeSingle();
    if (seller?.email) {
      await sendEmail({ to: seller.email, subject: title, text: body });
    }
  } catch (err) {
    console.error('notifySeller: email failed:', err.message);
  }
}

// If this order's buyer was referred by an ambassador, credits that
// ambassador 20% of the platform's 5% commission on the sale — straight to
// their wallet, same as a seller payout. Called once per order, right when
// the order is released (see paystack-release.js). Safe to call for every
// order: it's a no-op if the buyer wasn't referred by anyone.
async function payAmbassadorCommission(sb, { buyerId, amountKobo, orderType, orderId }) {
  const { data: buyerProfile } = await sb.from('profiles').select('referred_by_ambassador_id').eq('id', buyerId).maybeSingle();
  const ambassadorId = buyerProfile?.referred_by_ambassador_id;
  if (!ambassadorId) return;

  const { data: ambassador } = await sb.from('ambassadors').select('user_id, status').eq('id', ambassadorId).maybeSingle();
  if (!ambassador || ambassador.status !== 'approved') return; // revoked ambassadors stop earning

  const platformCommission = Math.round(amountKobo * COMMISSION_RATE);
  const ambassadorCut = Math.round(platformCommission * AMBASSADOR_SHARE);
  if (ambassadorCut <= 0) return;

  const { data: wallet } = await sb.from('wallets').select('balance_kobo').eq('user_id', ambassador.user_id).maybeSingle();
  const currentBalance = wallet?.balance_kobo || 0;

  await sb.from('wallets').upsert({
    user_id: ambassador.user_id, balance_kobo: currentBalance + ambassadorCut, updated_at: new Date().toISOString(),
  });
  await sb.from('wallet_transactions').insert({
    user_id: ambassador.user_id, type: 'ambassador_commission', amount_kobo: ambassadorCut,
    note: `20% referral commission on a student's ${orderType === 'food' ? 'food order' : 'purchase'}`,
  });
  await sb.from('ambassador_earnings').insert({
    ambassador_id: ambassadorId, buyer_id: buyerId, order_type: orderType, order_id: orderId, amount_kobo: ambassadorCut,
  });
}

// Reduces listings.stock_qty by however many units this order paid for, and
// marks the listing unavailable once it hits zero.
async function decrementListingStock(sb, listingId, qty) {
  const { data: listing } = await sb.from('listings').select('stock_qty').eq('id', listingId).maybeSingle();
  if (!listing) return;
  const newStock = Math.max(0, (listing.stock_qty ?? 1) - qty);
  const updates = { stock_qty: newStock };
  if (newStock <= 0) updates.is_available = false;
  await sb.from('listings').update(updates).eq('id', listingId);
}

async function decrementStockForOrder(sb, order_type, order) {
  if (order_type === 'food') {
    for (const line of (order.items || [])) {
      if (line.listing_id) await decrementListingStock(sb, line.listing_id, line.qty || 1);
    }
    return;
  }
  if (order.listing_id) await decrementListingStock(sb, order.listing_id, order.qty || 1);
}

// Builds an order-specific message and fires the seller's in-app + email notification.
async function notifyOrderPaid(sb, order_type, order) {
  const amountNaira = (order.amount_kobo / 100).toLocaleString('en-NG');

  if (order_type === 'food') {
    const itemNames = (order.items || []).map((i) => `${i.qty}x ${i.title}`).join(', ') || 'your food listing';
    await notifySeller(sb, {
      sellerId: order.seller_id,
      title: 'New order! 🍔',
      body: `You've got a new food order for ${itemNames} — ₦${amountNaira}. Head to your orders page on Camplugie to start preparing it.`,
    });
    return;
  }

  if (order.kind === 'swift') {
    await notifySeller(sb, {
      sellerId: order.seller_id,
      title: 'New Swift delivery job 🛵',
      body: `A buyer has paid for a Swift delivery — ₦${amountNaira}. Check the Swift tab on Camplugie for pickup details.`,
    });
    return;
  }

  let itemTitle = 'your item';
  if (order.listing_id) {
    const { data: listing } = await sb.from('listings').select('title').eq('id', order.listing_id).maybeSingle();
    if (listing?.title) itemTitle = listing.title;
  }
  await notifySeller(sb, {
    sellerId: order.seller_id,
    title: 'Item sold! 🎉',
    body: `"${itemTitle}" just sold for ₦${amountNaira}. Head to Camplugie to arrange handoff with the buyer.`,
  });
}

// Runs both side-effects of an order flipping to paid, each wrapped so a
// failure in one never blocks the other or bubbles up to break the caller
// (which has already recorded the payment by the time this runs).
async function finalizeOrderPaid(sb, order_type, order) {
  try { await notifyOrderPaid(sb, order_type, order); }
  catch (err) { console.error('notifyOrderPaid failed:', err.message); }

  try { await decrementStockForOrder(sb, order_type, order); }
  catch (err) { console.error('decrementStockForOrder failed:', err.message); }
}


// ---------------------------------------------------------------------------
// WHO IS CALLING? Every route that moves money must know the caller is really signed in
// and acting for themselves — never trust a user_id sent in the request body.
// Returns the Supabase user, or sends the 401 itself and returns null.
async function requireUser(req, res, sb) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).json({ error: 'Please sign in again.' }); return null; }
  const { data } = await sb.auth.getUser(token);
  if (!data || !data.user) { res.status(401).json({ error: 'Your session has expired — please sign in again.' }); return null; }
  return data.user;
}
async function isAdminUser(sb, userId) {
  const { data } = await sb.from('profiles').select('is_admin').eq('id', userId).maybeSingle();
  return !!(data && data.is_admin);
}
// True when `userId` is a person on this order (buyer, seller, Swift runner, vendor… — any
// *_id column on the order row) or an admin. A stranger who merely knows an order id is not.
async function canActOnOrder(sb, order, userId) {
  const parties = Object.entries(order || {}).filter(([k, v]) => /_id$/.test(k) && k !== 'id' && typeof v === 'string').map(([, v]) => v);
  if (parties.includes(userId)) return true;
  return isAdminUser(sb, userId);
}

module.exports = { supabaseAdmin, paystack, computeCommission, setCors, notifySeller, sendPush, pushToUsers, fcmStatus, requireUser, isAdminUser, canActOnOrder, payAmbassadorCommission, finalizeOrderPaid, COMMISSION_RATE, AMBASSADOR_SHARE, vapidStatus };
