#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
瞳瞳音乐 - 本地曲库批量导入脚本

递归扫描指定目录下的音频文件（.mp3 .flac .wav .m4a .ogg），
通过后端 admin 接口批量创建歌曲并上传音频/封面/歌词。

用法:
  python batch_import.py /path/to/music --base-url http://localhost:3000 --token <jwt_token>
  python batch_import.py /path/to/music --base-url http://localhost:3000 --username admin --password admin123
  python batch_import.py /path/to/music --base-url http://localhost:3000 --token <jwt> --dry-run
  python batch_import.py /path/to/music --base-url http://localhost:3000 --token <jwt> --resume

参数:
  directory         要扫描的本地音乐目录（位置参数）
  --base-url        后端 API 地址（默认 http://localhost:3000）
  --token           管理员 JWT Token（与 --username/--password 二选一）
  --username        管理员用户名
  --password        管理员密码
  --dry-run         试运行：只扫描不实际上传
  --resume          断点续传：跳过已导入的歌曲（按标题+歌手去重）
  --concurrency     并发数（默认 3）
  --cover-dir       封面目录（与音频同名的 .jpg/.png 将作为封面上传）

环境要求:
  Python 3.8+
  pip install requests
"""

import argparse
import os
import sys
import time
import json
import concurrent.futures
from pathlib import Path

try:
    import requests
except ImportError:
    print("缺少 requests 库，请运行: pip install requests")
    sys.exit(1)

AUDIO_EXTS = {'.mp3', '.flac', '.wav', '.m4a', '.ogg', '.aac'}
COVER_EXTS = {'.jpg', '.jpeg', '.png', '.webp'}
LRC_EXT = '.lrc'

# 进度状态文件
STATE_FILE = '.batch_import_state.json'


def load_state():
    """加载断点续传状态"""
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, 'r', encoding='utf-8') as f:
                return set(json.load(f).get('imported', []))
        except Exception:
            return set()
    return set()


def save_state(imported):
    """保存断点续传状态"""
    with open(STATE_FILE, 'w', encoding='utf-8') as f:
        json.dump({'imported': list(imported)}, f, ensure_ascii=False, indent=2)


def scan_directory(directory):
    """递归扫描音频文件及其关联的封面、歌词"""
    items = []
    root = Path(directory)
    if not root.exists():
        print(f"错误: 目录不存在 - {directory}")
        sys.exit(1)

    for filepath in sorted(root.rglob('*')):
        if filepath.suffix.lower() not in AUDIO_EXTS:
            continue
        stem = filepath.stem
        parent = filepath.parent
        # 查找同名封面
        cover = None
        for ext in COVER_EXTS:
            candidate = parent / f'{stem}{ext}'
            if candidate.exists():
                cover = candidate
                break
        # 查找同名歌词
        lrc = parent / f'{stem}{LRC_EXT}'
        if not lrc.exists():
            lrc = None
        items.append({
            'audio': filepath,
            'cover': cover,
            'lrc': lrc,
            'title': stem,
            'singer': parent.name,  # 用父目录名作为歌手名
        })
    return items


def get_token(base_url, username, password, token):
    """获取管理员 JWT Token"""
    if token:
        return token
    print(f"正在登录 {base_url} ...")
    resp = requests.post(f'{base_url}/api/auth/login',
                        json={'username': username, 'password': password}, timeout=10)
    data = resp.json()
    if resp.status_code != 200 or data.get('code') != 0:
        print(f"登录失败: {data.get('message', resp.text)}")
        sys.exit(1)
    t = data['data']['token']
    print("登录成功")
    return t


def create_song(base_url, token, item):
    """创建歌曲记录，返回 song_id"""
    headers = {'Authorization': f'Bearer {token}'}
    resp = requests.post(f'{base_url}/api/admin/songs',
                        json={'title': item['title'], 'singer': item['singer'], 'album': ''},
                        headers=headers, timeout=15)
    data = resp.json()
    if data.get('code') != 0:
        raise Exception(f"创建歌曲失败: {data.get('message')}")
    return data['data']['id']


def upload_file(base_url, token, song_id, field, filepath):
    """上传文件到指定端点"""
    headers = {'Authorization': f'Bearer {token}'}
    endpoint = f'{base_url}/api/admin/songs/{song_id}/{field}'
    with open(filepath, 'rb') as f:
        files = {'file': (filepath.name, f)}
        resp = requests.post(endpoint, files=files, headers=headers, timeout=300)
    data = resp.json()
    if data.get('code') != 0:
        raise Exception(f"上传{field}失败: {data.get('message')}")
    return True


def import_one(base_url, token, item, dry_run=False):
    """导入单首歌曲"""
    key = f"{item['title']}|{item['singer']}"
    if dry_run:
        print(f"[DRY-RUN] {item['title']} - {item['singer']} ({item['audio'].suffix})")
        return key, True
    try:
        song_id = create_song(base_url, token, item)
        upload_file(base_url, token, song_id, 'audio', item['audio'])
        if item['cover']:
            upload_file(base_url, token, song_id, 'cover', item['cover'])
        if item['lrc']:
            upload_file(base_url, token, song_id, 'lrc', item['lrc'])
        print(f"  ✓ #{song_id} {item['title']} - {item['singer']}")
        return key, True
    except Exception as e:
        print(f"  ✗ {item['title']} - {item['singer']}: {e}")
        return key, False


def main():
    parser = argparse.ArgumentParser(description='瞳瞳音乐批量导入脚本')
    parser.add_argument('directory', help='要扫描的本地音乐目录')
    parser.add_argument('--base-url', default='http://localhost:3000', help='后端 API 地址')
    parser.add_argument('--token', default=None, help='管理员 JWT Token')
    parser.add_argument('--username', default=None, help='管理员用户名')
    parser.add_argument('--password', default=None, help='管理员密码')
    parser.add_argument('--dry-run', action='store_true', help='试运行：只扫描不实际上传')
    parser.add_argument('--resume', action='store_true', help='断点续传：跳过已导入的歌曲')
    parser.add_argument('--concurrency', type=int, default=3, help='并发数')
    args = parser.parse_args()

    # 鉴权
    token = get_token(args.base_url, args.username, args.password, args.token)

    # 扫描
    print(f"扫描目录: {args.directory}")
    items = scan_directory(args.directory)
    print(f"发现 {len(items)} 首音频文件")

    if not items:
        print("未找到可导入的音频文件")
        return

    # 断点续传
    imported = load_state() if args.resume else set()
    if imported:
        print(f"断点续传: 已导入 {len(imported)} 首，将跳过")

    pending = [it for it in items if f"{it['title']}|{it['singer']}" not in imported]
    print(f"待导入: {len(pending)} 首")

    if args.dry_run:
        print("\n=== 试运行模式 ===")
        for item in pending:
            print(f"  {item['title']} - {item['singer']} | 音频:{item['audio'].name} 封面:{item['cover'].name if item['cover'] else '无'} 歌词:{item['lrc'].name if item['lrc'] else '无'}")
        return

    # 并发导入
    success = 0
    fail = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {pool.submit(import_one, args.base_url, token, item): item for item in pending}
        for future in concurrent.futures.as_completed(futures):
            key, ok = future.result()
            if ok:
                imported.add(key)
                success += 1
            else:
                fail += 1
            # 每 10 首保存一次状态
            if (success + fail) % 10 == 0:
                save_state(imported)

    save_state(imported)
    print(f"\n=== 导入完成 ===\n成功: {success}  失败: {fail}  总计: {len(pending)}")
    if fail:
        print(f"失败的歌曲可重新运行（带 --resume 参数）来续传")


if __name__ == '__main__':
    main()
