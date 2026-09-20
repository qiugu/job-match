#!/usr/bin/env python3
"""Run a paid, explicitly enabled match-pipeline benchmark.

Case bodies stay in the input fixture. The output contains identifiers and
aggregate measurements only; model text, prompts, resume text, and JD text are
never written to the result file.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path
from typing import Any, Sequence


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", required=True, type=Path)
    parser.add_argument(
        "--pipeline", required=True, choices=("legacy", "combined")
    )
    parser.add_argument("--repeats", type=_positive_int, default=3)
    parser.add_argument("--concurrency", type=_positive_int, default=1)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--live",
        action="store_true",
        help="allow real model calls (may incur cost)",
    )
    return parser


def load_cases(path: Path) -> list[dict[str, str]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list) or not payload:
        raise ValueError("cases must be a non-empty JSON array")
    expected = {"case_id", "resume_text", "jd_text"}
    seen: set[str] = set()
    cases: list[dict[str, str]] = []
    for item in payload:
        if not isinstance(item, dict) or set(item) != expected:
            raise ValueError(f"each case must contain exactly {sorted(expected)}")
        if not all(
            isinstance(item[key], str) and item[key].strip()
            for key in expected
        ):
            raise ValueError("case fields must be non-empty strings")
        if item["case_id"] in seen:
            raise ValueError(f"duplicate case_id: {item['case_id']}")
        seen.add(item["case_id"])
        cases.append(item)
    return cases


def build_result_record(
    *,
    case_id: str,
    pipeline: str,
    repeat: int,
    latency_ms: int,
    success: bool,
    error_type: str | None,
    input_tokens: int | None,
    output_tokens: int | None,
    reasoning_tokens: int | None,
    quality: dict[str, Any],
) -> dict[str, Any]:
    total_tokens = (
        None
        if input_tokens is None and output_tokens is None
        else (input_tokens or 0) + (output_tokens or 0)
    )
    return {
        "case_id": case_id,
        "performance": {
            "pipeline": pipeline,
            "repeat": repeat,
            "latency_ms": latency_ms,
            "success": success,
            "error_type": error_type,
        },
        "tokens": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "reasoning_tokens": reasoning_tokens,
            "total_tokens": total_tokens,
        },
        "quality": quality,
    }


def _summarize_tokens(
    usage_metadata: dict[str, Any],
) -> tuple[int | None, int | None, int | None]:
    if not usage_metadata:
        return None, None, None
    input_tokens = 0
    output_tokens = 0
    reasoning_tokens = 0
    has_reasoning = False
    for metadata in usage_metadata.values():
        input_tokens += int(metadata.get("input_tokens") or 0)
        output_tokens += int(metadata.get("output_tokens") or 0)
        details = metadata.get("output_token_details") or {}
        if details.get("reasoning") is not None:
            reasoning_tokens += int(details["reasoning"])
            has_reasoning = True
    return input_tokens, output_tokens, reasoning_tokens if has_reasoning else None


def _quality_fields(result: tuple[list[str], str, dict | None]) -> dict[str, Any]:
    _, optimized_resume, analysis = result
    expected = {"role", "score", "requirements", "summary"}
    requirements = (
        analysis.get("requirements") if isinstance(analysis, dict) else None
    )
    contract_valid = (
        isinstance(analysis, dict)
        and expected.issubset(analysis)
        and isinstance(requirements, list)
    )
    return {
        "analysis_contract_valid": contract_valid,
        "requirement_count": (
            len(requirements) if isinstance(requirements, list) else None
        ),
        "optimized_resume_chars": len(optimized_resume),
        "manual_review": "pending",
    }


async def run_live_benchmark(args: argparse.Namespace) -> list[dict[str, Any]]:
    # Imports stay behind the --live gate so an offline invocation cannot even
    # initialize the application model clients.
    from langchain_core.callbacks import get_usage_metadata_callback

    from app.core.config import settings
    from app.services.agent import run_match

    cases = load_cases(args.cases)
    previous_pipeline = settings.match_pipeline_version
    settings.match_pipeline_version = args.pipeline
    semaphore = asyncio.Semaphore(args.concurrency)

    async def run_one(case: dict[str, str], repeat: int) -> dict[str, Any]:
        async with semaphore:
            started = time.perf_counter()
            usage_metadata: dict[str, Any] = {}
            result: tuple[list[str], str, dict | None] | None = None
            error_type: str | None = None
            try:
                with get_usage_metadata_callback() as callback:
                    try:
                        result = await run_match(
                            case["resume_text"], case["jd_text"]
                        )
                    finally:
                        usage_metadata = dict(callback.usage_metadata)
            except Exception as exc:  # noqa: BLE001 - record failure class only
                error_type = type(exc).__name__
            latency_ms = round((time.perf_counter() - started) * 1000)
            input_tokens, output_tokens, reasoning_tokens = _summarize_tokens(
                usage_metadata
            )
            quality = (
                _quality_fields(result)
                if result is not None
                else {
                    "analysis_contract_valid": False,
                    "requirement_count": None,
                    "optimized_resume_chars": 0,
                    "manual_review": "pending",
                }
            )
            return build_result_record(
                case_id=case["case_id"],
                pipeline=args.pipeline,
                repeat=repeat,
                latency_ms=latency_ms,
                success=result is not None,
                error_type=error_type,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                reasoning_tokens=reasoning_tokens,
                quality=quality,
            )

    try:
        jobs = [
            run_one(case, repeat)
            for repeat in range(1, args.repeats + 1)
            for case in cases
        ]
        records = await asyncio.gather(*jobs)
    finally:
        settings.match_pipeline_version = previous_pipeline

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(records, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return records


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.live:
        parser.error("refusing real model calls without explicit --live")
    asyncio.run(run_live_benchmark(args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
