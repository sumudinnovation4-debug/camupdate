// Called by a Supabase Database Webhook every time a row is inserted into
// `notifications` — from ANY code path (notifySeller, a future "like"
// notification, an admin action, anything). This is what makes every
// notification a real device push, WhatsApp-style, instead of only the
// ones a developer remembered to wire up individually.
//
// Set up the webhook once in Supabase: Dashboard → Database → Webhooks →
// Create a new webhook
//   Table: notifications        Events: Insert
//   Type: HTTP Request          Method: POST
//   URL: https://<your-domain>/api/send-push
//   Headers: x-webhook-secret: <same value as PUSH_WEBHOOK_SECRET env var>
// (See PLAY_STORE_CHECKLIST.md / the notifications section for the full
// walkthrough.)
const { supabaseAdmin, sendPush } = require('./_lib');

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

    const sb = supabaseAdmin();
    await sendPush(sb, row.user_id, {
      title: row.title || 'Camplugie',
      body: row.body || '',
      url: row.data?.url,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('send-push failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
