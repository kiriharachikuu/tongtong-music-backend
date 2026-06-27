/**
 * 简易内存速率限制（单进程）
 *   rateLimit(max, windowMs=60000, keyFactory?) -> (req, res, next)
 *   keyFactory 默认使用 req.ip；也可根据路由传参区分
 */
function rateLimit(max, windowMs = 60 * 1000, keyFactory) {
  const buckets = new Map(); // key -> { start, count }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) if (now - v.start > windowMs) buckets.delete(k);
  }, Math.max(windowMs, 60 * 1000)).unref?.();
  return (req, res, next) => {
    const key = keyFactory ? keyFactory(req) : req.ip;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.start > windowMs) { b = { start: now, count: 0 }; buckets.set(key, b); }
    b.count += 1;
    if (b.count > max) return res.status(429).json({ code: 429, message: '请求过于频繁，请稍后再试', data: null });
    next();
  };
}

module.exports = rateLimit;
