const fs = require('fs');
const path = require('path');

function paginate(query, page = 1, pageSize = 20) {
  const p = Math.max(1, Number(page) || 1);
  const s = Math.min(200, Math.max(1, Number(pageSize) || 20));
  const list = [];
  let total = 0;
  if (typeof query === 'function') {
    const result = query({ limit: s, offset: (p - 1) * s });
    list.push(...(result.list || []));
    total = Number(result.total || 0);
  } else {
    const rows = query.all();
    total = rows.length;
    for (let i = (p - 1) * s; i < Math.min(total, p * s); i++) list.push(rows[i]);
  }
  return { list, total, page: p, pageSize: s };
}

function pageLimit(page, pageSize) {
  const p = Math.max(1, Number(page) || 1);
  const s = Math.min(200, Math.max(1, Number(pageSize) || 20));
  return { limit: s, offset: (p - 1) * s };
}

function normalizeSong(song, userId) {
  if (!song) return song;
  const { is_favorited, ...rest } = song;
  const out = { ...rest };
  if (userId !== undefined && is_favorited !== undefined) out.isFavorited = !!is_favorited;
  if (out.cover) out.cover = toStaticUrl(out.cover);
  return out;
}

function toStaticUrl(filePath) {
  if (!filePath) return '';
  if (/^https?:\/\//.test(filePath)) return filePath;
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/uploads/') || normalized.startsWith('uploads/')) {
    return '/api' + (normalized.startsWith('/') ? '' : '/') + normalized.replace(/^\/?/, '');
  }
  if (normalized.startsWith('/static/covers/') || normalized.startsWith('static/covers/')) {
    return '/api' + (normalized.startsWith('/') ? '' : '/') + normalized.replace(/^\/?/, '');
  }
  return '/api/uploads/' + normalized.replace(/^\/?uploads\//, '');
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
}

function parseSongIds(songIds) {
  if (!songIds) return [];
  const ids = Array.isArray(songIds) ? songIds : String(songIds).split(',').map(s => s.trim()).filter(Boolean);
  return ids.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0);
}

module.exports = { paginate, pageLimit, normalizeSong, toStaticUrl, safeUnlink, parseSongIds };
