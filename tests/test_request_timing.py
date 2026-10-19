import re

import pytest


@pytest.mark.asyncio
async def test_response_exposes_application_timing(client):
    response = await client.get("/health")

    assert response.status_code == 200
    assert re.fullmatch(r"app;dur=\d+(?:\.\d+)?", response.headers["server-timing"])


@pytest.mark.asyncio
async def test_response_preserves_request_id_header(client):
    response = await client.get("/health", headers={"X-Request-ID": "timing-test"})

    assert response.headers["x-request-id"] == "timing-test"
