/**
 * 横幅 API
 *   GET /api/banners
 */
const express = require('express');
const { db } = require('../db');
const storage = require('../storage');
const { S3_PLAY_MODE } = require('../config');
const router = express.Router();

router.get('/', async (req, res) => {
  const list = db.prepare('SELECT * FROM banners ORDER BY "order" ASC, id ASC').all();
  const base = `${req.protocol}://${req.get('host')}`;
  for (const b of list) {
    if (b.storage_mode === 's3' && b.image_object_key) {
      try { b.imageUrl = await storage.s3Engine.url(b.image_object_key, { mode: S3_PLAY_MODE === 'presigned' ? 'presigned' : 'proxy' }); } catch {}
    } else {
      b.imageUrl = b.image ? (b.image.startsWith('http') ? b.image : `${base}/api/uploads/${b.image.replace(/^(uploads?[\\/])+/, '').replace(/^[\\/]+/, '')}`) : '';
    }
  }
  res.ok(list);
});

module.exports = router;
