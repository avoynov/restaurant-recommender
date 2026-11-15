import json

from ig_ingest.canonical import parse_target
from ig_ingest.export import records, write_jsonl
from ig_ingest.merge import assess, merge
from ig_ingest.models import Author, Comment, FetchResult, Media, Post
from ig_ingest.pipeline import Options, Pipeline, parse_since
from ig_ingest.providers.base import Blocked, Permanent
from ig_ingest.store import Store


class FakeFree:
    """Stands in for the logged-out free tier."""
    name = "tier1_instaloader"

    def __init__(self, results):
        self.results = results
        self.calls = []

    def fetch_profiles(self, handles, limit, since, max_charge_usd=0.0):
        self.calls.append(list(handles))
        return {h: self.results.get(h, Blocked("429")) for h in handles}

    def fetch_posts(self, codes, max_charge_usd=0.0):
        return {c: self.results.get(c, Blocked("login wall")) for c in codes}


def run(settings, media_store, providers, targets, **kw):
    store = Store(settings.db_path)
    rep = Pipeline(store, settings, providers, media_store).run([parse_target(t) for t in targets], Options(**kw))
    return store, rep


def test_end_to_end_apify_then_export(settings, media_store, apify_provider, tmp_path):
    store, rep = run(settings, media_store, [apify_provider], ["some.bistro", "ghost.account"], limit=5)
    assert rep.profiles["some.bistro"].startswith("ok via tier2_apify (3 posts)")
    assert rep.profiles["ghost.account"].startswith("permanent")
    assert rep.posts["DAbCdEfGhIj"].startswith("COMPLETE")
    assert rep.posts["DVid000000x"].startswith("COMPLETE")
    assert rep.posts["DImg0000000"] == "COMPLETE (missing: caption, comments)"

    # media: photos + video covers stored by key with sniffed types; video itself not downloaded
    rec, prov = store.get_post("DAbCdEfGhIj")
    m0, m1 = rec["media"]
    assert m0["storage_key"] == "media/DAbCdEfGhIj/0.jpg" and m0["mime"] == "image/jpeg"
    assert m1["cover_storage_key"] == "media/DAbCdEfGhIj/1_cover.jpg" and m1["storage_key"] is None
    assert (tmp_path / "media/DAbCdEfGhIj/0.jpg").read_bytes()[:3] == b"\xff\xd8\xff"
    assert prov["caption"] == "tier2_apify"

    out = tmp_path / "export.jsonl"
    assert write_jsonl(store, out) == 3
    lines = [json.loads(x) for x in out.read_text().splitlines()]
    r = next(x for x in lines if x["post"]["shortcode"] == "DAbCdEfGhIj")
    assert r["schema_version"] == "1.0"
    assert r["save"] == {"source": "profile_feed", "handle": "some.bistro", "collection": None,
                         "saved_at": r["save"]["saved_at"]}
    assert r["post"]["url"] == "https://www.instagram.com/p/DAbCdEfGhIj/"
    # contract: no CDN URLs leave the module, null fields present not omitted
    dumped = json.dumps(r)
    assert "cdninstagram" not in dumped and "source_url" not in dumped
    assert "location" in r["post"] and "comments" in r["post"]
    vid = next(x for x in lines if x["post"]["shortcode"] == "DVid000000x")
    assert vid["post"]["location"] is None


def test_media_all_downloads_video(settings, media_store, apify_provider):
    store, rep = run(settings, media_store, [apify_provider], ["some.bistro"], media="all")
    rec, _ = store.get_post("DVid000000x")
    assert rec["media"][0]["storage_key"] == "media/DVid000000x/0.mp4"
    assert rec["media"][0]["mime"] == "video/mp4"


def test_fallback_free_blocked_then_apify(settings, media_store, apify_provider):
    free = FakeFree({})
    store, rep = run(settings, media_store, [free, apify_provider], ["some.bistro"])
    assert free.calls == [["some.bistro"]]
    assert rep.profiles["some.bistro"].startswith("ok via tier2_apify")
    outcomes = {(r["provider"], r["outcome"]) for r in store.summary()["attempts"]}
    assert ("tier1_instaloader", "blocked") in outcomes and ("tier2_apify", "ok") in outcomes


def test_permanent_stops_fallback(settings, media_store, apify_provider, fake_apify):
    free = FakeFree({"ghost.account": Permanent("private")})
    run(settings, media_store, [free, apify_provider], ["ghost.account"])
    assert fake_apify.runs == []  # no money spent on a private account


def test_deepen_comments(settings, media_store, apify_provider, fake_apify):
    store, rep = run(settings, media_store, [apify_provider], ["some.bistro"], comments=20)
    rec, prov = store.get_post("DImg0000000")
    assert [c["text"] for c in rec["comments"]] == ["Gorgeous plating", "Is this the new menu?"]
    assert prov["comments"] == "tier2_apify"
    # only posts with comments we don't have yet are sent to the paid comment actor
    sent = fake_apify.runs[1]["input"]["directUrls"]
    assert "https://www.instagram.com/p/DVid000000x/" not in sent
    rec2, _ = store.get_post("DAbCdEfGhIj")
    assert [c["text"] for c in rec2["comments"]] == ["Best carbonara in town", "Booking for Friday!"]


def test_budget_exhausted_skips_paid_tier(settings, media_store, apify_provider, fake_apify):
    settings.monthly_cap_usd = 0.0
    store, rep = run(settings, media_store, [apify_provider], ["some.bistro"])
    assert fake_apify.runs == []
    assert any(r["outcome"] == "skipped" for r in store.summary()["attempts"])


def test_dry_run_estimates_only(settings, media_store, apify_provider, fake_apify):
    _, rep = run(settings, media_store, [apify_provider], ["a", "b"], limit=10, dry_run=True)
    assert rep.estimate_usd == round(20 * 0.0027, 4)
    assert fake_apify.runs == []


def test_media_failure_leaves_post_partial(settings, media_store):
    post = Post(shortcode="DBroken0000", type="image", author=Author(username="x"), posted_at="2026-01-01T00:00:00Z",
                caption="hi", comments=[], media=[Media(idx=0, kind="image", source_url="https://cdn/broken.jpg")])
    free = FakeFree({"DBroken0000": FetchResult(posts=[post])})
    store, rep = run(settings, media_store, [free], ["https://www.instagram.com/p/DBroken0000/"])
    assert rep.posts["DBroken0000"] == "PARTIAL (missing: media)"
    assert rep.media_errors and "HTTP 403" in rep.media_errors[0]


def test_unavailable_post(settings, media_store):
    free = FakeFree({"DGone000000": Permanent("removed")})
    store, rep = run(settings, media_store, [free], ["https://www.instagram.com/p/DGone000000/"])
    assert rep.posts["DGone000000"].startswith("UNAVAILABLE")
    assert list(records(store, include_partial=True)) == []


def test_merge_rules():
    a = Post(shortcode="X", caption="from apify", comments=[Comment("good", 3)],
             media=[Media(idx=0, kind="image", source_url="u1", storage_key="media/X/0.jpg", mime="image/jpeg")])
    rec, prov = merge(None, a, "tier2_apify")
    prov["caption"] = "manual"
    rec["caption"] = "typed by user"
    b = Post(shortcode="X", caption="from free", comments=None,
             media=[Media(idx=0, kind="image", source_url="u2")])
    rec2, prov2 = merge((rec, prov), b, "tier1_instaloader")
    assert rec2["caption"] == "typed by user"  # manual never overwritten
    assert rec2["comments"][0]["text"] == "good"  # null never overwrites
    assert rec2["media"][0]["source_url"] == "u2"  # fresher CDN URL
    assert rec2["media"][0]["storage_key"] == "media/X/0.jpg"  # stored file kept
    assert prov2["media"] == "tier1_instaloader"


def test_assess_policies():
    rec = {"type": "video", "author": {}, "posted_at": "t", "caption": "c", "comments": [],
           "media": [{"kind": "video", "cover_url": "c", "storage_key": None, "cover_storage_key": "k"}]}
    assert assess(rec, "covers") == ("COMPLETE", [])
    assert assess(rec, "all") == ("PARTIAL", ["media"])
    assert assess(rec, "none") == ("COMPLETE", [])


def test_parse_since():
    assert parse_since("2026-01-31") == "2026-01-31"
    assert parse_since(None) is None
    assert len(parse_since("6 months")) == 10
