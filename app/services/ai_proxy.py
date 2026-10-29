"""通用 AI 代理：面向前端的润色/语法检查/简历导入/简历翻译。

所有调用统一走 app.core.llm.get_llm()，即后端环境变量配置的单一大模型
（LLM_API_KEY / LLM_BASE_URL / LLM_MODEL）。前端不再持有任何 api_key，
只透传业务参数（content / images / locale 等），由本模块负责与厂商交互。
"""
from __future__ import annotations

import hashlib
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
3. **保留原文（不译）**：公司名、机构全称、技术/产品代号（如 `JDMatch`、`V2X`，与规则 2 的「产品技术名」同口径）保留原文，不意译、不改写。
4. **人名**：保留原文；若目标语言是 English 且原文是中文人名，可按汉语拼音转写（如「张三」→「Zhang San」）。
5. **字段语义（按职场惯例本地化）**：`position`（职位）、`major`（专业）、`degree`（学位）、`role`（项目角色）按目标语言职场惯例翻译（如「学士」→「Bachelor's」、「项目负责人」→「Project Lead」），不要逐字硬译。
6. **学校名与项目名必须本地化（硬性要求）**：这两个字段承载的是「机构名」与「作品名」，不是代号，**禁止原样照抄**。
   - `education.*.school`：目标语言存在通行名称时必须译出（如「Fudan University」→「复旦大学」、「安徽师范大学」→「Anhui Normal University」）。
   - `projects.*.name`：译出名称中的语义部分（如「Intelligent Resume Matching Platform」→「智能简历匹配平台」、「JDMatch Resume Matcher」→「JDMatch 简历匹配器」）。
   - 唯一例外：整个名称是纯代号/缩写（如 `JDMatch`、`JD-Match`、`V2X`）时保留原文，不得硬造译名。
7. **禁止增删内容**：不新增信息、不删减信息、不合并或拆分条目、不解释、不总结。
8. **空值处理**：输入值为空字符串时，输出该键的值也必须为空字符串。

输出强约束：
1. 只输出 JSON 对象本身，禁止 Markdown 代码块（```）包裹，禁止任何前言、说明或注释。
2. JSON 的键集合必须与输入的键集合完全相同。"""


def _prompt_fingerprint(text: str) -> str:
    """prompt 指纹（sha256 前 8 位），写入 llm_usage.prompt_version。

    策略写在 prompt 字符串里：改了 prompt 却看不出行为差异、或没改 prompt 却回归时，
    只有把「当时生效的版本」记下来才能对齐，否则排查只能靠猜。
    """
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]


# 翻译指令的当前版本，随 translate 台账一起落库，观测页据此判断规则是否变过。
TRANSLATE_PROMPT_VERSION = _prompt_fingerprint(TRANSLATE_SYSTEM)


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


# 「整组未变化」告警的最小样本数：单字段原样返回是正常现象（纯代号项目名、与
# 目标语言同形的公司名），不足以判定策略失效；整组全长一致才说明该字段类别被漏译。
_UNCHANGED_GROUP_MIN_FIELDS = 2

# detail 里未变化 key 列表的保留条数：其余只留计数，防长简历把 detail 撑爆。
_DETAIL_MAX_UNCHANGED_KEYS = 20


def summarize_translation(
    fields: dict, translated: dict, target_lang: str = ""
) -> dict:
    """把一次翻译的结果压成可落库的结构化摘要（页面与护栏共用的单一事实源）。

    只产出**字段路径与计数**，不含任何简历正文，因此可以安全写入 llm_usage.detail
    并直接在观测页展示。三类字段互不重叠，且相加等于 fieldsTotal：

    - `fieldsTranslated`：已返回且与原文不同（真正译出）；
    - `fieldsUnchanged`：已返回但与原文相同。「保留原文」与「漏译」在此同形，
      所以另给 `unchangedGroups` 按字段类别聚合，供页面直接回答「哪类字段没译」；
    - `fieldsMissing`：LLM 根本没返回该 key（调用方会回退原文）。

    空值不参与统计：空文本没有「是否译出」的语义，计入会污染未变化占比。
    """
    total = len(fields)
    returned = {
        key: value
        for key, value in translated.items()
        if key in fields and isinstance(value, str) and value
    }
    unchanged_keys = [key for key, value in returned.items() if value == fields[key]]

    groups: dict[str, int] = {}
    for key in unchanged_keys:
        group = key.split(".", 1)[0]
        groups[group] = groups.get(group, 0) + 1

    summary = {
        "fieldsTotal": total,
        "fieldsTranslated": len(returned) - len(unchanged_keys),
        "fieldsUnchanged": len(unchanged_keys),
        "fieldsMissing": max(0, total - len(returned)),
        "unchangedGroups": groups,
        "unchangedKeys": unchanged_keys[:_DETAIL_MAX_UNCHANGED_KEYS],
        "unchangedKeysTruncated": max(
            0, len(unchanged_keys) - _DETAIL_MAX_UNCHANGED_KEYS
        ),
    }
    if target_lang:
        summary["targetLang"] = target_lang
    return summary


def _warn_if_group_unchanged(fields: dict, translated: dict) -> None:
    """检测「某类字段整组原样返回」并记 warning（只记分组名与计数，不记正文）。

    背景：翻译指令要求学校名与项目名本地化，但 LLM 仍可能判定为专名而照抄；而
    服务层此前只校验 key 是否存在与值是否为字符串，「未翻译」会被当作合法译文
    静默通过，线上只能靠用户肉眼发现。这里补一层与内容语义无关的检查（仅比较
    字符串是否相等），让 prompt 回归在日志里立刻可见，而不是等用户报障。

    判定复用 `summarize_translation`（同一事实源，与页面展示口径一致）：某组未
    变化条数达到最小样本、且等于该组总字段数，才算「整组未译」。分组粒度取字段
    路径首段——太粗（整批）会把「只有一处未译」淹掉，太细（单字段）无法区分正常保留。
    """
    summary = summarize_translation(fields, translated)
    if not summary["unchangedGroups"]:
        return

    group_totals: dict[str, int] = {}
    for key, value in fields.items():
        if value:
            group = key.split(".", 1)[0]
            group_totals[group] = group_totals.get(group, 0) + 1

    for group, count in summary["unchangedGroups"].items():
        if count < _UNCHANGED_GROUP_MIN_FIELDS or count != group_totals.get(group):
            continue
        # 组名取自前端提交的字段路径，可能带换行等控制字符（日志注入），打印前清洗
        safe_group = "".join(
            ch for ch in group if ch.isalnum() or ch == "_"
        )[:32] or "unknown"
        logger.warning(
            "简历翻译疑似未生效：字段组 %s 的 %d 项全部原样返回，"
            "请检查 TRANSLATE_SYSTEM 的本地化规则（学校名/项目名不得照抄）",
            safe_group,
            count,
        )


async def translate_fields(fields: dict, target_lang: str) -> dict:
    """把「键值映射」形式的简历文本字段翻译为目标语言。

    设计决策（PLAN_resume_translate.md §2.1）：不整包回传 ResumeData，只发送
    可翻译文本字段（key 为稳定字段路径），LLM 只译值、原样回传 key；前端再按
    key 合并。非文本配置（id/模板/排版设置/日期）从不离开客户端，LLM 物理上
    无法破坏结构。

    返回 {key: 译文}：只回传输入中出现过的 key（LLM 幻觉出的多余 key 丢弃）；
    缺失的 key 由调用方（前端 merge）回退原文，部分成功仍可用。

    返回前会执行 `_warn_if_group_unchanged`：某字段组全部「译文 == 原文」时写
    warning 日志（只记分组名与计数）。这是内容无关的可观测性检查，不改变返回值。
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

    _warn_if_group_unchanged(fields, result)
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
