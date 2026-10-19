#!/usr/bin/env bash
# Fallback for servers whose registry route is unreliable. Runs on a Linux runner.
set -euo pipefail

backend_image="${1:?backend image required}"
frontend_image="${2:?frontend image required}"
remote_host="${REMOTE_DEPLOY_TARGET%%:*}"
remote_path="${REMOTE_DEPLOY_TARGET#*:}"
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=30 -o StrictHostKeyChecking=accept-new
  -o ServerAliveInterval=30 -o ServerAliveCountMax=2 -T -i "${HOME}/.ssh/id_deploy")
printf -v ssh_command '%q ' ssh "${ssh_opts[@]}"
bounded() { timeout --signal=TERM --kill-after=10s "$@"; }

archive="$(mktemp "${RUNNER_TEMP:-/tmp}/jobmatch-images.XXXXXX")"
remote_archive="${remote_path}/.deploy-images/${archive##*/}.tar.gz"
printf -v archive_q '%q' "$remote_archive"
printf -v directory_q '%q' "${remote_path}/.deploy-images"
cleanup() {
  local status=$?
  rm -f -- "$archive"
  bounded 30s ssh "${ssh_opts[@]}" "$remote_host" "rm -f -- ${archive_q}" || true
  exit "$status"
}
trap cleanup EXIT
started="$(date +%s)"

# GitHub's runner pulls over its own registry route; the production server only
# needs its existing SSH connection. Both pulls must succeed before export.
bounded 5m docker pull "$backend_image" &
backend_pid=$!
bounded 5m docker pull "$frontend_image" &
frontend_pid=$!
backend_status=0
frontend_status=0
wait "$backend_pid" || backend_status=$?
wait "$frontend_pid" || frontend_status=$?
if (( backend_status != 0 || frontend_status != 0 )); then
  echo "::error::Runner 镜像下载失败，停止 SSH 传输" >&2
  exit 1
fi

bounded 5m bash -o pipefail -c 'docker save "$@" | gzip -1' -- \
  "$backend_image" "$frontend_image" > "$archive"
echo "METRIC image_transfer=ssh compressed_bytes=$(wc -c < "$archive")"
bounded 30s ssh "${ssh_opts[@]}" "$remote_host" "umask 077; mkdir -p -- ${directory_q}"

transferred=false
for attempt in {1..3}; do
  echo "==> SSH 上传镜像归档（第 ${attempt}/3 次，断点续传）"
  if bounded 5m rsync --partial --append-verify --protect-args --timeout=60 \
    -e "$ssh_command" "$archive" "${remote_host}:${remote_archive}"; then
    transferred=true
    break
  fi
  if (( attempt < 3 )); then sleep 10; fi
done
if [[ "$transferred" != true ]]; then
  echo "::error::SSH 镜像传输失败，保留正在运行的服务" >&2
  exit 1
fi

printf -v backend_q '%q' "$backend_image"
printf -v frontend_q '%q' "$frontend_image"
bounded 6m ssh "${ssh_opts[@]}" "$remote_host" \
  "bash -s -- ${archive_q} ${backend_q} ${frontend_q}" <<'REMOTE_LOAD'
set -euo pipefail
archive="$1"
backend_image="$2"
frontend_image="$3"
trap 'rm -f -- "$archive"' EXIT
timeout --signal=TERM --kill-after=10s 5m docker load --input "$archive"
# Validate both images before moving either deployment tag.
docker image inspect "$backend_image" "$frontend_image" >/dev/null
docker tag "$backend_image" job-matcher-backend:deploy
docker tag "$frontend_image" job-matcher-frontend:deploy
REMOTE_LOAD
echo "METRIC image_transfer=ssh elapsed_seconds=$(($(date +%s) - started))"
