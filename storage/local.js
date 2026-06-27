/**
 * 本地磁盘存储引擎
 *   put(file, { contentType }) -> { key }
 *   getReadStream(key)         -> Readable
 *   getBuffer(key)              -> Buffer
 *   exists(key)                 -> boolean
 *   delete(key)                 -> void
 *   url(key, { mode? })         -> string
 */
const path = require('path');
const fs = require('fs');
const { UPLOADS_DIR, STATIC_PREFIX } = require('../config');

function fullPath(key) {
  const p = path.resolve(path.join(UPLOADS_DIR, key));
  if (!p.startsWith(path.resolve(UPLOADS_DIR))) {
    throw new Error('invalid key');
  }
  return p;
}

async function putFromPath(key, srcPath) {
  const dest = fullPath(key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(srcPath, dest);
  const stat = fs.statSync(dest);
  return { key, size: stat.size };
}

async function putFromBuffer(key, buffer) {
  const dest = fullPath(key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  return { key, size: buffer.length };
}

class LocalStorageEngine {
  constructor() {
    this.name = 'local';
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  /**
   * @param {string} key 相对路径，例如 "audio/1782322781525_xxx.mp3"
   * @param {string|Buffer} source 文件路径或 Buffer
   */
  async put(key, source) {
    if (typeof source === 'string') return putFromPath(key, source);
    if (Buffer.isBuffer(source)) return putFromBuffer(key, source);
    // Readable stream
    const dest = fullPath(key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    return new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(dest);
      source.pipe(ws);
      ws.on('finish', () => {
        const stat = fs.statSync(dest);
        resolve({ key, size: stat.size });
      });
      ws.on('error', reject);
    });
  }
  getReadStream(key, opts = {}) {
    return fs.createReadStream(fullPath(key), opts);
  }
  getBuffer(key) {
    return fs.readFileSync(fullPath(key));
  }
  exists(key) {
    try { return fs.existsSync(fullPath(key)); } catch { return false; }
  }
  stat(key) {
    try { return fs.statSync(fullPath(key)); } catch { return null; }
  }
  delete(key) {
    try {
      const p = fullPath(key);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {}
  }
  url(key, { mode } = {}) {
    return `${STATIC_PREFIX}/${key.split(path.sep).join('/')}`;
  }
}

module.exports = LocalStorageEngine;
