"""求职信模型：约 200 字纯文本，关联衍生简历。"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Text, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _id() -> str:
    return uuid.uuid4().hex


class CoverLetter(Base):
    __tablename__ = "cover_letters"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    derived_resume_id: Mapped[str] = mapped_column(
        ForeignKey("derived_resumes.id", ondelete="CASCADE")
    )
    content: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    derived: Mapped["DerivedResume"] = relationship(back_populates="cover_letter")
