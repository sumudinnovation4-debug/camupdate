// POST { reply_token, call_channel }
// Sent by the Android app when someone taps "Decline" on a call notification. It tells the caller's
// screen "Call declined" through the same live channel the in-app Decline button uses.
const { supabaseAdmin, setCors } = require('../_lib');
const { userForReplyToken, tooMany } = require('./_device');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { reply_token, call_channel } = req.body || {};
    if (!/^call-[0-9a-f-]{36}$/i.test(String(call_channel || ''))) return res.status(400).json({ error: 'Bad call.' });
    const sb = supabaseAdmin();
    const userId = await userForReplyToken(sb, reply_token);
    if (!userId) return res.status(401).json({ error: 'This phone is not signed in.' });
    if (tooMany('cd:' + userId, 20, 60 * 1000)) return res.status(429).json({ error: 'Slow down a little.' });

    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const r = await fetch(`${process.env.SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ topic: call_channel, event: 'signal', payload: { kind: 'declined', from: userId }, private: false }] }),
    });
    if (!r.ok) console.warn('call-decline broadcast status', r.status);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('call-decline error:', err.message);
    return res.status(200).json({ ok: false });       // declining must never show an error to the user
  }
};
