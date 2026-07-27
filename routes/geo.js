const express = require('express');
const router = express.Router();
const { optionalAuth } = require('../middleware/auth');

/**
 * Place search / geocoding.
 *
 * Proxies OpenStreetMap Nominatim so the app can search any destination
 * ("Hotel Ganga Haridwar") and get coordinates to look for parking around.
 * Doing it server-side keeps the required User-Agent honest, lets us cache,
 * and respects Nominatim's 1 request/second policy from a single origin.
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const UA = 'ParkEase/1.0 (parking marketplace; support@parkease.in)';

// key -> { at, data }
const cache = new Map();
const TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 200;

let lastCallAt = 0;
const MIN_GAP_MS = 1100;   // Nominatim: max ~1 req/sec

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Serialises upstream calls so we never exceed the rate limit. */
const throttle = async () => {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
};

const getCached = (key) => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { cache.delete(key); return null; }
  return hit.data;
};

const setCached = (key, data) => {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), data });
};

/** Trim Nominatim's verbose payload to what the app actually renders. */
const shape = (r) => {
  const a = r.address || {};
  const locality = a.suburb || a.neighbourhood || a.village || a.town || a.city_district || '';
  const city = a.city || a.town || a.village || a.state_district || '';
  return {
    id: `${r.osm_type || 'n'}${r.osm_id || r.place_id}`,
    name: r.namedetails?.name || r.name || (r.display_name || '').split(',')[0],
    address: r.display_name,
    locality: locality || null,
    city: city || null,
    state: a.state || null,
    postcode: a.postcode || null,
    country: a.country || null,
    latitude: parseFloat(r.lat),
    longitude: parseFloat(r.lon),
    type: r.type || r.class || null,
  };
};

// ── GET /api/v1/geo/search?q=&limit=&lat=&lng= ────────────────────
// Free-text place search. lat/lng (optional) bias results toward the user.
router.get('/search', optionalAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 8, 20);

  if (q.length < 3) {
    return res.status(400).json({ success: false, message: 'Enter at least 3 characters to search' });
  }

  const key = `s:${q.toLowerCase()}:${limit}:${req.query.lat || ''},${req.query.lng || ''}`;
  const cached = getCached(key);
  if (cached) return res.json({ success: true, cached: true, count: cached.length, places: cached });

  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    addressdetails: '1',
    namedetails: '1',
    limit: String(limit),
    countrycodes: 'in',
  });
  // Bias toward the user's area without hard-filtering it out.
  if (req.query.lat && req.query.lng) {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const d = 1.5;
      params.set('viewbox', `${lng - d},${lat + d},${lng + d},${lat - d}`);
    }
  }

  try {
    await throttle();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const upstream = await fetch(`${NOMINATIM}/search?${params}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      return res.status(502).json({ success: false, message: `Place search unavailable (${upstream.status})` });
    }

    const raw = await upstream.json();
    const places = (Array.isArray(raw) ? raw : []).map(shape).filter(p => Number.isFinite(p.latitude));
    setCached(key, places);
    res.json({ success: true, count: places.length, places });
  } catch (err) {
    const aborted = err.name === 'AbortError';
    console.error('[geo] search failed:', err.message);
    res.status(aborted ? 504 : 502).json({
      success: false,
      message: aborted ? 'Place search timed out. Try again.' : 'Place search is unavailable right now.',
    });
  }
});

// ── GET /api/v1/geo/reverse?lat=&lng= ─────────────────────────────
router.get('/reverse', optionalAuth, async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ success: false, message: 'lat and lng are required' });
  }

  const key = `r:${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = getCached(key);
  if (cached) return res.json({ success: true, cached: true, place: cached });

  const params = new URLSearchParams({
    lat: String(lat), lon: String(lng),
    format: 'jsonv2', addressdetails: '1', zoom: '16',
  });

  try {
    await throttle();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const upstream = await fetch(`${NOMINATIM}/reverse?${params}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      return res.status(502).json({ success: false, message: 'Reverse geocoding unavailable' });
    }
    const raw = await upstream.json();
    const place = raw && raw.lat ? shape(raw) : null;
    if (place) setCached(key, place);
    res.json({ success: true, place });
  } catch (err) {
    console.error('[geo] reverse failed:', err.message);
    res.status(502).json({ success: false, message: 'Reverse geocoding unavailable' });
  }
});

module.exports = router;
