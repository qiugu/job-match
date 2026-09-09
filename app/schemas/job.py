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
