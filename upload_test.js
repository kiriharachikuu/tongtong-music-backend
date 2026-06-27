const fs = require('fs');
const path = require('path');

// ===== 配置 =====
const API_BASE = 'http://localhost:3000';
const AUDIO_DIR = path.join(__dirname, 'uploads', 'audio');

const SONGS = [
  { title: '搬家前，短暂夜', singer: 'ChiliChill乐团', album: '原创单曲', genre: '流行', file: path.join(AUDIO_DIR, 'ChiliChill乐团 - 搬家前，短暂夜.flac') },
  { title: 'See You', singer: '志国 一路', album: 'Cover', genre: '流行', file: path.join(AUDIO_DIR, '志国 一路 - See You (Cover).flac') }
];

async function jsonReq(urlPath, method, body, extraHeaders) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
  const res = await fetch(API_BASE + urlPath, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok || data.code !== 0) {
    throw new Error(`HTTP ${res.status}: ${data.message || JSON.stringify(data)}`);
  }
  return data.data;
}

async function uploadForm(urlPath, fieldName, filePath, extraHeaders) {
  // 直接读取文件，手工构造 multipart/form-data
  const fileBytes = fs.readFileSync(filePath);
  const boundary = '----tongtongBoundary' + Date.now().toString(16);
  const headerText = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="audio.flac"\r\nContent-Type: audio/flac\r\n\r\n`;
  const footerText = `\r\n--${boundary}--\r\n`;
  const headerBuf = Buffer.from(headerText, 'utf-8');
  const footerBuf = Buffer.from(footerText, 'utf-8');
  const body = Buffer.concat([headerBuf, fileBytes, footerBuf]);

  const res = await fetch(API_BASE + urlPath, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }, extraHeaders || {}),
    body
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.message || JSON.stringify(data)}`);
  return data;
}

(async () => {
  try {
    console.log('>>> 1. 登录 admin');
    const loginData = await jsonReq('/api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
    const token = loginData.token;
    const authHeader = { Authorization: 'Bearer ' + token };
    console.log('  token OK, length=' + token.length);

    console.log('\n>>> 2. 创建歌曲记录');
    const ids = [];
    for (const s of SONGS) {
      const r = await jsonReq('/api/admin/songs', 'POST', { title: s.title, singer: s.singer, album: s.album, genre: s.genre }, authHeader);
      ids.push(r.id);
      console.log('  [' + r.id + '] ' + s.title);
    }

    console.log('\n>>> 3. 上传音频文件');
    for (let i = 0; i < SONGS.length; i++) {
      const s = SONGS[i];
      const id = ids[i];
      if (!fs.existsSync(s.file)) { console.log('  [跳过] ' + s.file + ' 不存在'); continue; }
      try {
        const r = await uploadForm('/api/admin/songs/' + id + '/audio', 'audio', s.file, authHeader);
        console.log('  [' + id + '] ' + s.title + ' OK -> ' + JSON.stringify(r.data));
      } catch (e) {
        console.log('  [' + id + '] ' + s.title + ' 上传提示: ' + e.message);
      }
    }

    console.log('\n>>> 4. 验证歌曲列表');
    const list = await jsonReq('/api/songs?pageSize=20', 'GET');
    console.log('共 ' + list.total + ' 首:');
    for (const song of list.list) {
      console.log('  - [' + song.id + '] ' + song.title + ' / ' + song.singer + ' / duration=' + song.duration + 's / audio_path?=' + (!!song.audio_path));
    }

    console.log('\n完成 ✅');
  } catch (e) {
    console.error('失败:', e.message);
    process.exit(1);
  }
})();
