# Optimize Master Resume Response Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce PDF upload latency for `POST /api/master-resumes` by running independent PDF parsing work concurrently without changing the response contract or fallback behavior.

**Architecture:** Keep `extract_pdf_text` and `extract_pdf_layout` as async public functions for compatibility. Add a small upload-specific orchestration helper that runs the synchronous CPU-bound parser bodies in worker threads, including the existing async wrappers via `asyncio.run`, and gathers text, Markdown structure, and layout settings concurrently. The route continues applying the same Markdown fallback and validation rules after all artifacts are available.

**Tech Stack:** FastAPI, asyncio, SQLAlchemy async sessions, pypdf, PyMuPDF/pymupdf4llm, pytest, pytest-asyncio.

## Global Constraints

- Preserve the `POST /api/master-resumes` JSON response fields and status codes.
- Preserve PDF parsing fallbacks: pymupdf4llm Markdown, then rule-based Markdown, then extracted plain text.
- Do not add dependencies or change the public parser function signatures.
- Do not modify generated frontend artifacts or database schema.

---

### Task 1: Add a failing concurrency regression test

**Files:**
- Modify: `tests/test_resume_routes.py`
- Test: `tests/test_resume_routes.py`

**Interfaces:**
- Consumes: the upload route's internal PDF artifact orchestration helper.
- Produces: a regression test proving text extraction, layout extraction, and Markdown extraction overlap instead of running serially.

- [ ] **Step 1: Write the failing test**

Add an async test that monkeypatches the three parser functions used by the upload route. Each patched parser records its start and waits on a shared `asyncio.Event`; the test releases the event only after all three parser tasks have started. Call the orchestration helper with dummy PDF bytes and assert all three results are returned. The test must use the helper directly so it checks scheduling rather than network/database behavior.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_resume_routes.py -k upload_parser_tasks -q`

Expected: FAIL because the helper does not yet exist.

### Task 2: Implement concurrent upload parsing

**Files:**
- Modify: `app/api/resume.py:1-40,259-315`
- Test: `tests/test_resume_routes.py`

**Interfaces:**
- Consumes: existing `extract_pdf_text`, `extract_pdf_layout`, `extract_markdown_via_pymupdf`, and `_layout_to_global_settings` functions.
- Produces: `async def _extract_upload_artifacts(data: bytes) -> tuple[str, str, dict[str, Any] | None]`.

- [ ] **Step 1: Write the minimal implementation**

Implement a thread adapter for existing async parser functions and gather these three independent operations:

```python
async def _run_async_parser_in_thread(parser, data):
    return await asyncio.to_thread(asyncio.run, parser(data))


async def _extract_upload_artifacts(data: bytes):
    text, markdown_structure, global_settings = await asyncio.gather(
        _run_async_parser_in_thread(extract_pdf_text, data),
        asyncio.to_thread(extract_markdown_via_pymupdf, data),
        _run_async_parser_in_thread(_layout_to_global_settings, data),
    )
    return text, markdown_structure, global_settings
```

Replace the route's sequential parser calls with one call to `_extract_upload_artifacts(data)`. Leave the existing empty-text validation and Markdown fallback code in the same order after the gathered results.

- [ ] **Step 2: Run the focused regression test**

Run: `uv run pytest tests/test_resume_routes.py -k upload_parser_tasks -q`

Expected: PASS.

- [ ] **Step 3: Run resume route and parser tests**

Run: `uv run pytest tests/test_resume_routes.py tests/test_pdf_parser.py -q`

Expected: all tests PASS.

### Task 3: Verify endpoint behavior and measure the hot path

**Files:**
- Modify: none

**Interfaces:**
- Consumes: the updated upload endpoint and existing test fixtures.
- Produces: evidence that the response contract remains unchanged and the parsing stages overlap.

- [ ] **Step 1: Run the full backend test suite**

Run: `uv run pytest -q`

Expected: all backend tests PASS.

- [ ] **Step 2: Inspect the final diff and route call graph**

Run: `git diff --check && git diff -- app/api/resume.py tests/test_resume_routes.py`

Expected: no whitespace errors; only the upload parsing orchestration and its regression test are changed.

- [ ] **Step 3: Record the result**

Report that the endpoint now executes independent PDF parsing in parallel, while the database write and response schema remain unchanged. If a real PDF benchmark is available locally, compare repeated upload timings before and after; otherwise report the deterministic concurrency regression coverage and avoid claiming a fixed absolute latency.
