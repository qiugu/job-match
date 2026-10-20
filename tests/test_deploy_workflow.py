from pathlib import Path


WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "deploy.yml"


def test_deploy_workflow_builds_and_transfers_archives_without_registry_pulls():
    text = WORKFLOW.read_text()

    assert "load: true" in text
    assert "actions/upload-artifact@v4" in text
    assert "actions/download-artifact@v4" in text
    assert "Transfer images over SSH" in text
    assert "docker pull" not in text
    assert "DEPLOY_IMAGE_REGISTRY" not in text
    assert "DEPLOY_REGISTRY_PASSWORD" not in text


def test_backend_build_persists_buildkit_mounts_for_playwright_cache():
    text = WORKFLOW.read_text()

    assert "actions/cache@v4" in text
    assert "reproducible-containers/buildkit-cache-dance@v3" in text
    assert "path: .buildkit-cache" in text
    assert "cache-dir: .buildkit-cache" in text
    assert "matrix.image == 'backend'" in text


def test_code_upload_excludes_local_worktrees_and_has_transfer_guardrails():
    text = WORKFLOW.read_text()

    assert "--exclude '.worktrees/'" in text
    assert "--exclude '.workbuddy/'" in text
    assert "--exclude '.deploy-images/'" in text
    assert "--partial" in text
    assert "--append-verify" in text
    assert "--timeout=60" in text
    assert "--info=progress2,stats2" in text
    assert "timeout --signal=TERM --kill-after=30s 25m" in text
    assert "timeout-minutes: 180" in text
