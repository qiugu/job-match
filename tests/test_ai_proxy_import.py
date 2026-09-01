"""AI 简历导入（PDF）契约测试：约束「结构锚点」防回归。

背景（回归教训）：编辑器导入 PDF 的结构化解析曾把 extract_pdf_text 的
纯 layout 文本直接喂给 LLM——纯文本丢失层级/版面结构，LLM 无结构锚点
只能靠猜，解析出的简历模块归属与列表层级错乱。修复后与匹配基准
markdown_content 同源：优先用 extract_markdown_structure 的层级
Markdown 骨架（#/## 标题、列表符、**加粗**）作为 LLM 输入，结构提取
失败回退纯文本。本文件锁定该契约：
1. 传给 LLM 的文本必须是层级 Markdown（含标题/列表结构信号）；
2. 结构提取失败时回退纯文本，导入不中断；
3. 两路都提取不到文本（如扫描件）时给出明确错误；
4. 导入 prompt 必须包含结构信号映射规则（防止被删导致回归）；
5. 版式元数据（layout）独立于 LLM 附加到结果。
"""

import io

import pytest

from app.services import ai_proxy


def _build_pdf() -> bytes:
    """构造带标题层级/正文/列表的真实 PDF（reportlab，英文内容）。"""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    # 一级标题（大字号 + 加粗）
    c.setFont("Helvetica-Bold", 20)
    c.drawString(72, 780, "Work Experience")
    # 正文
    c.setFont("Helvetica", 12)
    c.drawString(72, 760, "Led a system rewrite.")
    # 列表项
    c.drawString(72, 744, "- Built core modules.")
    c.drawString(72, 728, "- Improved latency by 40%")
    c.showPage()
    c.save()
    return buf.getvalue()


@pytest.fixture
def captured_import(monkeypatch):
    """替换 LLM 调用，捕获喂给 LLM 的文本；同时固定 layout 元数据。"""
    captured: dict = {}

    async def fake_resume_import(content, images, locale):
        captured["text"] = content
        captured["images"] = images
        captured["locale"] = locale
        return {"basic": {"name": "Test User"}}

    async def fake_extract_pdf_layout(_data):
        return {"pageSize": "A4", "pageCount": 1}

    monkeypatch.setattr(ai_proxy, "is_configured", lambda: True)
    monkeypatch.setattr(ai_proxy, "resume_import", fake_resume_import)
    monkeypatch.setattr(ai_proxy, "extract_pdf_layout", fake_extract_pdf_layout)
    return captured


@pytest.mark.asyncio
async def test_resume_import_from_pdf_feeds_markdown_structure_to_llm(
    captured_import,
):
    """核心契约：LLM 输入必须是层级 Markdown，而非纯 layout 文本。

    纯 layout 文本无 #/列表 结构信号，LLM 无锚点导致导入格式错乱（回归根因）。
    """
    data = _build_pdf()
    parsed = await ai_proxy.resume_import_from_pdf(data, "zh")

    text = captured_import["text"]
    assert text is not None
    # 标题结构信号：pymupdf4llm 对 20pt 大字号加粗标题输出 `# **Work Experience**`
    # （`#` 标题前缀 + 加粗），证明喂给 LLM 的是带标题层级的 Markdown，而非纯文本。
    assert "# Work Experience" in text or "**Work Experience**" in text
    # 列表结构信号：行首列表符原样保留
    assert "- Built core modules." in text
    # 正文完整
    assert "Led a system rewrite." in text
    # 版式元数据独立于 LLM 附加
    assert parsed["layout"]["pageSize"] == "A4"
    assert parsed["basic"]["name"] == "Test User"


@pytest.mark.asyncio
async def test_resume_import_from_pdf_falls_back_when_pymupdf_unavailable(
    captured_import, monkeypatch
):
    """pymupdf4llm 不可用时（未安装/抛错）回退到自研结构提取，导入不中断。"""

    # 主路径（pymupdf4llm）不可用
    monkeypatch.setattr(ai_proxy, "extract_markdown_via_pymupdf", lambda _d: "")
    parsed = await ai_proxy.resume_import_from_pdf(_build_pdf(), "zh")

    text = captured_import["text"]
    # 回退到自研 span 级结构提取（Helvetica 标准字体可正确重建 # 标题）
    assert "# Work Experience" in text
    assert "Work Experience" in text
    assert parsed["layout"]["pageSize"] == "A4"


@pytest.mark.asyncio
async def test_resume_import_from_pdf_falls_back_to_plain_text(
    captured_import, monkeypatch
):
    """结构提取全失败时回退纯文本，导入不中断。"""

    monkeypatch.setattr(ai_proxy, "extract_markdown_via_pymupdf", lambda _d: "")

    def _boom(_data):
        raise RuntimeError("结构提取失败")

    monkeypatch.setattr(ai_proxy, "extract_markdown_structure", _boom)
    parsed = await ai_proxy.resume_import_from_pdf(_build_pdf(), "zh")

    text = captured_import["text"]
    # 回退的是纯文本（无 markdown 结构标记），但内容完整
    assert "# Work Experience" not in text
    assert "Work Experience" in text
    assert parsed["layout"]["pageSize"] == "A4"


@pytest.mark.asyncio
async def test_resume_import_from_pdf_empty_text_raises(monkeypatch):
    """两路都提取不到文本（如扫描件）时，必须给出明确错误而非空结果。"""

    async def fake_extract_pdf_text(_data):
        return ""

    monkeypatch.setattr(ai_proxy, "is_configured", lambda: True)
    monkeypatch.setattr(ai_proxy, "extract_markdown_structure", lambda _d: "")
    monkeypatch.setattr(ai_proxy, "extract_pdf_text", fake_extract_pdf_text)

    with pytest.raises(RuntimeError, match="无法从 PDF 提取文本内容"):
        await ai_proxy.resume_import_from_pdf(b"\x00" * 64, "zh")


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
    # 加粗片段映射关键字段的规则
    assert "**" in system


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
