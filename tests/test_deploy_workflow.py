"""deploy.yml 的源码级契约。

这些断言锁定的是**部署链路的性质**（服务器本地构建、不走 registry、不传归档、
默认复用构建层、断点可续传、上传后校验一致性），而不是某一行命令的字面写法——
链路上合法的演进（把 `--no-cache` 抽成手动开关、把构建命令参数化）不应让测试变红，
但违反性质的改动必须变红。

历史教训（2026-10-28）：
1. 本文件曾断言 `"--append-verify" in text` —— 等于把「rsync 变短文件被整份跳过」
   这个缺陷钉成了规范。该 flag 已移除，断言方向在此反转。
2. 本文件曾断言完整的 `build backend` 字面串，导致把构建参数抽成 ${CACHE_FLAG}
   之后测试误报失败 —— 现改用「允许一个可选 flag」的正则。
3. 参数类断言一律在 RSYNC_ARGS 参数块内进行，避免被说明性注释（会提到被禁用的
   flag）误判为「仍在使用」。
"""

import re
from pathlib import Path

WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "deploy.yml"

# 服务器本地构建命令：`build backend` 与 `build ${CACHE_FLAG} backend` 均视为合法。
BUILD_BACKEND = re.compile(r"docker compose --project-directory \$\{RP\} build (?:[^\s]+ )?backend")
BUILD_FRONTEND = re.compile(r"docker compose --project-directory \$\{RP\} build (?:[^\s]+ )?frontend")


def _read() -> str:
    return WORKFLOW.read_text()


def _rsync_args_block(text: str) -> str:
    """取出 RSYNC_ARGS=( ... ) 的实际参数，剔除注释行。"""
    start = text.index("RSYNC_ARGS=(")
    end = text.index(")", start)
    lines = text[start:end].splitlines()
    return "\n".join(ln for ln in lines if not ln.lstrip().startswith("#"))


def test_deploy_workflow_builds_images_on_server_without_registry_or_archives():
    text = _read()

    assert "\njobs:\n  deploy:" in text
    assert "Build images on remote" in text
    assert BUILD_BACKEND.search(text)
    assert BUILD_FRONTEND.search(text)
    assert "actions/upload-artifact@v4" not in text
    assert "actions/download-artifact@v4" not in text
    assert "Transfer images over SSH" not in text
    assert "docker save" not in text
    assert "docker pull" not in text


def test_remote_build_reuses_docker_layers_for_playwright_cache():
    text = _read()

    assert "复用 Docker 层缓存" in text
    build_step = text.split("- name: Build images on remote", 1)[1].split("- name:", 1)[0]
    assert " down " not in build_step
    assert " stop " not in build_step
    assert BUILD_BACKEND.search(text)
    assert BUILD_FRONTEND.search(text)

    # 默认必须复用层缓存：构建命令里不得出现无条件的 --no-cache；
    # 全量重建只能是显式开关（force_rebuild）的产物。
    assert "build --no-cache" not in text
    assert 'CACHE_FLAG="--no-cache"' in text
    assert "FORCE_REBUILD" in text


def test_code_upload_excludes_local_worktrees_and_has_transfer_guardrails():
    text = _read()
    args = _rsync_args_block(text)

    assert "--exclude '.worktrees/'" in text
    assert "--exclude '.workbuddy/'" in text
    assert "--exclude '.deploy-images/'" in text
    assert "--partial" in args
    assert "--timeout=60" in args
    assert "--info=progress2,stats2" in args
    assert "timeout --signal=TERM --kill-after=30s 25m" in text
    assert "timeout-minutes: 180" in text

    # 代码树同步禁止 --append / --append-verify：二者假定「接收端是发送端的前缀」，
    # 文件变短时整份跳过且不报错 ⇒ 服务器代码树新旧混合（2026-10-28 事故）。
    assert "--append-verify" not in args
    assert "--append " not in args
    # 上传后必须做一致性校验，把「静默偏离」变成显式失败。
    assert "--checksum" in text
    assert "--itemize-changes" in text


def test_deploy_builds_images_on_server_and_does_not_transfer_archives():
    text = _read()

    assert "Build images on remote" in text
    assert BUILD_BACKEND.search(text)
    assert BUILD_FRONTEND.search(text)
    assert "Transfer images over SSH" not in text
    assert 'docker save "$IMAGE_TAG"' not in text
