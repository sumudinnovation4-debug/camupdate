// POST { group_id, message_id }   Authorization: Bearer <supabase access token>
// Called by group-thread.html right after a group message is sent. Pushes to
// every member except the sender, skipping people who muted the group or blocked
// the sender. @mentioned people are pushed even if they muted (like WhatsApp).
// Group chatter is push-only — it deliberately does NOT create a row in the
// Activity feed for every message.
const { supabaseAdmin, setCors, sendPush, authedUserId } = require('./_lib');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const sb = supabaseAdmin();
    const userId = await authedUserId(sb, req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { group_id, message_id } = req.body || {};
    if (!group_id || !message_id) return res.status(400).json({ error: 'Missing group_id or message_id' });

    const { data: msg } = await sb.from('group_messages').select('*').eq('id', message_id).eq('group_id', group_id).maybeSingle();
    if (!msg || msg.sender_id !== userId) return res.status(404).json({ error: 'Message not found' });
    if (msg.message_type === 'system') return res.status(200).json({ ok: true, skipped: 'system' });

    const [{ data: group }, { data: sender }, { data: members }] = await Promise.all([
      sb.from('groups').select('name').eq('id', group_id).maybeSingle(),
      sb.from('profiles').select('full_name, username').eq('id', userId).maybeSingle(),
      sb.from('group_members').select('*').eq('group_id', group_id),
    ]);
    const senderName = sender?.full_name || sender?.username || 'Someone';
    const mentioned = new Set(Array.isArray(msg.mentions) ? msg.mentions : []);
    const preview = (msg.content || '').slice(0, 140)
      || (msg.media_type?.startsWith('image') ? '📷 Photo' : msg.media_type?.startsWith('audio') ? '🎤 Voice note' : '📎 Attachment');

    const { data: blocks } = await sb.from('user_blocks').select('blocker_id').eq('blocked_id', userId);
    const blockedBy = new Set((blocks || []).map(b => b.blocker_id));

    const targets = (members || []).filter(m =>
      m.user_id !== userId && !blockedBy.has(m.user_id) && (!m.is_muted || mentioned.has(m.user_id)));

    await Promise.all(targets.map(m => sendPush(sb, m.user_id, {
      title: group?.name || 'Group',
      body: `${mentioned.has(m.user_id) ? '@ ' : ''}${senderName}: ${preview}`,
      url: `/group-thread.html?id=${group_id}`,
      type: mentioned.has(m.user_id) ? 'mention' : 'group',
      tag: `group-${group_id}`,
    })));

    return res.status(200).json({ ok: true, sent: targets.length });
  } catch (err) {
    console.error('notify-group-message error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
