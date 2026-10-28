"""简历 PDF 上传护栏（S4）：体积与页数硬上限。

此前上传入口 `await file.read()` 一次性读入内存且无任何长度/页数判断，
认证用户提交超大 PDF 即可撑爆内存并拖垮同步解析线程。修复后由
`app.api.resume._read_upload_with_limits` 分块累计读、超限直接 413。
"""

from __future__ import annotations

import io

import pytest
from fastapi import UploadFile
from pypdf import PdfWriter

from app.api.resume import _read_upload_with_limits
from app.core.config import settings


def _make_pdf(page_count: int) -> bytes:
    writer = PdfWriter()
    for _ in range(page_count):
        writer.add_blank_page(width=612, height=792)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def _upload(filename: str, data: bytes) -> UploadFile:
    return UploadFile(filename=filename, file=io.BytesIO(data))


@pytest.mark.asyncio
async def test_oversized_upload_returns_413(monkeypatch):
    # 把体积上限临时压到 100 字节，用 200 字节文件验证分块读在超限时立即 413。
    monkeypatch.setattr(settings, "resume_upload_max_bytes", 100)
    with pytest.raises(Exception) as exc:
        await _read_upload_with_limits(_upload("big.pdf", b"x" * 200))
    assert exc.value.status_code == 413


@pytest.mark.asyncio
async def test_excessive_pages_returns_413(monkeypatch):
    # 把页数上限临时压到 1 页，用 2 页 PDF 验证页数护栏触发 413。
    monkeypatch.setattr(settings, "resume_upload_max_pages", 1)
    with pytest.raises(Exception) as exc:
        await _read_upload_with_limits(_upload("many.pdf", _make_pdf(2)))
    assert exc.value.status_code == 413


@pytest.mark.asyncio
async def test_valid_small_pdf_passes(monkeypatch):
    monkeypatch.setattr(settings, "resume_upload_max_bytes", 10 * 1024 * 1024)
    monkeypatch.setattr(settings, "resume_upload_max_pages", 50)
    data = await _read_upload_with_limits(_upload("ok.pdf", _make_pdf(1)))
    assert isinstance(data, bytes) and len(data) > 0
