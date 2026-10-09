// Shared helpers for all /api/paystack-* and /api/wallet-* functions.
// These run server-side on Vercel only — never imported by frontend code.

const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');

// Web Push — VAPID_PUBLIC_KEY must match the key hardcoded in pwa.js.
// VAPID_PRIVATE_KEY is a secret: set it as a Vercel env var, never commit it.
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:info@camplugie.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
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

// Maps a notification row to the page a tap should open. Mirrors targetFor()
// in notifications.html so a push opens the exact same place the in-app row would.
function urlForNotification(row) {
  const d = row.data || {};
  if (d.url) return d.url;
  if (row.type === 'message' && d.conversation_id) return `/chat-thread.html?id=${d.conversation_id}`;
  if (d.group_id && ['group', 'mention'].includes(row.type)) return `/group-thread.html?id=${d.group_id}`;
  if (d.listing_id) return `/listing.html?id=${d.listing_id}`;
  if (d.post_id) return `/yard.html?post=${d.post_id}`;
  if (d.order_id || ['order', 'escrow', 'payment', 'delivery'].includes(row.type)) return '/orders.html';
  if (row.type === 'wallet') return '/wallet.html';
  if (d.profile_id) return `/profile-view.html?id=${d.profile_id}`;
  return '/notifications.html';
}

// Which of the user's settings.html toggles governs each notification type.
// Anything not listed (system, call…) is always delivered.
const PREF_FOR_TYPE = {
  message: 'notify_messages', group: 'notify_messages', mention: 'notify_messages',
  order: 'notify_orders', payment: 'notify_orders', escrow: 'notify_orders', delivery: 'notify_orders', wallet: 'notify_orders',
  like: 'notify_yard', comment: 'notify_yard', repost: 'notify_yard', plug: 'notify_yard',
};

// Pushes a real device notification to every device this user has ever
// subscribed on (push_subscriptions can hold several rows per user — one
// per browser/device). A dead subscription (410 Gone / 404) is deleted so
// it stops being retried on every future notification.
//
// `tag` makes pushes WhatsApp-like: same tag = replaces the previous one
// (e.g. 5 messages in one chat collapse into one), different tag = stacks.
async function sendPush(sb, userId, { title, body, url, type, tag, data, ttl, urgency, requireInteraction, actions }) {
  if (!process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_PUBLIC_KEY) {
    console.warn('sendPush: VAPID keys not set — push skipped');
    return;
  }
  try {
    // Respect the toggles on settings.html (only an explicit `false` turns something off).
    const { data: prof } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (prof) {
      if (prof.push_enabled === false) return;
      const prefKey = PREF_FOR_TYPE[type];
      if (prefKey && prof[prefKey] === false) return;
    }

    const { data: subs } = await sb.from('push_subscriptions').select('*').eq('user_id', userId);
    if (!subs || !subs.length) return;

    const payload = JSON.stringify({
      title, body: body || '', url: url || '/notifications.html', type: type || 'system',
      tag: tag || `${type || 'camplugie'}-${Date.now()}`, data: data || {}, requireInteraction: !!requireInteraction, actions: actions || [],
    });
    // urgency:'high' is what lets Android deliver instantly even in Doze/battery-saver — without it
    // pushes can arrive minutes late, which is the opposite of WhatsApp.
    const opts = { TTL: ttl ?? 60 * 60 * 24, urgency: urgency || 'high' };

    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, opts);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        } else {
          console.error('sendPush: delivery failed:', err.statusCode, err.message);
        }
      }
    }));
  } catch (err) {
    console.error('sendPush failed:', err.message);
  }
}

// Verifies the caller's Supabase access token (Authorization: Bearer …) and
// returns their user id, or null. Used by endpoints the browser calls directly.
async function authedUserId(sb, req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await sb.auth.getUser(token);
  return error ? null : (data?.user?.id || null);
}

// Writes the in-app notification row and (optionally) emails the user. The
// device push is handled separately by a Supabase Database Webhook that fires
// on every INSERT into `notifications` (see sql/camplugie-notifications.sql +
// /api/send-push.js) — that way ANY notification, from this function or any
// DB trigger (likes, comments, follows, swift status, wallet…), pushes
// automatically. `url` is stored in `data.url` so a tap goes to the right place.
// Pass email:false for high-frequency events (chat messages) — nobody wants an
// email per message.
async function notifySeller(sb, { sellerId, type = 'order', title, body, url, data = {}, email = true }) {
  try {
    const { error } = await sb.from('notifications').insert({
      user_id: sellerId, type, title, body, is_read: false,
      data: url ? { ...data, url } : data,
    });
    if (error) console.error('notifySeller: in-app notification insert failed:', error.message);
  } catch (err) {
    console.error('notifySeller: in-app notification failed:', err.message);
  }

  if (!email) return;
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

module.exports = { supabaseAdmin, paystack, computeCommission, setCors, notifySeller, sendPush, urlForNotification, authedUserId, payAmbassadorCommission, finalizeOrderPaid, COMMISSION_RATE, AMBASSADOR_SHARE };
        
