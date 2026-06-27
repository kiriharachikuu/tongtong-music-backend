# 瞳瞳音乐文件上传规范

## 目录结构

```
backend/uploads/
├── audio/          # 音频文件目录
│   └── song_{id}_{timestamp}.mp3
│
├── covers/         # 封面图片目录
│   ├── {timestamp}_{random}.{ext}  # 正常使用的封面
│   └── unused/                      # 未使用的图片（回收站）
│       └── {timestamp}_{random}.{ext}
│
└── lrc/            # 歌词文件目录
    └── {id}.lrc                    # 简单命名：歌曲ID.lrc
    └── song_{id}_{timestamp}.lrc   # 详细命名（可选）
```

## 文件命名规范

### 音频文件
- **格式**: `song_{id}_{timestamp}.mp3`
- **示例**: `song_8_1782413361479.mp3`
- **说明**: 所有音频都会自动转码为 128kbps MP3 格式
- **存储路径**: 相对路径存入数据库 `audio/song_{id}_{timestamp}.mp3`

### 封面图片
- **格式**: `{timestamp}_{random}.{ext}`
- **示例**: `1782415461257_594862.png`
- **支持的格式**: PNG, JPG, JPEG, GIF, WEBP
- **大小限制**: 最大 5MB
- **存储路径**: 相对路径存入数据库 `covers/{timestamp}_{random}.{ext}`

### 歌词文件
- **格式**: `{id}.lrc` 或 `song_{id}_{timestamp}.lrc`
- **示例**: `8.lrc` 或 `song_8_1782413361479.lrc`
- **编码**: UTF-8
- **格式要求**: 标准 LRC 格式 `[mm:ss.xx]歌词文本`
- **大小限制**: 最大 1MB
- **存储路径**: 绝对路径 `uploads/lrc/{id}.lrc`

## 上传流程

### 1. 歌曲创建
```javascript
POST /api/admin/songs
{
  "title": "歌曲名",
  "singer": "演唱者",
  "album_id": 1,      // 选择已存在的专辑ID
  "genre": "流行",
  "year": 2024
}
```

### 2. 上传音频
```javascript
POST /api/admin/songs/:id/audio
Content-Type: multipart/form-data
file: [音频文件]

// 推荐流程：先探测元数据，再提交
POST /api/admin/songs/probe-audio  // 返回 tempToken
POST /api/admin/songs/:id/audio     // 使用 tempToken 避免二次上传
```

音频会自动转码为 MP3 格式并存入 `uploads/audio/` 目录。

### 3. 上传封面
```javascript
POST /api/admin/songs/:id/cover
Content-Type: multipart/form-data
file: [图片文件]
```

封面图片存入 `uploads/covers/` 目录，文件名自动生成。

### 4. 上传歌词
```javascript
POST /api/admin/songs/:id/lrc
Content-Type: multipart/form-data
file: [.lrc 文件]
```

歌词文件存入 `uploads/lrc/` 目录，文件名以歌曲ID命名。

## 文件类型验证

后端会严格验证上传文件的类型：

### 图片验证
- MIME 类型必须为 `image/*`（如 image/png, image/jpeg）
- 或扩展名为 `.png, .jpg, .jpeg, .gif, .webp`
- **错误示例**: 图片文件上传到歌词接口会被拒绝

### 歌词验证
- MIME 类型为 `text/plain`
- 或扩展名为 `.lrc`
- **错误示例**: 图片文件上传到歌词接口会被拒绝

### 音频验证
- MIME 类型必须为音频类型（如 audio/mpeg, audio/wav）
- 或扩展名为 `.mp3, .wav, .flac, .ogg, .m4a, .aac`

## 文件访问

### 音频播放
```javascript
GET /api/songs/:id/stream
// 支持 Range 请求，可用于 HTML5 Audio 元素
```

### 封面访问
```javascript
GET /api/uploads/covers/{timestamp}_{random}.{ext}
// 静态文件访问，无需认证
```

### 歌词获取
```javascript
GET /api/songs/:id/lrc        // 获取原始 LRC 文本
GET /api/songs/:id/lyric      // 获取解析后的结构化歌词
```

## 清理规范

### 未使用文件处理
- lrc 目录中发现非 `.lrc` 文件会自动移动到 `covers/unused/` 目录
- 定期清理 `covers/unused/` 目录中的文件（管理员手动处理）
- 删除歌曲时会自动清理关联的音频、封面、歌词文件

### 临时文件清理
- 音频探测临时文件存放在 `data/probe_tmp/` 目录
- 默认存活时间：30 分钟（AUDIO_TEMP_TTL）
- 后端每 10 分钟自动清理过期临时文件

## 数据库路径格式

### songs 表路径字段
- `audio_path`: 存放相对路径 `audio/song_{id}_{timestamp}.mp3`
- `cover`: 存放相对路径 `covers/{timestamp}_{random}.{ext}`
- `lrc_exists`: 标记是否有歌词（不存储路径，默认为 `uploads/lrc/{id}.lrc`）

### albums 表路径字段
- `cover`: 存放相对路径 `covers/{timestamp}_{random}.{ext}`

### banners 表路径字段
- `image`: 存放相对路径 `covers/{timestamp}_{random}.{ext}`（与封面共用目录）

## 注意事项

1. **严禁混放**: 不同类型的文件必须存放于对应目录，不可交叉存放
2. **路径规范**: 数据库中存储相对于 `uploads/` 的路径（如 `covers/xxx.png`）
3. **文件唯一性**: 文件名包含时间戳和随机数，确保不重复
4. **编码规范**: 歌词文件必须使用 UTF-8 编码，避免乱码
5. **格式限制**: 音频会强制转码为 MP3，不可上传后保持原格式

## 目录权限

- `audio/`: 只允许存储音频文件
- `covers/`: 只允许存储图片文件
- `covers/unused/`: 回收未使用的图片文件
- `lrc/`: 只允许存储 .lrc 歌词文件

---

**更新时间**: 2026-06-27
**维护者**: 瞳瞳音乐后端团队