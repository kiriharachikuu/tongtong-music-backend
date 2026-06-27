const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ========== 生成简单的 JPEG 封面图（无需外部依赖） ==========
// 使用纯 Node.js Buffer 写一个 600x600 的渐变 JPEG / PNG
// 这里用 PNG，更简单且无依赖

function makePng(width, height, colorFn) {
  // PNG Signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8);      // bit depth
  ihdrData.writeUInt8(2, 9);      // color type: 2 = RGB
  ihdrData.writeUInt8(0, 10);     // compression
  ihdrData.writeUInt8(0, 11);     // filter
  ihdrData.writeUInt8(0, 12);     // interlace
  const ihdr = makeChunk('IHDR', ihdrData);

  // IDAT (raw image data)
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorFn(x, y, width, height);
      const off = y * (1 + width * 3) + 1 + x * 3;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b;
    }
  }
  const idat = makeChunk('IDAT', zlib.deflateSync(raw));

  // IEND
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// CRC32 table
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 渐变配色方案：为两首歌定制不同的主题
function gradientFn(rgb1, rgb2) {
  return (x, y, w, h) => {
    // 对角线渐变 + 一点径向光
    const t = (x / w * 0.4 + y / h * 0.6);
    const cx = w / 2, cy = h / 2;
    const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / Math.sqrt(cx * cx + cy * cy);
    const light = Math.max(0, 0.25 - dist * 0.25);

    const r = Math.min(255, Math.round(rgb1[0] * (1 - t) + rgb2[0] * t + light * 255));
    const g = Math.min(255, Math.round(rgb1[1] * (1 - t) + rgb2[1] * t + light * 255));
    const b = Math.min(255, Math.round(rgb1[2] * (1 - t) + rgb2[2] * t + light * 255));
    return [r, g, b];
  };
}

// 搬家前，短暂夜 - 深夜蓝紫色
const cover1 = makePng(600, 600, gradientFn([20, 25, 60], [139, 0, 255]));
// See You - 温暖橙粉色
const cover2 = makePng(600, 600, gradientFn([50, 20, 40], [255, 140, 120]));

const coverDir = path.join(__dirname, 'uploads', 'covers');
const lrcDir = path.join(__dirname, 'uploads', 'lrc');
fs.mkdirSync(coverDir, { recursive: true });
fs.mkdirSync(lrcDir, { recursive: true });

const cover1Path = path.join(coverDir, '2_temp_cover.png');
const cover2Path = path.join(coverDir, '3_temp_cover.png');
fs.writeFileSync(cover1Path, cover1);
fs.writeFileSync(cover2Path, cover2);
console.log('[OK] 封面图生成: ' + cover1Path + ' (' + cover1.length + ' bytes)');
console.log('[OK] 封面图生成: ' + cover2Path + ' (' + cover2.length + ' bytes)');

// ========== 生成 LRC 歌词（带时间戳） ==========
// 简单的测试歌词 - 实际每句歌词的时间戳需要粗略估算

// 歌曲2: 搬家前，短暂夜 - 估算 ~213s
const lrc1 = `[ti:搬家前，短暂夜]
[ar:ChiliChill乐团]
[al:原创单曲]
[by:瞳瞳音乐]
[00:00.00]搬家前，短暂夜
[00:04.00]演唱：ChiliChill乐团
[00:08.00]
[00:12.50]灯光下的纸箱堆成山
[00:18.30]窗外偶尔传来晚归人的脚步
[00:24.00]这间屋子承载了太多
[00:29.80]如今要一一收拾放进包裹
[00:35.50]
[00:40.00]墙上还贴着那年的海报
[00:45.80]抽屉里藏着没寄出的信
[00:51.50]每一件物品都有故事
[00:57.20]关于你、关于我、关于我们
[01:02.00]
[01:05.00]搬家前，这最后一个夜晚
[01:10.80]忽然不知道该对谁说再见
[01:16.50]是对斑驳的墙壁
[01:21.80]还是对曾经住在这里的自己
[01:27.00]
[01:31.00]窗外的月亮静静地挂着
[01:36.80]像是见证所有的悲欢离合
[01:42.50]明天太阳升起的时候
[01:48.00]我就要带上全部家当离去
[01:54.00]
[02:00.00]也许新的地方会更好
[02:05.80]但今夜请允许我有些感伤
[02:11.50]这短暂的沉默是我给这间屋子
[02:18.00]最后的、也是最温柔的告别
[02:23.00]
[02:28.00]—— End ——
`;

// 歌曲3: See You - 估算 ~228s
const lrc2 = `[ti:See You]
[ar:志国 一路]
[al:Cover]
[by:瞳瞳音乐]
[00:00.00]See You
[00:03.50]演唱：志国 一路
[00:07.00]
[00:11.00]那扇熟悉的窗
[00:16.50]映着同样的月光
[00:22.00]时间像流水一样
[00:27.50]带走了多少梦想
[00:33.00]
[00:38.50]你说要去远方
[00:44.00]寻找属于你的光亮
[00:49.50]我微笑着点头
[00:55.00]却没告诉你心里的牵挂
[01:00.00]
[01:04.50]See you, see you again
[01:10.00]愿你一路上都有温柔的风相伴
[01:15.50]See you, see you someday
[01:21.00]不管多久我都愿意等你回来
[01:27.00]
[01:32.00]街灯下的路口
[01:37.50]我们各自要走不同的方向
[01:43.00]你挥挥手的样子
[01:48.50]我会记得很久很久
[01:54.00]
[01:59.50]See you, see you again
[02:05.00]愿你一路上都有温柔的风相伴
[02:10.50]See you, see you someday
[02:16.00]不管多久我都愿意等你回来
[02:22.00]
[02:27.00]—— End ——
`;

const lrc1Path = path.join(lrcDir, '2.lrc');
const lrc2Path = path.join(lrcDir, '3.lrc');
fs.writeFileSync(lrc1Path, lrc1, 'utf-8');
fs.writeFileSync(lrc2Path, lrc2, 'utf-8');
console.log('[OK] LRC 写入: ' + lrc1Path);
console.log('[OK] LRC 写入: ' + lrc2Path);

// ========== multipart/form-data 上传 ==========
const API_BASE = 'http://localhost:3000';

async function login() {
  const res = await fetch(API_BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error('登录失败: ' + data.message);
  return data.data.token;
}

function buildForm(fieldName, filePath, contentType) {
  const fileBytes = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const boundary = '----tongtong' + Date.now().toString(16);
  const headerText = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  const footerText = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(headerText, 'utf-8'), fileBytes, Buffer.from(footerText, 'utf-8')]);
  return { boundary, body };
}

async function uploadCover(songId, filePath, token) {
  const { boundary, body } = buildForm('cover', filePath, 'image/png');
  const res = await fetch(API_BASE + '/api/admin/songs/' + songId + '/cover', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': body.length
    },
    body
  });
  const data = await res.json();
  if (!res.ok) throw new Error('封面上传失败: ' + (data.message || JSON.stringify(data)));
  return data.data;
}

async function uploadLrc(songId, filePath, token) {
  const { boundary, body } = buildForm('lrc', filePath, 'text/plain');
  const res = await fetch(API_BASE + '/api/admin/songs/' + songId + '/lrc', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': body.length
    },
    body
  });
  const data = await res.json();
  if (!res.ok) throw new Error('LRC上传失败: ' + (data.message || JSON.stringify(data)));
  return data.data;
}

(async () => {
  try {
    console.log('\n>>> 登录 admin');
    const token = await login();
    console.log('  OK');

    console.log('\n>>> 上传封面');
    console.log('  歌曲2: ' + JSON.stringify(await uploadCover(2, cover1Path, token)));
    console.log('  歌曲3: ' + JSON.stringify(await uploadCover(3, cover2Path, token)));

    console.log('\n>>> 上传歌词');
    console.log('  歌曲2: ' + JSON.stringify(await uploadLrc(2, lrc1Path, token)));
    console.log('  歌曲3: ' + JSON.stringify(await uploadLrc(3, lrc2Path, token)));

    console.log('\n>>> 验证歌曲元数据');
    const res = await fetch(API_BASE + '/api/songs?pageSize=20');
    const data = await res.json();
    for (const s of data.data.list) {
      console.log('  [' + s.id + '] ' + s.title + ' | cover=' + (s.cover ? '✅' : '❌') + ' | lrc=' + (s.lrcExists ? '✅' : '❌') + ' | duration=' + s.duration + 's');
    }

    console.log('\n>>> 验证 LRC 可读取');
    const lrcRes = await fetch(API_BASE + '/api/songs/2/lrc');
    console.log('  歌曲2 LRC (HTTP ' + lrcRes.status + '): ' + (await lrcRes.text()).split('\n').slice(0, 4).map(l => '    ' + l).join('\n'));

    console.log('\n全部完成 ✅');
  } catch (e) {
    console.error('\n失败:', e.message);
    process.exit(1);
  }
})();
