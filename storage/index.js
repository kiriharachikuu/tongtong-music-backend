/**
 * 存储工厂：根据 STORAGE_MODE 返回当前引擎
 *   storage.put(key, source)
 *   storage.getReadStream(key, { range? })
 *   storage.getBuffer(key)
 *   storage.exists(key)
 *   storage.stat(key)
 *   storage.delete(key)
 *   storage.url(key, opts?)
 *   storage.localEngine / s3Engine （原始引擎，供迁移脚本直接使用）
 *   storage.storageMode = 'local' | 's3'
 *
 * 注意：S3 相关模块采用惰性加载。当 STORAGE_MODE != 's3' 时，
 * 不会 require '@aws-sdk/*'，避免本地开发者未安装 S3 SDK 时启动失败。
 */
const LocalStorageEngine = require('./local');
const config = require('../config');

const localEngine = new LocalStorageEngine();

// 懒加载 S3 引擎：首次访问时才 require
let _s3Engine = null;
function getS3Engine() {
  if (_s3Engine) return _s3Engine;
  try {
    const S3StorageEngine = require('./s3');
    _s3Engine = new S3StorageEngine();
  } catch (e) {
    // S3 SDK 不可用时返回一个空实现，避免启动失败
    console.warn('[storage] S3 模块加载失败（可能是 @aws-sdk/client-s3 未安装），将降级为 local 模式。错误：', e.message);
    _s3Engine = localEngine;
  }
  return _s3Engine;
}

function currentEngine() {
  return config.STORAGE_MODE === 's3' ? getS3Engine() : localEngine;
}

// 统一代理对象（同时支持同步/异步接口）
const storage = new Proxy({
  localEngine,
  get s3Engine() { return getS3Engine(); },
  get storageMode() { return config.STORAGE_MODE; },
}, {
  get(target, prop) {
    if (prop in target) {
      const v = target[prop];
      // 访问器需要再次调用 getter；普通属性直接返回
      return typeof v === 'function' ? v.call(target) : v;
    }
    const eng = currentEngine();
    const fn = eng[prop];
    if (typeof fn === 'function') return fn.bind(eng);
    return undefined;
  },
});

module.exports = storage;
