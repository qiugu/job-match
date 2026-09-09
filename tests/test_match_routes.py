"""match 路由测试：create/GET/list/accept/delete 业务流、积分扣减、接受幂等。

通过 monkeypatch 替换 app.api.match.run_match 注入确定性结果，
不触发真实 LLM / 网络。重点验证路由层契约：
- 简历匹配每次消耗 5 积分，成功后返回 remainingCredits
- create_match 挂载岗位卡并返回 jobId（匹配即建档，刷新不丢上下文）
- accept 幂等（同结果复用以 accepted_master_id 为键）
- 接受落库 MasterResume 标题冲突时加 ` (2)` 后缀
- 响应字段名 markdownContent
- 无限制账号不扣积分（管理员）

注：话术（cover letter）已从匹配结果解耦到独立资源 /api/cover-letters，
匹配响应不再包含 hasCoverLetter / coverLetter 字段。
"""

import pytest

from conftest import auth_headers
from app.core.timeutils import utcnow
from app.models.registration_code import RegistrationCode
from sqlalchemy import select


async def _ensure_code(session, code, grant_credits=20):
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


# 确定性伪匹配结果，绕过 LLM。
# 当前 run_match(master_text, jd_text) 返回 3 元组：(keywords, markdown, analysis)
async def _fake_run_match(master_text, jd_text):
    md = (
        "# 项目经历\n"
        "- 主导某系统重构，QPS 提升 3 倍\n"
        "- 负责核心模块设计\n\n"
        "# 专业技能\n"
        "- Python / FastAPI\n"
    )
    analysis = {"score": 5}
    return (["Python", "FastAPI"], md, analysis)


@pytest.mark.asyncio
async def test_create_match_consumes_quota(client, session, monkeypatch):
    token = await _login(client, session, "matq", "MQ1")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)

    r = await client.post(
        "/api/derived-resumes",
        json={
            "resumeText": "# resume\n- did x",
            "jdText": "# jd\n- need y",
            "title": "match1",
        },
        headers=h,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # 初始积分 20，简历匹配扣 5 后剩余 15
    assert body["remainingCredits"] == 15
    assert "markdownContent" in body and body["markdownContent"]
    # 匹配即建档：响应挂载 jobId（话术已解耦，无 hasCoverLetter/coverLetter）
    assert isinstance(body.get("jobId"), str) and body["jobId"]


@pytest.mark.asyncio
async def test_create_match_returns_job_id(client, session, monkeypatch):
    """create_match 必须自动挂载岗位卡并返回非空 jobId（归一化 JD 查重/建档）。"""
    token = await _login(client, session, "covl", "CL1")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)

    r = await client.post(
        "/api/derived-resumes",
        json={
            "resumeText": "# resume",
            "jdText": "# jd",
            "title": "match-cl",
        },
        headers=h,
    )
    assert r.status_code == 200, r.text
    assert isinstance(r.json().get("jobId"), str) and r.json()["jobId"]


@pytest.mark.asyncio
async def test_quota_exhausted_returns_403(client, session, monkeypatch):
    token = await _login(client, session, "qexh", "QE1")  # 积分 20，可匹配 4 次
    h = auth_headers(token)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)
    payload = {"resumeText": "# r", "jdText": "# j"}
    for i in range(4):
        r = await client.post(
            "/api/derived-resumes", json={**payload, "title": f"m{i}"}, headers=h
        )
        assert r.status_code == 200, r.text
    r = await client.post(
        "/api/derived-resumes", json={**payload, "title": "overflow"}, headers=h
    )
    assert r.status_code == 403, r.text
    assert "积分" in r.json()["detail"]


@pytest.mark.asyncio
async def test_get_and_list_derived(client, session, monkeypatch):
    token = await _login(client, session, "getl", "GL1")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)
    created = await client.post(
        "/api/derived-resumes",
        json={
            "resumeText": "# r",
            "jdText": "# j",
            "title": "t1",
        },
        headers=h,
    )
    did = created.json()["id"]

    r = await client.get(f"/api/derived-resumes/{did}", headers=h)
    assert r.status_code == 200
    assert r.json()["id"] == did
    # 详情含 markdownContent
    assert r.json()["markdownContent"]

    r = await client.get("/api/derived-resumes", headers=h)
    assert r.status_code == 200
    assert did in [x["id"] for x in r.json()]


@pytest.mark.asyncio
async def test_accept_derived_idempotent(client, session, monkeypatch):
    token = await _login(client, session, "accp", "AC1")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)
    created = await client.post(
        "/api/derived-resumes",
        json={
            "resumeText": "# r",
            "jdText": "# j",
            "title": "derived-title",
        },
        headers=h,
    )
    did = created.json()["id"]

    r1 = await client.post(
        f"/api/derived-resumes/{did}/accept",
        json={"accepted": True},
        headers=h,
    )
    assert r1.status_code == 200, r1.text
    assert r1.json()["accepted"] is True
    mid = r1.json()["masterResumeId"]
    assert mid

    # 重复接受 → 幂等复用，deduped=True
    r2 = await client.post(
        f"/api/derived-resumes/{did}/accept",
        json={"accepted": True},
        headers=h,
    )
    assert r2.status_code == 200
    assert r2.json()["masterResumeId"] == mid
    assert r2.json()["deduped"] is True


@pytest.mark.asyncio
async def test_accept_title_conflict_gets_suffix(client, session, monkeypatch):
    token = await _login(client, session, "titc", "TC1")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)

    # 第一个衍生简历（标题 derived-title）接受 → 落库 master "derived-title"
    d1 = await client.post(
        "/api/derived-resumes",
        json={
            "resumeText": "# r",
            "jdText": "# j",
            "title": "derived-title",
        },
        headers=h,
    )
    r1 = await client.post(
        f"/api/derived-resumes/{d1.json()['id']}/accept",
        json={"accepted": True},
        headers=h,
    )
    assert r1.status_code == 200, r1.text

    # 第二个衍生简历（同样标题 derived-title）接受 → 标题冲突加后缀
    d2 = await client.post(
        "/api/derived-resumes",
        json={
            "resumeText": "# r2",
            "jdText": "# j2",
            "title": "derived-title",
        },
        headers=h,
    )
    r2 = await client.post(
        f"/api/derived-resumes/{d2.json()['id']}/accept",
        json={"accepted": True},
        headers=h,
    )
    assert r2.status_code == 200, r2.text
    mid = r2.json()["masterResumeId"]
    mr = await client.get(f"/api/master-resumes/{mid}", headers=h)
    assert mr.status_code == 200
    # 冲突时自动追加 " (2)" 后缀，名称包含原基础名
    assert mr.json()["title"] != "derived-title"
    assert "derived-title" in mr.json()["title"]


@pytest.mark.asyncio
async def test_update_derived(client, session, monkeypatch):
    token = await _login(client, session, "delu", "DL1")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)
    created = await client.post(
        "/api/derived-resumes",
        json={
            "resumeText": "# r",
            "jdText": "# j",
            "title": "upd",
        },
        headers=h,
    )
    did = created.json()["id"]
    # PUT 回写二次编辑后的内容
    r = await client.put(
        f"/api/derived-resumes/{did}",
        json={"markdownContent": "# 改写后的内容\n- item"},
        headers=h,
    )
    assert r.status_code == 200, r.text
    assert r.json()["id"] == did
    # 详情应反映更新
    r = await client.get(f"/api/derived-resumes/{did}", headers=h)
    assert r.json()["markdownContent"] == "# 改写后的内容\n- item"


@pytest.mark.asyncio
async def test_unlimited_user_not_charged(client, session, monkeypatch):
    # 管理员账号无限制：注册码授予积分仅审计，但角色 admin 跳过预扣
    from app.models.user import User

    # 注册一个普通用户后手动置为 admin，验证不扣积分
    token = await _login(client, session, "adminx", "ADM1", password="Pass#1234")
    h = auth_headers(token)
    from sqlalchemy import select

    res = await session.execute(select(User).where(User.username == "adminx").limit(1))
    u = res.scalars().first()
    u.role = "admin"
    u.credits = -1
    await session.commit()

    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)
    r = await client.post(
        "/api/derived-resumes",
        json={
            "resumeText": "# r",
            "jdText": "# j",
            "title": "adm-match",
        },
        headers=h,
    )
    assert r.status_code == 200, r.text
    # 无限制账号返回 -1
    assert r.json()["remainingCredits"] == -1
