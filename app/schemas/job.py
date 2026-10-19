"""岗位卡（Job Tracking）Pydantic schema。

JobSummary：列表通用，含聚合字段（子记录计数、最近活跃、是否有已接受简历）。
  jd_text 全量返回（前端「恢复 JD 上下文」需要整段原文），不再单独区分列表/详情裁剪。
JobDetail：详情扩展——同页返回子记录（话术列表 + 衍生简历含匹配分析），
  支撑独立岗位页「JD / 话术 / 定制简历 / 匹配结果回看」一次取全，避免 N+1 请求。
JobUpdate：PATCH 语义收敛为 title/company 元数据；status 不允许再经 PATCH 直接写，
  必须走语义端点（mark / reopen），由后端做合法迁移校验（V2 操作驱动状态机）。
JobMarkPayload：用户仅有的两个手动确认——applied（投递成功，从 resume_ready 起）
  与 closed（失败/放弃归档，从任意活跃态起）。
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict


class JobSummary(BaseModel):
    id: str
    user_id: str
    title: str
    company: str
    status: str
    # 归一化后的 JD 全文（列表亦返回，供「恢复 JD 上下文」直接使用）
    jd_text: str
    created_at: str
    updated_at: str
    # 聚合字段（列表一次返回，避免 N+1）
    cover_letter_count: int = 0
    derived_count: int = 0
    last_activity_at: Optional[str] = None
    latest_acceptance: bool = False


class CoverLetterBrief(BaseModel):
    """岗位卡下的话术子记录（详情内嵌，列表 / 编辑仍走 /api/cover-letters）。"""

    id: str
    scene: str
    content: str
    created_at: str


class DerivedResumeBrief(BaseModel):
    """岗位卡下的定制简历子记录（含匹配分析回看）。"""

    id: str
    title: str
    accepted: bool
    # 匹配分析（MatchResult 结构 dict）；V2 前历史记录为 None
    analysis: Optional[dict] = None
    markdown_content: str = ""
    created_at: str


class JobDetail(JobSummary):
    """详情：在摘要基础上内嵌子记录，供岗位详情区一次渲染。"""

    cover_letters: list[CoverLetterBrief] = []
    derived_resumes: list[DerivedResumeBrief] = []


class JobUpdate(BaseModel):
    """仅可改 title / company；传 status 将因 extra=forbid 得到 422。

    状态请走语义端点：POST /api/jobs/{id}/mark（applied|closed）、
    POST /api/jobs/{id}/reopen，由后端校验合法迁移。
    """

    model_config = ConfigDict(extra="forbid")

    title: Optional[str] = None
    company: Optional[str] = None


class JobMarkPayload(BaseModel):
    """用户手动确认投递结果（V2 仅剩的两个手动状态写入）。

    - applied：投递成功。仅允许从 resume_ready 确认（须先有定制简历）。
    - closed：失败 / 放弃，归档。允许从任意活跃态进入。
    """

    outcome: Literal["applied", "closed"]


class JobDetectResponse(BaseModel):
    job_id: Optional[str] = None


# ---------- 投递统计（Delivery Analytics） ----------
# 口径与公式的权威说明见 docs/ANALYTICS.md；此处只做结构定义。
# 全部字段用 snake_case，与 JobSummary / JobDetail 保持一致，前端直接映射。


class JobStatsRange(BaseModel):
    """统计区间：按调用方时区折算后的本地日历日（闭区间 [start, end]）。"""

    days: int
    start: str  # YYYY-MM-DD（本地日）
    end: str  # YYYY-MM-DD（本地日）
    tz_offset: int  # 生效的时区偏移（分钟）


class JobStatsTotals(BaseModel):
    """汇总指标。

    `applied_now` 与 `applied_ever` 的区别是刻意的：
    - now：所选时间段新建岗位 cohort 中当前状态仍为「已投递」的卡
    - ever：全部现存岗位历史上曾确认投递过的卡（含后来归档的）
    """

    jobs: int
    active: int
    # 所选时间段新建岗位 cohort 中，当前仍处于进行中阶段的卡数
    active_now: int
    applied_now: int
    closed_now: int
    applied_ever: int
    closed_ever: int
    # 区间内发生的事件数
    applied_in_range: int
    created_in_range: int
    closed_in_range: int
    # applied_ever / jobs，0~1；分母为 0 时为 0.0
    applied_rate: float
    # 建卡 → 首次确认投递 的平均天数；无投递记录时为 None
    avg_days_to_apply: Optional[float] = None
    # 挂在现存岗位卡上的定制简历数 / applied_ever；无投递时为 None
    avg_derived_per_applied: Optional[float] = None
    # 产出计数（仅统计 job_id 非空、即挂在现存岗位卡上的产出）
    cover_letters: int
    cover_letter_jobs: int
    derived_resumes: int
    # 含回填事件（日期为近似值）的岗位卡数
    backfilled_jobs: int


class JobDailyPoint(BaseModel):
    """单日事件计数（缺日补零，保证前端图表连续）。"""

    date: str  # YYYY-MM-DD（本地日）
    created: int  # 建卡（from_status 为 NULL 的事件）
    greeting: int  # 推进到 greeting_sent（含归档卡重新激活）
    resume_ready: int  # 推进到 resume_ready
    applied: int  # 推进到 applied（= 当日确认投递数）
    closed: int  # 推进到 closed
    # 当日含迁移回填事件 ⇒ 日期为近似值，前端以斜纹底纹区分
    backfill: bool


class JobFunnelStage(BaseModel):
    """漏斗单级：累计到达口径（曾达到该级或更后一级的卡数），故必单调不增。"""

    key: str  # created | resume_ready | applied
    count: int
    rate: float  # count / jobs


class JobStreak(BaseModel):
    """连续投递天数（区间内计算；今天尚未投递时允许以昨天为终点）。"""

    current: int
    best: int


class JobStats(BaseModel):
    range: JobStatsRange
    totals: JobStatsTotals
    # 当前存量状态分布，键恒为 JOB_STATUSES 全集（缺项为 0）
    status_distribution: dict[str, int]
    funnel: list[JobFunnelStage]
    daily: list[JobDailyPoint]
    # 周一…周日 的区间内投递数（长度恒为 7）
    weekday: list[int]
    streak: JobStreak
