// POST { peer_id, video, call_channel }   Authorization: Bearer <caller's access token>
// call.html calls this the moment it starts ringing someone, so their phone rings even
// if Camplugie is closed (the in-app ring only works while the app is open).
const { supabaseAdmin, setCors, pushToUsers } = require('../_lib');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const sb = supabaseAdmin();
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const { data: auth } = token ? await sb.auth.getUser(token) : { data: null };
    const callerId = auth && auth.user && auth.user.id;
    if (!callerId) return res.status(401).json({ error: 'Not signed in' });

    const { peer_id, video, call_channel } = req.body || {};
    if (!peer_id || !call_channel || peer_id === callerId) return res.status(400).json({ error: 'Missing peer_id or call_channel' });

    const { data: blocked } = await sb.from('user_blocks').select('id').eq('blocker_id', peer_id).eq('blocked_id', callerId).maybeSingle();
    if (blocked) return res.status(200).json({ ok: true, skipped: 'blocked' });

    const { data: me } = await sb.from('profiles').select('full_name, username').eq('id', callerId).maybeSingle();
    const name = (me && (me.full_name || me.username)) || 'Someone';
    const r = await pushToUsers(sb, [peer_id], {
      title: `${video ? '📹' : '📞'} ${name}`,
      body: `Incoming ${video ? 'video' : 'voice'} call — tap to answer`,
      url: `/call.html?peer=${callerId}&name=${encodeURIComponent(name)}&role=callee&channel=${encodeURIComponent(call_channel)}&mode=${video ? 'video' : 'audio'}&auto=1`,
      type: 'call', tag: `call:${call_channel}`, eventAt: new Date().toISOString(),
      data: { call_channel, caller_id: callerId, video: video ? '1' : '0' },
      ttl: 45,                         // rings for ~45 s, then it's a missed call — never deliver late
      requireInteraction: true,
      actions: [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }],
    });
    return res.status(200).json({ ok: true, ...r });
  } catch (err) {
    console.error('notify-call error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
