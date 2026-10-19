"""Exercise SSH image fallback without contacting Docker or a production host."""

import os
from pathlib import Path
import subprocess

import pytest


SCRIPT = Path(__file__).parents[1] / ".github/scripts/transfer-images.sh"


@pytest.mark.parametrize("transfer_fails", [False, True])
def test_ssh_transfer_retries_and_only_loads_a_complete_archive(tmp_path, transfer_fails):
    binaries = tmp_path / "bin"
    binaries.mkdir()
    # All dependencies are isolated at the command boundary. The production Bash
    # script still controls downloads, archive creation, transfer retries and load.
    stub = r'''#!/bin/bash
set -euo pipefail
name="${0##*/}"
printf '%s %s\n' "$name" "$*" >> "$TEST_DIR/commands"
case "$name" in
    timeout)
        shift 3
        exec "$@"
        ;;
    docker)
        if [[ "$1" == save ]]; then printf 'image archive'; fi
        ;;
    rsync)
        count=0
        if [[ -f "$TEST_DIR/attempts" ]]; then read -r count < "$TEST_DIR/attempts"; fi
        count=$((count + 1))
        printf '%s\n' "$count" > "$TEST_DIR/attempts"
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
    for command in ("timeout", "docker", "rsync", "ssh", "sleep"):
        path = binaries / command
        path.write_text(stub)
        path.chmod(0o755)

    result = subprocess.run(
        ["bash", str(SCRIPT), "registry/backend:sha", "registry/frontend:sha"],
        text=True,
        capture_output=True,
        timeout=5,
        env={
            **os.environ,
            "PATH": f"{binaries}:{os.environ['PATH']}",
            "TEST_DIR": str(tmp_path),
            "RUNNER_TEMP": str(tmp_path),
            "REMOTE_DEPLOY_TARGET": "deploy@example.com:/srv/job match",
            "TRANSFER_FAILS": "1" if transfer_fails else "0",
        },
    )
    assert (result.returncode == 0) is (not transfer_fails), result.stderr
    assert int((tmp_path / "attempts").read_text()) == (3 if transfer_fails else 2)
    assert (tmp_path / "remote-script").exists() is (not transfer_fails)
    assert not list(tmp_path.glob("jobmatch-images.*")), "Local archive must be cleaned up"
    commands = (tmp_path / "commands").read_text()
    assert "--partial --append-verify" in commands
    assert "docker pull registry/backend:sha" in commands
    assert "docker pull registry/frontend:sha" in commands
    if not transfer_fails:
        assert "METRIC image_transfer=ssh" in result.stdout


@pytest.mark.parametrize("fail_operation", ["", "load", "image"])
def test_remote_load_validates_images_before_changing_deployment_tags(tmp_path, fail_operation):
    remote = SCRIPT.read_text().split("<<'REMOTE_LOAD'\n", 1)[1].split("\nREMOTE_LOAD", 1)[0]
    archive = tmp_path / "archive.tar.gz"
    archive.write_bytes(b"test archive")
    harness = r'''
timeout() { shift 3; "$@"; }
docker() {
    printf '%s\n' "$*" >> "$TEST_DIR/commands"
    if [[ "$1" == "$FAIL_OPERATION" ]]; then return 1; fi
}
'''
    result = subprocess.run(
        ["bash", "-s", "--", str(archive), "registry/backend:sha", "registry/frontend:sha"],
        input=harness + remote,
        text=True,
        capture_output=True,
        timeout=5,
        env={**os.environ, "TEST_DIR": str(tmp_path), "FAIL_OPERATION": fail_operation},
    )
    assert (result.returncode == 0) is (fail_operation == ""), result.stderr
    commands = (tmp_path / "commands").read_text().splitlines()
    assert len([c for c in commands if c.startswith("tag ")]) == (0 if fail_operation else 2)
    assert not archive.exists(), "Remote archive must be cleaned up on success and failure"
