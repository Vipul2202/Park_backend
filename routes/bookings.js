const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { BOOKINGS, PARKING_SPACES, VEHICLES, USERS, WALLETS, TRANSACTIONS } = require('../db/inMemoryDb');
const { authenticate, requireRole } = require('../middleware/auth');

// ── Helpers ───────────────────────────────────────────────────────
const calcPricing = (pricePerHour, hours, surgeMultiplier = 1.0) => {
  const base = parseFloat((pricePerHour * hours * surgeMultiplier).toFixed(2));
  const gst = parseFloat((base * (parseFloat(process.env.GST_PCT || 18) / 100)).toFixed(2));
  const fee = parseFloat(process.env.PLATFORM_FEE_FLAT || 15);
  const total = parseFloat((base + gst + fee).toFixed(2));
  return { base, gst, fee, total };
};

const enrichBooking = (booking) => {
  const spot = PARKING_SPACES.find(s => s.id === booking.parking_space_id);
  const vehicle = VEHICLES.find(v => v.id === booking.vehicle_id);
  const owner = spot ? USERS.find(u => u.id === spot.owner_id) : null;
  return {
    ...booking,
    spot: spot ? { id: spot.id, title: spot.title, address: spot.address_line, image: spot.images[0] } : null,
    vehicle: vehicle ? { id: vehicle.id, name: vehicle.make_model, plateNumber: vehicle.license_plate, type: vehicle.vehicle_type } : null,
    ownerName: owner ? owner.full_name : null,
    ownerPhone: owner ? owner.phone_number : null,
    ownerAvatar: owner ? owner.avatar_url : null,
  };
};

// ── GET /api/v1/bookings/my ──────────────────────────────────────
router.get('/my', authenticate, (req, res) => {
  const { status } = req.query;
  let bookings = BOOKINGS.filter(b => b.seeker_id === req.user.id);
  if (status) bookings = bookings.filter(b => b.booking_status === status.toUpperCase());
  bookings.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ success: true, count: bookings.length, bookings: bookings.map(enrichBooking) });
});

// ── GET /api/v1/bookings/owner ───────────────────────────────────
// For host to see bookings on their spots
router.get('/owner', authenticate, requireRole('OWNER', 'ADMIN'), (req, res) => {
  const { status } = req.query;
  const ownerSpotIds = PARKING_SPACES.filter(s => s.owner_id === req.user.id).map(s => s.id);
  let bookings = BOOKINGS.filter(b => ownerSpotIds.includes(b.parking_space_id));
  if (status) bookings = bookings.filter(b => b.booking_status === status.toUpperCase());
  bookings.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // Enrich with seeker info
  const enriched = bookings.map(b => {
    const seeker = USERS.find(u => u.id === b.seeker_id);
    return {
      ...enrichBooking(b),
      seekerName: seeker ? seeker.full_name : 'Unknown',
      seekerPhone: seeker ? seeker.phone_number : null,
      seekerAvatar: seeker ? seeker.avatar_url : null,
    };
  });

  res.json({ success: true, count: enriched.length, bookings: enriched });
});

// ── GET /api/v1/bookings/:id ─────────────────────────────────────
router.get('/:id', authenticate, (req, res) => {
  const booking = BOOKINGS.find(b => b.booking_code === req.params.id || b.id === req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

  // Only seeker or spot owner or admin can view
  const spot = PARKING_SPACES.find(s => s.id === booking.parking_space_id);
  const isOwner = spot && spot.owner_id === req.user.id;
  if (booking.seeker_id !== req.user.id && !isOwner && req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  res.json({ success: true, booking: enrichBooking(booking) });
});

// ── POST /api/v1/bookings/hold ───────────────────────────────────
// Reserves a slot for 10 minutes (before payment)
router.post('/hold', authenticate, (req, res) => {
  const { parking_space_id, vehicle_id, start_time, end_time, hours } = req.body;
  if (!parking_space_id || !start_time || !end_time) {
    return res.status(400).json({ success: false, message: 'parking_space_id, start_time and end_time required' });
  }

  const spot = PARKING_SPACES.find(s => s.id === parking_space_id);
  if (!spot || !spot.is_active) return res.status(404).json({ success: false, message: 'Parking spot not found or unavailable' });
  if (spot.available_car_slots <= 0) return res.status(409).json({ success: false, message: 'No slots available. Please choose another spot.' });

  const totalHours = hours || Math.ceil((new Date(end_time) - new Date(start_time)) / 3600000);
  const pricing = calcPricing(spot.price_per_hour, totalHours, spot.surge_multiplier);

  const holdId = `HOLD-${uuidv4().slice(0, 8).toUpperCase()}`;
  const holdExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min hold

  res.json({
    success: true,
    hold_id: holdId,
    hold_expiry: holdExpiry,
    pricing,
    spot: { id: spot.id, title: spot.title, price_per_hour: spot.price_per_hour, surge_multiplier: spot.surge_multiplier },
  });
});

// ── POST /api/v1/bookings ─────────────────────────────────────────
// Create booking after successful payment
router.post('/', authenticate, (req, res) => {
  const { parking_space_id, vehicle_id, start_time, end_time, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
  if (!parking_space_id || !start_time || !end_time || !razorpay_payment_id || !razorpay_order_id) {
    return res.status(400).json({ success: false, message: 'Required fields missing' });
  }

  const start = new Date(start_time);
  const end = new Date(end_time);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return res.status(400).json({ success: false, message: 'start_time and end_time must be valid dates' });
  }
  if (end <= start) {
    return res.status(400).json({ success: false, message: 'end_time must be after start_time' });
  }

  const spot = PARKING_SPACES.find(s => s.id === parking_space_id);
  if (!spot) return res.status(404).json({ success: false, message: 'Parking spot not found' });
  if (spot.approval_status !== 'APPROVED' || !spot.is_active) {
    return res.status(409).json({ success: false, message: 'This parking spot is not currently bookable' });
  }
  // Refuse rather than silently no-op the decrement below — that produced
  // confirmed bookings against a spot with zero free slots.
  if ((spot.available_car_slots || 0) <= 0) {
    return res.status(409).json({ success: false, message: 'No slots left at this spot' });
  }

  // The payment must actually exist and be captured. Without this any client
  // could post arbitrary razorpay ids and receive a confirmed booking.
  const { PAYMENTS } = require('../db/paymentsDb');
  const payment = PAYMENTS.find(p => p.order_id === razorpay_order_id);
  if (!payment) {
    return res.status(402).json({ success: false, message: 'No payment found for this order' });
  }
  if (payment.user_id !== req.user.id) {
    return res.status(403).json({ success: false, message: 'That payment belongs to another account' });
  }
  if (payment.status !== 'PAID') {
    return res.status(402).json({ success: false, message: 'Payment has not been captured yet' });
  }
  if (payment.booking_id) {
    return res.status(409).json({ success: false, message: 'This payment has already been used for a booking' });
  }

  const totalHours = Math.max(1, Math.ceil((end - start) / 3600000));
  const pricing = calcPricing(spot.price_per_hour, totalHours, spot.surge_multiplier);

  const bookingCode = `PE-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
  const qrToken = `PE-QR-${bookingCode}-${Date.now()}-VERIFIED`;

  const newBooking = {
    id: bookingCode,
    booking_code: bookingCode,
    seeker_id: req.user.id,
    parking_space_id,
    vehicle_id: vehicle_id || null,
    start_time,
    end_time,
    total_hours: totalHours,
    base_amount: pricing.base,
    gst_amount: pricing.gst,
    platform_fee: pricing.fee,
    grand_total: pricing.total,
    booking_status: 'CONFIRMED',
    qr_verification_code: qrToken,
    payment_id: razorpay_payment_id,
    razorpay_order_id,
    razorpay_signature: razorpay_signature || null,
    created_at: new Date().toISOString(),
  };

  BOOKINGS.push(newBooking);

  // Tie the payment to this booking so it cannot be redeemed twice and the
  // invoice / payment history can cross-reference it.
  payment.booking_id = bookingCode;

  spot.available_car_slots -= 1;

  // Platform commission credit
  const commissionPct = parseFloat(process.env.PLATFORM_COMMISSION_PCT || 15) / 100;
  const ownerEarning = parseFloat((pricing.base * (1 - commissionPct)).toFixed(2));

  // Credit the host wallet, creating it on first earning — previously the
  // payout was silently dropped for any host without an existing wallet row.
  let ownerWallet = WALLETS.find(w => w.user_id === spot.owner_id);
  if (!ownerWallet) {
    ownerWallet = {
      id: `wallet-${uuidv4().slice(0, 8)}`,
      user_id: spot.owner_id,
      balance: 0,
      bank_account_number: null,
      ifsc_code: null,
      upi_id: null,
      bank_name: null,
      updated_at: new Date().toISOString(),
    };
    WALLETS.push(ownerWallet);
  }
  ownerWallet.balance = parseFloat((ownerWallet.balance + ownerEarning).toFixed(2));
  ownerWallet.updated_at = new Date().toISOString();
  TRANSACTIONS.push({
    id: `tx-${uuidv4().slice(0, 8)}`,
    wallet_id: ownerWallet.id,
    type: 'EARNING',
    amount: ownerEarning,
    description: `Booking #${bookingCode} payout`,
    status: 'SETTLED',
    created_at: new Date().toISOString(),
  });

  res.status(201).json({
    success: true,
    message: 'Booking confirmed successfully',
    booking: enrichBooking(newBooking),
    qr_code: qrToken,
    owner_earning: ownerEarning,
  });
});

// ── POST /api/v1/bookings/:id/verify-qr ──────────────────────────
router.post('/:id/verify-qr', authenticate, (req, res) => {
  const { qr_token } = req.body;
  const booking = BOOKINGS.find(b => b.booking_code === req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  if (booking.qr_verification_code !== qr_token) {
    return res.status(400).json({ success: false, message: 'Invalid QR code' });
  }
  if (booking.booking_status === 'ACTIVE') {
    return res.json({ success: true, message: 'QR already verified — parking active', booking: enrichBooking(booking) });
  }
  booking.booking_status = 'ACTIVE';
  res.json({ success: true, message: 'QR verified. Parking session started.', booking: enrichBooking(booking) });
});

// ── GET /api/v1/bookings/:id/invoice ─────────────────────────────
// Structured invoice for a booking. Only the seeker who made it, the host
// who owns the spot, or an admin may read it.
router.get('/:id/invoice', authenticate, (req, res) => {
  const booking = BOOKINGS.find(
    b => b.id === req.params.id || b.booking_code === req.params.id
  );
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

  const spot = PARKING_SPACES.find(s => s.id === booking.parking_space_id);
  const seeker = USERS.find(u => u.id === booking.seeker_id);
  const host = spot ? USERS.find(u => u.id === spot.owner_id) : null;

  const isSeeker = booking.seeker_id === req.user.id;
  const isHost = host?.id === req.user.id;
  if (!isSeeker && !isHost && req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, message: 'Not your booking' });
  }

  const { PLATFORM_SETTINGS } = require('../db/settingsDb');
  const pricing = PLATFORM_SETTINGS.pricing;

  const base = booking.base_amount || 0;
  const gst = booking.gst_amount ?? +(base * (pricing.gstPct / 100)).toFixed(2);
  const platformFee = booking.platform_fee ?? pricing.platformFeeFlat;
  const commission = +(base * (pricing.platformCommissionPct / 100)).toFixed(2);

  const { PAYMENTS } = require('../db/paymentsDb');
  const payment = PAYMENTS.find(p => p.booking_id === booking.booking_code && p.status === 'PAID') || null;

  res.json({
    success: true,
    invoice: {
      invoice_no: `INV-${booking.booking_code}`,
      issued_at: booking.created_at,
      status: booking.booking_status === 'CANCELLED' ? 'CANCELLED' : (payment ? 'PAID' : 'UNPAID'),

      seller: {
        name: PLATFORM_SETTINGS.general.platformName,
        email: PLATFORM_SETTINGS.general.supportEmail,
        phone: PLATFORM_SETTINGS.general.supportPhone,
      },
      billed_to: {
        name: seeker?.full_name || null,
        phone: seeker?.phone_number || null,
        email: seeker?.email || null,
      },
      host: { name: host?.full_name || null },

      spot: {
        title: spot?.title || null,
        address: spot?.address_line || null,
        city: spot?.city || null,
        latitude: spot?.latitude ?? null,
        longitude: spot?.longitude ?? null,
      },

      booking: {
        code: booking.booking_code,
        start_time: booking.start_time,
        end_time: booking.end_time,
        hours: booking.total_hours,
        status: booking.booking_status,
      },

      line_items: [
        { label: `Parking (${booking.total_hours}h)`, amount: base },
        { label: `GST (${pricing.gstPct}%)`, amount: gst },
        { label: 'Platform fee', amount: platformFee },
      ],
      totals: {
        subtotal: base,
        gst,
        platform_fee: platformFee,
        grand_total: booking.grand_total,
        currency: PLATFORM_SETTINGS.general.currency,
      },
      // Host-facing split; seekers see it too so the breakdown is transparent.
      settlement: {
        platform_commission: commission,
        host_payout: +(base - commission).toFixed(2),
      },

      payment: payment
        ? { order_id: payment.order_id, payment_id: payment.payment_id, method: payment.method, paid_at: payment.paid_at }
        : null,
    },
  });
});

// ── PATCH /api/v1/bookings/:id/cancel ────────────────────────────
router.patch('/:id/cancel', authenticate, (req, res) => {
  const booking = BOOKINGS.find(b => b.booking_code === req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  if (booking.seeker_id !== req.user.id && req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }
  if (['COMPLETED', 'CANCELLED'].includes(booking.booking_status)) {
    return res.status(400).json({ success: false, message: `Cannot cancel a ${booking.booking_status} booking` });
  }

  booking.booking_status = 'CANCELLED';
  // Restore slot
  const spot = PARKING_SPACES.find(s => s.id === booking.parking_space_id);
  if (spot) spot.available_car_slots += 1;

  res.json({ success: true, message: 'Booking cancelled', booking: enrichBooking(booking) });
});

// ── PATCH /api/v1/bookings/:id/extend ────────────────────────────
router.patch('/:id/extend', authenticate, (req, res) => {
  const { extra_hours } = req.body;
  if (!extra_hours || extra_hours < 1) return res.status(400).json({ success: false, message: 'extra_hours (min 1) required' });

  const booking = BOOKINGS.find(b => b.booking_code === req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  if (booking.seeker_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied' });
  if (booking.booking_status !== 'ACTIVE') return res.status(400).json({ success: false, message: 'Only ACTIVE bookings can be extended' });

  const spot = PARKING_SPACES.find(s => s.id === booking.parking_space_id);
  const addHours = parseInt(extra_hours);
  const extraPricing = calcPricing(spot ? spot.price_per_hour : 50, addHours);

  const newEnd = new Date(booking.end_time);
  newEnd.setHours(newEnd.getHours() + addHours);
  booking.end_time = newEnd.toISOString();
  booking.total_hours += addHours;
  booking.base_amount = parseFloat((booking.base_amount + extraPricing.base).toFixed(2));
  booking.gst_amount = parseFloat((booking.gst_amount + extraPricing.gst).toFixed(2));
  booking.grand_total = parseFloat((booking.grand_total + extraPricing.total).toFixed(2));

  res.json({ success: true, message: `Booking extended by ${addHours}h`, booking: enrichBooking(booking), extra_charge: extraPricing.total });
});

// ── PATCH /api/v1/bookings/:id/complete ──────────────────────────
router.patch('/:id/complete', authenticate, (req, res) => {
  const booking = BOOKINGS.find(b => b.booking_code === req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

  const spot = PARKING_SPACES.find(s => s.id === booking.parking_space_id);
  const isOwner = spot && spot.owner_id === req.user.id;
  if (!isOwner && req.user.role !== 'ADMIN') return res.status(403).json({ success: false, message: 'Only the host or admin can complete a booking' });

  booking.booking_status = 'COMPLETED';
  if (spot) spot.available_car_slots = Math.min(spot.total_car_slots, spot.available_car_slots + 1);

  res.json({ success: true, message: 'Booking completed', booking: enrichBooking(booking) });
});

module.exports = router;
