const express = require('express');
const router = express.Router();
const { USERS, VEHICLES } = require('../db/inMemoryDb');
const { v4: uuidv4 } = require('uuid');
const { authenticate } = require('../middleware/auth');

// ── GET /api/v1/users/profile ─────────────────────────────────────
router.get('/profile', authenticate, (req, res) => {
  const user = USERS.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  const vehicles = VEHICLES.filter(v => v.user_id === user.id);
  res.json({
    success: true,
    user: {
      id: user.id, name: user.full_name, phone: user.phone_number, email: user.email,
      role: user.active_role, kyc_status: user.kyc_status, avatar: user.avatar_url,
      rating_seeker: user.rating_as_seeker, rating_owner: user.rating_as_owner,
      created_at: user.created_at,
    },
    vehicles,
  });
});

// ── PUT /api/v1/users/profile ─────────────────────────────────────
router.put('/profile', authenticate, (req, res) => {
  const { full_name, email, avatar_url } = req.body;
  const user = USERS.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  if (full_name) user.full_name = full_name;
  if (email) user.email = email;
  if (avatar_url) user.avatar_url = avatar_url;
  user.updated_at = new Date().toISOString();
  res.json({ success: true, message: 'Profile updated', user: { id: user.id, name: user.full_name, email: user.email, avatar: user.avatar_url } });
});

// ── GET /api/v1/users/vehicles ────────────────────────────────────
router.get('/vehicles', authenticate, (req, res) => {
  const vehicles = VEHICLES.filter(v => v.user_id === req.user.id);
  res.json({ success: true, vehicles });
});

// ── POST /api/v1/users/vehicles ───────────────────────────────────
router.post('/vehicles', authenticate, (req, res) => {
  const { make_model, license_plate, vehicle_type, is_default } = req.body;
  if (!make_model || !license_plate || !vehicle_type) {
    return res.status(400).json({ success: false, message: 'make_model, license_plate and vehicle_type required' });
  }
  if (!['CAR', 'BIKE', 'EV_CAR', 'SUV'].includes(vehicle_type.toUpperCase())) {
    return res.status(400).json({ success: false, message: 'vehicle_type must be CAR, BIKE, EV_CAR or SUV' });
  }

  // If setting as default, unset others
  if (is_default) {
    VEHICLES.filter(v => v.user_id === req.user.id).forEach(v => v.is_default = false);
  }

  const vehicle = {
    id: `veh-${uuidv4().slice(0,8)}`,
    user_id: req.user.id,
    make_model,
    license_plate: license_plate.toUpperCase(),
    vehicle_type: vehicle_type.toUpperCase(),
    is_default: Boolean(is_default),
    created_at: new Date().toISOString(),
  };
  VEHICLES.push(vehicle);
  res.status(201).json({ success: true, message: 'Vehicle added', vehicle });
});

// ── DELETE /api/v1/users/vehicles/:id ────────────────────────────
router.delete('/vehicles/:id', authenticate, (req, res) => {
  const idx = VEHICLES.findIndex(v => v.id === req.params.id && v.user_id === req.user.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Vehicle not found' });
  VEHICLES.splice(idx, 1);
  res.json({ success: true, message: 'Vehicle removed' });
});

// ── PUT /api/v1/users/vehicles/:id/set-default ───────────────────
router.put('/vehicles/:id/set-default', authenticate, (req, res) => {
  const userVehicles = VEHICLES.filter(v => v.user_id === req.user.id);
  const target = userVehicles.find(v => v.id === req.params.id);
  if (!target) return res.status(404).json({ success: false, message: 'Vehicle not found' });
  userVehicles.forEach(v => v.is_default = v.id === req.params.id);
  res.json({ success: true, message: 'Default vehicle updated', vehicle: target });
});

module.exports = router;
