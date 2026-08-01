const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { PARKING_SPACES, USERS, REVIEWS, KYC, WALLETS } = require('../db/inMemoryDb');
const { authenticate, requireRole, optionalAuth } = require('../middleware/auth');

// ── Facilities ───────────────────────────────────────────────────
// Mirrors mobile/constants/facilities.js. Kept as an explicit allowlist so a
// client cannot push arbitrary keys into the stored amenities object, and so
// every spot has the same shape whether it was listed before or after the
// facility set was widened.
const FACILITY_KEYS = [
  'cctv', 'securityGuard', 'gatedEntry', 'wellLit',
  'covered', 'twentyFourSeven', 'wideSpace', 'rainProtection',
  'evCharging', 'carWash', 'airPump', 'valet',
  'restroom', 'liftAccess', 'stepFree', 'waitingArea',
];

const ACCESS_TYPES = ['SELF', 'HOST_OPEN', 'GUARD', 'VALET'];

const normaliseFacilities = (input) => {
  const out = {};
  FACILITY_KEYS.forEach(k => { out[k] = input?.[k] === true; });
  return out;
};

// ── Haversine distance calculation (km) ──────────────────────────
const haversine = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// ── Enrich spot with owner info ───────────────────────────────────
const enrichSpot = (spot, userLat, userLng) => {
  const owner = USERS.find(u => u.id === spot.owner_id);
  const spotReviews = REVIEWS.filter(r => r.parking_space_id === spot.id).slice(0, 5);
  let distance = null;
  if (userLat && userLng) {
    const km = haversine(userLat, userLng, spot.latitude, spot.longitude);
    distance = km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
    spot._distanceKm = km;
  }
  return {
    ...spot,
    distance,
    ownerName: owner ? owner.full_name : 'Unknown Host',
    ownerPhone: owner ? owner.phone_number : null,
    ownerAvatar: owner ? owner.avatar_url : null,
    ownerJoined: owner ? new Date(owner.created_at).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : null,
    ownerVerified: owner ? owner.kyc_status === 'VERIFIED' : false,
    reviewsList: spotReviews,
  };
};

// ── GET /api/v1/parking/nearby ────────────────────────────────────
// Query: lat, lng, radius (km, default 10), vehicle_type, covered, ev_charging, cctv, security, twenty_four_seven, min_price, max_price, sort
router.get('/nearby', optionalAuth, (req, res) => {
  const { lat, lng, radius = 10, vehicle_type, covered, ev_charging, cctv, security, twenty_four_seven, min_price, max_price, sort = 'distance' } = req.query;

  let spots = PARKING_SPACES.filter(s => s.approval_status === 'APPROVED' && s.is_active);

  // Amenity filters
  if (covered === 'true') spots = spots.filter(s => s.amenities.covered);
  if (ev_charging === 'true') spots = spots.filter(s => s.amenities.evCharging);
  if (cctv === 'true') spots = spots.filter(s => s.amenities.cctv);
  if (security === 'true') spots = spots.filter(s => s.amenities.securityGuard);
  if (twenty_four_seven === 'true') spots = spots.filter(s => s.amenities.twentyFourSeven);

  // Price filters
  if (min_price) spots = spots.filter(s => s.price_per_hour >= parseFloat(min_price));
  if (max_price) spots = spots.filter(s => s.price_per_hour <= parseFloat(max_price));

  // Vehicle type filter
  if (vehicle_type) {
    const vt = vehicle_type.toUpperCase();
    spots = spots.filter(s => s.compatibility.some(c => c.toUpperCase().includes(vt) || vt.includes(c.toUpperCase())));
  }

  // Enrich & compute distance
  const userLat = lat ? parseFloat(lat) : null;
  const userLng = lng ? parseFloat(lng) : null;
  let enriched = spots.map(s => enrichSpot(s, userLat, userLng));

  // Radius filter
  if (userLat && userLng) {
    enriched = enriched.filter(s => (s._distanceKm || 0) <= parseFloat(radius));
  }

  // Sorting
  if (sort === 'distance' && userLat) enriched.sort((a, b) => (a._distanceKm || 99) - (b._distanceKm || 99));
  else if (sort === 'price_asc') enriched.sort((a, b) => a.price_per_hour - b.price_per_hour);
  else if (sort === 'price_desc') enriched.sort((a, b) => b.price_per_hour - a.price_per_hour);
  else if (sort === 'rating') enriched.sort((a, b) => b.rating - a.rating);

  // Clean internal fields
  enriched.forEach(s => delete s._distanceKm);

  res.json({ success: true, count: enriched.length, spots: enriched });
});

// ── GET /api/v1/parking/:id ───────────────────────────────────────
router.get('/:id', optionalAuth, (req, res) => {
  const spot = PARKING_SPACES.find(s => s.id === req.params.id);
  if (!spot) return res.status(404).json({ success: false, message: 'Parking spot not found' });
  res.json({ success: true, spot: enrichSpot(spot, null, null) });
});

// ── POST /api/v1/parking ─────────────────────────────────────────
// Create new listing (Host only)
router.post('/', authenticate, requireRole('OWNER', 'ADMIN'), (req, res) => {
  const {
    title, address_line, city, postal_code, latitude, longitude,
    total_car_slots, total_bike_slots, price_per_hour, amenities, images,
    compatibility, space_category, safety_ack, access_type, driver_note,
  } = req.body;

  // ── Onboarding gate ──────────────────────────────────────────────
  // A host must have their identity on file and somewhere to be paid before
  // a listing can exist. Admins are exempt so they can seed spots directly.
  if (req.user.role !== 'ADMIN') {
    const kyc = KYC.find(k => k.user_id === req.user.id);
    if (!kyc || kyc.verification_status === 'REJECTED') {
      return res.status(403).json({
        success: false,
        code: 'KYC_REQUIRED',
        message: 'Complete your identity verification before listing a space',
      });
    }
    const wallet = WALLETS.find(w => w.user_id === req.user.id);
    if (!wallet || !(wallet.upi_id || wallet.bank_account_number)) {
      return res.status(403).json({
        success: false,
        code: 'PAYOUT_REQUIRED',
        message: 'Add a bank account or UPI ID before listing a space',
      });
    }
  }

  // ── Field validation ─────────────────────────────────────────────
  const price = parseFloat(price_per_hour);
  const fieldError =
    (String(title || '').trim().length < 3 ? 'Give the listing a name of at least 3 characters' : null) ||
    (String(address_line || '').trim().length < 5 ? 'Enter a full address' : null) ||
    (String(city || '').trim().length < 2 ? 'Enter the city' : null) ||
    (!Number.isFinite(price) || price <= 0 ? 'Enter a price above ₹0' : null) ||
    (price > 5000 ? 'Price per hour looks too high (max ₹5000)' : null);
  if (fieldError) {
    return res.status(400).json({ success: false, message: fieldError });
  }

  // A home/driveway listing puts a stranger's vehicle on private property, so
  // the host has to accept the check-the-vehicle duty explicitly. Commercial
  // lots are staffed and carry no such prompt.
  const category = space_category === 'PERSONAL' ? 'PERSONAL' : 'COMMERCIAL';
  if (category === 'PERSONAL' && safety_ack !== true) {
    return res.status(400).json({
      success: false,
      code: 'SAFETY_ACK_REQUIRED',
      message: 'Accept the personal-space safety responsibilities to continue',
    });
  }

  // A bike-only listing sends 0 car slots — `|| 1` would treat that explicit 0
  // as "missing" and hand back a car slot the host never offered.
  const asCount = (v, fallback) => {
    const n = parseInt(v);
    return Number.isNaN(n) || n < 0 ? fallback : n;
  };
  const carSlots  = asCount(total_car_slots, 1);
  const bikeSlots = asCount(total_bike_slots, 0);

  if (carSlots + bikeSlots < 1) {
    return res.status(400).json({ success: false, message: 'Add at least one parking slot' });
  }

  const newSpot = {
    id: `spot-${uuidv4().slice(0, 8)}`,
    owner_id: req.user.id,
    title: String(title).trim(),
    address_line: String(address_line).trim(),
    city: String(city).trim(),
    space_category: category,
    safety_ack: category === 'PERSONAL',
    safety_ack_at: category === 'PERSONAL' ? new Date().toISOString() : null,
    postal_code: postal_code || '',
    latitude: parseFloat(latitude) || 12.9716,
    longitude: parseFloat(longitude) || 77.5946,
    total_car_slots: carSlots,
    total_bike_slots: bikeSlots,
    available_car_slots: carSlots,
    available_bike_slots: bikeSlots,
    price_per_hour: parseFloat(price_per_hour),
    surge_multiplier: 1.0,
    approval_status: 'PENDING_APPROVAL',
    is_active: false,
    amenities: normaliseFacilities(amenities),
    access_type: ACCESS_TYPES.includes(access_type) ? access_type : 'SELF',
    driver_note: String(driver_note || '').trim().slice(0, 280) || null,
    images: images || [],
    compatibility: compatibility || ['Car'],
    rating: 0,
    total_reviews: 0,
    map_coordinates: { x: 50, y: 50 },
    created_at: new Date().toISOString(),
  };

  PARKING_SPACES.push(newSpot);
  res.status(201).json({ success: true, message: 'Parking spot submitted for approval', spot: newSpot });
});

// ── PUT /api/v1/parking/:id ───────────────────────────────────────
router.put('/:id', authenticate, requireRole('OWNER', 'ADMIN'), (req, res) => {
  const idx = PARKING_SPACES.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Spot not found' });
  const spot = PARKING_SPACES[idx];
  const isAdmin = req.user.role === 'ADMIN';
  if (spot.owner_id !== req.user.id && !isAdmin) {
    return res.status(403).json({ success: false, message: 'Not authorized to edit this spot' });
  }

  // Spreading req.body wholesale let an owner send approval_status:'APPROVED'
  // and publish their own listing without review — and rewrite rating too.
  // Owners may only touch the fields below; the rest stay admin-only.
  const OWNER_EDITABLE = [
    'title', 'address_line', 'city', 'postal_code', 'latitude', 'longitude',
    'price_per_hour', 'total_car_slots', 'total_bike_slots',
    'amenities', 'images', 'compatibility', 'is_active',
    'access_type', 'driver_note',
  ];

  const patch = {};
  const source = isAdmin ? Object.keys(req.body) : OWNER_EDITABLE;
  source.forEach(key => {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) patch[key] = req.body[key];
  });

  // Two separate gates before a space can be seen by drivers:
  //   1. the listing itself has been reviewed, and
  //   2. the owner's identity is actually verified — not merely submitted.
  // A host may create a listing while KYC is pending, but nothing of theirs
  // becomes public until an admin has approved the person behind it.
  if (patch.is_active === true && !isAdmin) {
    if (spot.approval_status !== 'APPROVED') {
      return res.status(403).json({
        success: false,
        code: 'NOT_APPROVED',
        message: 'This space is still awaiting admin approval',
      });
    }
    const ownerKyc = KYC.find(k => k.user_id === spot.owner_id);
    if (ownerKyc?.verification_status !== 'VERIFIED') {
      return res.status(403).json({
        success: false,
        code: 'KYC_NOT_VERIFIED',
        message: 'Your identity must be verified before your space can go public',
      });
    }
  }

  // Same normalising as create, so an edit cannot smuggle in unknown keys or
  // an invalid access type.
  if (patch.amenities !== undefined) patch.amenities = normaliseFacilities(patch.amenities);
  if (patch.access_type !== undefined && !ACCESS_TYPES.includes(patch.access_type)) {
    return res.status(400).json({ success: false, message: 'Unknown access type' });
  }
  if (patch.driver_note !== undefined) {
    patch.driver_note = String(patch.driver_note || '').trim().slice(0, 280) || null;
  }

  if (patch.price_per_hour !== undefined) {
    const p = parseFloat(patch.price_per_hour);
    if (!Number.isFinite(p) || p <= 0 || p > 5000) {
      return res.status(400).json({ success: false, message: 'Price must be between ₹1 and ₹5000' });
    }
    patch.price_per_hour = p;
  }

  PARKING_SPACES[idx] = { ...spot, ...patch, id: spot.id, owner_id: spot.owner_id };
  res.json({ success: true, message: 'Spot updated', spot: PARKING_SPACES[idx] });
});

// ── GET /api/v1/parking/owner/my-listings ────────────────────────
router.get('/owner/my-listings', authenticate, requireRole('OWNER', 'ADMIN'), (req, res) => {
  const spots = PARKING_SPACES.filter(s => s.owner_id === req.user.id).map(s => enrichSpot(s, null, null));
  res.json({ success: true, count: spots.length, spots });
});

// ── POST /api/v1/parking/:id/review ──────────────────────────────
router.post('/:id/review', authenticate, (req, res) => {
  const { rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ success: false, message: 'Rating 1–5 required' });

  const spot = PARKING_SPACES.find(s => s.id === req.params.id);
  if (!spot) return res.status(404).json({ success: false, message: 'Spot not found' });

  const user = USERS.find(u => u.id === req.user.id);
  const review = {
    id: `rev-${uuidv4().slice(0, 8)}`,
    parking_space_id: req.params.id,
    reviewer_id: req.user.id,
    reviewer_name: user ? user.full_name : 'User',
    rating: parseInt(rating),
    comment: comment || '',
    created_at: new Date().toISOString(),
  };

  REVIEWS.push(review);

  // Update spot's average rating
  const spotReviews = REVIEWS.filter(r => r.parking_space_id === req.params.id);
  spot.rating = parseFloat((spotReviews.reduce((s, r) => s + r.rating, 0) / spotReviews.length).toFixed(2));
  spot.total_reviews = spotReviews.length;

  res.status(201).json({ success: true, message: 'Review submitted', review });
});

module.exports = router;
