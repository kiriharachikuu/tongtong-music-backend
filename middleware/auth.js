/**
 * 鉴权中间件家族：
 *   auth()         - 强制登录；读取 Authorization: Bearer <token> 或 ?token=xxx（iOS Safari 用）
 *   optionalAuth() - 可选登录，未登录时不阻断，req.user 可能为 null
 *   adminOnly()    - 必须管理员
 */
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');

function readToken(req) {
  const bearer = (req.headers.authorization || '').trim();
  if (bearer.startsWith('Bearer ')) return bearer.slice(7).trim();
  if (req.query && req.query.token) return String(req.query.token);
  if (req.body && req.body.token) return String(req.body.token);
  return null;
}

function verify(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

module.exports = {
  auth: function auth(req, res, next) {
    const token = readToken(req);
    if (!token) return res.status(401).json({ code: 401, message: '未登录', data: null });
    const payload = verify(token);
    if (!payload) return res.status(401).json({ code: 401, message: '登录已失效', data: null });
    req.user = payload;
    next();
  },
  optionalAuth: function optionalAuth(req, res, next) {
    const token = readToken(req);
    if (token) {
      const payload = verify(token);
      if (payload) req.user = payload;
    }
    next();
  },
  adminOnly: function adminOnly(req, res, next) {
    if (!req.user) return res.status(401).json({ code: 401, message: '未登录', data: null });
    if (!req.user.is_admin) return res.status(403).json({ code: 403, message: '无权访问', data: null });
    next();
  },
  readToken,
};
