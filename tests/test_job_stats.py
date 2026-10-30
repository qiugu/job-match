"""投递统计（Job Status Events + /api/jobs/stats）测试。

覆盖三类风险：
1. **记账完整性**——状态每次变更都必须留下事件，且重复操作不得重复记账
   （投递日一旦被重复点击改写，统计即失真）。
2. **时区口径**——事件按用户本地日历日分桶；UTC 23:30 的事件必须落到次日，
   这是最容易写错、且错了不会报错只会静默出错的一处。
3. **口径一致性**——漏斗为累计到达（单调不增）、越权隔离、删卡后计数同步下降。

不使用真实 LLM：monkeypatch `app.api.cover_letter.run_cover_letter` /
`app.api.match.run_match` 注入确定性结果（与 test_jobs.py 一致）。
"""
from __future__ import annotations

from datetime import datetime, time, timedelta, timezone

import pytest
from conftest import auth_headers
from sqlalchemy import select

import app.core.database as database_module
from app.models.cover_letter import CoverLetter
from app.models.derived_resume import DerivedResume
from app.models.job import Job
from app.models.job_event import (
    EVENT_SOURCE_AUTO,
    EVENT_SOURCE_BACKFILL,
    EVENT_SOURCE_CREATE,
    EVENT_SOURCE_MANUAL,
    EVENT_SOURCE_REOPEN,
    JobStatusEvent,
)
from app.models.registration_code import RegistrationCode
from app.services.job_stats import (
    ALLOWED_DAYS,
    clamp_days,
    clamp_tz_offset,
)
from app.services.job import get_jobs_aggregates


# ---------------- 辅助 ----------------
async def _ensure_code(code, grant_credits=50):
    """确保注册码存在（用独立会话提交，避免测试 fixture 会话的快照隔离问题）。"""
    from app.core.timeutils import utcnow

    async with database_module.AsyncSessionLocal() as s:
        res = await s.execute(
            select(RegistrationCode).where(RegistrationCode.code == code)
        )
        if res.scalars().first() is None:
            s.add(
                RegistrationCode(
                    code=code,
                    grant_credits=grant_credits,
                    expires_at=utcnow() + timedelta(days=1),
                )
            )
            await s.commit()


async def _login(client, username, code, password="Pass#1234") -> str:
    await _ensure_code(code)
    r = await client.post(
        "/api/auth/register",
        json={"username": username, "password": password, "code": code},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def _fake_run_cover_letter(jd_text, resume_text, scene):
    return "尊敬的招聘经理：\n\n我对贵司岗位非常感兴趣。\n"


async def _fake_run_match(master_text, jd_text):
    md = "# 项目经历\n- 主导系统重构\n"
    analysis = {"score": 0.6, "role": "后端工程师", "summary": "匹配良好"}
    return (["Python"], md, analysis)


async def _create_letter(client, h, jd, resume_text="# r"):
    return await client.post(
        "/api/cover-letters",
        json={"resume_text": resume_text, "jd_text": jd, "scene": "greeting"},
        headers=h,
    )


async def _create_match(client, h, jd, resume_text="# r"):
    return await client.post(
        "/api/derived-resumes",
        json={"resumeText": resume_text, "jdText": jd, "title": "m"},
        headers=h,
    )


async def _events_for(job_id: str) -> list[JobStatusEvent]:
    """按发生时间升序取某卡的事件（用独立会话，确保读到已提交数据）。"""
    async with database_module.AsyncSessionLocal() as s:
        rows = (
            await s.execute(
                select(JobStatusEvent)
                .where(JobStatusEvent.job_id == job_id)
                .order_by(JobStatusEvent.occurred_at)
            )
        ).scalars().all()
        for r in rows:  # 脱离会话前取出需要的字段，避免 DetachedInstanceError
            _ = (r.from_status, r.to_status, r.source, r.occurred_at)
        return list(rows)


async def _current_user_id(username: str) -> str:
    from app.models.user import User

    async with database_module.AsyncSessionLocal() as s:
        u = (
            await s.execute(select(User).where(User.username == username))
        ).scalars().one()
        return u.id


async def _add_event(
    job_id: str,
    user_id: str,
    from_status: str | None,
    to_status: str,
    occurred_at: datetime,
    source: str = EVENT_SOURCE_AUTO,
) -> None:
    """直接落一条事件（用于构造精确时间场景，绕开真实操作链路）。"""
    import uuid

    async with database_module.AsyncSessionLocal() as s:
        s.add(
            JobStatusEvent(
                id=uuid.uuid4().hex,
                user_id=user_id,
                job_id=job_id,
                from_status=from_status,
                to_status=to_status,
                source=source,
                occurred_at=occurred_at,
            )
        )
        await s.commit()


async def _add_job(job_id: str, user_id: str, status="greeting_sent") -> None:
    async with database_module.AsyncSessionLocal() as s:
        s.add(
            Job(
                id=job_id,
                user_id=user_id,
                jd_text=f"jd-{job_id}",
                title=f"岗位{job_id}",
                status=status,
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            )
        )
        await s.commit()


def _local_today(tz_offset: int):
    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    return (now_utc + timedelta(minutes=tz_offset)).date()


@pytest.mark.asyncio
async def test_get_jobs_aggregates_batches_child_counts(session):
    """岗位列表聚合应一次处理多个岗位，且保持单卡聚合字段口径。"""
    from datetime import datetime, timezone

    first_activity = datetime(2026, 10, 1, tzinfo=timezone.utc)
    second_activity = datetime(2026, 10, 2, tzinfo=timezone.utc)
    session.add_all(
        [
            Job(
                id="aggregate-job-1",
                user_id="aggregate-user",
                jd_text="jd-1",
                title="岗位 1",
                updated_at=first_activity,
            ),
            Job(
                id="aggregate-job-2",
                user_id="aggregate-user",
                jd_text="jd-2",
                title="岗位 2",
                updated_at=second_activity,
            ),
            CoverLetter(
                id="aggregate-letter-1",
                user_id="aggregate-user",
                job_id="aggregate-job-1",
                content="hello",
                created_at=first_activity,
            ),
            DerivedResume(
                id="aggregate-resume-1",
                user_id="aggregate-user",
                job_id="aggregate-job-1",
                markdown_content="# resume",
                created_at=second_activity,
                accepted=True,
            ),
        ]
    )
    await session.commit()

    aggregates = await get_jobs_aggregates(
        session, ["aggregate-job-1", "aggregate-job-2"]
    )

    assert aggregates["aggregate-job-1"] == {
        "cover_letter_count": 1,
        "derived_count": 1,
        "last_activity_at": second_activity.replace(tzinfo=None).isoformat(),
        "latest_acceptance": True,
    }
    assert aggregates["aggregate-job-2"] == {
        "cover_letter_count": 0,
        "derived_count": 0,
        "last_activity_at": None,
        "latest_acceptance": False,
    }


@pytest.mark.asyncio
async def test_get_jobs_aggregates_empty_ids_is_empty(session):
    assert await get_jobs_aggregates(session, []) == {}


# ---------------- 参数收敛（纯函数） ----------------
def test_clamp_days_whitelist_and_nearest():
    """非白名单值就近收敛；等距取较大者；非法值回落到最小合法值。"""
    for d in ALLOWED_DAYS:
        assert clamp_days(d) == d
    assert clamp_days(60) == 90  # 距 30 与 90 等距 → 取较大者
    assert clamp_days(8) == 7
    # 上限 180 = 归档保留期（JOB_RETENTION_DAYS）：更早事件已清理，不提供更长区间
    assert clamp_days(1000) == 180
    assert clamp_days(3650) == 180
    assert clamp_days(0) == 7
    assert clamp_days(-5) == 7


def test_clamp_tz_offset_range():
    """时区偏移收敛到 [-720, 840]（UTC-12 ~ UTC+14）。"""
    assert clamp_tz_offset(480) == 480
    assert clamp_tz_offset(2000) == 840
    assert clamp_tz_offset(-2000) == -720


# ---------------- 记账完整性 ----------------
@pytest.mark.asyncio
async def test_full_lifecycle_records_events(client, monkeypatch):
    """建卡 → 话术 → 定制简历 → 确认投递：每步各留一条事件，来源正确。"""
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)

    token = await _login(client, "statu1", "ST1")
    h = auth_headers(token)

    jd = "Python 后端工程师"
    r = await _create_letter(client, h, jd)
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]

    m = await _create_match(client, h, jd)
    assert m.status_code == 200, m.text
    assert m.json()["jobId"] == job_id  # 同 JD 复用同一张卡

    mk = await client.post(
        f"/api/jobs/{job_id}/mark", json={"outcome": "applied"}, headers=h
    )
    assert mk.status_code == 200, mk.text
    assert mk.json()["status"] == "applied"

    events = await _events_for(job_id)
    chain = [(e.from_status, e.to_status, e.source) for e in events]
    assert chain == [
        # 建卡：首动作是生成话术 → 初始态 greeting_sent，无前驱
        (None, "greeting_sent", EVENT_SOURCE_CREATE),
        # 生成话术时卡已存在且已是 greeting_sent → 无状态变化，故不产生事件
        # 生成定制简历 → 自动推进
        ("greeting_sent", "resume_ready", EVENT_SOURCE_AUTO),
        # 用户手动确认投递
        ("resume_ready", "applied", EVENT_SOURCE_MANUAL),
    ], chain


@pytest.mark.asyncio
async def test_match_first_card_records_create_at_resume_ready(client, monkeypatch):
    """首动作即匹配：建卡事件直接落在 resume_ready（不存在多余的前置事件）。"""
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)

    token = await _login(client, "statu2", "ST2")
    h = auth_headers(token)
    r = await _create_match(client, h, "数据分析师 SQL")
    job_id = r.json()["jobId"]

    events = await _events_for(job_id)
    assert [(e.from_status, e.to_status, e.source) for e in events] == [
        (None, "resume_ready", EVENT_SOURCE_CREATE)
    ]


@pytest.mark.asyncio
async def test_idempotent_mark_does_not_duplicate_event(client, monkeypatch):
    """重复点击「确认投递」不得重复记账——否则投递日会被改到最近一次点击那天。"""
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)

    token = await _login(client, "statu3", "ST3")
    h = auth_headers(token)
    jd = "产品经理 需求分析"
    job_id = (await _create_letter(client, h, jd)).json()["job_id"]
    await _create_match(client, h, jd)

    for _ in range(3):
        r = await client.post(
            f"/api/jobs/{job_id}/mark", json={"outcome": "applied"}, headers=h
        )
        assert r.status_code == 200, r.text

    applied_events = [
        e for e in await _events_for(job_id) if e.to_status == "applied"
    ]
    assert len(applied_events) == 1

    # 幂等调用也不应刷新 updated_at（避免无操作把卡片顶到列表最前）
    async with database_module.AsyncSessionLocal() as s:
        job = await s.get(Job, job_id)
        assert job.updated_at == applied_events[0].occurred_at


@pytest.mark.asyncio
async def test_reopen_records_reopen_source(client, monkeypatch):
    """归档后重新开启：事件来源标记为 reopen，便于与自动推进区分。"""
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    token = await _login(client, "statu4", "ST4")
    h = auth_headers(token)
    job_id = (await _create_letter(client, h, "测试工程师")).json()["job_id"]

    await client.post(
        f"/api/jobs/{job_id}/mark", json={"outcome": "closed"}, headers=h
    )
    r = await client.post(f"/api/jobs/{job_id}/reopen", headers=h)
    assert r.status_code == 200, r.text

    last = (await _events_for(job_id))[-1]
    assert (last.from_status, last.to_status, last.source) == (
        "closed",
        "greeting_sent",
        EVENT_SOURCE_REOPEN,
    )

    # 非 closed 卡 reopen 为幂等空操作：不产生事件
    before = len(await _events_for(job_id))
    await client.post(f"/api/jobs/{job_id}/reopen", headers=h)
    assert len(await _events_for(job_id)) == before


@pytest.mark.asyncio
async def test_metadata_patch_does_not_create_event(client, monkeypatch):
    """改标题/公司属元数据编辑，不是状态变更，不得产生事件。"""
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    token = await _login(client, "statu5", "ST5")
    h = auth_headers(token)
    job_id = (await _create_letter(client, h, "运营专员")).json()["job_id"]

    r = await client.patch(
        f"/api/jobs/{job_id}",
        json={"title": "改写后的岗位名", "company": "某某公司"},
        headers=h,
    )
    assert r.status_code == 200, r.text

    events = await _events_for(job_id)
    assert len(events) == 1
    assert events[0].source == EVENT_SOURCE_CREATE


# ---------------- 路由顺序（防 /{job_id} 吞路由） ----------------
@pytest.mark.asyncio
async def test_stats_route_not_shadowed_by_job_id(client, monkeypatch):
    """/api/jobs/stats 必须命中统计端点，而不是被 /{job_id} 当成不存在的岗位 404。"""
    token = await _login(client, "statr1", "SR1")
    h = auth_headers(token)

    r = await client.get("/api/jobs/stats", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    for key in (
        "range",
        "totals",
        "status_distribution",
        "funnel",
        "daily",
        "weekday",
        "streak",
    ):
        assert key in body, f"缺少字段 {key}"
    # 若被 /{job_id} 吞掉，detail 会是「岗位不存在」
    assert "detail" not in body


@pytest.mark.asyncio
async def test_stats_requires_auth(client):
    """未登录不得读取统计。"""
    r = await client.get("/api/jobs/stats")
    assert r.status_code == 401


# ---------------- 时区口径 ----------------
@pytest.mark.asyncio
async def test_daily_bucketing_uses_local_calendar_day(client):
    """UTC 23:30 的事件在 UTC+8 下必须落到次日（本地日）。

    这是本次统计最易出错处：直接用 UTC 日期分桶会让「深夜投递」错记到前一天。
    """
    tz = 480
    token = await _login(client, "statz1", "SZ1")
    h = auth_headers(token)
    user_id = await _current_user_id("statz1")

    today_local = _local_today(tz)
    # 构造「本地 07:30」的投递：其 UTC 时刻是前一天的 23:30 → 跨日
    utc_instant = datetime.combine(
        today_local - timedelta(days=1), time(23, 30)
    )
    await _add_job("jz1", user_id, status="applied")
    await _add_event(
        "jz1", user_id, None, "greeting_sent", utc_instant - timedelta(hours=1),
        EVENT_SOURCE_CREATE,
    )
    await _add_event("jz1", user_id, "greeting_sent", "applied", utc_instant)

    # UTC+8：归入今天
    r = await client.get(f"/api/jobs/stats?days=7&tz_offset={tz}", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    today_key = today_local.isoformat()
    assert body["range"]["end"] == today_key
    point = {d["date"]: d for d in body["daily"]}[today_key]
    assert point["applied"] == 1
    assert point["created"] == 1

    # UTC+0：同一 UTC 时刻应落在 UTC 日历的昨天，而不是今天
    r0 = await client.get("/api/jobs/stats?days=7&tz_offset=0", headers=h)
    body0 = r0.json()
    utc_date = utc_instant.date().isoformat()
    by_date0 = {d["date"]: d for d in body0["daily"]}
    assert by_date0[utc_date]["applied"] == 1
    # 用 .get 而非下标：本地时间已过午夜时「本地今天」会晚于 UTC 今天，
    # 该日不在 tz=0 的区间内，直接下标会 KeyError 造成偶发失败。
    assert by_date0.get(today_key, {}).get("applied", 0) == 0


@pytest.mark.asyncio
async def test_daily_is_zero_filled_and_contiguous(client):
    """区间内每一天都要出现（缺日补零），否则图表会出现断点。"""
    token = await _login(client, "statz2", "SZ2")
    h = auth_headers(token)

    r = await client.get("/api/jobs/stats?days=14", headers=h)
    daily = r.json()["daily"]
    assert len(daily) == 14
    dates = [d["date"] for d in daily]
    assert dates == sorted(dates)
    assert all(d["applied"] == 0 for d in daily)


@pytest.mark.asyncio
async def test_days_clamped_via_api(client):
    """越界 days 由服务层收敛（API 层不重复实现，单一口径）。"""
    token = await _login(client, "statz3", "SZ3")
    h = auth_headers(token)

    assert (await client.get("/api/jobs/stats?days=1000", headers=h)).json()["range"]["days"] == 180
    assert (await client.get("/api/jobs/stats?days=60", headers=h)).json()["range"]["days"] == 90
    assert (await client.get("/api/jobs/stats?days=0", headers=h)).json()["range"]["days"] == 7
    assert (await client.get("/api/jobs/stats?days=30&tz_offset=9999", headers=h)).json()[
        "range"
    ]["tz_offset"] == 840


# ---------------- 口径与指标 ----------------
@pytest.mark.asyncio
async def test_funnel_is_cumulative_and_monotonic(client, monkeypatch):
    """漏斗为累计到达：归档卡的历史进度不得丢失，且各级单调不增。

    场景：一张卡投递后归档。它当前状态是 closed，但「曾投递」必被计入。
    """
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)

    token = await _login(client, "statf1", "SF1")
    h = auth_headers(token)

    jd_applied = "岗位A 已投递后归档"
    job_a = (await _create_letter(client, h, jd_applied)).json()["job_id"]
    await _create_match(client, h, jd_applied)
    await client.post(f"/api/jobs/{job_a}/mark", json={"outcome": "applied"}, headers=h)
    await client.post(f"/api/jobs/{job_a}/mark", json={"outcome": "closed"}, headers=h)

    jd_pending = "岗位B 仅打招呼"
    await _create_letter(client, h, jd_pending)

    body = (await client.get("/api/jobs/stats?days=30", headers=h)).json()
    funnel = {f["key"]: f for f in body["funnel"]}

    assert funnel["created"]["count"] == 2
    assert funnel["resume_ready"]["count"] == 1  # 只有 A 生成过定制简历
    assert funnel["applied"]["count"] == 1  # A 虽已归档，历史投递仍计入
    counts = [funnel["created"]["count"], funnel["resume_ready"]["count"], funnel["applied"]["count"]]
    assert counts == sorted(counts, reverse=True), f"漏斗必须单调不增: {counts}"

    totals = body["totals"]
    assert totals["jobs"] == 2
    assert totals["active_now"] == 1  # B 仍在进行中；A 已归档
    assert totals["applied_now"] == 0  # A 已归档、B 未投递
    assert totals["closed_now"] == 1
    assert totals["applied_ever"] == 1  # 与漏斗同口径
    assert totals["applied_rate"] == 0.5
    assert body["status_distribution"] == {
        "greeting_sent": 1,
        "resume_ready": 0,
        "applied": 0,
        "closed": 1,
    }


@pytest.mark.asyncio
async def test_funnel_and_status_distribution_follow_selected_cohort(client):
    """漏斗与存量分布按所选区间内新建的岗位 cohort 变化，而非固定读全量岗位。"""
    token = await _login(client, "statc1", "SC1")
    h = auth_headers(token)
    user_id = await _current_user_id("statc1")
    today_local = _local_today(480)

    for job_id, delta in (("jc-old", 20), ("jc-new", 0)):
        created_at = datetime.combine(today_local - timedelta(days=delta), time(9, 0))
        await _add_job(job_id, user_id, status="applied")
        await _add_event(job_id, user_id, None, "greeting_sent", created_at, EVENT_SOURCE_CREATE)
        await _add_event(job_id, user_id, "greeting_sent", "resume_ready", created_at + timedelta(hours=1))
        await _add_event(job_id, user_id, "resume_ready", "applied", created_at + timedelta(hours=2))

    short = (await client.get("/api/jobs/stats?days=7&tz_offset=480", headers=h)).json()
    long = (await client.get("/api/jobs/stats?days=30&tz_offset=480", headers=h)).json()

    assert short["funnel"][0]["count"] == 1
    assert short["funnel"][-1]["count"] == 1
    assert short["status_distribution"]["applied"] == 1
    assert long["funnel"][0]["count"] == 2
    assert long["funnel"][-1]["count"] == 2
    assert long["status_distribution"]["applied"] == 2


@pytest.mark.asyncio
async def test_totals_metrics_and_production_counts(client, monkeypatch):
    """投递周期、每岗简历版本数、话术/简历产出计数。"""
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)

    token = await _login(client, "statm1", "SM1")
    h = auth_headers(token)
    user_id = await _current_user_id("statm1")

    jd = "指标岗位"
    job_id = (await _create_letter(client, h, jd)).json()["job_id"]
    await _create_match(client, h, jd)
    # 第二份定制简历（同 JD 复用同卡）→ 每岗简历版本数 > 1
    await _create_match(client, h, jd)

    # 把建卡事件回拨 6 天，构造 6 天投递周期
    async with database_module.AsyncSessionLocal() as s:
        create_ev = (
            await s.execute(
                select(JobStatusEvent).where(
                    JobStatusEvent.job_id == job_id,
                    JobStatusEvent.from_status.is_(None),
                )
            )
        ).scalars().one()
        moved = create_ev.occurred_at - timedelta(days=6)
        create_ev.occurred_at = moved
        await s.commit()

    r = await client.post(
        f"/api/jobs/{job_id}/mark", json={"outcome": "applied"}, headers=h
    )
    assert r.status_code == 200, r.text

    body = (await client.get(f"/api/jobs/stats?days=30", headers=h)).json()
    totals = body["totals"]
    assert totals["jobs"] == 1
    assert totals["applied_ever"] == 1
    assert totals["applied_rate"] == 1.0
    assert totals["avg_days_to_apply"] == pytest.approx(6.0, abs=0.2)
    assert totals["derived_resumes"] == 2
    assert totals["avg_derived_per_applied"] == pytest.approx(2.0)
    assert totals["cover_letters"] == 1
    assert totals["cover_letter_jobs"] == 1
    assert totals["backfilled_jobs"] == 0
    assert user_id  # 保持断言非空，避免未使用变量告警


@pytest.mark.asyncio
async def test_avg_days_none_when_never_applied(client, monkeypatch):
    """从未投递时，周期类指标为 None（而非 0 或 NaN），供前端显示占位符。"""
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    token = await _login(client, "statm2", "SM2")
    h = auth_headers(token)
    await _create_letter(client, h, "从未投递的岗位")

    totals = (await client.get("/api/jobs/stats?days=30", headers=h)).json()["totals"]
    assert totals["applied_ever"] == 0
    assert totals["applied_rate"] == 0.0
    assert totals["avg_days_to_apply"] is None
    assert totals["avg_derived_per_applied"] is None


@pytest.mark.asyncio
async def test_empty_state_has_no_division_by_zero(client):
    """零岗位卡：比例类指标返回 0.0，不产生 NaN / 除零错误。"""
    token = await _login(client, "state1", "SE1")
    h = auth_headers(token)

    body = (await client.get("/api/jobs/stats?days=30", headers=h)).json()
    assert body["totals"]["jobs"] == 0
    assert body["totals"]["applied_rate"] == 0.0
    assert body["totals"]["avg_days_to_apply"] is None
    assert body["funnel"][0]["count"] == 0
    assert all(f["rate"] == 0.0 for f in body["funnel"])
    assert body["status_distribution"] == {
        "greeting_sent": 0,
        "resume_ready": 0,
        "applied": 0,
        "closed": 0,
    }
    assert len(body["weekday"]) == 7
    assert body["weekday"] == [0] * 7
    assert body["streak"] == {"current": 0, "best": 0}


@pytest.mark.asyncio
async def test_stats_recovers_current_status_when_event_ledger_is_missing(client):
    """旧/异常数据没有事件台账时，当前状态仍应进入统计，而不是全为 0。"""
    token = await _login(client, "statlegacy", "SL1")
    h = auth_headers(token)
    user_id = await _current_user_id("statlegacy")
    await _add_job("jlegacy", user_id, status="applied")

    body = (await client.get("/api/jobs/stats?days=30&tz_offset=480", headers=h)).json()

    assert body["totals"]["applied_ever"] == 1
    assert body["totals"]["applied_rate"] == 1.0
    assert body["funnel"][-1]["count"] == 1
    assert body["status_distribution"]["applied"] == 1
    assert sum(point["created"] for point in body["daily"]) == 1
    assert sum(point["applied"] for point in body["daily"]) == 1


@pytest.mark.asyncio
async def test_weekday_and_streak(client):
    """星期分布与连续投递天数（按本地日历日）。"""
    tz = 480
    token = await _login(client, "statw1", "SW1")
    h = auth_headers(token)
    user_id = await _current_user_id("statw1")

    today_local = _local_today(tz)
    # 构造「今天、昨天、前天」连续三天各有一次投递；再在 10 天前投一次
    for delta in (0, 1, 2, 10):
        d = today_local - timedelta(days=delta)
        job_id = f"jw{delta}"
        await _add_job(job_id, user_id, status="applied")
        await _add_event(
            job_id, user_id, None, "greeting_sent",
            datetime.combine(d - timedelta(days=1), time(10, 0)),
            EVENT_SOURCE_CREATE,
        )
        await _add_event(
            job_id, user_id, "greeting_sent", "applied",
            datetime.combine(d, time(10, 0)),
        )

    body = (await client.get(f"/api/jobs/stats?days=30&tz_offset={tz}", headers=h)).json()
    assert sum(body["weekday"]) == 4
    assert body["streak"]["current"] == 3
    assert body["streak"]["best"] == 3


@pytest.mark.asyncio
async def test_backfill_events_are_flagged(client):
    """回填事件（日期为近似值）以 source=backfill 标注并在当日打标，前端据此提示。"""
    tz = 480
    token = await _login(client, "statb1", "SB1")
    h = auth_headers(token)
    user_id = await _current_user_id("statb1")

    today_local = _local_today(tz)
    await _add_job("jb1", user_id, status="applied")
    await _add_event(
        "jb1", user_id, None, "greeting_sent",
        datetime.combine(today_local, time(9, 0)), EVENT_SOURCE_BACKFILL,
    )
    await _add_event(
        "jb1", user_id, "greeting_sent", "applied",
        datetime.combine(today_local, time(11, 0)), EVENT_SOURCE_BACKFILL,
    )

    body = (await client.get(f"/api/jobs/stats?days=7&tz_offset={tz}", headers=h)).json()
    assert body["totals"]["backfilled_jobs"] == 1
    point = {d["date"]: d for d in body["daily"]}[today_local.isoformat()]
    assert point["backfill"] is True
    assert point["applied"] == 1


@pytest.mark.asyncio
async def test_stats_isolated_between_users(client, monkeypatch):
    """越权隔离：统计只反映当前用户自己的岗位卡与事件。"""
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)

    token_a = await _login(client, "stato1", "SO1")
    token_b = await _login(client, "stato2", "SO2")
    ha, hb = auth_headers(token_a), auth_headers(token_b)

    jd = "隔离测试岗位"
    job_a = (await _create_letter(client, ha, jd)).json()["job_id"]
    await _create_match(client, ha, jd)
    await client.post(f"/api/jobs/{job_a}/mark", json={"outcome": "applied"}, headers=ha)
    await _create_letter(client, hb, jd)  # 同一 JD 但属于另一个用户

    body_a = (await client.get("/api/jobs/stats?days=30", headers=ha)).json()
    body_b = (await client.get("/api/jobs/stats?days=30", headers=hb)).json()

    assert body_a["totals"]["jobs"] == 1
    assert body_a["totals"]["applied_ever"] == 1
    assert body_b["totals"]["jobs"] == 1
    assert body_b["totals"]["applied_ever"] == 0
    assert body_b["totals"]["cover_letters"] == 1

    # 跨用户直接访问他人卡仍 404（既有保护未被破坏）
    assert (await client.get(f"/api/jobs/{job_a}", headers=hb)).status_code == 404


@pytest.mark.asyncio
async def test_delete_job_removes_events(client, monkeypatch):
    """删卡（两种模式）同步清理事件，统计口径与列表页保持一致。"""
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    token = await _login(client, "statd1", "SD1")
    h = auth_headers(token)

    jd1 = "默认删除的岗位"
    jd2 = "彻底删除的岗位"
    job1 = (await _create_letter(client, h, jd1)).json()["job_id"]
    job2 = (await _create_letter(client, h, jd2)).json()["job_id"]

    before = (await client.get("/api/jobs/stats?days=30", headers=h)).json()
    assert before["totals"]["jobs"] == 2
    assert before["totals"]["cover_letters"] == 2

    d1 = await client.delete(f"/api/jobs/{job1}", headers=h)
    assert d1.status_code == 200, d1.text
    assert await _events_for(job1) == []

    d2 = await client.delete(f"/api/jobs/{job2}?purge=true", headers=h)
    assert d2.status_code == 200, d2.text
    assert await _events_for(job2) == []

    after = (await client.get("/api/jobs/stats?days=30", headers=h)).json()
    assert after["totals"]["jobs"] == 0
    # 话术随卡删除而不再计入（默认删除会把 job_id 置空转「未归类」）
    assert after["totals"]["cover_letters"] == 0
    assert sum(d["created"] for d in after["daily"]) == 0


@pytest.mark.asyncio
async def test_production_counts_exclude_unattached_assets(client, monkeypatch):
    """未归类（job_id 为空）的话术不计入岗位统计，避免与「我的简历」口径混淆。"""
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    token = await _login(client, "statu6", "SU6")
    h = auth_headers(token)
    user_id = await _current_user_id("statu6")

    job_id = (await _create_letter(client, h, "有归属的岗位")).json()["job_id"]
    # 直接落一条未归类话术
    async with database_module.AsyncSessionLocal() as s:
        s.add(
            CoverLetter(
                user_id=user_id,
                job_id=None,
                jd_text="未归类JD",
                resume_text="# r",
                scene="greeting",
                content="未归类话术",
            )
        )
        await s.commit()

    body = (await client.get("/api/jobs/stats?days=30", headers=h)).json()
    assert body["totals"]["jobs"] == 1
    assert body["totals"]["cover_letters"] == 1  # 只算挂在该卡上的那条
    assert job_id

    # 反向确认：确认库里确实存在两条话术（一条未归类）
    async with database_module.AsyncSessionLocal() as s:
        total = (await s.execute(select(CoverLetter))).scalars().all()
        assert len(total) == 2
        assert sum(1 for c in total if c.job_id is None) == 1
