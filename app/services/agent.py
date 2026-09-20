"""简历匹配 Agent：基于 LangGraph 的多节点工作流。

流程（匹配链路）：
  legacy:   jd_extract → resume_match → keyword_optimize
  combined: analyze_match → keyword_optimize

两条路径最终都产出原有 keywords、MatchResult 和优化后的 markdown。

话术（cover letter）已解耦为独立链路：单次 LLM 调用，不进 LangGraph 图，
由 `run_cover_letter` 直接产出，支持 greeting/followup/interview 多场景。

状态在节点间以 TypedDict 传递，最终产出优化后的 markdown 简历与匹配分析。
"""
from __future__ import annotations

import asyncio
import time
from contextvars import ContextVar
from datetime import timezone
from email.utils import parsedate_to_datetime
from typing import Any

import httpx
from langchain_core.exceptions import OutputParserException
from langgraph.graph import END, StateGraph
from openai import APIConnectionError, APIStatusError
from pydantic import ValidationError

from app.core.llm import get_match_llm, is_configured, model
from app.core.config import settings
from app.core.logging import get_logger
from app.core.prompts import (
    JD_EXTRACT_PROMPT,
    RESUME_REWRITE_PROMPT,
    COVER_LETTER_PROMPT,
    COVER_LETTER_SCENES,
    KEYWORDS_OPTIMIZE,
    MATCH_ANALYSIS_PROMPT,
    RESUME_MATCHER_PROMPT,
)
from app.schemas.resume import GlobalSettings, MenuSection, ResumeData
from app.schemas.agent import (
    AgentState,
    JDAnalysis,
    MatchAnalysisBundle,
    MatchResult,
)
from app.services.match_metrics import MatchStageError, match_request, match_stage

logger = get_logger("agent")
_match_deadline: ContextVar[float | None] = ContextVar(
    "match_deadline", default=None
)
_monotonic = time.monotonic
_wall_time = time.time


class TruncatedMatchOutputError(RuntimeError):
    """模型因输出上限中止，结果不可作为完整简历使用。"""


class StructuredMatchOutputError(ValueError):
    """结构化响应未能产出约定的 Pydantic 模型。"""


def _is_truncated_response(response: Any) -> bool:
    for metadata in (
        getattr(response, "response_metadata", None),
        getattr(response, "additional_kwargs", None),
    ):
        if not isinstance(metadata, dict):
            continue
        reason = metadata.get("finish_reason") or metadata.get("stop_reason")
        if str(reason).lower() in {"length", "max_tokens", "max_output_tokens"}:
            return True
    return False


def _retry_after_seconds(exc: BaseException) -> float:
    response = getattr(exc, "response", None)
    if response is None or response.status_code != 429:
        return 0
    retry_after_ms = response.headers.get("retry-after-ms")
    value = response.headers.get("retry-after")
    try:
        if retry_after_ms is not None:
            return max(float(retry_after_ms) / 1000, 0)
        return max(float(value), 0) if value is not None else 0
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value)
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=timezone.utc)
            return max(retry_at.timestamp() - _wall_time(), 0)
        except (TypeError, ValueError, OverflowError):
            return 0


def _is_recoverable_match_error(exc: BaseException) -> bool:
    if isinstance(
        exc,
        (
            OutputParserException,
            ValidationError,
            StructuredMatchOutputError,
            TimeoutError,
        ),
    ):
        return True
    if isinstance(exc, APIConnectionError):
        return True
    if isinstance(exc, APIStatusError):
        return exc.status_code == 429 or exc.status_code >= 500
    if isinstance(exc, httpx.TransportError):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code == 429 or exc.response.status_code >= 500
    return False


async def _invoke_match_stage(
    stage_name: str,
    runnable: Any,
    prompt: str,
    *,
    expected_type: type[Any] | None = None,
) -> Any:
    """在共享截止时间内调用节点，并对可恢复故障最多重试一次。"""
    deadline = _match_deadline.get()
    if deadline is None:
        deadline = _monotonic() + settings.match_total_timeout_seconds
    stage_timeout = {
        "jd_extract": settings.match_extract_timeout_seconds,
        "resume_match": settings.match_analyze_timeout_seconds,
        "analyze_match": settings.match_analyze_timeout_seconds,
        "keyword_optimize": settings.match_optimize_timeout_seconds,
    }[stage_name]
    for attempt in (1, 2):
        try:
            with match_stage(
                stage_name, attempt=attempt, input_chars=len(prompt)
            ) as stage:
                remaining = deadline - _monotonic()
                if remaining <= 0:
                    raise TimeoutError("match deadline exhausted")
                async with asyncio.timeout(min(stage_timeout, remaining)):
                    response = await runnable.ainvoke(
                        prompt, config=stage.runnable_config
                    )
                if (
                    stage_name == "keyword_optimize"
                    and _is_truncated_response(response)
                ):
                    raise TruncatedMatchOutputError(
                        "优化简历输出被模型长度限制截断"
                    )
                if expected_type is not None and not isinstance(
                    response, expected_type
                ):
                    raise StructuredMatchOutputError(
                        f"{stage_name} 结构化输出类型不正确"
                    )
                return response
        except Exception as exc:
            if attempt == 2 or not _is_recoverable_match_error(exc):
                raise
            retry_after = _retry_after_seconds(exc)
            if retry_after >= deadline - _monotonic():
                raise
            if retry_after:
                await asyncio.sleep(retry_after)
    raise AssertionError("unreachable")


def _flatten_keywords(analysis: JDAnalysis) -> list[str]:
    """把 JD 分析结果打平为关键词列表（去重、上限 20）。

    供 keyword_optimize 的 {kw}、API 返回的 keywords 与前端 diff 高亮使用。
    experiences/rigid 常为长句（如「3 年以上金融行业经验」），不适合做高亮
    token，故只取技能类与加分项。
    """
    out: list[str] = []
    for item in [*analysis.hard_skills, *analysis.soft_skills, *analysis.plus]:
        s = item.strip()
        if s and s not in out:
            out.append(s)
    return out[:20]


async def jd_extract(state: AgentState) -> AgentState:
    prompt = JD_EXTRACT_PROMPT.format(
        jd=state["jd_text"]
    )
    try:
        # 使用 langchain 结构化输出。思考模型（DeepSeek thinking）禁止 tool_choice，
        # 因此必须走 json_mode（response_format=json_object），不触发 tool_choice。
        model_with_structure = get_match_llm("extract").with_structured_output(
            JDAnalysis, method="json_mode"
        )
        resp = await _invoke_match_stage(
            "jd_extract",
            model_with_structure,
            prompt,
            expected_type=JDAnalysis,
        )
        state["jd_analyze_results"] = resp
        # 打平为关键词列表：此前没有任何节点写入 state["keywords"]，
        # 导致 keyword_optimize 的 {kw}、API 返回值与前端关键词高亮全部失效。
        state["keywords"] = _flatten_keywords(resp)
    except Exception as e:
        logger.error("JD 关键词提取节点失败 | error_type=%s", type(e).__name__)
        raise MatchStageError("jd_extract", e) from e
    return state


async def resume_match(state: AgentState) -> AgentState:
    jd_analyze_results = state.get("jd_analyze_results")
    if jd_analyze_results is None:
        cause = RuntimeError("JD 分析未产出结果，无法执行匹配")
        raise MatchStageError("resume_match", cause) from cause
    # 消费 jd_extract 的格式化结果（结构化 JD 要点）进行匹配。
    prompt = RESUME_MATCHER_PROMPT.format(
        jd_analyze_results=jd_analyze_results.model_dump_json(),
        resume=state["resume_text"]
    )
    try:
        model_with_structure = get_match_llm("analyze").with_structured_output(
            MatchResult, method="json_mode"
        )
        resp = await _invoke_match_stage(
            "resume_match",
            model_with_structure,
            prompt,
            expected_type=MatchResult,
        )
        state["resume_match_results"] = resp
    except Exception as e:
        logger.error("简历匹配节点失败 | error_type=%s", type(e).__name__)
        raise MatchStageError("resume_match", e) from e
    return state


async def analyze_match(state: AgentState) -> AgentState:
    """一次联合提取 JD 分类并生成匹配分析。"""

    prompt = MATCH_ANALYSIS_PROMPT.format(
        jd=state["jd_text"],
        resume=state["resume_text"],
    )
    try:
        model_with_structure = get_match_llm("analyze").with_structured_output(
            MatchAnalysisBundle, method="json_mode"
        )
        resp = await _invoke_match_stage(
            "analyze_match",
            model_with_structure,
            prompt,
            expected_type=MatchAnalysisBundle,
        )
        state["jd_analyze_results"] = resp.jd_analysis
        state["keywords"] = _flatten_keywords(resp.jd_analysis)
        state["resume_match_results"] = resp.match_result
    except Exception as e:
        logger.error("联合匹配分析节点失败 | error_type=%s", type(e).__name__)
        raise MatchStageError("analyze_match", e) from e
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
        resume_match_results=resume_match_results.model_dump_json(indent=2),
        resume_text=state["resume_text"]
    )
    resp = await asyncio.wait_for(model.ainvoke(prompt), timeout=settings.llm_timeout)
    state["markdown_content"] = _strip(_to_text(resp.content))
    return state


async def keyword_optimize(state: AgentState) -> AgentState:
    resume_match_results = state.get("resume_match_results")
    if resume_match_results is None:
        cause = RuntimeError("匹配结果缺失，无法优化关键词")
        raise MatchStageError("keyword_optimize", cause) from cause
    kw = "、".join(state.get("keywords", []))
    # 紧凑 JSON（不带 indent）：indent=2 的缩进/换行会额外增加 30%+ 的输入 token，
    # 抬高 TTFT 与费用，对模型解析没有帮助。
    prompt = KEYWORDS_OPTIMIZE.format(
        resume_match_results=resume_match_results.model_dump_json(),
        resume_text=state["resume_text"],
        kw=kw
    )
    try:
        resp = await _invoke_match_stage(
            "keyword_optimize", get_match_llm("optimize"), prompt
        )
        state["markdown_content"] = _strip(_to_text(resp.content))
    except Exception as e:
        logger.error("关键词优化节点失败 | error_type=%s", type(e).__name__)
        raise MatchStageError("keyword_optimize", e) from e
    return state


async def run_cover_letter(
    jd_text: str,
    resume_text: str,
    scene: str = "greeting",
) -> str:
    """独立话术生成链路：单次 LLM 调用，不进 LangGraph 图。

    输入仅需简历文本 + JD 文本 + 场景（greeting/followup/interview），
    输出纯文本话术。与简历匹配链路完全解耦，可独立调用、独立扣额度。
    """
    if not is_configured():
        raise RuntimeError("LLM 未配置：请在 .env 设置 LLM_API_KEY 等参数")

    guidance = COVER_LETTER_SCENES.get(scene, COVER_LETTER_SCENES["greeting"])
    prompt = COVER_LETTER_PROMPT.format(
        scene=guidance,
        jd_text=jd_text,
        resume_text=resume_text,
    )
    try:
        resp = await asyncio.wait_for(
            model.ainvoke(prompt), timeout=settings.llm_timeout
        )
    except asyncio.TimeoutError:
        logger.exception("话术生成超时")
        raise RuntimeError("话术生成请求超时（LLM 接口未在规定时间内响应），请稍后重试")
    except Exception as e:
        logger.exception("话术生成失败: %s", e)
        raise RuntimeError(f"话术生成失败：{e}") from e
    return _to_text(resp.content).strip()


def build_graph():
    # Pyrefly/ty 无法对 TypedDict 类做结构匹配（langgraph StateT 上界 TypedDictLikeV1/V2，
    # 且其错误码不互通，只能使用无码 ignore）。运行时已验证正常。
    g = StateGraph(AgentState)  # type: ignore
    g.add_node("keyword_optimize", keyword_optimize)
    if settings.match_pipeline_version == "combined":
        g.add_node("analyze_match", analyze_match)
        g.set_entry_point("analyze_match")
        g.add_edge("analyze_match", "keyword_optimize")
    else:
        g.add_node("jd_extract", jd_extract)
        g.add_node("resume_match", resume_match)
        g.set_entry_point("jd_extract")
        g.add_edge("jd_extract", "resume_match")
        g.add_edge("resume_match", "keyword_optimize")
    g.add_edge("keyword_optimize", END)
    return g.compile()


async def run_match(
    master_text: str,
    jd_text: str,
) -> tuple[list[str], str, dict | None]:
    """执行匹配工作流，返回 (关键词, 优化后简历, 匹配分析)。

    匹配方式已统一为 optimize（描述/模块级优化），不再由 LLM 判定 rewrite/optimize，
    因此不再返回匹配方式字段。
    匹配分析为 resume_match 节点产出的结构化结果（岗位角色、得分、匹配项、总结），
    下游节点不直接消费但前端需要展示，因此一并回传。
    话术已解耦为独立链路（run_cover_letter），本函数不再产出求职信。
    """
    if not is_configured():
        raise RuntimeError("LLM 未配置：请在 .env 设置 LLM_API_KEY 等参数")

    async def _run_once() -> tuple[list[str], str, dict | None]:
        graph = build_graph()
        init: AgentState = {
            "resume_text": master_text,
            "jd_text": jd_text,
        }
        result = await graph.ainvoke(init)

        # 正常节点失败会直接抛 MatchStageError；保留 error 状态检查，兼容未来或
        # 外部节点显式返回失败状态，避免静默返回空简历。
        if result.get("error"):
            raise RuntimeError(f"匹配流程执行失败：{result['error']}")

        resume_raw = result.get("markdown_content", "")
        match_results = result.get("resume_match_results")
        analysis = (
            match_results.model_dump(exclude_none=True) if match_results else None
        )

        return (
            result.get("keywords", []),
            resume_raw,
            analysis,
        )

    with match_request():
        t0 = time.perf_counter()
        total_timeout = settings.match_total_timeout_seconds
        deadline_token = _match_deadline.set(_monotonic() + total_timeout)
        try:
            async with asyncio.timeout(total_timeout):
                return await _run_once()
        except asyncio.TimeoutError:
            # LLM 接口无响应导致整体超时：返回 503 而非让事件循环永久 pending
            logger.exception("匹配工作流整体超时")
            raise RuntimeError("匹配请求超时（LLM 接口未在规定时间内响应），请稍后重试")
        except RuntimeError:
            # 节点异常已带 stage 名并记录完整堆栈，直接交给路由转成 503。
            raise
        except Exception as e:
            logger.error("匹配工作流执行失败 | error_type=%s", type(e).__name__)
            raise RuntimeError(f"匹配请求处理失败：{e}") from e
        finally:
            _match_deadline.reset(deadline_token)
            logger.info("匹配工作流总耗时 %.1fs", time.perf_counter() - t0)
