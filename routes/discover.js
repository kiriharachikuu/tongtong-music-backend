/**
 * 发现页 / 首页数据聚合
 *   GET /api/discover
 */
const express = require('express');
const { db } = require('../db');
const router = express.Router();

router.get('/', (req, res) => {
  const banners = db.prepare('SELECT * FROM banners ORDER BY "order" ASC, id ASC LIMIT 10').all();
  const playlists = db.prepare('SELECT *, (SELECT COUNT(*) FROM playlist_items WHERE playlist_id = playlists.id) AS song_count FROM playlists WHERE is_system = 1 ORDER BY id DESC LIMIT 10').all();
  const newest = db.prepare('SELECT * FROM songs ORDER BY id DESC LIMIT 15').all();
  const base = `${req.protocol}://${req.get('host')}`;
  const withHost = (s) => ({
    ...s,
    coverUrl: s.cover ? (s.cover.startsWith('http') ? s.cover : `${base}/api/uploads/${s.cover.replace(/^(uploads?[\\/])+/, '').replace(/^[\\/]+/, '')}`) : '',
    audioUrl: `${base}/api/songs/${s.id}/stream`,
    lrcUrl: s.lrc_exists ? `${base}/api/songs/${s.id}/lrc` : '',
  });
  for (const b of banners) b.imageUrl = b.image ? (b.image.startsWith('http') ? b.image : `${base}/api/uploads/${b.image.replace(/^(uploads?[\\/])+/, '').replace(/^[\\/]+/, '')}`) : '';
  for (const p of playlists) p.coverUrl = p.cover ? (p.cover.startsWith('http') ? p.cover : `${base}/api/uploads/${p.cover.replace(/^(uploads?[\\/])+/, '').replace(/^[\\/]+/, '')}`) : '';
  res.ok({ banners, playlists, newest: newest.map(withHost) });
});

module.exports = router;
