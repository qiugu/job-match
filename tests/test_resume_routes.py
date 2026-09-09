"""resume 路由测试：标题唯一 409、列表隔离、详情/删除、跨用户隔离。

依据 app/api/resume.py 的真实契约：
- 上传 PDF 与 /json 保存：标题已存在一律 409（用户改名重试，不静默复用）。
- 列表按 user_id 过滤；非本人资源返回 404（不暴露存在性）。
- 详情返回 resumeJson（含回填的 markdownContent）。
"""

import io

import pytest

from conftest import auth_headers
from app.core.timeutils import utcnow
from app.models.registration_code import RegistrationCode
from sqlalchemy import select


def _pdf_bytes(text: str = "John Doe resume content") -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica", 12)
    c.drawString(72, 780, text)
    c.drawString(72, 764, "Experience: built things.")
    c.showPage()
    c.save()
    return buf.getvalue()


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


async def _upload(client, session, username, code, filename="Resume.pdf"):
    token = await _login(client, session, username, code)
    r = await client.post(
        "/api/master-resumes",
        files={"file": (filename, _pdf_bytes(), "application/pdf")},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    return r, token


@pytest.mark.asyncio
async def test_upload_duplicate_title_409(client, session):
    # 第一个用户上传 Resume.pdf
    r1, token = await _upload(client, session, "dup1", "DUP1", filename="Resume.pdf")
    # 上传时标题剥掉 .pdf 扩展名（避免导出叠加出 xxx.pdf.pdf），故为 "Resume"
    assert r1.json()["title"] == "Resume"

    # 同一用户再次上传同名 → 409（标题唯一，不静默复用/覆盖）
    r2 = await client.post(
        "/api/master-resumes",
        files={"file": ("Resume.pdf", _pdf_bytes(), "application/pdf")},
        headers=auth_headers(token),
    )
    assert r2.status_code == 409, r2.text
    assert "已存在" in r2.json()["detail"]


@pytest.mark.asyncio
async def test_json_save_duplicate_title_409(client, session):
    token = await _login(client, session, "js1", "JS1")
    h = auth_headers(token)
    payload = {"title": "My Resume", "markdownContent": "# title\n- item"}
    r1 = await client.post("/api/master-resumes/json", json=payload, headers=h)
    assert r1.status_code == 200, r1.text
    # 同名再次保存 → 409（不静默复用/覆盖）
    r2 = await client.post("/api/master-resumes/json", json=payload, headers=h)
    assert r2.status_code == 409, r2.text
    assert "已存在" in r2.json()["detail"]


@pytest.mark.asyncio
async def test_list_only_own_resumes(client, session):
    _, h1 = await _upload(client, session, "owner", "OWN1", filename="A.pdf")
    _, h2 = await _upload(client, session, "other", "OWN2", filename="B.pdf")

    r1 = await client.get("/api/master-resumes", headers=auth_headers(h1))
    r2 = await client.get("/api/master-resumes", headers=auth_headers(h2))
    assert r1.status_code == 200 and r2.status_code == 200
    titles1 = [x["title"] for x in r1.json()]
    titles2 = [x["title"] for x in r2.json()]
    # 标题剥掉扩展名：A.pdf→"A"，B.pdf→"B"
    assert "A" in titles1 and "A" not in titles2
    assert "B" in titles2 and "B" not in titles1


@pytest.mark.asyncio
async def test_get_and_delete_resume(client, session):
    _, h = await _upload(client, session, "goodu", "GD1", filename="C.pdf")
    r = await client.get("/api/master-resumes", headers=auth_headers(h))
    rid = r.json()[0]["id"]

    r = await client.get(f"/api/master-resumes/{rid}", headers=auth_headers(h))
    assert r.status_code == 200
    assert r.json()["id"] == rid
    assert "resumeJson" in r.json()  # 详情含结构化数据

    r = await client.delete(f"/api/master-resumes/{rid}", headers=auth_headers(h))
    assert r.status_code == 200
    r = await client.get(f"/api/master-resumes/{rid}", headers=auth_headers(h))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_cannot_access_others_resume(client, session):
    _, h1 = await _upload(client, session, "ausr1", "A11", filename="X.pdf")
    r = await client.get("/api/master-resumes", headers=auth_headers(h1))
    rid = r.json()[0]["id"]
    h2 = await _login(client, session, "ausr2", "A22")
    # a2 访问 a1 的资源 → 404（不暴露存在性）
    r = await client.get(f"/api/master-resumes/{rid}", headers=auth_headers(h2))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_json_created_id_immediately_fetchable(client, session):
    """回归（2026-08-31 导入简历后编辑器 404）：前端导入 PDF 落库用 POST
    /api/master-resumes/json，拿到返回 id 后立即跳编辑器，编辑器 loader 马上
    GET /api/master-resumes/{id}。返回的 id 必须立刻可读、且带结构化数据，
    否则编辑器 404 回退空白态，用户刚导入的简历"消失"。"""
    token = await _login(client, session, "imm1", "IMM1")
    h = auth_headers(token)
    payload = {"title": "Imported.pdf", "markdownContent": "# Imported\n- item"}
    r = await client.post("/api/master-resumes/json", json=payload, headers=h)
    assert r.status_code == 200, r.text
    created_id = r.json()["id"]
    assert created_id, "POST /json 必须返回真实记录 id（前端跳转依赖它）"

    detail = await client.get(f"/api/master-resumes/{created_id}", headers=h)
    assert detail.status_code == 200, detail.text
    assert detail.json()["id"] == created_id
    assert detail.json()["title"] == "Imported"
    assert "resumeJson" in detail.json()
