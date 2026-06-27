/**
 * S3 兼容对象存储引擎（支持阿里云 OSS / 腾讯云 COS / MinIO / 原生 AWS S3）
 *   put(key, source)                   -> { key, size, etag }
 *   getReadStream(key, { range? })     -> Readable
 *   getBuffer(key)                     -> Buffer
 *   exists(key)                        -> boolean
 *   delete(key)                        -> void
 *   url(key, { mode, expiresIn })      -> string (presigned URL or proxy URL)
 */
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const config = require('../config');

class S3StorageEngine {
  constructor() {
    this.name = 's3';
    if (!config.S3_ENDPOINT || !config.S3_ACCESS_KEY || !config.S3_SECRET_KEY || !config.S3_BUCKET) {
      this._disabled = true;
      return;
    }
    const clientCfg = {
      region: config.S3_REGION || 'us-east-1',
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
      forcePathStyle: !!config.S3_FORCE_PATH_STYLE,
    };
    if (config.S3_ENDPOINT) {
      const url = new URL(config.S3_ENDPOINT.startsWith('http') ? config.S3_ENDPOINT : `https://${config.S3_ENDPOINT}`);
      clientCfg.endpoint = { protocol: url.protocol, hostname: url.hostname, port: url.port ? Number(url.port) : undefined, path: url.pathname };
    }
    this._client = new S3Client(clientCfg);
    this._bucket = config.S3_BUCKET;
  }
  _assert() {
    if (this._disabled) throw new Error('S3 配置不完整，请在 .env 中配置 S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY');
  }
  async put(key, source) {
    this._assert();
    let Body;
    if (typeof source === 'string') Body = fs.createReadStream(source);
    else Body = source;
    const cmd = new PutObjectCommand({ Bucket: this._bucket, Key: key, Body });
    const r = await this._client.send(cmd);
    return { key, etag: r.ETag };
  }
  async getReadStream(key, { range } = {}) {
    this._assert();
    const cmd = new GetObjectCommand({ Bucket: this._bucket, Key: key, Range: range });
    const r = await this._client.send(cmd);
    return r.Body;
  }
  async getBuffer(key) {
    this._assert();
    const r = await this._client.send(new GetObjectCommand({ Bucket: this._bucket, Key: key }));
    return Buffer.from(await r.Body.transformToByteArray());
  }
  async exists(key) {
    this._assert();
    try {
      await this._client.send(new HeadObjectCommand({ Bucket: this._bucket, Key: key }));
      return true;
    } catch (e) { return false; }
  }
  async stat(key) {
    this._assert();
    try {
      const r = await this._client.send(new HeadObjectCommand({ Bucket: this._bucket, Key: key }));
      return { size: Number(r.ContentLength), etag: r.ETag, lastModified: r.LastModified };
    } catch (e) { return null; }
  }
  async delete(key) {
    this._assert();
    try { await this._client.send(new DeleteObjectCommand({ Bucket: this._bucket, Key: key })); } catch (e) {}
  }
  async url(key, { mode = config.S3_PLAY_MODE, expiresIn = config.S3_PRESIGN_EXPIRES } = {}) {
    this._assert();
    if (mode === 'presigned') {
      const cmd = new GetObjectCommand({ Bucket: this._bucket, Key: key });
      return getSignedUrl(this._client, cmd, { expiresIn });
    }
    // proxy mode：由 GET /api/songs/:id/stream 代理读取，这里返回占位，具体由业务层处理
    return `/api/songs/proxy?k=${encodeURIComponent(key)}`;
  }
  async list(prefix) {
    this._assert();
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const r = await this._client.send(new ListObjectsV2Command({ Bucket: this._bucket, Prefix: prefix }));
    return r.Contents || [];
  }
}

module.exports = S3StorageEngine;
