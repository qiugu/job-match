"""服务端 PDF 渲染：headless Chromium（Playwright）矢量导出。

为什么放在后端而不是前端 html2canvas：
- Chromium 的 print-to-PDF 产出矢量文字（可选中/可搜索，ATS 友好），体积约
  100–200KB，远小于 html2canvas 的整页位图方案（700KB–1.8MB）；
- 与「浏览器打印」共用同一份打印版 HTML（见前端 utils/printHtml.ts），
  分页规则与版式完全一致。

设计要点：
- playwright 与 chromium 均在**首次请求时懒加载**（ImportError / 启动失败 →
  PdfExportUnavailableError → 接口 503），应用启动与无此能力的部署不受影响；
- chromium 以 root 运行需要 --no-sandbox；小内存容器用 --disable-dev-shm-usage；
- 渲染上下文禁用 JavaScript，并对 HTML 做 script/事件属性剥离（纵深防御，
  渲染对象无任何凭据）；
- **字体/图片资源内联**：HTML 中 root-relative 的 url（/fonts/...、/uploads/...）
  由服务端从字体源拉取并改写为 data: URL 再渲染——headless Chromium 沙箱网络
  受限且禁用 JS，若仅靠 <base href> 让浏览器自行拉取会静默回退到系统字体
  （表现为 PDF 中文非所选字体）；内联后渲染不再依赖浏览器外网，字体必然生效。
  <base href> 仍注入，仅作为未被内联的绝对/异常 url 的兜底；
- asyncio.Semaphore 限制并发，避免低配服务器 OOM。
"""
from __future__ import annotations

import asyncio
import base64
import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

import httpx

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger("pdf_export")


@dataclass
class PdfRenderResult:
    """渲染产物 + 元信息。"""

    pdf: bytes
    # True 表示至少有一个字体/图片资源服务端内联失败，最终 PDF 可能回退到系统字体
    font_fallback_used: bool = False

# 服务端内联资源（字体/图片）时允许的 MIME（依据扩展名或响应 Content-Type 兜底）
_MIME_BY_EXT = {
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}
# 匹配 CSS 中的 url(...)，捕获引号与路径；后续只处理 root-relative（以 / 开头）的路径
_ASSET_URL_RE = re.compile(r"url\(\s*(['\"]?)([^'\"()\s]+)\1\s*\)")
# 仅内联字体文件：字体必须服务端内联（浏览器沙箱加载会回退到系统字体）；
# 图片/图标等非字体资源交给 Chromium 经 <base href> 自行加载（带浏览器超时，
# 不会让请求永久挂起）。否则简历头像等大图被串行内联会拖慢甚至撑爆渲染进程。
_FONT_EXT = frozenset({"ttf", "otf", "woff", "woff2"})
# 内联资源拉取超时（秒）；字体文件较大，给到 15s
_ASSET_FETCH_TIMEOUT = 15.0
# 资源内联结果缓存：absolute_url -> data: URL（字体文件静态，命中率高，避免每次渲染重复拉取数 MB）
_ASSET_CACHE: dict[str, str] = {}
_ASSET_CACHE_LOCK = asyncio.Lock()
_ASSET_CACHE_MAX = 64


def _mime_from_path(path: str) -> str:
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return _MIME_BY_EXT.get(f".{ext}", "application/octet-stream")


async def _fetch_and_encode(abs_url: str, origin_netloc: str) -> Optional[str]:
    """拉取单个资源并转为 data: URL；失败返回 None（调用方保留原 url 走 <base> 兜底）。

    SSRF 防护：仅允许与字体源同 host 的 http/https 地址；其余一律拒绝。
    """
    async with _ASSET_CACHE_LOCK:
        if abs_url in _ASSET_CACHE:
            return _ASSET_CACHE[abs_url]
    parsed = urlparse(abs_url)
    if parsed.scheme not in ("http", "https") or parsed.netloc != origin_netloc:
        logger.warning("拒绝内联非同源资源（SSRF 防护）：%s", abs_url)
        return None
    try:
        async with httpx.AsyncClient(
            timeout=_ASSET_FETCH_TIMEOUT, follow_redirects=True
        ) as client:
            async with client.stream("GET", abs_url) as resp:
                if resp.status_code != 200:
                    logger.warning("资源拉取非 200（%s）：%s", resp.status_code, abs_url)
                    return None
                ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                data = b""
                async for chunk in resp.aiter_bytes(chunk_size=65536):
                    data += chunk
                    if len(data) > settings.pdf_export_max_asset_bytes:
                        logger.warning("资源超上限，放弃内联：%s", abs_url)
                        return None
        mime = ctype or _mime_from_path(abs_url)
        data_url = f"data:{mime};base64,{base64.b64encode(data).decode()}"
    except Exception as exc:  # 网络/解析异常：不阻断导出，保留原 url 走 <base> 兜底
        logger.warning("资源内联失败 %s: %s", abs_url, exc)
        return None
    async with _ASSET_CACHE_LOCK:
        if len(_ASSET_CACHE) >= _ASSET_CACHE_MAX:
            _ASSET_CACHE.clear()
        _ASSET_CACHE[abs_url] = data_url
    return data_url


async def _inline_root_relative_assets(html: str, font_origin: str) -> tuple[str, bool]:
    """把 HTML 中 root-relative 的字体/图片 url() 由服务端拉取并改写成 data: URL。

    为什么这样做：headless Chromium 渲染上下文禁用 JS 且沙箱网络受限，仅靠
    <base href> 让浏览器自行拉取 /fonts/* 会导致字体/图片加载失败并静默回退到系统
    字体（表现为 PDF 里中文不是所选字体）。改为服务端拉取并内联为 data: URL 后，
    渲染不再依赖浏览器外网，字体必然生效，且 HTML 请求体仍保持小巧（data URL 仅在
    服务端内存中生成，不进 API 入参）。

    仅处理以 / 开头的相对路径；绝对 URL（含 http://、data:、#fragment）保持原样，
    由浏览器经 <base> 兜底解析（绝对地址不会在服务端被拉取，规避 SSRF）。

    Returns:
        (处理后的 HTML, 是否发生过内联失败回退)
    """
    parsed_origin = urlparse(font_origin)
    if parsed_origin.scheme not in ("http", "https") or not parsed_origin.netloc:
        logger.warning("font_origin 非法，跳过资源内联：%s", font_origin)
        return html, True

    # 仅收集 root-relative 的字体文件路径；非字体（图片/图标等）保留原 url，
    # 交由 Chromium 经 <base href> 自行加载，避免大图内联拖慢或撑爆进程。
    seen: dict[str, str] = {}
    for quote, path in _ASSET_URL_RE.findall(html):
        ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
        if path.startswith("/") and not path.startswith("//") and ext in _FONT_EXT:
            seen.setdefault(path, quote)

    fallback_used = False
    for path, quote in seen.items():
        abs_url = f"{parsed_origin.scheme}://{parsed_origin.netloc}{path}"
        data_url = await _fetch_and_encode(abs_url, parsed_origin.netloc)
        if data_url:
            html = html.replace(f"url({quote}{path}{quote})", f"url({data_url})")
        else:
            fallback_used = True
            logger.error(
                "字体/图片资源内联失败，PDF 将回退到系统字体：%s；"
                "请检查 PDF_EXPORT_FONT_ORIGIN 是否对后端可达（本机开发应设为 http://localhost:3005）",
                abs_url,
            )
    return html, fallback_used


class PdfExportUnavailableError(Exception):
    """渲染能力不可用（未安装 playwright / chromium / 启动失败）。"""


class PdfRenderFailedError(Exception):
    """渲染阶段失败（浏览器崩溃 / 超时 / 内容异常），已与能力不可用区分开。"""


# 进程级单例，首请求懒加载
_playwright = None
_browser = None
_semaphore: Optional[asyncio.Semaphore] = None
_browser_lock = asyncio.Lock()

_SCRIPT_RE = re.compile(r"<script\b[^>]*>.*?</script>", re.IGNORECASE | re.DOTALL)
_EVENT_ATTR_RE = re.compile(r"\son\w+\s*=\s*(['\"]).*?\1", re.IGNORECASE | re.DOTALL)


def sanitize_html(html: str) -> str:
    """纵深防御：剥离 script 块与 on* 事件属性。

    渲染上下文本身已禁用 JS，此步仅为防止未来前端代码注入或内容意外携带
    可执行片段时仍能无害化。简历为自产 HTML，不含合法 script，可安全剥离。
    """
    return _EVENT_ATTR_RE.sub("", _SCRIPT_RE.sub("", html))


def _inject_base(html: str, font_origin: str) -> str:
    """在 <head> 之后注入 <base href="{font_origin}/">。

    print HTML 内字体/资源 URL 为 root-relative（/fonts/...），<base> 使其
    相对该 origin 解析；仅替换资源解析，不影响正文文本。
    """
    base_tag = f'<base href="{font_origin.rstrip("/")}/" />'
    head_idx = html.find("<head")
    if head_idx != -1:
        gt = html.find(">", head_idx)
        if gt != -1:
            return html[: gt + 1] + base_tag + html[gt + 1 :]
    # 兜底：无 <head> 时置于文档开头（<base> 必须在引用资源前）
    return base_tag + html


def _get_semaphore() -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(settings.pdf_export_max_concurrency)
    return _semaphore


async def _ensure_browser():
    """懒加载 playwright + chromium 单例（进程内复用，避免每请求起浏览器）。"""
    global _playwright, _browser
    if _browser is not None and _browser.is_connected():
        return

    async with _browser_lock:
        if _browser is not None and _browser.is_connected():
            return
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:  # playwright 未安装（部署未升级）
            logger.error("playwright 未安装，无法启用服务端 PDF 导出")
            raise PdfExportUnavailableError(
                "服务端 PDF 渲染组件未安装，请先用浏览器打印/另存为 PDF"
            ) from exc

        try:
            _playwright = await async_playwright().start()
            _browser = await _playwright.chromium.launch(
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            logger.info("无头 Chromium 已启动（服务端 PDF 导出就绪）")
        except Exception as exc:  # chromium 二进制缺失 / 系统库缺失等
            logger.exception("无头 Chromium 启动失败")
            if _playwright is not None:
                await _playwright.stop()
                _playwright = None
            raise PdfExportUnavailableError(
                "无法启动无头浏览器（chromium 缺失或系统库不足），请用浏览器打印/另存为 PDF"
            ) from exc


async def render_html_to_pdf(html: str, font_origin: str) -> PdfRenderResult:
    """渲染打印版 HTML 为 PDF 字节流（矢量、A4、@page CSS 优先）。

    返回 PdfRenderResult，调用方可通过 font_fallback_used 判断字体是否回退，
    从而向前端用户给出明确提示，避免静默使用系统字体。
    """
    global _browser
    await _ensure_browser()

    assert _browser is not None
    # 先剥离脚本/事件属性，再把 root-relative 字体/图片拉取为 data: URL 内联，
    # 最后注入 <base href> 处理剩余异常 url。顺序不可颠倒：内联需在 base 注入前完成，
    # 否则 root-relative 路径会被 base 改写为绝对地址而不再被内联命中。
    safe_html = sanitize_html(html)
    safe_html, fallback_used = await _inline_root_relative_assets(safe_html, font_origin)
    safe_html = _inject_base(safe_html, font_origin)
    # 内联字体后用 block 而非 swap：字体已随 HTML 同步就绪，文字直接以所选字体绘制，
    # 避免 swap 在字体未首绘时落入回退态（本渲染禁用 JS，无法 await fonts.ready 等待）。
    safe_html = safe_html.replace("font-display: swap", "font-display: block")

    async with _get_semaphore():
        # 禁用 JS 的隔离上下文：每次渲染独立 context，页面间互不共享状态。
        # 浏览器单例可能在上一次渲染中崩溃（OOM / 目标页关闭）：创建失败时清空
        # 单例，让下一次请求自动重启 Chromium，本请求给出友好错误而非裸 500。
        try:
            context = await _browser.new_context(java_script_enabled=False)
            page = await context.new_page()
        except Exception as exc:
            logger.exception("创建渲染上下文失败（浏览器单例可能已崩溃），重置待重启")
            _browser = None
            raise PdfRenderFailedError(
                "渲染服务异常，请稍后重试；若持续失败请精简简历内容"
            ) from exc
        try:
            # 体积护栏：内联字体后 HTML 仍异常膨胀（如误入多字体）时，直接拒绝渲染，
            # 避免把百 MB 级 HTML 喂给 Chromium 导致进程崩溃（表现为请求永久 pending）。
            if len(safe_html) > settings.pdf_export_max_inline_html_bytes:
                logger.error(
                    "内联后 HTML 体积过大（%d bytes，上限 %d），拒绝渲染以防 Chromium 崩溃",
                    len(safe_html),
                    settings.pdf_export_max_inline_html_bytes,
                )
                raise PdfRenderFailedError(
                    "简历内容过大无法导出，请精简后重试"
                )

            timeout_ms = settings.pdf_export_timeout_seconds * 1000
            _t = asyncio.get_event_loop().time()
            await page.set_content(safe_html, wait_until="load", timeout=timeout_ms)
            logger.debug("set_content 完成（%.2fs）", asyncio.get_event_loop().time() - _t)
            # 等待字体 / 图片等子资源静默（playwright 的 load 不含子资源）
            try:
                await page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                logger.debug("networkidle 超时，继续渲染（字体可能回退系统字体）")
            await asyncio.sleep(0.3)  # 额外渲染帧缓冲

            # page.pdf() 本身无内置超时，若 Chromium 在生成阶段卡死会让请求永久挂起；
            # 用 asyncio.wait_for 兜底，超时即转友好错误而非裸 500/无限 pending。
            _t = asyncio.get_event_loop().time()
            try:
                pdf = await asyncio.wait_for(
                    page.pdf(
                        prefer_css_page_size=True,  # 尊重 @page { size: A4 }，margin 走 CSS
                        print_background=True,
                    ),
                    timeout=settings.pdf_export_timeout_seconds,
                )
            except asyncio.TimeoutError:
                logger.error("page.pdf() 超时（%ds），渲染中断", settings.pdf_export_timeout_seconds)
                raise PdfRenderFailedError(
                    "PDF 渲染超时，请稍后重试或精简简历内容"
                )
            logger.debug("page.pdf 完成（%.2fs）", asyncio.get_event_loop().time() - _t)
            return PdfRenderResult(pdf=pdf, font_fallback_used=fallback_used)
        except Exception as exc:
            # 渲染期异常（含浏览器崩溃 TargetClosedError / set_content 超时）统一转
            # 友好错误，避免向上抛裸 500；浏览器崩溃同样清空单例待下次重启。
            if not _browser_is_connected():
                logger.error("渲染期间浏览器崩溃，重置单例待下次请求重启")
                _browser = None
            logger.exception("PDF 渲染失败")
            raise PdfRenderFailedError(
                "PDF 渲染失败，请重试；若持续失败请精简简历内容后重试"
            ) from exc
        finally:
            # 浏览器崩溃后 context 已随之关闭，close() 会抛 TargetClosedError——
            # 此处必须吞掉，否则它会覆盖上方已转换的业务异常（曾导致裸 500）。
            try:
                await context.close()
            except Exception:
                logger.debug("关闭渲染上下文失败（浏览器可能已退出），忽略")


def _browser_is_connected() -> bool:
    return _browser is not None and _browser.is_connected()


async def shutdown_renderer() -> None:
    """关闭单例浏览器（应用退出时调用，见 app/main.py lifespan）。"""
    global _playwright, _browser
    if _browser is not None:
        try:
            await _browser.close()
        finally:
            _browser = None
    if _playwright is not None:
        try:
            await _playwright.stop()
        finally:
            _playwright = None
