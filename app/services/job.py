"""岗位卡（Job Tracking）业务逻辑。

核心能力：
- attach_or_create_job：写链路（生成话术 / 创建匹配）共用的「自动挂载」逻辑——
  归一化 JD 后查重，命中则复用既有岗位卡，未命中则建卡；返回 job.id 供子记录归属。
  initial_status 参数表达「首动作决定初始态」：生成话术传 greeting_sent，
  直接匹配出简历传 resume_ready；仅在新建卡时生效，命中旧卡不改动。
- promote_for_action：V2 状态机唯一推进入口（只前进不回退）：
  - 内容操作（生成话术 / 生成定制简历）只能推进到 active 态；
  - applied/closed 只能经 jobs API 的 mark/reopen 手动确认；
  - closed 视为终态，但新的内容操作视为「重新激活」：按动作语义与是否已有简历回阶段。
- get_job_aggregates：聚合单张岗位卡的子记录统计，供列表/详情返回，避免 N+1。
- detect_job：按归一化 JD 查重，供前端重复 JD 防御提示。
- transition / record_status_event：状态事件台账的读写。**transition 是全项目唯一的
  `job.status` 写入口**——改状态与落事件是不可分割的一对动作，任何绕过它的直接赋值
  都会让投递统计失去时间基准（详见 app/models/job_event.py 的说明）。

所有函数均操作 async session（FastAPI 依赖注入的 AsyncSession）。
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.text_utils import normalize_jd_text
from app.models.cover_letter import CoverLetter
from app.models.derived_resume import DerivedResume
from app.models.job import (
    Job,
    JOB_STATUS_ACTIVE,
    JOB_STATUS_APPLIED,
    JOB_STATUS_CLOSED,
    JOB_STATUS_DEFAULT,
    JOB_STATUS_RESUME_READY,
    _id,
)
from app.models.job_event import (
    EVENT_SOURCE_AUTO,
    EVENT_SOURCE_CREATE,
    EVENT_SOURCE_REOPEN,
    JobStatusEvent,
    _id as _event_id,
)

# 标题兜底长度：jd 首行截断 40 字
TITLE_MAX_LEN = 40

# 阶段等级：内容操作推进只允许严格递增；applied 之后不再被内容操作覆盖。
_STATUS_RANK: dict[str, int] = {
    "greeting_sent": 0,
    "resume_ready": 1,
    "applied": 2,
}


def _derive_title(jd_text: str) -> str:
    """从 JD 原文首行派生岗位名，截断 40 字兜底。"""
    first_line = (jd_text or "").strip().splitlines()[0] if (jd_text or "").strip() else ""
    return first_line[:TITLE_MAX_LEN].strip() or "未命名岗位"


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _has_derived(db: AsyncSession, job_id: str) -> bool:
    """该岗位卡下是否存在任意衍生简历（用于 closed 复活与 reopen 的目标态判定）。"""
    n = (
        await db.execute(
            select(func.count())
            .select_from(DerivedResume)
            .where(DerivedResume.job_id == job_id)
        )
    ).scalar_one() or 0
    return int(n) > 0


def _utc_naive(dt: datetime) -> datetime:
    """归一为 UTC naive，供事件表存储。

    `jobs` 等既有表写入的是 aware UTC，SQLite 的 DATETIME 会丢弃 tzinfo、落库为
    同一 UTC 时刻的朴素字符串；读回来则是 naive。事件表显式做这一步，使「写进去的」
    与「读出来的」在比较时类型一致，避免统计层出现 aware/naive 混算。
    """
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


async def record_status_event(
    db: AsyncSession,
    *,
    job_id: str,
    user_id: str,
    from_status: str | None,
    to_status: str,
    source: str,
    occurred_at: datetime | None = None,
) -> None:
    """登记一条状态变更事实（append-only）。

    仅登记进会话、不在此处 commit：状态变更与事件必须同事务落地，
    由调用方统一提交（与 `attach_or_create_job` 的既有约定一致）。

    occurred_at 为「事实发生时刻」，一旦写入永不更新——这正是本表存在的理由：
    `jobs.updated_at` 会被元数据编辑覆盖，不能作为统计时间基准。
    """
    db.add(
        JobStatusEvent(
            id=_event_id(),
            user_id=user_id or "",
            job_id=job_id,
            from_status=from_status,
            to_status=to_status,
            source=source,
            occurred_at=_utc_naive(occurred_at or _now()),
        )
    )


async def transition(
    db: AsyncSession, job: Job, new_status: str, source: str = EVENT_SOURCE_AUTO
) -> bool:
    """**全项目唯一的状态写入口**：改 `job.status` 的同时落一条事件。

    任何绕过本函数直接赋值 `job.status` 的写法都会造成「状态变了但没事件」，
    统计随之失真。业务规则（只前进不回退、终态不可覆盖等）仍由调用方判断，
    本函数只负责「变更 + 记账」这对不可分割的动作。

    幂等：new_status 与当前一致时不做任何写入，返回 False
    （因此重复点「确认投递」不会污染投递日统计）。

    返回是否真的发生了状态变化。
    """
    if job.status == new_status:
        return False

    previous = job.status
    occurred = _now()
    job.status = new_status
    job.updated_at = occurred
    await record_status_event(
        db,
        job_id=job.id,
        user_id=job.user_id,
        from_status=previous,
        to_status=new_status,
        source=source,
        occurred_at=occurred,
    )
    return True


async def promote_for_action(
    db: AsyncSession, job: Job, action_status: str
) -> bool:
    """内容操作后的状态推进（V2 唯一自动推进入口）。

    参数：
    - action_status：本次动作蕴含的阶段。cover_letter 链路传 greeting_sent；
      match 链路传 resume_ready。
    规则：
    1. job 已 closed：新的内容操作视为「重新激活」——回到 resume_ready（卡下已有
       定制简历时）或动作阶段（仅话术动作且无简历时回到 greeting_sent）。
       该路径由内容操作隐式触发，事件来源记为 auto（用户显式复活走 reopen_job）。
    2. job 为 applied：终态，内容操作不再覆盖（返回 False）。
    3. 否则仅当动作阶段高于当前阶段时推进（只前进不回退）。

    状态变更统一经 transition() 落地，保证「状态变了必有事件」。
    """
    if job.status == JOB_STATUS_CLOSED:
        # 重新激活：有简历就回投递准备，否则按动作语义回对应阶段
        target = (
            JOB_STATUS_RESUME_READY
            if await _has_derived(db, job.id)
            else (
                action_status
                if action_status in JOB_STATUS_ACTIVE
                else JOB_STATUS_DEFAULT
            )
        )
        return await transition(db, job, target, EVENT_SOURCE_AUTO)

    if job.status == JOB_STATUS_APPLIED:
        return False

    cur = _STATUS_RANK.get(job.status, 0)
    target = _STATUS_RANK.get(action_status, 0)
    if target > cur:
        return await transition(db, job, action_status, EVENT_SOURCE_AUTO)
    return False


async def reopen_job(db: AsyncSession, job: Job) -> str:
    """把已结束（closed）的岗位卡重新开启，返回新状态。

    目标态按现有产出反推：卡下已有定制简历 → resume_ready；否则 → greeting_sent。
    非 closed 卡调用为幂等空操作（返回当前状态，不抛错，也不产生事件）。
    """
    if job.status != JOB_STATUS_CLOSED:
        return job.status
    target = (
        JOB_STATUS_RESUME_READY
        if await _has_derived(db, job.id)
        else JOB_STATUS_DEFAULT
    )
    await transition(db, job, target, EVENT_SOURCE_REOPEN)
    return job.status


async def attach_or_create_job(
    db: AsyncSession,
    user_id: str,
    jd_text: str,
    initial_status: str = JOB_STATUS_DEFAULT,
) -> Job:
    """归一化 JD 查重：命中既有岗位卡则复用，否则建卡并返回。

    写链路（create_cover_letter / create_match）调用本函数拿到 job.id 后，
    把子记录的 job_id 指向它，从而实现「自动建档、无感保存」。

    initial_status 仅对「新建卡」生效（V2 首动作定初始态）：
    - 生成话术 → JOB_STATUS_DEFAULT（greeting_sent）
    - 直接匹配出简历 → JOB_STATUS_RESUME_READY
    命中既有卡时不做任何状态改动，推进由调用方随后执行 promote_for_action。

    归一化与 detect 端点共用 normalize_jd_text，保证语义一致。
    """
    normalized = normalize_jd_text(jd_text)
    if normalized:
        existing = (
            await db.execute(
                select(Job).where(
                    Job.user_id == user_id, Job.jd_text == normalized
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            return existing

    job = Job(
        id=_id(),
        user_id=user_id,
        jd_text=normalized,
        title=_derive_title(jd_text),
        status=initial_status if initial_status in JOB_STATUS_ACTIVE else JOB_STATUS_DEFAULT,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    # 仅登记进会话，不在本次调用内 flush：避免提前开启写事务，
    # 与「预扣共享额度」使用独立会话的写操作在 SQLite 下争锁（database is locked）。
    # 调用方在挂好子记录后统一 commit，由 SQLAlchemy 依 FK 依赖顺序先插 jobs 再插子表。
    db.add(job)
    # 建卡事实：from_status 为 NULL（无前驱），occurred_at 取建卡时刻。
    # 与 jobs 同事务提交，故此处同样不 flush。
    await record_status_event(
        db,
        job_id=job.id,
        user_id=user_id,
        from_status=None,
        to_status=job.status,
        source=EVENT_SOURCE_CREATE,
        occurred_at=job.created_at,
    )
    return job


async def detect_job(db: AsyncSession, user_id: str, jd_text: str) -> str | None:
    """按归一化 JD 查重，返回命中岗位卡的 id；未命中返回 None。

    仅提示不拦截——前端据此弹确认「继续这个机会 / 仍然新建」。
    """
    normalized = normalize_jd_text(jd_text)
    if not normalized:
        return None
    job_id = (
        await db.execute(
            select(Job.id).where(
                Job.user_id == user_id, Job.jd_text == normalized
            )
        )
    ).scalar_one_or_none()
    return job_id


async def get_job_aggregates(db: AsyncSession, job_id: str) -> dict:
    """聚合单张岗位卡的子记录统计，供列表/详情返回，避免 N+1。

    返回：cover_letter_count、derived_count、last_activity_at、latest_acceptance。
    last_activity_at 取子记录最大 created_at，无子记录时用岗位卡 updated_at。
    """
    cl_count = (
        await db.execute(
            select(func.count())
            .select_from(CoverLetter)
            .where(CoverLetter.job_id == job_id)
        )
    ).scalar_one() or 0

    dr_rows = (
        await db.execute(
            select(func.count(), func.max(DerivedResume.created_at))
            .select_from(DerivedResume)
            .where(DerivedResume.job_id == job_id)
        )
    ).first()
    dr_count = dr_rows[0] or 0
    dr_max_created = dr_rows[1]

    cl_max_created = (
        await db.execute(
            select(func.max(CoverLetter.created_at)).where(
                CoverLetter.job_id == job_id
            )
        )
    ).scalar_one_or_none()

    # 最近活跃：子记录最大 created_at；都没有则用岗位卡自身（调用方传入 job）
    last_activity_at: datetime | None = None
    candidates = [c for c in (dr_max_created, cl_max_created) if c is not None]
    if candidates:
        last_activity_at = max(candidates)  # type: ignore[arg-type]

    latest_acceptance = (
        await db.execute(
            select(func.count())
            .select_from(DerivedResume)
            .where(DerivedResume.job_id == job_id, DerivedResume.accepted == True)  # noqa: E712
        )
    ).scalar_one() or 0

    return {
        "cover_letter_count": int(cl_count),
        "derived_count": int(dr_count),
        "last_activity_at": last_activity_at.isoformat() if last_activity_at else None,
        "latest_acceptance": int(latest_acceptance) > 0,
    }
