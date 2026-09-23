// POST { reference, order_type: 'escrow' | 'food' | 'wallet_topup', order_id }
// Verifies payment with Paystack (never trust the client on the AMOUNT —
// that's always re-checked against Paystack's own record), then flips the
// matching escrow_order/food_order to "paid" — money now sits with the
// platform until release (confirm-received / Swift PIN / vendor delivered).
//
// order_type/order_id come straight from the client instead of being read
// back out of Paystack's `metadata` field. Paystack's inline popup (opened
// via PaystackPop.setup + openIframe) doesn't reliably round-trip metadata
// set during the earlier server-side /transaction/initialize call, so
// reading it back here was causing "Order not found" even on successful
// payments. The client already knows exactly which order it's paying for —
// we just re-verify the amount actually charged before trusting it.
const { paystack, supabaseAdmin, finalizeOrderPaid, setCors } = require('../_lib');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { reference, order_type, order_id } = req.body;
    if (!reference || !order_type || !order_id) return res.status(400).json({ error: 'Missing reference/order_type/order_id' });
    if (!['escrow', 'food', 'wallet_topup'].includes(order_type)) return res.status(400).json({ error: 'Invalid order_type' });

    const data = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
    if (data.data.status !== 'success') {
      return res.status(200).json({ ok: false, status: data.data.status });
    }

    const amountPaid = data.data.amount; // kobo, confirmed by Paystack — this is the number we actually trust
    const sb = supabaseAdmin();

    // Wallet top-up has no escrow_order/food_order row — order_id is just
    // the funding user's own id — so it's handled entirely separately from
    // the order-paid flow below.
    if (order_type === 'wallet_topup') {
      const userId = order_id;
      // Idempotent on the Paystack reference: verify can get called twice
      // (e.g. a flaky network retry) and must never credit the wallet twice.
      const { data: already } = await sb.from('wallet_transactions').select('id').eq('reference', reference).maybeSingle();
      if (already) return res.status(200).json({ ok: true, already: true });

      const { data: wallet } = await sb.from('wallets').select('balance_kobo').eq('user_id', userId).maybeSingle();
      const currentBalance = wallet?.balance_kobo || 0;
      await sb.from('wallets').upsert({
        user_id: userId, balance_kobo: currentBalance + amountPaid, updated_at: new Date().toISOString(),
      });
      await sb.from('wallet_transactions').insert({
        user_id: userId, type: 'wallet_topup', amount_kobo: amountPaid,
        note: 'Wallet funded via card/bank transfer', reference,
      });
      return res.status(200).json({ ok: true });
    }
    const table = order_type === 'escrow' ? 'escrow_orders' : 'food_orders';
    const paidStatus = order_type === 'escrow' ? 'paid_escrow' : 'paid';

    const { data: order, error } = await sb.from(table).select('*').eq('id', order_id).single();
    if (error) return res.status(500).json({ error: `Database error looking up order: ${error.message}` });
    if (!order) return res.status(404).json({ error: `Order not found (id ${order_id}) — this usually means the API function's SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY point to a different Supabase project than the one the app writes to.` });
    if (order.status !== 'awaiting_payment') return res.status(200).json({ ok: true, already: true });
    if (amountPaid < order.amount_kobo) return res.status(400).json({ error: 'Amount mismatch' });

    await sb.from(table).update({
      status: paidStatus, paystack_reference: reference, updated_at: new Date().toISOString(),
    }).eq('id', order_id);

    await finalizeOrderPaid(sb, order_type, order);

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
