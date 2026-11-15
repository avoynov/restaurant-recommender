import httpx
import pytest

from ig_ingest.providers.apify import ApifyProvider
from ig_ingest.providers.base import Blocked, ConfigError, Permanent

from .conftest import FakeApify, load


def test_profile_run_input_and_budget_cap(apify_provider, fake_apify):
    apify_provider.fetch_profiles(["some.bistro", "ghost.account"], 12, "2026-01-01", max_charge_usd=0.08)
    run = fake_apify.runs[0]
    assert run["actor"] == "apify~instagram-scraper"
    assert run["input"]["directUrls"] == ["https://www.instagram.com/some.bistro/", "https://www.instagram.com/ghost.account/"]
    assert run["input"]["resultsType"] == "posts"
    assert run["input"]["resultsLimit"] == 12
    assert run["input"]["onlyPostsNewerThan"] == "2026-01-01"
    assert run["params"]["maxTotalChargeUsd"] == "0.0800"


def test_profile_results_split_by_handle(apify_provider):
    out = apify_provider.fetch_profiles(["some.bistro", "ghost.account"], 12, None, 1.0)
    assert isinstance(out["ghost.account"], Permanent)
    res = out["some.bistro"]
    assert [p.shortcode for p in res.posts] == ["DAbCdEfGhIj", "DVid000000x", "DImg0000000"]
    assert len(res.raw) == 3
    assert res.cost_usd == pytest.approx(3 * 0.0027, abs=1e-6)


def test_normalize_carousel(apify_provider):
    item = load("apify_profile_posts.json")[0]
    p = apify_provider.normalize(item)
    assert p.type == "carousel"
    assert p.posted_at == "2026-09-30T12:00:00Z"
    assert p.author.username == "some.bistro" and p.author.full_name == "Some Bistro London"
    assert p.hashtags == ["#londonfood", "#pasta"] and p.mentions == ["@chef.anna"]
    assert p.location.name == "Some Bistro" and p.location.ig_location_id == "123456"
    # sorted by likes, blank dropped, commenter handles not kept
    assert [c.text for c in p.comments] == ["Best carbonara in town", "Booking for Friday!"]
    assert not hasattr(p.comments[0], "owner_username")
    assert [m.kind for m in p.media] == ["image", "video"]
    assert p.media[1].source_url.endswith("a1.mp4") and p.media[1].cover_url.endswith("a1_cover.jpg")
    assert p.media[1].duration_s == 12.4
    assert p.stats.like_count == 1520


def test_normalize_video_hidden_likes_and_no_comments(apify_provider):
    p = apify_provider.normalize(load("apify_profile_posts.json")[1])
    assert p.type == "video"
    assert p.stats.like_count is None  # -1 means hidden
    assert p.stats.view_count == 10400
    assert p.comments == []  # zero comments is a known value, not missing
    assert p.location is None


def test_normalize_missing_comments_is_null_and_epoch_time(apify_provider):
    p = apify_provider.normalize(load("apify_profile_posts.json")[2])
    assert p.comments is None  # 7 comments exist, none returned
    assert p.caption is None
    assert p.posted_at == "2025-09-16T05:20:00Z"


def test_fetch_comments_groups_and_sorts(apify_provider, fake_apify):
    got = apify_provider.fetch_comments(["DImg0000000", "DAbCdEfGhIj"], 20, 0.5)
    assert fake_apify.runs[0]["actor"] == "apify~instagram-comment-scraper"
    assert fake_apify.runs[0]["input"]["resultsLimit"] == 20
    assert [c.text for c in got["DImg0000000"]] == ["Gorgeous plating", "Is this the new menu?"]


def test_bad_token_is_config_error():
    fake = FakeApify({}, fail_start=401)
    p = ApifyProvider("test-token", client=httpx.Client(transport=httpx.MockTransport(fake.handler)), sleep=lambda s: None)
    with pytest.raises(ConfigError):
        p.fetch_profiles(["x"], 1, None, 0.1)


def test_out_of_credit_is_blocked():
    fake = FakeApify({}, fail_start=402)
    p = ApifyProvider("test-token", client=httpx.Client(transport=httpx.MockTransport(fake.handler)), sleep=lambda s: None)
    with pytest.raises(Blocked):
        p.fetch_profiles(["x"], 1, None, 0.1)


def test_failed_run_without_items_is_blocked():
    fake = FakeApify({}, status="FAILED")
    p = ApifyProvider("test-token", client=httpx.Client(transport=httpx.MockTransport(fake.handler)), sleep=lambda s: None)
    with pytest.raises(Blocked):
        p.fetch_profiles(["x"], 1, None, 0.1)


def test_aborted_run_with_items_keeps_partial_data():
    fake = FakeApify({"apify~instagram-scraper": load("apify_profile_posts.json")[:1]}, status="ABORTED")
    p = ApifyProvider("test-token", client=httpx.Client(transport=httpx.MockTransport(fake.handler)), sleep=lambda s: None)
    out = p.fetch_profiles(["some.bistro"], 5, None, 0.01)
    assert len(out["some.bistro"].posts) == 1


def test_transient_5xx_is_retried():
    calls = {"n": 0}
    fake = FakeApify({"apify~instagram-scraper": []})

    def flaky(request):
        if request.url.path.endswith("/users/me"):
            calls["n"] += 1
            if calls["n"] < 3:
                return httpx.Response(503, json={"error": {"type": "x", "message": "busy"}})
        return fake.handler(request)

    p = ApifyProvider("test-token", client=httpx.Client(transport=httpx.MockTransport(flaky)), sleep=lambda s: None)
    assert p.check() == {"username": "tester", "plan": "FREE"}
    assert calls["n"] == 3


def test_missing_token():
    with pytest.raises(ConfigError):
        ApifyProvider(None)


def test_live_payloads_normalize(apify_provider):
    """Real apify/instagram-scraper output recorded 15 Nov 2026 (commenters scrubbed, CDN query strings cut)."""
    items = load("apify_live_2026-11-15.json")
    posts = [apify_provider.normalize(i) for i in items]
    assert {p.type for p in posts} == {"image", "video", "carousel"}
    for p, raw in zip(posts, items):
        assert p.author.username and p.posted_at.endswith("Z")
        assert p.comments and len(p.comments) <= 50
        assert p.media and all(m.source_url or m.cover_url for m in p.media)
        if p.type == "carousel":
            assert len(p.media) == len(raw["childPosts"]) > 1
        if p.type == "video":
            assert p.media[0].cover_url and p.media[0].duration_s


def test_raw_payload_scrubs_commenters(tmp_path):
    from ig_ingest.store import Store
    s = Store(tmp_path / "x.db")
    s.put_raw("X", "p", {"latestComments": [{"text": "hi", "ownerUsername": "someone", "owner": {"u": 1}}]})
    import json as _j
    stored = _j.loads(s.db.execute("select payload from raw_payloads").fetchone()[0])
    assert stored == {"latestComments": [{"text": "hi"}]}
