// POST { post_id, comment_id }
// Called by yard.html right after a comment insert succeeds (fire-and-
// forget). Mirrors notify-message.js: looks the comment up server-side by
// id rather than trusting client-supplied text, so this can't be used to
// push arbitrary content to a stranger.
const { supabaseAdmin, setCors, notifySeller } = require('./_lib');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { post_id, comment_id } = req.body;
    if (!post_id || !comment_id) {
      return res.status(400).json({ error: 'Missing post_id or comment_id' });
    }

    const sb = supabaseAdmin();

    const { data: comment } = await sb.from('post_comments').select('author_id, content').eq('id', comment_id).eq('post_id', post_id).single();
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    const { data: post } = await sb.from('posts').select('author_id').eq('id', post_id).single();
    if (!post || !post.author_id) return res.status(200).json({ ok: true, skipped: true });
    if (post.author_id === comment.author_id) return res.status(200).json({ ok: true, skipped: 'own post' });

    const { data: commenter } = await sb.from('profiles').select('full_name, username').eq('id', comment.author_id).maybeSingle();
    const commenterName = commenter?.full_name || commenter?.username || 'Someone';
    const preview = (comment.content || '').slice(0, 120);

    await notifySeller(sb, {
      sellerId: post.author_id,
      type: 'comment',
      title: `${commenterName} commented on your post 💬`,
      body: preview,
      url: `/yard.html`,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('notify-comment error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
