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

def _ensure_rag_path(pymupdf4llm) -> None:
    """幂等地把 pymupdf4llm 切到支持 hdr_info 的 rag 路径（进程内仅设置一次）。

    `use_layout(False)` 是 pymupdf4llm 的模块级全局开关：layout 路径会删除
    IdentifyHeaders 并忽略 hdr_info，导致自定义中文标题检测（`ResumeHeaders`）失效。
    该开关一旦设置即对进程内所有 to_markdown 生效，本进程只会走 rag 路径，故用
    _RAG_PATH_CONFIGURED 标志保证仅执行一次，避免重复写入全局状态。
    """
    global _RAG_PATH_CONFIGURED
    if _RAG_PATH_CONFIGURED:
        return
    pymupdf4llm.use_layout(False)
    _RAG_PATH_CONFIGURED = True


_RAG_PATH_CONFIGURED = False


def extract_markdown_via_pymupdf(data: bytes) -> str:
    """用 pymupdf4llm 把 PDF 转为层级 Markdown（确定性、无 LLM，首选路径）。

    背景（回归根因）：`extract_markdown_structure` 依赖 pypdf 的
    `visitor_operand_after` 回调，它拿到的是 PDF 流里的原始字节。对 CID /
    子集化 Type3 中文字体（真实中文简历主流），这些字节是未经 ToUnicode CMap
    解码的字符码，直接按 Latin-1 读会变成 ¢©ª«¬® 等高位乱码——中文全丢、
    词被拆散、模块归属错乱。此前用「乱码检测 + 回退纯文本」只是绕开问题，
    纯文本仍丢失层级（子标题/列表/段落）。

    改用成熟的 pymupdf4llm（PyMuPDF 官方 PDF→Markdown 工具）：
    - 正确解码所有字体（含 CID/Type3 中文字体），零乱码；
    - 依据版面自动还原标题层级（#/##/###/####）、列表（- ）、段落，
      子标题（如「核心贡献」「项目成果」）自动识别；
    - 内容完整、结构确定，作为「结构不动、只改内容」的硬约束锚点。

    pymupdf4llm 的 layout 引擎按字号/位置启发式推断层级，对中文简历的模块标题
    不稳定（有时 h1、有时 h2、有时退化成普通段）。`calibrate_module_headings`
    在返回前把「整行等于模块关键词」的标题统一校准为 `##`，消除层级不一致。

    pymupdf4llm 不接受 bytes，需先落临时文件再转换；异常或空结果返回空串，
    由调用方回退到 pypdf 纯文本提取。

    三处确定性修复（解决 pymupdf4llm 1.x 对中文简历的常见缺陷）：
    1. 标题层级：pymupdf4llm 1.28 默认走 `document_layout` 路径（`_use_layout=True`），
       **完全忽略 `hdr_info` 参数**（该路径下 `IdentifyHeaders` 被删除）。必须先用
       `pymupdf4llm.use_layout(False)` 切回支持 `hdr_info` 的 rag 路径。默认
       `IdentifyHeaders` 的 `body_limit` 固定为 12pt、且只认「字号 > 正文」，中文简历
       正文 9~10.5pt、模块标题 11~12pt 时标题被整体排除为普通文本。改用
       `ResumeHeaders`（正文基准取全文字符数最多字号，去掉 12pt 下限），并把「整行加粗
       且较短」的标题行行级提级为 `###`；rag 路径对加粗标题行会同时包 `**`，
       `clean_header_asterisks` 去掉冗余 `**`，统一为 `# 文本`。
    2. 列表符号：默认 `startswith_bullet` 要求 bullet 后紧跟半角空格、且仅识别
       有限字符集，中文 PDF 的「•内容」无空格 / 中文序号「1、」会丢失。后处理
       `normalize_list_items` 把无空格 bullet 与中文序号规范为 `- ` 列表。
    3. 软换行：pymupdf4llm 同一 block 内相邻行只输出单个 `\\n`，由前端
       MarkdownPreview（markdown-it `breaks: true`）渲染为换行，此处不改源文本。
    """
    import os
    import tempfile

    try:
        import pymupdf4llm
    except Exception:  # noqa: BLE001 - 依赖未安装时不阻断，走既有回退
        return ""
    if not data:
        return ""
    # 进程级全局开关：切回支持 hdr_info 的 rag 路径（layout 路径忽略 hdr_info 且删除了
    # IdentifyHeaders，无法自定义标题检测）。该开关是 pymupdf4llm 模块级全局状态，
    # 一旦设置对进程内所有 to_markdown 生效；本进程只会走 rag 路径，故仅幂等设置一次，
    # 避免重复调用反复写入全局状态、也防止其他入口（或并发）相互干扰。
    _ensure_rag_path(pymupdf4llm)
    path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            f.write(data)
            path = f.name
        # ResumeHeaders 既提供标题档位（hdr_info），也顺带预扫描列表项信号
        # （list_items：去 bullet/序号后的纯文本 → True），用于恢复被吞 bullet。
        hdr = ResumeHeaders(path)
        md = pymupdf4llm.to_markdown(path, hdr_info=hdr)
        # to_markdown 返回 str；类型不透明时显式转 str，避免 `(md or "").strip()`
        # 对非 str 值（如 list）在静态检查下报错。
        md = str(md or "").strip()
        if not md:
            return md
        # 修复 1（前置）：rag 路径对加粗标题行会同时包 `**`，去掉冗余 `**` 统一为 `# 文本`
        md = clean_header_asterisks(md)
        # 修复 2：无空格 bullet / 中文序号 → 列表；被吞 bullet 用预扫描信号恢复
        # 必须在 promote_bold_lines 之前：normalize 作用于纯文本行，promote 才会把
        # 加粗短行加 `###`，顺序颠倒会导致已转列表项被误判为标题。
        md = normalize_list_items(md, hdr.list_items)
        # 修复 1：整行加粗短行（同字号加粗标题 pymupdf4llm 漏检）→ 三级标题
        md = promote_bold_lines(md)
        # 校准 pymupdf4llm 对中文简历模块标题不稳定的层级（#/h2/普通段 → 统一 ##）。
        md = calibrate_module_headings(md)
        return md
    except Exception:  # noqa: BLE001
        return ""
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:  # noqa: BLE001
                pass


# 受控的简历模块标题关键词表（用于把 pymupdf4llm 输出里层级不一致的
# 模块标题统一校准为 `##`）。只覆盖独立成行的模块名，不碰子标题/正文/列表，
# 保留 pymupdf4llm 在子标题、列表、段落上的优势。
_MODULE_TITLE_KEYWORDS = (
    "工作经历", "工作背景", "工作经验", "项目经历", "项目经验", "项目背景",
    "教育经历", "教育背景", "教育经验", "技能", "技能专业", "专业技能", "技能特长",
    "自我评价", "个人评价", "个人总结", "个人优势", "关于我", "荣誉奖项", "获奖情况",
    "证书", "资格证书", "专业证书", "语言能力", "语言", "实习经历", "校园经历",
    "社团经历", "志愿服务", "研究成果", "发表论文", " publications", "Skills",
    "Experience", "Education", "Projects", "About", "Honors", "Awards", "Certificates",
)
_MODULE_TITLE_RE = re.compile(r"^(#{1,6})?\s*(.*?)\s*$")


def calibrate_module_headings(md: str) -> str:
    """把 pymupdf4llm 输出里层级不一致的模块标题统一校准为 `##`。

    pymupdf4llm 的 layout 引擎按字号/位置启发式推断层级，对中文简历的模块标题
    不稳定（有时 h1、有时 h2、有时退化成普通段，且随位置变化）。本函数只做一件
    确定性、可复现的事：把「整行去除 markdown 标题符号后等于某模块关键词」的行
    强制设为 `##`，其余内容（子标题、列表、正文）原样保留。

    匹配严格限定「整行即关键词」，避免把含关键词的正文句子（如「工作经历丰富」）
    误判为标题。
    """
    if not md:
        return md
    out: list[str] = []
    for line in md.split("\n"):
        m = _MODULE_TITLE_RE.match(line.strip())
        if m:
            text = m.group(2).strip()
            if text and text in _MODULE_TITLE_KEYWORDS:
                out.append(f"## {text}")
                continue
        out.append(line)
    return "\n".join(out)


# 视为「列表 bullet」的字符集合：pymupdf4llm 的 BULLETS 超集。注意 pymupdf4llm
# 在转换时会把中文 PDF 里无空格的 bullet（如「•负责…」）**连同字符一起吞掉**，
# 仅保留后续文本。因此除依赖输出中残留的 bullet 字符外，还需在 PDF 原始文本层
# 预扫描「以 bullet 开头的视觉行」，用于恢复被吞字符的列表项。
_BULLET_CHARS = set("•·●○▪▫◦‣⁃*○●■□◆◇►▶-‐‑‒–—")

# 中文序号前缀：用于从原始行识别「中文序号列表项」，作为列表锚点。
# 分支规则（与 _CN_ORDINAL_RE 一致）：
#   - 数字/中文数字序号必须带顿号或间隔号（「1、」「一、」），否则「2020.01」的「20」、
#     「一负责」这类普通词会被误判为序号锚点，进而把整块纯文本传播成列表；
#   - 括号序号（「(1)」「（1）」「（一）」）后**不带顿号**，单独成分支，避免漏判。
_CN_ORDINAL_PREFIX_RE = re.compile(
    r"^(\d{1,2}[、．]"
    r"|[一二三四五六七八九十]{1,3}[、．]"
    r"|\(\d{1,2}\)"
    r"|（\d{1,2}）"
    r"|[（(][一二三四五六七八九十]{1,3}[)）])"
)

# 句子/段落终止标点：行尾是这些符号时，视为「完整句子/普通段落结束」，
# 列表组内传播遇此即止——避免把普通正文段落误并入列表。
_SENTENCE_END_PUNCT = set("。！？.!?；;：:）)】”\"'»")
# 句读标点：用于识别「含多个停顿的长叙述句」——典型为普通段落而非列表项短语。
_PUNCT_COUNT_RE = re.compile(r"[，。；、,;]")


def _looks_like_paragraph(t: str) -> bool:
    """判断一行是否更像普通段落而非列表项。

    列表项通常是无终止标点的短名词/动宾短语（「负责核心系统设计」）；普通段落
    多以句号/分号/冒号结尾，或是含多个停顿、长度偏长的整段叙述。组内传播遇此即止，
    避免把普通正文误判为列表项。
    """
    s = (t or "").rstrip()
    if not s:
        return False
    if s.endswith(tuple(_SENTENCE_END_PUNCT)):
        return True
    if len(s) > 28:  # 超长文本通常为段落而非列表项
        return True
    # 偏长且含句读标点 → 叙述性段落（区别于短列表项短语）
    if len(s) > 25 and len(_PUNCT_COUNT_RE.findall(s)) >= 1:
        return True
    return False


class ResumeHeaders:
    """字号驱动的标题检测 + 列表项信号预扫描，替代 pymupdf4llm 默认的 `IdentifyHeaders`。

    pymupdf4llm 的 `IdentifyHeaders` 有两个对中文简历致命的缺陷（见
    `pymupdf4llm/helpers/pymupdf_rag.py`）：
    1. `body_limit` 固定取 `max(12, 最高频字号)`（12 为英文正文设计）。中文简历
       正文 9~10.5pt、模块标题 11~12pt 时，标题字号 `<= 12` 被整体排除，一个
       标题都不会产生；
    2. 判定信号只有字号（加粗/颜色等样式信号完全忽略），同字号加粗/主题色标题
       一律判为普通文本。

    本类沿用「统计全文最高频字号作为正文基准」的思路，但**去掉 12pt 下限**，
    并以「高于正文基准」的字号降序映射为 #/##/### 档位。同字号加粗的标题由
    行级后处理 `promote_bold_lines`（而非 per-span 判定）负责，避免混排行里
    单个加粗片段把整行误提级。

    同时，在遍历 `page.get_text("dict")` 时顺带收集 `list_items`：key 为「纯文本」，
    value 为 True。pymupdf4llm 会吞掉中文 bullet 字符（如「•」连同字符在 PDF 文本层
    即丢失，仅留后续文本），字符级匹配无法恢复。此处改用**几何缩进信号**识别列表项：
    同一 block 内，首行 x0 明显大于该 block 正文基准左边界（说明行首有 bullet 占位 /
    悬挂缩进）的短行即为列表项。对字符级 bullet（字符仍在输出中）与中文序号则由
    `normalize_list_items` 的字符分支处理，此处仅为「bullet 字符已丢失」的列表兜底。
    """

    def __init__(self, doc) -> None:
        import pymupdf

        mydoc = doc if isinstance(doc, pymupdf.Document) else pymupdf.open(doc)
        sizes: "Counter[int]" = Counter()
        # 按 block 收集行快照，便于「列表组」内锚点传播：
        # 中文简历常见「bullet 项 + 中文序号项」混排在同一列表，bullet 字符在 PDF 文本层
        # 已丢失（与正文不可区分），但序号项是可识别的锚点。借助锚点向同组连续行传播，
        # 即可把无字符残留的 bullet 行一并恢复为列表。
        blocks_lines: list[list[tuple[float, int, str]]] = []
        try:
            for page in mydoc:
                # PyMuPDF get_text("dict") 动态返回 dict；Pyrefly 误判联合类型，
                # 运行时恒为 dict。显式标注 dict 以消除下游 .get 的误报。
                text_dict: dict = page.get_text("dict", flags=pymupdf.TEXTFLAGS_TEXT)  # type: ignore[assignment]
                blocks = text_dict.get("blocks", [])
                for block in blocks:
                    if block.get("type") != 0:
                        continue
                    snap: list[tuple[float, int, str]] = []
                    for line in block.get("lines", []):
                        spans = line.get("spans", [])
                        line_text = "".join(s["text"] for s in spans).strip()
                        x0 = line.get("bbox", (0, 0, 0, 0))[0]
                        line_size = round(max((s["size"] for s in spans), default=0))
                        snap.append((x0, line_size, line_text))
                        for span in spans:
                            text = span["text"].strip()
                            if text:
                                sizes[round(span["size"])] += len(text)
                    if snap:
                        blocks_lines.append(snap)
        finally:
            if not isinstance(doc, pymupdf.Document):
                mydoc.close()
        # 正文基准字号 = 字符数最多的字号；无文本时回退 10pt
        self.body_size = self._estimate_body_size(sizes)
        # 高于正文的字号降序映射 #/##/###（最多 3 级，与简历层级匹配）
        header_sizes = sorted((s for s in sizes if s > self.body_size), reverse=True)[:3]
        self._map: dict[int, str] = {
            size: "#" * (i + 1) + " " for i, size in enumerate(header_sizes)
        }
        # 正文左边界 = 全文档非标题行 x0 的最小值。简历中标题/正文/模块名通常对齐到
        # 页面正文左边界（最小 x0），列表项在此基础上右移（悬挂缩进或 bullet 占位）。
        # 用最小值而非中位数，可避免「列表项占多数」时中位数被抬高、导致 indent 恒为 0。
        body_x0s: list[float] = []
        for blk in blocks_lines:
            for (x0, sz, _t) in blk:
                if 0 < sz <= self.body_size * 1.3:
                    body_x0s.append(x0)
        base_left = min(body_x0s) if body_x0s else 0.0
        indent_threshold = max(6.0, self.body_size * 0.6)
        # 列表项信号：纯文本 → True（用于恢复被吞 bullet 的列表项）
        list_items: dict[str, bool] = {}
        for snap in blocks_lines:
            self._mark_list_block(snap, base_left, indent_threshold, list_items)
        self.list_items = list_items

    @staticmethod
    def _estimate_body_size(sizes: "Counter[int]") -> int:
        """正文基准字号 = 字符数最多的字号（无文本回退 10pt）。"""
        return max(sizes, key=lambda k: sizes[k]) if sizes else 10

    @staticmethod
    def _mark_list_block(
        snap: list[tuple[float, int, str]],
        base_left: float,
        indent_threshold: float,
        store: dict[str, bool],
    ) -> None:
        """把单个 block 内的列表项登记为信号（key = 纯文本）。

        判定分两步：
        1. **锚点标记**：逐行按三类强信号打标——(a) 行首是 bullet 字符（字符仍在层）；
           (b) 行首是中文序号（「1、」「一、」「(1)」等）；(c) 几何缩进（x0 明显右移）。
           这三类能确定命中即记为锚点。
        2. **组内传播**：中文简历常见「bullet 项 + 中文序号项」混排在同一列表，而 bullet
           字符在 PDF 文本层已丢失（与正文不可区分）。因此一旦某行被锚定，其**前后连续、
           且 (size, x0) 相同**的行也判为列表项（双向扩展，直至格式变化或到达块边界）。
           如此即可把无字符残留的 bullet 行随同组序号锚点一并恢复。

        仅当块内存在锚点时才传播，避免把正文段落误判为列表；传播遇**冒号结尾行**
        （中文「：」/英文「:」，典型为「以下是主要职责：」这类列表引导句）即止，不再
        向该方向扩展——避免把引导句误列入列表。标题行（size 显著大于基准）不参与传播。

        局限性：若列表全部由「无锚点、无缩进、且文本层字符已丢失」的 bullet 组成（PDF
        完全不含序号/缩进/bullet 字符信号），则纯文本层无可识别特征，属 PyMuPDF 文本提取
        的固有局限，无法 100% 恢复。
        """
        n = len(snap)
        if n == 0:
            return

        def _is_guide_line(t: str) -> bool:
            # 以冒号结尾的行通常为列表引导句，不应被纳入列表，也不向该方向继续传播
            s = (t or "").rstrip()
            return bool(s) and s.endswith(("：", ":"))

        # 第一步：计算每行是否为锚点
        is_anchor = [False] * n
        for i, (x0, size, line_text) in enumerate(snap):
            if not line_text:
                continue
            stripped = line_text.lstrip()
            if not stripped:
                continue
            first = stripped[0]
            if first in _BULLET_CHARS:
                is_anchor[i] = True
                continue
            if _CN_ORDINAL_PREFIX_RE.match(stripped):
                is_anchor[i] = True
                continue
            if x0 - base_left >= indent_threshold:
                is_anchor[i] = True
        # 第二步：从每个锚点向两侧传播（连续同 size+x0 的同格式行）。遇以下情况即止，
        # 不把该行纳入、也不继续向该方向传播：
        #   - 冒号结尾的引导句（「以下是主要职责：」类）；
        #   - 终止标点结尾或超长的普通段落（与列表项短语形态不同）。
        # 如此「同组列表项（含被吞 bullet）」会被锚点一并恢复，而普通正文段落不被误并。
        for i in range(n):
            if not is_anchor[i]:
                continue
            ax0, asize, _ = snap[i]
            # 向前传播
            j = i - 1
            while j >= 0 and snap[j][1] == asize and abs(snap[j][0] - ax0) < 0.5:
                if _is_guide_line(snap[j][2]) or _looks_like_paragraph(snap[j][2]):
                    break
                if snap[j][2]:
                    is_anchor[j] = True
                j -= 1
            # 向后传播
            j = i + 1
            while j < n and snap[j][1] == asize and abs(snap[j][0] - ax0) < 0.5:
                if _is_guide_line(snap[j][2]) or _looks_like_paragraph(snap[j][2]):
                    break
                if snap[j][2]:
                    is_anchor[j] = True
                j += 1
        # 登记所有锚点（含传播得到的）行文本
        for i, (_, _, line_text) in enumerate(snap):
            if is_anchor[i] and line_text:
                store[line_text.lstrip()] = True

    def get_header_id(self, span: dict, page=None) -> str:
        return self._map.get(round(span.get("size", 0)), "")


# 列表符号（纯排版符号，丢弃并转为 "- "）。
# 不含 -/*/+，避免吃掉 pymupdf4llm 已生成的合法列表与 `---` 分隔线。
_BULLET_LINE_RE = re.compile(
    r"^([\u2022\u25cf\u25cb\u25a0\u25aa\u25ab\u25e6\u2023\u2043\u2219\u00b7\u30fb][ \t]*)+"
)
# 序号前缀（属于原文措辞，整段保留并前置 "- "；"1." 本就是合法有序列表不动）：
# 中文顿号「1、」/「一、」、半角点「1．」、括号「(1)」「（1）」「（一）」。
_CN_ORDINAL_RE = re.compile(
    r"^(?:\d{1,2}[、．]|\(\d{1,2}\)|（\d{1,2}）|[（(][一二三四五六七八九十]{1,3}[)）]"
    r"|[一二三四五六七八九十]{1,3}[、．])[ \t]*"
)


def _core_text_of_line(line: str) -> str:
    """从 markdown 行取「纯文本」，用于与预扫描的列表项信号匹配。

    去掉前导 markdown 标记（# / - / * / > / 加粗 **）与空白，保留中英文正文。
    bullet 被 pymupdf4llm 吞掉后，列表项在 markdown 里就是纯文本，故 stripped
    即核心文本，可直接参与匹配。
    """
    t = line.strip()
    t = re.sub(r"^([#*\-+>]+\s+|\*\*)", "", t)
    return t.strip()


def normalize_list_items(md: str, list_items: "dict[str, bool] | None" = None) -> str:
    """把 pymupdf4llm 漏检的 bullet 与中文序号规范为 markdown 列表。

    修复场景：
    - 中文 PDF「•内容」「●职责描述」无空格：默认 `startswith_bullet` 要求 bullet
      后紧跟半角空格，判定失败 → 普通文本。本函数容忍任意空白/连写 bullet；
    - 中文序号「1、」「一、」「(1)」「（1）」不在默认字符集 → 原样普通文本。
      本函数保留序号整段文字（属原文措辞）仅前置 "- "，便于人工核对原 PDF 顺序；
    - **bullet 字符被 pymupdf4llm 整段吞掉**（如「•负责…」→「负责…」连符号都丢）：
      输出中既无 bullet 字符也无序号，前两分支都无法恢复。此时用 `list_items`
      （`ResumeHeaders` 预扫描得到的「去符号纯文本 → True」映射）按内容匹配，
      命中即补回 "- "。

    保留前导空格以维持 pymupdf4llm 生成的嵌套列表缩进；已合法列表/标题/表格/
    空行不动，防误伤。
    """
    if not md:
        return md
    out: list[str] = []
    for line in md.split("\n"):
        stripped = line.lstrip()
        indent = line[: len(line) - len(stripped)]
        # 跳过：空行、已是合法列表、标题、表格行
        if (
            not stripped
            or stripped.startswith(("- ", "* ", "+ ", "#", "|"))
            or "|" in stripped
        ):
            out.append(line)
            continue
        if _BULLET_LINE_RE.match(stripped):
            rest = _BULLET_LINE_RE.sub("", stripped).lstrip()
            out.append(f"{indent}- {rest}" if rest else line)
        elif _CN_ORDINAL_RE.match(stripped):
            # 序号整段保留，仅前置 "- "
            out.append(f"{indent}- {stripped.lstrip()}")
        elif list_items and "*" not in stripped and "#" not in stripped:
            # 第三分支：bullet 被吞，仅剩纯文本，用预扫描信号恢复列表
            core = _core_text_of_line(stripped)
            if core and core in list_items:
                out.append(f"{indent}- {stripped.lstrip()}")
            else:
                out.append(line)
        else:
            out.append(line)
    return "\n".join(out)


_BOLD_LINE_RE = re.compile(r"^\*\*(.{1,24})\*\*$")


def promote_bold_lines(md: str) -> str:
    """把整行加粗且 ≤24 字的行提级为三级标题。

    pymupdf4llm 对整行加粗输出 `**整行**`。中文简历大量标题是「正文同字号 +
    加粗 + 主题色」，纯字号判定（`ResumeHeaders`）无法识别，却必然是整行加粗
    的短文本。在行级（而非 per-span）判定，可避免混排行里单个加粗片段把整行
    误提级，零误伤正文。

    已带 # 前缀的标题行（如 `## 工作经历`）不重复处理。
    """
    if not md:
        return md
    out: list[str] = []
    for line in md.split("\n"):
        m = _BOLD_LINE_RE.match(line.strip())
        if m and "#" not in line:
            out.append(f"### {m.group(1)}")
        else:
            out.append(line)
    return "\n".join(out)


# 标题行被 rag 路径同时包了 `**`（如 `# **工作经历**`）→ 去掉冗余加粗标记
_HEADER_ASTERISK_RE = re.compile(r"^(#{1,6})\s+\*\*(.+?)\*\*\s*$")


def clean_header_asterisks(md: str) -> str:
    """去掉标题行内被 rag 路径冗余包裹的 `**`。

    pymupdf4llm 的 rag 路径在识别到标题后，若整行加粗会再包一层 `**`（见
    `pymupdf_rag.py` 的 `all_bold` 分支），输出形如 `# **工作经历**`。冗余 `**`
    对渲染无益且易与 `calibrate_module_headings` / `promote_bold_lines` 的规则冲突，
    统一剥离为 `# 工作经历`。
    """
    if not md:
        return md
    out: list[str] = []
    for line in md.split("\n"):
        m = _HEADER_ASTERISK_RE.match(line.strip())
        if m:
            out.append(f"{m.group(1)} {m.group(2)}")
        else:
            out.append(line)
    return "\n".join(out)


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


def count_pdf_pages(data: bytes) -> int:
    """返回 PDF 页数；损坏文件由 pypdf 抛异常，由调用方映射为 422。

    用于上传护栏（S4）：在整体解析前先快速校验页数上限，避免超大 PDF
    直接进入 CPU 密集的同步解析路径。
    """
    return len(PdfReader(BytesIO(data)).pages)


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


def _is_garbled(text: str) -> bool:
    """判断 span 级提取的文本是否乱码（CID/子集化字体未正确解码）。

    `_collect_spans` 依赖 pypdf 的 `visitor_operand_after` 回调，它拿到的是
    PDF 流里的原始字节。对标准字体（Helvetica 等）这些字节即 ASCII/Latin-1，
    可直接读出；但对 CID 字体与子集化 Type3 中文字体（真实中文简历普遍如此），
    原始字节是未经 ToUnicode CMap 解码的 CID/字符码，直接按 Latin-1 读出会变成
    ¢©ª«¬®¯°± 等高位乱码——中文全部丢失、词被拆散。

    判定信号：Latin-1 高位字符（U+00A0~U+00FF）占比异常高。正常中文/英文简历
    该占比接近 0；乱码文本该占比通常 >10%（已用真实 CID 中文字体 PDF 校准）。
    返回 True 表示乱码，调用方应回退到 extract_pdf_text（标准提取路径会走
    ToUnicode 正确解码）。
    """
    if not text:
        return False
    total = 0
    high = 0
    for ch in text:
        if ch.isspace() or ch in "`*#-•·，。、；：（）【】“”‘’":
            continue
        total += 1
        o = ord(ch)
        if 0x00A0 <= o <= 0x00FF:
            high += 1
    return total > 0 and high / total > 0.10


def extract_markdown_structure(data: bytes) -> str:
    """纯规则、无 LLM 地重建原简历的层级 Markdown 骨架。

    依据 span 级版面信息（字号 / 加粗 / 位置）确定性地恢复：
    - 模块标题：字号显著大于正文基准的行 → 一级/二级标题；
    - 列表项：行首带列表符号的行 → 保留原列表标记；
    - 加粗：行内加粗片段 → **加粗**；
    - 模块与条目顺序：按版面上→下、左→右顺序保留。

    返回的 markdown 仅承载「结构 + 原文措辞」，供匹配流程作为
    「结构不动、只改内容」的硬约束锚点。无法恢复结构时退化为纯文本行。

    重要：CID/子集化中文字体（真实中文简历主流）下 span 级提取会产出乱码，
    此时返回空字符串，由调用方回退到 extract_pdf_text（标准路径正确解码）。
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

    markdown = "\n".join(out).strip()
    if _is_garbled(markdown):
        return ""
    return markdown
