const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { USERS, SEEDED_PHONES, OTP_STORE, REFRESH_TOKENS } = require('../db/inMemoryDb');
const { authenticate } = require('../middleware/auth');

// ── Helper: generate tokens ──────────────────────────────────────
const generateTokens = (user) => {
  const payload = { id: user.id, phone: user.phone_number, role: user.active_role, name: user.full_name };
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
  const refreshToken = jwt.sign({ id: user.id }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' });
  REFRESH_TOKENS.add(refreshToken);
  return { accessToken, refreshToken };
};

// ── Helper: generate 6-digit OTP ────────────────────────────────
const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

// No SMS gateway is wired up, so a randomly generated OTP can only be read
// from the server log — which makes the deployed demo unusable. The seeded
// accounts therefore accept a fixed code. Numbers that registered at runtime
// are untouched and still get a random OTP.
const DEMO_OTP = process.env.DEMO_OTP || '000000';
const isDemoPhone = (phone) => SEEDED_PHONES.includes(phone);

// POST /api/v1/auth/send-otp
// Body: { phone }
router.post('/send-otp', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, message: 'Phone number required' });

  const demo = isDemoPhone(phone);
  const otp = demo ? DEMO_OTP : generateOtp();
  const expiry = Date.now() + 5 * 60 * 1000; // 5 min
  OTP_STORE[phone] = { otp, expiry };

  console.log(`[OTP] Phone: ${phone} → OTP: ${otp}${demo ? ' (seeded demo account)' : ''}`);

  res.json({
    success: true,
    message: demo ? `Demo account — use code ${DEMO_OTP}` : 'OTP sent successfully',
    // Only ever disclosed for the seeded accounts, whose fixed code is public
    // anyway. A real number's OTP is never returned over the API.
    demo_otp: demo ? DEMO_OTP : undefined,
    dev_otp: process.env.NODE_ENV === 'development' ? otp : undefined,
  });
});

// POST /api/v1/auth/verify-otp
// Body: { phone, otp }
router.post('/verify-otp', (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ success: false, message: 'Phone and OTP required' });

  const record = OTP_STORE[phone];
  if (!record || record.expiry < Date.now()) {
    return res.status(400).json({ success: false, message: 'OTP expired or not found. Request a new one.' });
  }
  if (record.otp !== otp) {
    return res.status(400).json({ success: false, message: 'Invalid OTP' });
  }

  delete OTP_STORE[phone]; // consume OTP

  // Check if user exists — if not, return "new_user" flag
  const user = USERS.find(u => u.phone_number === phone);
  if (!user) {
    return res.json({ success: true, is_new_user: true, phone, message: 'OTP verified. Please complete registration.' });
  }

  const tokens = generateTokens(user);
  res.json({
    success: true,
    is_new_user: false,
    message: 'Login successful',
    user: { id: user.id, name: user.full_name, phone: user.phone_number, email: user.email, role: user.active_role, kyc_status: user.kyc_status, avatar: user.avatar_url },
    ...tokens,
  });
});

// POST /api/v1/auth/register
// Body: { phone, full_name, email, password, role }
router.post('/register', (req, res) => {
  const { phone, full_name, email, password, role = 'SEEKER' } = req.body;
  if (!phone || !full_name || !password) {
    return res.status(400).json({ success: false, message: 'Phone, name and password are required' });
  }

  const exists = USERS.find(u => u.phone_number === phone || u.email === email);
  if (exists) return res.status(409).json({ success: false, message: 'User with this phone/email already exists' });

  const newUser = {
    id: uuidv4(),
    phone_number: phone,
    email: email || null,
    password_hash: bcrypt.hashSync(password, 10),
    full_name,
    avatar_url: null,
    active_role: ['SEEKER', 'OWNER'].includes(role) ? role : 'SEEKER',
    kyc_status: 'NOT_SUBMITTED',
    is_phone_verified: true,
    is_email_verified: false,
    rating_as_seeker: 5.0,
    rating_as_owner: 5.0,
    biometric_token: null,
    created_at: new Date().toISOString(),
  };

  USERS.push(newUser);

  const tokens = generateTokens(newUser);
  res.status(201).json({
    success: true,
    message: 'Account created successfully',
    user: { id: newUser.id, name: newUser.full_name, phone: newUser.phone_number, email: newUser.email, role: newUser.active_role, kyc_status: newUser.kyc_status },
    ...tokens,
  });
});

// POST /api/v1/auth/login
// Body: { phone, password }
router.post('/login', (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ success: false, message: 'Phone and password required' });

  const user = USERS.find(u => u.phone_number === phone);
  if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return res.status(401).json({ success: false, message: 'Invalid credentials' });

  const tokens = generateTokens(user);
  res.json({
    success: true,
    message: 'Login successful',
    user: { id: user.id, name: user.full_name, phone: user.phone_number, email: user.email, role: user.active_role, kyc_status: user.kyc_status, avatar: user.avatar_url },
    ...tokens,
  });
});

// POST /api/v1/auth/refresh
// Body: { refreshToken }
router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ success: false, message: 'Refresh token required' });
  if (!REFRESH_TOKENS.has(refreshToken)) return res.status(401).json({ success: false, message: 'Invalid or revoked refresh token' });

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = USERS.find(u => u.id === decoded.id);
    if (!user) return res.status(401).json({ success: false, message: 'User not found' });

    REFRESH_TOKENS.delete(refreshToken);
    const tokens = generateTokens(user);
    res.json({ success: true, ...tokens });
  } catch (err) {
    REFRESH_TOKENS.delete(refreshToken);
    res.status(401).json({ success: false, message: 'Expired or invalid refresh token' });
  }
});

// POST /api/v1/auth/logout
router.post('/logout', authenticate, (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) REFRESH_TOKENS.delete(refreshToken);
  res.json({ success: true, message: 'Logged out successfully' });
});

// GET /api/v1/auth/me
router.get('/me', authenticate, (req, res) => {
  const user = USERS.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({
    success: true,
    user: { id: user.id, name: user.full_name, phone: user.phone_number, email: user.email, role: user.active_role, kyc_status: user.kyc_status, avatar: user.avatar_url, rating_seeker: user.rating_as_seeker, rating_owner: user.rating_as_owner },
  });
});

// POST /api/v1/auth/switch-role
// Body: { role: 'SEEKER' | 'OWNER' }
router.post('/switch-role', authenticate, (req, res) => {
  const { role } = req.body;
  if (!['SEEKER', 'OWNER'].includes(role)) return res.status(400).json({ success: false, message: 'Role must be SEEKER or OWNER' });
  const user = USERS.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  user.active_role = role;
  const tokens = generateTokens(user);
  res.json({ success: true, message: `Role switched to ${role}`, role, ...tokens });
});

module.exports = router;
