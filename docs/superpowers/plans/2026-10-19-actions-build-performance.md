# Actions 构建耗时优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 消除可确认的串行构建和缓存配置问题，并限制异常网络操作的等待时间。

**Architecture:** 使用 backend/frontend matrix 在独立 runner 上构建，通过 build-push-action 接入 GHA 缓存。两镜像成功后才部署，手动 no_build 保留。远端并行拉取采用有界重试，失败不进入数据库迁移。

**Tech Stack:** GitHub Actions、Docker BuildKit、Bash、pytest。

## Global Constraints

- 保留工作区已有暂存修改、镜像注册表配置、数据库备份及 TLS 流程。
- 用户提供的日志确认 Pull images on server 耗时约 3 小时、backend 拉取已到第 6/8 次；具体网络故障类型仍需错误行，不能由 Download complete 推断。
- 不推送、不触发生产部署；本地 Docker daemon 不可用，完整镜像验证待 CI。

## Task 1: 并行构建与缓存

Files: `.github/workflows/deploy.yml`, `README.md`。

- [x] 使用 matrix include 配置 backend (`context: .`, `file: Dockerfile`, `PLAYWRIGHT_DOWNLOAD_HOST=`) 和 frontend (`context: ./frontend`, `file: frontend/Dockerfile`, 原 VITE 参数)。
- [x] 把现有登录逻辑移到 build job；保留 production 环境中的注册表凭据。用 `docker/build-push-action@v6`、`push: true`、`platforms: linux/amd64`、小写 SHA tag 构建。
- [x] 保留 `job-matcher-backend` / `job-matcher-frontend` 独立缓存 scope，缓存导出 `mode=max,timeout=5m,ignore-error=true`，导入 `timeout=5m`。
- [x] build job 超时 30 分钟；deploy 依赖 build，仅 success 或 no_build 导致的 skipped 时运行，deploy 超时 40 分钟。保持部署 concurrency 不取消进行中的发布。
- [x] 解析 YAML、逐段 `bash -n`，运行现有 `tests/test_deploy_workflow.py`。

## Task 2: 有界镜像拉取

Files: `.github/workflows/deploy.yml`, `tests/test_deploy_workflow.py`。

- [x] 先增加执行工作流内远端 Bash 的回归测试，模拟 docker、timeout、sleep：首次成功、失败后恢复、持续失败、超时后重试；失败不能执行 docker tag。
- [x] 运行 `.venv/bin/pytest tests/test_deploy_workflow.py -q`，确认持续失败及超时约束测试在修改前失败。
- [x] `for attempt in {1..3}`；每次 `timeout --signal=TERM --kill-after=10s 2m docker pull`；保留并行 wait 和耗时输出，新增失败退出码；step 超时 8 分钟，失败转 SSH 兜底。
- [x] 重跑回归测试，确认失败先于迁移，现有拉取指标和注册表配置不退化。

## Task 3: 减少浏览器下载与镜像体积

Files: `Dockerfile`, `README.md`。

- [x] 应用使用默认无头 Chromium 且无 channel/executable_path；安装命令改为 `.venv/bin/playwright install --with-deps --only-shell chromium`。
- [x] 保留本地 Dockerfile 的镜像源默认值，CI build arg 置空使用官方源。
- [x] 更新缓存说明：cache mount 不等于跨 GitHub runner 持久化；依赖层变化可能让浏览器层重建。
- [x] 检查 Playwright CLI 支持 --only-shell，运行已有 PDF 导出相关测试，检查 `git diff --check`。

## Validation limits

GitHub API 匿名读取返回 404，本机缺少 gh。通过 Chrome 已登录页面读取运行 39225335600：提交 b3bf6e3，Deploy 仍在运行，观察时耗时 3h24m29s；详细 job 页面未能加载。随后用户提供步骤日志：Pull images on server 耗时 3 小时，backend 正在第 6/8 次拉取，多个相同 layer 再次显示 Download complete。主要瓶颈已定位为服务器拉取和重试，不是编译。首次构建仍可能冷缓存；超时只是异常保护，不能作为已实现加速的证据。

验证：部署、SSH 传输与 PDF 相关测试 29 passed；官方 actionlint 1.7.12（下载校验和通过；shellcheck/pyflakes 未安装）通过；YAML 解析及 shell 的 bash -n 通过；Playwright --dry-run --only-shell 确认仅选择 Headless Shell 与 FFmpeg。Docker daemon 未运行，未执行完整镜像构建或 Linux Chromium 渲染。

参考：
- https://docs.docker.com/build/cache/backends/gha/
- https://playwright.dev/python/docs/browsers
- https://github.com/qiugu/job-match/actions/runs/39225335600


## Task 4: 根据实际日志增加 SSH 传输兜底

Files: `.github/scripts/transfer-images.sh`, `.github/workflows/deploy.yml`, `tests/test_image_transfer.py`, `README.md`。

- [x] 增加命令边界测试，验证 rsync 第一次失败后恢复、连续三次失败停止，传输未完成不能加载；新增脚本前观察测试失败。
- [x] Runner 使用现有注册表凭据拉取两镜像，`docker save | gzip -1` 归档；通过现有 SSH 凭据使用 rsync `--partial --append-verify` 传输，远端 `docker load` 后验证两镜像存在才更新部署 tag。
- [x] 服务器直拉 `continue-on-error: true`，只有该步骤 outcome=failure 时才启动兜底；兜底没有 continue-on-error，失败阻止数据库迁移。no_build 时两个步骤都跳过。
- [x] 兜底 step 超时 25 分钟，deploy job 超时 40 分钟；下载、归档、传输、加载各有子命令超时。保留部署不取消策略。
- [x] 补充远端加载或镜像检查失败不打部署 tag、成功/失败清理临时归档的执行测试。
- [x] 文档说明兜底会传完整归档，需要额外磁盘；普通退出清理临时文件，强制终止可能遗留 `.deploy-images/` 文件。

本次未推送、未取消运行中的部署、未重启生产服务。SSH 兜底的生产带宽与完整镜像加载耗时待下次部署测量。
