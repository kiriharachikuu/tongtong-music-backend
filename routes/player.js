/**
 * 播放器播放队列（持久化）
 *   GET    /api/player/queue
 *   POST   /api/player/queue         { songIds: [], currentIndex }
 */
const express = require('express');
const { db } = require('../db');
const { auth } = require('../middleware/auth');
const router = express.Router();

router.get('/queue', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM player_queue WHERE user_id = ?').get(req.user.id);
  if (!row) return res.ok({ songIds: [], currentIndex: 0 });
  const ids = (row.song_ids || '').split(',').map((n) => Number(n)).filter(Boolean);
  const base = `${req.protocol}://${req.get('host')}`;
  const songs = ids.map((id) => db.prepare('SELECT * FROM songs WHERE id = ?').get(id)).filter(Boolean).map((s) => ({
    ...s,
    coverUrl: s.cover ? (s.cover.startsWith('http') ? s.cover : `${base}/api/uploads/${s.cover.replace(/^(uploads?[\\/])+/, '').replace(/^[\\/]+/, '')}`) : '',
    audioUrl: `${base}/api/songs/${s.id}/stream`,
    lrcUrl: s.lrc_exists ? `${base}/api/songs/${s.id}/lrc` : '',
  }));
  res.ok({ songIds: ids, currentIndex: row.current_index || 0, songs });
});

router.post('/queue', auth, (req, res) => {
  const { songIds = [], currentIndex = 0 } = req.body || {};
  const ids = songIds.map((n) => Number(n)).filter(Boolean);
  const existing = db.prepare('SELECT user_id FROM player_queue WHERE user_id = ?').get(req.user.id);
  if (existing) {
    db.prepare('UPDATE player_queue SET song_ids = ?, current_index = ?, updated_at = datetime(\'now\',\'localtime\') WHERE user_id = ?')
      .run(ids.join(','), Number(currentIndex) || 0, req.user.id);
  } else {
    db.prepare('INSERT INTO player_queue (user_id, song_ids, current_index) VALUES (?, ?, ?)')
      .run(req.user.id, ids.join(','), Number(currentIndex) || 0);
  }
  res.ok({ ok: true });
});

module.exports = router;
