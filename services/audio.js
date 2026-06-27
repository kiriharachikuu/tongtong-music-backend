/**
 * 音频转码与流式播放
 *   transcode(inputPath, outputPath)  - 将任意音频转码为 128kbps MP3
 *   streamSong(req, res, song)        - 以 Range 形式播放歌曲
 *   probeAudio(filePath)              - 调用 ffprobe 提取音频元数据
 *   makeTempToken() / resolveTempPath - 临时文件令牌（断点续传复用）
 *   startTempSweep()                 - 后台定时清理过期临时文件
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const { FFMPEG_PATH, FFPROBE_PATH, TRANSCODE_TO_MP3, UPLOADS_DIR, UPLOADS_AUDIO_DIR, S3_PLAY_MODE, STORAGE_MODE, PROBE_TMP_DIR, AUDIO_TEMP_TTL } = require('../config');
const storage = require('../storage');

if (FFMPEG_PATH) ffmpeg.setFfmpegPath(FFMPEG_PATH);
if (FFPROBE_PATH) ffmpeg.setFfprobePath(FFPROBE_PATH);

function transcode(inputPath, outputName) {
  return new Promise((resolve, reject) => {
    if (!TRANSCODE_TO_MP3) {
      return resolve({ outputPath: inputPath, transcoded: false });
    }
    const outputPath = path.join(UPLOADS_AUDIO_DIR, outputName);
    fs.mkdirSync(UPLOADS_AUDIO_DIR, { recursive: true });
    const cmd = ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .format('mp3')
      .output(outputPath)
      .on('end', () => resolve({ outputPath, transcoded: true }))
      .on('error', (err) => reject(err));
    cmd.run();
  });
}

/**
 * 从本地文件流式播放（支持 Range）
 */
function streamLocalFile(req, res, absPath) {
  if (!fs.existsSync(absPath)) return res.status(404).json({ code: 404, message: '文件不存在' });
  const stat = fs.statSync(absPath);
  const total = stat.size;
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'audio/mpeg');
  if (!range) {
    res.setHeader('Content-Length', total);
    return fs.createReadStream(absPath).pipe(res);
  }
  const [s, e] = range.replace(/bytes=/, '').split('-');
  const start = parseInt(s, 10) || 0;
  const end = e ? parseInt(e, 10) : total - 1;
  if (start >= total || end >= total || start > end) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.end();
  }
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(absPath, { start, end }).pipe(res);
}

/**
 * 根据 songs 行，决定如何播放：
 *   - 本地存储 -> 读取 audio_path 流式
 *   - S3 + presigned -> 302 重定向到预签名 URL
 *   - S3 + proxy    -> 从 S3 读取后流式转发
 */
async function streamSong(req, res, song) {
  if (!song) return res.status(404).json({ code: 404, message: '歌曲不存在' });
  const mode = song.storage_mode || STORAGE_MODE;
  if (mode === 's3') {
    if (!song.audio_object_key) return res.status(404).json({ code: 404, message: '缺少音频对象' });
    if (S3_PLAY_MODE === 'presigned') {
      const url = await storage.s3Engine.url(song.audio_object_key, { mode: 'presigned' });
      return res.redirect(302, url);
    }
    // proxy
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'audio/mpeg');
    try {
      const stream = await storage.s3Engine.getReadStream(song.audio_object_key, { range });
      if (range && stream) {
        res.status(206);
      }
      stream.on('error', () => {});
      stream.pipe(res);
    } catch (e) {
      return res.status(500).json({ code: 500, message: '读取对象存储失败' });
    }
    return;
  }
  // 本地
  let audioPath = song.audio_path;
  // 容错：如果 audio_path 为空但 audio_object_key 存有本地路径格式（如 "audio/song_xxx.mp3"），
  // 且文件在本地存在，则回退使用 audio_object_key（修复历史数据不一致问题）
  if (!audioPath && song.audio_object_key && !song.audio_object_key.startsWith('s3://')) {
    const candidatePath = song.audio_object_key;
    const fallbackAbs = path.isAbsolute(candidatePath)
      ? candidatePath
      : path.join(UPLOADS_DIR, candidatePath);
    if (fs.existsSync(fallbackAbs)) {
      audioPath = candidatePath;
    }
  }
  if (!audioPath) return res.status(404).json({ code: 404, message: '缺少音频文件' });
  // audio_path 在入库时是相对于 UPLOADS_DIR 的（如 "audio/song_1_xxx.mp3"）
  const abs = path.isAbsolute(audioPath) ? audioPath : path.join(UPLOADS_DIR, audioPath);
  if (!fs.existsSync(abs)) {
    console.error('[streamSong] 音频文件不存在:', abs, 'songId:', song.id);
    return res.status(404).json({ code: 404, message: '音频文件不存在' });
  }
  return streamLocalFile(req, res, abs);
}

// ============ 音频元数据探测（ffprobe）============

/**
 * 安全字符串化 ffprobe tag（可能为 Buffer/数组）
 */
function tagStr(v) {
  if (v == null) return '';
  if (Buffer.isBuffer(v)) return v.toString('utf-8').trim();
  if (Array.isArray(v)) return v.map(tagStr).filter(Boolean).join(' / ').trim();
  return String(v).trim();
}

/**
 * 解析年份：支持 "2024" / "2024-01-01" / "2024-00-00T..."
 */
function parseYear(raw) {
  if (!raw) return 0;
  const m = String(raw).match(/(\d{4})/);
  return m ? Number(m[1]) : 0;
}

/**
 * 调用 ffprobe 提取音频元数据
 * @param {string} filePath 本地音频文件路径
 * @returns {Promise<{title,artist,album,genre,year,duration,bitrate,sample_rate,codec}>}
 */
function probeAudio(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg(filePath).ffprobe((err, data) => {
      if (err) return reject(new Error('ffprobe 解析失败: ' + err.message));
      const fmt = data.format || {};
      const tags = fmt.tags || {};
      const audioStream = (data.streams || []).find((s) => s.codec_type === 'audio') || {};
      const yearRaw =
        tagStr(tags.date) ||
        tagStr(tags.year) ||
        tagStr(tags.creation_time) ||
        tagStr(tags.TDRC) ||
        tagStr(tags.TYER);
      resolve({
        title: tagStr(tags.title) || tagStr(tags.TIT2),
        artist: tagStr(tags.artist) || tagStr(tags.ARTIST) || tagStr(tags.TPE1),
        album: tagStr(tags.album) || tagStr(tags.ALBUM) || tagStr(tags.TALB),
        genre: tagStr(tags.genre) || tagStr(tags.GENRE) || tagStr(tags.TCON),
        year: parseYear(yearRaw),
        duration: Math.round(Number(fmt.duration) || 0),
        bitrate: Math.round((Number(fmt.bit_rate) || 0) / 1000), // kbps
        sample_rate: Number(audioStream.sample_rate) || 0,
        codec: audioStream.codec_name || '',
        original_singer: '',
      });
    });
  });
}

/**
 * 生成临时文件令牌（用于断点续传复用临时文件）
 */
function makeTempToken() {
  return crypto.randomUUID();
}

/**
 * 根据令牌解析临时文件路径
 */
function resolveTempPath(token, originalName) {
  if (!token) return null;
  const safeName = path.basename(originalName || 'audio.bin').replace(/[^\w.\-]/g, '_');
  return path.join(PROBE_TMP_DIR, `${token}_${safeName}`);
}

/**
 * 启动临时文件清扫定时器（每 10 分钟清理超过 TTL 的文件）
 */
function startTempSweep() {
  const SWEEP_INTERVAL = 10 * 60 * 1000;
  setInterval(() => {
    try {
      if (!fs.existsSync(PROBE_TMP_DIR)) return;
      const now = Date.now();
      for (const name of fs.readdirSync(PROBE_TMP_DIR)) {
        const fp = path.join(PROBE_TMP_DIR, name);
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > AUDIO_TEMP_TTL) {
          fs.unlinkSync(fp);
        }
      }
    } catch (e) {
      /* 忽略清扫错误 */
    }
  }, SWEEP_INTERVAL);
}

module.exports = { transcode, streamSong, streamLocalFile, probeAudio, makeTempToken, resolveTempPath, startTempSweep };
