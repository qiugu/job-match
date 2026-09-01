"""模型属性测试：User 角色/额度属性，DerivedResume 接受幂等字段。"""

from app.core.timeutils import utcnow
from app.models.derived_resume import DerivedResume
from app.models.master_resume import MasterResume
from app.models.user import User


def _user(role: str = "user", match_quota: int = 5) -> User:
    return User(
        id="u1",
        username="tester",
        nickname="tester",
        password_hash="x",
        token_version=1,
        role=role,
        match_quota=match_quota,
        registered_code="",
    )


def test_user_is_admin():
    assert _user(role="admin").is_admin is True
    assert _user(role="user").is_admin is False


def test_user_unlimited_match_quota():
    # 负额度表示无限制
    assert _user(match_quota=-1).unlimited_match_quota is True
    # 管理员无限制
    assert _user(role="admin", match_quota=0).unlimited_match_quota is True
    # 普通正额度账号受限制
    assert _user(match_quota=0).unlimited_match_quota is False
    assert _user(match_quota=5).unlimited_match_quota is False


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
