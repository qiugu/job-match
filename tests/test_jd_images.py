"""JD 截图预处理服务的单元测试。

覆盖两类契约：
1. validate_jd_images 的安全边界（数量 / MIME / base64 / 体积 / 总量）；
2. resolve_jd_text 的适配器语义（无图片零副作用、有图片拼接、失败显式抛错）。

全部 monkeypatch LLM 客户端，不依赖真实网络或 API key。
"""
from __future__ import annotations

import base64
from types import SimpleNamespace

import pytest

import app.services.jd_images as svc
from datetime import timedelta

from sqlalchemy import select

from conftest import auth_headers
from app.core.timeutils import utcnow
from app.models.registration_code import RegistrationCode
from app.models.user import User


def _data_url(raw: bytes = b"fake-image-bytes", mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


class _FakeLLM:
    """记录调用参数并返回确定性响应，替代 ChatOpenAI。"""

    def __init__(self, content):
        self.content = content
        self.messages = None

    async def ainvoke(self, messages):
        self.messages = messages
        return SimpleNamespace(content=self.content)


class TestValidateJdImages:
    def test_none_and_empty_are_noop(self):
        assert svc.validate_jd_images(None) == []
        assert svc.validate_jd_images([]) == []

    def test_valid_data_url_is_returned_unchanged(self):
        url = _data_url()
        assert svc.validate_jd_images([url]) == [url]
        assert svc.validate_jd_images([_data_url(mime="image/webp")])

    def test_rejects_more_than_four_images(self):
        with pytest.raises(svc.JDImageError, match="最多"):
            svc.validate_jd_images([_data_url()] * (svc.MAX_JD_IMAGES + 1))

    def test_rejects_plain_url_and_non_base64_data_url(self):
        with pytest.raises(svc.JDImageError, match="data URL"):
            svc.validate_jd_images(["https://example.com/jd.png"])
        with pytest.raises(svc.JDImageError, match="格式不正确"):
            svc.validate_jd_images(["data:image/png,jd.png"])

    def test_rejects_unsupported_mime_including_svg(self):
        for mime in ("image/svg+xml", "text/html", "application/pdf"):
            with pytest.raises(svc.JDImageError, match="不支持的图片类型"):
                svc.validate_jd_images([_data_url(mime=mime)])

    def test_rejects_invalid_base64(self):
        with pytest.raises(svc.JDImageError, match="base64"):
            svc.validate_jd_images(["data:image/png;base64,@@@not-base64@@@"])

    def test_rejects_empty_payload(self):
        with pytest.raises(svc.JDImageError, match="内容为空"):
            svc.validate_jd_images(["data:image/png;base64,"])

    def test_rejects_oversize_single_image(self, monkeypatch):
        # 缩小阈值即可用小样本覆盖体积分支，避免构造 4MB 字符串。
        monkeypatch.setattr(svc, "MAX_IMAGE_BYTES", 8)
        with pytest.raises(svc.JDImageError, match="4MB"):
            svc.validate_jd_images([_data_url(b"x" * 9)])

    def test_rejects_total_over_limit(self, monkeypatch):
        monkeypatch.setattr(svc, "MAX_TOTAL_IMAGE_BYTES", 10)
        with pytest.raises(svc.JDImageError, match="8MB"):
            svc.validate_jd_images([_data_url(b"x" * 6), _data_url(b"x" * 6)])

    def test_rejects_string_instead_of_list(self):
        # str 也是 Sequence[str]，必须显式拒绝，避免逐字符校验。
        with pytest.raises(svc.JDImageError, match="列表格式"):
            svc.validate_jd_images("data:image/png;base64,AAAA")  # type: ignore[arg-type]


class TestResolveJdText:
    @pytest.mark.asyncio
    async def test_no_images_returns_original_and_never_calls_llm(self, monkeypatch):
        called = False

        async def _should_not_run(*_args, **_kwargs):
            nonlocal called
            called = True
            return "识别文本"

        monkeypatch.setattr(svc, "extract_jd_text_from_images", _should_not_run)
        assert await svc.resolve_jd_text("原始 JD 文本", None) == "原始 JD 文本"
        assert await svc.resolve_jd_text("原始 JD 文本", []) == "原始 JD 文本"
        assert called is False

    @pytest.mark.asyncio
    async def test_appends_recognized_block_to_existing_jd(self, monkeypatch):
        async def _fake(images, existing_jd_text=""):
            assert len(images) == 1
            assert existing_jd_text == "原始 JD"
            return "识别出的岗位要求"

        monkeypatch.setattr(svc, "extract_jd_text_from_images", _fake)
        result = await svc.resolve_jd_text("原始 JD", [_data_url()])
        assert result.startswith("原始 JD\n\n")
        assert svc.JD_IMAGE_BLOCK_MARKER in result
        assert result.endswith("识别出的岗位要求")

    @pytest.mark.asyncio
    async def test_images_only_produces_non_empty_jd(self, monkeypatch):
        async def _fake(_images, _existing=""):
            return "截图里的 JD"

        monkeypatch.setattr(svc, "extract_jd_text_from_images", _fake)
        result = await svc.resolve_jd_text("   ", [_data_url()])
        assert result.strip()
        assert svc.JD_IMAGE_BLOCK_MARKER in result

    @pytest.mark.asyncio
    async def test_invalid_image_raises_before_any_llm_call(self, monkeypatch):
        async def _should_not_run(*_args, **_kwargs):
            raise AssertionError("非法图片不应触发识别")

        monkeypatch.setattr(svc, "extract_jd_text_from_images", _should_not_run)
        with pytest.raises(svc.JDImageError):
            await svc.resolve_jd_text("JD", ["https://example.com/x.png"])


class TestExtractJdTextFromImages:
    @pytest.mark.asyncio
    async def test_builds_multimodal_messages(self, monkeypatch):
        fake = _FakeLLM("岗位：后端工程师")
        monkeypatch.setattr(svc, "is_configured", lambda: True)
        monkeypatch.setattr(svc, "get_llm", lambda temperature=None: fake)

        first, second = _data_url(b"a"), _data_url(b"b", mime="image/jpeg")
        text = await svc.extract_jd_text_from_images([first, second], "已有 JD")

        assert text == "岗位：后端工程师"
        assert fake.messages is not None
        assert fake.messages[0]["role"] == "system"
        user_parts = fake.messages[1]["content"]
        assert user_parts[0]["type"] == "text"
        assert "已有 JD" in user_parts[0]["text"]
        image_parts = [p for p in user_parts if p["type"] == "image_url"]
        assert [p["image_url"]["url"] for p in image_parts] == [first, second]

    @pytest.mark.asyncio
    async def test_list_content_is_normalized(self, monkeypatch):
        fake = _FakeLLM([{"type": "text", "text": "识别文本"}])
        monkeypatch.setattr(svc, "is_configured", lambda: True)
        monkeypatch.setattr(svc, "get_llm", lambda temperature=None: fake)
        assert await svc.extract_jd_text_from_images([_data_url()]) == "识别文本"

    @pytest.mark.asyncio
    async def test_empty_recognition_raises(self, monkeypatch):
        fake = _FakeLLM("   ")
        monkeypatch.setattr(svc, "is_configured", lambda: True)
        monkeypatch.setattr(svc, "get_llm", lambda temperature=None: fake)
        with pytest.raises(RuntimeError, match="未能识别"):
            await svc.extract_jd_text_from_images([_data_url()])

    @pytest.mark.asyncio
    async def test_unconfigured_llm_raises(self, monkeypatch):
        monkeypatch.setattr(svc, "is_configured", lambda: False)
        with pytest.raises(RuntimeError, match="LLM 未配置"):
            await svc.extract_jd_text_from_images([_data_url()])


# --------------------------------------------------------------- API 契约层
async def _login(client, session, username, code="JDIMG-CODE"):
    """注册并返回 (token, username)，复用既有路由测试的注册码模式。"""
    exists = (
        await session.execute(
            select(RegistrationCode).where(RegistrationCode.code == code)
        )
    ).scalars().first()
    if exists is None:
        session.add(
            RegistrationCode(
                code=code,
                grant_credits=50,
                expires_at=utcnow() + timedelta(days=1),
            )
        )
        await session.commit()
    response = await client.post(
        "/api/auth/register",
        json={"username": username, "password": "Pass#1234", "code": code},
    )
    assert response.status_code == 200, response.text
    return response.json()["token"], username


async def _credits(session, username):
    session.expire_all()
    return (
        await session.execute(
            select(User.credits).where(User.username == username)
        )
    ).scalar_one()


@pytest.mark.asyncio
async def test_match_route_rejects_invalid_images_without_charging(
    client, session, monkeypatch
):
    token, username = await _login(client, session, "jdimg-match")
    before = await _credits(session, username)
    called = False

    async def _fake_run_match(master_text, jd_text):
        nonlocal called
        called = True
        return [], "", None

    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)
    response = await client.post(
        "/api/derived-resumes",
        json={
            "resumeText": "简历正文",
            "jdText": "岗位描述",
            "jdImages": ["https://example.com/x.png"],
        },
        headers=auth_headers(token),
    )
    assert response.status_code == 400
    assert "data URL" in response.json()["detail"]
    assert called is False
    assert await _credits(session, username) == before


@pytest.mark.asyncio
async def test_cover_letter_route_rejects_invalid_images(
    client, session, monkeypatch
):
    token, username = await _login(client, session, "jdimg-pitch")
    before = await _credits(session, username)

    async def _fake_run_cover_letter(jd_text, resume_text, scene):
        return "话术正文"

    monkeypatch.setattr(
        "app.api.cover_letter.run_cover_letter", _fake_run_cover_letter
    )
    response = await client.post(
        "/api/cover-letters",
        json={
            "resume_text": "简历正文",
            "jd_text": "岗位描述",
            "jd_images": ["data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="],
        },
        headers=auth_headers(token),
    )
    assert response.status_code == 400
    assert await _credits(session, username) == before
