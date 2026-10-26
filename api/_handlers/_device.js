// Shared by the notification-button routes (quick-reply, call-decline).
// The Android app keeps a random secret on the phone and registers only its SHA-256 hash here, so a
// stolen database copy cannot be used to send messages. Signing out (or deleting the phone's
// registration) revokes it immediately.
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Returns the user id this phone is registered to, or null.
async function userForReplyToken(sb, token) {
  if (!token || typeof token !== 'string' || token.length < 32 || token.length > 200) return null;
  const { data } = await sb.from('device_tokens').select('user_id').eq('reply_token_hash', sha256(token)).maybeSingle();
  return (data && data.user_id) || null;
}

// Tiny per-phone rate limit (best effort — each warm server instance keeps its own count).
const hits = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

module.exports = { sha256, userForReplyToken, tooMany };
