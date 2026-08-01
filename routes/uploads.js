/**
 * Image uploads.
 * ─────────────────────────────────────────────────────
 * Before this existed the app sent whatever URI the image picker returned —
 * a path on the phone's own filesystem (`file:///data/user/0/...`). Those were
 * stored verbatim, so the admin console rendered broken images and KYC could
 * not actually be reviewed.
 *
 * The client now posts the picked image as base64 and gets back a real URL
 * served by this API. No multipart dependency: expo-image-picker can return
 * base64 directly, and express.json already accepts 10mb.
 *
 * Files land on local disk, which is fine alongside the in-memory store — both
 * want replacing with real infrastructure (S3 / a database) before production.
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { authenticate } = require('../middleware/auth');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const MAX_BYTES = 6 * 1024 * 1024;          // 6 MB decoded

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** Absolute URL so the phone, the admin console and curl all resolve it. */
const publicUrl = (req, filename) => {
  const base = process.env.PUBLIC_BASE_URL
    || `${req.protocol}://${req.get('host')}`;
  return `${base}/uploads/${filename}`;
};

// ── POST /api/v1/uploads ─────────────────────────────────────────
// Body: { data: "<base64>" | "data:image/jpeg;base64,...", mime?, kind? }
router.post('/', authenticate, (req, res) => {
  const { data, mime, kind } = req.body;

  if (!data || typeof data !== 'string') {
    return res.status(400).json({ success: false, message: 'No image data supplied' });
  }

  // Accept both a bare base64 string and a full data: URI.
  let payload = data;
  let type = mime;
  const dataUri = /^data:([^;]+);base64,(.*)$/s.exec(data);
  if (dataUri) {
    type = dataUri[1];
    payload = dataUri[2];
  }
  type = (type || 'image/jpeg').toLowerCase();

  const ext = EXT_BY_MIME[type];
  if (!ext) {
    return res.status(400).json({ success: false, message: `Unsupported image type: ${type}` });
  }

  let buffer;
  try {
    buffer = Buffer.from(payload, 'base64');
  } catch {
    return res.status(400).json({ success: false, message: 'Image data is not valid base64' });
  }

  if (!buffer.length) {
    return res.status(400).json({ success: false, message: 'Image data is empty' });
  }
  if (buffer.length > MAX_BYTES) {
    return res.status(413).json({
      success: false,
      message: `Image is ${(buffer.length / 1048576).toFixed(1)} MB — keep it under 6 MB`,
    });
  }

  // `kind` only labels the file for humans reading the directory; it can never
  // escape UPLOAD_DIR because it is stripped to a short safe token.
  const label = String(kind || 'img').replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'img';
  const filename = `${label}-${uuidv4().slice(0, 8)}-${crypto.randomBytes(4).toString('hex')}.${ext}`;

  try {
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
  } catch (e) {
    return res.status(500).json({ success: false, message: 'Could not save the image' });
  }

  res.status(201).json({
    success: true,
    url: publicUrl(req, filename),
    filename,
    bytes: buffer.length,
  });
});

module.exports = router;
