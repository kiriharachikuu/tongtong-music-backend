const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const morgan = require('morgan');
const { PORT, ROOT_DIR, TRACK_CODE, VERSION, CORS_ORIGIN } = require('./config');
const { initDatabase } = require('./db');
const apiResponse = require('./middleware/response');
const { startTempSweep } = require('./services/audio');

const authRoutes = require('./routes/auth');
const songsRoutes = require('./routes/songs');
const favoritesRoutes = require('./routes/favorites');
const playlistsRoutes = require('./routes/playlists');
const bannersRoutes = require('./routes/banners');
const dailyRoutes = require('./routes/daily');
const historyRoutes = require('./routes/history');
const playerRoutes = require('./routes/player');
const discoverRoutes = require('./routes/discover');
const rankingRoutes = require('./routes/ranking');
const versionsRoutes = require('./routes/versions');
const adminRoutes = require('./routes/admin');

const app = express();

// CORS：配置了白名单则严格限定来源，否则开发环境放行全部
const corsOptions = CORS_ORIGIN.length
  ? { origin: CORS_ORIGIN, credentials: true }
  : {};
app.use(cors(corsOptions));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('tiny'));
app.use(apiResponse);

// 防盗链中间件：校验 Referer / Origin 是否在白名单内（仅对 /api/songs 流媒体与静态资源生效）
function hotlinkGuard(whitelist) {
  return (req, res, next) => {
    if (!whitelist.length) return next();
    const referer = req.headers['referer'] || '';
    const origin = req.headers['origin'] || '';
    if (!referer && !origin) return next(); // 非浏览器请求（如 curl/原生播放器）放行
    const isAllowed = (u) => {
      if (!u) return false;
      try {
        const h = new URL(u).host;
        return whitelist.some((w) => h === w || h.endsWith('.' + w));
      } catch { return false; }
    };
    if (isAllowed(referer) || isAllowed(origin)) return next();
    return res.status(403).json({ code: 403, message: '防盗链：来源不在白名单', data: null });
  };
}
const hotlinkWhitelist = CORS_ORIGIN.map((o) => { try { return new URL(o).host; } catch { return ''; } }).filter(Boolean);
if (hotlinkWhitelist.length) {
  app.use('/api/songs/:id/stream', hotlinkGuard(hotlinkWhitelist));
  app.use('/api/uploads', hotlinkGuard(hotlinkWhitelist));
}

app.get('/api/health', (req, res) => {
  res.ok({ uptime: process.uptime(), version: VERSION, trackCode: !!TRACK_CODE });
});

app.use('/api/static', express.static(path.join(ROOT_DIR, 'uploads'), { maxAge: '1d' }));
app.use('/api/uploads', express.static(path.join(ROOT_DIR, 'uploads'), { maxAge: '1d' }));

app.use('/api/auth', authRoutes);
app.use('/api/songs', songsRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/playlists', playlistsRoutes);
app.use('/api/banners', bannersRoutes);
app.use('/api/daily', dailyRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/player', playerRoutes);
app.use('/api/discover', discoverRoutes);
app.use('/api/ranking', rankingRoutes);
app.use('/api/version', versionsRoutes);
app.use('/api/admin', adminRoutes);

const frontendDist = path.join(ROOT_DIR, '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist, { maxAge: '1h', index: 'index.html' }));
  app.get(/^\/(?!api\/|static\/).*/, (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.use((err, req, res, next) => {
  console.error('[server]', err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ code: 500, message: (err && err.message) || '服务器内部错误', data: null });
});

app.use((req, res) => {
  res.status(404).json({ code: 404, message: '接口不存在', data: null });
});

try {
  initDatabase();
} catch (e) {
  console.error('[db] 初始化失败', e);
}
app.listen(PORT, () => {
  console.log(`[tongtong-music] http://localhost:${PORT}`);
  startTempSweep();
});
