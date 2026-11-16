import json
from pathlib import Path

import httpx
import pytest

FIX = Path(__file__).parent / "fixtures"
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
MP4 = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 64


def load(name):
    return json.loads((FIX / name).read_text())


class FakeApify:
    """In-memory Apify API: records run inputs, serves a dataset per actor."""

    def __init__(self, datasets: dict[str, list], status="SUCCEEDED", fail_start: int | None = None):
        self.datasets = datasets
        self.status = status
        self.fail_start = fail_start
        self.runs: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        assert request.headers["Authorization"] == "Bearer test-token"
        if request.method == "POST" and path.endswith("/runs"):
            if self.fail_start:
                return httpx.Response(self.fail_start, json={"error": {"type": "x", "message": "nope"}})
            actor = path.split("/acts/")[1].split("/")[0]
            run_input = json.loads(request.content)
            key = actor + ("~details" if run_input.get("resultsType") == "details" else "")
            run_id = f"run{len(self.runs)}"
            self.runs.append({"actor": actor, "key": key, "input": run_input, "params": dict(request.url.params)})
            return httpx.Response(201, json={"data": {"id": run_id, "status": "RUNNING", "defaultDatasetId": f"ds_{key}"}})
        if path.startswith("/v2/actor-runs/"):
            run_id = path.rsplit("/", 1)[1]
            key = self.runs[int(run_id[3:])]["key"]
            return httpx.Response(200, json={"data": {"id": run_id, "status": self.status, "defaultDatasetId": f"ds_{key}"}})
        if path.startswith("/v2/datasets/"):
            actor = path.split("/")[3][3:]
            offset = int(request.url.params.get("offset", 0))
            return httpx.Response(200, json=self.datasets.get(actor, [])[offset:])
        if path == "/v2/users/me":
            return httpx.Response(200, json={"data": {"username": "tester", "plan": {"id": "FREE"}}})
        return httpx.Response(404, json={"error": {"type": "not-found", "message": path}})


def cdn_handler(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith(".mp4"):
        return httpx.Response(200, content=MP4)
    if "broken" in request.url.path:
        return httpx.Response(403)
    return httpx.Response(200, content=JPEG)


@pytest.fixture
def fake_apify():
    return FakeApify({
        "apify~instagram-scraper": load("apify_profile_posts.json"),
        "apify~instagram-comment-scraper": load("apify_comments.json"),
        "apify~instagram-scraper~details": [
            {"inputUrl": "https://www.instagram.com/some.bistro/", "username": "some.bistro", "fullName": "Some Bistro",
             "postsCount": 240, "private": False, "isBusinessAccount": True, "verified": False},
        ],
    })


@pytest.fixture
def apify_provider(fake_apify):
    from ig_ingest.providers.apify import ApifyProvider
    client = httpx.Client(transport=httpx.MockTransport(fake_apify.handler))
    return ApifyProvider("test-token", client=client, sleep=lambda s: None)


@pytest.fixture
def settings(tmp_path):
    from ig_ingest.config import Settings
    return Settings(apify_token="test-token", data_dir=tmp_path, monthly_cap_usd=5.0, run_budget_usd=1.0)


@pytest.fixture
def media_store(tmp_path):
    from ig_ingest.media import MediaStore
    return MediaStore(tmp_path, client=httpx.Client(transport=httpx.MockTransport(cdn_handler)))
