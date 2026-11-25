#!/bin/bash
# Banana Gallery — 本地单机版（personal 模式）启停脚本
# 完整说明见 doc/gallery-local.md
#
# 用法:
#   ./gallery.sh start    启动 (personal 模式, 后台运行)
#   ./gallery.sh stop     停止
#   ./gallery.sh restart  重启
#   ./gallery.sh status   查看运行状态
#   ./gallery.sh log      查看实时日志 (Ctrl+C 退出)
#   ./gallery.sh launchd  由 macOS LaunchAgent 调用 (前台运行)

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/.banana-gallery.pid"
SERVER_PID_FILE="$DIR/.banana-gallery.server.pid"
FRONTEND_PID_FILE="$DIR/.banana-gallery.frontend.pid"
LOG_FILE="$DIR/.banana-gallery.log"
PROFILE_FILE="$DIR/.banana-gallery.profile"
REMOTE_ENV_FILE="$DIR/.env.personal-remote"
FRONTEND_URL="http://localhost:5173"
BACKEND_URL="http://localhost:3333"
REMOTE_ORIGIN_URL="http://localhost:3334"
TMUX_SESSION="banana-gallery"
LAUNCHD_LABEL="com.banana.gallery"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"

# ── helpers ──────────────────────────────────────────────────────────────────

kill_tree() {
  local pid=$1
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

pid_running() {
  local file=$1
  [ -f "$file" ] && kill -0 "$(cat "$file")" 2>/dev/null
}

is_running() {
  pid_running "$SERVER_PID_FILE" && pid_running "$FRONTEND_PID_FILE"
}

any_managed_process_running() {
  tmux_session_running || pid_running "$PID_FILE" || pid_running "$SERVER_PID_FILE" || pid_running "$FRONTEND_PID_FILE"
}

set_personal_env() {
  # 强制本机免登录入口的环境变量
  export AUTH_MODE=local
}

get_runtime_profile() {
  local profile="${BANANA_GALLERY_PROFILE:-}"
  if [ -z "$profile" ] && [ -f "$PROFILE_FILE" ]; then
    profile=$(head -n 1 "$PROFILE_FILE" | tr -d '[:space:]')
  fi
  profile="${profile:-personal}"

  case "$profile" in
    personal|cloudflare_access) printf "%s" "$profile" ;;
    *)
      echo "不支持的 Banana Gallery 运行配置：$profile" >&2
      return 1
      ;;
  esac
}

set_cloudflare_access_env() {
  if [ ! -f "$REMOTE_ENV_FILE" ]; then
    echo "缺少远程自用配置：$REMOTE_ENV_FILE" >&2
    return 1
  fi

  export BANANA_GALLERY_ENV_FILE=".env.personal-remote"
  export NODE_ENV=production
  export AUTH_MODE=cloudflare_access
  export BIND_HOST=127.0.0.1
}

set_runtime_env() {
  local profile
  profile=$(get_runtime_profile)
  if [ "$profile" = "cloudflare_access" ]; then
    set_cloudflare_access_env
  else
    set_personal_env
  fi
}

prepare_runtime() {
  local profile
  profile=$(get_runtime_profile)
  if [ "$profile" != "cloudflare_access" ]; then
    return 0
  fi

  if [ ! -f "$REMOTE_ENV_FILE" ]; then
    echo "缺少远程自用配置：$REMOTE_ENV_FILE" >&2
    return 1
  fi
  if [ ! -f "$DIR/dist/index.html" ]; then
    echo "首次启用远程自用模式，正在构建前端..."
    (cd "$DIR" && npm run build)
  fi
}

wait_for_url() {
  local url=$1 max=$2
  for _ in $(seq 1 "$max"); do
    sleep 1
    printf "."
    url_ok "$url" && return 0
  done
  return 1
}

url_ok() {
  curl -sf --max-time 2 "$1" -o /dev/null 2>/dev/null
}

tmux_session_running() {
  command -v tmux >/dev/null 2>&1 && tmux has-session -t "$TMUX_SESSION" 2>/dev/null
}

stop_pid_file() {
  local file=$1
  local label=$2
  if ! pid_running "$file"; then
    rm -f "$file"
    return 0
  fi

  local pid
  pid=$(cat "$file")
  echo "正在停止 $label (PID $pid)..."
  kill_tree "$pid"

  local waited=0
  while kill -0 "$pid" 2>/dev/null && [ $waited -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$file"
}

start_background_services() {
  nohup npm run server >> "$LOG_FILE" 2>&1 < /dev/null &
  echo $! > "$SERVER_PID_FILE"

  nohup npm run dev >> "$LOG_FILE" 2>&1 < /dev/null &
  echo $! > "$FRONTEND_PID_FILE"
}

is_macos() {
  [ "$(uname -s)" = Darwin ]
}

launchd_domain() {
  printf 'gui/%s' "$(id -u)"
}

launchd_target() {
  printf '%s/%s' "$(launchd_domain)" "$LAUNCHD_LABEL"
}

prepare_launchd_plist() {
  if [ ! -f "$LAUNCHD_PLIST" ]; then
    mkdir -p "$(dirname "$LAUNCHD_PLIST")"
    python3 - "$LAUNCHD_PLIST" "$DIR" "$LOG_FILE" "$LAUNCHD_LABEL" "$(dirname "$(command -v node)")" <<'PYTHON'
import os
import plistlib
import sys
import tempfile

path, directory, log, label, node_bin = sys.argv[1:]
with tempfile.NamedTemporaryFile(dir=os.path.dirname(path), delete=False) as file:
    try:
        plistlib.dump({
            "Label": label,
            "ProgramArguments": [os.path.join(directory, "gallery.sh"), "launchd"],
            "WorkingDirectory": directory,
            "RunAtLoad": True,
            "EnvironmentVariables": {
                "PATH": node_bin + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            },
            "StandardOutPath": log,
            "StandardErrorPath": log,
        }, file)
        file.close()
        try:
            os.link(file.name, path)
        except FileExistsError:
            pass
    finally:
        os.unlink(file.name)
PYTHON
  fi

  local directory command
  directory=$(plutil -extract WorkingDirectory raw -o - "$LAUNCHD_PLIST" 2>/dev/null) || directory=
  command=$(plutil -extract ProgramArguments.2 raw -o - "$LAUNCHD_PLIST" 2>/dev/null) || command=
  if [ "$directory" != "$DIR" ] && [ "$command" != "cd \"$DIR\" && ./gallery.sh launchd" ]; then
    echo "LaunchAgent 指向其他目录：$LAUNCHD_PLIST" >&2
    return 1
  fi
}

start_with_launchd() {
  local target job
  prepare_launchd_plist
  target=$(launchd_target)
  job=$(launchctl print "$target" 2>/dev/null) || job=
  if tmux_session_running || { [[ "$job" != *"state = running"* ]] && any_managed_process_running; }; then
    echo "检测到旧的后台进程，请执行 ./gallery.sh restart 切换到 launchd。" >&2
    return 1
  fi

  if [ -n "$job" ]; then
    launchctl kickstart "${1:--p}" "$target" >/dev/null
  else
    launchctl bootstrap "$(launchd_domain)" "$LAUNCHD_PLIST"
  fi
  printf "等待 launchd 启动 Banana Gallery"
  if wait_for_url "$FRONTEND_URL/api/session" 30 && url_ok "$BACKEND_URL/api/session"; then
    printf '\nBanana Gallery 已启动（launchd）\n'
  else
    printf '\n启动超时，请查看日志：%s\n' "$LOG_FILE" >&2
    return 1
  fi
}

stop_with_launchd() {
  local target job pid
  target=$(launchd_target)
  if [ -f "$LAUNCHD_PLIST" ]; then
    prepare_launchd_plist
  fi
  job=$(launchctl print "$target" 2>/dev/null) || return 0
  pid=$(awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }' <<< "$job")
  launchctl bootout "$target"
  if [ -n "$pid" ]; then
    for _ in $(seq 1 35); do
      if ! kill -0 "$pid" 2>/dev/null; then
        return 0
      fi
      sleep 1
    done
    echo "等待 launchd 停止 Banana Gallery 超时，请查看日志：$LOG_FILE" >&2
    return 1
  fi
}

# ── commands ─────────────────────────────────────────────────────────────────

do_start() {
  if is_macos; then
    start_with_launchd
    return
  fi

  if any_managed_process_running || url_ok "$FRONTEND_URL" || url_ok "$BACKEND_URL/api/session"; then
    echo "Banana Gallery 进程已存在"
    do_status || true
    if url_ok "$FRONTEND_URL" && url_ok "$BACKEND_URL/api/session"; then
      return 0
    fi
    echo "状态异常：请先执行 ./gallery.sh restart"
    return 1
  fi

  local profile
  profile=$(get_runtime_profile)
  prepare_runtime
  echo "正在启动 Banana Gallery ($profile)..."
  cd "$DIR"
  if command -v tmux >/dev/null 2>&1; then
    tmux new-session -d -s "$TMUX_SESSION" -c "$DIR" "./gallery.sh launchd >> \"$LOG_FILE\" 2>&1"
  else
    set_runtime_env
    start_background_services
  fi

  printf "等待服务就绪"
  if wait_for_url "$FRONTEND_URL" 30 && wait_for_url "$BACKEND_URL/api/session" 30; then
    echo ""
    echo "Banana Gallery 已启动"
    echo "  后端 PID: $(cat "$SERVER_PID_FILE")"
    echo "  前端 PID: $(cat "$FRONTEND_PID_FILE")"
    echo "  前端: $FRONTEND_URL"
    echo "  后端: $BACKEND_URL"
    echo "  日志: $LOG_FILE"
  else
    echo ""
    echo "启动超时，请查看日志:"
    echo "  tail -f $LOG_FILE"
    return 1
  fi
}

guard_generation_shutdown() {
  local action=$1 force=${2:-} profile env_file address status summary
  if [ "$force" = "--force" ]; then
    return 0
  fi
  profile=$(get_runtime_profile)
  env_file="$DIR/${BANANA_GALLERY_ENV_FILE:-.env}"
  if [ "$profile" = "cloudflare_access" ]; then
    env_file="$REMOTE_ENV_FILE"
  fi
  address=$(node -e '
    const fs = require("node:fs");
    const { parseEnv } = require("node:util");
    const file = process.argv[1];
    const config = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {};
    const port = parseInt(process.env.PORT ?? config.PORT ?? "", 10) || 3333;
    const bind = process.argv[2] === "cloudflare_access" ? "127.0.0.1" : (process.env.BIND_HOST ?? config.BIND_HOST)?.trim();
    const host = bind === "::1" ? "[::1]" : bind === "localhost" ? "localhost" : "127.0.0.1";
    process.stdout.write(host + ":" + port);
  ' "$env_file" "$profile") || return 1
  status="status=running"
  if [ "$action" = "restart" ]; then
    status="$status&status=queued"
  fi
  local count
  if summary=$(curl --noproxy '*' -sf --max-time 2 "http://$address/api/generation-tasks?view=summary&$status&limit=1" 2>/dev/null) &&
    count=$(printf '%s' "$summary" | node -e '
      try {
        const { total } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        if (!Number.isSafeInteger(total) || total < 0) process.exit(1);
        process.stdout.write(String(total));
      } catch { process.exit(1); }
    '); then
    if [ "$count" -gt 0 ]; then
      echo "仍有生图任务正在执行或等待，请等任务结束后再操作；如需强制执行，请运行 ./gallery.sh $action --force。" >&2
      return 1
    fi
  elif any_managed_process_running ||
    { is_macos && [[ "$(launchctl print "$(launchd_target)" 2>/dev/null)" == *"state = running"* ]]; }; then
    echo "无法确认生图队列是否空闲，已取消操作；如需强制执行，请运行 ./gallery.sh $action --force。" >&2
    return 1
  fi
}

do_stop() {
  if is_macos; then
    stop_with_launchd
  fi

  if ! any_managed_process_running; then
    echo "Banana Gallery 未在运行"
    rm -f "$PID_FILE" "$SERVER_PID_FILE" "$FRONTEND_PID_FILE"
    return 0
  fi

  stop_pid_file "$PID_FILE" "Banana Gallery"
  stop_pid_file "$SERVER_PID_FILE" "Banana Gallery 后端"
  stop_pid_file "$FRONTEND_PID_FILE" "Banana Gallery 前端"
  if tmux_session_running; then
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  fi
  echo "Banana Gallery 已停止"
}

do_restart() {
  if is_macos && ! tmux_session_running && launchctl print "$(launchd_target)" >/dev/null 2>&1; then
    start_with_launchd -kp
  else
    do_stop
    do_start
  fi
}

do_status() {
  if ! any_managed_process_running && ! url_ok "$FRONTEND_URL" && ! url_ok "$BACKEND_URL/api/session"; then
    echo "Banana Gallery 未在运行"
    rm -f "$PID_FILE" "$SERVER_PID_FILE" "$FRONTEND_PID_FILE"
    return 0
  fi

  echo "Banana Gallery 状态:"
  echo "  运行配置: $(get_runtime_profile)"
  if is_macos && launchctl print "$(launchd_target)" 2>/dev/null | grep -q "state = running"; then
    echo "  进程托管: launchd"
  fi
  if tmux_session_running; then
    echo "  tmux 会话: $TMUX_SESSION"
  fi
  if pid_running "$FRONTEND_PID_FILE"; then
    echo "  前端进程: PID $(cat "$FRONTEND_PID_FILE")"
  else
    echo "  前端进程: 未由脚本管理"
  fi
  if url_ok "$FRONTEND_URL"; then
    echo "  前端: $FRONTEND_URL (正常)"
  else
    echo "  前端: $FRONTEND_URL (不可用)"
  fi

  if pid_running "$SERVER_PID_FILE"; then
    echo "  后端进程: PID $(cat "$SERVER_PID_FILE")"
  else
    echo "  后端进程: 未由脚本管理"
  fi
  if url_ok "$BACKEND_URL/api/session"; then
    echo "  后端: $BACKEND_URL (正常)"
  else
    echo "  后端: $BACKEND_URL (不可用)"
    return 1
  fi
  node -e 'fetch(process.argv[1], {signal: AbortSignal.timeout(7000)}).then(r => r.json()).then(data => {for (const [provider,label] of [["qwen-local","本地 Qwen"],["krea-local","本地 Krea"]]) {const model = data.models?.find(m => m.provider === provider); if (model) console.log("  " + label + ": " + (model.available ? "在线" : model.unavailableReason || "未配置"))}}).catch(() => console.log("  本地 Qwen/Krea: 暂无法查询"))' "$BACKEND_URL/api/generation/models"
  if [ "$(get_runtime_profile)" = "cloudflare_access" ]; then
    if curl -sS -o /dev/null --max-time 2 "$REMOTE_ORIGIN_URL/api/session"; then
      echo "  远程认证源站: $REMOTE_ORIGIN_URL (正常，未携带 Access 断言时应返回 401)"
    else
      echo "  远程认证源站: $REMOTE_ORIGIN_URL (不可用)"
      return 1
    fi
  fi
}

do_log() {
  if [ -f "$LOG_FILE" ]; then
    tail -f "$LOG_FILE"
  else
    echo "日志文件不存在 (尚未启动过)"
  fi
}

do_launchd() {
  if pid_running "$SERVER_PID_FILE" || pid_running "$FRONTEND_PID_FILE" || url_ok "$FRONTEND_URL" || url_ok "$BACKEND_URL/api/session"; then
    echo "Banana Gallery 已在运行"
    do_status || true
    return 0
  fi

  cd "$DIR"
  prepare_runtime
  set_runtime_env
  echo $$ > "$PID_FILE"

  cleanup() {
    stop_pid_file "$SERVER_PID_FILE" "Banana Gallery 后端"
    stop_pid_file "$FRONTEND_PID_FILE" "Banana Gallery 前端"
    rm -f "$PID_FILE" "$SERVER_PID_FILE" "$FRONTEND_PID_FILE"
  }

  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  echo "正在通过 launchd 启动 Banana Gallery ($(get_runtime_profile))..."
  npm run server &
  echo $! > "$SERVER_PID_FILE"
  npm run dev &
  echo $! > "$FRONTEND_PID_FILE"

  while pid_running "$SERVER_PID_FILE" && pid_running "$FRONTEND_PID_FILE"; do
    sleep 2
  done

  echo "Banana Gallery 子进程已退出，正在清理..."
  return 1
}

# ── main ─────────────────────────────────────────────────────────────────────

case "${1:-}" in
  start)   do_start ;;
  stop)    guard_generation_shutdown stop "${2:-}" && do_stop ;;
  restart) guard_generation_shutdown restart "${2:-}" && do_restart ;;
  status)  do_status ;;
  log|logs) do_log ;;
  launchd) do_launchd ;;
  profile) get_runtime_profile; echo "" ;;
  backup|backup-info|verify|restore)
    set_runtime_env
    if [ "$1" = restore ] && [ "${3:-}" = --in-place ]; then
      if any_managed_process_running; then
        echo "请先执行 ./gallery.sh stop，再恢复原位置。" >&2
        exit 1
      fi
      export BANANA_GALLERY_OFFLINE_RESTORE=true
    fi
    cd "$DIR"
    npx --no-install tsx scripts/gallery-backup.ts "$@"
    ;;
  *)
    echo "Banana Gallery 本地启停脚本"
    echo ""
    echo "用法: ./gallery.sh <命令>"
    echo ""
    echo "  start    启动 (personal 模式, 后台运行)"
    echo "  stop [--force]     停止"
    echo "  restart [--force]  重启"
    echo "  status   查看运行状态"
    echo "  log      查看实时日志 (Ctrl+C 退出)"
    echo "  launchd  由 macOS LaunchAgent 调用 (前台运行)"
    echo "  profile  查看当前运行配置"
    echo "  backup   创建完整备份"
    echo "  verify <编号>   校验备份"
    echo "  restore <编号> --to <空目录> | --in-place   恢复备份"
    ;;
esac
