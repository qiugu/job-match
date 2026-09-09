"""AI 简历导入（LLM 结构化）契约测试：约束「结构锚点」防回归。

背景（回归教训）：编辑器导入 PDF 的结构化解析曾把 extract_pdf_text 的
纯 layout 文本直接喂给 LLM——纯文本丢失层级/版面结构，LLM 无结构锚点
只能靠猜，解析出的简历模块归属与列表层级错乱。修复后与匹配基准
markdown_content 同源：调用方（前端 / 路由）优先用层级 Markdown 骨架
（#/## 标题、列表符、**加粗**）作为 resume_import 的 content 输入。

本文件锁定该契约（针对现存的 ai_proxy.resume_import 入口）：
1. resume_import 必须原样把 content（层级 Markdown）透传给 LLM，不篡改结构信号；
2. 返回可直接解析为 dict 的结果；
3. content 为空 / LLM 未返回可解析 JSON 时必须给出明确错误（不静默吞掉）；
4. 导入 prompt（RESUME_IMPORT_SYSTEM）必须包含结构信号映射规则（防被删导致回归）；
5. 技能数组粒度约束（一项 = 原文一行，禁止拆词、禁止丢分组前缀）。

注：PDF→层级 Markdown 的提取本身在 app.services.pdf_parser，已由
test_pdf_parser.py 覆盖；版式元数据（layout）由路由层附加，与 LLM 导入解耦。
"""

import pytest

from app.services import ai_proxy


def _capture_llm(monkeypatch, captured, content_json='{"basic": {"name": "Test User"}}'):
    """替换 get_llm / is_configured，捕获透传给 LLM 的 messages，固定返回 JSON。"""

    class _FakeResp:
        content = content_json

    class _FakeLLM:
        async def ainvoke(self, messages, response_format=None):
            captured["messages"] = messages
            return _FakeResp()

    monkeypatch.setattr(ai_proxy, "get_llm", lambda **kwargs: _FakeLLM())
    monkeypatch.setattr(ai_proxy, "is_configured", lambda: True)


@pytest.mark.asyncio
async def test_resume_import_passes_markdown_structure_to_llm(monkeypatch):
    """核心契约：resume_import 必须把层级 Markdown content 原样透传给 LLM。"""
    captured: dict = {}
    _capture_llm(monkeypatch, captured)

    content = (
        "# Work Experience\n"
        "- Led a system rewrite.\n"
        "- Built core modules.\n"
        "**Senior Engineer**"
    )
    parsed = await ai_proxy.resume_import(content, None, "en")

    # 透传给 LLM 的 user content（parts 列表第一项）必须包含原始层级结构信号
    user_parts = captured["messages"][1]["content"]
    text = user_parts[0]["text"]
    assert "# Work Experience" in text
    assert "- Led a system rewrite." in text
    assert "**Senior Engineer**" in text
    # 系统 prompt 为结构映射规则（即 RESUME_IMPORT_SYSTEM 本身）
    assert ai_proxy.RESUME_IMPORT_SYSTEM in captured["messages"][0]["content"]
    # 返回解析结果
    assert parsed["basic"]["name"] == "Test User"


@pytest.mark.asyncio
async def test_resume_import_empty_content_raises(monkeypatch):
    """content 为空时，LLM 未返回可解析 JSON → 必须给出明确错误而非空结果。"""
    captured: dict = {}
    _capture_llm(monkeypatch, captured, content_json="这不是合法 JSON")

    with pytest.raises(RuntimeError):
        await ai_proxy.resume_import("", None, "zh")


def test_resume_import_system_prompt_has_structure_mapping():
    """导入 prompt 必须包含层级 Markdown 的结构信号映射规则。

    若删除该说明，LLM 收到结构骨架也不知道如何映射，格式会再次错乱。
    """
    system = ai_proxy.RESUME_IMPORT_SYSTEM
    assert "Markdown" in system
    # 标题信号说明（#/##）
    assert "`#`/`##`" in system
    # 列表条目按原顺序进入 details/description 的规则
    assert "details/description" in system
    # 加粗片段映射关键字段的规则（原契约记为 `**`，现 prompt 用语义化「加粗文本」）
    assert "加粗文本" in system


def test_resume_import_system_prompt_keeps_skills_line_granularity():
    """技能数组粒度约束：一项 = 原文一行，禁止拆词、禁止丢分组前缀。

    回归教训：prompt 曾对 skills 数组粒度零约束，LLM 把原文
    「Frontend: React / TypeScript / ...」整行拆成单词数组，分组前缀
    全部丢失（用户看到「技能截断，一词一行」）。已用真实 LLM 对照实验
    实锤：骨架正确保留分组行，LLM 仍拆词；补充该规则后不再拆。
    """
    system = ai_proxy.RESUME_IMPORT_SYSTEM
    # 粒度必须与原文行一致
    assert "粒度必须与原文行一致" in system
    # 禁止拆词 + 禁止丢前缀，两条都要在
    assert "严禁把一行内的多个技能词拆成多个数组项" in system
    assert "严禁丢弃分组前缀" in system
