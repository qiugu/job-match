from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_playwright_browser_download_uses_a_persistent_buildkit_cache():
    dockerfile = (ROOT / "Dockerfile").read_text()

    assert "target=/root/.cache/ms-playwright" in dockerfile
    assert "id=playwright-browsers" in dockerfile
    assert "PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright" in dockerfile
    # Copy only the revisions required by this Playwright version. Copying the
    # whole persistent cache can embed stale Chromium revisions in every image.
    assert "install --dry-run --only-shell chromium" in dockerfile
    assert "required_browser_dirs" in dockerfile
    assert "cp -a \"$browser_dir\" /ms-playwright/" in dockerfile
    assert "cp -a /root/.cache/ms-playwright/. /ms-playwright/" not in dockerfile
    assert "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright" in dockerfile
