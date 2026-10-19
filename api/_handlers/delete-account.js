// POST { confirm: "DELETE" }   Authorization: Bearer <the signed-in user's access token>
// Permanently deletes the caller's own account. Required by Google Play (apps that let people
// create an account must let them delete it from inside the app).
//
// What happens:
//   1. Refuses if money is still involved (wallet balance, or an order that is paid but not
//      yet completed) — deleting then would strand real money.
//   2. Removes personal data: devices, notifications, bank payout details, blocks, group
//      memberships, messages they sent, posts and listings; blanks the profile.
//   3. Deletes the sign-in account. If the database refuses (records still point at it), the
//      account is anonymised and locked instead, so nobody can sign in to it again.
// Kept on purpose (legal / accounting / dispute records): completed order, receipt and
// wallet-transaction history, with the person's name already removed.
const { supabaseAdmin, setCors, requireUser } = require('../_lib');

const naira = (kobo) => '₦' + (kobo / 100).toLocaleString('en-NG');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const sb = supabaseAdmin();
    const caller = await requireUser(req, res, sb); if (!caller) return;
    if ((req.body || {}).confirm !== 'DELETE') return res.status(400).json({ error: 'Please type DELETE to confirm.' });
    const uid = caller.id;

    // 1 — never strand money
    const { data: wallet } = await sb.from('wallets').select('balance_kobo').eq('user_id', uid).maybeSingle();
    if (wallet && wallet.balance_kobo > 0) {
      return res.status(409).json({ error: `Your wallet still holds ${naira(wallet.balance_kobo)}. Withdraw it to your bank (or send it) first, then delete your account.` });
    }
    const involved = `buyer_id.eq.${uid},seller_id.eq.${uid}`;
    const [{ data: escrow }, { data: food }] = await Promise.all([
      sb.from('escrow_orders').select('id').or(involved).eq('status', 'paid_escrow').limit(1),
      sb.from('food_orders').select('id').or(involved).eq('status', 'paid').limit(1),
    ]);
    if ((escrow && escrow.length) || (food && food.length)) {
      return res.status(409).json({ error: 'You have an order in progress. Finish or cancel it first, then delete your account.' });
    }

    // 2 — remove personal data (each step independent: one missing table never blocks the rest)
    const problems = [];
    const attempt = async (label, p) => {
      try { const r = await p; if (r && r.error) problems.push(`${label}: ${r.error.message}`); }
      catch (e) { problems.push(`${label}: ${e.message}`); }
    };
    await attempt('push_subscriptions', sb.from('push_subscriptions').delete().eq('user_id', uid));
    await attempt('device_tokens', sb.from('device_tokens').delete().eq('user_id', uid));
    await attempt('notifications', sb.from('notifications').delete().eq('user_id', uid));
    await attempt('payout_recipients', sb.from('payout_recipients').delete().eq('user_id', uid));
    await attempt('blocks_by', sb.from('user_blocks').delete().eq('blocker_id', uid));
    await attempt('blocks_of', sb.from('user_blocks').delete().eq('blocked_id', uid));
    await attempt('group_members', sb.from('group_members').delete().eq('user_id', uid));
    await attempt('messages', sb.from('messages').delete().eq('sender_id', uid));
    await attempt('group_messages', sb.from('group_messages').delete().eq('sender_id', uid));
    await attempt('posts', sb.from('posts').delete().eq('author_id', uid));
    const del = await sb.from('listings').delete().eq('seller_id', uid);
    if (del && del.error) await attempt('listings', sb.from('listings').update({ status: 'removed' }).eq('seller_id', uid));
    await attempt('wallet', sb.from('wallets').delete().eq('user_id', uid));

    const blank = { full_name: 'Deleted user', username: 'deleted_' + uid.slice(0, 8), avatar_url: null, bio: null, phone: null, email: null };
    for (const [col, val] of Object.entries(blank)) await attempt('profile.' + col, sb.from('profiles').update({ [col]: val }).eq('id', uid));

    // 3 — delete the sign-in account, or lock it if records still point at it
    let mode = 'deleted';
    const gone = await sb.auth.admin.deleteUser(uid);
    if (gone && gone.error) {
      mode = 'deactivated';
      const lock = await sb.auth.admin.updateUserById(uid, { ban_duration: '876000h', email: `deleted-${uid}@deleted.camplugie.invalid`, user_metadata: {} });
      if (lock && lock.error) return res.status(500).json({ error: 'We removed your data but could not finish closing the account. Email info@camplugie.com and we will complete it.' });
    }
    if (problems.length) console.warn('delete-account partial cleanup for', uid, problems.slice(0, 8));
    return res.status(200).json({ ok: true, mode });
  } catch (err) {
    console.error('delete-account error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again, or email info@camplugie.com.' });
  }
};
