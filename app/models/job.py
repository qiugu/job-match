"""岗位卡（Job Tracking）模型：以 JD 为中心的「机会容器」。

话术（cover_letters）与匹配结果（derived_resumes）通过可空外键 job_id 归属某张岗位卡；
删除岗位卡（默认）仅把子记录 job_id 置空（SET NULL），话术/匹配作为用户资产仍保留可查。
本表不持有任何 LLM 产出，仅是「组织视图」的容器。

状态机见 JOB_STATUSES（V2 操作驱动，4 态，删除 replied）：
- greeting_sent：生成打招呼话术时自动进入（默认态；新建卡的首动作若是匹配则直接 resume_ready）
- resume_ready：任何一次成功生成定制简历（DerivedResume 落库）即自动推进（生成即触发，
  不再等「接受」；「接受」仅是把结果另存为我的简历资产，与阶段解耦）
- applied：用户手动确认「投递成功」（仅允许从 resume_ready 确认）
- closed：用户手动确认「失败/放弃」归档（从任意活跃态可进入；可重新开启）

推进规则（集中在 app/services/job.py 的 promote_for_action）：
- 只前进不回退；applied/closed 不被内容操作覆盖；删光子记录不自动回退；
- closed 视为终态，但新的内容操作（生成话术/简历）视为「重新激活」信号，
  按动作语义回到对应阶段（有简历则回到 resume_ready）。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Text, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _id() -> str:
    return uuid.uuid4().hex


# 岗位状态枚举（常量集中定义，供 schema / API 白名单校验与前端映射复用）。
# 与前端岗位页 src/components/jobs/ 的状态映射保持一致。
JOB_STATUSES: tuple[str, ...] = (
    "greeting_sent",  # 已打招呼 · 待回复（默认态）
    "resume_ready",  # 已定制简历 · 待投递
    "applied",  # 已投递
    "closed",  # 已结束（归档）
)

# 默认态：生成打招呼话术时建卡即进入此状态。
JOB_STATUS_DEFAULT = "greeting_sent"

# 已定制简历阶段：生成定制简历即自动推进到的状态。
JOB_STATUS_RESUME_READY = "resume_ready"

# 用户手动确认的终态。
JOB_STATUS_APPLIED = "applied"
JOB_STATUS_CLOSED = "closed"

# 内容操作可自动推进到的活跃态（applied/closed 只能手动确认进入）。
JOB_STATUS_ACTIVE = ("greeting_sent", "resume_ready")


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    # 归属用户（与项目其他 user_id 一致：String(32)，可空默认空串表示无归属）
    user_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    # 归一化后的 JD 原文（创建时 trim + 折叠空白换行），供查重与快照
    jd_text: Mapped[str] = mapped_column(Text, default="")
    # 岗位名：创建时取 jd 首行截断 40 字兜底，可 PATCH 改名
    title: Mapped[str] = mapped_column(String(255), default="")
    # 公司名：MVP 不自动提取，留空 + 可 PATCH
    company: Mapped[str] = mapped_column(String(255), default="")
    # 状态：见 JOB_STATUSES
    status: Mapped[str] = mapped_column(
        String(32), default=JOB_STATUS_DEFAULT, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
