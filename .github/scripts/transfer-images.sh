#!/usr/bin/env bash
# Transfer build artifacts to the production server and load them locally.
# This script intentionally never contacts an image registry.
set -euo pipefail

backend_archive="${1:?backend archive required}"
frontend_archive="${2:?frontend archive required}"
backend_image="${3:?backend image tag required}"
frontend_image="${4:?frontend image tag required}"

for archive in "$backend_archive" "$frontend_archive"; do
  [[ -s "$archive" ]] || {
    echo "::error::镜像归档不存在或为空: $archive" >&2
    exit 1
  }
done

remote_host="${REMOTE_DEPLOY_TARGET%%:*}"
remote_path="${REMOTE_DEPLOY_TARGET#*:}"
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=30 -o StrictHostKeyChecking=accept-new
  -o ServerAliveInterval=30 -o ServerAliveCountMax=4 -T -i "${HOME}/.ssh/id_deploy")
printf -v ssh_command '%q ' ssh "${ssh_opts[@]}"
bounded() { timeout --signal=TERM --kill-after=10s "$@"; }

remote_dir="${remote_path}/.deploy-images"
backend_remote_archive="${remote_dir}/$(basename -- "$backend_archive")"
frontend_remote_archive="${remote_dir}/$(basename -- "$frontend_archive")"
printf -v remote_dir_q '%q' "$remote_dir"
printf -v backend_remote_archive_q '%q' "$backend_remote_archive"
printf -v frontend_remote_archive_q '%q' "$frontend_remote_archive"

started="$(date +%s)"
cleanup() {
  local status=$?
  if (( status == 0 )); then
    bounded 30s ssh "${ssh_opts[@]}" "$remote_host" \
      "rm -f -- ${backend_remote_archive_q} ${frontend_remote_archive_q}" || true
  else
    echo "::warning::保留服务器上的临时归档，便于下次 rsync 断点续传: ${remote_dir}" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

bounded 30s ssh "${ssh_opts[@]}" "$remote_host" \
  "umask 077; mkdir -p -- ${remote_dir_q}"

transfer_archive() {
  local local_archive="$1" remote_archive="$2" label="$3"
  local attempt
  for attempt in {1..3}; do
    echo "==> SSH 上传 ${label} 镜像归档（第 ${attempt}/3 次，支持断点续传）"
    # The 55m limit is per attempt; --timeout=60 is only an idle timeout.
    if bounded 55m rsync --partial --append-verify --protect-args --timeout=60 \
      -e "$ssh_command" "$local_archive" "${remote_host}:${remote_archive}"; then
      echo "METRIC image_transfer=ssh image=${label} compressed_bytes=$(wc -c < "$local_archive")"
      return 0
    fi
    if (( attempt < 3 )); then
      echo "    ${label} 上传中断，10s 后重试"
      sleep 10
    fi
  done
  echo "::error::${label} 镜像归档 SSH 传输失败" >&2
  return 1
}

transfer_archive "$backend_archive" "$backend_remote_archive" backend
transfer_archive "$frontend_archive" "$frontend_remote_archive" frontend

printf -v backend_image_q '%q' "$backend_image"
printf -v frontend_image_q '%q' "$frontend_image"
bounded 15m ssh "${ssh_opts[@]}" "$remote_host" \
  "bash -s -- ${backend_remote_archive_q} ${frontend_remote_archive_q} ${backend_image_q} ${frontend_image_q}" <<'REMOTE_LOAD'
set -euo pipefail
backend_archive="$1"
frontend_archive="$2"
backend_image="$3"
frontend_image="$4"

timeout --signal=TERM --kill-after=10s 10m docker load --input "$backend_archive"
timeout --signal=TERM --kill-after=10s 10m docker load --input "$frontend_archive"

# Validate both images before moving either deployment tag.
docker image inspect "$backend_image" "$frontend_image" >/dev/null
docker tag "$backend_image" job-matcher-backend:deploy
docker tag "$frontend_image" job-matcher-frontend:deploy
docker image inspect job-matcher-backend:deploy job-matcher-frontend:deploy >/dev/null
REMOTE_LOAD

echo "METRIC image_transfer=ssh elapsed_seconds=$(($(date +%s) - started))"
