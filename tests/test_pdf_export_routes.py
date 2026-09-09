"""export 路由测试：鉴权 / 渲染成功 / 内容过大 / 渲染能力不可用 / 限流。

真实 chromium 渲染不在单测覆盖范围（需浏览器二进制），统一 mock
`app.api.export.render_html_to_pdf` 返回假 PDF 字节；渲染本身由
C7 的 Docker 冒烟验证。限流窗口为内存滑动窗口，按 user.id 隔离。
"""

import pytest

from conftest import auth_headers
from app.core.config import settings
from app.services.pdf_export import PdfRenderResult

# 复用 auth 测试的注册辅助（tests/ 目录已在 sys.path，同目录模块直接 import）
from test_auth_routes import _register


def _fake_pdf_bytes() -> bytes:
    return b"%PDF-1.4\n% fake vector pdf for export route test\n%%EOF"


def _fake_result(fallback: bool = False) -> PdfRenderResult:
    return PdfRenderResult(pdf=_fake_pdf_bytes(), font_fallback_used=fallback)


@pytest.mark.asyncio
async def test_export_pdf_requires_auth(client):
    r = await client.post(
        "/api/export/pdf",
        json={"html": "<html><body>hi</body></html>", "title": "resume"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_export_pdf_success(client, session, monkeypatch):
    async def _fake_render(html: str, font_origin: str) -> PdfRenderResult:
        # 断言字体源已传入（C4 契约：渲染服务用 settings.pdf_export_font_origin 解析 /fonts）
        assert font_origin == settings.pdf_export_font_origin
        return _fake_result()

    monkeypatch.setattr(
        "app.api.export.render_html_to_pdf", _fake_render
    )

    token = await _register(client, session, "exporter1", code="EXC1", password="Pass#1234")
    r = await client.post(
        "/api/export/pdf",
        headers=auth_headers(token),
        json={"html": "<!doctype html><html><head></head><body>简历</body></html>", "title": "我的简历"},
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/pdf")
    assert r.content == _fake_pdf_bytes()
    # Content-Disposition 使用 RFC 5987 编码文件名，含 .pdf 后缀
    cd = r.headers["content-disposition"]
    assert "attachment" in cd
    assert "filename*=UTF-8''" in cd
    assert ".pdf" in cd


@pytest.mark.asyncio
async def test_export_pdf_oversized_rejected(client, session, monkeypatch):
    called = {"n": 0}

    async def _fake_render(html: str, font_origin: str) -> PdfRenderResult:
        called["n"] += 1
        return _fake_result()

    monkeypatch.setattr("app.api.export.render_html_to_pdf", _fake_render)

    token = await _register(client, session, "exporter2", code="EXC2", password="Pass#1234")
    big_html = "<div>" + "x" * (settings.pdf_export_max_html_bytes + 1) + "</div>"
    r = await client.post(
        "/api/export/pdf",
        headers=auth_headers(token),
        json={"html": big_html, "title": "big"},
    )
    assert r.status_code == 413
    assert called["n"] == 0  # 过大内容不应触达渲染器


@pytest.mark.asyncio
async def test_export_pdf_renderer_unavailable(client, session, monkeypatch):
    from app.services.pdf_export import PdfExportUnavailableError

    async def _boom(html: str, font_origin: str) -> PdfRenderResult:
        raise PdfExportUnavailableError("渲染组件未安装，请用浏览器打印")

    monkeypatch.setattr("app.api.export.render_html_to_pdf", _boom)

    token = await _register(client, session, "exporter3", code="EXC3", password="Pass#1234")
    r = await client.post(
        "/api/export/pdf",
        headers=auth_headers(token),
        json={"html": "<html><body>x</body></html>", "title": "r"},
    )
    assert r.status_code == 503
    assert "浏览器打印" in r.json()["detail"]


@pytest.mark.asyncio
async def test_export_pdf_rate_limited(client, session, monkeypatch):
    async def _fake_render(html: str, font_origin: str) -> PdfRenderResult:
        return _fake_result()

    monkeypatch.setattr("app.api.export.render_html_to_pdf", _fake_render)
    monkeypatch.setattr(settings, "pdf_export_rate_limit_per_hour", 2)

    token = await _register(client, session, "exporter4", code="EXC4", password="Pass#1234")
    headers = auth_headers(token)
    payload = {"html": "<html><body>x</body></html>", "title": "r"}

    for _ in range(2):
        r = await client.post("/api/export/pdf", headers=headers, json=payload)
        assert r.status_code == 200, r.text

    r3 = await client.post("/api/export/pdf", headers=headers, json=payload)
    assert r3.status_code == 429
    assert "Retry-After" in r3.headers


@pytest.mark.asyncio
async def test_export_pdf_font_fallback_header(client, session, monkeypatch):
    async def _fake_render_fallback(html: str, font_origin: str) -> PdfRenderResult:
        return _fake_result(fallback=True)

    monkeypatch.setattr("app.api.export.render_html_to_pdf", _fake_render_fallback)

    token = await _register(client, session, "exporter5", code="EXC5", password="Pass#1234")
    r = await client.post(
        "/api/export/pdf",
        headers=auth_headers(token),
        json={"html": "<html><body>x</body></html>", "title": "r"},
    )
    assert r.status_code == 200
    assert r.headers["X-Font-Fallback"] == "true"
