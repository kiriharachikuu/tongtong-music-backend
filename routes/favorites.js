/**
 * 收藏 API
 *   GET    /api/favorites             我的收藏（歌曲列表）
 *   GET    /api/favorites/:songId/check  检查是否已收藏
 *   POST   /api/favorites/:songId     加入收藏
 *   DELETE /api/favorites/:songId     取消
 */
const express = require('express');
const { db } = require('../db');
const { auth } = require('../middleware/auth');
const router = express.Router();

router.get('/', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT s.* FROM favorites f JOIN songs s ON s.id = f.song_id WHERE f.user_id = ? ORDER BY f.id DESC`
  ).all(req.user.id);
  const base = `${req.protocol}://${req.get('host')}`;
  const songs = rows.map((s) => ({
    ...s,
    coverUrl: s.cover ? (s.cover.startsWith('http') ? s.cover : `${base}/api/uploads/${s.cover.replace(/^(uploads?[\\/])+/, '').replace(/^[\\/]+/, '')}`) : '',
    audioUrl: `${base}/api/songs/${s.id}/stream`,
    lrcUrl: s.lrc_exists ? `${base}/api/songs/${s.id}/lrc` : '',
  }));
  res.ok(songs);
});

// 检查是否已收藏指定歌曲
router.get('/:songId/check', auth, (req, res) => {
  const songId = Number(req.params.songId);
  const exist = db.prepare('SELECT id FROM favorites WHERE user_id = ? AND song_id = ?').get(req.user.id, songId);
  res.ok({ favorited: !!exist });
});

router.post('/:songId', auth, (req, res) => {
  const songId = Number(req.params.songId);
  const song = db.prepare('SELECT id FROM songs WHERE id = ?').get(songId);
  if (!song) return res.status(404).fail('歌曲不存在');
  const exist = db.prepare('SELECT id FROM favorites WHERE user_id = ? AND song_id = ?').get(req.user.id, songId);
  if (exist) return res.ok({ existed: true });
  db.prepare('INSERT INTO favorites (user_id, song_id) VALUES (?, ?)').run(req.user.id, songId);
  db.prepare('UPDATE songs SET favorite_count = favorite_count + 1 WHERE id = ?').run(songId);
  res.ok({ ok: true });
});

router.delete('/:songId', auth, (req, res) => {
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND song_id = ?').run(req.user.id, Number(req.params.songId));
  res.ok({ ok: true });
});

module.exports = router;
