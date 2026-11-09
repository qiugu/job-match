"""浏览路径归一化：把 URL 变体收敛成稳定的页面标识。

后端统一归一化（前端只上报原始 pathname），规则只存在一处，且匿名端点收到
的 path 不可信——伪造带随机段的 path 曾可绕过按路径去重的旧口径。

处理顺序：去 query/fragment → 剥离 locale 前缀 → 动态 ID 段替换为 :id →
压缩重复斜杠与末尾斜杠 → 截断到列宽。
"""
from __future__ import annotations

import re
from urllib.parse import urlsplit

MAX_PATH_LENGTH = 255

_LOCALE_PREFIX = re.compile(r"^/(?:zh|en)(?=/|$)", re.IGNORECASE)
# 32 位 hex（项目内 workbench id）、带连字符 UUID、纯数字自增 id。
_DYNAMIC_SEGMENT = re.compile(
    r"(?:[0-9a-f]{16,32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)",
    re.IGNORECASE,
)


def normalize_visit_path(raw: str) -> str:
    """归一化单条路径；空串/异常输入一律收敛为根路径 ``/``。"""
    raw = (raw or "").strip()
    # urlsplit 会把以 // 开头的字符串误判成 netloc（协议相对 URL），例如
    # //app///dashboard 只剩 ///dashboard。埋点只收路径，故按纯路径处理。
    if raw.startswith("//"):
        path = raw.split("?", 1)[0].split("#", 1)[0] or "/"
    else:
        path = urlsplit(raw).path or "/"
    if not path.startswith("/"):
        path = "/" + path
    path = _LOCALE_PREFIX.sub("", path) or "/"
    segments = [":id" if _DYNAMIC_SEGMENT.fullmatch(seg) else seg for seg in path.split("/")]
    normalized = re.sub(r"/{2,}", "/", "/".join(segments))
    if len(normalized) > 1:
        normalized = normalized.rstrip("/") or "/"
    return normalized[:MAX_PATH_LENGTH]
