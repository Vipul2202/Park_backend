/**
 * ParkEase — Platform Settings, Payouts, Disputes & Audit Store
 * ──────────────────────────────────────────────────────────────
 * Everything the admin panel can configure at runtime lives here.
 * In-memory for dev; mirrors the shape a `platform_settings` /
 * `payouts` / `disputes` / `audit_log` table set would have.
 *
 * SECURITY: secrets (Razorpay key_secret, webhook secret) are stored
 * here but never serialised back to the client in full — always run
 * them through `maskSecret()` / `publicSettings()` first.
 */

const { v4: uuid } = require('uuid');

// ──────────────────────────────────────────
// PLATFORM SETTINGS
// ──────────────────────────────────────────
const PLATFORM_SETTINGS = {
  general: {
    platformName: 'ParkEase',
    supportEmail: 'support@parkease.in',
    supportPhone: '+91 80 4718 2200',
    defaultCity: 'Bengaluru',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    maintenanceMode: false,
    maintenanceMessage: 'ParkEase is undergoing scheduled maintenance. Back shortly.',
  },

  pricing: {
    platformCommissionPct: 15,
    gstPct: 18,
    platformFeeFlat: 15,
    ownerPayoutPct: 85,
    surgeEnabled: true,
    maxSurgeMultiplier: 2.0,
    minBookingHours: 1,
    maxBookingHours: 24,
    holdWindowMinutes: 10,
    cancellationFeePct: 10,
    freeCancellationMinutes: 30,
  },

  payment: {
    provider: 'RAZORPAY',
    mode: 'TEST',                       // TEST | LIVE
    keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_THfZOdugsmU2w3',
    keySecret: process.env.RAZORPAY_KEY_SECRET || 'nUpAyEXMXIqeVOlC8QOblznO',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    webhookUrl: '/api/v1/payments/webhook',
    captureMode: 'AUTO',                // AUTO | MANUAL
    methods: {
      upi: true,
      card: true,
      netbanking: true,
      wallet: true,
      emi: false,
      paylater: false,
    },
    autoRefundOnCancel: true,
    settlementCycleDays: 2,
    lastTestedAt: null,
    lastTestResult: null,
  },

  payouts: {
    autoPayoutEnabled: true,
    minPayoutAmount: 500,
    payoutSchedule: 'WEEKLY',           // DAILY | WEEKLY | MONTHLY
    payoutDayOfWeek: 'MONDAY',
    requireKycForPayout: true,
    maxDailyPayoutPerUser: 50000,
  },

  notifications: {
    pushEnabled: true,
    smsEnabled: true,
    emailEnabled: true,
    bookingConfirmation: true,
    bookingReminder: true,
    reminderLeadMinutes: 30,
    payoutAlerts: true,
    kycStatusAlerts: true,
    marketingOptIn: false,
  },

  features: {
    hostOnboarding: true,
    evCharging: true,
    bikeParking: true,
    qrGateAccess: true,
    biometricLogin: true,
    referralProgram: false,
    subscriptions: false,
    corporateAccounts: false,
    dynamicPricing: true,
  },

  security: {
    otpExpiryMinutes: 5,
    maxLoginAttempts: 5,
    lockoutMinutes: 10,
    accessTokenDays: 7,
    refreshTokenDays: 30,
    forceKycForHosts: true,
    twoFactorForAdmins: false,
  },
};

// ──────────────────────────────────────────
// PAYOUTS (host withdrawal requests)
// ──────────────────────────────────────────
// Created when hosts request a withdrawal.
const PAYOUTS = [];

// ──────────────────────────────────────────
// DISPUTES / SUPPORT TICKETS
// ──────────────────────────────────────────
// Raised by seekers and hosts from the app.
const DISPUTES = [];

// ──────────────────────────────────────────
// ADMIN USERS & ROLES (RBAC)
// ──────────────────────────────────────────
const ADMIN_ROLES = {
  SUPER_ADMIN: {
    label: 'Super Admin',
    description: 'Unrestricted access including settings, payments and admin management.',
    permissions: ['*'],
  },
  OPS_MANAGER: {
    label: 'Operations Manager',
    description: 'Day-to-day moderation: KYC, listings, bookings and disputes.',
    permissions: ['dashboard.view', 'users.view', 'users.suspend', 'kyc.*', 'listings.*', 'bookings.*', 'disputes.*'],
  },
  FINANCE: {
    label: 'Finance',
    description: 'Transactions, payouts, pricing and payment gateway configuration.',
    permissions: ['dashboard.view', 'transactions.*', 'payouts.*', 'pricing.*', 'payments.*', 'analytics.view'],
  },
  SUPPORT: {
    label: 'Support Agent',
    description: 'Read-only on users and bookings, full access to disputes.',
    permissions: ['dashboard.view', 'users.view', 'bookings.view', 'disputes.*'],
  },
  READ_ONLY: {
    label: 'Read Only',
    description: 'View-only access across the panel. Cannot mutate anything.',
    permissions: ['*.view'],
  },
};

const ADMIN_USERS = [
  {
    id: 'admin-001', name: 'ParkEase Admin', email: 'admin@parkease.in',
    phone: '+919000000001', role: 'SUPER_ADMIN', status: 'ACTIVE',
    last_login_at: null, created_at: '2024-01-01T00:00:00Z',
  },
];

// ──────────────────────────────────────────
// AUDIT LOG
// ──────────────────────────────────────────
const AUDIT_LOG = [];

const recordAudit = (actor, action, target, meta = {}) => {
  const entry = {
    id: uuid(),
    actor_id: actor?.id || 'system',
    actor_name: actor?.full_name || actor?.name || 'System',
    action,
    target,
    meta,
    ip: meta.ip || null,
    created_at: new Date().toISOString(),
  };
  AUDIT_LOG.unshift(entry);
  if (AUDIT_LOG.length > 500) AUDIT_LOG.length = 500;
  return entry;
};

// ──────────────────────────────────────────
// ADMIN NOTIFICATIONS
// ──────────────────────────────────────────
// Emitted by the platform as real events occur.
const ADMIN_NOTIFICATIONS = [];

const pushNotification = ({ type, severity = 'INFO', title, body }) => {
  const entry = {
    id: `n_${Date.now().toString(36)}`,
    type, severity, title, body,
    read: false,
    created_at: new Date().toISOString(),
  };
  ADMIN_NOTIFICATIONS.unshift(entry);
  if (ADMIN_NOTIFICATIONS.length > 200) ADMIN_NOTIFICATIONS.length = 200;
  return entry;
};

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

/** Mask all but the last 4 characters of a secret. */
const maskSecret = (value) => {
  if (!value) return '';
  const tail = value.slice(-4);
  return `${'•'.repeat(Math.max(6, value.length - 4))}${tail}`;
};

/**
 * Settings safe to send to the browser.
 * Secrets become masked strings plus a `has*` boolean so the UI can
 * show "configured" state without ever receiving the real value.
 */
const publicSettings = () => {
  const { payment, ...rest } = PLATFORM_SETTINGS;
  return {
    ...rest,
    payment: {
      ...payment,
      keySecret: maskSecret(payment.keySecret),
      webhookSecret: maskSecret(payment.webhookSecret),
      hasKeySecret: Boolean(payment.keySecret),
      hasWebhookSecret: Boolean(payment.webhookSecret),
    },
  };
};

module.exports = {
  PLATFORM_SETTINGS,
  PAYOUTS,
  DISPUTES,
  ADMIN_USERS,
  ADMIN_ROLES,
  AUDIT_LOG,
  ADMIN_NOTIFICATIONS,
  recordAudit,
  pushNotification,
  maskSecret,
  publicSettings,
};
