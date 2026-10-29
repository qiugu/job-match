"""简历翻译（/api/ai/translate + ai_proxy.translate_fields）契约测试。

背景（PLAN_resume_translate.md）：翻译采用「键值映射」而非整包 ResumeData
回传——非文本配置（id/模板/排版/日期）从不离开客户端，LLM 只译值、原样回传
key，多余 key 丢弃、缺失 key 由前端回退原文。本文件锁定该契约：

1. translate_fields 把 fields + 目标语言原样透传给 LLM；
2. 只回传输入中出现过的 key（LLM 幻觉 key 丢弃、非字符串值丢弃）；
3. 空 fields / 不支持的语言必须显式报错（不静默吞掉）；
4. TRANSLATE_SYSTEM 必须保留结构/专名/空值硬约束（防被删导致回归）；
5. 路由契约：登录鉴权、空 fields 与非法语言返回 BadRequest、成功返回同 key 映射。
"""

import json

import pytest

from conftest import auth_headers
from app.services import ai_proxy
from app.models.registration_code import RegistrationCode
from app.core.timeutils import utcnow
from sqlalchemy import select


def _capture_llm(monkeypatch, captured, content_json='{"title": "My Resume"}'):
    """替换 get_llm / is_configured，捕获透传给 LLM 的 messages，固定返回 JSON。"""

    class _FakeResp:
        content = content_json

    class _FakeLLM:
        async def ainvoke(self, messages, response_format=None):
            captured["messages"] = messages
            captured["response_format"] = response_format
            return _FakeResp()

    monkeypatch.setattr(ai_proxy, "get_llm", lambda **kwargs: _FakeLLM())
    monkeypatch.setattr(ai_proxy, "is_configured", lambda: True)


# ---------- 服务层：translate_fields ----------


@pytest.mark.asyncio
async def test_translate_fields_roundtrip_with_same_keys(monkeypatch):
    """核心契约：字段映射透传 LLM，返回同 key 译文。"""
    captured: dict = {}
    _capture_llm(
        monkeypatch,
        captured,
        content_json='{"title": "My Resume", "skillContent": "- React\\n- TypeScript"}',
    )

    fields = {
        "title": "我的简历",
        "skillContent": "- React\n- TypeScript",
    }
    result = await ai_proxy.translate_fields(fields, "en")

    assert result == {
        "title": "My Resume",
        "skillContent": "- React\n- TypeScript",
    }
    # user 消息为 fields 的 JSON 串（键值映射）
    user_payload = captured["messages"][1]["content"]
    assert '"我的简历"' in user_payload
    # 系统 prompt 内含目标语言与 TRANSLATE_SYSTEM 主体
    system = captured["messages"][0]["content"]
    assert ai_proxy.TRANSLATE_SYSTEM.split("${language}")[0] in system
    assert "English" in system
    # JSON 对象模式（与 grammar_check 同路）
    assert captured["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_translate_fields_drops_hallucinated_and_non_string_values(monkeypatch):
    """LLM 幻觉出的多余 key 与非字符串值必须丢弃，调用方回退原文。"""
    captured: dict = {}
    _capture_llm(
        monkeypatch,
        captured,
        content_json=(
            '{"title": "My Resume", "ghost": "不该出现", "education.a.gpa": 3.8}'
        ),
    )

    fields = {"title": "我的简历", "education.a.gpa": "3.8"}
    result = await ai_proxy.translate_fields(fields, "en")

    assert result == {"title": "My Resume"}
    assert "ghost" not in result
    assert "education.a.gpa" not in result


@pytest.mark.asyncio
async def test_translate_fields_rejects_empty_fields_and_bad_lang(monkeypatch):
    """空 fields / 不支持的语言必须显式报错，不发起 LLM 调用。"""
    captured: dict = {}
    _capture_llm(monkeypatch, captured)

    with pytest.raises(ValueError):
        await ai_proxy.translate_fields({}, "en")
    with pytest.raises(ValueError):
        await ai_proxy.translate_fields({"title": "x"}, "fr")

    # 校验失败必须发生在 LLM 调用之前
    assert "messages" not in captured


@pytest.mark.asyncio
async def test_translate_fields_unparseable_llm_output_raises(monkeypatch):
    """LLM 未返回可解析 JSON → 显式 RuntimeError（不静默返回空）。"""
    captured: dict = {}
    _capture_llm(monkeypatch, captured, content_json="这不是合法 JSON")

    with pytest.raises(RuntimeError):
        await ai_proxy.translate_fields({"title": "我的简历"}, "en")


@pytest.mark.asyncio
async def test_translate_fields_rejects_non_object_json(monkeypatch):
    """LLM 返回非对象 JSON（数组/标量）→ 显式 RuntimeError，而非 AttributeError。

    回归契约（缺陷修复）：_extract_json 只接受 dict，调用方对结果调 .items()，
    放行 list 会抛 AttributeError 落到 500 分支。此处锁定「非对象视为不可解析」。
    """
    for bad in ('[1, 2, 3]', '"just a string"', '42', 'null'):
        captured: dict = {}
        _capture_llm(monkeypatch, captured, content_json=bad)
        with pytest.raises(RuntimeError):
            await ai_proxy.translate_fields({"title": "我的简历"}, "en")


@pytest.mark.asyncio
async def test_translate_fields_extracts_json_from_fenced_and_trailing_text(monkeypatch):
    """容错路径：LLM 返回带 ```json 围栏或尾随说明时仍能正确提取 dict。"""
    captured: dict = {}
    _capture_llm(
        monkeypatch,
        captured,
        content_json='```json\n{"title": "My Resume"}\n```',
    )
    assert await ai_proxy.translate_fields({"title": "我的简历"}, "en") == {
        "title": "My Resume"
    }

    _capture_llm(
        monkeypatch,
        captured,
        content_json='{"title": "My Resume"} 这是说明',
    )
    assert await ai_proxy.translate_fields({"title": "我的简历"}, "en") == {
        "title": "My Resume"
    }


def test_translate_system_prompt_keeps_hard_constraints():
    """翻译 prompt 必须保留结构/原样保留/空值硬约束（删掉会导致格式回归）。"""
    system = ai_proxy.TRANSLATE_SYSTEM
    # 结构标记原样保留
    assert ":::left" in system
    # 日期/邮箱/URL 原样保留
    assert "URL" in system
    # 键集合与输入完全一致
    assert "键集合必须与输入的键集合完全相同" in system
    # 空值处理
    assert "空值" in system


def test_translate_system_prompt_localizes_school_and_project_names():
    """回归契约（缺陷修复）：学校名与项目名必须本地化，不得被「专名保留」吞掉。

    背景：旧规则 3 写作「公司名、学校名、产品名、机构名保留原文」，与字段清单
    （extract 明确把 `education.*.school`、`projects.*.name` 列为可译）互相撤销。
    LLM 优先服从显式禁令，英译中方向实测这两个字段 100% 原样返回，用户报
    「项目名称未翻译 / 学校名称未翻译」。产品裁决（2026-10-29）：学校名、项目名
    纳入本地化；公司名仍保留原文。
    """
    system = ai_proxy.TRANSLATE_SYSTEM
    # 硬性本地化规则在位，且点名了两个字段路径
    assert "学校名与项目名必须本地化" in system
    assert "education.*.school" in system
    assert "projects.*.name" in system
    # 旧措辞必须消失：它会重新把学校名/项目名归入「保留原文」
    assert "专名保留原文" not in system
    assert "学校名、产品名、机构名保留原文" not in system
    # 公司名保留原文（产品裁决：不本地化）
    assert "公司名" in system


def test_translate_languages_whitelist_is_zh_en_only():
    """产品决策（2026-10-28）：本期只支持中英，白名单与前端对齐。"""
    assert set(ai_proxy.TRANSLATE_LANGUAGES.keys()) == {"zh", "en"}


# ---------- 可观测性护栏：某字段组整组原样返回时告警 ----------


def test_warn_if_group_unchanged_only_fires_for_fully_unchanged_groups(monkeypatch):
    """整组未变化才告警：组内有变化、或样本不足（单字段组）都不应误报。

    用替换 logger.warning 的方式捕获——项目 logger 的 propagate=False（见
    app/core/logging.py），caplog 挂 root handler 抓不到。
    """
    calls: list = []
    monkeypatch.setattr(ai_proxy.logger, "warning", lambda *a, **k: calls.append(a))

    # education 组 2 项全未变化 → 告警一次，只记分组名与计数
    edu = {
        "education.a.school": "Fudan University",
        "education.b.school": "Anhui Normal University",
    }
    ai_proxy._warn_if_group_unchanged(edu, dict(edu))
    assert len(calls) == 1
    assert calls[0][1] == "education"
    assert calls[0][2] == 2

    # 组内已有一项译出（JD-Match 属纯代号正常保留）→ 不告警
    calls.clear()
    ai_proxy._warn_if_group_unchanged(
        {
            "projects.a.name": "Intelligent Resume Matching Platform",
            "projects.b.name": "JD-Match",
        },
        {"projects.a.name": "智能简历匹配平台", "projects.b.name": "JD-Match"},
    )
    assert calls == []

    # 单字段组样本不足，无法区分「正常保留」与「漏译」→ 不告警
    calls.clear()
    ai_proxy._warn_if_group_unchanged({"title": "My Resume"}, {"title": "My Resume"})
    assert calls == []


def test_warn_if_group_unchanged_ignores_empty_values_and_sanitizes_group(monkeypatch):
    """空值不计入统计；组名含控制字符时清洗后再打印（字段路径来自前端提交）。"""
    calls: list = []
    monkeypatch.setattr(ai_proxy.logger, "warning", lambda *a, **k: calls.append(a))

    # 整组空串没有「是否译出」的语义 → 不算漏译证据
    empty = {
        "education.a.description": "",
        "education.b.description": "",
    }
    ai_proxy._warn_if_group_unchanged(empty, dict(empty))
    assert calls == []

    # 组名含换行：清洗后才能落盘，否则可伪造日志行（日志注入）
    injected = {
        "edu\ncation.a.school": "Fudan University",
        "edu\ncation.b.school": "Anhui Normal University",
    }
    ai_proxy._warn_if_group_unchanged(injected, dict(injected))
    assert len(calls) == 1
    assert calls[0][1] == "education"
    assert "\n" not in calls[0][1]


@pytest.mark.asyncio
async def test_translate_fields_warns_when_llm_copies_originals(monkeypatch):
    """端到端：LLM 整组照抄原文时 translate_fields 必须留下 warning 线索。

    这是本次缺陷的自动发现手段——修复前该场景完全静默（译文等于原文被当作
    合法译文返回，前端照常写入，用户只能肉眼发现）。
    """
    fields = {
        "education.a.school": "Fudan University",
        "education.b.school": "Anhui Normal University",
    }
    captured: dict = {}
    _capture_llm(
        monkeypatch, captured, content_json=json.dumps(fields, ensure_ascii=False)
    )
    calls: list = []
    monkeypatch.setattr(ai_proxy.logger, "warning", lambda *a, **k: calls.append(a))

    result = await ai_proxy.translate_fields(fields, "zh")

    assert result == fields
    assert any(call[1] == "education" for call in calls)


# ---------- 路由层：POST /api/ai/translate ----------


async def _ensure_code(session, code, grant_credits=50):
    res = await session.execute(
        select(RegistrationCode).where(RegistrationCode.code == code)
    )
    if res.scalars().first() is None:
        from datetime import timedelta

        session.add(
            RegistrationCode(
                code=code,
                grant_credits=grant_credits,
                expires_at=utcnow() + timedelta(days=1),
            )
        )
        await session.commit()


async def _login(client, session, username, code, password="Pass#1234"):
    await _ensure_code(session, code)
    r = await client.post(
        "/api/auth/register",
        json={"username": username, "password": password, "code": code},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.mark.asyncio
async def test_translate_route_requires_auth(client):
    r = await client.post(
        "/api/ai/translate",
        json={"targetLang": "en", "fields": {"title": "我的简历"}},
    )
    assert r.status_code in (401, 403)


@pytest.mark.asyncio
async def test_translate_route_rejects_empty_fields(client, session):
    token = await _login(client, session, "tr-empty", "TE1")
    r = await client.post(
        "/api/ai/translate",
        json={"targetLang": "en", "fields": {}},
        headers=auth_headers(token),
    )
    assert r.status_code == 200
    assert r.json()["error"]["code"] == "BadRequest"


@pytest.mark.asyncio
async def test_translate_route_rejects_unsupported_language(client, session):
    token = await _login(client, session, "tr-lang", "TL1")
    r = await client.post(
        "/api/ai/translate",
        json={"targetLang": "fr", "fields": {"title": "我的简历"}},
        headers=auth_headers(token),
    )
    assert r.status_code == 200
    assert r.json()["error"]["code"] == "BadRequest"


@pytest.mark.asyncio
async def test_translate_route_success_returns_same_key_map(client, session, monkeypatch):
    token = await _login(client, session, "tr-ok", "TO1")

    async def _fake_translate_fields(fields, target_lang):
        return {k: f"[{target_lang}]{k}" for k in fields}

    monkeypatch.setattr(
        "app.api.ai.ai_proxy.translate_fields", _fake_translate_fields
    )
    r = await client.post(
        "/api/ai/translate",
        json={"targetLang": "en", "fields": {"title": "我的简历", "skillContent": "- React"}},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body["fields"].keys()) == {"title", "skillContent"}
    assert body["fields"]["title"] == "[en]title"


@pytest.mark.asyncio
async def test_translate_route_config_error_path(client, session, monkeypatch):
    """LLM 未配置 → ConfigError 结构（与 grammar 路由一致），不 500。"""
    token = await _login(client, session, "tr-cfg", "TC1")

    async def _fake_raise(fields, target_lang):
        raise RuntimeError("LLM 未配置：请在后端 .env 设置 LLM_API_KEY 等参数")

    monkeypatch.setattr("app.api.ai.ai_proxy.translate_fields", _fake_raise)
    r = await client.post(
        "/api/ai/translate",
        json={"targetLang": "en", "fields": {"title": "我的简历"}},
        headers=auth_headers(token),
    )
    assert r.status_code == 200
    assert r.json()["error"]["code"] == "ConfigError"
