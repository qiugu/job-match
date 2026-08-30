"""SQLAlchemy 模型包：集中导出所有表模型，供 Alembic 与数据库初始化使用。"""
from app.models.master_resume import MasterResume
from app.models.derived_resume import DerivedResume
from app.models.cover_letter import CoverLetter

__all__ = ["MasterResume", "DerivedResume", "CoverLetter"]
