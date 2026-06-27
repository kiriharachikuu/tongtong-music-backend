/**
 * 管理员接口（仅管理员访问）
 *   GET    /api/admin/songs           歌曲列表/搜索/分页
 *   POST   /api/admin/songs         创建歌曲  { title, singer, album, genre }
 *   POST   /api/admin/songs/:id        更新歌曲信息
 *   DELETE /api/admin/songs/:id        删除歌曲（清理本地文件）
 *   POST   /api/admin/songs/:id/cover  上传封面（multipart/form-data, field: file）
 *   POST   /api/admin/songs/:id/audio 上传音频（自动转码 mp3）
 *   POST   /api/admin/songs/:id/lrc   上传歌词
 *   GET    /api/admin/stats         统计看板（歌曲/用户/播放次数）
 *   GET    /api/admin/users           用户列表
 *   DELETE /api/admin/users/:id     删除用户
 *   GET    /api/admin/banners        横幅列表
 *   POST   /api/admin/banners     创建横幅
 *   POST   /api/admin/banners/:id   更新
 *   DELETE /api/admin/banners/:id
 *   GET    /api/admin/playlists
 *   POST   /api/admin/playlists/:id/songs
 *   POST   /api/admin/logs            操作日志
 *   POST   /api/admin/storage/test  测试 S3 配置
 *   POST   /api/admin/storage/migrate 迁移本地资源到对象存储
 *   GET    /api/admin/storage/migrate/progress
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { UPLOADS_DIR, UPLOADS_COVER_DIR, UPLOADS_LRC_DIR, STORAGE_MODE, S3_PLAY_MODE, S3_KEY_PREFIX_COVER, S3_KEY_PREFIX_AUDIO, S3_KEY_PREFIX_LRC, RATE_LIMIT_UPLOAD, ALLOWED_AUDIO_MIME, ALLOWED_IMAGE_MIME, MAX_AUDIO_SIZE, MAX_IMAGE_SIZE, PROBE_TMP_DIR } = require('../config');
const storage = require('../storage');
const { transcode, probeAudio, makeTempToken } = require('../services/audio');
const logAction = require('../utils/opLog');
const rateLimit = require('../middleware/rateLimit');

const router = express.Router();
router.use(auth, adminOnly);

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const AUDIO_EXTS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.mp4'];

/**
 * 多类型文件过滤器：按 MIME 智能分流图片/歌词/音频
 */
const multipartFilter = (req, file, cb) => {
  const mime = file.mimetype || '';
  const ext = path.extname(file.originalname).toLowerCase();

  // 图片：image/* 或常见图片扩展名
  if (mime.startsWith('image/') || IMAGE_EXTS.includes(ext)) {
    if (ALLOWED_IMAGE_MIME.includes(mime) || mime === '') return cb(null, true);
    return cb(new Error('不支持的图片格式: ' + mime));
  }
  // 歌词：text/* 或 .lrc 扩展名
  if (mime.startsWith('text/') || ext === '.lrc') return cb(null, true);
  // 音频
  if (ALLOWED_AUDIO_MIME.includes(mime) || AUDIO_EXTS.includes(ext)) return cb(null, true);

  return cb(new Error('不支持的文件格式: ' + (mime || ext || '未知')));
};

/**
 * 根据 MIME/扩展名决定存储目录（严格分类）
 * 图片 -> covers/（必须是图片 MIME 或图片扩展名）
 * 歌词 -> lrc/（必须是 .lrc 扩展名或 text MIME）
 * 音频 -> audio/
 */
function destByMime(file) {
  const mime = file.mimetype || '';
  const ext = path.extname(file.originalname).toLowerCase();

  // 图片优先判断：必须明确是图片类型
  if (mime.startsWith('image/') || IMAGE_EXTS.includes(ext)) {
    return UPLOADS_COVER_DIR;
  }

  // 歌词文件：必须是 .lrc 扩展名或 text/plain MIME
  if (ext === '.lrc' || mime === 'text/plain') {
    return UPLOADS_LRC_DIR;
  }

  // 音频文件
  return path.join(UPLOADS_DIR, 'audio');
}

const uploader = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = destByMime(file);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.bin';
      cb(null, `${Date.now()}_${Math.floor(Math.random() * 1e6)}${ext}`);
    },
  }),
  fileFilter: multipartFilter,
  limits: { fileSize: 500 * 1024 * 1024 },
});

/**
 * 专用上传器：将探测用音频存入 PROBE_TMP_DIR，文件名含临时令牌
 */
const probeUploader = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(PROBE_TMP_DIR, { recursive: true });
      cb(null, PROBE_TMP_DIR);
    },
    filename: (req, file, cb) => {
      const token = makeTempToken();
      const safeName = path.basename(file.originalname).replace(/[^\w.\-]/g, '_');
      req.probeToken = token;
      cb(null, `${token}_${safeName}`);
    },
  }),
  fileFilter: multipartFilter,
  limits: { fileSize: MAX_AUDIO_SIZE },
});

// ============ 歌曲 ============
router.get('/songs', (req, res) => {
  const keyword = (req.query.keyword || '').toString();
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(500, Number(req.query.size) || 20);
  const where = keyword ? 'WHERE title LIKE ? OR singer LIKE ? OR album LIKE ?' : '';
  const params = keyword ? [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM songs ${where}`).get(...params).c;
  const list = db.prepare(`SELECT * FROM songs ${where} ORDER BY id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`).all(...params);
  res.page(list, total);
});

router.post('/songs', rateLimit(RATE_LIMIT_UPLOAD), (req, res) => {
  const { title, singer, album, album_id, genre, year, original_singer, remark } = req.body || {};
  if (!title) return res.fail('标题不能为空');
  let albumName = album || '';
  let albumId = null;
  if (album_id) {
    const alb = db.prepare('SELECT * FROM albums WHERE id = ?').get(Number(album_id));
    if (alb) { albumName = alb.name; albumId = alb.id; }
  }
  const info = db.prepare('INSERT INTO songs (title, singer, album, album_id, genre, year, original_singer, remark, storage_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(title, singer || '', albumName, albumId, genre || '', Number(year) || 0, original_singer || '', remark || '', STORAGE_MODE);
  logAction(req, { action: '创建歌曲', target: `song#${info.lastInsertRowid}`, detail: JSON.stringify({ title, singer, year, album_id: albumId }) });
  res.ok({ id: info.lastInsertRowid });
});

/**
 * 探测音频元数据：上传文件到临时目录，调用 ffprobe 解析，返回 metadata + tempToken
 * 后续 /songs/:id/audio 可凭 tempToken 复用临时文件，避免二次上传
 */
router.post('/songs/probe-audio', rateLimit(RATE_LIMIT_UPLOAD), probeUploader.single('file'), async (req, res) => {
  if (!req.file) return res.fail('未提供音频文件');
  try {
    const meta = await probeAudio(req.file.path);
    // ffprobe 关键字段为空时,按文件名以 `-` 分割回退填充: 歌名-演唱者-原唱-日期
    const hasTitle = meta.title && meta.title.trim();
    const hasArtist = meta.artist && meta.artist.trim();
    if (!hasTitle || !hasArtist) {
      const baseName = path.basename(req.file.originalname, path.extname(req.file.originalname));
      const parts = baseName.split(/\s*-\s*/).map((s) => s.trim()).filter(Boolean);
      if (!hasTitle && parts[0]) meta.title = parts[0];
      if (!hasArtist && parts[1]) meta.artist = parts[1];
      if (!meta.original_singer && parts[2]) meta.original_singer = parts[2];
      if ((!meta.year || meta.year === 0) && parts[3]) {
        const y = String(parts[3]).match(/(\d{4})/);
        if (y) meta.year = Number(y[1]);
      }
    }
    logAction(req, { action: '探测音频元数据', target: req.file.originalname, detail: JSON.stringify({ duration: meta.duration, bitrate: meta.bitrate }) });
    res.ok({ metadata: meta, tempToken: req.probeToken, tempFileName: req.file.filename });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.fail('音频解析失败: ' + e.message + '。请检查文件是否为有效的音频文件。');
  }
});

router.post('/songs/:id', (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(Number(req.params.id));
  if (!song) return res.status(404).fail('歌曲不存在');
  const { title, singer, album, album_id, genre, year, original_singer, remark } = req.body || {};
  let albumName = album != null ? album : song.album;
  let albumId = song.album_id;
  if (album_id != null) {
    const aid = Number(album_id) || null;
    if (aid) {
      const alb = db.prepare('SELECT * FROM albums WHERE id = ?').get(aid);
      if (alb) { albumName = alb.name; albumId = aid; }
    } else {
      albumName = ''; albumId = null;
    }
  }
  db.prepare('UPDATE songs SET title=?, singer=?, album=?, album_id=?, genre=?, year=?, original_singer=?, remark=? WHERE id=?')
    .run(title || song.title, singer || song.singer, albumName, albumId, genre || song.genre, year != null ? Number(year) || 0 : song.year, original_singer != null ? original_singer : song.original_singer || '', remark != null ? remark : song.remark || '', song.id);
  logAction(req, { action: '更新歌曲', target: `song#${song.id}`, detail: JSON.stringify({ title, singer, year, album_id: albumId }) });
  res.ok({ id: song.id });
});

router.delete('/songs/:id', async (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(Number(req.params.id));
  if (!song) return res.status(404).fail('歌曲不存在');
  try {
    if (song.storage_mode === 's3') {
      if (song.audio_object_key) await storage.s3Engine.delete(song.audio_object_key);
      if (song.cover_object_key) await storage.s3Engine.delete(song.cover_object_key);
      if (song.lrc_object_key) await storage.s3Engine.delete(song.lrc_object_key);
    } else {
      if (song.audio_path && fs.existsSync(path.isAbsolute(song.audio_path) ? song.audio_path : path.join(UPLOADS_DIR, song.audio_path))) {
        const p = path.isAbsolute(song.audio_path) ? song.audio_path : path.join(UPLOADS_DIR, song.audio_path);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      if (song.cover) {
        const p = path.isAbsolute(song.cover) ? song.cover : path.join(UPLOADS_DIR, song.cover);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      const lrc = path.join(UPLOADS_DIR, 'lrc', `${song.id}.lrc`);
      if (fs.existsSync(lrc)) fs.unlinkSync(lrc);
    }
  } catch (e) {}
  db.prepare('DELETE FROM playlist_items WHERE song_id = ?').run(song.id);
  db.prepare('DELETE FROM favorites WHERE song_id = ?').run(song.id);
  db.prepare('DELETE FROM play_history WHERE song_id = ?').run(song.id);
  db.prepare('DELETE FROM songs WHERE id = ?').run(song.id);
  logAction(req, { action: '删除歌曲', target: `song#${song.id}`, detail: song.title });
  res.ok({ removed: song.id });
});

router.post('/songs/:id/cover', rateLimit(RATE_LIMIT_UPLOAD), uploader.single('file'), async (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(Number(req.params.id));
  if (!song) return res.status(404).fail('歌曲不存在');
  if (!req.file) return res.fail('未提供图片');
  try {
    const filePath = req.file.path;
    if (STORAGE_MODE === 's3') {
      const key = `${S3_KEY_PREFIX_COVER || 'covers/'}${song.id}_${req.file.filename}`;
      await storage.s3Engine.put(key, fs.readFileSync(filePath));
      db.prepare('UPDATE songs SET cover=?, cover_object_key=?, storage_mode=? WHERE id=?').run('', key, 's3', song.id);
      try { fs.unlinkSync(filePath); } catch {}
    } else {
      const rel = path.relative(UPLOADS_DIR, filePath).split(path.sep).join('/');
      db.prepare('UPDATE songs SET cover=?, cover_object_key=NULL, storage_mode=? WHERE id=?').run(rel, 'local', song.id);
    }
    logAction(req, { action: '上传封面', target: `song#${song.id}`, detail: `size=${req.file.size}` });
    res.ok({ ok: true });
  } catch (e) { res.status(500).json({ code: 500, message: e.message }); }
});

router.post('/songs/:id/audio', rateLimit(RATE_LIMIT_UPLOAD), uploader.single('file'), async (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(Number(req.params.id));
  if (!song) return res.status(404).fail('歌曲不存在');

  const tempToken = req.body.tempToken;
  const tempFileName = req.body.tempFileName;
  let srcPath;

  // 优先使用 tempToken 复用临时文件（避免二次上传）
  if (tempToken && tempFileName) {
    const tempPath = path.join(PROBE_TMP_DIR, tempFileName);
    if (fs.existsSync(tempPath)) {
      srcPath = tempPath;
      // 若客户端仍附带了文件，清理冗余上传
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    } else if (req.file) {
      // 临时文件过期但客户端补传了文件
      srcPath = req.file.path;
    } else {
      return res.fail('临时文件已过期，请重新选择音频文件');
    }
  } else if (req.file) {
    srcPath = req.file.path;
  } else {
    return res.fail('未提供音频');
  }

  try {
    const outputName = `song_${song.id}_${Date.now()}.mp3`;
    let finalPath;
    let probeMeta = null;

    // 探测元数据（写入 DB；失败不阻塞转码）
    try { probeMeta = await probeAudio(srcPath); } catch (e) {}

    try {
      const out = await transcode(srcPath, outputName);
      finalPath = out.outputPath;
      if (fs.existsSync(srcPath)) { try { fs.unlinkSync(srcPath); } catch {} }
    } catch (e) { finalPath = srcPath; }

    if (STORAGE_MODE === 's3') {
      const key = `${S3_KEY_PREFIX_AUDIO || 'audio/'}${path.basename(finalPath)}`;
      await storage.s3Engine.put(key, fs.readFileSync(finalPath));
      db.prepare('UPDATE songs SET audio_path=?, audio_object_key=?, storage_mode=?, duration=?, bitrate=?, sample_rate=? WHERE id=?')
        .run('', key, 's3', probeMeta?.duration || 0, probeMeta?.bitrate || 0, probeMeta?.sample_rate || 0, song.id);
      try { fs.unlinkSync(finalPath); } catch {}
    } else {
      const rel = path.relative(UPLOADS_DIR, finalPath).split(path.sep).join('/');
      db.prepare('UPDATE songs SET audio_path=?, audio_object_key=NULL, storage_mode=?, duration=?, bitrate=?, sample_rate=? WHERE id=?')
        .run(rel, 'local', probeMeta?.duration || 0, probeMeta?.bitrate || 0, probeMeta?.sample_rate || 0, song.id);
    }
    logAction(req, { action: '上传音频', target: `song#${song.id}`, detail: JSON.stringify({ duration: probeMeta?.duration, bitrate: probeMeta?.bitrate }) });
    res.ok({ ok: true, metadata: probeMeta });
  } catch (e) { res.status(500).json({ code: 500, message: e.message }); }
});

router.post('/songs/:id/lrc', rateLimit(RATE_LIMIT_UPLOAD), uploader.single('file'), async (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(Number(req.params.id));
  if (!song) return res.status(404).fail('歌曲不存在');
  if (!req.file) return res.fail('未提供 LRC');
  try {
    const srcPath = req.file.path;
    if (STORAGE_MODE === 's3') {
      const key = `${S3_KEY_PREFIX_LRC || 'lrc/'}song_${song.id}.lrc`;
      await storage.s3Engine.put(key, fs.readFileSync(srcPath));
      db.prepare('UPDATE songs SET lrc_exists=1, lrc_object_key=?, storage_mode=? WHERE id=?').run(key, 's3', song.id);
      try { fs.unlinkSync(srcPath); } catch {}
    } else {
      const target = path.join(UPLOADS_LRC_DIR, `${song.id}.lrc`);
      fs.copyFileSync(srcPath, target);
      try { fs.unlinkSync(srcPath); } catch {}
      db.prepare('UPDATE songs SET lrc_exists=1, lrc_object_key=NULL, storage_mode=? WHERE id=?').run('local', song.id);
    }
    logAction(req, { action: '上传歌词', target: `song#${song.id}` });
    res.ok({ ok: true });
  } catch (e) { res.status(500).json({ code: 500, message: e.message }); }
});

// 删除歌词（清理本地文件或 S3 对象，并回写 lrc_exists=0）
router.delete('/songs/:id/lrc', async (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(Number(req.params.id));
  if (!song) return res.status(404).fail('歌曲不存在');
  try {
    if (song.storage_mode === 's3' && song.lrc_object_key) {
      await storage.s3Engine.delete(song.lrc_object_key);
    } else {
      const lrc = path.join(UPLOADS_LRC_DIR, `${song.id}.lrc`);
      if (fs.existsSync(lrc)) fs.unlinkSync(lrc);
    }
    db.prepare('UPDATE songs SET lrc_exists=0, lrc_object_key=NULL WHERE id=?').run(song.id);
    logAction(req, { action: '删除歌词', target: `song#${song.id}` });
    res.ok({ ok: true });
  } catch (e) { res.status(500).json({ code: 500, message: e.message }); }
});

// ============ 专辑管理 ============
/** 专辑列表（含歌曲数统计） */
router.get('/albums', (req, res) => {
  const { keyword } = req.query || {};
  let where = '';
  const params = [];
  if (keyword) {
    where = 'WHERE a.name LIKE ? OR a.singer LIKE ?';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  const list = db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM songs s WHERE s.album_id = a.id) AS song_count
    FROM albums a ${where} ORDER BY a.id DESC
  `).all(...params);
  res.ok(list);
});

/** 创建专辑 */
router.post('/albums', rateLimit(RATE_LIMIT_UPLOAD), (req, res) => {
  const { name, singer, description } = req.body || {};
  if (!name) return res.fail('专辑名不能为空');
  const info = db.prepare('INSERT INTO albums (name, singer, description, storage_mode) VALUES (?, ?, ?, ?)')
    .run(name, singer || '', description || '', STORAGE_MODE);
  logAction(req, { action: '创建专辑', target: `album#${info.lastInsertRowid}`, detail: JSON.stringify({ name, singer }) });
  res.ok({ id: info.lastInsertRowid });
});

/** 更新专辑信息 */
router.post('/albums/:id', (req, res) => {
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(Number(req.params.id));
  if (!album) return res.status(404).fail('专辑不存在');
  const { name, singer, description } = req.body || {};
  db.prepare('UPDATE albums SET name=?, singer=?, description=? WHERE id=?')
    .run(name || album.name, singer != null ? singer : album.singer, description != null ? description : album.description, album.id);
  // 同步更新关联歌曲的 album 文本字段
  if (name) {
    db.prepare('UPDATE songs SET album=? WHERE album_id=?').run(name, album.id);
  }
  logAction(req, { action: '更新专辑', target: `album#${album.id}`, detail: JSON.stringify({ name, singer }) });
  res.ok({ id: album.id });
});

/** 上传专辑封面 */
router.post('/albums/:id/cover', rateLimit(RATE_LIMIT_UPLOAD), uploader.single('file'), async (req, res) => {
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(Number(req.params.id));
  if (!album) return res.status(404).fail('专辑不存在');
  if (!req.file) return res.fail('未提供图片');
  try {
    const filePath = req.file.path;
    if (STORAGE_MODE === 's3') {
      const key = `album-covers/${album.id}_${req.file.filename}`;
      const storage = require('../services/storage');
      await storage.s3Engine.put(key, fs.readFileSync(filePath));
      db.prepare('UPDATE albums SET cover=?, cover_object_key=?, storage_mode=? WHERE id=?').run('', key, 's3', album.id);
      try { fs.unlinkSync(filePath); } catch {}
    } else {
      const rel = path.relative(UPLOADS_DIR, filePath).split(path.sep).join('/');
      db.prepare('UPDATE albums SET cover=?, cover_object_key=NULL, storage_mode=? WHERE id=?').run(rel, 'local', album.id);
    }
    logAction(req, { action: '上传专辑封面', target: `album#${album.id}`, detail: `size=${req.file.size}` });
    res.ok({ ok: true });
  } catch (e) { res.status(500).json({ code: 500, message: e.message }); }
});

/** 删除专辑（不删除关联歌曲，仅解除关联） */
router.delete('/albums/:id', (req, res) => {
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(Number(req.params.id));
  if (!album) return res.status(404).fail('专辑不存在');
  // 清理封面文件
  if (album.cover && STORAGE_MODE === 'local') {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, album.cover)); } catch {}
  }
  // 解除歌曲关联
  db.prepare('UPDATE songs SET album_id=NULL WHERE album_id=?').run(album.id);
  // 删除专辑记录
  db.prepare('DELETE FROM albums WHERE id=?').run(album.id);
  logAction(req, { action: '删除专辑', target: `album#${album.id}`, detail: album.name });
  res.ok({ ok: true });
});

// ============ 统计 ============
router.get('/stats', (req, res) => {
  const songCount = db.prepare('SELECT COUNT(*) AS c FROM songs').get().c;
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const playCount = db.prepare('SELECT COUNT(*) AS c FROM play_history').get().c;
  const favoriteCount = db.prepare('SELECT COUNT(*) AS c FROM favorites').get().c;
  res.ok({ songCount, userCount, playCount, favoriteCount });
});

// ============ 用户 ============
router.get('/users', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Number(req.query.size) || 20);
  const total = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const list = db.prepare(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.is_admin, u.created_at,
       (SELECT COUNT(*) FROM play_history WHERE user_id = u.id) AS play_count,
       (SELECT COUNT(*) FROM favorites WHERE user_id = u.id) AS favorite_count,
       (SELECT COUNT(*) FROM playlists WHERE owner_id = u.id) AS playlist_count
     FROM users u ORDER BY u.id DESC LIMIT ? OFFSET ?`
  ).all(size, (page - 1) * size);
  res.page(list, total);
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.fail('不能删除自己');
  db.prepare('DELETE FROM play_history WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM favorites WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM playlists WHERE owner_id = ?').run(id);
  db.prepare('DELETE FROM player_queue WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  logAction(req, { action: '删除用户', target: `user#${id}` });
  res.ok({ removed: id });
});

// ============ 横幅 ============
router.get('/banners', (req, res) => {
  const list = db.prepare('SELECT * FROM banners ORDER BY "order" ASC, id ASC').all();
  const base = `${req.protocol}://${req.get('host')}`;
  for (const b of list) {
    if (b.storage_mode === 's3' && b.image_object_key) {
      try { b.imageUrl = storage.s3Engine.url(b.image_object_key, { mode: S3_PLAY_MODE === 'presigned' ? 'presigned' : 'proxy' }); } catch { b.imageUrl = ''; }
    } else {
      b.imageUrl = b.image ? (b.image.startsWith('http') ? b.image : `${base}/api/uploads/${b.image.replace(/^(uploads?[\\/])+/, '').replace(/^[\\/]+/, '')}`) : '';
    }
  }
  res.ok(list);
});

router.post('/banners', (req, res) => {
  const { title, link, order, song_id, ad_url } = req.body || {};
  const info = db.prepare('INSERT INTO banners (title, link, "order", song_id, ad_url, storage_mode) VALUES (?, ?, ?, ?, ?, ?)').run(title || '', link || '', Number(order) || 0, song_id || null, ad_url || '', STORAGE_MODE);
  logAction(req, { action: '创建横幅', target: `banner#${info.lastInsertRowid}`, detail: title });
  res.ok({ id: info.lastInsertRowid });
});

router.post('/banners/:id/image', uploader.single('file'), async (req, res) => {
  const b = db.prepare('SELECT * FROM banners WHERE id = ?').get(Number(req.params.id));
  if (!b) return res.status(404).fail('横幅不存在');
  if (!req.file) return res.fail('未提供图片');
  try {
    if (STORAGE_MODE === 's3') {
      const key = `banners/${req.file.filename}`;
      await storage.s3Engine.put(key, fs.readFileSync(req.file.path));
      db.prepare('UPDATE banners SET image=?, image_object_key=?, storage_mode=? WHERE id=?').run('', key, 's3', b.id);
      try { fs.unlinkSync(req.file.path); } catch {}
    } else {
      const rel = path.relative(UPLOADS_DIR, req.file.path).split(path.sep).join('/');
      db.prepare('UPDATE banners SET image=?, image_object_key=NULL, storage_mode=? WHERE id=?').run(rel, 'local', b.id);
    }
    logAction(req, { action: '上传横幅图片', target: `banner#${b.id}` });
    res.ok({ ok: true });
  } catch (e) { res.status(500).json({ code: 500, message: e.message }); }
});

router.post('/banners/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM banners WHERE id = ?').get(Number(req.params.id));
  if (!b) return res.status(404).fail('横幅不存在');
  const { title, link, order, song_id, ad_url } = req.body || {};
  db.prepare('UPDATE banners SET title=?, link=?, "order"=?, song_id=?, ad_url=? WHERE id=?')
    .run(title != null ? title : b.title, link != null ? link : b.link, Number(order) ?? b.order, song_id != null ? (song_id || null) : b.song_id, ad_url != null ? ad_url : b.ad_url, b.id);
  logAction(req, { action: '更新横幅', target: `banner#${b.id}`, detail: title });
  res.ok({ id: b.id });
});

router.delete('/banners/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM banners WHERE id = ?').get(Number(req.params.id));
  if (!b) return res.status(404).fail('横幅不存在');
  try {
    if (b.storage_mode === 's3' && b.image_object_key) storage.s3Engine.delete(b.image_object_key);
    else if (b.image) {
      const p = path.isAbsolute(b.image) ? b.image : path.join(UPLOADS_DIR, b.image);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch (e) {}
  db.prepare('DELETE FROM banners WHERE id = ?').run(b.id);
  logAction(req, { action: '删除横幅', target: `banner#${b.id}`, detail: b.title });
  res.ok({ removed: b.id });
});

// ============ 歌单 ============
router.get('/playlists', (req, res) => {
  const list = db.prepare('SELECT p.*, (SELECT COUNT(*) FROM playlist_items WHERE playlist_id = p.id) AS song_count, u.username AS owner_name FROM playlists p LEFT JOIN users u ON u.id = p.owner_id ORDER BY p.id DESC').all();
  res.ok(list);
});

// 创建歌单（管理员）
router.post('/playlists', (req, res) => {
  const { name, description, cover_url, is_system } = req.body || {};
  if (!name) return res.fail('歌单名称不能为空');
  const sysFlag = is_system === 1 || is_system === true ? 1 : 0;
  const info = db.prepare('INSERT INTO playlists (name, description, cover_url, owner_id, is_system) VALUES (?, ?, ?, ?, ?)').run(name, description || '', cover_url || '', req.user.id, sysFlag);
  logAction(req, { action: '创建歌单', target: `playlist#${info.lastInsertRowid}`, detail: JSON.stringify({ name, is_system: sysFlag }) });
  res.ok({ id: info.lastInsertRowid });
});

// 更新歌单元信息
router.post('/playlists/:id', (req, res) => {
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(req.params.id));
  if (!pl) return res.status(404).fail('歌单不存在');
  const { name, description } = req.body || {};
  db.prepare('UPDATE playlists SET name=?, description=? WHERE id=?').run(name || pl.name, description != null ? description : pl.description, pl.id);
  logAction(req, { action: '更新歌单', target: `playlist#${pl.id}`, detail: name });
  res.ok({ id: pl.id });
});

router.post('/playlists/:id/songs', (req, res) => {
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(req.params.id));
  if (!pl) return res.status(404).fail('歌单不存在');
  const { songIds = [] } = req.body || {};
  const added = [];
  for (const id of songIds) {
    const n = Number(id); if (!n) continue;
    const exist = db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ? AND song_id = ?').get(pl.id, n);
    if (exist) continue;
    db.prepare('INSERT INTO playlist_items (playlist_id, song_id, position) VALUES (?, ?, 0)').run(pl.id, n);
    added.push(n);
  }
  logAction(req, { action: '歌单添加歌曲', target: `playlist#${pl.id}`, detail: JSON.stringify(added) });
  res.ok({ added: added.length });
});

router.delete('/playlists/:id/songs/:songId', (req, res) => {
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(req.params.id));
  if (!pl) return res.status(404).fail('歌单不存在');
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND song_id = ?').run(pl.id, Number(req.params.songId));
  logAction(req, { action: '歌单删除歌曲', target: `playlist#${pl.id}` });
  res.ok({ ok: true });
});

router.delete('/playlists/:id', (req, res) => {
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(req.params.id));
  if (!pl) return res.status(404).fail('歌单不存在');
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(pl.id);
  db.prepare('DELETE FROM playlists WHERE id = ?').run(pl.id);
  logAction(req, { action: '删除歌单', target: `playlist#${pl.id}`, detail: pl.name });
  res.ok({ removed: pl.id });
});

// ============ 日志 ============
router.get('/logs', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(200, Number(req.query.size) || 30);
  const { action, user_id, from, to } = req.query || {};
  const where = [];
  const params = {};
  if (action) { where.push('action = @action'); params.action = action; }
  if (user_id) { where.push('user_id = @user_id'); params.user_id = Number(user_id); }
  if (from) { where.push("created_at >= @from"); params.from = from; }
  if (to) { where.push("created_at <= @to"); params.to = to; }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM op_logs ${whereClause}`).get(params).c;
  const list = db.prepare(`SELECT * FROM op_logs ${whereClause} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: size, offset: (page - 1) * size });
  res.page(list, total);
});

// ============ 存储配置中心 ============
// storage_config 表的 CRUD：管理员可在后台读取/修改存储配置
router.get('/storage/config', (req, res) => {
  const rows = db.prepare('SELECT key, value, updated_at FROM storage_config ORDER BY key').all();
  res.ok(rows);
});

router.post('/storage/config', (req, res) => {
  const { items = [] } = req.body || {};
  const upsert = db.prepare('INSERT INTO storage_config (key, value, updated_at) VALUES (?, ?, datetime(\'now\',\'localtime\')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at');
  for (const { key, value } of items) {
    if (!key) continue;
    upsert.run(key, value == null ? '' : String(value));
  }
  logAction(req, { action: '更新存储配置', target: 'storage_config', detail: JSON.stringify(items.map((i) => i.key)) });
  res.ok({ ok: true });
});

router.delete('/storage/config/:key', (req, res) => {
  db.prepare('DELETE FROM storage_config WHERE key = ?').run(req.params.key);
  logAction(req, { action: '删除存储配置项', target: `storage_config:${req.params.key}` });
  res.ok({ ok: true });
});

router.post('/storage/test', async (req, res) => {
  try {
    const key = `__test_${Date.now()}.txt`;
    await storage.s3Engine.put(key, Buffer.from('test', 'utf-8'));
    const signed = await storage.s3Engine.url(key, { mode: 'presigned' });
    await storage.s3Engine.delete(key);
    logAction(req, { action: '测试对象存储连通', target: 'storage' });
    res.ok({ ok: true, signedUrl: signed });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/storage/migrate', async (req, res) => {
  logAction(req, { action: '启动本地→对象存储迁移', target: 'storage' });
  try {
    const runId = `run_${Date.now()}`;
    const rows = db.prepare('SELECT * FROM songs').all();
    let total = 0, ok = 0, errors = [];
    const insertState = db.prepare('INSERT INTO storage_migration_state (run_id, song_id, phase, status, old_path, new_object_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\',\'localtime\'))');
    for (const s of rows) {
      if (s.audio_path) {
        total++;
        try {
          const key = `audio/song_${s.id}_${Date.now()}.mp3`;
          const full = path.isAbsolute(s.audio_path) ? s.audio_path : path.join(UPLOADS_DIR, s.audio_path);
          if (fs.existsSync(full)) {
            await storage.s3Engine.put(key, fs.readFileSync(full));
            db.prepare('UPDATE songs SET audio_object_key=?, audio_path=?, storage_mode=? WHERE id=?').run(key, '', 's3', s.id);
            try { fs.unlinkSync(full); } catch (e) {}
            insertState.run(runId, s.id, 'audio', 'done', s.audio_path, key);
            ok++;
          }
        } catch (e) { errors.push({ id: s.id, err: e.message }); insertState.run(runId, s.id, 'audio', 'error', '', ''); }
      }
      if (s.cover) {
        try {
          const key = `covers/song_${s.id}_${Date.now()}.png`;
          const full = path.isAbsolute(s.cover) ? s.cover : path.join(UPLOADS_DIR, s.cover);
          if (fs.existsSync(full)) {
            await storage.s3Engine.put(key, fs.readFileSync(full));
            db.prepare('UPDATE songs SET cover_object_key=?, cover=? WHERE id=?').run(key, '', s.id);
            try { fs.unlinkSync(full); } catch (e) {}
            insertState.run(runId, s.id, 'cover', 'done', s.cover, key);
          }
        } catch (e) { errors.push({ id: s.id, err: e.message }); insertState.run(runId, s.id, 'cover', 'error', '', ''); }
      }
      const lrcPath = path.join(UPLOADS_DIR, 'lrc', `${s.id}.lrc`);
      if (fs.existsSync(lrcPath)) {
        try {
          const key = `lrc/song_${s.id}.lrc`;
          await storage.s3Engine.put(key, fs.readFileSync(lrcPath));
          db.prepare('UPDATE songs SET lrc_object_key=?, lrc_exists=1 WHERE id=?').run(key, s.id);
          fs.unlinkSync(lrcPath);
          insertState.run(runId, s.id, 'lrc', 'done', '', key);
        } catch (e) { errors.push({ id: s.id, err: e.message }); insertState.run(runId, s.id, 'lrc', 'error', '', ''); }
      }
    }
    logAction(req, { action: '对象存储迁移完成', target: 'storage', detail: `total=${rows.length}, ok=${ok}, errors=${errors.length}` });
    res.ok({ runId, total, ok, errors });
  } catch (e) { res.status(500).json({ code: 500, message: e.message }); }
});

router.get('/storage/migrate/progress', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS c FROM storage_migration_state').get().c;
  const recent = db.prepare('SELECT * FROM storage_migration_state ORDER BY updated_at DESC LIMIT 50').all();
  res.ok({ total, recent });
});

// ============ 环境变量配置（.env 文件编辑） ============
const ENV_FILE = path.join(__dirname, '..', '.env');

/** 读取 .env 文件并解析为分组结构 */
router.get('/env', (req, res) => {
  try {
    if (!fs.existsSync(ENV_FILE)) return res.fail('.env 文件不存在');
    const text = fs.readFileSync(ENV_FILE, 'utf-8');
    const lines = text.split(/\r?\n/);
    const sections = [];
    let currentSection = { comment: '', items: [] };
    let hasItems = false;

    for (const line of lines) {
      const trimmed = line.trim();
      // 注释行（以 # 开头）
      if (trimmed.startsWith('#')) {
        if (hasItems) {
          sections.push(currentSection);
          currentSection = { comment: '', items: [] };
          hasItems = false;
        }
        currentSection.comment += (currentSection.comment ? '\n' : '') + line;
      } else if (!trimmed) {
        // 空行：跳过但不重置 section
        continue;
      } else {
        // KEY=VALUE 行
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.substring(0, eqIdx).trim();
          const value = trimmed.substring(eqIdx + 1).trim();
          currentSection.items.push({ key, value });
          hasItems = true;
        }
      }
    }
    if (currentSection.items.length || currentSection.comment) {
      sections.push(currentSection);
    }
    res.ok({ sections });
  } catch (e) { res.status(500).json({ code: 500, message: e.message }); }
});

/** 更新 .env 文件中的指定键值 */
router.post('/env', (req, res) => {
  try {
    if (!fs.existsSync(ENV_FILE)) return res.fail('.env 文件不存在');
    const { updates } = req.body || {};
    if (!updates || typeof updates !== 'object') return res.fail('未提供更新数据');
    // 敏感字段掩码返回但不限制修改
    const text = fs.readFileSync(ENV_FILE, 'utf-8');
    const lines = text.split(/\r?\n/);
    const updatedKeys = new Set();
    const newLines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed) return line;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) return line;
      const key = trimmed.substring(0, eqIdx).trim();
      if (updates.hasOwnProperty(key)) {
        updatedKeys.add(key);
        return `${key}=${updates[key]}`;
      }
      return line;
    });
    fs.writeFileSync(ENV_FILE, newLines.join('\n'), 'utf-8');
    logAction(req, { action: '修改环境变量', target: '.env', detail: JSON.stringify([...updatedKeys]) });
    res.ok({ updated: [...updatedKeys], message: '配置已保存，部分变更需重启服务后生效' });
  } catch (e) { res.status(500).json({ code: 500, message: e.message }); }
});

module.exports = router;
