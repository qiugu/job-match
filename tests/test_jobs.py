"""岗位卡（Job Tracking）路由测试（V2 操作驱动状态机）：自动建档、查重、状态推进、删除、越权。

通过 monkeypatch 替换 LLM 调用（run_cover_letter / run_match）注入确定性结果，
不触发真实 LLM / 网络。覆盖验收关键路径：
- 生成话术自动建档；同一 JD 再次生成复用旧卡（不新建）；首动作定初始态
- detect 端点按归一化 JD 查重
- 生成定制简历即自动推进 resume_ready（生成即触发，不再等 accept）；匹配分析落库可回看
- mark 语义：applied 仅允许从 resume_ready 确认（greeting_sent 确认 → 400）；closed 任意活跃态可归档
- reopen：closed 卡按有无定制简历回 resume_ready / greeting_sent
- PATCH 不再接受 status（extra=forbid → 422），状态只经 mark / reopen 写入
- 越权：访问他人岗位卡返回 404
- 删除两档：默认仅置空子记录（资产保留）；purge 级联删除子记录
"""
from __future__ import annotations

import json

import pytest
from conftest import auth_headers
from sqlalchemy import select

from app.models.job import Job
from app.models.cover_letter import CoverLetter
from app.models.derived_resume import DerivedResume
import app.core.database as database_module


async def _ensure_code(code, grant_matches=20):
    from app.core.timeutils import utcnow
    from datetime import timedelta
    from app.models.registration_code import RegistrationCode

    # 用独立短生命周期会话写入注册码并提交，避免与测试 fixture 会话共用连接
    # 导致的「快照未刷新 / 注册码查不到」问题。通过模块属性访问以拿到被
    # conftest monkeypatch 后的测试 session factory（而非导入时的旧引用）。
    async with database_module.AsyncSessionLocal() as s:
        res = await s.execute(
            select(RegistrationCode).where(RegistrationCode.code == code)
        )
        if res.scalars().first() is None:
            s.add(
                RegistrationCode(
                    code=code,
                    grant_matches=grant_matches,
                    expires_at=utcnow() + timedelta(days=1),
                )
            )
            await s.commit()


async def _login(client, session, username, code, password="Pass#1234"):
    await _ensure_code(code)
    r = await client.post(
        "/api/auth/register",
        json={"username": username, "password": password, "code": code},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def _direct_login(session, username, password="Pass#1234") -> str:
    """绕过注册端点直接落库用户并签发票据。

    用于「越权」类测试的第二用户：注册端点经连接池复用同一 aiosqlite 连接，
    存在快照隔离导致紧接插入的注册码查不到（注册码无效）的竞态。直接写库 +
    手动签 JWT 可稳定复现「两个不同用户」而不触碰该竞态。
    """
    from app.models.user import User
    from app.core.security import create_access_token, hash_password

    user = User(
        username=username,
        nickname=username,
        password_hash=hash_password(password),
        token_version=1,
        is_active=True,
        role="user",
        match_quota=20,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    token, _ = create_access_token(user.id, user.token_version)
    return token


async def _fake_run_cover_letter(jd_text, resume_text, scene):
    return "尊敬的招聘经理：\n\n我对贵司岗位非常感兴趣。\n"


async def _fake_run_match(master_text, jd_text):
    md = "# 项目经历\n- 主导系统重构\n\n# 专业技能\n- Python\n"
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


@pytest.mark.asyncio
async def test_cover_letter_auto_creates_and_reuses_job(client, session, monkeypatch):
    token = await _login(client, session, "jobu1", "JB1")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    jd = "  Python 后端工程师  \n  负责服务端开发  "
    r1 = await _create_letter(client, h, jd)
    assert r1.status_code == 200, r1.text
    job1 = r1.json()["job_id"]
    assert job1

    # 同一 JD（仅空白差异）再次生成：应复用旧卡，不新建
    r2 = await _create_letter(client, h, "Python 后端工程师\n 负责服务端开发")
    assert r2.status_code == 200, r2.text
    assert r2.json()["job_id"] == job1

    jobs = (await session.execute(select(Job))).scalars().all()
    assert len(jobs) == 1
    # 归一化后 jd_text 存储为折叠空白
    assert jobs[0].jd_text == "Python 后端工程师 负责服务端开发"
    # 仅生成话术（match-first 场景以外的首动作）→ greeting_sent（待回复）
    assert jobs[0].status == "greeting_sent"

    # 不同 JD 应生成第二张卡
    r3 = await _create_letter(client, h, "前端工程师 React")
    assert r3.json()["job_id"] != job1
    assert (await session.execute(select(Job))).scalars().all().__len__() == 2


@pytest.mark.asyncio
async def test_detect_endpoint(client, session, monkeypatch):
    token = await _login(client, session, "jobu2", "JB2")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    jd = "算法工程师 机器学习"
    await _create_letter(client, h, jd)
    # 归一化等价（空白差异）应命中
    r = await client.post("/api/jobs/detect", json={"jd_text": "  算法工程师\n机器学习  "}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["job_id"]

    # 不存在的 JD 返回 null
    r2 = await client.post("/api/jobs/detect", json={"jd_text": "不存在的岗位 xyz"}, headers=h)
    assert r2.json()["job_id"] is None


@pytest.mark.asyncio
async def test_match_promotes_resume_ready_and_persists_analysis(
    client, session, monkeypatch
):
    """V2 核心：生成定制简历即自动推进 resume_ready；匹配分析落库；详情可回看。"""
    token = await _login(client, session, "jobu3", "JB3")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    jd = "数据分析师 SQL"
    r = await _create_match(client, h, jd)
    assert r.status_code == 200, r.text
    derived_id = r.json()["id"]
    job_id = r.json()["jobId"]
    assert job_id

    # 生成即推进（match-first 新建卡初始态即 resume_ready）
    job = await session.get(Job, job_id)
    assert job.status == "resume_ready"

    # 匹配分析已随结果落库（此前仅当次返回、从不持久化）
    dr = await session.get(DerivedResume, derived_id)
    assert dr.analysis_json is not None
    stored = json.loads(dr.analysis_json)
    assert stored["role"] == "后端工程师"
    assert stored["score"] == 0.6

    # 详情返回子记录：衍生简历含 analysis；此时无话术
    g = await client.get(f"/api/jobs/{job_id}", headers=h)
    assert g.status_code == 200, g.text
    detail = g.json()
    assert detail["status"] == "resume_ready"
    assert len(detail["derived_resumes"]) == 1
    assert detail["derived_resumes"][0]["analysis"]["role"] == "后端工程师"
    assert detail["derived_count"] == 1
    assert detail["cover_letters"] == []

    # 在已有简历的卡上再生成话术：状态只前进不回退（不得降回待回复）
    lp = await _create_letter(client, h, jd)
    assert lp.json()["job_id"] == job_id
    g2 = await client.get(f"/api/jobs/{job_id}", headers=h)
    assert g2.json()["status"] == "resume_ready"
    assert len(g2.json()["cover_letters"]) == 1
    assert g2.json()["cover_letter_count"] == 1

    # accept 幂等：接受不改变已推进的状态（生成链路已到 resume_ready）
    a = await client.post(
        f"/api/derived-resumes/{derived_id}/accept", json={"accepted": True}, headers=h
    )
    assert a.status_code == 200, a.text
    assert a.json()["jobStatus"] is None  # 无变化不返回推进
    assert a.json()["masterResumeId"]
    await session.refresh(job)
    assert job.status == "resume_ready"


@pytest.mark.asyncio
async def test_mark_applied_requires_resume_and_closed_anytime(
    client, session, monkeypatch
):
    token = await _login(client, session, "jobu4", "JB4")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    # 仅话术（greeting_sent）的卡：不能确认投递成功
    lr = await _create_letter(client, h, "运营专员 用户增长")
    pitch_job = lr.json()["job_id"]
    m1 = await client.post(f"/api/jobs/{pitch_job}/mark", json={"outcome": "applied"}, headers=h)
    assert m1.status_code == 400, m1.text

    # 但可从任意活跃态归档（失败/放弃）
    m2 = await client.post(f"/api/jobs/{pitch_job}/mark", json={"outcome": "closed"}, headers=h)
    assert m2.status_code == 200, m2.text
    assert m2.json()["status"] == "closed"

    # 有定制简历后：resume_ready → applied 成功
    mr = await _create_match(client, h, "市场经理 SEM")
    match_job = mr.json()["jobId"]
    assert (await client.get(f"/api/jobs/{match_job}", headers=h)).json()["status"] == "resume_ready"
    m3 = await client.post(f"/api/jobs/{match_job}/mark", json={"outcome": "applied"}, headers=h)
    assert m3.status_code == 200, m3.text
    assert m3.json()["status"] == "applied"

    # applied 后再归档
    m4 = await client.post(f"/api/jobs/{match_job}/mark", json={"outcome": "closed"}, headers=h)
    assert m4.json()["status"] == "closed"


@pytest.mark.asyncio
async def test_reopen_closed_restores_by_artifacts(client, session, monkeypatch):
    token = await _login(client, session, "jobu5", "JB5")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    # 有定制简历的卡归档后重开 → 回到 resume_ready
    r = await _create_match(client, h, "供应链管理 采购")
    job_id = r.json()["jobId"]
    await client.post(f"/api/jobs/{job_id}/mark", json={"outcome": "closed"}, headers=h)
    rr = await client.post(f"/api/jobs/{job_id}/reopen", headers=h)
    assert rr.status_code == 200, rr.text
    assert rr.json()["status"] == "resume_ready"

    # 仅话术的卡归档后重开 → 回到 greeting_sent；归档卡不出现在活跃列表
    lr = await _create_letter(client, h, "测试工程师 QA")
    pitch_job = lr.json()["job_id"]
    await client.post(f"/api/jobs/{pitch_job}/mark", json={"outcome": "closed"}, headers=h)
    lst = (await client.get("/api/jobs", headers=h)).json()
    assert all(j["id"] != pitch_job for j in lst)
    # include_closed=true 时归档卡可见（供「重新开启」入口）
    lst_all = (await client.get("/api/jobs?include_closed=true", headers=h)).json()
    assert any(j["id"] == pitch_job and j["status"] == "closed" for j in lst_all)
    rr2 = await client.post(f"/api/jobs/{pitch_job}/reopen", headers=h)
    assert rr2.json()["status"] == "greeting_sent"


@pytest.mark.asyncio
async def test_patch_status_rejected_and_title_allowed(client, session, monkeypatch):
    token = await _login(client, session, "jobu6", "JB6")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)

    r = await _create_match(client, h, "Go 后端 高并发")
    job_id = r.json()["jobId"]

    # PATCH status：extra=forbid → 422（状态只经 mark / reopen 语义端点）
    p1 = await client.patch(f"/api/jobs/{job_id}", json={"status": "applied"}, headers=h)
    assert p1.status_code == 422, p1.text

    # PATCH 元数据（title / company）仍可用
    p2 = await client.patch(
        f"/api/jobs/{job_id}", json={"title": "Go 高级后端", "company": "某科技"}, headers=h
    )
    assert p2.status_code == 200, p2.text
    assert p2.json()["title"] == "Go 高级后端"
    assert p2.json()["company"] == "某科技"


@pytest.mark.asyncio
async def test_job_ownership_404(client, session, monkeypatch):
    t1 = await _direct_login(session, "jobu7a")
    t2 = await _direct_login(session, "jobu7b")
    h1, h2 = auth_headers(t1), auth_headers(t2)
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    jd = "产品经理 增长"
    r = await _create_letter(client, h1, jd)
    job_id = r.json()["job_id"]

    # 他人访问该岗位卡 → 404
    g = await client.get(f"/api/jobs/{job_id}", headers=h2)
    assert g.status_code == 404
    # 本人可访问
    g1 = await client.get(f"/api/jobs/{job_id}", headers=h1)
    assert g1.status_code == 200, g1.text


@pytest.mark.asyncio
async def test_delete_default_set_null_vs_purge(client, session, monkeypatch):
    token = await _login(client, session, "jobu8", "JB8")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    jd = "运维工程师 SRE"
    r = await _create_letter(client, h, jd)
    cl_id = r.json()["id"]
    job_id = r.json()["job_id"]

    # 默认删除：卡片消失，话术转「未归类」（job_id 置空），资产保留
    d = await client.delete(f"/api/jobs/{job_id}", headers=h)
    assert d.status_code == 200, d.text
    assert (await session.get(Job, job_id)) is None
    cl = await session.get(CoverLetter, cl_id)
    assert cl is not None
    assert cl.job_id is None

    # 新建一张卡并用 purge 彻底删除
    r2 = await _create_letter(client, h, jd)
    cl2_id = r2.json()["id"]
    job2 = r2.json()["job_id"]
    dp = await client.delete(f"/api/jobs/{job2}?purge=true", headers=h)
    assert dp.status_code == 200, dp.text
    assert (await session.get(CoverLetter, cl2_id)) is None
