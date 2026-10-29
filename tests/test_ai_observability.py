"""AI 观测台账契约测试（P1 数据层）。

锁定三件事，防止「页面看得到、数字却是错的」：

1. `summarize_translation` 的三类分桶（译出 / 未变化 / 缺失）互不重叠且相加等于总数；
2. `serialize_detail` 超 8KB 时逐级降级，但**任何一级都仍是合法 JSON**（页面直接 loads）；
3. `/api/ai/translate` 真的把统计与 prompt 版本写进了台账（接线没断）。

背景：docs/PLAN_ai_observability.md。此前翻译只有一行汇总 + 滚动日志，
「哪个字段没译、当时用的是哪版指令」无从查证。
"""

import json

import pytest
from sqlalchemy import select, update

from conftest import auth_headers
from app.models.llm_usage import LlmUsage
from app.models.user import ROLE_ADMIN, User
from app.services import ai_proxy
from app.services.usage import serialize_detail


# ---------- 统计摘要 ----------


def test_summarize_translation_splits_three_buckets():
    """译出 / 未变化 / 缺失 三类相加等于字段总数（页面各占比的分母）。"""
    fields = {
        "education.a.school": "Fudan University",
        "education.b.school": "Anhui Normal University",
        "projects.a.name": "Intelligent Resume Matching Platform",
        "title": "My Resume",
    }
    translated = {
        # 学校名原样返回（历史上正是这类被「专名保留」整类吞掉）
        "education.a.school": "Fudan University",
        "education.b.school": "Anhui Normal University",
        "projects.a.name": "智能简历匹配平台",
        # title 直接缺失，模拟 LLM 漏返回
    }

    summary = ai_proxy.summarize_translation(fields, translated)

    assert summary["fieldsTotal"] == 4
    assert summary["fieldsTranslated"] == 1
    assert summary["fieldsUnchanged"] == 2
    assert summary["fieldsMissing"] == 1
    assert (
        summary["fieldsTranslated"] + summary["fieldsUnchanged"] + summary["fieldsMissing"]
        == summary["fieldsTotal"]
    )
    assert summary["unchangedGroups"] == {"education": 2}
    assert summary["unchangedKeys"] == [
        "education.a.school",
        "education.b.school",
    ]
    assert "targetLang" not in summary


def test_summarize_translation_ignores_empty_values():
    """空文本没有「是否译出」的语义，不得计入未变化（否则占比被污染）。"""
    fields = {"education.a.description": "", "title": "我的简历"}
    translated = {"education.a.description": "", "title": "My Resume"}

    summary = ai_proxy.summarize_translation(fields, translated, "en")

    assert summary["fieldsUnchanged"] == 0
    assert summary["unchangedGroups"] == {}
    # 空字段仍算在分母里（它是本次请求的一部分），只是不算「未变化」
    assert summary["fieldsTotal"] == 2
    assert summary["fieldsTranslated"] == 1
    assert summary["targetLang"] == "en"


def test_summarize_translation_truncates_unchanged_keys():
    """未变化 key 列表截断到 20 项，其余只留计数（防长简历撑爆 detail）。"""
    fields = {f"education.e{i}.school": f"School {i}" for i in range(25)}
    summary = ai_proxy.summarize_translation(fields, dict(fields))

    assert summary["fieldsUnchanged"] == 25
    assert len(summary["unchangedKeys"]) == 20
    assert summary["unchangedKeysTruncated"] == 5
    assert summary["unchangedGroups"] == {"education": 25}


# ---------- detail 序列化 ----------


def test_serialize_detail_returns_empty_for_none():
    assert serialize_detail(None) == ""
    assert serialize_detail({}) == ""


def test_serialize_detail_keeps_compact_json():
    text = serialize_detail({"fieldsTotal": 2, "fieldsUnchanged": 0})
    assert json.loads(text) == {"fieldsTotal": 2, "fieldsUnchanged": 0}


def test_serialize_detail_degrades_but_stays_valid_json():
    """超 8KB 时先丢明细列表保计数，再兜底骨架——任何一级都必须可 loads。"""
    huge = {
        "fieldsTotal": 1000,
        "fieldsUnchanged": 1000,
        "unchangedGroups": {"education": 1000},
        "unchangedKeys": [f"education.e{i}.school" for i in range(500)],
    }
    text = serialize_detail(huge)
    parsed = json.loads(text)  # 关键断言：不抛异常

    assert parsed["truncated"] is True
    # 计数优先保留：页面最需要「几项未变化」，明细可丢
    assert parsed["fieldsUnchanged"] == 1000
    assert "unchangedKeys" not in parsed


def test_serialize_detail_falls_back_to_skeleton_when_still_too_large():
    """分组表本身超限时退到骨架，仍能区分「有记录但明细不可用」与「无记录」。"""
    huge = {
        "unchangedGroups": {f"group{i}": i for i in range(3000)},
        "fieldsUnchanged": 3000,
    }
    parsed = json.loads(serialize_detail(huge))
    assert parsed == {"truncated": True}


# ---------- 路由接线 ----------


async def _ensure_code(session, code, grant_credits=50):
    from datetime import timedelta

    from sqlalchemy import select

    from app.core.timeutils import utcnow
    from app.models.registration_code import RegistrationCode

    res = await session.execute(
        select(RegistrationCode).where(RegistrationCode.code == code)
    )
    if res.scalars().first() is None:
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
async def test_translate_route_records_detail_and_prompt_version(
    client, session, monkeypatch
):
    """接线契约：路由必须把 summarize 结果与 prompt 版本交给台账，而不是只记 token。"""
    token = await _login(client, session, "obs-1", "OB1")

    async def _fake_translate(fields, target_lang):
        # school 原样返回（模拟漏译），name 译出
        return {
            key: (value if "school" in key else f"[{target_lang}]{value}")
            for key, value in fields.items()
        }

    captured: dict = {}

    async def _fake_record_llm_usage(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr("app.api.ai.ai_proxy.translate_fields", _fake_translate)
    monkeypatch.setattr("app.services.usage.record_llm_usage", _fake_record_llm_usage)

    r = await client.post(
        "/api/ai/translate",
        json={
            "targetLang": "en",
            "fields": {
                "education.a.school": "复旦大学",
                "projects.a.name": "简历平台",
            },
        },
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["fields"]["projects.a.name"] == "[en]简历平台"

    detail = json.loads(captured["detail"])
    assert detail["fieldsTotal"] == 2
    assert detail["fieldsUnchanged"] == 1
    assert detail["unchangedGroups"] == {"education": 1}
    assert detail["targetLang"] == "en"
    assert captured["prompt_version"] == ai_proxy.TRANSLATE_PROMPT_VERSION
    assert captured["endpoint"] == "ai.translate"


@pytest.mark.asyncio
async def test_translate_route_omits_detail_when_llm_fails(
    client, session, monkeypatch
):
    """失败时不应写入伪造统计：detail 为空，但 status/error_type 仍留痕。"""
    token = await _login(client, session, "obs-2", "OB2")

    async def _boom(fields, target_lang):
        raise RuntimeError("AI 未返回可解析的 JSON")

    captured: dict = {}

    async def _fake_record_llm_usage(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr("app.api.ai.ai_proxy.translate_fields", _boom)
    monkeypatch.setattr("app.services.usage.record_llm_usage", _fake_record_llm_usage)

    r = await client.post(
        "/api/ai/translate",
        json={"targetLang": "en", "fields": {"title": "我的简历"}},
        headers=auth_headers(token),
    )
    assert r.status_code == 200
    assert r.json()["error"]["code"] == "ConfigError"

    assert captured["detail"] == ""
    assert captured["status"] == "error"
    assert captured["error_type"] == "RuntimeError"


# ---------- P2：观测查询接口 ----------


async def _uid(session, username: str) -> str:
    row = (
        await session.execute(select(User).where(User.username == username))
    ).scalars().first()
    assert row is not None
    return row.id


async def _add_call(
    session,
    *,
    user_id: str,
    endpoint: str = "ai.translate",
    status: str = "success",
    latency_ms: int = 120,
    total_tokens: int = 50,
    prompt_version: str = "16ef11b9",
    detail: dict | None = None,
) -> str:
    row = LlmUsage(
        user_id=user_id,
        endpoint=endpoint,
        status=status,
        latency_ms=latency_ms,
        total_tokens=total_tokens,
        prompt_version=prompt_version,
        detail=json.dumps(detail, ensure_ascii=False) if detail else "",
    )
    session.add(row)
    await session.commit()
    return row.id


TRANSLATE_DETAIL = {
    "targetLang": "en",
    "fieldsTotal": 4,
    "fieldsTranslated": 3,
    "fieldsUnchanged": 1,
    "fieldsMissing": 0,
    "unchangedGroups": {"education": 1},
    "unchangedKeys": ["education.a.school"],
    "unchangedKeysTruncated": 0,
}


@pytest.mark.asyncio
async def test_translate_observability_requires_auth(client):
    r = await client.get("/api/ai/translate/observability")
    assert r.status_code in (401, 403)


@pytest.mark.asyncio
async def test_translate_observability_empty_is_zeroed(client, session):
    """空库必须返回结构完整的零值，不能 500（页面首次打开就是这种状态）。"""
    token = await _login(client, session, "obs-empty", "OBE")
    r = await client.get(
        "/api/ai/translate/observability", headers=auth_headers(token)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["overview"]["total"] == 0
    assert body["overview"]["success_rate"] == 0
    assert body["overview"]["unchanged_rate"] == 0
    assert body["unchanged_groups"] == []
    assert body["recent_calls"] == []
    assert len(body["daily"]) == 30


@pytest.mark.asyncio
async def test_translate_observability_aggregates_detail(client, session):
    """字段统计与未变化分组必须从 detail 汇总出来（页面「哪类字段没译」的数据源）。"""
    token = await _login(client, session, "obs-agg", "OBA")
    uid = await _uid(session, "obs-agg")

    await _add_call(session, user_id=uid, detail=TRANSLATE_DETAIL)
    await _add_call(
        session,
        user_id=uid,
        detail={
            "targetLang": "zh",
            "fieldsTotal": 2,
            "fieldsTranslated": 2,
            "fieldsUnchanged": 0,
            "fieldsMissing": 0,
            "unchangedGroups": {},
            "unchangedKeys": [],
        },
    )
    await _add_call(session, user_id=uid, status="error", total_tokens=0)

    r = await client.get(
        "/api/ai/translate/observability", headers=auth_headers(token)
    )
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["overview"]["total"] == 3
    assert body["overview"]["success"] == 2
    assert body["overview"]["error"] == 1
    assert body["overview"]["fields_total"] == 6
    assert body["overview"]["fields_translated"] == 5
    assert body["overview"]["fields_unchanged"] == 1
    assert body["overview"]["fields_missing"] == 0
    # 分母是「已返回字段数」(5+1)，不是 fieldsTotal(6)：缺失字段不算策略性保留
    assert body["overview"]["unchanged_rate"] == round(1 / 6, 4)
    assert body["unchanged_groups"] == [{"group": "education", "count": 1}]
    assert len(body["recent_calls"]) == 3


@pytest.mark.asyncio
async def test_translate_observability_tolerates_bad_detail(client, session):
    """detail 是脏数据（非 JSON）时降级为空摘要，不能让整页崩。"""
    token = await _login(client, session, "obs-bad", "OBB")
    uid = await _uid(session, "obs-bad")

    session.add(
        LlmUsage(
            user_id=uid,
            endpoint="ai.translate",
            status="success",
            detail="这不是 JSON",
            prompt_version="deadbeef",
        )
    )
    await session.commit()

    r = await client.get(
        "/api/ai/translate/observability", headers=auth_headers(token)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["overview"]["total"] == 1
    assert body["overview"]["fields_total"] == 0
    assert body["recent_calls"][0]["detail_available"] is False
    assert body["recent_calls"][0]["summary"] is None


@pytest.mark.asyncio
async def test_translate_call_detail_is_scoped_to_owner(client, session):
    """查他人记录一律 404：既不返回数据，也不泄露「这条记录存在」。"""
    await _login(client, session, "obs-owner", "OBO")
    owner_id = await _uid(session, "obs-owner")
    call_id = await _add_call(session, user_id=owner_id, detail=TRANSLATE_DETAIL)

    other_token = await _login(client, session, "obs-other", "OBT")
    r = await client.get(
        f"/api/ai/translate/observability/calls/{call_id}",
        headers=auth_headers(other_token),
    )
    assert r.status_code == 404

    owner_token = await _login(client, session, "obs-owner2", "OBO2")
    # 用新用户自己的记录验证正常路径（避免复用旧 token 的 tokenVersion 干扰）
    own_id = await _uid(session, "obs-owner2")
    own_call = await _add_call(session, user_id=own_id, detail=TRANSLATE_DETAIL)
    r2 = await client.get(
        f"/api/ai/translate/observability/calls/{own_call}",
        headers=auth_headers(owner_token),
    )
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert body["detail"]["fieldsUnchanged"] == 1
    assert body["unchanged_keys"] == ["education.a.school"]
    assert body["call"]["prompt_version"] == "16ef11b9"


@pytest.mark.asyncio
async def test_admin_ai_observability_requires_admin(client, session):
    token = await _login(client, session, "obs-plain", "OBP")
    r = await client.get("/api/admin/ai/observability", headers=auth_headers(token))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_admin_ai_observability_validates_params(client, session):
    token = await _login(client, session, "obs-admin1", "OBX")
    uid = await _uid(session, "obs-admin1")
    await session.execute(
        update(User).where(User.id == uid).values(role=ROLE_ADMIN)
    )
    await session.commit()

    bad_days = await client.get(
        "/api/admin/ai/observability?days=5", headers=auth_headers(token)
    )
    assert bad_days.status_code == 422

    bad_endpoint = await client.get(
        "/api/admin/ai/observability?endpoint=nope", headers=auth_headers(token)
    )
    assert bad_endpoint.status_code == 422


@pytest.mark.asyncio
async def test_admin_ai_observability_spans_users(client, session):
    """管理员视角跨用户：两个用户的调用都要计入，且 endpoint 筛选生效。"""
    ua = await _login(client, session, "obs-a", "OBSA")
    uid_a = await _uid(session, "obs-a")
    await _add_call(session, user_id=uid_a, detail=TRANSLATE_DETAIL)
    await _add_call(session, user_id=uid_a, endpoint="ai.grammar", detail=None)

    ub = await _login(client, session, "obs-b", "OBSB")
    uid_b = await _uid(session, "obs-b")
    await _add_call(session, user_id=uid_b, status="error", detail=None)

    admin_token = await _login(client, session, "obs-admin2", "OBY")
    admin_id = await _uid(session, "obs-admin2")
    await session.execute(
        update(User).where(User.id == admin_id).values(role=ROLE_ADMIN)
    )
    await session.commit()

    r = await client.get(
        "/api/admin/ai/observability", headers=auth_headers(admin_token)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["overview"]["total"] == 3
    assert body["overview"]["error"] == 1
    endpoints = {item["endpoint"]: item for item in body["endpoints"]}
    assert endpoints["ai.translate"]["calls"] == 2
    assert endpoints["ai.grammar"]["calls"] == 1
    assert body["failures"][0]["status"] == "error"

    filtered = await client.get(
        "/api/admin/ai/observability?endpoint=ai.grammar",
        headers=auth_headers(admin_token),
    )
    assert filtered.status_code == 200
    assert filtered.json()["overview"]["total"] == 1

