import json

from ig_ingest.worker import Worker, estimate


def make(tmp_path, settings, apify_provider, media_store, reqs):
    rdir = tmp_path / "requests"
    rdir.mkdir()
    for rid, body in reqs.items():
        (rdir / f"{rid}.json").write_text(json.dumps(body))
    from ig_ingest.media import MediaStore
    w = Worker(tmp_path / "store", settings, [apify_provider], MediaStore(tmp_path / "store", client=media_store.client))
    return w, rdir


def test_inspect_then_profile_then_posts(tmp_path, settings, apify_provider, media_store, fake_apify):
    w, rdir = make(tmp_path, settings, apify_provider, media_store, {
        "001-inspect": {"kind": "inspect", "handle": "@some.bistro", "comments": 10},
        "002-profile": {"kind": "profile", "handle": "some.bistro", "limit": 3, "comments": 1, "label": "Date night"},
        "003-posts": {"kind": "posts", "urls": ["https://www.instagram.com/reel/DVid000000x/", "nasa", "junk!"], "comments": 5},
    })
    todo = w.pending(rdir)
    assert [p.stem for p in todo] == ["001-inspect", "002-profile", "003-posts"]
    results = [w.process(p) for p in todo]

    ins = results[0]
    assert ins["state"] == "done" and ins["profile"]["post_count"] == 240
    assert ins["profile"]["estimate_usd_all"] == estimate(240, 10) == round(240 * 0.0027, 4)

    prof = results[1]
    assert prof["state"] == "done", prof
    assert set(prof["posts"]) == {"DAbCdEfGhIj", "DVid000000x", "DImg0000000"}
    rec, _ = w.store.get_post("DAbCdEfGhIj")
    assert len(rec["comments"]) == 1  # trimmed to the N asked for
    assert rec["media"][1]["storage_key"] == "media/DAbCdEfGhIj/1.mp4"  # videos saved by default

    posts = results[2]
    assert posts["state"] == "done"
    assert len(posts["rejected"]) == 2

    # finished requests are not picked up again
    assert w.pending(rdir) == []

    out = tmp_path / "public"
    assert w.build_public(out) == 3
    index = json.loads((out / "index.json").read_text())
    first = next(p for p in index["posts"] if p["shortcode"] == "DAbCdEfGhIj")
    assert first["thumb"] == "media/DAbCdEfGhIj/0.jpg" and first["has_video"] is True
    assert {"kind": "collection", "handle": "Date night"} in [{k: s[k] for k in ("kind", "handle")} for s in first["sources"]]
    assert (out / "media/DAbCdEfGhIj/1.mp4").exists()
    assert (out / "status/002-profile.json").exists()
    full = json.loads((out / "posts/DAbCdEfGhIj.json").read_text())
    assert "cdninstagram" not in json.dumps(full)


def test_bad_request_fails_cleanly(tmp_path, settings, apify_provider, media_store):
    w, rdir = make(tmp_path, settings, apify_provider, media_store, {
        "a": {"kind": "posts", "urls": ["https://example.com/x"]},
        "b": {"kind": "nope"},
    })
    (rdir / "c.json").write_text("{not json")
    states = {p.stem: w.process(p) for p in w.pending(rdir)}
    assert {k: v["state"] for k, v in states.items()} == {"a": "failed", "b": "failed", "c": "failed"}
    assert "no valid links" in states["a"]["error"]
