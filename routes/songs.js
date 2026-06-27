/**
 * 歌曲 API
 *   GET  /api/songs?keyword=..&page=1&size=20   列表
 *   GET  /api/songs/:id                          详情
 *   GET  /api/songs/:id/stream                   音频流（支持 Range, 支持 ?token=）
 *   GET  /api/songs/:id/lrc                      歌词原文
 *   GET  /api/songs/:id/lyric                    解析后的歌词结构（带逐词/逐行）
 *   GET  /api/songs/:id/download                 下载音频（Content-Disposition: attachment）
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { streamSong } = require('../services/audio');
const { auth, optionalAuth } = require('../middleware/auth');
const { UPLOADS_DIR, STORAGE_MODE, S3_PLAY_MODE } = require('../config');
const storage = require('../storage');
const router = express.Router();

// 给歌曲对象补充 URL 信息（封面/音频/歌词），由 STORAGE_MODE / 行内字段决定
// 封面回退逻辑：歌曲自有封面 → 专辑封面 → 空
async function withUrls(song, req) {
  let coverUrl = '';
  // 1. 优先使用歌曲自己的封面
  if (song.storage_mode === 's3' && song.cover_object_key) {
    try { coverUrl = await storage.s3Engine.url(song.cover_object_key, { mode: S3_PLAY_MODE === 'presigned' ? 'presigned' : 'proxy' }); } catch {}
  } else if (song.cover) {
    coverUrl = song.cover.startsWith('http') ? song.cover : `/api/uploads/${stripLeading(song.cover)}`;
  }
  // 2. 如果歌曲没有封面，回退到专辑封面
  if (!coverUrl && song.album_id) {
    const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(song.album_id);
    if (album) {
      if (album.storage_mode === 's3' && album.cover_object_key) {
        try { coverUrl = await storage.s3Engine.url(album.cover_object_key, { mode: S3_PLAY_MODE === 'presigned' ? 'presigned' : 'proxy' }); } catch {}
      } else if (album.cover) {
        coverUrl = album.cover.startsWith('http') ? album.cover : `/api/uploads/${stripLeading(album.cover)}`;
      }
    }
  }
  let audioUrl = `/api/songs/${song.id}/stream`;
  if (song.storage_mode === 's3' && song.audio_object_key && S3_PLAY_MODE === 'presigned') {
    try { audioUrl = await storage.s3Engine.url(song.audio_object_key, { mode: 'presigned' }); } catch {}
  }
  const lrcUrl = song.lrc_exists ? `/api/songs/${song.id}/lrc` : '';
  return { ...song, coverUrl, audioUrl, lrcUrl };
}
function stripLeading(p) { return p.replace(/^(uploads?[\\/])+/, '').replace(/^[\\/]+/, ''); }

router.get('/', async (req, res) => {
  const keyword = (req.query.keyword || '').toString();
  const genre = (req.query.genre || '').toString();
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
  const where = [];
  const params = {};
  if (keyword) { where.push('(title LIKE @keyword OR singer LIKE @keyword OR album LIKE @keyword)'); params.keyword = `%${keyword}%`; }
  if (genre) { where.push('genre = @genre'); params.genre = genre; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM songs ${whereClause}`).get(params).c;
  const rows = db.prepare(`SELECT * FROM songs ${whereClause} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: size, offset: (page - 1) * size });
  const list = [];
  for (const s of rows) list.push(await withUrls(s, req));
  res.page(list, total);
});

// 公开专辑列表（无需认证）- 必须放在 /:id 之前
router.get('/albums', (req, res) => {
  const list = db.prepare(`
    SELECT a.id, a.name, a.singer, a.cover, a.cover_object_key, a.storage_mode,
           (SELECT COUNT(*) FROM songs s WHERE s.album_id = a.id) AS song_count
    FROM albums a ORDER BY a.id DESC
  `).all();
  const result = list.map(a => ({
    ...a,
    coverUrl: a.cover
      ? (a.cover.startsWith('http') ? a.cover : `/api/uploads/${stripLeading(a.cover)}`)
      : ''
  }));
  res.ok(result);
});

// 专辑详情（含歌曲列表）- 必须放在 /:id 之前
router.get('/albums/:id', async (req, res) => {
  const albumId = Number(req.params.id);
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(albumId);
  if (!album) return res.status(404).fail('专辑不存在');

  const songs = db.prepare('SELECT * FROM songs WHERE album_id = ? ORDER BY id ASC').all(albumId);
  const songsWithUrls = [];
  for (const s of songs) songsWithUrls.push(await withUrls(s, req));

  const albumInfo = {
    id: album.id,
    name: album.name,
    singer: album.singer,
    description: album.description,
    song_count: songs.length,
    coverUrl: album.cover
      ? (album.cover.startsWith('http') ? album.cover : `/api/uploads/${stripLeading(album.cover)}`)
      : ''
  };

  res.ok({ album: albumInfo, songs: songsWithUrls });
});

router.get('/:id', async (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(Number(req.params.id));
  if (!song) return res.status(404).json({ code: 404, message: '歌曲不存在' });
  res.ok(await withUrls(song, req));
});

// 注意：stream 允许未登录（以便播放器 UI 直接展示），但建议在生产配置防盗链
router.get('/:id/stream', optionalAuth, async (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(Number(req.params.id));
  if (!song) return res.status(404).json({ code: 404, message: '歌曲不存在' });
  // 首次播放请求（非 Range 后续分段）累计播放次数；S3 presigned 重定向前也会计入
  const range = req.headers.range;
  if (!range || range === 'bytes=0-') {
    try { db.prepare('UPDATE songs SET play_count = play_count + 1 WHERE id = ?').run(song.id); } catch {}
  }
  try { await streamSong(req, res, song); } catch (e) { res.status(500).json({ code: 500, message: e.message }); }
});

router.get('/:id/lrc', optionalAuth, async (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(Number(req.params.id));
  if (!song || !song.lrc_exists) return res.status(404).json({ code: 404, message: '无歌词' });
  try {
    if (song.storage_mode === 's3' && song.lrc_object_key) {
      const buf = await storage.s3Engine.getBuffer(song.lrc_object_key);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(buf);
    }
    const p = path.join(UPLOADS_DIR, 'lrc', `${song.id}.lrc`);
    if (fs.existsSync(p)) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.send(fs.readFileSync(p)); }
    return res.status(404).json({ code: 404, message: '无歌词文件' });
  } catch (e) { res.status(500).json({ code: 500, message: '读取失败' }); }
});

router.get('/:id/lyric', optionalAuth, async (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(Number(req.params.id));
  if (!song || !song.lrc_exists) return res.status(404).json({ code: 404, message: '无歌词' });
  let text = '';
  try {
    if (song.storage_mode === 's3' && song.lrc_object_key) text = (await storage.s3Engine.getBuffer(song.lrc_object_key)).toString('utf-8');
    else {
      const p = path.join(UPLOADS_DIR, 'lrc', `${song.id}.lrc`);
      text = fs.readFileSync(p, 'utf-8');
    }
  } catch (e) { return res.status(404).json({ code: 404, message: '无歌词文件' }); }
  const lines = parseLrcSimple(text);
  res.ok({ lines, meta: metaFromLrc(text) });
});

// 下载音频（Content-Disposition: attachment, 文件名: 歌手-歌名.mp3）
router.get('/:id/download', optionalAuth, async (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(Number(req.params.id));
  if (!song) return res.status(404).json({ code: 404, message: '歌曲不存在' });
  // 构造安全文件名: 歌手-歌名.mp3（去除非法字符）
  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || '未知';
  const filename = `${safe(song.singer)}-${safe(song.title)}.mp3`;
  // RFC 5987 编码文件名（支持中文）
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encoded}`);
  res.setHeader('Content-Type', 'audio/mpeg');
  // S3 模式:从对象存储读取后转发
  if (song.storage_mode === 's3' && song.audio_object_key) {
    try {
      const stream = await storage.s3Engine.getReadStream(song.audio_object_key, {});
      return stream.pipe(res);
    } catch (e) { return res.status(500).json({ code: 500, message: '读取对象存储失败' }); }
  }
  // 本地模式:直接流式
  const audioPath = song.audio_path;
  if (!audioPath) return res.status(404).json({ code: 404, message: '缺少音频文件' });
  const abs = path.isAbsolute(audioPath) ? audioPath : path.join(UPLOADS_DIR, audioPath);
  if (!fs.existsSync(abs)) return res.status(404).json({ code: 404, message: '音频文件不存在' });
  return fs.createReadStream(abs).pipe(res);
});

// 简易解析：逐行 [mm:ss.xx]
function parseLrcSimple(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)$/);
    if (!m) continue;
    const t = Number(m[1]) * 60 + Number(m[2]) + Number('0.' + (m[3] || '0'));
    out.push({ time: Number(t.toFixed(3)), text: m[4].trim(), words: [{ word: m[4].trim(), start: t }] });
  }
  return out.sort((a, b) => a.time - b.time);
}
function metaFromLrc(text) {
  const m = {};
  for (const raw of text.split(/\r?\n/)) {
    const r = raw.match(/^\[(ti|ar|al|by|offset):\s*(.*)\]$/i);
    if (r) m[r[1].toLowerCase()] = r[2].trim();
  }
  return m;
}

module.exports = router;
