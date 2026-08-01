const express = require('express');
const router = express.Router();
const { ADMIN_ANALYTICS, USERS, PARKING_SPACES, BOOKINGS, KYC, WALLETS, TRANSACTIONS } = require('../db/inMemoryDb');
const {
  PLATFORM_SETTINGS, PAYOUTS, DISPUTES, ADMIN_USERS, ADMIN_ROLES,
  AUDIT_LOG, ADMIN_NOTIFICATIONS, recordAudit, publicSettings, maskSecret,
} = require('../db/settingsDb');
const { authenticate, requireRole } = require('../middleware/auth');

// All admin routes require ADMIN role
router.use(authenticate, requireRole('ADMIN'));

// ── Metric helpers ────────────────────────────────────────────────
const round2 = (n) => parseFloat((n || 0).toFixed(2));
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** Percentage change between two periods; null when there is no baseline. */
const growth = (current, previous) => {
  if (!previous) return null;
  return round2(((current - previous) / previous) * 100);
};

const billable = () => BOOKINGS.filter(b => b.booking_status !== 'CANCELLED');

// ── GET /api/v1/admin/dashboard ───────────────────────────────────
// Every figure is derived from live records. With an empty database this
// legitimately returns zeroes rather than invented sample numbers.
router.get('/dashboard', (req, res) => {
  const now = new Date();
  const thisMonth = monthKey(now);
  const prevMonth = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const commissionPct = ADMIN_ANALYTICS.commissionSettings.platformCommissionPct;

  const paidBookings = billable();
  const inMonth = (key) => paidBookings.filter(b => monthKey(new Date(b.created_at)) === key);

  const grossThisMonth = inMonth(thisMonth).reduce((s, b) => s + (b.grand_total || 0), 0);
  const grossPrevMonth = inMonth(prevMonth).reduce((s, b) => s + (b.grand_total || 0), 0);

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todays = paidBookings.filter(b => new Date(b.created_at) >= startOfToday);

  const usersThisMonth = USERS.filter(u => monthKey(new Date(u.created_at)) === thisMonth).length;
  const usersPrevMonth = USERS.filter(u => monthKey(new Date(u.created_at)) === prevMonth).length;

  res.json({
    success: true,
    metrics: {
      totalUsers: USERS.length,
      totalOwners: USERS.filter(u => u.active_role === 'OWNER').length,
      totalSeekers: USERS.filter(u => u.active_role === 'SEEKER').length,
      userGrowthPct: growth(usersThisMonth, usersPrevMonth),

      activeListings: PARKING_SPACES.filter(s => s.approval_status === 'APPROVED' && s.is_active).length,
      totalListings: PARKING_SPACES.length,
      pendingApprovals: PARKING_SPACES.filter(s => s.approval_status === 'PENDING_APPROVAL').length,

      totalBookings: BOOKINGS.length,
      activeBookingsNow: BOOKINGS.filter(b => b.booking_status === 'ACTIVE').length,
      kycPending: KYC.filter(k => k.verification_status === 'PENDING').length,

      grossRevenueMonth: round2(grossThisMonth),
      revenueGrowthPct: growth(grossThisMonth, grossPrevMonth),
      platformCommissionMonth: round2(
        inMonth(thisMonth).reduce((s, b) => s + ((b.base_amount || 0) * commissionPct) / 100, 0)
      ),
      totalRevenueLive: round2(paidBookings.reduce((s, b) => s + (b.grand_total || 0), 0)),

      todayTransactionsCount: todays.length,
      todayVolume: round2(todays.reduce((s, b) => s + (b.grand_total || 0), 0)),
    },
  });
});

// ── GET /api/v1/admin/users ───────────────────────────────────────
router.get('/users', (req, res) => {
  const { role, kyc_status, search, page = 1, limit = 20 } = req.query;
  let users = USERS.filter(u => u.active_role !== 'ADMIN');

  if (role) users = users.filter(u => u.active_role === role.toUpperCase());
  if (kyc_status) users = users.filter(u => u.kyc_status === kyc_status.toUpperCase());
  if (search) {
    const s = search.toLowerCase();
    users = users.filter(u => u.full_name.toLowerCase().includes(s) || u.email?.toLowerCase().includes(s) || u.phone_number.includes(s));
  }

  const total = users.length;
  const start = (parseInt(page) - 1) * parseInt(limit);
  const paginated = users.slice(start, start + parseInt(limit)).map(u => ({
    id: u.id, name: u.full_name, phone: u.phone_number, email: u.email,
    role: u.active_role, kyc_status: u.kyc_status, avatar: u.avatar_url,
    rating: u.rating_as_seeker, created_at: u.created_at,
  }));

  res.json({ success: true, total, page: parseInt(page), limit: parseInt(limit), users: paginated });
});

// ── GET /api/v1/admin/parking ─────────────────────────────────────
router.get('/parking', (req, res) => {
  const { status, city } = req.query;
  let spots = [...PARKING_SPACES];
  if (status) spots = spots.filter(s => s.approval_status === status.toUpperCase());
  if (city) spots = spots.filter(s => s.city.toLowerCase() === city.toLowerCase());

  res.json({ success: true, count: spots.length, spots: spots.map(s => {
    const owner = USERS.find(u => u.id === s.owner_id);
    return { ...s, ownerName: owner?.full_name, ownerPhone: owner?.phone_number };
  })});
});

// ── PATCH /api/v1/admin/parking/:id/approve ───────────────────────
router.patch('/parking/:id/approve', (req, res) => {
  const spot = PARKING_SPACES.find(s => s.id === req.params.id);
  if (!spot) return res.status(404).json({ success: false, message: 'Spot not found' });
  spot.approval_status = 'APPROVED';
  spot.is_active = true;
  recordAudit(req.user, 'listing.approve', spot.id, { title: spot.title, city: spot.city });
  res.json({ success: true, message: 'Parking spot approved and listed', spot });
});

// ── PATCH /api/v1/admin/parking/:id/reject ────────────────────────
router.patch('/parking/:id/reject', (req, res) => {
  const { reason } = req.body;
  const spot = PARKING_SPACES.find(s => s.id === req.params.id);
  if (!spot) return res.status(404).json({ success: false, message: 'Spot not found' });
  spot.approval_status = 'REJECTED';
  spot.is_active = false;
  spot.rejection_reason = reason || 'Does not meet platform standards';
  recordAudit(req.user, 'listing.reject', spot.id, { title: spot.title, reason: spot.rejection_reason });
  res.json({ success: true, message: 'Parking spot rejected', spot });
});

// ── GET /api/v1/admin/bookings ────────────────────────────────────
router.get('/bookings', (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  let bookings = [...BOOKINGS];
  if (status) bookings = bookings.filter(b => b.booking_status === status.toUpperCase());
  bookings.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

  const total = bookings.length;
  const start = (parseInt(page) - 1) * parseInt(limit);
  const paginated = bookings.slice(start, start + parseInt(limit)).map(b => {
    const spot = PARKING_SPACES.find(s => s.id === b.parking_space_id);
    const seeker = USERS.find(u => u.id === b.seeker_id);
    return { ...b, spotTitle: spot?.title, seekerName: seeker?.full_name, seekerPhone: seeker?.phone_number };
  });

  res.json({ success: true, total, page: parseInt(page), limit: parseInt(limit), bookings: paginated });
});

// ── GET /api/v1/admin/analytics/revenue ──────────────────────────
// Aggregated from real bookings. Series are emitted even when empty so the
// charts render an honest flat line instead of nothing.
router.get('/analytics/revenue', (req, res) => {
  const commissionPct = ADMIN_ANALYTICS.commissionSettings.platformCommissionPct;
  const rows = billable();
  const now = new Date();

  // Last 6 calendar months, oldest first.
  const revenue_graph = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    const key = monthKey(d);
    const monthRows = rows.filter(b => monthKey(new Date(b.created_at)) === key);
    return {
      month: d.toLocaleString('en-IN', { month: 'short' }),
      revenue: round2(monthRows.reduce((s, b) => s + (b.grand_total || 0), 0)),
      commission: round2(monthRows.reduce((s, b) => s + ((b.base_amount || 0) * commissionPct) / 100, 0)),
    };
  });

  // Demand by hour, only hours that actually have bookings.
  const hourCounts = rows.reduce((acc, b) => {
    const h = new Date(b.start_time).getHours();
    acc[h] = (acc[h] || 0) + 1;
    return acc;
  }, {});
  const peak_hours = Object.keys(hourCounts)
    .map(Number)
    .sort((a, b) => a - b)
    .map(h => ({ hour: `${String(h).padStart(2, '0')}:00`, bookings: hourCounts[h] }));

  // Share of bookings per city.
  const cityCounts = rows.reduce((acc, b) => {
    const spot = PARKING_SPACES.find(s => s.id === b.parking_space_id);
    const city = spot?.city;
    if (city) acc[city] = (acc[city] || 0) + 1;
    return acc;
  }, {});
  const cityTotal = Object.values(cityCounts).reduce((s, n) => s + n, 0);
  const city_breakdown = Object.entries(cityCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([city, count]) => ({
      city,
      count,
      percentage: cityTotal ? Math.round((count / cityTotal) * 100) : 0,
    }));

  const recent_bookings = [...BOOKINGS]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 8)
    .map(b => {
      const spot = PARKING_SPACES.find(s => s.id === b.parking_space_id);
      const seeker = USERS.find(u => u.id === b.seeker_id);
      return {
        id: b.booking_code,
        user: seeker?.full_name || null,
        spot: spot?.title || null,
        amount: b.grand_total,
        status: b.booking_status,
        created_at: b.created_at,
      };
    });

  res.json({ success: true, revenue_graph, peak_hours, city_breakdown, recent_bookings });
});

// ── PATCH /api/v1/admin/settings/commission ───────────────────────
router.patch('/settings/commission', (req, res) => {
  const { platformCommissionPct, gstPct, platformFeeFlat, surgeEnabled, maxSurgeMultiplier } = req.body;
  const settings = ADMIN_ANALYTICS.commissionSettings;
  if (platformCommissionPct !== undefined) settings.platformCommissionPct = parseFloat(platformCommissionPct);
  if (gstPct !== undefined) settings.gstPct = parseFloat(gstPct);
  if (platformFeeFlat !== undefined) settings.platformFeeFlat = parseFloat(platformFeeFlat);
  if (surgeEnabled !== undefined) settings.surgeEnabled = Boolean(surgeEnabled);
  if (maxSurgeMultiplier !== undefined) settings.maxSurgeMultiplier = parseFloat(maxSurgeMultiplier);

  // Also update env vars in memory
  if (platformCommissionPct) process.env.PLATFORM_COMMISSION_PCT = String(platformCommissionPct);
  if (gstPct) process.env.GST_PCT = String(gstPct);
  if (platformFeeFlat) process.env.PLATFORM_FEE_FLAT = String(platformFeeFlat);

  res.json({ success: true, message: 'Commission settings updated', settings });
});

// ── PATCH /api/v1/admin/users/:id/suspend ─────────────────────────
router.patch('/users/:id/suspend', (req, res) => {
  const user = USERS.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  user.is_suspended = true;
  recordAudit(req.user, 'user.suspend', user.id, { name: user.full_name });
  res.json({ success: true, message: `User ${user.full_name} suspended` });
});

// ── GET /api/v1/admin/payments ────────────────────────────────────
router.get('/payments', (req, res) => {
  const allTxns = [...require('../db/inMemoryDb').TRANSACTIONS].sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
  const totalVolume = allTxns.filter(t => t.type === 'EARNING').reduce((s,t) => s + t.amount, 0);
  const totalWithdrawals = allTxns.filter(t => t.type === 'WITHDRAWAL').reduce((s,t) => s + Math.abs(t.amount), 0);
  res.json({ success: true, total_volume: parseFloat(totalVolume.toFixed(2)), total_withdrawals: parseFloat(totalWithdrawals.toFixed(2)), transactions: allTxns.slice(0, 50) });
});

// ── GET /api/v1/admin/gateway-payments ────────────────────────────
// Razorpay ledger across all users — separate from wallet transactions.
router.get('/gateway-payments', (req, res) => {
  const { PAYMENTS } = require('../db/paymentsDb');
  const { status, limit = 100 } = req.query;

  let rows = [...PAYMENTS];
  if (status) rows = rows.filter(p => p.status === status.toUpperCase());
  rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const withUser = rows.slice(0, parseInt(limit, 10)).map(p => {
    const user = USERS.find(u => u.id === p.user_id);
    return { ...p, user_name: user?.full_name || null, user_phone: user?.phone_number || null };
  });

  const paid = PAYMENTS.filter(p => p.status === 'PAID');
  const failed = PAYMENTS.filter(p => p.status === 'FAILED');

  res.json({
    success: true,
    count: rows.length,
    captured: parseFloat(paid.reduce((s, p) => s + p.amount, 0).toFixed(2)),
    paid_count: paid.length,
    failed_count: failed.length,
    success_rate: PAYMENTS.length ? Math.round((paid.length / PAYMENTS.length) * 100) : 0,
    payments: withUser,
  });
});

// ══════════════════════════════════════════════════════════════════
// PLATFORM SETTINGS
// ══════════════════════════════════════════════════════════════════

// ── GET /api/v1/admin/settings ────────────────────────────────────
router.get('/settings', (req, res) => {
  res.json({ success: true, settings: publicSettings(), roles: ADMIN_ROLES });
});

/** Shallow-merge `patch` into `target`, ignoring undefined/blank-secret values. */
const applyPatch = (target, patch, { skipBlank = [] } = {}) => {
  const changed = {};
  Object.entries(patch || {}).forEach(([key, value]) => {
    if (value === undefined) return;
    if (skipBlank.includes(key) && (value === '' || value === null)) return;
    if (!(key in target)) return;
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof target[key] === 'object') {
      Object.entries(value).forEach(([k, v]) => {
        if (v !== undefined && k in target[key]) target[key][k] = v;
      });
      changed[key] = { ...target[key] };
    } else if (target[key] !== value) {
      target[key] = value;
      changed[key] = value;
    }
  });
  return changed;
};

// ── PATCH /api/v1/admin/settings/payment ──────────────────────────
// Razorpay / gateway configuration. Blank secrets are ignored so the
// UI can submit the masked placeholder without wiping stored keys.
router.patch('/settings/payment', (req, res) => {
  const { mode, keyId, keySecret, webhookSecret } = req.body;

  if (mode && !['TEST', 'LIVE'].includes(mode)) {
    return res.status(400).json({ success: false, message: 'mode must be TEST or LIVE' });
  }
  if (keyId && !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId)) {
    return res.status(400).json({ success: false, message: 'Key ID must look like rzp_test_xxx or rzp_live_xxx' });
  }
  // Guard against a live key being saved while the panel says TEST (and vice versa).
  const effectiveMode = mode || PLATFORM_SETTINGS.payment.mode;
  if (keyId && effectiveMode === 'LIVE' && keyId.startsWith('rzp_test_')) {
    return res.status(400).json({ success: false, message: 'Cannot save a test Key ID while mode is LIVE' });
  }
  if (keyId && effectiveMode === 'TEST' && keyId.startsWith('rzp_live_')) {
    return res.status(400).json({ success: false, message: 'Cannot save a live Key ID while mode is TEST' });
  }
  // Masked values coming back from the UI must never overwrite real secrets.
  // Guard on shape rather than a single bullet character, so a mangled or
  // re-encoded mask (•, *, ●, ·, ?) can never be stored as a live credential.
  const looksMasked = (value, current) => {
    if (typeof value !== 'string' || !value) return false;
    if (current && value === maskSecret(current)) return true;
    // Any run of mask-ish glyphs followed by at most 4 visible chars.
    return /^[•*●·◦.?•●�\s]{4,}[A-Za-z0-9]{0,4}$/.test(value);
  };

  const clean = { ...req.body };
  if (looksMasked(clean.keySecret, PLATFORM_SETTINGS.payment.keySecret)) delete clean.keySecret;
  if (looksMasked(clean.webhookSecret, PLATFORM_SETTINGS.payment.webhookSecret)) delete clean.webhookSecret;

  // A real Razorpay secret is a 20-24 char alphanumeric string. Reject anything
  // that survived the mask check but still cannot be a credential.
  if (clean.keySecret !== undefined && !/^[A-Za-z0-9_-]{16,64}$/.test(clean.keySecret)) {
    return res.status(400).json({ success: false, message: 'Key Secret must be 16-64 alphanumeric characters' });
  }

  const changed = applyPatch(PLATFORM_SETTINGS.payment, clean, { skipBlank: ['keySecret', 'webhookSecret'] });

  if (clean.keyId) process.env.RAZORPAY_KEY_ID = clean.keyId;
  if (clean.keySecret) process.env.RAZORPAY_KEY_SECRET = clean.keySecret;
  if (clean.webhookSecret) process.env.RAZORPAY_WEBHOOK_SECRET = clean.webhookSecret;

  recordAudit(req.user, 'settings.payment.update', 'payment', {
    fields: Object.keys(changed).filter(k => !['keySecret', 'webhookSecret'].includes(k)),
    secretsRotated: Boolean(clean.keySecret || clean.webhookSecret),
  });

  res.json({ success: true, message: 'Payment settings updated', settings: publicSettings().payment });
});

// ── POST /api/v1/admin/settings/payment/test ──────────────────────
// Validates that a key pair is present and well-formed. Does not call
// Razorpay — no network dependency in dev.
router.post('/settings/payment/test', (req, res) => {
  const { keyId, keySecret, mode } = PLATFORM_SETTINGS.payment;
  const problems = [];
  if (!keyId) problems.push('Key ID is not set');
  if (!keySecret) problems.push('Key Secret is not set');
  if (keyId && mode === 'LIVE' && keyId.startsWith('rzp_test_')) problems.push('Mode is LIVE but a test Key ID is configured');
  if (keyId && mode === 'TEST' && keyId.startsWith('rzp_live_')) problems.push('Mode is TEST but a live Key ID is configured');

  const ok = problems.length === 0;
  PLATFORM_SETTINGS.payment.lastTestedAt = new Date().toISOString();
  PLATFORM_SETTINGS.payment.lastTestResult = ok ? 'PASS' : 'FAIL';

  recordAudit(req.user, 'settings.payment.test', 'payment', { result: ok ? 'PASS' : 'FAIL' });

  res.json({
    success: ok,
    message: ok ? `Razorpay ${mode} credentials look valid` : 'Configuration incomplete',
    problems,
    checked_at: PLATFORM_SETTINGS.payment.lastTestedAt,
  });
});

// ── PATCH /api/v1/admin/settings/:section ─────────────────────────
router.patch('/settings/:section', (req, res) => {
  const { section } = req.params;
  if (section === 'payment') return res.status(400).json({ success: false, message: 'Use /settings/payment' });
  if (!(section in PLATFORM_SETTINGS)) {
    return res.status(404).json({ success: false, message: `Unknown settings section: ${section}` });
  }

  const changed = applyPatch(PLATFORM_SETTINGS[section], req.body);

  // Keep the legacy commission block in sync so pricing math stays correct.
  if (section === 'pricing') {
    const p = PLATFORM_SETTINGS.pricing;
    Object.assign(ADMIN_ANALYTICS.commissionSettings, {
      platformCommissionPct: p.platformCommissionPct,
      gstPct: p.gstPct,
      platformFeeFlat: p.platformFeeFlat,
      surgeEnabled: p.surgeEnabled,
      maxSurgeMultiplier: p.maxSurgeMultiplier,
    });
    process.env.PLATFORM_COMMISSION_PCT = String(p.platformCommissionPct);
    process.env.GST_PCT = String(p.gstPct);
    process.env.PLATFORM_FEE_FLAT = String(p.platformFeeFlat);
  }

  recordAudit(req.user, `settings.${section}.update`, section, { fields: Object.keys(changed) });
  res.json({ success: true, message: `${section} settings updated`, settings: publicSettings()[section] });
});

// ══════════════════════════════════════════════════════════════════
// PAYOUTS
// ══════════════════════════════════════════════════════════════════

// ── GET /api/v1/admin/payouts ─────────────────────────────────────
router.get('/payouts', (req, res) => {
  const { status } = req.query;
  let rows = [...PAYOUTS];
  if (status) rows = rows.filter(p => p.status === status.toUpperCase());
  rows.sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at));

  // Re-resolve the host name at read time so the Host column never renders
  // blank, even for a row written before the name was captured.
  const enriched = rows.map(p => {
    if (p.user_name) return p;
    const u = USERS.find(x => x.id === p.user_id);
    return { ...p, user_name: u?.full_name || 'Unknown', user_phone: u?.phone_number || null };
  });

  res.json({
    success: true,
    count: enriched.length,
    pending_amount: PAYOUTS.filter(p => p.status === 'PENDING').reduce((s, p) => s + p.amount, 0),
    payouts: enriched,
  });
});

// ── PATCH /api/v1/admin/payouts/:id/approve ───────────────────────
router.patch('/payouts/:id/approve', (req, res) => {
  const payout = PAYOUTS.find(p => p.id === req.params.id);
  if (!payout) return res.status(404).json({ success: false, message: 'Payout not found' });
  if (payout.status !== 'PENDING') {
    return res.status(409).json({ success: false, message: `Payout already ${payout.status}` });
  }
  payout.status = 'COMPLETED';
  payout.processed_at = new Date().toISOString();
  payout.reference = req.body.reference || `RZPX${Date.now().toString().slice(-9)}`;

  recordAudit(req.user, 'payout.approve', payout.id, { amount: payout.amount, user: payout.user_name });
  res.json({ success: true, message: `₹${payout.amount} released to ${payout.user_name}`, payout });
});

// ── PATCH /api/v1/admin/payouts/:id/reject ────────────────────────
router.patch('/payouts/:id/reject', (req, res) => {
  const payout = PAYOUTS.find(p => p.id === req.params.id);
  if (!payout) return res.status(404).json({ success: false, message: 'Payout not found' });
  if (payout.status !== 'PENDING') {
    return res.status(409).json({ success: false, message: `Payout already ${payout.status}` });
  }
  payout.status = 'REJECTED';
  payout.processed_at = new Date().toISOString();
  payout.note = req.body.reason || 'Rejected by admin';

  recordAudit(req.user, 'payout.reject', payout.id, { reason: payout.note });
  res.json({ success: true, message: 'Payout rejected', payout });
});

// ══════════════════════════════════════════════════════════════════
// DISPUTES
// ══════════════════════════════════════════════════════════════════

// ── GET /api/v1/admin/disputes ────────────────────────────────────
router.get('/disputes', (req, res) => {
  const { status, priority } = req.query;
  let rows = [...DISPUTES];
  if (status) rows = rows.filter(d => d.status === status.toUpperCase());
  if (priority) rows = rows.filter(d => d.priority === priority.toUpperCase());
  rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({
    success: true,
    count: rows.length,
    open: DISPUTES.filter(d => d.status === 'OPEN').length,
    disputes: rows,
  });
});

// ── PATCH /api/v1/admin/disputes/:id ──────────────────────────────
router.patch('/disputes/:id', (req, res) => {
  const dispute = DISPUTES.find(d => d.id === req.params.id);
  if (!dispute) return res.status(404).json({ success: false, message: 'Dispute not found' });

  const { status, priority, resolution } = req.body;
  if (status && !['OPEN', 'IN_PROGRESS', 'RESOLVED', 'REJECTED'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status' });
  }
  if (status) dispute.status = status;
  if (priority) dispute.priority = priority;
  if (resolution !== undefined) dispute.resolution = resolution;
  if (status === 'RESOLVED' || status === 'REJECTED') dispute.resolved_at = new Date().toISOString();

  recordAudit(req.user, 'dispute.update', dispute.id, { status: dispute.status });
  res.json({ success: true, message: 'Dispute updated', dispute });
});

// ══════════════════════════════════════════════════════════════════
// ADMIN USERS & RBAC
// ══════════════════════════════════════════════════════════════════

// ── GET /api/v1/admin/admins ──────────────────────────────────────
router.get('/admins', (req, res) => {
  res.json({ success: true, admins: ADMIN_USERS, roles: ADMIN_ROLES });
});

// ── POST /api/v1/admin/admins ─────────────────────────────────────
router.post('/admins', (req, res) => {
  const { name, email, phone, role } = req.body;
  if (!name || !email || !role) {
    return res.status(400).json({ success: false, message: 'name, email and role are required' });
  }
  if (!(role in ADMIN_ROLES)) {
    return res.status(400).json({ success: false, message: `Unknown role: ${role}` });
  }
  if (ADMIN_USERS.some(a => a.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ success: false, message: 'An admin with that email already exists' });
  }

  const admin = {
    id: `admin-${Date.now().toString().slice(-6)}`,
    name, email, phone: phone || null, role,
    status: 'INVITED', last_login_at: null,
    created_at: new Date().toISOString(),
  };
  ADMIN_USERS.push(admin);

  recordAudit(req.user, 'admin.create', admin.id, { email, role });
  res.status(201).json({ success: true, message: `Invite sent to ${email}`, admin });
});

// ── PATCH /api/v1/admin/admins/:id ────────────────────────────────
router.patch('/admins/:id', (req, res) => {
  const admin = ADMIN_USERS.find(a => a.id === req.params.id);
  if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });

  const { role, status } = req.body;
  if (role && !(role in ADMIN_ROLES)) {
    return res.status(400).json({ success: false, message: `Unknown role: ${role}` });
  }
  // Never allow the last active super admin to be demoted or disabled.
  const activeSupers = ADMIN_USERS.filter(a => a.role === 'SUPER_ADMIN' && a.status === 'ACTIVE');
  const isLastSuper = admin.role === 'SUPER_ADMIN' && admin.status === 'ACTIVE' && activeSupers.length === 1;
  if (isLastSuper && ((role && role !== 'SUPER_ADMIN') || (status && status !== 'ACTIVE'))) {
    return res.status(409).json({ success: false, message: 'Cannot demote or disable the last active Super Admin' });
  }
  if (role) admin.role = role;
  if (status) admin.status = status;

  recordAudit(req.user, 'admin.update', admin.id, { role: admin.role, status: admin.status });
  res.json({ success: true, message: 'Admin updated', admin });
});

// ── DELETE /api/v1/admin/admins/:id ───────────────────────────────
router.delete('/admins/:id', (req, res) => {
  const idx = ADMIN_USERS.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Admin not found' });

  const admin = ADMIN_USERS[idx];
  if (admin.id === req.user.id) {
    return res.status(409).json({ success: false, message: 'You cannot remove your own admin account' });
  }
  const activeSupers = ADMIN_USERS.filter(a => a.role === 'SUPER_ADMIN' && a.status === 'ACTIVE');
  if (admin.role === 'SUPER_ADMIN' && activeSupers.length === 1) {
    return res.status(409).json({ success: false, message: 'Cannot remove the last active Super Admin' });
  }
  ADMIN_USERS.splice(idx, 1);

  recordAudit(req.user, 'admin.delete', admin.id, { email: admin.email });
  res.json({ success: true, message: `${admin.name} removed` });
});

// ══════════════════════════════════════════════════════════════════
// USERS (extra actions)
// ══════════════════════════════════════════════════════════════════

// ── PATCH /api/v1/admin/users/:id/unsuspend ───────────────────────
router.patch('/users/:id/unsuspend', (req, res) => {
  const user = USERS.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  user.is_suspended = false;

  recordAudit(req.user, 'user.unsuspend', user.id, { name: user.full_name });
  res.json({ success: true, message: `User ${user.full_name} reinstated` });
});

// ── GET /api/v1/admin/users/:id ───────────────────────────────────
router.get('/users/:id', (req, res) => {
  const user = USERS.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  // biometric_token is a credential — it was being sent to the admin console
  // alongside the password hash exclusion, which missed it.
  const { password_hash, biometric_token, ...safe } = user;
  const wallet = WALLETS.find(w => w.user_id === user.id) || null;

  res.json({
    success: true,
    user: safe,
    listings: PARKING_SPACES.filter(s => s.owner_id === user.id),
    bookings: BOOKINGS.filter(b => b.seeker_id === user.id),
    wallet,
    kyc: KYC.find(k => k.user_id === user.id) || null,
  });
});

// ══════════════════════════════════════════════════════════════════
// NOTIFICATIONS & AUDIT LOG
// ══════════════════════════════════════════════════════════════════

// ── GET /api/v1/admin/notifications ───────────────────────────────
router.get('/notifications', (req, res) => {
  res.json({
    success: true,
    unread: ADMIN_NOTIFICATIONS.filter(n => !n.read).length,
    notifications: [...ADMIN_NOTIFICATIONS].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
  });
});

// ── PATCH /api/v1/admin/notifications/read ────────────────────────
router.patch('/notifications/read', (req, res) => {
  const { id } = req.body;
  if (id) {
    const n = ADMIN_NOTIFICATIONS.find(x => x.id === id);
    if (n) n.read = true;
  } else {
    ADMIN_NOTIFICATIONS.forEach(n => { n.read = true; });
  }
  res.json({ success: true, unread: ADMIN_NOTIFICATIONS.filter(n => !n.read).length });
});

// ── GET /api/v1/admin/audit-log ───────────────────────────────────
router.get('/audit-log', (req, res) => {
  const { action, limit = 100 } = req.query;
  let rows = [...AUDIT_LOG];
  if (action) rows = rows.filter(e => e.action.startsWith(action));
  res.json({ success: true, count: rows.length, entries: rows.slice(0, parseInt(limit)) });
});

module.exports = router;
