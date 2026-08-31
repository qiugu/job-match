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
    
# 简历匹配结果
class MatchResult(BaseModel):
    role: str = Field(description="岗位角色")
    score: float = Field(ge=0, le=1, description="匹配得分")
    requirements: List[MatchItem] = Field(description="匹配项列表")
    cover_letter: Optional[str] = Field(default=None, description="打招呼话术")
    summary: str = Field(description="总结摘要建议")
    
# langgraph state
class AgentState(TypedDict, total=False):
    resume_text: str
    resume_match_results: MatchResult
    jd_text: str
    jd_analyze_results: JDAnalysis
    markdown_content: str
    with_cover_letter: bool
    keywords: list[str]
    cover_letter: str
    error: str
