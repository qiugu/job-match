"""通用 AI 代理：面向前端的润色/语法检查/简历导入/简历翻译。

所有调用统一走 app.core.llm.get_llm()，即后端环境变量配置的单一大模型
（LLM_API_KEY / LLM_BASE_URL / LLM_MODEL）。前端不再持有任何 api_key，
只透传业务参数（content / images / locale 等），由本模块负责与厂商交互。
"""
from __future__ import annotations

import json
from typing import AsyncIterator, List, Optional

from app.core.llm import get_llm, is_configured
from app.core.logging import get_logger
from app.services.pdf_parser import (
    extract_markdown_structure,
    extract_markdown_via_pymupdf,
    extract_pdf_text,
)

logger = get_logger("ai_proxy")

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

输入格式说明（重要）：
- 简历内容通常是从 PDF 确定性提取的层级 Markdown：`#`/`##` 开头的行是模块标题；行首带 `-`、`•` 或数字/中文序号的行是列表条目；`**文本**` 是原文加粗片段。
- 严格依据这些结构信号归类：标题行决定模块归属（教育/工作经历/项目/技能等）；列表条目按原顺序逐条进入对应条目的 details/description 数组，不合并、不拆分、不遗漏；加粗文本优先映射到 company/position/school/name 等关键字段。
- 技能区（skills 数组）的粒度必须与原文行一致：原文的一行/一条列表就是一个数组项，整项原样保留（含「前端：」「Frontend:」等分组前缀和 / 、等分隔符）；严禁把一行内的多个技能词拆成多个数组项，严禁丢弃分组前缀。

description/details 输出规则（必须遵守，保证前端按原样渲染、样式统一）：
- 每一项必须是「原样保留其 markdown 结构」的单行：列表条目以 `- ` 开头；子标题（如「核心贡献」「项目成果」）写成 `### 子标题`；普通段落不加任何前缀。
- 严禁把所有项统一转成列表或统一拍平——原 PDF 里的列表保留为 `- `，子标题保留为 `### `，段落保留为无前缀文本。
- 严禁凭空捏造列表中不存在的条目，也严禁丢弃任何原文条目。

输出约束：
1. 只允许输出 JSON，不要输出 Markdown，不要输出解释。
2. 如果某个字段不确定，使用空字符串或空数组。

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

# 目标语言白名单：与前端 TRANSLATE_LANGUAGES 对齐（本期只支持中英，产品决策 2026-10-28）。
TRANSLATE_LANGUAGES = {
    "zh": "简体中文",
    "en": "English",
}

TRANSLATE_SYSTEM = """你是一个专业的简历翻译助手。用户会给你一个 JSON 对象：键（key）是字段路径，值（value）是待翻译的简历文本。请把每个值翻译成目标语言，并只输出一个 JSON 对象：键必须与输入完全一致（一个不多、一个不少），值为译文。

目标语言：${language}

翻译规则（必须全部遵守）：
1. **只译文字，不译结构**：Markdown 标记（`#`/`##`/`###`/`-`/`*`/`**`/`:::left`/`:::center`/`:::right` 等）必须逐字符原样保留在译文中，只翻译标记之间的文字。列表条目保持为列表条目，加粗保持加粗，行数与顺序不变。
2. **原样保留（绝不翻译）**：日期、数字、百分比、版本号、邮箱、电话、URL、代码标识符、产品技术名（React、Kubernetes 等）。
3. **专名保留原文**：公司名、学校名、产品名、机构名保留原文，不意译、不改写。
4. **人名**：保留原文；若目标语言是 English 且原文是中文人名，可按汉语拼音转写（如「张三」→「Zhang San」）。
5. **字段语义**：如 `position`（职位）、`degree`（学位）等按目标语言职场惯例翻译（如「学士」→「Bachelor's」），不要逐字硬译。
6. **禁止增删内容**：不新增信息、不删减信息、不合并或拆分条目、不解释、不总结。
7. **空值处理**：输入值为空字符串时，输出该键的值也必须为空字符串。

输出强约束：
1. 只输出 JSON 对象本身，禁止 Markdown 代码块（```）包裹，禁止任何前言、说明或注释。
2. JSON 的键集合必须与输入的键集合完全相同。"""


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


async def translate_fields(fields: dict, target_lang: str) -> dict:
    """把「键值映射」形式的简历文本字段翻译为目标语言。

    设计决策（PLAN_resume_translate.md §2.1）：不整包回传 ResumeData，只发送
    可翻译文本字段（key 为稳定字段路径），LLM 只译值、原样回传 key；前端再按
    key 合并。非文本配置（id/模板/排版设置/日期）从不离开客户端，LLM 物理上
    无法破坏结构。

    返回 {key: 译文}：只回传输入中出现过的 key（LLM 幻觉出的多余 key 丢弃）；
    缺失的 key 由调用方（前端 merge）回退原文，部分成功仍可用。
    """
    _require_configured()
    if not fields:
        raise ValueError("fields 不能为空")
    if target_lang not in TRANSLATE_LANGUAGES:
        raise ValueError(f"不支持的目标语言: {target_lang}")

    language = TRANSLATE_LANGUAGES[target_lang]
    system = TRANSLATE_SYSTEM.replace("${language}", language)
    user_payload = json.dumps(fields, ensure_ascii=False)
    llm = get_llm(temperature=0)
    resp = await llm.ainvoke(
        [
            {"role": "system", "content": system},
            {"role": "user", "content": user_payload},
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

    # 只保留输入中出现过的 key，且值必须是字符串；其余丢弃（调用方回退原文）。
    result: dict = {}
    for key, value in parsed.items():
        if key in fields and isinstance(value, str):
            result[key] = value
    return result


def _extract_json(text: str) -> Optional[dict]:
    """从 LLM 输出中容错提取 JSON 对象。

    只接受 dict（对象）——调用方（resume_import / translate_fields）均对结果
    调 `.items()`，若放行 list/str/number 会抛 AttributeError 落到 500 分支。
    因此三层解析（直接 loads / fenced 块 / 花括号块）成功后统一校验结果是
    dict，非对象一律返回 None，让调用方走既有的清晰错误路径。
    """
    text = (text or "").strip()

    candidates = [text]
    fenced = __import__("re").search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fenced:
        candidates.append(fenced.group(1).strip())
    block = __import__("re").search(r"\{[\s\S]*\}", text)
    if block:
        candidates.append(block.group(0))

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None
