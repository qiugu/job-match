from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_playwright_browser_download_uses_a_persistent_buildkit_cache():
    dockerfile = (ROOT / "Dockerfile").read_text()

    assert "target=/root/.cache/ms-playwright" in dockerfile
    assert "id=playwright-browsers" in dockerfile
    assert "PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright" in dockerfile
    # The cache mount is not part of the resulting image, so the installed
    # browser must be copied to a stable runtime path in the same layer.
    assert "cp -a /root/.cache/ms-playwright/. /ms-playwright/" in dockerfile
    assert "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright" in dockerfile
