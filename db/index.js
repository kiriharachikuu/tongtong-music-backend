/**
 * 瞳瞳音乐数据库初始化
 * - 使用 better-sqlite3
 * - 数据表：users / songs / playlists / playlist_items / favorites / banners
 *          play_history / daily_recommend / player_queue
 *          op_logs / storage_config / storage_migration_state
 * - 首次启动自动创建管理员 admin / admin123
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { DB_PATH, DATA_DIR, ADMIN_USERNAME, ADMIN_PASSWORD } = require('../config');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * 幂等添加列：如果列已存在则不做任何事
 */
function addColumnIfAbsent(table, column, definition) {
  const rows = db.pragma(`table_info(${table})`);
  if (rows.some((r) => r.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * 幂等创建表
 */
function createTableIfAbsent(name, definition) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${name} (${definition})`);
}

// 基础表
createTableIfAbsent(
  'users',
  `id INTEGER PRIMARY KEY AUTOINCREMENT,
   username TEXT UNIQUE NOT NULL,
   password TEXT NOT NULL,
   nickname TEXT,
   avatar TEXT,
   theme_color TEXT DEFAULT '#8B00FF',
   is_admin INTEGER DEFAULT 0,
   created_at TEXT DEFAULT (datetime('now','localtime')),
   updated_at TEXT DEFAULT (datetime('now','localtime'))`
);

createTableIfAbsent(
  'songs',
  `id INTEGER PRIMARY KEY AUTOINCREMENT,
   title TEXT NOT NULL,
   singer TEXT,
   album TEXT,
   genre TEXT,
   cover TEXT,
   audio_path TEXT,
   duration INTEGER DEFAULT 0,
   lrc_exists INTEGER DEFAULT 0,
   created_at TEXT DEFAULT (datetime('now','localtime'))`
);
// 对象存储相关列
addColumnIfAbsent('songs', 'audio_object_key', 'TEXT');
addColumnIfAbsent('songs', 'cover_object_key', 'TEXT');
addColumnIfAbsent('songs', 'lrc_object_key', 'TEXT');
addColumnIfAbsent('songs', 'storage_mode', `TEXT DEFAULT 'local'`);
// 音频元数据列（ffprobe 解析后写入）
addColumnIfAbsent('songs', 'year', 'INTEGER DEFAULT 0');
addColumnIfAbsent('songs', 'bitrate', 'INTEGER DEFAULT 0');
addColumnIfAbsent('songs', 'sample_rate', 'INTEGER DEFAULT 0');
// 专辑外键：关联 albums 表，同一专辑歌曲共用封面
addColumnIfAbsent('songs', 'album_id', 'INTEGER');
// 统计与扩展信息列（幂等新增）
addColumnIfAbsent('songs', 'play_count', 'INTEGER DEFAULT 0');       // 播放次数
addColumnIfAbsent('songs', 'favorite_count', 'INTEGER DEFAULT 0');   // 收藏次数
addColumnIfAbsent('songs', 'original_singer', 'TEXT');               // 原唱歌手
addColumnIfAbsent('songs', 'remark', 'TEXT');                        // 备注

// 专辑表
createTableIfAbsent(
  'albums',
  `id INTEGER PRIMARY KEY AUTOINCREMENT,
   name TEXT NOT NULL,
   singer TEXT,
   cover TEXT,
   cover_object_key TEXT,
   storage_mode TEXT DEFAULT 'local',
   description TEXT,
   created_at TEXT DEFAULT (datetime('now','localtime'))`
);

try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_songs_title ON songs(title)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_songs_singer ON songs(singer)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_songs_album ON songs(album)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_songs_album_id ON songs(album_id)`);
} catch (e) {}

createTableIfAbsent(
  'playlists',
  `id INTEGER PRIMARY KEY AUTOINCREMENT,
   name TEXT NOT NULL,
   description TEXT,
   cover TEXT,
   owner_id INTEGER,
   is_system INTEGER DEFAULT 0,
   created_at TEXT DEFAULT (datetime('now','localtime'))`
);

createTableIfAbsent(
  'playlist_items',
  `id INTEGER PRIMARY KEY AUTOINCREMENT,
   playlist_id INTEGER NOT NULL,
   song_id INTEGER NOT NULL,
   position INTEGER DEFAULT 0,
   added_at TEXT DEFAULT (datetime('now','localtime')),
   UNIQUE(playlist_id, song_id)`
);

createTableIfAbsent(
  'favorites',
  `id INTEGER PRIMARY KEY AUTOINCREMENT,
   user_id INTEGER NOT NULL,
   song_id INTEGER NOT NULL,
   created_at TEXT DEFAULT (datetime('now','localtime')),
   UNIQUE(user_id, song_id)`
);

createTableIfAbsent(
  'banners',
  `id INTEGER PRIMARY KEY AUTOINCREMENT,
   title TEXT,
   image TEXT,
   link TEXT,
   "order" INTEGER DEFAULT 0,
   created_at TEXT DEFAULT (datetime('now','localtime'))`
);
addColumnIfAbsent('banners', 'image_object_key', 'TEXT');
addColumnIfAbsent('banners', 'storage_mode', `TEXT DEFAULT 'local'`);
// Banner 关联歌曲或外链广告（幂等新增）
addColumnIfAbsent('banners', 'song_id', 'INTEGER');  // 关联歌曲 ID，点击跳转歌曲详情
addColumnIfAbsent('banners', 'ad_url', 'TEXT');      // 广告外链地址

createTableIfAbsent(
  'play_history',
  `id INTEGER PRIMARY KEY AUTOINCREMENT,
   user_id INTEGER NOT NULL,
   song_id INTEGER NOT NULL,
   played_at TEXT DEFAULT (datetime('now','localtime'))`
);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_history_user ON play_history(user_id, played_at DESC)`); } catch (e) {}

createTableIfAbsent(
  'daily_recommend',
  `id INTEGER PRIMARY KEY AUTOINCREMENT,
   user_id INTEGER,
   date TEXT NOT NULL,
   song_ids TEXT NOT NULL,
   created_at TEXT DEFAULT (datetime('now','localtime')),
   UNIQUE(user_id, date)`
);

createTableIfAbsent(
  'player_queue',
  `user_id INTEGER PRIMARY KEY,
   song_ids TEXT NOT NULL,
   current_index INTEGER DEFAULT 0,
   updated_at TEXT DEFAULT (datetime('now','localtime'))`
);

// 新增：操作日志
createTableIfAbsent(
  'op_logs',
  `id INTEGER PRIMARY KEY AUTOINCREMENT,
   user_id INTEGER,
   username TEXT,
   action TEXT NOT NULL,
   target TEXT,
   detail TEXT,
   ip TEXT,
   created_at TEXT DEFAULT (datetime('now','localtime'))`
);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_op_logs_time ON op_logs(created_at DESC)`); } catch (e) {}

// 新增：存储配置（允许管理后台在不重启服务的情况下覆盖部分默认值）
createTableIfAbsent(
  'storage_config',
  `id INTEGER PRIMARY KEY AUTOINCREMENT,
   key TEXT UNIQUE NOT NULL,
   value TEXT,
   updated_at TEXT DEFAULT (datetime('now','localtime'))`
);

// 新增：对象存储迁移状态（断点续传）
createTableIfAbsent(
  'storage_migration_state',
  `id INTEGER PRIMARY KEY AUTOINCREMENT,
   run_id TEXT NOT NULL,
   song_id INTEGER NOT NULL,
   phase TEXT NOT NULL,            -- audio / cover / lrc / done / error
   status TEXT NOT NULL,           -- pending / running / done / error
   message TEXT,
   old_path TEXT,
   new_object_key TEXT,
   updated_at TEXT DEFAULT (datetime('now','localtime'))`
);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_migration_song ON storage_migration_state(song_id)`); } catch (e) {}

// 新增：App 版本管理表（用于客户端升级检测）
createTableIfAbsent(
  'app_versions',
  `id INTEGER PRIMARY KEY AUTOINCREMENT,
   version_code INTEGER NOT NULL,                                  -- 版本号(整数,用于比较大小)
   version_name TEXT NOT NULL,                                     -- 版本名(如 1.0.0)
   download_url TEXT,                                              -- 下载地址
   changelog TEXT,                                                 -- 更新日志
   is_active INTEGER DEFAULT 0,                                    -- 是否启用(1=启用)
   created_at TEXT DEFAULT (datetime('now','localtime'))`
);

// 新增索引（与现有 idx_songs_title 风格一致,使用 try/catch 包裹避免异常阻断启动）
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_songs_play_count ON songs(play_count DESC)`);         // 播放次数倒序索引
  db.exec(`CREATE INDEX IF NOT EXISTS idx_songs_favorite_count ON songs(favorite_count DESC)`); // 收藏次数倒序索引
  db.exec(`CREATE INDEX IF NOT EXISTS idx_banners_song_id ON banners(song_id)`);                // Banner 关联歌曲索引
} catch (e) {}

// 初始化默认数据（幂等）
function initDefaults() {
  const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USERNAME);
  if (!existingAdmin) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    db.prepare('INSERT INTO users (username, password, nickname, is_admin) VALUES (?, ?, ?, 1)').run(ADMIN_USERNAME, hash, '超级管理员');
  }
  const bannerCount = db.prepare('SELECT COUNT(*) AS c FROM banners').get().c;
  if (bannerCount === 0) {
    const insert = db.prepare('INSERT INTO banners (title, "order") VALUES (?, ?)');
    insert.run('欢迎使用瞳瞳音乐', 1);
    insert.run('高品质 128kbps MP3 全量转码', 2);
    insert.run('Apple Music 风格 UI', 3);
  }
  const playlistCount = db.prepare('SELECT COUNT(*) AS c FROM playlists WHERE is_system = 1').get().c;
  if (playlistCount === 0) {
    const insert = db.prepare('INSERT INTO playlists (name, description, is_system, owner_id) VALUES (?, ?, 1, NULL)');
    insert.run('每日推荐', '系统精选');
    insert.run('新歌速递', '最新入库');
  }
  // 初始化默认 App 版本记录（幂等：仅当 app_versions 表为空时插入）
  const versionCount = db.prepare('SELECT COUNT(*) AS c FROM app_versions').get().c;
  if (versionCount === 0) {
    db.prepare(
      `INSERT INTO app_versions (version_code, version_name, download_url, changelog, is_active)
       VALUES (?, ?, ?, ?, ?)`
    ).run(1, '1.0.0', '', '初始版本', 1);
  }
}

initDefaults();

module.exports = { db, initDatabase: () => initDefaults() };
