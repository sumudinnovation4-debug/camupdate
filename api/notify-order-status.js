// POST { order_id, status }
// Called by orders.html right after a seller updates a food_orders row
// (currently just 'delivered', fire-and-forget). Looks the order and
// buyer up server-side from the id, so the buyer can't be spoofed or sent
// an arbitrary message.
const { supabaseAdmin, setCors, notifySeller } = require('./_lib');

const MESSAGES = {
  delivered: { title: 'Your order is here! 🛵', body: 'Confirm you received it on Camplugie so the vendor gets paid.' },
};

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { order_id, status } = req.body;
    const msg = MESSAGES[status];
    if (!order_id || !msg) return res.status(200).json({ ok: true, skipped: true });

    const sb = supabaseAdmin();
    const { data: order } = await sb.from('food_orders').select('buyer_id, status').eq('id', order_id).single();
    if (!order || !order.buyer_id || order.status !== status) return res.status(200).json({ ok: true, skipped: true });

    await notifySeller(sb, {
      sellerId: order.buyer_id,
      type: 'order',
      title: msg.title,
      body: msg.body,
      url: `/orders.html`,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('notify-order-status error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
