/**
 * 操作日志写入工具
 *   logAction(req, { action, target, detail })
 */
const { db } = require('../db');

function logAction(req, { action, target = '', detail = '' }) {
  try {
    const user = req.user || {};
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().slice(0, 64);
    db.prepare(
      'INSERT INTO op_logs (user_id, username, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      user.id || null,
      user.username || '',
      String(action).slice(0, 64),
      String(target).slice(0, 255),
      String(detail).slice(0, 1024),
      ip
    );
  } catch (e) {}
}

module.exports = logAction;
