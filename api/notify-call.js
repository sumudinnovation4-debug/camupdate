// POST { peer_id, caller_id, video }
// Called by call.html right after it broadcasts on the `ring-<peerId>`
// realtime channel (fire-and-forget). The realtime broadcast only reaches
// the other person if their browser tab is already open and subscribed —
// this is the fallback that reaches their device as a real push when it
// isn't, same as a WhatsApp call notification. Looks the caller's name up
// server-side rather than trusting the client-supplied one.
const { supabaseAdmin, setCors, notifySeller } = require('./_lib');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { peer_id, caller_id, video } = req.body;
    if (!peer_id || !caller_id) {
      return res.status(400).json({ error: 'Missing peer_id or caller_id' });
    }
    if (peer_id === caller_id) return res.status(200).json({ ok: true, skipped: true });

    const sb = supabaseAdmin();

    const { data: blocked } = await sb.from('user_blocks').select('id')
      .eq('blocker_id', peer_id).eq('blocked_id', caller_id).maybeSingle();
    if (blocked) return res.status(200).json({ ok: true, skipped: true });

    const { data: caller } = await sb.from('profiles').select('full_name, username').eq('id', caller_id).maybeSingle();
    const callerName = caller?.full_name || caller?.username || 'Someone';

    await notifySeller(sb, {
      sellerId: peer_id,
      type: 'call',
      title: `📞 Incoming ${video ? 'video ' : ''}call from ${callerName}`,
      body: 'Open Camplugie to answer.',
      url: `/yard.html`,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('notify-call error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
