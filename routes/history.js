/**
 * 播放历史 API
 *   GET    /api/history
 *   POST   /api/history/:songId   (播放时上报，允许重复)
 *   DELETE /api/history/:songId   (删除指定歌曲的播放历史)
 */
const express = require('express');
const { db } = require('../db');
const { auth } = require('../middleware/auth');
const { PLAY_HISTORY_LIMIT } = require('../config');
const router = express.Router();

router.get('/', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT s.*, h.played_at FROM play_history h JOIN songs s ON s.id = h.song_id WHERE h.user_id = ? ORDER BY h.id DESC LIMIT ${PLAY_HISTORY_LIMIT}`
  ).all(req.user.id);
  const base = `${req.protocol}://${req.get('host')}`;
  res.ok(rows.map((s) => ({
    ...s,
    coverUrl: s.cover ? (s.cover.startsWith('http') ? s.cover : `${base}/api/uploads/${s.cover.replace(/^(uploads?[\\/])+/, '').replace(/^[\\/]+/, '')}`) : '',
    audioUrl: `${base}/api/songs/${s.id}/stream`,
    lrcUrl: s.lrc_exists ? `${base}/api/songs/${s.id}/lrc` : '',
  })));
});

router.post('/:songId', auth, (req, res) => {
  const songId = Number(req.params.songId);
  const s = db.prepare('SELECT id FROM songs WHERE id = ?').get(songId);
  if (!s) return res.status(404).fail('歌曲不存在');
  db.prepare('INSERT INTO play_history (user_id, song_id) VALUES (?, ?)').run(req.user.id, songId);
  res.ok({ ok: true });
});

// 删除指定歌曲的播放历史（用户最近播放左滑删除）
router.delete('/:songId', auth, (req, res) => {
  const songId = Number(req.params.songId);
  // 删除该用户对该歌曲的所有历史记录（可能重复播放多次）
  db.prepare('DELETE FROM play_history WHERE user_id = ? AND song_id = ?').run(req.user.id, songId);
  res.ok({ ok: true });
});

module.exports = router;
