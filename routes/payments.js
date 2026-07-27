const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { authenticate } = require('../middleware/auth');
const { PLATFORM_SETTINGS } = require('../db/settingsDb');
const { PAYMENTS, recordOrder, markPaid, markFailed } = require('../db/paymentsDb');

// Razorpay SDK (lazy-loaded so a missing package doesn't crash boot)
let Razorpay;
try { Razorpay = require('razorpay'); } catch (_) {}

/**
 * Gateway credentials come from PLATFORM_SETTINGS so that whatever the
 * admin panel saves takes effect immediately, with env vars as the seed.
 */
const creds = () => {
  const p = PLATFORM_SETTINGS.payment;
  return {
    keyId: p.keyId || process.env.RAZORPAY_KEY_ID,
    keySecret: p.keySecret || process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: p.webhookSecret || process.env.RAZORPAY_WEBHOOK_SECRET || '',
    mode: p.mode || 'TEST',
  };
};

const getRazorpay = () => {
  if (!Razorpay) throw new Error('Razorpay SDK is not installed on the server');
  const { keyId, keySecret } = creds();
  if (!keyId || !keySecret) throw new Error('Razorpay credentials are not configured');
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

/**
 * Razorpay rejects an order outright if `notes` contains non-string values or
 * characters it cannot encode ("The notes field should contain valid UTF-8
 * encoded characters"). Spot titles routinely carry en-dashes and ₹, and the
 * client sends numbers, so normalise before sending.
 *
 * Limits enforced: max 15 keys, 256 chars per value.
 */
const sanitizeNotes = (notes) => {
  if (!notes || typeof notes !== 'object') return {};
  return Object.entries(notes)
    .slice(0, 15)
    .reduce((acc, [key, value]) => {
      if (value === null || value === undefined) return acc;
      const str = String(value)
        .normalize('NFKD')            // é → e +  ́ , – → -
        .replace(/[^\x20-\x7E]/g, '') // drop anything outside printable ASCII
        .trim()
        .slice(0, 256);
      if (str) acc[String(key).slice(0, 256)] = str;
      return acc;
    }, {});
};

// ── POST /api/v1/payments/razorpay/order ─────────────────────────
// Body: { amount_paise, currency?, receipt?, notes? }
router.post('/razorpay/order', authenticate, async (req, res) => {
  const { amount_paise, currency = 'INR', receipt, notes } = req.body;
  if (!amount_paise || amount_paise < 100) {
    return res.status(400).json({ success: false, message: 'amount_paise (min 100) required' });
  }

  const { keyId, mode } = creds();
  const safeNotes = sanitizeNotes(notes);

  try {
    const razorpay = getRazorpay();
    const order = await razorpay.orders.create({
      amount: Math.round(amount_paise),
      currency,
      receipt: String(receipt || `rcpt_${Date.now()}`).slice(0, 40),
      notes: safeNotes,
    });

    recordOrder({
      userId: req.user.id,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      mode,
      description: safeNotes.description,
      notes: safeNotes,
    });

    res.json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: keyId,
      mode,
    });
  } catch (err) {
    // Surface the failure instead of silently handing back a fake order —
    // a mock id cannot be paid, and pretending otherwise produces bookings
    // with no money behind them.
    console.error('[Razorpay] Order creation failed:', err.message);
    res.status(502).json({
      success: false,
      message: 'Could not create a Razorpay order. Check the gateway credentials in Admin → Payment Gateway.',
      detail: err.error?.description || err.message,
      mode,
    });
  }
});

// ── POST /api/v1/payments/webhook ────────────────────────────────
// Razorpay signs webhooks with the WEBHOOK secret, which is a different
// value from the API key secret.
router.post('/webhook', (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const { webhookSecret } = creds();

  if (!webhookSecret) {
    console.warn('[Webhook] Rejected — no webhook secret configured');
    return res.status(503).json({ success: false, message: 'Webhook secret not configured' });
  }

  // server.js registers express.raw() for this path, so req.body is a Buffer.
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);

  try {
    const expected = crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature || ''));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      console.warn('[Webhook] Invalid Razorpay signature');
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    const event = JSON.parse(raw);
    const entity = event.payload?.payment?.entity;

    if (event.event === 'payment.captured' && entity) {
      markPaid(entity.order_id, entity.id, (entity.method || '').toUpperCase());
      const { BOOKINGS } = require('../db/inMemoryDb');
      const booking = BOOKINGS.find((b) => b.razorpay_order_id === entity.order_id);
      if (booking) {
        booking.booking_status = 'CONFIRMED';
        booking.payment_id = entity.id;
      }
    }

    if (event.event === 'payment.failed' && entity) {
      markFailed(entity.order_id, entity.error_description || 'Payment failed');
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Webhook] Error:', err.message);
    res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
});

// ── POST /api/v1/payments/verify ─────────────────────────────────
router.post('/verify', authenticate, (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, method } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ success: false, message: 'All three Razorpay fields required' });
  }

  const { keySecret } = creds();
  const body = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expected = crypto.createHmac('sha256', keySecret).update(body).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(razorpay_signature));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    markFailed(razorpay_order_id, 'Signature mismatch');
    return res.status(400).json({ success: false, message: 'Payment verification failed — signature mismatch' });
  }

  const row = markPaid(razorpay_order_id, razorpay_payment_id, (method || '').toUpperCase());
  res.json({
    success: true,
    message: 'Payment verified successfully',
    payment_id: razorpay_payment_id,
    payment: row,
  });
});

// ── GET /api/v1/payments/history ─────────────────────────────────
// The signed-in user's gateway payments, newest first.
router.get('/history', authenticate, (req, res) => {
  const { status, limit = 50 } = req.query;
  let rows = PAYMENTS.filter((p) => p.user_id === req.user.id);
  if (status) rows = rows.filter((p) => p.status === status.toUpperCase());
  rows = rows.slice().sort((x, y) => new Date(y.created_at) - new Date(x.created_at));

  const paid = rows.filter((p) => p.status === 'PAID');
  res.json({
    success: true,
    count: rows.length,
    total_paid: Number(paid.reduce((s, p) => s + p.amount, 0).toFixed(2)),
    payments: rows.slice(0, parseInt(limit, 10)),
  });
});

// ── GET /api/v1/payments/config ───────────────────────────────────
router.get('/config', authenticate, (req, res) => {
  const { keyId, mode } = creds();
  const p = PLATFORM_SETTINGS.payment;
  res.json({
    success: true,
    key_id: keyId,
    mode,
    methods: p.methods,
    provider: p.provider,
  });
});

module.exports = router;
