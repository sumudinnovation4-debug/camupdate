// POST { group_id, message_id }   Authorization: Bearer <sender's Supabase access token>
// Called by group-thread.html right after a group message is saved
// (fire-and-forget — never blocks sending).
//
// Sends a real device push to every other member of the group, the way
// WhatsApp does. It deliberately does NOT write a `notifications` row per
// member (a 300-student course group would flood that table on every
// message) — it pushes straight to their devices instead.
//
//  - Looks the message up server-side; never trusts client-sent text.
//  - Requires the caller to be the message's sender, and the message to be
//    fresh (<2 min old), so the endpoint can't be used to spam people.
//  - Skips the sender, anyone who muted the group (unless @mentioned),
//    and anyone who blocked the sender. Per-user Settings switches are
//    applied inside sendPush().
const { supabaseAdmin, setCors, sendPush } = require('./_lib');

const MAX_RECIPIENTS = 500;
const CHUNK = 25;

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { group_id, message_id } = req.body || {};
    if (!group_id || !message_id) return res.status(400).json({ error: 'Missing group_id or message_id' });

    const sb = supabaseAdmin();

    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Missing token' });
    const { data: auth } = await sb.auth.getUser(token);
    const callerId = auth?.user?.id;
    if (!callerId) return res.status(401).json({ error: 'Invalid token' });

    const { data: msg } = await sb.from('group_messages')
      .select('id, sender_id, content, media_type, created_at')
      .eq('id', message_id).eq('group_id', group_id).maybeSingle();
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.sender_id !== callerId) return res.status(403).json({ error: 'Not your message' });
    if (Date.now() - new Date(msg.created_at).getTime() > 2 * 60 * 1000) {
      return res.status(200).json({ ok: true, skipped: 'stale' });
    }

    const [{ data: group }, { data: sender }, { data: members }] = await Promise.all([
      sb.from('groups').select('name').eq('id', group_id).maybeSingle(),
      sb.from('profiles').select('full_name, username').eq('id', msg.sender_id).maybeSingle(),
      sb.from('group_members').select('user_id, is_muted').eq('group_id', group_id),
    ]);

    const senderName = sender?.full_name || sender?.username || 'Someone';
    const groupName = group?.name || 'Group';
    const text = (msg.content || '').trim();
    const preview = text
      ? text.slice(0, 120)
      : (msg.media_type?.startsWith('image') ? '📷 Photo'
        : msg.media_type?.startsWith('audio') ? '🎤 Voice note'
        : msg.media_type?.startsWith('video') ? '🎥 Video' : '📎 Attachment');

    const others = (members || []).filter(m => m.user_id && m.user_id !== msg.sender_id).slice(0, MAX_RECIPIENTS);
    if (!others.length) return res.status(200).json({ ok: true, recipients: 0 });

    // Names for @mention detection + who has blocked the sender.
    const ids = others.map(m => m.user_id);
    const [{ data: profs }, { data: blocks }] = await Promise.all([
      sb.from('profiles').select('id, full_name, username').in('id', ids),
      sb.from('user_blocks').select('blocker_id').eq('blocked_id', msg.sender_id).in('blocker_id', ids),
    ]);
    const blockedBy = new Set((blocks || []).map(b => b.blocker_id));
    const profById = new Map((profs || []).map(p => [p.id, p]));
    const lower = text.toLowerCase();
    const isMentioned = (id) => {
      const p = profById.get(id); if (!p) return false;
      return (p.username && lower.includes('@' + p.username.toLowerCase())) ||
             (p.full_name && lower.includes('@' + p.full_name.toLowerCase()));
    };

    const url = `/group-thread.html?id=${group_id}`;
    let sent = 0, skipped = 0;
    const targets = others.filter(m => !blockedBy.has(m.user_id));

    for (let i = 0; i < targets.length; i += CHUNK) {
      await Promise.all(targets.slice(i, i + CHUNK).map(async (m) => {
        const mentioned = isMentioned(m.user_id);
        if (m.is_muted && !mentioned) { skipped++; return; }
        const r = await sendPush(sb, m.user_id, {
          title: mentioned ? `${senderName} mentioned you in ${groupName}` : groupName,
          body: mentioned ? preview : `${senderName}: ${preview}`,
          url,
          type: mentioned ? 'mention' : 'group_message',
          tag: `group:${group_id}`,
        });
        if (r.sent) sent++; else skipped++;
      }));
    }

    return res.status(200).json({ ok: true, recipients: targets.length, sent, skipped });
  } catch (err) {
    console.error('notify-group-message error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
