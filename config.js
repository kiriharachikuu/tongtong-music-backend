/**
 * 瞳瞳音乐后端配置
 * - 从 .env 读取环境变量，集中导出
 * - 首次运行时如缺少 JWT_SECRET 会自动写入随机值
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(
    envPath,
    `# 瞳瞳音乐后端环境变量\nPORT=3000\nJWT_SECRET=${secret}\nJWT_EXPIRES_DAYS=30\nADMIN_USERNAME=admin\nADMIN_PASSWORD=admin123\nTRACK_CODE=\nFFMPEG_PATH=\nFFPROBE_PATH=\nTRANSCODE_TO_MP3=1\nSTATIC_PREFIX=/uploads\nSTORAGE_MODE=local\n`
  );
}

require('dotenv').config({ path: envPath });

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const UPLOADS_AUDIO_DIR = path.join(UPLOADS_DIR, 'audio');
const UPLOADS_COVER_DIR = path.join(UPLOADS_DIR, 'covers');
const UPLOADS_LRC_DIR = path.join(UPLOADS_DIR, 'lrc');
// 音频元数据探测临时目录（用于断点续传复用临时音频文件）
const PROBE_TMP_DIR = path.join(DATA_DIR, 'probe_tmp');

for (const dir of [DATA_DIR, UPLOADS_DIR, UPLOADS_AUDIO_DIR, UPLOADS_COVER_DIR, UPLOADS_LRC_DIR, PROBE_TMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const splitList = (v) =>
  (v || '')
    .toString()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'please-change-me',
  JWT_EXPIRES_DAYS: Number(process.env.JWT_EXPIRES_DAYS) || 30,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
  ROOT_DIR,
  DATA_DIR,
  DB_PATH: path.join(DATA_DIR, 'tongtong.db'),
  UPLOADS_DIR,
  UPLOADS_AUDIO_DIR,
  UPLOADS_COVER_DIR,
  UPLOADS_LRC_DIR,
  PROBE_TMP_DIR,
  AUDIO_TEMP_TTL: Number(process.env.AUDIO_TEMP_TTL) || 30 * 60 * 1000, // 默认 30 分钟
  PLAY_HISTORY_LIMIT: 50,
  VERSION: '1.0.0',
  STATIC_PREFIX: process.env.STATIC_PREFIX || '/uploads',
  TRANSCODE_TO_MP3: process.env.TRANSCODE_TO_MP3 !== '0',
  FFMPEG_PATH: process.env.FFMPEG_PATH || '',
  FFPROBE_PATH: process.env.FFPROBE_PATH || '',
  ALLOWED_AUDIO_MIME: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/x-m4a'],
  ALLOWED_IMAGE_MIME: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'],
  MAX_AUDIO_SIZE: 50 * 1024 * 1024,
  MAX_IMAGE_SIZE: 5 * 1024 * 1024,
  MAX_LRC_SIZE: 1024 * 1024,
  TRACK_CODE: process.env.TRACK_CODE || '',
  // ===== 存储 =====
  STORAGE_MODE: (process.env.STORAGE_MODE || 'local').toLowerCase() === 's3' ? 's3' : 'local',
  S3_ENDPOINT: process.env.S3_ENDPOINT || '',
  S3_REGION: process.env.S3_REGION || 'us-east-1',
  S3_BUCKET: process.env.S3_BUCKET || '',
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY || '',
  S3_SECRET_KEY: process.env.S3_SECRET_KEY || '',
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE === '1',
  S3_PRESIGN_EXPIRES: Number(process.env.S3_PRESIGN_EXPIRES) || 3600,
  S3_PLAY_MODE: process.env.S3_PLAY_MODE === 'proxy' ? 'proxy' : 'presigned',
  S3_KEY_PREFIX_AUDIO: 'audio/',
  S3_KEY_PREFIX_COVER: 'covers/',
  S3_KEY_PREFIX_LRC: 'lrc/',
  // ===== 安全 =====
  CORS_ORIGIN: splitList(process.env.CORS_ORIGIN),
  RATE_LIMIT_LOGIN: Number(process.env.RATE_LIMIT_LOGIN) || 10,
  RATE_LIMIT_UPLOAD: Number(process.env.RATE_LIMIT_UPLOAD) || 60,
};
