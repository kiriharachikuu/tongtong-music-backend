/**
 * 排行榜 API
 *   GET /api/ranking?by=play|favorite&limit=100&offset=0
 *
 * 接口规格：
 *   - 公开接口（使用 optionalAuth，不强制登录）
 *   - by=play（默认）: ORDER BY play_count DESC, id ASC
 *   - by=favorite:     ORDER BY favorite_count DESC, id ASC
 *   - limit  默认 100，最大 500，最小 1
 *   - offset 默认 0
 *   - 返回字段：歌曲基础信息 + play_count + favorite_count + rank（序号，从 1 开始）
 *   - 封面/音频 URL 构造参考 favorites.js 第 17-22 行
 *     （本地走 ${base}/api/uploads/... 与 ${base}/api/songs/:id/stream）
 *     无需 S3 预签名，本接口只返回基础 URL，实际播放走 stream 接口
 *   - 同时返回 total（总歌曲数）
 */
const express = require('express');
const { db } = require('../db');
const { optionalAuth } = require('../middleware/auth');
const storage = require('../storage');
const router = express.Router();

router.get('/', optionalAuth, async (req, res) => {
  // 1. 参数校验：by 必须是 'play' 或 'favorite'，否则默认 'play'
  const byRaw = String(req.query.by || '').toLowerCase();
  const by = byRaw === 'favorite' ? 'favorite' : 'play';

  // limit 默认 100，最大 500，最小 1
  let limit = parseInt(req.query.limit, 10);
  if (Number.isNaN(limit)) limit = 100;
  if (limit < 1) limit = 1;
  if (limit > 500) limit = 500;

  // offset 默认 0
  let offset = parseInt(req.query.offset, 10);
  if (Number.isNaN(offset) || offset < 0) offset = 0;

  // 2. 排序字段（已限定枚举值，可安全拼接）
  const orderField = by === 'favorite' ? 'favorite_count' : 'play_count';

  // 3. 总歌曲数
  const total = db.prepare('SELECT COUNT(*) AS c FROM songs').get().c;

  // 4. 分页查询（参数化 LIMIT ? OFFSET ?）
  const rows = db
    .prepare(`SELECT * FROM songs ORDER BY ${orderField} DESC, id ASC LIMIT ? OFFSET ?`)
    .all(limit, offset);

  // 5. 构造 URL（参考 favorites.js 第 17-22 行）并附加 rank 字段
  const base = `${req.protocol}://${req.get('host')}`;
  const songs = [];
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i];

    // 封面 URL：S3 兼容（storage_mode === 's3' && cover_object_key 时走代理 URL），否则本地
    let coverUrl = '';
    if (s.storage_mode === 's3' && s.cover_object_key) {
      try {
        coverUrl = await storage.s3Engine.url(s.cover_object_key, { mode: 'proxy' });
      } catch {
        coverUrl = '';
      }
    } else if (s.cover) {
      coverUrl = s.cover.startsWith('http')
        ? s.cover
        : `${base}/api/uploads/${s.cover.replace(/^(uploads?[\\/])+/, '').replace(/^[\\/]+/, '')}`;
    }

    songs.push({
      ...s,
      coverUrl,
      audioUrl: `${base}/api/songs/${s.id}/stream`,
      lrcUrl: s.lrc_exists ? `${base}/api/songs/${s.id}/lrc` : '',
      rank: offset + i + 1, // 序号，从 1 开始（含 offset 偏移）
    });
  }

  res.ok({ list: songs, total });
});

module.exports = router;
