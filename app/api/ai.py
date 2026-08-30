"""前端 AI 能力代理路由：润色 / 语法检查 / 简历导入。

前端不再持有 api_key，所有请求转发到这里，由后端使用环境变量中的
LLM_API_KEY 调用大模型。接口契约与前端 src/routes/api/*.ts 对齐。
"""
from __future__ import annotations

import json
from typing import List, Optional

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.api.deps import get_current_user
from app.core.logging import get_logger
from app.models.user import User
from app.services import ai_proxy

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


@router.post("/polish")
async def polish(req: PolishRequest, user: User = Depends(get_current_user)):
    """流式润色，返回 text/event-stream 纯文本流。

    需要登录：每次调用都会消耗后端 LLM 额度。
    """
    if not req.content or not req.content.strip():
        return StreamingResponse(iter([b""]), media_type="text/plain")

    async def event_stream():
        try:
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
        parsed = await ai_proxy.resume_import(req.content, req.images, req.locale)
    except RuntimeError as e:
        logger.warning("简历导入失败（可预期）: %s", e)
        return {"error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("简历导入调用失败: %s", e)
        return {"error": f"AI 解析失败：{e}"}
    return {"resume": parsed}


@router.post("/resume-import-pdf")
async def resume_import_pdf(
    file: UploadFile = File(...),
    locale: str = "zh",
    user: User = Depends(get_current_user),
):
    """从上传的 PDF 中提取纯文本并结构化解析，返回 { resume: {...} }。

    走文本提取路径，兼容不支持图片输入的纯文本大模型。
    """
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        return {"error": "仅支持 PDF 格式"}
    try:
        data = await file.read()
        parsed = await ai_proxy.resume_import_from_pdf(data, locale)
    except RuntimeError as e:
        logger.warning("PDF 简历导入失败（可预期）: %s", e)
        return {"error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("PDF 简历导入调用失败: %s", e)
        return {"error": f"AI 解析失败：{e}"}
    return {"resume": parsed}
