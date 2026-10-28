# 修复：GitHub Actions 部署在前端镜像构建阶段失败（BRAND_ACCENT is not exported）

- 时间：2026-10-28
- 影响：`Deploy to Server` workflow 的 `Build images on remote` 步骤失败 ⇒ 后续 `docker compose up -d`
  未执行 ⇒ **生产环境自 10-25 那次部署起一直停留在旧镜像**（构建失败不会重启容器，用户侧无感知）。
- 结论先行：**不是代码错误，是部署链路把服务器上的代码树同步成了「新旧混合」状态。**

## 1. 报错

```
[+] Building ...
 > [frontend builder 2/2] RUN pnpm run build:
16 | import {
17 |   BRAND_ACCENT,
   |   ^
ERROR: "BRAND_ACCENT" is not exported by "src/components/analytics/tokens.ts",
        imported by "src/components/analytics/options.ts"
```

`/app/src/components/analytics/options.ts:16:2` 是 Docker 内的路径，说明错误发生在**服务器本地构建**
镜像时（`deploy.yml` → `docker compose build frontend`），而非 Actions runner 上的源码。

## 2. 关键线索：报错行号与仓库历史版本逐字吻合

`options.ts` 的 import 块在历史上有过两个形态：

| 版本（commit）       | `options.ts` 字节 | `tokens.ts` 字节 | options 引用 `BRAND_ACCENT` | tokens 导出 `BRAND_ACCENT` |
| -------------------- | ----------------: | ---------------: | :-------------------------: | :------------------------: |
| `095a3d5^`（Phase 4 前） |             12707 |             5000 |             是              |             是             |
| `095a3d5`（Phase 4 换血） |             12638 |             5324 |             否              |             否             |
| `bc9b04c`（HEAD 前一次） |             12696 |             5324 |             否              |             否             |

报错里 `16:2 → BRAND_ACCENT`、`17:2 → axisColors`、`18:2 → mixHex`，与 `095a3d5^`（**Phase 4 之前**）
的 import 顺序完全一致；而 `tokens.ts` 报「不导出 BRAND_ACCENT」说明它已经是 `≥095a3d5` 的新版。

即：**服务器上的 `options.ts` 停留在 Phase 4 之前，同目录的 `tokens.ts` 已更新到新版。**
一次干净的 `actions/checkout` 不可能产出这种混合树（同一 commit 内部自洽），故只能是**上传环节漏传**。

## 3. 根因：`rsync --append-verify` 的语义与代码同步不兼容

`deploy.yml` 的上传步骤原先使用：

```bash
RSYNC_ARGS=(-az --partial --append-verify --timeout=60 ...)
```

`--append` / `--append-verify` 的设计语义是「**接收端文件是发送端文件的前缀**」，只适用于续传
同一份文件（大归档、镜像）。落到代码树上会产生一个静默的破坏性行为：

> 若某个文件本次**变短**（接收端反而更长），rsync **整份跳过**，不报错、不警告。

于是出现了这次事故的组合：

- `tokens.ts`：5000 → 5324（变长）⇒ 被追加/重传 ⇒ 服务器上是新版；
- `options.ts`：12707 → 12638（**变短 69 字节**）⇒ 被跳过 ⇒ 服务器上停在 Phase 4 之前。

而且这种偏离是**持续性**的：之后每次部署 rsync 都「看似成功」（该文件始终被跳过），
直到某次改动让它重新变长，或者构建报一个看似无关的错。本次属于后者。

> 旁证：上传前的「统计代码上传规模」空跑也用了同一组参数，因此它对被跳过的文件同样不计字节，
> 预演数字偏小，掩盖了问题。

## 4. 复现（本地最小验证）

本机 rsync 2.6.9（`--append` 与 `--append-verify` 共用「接收端 ≥ 发送端则跳过」这一判定）：

```
初始：两端同为 100 字节
发送端改为 80 字节后执行 rsync -a --append
  → 接收端仍为 100 字节（未更新，且退出码 0）
改为 rsync -a --partial（去掉 append）
  → 接收端 80 字节（正确更新）
```

## 5. 修复

`.github/workflows/deploy.yml`，上传步骤两处改动：

1. **移除 `--append-verify`**，并在参数组上方写明禁止原因与事故引用（防止日后被「优化」回去）。
   断点续传由 `--partial` 承担——保留半截文件，下次按 delta 算法正确续传，语义安全。
2. **新增「上传后一致性校验」**（后置条件断言）：

   ```bash
   rsync --dry-run --checksum --itemize-changes -e "$RSYNC_SSH" "${RSYNC_ARGS[@]}" ./ "$REMOTE/" \
     | grep -E '^>f' | grep -vE '^>f\.\.t'
   ```

   只要**内容层面**仍有待传文件就 `exit 1` 并列出清单，拒绝用混合代码树构建镜像；
   仅时间戳不同（`>f..t......`）的正常抖动不误报。

这样把「静默偏离」变成「显式失败」，下一次同类问题会在上传步骤末尾直接暴露，而不是等到
`docker build` 里冒出一个与该文件毫不相干的报错。

## 6. 验证

| 项目 | 方法 | 结果 |
| ---- | ---- | ---- |
| YAML 合法性 | `python3 -c "yaml.safe_load(...)"` | 通过 |
| 上传步骤 shell 语法 | `bash -n`（从 YAML 提取 run 块） | 通过（exit 0） |
| 参数已移除 | 正则 `^\s+--append-verify` 全文件检索 | 无匹配（仅保留注释中的说明） |
| 漂移检测语义 | 本地三文件样本（变短 / 变长 / 仅改 mtime） | 变短与变长被标记，mtime 抖动不误报 |
| 修复后自愈 | 去掉 append 后重跑 rsync | 变短文件正确更新，漂移检测归零 |
| 前端导出契约 | `tokens.ts` 导出 vs `options.ts` 导入（axisColors / mixHex / stageColor / ChartTokens） | 全部匹配 |

**服务器侧无需人工干预**：去掉 `--append-verify` 后，下次部署的「快速检查」（大小 + mtime）
一定会判定 `options.ts` 需要更新（当前 12696 ≠ 服务器 12707，且 mtime 不同），自动纠正为正确版本。

## 7. 与同期提交 `9db626c` 的关系（必读）

本次修复完成后，仓库里又落了一个提交 `9db626c fix(deploy): 强制无缓存重建并清理陈旧 .js 阴影`，
它**包含**本文第 5 节的两处 rsync 改动（保留），同时追加了两处基于另一套根因推断的改动。
结论：那两处对本次报错**没有因果关系**，其中 `--no-cache` 有明确成本而无收益。

| 追加改动 | 关于「陈旧 `.js` 遮蔽 `.ts`」的核查 | 建议 |
| --- | --- | --- |
| `find ${RP}/frontend/src -name '*.js' -delete` | `git log --all` 显示 `frontend/src` 在**任何历史提交**中都未出现过 `.js` 文件；`vite.config.ts` 也没有覆写 `resolve.extensions` | 无害的卫生检查，可留，但**不能**作为根因依据 |
| `docker compose build --no-cache backend/frontend` | Docker 对 `COPY . .` 的层缓存以**内容校验和**为键，源码变动必然失效并重跑 `RUN pnpm run build`，不会出现「源码已改却复用旧编译层」 | 建议回退为增量构建：每次部署全量重建两个镜像，成本显著、收益为零 |

该推断与报错文本直接冲突，有两条硬反证：

1. **文件名**：报错写的是 `"BRAND_ACCENT" is not exported by "src/components/analytics/tokens.ts"`。
   若真是旧的 `tokens.js` 遮蔽 `.ts`，模块 id 会显示 `tokens.js`，而不是 `tokens.ts`。
2. **行内容**：报错引用 `options.ts:16` 的内容为 `BRAND_ACCENT,`，而 HEAD 版 `options.ts` 第 16 行是
   `mixHex,`。`.js` 遮蔽只能改变「解析到哪个文件」，**不能改变 `.ts` 文件内部某一行的内容**。
   唯一解释是被编译的 `options.ts` 本身是旧版 —— 即第 3 节的「接收端更长 ⇒ 整份跳过」。

### 7.1 追记：`--no-cache` 的实际代价（已回退）

`9db626c` 把 `--no-cache` 写死进每次部署后，构建耗时从**约 3 分钟涨到 40 分钟以上仍未完成**。
机制很清楚：常态 3 分钟的构建是「只重跑 `COPY . .` + `RUN pnpm run build`」这两层；
`--no-cache` 让 `deps`、`prod-deps`、`uv sync` 全部重来 —— pnpm 要把上千个包重新 link 到
overlayfs（而且是 deps / prod-deps 两遍），在小规格 VPS 上是数量级的差异。

同时排除另一个嫌疑：本文第 5 节新增的漂移校验在本机对全仓（含全量 checksum 比对）实测
**3.8 秒**，不构成分钟级影响。

现处理：`--no-cache` 改为 `workflow_dispatch` 的 `force_rebuild` 手动开关（默认 false），
常态走层缓存。除了性能，它**存在的前提本身也不成立**，见下节。

### 7.2 为什么「复用缓存 ⇒ 编译到旧源码」不成立

Docker 官方文档对 `COPY` / `ADD` 的缓存判定写得很明确
（https://docs.docker.com/build/cache/invalidation/）：

> "For the `ADD` and `COPY` instructions … the builder calculates a cache checksum from file metadata
> to determine whether cache is valid. During cache lookup, cache is invalidated if the file metadata
> has changed for any of the files involved."
>
> "The modification time of a file (`mtime`) is not taken into account when calculating the cache
> checksum. If only the `mtime` of the copied files have changed, the cache is not invalidated."

由此有两条结论：

1. **内容变了 ⇒ `COPY . .` 层失效 ⇒ 后续 `RUN pnpm run build` 必然重跑。** 所以「层缓存把旧源码编出来」在
   `COPY . .` + `RUN` 这种结构里没有发生路径。
2. **只有 mtime 变、内容没变 ⇒ 缓存仍然命中。** 这一条正好解释了「3 分钟构建」为何能成立：
   `actions/checkout` 让所有文件 mtime 都是新的，但因为内容校验和不变，`pnpm install` / `build` 层照样复用。

更直接的一条反证与机制无关，只看现象：**缓存命中意味着 `RUN` 根本不执行，也就不可能报 rollup 错误。**
本次是一个具体的编译错误（rollup 解析源码失败），说明 bundler 确实跑了、且读到的 `options.ts`
第 16 行是 `BRAND_ACCENT` —— 镜像里的文件内容本身就是旧的。这只能是**上传环节没更新文件**（第 3 节），
而不是缓存。

真正需要 `--no-cache` 的场景很窄，且都是一次性排障：`--mount=type=cache` 的 pnpm store / corepack
缓存损坏、基础镜像 tag 漂移但仍要强制重拉、或已排除其他因素后怀疑层损坏。这类场景按需手动触发即可，
不该写进每次部署。

## 8. 附：CI 门禁的三条故障线（独立于本次部署事故）

`ci.yml` 自 2026-10-28 18:46 接入后三次运行全红（`7de70ab`、`9db626c`、`b506626` 各一次），
与部署链路无关，是三条独立问题叠在一起。

### 8.1 前端作业：pnpm 版本无法解析（已修，证据确凿）

GitHub API 返回的注解原文：

> Error: No pnpm version is specified.
> Please specify it by one of the following ways:
>  - in the GitHub Action config with the key "version"
>  - in the package.json with the key "packageManager"

机制：`pnpm/action-setup@v4` 未给 `version`，只能读 `packageManager`；而它默认在**仓库根目录**
找 `package.json` —— 本仓库根目录没有（后端是 `pyproject.toml`，前端在 `frontend/`）。
`defaults.run.working-directory: frontend` **只作用于 `run` 步骤，对 `uses` 步骤无效**，
所以该 action 在 0 秒内失败，后续 5 个步骤全部 skipped。

修法：显式 `with: package_json_file: frontend/package.json`，版本仍以
`frontend/package.json` 的 `packageManager: pnpm@8.14.3` 为唯一来源（与 Dockerfile 的 corepack 一致）。

顺带验证：`pnpm test -- --reporter=dot` 的参数透传在 pnpm 8 下正常（本地实跑 187 用例通过），
故该步骤无需改动。

### 8.2 后端作业：3 个部署契约测试被 deploy.yml 改动打破（已修）

`tests/test_deploy_workflow.py` 对 `deploy.yml` 做源码级断言，本次改动命中其中三处：

| 测试 | 失败原因 |
| --- | --- |
| `test_deploy_workflow_builds_images_on_server_without_registry_or_archives` | 断言字面串 `build backend`，而命令已变为 `build ${CACHE_FLAG} backend` |
| `test_remote_build_reuses_docker_layers_for_playwright_cache` | 同上（该测试的本意是「默认复用层缓存」，与参数化并不冲突） |
| `test_deploy_builds_images_on_server_and_does_not_transfer_archives` | 同上 |

**更值得记的是第四个测试**：`test_code_upload_excludes_local_worktrees_and_has_transfer_guardrails`
原本断言 `"--append-verify" in text` —— 等于把第 3 节的缺陷**钉成了规范**。移除该 flag 后，
这条断言其实仍在通过，但只是因为我写的注释里提到了它，属于「假绿」。

修法（改测试而非迁就代码，但只放松字面耦合、保留性质断言）：

- 构建命令改为正则 `build (?:[^\s]+ )?backend|frontend`（允许一个可选 flag）；
- 新增性质断言：`"build --no-cache" not in text`（默认复用缓存）+ 全量重建只能来自 `force_rebuild`；
- 参数类断言改为在 **`RSYNC_ARGS=( … )` 参数块内**进行，并**反转方向**：
  `"--append-verify" not in args`、`"--partial" in args`，同时要求存在
  `--checksum` / `--itemize-changes`（上传后一致性校验）。

### 8.3 后端作业：pytest `exit code 4`（部分修，待日志确认）

注解原文：`Process completed with exit code 4.` —— pytest 的 `4` 是 **usage error**（参数/配置层），
不是「用例失败」（那会是 1）。同一命令在本地（`pytest -q --basetemp=...`）exit 0、237 用例全过，
说明是 CI 侧的调用或环境差异，且与本次代码改动无关（`7de70ab` 那次同样报 4）。

已做的加固（机制上正确，但**尚未证实**就是这次的触发点）：

- `uv sync --no-dev` → `uv sync --frozen`。测试作业把 `pytest` / `pytest-asyncio` / `reportlab`
  排除在外本来就是错的（它们在 `[dependency-groups].dev` 里），此前只靠 `uv run` 的隐式二次同步兜底；
  `--frozen` 还能保证「lockfile 与 pyproject 不一致时直接失败」。
- 新增 `Show toolchain versions` 步骤，把 `python -V` 与 `pytest --version` 打进日志 ——
  下次若仍红，这两行足以判定是环境差异还是参数问题。
- 该步骤的完整日志需要仓库 admin 权限才能经 API 拉取，故此处无法直接引用；若加固后仍复现，
  需要人工提供该步骤的日志尾部。

## 9. 后续可选项（未实施，待决策）


1. **加 `pnpm build` 到 `ci.yml`**：当前 CI 只跑 lint / typecheck / test，不含生产构建。
   注意它**不会**拦住本次这类问题（干净 checkout 构建是通过的），价值在于其他真实构建错误
   能在 20 分钟的部署之前暴露。
2. **`--delete` 清理服务器上的历史残留文件**：`COPY . .` 会把服务器目录里的陈旧文件一并打进镜像，
   与本次问题同族。但需要先为服务器侧自有产物补 `--exclude`（`backups/`、`jdmatch.site*`、
   `*.pem`、`.tls_*.b64`），属改动删除语义，需单独评审。
3. **用 `--checksum` 传输代替默认的「大小 + mtime」快速检查**：`actions/checkout` 让所有文件
   mtime 都是「现在」，导致每次部署实际上全量重传；改为内容寻址可显著缩短上传时长，
   代价是两端各读一遍文件（本项目数千个小文件，成本可忽略）。
