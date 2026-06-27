/**
 * 统一响应
 *   res.ok(data, message)       -> { code: 0, message: 'ok', data }
 *   res.fail(message, code)      -> { code, message, data: null }
 *   res.page(list, total)        -> { code: 0, message: 'ok', data: { list, total } }
 */
module.exports = function apiResponse(req, res, next) {
  res.ok = function (data = null, message = 'ok') {
    return res.json({ code: 0, message, data });
  };
  res.fail = function (message = 'fail', code = 1) {
    return res.json({ code, message, data: null });
  };
  res.page = function (list = [], total = 0, extra = {}) {
    return res.json({ code: 0, message: 'ok', data: { list, total, ...extra } });
  };
  next();
};
