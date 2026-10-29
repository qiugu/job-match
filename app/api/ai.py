"""前端 AI 能力代理路由：润色 / 语法检查 / 简历导入 / 简历翻译。

前端不再持有 api_key，所有请求转发到这里，由后端使用环境变量中的
LLM_API_KEY 调用大模型。接口契约与前端 src/routes/api/*.ts 对齐。
"""
from __future__ import annotations

import json
from typing import List, Optional

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.api.deps import get_current_user
from app.core.logging import get_logger
from app.models.llm_usage import (
    ENDPOINT_AI_GRAMMAR,
    ENDPOINT_AI_POLISH,
    ENDPOINT_AI_RESUME_IMPORT,
    ENDPOINT_AI_TRANSLATE,
)
from app.models.user import User
from app.services import ai_proxy
from app.services.usage import track_llm

router = APIRouter(prefix="/api/ai", tags=["ai"])

logger = get_logger("ai")


class PolishRequest(BaseModel):
    content: str
    customInstructions: Optional[str] = None


class GrammarRequest(BaseModel):
    content: str


class ResumeImportRequest(BaseModel):
    content: Optional[str] = None
    images: Optional[List[str]] = Field(default_factory=list)
    locale: str = "zh"


class TranslateRequest(BaseModel):
    """简历文本字段翻译请求。

    fields 为「字段路径 → 待译文本」映射（前端 lib/resumeTranslate.ts 提取），
    只含可翻译文本；id/模板/排版/日期等非文本配置从不上传。
    """

    targetLang: str = "en"
    fields: dict[str, str] = Field(default_factory=dict)


# 单次请求的字段文本总长度上限（防滥用；256KB 足够覆盖超长简历 + markdown 正文）
TRANSLATE_MAX_TOTAL_CHARS = 256 * 1024


@router.post("/polish")
async def polish(req: PolishRequest, user: User = Depends(get_current_user)):
    """流式润色，返回 text/event-stream 纯文本流。

    需要登录：每次调用都会消耗后端 LLM 额度。
    """
    if not req.content or not req.content.strip():
        return StreamingResponse(iter([b""]), media_type="text/plain")

    async def event_stream():
        try:
            # 用量台账（Plan.md R1）：流式接口的 token 取决于厂商是否在流末回传 usage，
            # 缺失时 token 记 0，但调用次数与耗时仍会留痕（够 R2 按次限流用）。
            async with track_llm(ENDPOINT_AI_POLISH, user_id=user.id):
                async for chunk in ai_proxy.stream_polish(req.content, req.customInstructions):
                    yield chunk
        except RuntimeError as e:
            logger.warning("润色失败（可预期）: %s", e)
            yield f"[错误] {e}"
        except Exception as e:  # noqa: BLE001
            logger.exception("润色流式调用失败: %s", e)
            yield f"[错误] {e}"

    return StreamingResponse(event_stream(), media_type="text/plain; charset=utf-8")


@router.post("/grammar")
async def grammar(req: GrammarRequest, user: User = Depends(get_current_user)):
    """语法/错别字检查，返回 { choices:[{ message:{ content } }] }，content 为 errors JSON。

    需要登录：每次调用都会消耗后端 LLM 额度。
    """
    if not req.content or not req.content.strip():
        return {"choices": [{"message": {"content": json.dumps({"errors": []}, ensure_ascii=False)}}]}
    try:
        async with track_llm(ENDPOINT_AI_GRAMMAR, user_id=user.id):
            text = await ai_proxy.grammar_check(req.content)
    except RuntimeError as e:
        logger.warning("语法检查失败（可预期）: %s", e)
        return {"error": {"message": str(e), "code": "ConfigError"}}
    except Exception as e:  # noqa: BLE001
        logger.exception("语法检查调用失败: %s", e)
        return {"error": {"message": str(e)}}
    return {"choices": [{"message": {"content": text}}]}


@router.post("/resume-import")
async def resume_import(
    req: ResumeImportRequest, user: User = Depends(get_current_user)
):
    """从文本/图片结构化解析简历，返回 { resume: {...} }。

    需要登录：每次调用都会消耗后端 LLM 额度。
    """
    if not req.content and not req.images:
        return {"error": "Missing resume content or images"}
    try:
        async with track_llm(ENDPOINT_AI_RESUME_IMPORT, user_id=user.id):
            parsed = await ai_proxy.resume_import(req.content, req.images, req.locale)
    except RuntimeError as e:
        logger.warning("简历导入失败（可预期）: %s", e)
        return {"error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("简历导入调用失败: %s", e)
        return {"error": f"AI 解析失败：{e}"}
    return {"resume": parsed}


@router.post("/translate")
async def translate(req: TranslateRequest, user: User = Depends(get_current_user)):
    """把简历文本字段映射翻译为目标语言，返回 { fields: {同 key: 译文} }。

    契约（PLAN_resume_translate.md）：LLM 只译值、原样回传 key；响应中缺失的
    key 由前端合并时回退原文（部分成功可用）。多余 key 在服务层已丢弃。

    需要登录：每次调用都会消耗后端 LLM 额度（只记用量台账，不扣积分）。
    """
    if not req.fields:
        return {"error": {"message": "fields 不能为空", "code": "BadRequest"}}
    # 值类型已由 Pydantic（dict[str, str]）在 422 层校验，这里只做长度防护
    total_chars = sum(len(v) for v in req.fields.values())
    if total_chars > TRANSLATE_MAX_TOTAL_CHARS:
        return {"error": {"message": "fields 总长度超限", "code": "BadRequest"}}
    try:
        async with track_llm(ENDPOINT_AI_TRANSLATE, user_id=user.id):
            translated = await ai_proxy.translate_fields(req.fields, req.targetLang)
    except ValueError as e:
        return {"error": {"message": str(e), "code": "BadRequest"}}
    except RuntimeError as e:
        logger.warning("简历翻译失败（可预期）: %s", e)
        return {"error": {"message": str(e), "code": "ConfigError"}}
    except Exception as e:  # noqa: BLE001
        logger.exception("简历翻译调用失败: %s", e)
        return {"error": {"message": str(e)}}
    return {"fields": translated}
