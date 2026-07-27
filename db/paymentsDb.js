/**
 * ParkEase — Payment ledger
 * ──────────────────────────────────────────────────────────
 * One row per Razorpay order, updated as it moves through
 * CREATED → PAID / FAILED / REFUNDED. This is what the payment
 * history screens read; wallet TRANSACTIONS remain separate
 * (they track host earnings and withdrawals, not gateway charges).
 */

// Populated only by real Razorpay orders — no seed rows.
const PAYMENTS = [];

const recordOrder = ({ userId, orderId, amount, currency, mode, description, notes }) => {
  const row = {
    id: `pmt_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    user_id: userId,
    order_id: orderId,
    payment_id: null,
    booking_id: notes?.booking_id || null,
    amount: Number((amount / 100).toFixed(2)),
    currency: currency || 'INR',
    method: null,
    status: 'CREATED',
    mode,
    description: description || 'ParkEase booking',
    error: null,
    created_at: new Date().toISOString(),
    paid_at: null,
  };
  PAYMENTS.unshift(row);
  if (PAYMENTS.length > 500) PAYMENTS.length = 500;
  return row;
};

const markPaid = (orderId, paymentId, method) => {
  const row = PAYMENTS.find((p) => p.order_id === orderId);
  if (!row) return null;
  row.status = 'PAID';
  row.payment_id = paymentId;
  row.method = method || row.method;
  row.paid_at = new Date().toISOString();
  row.error = null;
  return row;
};

/**
 * A captured payment is terminal. Razorpay can deliver `payment.failed` after
 * `payment.captured` for the same order (retries, late callbacks), and a
 * rejected verify attempt must never be able to downgrade money already taken —
 * so refuse to move PAID or REFUNDED backwards.
 */
const markFailed = (orderId, reason) => {
  const row = PAYMENTS.find((p) => p.order_id === orderId);
  if (!row) return null;
  if (row.status === 'PAID' || row.status === 'REFUNDED') return row;
  row.status = 'FAILED';
  row.error = reason || 'Payment failed';
  return row;
};

module.exports = { PAYMENTS, recordOrder, markPaid, markFailed };
