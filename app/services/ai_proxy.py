"""通用 AI 代理：面向前端的润色/语法检查/简历导入。

所有调用统一走 app.core.llm.get_llm()，即后端环境变量配置的单一大模型
（LLM_API_KEY / LLM_BASE_URL / LLM_MODEL）。前端不再持有任何 api_key，
只透传业务参数（content / images / locale 等），由本模块负责与厂商交互。
"""
from __future__ import annotations

import json
from typing import AsyncIterator, List, Optional

from app.core.llm import get_llm, is_configured
from app.services.pdf_parser import extract_pdf_text

POLISH_SYSTEM = """你是一个专业的简历优化助手。请帮助优化以下 Markdown 格式的文本，使其更加专业和有吸引力。

优化原则：
1. 使用更专业的词汇和表达方式
2. 突出关键成就和技能
3. 保持简洁清晰
4. 使用主动语气
5. 保持原有信息的完整性
6. 严格保留原有的 Markdown 格式结构（列表项保持为列表项，加粗保持加粗等）

输出强约束（必须遵守）：
1. 只能输出“润色后的正文内容”本身。
2. 禁止输出任何前言、说明、总结、附加建议。
3. 禁止出现这类引导语：如“以下是...”“根据您提供...”“这是...”“特点：”“说明：”“总结：”等。
4. 禁止新增与原文无关的章节标题或收尾段落。
5. 不要使用 Markdown 代码块（`）包裹结果。
6. 若你产生了解释性内容，必须在输出前自检并删除，只保留最终正文。"""

GRAMMAR_SYSTEM = """你是一个专业的中文简历校对助手。你的任务是**仅**找出简历中的**错别字**和**标点符号错误**。

**严格禁止**：
1. ❌ **禁止**提供任何风格、语气、润色或改写建议。如果句子在语法上是正确的（即使读起来不够优美），也**绝对不要**报错。
2. ❌ **禁止**报告“无明显错误”或类似的信息。如果没有发现错别字或标点错误，"errors" 数组必须为空。
3. ❌ **禁止**对专业术语进行过度纠正，除非通过上下文非常确定是打字错误。

**仅检查以下两类错误**：
1. ✅ **错别字**：例如将“作为”写成“做为”，将“经理”写成“经里”。
2. ✅ **严重标点错误**：仅报告重复标点（如“，，”）或完全错误的符号位置。

**重要例外（绝不报错）**：
- ❌ **忽略中英文标点混用**：在技术简历中，中文内容使用英文标点（如使用英文逗号, 代替中文逗号，或使用英文句点. 代替中文句号）是**完全接受**的风格。**绝对不要**报告此类“错误”。
- ❌ **忽略空格使用**：不要报告中英文之间的空格遗漏或多余。

返回格式示例（JSON）：
{
  "errors": [
    {
      "context": "包含错误的完整句子（必须是原文）",
      "text": "具体的错误部分（必须是原文中实际存在的字符串）",
      "suggestion": "仅包含修正后的词汇或片段（**不要**返回整句，除非整句都是错误的）",
      "reason": "错别字 / 标点错误",
      "type": "spelling"
    }
  ]
}

再次强调：**只找错别字和标点错误，不要做任何润色！**"""

RESUME_IMPORT_SYSTEM = """你是一个专业的简历结构化助手。根据用户提供的简历内容，提取信息并只输出一个合法 JSON 对象。

输出约束：
1. 只允许输出 JSON，不要输出 Markdown，不要输出解释。
2. 如果某个字段不确定，使用空字符串或空数组。
3. description/details 字段输出字符串数组，每一项为一句可读内容。

JSON 结构：
{
  "title": "简历标题",
  "basic": {
    "name": "",
    "title": "",
    "email": "",
    "phone": "",
    "location": "",
    "employementStatus": "",
    "birthDate": ""
  },
  "education": [
    {
      "school": "",
      "major": "",
      "degree": "",
      "startDate": "",
      "endDate": "",
      "gpa": "",
      "description": [""]
    }
  ],
  "experience": [
    {
      "company": "",
      "position": "",
      "date": "",
      "details": [""]
    }
  ],
  "projects": [
    {
      "name": "",
      "role": "",
      "date": "",
      "description": [""],
      "link": "",
      "linkLabel": ""
    }
  ],
  "skills": [""]
}"""


def _require_configured() -> None:
    if not is_configured():
        raise RuntimeError("LLM 未配置：请在后端 .env 设置 LLM_API_KEY 等参数")


async def stream_polish(content: str, custom_instructions: Optional[str] = None) -> AsyncIterator[str]:
    """流式润色，逐块产出文本。"""
    _require_configured()
    system = POLISH_SYSTEM
    if custom_instructions and custom_instructions.strip():
        system += f"\n\n用户额外要求：\n{custom_instructions.strip()}"
    llm = get_llm(temperature=0.4)
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": content},
    ]
    async for chunk in llm.astream(messages):
        delta = getattr(chunk, "content", None)
        if delta:
            yield delta


async def grammar_check(content: str) -> str:
    """返回 JSON 字符串（errors 数组）。"""
    _require_configured()
    llm = get_llm(temperature=0)
    messages = [
        {"role": "system", "content": GRAMMAR_SYSTEM},
        {"role": "user", "content": content},
    ]
    resp = await llm.ainvoke(messages, response_format={"type": "json_object"})
    return resp.content


def _build_import_parts(content: Optional[str], images: Optional[List[str]], locale: str):
    language = "English" if locale == "en" else "Chinese"
    system = RESUME_IMPORT_SYSTEM.replace("${language}", language)
    parts: List[dict] = [{"type": "text", "text": content or "请识别以下简历页面图片中的信息，并严格按 JSON 结构输出。"}]
    for img in images or []:
        # 接受 data URL 或裸 base64（默认 image/jpeg）
        if img.startswith("data:"):
            mime = img.split(";")[0].replace("data:", "") or "image/jpeg"
            data = img.split(",", 1)[1] if "," in img else img
        else:
            mime, data = "image/jpeg", img
        parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}})
    return system, parts


async def resume_import(content: Optional[str], images: Optional[List[str]], locale: str) -> dict:
    """从文本/图片结构化解析简历，返回解析后的 dict。"""
    _require_configured()
    system, parts = _build_import_parts(content, images, locale)
    llm = get_llm(temperature=0.2)
    resp = await llm.ainvoke(
        [
            {"role": "system", "content": system},
            {"role": "user", "content": parts},
        ],
        response_format={"type": "json_object"},
    )
    raw = resp.content
    if isinstance(raw, list):
        raw = "".join(getattr(p, "text", "") for p in raw)
    raw = raw or ""
    parsed = _extract_json(raw)
    if parsed is None:
        raise RuntimeError("AI 未返回可解析的 JSON")
    return parsed


async def resume_import_from_pdf(data: bytes, locale: str) -> dict:
    """从 PDF 二进制中提取纯文本 + 版式元数据，做结构化解析。

    结构化内容走纯文本模型（避免依赖多模态模型），而版式元数据（字体 /
    字号 / 页边距 / 分栏 / 主色）直接从 PDF 结构提取，不经由 LLM，
    既准确又不受模型能力影响。最终把 layout 元数据一并回传前端，
    让导入后的简历在样式上尽量贴近原始 PDF。
    """
    _require_configured()
    text = await extract_pdf_text(data)
    if not text.strip():
        raise RuntimeError("无法从 PDF 提取文本内容，请确认文件未加密或为扫描件")
    parsed = await resume_import(text, None, locale)
    # 版式元数据独立于 LLM 输出，附加到结果顶层
    try:
        layout = await extract_pdf_layout(data)
    except Exception as e:  # noqa: BLE001
        # 版式提取失败不应阻断导入，仅记录
        layout = {}
    parsed["layout"] = layout
    return parsed


def _extract_json(text: str) -> Optional[dict]:
    text = (text or "").strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    fenced = __import__("re").search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fenced:
        try:
            return json.loads(fenced.group(1).strip())
        except Exception:
            pass
    block = __import__("re").search(r"\{[\s\S]*\}", text)
    if block:
        try:
            return json.loads(block.group(0))
        except Exception:
            pass
    return None
