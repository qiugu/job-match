from pathlib import Path
import os
import subprocess

import pytest


WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "deploy.yml"


def test_deploy_workflow_supports_a_nearby_registry_without_breaking_ghcr_default():
    text = WORKFLOW.read_text()

    assert "DEPLOY_IMAGE_REGISTRY" in text
    assert "ghcr.io" in text
    assert "DEPLOY_IMAGE_REPOSITORY" in text
    assert "DEPLOY_REGISTRY_USERNAME" in text
    assert "DEPLOY_REGISTRY_PASSWORD" in text


def test_deploy_workflow_pulls_both_images_concurrently_and_reports_transfer_metrics():
    text = WORKFLOW.read_text()

    assert "backend_pid=$!" in text
    assert "frontend_pid=$!" in text
    assert 'wait "$backend_pid"' in text
    assert 'wait "$frontend_pid"' in text
    assert "docker image inspect" in text
    assert "date +%s" in text


def test_backend_build_persists_buildkit_mounts_for_playwright_cache():
    text = WORKFLOW.read_text()

    assert "actions/cache@v4" in text
    assert "reproducible-containers/buildkit-cache-dance@v3" in text
    assert "path: .buildkit-cache" in text
    assert "cache-dir: .buildkit-cache" in text
    assert "matrix.image == 'backend'" in text


@pytest.mark.parametrize(
    ("failures", "failure_code", "expected_attempts", "succeeds"),
    [(0, 1, 1, True), (1, 1, 2, True), (1, 124, 2, True), (99, 1, 3, False)],
)
def test_remote_pull_retries_are_bounded_and_failed_images_are_not_deployed(
    tmp_path, failures, failure_code, expected_attempts, succeeds
):
    # Execute the actual remote script; replace only external Docker/network/time
    # operations, so retry flow, waits and deployment gating are exercised by Bash.
    text = WORKFLOW.read_text()
    remote = text.split("<<'REMOTE'\n", 1)[1].split("\n          REMOTE", 1)[0]
    harness = r'''
set -euo pipefail
docker() {
    printf '%s\n' "$*" >> "$TEST_DIR/commands"
    if [[ "$1" == pull ]]; then
        local name="${2##*/}" count=0
        if [[ -f "$TEST_DIR/$name" ]]; then
            read -r count < "$TEST_DIR/$name"
        fi
        count=$((count + 1))
        printf '%s\n' "$count" > "$TEST_DIR/$name"
        # One image fails while the other succeeds: neither may be deployed.
        if [[ "$name" == backend ]] && (( count <= FAILURES )); then
            return "$FAILURE_CODE"
        fi
    fi
}
timeout() {
    printf '%s\n' "$*" >> "$TEST_DIR/timeouts"
        [[ "$1" == --signal=TERM && "$2" == --kill-after=10s && "$3" == 2m ]] || return 99
    shift 3
    "$@"
}
sleep() { :; }
'''
    result = subprocess.run(
        ["bash", "-s", "--", "example/backend", "example/frontend"],
        input=harness + remote,
        text=True,
        capture_output=True,
        timeout=5,
        env={
            **os.environ,
            "TEST_DIR": str(tmp_path),
            "FAILURES": str(failures),
            "FAILURE_CODE": str(failure_code),
        },
    )

    assert (result.returncode == 0) is succeeds, result.stderr
    assert int((tmp_path / "backend").read_text()) == expected_attempts
    assert int((tmp_path / "frontend").read_text()) == 1
    commands = (tmp_path / "commands").read_text().splitlines()
    tags = [command for command in commands if command.startswith("tag ")]
    assert len(tags) == (2 if succeeds else 0)
    assert (tmp_path / "timeouts").exists(), "Every pull must have a deadline"
    assert len((tmp_path / "timeouts").read_text().splitlines()) == expected_attempts + 1
    assert "METRIC image=frontend pull_seconds=" in result.stdout
