from enum import Enum
from pydantic import BaseModel, Field
from typing import List, Literal, Optional
from typing_extensions import TypedDict
from langchain.messages import AnyMessage

# JD 分析结果
class JDAnalysis(BaseModel):
    experiences: List[str] = Field(description="行业经验")
    hard_skills: List[str] = Field(description="技术栈")
    soft_skills: List[str] = Field(description="软技能")
    plus: List[str] = Field(description="加分项")
    rigid: List[str] = Field(description="硬性要求")
    
# 基于源简历的匹配项
class MatchItem(BaseModel):
    requirement: str = Field(description="要求项")
    evidence: str = Field(description="匹配要求项的证据")
    strength: Literal["matched", "weak", "missing", "unspported"] = Field(
        description="匹配的级别，matched:完全匹配；weak:弱匹配；missing:不匹配；unspported:不支持"
    )
    suggestion: str = Field(description="优化建议")
    
# 简历匹配结果（不含话术：话术已解耦为独立链路）
class MatchResult(BaseModel):
    role: str = Field(description="岗位角色")
    score: float = Field(ge=0, le=1, description="匹配得分")
    requirements: List[MatchItem] = Field(description="匹配项列表")
    summary: str = Field(description="总结摘要建议")


# 话术生成请求（独立链路，输入仅 resume + jd + scene）
class CoverLetterRequest(BaseModel):
    resume_text: str = Field(description="简历文本")
    jd_text: str = Field(description="岗位描述")
    scene: str = Field(default="greeting", description="场景：greeting/followup/interview")
    derived_resume_id: Optional[str] = Field(default=None, description="关联衍生简历 id（可选）")


# 话术生成结果
class CoverLetterResult(BaseModel):
    id: str
    content: str
    scene: str
    model: str
    created_at: str
    updated_at: str
    # 归属岗位卡 id（写链路自动挂载；未命中历史/未开启时为 null）
    job_id: Optional[str] = None
    # 本次「生成 / 重生成」后剩余的匹配额度（-1 表示无限制）；
    # 非消耗型操作（列表 / 详情 / 更新 / 删除）不返回，前端据此判断是否需要刷新配额显示。
    remaining_quota: Optional[int] = Field(
        default=None,
        description="生成/重生成后剩余匹配额度（-1=无限制）；非消耗操作不返回",
    )
    
# langgraph state
class AgentState(TypedDict, total=False):
    resume_text: str
    resume_match_results: MatchResult
    jd_text: str
    jd_analyze_results: JDAnalysis
    markdown_content: str
    keywords: list[str]
    error: str
