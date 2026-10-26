// POST { table, record }   Header: x-webhook-secret
// Called by Postgres itself (see sql/camplugie-push-v2.sql) the instant a row is
// inserted into: messages, group_messages, group_calls, listings, posts, group_members.
//
// Because the DATABASE triggers this — not the sender's phone — it works even if the
// sender closes the app the moment they hit send, exactly like WhatsApp.
const { supabaseAdmin, pushToUsers } = require('../_lib');

const SYSTEM_PREFIX = '\u{1F512}SYSTEM:';
const MAX_BROADCAST = 1500;   // most people one new listing / post is pushed to

const mediaLabel = (t) =>
  (t || '').startsWith('image') ? '📷 Photo'
  : (t || '').startsWith('audio') ? '🎤 Voice note'
  : (t || '').startsWith('video') ? '🎥 Video' : '📎 Attachment';

const nameOf = (p) => (p && (p.full_name || p.username)) || 'Someone';
const short = (t, n = 120) => String(t || '').trim().replace(/\s+/g, ' ').slice(0, n);

async function profile(sb, id) {
  const { data } = await sb.from('profiles').select('full_name, username').eq('id', id).maybeSingle();
  return data;
}

/* ---------- 1:1 chat ---------- */
async function onMessage(sb, m) {
  if (!m.content && !m.media_url) return { skipped: 'empty' };
  if ((m.content || '').startsWith(SYSTEM_PREFIX)) return { skipped: 'system' };
  const { data: convo } = await sb.from('conversations').select('buyer_id, seller_id').eq('id', m.conversation_id).maybeSingle();
  if (!convo) return { skipped: 'no-conversation' };
  const to = m.sender_id === convo.buyer_id ? convo.seller_id : convo.buyer_id;
  if (!to || to === m.sender_id) return { skipped: 'no-recipient' };
  const { data: blocked } = await sb.from('user_blocks').select('id').eq('blocker_id', to).eq('blocked_id', m.sender_id).maybeSingle();
  if (blocked) return { skipped: 'blocked' };
  const sender = await profile(sb, m.sender_id);
  return pushToUsers(sb, [to], {
    title: nameOf(sender), body: short(m.content) || mediaLabel(m.media_type),
    url: `/chat-thread.html?id=${m.conversation_id}`, type: 'message', tag: `chat:${m.conversation_id}`,
    eventAt: m.created_at, data: { conv_id: m.conversation_id },
  });
}

/* ---------- group chat ---------- */
async function onGroupMessage(sb, m) {
  if (m.message_type === 'system' || (m.content || '').startsWith(SYSTEM_PREFIX)) return { skipped: 'system' };
  const [{ data: group }, sender, { data: members }] = await Promise.all([
    sb.from('groups').select('name').eq('id', m.group_id).maybeSingle(),
    profile(sb, m.sender_id),
    sb.from('group_members').select('user_id, is_muted').eq('group_id', m.group_id),
  ]);
  const others = (members || []).filter(x => x.user_id && x.user_id !== m.sender_id).slice(0, 1000);
  if (!others.length) return { skipped: 'no-members' };
  const ids = others.map(x => x.user_id);
  const [{ data: profs }, { data: blocks }] = await Promise.all([
    sb.from('profiles').select('id, full_name, username').in('id', ids),
    sb.from('user_blocks').select('blocker_id').eq('blocked_id', m.sender_id).in('blocker_id', ids),
  ]);
  const blockedBy = new Set((blocks || []).map(b => b.blocker_id));
  const byId = new Map((profs || []).map(p => [p.id, p]));
  const text = (m.content || '').toLowerCase();
  const mentioned = (id) => { const p = byId.get(id); return !!p && ((p.username && text.includes('@' + p.username.toLowerCase())) || (p.full_name && text.includes('@' + p.full_name.toLowerCase()))); };

  const groupName = (group && group.name) || 'Group';
  const preview = short(m.content) || mediaLabel(m.media_type);
  const senderName = nameOf(sender);
  const url = `/group-thread.html?id=${m.group_id}`;
  const normal = [], mention = [];
  for (const x of others) {
    if (blockedBy.has(x.user_id)) continue;
    if (mentioned(x.user_id)) mention.push(x.user_id);
    else if (!x.is_muted) normal.push(x.user_id);     // muted groups stay silent unless you're @mentioned
  }
  const [a, b] = await Promise.all([
    pushToUsers(sb, normal, { title: groupName, body: `${senderName}: ${preview}`, url, type: 'group_message', tag: `group:${m.group_id}`, eventAt: m.created_at, data: { group_id: m.group_id } }),
    pushToUsers(sb, mention, { title: `${senderName} mentioned you in ${groupName}`, body: preview, url, type: 'mention', tag: `group:${m.group_id}`, eventAt: m.created_at, data: { group_id: m.group_id } }),
  ]);
  return { normal: a, mention: b };
}

/* ---------- group call / lecture ---------- */
async function onGroupCall(sb, c) {
  if (c.ended_at || c.status === 'ended') return { skipped: 'ended' };
  const [{ data: group }, host, { data: members }] = await Promise.all([
    sb.from('groups').select('name').eq('id', c.group_id).maybeSingle(),
    profile(sb, c.host_id),
    sb.from('group_members').select('user_id').eq('group_id', c.group_id),
  ]);
  const ids = (members || []).map(x => x.user_id).filter(id => id && id !== c.host_id);
  const lecture = c.mode === 'lecture';
  return pushToUsers(sb, ids, {
    title: `${lecture ? '🎓' : '📞'} ${(group && group.name) || 'Group'}`,
    body: `${nameOf(host)} started ${lecture ? 'a lecture' : 'a group call'} — tap to join`,
    url: `/group-call.html?groupId=${c.group_id}&callId=${c.id}&mode=${c.mode}&role=guest`,
    type: 'group_call', tag: `call:${c.id}`, eventAt: c.created_at, data: { group_id: c.group_id, call_id: c.id },
    ttl: 120,                       // a call that rang 10 minutes ago is useless — don't deliver it late
    requireInteraction: true,
    actions: [{ action: 'open', title: lecture ? 'Join lecture' : 'Join call' }],
  });
}

/* ---------- new listing / new post → everyone at the same university ---------- */
async function campusRecipients(sb, universityId, exceptUserId) {
  if (!universityId) return [];
  const { data } = await sb.from('profiles').select('id').eq('university_id', universityId).neq('id', exceptUserId || '00000000-0000-0000-0000-000000000000').limit(MAX_BROADCAST);
  return (data || []).map(p => p.id);
}
async function tooFrequent(sb, table, col, userId, max) {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await sb.from(table).select('id', { count: 'exact', head: true }).eq(col, userId).gte('created_at', since);
  return (count || 0) > max;
}

async function onListing(sb, l) {
  if (l.status && l.status !== 'active') return { skipped: 'not-active' };
  if (await tooFrequent(sb, 'listings', 'seller_id', l.seller_id, 4)) return { skipped: 'seller-spamming' };
  const ids = await campusRecipients(sb, l.university_id, l.seller_id);
  return pushToUsers(sb, ids, {
    title: '🛍️ New on Camplugie', body: short(l.title, 100),
    url: `/listing.html?id=${l.id}`, type: 'listing', tag: `listing:${l.id}`, eventAt: l.created_at,
    ttl: 6 * 3600, urgency: 'normal',          // not urgent — lets phones batch it and save battery
  });
}

async function onPost(sb, p) {
  if (await tooFrequent(sb, 'posts', 'author_id', p.author_id, 6)) return { skipped: 'author-spamming' };
  const [author, ids] = await Promise.all([profile(sb, p.author_id), campusRecipients(sb, p.university_id, p.author_id)]);
  const media = Array.isArray(p.media_types) && p.media_types.length ? mediaLabel(p.media_types[0]) : '';
  return pushToUsers(sb, ids, {
    title: `${nameOf(author)} posted on The Yard`, body: short(p.content) || media || 'Tap to see it',
    url: '/yard.html', type: 'post', tag: `post:${p.id}`, eventAt: p.created_at,
    ttl: 6 * 3600, urgency: 'normal',
  });
}

/* ---------- added to a group ---------- */
async function onGroupMember(sb, gm) {
  if (gm.role === 'creator') return { skipped: 'creator' };
  const { data: group } = await sb.from('groups').select('name, creator_id, created_by').eq('id', gm.group_id).maybeSingle();
  if (!group) return { skipped: 'no-group' };
  if ([group.creator_id, group.created_by].includes(gm.user_id)) return { skipped: 'is-creator' };
  return pushToUsers(sb, [gm.user_id], {
    title: 'You were added to a group', body: `You’re now in ${group.name || 'a new group'}`,
    url: `/group-thread.html?id=${gm.group_id}`, type: 'group_added', tag: `added:${gm.group_id}`, eventAt: gm.created_at,
  });
}

const HANDLERS = {
  messages: onMessage, group_messages: onGroupMessage, group_calls: onGroupCall,
  listings: onListing, posts: onPost, group_members: onGroupMember,
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.PUSH_WEBHOOK_SECRET || req.headers['x-webhook-secret'] !== process.env.PUSH_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { table, record } = req.body || {};
    const handler = HANDLERS[table];
    if (!handler || !record) return res.status(200).json({ ok: true, skipped: 'unhandled-table' });
    const started = Date.now();
    const result = await handler(supabaseAdmin(), record);
    return res.status(200).json({ ok: true, table, ms: Date.now() - started, result });
  } catch (err) {
    console.error('push-event error:', err.message);
    // Always 200 so Postgres never retries and double-notifies.
    return res.status(200).json({ ok: false, error: err.message });
  }
};
