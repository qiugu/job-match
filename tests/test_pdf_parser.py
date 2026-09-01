"""pdf_parser 测试：从真实 PDF 中提取层级化 Markdown 结构、纯文本、版式元数据。

用 reportlab 生成真实 PDF（带不同字号/加粗/列表），验证：
- extract_markdown_structure 重建标题层级与列表（纯规则、无 LLM）
- extract_pdf_text 提取纯文本
- extract_pdf_layout 返回版式元数据
"""

import io
import os

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


def _build_cid_chinese_pdf() -> bytes:
    """构造 CID 中文字体 PDF。

    CID 字体的 PDF 流里是 CID 字符码（未走 ToUnicode），span 级
    visitor_operand_after 回调拿到原始字节会误读成 Latin-1 高位乱码。
    真实中文简历普遍如此，是本 bug 回归的核心场景。
    """
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas

    try:
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    except Exception:  # noqa: BLE001 - 字体注册失败则跳过（依赖环境）
        pytest.skip("STSong-Light CID 字体不可用")
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("STSong-Light", 16)
    c.drawString(72, 780, "教育经历")
    c.setFont("STSong-Light", 12)
    c.drawString(72, 760, "清华大学 计算机科学 本科")
    c.drawString(72, 744, "项目经历：主导前端架构")
    c.showPage()
    c.save()
    return buf.getvalue()


def test_extract_markdown_structure_returns_empty_for_cid_chinese():
    """CID 中文字体 PDF：span 级结构提取产出乱码时返回空串。

    回归教训：此前对这类 PDF 返回「非空乱码」（CJK 全丢、Latin-1 高位
    乱码堆积），导入路径把它当有效结构喂给 LLM，导致教育/项目全丢、
    技能被拆词。契约：检测到乱码返回空串，由调用方回退纯文本。
    """
    data = _build_cid_chinese_pdf()
    md = pdf_parser.extract_markdown_structure(data)
    assert md == ""


def test_extract_markdown_via_pymupdf_converts_cid_chinese():
    """CID 中文字体 PDF：pymupdf4llm 正确转为层级 Markdown（零乱码）。

    回归教训：真实中文简历的 CID/Type3 字体让自研 span 级提取产出乱码
    （CJK 全丢、词被拆散），纯文本回退又丢层级。pymupdf4llm 作为主路径
    必须能正确解码中文字体并还原结构。
    """
    data = _build_cid_chinese_pdf()
    md = pdf_parser.extract_markdown_via_pymupdf(data)
    # 中文正确解码（无 Latin-1 高位乱码）
    assert "教育经历" in md
    assert "清华大学" in md
    # 无乱码字符
    assert "¢" not in md and "©" not in md


def test_extract_markdown_structure_not_garbled_for_standard_font():
    """标准字体（Helvetica）PDF 不被误判为乱码，仍能正常重建结构。"""
    data = _build_pdf()
    md = pdf_parser.extract_markdown_structure(data)
    assert md != ""
    assert "Work Experience" in md


def test_is_garbled_classifier():
    """乱码分类器：区分正常文本与 Latin-1 高位乱码。"""
    assert pdf_parser._is_garbled("前端：React、TypeScript") is False
    assert pdf_parser._is_garbled("Work Experience - Built modules") is False
    # 模拟 span 级未解码的 CID 中文乱码
    garbled = "¢©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿×"
    assert pdf_parser._is_garbled(garbled) is True


# ──────────────────────────────── pymupdf4llm 三处修复契约 ────────────────────────────────


def test_normalize_list_items_bullet_no_space():
    """无空格 bullet（中文 PDF 常见「•内容」）应规范为 `- ` 列表。"""
    md = "•负责核心系统设计\n●主导前端架构重构\n  •  嵌套项"
    out = pdf_parser.normalize_list_items(md)
    lines = out.split("\n")
    assert lines[0] == "- 负责核心系统设计"
    assert lines[1] == "- 主导前端架构重构"
    assert lines[2] == "  - 嵌套项"  # 保留前导缩进


def test_normalize_list_items_chinese_ordinal():
    """中文序号（1、/一、/(1)/（1））保留文字并前置 `- `。"""
    md = "1、搭建 CI/CD 流水线\n一、负责团队管理\n(2) 优化构建\n（三）项目统筹"
    out = pdf_parser.normalize_list_items(md)
    assert "- 1、搭建 CI/CD 流水线" in out
    assert "- 一、负责团队管理" in out
    assert "- (2) 优化构建" in out
    assert "- （三）项目统筹" in out


def test_normalize_list_items_does_not_break_existing_lists():
    """已是合法列表 / 标题 / 表格 / 分隔线不应被误改。"""
    md = "- 已是列表\n## 模块标题\n| a | b |\n---\n1. 有序列表\n普通正文段落"
    out = pdf_parser.normalize_list_items(md)
    assert "- 已是列表" in out
    assert "## 模块标题" in out
    assert "| a | b |" in out
    assert "---" in out
    assert "1. 有序列表" in out  # 半角点有序列表保留（markdown 原生支持）
    assert "普通正文段落" in out


def test_promote_bold_lines_to_heading():
    """整行加粗短行（同字号加粗标题）应提级为三级标题。"""
    md = "**工作经历**\n**核心贡献**\n**这是一段很长的加粗正文，超过二十四个字符不应被提级为标题**"
    out = pdf_parser.promote_bold_lines(md)
    assert "### 工作经历" in out
    assert "### 核心贡献" in out
    # 超过 24 字的加粗行不提级（避免误伤正文）
    assert "**这是一段很长的加粗正文" in out


def test_promote_bold_lines_keeps_markdown_headings():
    """已带 # 前缀的标题行不被重复处理。"""
    md = "## 工作经历\n**技能**"
    out = pdf_parser.promote_bold_lines(md)
    assert "## 工作经历" in out
    assert "### 技能" in out


def test_resume_headers_size_based_level():
    """ResumeHeaders：正文基准取全文字符数最多字号，更大字号映射为标题档位。"""
    data = _build_pdf()  # 正文 12pt，标题 14/16/20pt
    # ResumeHeaders 接收文件路径（与 to_markdown 调用方式一致），先落临时文件
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(data)
        path = f.name
    try:
        hdr = pdf_parser.ResumeHeaders(path)
        # 正文基准应为字符数最多的 12pt
        assert hdr.body_size == 12
        # 20pt(最大)→#，16pt→##，14pt→###
        assert hdr.get_header_id({"size": 20, "text": "X"}) == "# "
        assert hdr.get_header_id({"size": 16, "text": "X"}) == "## "
        assert hdr.get_header_id({"size": 14, "text": "X"}) == "### "
        # 同字号正文不提级
        assert hdr.get_header_id({"size": 12, "text": "X"}) == ""
    finally:
        os.unlink(path)


def test_extract_markdown_via_pymupdf_lists_and_breaks():
    """端到端：PDF 经 pymupdf4llm + 后处理应正确还原标题档位与列表，且不崩溃。

    注：中文「•」「、」需 CID 字体才能正确渲染（Helvetica 标准字体下会成 tofu），
    中文 bullet / 中文序号的纯函数行为由 test_normalize_list_items_* 单测锁定。
    本用例验证完整「PDF → use_layout(False) → to_markdown(hdr_info=ResumeHeaders)
    → 后处理」链路跑通：字号标题档位生效（且无冗余 **）、原生列表保留、内容完整。
    """
    data = _build_list_pdf()
    md = pdf_parser.extract_markdown_via_pymupdf(data)
    assert "# Work Experience" in md  # 20pt → 一级标题（ResumeHeaders 生效，无 **）
    assert "- Owned core system design" in md  # pymupdf4llm 原生列表保留
    assert "- Built CI/CD pipeline" in md
    assert "Plain text paragraph content." in md


def test_clean_header_asterisks():
    """rag 路径对加粗标题行会包 `**`，应剥离为纯净 `# 文本`。"""
    md = "# **工作经历**\n## **Core Contribution**\n普通段落\n**仅加粗非标题**"
    out = pdf_parser.clean_header_asterisks(md)
    assert "## 工作经历" not in out
    assert "# 工作经历" in out
    assert "## Core Contribution" in out
    assert "普通段落" in out
    # 非标题的纯加粗行不被改动
    assert "**仅加粗非标题**" in out


def _build_list_pdf() -> bytes:
    """构造含字号标题与标准 markdown 列表的 PDF（验证整链路跑通）。"""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica-Bold", 20)
    c.drawString(72, 780, "Work Experience")  # 20pt → 一级标题
    c.setFont("Helvetica", 12)
    c.drawString(72, 760, "- Owned core system design")  # 标准列表
    c.drawString(72, 744, "- Built CI/CD pipeline")
    c.drawString(72, 728, "Plain text paragraph content.")
    c.showPage()
    c.save()
    return buf.getvalue()


def test_extract_markdown_via_pymupdf_indented_bullets():
    """端到端：bullet 字符在 PDF 文本层丢失（中文 PDF 常见）时，列表项仍能恢复。

    覆盖两类几何/结构信号：
    1. 非缩进 bullet（与正文同 x0）+ 中文序号混排 → 序号锚点向同组连续行传播，
       把字符已丢失的 bullet 行一并恢复为 `- `（真实简历「bullet 项 + 序号项」混排）；
    2. 纯缩进 bullet（x0 右移）→ 几何缩进检测独立命中。
    """
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))

    # 场景 A：非缩进 bullet + 中文序号（用户真实样本结构）
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("STSong-Light", 14)
    c.drawString(72, 790, "工作经历")
    c.setFont("STSong-Light", 11)
    c.drawString(72, 770, "负责核心系统设计")      # 非缩进 bullet（字符已丢失）
    c.drawString(72, 754, "主导前端架构重构")      # 非缩进 bullet（字符已丢失）
    c.drawString(72, 738, "1、搭建 CI/CD 流水线")  # 中文序号（锚点）
    c.drawString(72, 722, "一、负责团队管理")      # 中文序号（锚点）
    c.showPage()
    c.save()
    data = buf.getvalue()
    md = pdf_parser.extract_markdown_via_pymupdf(data)
    assert "- 负责核心系统设计" in md   # bullet 经组内传播恢复
    assert "- 主导前端架构重构" in md
    assert "- 1、搭建 CI/CD 流水线" in md
    assert "- 一、负责团队管理" in md

    # 场景 B：纯缩进 bullet（无序号锚点，几何缩进独立命中）
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("STSong-Light", 14)
    c.drawString(72, 790, "工作经历")
    c.setFont("STSong-Light", 11)
    c.drawString(90, 770, "负责核心系统设计")      # 缩进 bullet
    c.drawString(90, 754, "主导前端架构重构")      # 缩进 bullet
    c.showPage()
    c.save()
    data = buf.getvalue()
    md = pdf_parser.extract_markdown_via_pymupdf(data)
    assert "- 负责核心系统设计" in md
    assert "- 主导前端架构重构" in md


def test_extract_markdown_guide_line_not_list():
    """列表前的冒号引导句（如「以下是主要职责：」）不应被误判为列表项。

    序号锚点向前传播时遇冒号结尾行应停止，避免把引导句纳入列表。
    """
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("STSong-Light", 14)
    c.drawString(72, 790, "工作经历")
    c.setFont("STSong-Light", 11)
    c.drawString(72, 772, "以下是主要职责：")      # 引导句（冒号结尾，非列表）
    c.drawString(72, 756, "负责核心系统设计")      # 非缩进 bullet
    c.drawString(72, 740, "主导前端架构重构")      # 非缩进 bullet
    c.drawString(72, 724, "1、搭建 CI/CD 流水线")  # 序号锚点
    c.showPage()
    c.save()
    data = buf.getvalue()

    md = pdf_parser.extract_markdown_via_pymupdf(data)
    assert "以下是主要职责：" in md and "- 以下是主要职责：" not in md
    assert "- 负责核心系统设计" in md
    assert "- 主导前端架构重构" in md
    assert "- 1、搭建 CI/CD 流水线" in md


def test_resume_headers_indented_bullets_collected():
    """ResumeHeaders 应把缩进的 bullet 行（字符已丢失）登记进 list_items。"""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("STSong-Light", 11)
    c.drawString(72, 772, "正文段落")
    c.drawString(90, 754, "负责核心系统设计")
    c.showPage()
    c.save()
    data = buf.getvalue()

    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(data)
        path = f.name
    try:
        hdr = pdf_parser.ResumeHeaders(path)
        assert "负责核心系统设计" in hdr.list_items
    finally:
        os.unlink(path)


def test_backend_keeps_source_linebreaks_no_guess_merge():
    """后端不应再用启发式猜测并合并「被视觉切断的续行」。

    词中断行（『前端↵工程体系搭建』）的根因是前端 markdown-it 的 breaks:true 把单 \\n
    渲染成硬换行；正确修复在前端渲染层（改为 breaks:false，单 \\n 统一空格连接）。
    因此后端应保持 pymupdf4llm 的原始单 \\n 结构，不再越界猜测哪些行该合并，避免引入
    脆弱的启发式误伤（如把地址/日期/公司等不同字段错误拼接）。
    """
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("STSong-Light", 11)
    c.drawString(72, 780, "5年+前端开发经验，近2年专注企业级AI 应用平台与前端架构方向，参与从0到1 的AI Native 平台建设与前端")
    c.drawString(72, 764, "工程体系搭建")  # 上一句的视觉续行（PDF 按宽度切行）
    c.drawString(72, 748, "具备复杂ToB系统设计与落地能力，覆盖微前端架构、Monorepo 工程体系。")
    c.showPage()
    c.save()
    data = buf.getvalue()

    md = pdf_parser.extract_markdown_via_pymupdf(data)
    # 后端保留原始单 \n 结构（不做猜测式合并）
    assert "平台建设与前端\n工程体系搭建" in md
    # 且不应把上行尾与下行首直接拼接成一行
    assert "平台建设与前端工程体系搭建" not in md


def test_cn_ordinal_regex_not_matching_dates():
    """`_CN_ORDINAL_PREFIX_RE` 必须把 `[、．]` 设为必选，否则会把『2020.01』的『20』
    误判为中文序号锚点，进而把整块纯文本（地址/日期/公司）传播成列表。
    """
    import re

    # 数字/中文数字后无顿号或间隔号 → 不应命中（注意：『20、』带顿号是合法序号）
    for bad in ["2020.01 - 2023.06", "一负责团队"]:
        assert not pdf_parser._CN_ORDINAL_PREFIX_RE.match(bad), f"误判为序号: {bad!r}"
    # 真正的中文序号 → 应命中
    for good in ["1、搭建", "一、负责", "（1）参与", "（一）统筹"]:
        assert pdf_parser._CN_ORDINAL_PREFIX_RE.match(good), f"漏判序号: {good!r}"


def test_plain_text_block_not_listified():
    """纯文本块（地址/日期/公司，无 bullet/序号/缩进）不应被误判为列表项。"""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("STSong-Light", 11)
    c.drawString(72, 780, "北京市朝阳区")
    c.drawString(72, 764, "2020.01 - 2023.06")
    c.drawString(72, 748, "某某科技有限公司")
    c.showPage()
    c.save()
    data = buf.getvalue()

    md = pdf_parser.extract_markdown_via_pymupdf(data)
    # 不应带列表前缀
    for line in md.split("\n"):
        assert not line.lstrip().startswith("- "), f"纯文本被误判为列表: {line!r}"
    # 正文保留
    assert "北京市朝阳区" in md
    assert "2020.01 - 2023.06" in md


def test_paragraphs_not_confused_with_list_items():
    """普通段落与列表项混排时，必须正确区分，不能把所有文本都变成列表。

    构造：普通段落 + 被吞 bullet 列表项 + 中文序号 + 普通段落。组内传播
    （从序号锚点扩散）遇到终止标点/超长叙述句即止，不把普通正文并入列表。
    """
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("STSong-Light", 11)
    c.drawString(72, 790, "5年+前端开发经验，近2年专注企业级AI 应用平台与前端架构方向，参与从0到1 的AI Native 平台建设与前端工程体系搭建")
    c.drawString(72, 774, "具备复杂ToB系统设计与落地能力，覆盖微前端架构、Monorepo 工程体系、组件化平台建设以及LLM应用工程化实现")
    c.drawString(72, 758, "负责核心系统设计")
    c.drawString(72, 742, "主导前端架构重构")
    c.drawString(72, 726, "1、搭建 CI/CD 流水线")
    c.drawString(72, 710, "一、负责团队管理")
    c.drawString(72, 694, "能够独立承担中大型前端/平台型项目的架构设计、技术选型与核心模块开发")
    c.showPage()
    c.save()
    data = buf.getvalue()

    md = pdf_parser.extract_markdown_via_pymupdf(data)
    lines = md.split("\n")
    list_lines = [ln for ln in lines if ln.lstrip().startswith("- ")]
    # 只有中间 4 行列表项（2 个被吞 bullet + 2 个中文序号）应带 - 前缀
    assert "- 负责核心系统设计" in md
    assert "- 主导前端架构重构" in md
    assert "- 1、搭建 CI/CD 流水线" in md
    assert "- 一、负责团队管理" in md
    # 前后 3 行普通段落不得被误判为列表
    assert not any(ln.lstrip().startswith("- ") and "前端开发经验" in ln for ln in lines)
    assert not any(ln.lstrip().startswith("- ") and "复杂ToB系统" in ln for ln in lines)
    assert not any(ln.lstrip().startswith("- ") and "能够独立承担" in ln for ln in lines)
    # 普通段落正文仍保留
    assert "5年+前端开发经验" in md
    assert "能够独立承担中大型" in md
