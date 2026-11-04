"""JD 截图 → 文本预处理：多模态 JD 输入的适配层。

架构决策（preprocessing adapter）
---------------------------------
既有匹配 / 话术链路全部是「纯文本 prompt + json_mode 结构化输出」，把图片
直接塞进 LangGraph 节点会破坏 structured output 与思考模型兼容性，且需改动
所有节点与状态类型。因此在进入既有链路之前，先用一次多模态 LLM 调用把 JD
截图转写为纯文本，再并入 jd_text：

- 无图片时：零额外 LLM 调用、原样返回，旧行为完全不变（关键回归保证）。
- 有图片时：识别结果以显式分隔块追加；岗位卡 / 衍生简历 / 话术快照存的都
  是合并后的文本，后续「恢复 JD 上下文」不会丢图片信息。
- 识别失败：显式抛错并由 API 层转 503，绝不静默丢弃用户上传的图片。

安全边界
--------
后端只接受 ``data:image/<mime>;base64,...``，不接受任意 URL —— 外链图片由
前端经 /image-proxy 抓取后转为 data URL，避免服务端 SSRF。同时限制数量、
单张解码后大小与总大小；MIME 白名单排除 SVG（可执行脚本载体）。
"""
from __future__ import annotations

import base64
import binascii
from typing import Sequence

from app.core.llm import get_llm, is_configured
from app.core.logging import get_logger
from app.core.prompts import JD_IMAGE_OCR_SYSTEM

logger = get_logger("jd_images")

# 与前端 frontend/src/lib/jdImages.ts 的常量保持同步；改动需两端一致。
MAX_JD_IMAGES = 4
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024
ALLOWED_IMAGE_MIME = frozenset(
    {"image/png", "image/jpeg", "image/webp", "image/gif"}
)

JD_IMAGE_BLOCK_MARKER = "【JD 截图识别内容】"


class JDImageError(ValueError):
    """JD 图片不合法；API 层据此返回 400（不预扣积分）。"""


def _parse_data_url(image: str) -> tuple[str, bytes]:
    """解析并解码 data URL，返回 (mime, 原始字节)；不合法抛 JDImageError。"""
    if not isinstance(image, str) or not image.startswith("data:"):
        raise JDImageError("JD 图片必须是 data URL（不支持外链直传）")
    header, sep, payload = image.partition(",")
    if not sep or not header.endswith(";base64"):
        raise JDImageError("JD 图片格式不正确（应为 data:image/...;base64,...）")
    mime = header[len("data:") : -len(";base64")]
    if mime not in ALLOWED_IMAGE_MIME:
        raise JDImageError(f"不支持的图片类型：{mime or '未知'}")
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise JDImageError("JD 图片 base64 编码无效") from exc
    if not raw:
        raise JDImageError("JD 图片内容为空")
    return mime, raw


def validate_jd_images(images: Sequence[str] | None) -> list[str]:
    """校验图片列表并原样返回；``None`` / 空列表返回 ``[]``。

    在 API 层扣积分之前调用，保证非法输入不产生任何费用或 LLM 调用。
    """
    if not images:
        return []
    # str 本身也是 Sequence[str]，显式拒绝，避免逐字符校验。
    if not isinstance(images, (list, tuple)):
        raise JDImageError("JD 图片列表格式不正确")
    if len(images) > MAX_JD_IMAGES:
        raise JDImageError(f"JD 截图最多 {MAX_JD_IMAGES} 张")

    total = 0
    for image in images:
        _, raw = _parse_data_url(image)
        if len(raw) > MAX_IMAGE_BYTES:
            raise JDImageError("单张 JD 图片超过 4MB，请压缩后重试")
        total += len(raw)
        if total > MAX_TOTAL_IMAGE_BYTES:
            raise JDImageError("JD 图片总大小超过 8MB，请减少图片数量")
    return list(images)


def _content_to_text(content: object) -> str:
    """把 LLM 响应内容归一化为纯文本（兼容 str / list[dict] 多模态返回）。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)
    return ""


async def extract_jd_text_from_images(
    images: Sequence[str], existing_jd_text: str = ""
) -> str:
    """一次多模态调用，把 JD 截图忠实转写为纯文本。

    复用 app.core.llm.get_llm()（与简历 PDF 图片导入同一客户端），因此
    要求所配置的 LLM_MODEL 支持视觉输入；不支持时由厂商返回错误，
    API 层转成 503 并给出明确提示。
    """
    if not is_configured():
        raise RuntimeError("LLM 未配置：请在 .env 设置 LLM_API_KEY 等参数")

    hint = (
        "用户已填写的 JD 文本如下，仅作上下文参考，请勿原样复述：\n"
        f"{existing_jd_text[:2000]}"
        if existing_jd_text.strip()
        else "用户未填写 JD 文本，请完整转写截图中的岗位描述。"
    )
    parts: list[dict] = [{"type": "text", "text": hint}]
    parts.extend(
        {"type": "image_url", "image_url": {"url": img}} for img in images
    )

    llm = get_llm(temperature=0)
    resp = await llm.ainvoke(
        [
            {"role": "system", "content": JD_IMAGE_OCR_SYSTEM},
            {"role": "user", "content": parts},
        ]
    )
    text = _content_to_text(resp.content).strip()
    if not text:
        raise RuntimeError("JD 截图未能识别出文字，请更换更清晰的截图")
    logger.info("JD 截图识别完成 | images=%d chars=%d", len(images), len(text))
    return text


async def resolve_jd_text(jd_text: str, images: Sequence[str] | None) -> str:
    """把 JD 截图识别结果并入 jd_text；无图片时原样返回（零副作用）。"""
    validated = validate_jd_images(images)
    if not validated:
        return jd_text

    recognized = await extract_jd_text_from_images(validated, jd_text)
    block = f"{JD_IMAGE_BLOCK_MARKER}\n{recognized}"
    base = jd_text.strip()
    return f"{base}\n\n{block}" if base else block
