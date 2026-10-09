"""增长事件写入契约；字段固定且不接受任意属性。"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


GrowthEventName = Literal[
    "landing_view",
    "cta_click",
    "register_start",
    "register_success",
    "resume_created",
    "first_match_success",
    "session_start",
]


class GrowthEventIn(BaseModel):
    eventId: str = Field(min_length=8, max_length=64)
    eventName: GrowthEventName
    visitorId: str = Field(min_length=8, max_length=128)
    path: str = Field(default="", max_length=255)
    referrer: str = Field(default="", max_length=512)
    utmSource: str = Field(default="", max_length=128)
    utmMedium: str = Field(default="", max_length=128)
    utmCampaign: str = Field(default="", max_length=128)
