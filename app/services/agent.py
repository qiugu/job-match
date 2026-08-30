"""简历匹配 Agent：基于 LangGraph 的多节点工作流。

流程：
  1. extract_keywords  —— 从 JD 提取关键词（技能/经验/要求）
  2. branch            —— 根据 match_mode 路由
  3a. rewrite_resume   —— 全部重写：以简历为素材，按 JD 重写整份简历（markdown）
  3b. keyword_optimize —— 关键词优化：保留简历结构，仅针对性优化描述以命中 JD 关键词
  4. cover_letter?     —— 若需要，生成约 200 字求职信纯文本

状态在节点间以 TypedDict 传递，最终产出结构化 ResumeData 与可选求职信。
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from langgraph.graph import StateGraph, END
from pydantic import ValidationError

from app.core.llm import get_llm, is_configured, model
from app.core.config import settings
from app.core.logging import get_logger
from app.core.prompts import JD_EXTRACT_PROMPT, RESUME_REWRITE_PROMPT, COVER_LETTER_PROMPT, KEYWORDS_OPTIMIZE, RESUME_MATCHER_PROMPT
from app.schemas.resume import GlobalSettings, MenuSection, ResumeData
from app.schemas.agent import AgentState, JDAnalysis, MatchResult

logger = get_logger("agent")

RULES = (
    "你是资深简历优化顾问。仅输出符合要求的 JSON，不要包含多余解释或 Markdown 代码块标记。"
    "所有字段使用中文（除非专有名词/技术栈）。保持真实，不得编造不存在的经历、公司或技能。"
)

SCHEMA_HINT = (
    "输出 JSON 结构："
    '{"basic":{"name","title","email","phone","location","customFields":[{"label","value"}]},'
    '"education":[{"school","major","degree","startDate","endDate","description"}],'
    '"experience":[{"company","position","date","details"}],'
    '"projects":[{"name","role","date","description"}],'
    '"skillContent":"技能总结文本","selfEvaluationContent":"自我评价文本"}'
)

# LLM 结构化输出的清洗策略（LLM 输出不稳定，可能带 null 或类型错位，需兜底）：
# - null 值：直接删除，Pydantic 回退到字段默认值
# - 文本字段：非字符串转成字符串（列表用「；」拼接），避免 ValidationError
_TEXT_FIELDS = {
    # BasicInfo
    "name", "title", "email", "phone", "location", "birthDate",
    "employementStatus", "photo", "githubKey", "githubUseName",
    # Education
    "school", "major", "degree", "startDate", "endDate", "gpa",
    # Experience / Project / CustomItem
    "company", "position", "date", "details", "description", "role",
    "link", "linkLabel", "subtitle", "dateRange",
    # CustomFieldType / 通用
    "label", "value", "icon", "id",
    # ResumeData
    "skillContent", "selfEvaluationContent", "activeSection",
}

async def jd_extract(state: AgentState) -> AgentState:
    prompt = JD_EXTRACT_PROMPT.format(
        jd=state["jd_text"]
    )
    try:
        # 使用 langchain 结构化输出。思考模型（DeepSeek thinking）禁止 tool_choice，
        # 因此必须走 json_mode（response_format=json_object），不触发 tool_choice。
        model_with_structure = model.with_structured_output(
            JDAnalysis, method="json_mode"
        )
        resp = await asyncio.wait_for(
            model_with_structure.ainvoke(prompt),
            timeout=settings.llm_timeout
        )
        if isinstance(resp, JDAnalysis):
            state["jd_analyze_results"] = resp
    except Exception as e:
        # 兜底：JD 提取失败时也要写入空结果，避免下游 resume_match 因缺失
        # jd_analyze_results 触发 KeyError（AgentState 该字段为可选字段）。
        logger.exception("JD 关键词提取节点失败（已降级为空结果）: %s", str(e))
        state["jd_analyze_results"] = JDAnalysis(
            experiences=[],
            hard_skills=[],
            soft_skills=[],
            plus=[],
            rigid=[],
        )
        state["error"] = str(e)
    return state


async def resume_match(state: AgentState) -> AgentState:
    jd_analyze_results = state.get("jd_analyze_results")
    # 上游（jd_extract）未产出分析结果时跳过，避免 KeyError 崩溃。
    if jd_analyze_results is None:
        state["error"] = state.get("error") or "JD 分析未产出结果，无法执行匹配"
        return state
    prompt = RESUME_MATCHER_PROMPT.format(
        jd_analyze_results=jd_analyze_results.model_dump_json(
            indent=2
        ),
        resume=state["resume_text"]
    )
    try:
        model_with_structure = model.with_structured_output(
            MatchResult, method="json_mode"
        )
        resp = await asyncio.wait_for(
            model_with_structure.ainvoke(prompt),
            timeout=settings.llm_timeout
        )
        if isinstance(resp, MatchResult): 
            state["resume_match_results"] = resp
            state["refactor_mode"] = resp.refactor_mode
    except Exception as e:
        logger.exception("简历匹配节点失败: %s", e)
        state["error"] = str(e)
    return state

def _strip(s: str) -> str:
    s = s.strip()
    if s.startswith("```"):
        s = s.split("```", 2)[1]
        if s.startswith("json"):
            s = s[4:]
    return s.strip()


def _to_text(content: str | list | None) -> str:
    """把 LLM 响应内容统一转成纯文本。

    `AIMessage.content` 的类型为 `str | list[dict]`：文本模型返回 str，
    多模态/带工具调用的模型可能返回 list（如 [{"type":"text","text":"..."}]），
    直接 `.strip()` 会 AttributeError，这里统一归一化为字符串。
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts)
    return str(content) if content is not None else ""


def resume_to_text(resume: ResumeData) -> str:
    """把结构化 ResumeData 转成 LLM 可读的纯文本简历。

    用于没有 PDF 原文的 JSON 简历：在 rewrite / 求职信等需要
    master_text 的节点中作为素材输入。
    """
    lines: list[str] = []
    basic = resume.basic
    info = [p for p in [basic.name, basic.title] if p]
    contact = [
        p
        for p in [basic.email, basic.phone, basic.location]
        if p
    ]
    if info:
        lines.append(" | ".join(info))
    if contact:
        lines.append(" | ".join(contact))
    for field in basic.customFields:
        if field.label and field.value:
            lines.append(f"{field.label}: {field.value}")

    def section(title: str, body: str) -> None:
        if body:
            lines.append(f"\n【{title}】\n{body}")

    edu_blocks = []
    for e in resume.education:
        head = " · ".join(p for p in [e.school, e.major, e.degree] if p)
        if e.startDate or e.endDate:
            head += f"（{e.startDate or ''}-{e.endDate or ''}）"
        block = head
        if e.description:
            block += f"\n{e.description}"
        edu_blocks.append(block)
    section("教育经历", "\n\n".join(edu_blocks))

    exp_blocks = []
    for x in resume.experience:
        head = " · ".join(p for p in [x.company, x.position] if p)
        if x.date:
            head += f"（{x.date}）"
        block = head
        if x.details:
            block += f"\n{x.details}"
        exp_blocks.append(block)
    section("工作经历", "\n\n".join(exp_blocks))

    proj_blocks = []
    for p in resume.projects:
        head = " · ".join(x for x in [p.name, p.role] if x)
        if p.date:
            head += f"（{p.date}）"
        block = head
        if p.description:
            block += f"\n{p.description}"
        proj_blocks.append(block)
    section("项目经历", "\n\n".join(proj_blocks))

    if resume.skillContent:
        section("技能", resume.skillContent)
    if resume.selfEvaluationContent:
        section("自我评价", resume.selfEvaluationContent)

    for custom_title, items in (resume.customData or {}).items():
        blocks = []
        for item in items:
            head = " · ".join(x for x in [item.title, item.subtitle] if x)
            if item.dateRange:
                head += f"（{item.dateRange}）"
            block = head
            if item.description:
                block += f"\n{item.description}"
            blocks.append(block)
        section(custom_title or "自定义模块", "\n\n".join(blocks))

    return "\n".join(lines).strip()


async def rewrite_resume(state: AgentState) -> AgentState:
    resume_match_results = state.get("resume_match_results")
    if resume_match_results is None:
        state["error"] = state.get("error") or "匹配结果缺失，无法重写简历"
        return state
    prompt = RESUME_REWRITE_PROMPT.format(
        resume_match_results=resume_match_results.model_dump_json(
            indent=2,
            exclude={ "cover_letter", "resume_match_results" }
        ),
        resume_text=state["resume_text"]
    )
    resp = await asyncio.wait_for(model.ainvoke(prompt), timeout=settings.llm_timeout)
    state["markdown_content"] = _strip(_to_text(resp.content))
    return state


async def keyword_optimize(state: AgentState) -> AgentState:
    resume_match_results = state.get("resume_match_results")
    if resume_match_results is None:
        state["error"] = state.get("error") or "匹配结果缺失，无法优化关键词"
        return state
    kw = "、".join(state.get("keywords", []))
    prompt = KEYWORDS_OPTIMIZE.format(
        resume_match_results=resume_match_results.model_dump_json(
            indent=2,
            exclude=set(["cover_letter", "resume_match_results"])
        ),
        resume_text=state["resume_text"],
        kw={kw}
    )
    resp = await asyncio.wait_for(model.ainvoke(prompt), timeout=settings.llm_timeout)
    state["markdown_content"] = _strip(_to_text(resp.content))
    return state


async def generate_cover_letter(state: AgentState) -> AgentState:
    if not state.get("with_cover_letter"):
        return state
    prompt = COVER_LETTER_PROMPT.format(
        jd_text=state["jd_text"],
        resume_text=state["resume_text"]
    )
    resp = await asyncio.wait_for(model.ainvoke(prompt), timeout=settings.llm_timeout)
    state["cover_letter"] = _to_text(resp.content).strip()
    return state


def _route(state: AgentState) -> str:
    return "rewrite" if state.get("refactor_mode") == "rewrite" else "optimize"


def build_graph():
    # Pyrefly/ty 无法对 TypedDict 类做结构匹配（langgraph StateT 上界 TypedDictLikeV1/V2，
    # 且其错误码不互通，只能使用无码 ignore）。运行时已验证正常。
    g = StateGraph(AgentState)  # type: ignore
    g.add_node("jd_extract", jd_extract)
    g.add_node("resume_match", resume_match)
    g.add_node("rewrite_resume", rewrite_resume)
    g.add_node("keyword_optimize", keyword_optimize)

    g.set_entry_point("jd_extract")
    g.add_edge("jd_extract", "resume_match")
    g.add_conditional_edges(
        "resume_match", _route, {"rewrite": "rewrite_resume", "optimize": "keyword_optimize"}
    )
    g.add_edge("rewrite_resume", END)
    return g.compile()


async def run_match(
    master_text: str,
    jd_text: str,
    with_cover_letter: bool,
) -> tuple[list[str], str, str, str, dict | None]:
    """执行匹配工作流，返回 (关键词, 优化后简历, 求职信, 匹配方式, 匹配分析)。

    匹配方式（rewrite/optimize）由 LLM 在 resume_match 节点自行判断，无需调用方传入。
    匹配分析为 resume_match 节点产出的结构化结果（岗位角色、得分、匹配项、总结），
    下游节点不直接消费但前端需要展示，因此一并回传。
    """
    if not is_configured():
        raise RuntimeError("LLM 未配置：请在 .env 设置 LLM_API_KEY 等参数")

    async def _run_once() -> tuple[list[str], str, str, str, dict | None]:
        graph = build_graph()
        init: AgentState = {
            "resume_text": master_text,
            "jd_text": jd_text,
            "with_cover_letter": with_cover_letter,
        }
        result = await asyncio.wait_for(graph.ainvoke(init), timeout=settings.llm_timeout)

        # 工作流节点内部出错时已写入 error 字段，此处将其作为异常抛出，
        # 避免静默返回空简历误导调用方。节点内已用 logger.exception 记录完整堆栈。
        if result.get("error"):
            raise RuntimeError(f"匹配流程执行失败：{result['error']}")

        resume_raw = result.get("markdown_content", "")
        refactor_mode = result.get("refactor_mode", "rewrite")
        match_results = result.get("resume_match_results")
        analysis = (
            match_results.model_dump(exclude_none=True) if match_results else None
        )

        return (
            result.get("keywords", []),
            resume_raw,
            result.get("cover_letter", ""),
            refactor_mode,
            analysis,
        )

    try:
        return await _run_once()
    except ValidationError as e:
        # LLM 输出不稳定导致结构无法验证：重试一次工作流
        logger.warning("LLM 结构化输出解析失败，重试一次: %s", e)
        try:
            return await _run_once()
        except ValidationError:
            logger.exception("LLM 结构化输出重试后仍无法解析")
            raise RuntimeError(f"LLM 输出的简历结构无法解析，请重试：{str(e)[:120]}") from e
    except asyncio.TimeoutError:
        # LLM 接口无响应导致整体超时：返回 503 而非让事件循环永久 pending
        logger.exception("匹配工作流整体超时")
        raise RuntimeError("匹配请求超时（LLM 接口未在规定时间内响应），请稍后重试")
    except RuntimeError:
        # 业务上抛出的可预期错误（LLM 未配置 / 匹配流程失败）已在上游记录，
        # 直接向上传播给 match.py 转 503。
        raise
    except Exception as e:
        # 节点内未捕获的 LLM 网络/厂商异常会在此冒泡：记录完整 traceback，
        # 转成 RuntimeError 让 match.py 返回 503 而非默认 500。
        logger.exception("匹配工作流执行失败: %s", e)
        raise RuntimeError(f"匹配请求处理失败：{e}") from e
