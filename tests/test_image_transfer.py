"""Exercise SSH image artifact transfer without contacting Docker or a registry."""

import os
from pathlib import Path
import subprocess

import pytest


SCRIPT = Path(__file__).parents[1] / ".github/scripts/transfer-images.sh"
WORKFLOW = Path(__file__).parents[1] / ".github/workflows/deploy.yml"


def test_large_archive_transfer_has_a_long_hard_deadline():
    script = SCRIPT.read_text()
    workflow = WORKFLOW.read_text()

    assert "bounded 55m rsync" in script
    assert "--info=progress2,stats2" in script
    assert "--human-readable" in script
    assert "backend_pid=$!" in script
    assert "frontend_pid=$!" in script
    assert "timeout-minutes: 180" in workflow
    assert "docker pull" not in script


@pytest.mark.parametrize("transfer_fails", [False, True])
def test_ssh_transfer_retries_archives_and_only_loads_after_success(tmp_path, transfer_fails):
    binaries = tmp_path / "bin"
    binaries.mkdir()
    (tmp_path / "backend.tar.gz").write_bytes(b"backend archive")
    (tmp_path / "frontend.tar.gz").write_bytes(b"frontend archive")
    stub = r'''#!/bin/bash
set -euo pipefail
name="${0##*/}"
printf '%s %s\n' "$name" "$*" >> "$TEST_DIR/commands"
case "$name" in
    timeout)
        shift 3
        exec "$@"
        ;;
    rsync)
        label=backend
        [[ "$*" == *frontend.tar.gz* ]] && label=frontend
        attempts_file="$TEST_DIR/attempts-$label"
        count=0
        if [[ -f "$attempts_file" ]]; then read -r count < "$attempts_file"; fi
        count=$((count + 1))
        printf '%s\n' "$count" > "$attempts_file"
        if [[ "$TRANSFER_FAILS" == 1 ]] || (( count == 1 )); then exit 23; fi
        ;;
    ssh)
        if [[ "$*" == *'bash -s --'* ]]; then
            cat > "$TEST_DIR/remote-script"
        fi
        ;;
    sleep) ;;
esac
'''
    for command in ("timeout", "rsync", "ssh", "sleep"):
        path = binaries / command
        path.write_text(stub)
        path.chmod(0o755)

    result = subprocess.run(
        [
            "bash",
            str(SCRIPT),
            str(tmp_path / "backend.tar.gz"),
            str(tmp_path / "frontend.tar.gz"),
            "job-matcher-backend:sha",
            "job-matcher-frontend:sha",
        ],
        text=True,
        capture_output=True,
        timeout=5,
        env={
            **os.environ,
            "PATH": f"{binaries}:{os.environ['PATH']}",
            "TEST_DIR": str(tmp_path),
            "REMOTE_DEPLOY_TARGET": "deploy@example.com:/srv/job match",
            "TRANSFER_FAILS": "1" if transfer_fails else "0",
        },
    )
    assert (result.returncode == 0) is (not transfer_fails), result.stderr
    # Each archive retries once; the two archives are transferred concurrently.
    assert int((tmp_path / "attempts-backend").read_text()) == 2
    assert int((tmp_path / "attempts-frontend").read_text()) == 2
    assert (tmp_path / "remote-script").exists() is (not transfer_fails)
    commands = (tmp_path / "commands").read_text()
    assert "--partial --append-verify" in commands
    assert "docker pull" not in commands
    if not transfer_fails:
        assert "METRIC image_transfer=ssh" in result.stdout


@pytest.mark.parametrize("fail_operation", ["", "load", "image"])
def test_remote_load_validates_images_before_changing_deployment_tags(tmp_path, fail_operation):
    remote = SCRIPT.read_text().split("<<'REMOTE_LOAD'\n", 1)[1].split("\nREMOTE_LOAD", 1)[0]
    backend_archive = tmp_path / "backend.tar.gz"
    frontend_archive = tmp_path / "frontend.tar.gz"
    backend_archive.write_bytes(b"backend archive")
    frontend_archive.write_bytes(b"frontend archive")
    harness = r'''
timeout() { shift 3; "$@"; }
docker() {
    printf '%s\n' "$*" >> "$TEST_DIR/commands"
    if [[ "$1" == "$FAIL_OPERATION" ]]; then return 1; fi
}
'''
    result = subprocess.run(
        [
            "bash",
            "-s",
            "--",
            str(backend_archive),
            str(frontend_archive),
            "registry/backend:sha",
            "registry/frontend:sha",
        ],
        input=harness + remote,
        text=True,
        capture_output=True,
        timeout=5,
        env={**os.environ, "TEST_DIR": str(tmp_path), "FAIL_OPERATION": fail_operation},
    )
    assert (result.returncode == 0) is (fail_operation == ""), result.stderr
    commands = (tmp_path / "commands").read_text().splitlines()
    assert len([c for c in commands if c.startswith("tag ")]) == (2 if not fail_operation else 0)
