"""文本归一化工具：岗位卡查重与历史回填共用同一实现，保证语义一致。

归一化只折叠空白（含换行、全角空格、连续空格），不做语义近似——
避免不同 JD 因语义相似被错误归并到同一岗位卡。
"""
from __future__ import annotations

import re

_WS_RE = re.compile(r"\s+", flags=re.UNICODE)


def normalize_jd_text(text: str | None) -> str:
    """归一化岗位描述：trim + 折叠所有空白（含换行）为单个空格。

    用于岗位卡查重与历史数据归组。返回的字符串是「同一 JD 内容」的稳定指纹：
    仅空白差异（换行、缩进、尾随空格）视为同一 JD。
    """
    if not text:
        return ""
    return _WS_RE.sub(" ", text).strip()
