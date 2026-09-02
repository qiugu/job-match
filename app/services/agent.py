"""简历匹配 Agent：基于 LangGraph 的多节点工作流。

流程：
  1. jd_extract       —— 从 JD 提取关键词（技能/经验/要求），打平为 keywords
  2. resume_match     —— 基于 JD 分析结果与简历的匹配关系，产出匹配项、优化建议
                         与求职信话术（MatchResult.cover_letter）
  3. keyword_optimize —— 关键词/模块级优化：保持简历大结构，在建议指导下
                         优化措辞，允许有依据时新增/删除条目或模块（markdown）

已删除 refactor_mode（rewrite/optimize）分支：统一走 keyword_optimize。
rewrite_resume / generate_cover_letter 节点代码留存但不再路由（求职信复用
resume_match 的 MatchResult.cover_letter，不再单独调用一次 LLM）。

状态在节点间以 TypedDict 传递，最终产出优化后的 markdown 简历与可选求职信。
"""
from __future__ import annotations

import asyncio
import json
import time
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


class MatchTimeoutError(RuntimeError):
    """整体匹配工作流因「超时 / 可重试类错误」在耗尽重试次数后仍失败。

    调用方（app/api/match.py）据此返回 503 + 「请稍后重试」文案，并退回本次额度
    （超时重试不消耗匹配次数）。
    """


class MatchPermanentError(RuntimeError):
    """匹配因「不可重试类错误」（4xx：鉴权/余额/内容策略/入参错误等）失败。

    这类错误重试无意义，调用方应立即停止响应、退回额度并透传明确错误，不再重试。
    """


def _error_status_code(exc: BaseException) -> int | None:
    """尽可能从底层异常中还原 HTTP 状态码（langchain/openai 异常会携带）。"""
    # openai / langchain 异常通常把原始状态码放在这些属性上
    for attr in ("status_code", "code"):
        val = getattr(exc, attr, None)
        if isinstance(val, int):
            return val
    # 嵌套原因（如 httpx 包装）
    cause = getattr(exc, "__cause__", None) or getattr(exc, "__context__", None)
    if cause is not None and cause is not exc:
        code = _error_status_code(cause)
        if code is not None:
            return code
    return None


def _is_retryable_error(exc: BaseException) -> bool:
    """判断失败是否属于「可重试」类。

    可重试：超时、连接/网络错误、5xx、429（限流）。
    不可重试（立即停止）：4xx（鉴权 401/403、余额 402、内容策略 400、入参 422 等）。
    """
    if isinstance(exc, asyncio.TimeoutError):
        return True
    # 连接 / 网络类异常（无状态码，通常瞬时）
    for cls_name in ("ConnectionError", "ConnectError", "Timeout", "TransportError"):
        if type(exc).__name__ in (cls_name, f"httpx.{cls_name}"):
            return True
    code = _error_status_code(exc)
    if code is not None:
        return code >= 500 or code == 429
    # 无法判断状态码时，默认为「超时类」按可重试处理，避免误杀瞬时故障
    return True


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
    t0 = time.perf_counter()
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
            # 打平为关键词列表：此前没有任何节点写入 state["keywords"]，
            # 导致 keyword_optimize 的 {kw}、API 返回值与前端关键词高亮全部失效。
            state["keywords"] = _flatten_keywords(resp)
    except Exception as e:
        # 兜底：JD 提取失败时也要写入空结果，避免下游因缺失
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
    finally:
        logger.info("节点 jd_extract 耗时 %.1fs", time.perf_counter() - t0)
    return state


async def resume_match(state: AgentState) -> AgentState:
    t0 = time.perf_counter()
    jd_analyze_results = state.get("jd_analyze_results")
    # 上游（jd_extract）未产出分析结果时跳过，避免 KeyError 崩溃。
    if jd_analyze_results is None:
        state["error"] = state.get("error") or "JD 分析未产出结果，无法执行匹配"
        return state
    # 消费 jd_extract 的格式化结果（结构化 JD 要点）进行匹配。
    prompt = RESUME_MATCHER_PROMPT.format(
        jd_analyze_results=jd_analyze_results.model_dump_json(),
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
    except Exception as e:
        logger.exception("简历匹配节点失败: %s", e)
        state["error"] = str(e)
    finally:
        logger.info("节点 resume_match 耗时 %.1fs", time.perf_counter() - t0)
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
    t0 = time.perf_counter()
    resume_match_results = state.get("resume_match_results")
    if resume_match_results is None:
        state["error"] = state.get("error") or "匹配结果缺失，无法优化关键词"
        return state
    kw = "、".join(state.get("keywords", []))
    # 紧凑 JSON（不带 indent）：indent=2 的缩进/换行会额外增加 30%+ 的输入 token，
    # 抬高 TTFT 与费用，对模型解析没有帮助。
    prompt = KEYWORDS_OPTIMIZE.format(
        resume_match_results=resume_match_results.model_dump_json(
            exclude=set(["cover_letter", "resume_match_results"])
        ),
        resume_text=state["resume_text"],
        kw=kw
    )
    try:
        resp = await asyncio.wait_for(
            model.ainvoke(prompt), timeout=settings.llm_timeout
        )
        state["markdown_content"] = _strip(_to_text(resp.content))
    finally:
        logger.info(
            "节点 keyword_optimize 耗时 %.1fs（注入关键词 %d 个）",
            time.perf_counter() - t0,
            len(state.get("keywords", [])),
        )
    return state


async def generate_cover_letter(state: AgentState) -> AgentState:
    """（留档，未接入图）求职信已由 resume_match 节点顺带产出
    （MatchResult.cover_letter 随匹配分析一起生成），单独再调一次 LLM 生成
    同样的内容纯属浪费时长；run_match 直接取该字段返回。"""
    if not state.get("with_cover_letter"):
        return state
    prompt = COVER_LETTER_PROMPT.format(
        jd_text=state["jd_text"],
        resume_text=state["resume_text"]
    )
    resp = await asyncio.wait_for(model.ainvoke(prompt), timeout=settings.llm_timeout)
    state["cover_letter"] = _to_text(resp.content).strip()
    return state


def build_graph():
    # Pyrefly/ty 无法对 TypedDict 类做结构匹配（langgraph StateT 上界 TypedDictLikeV1/V2，
    # 且其错误码不互通，只能使用无码 ignore）。运行时已验证正常。
    g = StateGraph(AgentState)  # type: ignore
    g.add_node("jd_extract", jd_extract)
    g.add_node("resume_match", resume_match)
    g.add_node("keyword_optimize", keyword_optimize)

    g.set_entry_point("jd_extract")
    g.add_edge("jd_extract", "resume_match")
    # 已删除 refactor_mode 分支：统一走 keyword_optimize（描述/模块级优化）。
    # rewrite_resume / generate_cover_letter 节点保留（代码留存不路由）。
    g.add_edge("resume_match", "keyword_optimize")
    g.add_edge("keyword_optimize", END)
    return g.compile()


async def run_match(
    master_text: str,
    jd_text: str,
    with_cover_letter: bool,
) -> tuple[list[str], str, str, dict | None]:
    """执行匹配工作流，返回 (关键词, 优化后简历, 求职信, 匹配分析)。

    匹配方式已统一为 optimize（描述/模块级优化），不再由 LLM 判定 rewrite/optimize，
    因此不再返回匹配方式字段。
    求职信复用 resume_match 节点顺带产出的 MatchResult.cover_letter（仅在
    with_cover_letter=True 时随响应返回），不再单独调用 LLM。
    匹配分析为 resume_match 节点产出的结构化结果（岗位角色、得分、匹配项、总结），
    下游节点不直接消费但前端需要展示，因此一并回传。
    """
    if not is_configured():
        raise RuntimeError("LLM 未配置：请在 .env 设置 LLM_API_KEY 等参数")

    async def _run_once() -> tuple[list[str], str, str, dict | None]:
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
        match_results = result.get("resume_match_results")
        analysis = (
            match_results.model_dump(exclude_none=True) if match_results else None
        )
        # 求职信复用 resume_match 的产出（随匹配分析一起生成）：
        # generate_cover_letter 节点从未接入图，原实现下 with_cover_letter 一直不生效。
        cover = ""
        if with_cover_letter and match_results is not None:
            cover = (match_results.cover_letter or "").strip()

        return (
            result.get("keywords", []),
            resume_raw,
            cover,
            analysis,
        )

    t0 = time.perf_counter()
    last_exc: BaseException | None = None
    attempts = 1 + max(0, settings.llm_timeout_retries)
    for attempt in range(1, attempts + 1):
        try:
            # 重置机制：每次尝试都基于全新的 AgentState 启动工作流，
            # 避免上一次失败（超时/异常）残留的半成品状态污染下一次尝试。
            return await _run_once()
        except ValidationError as e:
            # LLM 输出不稳定导致结构无法验证：工作流内部已重试一次，
            # 此处仍失败视为「不可重试」——错误来自模型输出格式而非瞬时故障，
            # 继续重试只会重复同样的解析失败，立即停止并透传明确错误。
            logger.exception("LLM 结构化输出无法解析（不可重试），停止匹配")
            raise MatchPermanentError(
                f"LLM 输出的简历结构无法解析，请调整后重试：{str(e)[:120]}"
            ) from e
        except asyncio.TimeoutError as e:
            # 整体超时：属于「可重试」类，记一次重试；若还有重试次数则重置状态后重跑。
            last_exc = e
            logger.warning(
                "匹配工作流整体超时（第 %d/%d 次尝试），将重置状态后重试",
                attempt, attempts,
            )
            # 直接进入下一次循环（_run_once 内会重建全新 state）
            continue
        except MatchPermanentError:
            # 节点内已明确判定为不可重试错误（如内容策略/鉴权），立即上抛，不重试。
            raise
        except RuntimeError as e:
            # 业务上抛出的可预期错误（LLM 未配置等）。LLM 未配置属永久不可用，
            # 重试无意义；其它 RuntimeError 按「不可重试」处理并透传。
            logger.warning("匹配流程可预期错误（不可重试），停止匹配: %s", e)
            raise
        except Exception as e:  # noqa: BLE001
            # 节点内未捕获的 LLM 网络/厂商异常在此冒泡：按状态码区分可重试/不可重试。
            if _is_retryable_error(e):
                last_exc = e
                logger.warning(
                    "匹配工作流异常（可重试，第 %d/%d 次尝试）: %s",
                    attempt, attempts, e,
                )
                continue
            code = _error_status_code(e)
            logger.warning(
                "匹配工作流异常（不可重试，状态码=%s），停止匹配: %s",
                code, e,
            )
            raise MatchPermanentError(f"匹配请求处理失败：{e}") from e

    # 抵达此处说明所有尝试均因「可重试」类错误（超时/5xx/429/连接）失败。
    logger.error(
        "匹配工作流在 %d 次尝试后仍因可重试错误失败，最后一次: %s",
        attempts, last_exc,
    )
    raise MatchTimeoutError("匹配请求超时（LLM 接口未在规定时间内响应），请稍后重试")
