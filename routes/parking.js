const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { PARKING_SPACES, USERS, REVIEWS } = require('../db/inMemoryDb');
const { authenticate, requireRole, optionalAuth } = require('../middleware/auth');

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
  const { title, address_line, city, postal_code, latitude, longitude, total_car_slots, total_bike_slots, price_per_hour, amenities, images, compatibility } = req.body;
  if (!title || !address_line || !city || !price_per_hour) {
    return res.status(400).json({ success: false, message: 'Title, address, city and price are required' });
  }

  const newSpot = {
    id: `spot-${uuidv4().slice(0, 8)}`,
    owner_id: req.user.id,
    title,
    address_line,
    city: city || 'Bengaluru',
    postal_code: postal_code || '',
    latitude: parseFloat(latitude) || 12.9716,
    longitude: parseFloat(longitude) || 77.5946,
    total_car_slots: parseInt(total_car_slots) || 1,
    total_bike_slots: parseInt(total_bike_slots) || 0,
    available_car_slots: parseInt(total_car_slots) || 1,
    available_bike_slots: parseInt(total_bike_slots) || 0,
    price_per_hour: parseFloat(price_per_hour),
    surge_multiplier: 1.0,
    approval_status: 'PENDING_APPROVAL',
    is_active: false,
    amenities: amenities || { covered: false, evCharging: false, cctv: false, securityGuard: false, twentyFourSeven: false },
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
  if (spot.owner_id !== req.user.id && req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, message: 'Not authorized to edit this spot' });
  }
  PARKING_SPACES[idx] = { ...spot, ...req.body, id: spot.id, owner_id: spot.owner_id };
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
