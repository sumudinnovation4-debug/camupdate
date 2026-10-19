// POST { endpoint?, appKey? }   Authorization: Bearer <the signed-in user's access token>
// Settings → Notifications → "Send test notification" calls this.
// It walks the whole push chain for THIS user, reports which link is broken in
// plain English, and finally sends a real test push to every device they have.
const { supabaseAdmin, setCors, sendPush, vapidStatus, fcmStatus } = require('../_lib');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const steps = [];
  const add = (ok, name, detail) => steps.push({ ok, name, detail });

  try {
    const sb = supabaseAdmin();
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const { data: auth } = token ? await sb.auth.getUser(token) : { data: null };
    const uid = auth && auth.user && auth.user.id;
    if (!uid) return res.status(401).json({ error: 'Please sign in again.' });

    const { endpoint, appKey, native_token } = req.body || {};
    const v = vapidStatus();

    if (native_token) {
      // ---- Android app: Firebase key on the server ----
      const f = fcmStatus();
      if (!f.ready) add(false, 'Firebase on the server', 'Vercel has no valid FIREBASE_SERVICE_ACCOUNT. In Firebase → Project settings → Service accounts → Generate new private key, then paste the WHOLE file content into a Vercel environment variable named FIREBASE_SERVICE_ACCOUNT and Redeploy.');
      else add(true, 'Firebase on the server', `Connected to Firebase project “${f.project}”.`);
    } else {
      // 1 — server keys
      if (!v.public || !v.private) {
        add(false, 'Server keys', `Vercel is missing ${!v.public ? 'VAPID_PUBLIC_KEY' : ''}${!v.public && !v.private ? ' and ' : ''}${!v.private ? 'VAPID_PRIVATE_KEY' : ''}. Add them in Vercel → Settings → Environment Variables, then Redeploy.`);
      } else if (v.error) {
        add(false, 'Server keys', `The keys on Vercel are not valid (${v.error}). Re-copy both from the key pair, with no spaces or quotes, then Redeploy.`);
      } else {
        add(true, 'Server keys', 'Both keys are set on Vercel and valid.');
      }

      // 2 — public key on the server == public key inside the app
      if (appKey && v.publicKey) {
        if (String(appKey).trim() === v.publicKey) add(true, 'Keys match', 'The app and the server use the same public key.');
        else add(false, 'Keys match', 'The public key in pwa.js is DIFFERENT from VAPID_PUBLIC_KEY on Vercel. Make both the same, redeploy, then switch notifications off and on again.');
      }
    }

    // 3 — settings switch
    const { data: prof } = await sb.from('profiles').select('push_enabled').eq('id', uid).maybeSingle();
    if (prof && prof.push_enabled === false) add(false, 'Settings switch', 'Push notifications are switched OFF in your profile. Turn on “Push notifications” in Settings.');
    else add(true, 'Settings switch', 'Push notifications are switched on.');

    // 4 — saved devices
    if (native_token) {
      const { data: toks, error: tokErr } = await sb.from('device_tokens').select('token').eq('user_id', uid);
      if (tokErr) add(false, 'Saved devices', 'The device_tokens table is missing. Run camplugie-native.sql in Supabase → SQL Editor.');
      else if (!toks.some(t => t.token === native_token)) add(false, 'This device', 'This phone’s Firebase token is not saved to your account. Switch Push notifications off and on in Settings.');
      else add(true, 'Saved devices', 'This phone is saved for push.');
    } else {
      const { data: subs, error: subErr } = await sb.from('push_subscriptions').select('endpoint').eq('user_id', uid);
      if (subErr) {
        add(false, 'Saved devices', 'The push_subscriptions table is missing or unreadable. Run camplugie-push.sql again in Supabase → SQL Editor.');
      } else if (!subs.length) {
        add(false, 'Saved devices', 'No device is saved for your account yet. Open Settings, switch Push notifications off and on, and tap Allow.');
      } else if (endpoint && !subs.some(r => r.endpoint === endpoint)) {
        add(false, 'This device', `You have ${subs.length} saved device(s) but NOT this phone. Switch Push notifications off and on in Settings to save this one.`);
      } else {
        add(true, 'Saved devices', endpoint ? 'This phone is saved.' : `${subs.length} device(s) saved.`);
      }
    }

    // 5 — actually send
    const blocking = steps.some(s => !s.ok);
    if (!blocking) {
      const r = await sendPush(sb, uid, {
        title: 'Camplugie test ✅', body: 'If you can read this, notifications work on this phone.',
        url: '/settings.html', type: 'test', tag: 'cp-test',
      });
      if (r.sent > 0) {
        add(true, 'Test sent', `Sent to ${r.sent} device(s). It should pop up in a few seconds — if it does not, check your phone’s notification settings for Camplugie.`);
      } else if (r.errors && r.errors.length) {
        const st = r.errors[0].status;
        const why = (st === 401 || st === 403)
          ? 'The push service rejected our keys — the private key on Vercel does not belong to the public key in the app. Use ONE matching pair in both places.'
          : (st === 404 || st === 410) ? 'This phone’s saved subscription had expired and was removed. Switch Push notifications off and on in Settings, then test again.'
          : `The push service returned ${st || 'an error'}: ${r.errors[0].message}`;
        add(false, 'Test sent', why);
      } else {
        add(false, 'Test sent', `Nothing was sent (${r.skipped || 'unknown reason'}).`);
      }
    }

    return res.status(200).json({ ok: steps.every(s => s.ok), steps });
  } catch (err) {
    console.error('push-test error:', err.message);
    return res.status(500).json({ error: err.message, steps });
  }
};
