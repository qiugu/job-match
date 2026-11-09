"""浏览路径归一化：URL 变体必须收敛到稳定的页面标识。

单测纯函数，不依赖数据库；这是防止 locale 前缀 / 动态 ID 把 PV 口径拆散的契约。
"""
from app.services.visit_path import MAX_PATH_LENGTH, normalize_visit_path


def test_strips_locale_prefix_and_query():
    assert normalize_visit_path("/zh/app/dashboard") == "/app/dashboard"
    assert normalize_visit_path("/en/login?next=/app") == "/login"
    assert normalize_visit_path("/zh") == "/"
    assert normalize_visit_path("/en/") == "/"


def test_replaces_dynamic_segments():
    assert (
        normalize_visit_path("/app/workbench/2a0d21e84a414aaf80943e75d753ad87")
        == "/app/workbench/:id"
    )
    assert normalize_visit_path("/templates/12345") == "/templates/:id"
    assert (
        normalize_visit_path("/templates/550e8400-e29b-41d4-a716-446655440000")
        == "/templates/:id"
    )
    assert (
        normalize_visit_path("/app/workbench/2a0d21e84a414aaf80943e75d753ad87/edit")
        == "/app/workbench/:id/edit"
    )


def test_keeps_static_paths_and_normalizes_slashes():
    assert normalize_visit_path("/app/dashboard/") == "/app/dashboard"
    assert normalize_visit_path("//app///dashboard") == "/app/dashboard"
    assert normalize_visit_path("relative/path") == "/relative/path"
    assert normalize_visit_path("") == "/"


def test_truncates_to_column_width():
    assert len(normalize_visit_path("/" + "a" * 500)) == MAX_PATH_LENGTH
