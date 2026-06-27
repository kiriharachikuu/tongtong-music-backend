/**
 * 每日推荐
 *   GET /api/daily    返回当日推荐歌曲列表（按用户）
 */
const express = require('express');
const { db } = require('../db');
const { optionalAuth } = require('../middleware/auth');
const router = express.Router();

router.get('/', optionalAuth, (req, res) => {
  const uid = req.user ? req.user.id : null;
  const today = new Date().toISOString().slice(0, 10);
  let row = db.prepare('SELECT * FROM daily_recommend WHERE user_id IS ? AND date = ?').get(uid, today);
  let songIds;
  if (row) {
    songIds = (row.song_ids || '').split(',').map((n) => Number(n)).filter(Boolean);
  } else {
    const songs = db.prepare('SELECT id FROM songs ORDER BY RANDOM() LIMIT 30').all();
    songIds = songs.map((s) => s.id);
    db.prepare('INSERT INTO daily_recommend (user_id, date, song_ids) VALUES (?, ?, ?)')
      .run(uid, today, songIds.join(','));
  }
  const list = songIds.map((id) => db.prepare('SELECT * FROM songs WHERE id = ?').get(id)).filter(Boolean);
  const base = `${req.protocol}://${req.get('host')}`;
  res.ok(list.map((s) => ({
    ...s,
    coverUrl: s.cover ? (s.cover.startsWith('http') ? s.cover : `${base}/api/uploads/${s.cover.replace(/^(uploads?[\\/])+/, '').replace(/^[\\/]+/, '')}`) : '',
    audioUrl: `${base}/api/songs/${s.id}/stream`,
    lrcUrl: s.lrc_exists ? `${base}/api/songs/${s.id}/lrc` : '',
  })));
});

module.exports = router;
