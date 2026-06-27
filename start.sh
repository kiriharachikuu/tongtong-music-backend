#!/bin/bash
# 瞳瞳音乐后端 - Debian/Linux 启动脚本
# 用法:
#   ./start.sh          # 前台启动
#   ./start.sh background # 后台启动（使用 nohup）
#   ./start.sh stop     # 停止后台进程
#   ./start.sh status   # 查看运行状态

cd "$(dirname "$0")"

PID_FILE="data/app.pid"
LOG_FILE="data/app.log"

mkdir -p data uploads/audio uploads/covers uploads/lrc

check_node() {
    if ! command -v node &> /dev/null; then
        echo "错误: 未找到 node，请先安装 Node.js (建议 v18+)"
        echo "  Debian/Ubuntu: sudo apt install nodejs npm"
        exit 1
    fi
}

check_ffmpeg() {
    if ! command -v ffmpeg &> /dev/null; then
        echo "警告: 未找到 ffmpeg，音频转码功能将不可用"
        echo "  Debian/Ubuntu: sudo apt install ffmpeg"
    fi
}

start_foreground() {
    check_node
    check_ffmpeg
    echo "启动瞳瞳音乐后端（前台模式）..."
    node app.js
}

start_background() {
    check_node
    check_ffmpeg
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "服务已在运行，PID: $PID"
            return
        else
            rm -f "$PID_FILE"
        fi
    fi
    echo "启动瞳瞳音乐后端（后台模式）..."
    nohup node app.js > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "服务已启动，PID: $(cat "$PID_FILE")"
    echo "日志文件: $LOG_FILE"
}

stop_service() {
    if [ ! -f "$PID_FILE" ]; then
        echo "未找到 PID 文件，服务可能未运行"
        return
    fi
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "停止服务，PID: $PID"
        kill "$PID"
        sleep 2
        if kill -0 "$PID" 2>/dev/null; then
            echo "强制停止..."
            kill -9 "$PID"
        fi
        echo "服务已停止"
    else
        echo "进程不存在，清理 PID 文件"
    fi
    rm -f "$PID_FILE"
}

show_status() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "服务运行中，PID: $PID"
            echo "日志文件: $LOG_FILE"
            echo "最近日志:"
            tail -5 "$LOG_FILE" 2>/dev/null
        else
            echo "PID 文件存在但进程已死亡"
        fi
    else
        echo "服务未运行"
    fi
}

case "${1:-foreground}" in
    foreground)
        start_foreground
        ;;
    background)
        start_background
        ;;
    stop)
        stop_service
        ;;
    status)
        show_status
        ;;
    restart)
        stop_service
        sleep 1
        start_background
        ;;
    *)
        echo "用法: $0 {foreground|background|stop|status|restart}"
        echo "  foreground  - 前台启动（默认）"
        echo "  background  - 后台启动（nohup）"
        echo "  stop        - 停止后台服务"
        echo "  status      - 查看运行状态"
        echo "  restart     - 重启后台服务"
        exit 1
        ;;
esac
