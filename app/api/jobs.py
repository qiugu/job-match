"""岗位卡（Job Tracking）API：以 JD 为中心的「机会管理」。

端点前缀 /api/jobs：
  GET    /               当前用户活跃岗位列表（含聚合，按最近活跃 desc；归档 closed 不出现）
  GET    /stats          投递统计（事件台账聚合；days / tz_offset 可调）
                         ⚠ 必须声明在 /{job_id} 之前，否则会被 {job_id} 吞掉按「岗位不存在」404
  GET    /{job_id}      岗位详情（含子记录：话术列表 + 定制简历及匹配分析；非本人 404）
  POST   /              手动建档（罕见，供检测 UI 的「仍然新建」兜底；归一化查重复用）
  PATCH  /{job_id}      仅改 title/company（extra=forbid，传 status 直接 422）
  POST   /{job_id}/mark   手动确认投递结果：{outcome: applied|closed}
                          applied=投递成功（仅从 resume_ready 确认）；
                          closed=失败/放弃归档（任意活跃态可进；幂等）
  POST   /{job_id}/reopen 把已结束卡重新开启（按有无定制简历回 resume_ready/greeting_sent）
  DELETE /{job_id}      默认：仅删卡片，子记录 job_id 置空（SET NULL）转「未归类」，资产保留
  DELETE /{job_id}?purge=true  彻底删除：级联删除该卡下全部话术与匹配记录；
                                  已接受简历在 master_resumes 的副本不受影响
  POST   /detect        按归一化 jd_text 查重 → { job_id | null }

状态由内容操作自动推进（集中 app/services/job.py 的 promote_for_action：
生成话术→greeting_sent、生成定制简历→resume_ready，只前进不回退），
本模块只承载两个「用户手动确认」（mark）与归档复活（reopen）。

写链路自动挂载逻辑在 app/services/job.py 的 attach_or_create_job。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.logging import get_logger
from app.models.cover_letter import CoverLetter
from app.models.derived_resume import DerivedResume
from app.models.job import (
    Job,
    JOB_STATUS_APPLIED,
    JOB_STATUS_CLOSED,
    JOB_STATUS_RESUME_READY,
)
from app.models.job_event import EVENT_SOURCE_MANUAL, JobStatusEvent
from app.models.user import User
from app.schemas.job import (
    CoverLetterBrief,
    DerivedResumeBrief,
    JobDetail,
    JobDetectResponse,
    JobMarkPayload,
    JobStats,
    JobSummary,
    JobUpdate,
)
from app.services.job import (
    attach_or_create_job,
    detect_job,
    get_job_aggregates,
    get_jobs_aggregates,
    reopen_job,
    transition,
)
from app.services.job_stats import (
    ALLOWED_DAYS,
    DEFAULT_TZ_OFFSET,
    compute_job_stats,
)

logger = get_logger("jobs")

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


class JobCreate(BaseModel):
    """手动建档：jd_text 必填；title/company 可选（缺省由 JD 派生 / 留空）。"""

    jd_text: str
    title: str | None = None
    company: str | None = None


def _ensure_owner(job: Job | None, user: User) -> Job:
    """校验岗位卡归属当前用户：非本人记录返回 404，不暴露资源是否存在。"""
    if job is None or job.user_id != user.id:
        raise HTTPException(status_code=404, detail="岗位不存在")
    return job


async def _to_summary(db: AsyncSession, job: Job) -> JobSummary:
    agg = await get_job_aggregates(db, job.id)
    return JobSummary(
        id=job.id,
        user_id=job.user_id,
        title=job.title,
        company=job.company,
        status=job.status,
        jd_text=job.jd_text,
        created_at=job.created_at.isoformat(),
        updated_at=job.updated_at.isoformat(),
        **agg,
    )


async def _to_detail(db: AsyncSession, job: Job) -> JobDetail:
    """详情 = 摘要 + 内嵌子记录（话术全文 + 定制简历含匹配分析），一次取全供详情区渲染。"""
    summary = await _to_summary(db, job)

    cl_rows = (
        await db.execute(
            select(CoverLetter)
            .where(CoverLetter.job_id == job.id)
            .order_by(CoverLetter.created_at.desc())
        )
    ).scalars().all()
    dr_rows = (
        await db.execute(
            select(DerivedResume)
            .where(DerivedResume.job_id == job.id)
            .order_by(DerivedResume.created_at.desc())
        )
    ).scalars().all()

    return JobDetail(
        **summary.model_dump(),
        cover_letters=[
            CoverLetterBrief(
                id=c.id,
                scene=c.scene,
                content=c.content,
                created_at=c.created_at.isoformat(),
            )
            for c in cl_rows
        ],
        derived_resumes=[
            DerivedResumeBrief(
                id=d.id,
                title=d.title,
                accepted=bool(d.accepted),
                analysis=json.loads(d.analysis_json) if d.analysis_json else None,
                markdown_content=d.markdown_content,
                created_at=d.created_at.isoformat(),
            )
            for d in dr_rows
        ],
    )


@router.get("", summary="岗位列表（含聚合，归档 closed 默认不出现）")
async def list_jobs(
    include_closed: bool = Query(False, description="true=额外返回已归档（closed）岗位"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = select(Job).where(Job.user_id == user.id)
    if not include_closed:
        stmt = stmt.where(Job.status != JOB_STATUS_CLOSED)
    rows = (await db.execute(stmt.order_by(Job.updated_at.desc()))).scalars().all()
    aggregates = await get_jobs_aggregates(db, [j.id for j in rows])
    return [
        JobSummary(
            id=j.id,
            user_id=j.user_id,
            title=j.title,
            company=j.company,
            status=j.status,
            jd_text=j.jd_text,
            created_at=j.created_at.isoformat(),
            updated_at=j.updated_at.isoformat(),
            **aggregates[j.id],
        )
        for j in rows
    ]


@router.get("/stats", summary="投递统计（状态事件台账聚合）")
async def job_stats(
    days: int = Query(
        30,
        description=(
            f"统计区间天数，取值 {'/'.join(str(d) for d in ALLOWED_DAYS)}；"
            "非白名单值就近收敛（等距取较大者），超额上限 365"
        ),
    ),
    tz_offset: int = Query(
        DEFAULT_TZ_OFFSET,
        description="时区偏移（分钟）。UTC+8 传 480；前端传 -new Date().getTimezoneOffset()",
    ),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """按用户本地日历日聚合投递情况。

    参数收敛（白名单 / 上限 / 偏移范围）统一由 `compute_job_stats` 负责，
    本层不重复实现，避免两处口径分叉。返回结构见 `JobStats`。
    """
    data = await compute_job_stats(
        db, user.id, days=days, tz_offset=tz_offset
    )
    return JobStats(**data)


@router.get("/{job_id}", summary="岗位详情（含话术 / 定制简历与匹配分析）")
async def get_job(
    job_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    job = await db.get(Job, job_id)
    _ensure_owner(job, user)
    return await _to_detail(db, job)  # type: ignore[arg-type]


@router.post("", summary="手动建档（归一化查重复用）")
async def create_job(
    req: JobCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not req.jd_text.strip():
        raise HTTPException(status_code=400, detail="岗位描述不能为空")
    # 复用写链路的「查重或建卡」：同一 JD 不会因手动建档产生第二张卡
    job = await attach_or_create_job(db, user.id, req.jd_text)
    # 手动建档允许覆盖派生标题/公司（自动挂载时这些为空/派生）
    if req.title is not None:
        job.title = req.title
    if req.company is not None:
        job.company = req.company
    await db.commit()
    await db.refresh(job)
    return await _to_summary(db, job)


@router.patch("/{job_id}", summary="更新岗位元数据（title/company；状态请用 mark/reopen）")
async def update_job(
    job_id: str,
    payload: JobUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    job = await db.get(Job, job_id)
    _ensure_owner(job, user)
    if payload.title is not None:
        job.title = payload.title
    if payload.company is not None:
        job.company = payload.company
    job.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(job)
    return await _to_summary(db, job)


@router.post("/{job_id}/mark", summary="手动确认投递结果（applied=投递成功 / closed=失败归档）")
async def mark_job(
    job_id: str,
    payload: JobMarkPayload,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    job = await db.get(Job, job_id)
    _ensure_owner(job, user)

    if payload.outcome == JOB_STATUS_APPLIED:
        if job.status == JOB_STATUS_APPLIED:
            # 幂等：已确认过投递成功。transition 同态不写事件，
            # 因此重复点击不会把投递日改到「最近一次点击那天」。
            pass
        elif job.status == JOB_STATUS_RESUME_READY:
            await transition(db, job, JOB_STATUS_APPLIED, EVENT_SOURCE_MANUAL)
        else:
            raise HTTPException(
                status_code=400,
                detail="需先生成定制简历，才能确认投递成功",
            )
    else:  # closed：从任意活跃态（greeting_sent / resume_ready / applied）归档
        if job.status == JOB_STATUS_CLOSED:
            pass  # 幂等：已归档
        else:
            await transition(db, job, JOB_STATUS_CLOSED, EVENT_SOURCE_MANUAL)

    # updated_at 由 transition 在真正发生变更时写入；幂等调用不再刷新它，
    # 避免「无操作的重复点击把卡片顶到列表最前」。
    await db.commit()
    await db.refresh(job)
    return await _to_summary(db, job)


@router.post("/{job_id}/reopen", summary="重新开启已结束的岗位（按有无简历回投递准备/待回复）")
async def reopen_job_endpoint(
    job_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    job = await db.get(Job, job_id)
    _ensure_owner(job, user)
    new_status = await reopen_job(db, job)  # 非 closed 为幂等空操作
    await db.commit()
    await db.refresh(job)
    return await _to_summary(db, job)


@router.delete("/{job_id}", summary="删除岗位（默认置空子记录；purge 级联）")
async def delete_job(
    job_id: str,
    purge: bool = Query(False, description="true=彻底删除（级联删除该卡下全部话术与匹配记录）"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    job = await db.get(Job, job_id)
    _ensure_owner(job, user)

    if purge:
        # 彻底删除：级联删除该卡下的全部话术与匹配记录。
        # 注意：已接受简历在 master_resumes 中的副本不受影响（那是独立资产）。
        children_cl = (
            await db.execute(select(CoverLetter).where(CoverLetter.job_id == job_id))
        ).scalars().all()
        children_dr = (
            await db.execute(select(DerivedResume).where(DerivedResume.job_id == job_id))
        ).scalars().all()
        for c in children_cl:
            await db.delete(c)
        for d in children_dr:
            await db.delete(d)
    else:
        # 默认「整理」：仅删卡片，子记录 job_id 置空转「未归类」，资产保留
        await db.execute(
            sa_update(CoverLetter)
            .where(CoverLetter.job_id == job_id)
            .values(job_id=None)
        )
        await db.execute(
            sa_update(DerivedResume)
            .where(DerivedResume.job_id == job_id)
            .values(job_id=None)
        )

    # 状态事件随卡删除（两种模式都清理）：统计口径恒等于「当前存在的岗位卡的行为」，
    # 与岗位列表页数字保持一致，避免「列表 3 张卡、统计却说 10 次投递」的认知冲突。
    events = (
        await db.execute(
            select(JobStatusEvent).where(JobStatusEvent.job_id == job_id)
        )
    ).scalars().all()
    for e in events:
        await db.delete(e)

    await db.delete(job)
    await db.commit()
    return {"id": job_id, "purged": bool(purge), "deleted": True}


@router.post("/detect", summary="按 JD 查重检测既有岗位卡")
async def detect_job_endpoint(
    req: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    jd_text = (req.get("jd_text") or "") if isinstance(req, dict) else ""
    job_id = await detect_job(db, user.id, jd_text)
    return JobDetectResponse(job_id=job_id)
