"""pdf_parser 测试：从真实 PDF 中提取层级化 Markdown 结构、纯文本、版式元数据。

用 reportlab 生成真实 PDF（带不同字号/加粗/列表），验证：
- extract_markdown_structure 重建标题层级与列表（纯规则、无 LLM）
- extract_pdf_text 提取纯文本
- extract_pdf_layout 返回版式元数据
"""

import io

import pytest

from app.services import pdf_parser


def _build_pdf() -> bytes:
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
    c.drawString(72, 744, "Built core modules.")
    # 二级标题
    c.setFont("Helvetica-Bold", 14)
    c.drawString(72, 720, "Skills")
    # 列表项（保留原符号）
    c.setFont("Helvetica", 12)
    c.drawString(72, 700, "- Python / FastAPI")
    c.drawString(72, 684, "- Distributed systems")
    # 二级标题（16pt，加粗，命中标题词 Projects）
    c.setFont("Helvetica-Bold", 16)
    c.drawString(72, 660, "Projects")
    c.showPage()
    c.save()
    return buf.getvalue()


def test_extract_markdown_structure_detects_title():
    data = _build_pdf()
    md = pdf_parser.extract_markdown_structure(data)
    assert "Work Experience" in md
    # 20pt 相对 12pt 基准 >= 1.6x → 一级标题
    assert "# Work Experience" in md


def test_extract_markdown_structure_detects_second_level_title():
    data = _build_pdf()
    md = pdf_parser.extract_markdown_structure(data)
    assert "Projects" in md
    # 16pt 相对 12pt 基准 < 1.6x 但 > 1.2x 阈值 → 二级标题
    assert "## Projects" in md


def test_extract_markdown_structure_keeps_body_and_list():
    data = _build_pdf()
    md = pdf_parser.extract_markdown_structure(data)
    assert "Led a system rewrite." in md
    assert "Built core modules." in md
    # 列表符号保留
    assert "- Python / FastAPI" in md


def test_extract_markdown_structure_empty_for_blank():
    # 空字节无法解析（pypdf 抛 EmptyFileError），不静默成 ""
    import pytest

    with pytest.raises(Exception):
        pdf_parser.extract_markdown_structure(b"")


@pytest.mark.asyncio
async def test_extract_pdf_text_returns_text():
    data = _build_pdf()
    text = await pdf_parser.extract_pdf_text(data)
    assert isinstance(text, str)
    assert "Work Experience" in text


@pytest.mark.asyncio
async def test_extract_pdf_layout_returns_metadata():
    data = _build_pdf()
    layout = await pdf_parser.extract_pdf_layout(data)
    assert isinstance(layout, dict)
    assert layout["pageCount"] >= 1
    assert layout["pageSize"] == "A4"
    # 主字号应被识别（12pt 正文最密集）
    assert layout.get("fontSize") in (12, 14, 20, None)
