/**
 * App 版本管理 API（基于 app_versions 表）
 *
 * 接口规格（共 5 个）：
 *   1. GET    /latest    公开（不需要 auth），返回 is_active=1 的最新版本（按 id DESC 取第一条）；
 *                       无数据时返回 res.ok(null)。
 *   2. GET    /          adminOnly，返回所有版本，按 id DESC 排序；
 *                       字段：id, version_code, version_name, download_url, changelog, is_active, created_at。
 *   3. POST   /          adminOnly，创建版本。
 *                       请求体：{ version_code, version_name, download_url, changelog, is_active }
 *                       校验：version_code 必须能转成正整数；version_name 非空字符串。
 *                       若 is_active===1（或 true），先把所有现有版本 is_active 置 0（用事务）；
 *                       请求体未指定 is_active 时，默认置 1（并同时把其他置 0）。
 *                       写 op_logs：action='发布版本', target='version#'+id,
 *                                   detail=JSON.stringify({version_code, version_name})。
 *                       返回 { id }。
 *   4. PUT    /:id       adminOnly，更新指定版本。
 *                       接受：version_code, version_name, download_url, changelog, is_active。
 *                       若 is_active 被设为 1，把其他版本 is_active 置 0（事务）。
 *                       写 op_logs：action='更新版本'。
 *                       返回 { id }。
 *   5. DELETE /:id       adminOnly，删除指定版本。
 *                       写 op_logs：action='删除版本'。
 *                       返回 { removed: id }。
 */
const express = require('express');
const { db } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const logAction = require('../utils/opLog');
const router = express.Router();

// 公共预处理语句：把所有版本的 is_active 置 0（用于切换启用版本时互斥）
const clearAllActive = db.prepare('UPDATE app_versions SET is_active = 0');

/**
 * 归一化 is_active 标志
 *   - undefined / null        -> null  （表示未指定，调用方自行决定语义）
 *   - true / 1 / '1' / 'true' -> 1
 *   - 其他                    -> 0
 */
function normalizeActive(v) {
  if (v === undefined || v === null) return null;
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  return 0;
}

// ============ 公开接口 ============

/**
 * 1. GET /latest
 *    返回 is_active=1 的最新版本（按 id DESC 取第一条），无数据返回 null。
 *    注意：必须在 GET / 之前注册，避免被 / 拦截；且不挂 auth 中间件。
 */
router.get('/latest', (req, res) => {
  const row = db
    .prepare(
      `SELECT id, version_code, version_name, download_url, changelog, is_active, created_at
       FROM app_versions
       WHERE is_active = 1
       ORDER BY id DESC
       LIMIT 1`
    )
    .get();
  res.ok(row || null);
});

// ============ 管理员接口 ============
// 在路由级别应用鉴权：此后注册的所有路由均需登录且为管理员
router.use(auth, adminOnly);

/**
 * 2. GET /
 *    返回所有版本，按 id DESC 排序。
 */
router.get('/', (req, res) => {
  const list = db
    .prepare(
      `SELECT id, version_code, version_name, download_url, changelog, is_active, created_at
       FROM app_versions
       ORDER BY id DESC`
    )
    .all();
  res.ok(list);
});

/**
 * 3. POST /
 *    创建版本。
 */
router.post('/', (req, res) => {
  const { version_code, version_name, download_url, changelog, is_active } = req.body || {};

  // 校验 version_code：必须能转成正整数
  const code = Number(version_code);
  if (!Number.isInteger(code) || code <= 0) {
    return res.fail('version_code 必须为正整数');
  }
  // 校验 version_name：非空字符串
  if (typeof version_name !== 'string' || !version_name.trim()) {
    return res.fail('version_name 不能为空');
  }
  const name = version_name.trim();

  // is_active 语义：
  //   - 显式为 1/true -> 置 1，并清空其他
  //   - 显式为 0/false -> 置 0，不动其他
  //   - 未指定 -> 默认置 1，并清空其他
  const activeFlag = normalizeActive(is_active);
  const finalActive = activeFlag === null ? 1 : activeFlag;

  const insert = db.prepare(
    `INSERT INTO app_versions (version_code, version_name, download_url, changelog, is_active)
     VALUES (?, ?, ?, ?, ?)`
  );

  const createVersion = db.transaction(() => {
    if (finalActive === 1) {
      clearAllActive.run();
    }
    return insert.run(code, name, download_url || '', changelog || '', finalActive);
  });

  const info = createVersion();
  const newId = info.lastInsertRowid;

  logAction(req, {
    action: '发布版本',
    target: 'version#' + newId,
    detail: JSON.stringify({ version_code: code, version_name: name }),
  });

  res.ok({ id: newId });
});

/**
 * 4. PUT /:id
 *    更新指定版本（仅更新请求体中提供的字段；is_active 未提供时保持原值）。
 */
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.fail('无效的版本 id');
  }

  const ver = db.prepare('SELECT * FROM app_versions WHERE id = ?').get(id);
  if (!ver) {
    return res.status(404).fail('版本不存在');
  }

  const { version_code, version_name, download_url, changelog, is_active } = req.body || {};

  // 校验 version_code（仅在提供时校验）
  let code = ver.version_code;
  if (version_code !== undefined && version_code !== null) {
    code = Number(version_code);
    if (!Number.isInteger(code) || code <= 0) {
      return res.fail('version_code 必须为正整数');
    }
  }
  // 校验 version_name（仅在提供时校验）
  let name = ver.version_name;
  if (version_name !== undefined && version_name !== null) {
    if (typeof version_name !== 'string' || !version_name.trim()) {
      return res.fail('version_name 不能为空');
    }
    name = version_name.trim();
  }
  const url = download_url !== undefined && download_url !== null ? download_url : ver.download_url;
  const log = changelog !== undefined && changelog !== null ? changelog : ver.changelog;

  // is_active 语义：
  //   - 显式为 1/true -> 置 1，并清空其他（事务）
  //   - 显式为 0/false -> 置 0，不动其他
  //   - 未指定 -> 保持原值
  const activeFlag = normalizeActive(is_active);
  const finalActive = activeFlag === null ? ver.is_active : activeFlag;

  const update = db.prepare(
    `UPDATE app_versions
     SET version_code = ?, version_name = ?, download_url = ?, changelog = ?, is_active = ?
     WHERE id = ?`
  );

  const updateVersion = db.transaction(() => {
    if (activeFlag === 1) {
      clearAllActive.run();
    }
    update.run(code, name, url, log, finalActive, id);
  });

  updateVersion();

  logAction(req, {
    action: '更新版本',
    target: 'version#' + id,
    detail: JSON.stringify({ version_code: code, version_name: name }),
  });

  res.ok({ id });
});

/**
 * 5. DELETE /:id
 *    删除指定版本。
 */
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.fail('无效的版本 id');
  }

  const ver = db.prepare('SELECT version_name FROM app_versions WHERE id = ?').get(id);
  if (!ver) {
    return res.status(404).fail('版本不存在');
  }

  db.prepare('DELETE FROM app_versions WHERE id = ?').run(id);

  logAction(req, {
    action: '删除版本',
    target: 'version#' + id,
    detail: ver.version_name ? JSON.stringify({ version_name: ver.version_name }) : '',
  });

  res.ok({ removed: id });
});

module.exports = router;
