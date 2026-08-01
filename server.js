/**
 * ParkEase API Server
 * ─────────────────────────────────────────────────────────────────
 * Peer-to-Peer Parking Marketplace Backend
 * Stack: Node.js 22 + Express + In-Memory DB (swap for PostgreSQL)
 * 
 * Production: Replace in-memory store with PostgreSQL + PostGIS
 * ─────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 5000;

// ── Security Middleware ───────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',');
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, curl, Expo Go)
    if (!origin) return callback(null, true);
    // Allow any local network IP (192.168.x.x, 10.x.x.x, 172.x.x.x) + localhost
    if (
      origin.includes('localhost') ||
      origin.includes('127.0.0.1') ||
      origin.match(/https?:\/\/192\.168\.\d+\.\d+/) ||
      origin.match(/https?:\/\/10\.\d+\.\d+\.\d+/) ||
      origin.match(/https?:\/\/172\.\d+\.\d+\.\d+/) ||
      origin.startsWith('exp://') ||
      // The admin dashboard is on Vercel, which mints a new subdomain for
      // every preview deploy — pinning one URL would break on each redeploy.
      origin.match(/^https:\/\/[a-z0-9-]+\.vercel\.app$/) ||
      allowedOrigins.some(o => origin.startsWith(o.trim()))
    ) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Rate Limiting ─────────────────────────────────────────────────
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, message: { success: false, message: 'Too many auth attempts. Try again in 10 minutes.' } });
app.use('/api/v1/auth', authLimiter);
app.use('/api/', limiter);

// ── Body Parsers ──────────────────────────────────────────────────
// Webhooks need raw body → register before json parser
app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Request Logging ───────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// ── Health Check ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ParkEase API',
    version: '2.4.0',
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(process.uptime())}s`,
  });
});

// ── API Info ──────────────────────────────────────────────────────
app.get('/api/v1', (req, res) => {
  res.json({
    name: 'ParkEase REST API',
    version: 'v1',
    description: 'Peer-to-Peer Parking Marketplace',
    endpoints: {
      auth:     'POST /api/v1/auth/send-otp | /verify-otp | /login | /register | /refresh | /logout | GET /me',
      parking:  'GET /api/v1/parking/nearby | /:id | POST / | PUT /:id | GET /owner/my-listings',
      bookings: 'GET /api/v1/bookings/my | /owner | /:id | POST / | /hold | PATCH /:id/cancel | /extend | /complete | /verify-qr',
      payments: 'POST /api/v1/payments/razorpay/order | /verify | /webhook | GET /config',
      wallet:   'GET /api/v1/wallet | /transactions | POST /withdraw | /credit | PUT /bank-details',
      kyc:      'GET /api/v1/kyc/status | POST /submit | GET /admin/queue | PATCH /admin/:id/approve | /reject',
      users:    'GET /api/v1/users/profile | /vehicles | POST /vehicles | DELETE /vehicles/:id',
      admin:    'GET /api/v1/admin/dashboard | /users | /parking | /bookings | /payments | /analytics/revenue | PATCH /settings/commission',
    },
    docs: 'http://localhost:5000/api/v1',
    razorpay_key: process.env.RAZORPAY_KEY_ID,
  });
});

// ── Uploaded images ───────────────────────────────────────────────
// Served from disk so the admin console can actually display KYC documents.
// crossOriginResourcePolicy is relaxed because helmet's default blocks the
// dashboard on :3001 from loading images off this origin.
app.use(
  '/uploads',
  require('helmet')({ crossOriginResourcePolicy: { policy: 'cross-origin' } }),
  express.static(require('path').join(__dirname, 'uploads'), { maxAge: '1d' })
);

// ── Routes ────────────────────────────────────────────────────────
app.use('/api/v1/uploads',  require('./routes/uploads'));
app.use('/api/v1/auth',     require('./routes/auth'));
app.use('/api/v1/parking',  require('./routes/parking'));
app.use('/api/v1/geo',      require('./routes/geo'));
app.use('/api/v1/bookings', require('./routes/bookings'));
app.use('/api/v1/payments', require('./routes/payments'));
app.use('/api/v1/wallet',   require('./routes/wallet'));
app.use('/api/v1/kyc',      require('./routes/kyc'));
app.use('/api/v1/users',    require('./routes/users'));
app.use('/api/v1/admin',    require('./routes/admin'));

// ── 404 Handler ───────────────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.originalUrl} not found` });
});

// ── Global Error Handler ──────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  if (err.message?.startsWith('CORS blocked')) {
    return res.status(403).json({ success: false, message: err.message });
  }
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║       🅿  ParkEase API Server Started          ║');
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║  URL  : http://localhost:${PORT}                   ║`);
  console.log(`║  ENV  : ${process.env.NODE_ENV || 'development'}                        ║`);
  console.log(`║  RZP  : ${process.env.RAZORPAY_KEY_ID?.slice(0,20)}...   ║`);
  console.log('╠═══════════════════════════════════════════════╣');
  console.log('║  Test Accounts:                               ║');
  console.log('║  Admin  : +919000000001 / Admin@2026!         ║');
  console.log('║  Seeker : +919876543210 / Password@123        ║');
  console.log('║  Host   : +919876543211 / Password@123        ║');
  console.log('╚═══════════════════════════════════════════════╝\n');
});

module.exports = app;
