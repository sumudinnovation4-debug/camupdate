// Called by a Supabase Database Webhook every time a row is inserted into
// `notifications` — from ANY code path (server helper, DB trigger for likes /
// comments / follows / swift / wallet, an admin action, anything). This is what
// makes every notification a real device push, WhatsApp-style.
//
// The webhook is created by sql/camplugie-notifications.sql (section 6), or by
// hand: Supabase → Database → Webhooks → table `notifications`, event Insert,
// POST https://<your-domain>/api/send-push, header
// x-webhook-secret: <same value as the PUSH_WEBHOOK_SECRET env var>.
const { supabaseAdmin, sendPush, urlForNotification } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Anyone who guesses this URL could otherwise spam pushes to your users —
  // require the shared secret the webhook sends as a header.
  if (!process.env.PUSH_WEBHOOK_SECRET || req.headers['x-webhook-secret'] !== process.env.PUSH_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const row = req.body?.record;
    if (!row || !row.user_id) return res.status(200).json({ ok: true, skipped: 'no record' });

    const d = row.data || {};
    // Same thing in the same place collapses into one banner (like WhatsApp);
    // different things stack. Falls back to the row id so nothing is ever dropped.
    const target = d.conversation_id || d.group_id || d.post_id || d.listing_id || d.order_id || d.profile_id || row.id;
    const isCall = row.type === 'call';

    const sb = supabaseAdmin();
    await sendPush(sb, row.user_id, {
      title: row.title || 'Camplugie',
      body: row.body || '',
      url: urlForNotification(row),
      type: row.type,
      tag: `${row.type || 'n'}-${target}`,
      data: { notification_id: row.id },
      requireInteraction: isCall,
      ttl: isCall ? 45 : undefined,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('send-push failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
