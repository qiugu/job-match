"""简历数据结构定义——与前端 src/types/resume.ts 的 ResumeData 对齐。

前端 magic-resume 以该 JSON 为数据模型，后端 Agent 的输入/输出均采用此结构，
保证简历可结构化存储、衍生简历可回传前端加载进编辑器二次编辑。
"""
from __future__ import annotations

from typing import List, Optional, Dict, Any

from pydantic import BaseModel, Field


class PhotoConfig(BaseModel):
    width: float = 90
    height: float = 120
    aspectRatio: str = "1:1"
    borderRadius: str = "none"
    customBorderRadius: float = 0
    visible: bool = True


class CustomFieldType(BaseModel):
    id: str = ""
    label: str = ""
    value: str = ""
    icon: Optional[str] = None
    visible: Optional[bool] = True
    custom: Optional[bool] = None
    displayLabel: Optional[bool] = None


class BasicInfo(BaseModel):
    birthDate: str = ""
    name: str = ""
    title: str = ""
    email: str = ""
    phone: str = ""
    location: str = ""
    icons: Dict[str, str] = Field(default_factory=dict)
    employementStatus: str = ""
    photo: str = ""
    photoConfig: PhotoConfig = Field(default_factory=PhotoConfig)
    fieldOrder: Optional[List[Any]] = None
    customFields: List[CustomFieldType] = Field(default_factory=list)
    githubKey: str = ""
    githubUseName: str = ""
    githubContributionsVisible: bool = False
    layout: Optional[str] = None


class Education(BaseModel):
    id: str = ""
    school: str = ""
    major: str = ""
    degree: str = ""
    startDate: str = ""
    endDate: str = ""
    gpa: Optional[str] = None
    description: Optional[str] = None
    visible: Optional[bool] = True


class Experience(BaseModel):
    id: str = ""
    company: str = ""
    position: str = ""
    date: str = ""
    details: str = ""
    visible: Optional[bool] = True


class Skill(BaseModel):
    id: str = ""
    name: str = ""
    level: float = 0


class Project(BaseModel):
    id: str = ""
    name: str = ""
    role: str = ""
    date: str = ""
    description: str = ""
    visible: bool = True
    link: Optional[str] = None
    linkLabel: Optional[str] = None


class Certificate(BaseModel):
    id: str = ""
    url: str = ""  # Base64 或直链
    width: float = 100


class GlobalSettings(BaseModel):
    themeColor: Optional[str] = None
    fontFamily: Optional[str] = None
    baseFontSize: Optional[float] = None
    pagePadding: Optional[float] = None
    paragraphSpacing: Optional[float] = None
    lineHeight: Optional[float] = None
    sectionSpacing: Optional[float] = None
    headerSize: Optional[float] = None
    subheaderSize: Optional[float] = None
    useIconMode: Optional[bool] = None
    centerSubtitle: Optional[bool] = None
    flexibleHeaderLayout: Optional[bool] = None
    autoOnePage: Optional[bool] = None


class MenuSection(BaseModel):
    id: str = ""
    title: str = ""
    icon: str = ""
    enabled: bool = True
    order: float = 0


class CustomItem(BaseModel):
    id: str = ""
    title: str = ""
    subtitle: str = ""
    dateRange: str = ""
    description: str = ""
    visible: bool = True


class ResumeData(BaseModel):
    """与前端 ResumeData 对齐的结构化简历。"""

    id: str = ""
    title: str = ""
    createdAt: str = ""
    updatedAt: str = ""
    templateId: Optional[str] = None
    # 简历 markdown 预览文本，用于列表卡片缩略图渲染
    markdownContent: Optional[str] = None
    basic: BasicInfo = Field(default_factory=BasicInfo)
    education: List[Education] = Field(default_factory=list)
    experience: List[Experience] = Field(default_factory=list)
    projects: List[Project] = Field(default_factory=list)
    certificates: List[Certificate] = Field(default_factory=list)
    customData: Dict[str, List[CustomItem]] = Field(default_factory=dict)
    skillContent: str = ""
    selfEvaluationContent: str = ""
    activeSection: str = ""
    draggingProjectId: Optional[str] = None
    menuSections: List[MenuSection] = Field(default_factory=list)
    globalSettings: GlobalSettings = Field(default_factory=GlobalSettings)


class ResumeDataPatch(BaseModel):
    """用于前端二次编辑后回写，仅传需要更新的字段。"""

    title: Optional[str] = None
    basic: Optional[BasicInfo] = None
    education: Optional[List[Education]] = None
    experience: Optional[List[Experience]] = None
    projects: Optional[List[Project]] = None
    certificates: Optional[List[Certificate]] = None
    customData: Optional[Dict[str, List[CustomItem]]] = None
    skillContent: Optional[str] = None
    selfEvaluationContent: Optional[str] = None
    globalSettings: Optional[GlobalSettings] = None
