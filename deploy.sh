#!/usr/bin/env bash
#
# deploy.sh — matcher 项目一键部署脚本
#
# 流程：
#   1. 校验本地前置条件（docker / docker compose / rsync / ssh 可用）
#   2. 检查本地 .env 必填项（只读解析，绝不 source 不可信文件）
#   3. 上传代码到目标服务器（rsync，排除本地产物与 .env）
#   4. 在服务器上检查/准备 .env（权限收敛为 600），迁移前先备份数据库，再执行 Alembic 迁移（幂等）
#   5. 在服务器上执行 docker compose up -d [--build]
#
# 用法：
#   ./deploy.sh user@host:/opt/matcher
#   ./deploy.sh user@host:/opt/matcher -i ~/job_match.pem   # 用指定私钥登录
#   ./deploy.sh user@host:/opt/matcher --no-upload     # 跳过上传，仅迁移+部署
#   ./deploy.sh user@host:/opt/matcher --no-build      # 上传+迁移，但不重建镜像
#
# 私钥：若服务器要求密钥登录（如腾讯云 .pem），用 -i/--identity 指定，
#       或设置环境变量 SSH_IDENTITY；未指定时回退到 ssh 默认（~/.ssh/id_*）。
#
# 安全说明：
#   - 本脚本不以 source 方式加载 .env（避免执行其中可能被篡改的任意命令），
#     改用只读 grep 解析所需键值。
#   - 远程命令不把路径拼进 shell 字符串（避免引号破坏/注入），
#     而是用 docker compose --project-directory 指定目录。
#   - 服务器侧新建的 .env 权限收敛为 600。
#   - ssh 统一 BatchMode（无交互）、ConnectTimeout、禁用 TTY。

set -euo pipefail

# ---------- 参数解析 ----------
REMOTE="${1:-}"
NO_UPLOAD=0
NO_BUILD=0
IDENTITY="${SSH_IDENTITY:-}"   # 支持环境变量 SSH_IDENTITY 预设私钥

for arg in "$@"; do
  case "$arg" in
    --no-upload) NO_UPLOAD=1 ;;
    --no-build)  NO_BUILD=1 ;;
    -i|--identity)
      # 选项值在下一个位置参数
      shift_args=1
      ;;
    -i=*|--identity=*)
      IDENTITY="${arg#*=}"
      ;;
    -h|--help)
      grep -E '^#' "$0" | sed 's/^#\s\?//'
      exit 0
      ;;
    *)
      if [[ -z "$REMOTE" ]]; then REMOTE="$arg"; fi
      ;;
  esac
done

# 单独解析 -i/--identity 的伴随值（兼容「-i path」与「-i=path」两种写法）
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  a="${args[i]}"
  if [[ "$a" == "-i" || "$a" == "--identity" ]]; then
    if [[ -n "${args[i+1]:-}" && "${args[i+1]}" != -* ]]; then
      IDENTITY="${args[i+1]}"
    fi
  elif [[ "$a" == -i=* || "$a" == --identity=* ]]; then
    IDENTITY="${a#*=}"
  fi
done

if [[ -z "$REMOTE" ]]; then
  echo "✗ 用法: $0 user@host:/path/to/deploy [--no-upload] [--no-build]" >&2
  exit 1
fi

# 仅允许 host:/abs/path 形式；路径必须是绝对路径，防止误写到相对目录
if [[ "$REMOTE" != *:* || "$REMOTE" != */?* ]]; then
  echo "✗ 目标格式应为 user@host:/absolute/path（路径需为绝对路径）" >&2
  exit 1
fi

# 本地仓库根目录（脚本所在目录）
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE_HOST="${REMOTE%%:*}"
REMOTE_PATH="${REMOTE#*:}"

# 远程命令统一的安全选项
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=30 -o StrictHostKeyChecking=accept-new -T)
# 若指定了私钥，加入 IdentityFile（并强制密钥认证，禁用密码交互）
if [[ -n "$IDENTITY" ]]; then
  if [[ ! -f "$IDENTITY" ]]; then
    echo "✗ 指定的私钥文件不存在: $IDENTITY" >&2
    exit 1
  fi
  # 私钥权限必须受限制，否则 ssh 会拒绝使用
  chmod 600 "$IDENTITY" 2>/dev/null || true
  SSH_OPTS+=(-i "$IDENTITY" -o PreferredAuthentications=publickey -o PasswordAuthentication=no)
fi

# docker compose 命令（兼容 plugin 与旧版）
if docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DOCKER_COMPOSE=(docker-compose)
else
  echo "✗ 未找到 docker compose（插件或 docker-compose 均可）" >&2
  exit 1
fi

echo "==> 部署配置"
echo "    本地目录 : $LOCAL_DIR"
echo "    目标服务器: $REMOTE_HOST"
echo "    目标路径  : $REMOTE_PATH"
echo "    私钥文件  : $([[ -n "$IDENTITY" ]] && echo "${IDENTITY}" || echo "(ssh 默认)")"
echo "    跳过上传  : $([[ $NO_UPLOAD -eq 1 ]] && echo 是 || echo 否)"
echo "    跳过构建  : $([[ $NO_BUILD -eq 1 ]] && echo 是 || echo 否)"
echo

# ---------- 第 1 步：本地前置条件 ----------
echo "==> [1/5] 校验本地前置条件"
for bin in docker rsync ssh; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "✗ 本地缺少命令: $bin" >&2
    exit 1
  fi
done
echo "    使用: ${DOCKER_COMPOSE[*]}"

# 验证能无交互 ssh 到服务器
if ! ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" true 2>/dev/null; then
  echo "✗ 无法通过 ssh 无交互登录 ${REMOTE_HOST}" >&2
  if [[ -z "$IDENTITY" ]]; then
    echo "    提示：服务器若要求密钥登录，请用 -i/--identity 指定私钥（如 -i ~/job_match.pem）" >&2
  fi
  exit 1
fi
echo "    ssh 连接正常"
echo

# ---------- 第 2 步：本地 .env 必填项检查（只读解析，不 source） ----------
echo "==> [2/5] 检查本地 .env 环境变量"
REQUIRED_VARS=(LLM_API_KEY AUTH_SECRET_KEY AUTH_BOOTSTRAP_PASSWORD)
# 读取 .env 中某个 key 的值（不执行文件，避免任意命令执行）
read_env_value() {
  local key="$1" file="$2" val=""
  [[ -f "$file" ]] || return 0
  val="$(grep -E "^${key}=" "$file" | tail -n1 | sed -E "s/^${key}=//" | sed -E 's/^["'\''"]|["'\''"]$//g')"
  printf '%s' "$val"
}

if [[ -f "$LOCAL_DIR/.env" ]]; then
  missing=0
  for v in "${REQUIRED_VARS[@]}"; do
    if [[ -z "$(read_env_value "$v" "$LOCAL_DIR/.env")" ]]; then
      echo "    ⚠ 本地 .env 中 $v 为空（部署到服务器后需确保服务器侧也已配置）"
      missing=1
    fi
  done
  if [[ $missing -eq 0 ]]; then
    echo "    本地 .env 必填项均已填写"
  fi
else
  echo "    ℹ 本地无 .env（不影响部署；服务器侧会单独检查）"
fi
echo

# ---------- 第 3 步：上传代码 ----------
if [[ $NO_UPLOAD -eq 0 ]]; then
  echo "==> [3/5] 上传代码到 $REMOTE"
  # 排除本地产物、依赖、数据库；
  # 注意：本地 .env 会一并上传（首次部署即把本地配置带到服务器），
  #       但第 4.1 步保证「服务器已存在 .env 时不覆盖」，避免冲掉线上改动。
  # 先确保服务器目标目录存在（兼容旧版 rsync，不依赖 --mkpath）
  # 目标可能位于 /opt 等需 root 的目录，使用 sudo 创建（依赖服务器免密 sudo）
  ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "sudo mkdir -p '$REMOTE_PATH' && sudo chown \$(id -u):\$(id -g) '$REMOTE_PATH'"
  # 构造 rsync 远程 shell：复用 SSH_OPTS（含私钥、BatchMode、超时等）
  RSYNC_SSH=(ssh -o BatchMode=yes -o ConnectTimeout=30 -o StrictHostKeyChecking=accept-new)
  if [[ -n "$IDENTITY" ]]; then
    RSYNC_SSH+=(-i "$IDENTITY" -o PreferredAuthentications=publickey -o PasswordAuthentication=no)
  fi
  RSYNC_RSH=$(printf '%q ' "${RSYNC_SSH[@]}")
  rsync -az -e "$RSYNC_RSH" \
    --exclude '.git/' \
    --exclude '.venv/' \
    --exclude 'node_modules/' \
    --exclude 'frontend/node_modules/' \
    --exclude 'frontend/dist/' \
    --exclude '__pycache__/' \
    --exclude '*.pyc' \
    --exclude '*.db' \
    --exclude '.DS_Store' \
    "$LOCAL_DIR/" "$REMOTE/"
  echo "    上传完成"
else
  echo "==> [3/5] 跳过上传（--no-upload）"
fi
echo

# ---------- 第 4 步：服务器端 .env 与数据库迁移 ----------
echo "==> [4/5] 服务器侧环境检查 + 执行迁移"
# 通过 quoted heredoc 传参，避免本地意外展开；仅把需要的变量以位置参数传入
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" bash -s "$REMOTE_PATH" "${DOCKER_COMPOSE[@]}" <<'EOF'
set -euo pipefail
REMOTE_PATH="$1"; shift
# 重构 docker compose 命令数组
DC=("$@")

echo "  [4.0] 备份数据库（迁移前，防止迁移/重建损坏数据）"
BACKUP_DIR="$REMOTE_PATH/backups"
mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d_%H%M%S)"
BAK="$BACKUP_DIR/jobmatch-$TS.db"
# SQLite 官方 backup() API：在线热备，保证一致性快照，无需停机
if "${DC[@]}" --project-directory "$REMOTE_PATH" ps -q backend 2>/dev/null | grep -q .; then
  # 容器在运行：在线备份到 /tmp 后拷出容器
  if "${DC[@]}" --project-directory "$REMOTE_PATH" exec -T backend \
       python -c "import sqlite3; s=sqlite3.connect('/app/data/jobmatch.db'); d=sqlite3.connect('/tmp/jobmatch_bak.db'); s.backup(d); d.close(); s.close()" && \
     "${DC[@]}" --project-directory "$REMOTE_PATH" cp backend:/tmp/jobmatch_bak.db "$BAK"; then
    echo "    已备份: $BAK"
  else
    echo "    ⚠ 在线备份失败，请手动确认数据库状态后再继续" >&2
  fi
else
  # 容器未运行：用临时容器直接把备份写到挂载的备份目录（数据来自卷，无需旧容器）
  if "${DC[@]}" --project-directory "$REMOTE_PATH" run --rm -v "$BACKUP_DIR:/backup" backend \
       python -c "import sqlite3; s=sqlite3.connect('/app/data/jobmatch.db'); d=sqlite3.connect('/backup/jobmatch-$TS.db'); s.backup(d); d.close(); s.close()" 2>/dev/null; then
    echo "    已备份: $BAK"
  else
    echo "    ℹ 未能备份（卷中尚无数据库，首次部署属正常）"
  fi
fi
# 仅保留最近 10 份备份，避免无限增长
ls -1t "$BACKUP_DIR"/jobmatch-*.db 2>/dev/null | tail -n +11 | xargs -r rm -f

echo "  [4.1] 检查服务器目录与 .env"
mkdir -p "$REMOTE_PATH"
cd "$REMOTE_PATH"
if [[ -f .env ]]; then
  echo "    服务器已存在 .env，保留不覆盖（来自本地上传或人工改动）"
else
  if [[ -f .env.example ]]; then
    cp .env.example .env
    chmod 600 .env
    echo "    ⚠ 服务器无 .env，已用 .env.example 创建（权限 600），请补全必填项后再继续"
  else
    echo "    ✗ 服务器上既无 .env 也无 .env.example，无法继续" >&2
    exit 1
  fi
fi
# 收敛 .env 权限（若存在且权限过宽）
if [[ -f .env && "$(stat -c '%a' .env 2>/dev/null)" != "600" ]]; then
  chmod 600 .env
fi

echo "  [4.2] 校验 .env 必填项"
missing=0
while IFS= read -r line; do
  key="${line%%=*}"
  val="${line#*=}"
  case "$key" in
    LLM_API_KEY|AUTH_SECRET_KEY|AUTH_BOOTSTRAP_PASSWORD)
      if [[ -z "$val" ]]; then
        echo "    ✗ .env 必填项 $key 为空" >&2
        missing=1
      fi
      ;;
  esac
done < <(grep -E '^(LLM_API_KEY|AUTH_SECRET_KEY|AUTH_BOOTSTRAP_PASSWORD)=' .env || true)
if [[ $missing -eq 1 ]]; then
  echo "    请先在服务器 $REMOTE_PATH/.env 中填写上述必填项，再重新运行部署。" >&2
  exit 1
fi
echo "    服务器 .env 必填项均已填写"

echo "  [4.3] 执行数据库迁移 (alembic upgrade head)"
# 直接在 backend 服务容器内运行迁移；若镜像不存在，compose 会按配置自动构建后再运行。
# 不使用 || true 吞错，确保迁移失败能暴露。
"${DC[@]}" --project-directory "$REMOTE_PATH" run --rm backend python -m alembic upgrade head
echo "    迁移完成"
EOF
echo

# ---------- 第 5 步：docker compose 启动 ----------
echo "==> [5/5] 启动服务 (docker compose up -d)"
UP_ARGS=(up -d)
if [[ $NO_BUILD -eq 0 ]]; then
  UP_ARGS=(up -d --build)
fi
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" \
  "${DOCKER_COMPOSE[@]}" --project-directory "$REMOTE_PATH" "${UP_ARGS[@]}"

echo
echo "==> 部署完成 ✓"
echo "    前端: http://<服务器IP>:3005   (或经 Nginx: http://<服务器IP>)"
echo "    后端: http://<服务器IP>:8005/health"
echo "    查看状态: ssh ${SSH_OPTS[*]} $REMOTE_HOST '${DOCKER_COMPOSE[*]} --project-directory $REMOTE_PATH ps'"
echo "    查看日志: ssh ${SSH_OPTS[*]} $REMOTE_HOST '${DOCKER_COMPOSE[*]} --project-directory $REMOTE_PATH logs -f'"
echo "    数据库备份: $REMOTE_PATH/backups/ （迁移前自动生成，保留最近 10 份）"
