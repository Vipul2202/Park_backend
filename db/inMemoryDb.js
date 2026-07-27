/**
 * ParkEase In-Memory Database
 * Production would use PostgreSQL + PostGIS.
 *
 * Seed content has deliberately been reduced to the sign-in accounts only.
 * Every other collection starts empty and fills up through real app usage,
 * so nothing the admin panel reports is invented — the dashboard shows
 * zeroes until real listings, bookings and payments exist.
 */

const bcrypt = require('bcryptjs');

// ──────────────────────────────────────────
// USERS TABLE — the only seeded records
// ──────────────────────────────────────────
const USERS = [
  {
    id: 'user-001',
    phone_number: '+919876543210',
    email: 'rahul.kumar@gmail.com',
    password_hash: bcrypt.hashSync('Password@123', 10),
    full_name: 'Rahul Kumar',
    avatar_url: null,
    active_role: 'SEEKER',
    kyc_status: 'NOT_SUBMITTED',
    is_phone_verified: true,
    is_email_verified: true,
    rating_as_seeker: null,
    rating_as_owner: null,
    biometric_token: null,
    created_at: '2024-01-10T00:00:00Z',
  },
  {
    id: 'user-002',
    phone_number: '+919876543211',
    email: 'rajesh.sharma@gmail.com',
    password_hash: bcrypt.hashSync('Password@123', 10),
    full_name: 'Rajesh Sharma',
    avatar_url: null,
    active_role: 'OWNER',
    kyc_status: 'NOT_SUBMITTED',
    is_phone_verified: true,
    is_email_verified: true,
    rating_as_seeker: null,
    rating_as_owner: null,
    biometric_token: null,
    created_at: '2024-01-15T00:00:00Z',
  },
  {
    id: 'user-003',
    phone_number: '+919812345678',
    email: 'sunita.reddy@gmail.com',
    password_hash: bcrypt.hashSync('Password@123', 10),
    full_name: 'Sunita Reddy',
    avatar_url: null,
    active_role: 'OWNER',
    kyc_status: 'NOT_SUBMITTED',
    is_phone_verified: true,
    is_email_verified: true,
    rating_as_seeker: null,
    rating_as_owner: null,
    biometric_token: null,
    created_at: '2023-11-20T00:00:00Z',
  },
  {
    id: 'admin-001',
    phone_number: '+919000000001',
    email: 'admin@parkease.in',
    // The fallback is committed and therefore public. Any deployment that
    // is reachable from the internet must set ADMIN_PASSWORD.
    password_hash: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'Admin@2026!', 10),
    full_name: 'ParkEase Admin',
    avatar_url: null,
    active_role: 'ADMIN',
    kyc_status: 'VERIFIED',
    is_phone_verified: true,
    is_email_verified: true,
    rating_as_seeker: null,
    rating_as_owner: null,
    biometric_token: null,
    created_at: '2024-01-01T00:00:00Z',
  },
];

// ──────────────────────────────────────────
// OTP STORE (in-memory, 5 min TTL)
// ──────────────────────────────────────────
const OTP_STORE = {}; // { phone: { otp, expiry } }

// ──────────────────────────────────────────
// Operational tables — populated at runtime
// ──────────────────────────────────────────
const VEHICLES = [];
const PARKING_SPACES = [];
const BOOKINGS = [];
const WALLETS = [];        // auto-created per user on first wallet read
const TRANSACTIONS = [];
const KYC = [];
const REVIEWS = [];

// ──────────────────────────────────────────
// PLATFORM CONFIG
// Configuration, not sample data — the admin panel edits these.
// Live metrics are computed from the tables above, never stored here.
// ──────────────────────────────────────────
const ADMIN_ANALYTICS = {
  commissionSettings: {
    platformCommissionPct: 15,
    gstPct: 18,
    platformFeeFlat: 15,
    surgeEnabled: true,
    maxSurgeMultiplier: 2.0,
  },
};

// ──────────────────────────────────────────
// REFRESH TOKENS (in-memory)
// ──────────────────────────────────────────
const REFRESH_TOKENS = new Set();

module.exports = {
  USERS,
  OTP_STORE,
  VEHICLES,
  PARKING_SPACES,
  BOOKINGS,
  WALLETS,
  TRANSACTIONS,
  KYC,
  REVIEWS,
  ADMIN_ANALYTICS,
  REFRESH_TOKENS,
};
