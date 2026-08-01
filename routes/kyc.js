const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { KYC, USERS, PARKING_SPACES } = require('../db/inMemoryDb');
const { authenticate, requireRole } = require('../middleware/auth');
const { checkAadhaar, checkPan, digitsOnly } = require('../utils/validate');

// ── GET /api/v1/kyc/status ────────────────────────────────────────
router.get('/status', authenticate, (req, res) => {
  const kyc = KYC.find(k => k.user_id === req.user.id);
  const user = USERS.find(u => u.id === req.user.id);
  res.json({
    success: true,
    kyc_status: user ? user.kyc_status : 'NOT_SUBMITTED',
    kyc: kyc || null,
  });
});

// ── POST /api/v1/kyc/submit ───────────────────────────────────────
// Body: { aadhaar_number, pan_number, aadhaar_front_url, pan_card_url, selfie_photo_url, driving_license_url? }
router.post('/submit', authenticate, (req, res) => {
  const { aadhaar_number, pan_number, aadhaar_front_url, pan_card_url, selfie_photo_url, driving_license_url } = req.body;

  // Validate the raw numbers before the Aadhaar gets masked below.
  const fieldError =
    checkAadhaar(aadhaar_number) ||
    checkPan(pan_number) ||
    (!aadhaar_front_url ? 'Aadhaar photo is required' : null) ||
    (!selfie_photo_url ? 'Selfie is required' : null);
  if (fieldError) {
    return res.status(400).json({ success: false, message: fieldError });
  }

  // Re-submitting over an already-approved record would silently drop the
  // host back to PENDING, so it is refused outright.
  const already = KYC.find(k => k.user_id === req.user.id);
  if (already && already.verification_status === 'VERIFIED') {
    return res.status(409).json({ success: false, message: 'Your KYC is already verified' });
  }

  // Check if already submitted
  const existing = KYC.findIndex(k => k.user_id === req.user.id);
  const user = USERS.find(u => u.id === req.user.id);
  const userName = user ? user.full_name : 'Unknown';

  const kycRecord = {
    id: existing >= 0 ? KYC[existing].id : `kyc-${uuidv4().slice(0,8)}`,
    user_id: req.user.id,
    user_name: userName,
    email: user ? user.email : null,
    phone: user ? user.phone_number : null,
    role: user ? user.active_role : 'SEEKER',
    // Strip separators first, else a "1234 5678 9012" input keeps its spaces
    // and only part of it gets masked.
    aadhaar_number: digitsOnly(aadhaar_number).replace(/\d(?=\d{4})/g, 'X'),
    pan_number: String(pan_number).trim().toUpperCase(),
    aadhaar_front_url,
    pan_card_url: pan_card_url || null,
    selfie_photo_url,
    driving_license_url: driving_license_url || null,
    verification_status: 'PENDING',
    submitted_at: new Date().toISOString(),
    rejection_reason: null,
  };

  if (existing >= 0) {
    KYC[existing] = kycRecord;
  } else {
    KYC.push(kycRecord);
  }

  if (user) user.kyc_status = 'PENDING';

  res.status(201).json({ success: true, message: 'KYC submitted for verification (1–2 business days)', kyc: kycRecord });
});

// ── GET /api/v1/kyc/admin/queue ───────────────────────────────────
// Admin: list all pending KYC
router.get('/admin/queue', authenticate, requireRole('ADMIN'), (req, res) => {
  const { status = 'PENDING' } = req.query;
  const list = status === 'ALL' ? KYC : KYC.filter(k => k.verification_status === status.toUpperCase());
  res.json({ success: true, count: list.length, kyc_list: list });
});

// ── PATCH /api/v1/kyc/admin/:id/approve ──────────────────────────
router.patch('/admin/:id/approve', authenticate, requireRole('ADMIN'), (req, res) => {
  const idx = KYC.findIndex(k => k.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'KYC record not found' });

  KYC[idx].verification_status = 'VERIFIED';
  KYC[idx].verified_at = new Date().toISOString();
  KYC[idx].verified_by_admin_id = req.user.id;

  // Update user KYC status
  const user = USERS.find(u => u.id === KYC[idx].user_id);
  if (user) user.kyc_status = 'VERIFIED';

  res.json({ success: true, message: 'KYC approved', kyc: KYC[idx] });
});

// ── PATCH /api/v1/kyc/admin/:id/reject ───────────────────────────
router.patch('/admin/:id/reject', authenticate, requireRole('ADMIN'), (req, res) => {
  const { reason } = req.body;
  const idx = KYC.findIndex(k => k.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'KYC record not found' });

  KYC[idx].verification_status = 'REJECTED';
  KYC[idx].rejection_reason = reason || 'Documents unclear or invalid';
  KYC[idx].rejected_at = new Date().toISOString();

  const user = USERS.find(u => u.id === KYC[idx].user_id);
  if (user) user.kyc_status = 'REJECTED';

  // An unverified host must not have anything public. Rejecting their identity
  // takes their live spaces down straight away rather than leaving them
  // bookable until someone notices.
  let pulled = 0;
  PARKING_SPACES.forEach(s => {
    if (s.owner_id === KYC[idx].user_id && s.is_active) {
      s.is_active = false;
      pulled++;
    }
  });

  res.json({
    success: true,
    message: pulled
      ? `KYC rejected — ${pulled} live space${pulled > 1 ? 's' : ''} taken offline`
      : 'KYC rejected',
    kyc: KYC[idx],
    spaces_deactivated: pulled,
  });
});

module.exports = router;
