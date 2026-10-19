# SSH Image Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the images built by GitHub Actions to the production server over SSH without requiring the production server or fallback Runner path to pull from GHCR.

**Architecture:** The build job will retain each built image locally and export it as a compressed archive. A single deploy job will receive the archives as GitHub Actions artifacts and upload them to the server with resumable rsync, then run `docker load` remotely. Registry publishing remains optional for distribution/rollback, but deployment will consume the SSH-delivered images.

**Tech Stack:** GitHub Actions, Docker Buildx, Docker save/load, gzip, SSH, rsync, Docker Compose.

## Global Constraints

- Production image deployment must not execute `docker pull` against GHCR.
- SSH transfer must support partial/resumable uploads and must not expose registry credentials on the server.
- Existing no-build behavior and image tags based on `GITHUB_SHA` must remain supported.
- Workflows must remain valid YAML and shell syntax must be checked before commit.

---

### Task 1: Export build images as workflow artifacts

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [x] Add a build step after each successful `docker/build-push-action` to run `docker save <tag> | gzip -1 > $RUNNER_TEMP/<image>.tar.gz`, then upload the archive with `actions/upload-artifact@v4` using a unique artifact name per matrix image.
- [x] Keep registry publishing out of the deployment path; the artifact is produced independently of registry availability.
- [x] Update the deploy job needs/steps to download both image artifacts with `actions/download-artifact@v4` into a known directory.
- [x] Ensure the archive names and image tags are derived from `GITHUB_SHA`, not hardcoded.

### Task 2: Replace registry pull and fallback with SSH image loading

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `.github/scripts/transfer-images.sh`

- [x] Remove the deploy step that logs into the registry and runs remote `docker pull`.
- [x] Make the transfer script accept the two local archive paths and image tags, upload archives with `rsync --partial --append-verify`, and remotely run `docker load --input` for each archive.
- [x] Validate both loaded images with `docker image inspect` before applying `job-matcher-backend:deploy` and `job-matcher-frontend:deploy` tags.
- [x] Keep cleanup of local and remote temporary archives on success; retain failed partial archives for resumable retries.
- [x] Preserve SSH keepalive, bounded timeouts, and retry metrics. The script never calls `docker pull`.
- [x] Make the deploy step run for normal builds and skip only when `no_build=true`; retain the existing `no_upload` behavior.

### Task 3: Document the new deployment path and validate

**Files:**
- Modify: `README.md`
- Test: shell/YAML validation commands

- [x] Update deployment documentation to state that normal deploys build on the Runner and transfer images over SSH; GHCR/TCR is optional publication only.
- [x] Document the temporary archive location and existing SSH/rsync prerequisites.
- [x] Run `bash -n .github/scripts/transfer-images.sh` and helper shell checks.
- [x] Parse `.github/workflows/deploy.yml` with Ruby's YAML parser.
- [x] Run the relevant deployment tests and frontend build.
