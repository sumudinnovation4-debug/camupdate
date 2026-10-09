// POST { callee_id, call_channel, video }   Authorization: Bearer <supabase access token>
// Called by call.html the moment a caller starts ringing. The in-app ring
// (Supabase realtime) only reaches someone who has the app open; this sends a
// real device push so the callee's phone/browser rings even when Camplugie is
// closed — same idea as a WhatsApp call.
const { supabaseAdmin, setCors, sendPush, authedUserId } = require('./_lib');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const sb = supabaseAdmin();
    const callerId = await authedUserId(sb, req);
    if (!callerId) return res.status(401).json({ error: 'Unauthorized' });

    const { callee_id, call_channel, video } = req.body || {};
    if (!callee_id || !call_channel || callee_id === callerId) return res.status(400).json({ error: 'Bad request' });

    const { data: blocked } = await sb.from('user_blocks').select('id')
      .eq('blocker_id', callee_id).eq('blocked_id', callerId).maybeSingle();
    if (blocked) return res.status(200).json({ ok: true, skipped: true });

    const { data: caller } = await sb.from('profiles').select('full_name, username').eq('id', callerId).maybeSingle();
    const name = caller?.full_name || caller?.username || 'Someone';

    // Same URL the in-app Answer button builds (see incoming-call.js) minus auto=1,
    // so tapping the push lands on call.html's own Answer / Decline screen. The caller
    // keeps re-sending the offer for ~35s, so answering from a push still connects.
    const url = `/call.html?peer=${callerId}&name=${encodeURIComponent(name)}` +
      `&role=callee&channel=${encodeURIComponent(call_channel)}&mode=${video ? 'video' : 'audio'}`;

    await sendPush(sb, callee_id, {
      title: `${video ? '📹 Video' : '📞 Voice'} call`,
      body: `${name} is calling you…`,
      url, type: 'call', tag: `call-${callerId}`,
      requireInteraction: true, ttl: 45, urgency: 'high',
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('notify-call error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
