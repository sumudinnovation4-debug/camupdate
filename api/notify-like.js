// POST { post_id, liker_id }
// Called by yard.html right after a like is recorded in `post_likes` (fire-
// and-forget — never blocks the like button, never shown to the liker if
// it fails). Mirrors notify-message.js: looks everything up server-side
// from the two ids given, never trusts client-supplied names/content.
const { supabaseAdmin, setCors, notifySeller } = require('./_lib');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { post_id, liker_id } = req.body;
    if (!post_id || !liker_id) {
      return res.status(400).json({ error: 'Missing post_id or liker_id' });
    }

    const sb = supabaseAdmin();

    const { data: post } = await sb.from('posts').select('author_id, body').eq('id', post_id).single();
    if (!post || !post.author_id) return res.status(200).json({ ok: true, skipped: true });
    if (post.author_id === liker_id) return res.status(200).json({ ok: true, skipped: 'own post' });

    const { data: liker } = await sb.from('profiles').select('full_name, username').eq('id', liker_id).maybeSingle();
    const likerName = liker?.full_name || liker?.username || 'Someone';
    const preview = (post.body || '').slice(0, 80);

    await notifySeller(sb, {
      sellerId: post.author_id,
      type: 'like',
      title: `${likerName} liked your post ⚡`,
      body: preview ? `"${preview}"` : 'Tap to see it on The Yard.',
      url: `/yard.html`,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('notify-like error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
