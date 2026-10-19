"""投递统计聚合（Delivery Analytics）。

数据来源：`job_status_events` 状态事件台账（append-only）。
不用 `jobs.updated_at` 作时间基准——它会被改标题/公司等元数据编辑覆盖，
用它分日聚合会让历史图表随编辑漂移（详见 app/models/job_event.py）。

口径声明（完整版见 docs/ANALYTICS.md）：

- **范围**：恒为「当前存在的岗位卡」。事件随卡删除而清理，未归类（job_id 为空）
  的话术/简历不计入，因此本页数字与「我的投递」列表页一致。
- **日历日**：按调用方传入的 `tz_offset` 折算为用户本地日再分桶。库里存的是
  UTC naive，必须先加偏移再取日期，否则「UTC 23:30 投的简历」会落到前一天。
- **漏斗 / 存量分布**：按所选区间内新建岗位的 cohort 统计；漏斗仍是累计到达口径，
  某级计数 = 该 cohort 中曾达到该级或更后一级的卡数，因此漏斗必单调不增。
  这样切换 7/30/90 天时，转化漏斗与状态分布会和当前分析区间一致。
  `closed` 是终态分支而非漏斗级，不计入。
- **回填数据**：`source == "backfill"` 的事件由迁移按 `updated_at` 近似重建，
  其日期不精确；对应日期在 `daily[].backfill` 标为 true，前端以斜纹区分。
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cover_letter import CoverLetter
from app.models.derived_resume import DerivedResume
from app.models.job import (
    JOB_STATUSES,
    JOB_STATUS_ACTIVE,
    JOB_STATUS_APPLIED,
    JOB_STATUS_CLOSED,
    Job,
)
from app.models.job_event import EVENT_SOURCE_BACKFILL, JobStatusEvent

# ---- 参数白名单 ----
# 允许的统计区间（天）。非白名单值 clamp 到最近的合法值，上限 365 防滥用。
ALLOWED_DAYS: tuple[int, ...] = (7, 14, 30, 90, 180, 365)
# 时区偏移（分钟）：UTC-12 ~ UTC+14
MIN_TZ_OFFSET = -720
MAX_TZ_OFFSET = 840
# 缺省 UTC+8（主要用户群）
DEFAULT_TZ_OFFSET = 480

# 阶段等级：与 app/services/job.py::_STATUS_RANK 同源语义（漏斗累计到达判定用）。
# 只列可累进的阶段；closed 不在其中（终态分支）。
_STAGE_RANK: dict[str, int] = {
    "greeting_sent": 0,
    "resume_ready": 1,
    "applied": 2,
}


def _utc_naive(value: datetime | None) -> datetime:
    """将模型时间归一为事件表使用的 UTC naive 时间。"""
    if value is None:
        return datetime.now(timezone.utc).replace(tzinfo=None)
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def clamp_days(days: int) -> int:
    """把区间天数收敛到 ALLOWED_DAYS。

    非白名单值取「最近的合法值」，等距时取较大者（如 60 → 30 与 90 等距 → 取 90）。
    非法输入（非正数）回落到最小的 7。
    """
    if days in ALLOWED_DAYS:
        return days
    if days <= 0:
        return ALLOWED_DAYS[0]
    return min(ALLOWED_DAYS, key=lambda d: (abs(d - days), -d))


def clamp_tz_offset(minutes: int) -> int:
    """把时区偏移收敛到 [-720, 840] 分钟。"""
    return max(MIN_TZ_OFFSET, min(MAX_TZ_OFFSET, minutes))


def _rate(numerator: int, denominator: int) -> float:
    """比例计算，分母为 0 时返回 0.0（避免前端拿到 NaN）。"""
    if denominator <= 0:
        return 0.0
    return round(numerator / denominator, 4)


def _round1(value: float | None) -> float | None:
    return None if value is None else round(value, 1)


def _consecutive(flags: list[bool]) -> tuple[int, int]:
    """输入按时间升序的「当日是否达标」序列，返回 (当前连续, 最长连续)。

    当前连续：以序列末尾起向前的最长连续 True。
    """
    best = 0
    run = 0
    for f in flags:
        run = run + 1 if f else 0
        best = max(best, run)
    current = 0
    for f in reversed(flags):
        if f:
            current += 1
        else:
            break
    return current, best


async def compute_job_stats(
    db: AsyncSession, user_id: str, days: int = 30, tz_offset: int = DEFAULT_TZ_OFFSET
) -> dict:
    """聚合当前用户的投递统计，返回可被 Pydantic schema 直接校验的 dict。"""
    days = clamp_days(days)
    tz_offset = clamp_tz_offset(tz_offset)
    offset = timedelta(minutes=tz_offset)

    # 库里存 UTC naive；先折算到本地再取日历日
    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    end_date = (now_utc + offset).date()
    start_date = end_date - timedelta(days=days - 1)
    # 时间窗（闭开区间 [start 00:00 本地, end+1 00:00 本地) 的 UTC 边界）
    window_start_utc = datetime.combine(start_date, time.min) - offset
    window_end_utc = datetime.combine(end_date + timedelta(days=1), time.min) - offset

    rows = (await db.execute(select(Job).where(Job.user_id == user_id))).scalars().all()

    # 事件全量取（仅需要的列，不加载 ORM 对象）。
    # 为何不按窗口过滤：漏斗「累计到达」与「投递周期」需要窗口之前的事件，
    # 否则跨过区间起点的卡会被算成未投递。单用户事件量为百级，全量可控。
    event_rows = (
        await db.execute(
            select(
                JobStatusEvent.job_id,
                JobStatusEvent.from_status,
                JobStatusEvent.to_status,
                JobStatusEvent.source,
                JobStatusEvent.occurred_at,
            ).where(JobStatusEvent.user_id == user_id)
        )
    ).all()

    # 理想情况下，所有状态都由 transition() 记账；但历史库、手工导入或旧版本
    # 直接更新 jobs.status 的数据可能只有岗位当前状态，没有完整事件链。统计页不能
    # 因为台账缺一条就把整张卡显示成 0，因此只对「当前岗位缺失的事件」做内存中的
    # 近似回填。标记为 backfill，沿用迁移回填的可信度提示，不伪装成精确事实。
    rows_by_id = {job.id: job for job in rows}
    events_by_job: dict[str, list[tuple]] = {}
    for row in event_rows:
        events_by_job.setdefault(row[0], []).append(row)

    for job_id, job in rows_by_id.items():
        job_events = events_by_job.setdefault(job_id, [])
        has_create = any(row[1] is None for row in job_events)
        max_rank = max(
            (_STAGE_RANK.get(row[2], -1) for row in job_events),
            default=-1,
        )

        if not has_create:
            row = (
                job_id,
                None,
                "greeting_sent",
                EVENT_SOURCE_BACKFILL,
                _utc_naive(job.created_at or job.updated_at),
            )
            event_rows.append(row)
            job_events.append(row)

        target = job.status
        target_rank = _STAGE_RANK.get(target)
        if target_rank is not None and max_rank < target_rank:
            previous = next(
                (
                    status
                    for status, rank in _STAGE_RANK.items()
                    if rank == max_rank
                ),
                "greeting_sent",
            )
            row = (
                job_id,
                previous,
                target,
                EVENT_SOURCE_BACKFILL,
                _utc_naive(job.updated_at or job.created_at),
            )
            event_rows.append(row)
            job_events.append(row)
            max_rank = target_rank

        if target == JOB_STATUS_CLOSED and not any(
            row[2] == JOB_STATUS_CLOSED for row in job_events
        ):
            previous = next(
                (
                    status
                    for status, rank in _STAGE_RANK.items()
                    if rank == max_rank
                ),
                "greeting_sent",
            )
            row = (
                job_id,
                previous,
                JOB_STATUS_CLOSED,
                EVENT_SOURCE_BACKFILL,
                _utc_naive(job.updated_at or job.created_at),
            )
            event_rows.append(row)
            job_events.append(row)

    # 按卡聚合：首次建卡时刻、曾达到的最高阶段、首次投递时刻
    first_create_at: dict[str, datetime] = {}
    first_applied_at: dict[str, datetime] = {}
    max_rank: dict[str, int] = {}
    applied_ever_ids: set[str] = set()
    closed_ever_ids: set[str] = set()
    # 含回填事件的卡：其日期为近似值，用于前端提示「数据可信度」
    backfilled_ids: set[str] = set()

    # 区间内分桶
    ordered_dates = [start_date + timedelta(days=i) for i in range(days)]
    daily: dict[date, dict] = {
        d: {
            "date": d.isoformat(),
            "created": 0,
            "greeting": 0,
            "resume_ready": 0,
            "applied": 0,
            "closed": 0,
            "backfill": False,
        }
        for d in ordered_dates
    }
    weekday = [0] * 7

    for job_id, from_status, to_status, source, occurred_at in event_rows:
        # ---- 全量口径聚合 ----
        if source == EVENT_SOURCE_BACKFILL:
            # 回填卡与区间无关，故置于分桶逻辑之前统计
            backfilled_ids.add(job_id)
        if from_status is None:
            prev = first_create_at.get(job_id)
            if prev is None or occurred_at < prev:
                first_create_at[job_id] = occurred_at
        rank = _STAGE_RANK.get(to_status)
        if rank is not None and rank > max_rank.get(job_id, -1):
            max_rank[job_id] = rank
        if to_status == JOB_STATUS_APPLIED:
            applied_ever_ids.add(job_id)
            prev_a = first_applied_at.get(job_id)
            if prev_a is None or occurred_at < prev_a:
                first_applied_at[job_id] = occurred_at
        elif to_status == JOB_STATUS_CLOSED:
            closed_ever_ids.add(job_id)

        # ---- 区间分桶 ----
        local_date = (occurred_at + offset).date()
        bucket = daily.get(local_date)
        if bucket is None:
            continue
        if source == EVENT_SOURCE_BACKFILL:
            bucket["backfill"] = True
        if from_status is None:
            # 建卡事件：只计入 created，不再计入 greeting/resume_ready（避免双计）
            bucket["created"] += 1
        elif to_status == "greeting_sent":
            bucket["greeting"] += 1
        elif to_status == "resume_ready":
            bucket["resume_ready"] += 1
        elif to_status == "applied":
            bucket["applied"] += 1
            weekday[local_date.weekday()] += 1
        elif to_status == "closed":
            bucket["closed"] += 1

    daily_list = [daily[d] for d in ordered_dates]

    # 统计页的 cohort 以「区间内新建」为边界。事件表是唯一可靠的建卡时间来源，
    # 同一张卡后续状态事件即使落在更晚区间，也仍归属于它首次出现的 cohort。
    current_job_ids = {j.id for j in rows}
    cohort_job_ids = {
        job_id
        for job_id, created_at in first_create_at.items()
        if job_id in current_job_ids
        and window_start_utc <= created_at < window_end_utc
    }
    cohort_jobs = len(cohort_job_ids)

    # ---- 存量状态分布（所选 cohort 在当前时刻的状态） ----
    status_distribution = {s: 0 for s in JOB_STATUSES}
    for j in rows:
        if j.id not in cohort_job_ids:
            continue
        if j.status in status_distribution:
            status_distribution[j.status] += 1
        else:  # 防御：未知状态归入默认态，避免口径漏计
            status_distribution[JOB_STATUSES[0]] += 1

    total_jobs = len(rows)
    active = sum(
        1 for j in rows if j.status in JOB_STATUS_ACTIVE
    )
    active_now = sum(
        1
        for j in rows
        if j.id in cohort_job_ids and j.status in JOB_STATUS_ACTIVE
    )
    applied_now = status_distribution.get(JOB_STATUS_APPLIED, 0)
    closed_now = status_distribution.get(JOB_STATUS_CLOSED, 0)
    applied_ever = len(applied_ever_ids)

    # ---- 漏斗：cohort 内累计到达（单调不增） ----
    # 某卡达到的阶段 = 其事件中出现过的最高阶段；无事件时回落到当前状态。
    reached_rank: dict[str, int] = {}
    for j in rows:
        if j.id not in cohort_job_ids:
            continue
        r = max_rank.get(j.id)
        if r is None:
            r = _STAGE_RANK.get(j.status, 0)
        reached_rank[j.id] = r
    funnel_spec = (
        ("created", None),  # 全部岗位卡
        ("resume_ready", 1),
        ("applied", 2),
    )
    funnel = []
    for key, threshold in funnel_spec:
        if threshold is None:
            count = cohort_jobs
        else:
            count = sum(1 for r in reached_rank.values() if r >= threshold)
        funnel.append({"key": key, "count": count, "rate": _rate(count, cohort_jobs)})

    # ---- 产出计数（仅统计挂在现存岗位卡上的产出） ----
    cover_letters = 0
    cover_letter_jobs = 0
    derived_resumes = 0
    if total_jobs:
        cover_letters = int(
            (
                await db.execute(
                    select(func.count())
                    .select_from(CoverLetter)
                    .where(
                        CoverLetter.user_id == user_id,
                        CoverLetter.job_id.isnot(None),
                    )
                )
            ).scalar_one()
            or 0
        )
        cover_letter_jobs = int(
            (
                await db.execute(
                    select(func.count(distinct(CoverLetter.job_id))).where(
                        CoverLetter.user_id == user_id,
                        CoverLetter.job_id.isnot(None),
                    )
                )
            ).scalar_one()
            or 0
        )
        derived_resumes = int(
            (
                await db.execute(
                    select(func.count())
                    .select_from(DerivedResume)
                    .where(
                        DerivedResume.user_id == user_id,
                        DerivedResume.job_id.isnot(None),
                    )
                )
            ).scalar_one()
            or 0
        )

    # ---- 投递周期：建卡 → 首次确认投递 ----
    durations: list[float] = []
    for job_id, applied_at in first_applied_at.items():
        created_at = first_create_at.get(job_id)
        if created_at is None:
            continue
        durations.append(
            (applied_at - created_at).total_seconds() / 86400.0
        )
    avg_days_to_apply = (
        _round1(sum(durations) / len(durations)) if durations else None
    )

    # ---- 连续投递（以区间最后一天为锚，今天或昨天有投递才算延续） ----
    applied_flags = [daily[d]["applied"] > 0 for d in ordered_dates]
    if applied_flags and not applied_flags[-1] and len(applied_flags) >= 2:
        applied_flags = applied_flags[:-1]  # 今天尚未投递：允许以昨天为终点
    streak_current, streak_best = _consecutive(applied_flags)

    applied_in_range = sum(d["applied"] for d in daily_list)
    created_in_range = sum(d["created"] for d in daily_list)
    closed_in_range = sum(d["closed"] for d in daily_list)

    return {
        "range": {
            "days": days,
            "start": start_date.isoformat(),
            "end": end_date.isoformat(),
            "tz_offset": tz_offset,
        },
        "totals": {
            "jobs": total_jobs,
            "active": active,
            "active_now": active_now,
            "applied_now": applied_now,
            "closed_now": closed_now,
            "applied_ever": applied_ever,
            "closed_ever": len(closed_ever_ids),
            "applied_in_range": applied_in_range,
            "created_in_range": created_in_range,
            "closed_in_range": closed_in_range,
            "applied_rate": _rate(applied_ever, total_jobs),
            "avg_days_to_apply": avg_days_to_apply,
            "avg_derived_per_applied": (
                _round1(derived_resumes / applied_ever) if applied_ever else None
            ),
            "cover_letters": cover_letters,
            "cover_letter_jobs": cover_letter_jobs,
            "derived_resumes": derived_resumes,
            # 日期为近似值（迁移按 updated_at 回填）的岗位卡数；>0 时前端提示可信度
            "backfilled_jobs": len(backfilled_ids),
        },
        "status_distribution": status_distribution,
        "funnel": funnel,
        "daily": daily_list,
        "weekday": weekday,
        "streak": {"current": streak_current, "best": streak_best},
    }
