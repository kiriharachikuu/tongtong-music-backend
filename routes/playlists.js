/**
 * 歌单 API
 *   GET    /api/playlists              系统 + 我的歌单（登录可见私有）
 *   GET    /api/playlists/:id          详情（含歌曲列表）
 *   POST   /api/playlists              创建（登录）
 *   PATCH  /api/playlists/:id          重命名歌单（owner 或管理员）
 *   PATCH  /api/playlists/:id/reorder  歌单内歌曲拖拽排序
 *   POST   /api/playlists/:id/songs    添加歌曲到歌单（登录）
 *   DELETE /api/playlists/:id/songs/:songId
 */
const express = require('express');
const { db } = require('../db');
const { auth, optionalAuth } = require('../middleware/auth');
const { S3_PLAY_MODE } = require('../config');
const storage = require('../storage');
const router = express.Router();

/** 构造封面 URL（兼容 local 和 s3） */
function buildCoverUrl(item, base) {
  if (item.storage_mode === 's3' && item.cover_object_key) {
    try { return storage.s3Engine.url(item.cover_object_key, { mode: S3_PLAY_MODE === 'presigned' ? 'presigned' : 'proxy' }); } catch {}
  }
  if (item.cover) {
    return item.cover.startsWith('http') ? item.cover : `${base}/api/uploads/${item.cover.replace(/^(uploads?[\\/])+/, '').replace(/^[\\/]+/, '')}`;
  }
  return '';
}

router.get('/', optionalAuth, (req, res) => {
  const user = req.user;
  const rows = db.prepare(
    `SELECT * FROM playlists WHERE is_system = 1 ${user ? 'OR owner_id = ?' : ''} ORDER BY id DESC`
  ).all(user ? user.id : []);
  const base = `${req.protocol}://${req.get('host')}`;
  const totals = rows.map((p) => ({
    ...p,
    coverUrl: buildCoverUrl(p, base),
    songCount: db.prepare('SELECT COUNT(*) AS c FROM playlist_items WHERE playlist_id = ?').get(p.id).c,
  }));
  res.ok(totals);
});

router.get('/:id', (req, res) => {
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(req.params.id));
  if (!pl) return res.status(404).fail('歌单不存在');
  const songRows = db.prepare(
    `SELECT s.*, pi.position FROM playlist_items pi JOIN songs s ON s.id = pi.song_id WHERE pi.playlist_id = ? ORDER BY pi.position ASC, pi.id ASC`
  ).all(pl.id);
  const base = `${req.protocol}://${req.get('host')}`;
  // 歌单封面 URL
  pl.coverUrl = pl.cover ? (pl.cover.startsWith('http') ? pl.cover : `${base}/api/uploads/${pl.cover.replace(/^(uploads?[\\/])+/, '').replace(/^[\\/]+/, '')}`) : '';
  // 歌曲列表补 coverUrl（兼容 S3）
  const songs = songRows.map((s) => ({
    ...s,
    coverUrl: buildCoverUrl(s, base),
    audioUrl: `${base}/api/songs/${s.id}/stream`,
    lrcUrl: s.lrc_exists ? `${base}/api/songs/${s.id}/lrc` : '',
  }));
  res.ok({ ...pl, songs });
});

router.post('/', auth, (req, res) => {
  const { name, description = '' } = req.body || {};
  if (!name) return res.fail('歌单名不能为空');
  const info = db.prepare('INSERT INTO playlists (name, description, owner_id, is_system) VALUES (?, ?, ?, 0)').run(name, description, req.user.id);
  res.ok({ id: info.lastInsertRowid, name, description, owner_id: req.user.id });
});

router.post('/:id/songs', auth, (req, res) => {
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(req.params.id));
  if (!pl) return res.status(404).fail('歌单不存在');
  if (!pl.is_system && pl.owner_id !== req.user.id && !req.user.is_admin) return res.status(403).fail('无权修改');
  const songIds = Array.isArray(req.body.songIds) ? req.body.songIds : [req.body.songId];
  let added = 0;
  for (const id of songIds) {
    const n = Number(id); if (!n) continue;
    const exist = db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ? AND song_id = ?').get(pl.id, n);
    if (exist) continue;
    db.prepare('INSERT INTO playlist_items (playlist_id, song_id, position) VALUES (?, ?, 0)').run(pl.id, n);
    added += 1;
  }
  res.ok({ added });
});

// 重命名歌单（仅 owner 或管理员）
router.patch('/:id', auth, (req, res) => {
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(req.params.id));
  if (!pl) return res.status(404).fail('歌单不存在');
  if (!pl.is_system && pl.owner_id !== req.user.id && !req.user.is_admin) return res.status(403).fail('无权修改');
  const { name, description } = req.body || {};
  if (name != null && !String(name).trim()) return res.fail('歌单名不能为空');
  const updates = [];
  const params = [];
  if (name != null) { updates.push('name = ?'); params.push(String(name).trim()); }
  if (description != null) { updates.push('description = ?'); params.push(String(description)); }
  if (updates.length === 0) return res.fail('没有可更新的字段');
  params.push(pl.id);
  db.prepare(`UPDATE playlists SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.ok({ id: pl.id });
});

// 歌单内歌曲拖拽排序（仅 owner 或管理员；系统歌单不允许排序）
router.patch('/:id/reorder', auth, (req, res) => {
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(req.params.id));
  if (!pl) return res.status(404).fail('歌单不存在');
  if (pl.is_system) return res.status(403).fail('系统歌单不允许排序');
  if (pl.owner_id !== req.user.id && !req.user.is_admin) return res.status(403).fail('无权修改');
  const { fromPosition, toPosition } = req.body || {};
  const from = Number(fromPosition);
  const to = Number(toPosition);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return res.fail('参数错误');
  // 获取歌单内所有歌曲按 position 排序
  const items = db.prepare('SELECT id, song_id, position FROM playlist_items WHERE playlist_id = ? ORDER BY position ASC, id ASC').all(pl.id);
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return res.fail('索引越界');
  // 移动元素
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved);
  // 重新写 position
  const tx = db.transaction((rows) => {
    rows.forEach((row, idx) => {
      db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?').run(idx, row.id);
    });
  });
  tx(items);
  res.ok({ ok: true });
});

router.delete('/:id/songs/:songId', auth, (req, res) => {
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(req.params.id));
  if (!pl) return res.status(404).fail('歌单不存在');
  if (!pl.is_system && pl.owner_id !== req.user.id && !req.user.is_admin) return res.status(403).fail('无权修改');
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND song_id = ?').run(pl.id, Number(req.params.songId));
  res.ok({ removed: db.changes || 1 });
});

router.delete('/:id', auth, (req, res) => {
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(req.params.id));
  if (!pl) return res.status(404).fail('歌单不存在');
  if (pl.is_system && !req.user.is_admin) return res.status(403).fail('仅管理员可删除系统歌单');
  if (!pl.is_system && pl.owner_id !== req.user.id && !req.user.is_admin) return res.status(403).fail('无权删除');
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(pl.id);
  db.prepare('DELETE FROM playlists WHERE id = ?').run(pl.id);
  res.ok({ removed: pl.id });
});

module.exports = router;
