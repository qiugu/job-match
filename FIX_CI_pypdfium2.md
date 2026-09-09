# 修复：CI 构建因 pypdfium2 下载超时失败

## 现象

CI（`docker compose build backend` → Dockerfile 的 `uv sync --frozen`）失败，报错：

```
× Failed to download `pypdfium2==5.13.0`
  ├─▶ Failed to extract archive: pypdfium2-5.13.0-...-manylinux...whl
  ├─▶ I/O operation failed during extraction
  ╰─▶ Failed to download distribution due to network timeout.
      Try increasing UV_HTTP_TIMEOUT (current value: 30s).
```

## 根因

- `pyproject.toml` 声明了 `markitdown[pdf]>=0.1.7`，其 `[pdf]` extra 经
  `pdfplumber`(0.11.10) 传递拉入 `pypdfium2`(5.13.0)（manylinux wheel ~3.7MB）。
- 全仓 grep 确认：**代码没有任何 `markitdown` / `pdfplumber` / `pypdfium2` 的 import**，
  PDF 能力实际由 `pypdf`（`app/services/pdf_parser.py`）+ `pymupdf`/`pymupdf4llm` 提供，
  且 `pymupdf` 不依赖 `pypdfium2`。即 `markitdown[pdf]` 是**未使用的冗余依赖**。
- 在默认 `UV_HTTP_TIMEOUT=30s` 下，该重型间接包下载/解包超时，阻塞了整个构建。

## 修复方案（已执行）

**方案 A（根因修复）+ 防御性兜底**，共改动 3 个文件：

1. **移除冗余依赖**：`uv remove markitdown`
   - `pyproject.toml` 删除 `markitdown[pdf]` 一行；`uv.lock` 同步移除整条子树
     （markitdown / pdfplumber / pypdfium2 及独占依赖 beautifulsoup4、cffi、cryptography、
     defusedxml、magika、markdownify、pdfminer-six、pycparser、six、soupsieve，共 13 个包）。
   - 验证：移除后 `uv.lock` 中上述包引用计数均为 0；`pypdfium2` 目录已从 `.venv` 消失。
2. **Dockerfile 增加超时兜底**：在 `ENV` 中加 `UV_HTTP_TIMEOUT=300`
   - 仅作防御性兜底，防止真实依赖偶发网络抖动；主修复仍是移除未使用依赖。
   - 锁文件格式保持 `version = 1, revision = 3`，与 Dockerfile 固定的 `uv:0.12.9` 兼容
     （本地用 `uv 0.11.7` 重生 lock，已通过 `--frozen` 一致性校验）。

## 验证结果

- `uv lock --check`：通过（解析 92 包，无漂移）。
- `uv sync --frozen --no-install-project --no-dev`：成功（Exit 0），证明 lock 在
  `--frozen` 下完全自洽，CI 路径可重建。
- `uv run python -m pytest -q`：**111 passed**（仅 `pymupdf` 的 SwigPyObject 弃用警告，
  与本次改动无关，属既有现象）。
- 真实依赖导入正常：`pypdf` / `pymupdf` / `playwright` / `fastapi` / `langgraph` 均 OK。

## 影响面

- 镜像体积减小、构建更快、依赖攻击面收窄（移除 13 个未使用包）。
- 不影响任何业务功能（PDF 解析/导出/匹配均不依赖 markitdown 链）。

## 后续建议（可选）

- 若未来确需 office/PDF 文档解析，优先复用现有 `pymupdf`/`pypdf`，避免再次引入
  `markitdown[pdf]` 这类携带重型原生 wheel 的依赖；必要时应单独评估并固定版本。
