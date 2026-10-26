// POST { reply_token, text, conversation_id | group_id }
// Sent by the Android app when someone types into the "Reply" box on a chat notification.
// No sign-in header: the phone's registered reply token identifies who is replying.
const { supabaseAdmin, setCors } = require('../_lib');
const { userForReplyToken, tooMany } = require('./_device');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { reply_token, conversation_id, group_id } = req.body || {};
    const text = String((req.body || {}).text || '').trim();
    if (!text || text.length > 1000) return res.status(400).json({ error: 'Reply must be 1–1000 characters.' });
    if (!conversation_id === !group_id) return res.status(400).json({ error: 'Say which chat this reply is for.' });

    const sb = supabaseAdmin();
    const userId = await userForReplyToken(sb, reply_token);
    if (!userId) return res.status(401).json({ error: 'This phone is not signed in.' });
    if (tooMany('qr:' + userId, 12, 60 * 1000)) return res.status(429).json({ error: 'Slow down a little.' });

    const now = new Date().toISOString();
    if (conversation_id) {
      const { data: convo } = await sb.from('conversations').select('id, buyer_id, seller_id').eq('id', conversation_id).maybeSingle();
      if (!convo || (convo.buyer_id !== userId && convo.seller_id !== userId)) return res.status(403).json({ error: 'Not your chat.' });
      const other = convo.buyer_id === userId ? convo.seller_id : convo.buyer_id;
      const { data: blocked } = await sb.from('user_blocks').select('id').or(`and(blocker_id.eq.${other},blocked_id.eq.${userId}),and(blocker_id.eq.${userId},blocked_id.eq.${other})`).limit(1);
      if (blocked && blocked.length) return res.status(403).json({ error: 'You can’t message this person.' });
      const { error } = await sb.from('messages').insert({ conversation_id, sender_id: userId, content: text });
      if (error) throw new Error(error.message);
      await sb.from('conversations').update({ last_message: text.slice(0, 120), last_message_at: now }).eq('id', conversation_id);
    } else {
      const { data: member } = await sb.from('group_members').select('user_id').eq('group_id', group_id).eq('user_id', userId).maybeSingle();
      if (!member) return res.status(403).json({ error: 'You are not in this group.' });
      const { error } = await sb.from('group_messages').insert({ group_id, sender_id: userId, content: text, message_type: 'text' });
      if (error) throw new Error(error.message);
      await sb.from('groups').update({ last_message: text.slice(0, 120), last_message_at: now }).eq('id', group_id);
    }
    // The database trigger now notifies the other people, exactly as if you had typed it in the app.
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('quick-reply error:', err.message);
    return res.status(500).json({ error: 'Could not send. Please open Camplugie.' });
  }
};
