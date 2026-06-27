# 瞳瞳音乐后端 - Debian 部署教程

## 环境要求

- Debian 10+ / Ubuntu 18.04+
- Node.js 18+ (推荐 LTS)
- FFmpeg (用于音频转码)
- 至少 1GB 内存
- 10GB+ 可用磁盘空间

---

## 一、快速安装

### 1.1 一键安装脚本

创建并运行安装脚本 `deploy.sh`：

```bash
#!/bin/bash
set -e

echo "=== 瞳瞳音乐后端部署脚本 ==="

# 检测是否为 root 用户
if [ "$EUID" -ne 0 ]; then
  echo "请使用 sudo 运行此脚本，或切换到 root 用户"
  exit 1
fi

# 安装 Node.js 18.x
echo ">>> 安装 Node.js 18.x..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# 安装 FFmpeg
echo ">>> 安装 FFmpeg..."
apt-get install -y ffmpeg

# 安装 PM2 (进程管理器)
echo ">>> 安装 PM2..."
npm install -g pm2

# 创建服务用户
echo ">>> 创建服务用户..."
if ! id -u toktokmusic > /dev/null 2>&1; then
  useradd -r -m -s /bin/false toktokmusic
fi

# 创建安装目录
INSTALL_DIR="/var/www/tongtong-music-backend"
mkdir -p $INSTALL_DIR

# 复制项目文件（假设当前目录是项目根目录）
echo ">>> 复制项目文件..."
cp -r . $INSTALL_DIR/
cd $INSTALL_DIR

# 设置权限
chown -R toktokmusic:toktokmusic $INSTALL_DIR

# 安装依赖
echo ">>> 安装 Node.js 依赖..."
npm install --production

# 创建上传目录
mkdir -p $INSTALL_DIR/{uploads,audio,uploads/covers,uploads/lrc,data}
chown -R toktokmusic:toktokmusic $INSTALL_DIR/uploads

# 配置环境变量
if [ ! -f "$INSTALL_DIR/.env" ]; then
  echo ">>> 创建 .env 配置文件..."
  SECRET=$(openssl rand -hex 32)
  cat > $INSTALL_DIR/.env << EOF
PORT=3000
JWT_SECRET=$SECRET
JWT_EXPIRES_DAYS=30
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
FFMPEG_PATH=
FFPROBE_PATH=
TRANSCODE_TO_MP3=1
STATIC_PREFIX=/uploads
STORAGE_MODE=local
EOF
  chown toktokmusic:toktokmusic $INSTALL_DIR/.env
fi

echo ""
echo "=== 部署完成 ==="
echo "安装目录: $INSTALL_DIR"
echo ""
echo "启动服务:"
echo "  cd $INSTALL_DIR"
echo "  sudo -u toktokmusic pm2 start app.js --name toktok-music"
echo "  pm2 save"
echo "  pm2 startup"
echo ""
echo "或使用 systemd:"
echo "  sudo cp $INSTALL_DIR/tongtong-music.service.example /etc/systemd/system/tongtong-music.service"
echo "  sudo nano /etc/systemd/system/tongtong-music.service  # 修改路径"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable --now tongtong-music"
```

### 1.2 手动安装

```bash
# 1. 安装系统依赖
sudo apt update
sudo apt install -y nodejs npm ffmpeg

# 2. 验证安装
node --version   # 应显示 v18.x.x
npm --version
ffmpeg -version

# 3. 创建项目目录
sudo mkdir -p /var/www/tongtong-music-backend
sudo chown $USER:$USER /var/www/tongtong-music-backend

# 4. 复制项目文件到服务器
# 使用 scp/rsync/sftp 等方式上传项目文件

# 5. 进入目录并安装依赖
cd /var/www/tongtong-music-backend
npm install

# 6. 创建上传目录
mkdir -p uploads/audio uploads/covers uploads/lrc data
```

---

## 二、配置服务

### 2.1 环境变量配置

```bash
cd /var/www/tongtong-music-backend

# 复制配置示例
cp .env.example .env

# 编辑配置（必选项：JWT_SECRET、ADMIN_PASSWORD）
nano .env
```

**关键配置项说明：**

| 配置项 | 说明 | 推荐值 |
|--------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `JWT_SECRET` | JWT 密钥（安全！） | 使用 `openssl rand -hex 32` 生成 |
| `ADMIN_PASSWORD` | 管理员密码 | 强密码，不要使用默认值 |
| `FFMPEG_PATH` | FFmpeg 路径 | 留空使用系统 PATH |
| `TRANSCODE_TO_MP3` | 是否转码为 128kbps MP3 | `1`（开启） |

### 2.2 配置防火墙

```bash
# 允许 3000 端口
sudo ufw allow 3000/tcp

# 如果使用 Nginx 反向代理
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

---

## 三、启动服务

### 方式一：PM2 进程管理器（推荐）

```bash
# 全局安装 PM2
sudo npm install -g pm2

# 启动服务
cd /var/www/tongtong-music-backend
pm2 start app.js --name toktok-music

# 设置开机自启
pm2 save
pm2 startup

# 常用命令
pm2 status              # 查看状态
pm2 logs toktok-music   # 查看日志
pm2 restart toktok-music   # 重启
pm2 stop toktok-music      # 停止
```

### 方式二：systemd 服务

```bash
# 复制服务文件
sudo cp tongtong-music.service.example /etc/systemd/system/tongtong-music.service

# 编辑服务文件（必须修改路径）
sudo nano /etc/systemd/system/tongtong-music.service
```

编辑内容（修改 `WorkingDirectory` 和 `ExecStart` 路径）：

```ini
[Unit]
Description=Tongtong Music Backend
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/var/www/tongtong-music-backend
ExecStart=/usr/bin/node app.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

StandardOutput=journal
StandardError=journal
SyslogIdentifier=tongtong-music

[Install]
WantedBy=multi-user.target
```

```bash
# 重新加载 systemd
sudo systemctl daemon-reload

# 启用并启动服务
sudo systemctl enable --now toktong-music

# 查看状态
sudo systemctl status toktong-music

# 常用命令
sudo systemctl restart toktong-music   # 重启
sudo systemctl stop toktong-music       # 停止
sudo journalctl -u toktong-music -f    # 查看日志
```

### 方式三：使用启动脚本

```bash
chmod +x start.sh

# 前台运行（调试用）
./start.sh

# 后台运行
./start.sh background

# 管理服务
./start.sh status
./start.sh stop
./start.sh restart
```

---

## 四、反向代理配置（Nginx）

### 4.1 安装 Nginx

```bash
sudo apt install -y nginx
```

### 4.2 配置反向代理

```bash
sudo nano /etc/nginx/sites-available/tongtong-music
```

写入配置：

```nginx
server {
    listen 80;
    server_name your-domain.com;  # 替换为你的域名或 IP

    # 强制 HTTPS（可选）
    # return 301 https://$server_name$request_uri;
}

# HTTPS 配置（需要先申请 SSL 证书）
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/ssl/certs/your-cert.pem;
    ssl_certificate_key /etc/ssl/private/your-key.pem;

    # 瞳瞳音乐后端
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # 大文件上传支持
        client_max_body_size 100M;
    }

    # 上传文件大小限制
    client_max_body_size 100M;
}
```

```bash
# 启用配置
sudo ln -s /etc/nginx/sites-available/tongtong-music /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重载 Nginx
sudo systemctl reload nginx
```

---

## 五、SSL 证书配置（Let's Encrypt）

```bash
# 安装 Certbot
sudo apt install -y certbot python3-certbot-nginx

# 申请证书（自动配置 Nginx）
sudo certbot --nginx -d your-domain.com

# 自动续期测试
sudo certbot renew --dry-run
```

---

## 六、运维命令

### 6.1 查看服务状态

```bash
# PM2
pm2 status

# systemd
sudo systemctl status toktong-music
```

### 6.2 查看日志

```bash
# PM2
pm2 logs toktong-music

# systemd
sudo journalctl -u toktong-music -f

# 启动脚本日志
cat /var/www/tongtong-music-backend/data/app.log
```

### 6.3 数据库备份

```bash
# 备份 SQLite 数据库
cp /var/www/tongtong-music-backend/data/tongtong.db /path/to/backup/tongtong.db.$(date +%Y%m%d).bak
```

### 6.4 更新版本

```bash
cd /var/www/tongtong-music-backend

# 停止服务
pm2 stop toktok-music
# 或
sudo systemctl stop toktong-music

# 备份数据
cp -r data data.backup
cp .env .env.backup

# 更新代码（git pull 或上传新文件）

# 重新安装依赖
npm install

# 启动服务
pm2 restart toktok-music
# 或
sudo systemctl start toktong-music
```

---

## 七、常见问题

### Q1: FFmpeg 未找到

```bash
# 安装 FFmpeg
sudo apt install ffmpeg

# 验证
ffmpeg -version
```

### Q2: 端口被占用

```bash
# 查看 3000 端口占用
sudo lsof -i :3000

# 修改 .env 中的 PORT
PORT=3001
```

### Q3: 上传文件失败

```bash
# 检查目录权限
ls -la uploads/

# 修复权限
sudo chown -R www-data:www-data uploads/
# 或
sudo chown -R $(whoami):$(whoami) uploads/
```

### Q4: 数据库锁定

```bash
# 检查数据库文件
ls -la data/*.db*

# 删除 WAL 和 SHM 文件
rm -f data/*.db-wal data/*.db-shm
```

---

## 八、API 地址说明

部署完成后，API 访问地址：

| 环境 | 后端地址 |
|------|----------|
| 本地开发 | `http://localhost:3000` |
| 有 Nginx 反代 | `http://your-domain.com` |
| 直接访问（未配置反代） | `http://your-server-ip:3000` |

**健康检查：**
```
GET http://localhost:3000/api/health
```

---

## 九、默认账号

| 类型 | 用户名 | 密码 |
|------|--------|------|
| 管理员 | `admin` | `admin123` |

> ⚠️ 生产环境请务必修改默认密码！
