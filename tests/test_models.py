"""模型属性测试：User 角色/积分属性，DerivedResume 接受幂等字段。"""

from app.core.timeutils import utcnow
from app.models.derived_resume import DerivedResume
from app.models.master_resume import MasterResume
from app.models.user import User


def _user(role: str = "user", credits: int = 50) -> User:
    return User(
        id="u1",
        username="tester",
        nickname="tester",
        password_hash="x",
        token_version=1,
        role=role,
        credits=credits,
        registered_code="",
    )


def test_user_is_admin():
    assert _user(role="admin").is_admin is True
    assert _user(role="user").is_admin is False


def test_user_unlimited_credits():
    # 负余额表示无限制
    assert _user(credits=-1).unlimited_credits is True
    # 管理员无限制
    assert _user(role="admin", credits=0).unlimited_credits is True
    # 普通正余额账号受限制
    assert _user(credits=0).unlimited_credits is False
    assert _user(credits=50).unlimited_credits is False


def test_derived_resume_accept_idempotency_field_present():
    dr = DerivedResume(
        id="d1",
        user_id="u1",
        title="T",
        markdown_content="# x",
        accepted_master_id=None,
    )
    assert dr.accepted_master_id is None


def test_master_resume_no_structured_json_field():
    mr = MasterResume(
        id="m1",
        user_id="u1",
        title="Resume",
        raw_text="raw",
        markdown_content="# md",
    )
    # 确认没有 master_json 残留字段（迁移已改名）
    assert not hasattr(mr, "master_json")
    assert mr.markdown_content == "# md"
