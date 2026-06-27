#!/usr/bin/env node
/**
 * 瞳瞳音乐 - 本地→对象存储迁移脚本（命令行版）
 *
 * 遍历数据库中所有 storage_mode='local' 的歌曲，
 * 将其音频/封面/歌词上传至 S3 兼容对象存储，并回写 *_object_key 字段。
 *
 * 用法:
 *   node scripts/migrate_to_s3.js --help
 *   node scripts/migrate_to_s3.js                    # 执行迁移
 *   node scripts/migrate_to_s3.js --dry-run          # 试运行
 *   node scripts/migrate_to_s3.js --resume           # 断点续传
 *   node scripts/migrate_to_s3.js --concurrency=5    # 并发数
 *
 * 环境变量（读取 backend/.env）:
 *   STORAGE_MODE=s3            必须设为 s3 才会执行
 *   S3_ENDPOINT / S3_REGION / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY
 */

const path = require('path');
const fs = require('fs');

// 解析命令行参数
const args = process.argv.slice(2);
const opts = { dryRun: false, resume: false, concurrency: 3, help: false };
for (const a of args) {
  if (a === '--help' || a === '-h') opts.help = true;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--resume') opts.resume = true;
  else if (a.startsWith('--concurrency=')) opts.concurrency = Number(a.split('=')[1]) || 3;
}

if (opts.help) {
  console.log(`
瞳瞳音乐 - 本地→对象存储迁移脚本

用法:
  node scripts/migrate_to_s3.js [选项]

选项:
  --dry-run          试运行：只显示将要迁移的文件，不实际上传
  --resume           断点续传：跳过已迁移的歌曲（storage_mode=s3）
  --concurrency=N    并发上传数（默认 3）
  --help, -h         显示帮助

环境要求:
  backend/.env 中 STORAGE_MODE=s3 且 S3_* 参数已配置
`);
  process.exit(0);
}

// 加载配置与依赖
const config = require('../config');
const { db } = require('../db');
const storage = require('../storage');

if (config.STORAGE_MODE !== 's3') {
  console.error('错误: STORAGE_MODE 不是 s3，请在 backend/.env 中设置 STORAGE_MODE=s3');
  process.exit(1);
}

const STATE_FILE = path.join(config.DATA_DIR, '.migrate_state.json');

function loadState() {
  if (!opts.resume) return new Set();
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    return new Set(JSON.parse(raw).done || []);
  } catch { return new Set(); }
}

function saveState(done) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ done: [...done] }, null, 2));
}

async function migrateFile(songId, phase, localPath, s3Key) {
  if (!localPath || !fs.existsSync(localPath)) return false;
  const buf = fs.readFileSync(localPath);
  await storage.s3Engine.put(s3Key, buf);
  return true;
}

async function migrateSong(song) {
  const results = { audio: false, cover: false, lrc: false };
  const keys = {};

  // 音频
  if (song.audio_path) {
    const full = path.isAbsolute(song.audio_path) ? song.audio_path : path.join(config.UPLOADS_DIR, song.audio_path);
    const key = `${config.S3_KEY_PREFIX_AUDIO}song_${song.id}_${Date.now()}.mp3`;
    if (await migrateFile(song.id, 'audio', full, key)) {
      results.audio = true;
      keys.audio = key;
      if (fs.existsSync(full)) fs.unlinkSync(full);
    }
  }

  // 封面
  if (song.cover) {
    const full = path.isAbsolute(song.cover) ? song.cover : path.join(config.UPLOADS_DIR, song.cover);
    const key = `${config.S3_KEY_PREFIX_COVER}song_${song.id}_${Date.now()}.png`;
    if (await migrateFile(song.id, 'cover', full, key)) {
      results.cover = true;
      keys.cover = key;
      if (fs.existsSync(full)) fs.unlinkSync(full);
    }
  }

  // 歌词
  const lrcPath = path.join(config.UPLOADS_LRC_DIR, `${song.id}.lrc`);
  if (fs.existsSync(lrcPath)) {
    const key = `${config.S3_KEY_PREFIX_LRC}song_${song.id}.lrc`;
    if (await migrateFile(song.id, 'lrc', lrcPath, key)) {
      results.lrc = true;
      keys.lrc = key;
      fs.unlinkSync(lrcPath);
    }
  }

  // 回写数据库
  db.prepare(`UPDATE songs SET
    audio_object_key = COALESCE(?, audio_object_key),
    cover_object_key = COALESCE(?, cover_object_key),
    lrc_object_key = COALESCE(?, lrc_object_key),
    audio_path = CASE WHEN ? IS NOT NULL THEN '' ELSE audio_path END,
    cover = CASE WHEN ? IS NOT NULL THEN '' ELSE cover END,
    lrc_exists = CASE WHEN ? IS NOT NULL THEN 1 ELSE lrc_exists END,
    storage_mode = 's3'
    WHERE id = ?`).run(
    keys.audio || null, keys.cover || null, keys.lrc || null,
    keys.audio || null, keys.cover || null, keys.lrc || null,
    song.id
  );

  return results;
}

async function run() {
  console.log('=== 瞳瞳音乐 本地→对象存储迁移 ===');
  console.log(`S3 Endpoint: ${config.S3_ENDPOINT}`);
  console.log(`Bucket: ${config.S3_BUCKET}`);
  console.log(`Dry-run: ${opts.dryRun}`);
  console.log(`Resume: ${opts.resume}`);
  console.log(`Concurrency: ${opts.concurrency}\n`);

  const done = loadState();
  const allSongs = db.prepare('SELECT * FROM songs').all();
  const pending = opts.resume
    ? allSongs.filter((s) => s.storage_mode !== 's3' && !done.has(s.id))
    : allSongs.filter((s) => s.storage_mode !== 's3');

  console.log(`总歌曲数: ${allSongs.length}`);
  console.log(`待迁移: ${pending.length}\n`);

  if (pending.length === 0) {
    console.log('没有需要迁移的歌曲');
    return;
  }

  if (opts.dryRun) {
    console.log('=== 试运行模式 ===');
    for (const s of pending) {
      const parts = [];
      if (s.audio_path) parts.push('audio');
      if (s.cover) parts.push('cover');
      const lrc = path.join(config.UPLOADS_LRC_DIR, `${s.id}.lrc`);
      if (fs.existsSync(lrc)) parts.push('lrc');
      console.log(`  #${s.id} ${s.title} - ${s.singer || '未知'} [${parts.join(', ')}]`);
    }
    return;
  }

  let ok = 0, fail = 0;
  const errors = [];

  // 串行 + 限速（S3 通常有并发上限）
  for (const song of pending) {
    try {
      const r = await migrateSong(song);
      done.add(song.id);
      ok++;
      console.log(`  ✓ #${song.id} ${song.title}`);
      if (ok % 10 === 0) saveState(done);
    } catch (e) {
      fail++;
      errors.push({ id: song.id, title: song.title, err: e.message });
      console.error(`  ✗ #${song.id} ${song.title}: ${e.message}`);
    }
  }

  saveState(done);
  console.log(`\n=== 迁移完成 ===\n成功: ${ok}  失败: ${fail}  总计: ${pending.length}`);
  if (fail > 0) {
    console.log('\n失败列表:');
    for (const e of errors) console.log(`  #${e.id} ${e.title}: ${e.err}`);
    console.log('\n可重新运行（带 --resume）来续传');
  }
}

run().catch((e) => { console.error('迁移异常:', e); process.exit(1); });
