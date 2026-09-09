"""pdf_export 渲染服务纯逻辑测试（不启动 chromium）：

- sanitize_html：剥离 script 块与 on* 事件属性（纵深防御）；
- _inject_base：<head> 后注入 <base href="{font_origin}/">，root-relative
  字体 URL 因此重定向到字体源；无 <head> 时兜底置于文档开头。

真实 chromium 渲染由 Docker 冒烟验证（见 C7），不在单测范围。
"""

import pytest

from app.services.pdf_export import (
    _fetch_and_encode,
    _inline_root_relative_assets,
    _inject_base,
    sanitize_html,
)


def test_sanitize_html_strips_script_blocks():
    html = "<html><head></head><body><script>alert(1)</script><p>ok</p></body></html>"
    cleaned = sanitize_html(html)
    assert "<script" not in cleaned
    assert "alert(1)" not in cleaned
    assert "<p>ok</p>" in cleaned


def test_sanitize_html_strips_event_attrs():
    html = '<img src="x" onerror="alert(1)"><div onclick="steal()">content</div>'
    cleaned = sanitize_html(html)
    assert "onerror" not in cleaned
    assert "onclick" not in cleaned
    assert "<div>content</div>" in cleaned


def test_sanitize_html_keeps_normal_attrs():
    html = '<a href="https://example.com" rel="nofollow">link</a>'
    cleaned = sanitize_html(html)
    assert cleaned == html


def test_inject_base_after_head():
    html = "<!doctype html><html><head><meta charset=\"utf-8\"><title>R</title></head><body>x</body></html>"
    out = _inject_base(html, "http://frontend:3005")
    assert '<base href="http://frontend:3005/" />' in out
    # base 紧跟 <head> 之后（先于任何样式引用）
    assert out.index("<base") < out.index("<meta")
    assert out.index("<base") > out.index("<head>")


def test_inject_base_handles_trailing_slash_origin():
    out = _inject_base("<html><head></head><body></body></html>", "http://localhost:3005/")
    assert '<base href="http://localhost:3005/" />' in out


def test_inject_base_fallback_without_head():
    html = "<html><body>x</body></html>"
    out = _inject_base(html, "http://frontend:3005")
    assert out.startswith('<base href="http://frontend:3005/" />')


# ---------- 服务端资源内联（字体/图片 root-relative -> data: URL） ----------

@pytest.mark.asyncio
async def test_inline_replaces_root_relative_font_url(monkeypatch):
    async def fake_fetch(abs_url, netloc):
        return "data:font/ttf;base64,FAKE"

    monkeypatch.setattr(
        "app.services.pdf_export._fetch_and_encode", fake_fetch
    )
    html = (
        '<style>@font-face{src:url("/fonts/a.ttf") format("truetype")}'
        'body{background:url(/img/b.png)}</style>'
    )
    out, fallback = await _inline_root_relative_assets(html, "http://frontend:3005")
    # 字体资源（.ttf）服务端内联为 data: URL
    assert "data:font/ttf;base64,FAKE" in out
    assert "/fonts/a.ttf" not in out
    # 非字体资源（图片）不再服务端内联，保留原 url 交给 Chromium 经 <base> 加载，
    # 避免大图串行内联拖慢/撑爆渲染进程
    assert "/img/b.png" in out
    assert fallback is False


@pytest.mark.asyncio
async def test_inline_keeps_absolute_and_data_urls(monkeypatch):
    # 绝对地址 / data: / #fragment 不应被服务端拉取（防 SSRF），保持原样
    calls = []

    async def fake_fetch(abs_url, netloc):
        calls.append(abs_url)
        return "data:x"

    monkeypatch.setattr("app.services.pdf_export._fetch_and_encode", fake_fetch)
    html = (
        'src1:url(http://evil.example/x.ttf);'
        'src2:url(data:image/png;base64,ABC);'
        'src3:url(#frag)'
    )
    out, fallback = await _inline_root_relative_assets(html, "http://frontend:3005")
    assert out == html
    assert calls == []
    assert fallback is False


@pytest.mark.asyncio
async def test_inline_reports_fallback_on_fetch_failure(monkeypatch):
    async def fake_fetch_fail(abs_url, netloc):
        return None

    monkeypatch.setattr("app.services.pdf_export._fetch_and_encode", fake_fetch_fail)
    html = '<style>@font-face{src:url("/fonts/a.ttf") format("truetype")}</style>'
    out, fallback = await _inline_root_relative_assets(html, "http://frontend:3005")
    assert fallback is True
    assert "/fonts/a.ttf" in out  # 保留原 url 走 <base> 兜底


@pytest.mark.asyncio
async def test_inline_only_font_extensions(monkeypatch):
    # 只内联字体（ttf/otf/woff/woff2），非字体资源（图片/svg）保留原 url，
    # 交由 Chromium 经 <base href> 自行加载，避免大图串行内联拖慢/撑爆进程。
    fetched = []

    async def fake_fetch(abs_url, netloc):
        fetched.append(abs_url)
        return "data:font/ttf;base64,FAKE"

    monkeypatch.setattr("app.services.pdf_export._fetch_and_encode", fake_fetch)
    html = (
        'a{src:url("/fonts/x.woff2")}'        # 字体 → 应内联
        'b{background:url(/img/photo.png)}'   # 图片 → 保留
        'c{background:url(/icon/logo.svg)}'   # svg  → 保留
    )
    out, fallback = await _inline_root_relative_assets(html, "http://frontend:3005")
    assert fetched == ["http://frontend:3005/fonts/x.woff2"]
    assert "data:font/ttf;base64,FAKE" in out
    assert "/img/photo.png" in out
    assert "/icon/logo.svg" in out
    assert fallback is False


@pytest.mark.asyncio
async def test_fetch_and_encode_rejects_cross_host():
    # 同源校验：host 不符直接拒绝，不发起网络请求
    assert await _fetch_and_encode("http://other-host/fonts/x.ttf", "frontend:3005") is None
    assert await _fetch_and_encode("https://frontend:9999/fonts/x.ttf", "frontend:3005") is None


@pytest.mark.asyncio
async def test_fetch_and_encode_rejects_non_http():
    assert await _fetch_and_encode("ftp://frontend:3005/x", "frontend:3005") is None
    assert await _fetch_and_encode("//frontend:3005/x", "frontend:3005") is None

