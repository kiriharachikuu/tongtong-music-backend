# 瞳瞳音乐 - 后端

Node.js + Express + SQLite 音乐服务后端

## 技术栈

- Node.js + Express
- better-sqlite3 (SQLite 数据库)
- JWT 认证
- FFmpeg 音频处理
- Multer 文件上传

## 功能特性

- 用户认证（注册、登录、JWT）
- 歌曲管理（上传、转码、播放）
- 专辑管理
- 歌单管理
- 收藏与历史记录
- 排行榜
- 横幅管理
- 每日推荐
- 应用版本管理
- 歌词解析

## 开发

```bash
# 安装依赖
npm install

# 配置环境变量
# 复制 .env.example 为 .env 并修改配置
cp .env.example .env

# 启动服务
npm start

# 开发模式（热重载）
npm run dev
```

## 环境变量 (.env)

```env
# 服务端口
PORT=3000

# JWT 密钥
JWT_SECRET=your-secret-key

# JWT 过期天数
JWT_EXPIRES_DAYS=30

# 管理员账号
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123

# FFmpeg 路径（可选）
FFMPEG_PATH=D:\ffmpeg\bin\ffmpeg.exe
FFPROBE_PATH=D:\ffmpeg\bin\ffprobe.exe

# 是否转码为 MP3
TRANSCODE_TO_MP3=1

# 存储模式 (local/s3)
STORAGE_MODE=local
```

## API 接口

### 认证
- `POST /api/auth/register` - 注册
- `POST /api/auth/login` - 登录
- `GET /api/auth/me` - 当前用户

### 歌曲
- `GET /api/songs` - 歌曲列表
- `GET /api/songs/:id` - 歌曲详情
- `GET /api/songs/albums` - 专辑列表
- `GET /api/songs/albums/:id` - 专辑详情

### 管理后台
- `POST /api/admin/songs` - 创建歌曲
- `POST /api/admin/albums` - 创建专辑
- `GET /api/admin/albums` - 专辑列表
- `DELETE /api/admin/albums/:id` - 删除专辑
- 等等...

## 数据库

使用 SQLite，数据库文件 `data/music.db`。

首次启动会自动创建表结构。
