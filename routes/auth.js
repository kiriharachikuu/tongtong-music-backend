/**
 * 登录/注册接口
 *   POST  /api/auth/login     { username, password }
 *   POST  /api/auth/register  { username, password, nickname }
 *   GET   /api/auth/me       (需要登录)
 *   PATCH /api/auth/me       { nickname, avatar }
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { JWT_SECRET, JWT_EXPIRES_DAYS } = require('../config');
const { auth } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { RATE_LIMIT_LOGIN } = require('../config');
const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, is_admin: !!user.is_admin, nickname: user.nickname || user.username },
    JWT_SECRET,
    { expiresIn: `${JWT_EXPIRES_DAYS}d` }
  );
}

router.post('/login', rateLimit(RATE_LIMIT_LOGIN), (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.fail('用户名或密码不能为空');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).fail('用户不存在');
  if (!bcrypt.compareSync(password, user.password)) return res.status(401).fail('密码错误');
  const token = signToken(user);
  res.ok({ token, user: publicUser(user) });
});

router.post('/register', rateLimit(RATE_LIMIT_LOGIN), (req, res) => {
  const { username, password, nickname } = req.body || {};
  if (!username || !password) return res.fail('用户名或密码不能为空');
  if (username.length < 2) return res.fail('用户名至少 2 位');
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(400).fail('用户名已存在');
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (username, password, nickname) VALUES (?, ?, ?)').run(username, hash, nickname || username);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const token = signToken(user);
  res.ok({ token, user: publicUser(user) });
});

router.get('/me', auth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).fail('用户不存在');
  res.ok(publicUser(user));
});

// 修改个人资料（目前仅支持昵称与头像）
router.patch('/me', auth, (req, res) => {
  const { nickname, avatar } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).fail('用户不存在');
  const updates = [];
  const params = [];
  if (nickname != null && String(nickname).trim()) { updates.push('nickname = ?'); params.push(String(nickname).trim()); }
  if (avatar != null) { updates.push('avatar = ?'); params.push(String(avatar)); }
  if (updates.length === 0) return res.fail('没有可更新的字段');
  params.push(user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`).run(...params);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.ok(publicUser(updated));
});

function publicUser(u) {
  return { id: u.id, username: u.username, nickname: u.nickname, avatar: u.avatar, themeColor: u.theme_color, is_admin: !!u.is_admin };
}

module.exports = router;
