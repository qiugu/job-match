"""PDF 解析：从上传的 PDF 简历中提取纯文本、版式元数据与层级结构。

- 纯文本（extract_pdf_text）：面向导入/LM 阅读。
- 版式元数据（extract_pdf_layout）：还原原文件的字体 / 字号 / 间距 / 分页。
- 层级结构（extract_markdown_structure）：纯规则、无 LLM，从 span 级版面信息
  （字号 / 加粗 / 颜色 / 坐标）确定性重建原简历的层级 Markdown 骨架，作为
  匹配时「结构不动、只改内容」的硬约束锚点。
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from io import BytesIO
from typing import Optional

from pypdf import PdfReader


# 常见字体名 → 本应用内置字体族的映射（保持与前端 fonts.ts 一致）。
_FONT_ALIASES = [
    ("Alibaba PuHuiTi", '"Alibaba PuHuiTi", sans-serif'),
    ("MiSans", '"MiSans", sans-serif'),
    ("Microsoft YaHei", '"Microsoft YaHei", "微软雅黑", sans-serif'),
    ("微软雅黑", '"Microsoft YaHei", "微软雅黑", sans-serif'),
    ("SimSun", '"SimSun", "宋体", serif'),
    ("宋体", '"SimSun", "宋体", serif'),
    ("SimHei", '"SimHei", "黑体", sans-serif'),
    ("黑体", '"SimHei", "黑体", sans-serif'),
    ("Songti", '"Songti SC", serif'),
    ("STSong", '"Songti SC", serif'),
    ("Times New Roman", '"Times New Roman", serif'),
    ("Arial", '"Arial", sans-serif'),
    ("Helvetica", '"Helvetica", sans-serif'),
    ("Calibri", '"Calibri", sans-serif'),
    ("Georgia", '"Georgia", serif'),
    ("Cambria", '"Cambria", serif'),
]


def _resolve_font_family(base_font: str) -> Optional[str]:
    """把 PDF 内嵌字体名映射为本应用可用的 web 字体族。"""
    if not base_font:
        return None
    name = base_font.split("+")[-1] if "+" in base_font else base_font
    for keyword, family in _FONT_ALIASES:
        if keyword.lower() in name.lower():
            return family
    return None


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    n = len(s)
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2


async def extract_pdf_text(data: bytes) -> str:
    """提取 PDF 全部页面文本。简历仅支持 PDF 格式。"""
    reader = PdfReader(BytesIO(data))
    parts: list[str] = []
    for page in reader.pages:
        text = page.extract_text(extraction_mode="layout") or ""
        parts.append(text)
    return "\n".join(p for p in parts if p.strip())


async def extract_pdf_layout(data: bytes) -> dict:
    """提取 PDF 版式元数据，用于还原原文件样式。

    返回字段：
    - fontFamily: 推断出的主字体族（web 字体）
    - fontSize: 主字号（pt，取整）
    - pagePadding: 推断的平均页边距（px，1pt≈1.33px）
    - pageSize: "A4" | "Letter" | "Unknown"
    - columns: 1 | 2  （是否分栏）
    - themeColor: 推断的主色调（取最大字号文本的颜色，#rrggbb 或空）
    - pageCount: 页数
    """
    reader = PdfReader(BytesIO(data))
    page_count = len(reader.pages)

    # 用 pypdf 6.x 的 visitor 回调确定性收集字号/字体/坐标（替代已移除的 get_text("dict")）
    font_counter: Counter = Counter()
    sizes: list[float] = []
    lefts: list[float] = []
    widths: list[float] = []
    page_widths: list[float] = []
    top_texts: list[tuple[float, str, Optional[str]]] = []  # (size, text, color)

    for page_idx, page in enumerate(reader.pages):
        mediabox = page.mediabox
        pw = float(mediabox.width)
        page_widths.append(pw)
        font_size: float = 0.0
        base_font: str = ""
        fill_color: Optional[str] = None

        def visitor(operator: bytes, operands: list, cm: list, tm: list) -> None:
            nonlocal font_size, base_font, fill_color
            try:
                opname = operator if isinstance(operator, str) else operator.decode("latin-1", "ignore")
                if opname == "Tf" and len(operands) >= 2:
                    font_size = float(operands[1] or 0)
                    base_font = _resolve_font_name(page, operands[0]) or ""
                elif opname in ("Tj", "TJ") and operands:
                    texts = _extract_string_operands(operands)
                    x0 = float(tm[4]) if len(tm) > 4 else 0.0
                    text = "".join(texts)
                    if not text.strip():
                        return
                    if font_size > 0:
                        sizes.append(font_size)
                    fam = _resolve_font_family(base_font)
                    if fam:
                        font_counter[fam] += 1
                    lefts.append(x0)
                    widths.append(max(len(text.strip()) * font_size * 0.5, 1))
                    if font_size > 0:
                        top_texts.append((font_size, text.strip(), fill_color))
                elif opname in ("rg", "RG") and len(operands) >= 3:
                    fill_color = _rgb_to_hex(operands[:3])
            except Exception:  # noqa: BLE001
                return

        try:
            page.extract_text(visitor_operand_after=visitor)
        except Exception:  # noqa: BLE001
            continue

    # 主字体：出现频次最高
    font_family = font_counter.most_common(1)[0][0] if font_counter else None

    # 主字号：取出现最多的字号（直方图峰值）更稳定
    font_size = 0
    if sizes:
        size_counter = Counter(round(s) for s in sizes if s > 0)
        font_size = size_counter.most_common(1)[0][0]

    # 页边距：左边界最小留白 + 右边界最小留白的平均值
    page_padding = 0
    if lefts and page_widths:
        avg_page_w = sum(page_widths) / len(page_widths)
        left_margin = max(0.0, min(lefts))
        right_margin = max(0.0, avg_page_w - max(lefts))
        margin_pt = (left_margin + right_margin) / 2
        page_padding = max(8, int(round(margin_pt * 1.33)))  # pt→px

    # 页面尺寸：取第一页 mediabox 尺寸判断
    page_size = "Unknown"
    if page_widths:
        w = page_widths[0]
        h = float(reader.pages[0].mediabox.height)
        # 允许 ±5pt 误差
        if abs(w - 595) <= 8 and abs(h - 842) <= 8:
            page_size = "A4"
        elif abs(w - 612) <= 8 and abs(h - 792) <= 8:
            page_size = "Letter"

    # 分栏：若文本块横向明显分为两簇（左半/右半），视为双栏
    columns = 1
    if lefts and widths and page_widths:
        avg_page_w = sum(page_widths) / len(page_widths)
        mid = avg_page_w / 2
        left_cluster = [x for x in lefts if x < mid * 0.85]
        right_cluster = [x for x in lefts if x > mid * 1.15]
        # 两侧都有相当数量的文本块，且中间有空白间隙
        if len(left_cluster) > 3 and len(right_cluster) > 3:
            columns = 2

    # 主色调：取最大字号文本的颜色（标题通常代表主题色）
    theme_color = None
    if top_texts:
        top_texts.sort(key=lambda t: t[0], reverse=True)
        for _size, _text, color in top_texts[:15]:
            if color and color.lower() not in ("#000000", "#ffffff", "#000"):
                theme_color = color
                break

    return {
        "fontFamily": font_family,
        "fontSize": int(font_size) if font_size else None,
        "pagePadding": page_padding or None,
        "pageSize": page_size,
        "columns": columns,
        "themeColor": theme_color,
        "pageCount": page_count,
    }


def _int_to_hex(color_int: int) -> Optional[str]:
    """pypdf 颜色为 0xRRGGBB 整数，转为 #rrggbb。"""
    try:
        return f"#{color_int & 0xFFFFFF:06x}"
    except Exception:  # noqa: BLE001
        return None


def _rgb_to_hex(rgb: list) -> Optional[str]:
    """把 [r,g,b]（0~1 浮点或 0~255）转 #rrggbb。"""
    try:
        vals = [float(c) for c in rgb[:3]]
        # pypdf 颜色多为 0~1，也有 0~255
        scale = 255.0 if max(vals) > 1 else 1.0
        r = round(vals[0] * scale) & 0xFF
        g = round(vals[1] * scale) & 0xFF
        b = round(vals[2] * scale) & 0xFF
        return f"#{r:02x}{g:02x}{b:02x}"
    except Exception:  # noqa: BLE001
        return None


def _resolve_font_name(page, font_operand) -> Optional[str]:
    """根据页面字体资源把字体资源名（如 /F1）解析为真实字体名（如 Helvetica-Bold）。"""
    try:
        if isinstance(font_operand, bytes):
            font_operand = font_operand.decode("latin-1", "ignore")
        name = str(font_operand).lstrip("/")
        resources = page.get("/Resources") or {}
        fonts = resources.get("/Font") or {}
        font_ref = fonts.get("/" + name)
        if font_ref is None:
            return str(font_operand)
        font_obj = font_ref.get_object()
        return str(font_obj.get("/BaseFont", str(font_operand)))
    except Exception:  # noqa: BLE001
        return str(font_operand)


# ---------------------------------------------------------------------------
# 确定性 PDF -> 层级 Markdown 提取（纯规则，无 LLM）
# ---------------------------------------------------------------------------

# 常见加粗字体名片段（子串匹配，大小写不敏感）
_BOLD_FONT_MARKS = ("bold", "black", "heavy", "demibold", "semibold", "b ")
# 常见列表符号：无序号圆点 / 有序号（数字或中文序号）
_LIST_BULLET_RE = re.compile(r"^[\u2022\u25cf\u25cb\u25a0\u25aa\u25a1\u25e6\u25cf\-\*\u00b7\u30fb]\s*")
_LIST_NUMERIC_RE = re.compile(
    r"^(?:\d+[\.\、\)\]]\s*|\(\d+\)\s*|(?:[一二三四五六七八九十]+)[、．.]\s*)"
)
# 简历常见模块标题关键词（用于兜底识别标题行，即使字号与正文接近）
_SECTION_TITLE_KEYWORDS = (
    "教育", "工作经历", "实习", "项目", "技能", "自我评价", "个人简介",
    "基本信息", "求职意向", "获奖", "证书", "荣誉", "校园", "社会",
)


@dataclass
class _Span:
    """单个 span 的版面摘要。"""
    x: float
    y: float
    page: int
    size: float
    bold: bool
    text: str


@dataclass
class _Line:
    """一条文本行（由同页、近 y 坐标的 span 合并）。"""
    y: float
    x: float
    page: int
    max_size: float
    bold: bool
    segments: list[tuple[str, bool, float]]  # (text, bold, x)


def _collect_spans(data: bytes) -> list[_Span]:
    """遍历所有页，收集去空白的 span 版面摘要。

    基于 pypdf 6.x 的 `extract_text(visitor_operand_after=...)` 回调：
    在渲染时捕获 `Tf`（字体+字号）与 `Tj/TJ`（文本）算子及其文本矩阵，
    从而确定性取得每个文本片段的字号 / 加粗 / 坐标，无需 LLM。
    """
    reader = PdfReader(BytesIO(data))
    spans: list[_Span] = []

    for page_idx, page in enumerate(reader.pages):
        font_size: float = 0.0
        bold: bool = False

        def visitor(operator: bytes, operands: list, cm: list, tm: list) -> None:
            nonlocal font_size, bold
            try:
                opname = operator if isinstance(operator, str) else operator.decode("latin-1", "ignore")
                if opname == "Tf" and len(operands) >= 2:
                    font_size = float(operands[1] or 0)
                    # 字体资源名 -> 真实字体名（判断是否加粗）
                    bold = _is_font_bold(page, operands[0])
                elif opname in ("Tj", "TJ") and operands:
                    texts = _extract_string_operands(operands)
                    # tm 为文本矩阵，[4]/[5] 即当前文本基线坐标
                    x = float(tm[4]) if len(tm) > 4 else 0.0
                    y = float(tm[5]) if len(tm) > 5 else 0.0
                    for txt in texts:
                        if not txt.strip():
                            continue
                        spans.append(
                            _Span(x=x, y=y, page=page_idx, size=font_size, bold=bold, text=txt)
                        )
            except Exception:  # noqa: BLE001
                return

        try:
            page.extract_text(visitor_operand_after=visitor)
        except Exception:  # noqa: BLE001
            # 某些畸形 PDF 渲染回调可能抛错；忽略整页，保证不阻断整体提取
            continue

    return spans


def _extract_string_operands(operands: list) -> list[str]:
    """从 Tj/TJ 的 operands 中提取文本字符串片段。"""
    result: list[str] = []
    for op in operands:
        if isinstance(op, bytes):
            result.append(op.decode("latin-1", "ignore"))
        elif isinstance(op, str):
            result.append(op)
    return result


def _is_font_bold(page, font_operand) -> bool:
    """根据页面字体资源解析真实字体名，判断是否为粗体。"""
    try:
        if isinstance(font_operand, bytes):
            font_operand = font_operand.decode("latin-1", "ignore")
        name = str(font_operand).lstrip("/")
        resources = page.get("/Resources") or {}
        fonts = resources.get("/Font") or {}
        font_ref = fonts.get("/" + name)
        if font_ref is None:
            return False
        font_obj = font_ref.get_object()
        base_font = str(font_obj.get("/BaseFont", ""))
        return any(mark in base_font.lower() for mark in _BOLD_FONT_MARKS)
    except Exception:  # noqa: BLE001
        return False


def _cluster_lines(spans: list[_Span], y_tolerance: float = 3.0) -> list[_Line]:
    """按 y 坐标把 span 聚类成行（同一视觉行合并），再按 页→y→x 排序。"""
    lines: list[_Line] = []
    for sp in spans:
        placed = False
        for ln in lines:
            # 仅同页、近 y 的 span 才能并入同一行，避免跨页错位
            if ln.page == sp.page and abs(ln.y - sp.y) <= y_tolerance:
                ln.segments.append((sp.text, sp.bold, sp.x))
                ln.max_size = max(ln.max_size, sp.size)
                ln.bold = ln.bold or sp.bold
                ln.x = min(ln.x, sp.x)
                placed = True
                break
        if not placed:
            lines.append(
                _Line(
                    y=sp.y,
                    x=sp.x,
                    page=sp.page,
                    max_size=sp.size,
                    bold=sp.bold,
                    segments=[(sp.text, sp.bold, sp.x)],
                )
            )
    # 排序：先按页，再按 PDF 坐标 y 向上递减（页顶 y 大）得到「从上到下」，
    # 同一视觉行内按 x 由小到大（从左到右）。
    lines.sort(key=lambda ln: (ln.page, -ln.y, ln.x))
    return lines


def _dominant_size(lines: list[_Line]) -> float:
    """正文基准字号：出现频次最高的字号（直方图峰值）。"""
    sizes = [ln.max_size for ln in lines if ln.max_size > 0]
    if not sizes:
        return 0.0
    counter = Counter(round(s) for s in sizes)
    return float(counter.most_common(1)[0][0])


def _line_text(ln: _Line) -> str:
    return _join_segments([(seg, False, x) for seg, _, x in ln.segments])


def _join_segments(segments: list[tuple[str, bool, float]]) -> str:
    """按水平位置拼接片段：跨度明显时补一个空格，避免「公司职位」粘连。"""
    parts: list[str] = []
    prev_x: float | None = None
    prev_text = ""
    for text, _, x in segments:
        if prev_x is not None and x - prev_x > 1.0 and prev_text and text:
            parts.append(" ")
        parts.append(text)
        prev_x = x
        prev_text = text
    return "".join(parts).strip()


def _is_list_item(text: str) -> bool:
    return bool(_LIST_BULLET_RE.match(text) or _LIST_NUMERIC_RE.match(text))


def _is_section_title(text: str, base_size: float) -> bool:
    """判断一行是否为模块标题：字号明显偏大，或加粗且为短行/含标题关键词。"""
    t = text.strip()
    if not t or len(t) > 60:
        return False
    if base_size > 0:
        pass  # 字号判定在调用方完成（依赖行字号）
    return any(kw in t for kw in _SECTION_TITLE_KEYWORDS)


def _render_bold(ln: _Line) -> str:
    """把行内加粗片段渲染为 **加粗**；整行加粗则不额外包裹。"""
    if ln.bold:
        return _line_text(ln)
    parts: list[str] = []
    prev_x: float | None = None
    prev_text = ""
    for seg, bold, x in ln.segments:
        seg = seg.strip()
        if not seg:
            continue
        # 水平跨度明显时补空格，避免粘连
        if prev_x is not None and x - prev_x > 1.0 and prev_text:
            parts.append(" ")
        parts.append(f"**{seg}**" if bold else seg)
        prev_x = x
        prev_text = seg
    return "".join(parts)


def extract_markdown_structure(data: bytes) -> str:
    """纯规则、无 LLM 地重建原简历的层级 Markdown 骨架。

    依据 span 级版面信息（字号 / 加粗 / 位置）确定性地恢复：
    - 模块标题：字号显著大于正文基准的行 → 一级/二级标题；
    - 列表项：行首带列表符号的行 → 保留原列表标记；
    - 加粗：行内加粗片段 → **加粗**；
    - 模块与条目顺序：按版面上→下、左→右顺序保留。

    返回的 markdown 仅承载「结构 + 原文措辞」，供匹配流程作为
    「结构不动、只改内容」的硬约束锚点。无法恢复结构时退化为纯文本行。
    """
    spans = _collect_spans(data)
    if not spans:
        return ""
    lines = _cluster_lines(spans)
    if not lines:
        return ""

    base = _dominant_size(lines)
    title_threshold = base * 1.2 if base > 0 else float("inf")

    out: list[str] = []
    for ln in lines:
        text = _line_text(ln)
        if not text:
            continue

        # 1) 模块标题：字号显著大于正文基准，或加粗且短行/含标题关键词
        is_title = ln.max_size > title_threshold
        if not is_title and ln.bold and len(text) <= 40:
            is_title = _is_section_title(text, base)
        if not is_title and _is_section_title(text, base) and ln.max_size >= base * 1.05:
            is_title = True

        if is_title:
            # 字号越大层级越高：>=1.6x 基准用一级标题，其余用二级标题
            level = "#" if ln.max_size >= base * 1.6 else "##"
            out.append(f"{level} {text}")
            continue

        # 2) 列表项：保留原列表标记（符号原样，正文还原加粗）
        if _is_list_item(text):
            out.append(_render_bold(ln))
            continue

        # 3) 普通正文
        out.append(_render_bold(ln))

    return "\n".join(out).strip()
