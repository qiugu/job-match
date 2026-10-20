from pathlib import Path


WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "deploy.yml"


def test_deploy_workflow_builds_images_on_server_without_registry_or_archives():
    text = WORKFLOW.read_text()

    assert "\njobs:\n  deploy:" in text
    assert "Build images on remote" in text
    assert "docker compose --project-directory ${RP} build backend" in text
    assert "docker compose --project-directory ${RP} build frontend" in text
    assert "actions/upload-artifact@v4" not in text
    assert "actions/download-artifact@v4" not in text
    assert "Transfer images over SSH" not in text
    assert "docker save" not in text
    assert "docker pull" not in text


def test_remote_build_reuses_docker_layers_for_playwright_cache():
    text = WORKFLOW.read_text()

    assert "复用 Docker 层缓存" in text
    assert "docker compose --project-directory ${RP} down --remove-orphans" in text
    assert "docker compose --project-directory ${RP} build backend" in text
    assert "docker compose --project-directory ${RP} build frontend" in text


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


def test_deploy_builds_images_on_server_and_does_not_transfer_archives():
    text = WORKFLOW.read_text()

    assert "Build images on remote" in text
    assert "docker compose --project-directory ${RP} build backend" in text
    assert "docker compose --project-directory ${RP} build frontend" in text
    assert "Transfer images over SSH" not in text
    assert "docker save \"$IMAGE_TAG\"" not in text
