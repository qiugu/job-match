# Optimize Server Image Pull Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce deployment time caused by the production server pulling large Docker layers over a slow path to GHCR, while making the remaining image-transfer time measurable.

**Architecture:** Keep GitHub Actions as the image builder, but make the destination registry configurable so the server can pull from a nearby registry (for example Tencent Cloud TCR) instead of hard-coding GHCR. Pull backend and frontend concurrently on the server, retain retry/resume behavior, and emit per-image elapsed time, digest, compressed size, and local size metrics so future regressions can be attributed to network, layer volume, or startup.

**Tech Stack:** GitHub Actions YAML, Docker Buildx, Docker Registry login/pull, POSIX/Bash shell, pytest static workflow checks.

## Global Constraints

- The server `.env` remains the production configuration source and must not be overwritten.
- No image secrets may be printed in workflow logs.
- The default registry remains `ghcr.io` so existing deployments continue to work before the optional nearby registry is configured.
- `docker compose up` must continue to use the locally tagged `job-matcher-backend:deploy` and `job-matcher-frontend:deploy` images.
- The deployment must fail if either parallel image pull fails.

### Task 1: Add failing checks for registry configuration and pull instrumentation

**Files:**
- Create: `tests/test_deploy_workflow.py`

**Interfaces:**
- Consumes: `.github/workflows/deploy.yml` as text.
- Produces: regression checks for the required workflow behavior before the workflow is edited.

- [x] **Step 1: Write the failing tests**

```python
from pathlib import Path


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
    assert "wait \"$backend_pid\"" in text
    assert "wait \"$frontend_pid\"" in text
    assert "docker image inspect" in text
    assert "date +%s" in text
```

- [x] **Step 2: Run the tests to verify they fail for the current workflow**

Run: `uv run pytest tests/test_deploy_workflow.py -q`

Expected: FAIL because the current workflow hard-codes `ghcr.io`, pulls images sequentially, and has no transfer metrics.

### Task 2: Make the image registry configurable and authenticate safely

**Files:**
- Modify: `.github/workflows/deploy.yml:31-55,160-217`

**Interfaces:**
- Consumes: Actions Variable `DEPLOY_IMAGE_REGISTRY` (optional), Actions Variable `DEPLOY_IMAGE_REPOSITORY` (optional), and Secrets `DEPLOY_REGISTRY_USERNAME` / `DEPLOY_REGISTRY_PASSWORD` (required only for a non-GHCR registry).
- Produces: `IMAGE_REPO` values of `<registry>/<repository>`, with GHCR using `GITHUB_ACTOR`/`GITHUB_TOKEN` and other registries using the explicit deploy credentials.

- [x] **Step 1: Add documented workflow variables and environment defaults**

Add to the workflow header:

```yaml
# Optional nearby registry configuration:
#   DEPLOY_IMAGE_REGISTRY   Actions Variable, e.g. crpi-xxx.tencentcloudcr.com
#                           (default: ghcr.io)
#   DEPLOY_IMAGE_REPOSITORY Actions Variable, e.g. job-matcher
#                           (default: owner/repository)
#   DEPLOY_REGISTRY_USERNAME / DEPLOY_REGISTRY_PASSWORD
#                           Secrets for non-GHCR registries.
```

Add to the workflow-level `env`:

```yaml
  DEPLOY_IMAGE_REGISTRY: ${{ vars.DEPLOY_IMAGE_REGISTRY || 'ghcr.io' }}
  DEPLOY_IMAGE_REPOSITORY: ${{ vars.DEPLOY_IMAGE_REPOSITORY || github.repository }}
```

- [x] **Step 2: Replace the GHCR-only login action with a conditional safe login step**

Use one shell login so the same credentials can be used by the runner and server, without echoing passwords:

```yaml
      - name: Log in to image registry
        if: ${{ github.event.inputs.no_build != 'true' }}
        env:
          IMAGE_REGISTRY: ${{ env.DEPLOY_IMAGE_REGISTRY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REGISTRY_USERNAME: ${{ secrets.DEPLOY_REGISTRY_USERNAME }}
          REGISTRY_PASSWORD: ${{ secrets.DEPLOY_REGISTRY_PASSWORD }}
        run: |
          set -euo pipefail
          if [[ "${IMAGE_REGISTRY}" == "ghcr.io" ]]; then
            REGISTRY_USERNAME="${GITHUB_ACTOR}"
            REGISTRY_PASSWORD="${GITHUB_TOKEN}"
          elif [[ -z "${REGISTRY_USERNAME}" || -z "${REGISTRY_PASSWORD}" ]]; then
            echo "::error::非 ghcr.io 注册表必须配置 DEPLOY_REGISTRY_USERNAME / DEPLOY_REGISTRY_PASSWORD" >&2
            exit 1
          fi
          printf '%s' "${REGISTRY_PASSWORD}" | docker login "${IMAGE_REGISTRY}" \
            --username "${REGISTRY_USERNAME}" --password-stdin
```

- [x] **Step 3: Change build and pull image names to use the configured registry**

In both build/pull steps, construct the repository without exposing credentials:

```bash
IMAGE_REGISTRY="${DEPLOY_IMAGE_REGISTRY%/}"
IMAGE_REPO="${IMAGE_REGISTRY}/${DEPLOY_IMAGE_REPOSITORY}"
IMAGE_REPO="${IMAGE_REPO,,}"
```

Pass the same registry credentials to the remote pull step through environment variables and `docker login --password-stdin`. Keep the existing GHCR path as the default.

### Task 3: Pull images concurrently and expose objective timing/size data

**Files:**
- Modify: `.github/workflows/deploy.yml:196-244`

**Interfaces:**
- Consumes: `BACKEND_IMAGE`, `FRONTEND_IMAGE`, and the registry credentials produced by Task 2.
- Produces: locally tagged deploy images; nonzero exit if either pull fails; logs with per-image elapsed seconds, image digest, compressed layer total, and local unpacked size.

- [x] **Step 1: Implement a timed retry helper**

Use the existing eight-attempt retry policy, but record start/end epoch seconds and print a clear metric after success:

```bash
pull_with_retry() {
  local image="$1" label="$2" attempt delay started finished
  started="$(date +%s)"
  for attempt in {1..8}; do
    echo "==> docker pull ${label} ${image}（第 ${attempt}/8 次；已完成的镜像层会复用）"
    if docker pull "$image"; then
      finished="$(date +%s)"
      echo "METRIC image=${label} pull_seconds=$((finished - started))"
      return 0
    fi
    if (( attempt < 8 )); then
      delay=$((attempt * 10))
      sleep "$delay"
    fi
  done
  echo "✗ 多次重试仍无法拉取 ${image}" >&2
  return 1
}
```

- [x] **Step 2: Start both pulls concurrently and wait for both statuses**

```bash
pull_with_retry "$backend_image" backend > /tmp/job-matcher-backend-pull.log 2>&1 &
backend_pid=$!
pull_with_retry "$frontend_image" frontend > /tmp/job-matcher-frontend-pull.log 2>&1 &
frontend_pid=$!

backend_status=0
frontend_status=0
wait "$backend_pid" || backend_status=$?
wait "$frontend_pid" || frontend_status=$?
cat /tmp/job-matcher-backend-pull.log
cat /tmp/job-matcher-frontend-pull.log
if (( backend_status != 0 || frontend_status != 0 )); then
  exit 1
fi
```

After successful waits, tag both images and print `docker image inspect` values for digest and byte size. The logs are temporary and contain no credentials.

### Task 4: Document the deployment optimization and verify it

**Files:**
- Modify: `.github/workflows/deploy.yml` (configuration comments)
- Modify: `README.md` (deployment configuration section)
- Test: `tests/test_deploy_workflow.py`

- [x] **Step 1: Run the focused regression tests**

Run: `uv run pytest tests/test_deploy_workflow.py -q`

Expected: PASS.

- [x] **Step 2: Validate workflow syntax if `actionlint` is available**

Run: `if command -v actionlint >/dev/null; then actionlint .github/workflows/deploy.yml; else echo 'actionlint not installed; skipped'; fi`

Expected: no workflow diagnostics, or an explicit skipped message.

- [x] **Step 3: Run the existing backend test suite**

Run: `uv run pytest -q`

Expected: existing tests pass; any unrelated pre-existing failure is reported separately.

- [x] **Step 4: Document the recommended production setting**

Document that the 4-hour path is expected when the server downloads large layers from GHCR over a slow route; configure a registry close to the server, set `DEPLOY_IMAGE_REGISTRY`, `DEPLOY_IMAGE_REPOSITORY`, `DEPLOY_REGISTRY_USERNAME`, and `DEPLOY_REGISTRY_PASSWORD`, then compare the emitted `METRIC` values before and after.

## Self-review

- The plan preserves GHCR as the default and therefore does not require a registry migration to merge safely.
- It addresses both likely contributors: slow registry route and sequential two-image pulls.
- It adds measurements needed to distinguish slow network transfer from image size, retries, or startup time.
- No database, application runtime, or secret-handling behavior outside deployment authentication is changed.
