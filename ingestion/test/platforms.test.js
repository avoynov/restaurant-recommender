import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { InputError, parseLink, platformOfKey } from "../src/canonical.js";
import { records } from "../src/export.js";
import { MediaStore } from "../src/media.js";
import { assess } from "../src/merge.js";
import { FacebookProvider, GoogleMapsProvider, GooglePlacesProvider, TikTokProvider, linkProviders, normalizePlace } from "../src/platforms.js";
import { Store } from "../src/store.js";
import { Worker } from "../src/worker.js";
import { JPEG, fakePlatforms, load, mediaStore, provider, tmp } from "./helpers.js";

const opts = (fake) => ({ fetchFn: fake.fetch, sleepFn: async () => {}, resolveFn: async () => new Response(null, { status: 404 }) });

const links = [
  ["https://www.tiktok.com/@nasa/video/7709957996436131086?is_from_webapp=1", "tiktok", "post", "7709957996436131086"],
  ["https://www.tiktok.com/@chef/photo/7709957996436131000", "tiktok", "post", "7709957996436131000"],
  ["https://www.tiktokv.com/share/video/7709957996436131086/", "tiktok", "post", "7709957996436131086"],
  ["https://vm.tiktok.com/ZMabc123/", "tiktok", "post", null],
  ["https://www.tiktok.com/t/ZTabc/", "tiktok", "post", null],
  ["https://www.facebook.com/NASA/posts/pfbid02hb8fsH3Y8btu?__cft__=x", "facebook", "post", "pfbid02hb8fsH3Y8btu"],
  ["https://m.facebook.com/permalink.php?story_fbid=123456&id=789", "facebook", "post", "789_123456"],
  ["https://www.facebook.com/reel/1497381435689987/?s=1", "facebook", "post", "1497381435689987"],
  ["https://www.facebook.com/watch/?v=12345678", "facebook", "post", "12345678"],
  ["https://www.facebook.com/NASA/videos/send-your-name/1497381435689987/", "facebook", "post", "1497381435689987"],
  ["https://www.facebook.com/share/r/1AbCdEf/", "facebook", "post", null],
  ["https://fb.watch/abcDEF/", "facebook", "post", null],
  ["https://maps.app.goo.gl/AbCd1234", "google_maps", "place", null],
  ["https://www.google.com/maps/place/Dishoom/@51.5,-0.12,17z/data=!3m1", "google_maps", "place", null],
  ["http://maps.google.com/?cid=11256896404490944630", "google_maps", "place", null],
  ["https://www.google.co.uk/maps/placelists/list/2abcDEF", "google_maps", "list", null],
  ["https://www.instagram.com/reel/DfahZrMjAqq/", "instagram", "post", "DfahZrMjAqq"],
  ["nasa", "instagram", "profile", "nasa"],
];
for (const [raw, platform, kind, value] of links) {
  test(`parseLink ${raw}`, () => assert.deepEqual((({ platform, kind, value }) => ({ platform, kind, value }))(parseLink(raw)), { platform, kind, value }));
}
for (const raw of ["https://www.tiktok.com/@nasa", "https://www.facebook.com/NASA", "https://www.google.com/search?q=pizza", "https://www.google.com/maps", "https://example.com/x"]) {
  test(`parseLink rejects ${raw}`, () => assert.throws(() => parseLink(raw), InputError));
}

test("record keys are prefixed per platform", () => {
  assert.equal(platformOfKey("tt_123"), "tiktok");
  assert.equal(platformOfKey("gm_ChIJx"), "google_maps");
  assert.equal(platformOfKey("DAbCdEfGhIj"), "instagram");
});

test("tiktok: one run, $0.50 cap floor, comments from the comment dataset, covers saved in Apify", async () => {
  const fake = fakePlatforms();
  const tt = new TikTokProvider("test-token", opts(fake));
  const t = parseLink("https://www.tiktok.com/@nasa/video/7709957996436131086");
  const { results } = await tt.fetchLinks([t], { comments: 5, media: "covers" }, 0.02);
  const run = fake.runs[0];
  assert.equal(run.actor, "clockworks~tiktok-scraper");
  assert.equal(run.params.maxTotalChargeUsd, "0.5000");
  assert.deepEqual(run.input.postURLs, [t.url]);
  assert.equal(run.input.shouldDownloadCovers, true);
  assert.equal(run.input.shouldDownloadVideos, false);
  const p = results.get(t.url).posts[0];
  assert.equal(p.shortcode, "tt_7709957996436131086");
  assert.equal(p.platform, "tiktok");
  assert.equal(p.author.username, "nasa");
  assert.equal(p.posted_at, "2026-11-19T18:54:56Z");
  assert.equal(p.stats.view_count, 27400);
  assert.deepEqual(p.comments.map((c) => c.text), ["Top comment", "Second"]); // replies dropped
  assert.ok(!("uniqueId" in p.comments[0]));
  assert.match(p.media[0].cover_url, /^https:\/\/api\.apify\.com\//);
  assert.equal(p.media[0].duration_s, 177);
});

test("tiktok: a short link is matched to whatever the actor returns", async () => {
  const fake = fakePlatforms();
  const t = parseLink("https://vm.tiktok.com/ZMabc123/");
  const { results } = await new TikTokProvider("test-token", opts(fake)).fetchLinks([t], {}, 1);
  assert.equal(results.get(t.url).posts[0].platform_id, "7709957996436131086");
});

test("tiktok: short links are resolved through redirects first", async () => {
  const fake = fakePlatforms();
  const resolveFn = async () => new Response(null, { status: 301, headers: { location: "https://www.tiktok.com/@nasa/video/7709957996436131086?_r=1" } });
  const tt = new TikTokProvider("test-token", { ...opts(fake), resolveFn });
  await tt.fetchLinks([parseLink("https://vm.tiktok.com/ZMabc123/")], {}, 1);
  assert.deepEqual(fake.runs[0].input.postURLs, ["https://www.tiktok.com/@nasa/video/7709957996436131086"]);
});

test("cap below the actor's minimum is retried once at the minimum", async () => {
  const fake = fakePlatforms({ minCharge: { "apify~facebook-posts-scraper": 0.5 } });
  const fb = new FacebookProvider("test-token", opts(fake));
  await fb.fetchLinks([parseLink("https://www.facebook.com/reel/1497381435689987/")], {}, 0.02);
  assert.equal(fake.rejectedStarts, 1);
  assert.equal(fake.runs[0].params.maxTotalChargeUsd, "0.5000");
});

test("facebook: page post with a shared reel, and a raw reel, normalize", async () => {
  const fb = new FacebookProvider("test-token", opts(fakePlatforms()));
  const [post] = load("facebook_post.json");
  const p = fb.normalize(post);
  assert.equal(p.shortcode, "fb_1693389518823084");
  assert.equal(p.author.username, "NASA");
  assert.match(p.caption, /Titan/);
  assert.equal(p.type, "video");
  assert.match(p.media[0].source_url, /fbcdn\.net/);
  assert.match(p.media[0].cover_url, /fbcdn\.net/);
  assert.equal(p.media[0].duration_s, 50.02);
  assert.equal(p.stats.like_count, 89);
  assert.equal(p.link, "http://go.nasa.gov/dragonfly-names");

  const r = fb.normalize(load("facebook_reel.json")[0]);
  assert.equal(r.shortcode, "fb_1633078842188388");
  assert.equal(r.posted_at, "2026-11-20T17:25:24Z");
  assert.equal(r.author.username, "NASASolarSystem");
  assert.equal(r.product_type, "reel");
  assert.match(r.media[0].source_url, /video-.*fbcdn\.net/);
  assert.equal(r.stats.comment_count, 5);
});

test("facebook: links matched by URL, comments from the comments actor without names", async () => {
  const fake = fakePlatforms();
  const fb = new FacebookProvider("test-token", opts(fake));
  const reel = parseLink("https://www.facebook.com/reel/1497381435689987/");
  const { results, cost } = await fb.fetchLinks([reel], { comments: 5 }, 1);
  const p = results.get(reel.url).posts[0];
  assert.equal(p.shortcode, "fb_1633078842188388");
  assert.deepEqual(p.comments, [{ text: "Looks great", like_count: 5, created_at: "2026-11-20T18:00:00Z" }]);
  assert.equal(fake.runs[1].actor, "apify~facebook-comments-scraper");
  assert.ok(cost > 0);
});

test("google maps: shared-list and Compass shapes give the same place record", () => {
  const a = normalizePlace(load("gmaps_list.json")[0]);
  const b = normalizePlace(load("gmaps_compass.json")[0]);
  for (const p of [a, b]) {
    assert.equal(p.shortcode, "gm_ChIJxZXYx7cEdkgRdgAOZ6OHOJw");
    assert.equal(p.type, "place");
    assert.equal(p.place.name, "Dishoom Covent Garden");
    assert.equal(p.place.rating, 4.7);
    assert.equal(p.place.categories[0], "Indian restaurant");
    assert.ok(Math.abs(p.place.lat - 51.5125) < 1e-3);
    assert.ok(p.media.length >= 1 && p.media.every((m) => m.kind === "image"));
    assert.ok(p.comments.every((c) => !("reviewerName" in c) && c.text));
  }
  assert.equal(a.place.cid, "11256896404490944630");
  const graded = assess({ ...a, media: a.media.map((m) => ({ ...m, storage_key: "k" })) }, "covers");
  assert.equal(graded.status, "COMPLETE");
  assert.equal(assess({ ...a, media: [] }, "covers").status, "COMPLETE"); // a place without photos is fine
});

test("google maps: a private list is unavailable; Compass declines lists", async () => {
  const fake = fakePlatforms();
  fake.datasets["maximedupre~google-maps-shared-list-scraper"] = [];
  const list = parseLink("https://www.google.com/maps/placelists/list/2abcDEF");
  const { results } = await new GoogleMapsProvider("test-token", opts(fake)).fetchLinks([list], {}, 1);
  assert.equal(results.get(list.url).errorClass, "permanent");
  assert.match(results.get(list.url).message, /shared publicly/);
  const res = await new GooglePlacesProvider("test-token", opts(fake)).fetchLinks([list], {}, 1);
  assert.equal(res.results.get(list.url).errorClass, "blocked");
});

test("media: Apify storage links get the token, others don't", async () => {
  const seen = [];
  const fetchFn = async (url, init) => { seen.push([url, init.headers.Authorization]); return new Response(JPEG, { status: 200 }); };
  const m = new MediaStore(tmp(), { fetchFn, apifyToken: "secret" });
  await m.save("tt_1", "0_cover", "https://api.apify.com/v2/key-value-stores/x/records/cover");
  await m.save("tt_1", "1", "https://p16.tiktokcdn.com/a.jpg");
  assert.equal(seen[0][1], "Bearer secret");
  assert.equal(seen[1][1], undefined);
});

test("raw payloads drop reviewer and commenter identities", () => {
  const s = new Store(tmp());
  s.putRaw("gm_X", "p", { reviews: [{ text: "ok", reviewerName: "A", reviewerId: "1", name: "A" }], topComments: [{ text: "hi", profileName: "B" }] });
  const stored = JSON.parse(readFileSync(join(s.root, "raw", "gm_X.p.json"), "utf8"));
  assert.deepEqual(stored.payload, { reviews: [{ text: "ok" }], topComments: [{ text: "hi" }] });
});

test("worker: one request mixing every platform, then the public build", async () => {
  const root = tmp();
  const reqDir = join(root, "requests");
  mkdirSync(reqDir);
  const urls = [
    "https://www.instagram.com/p/DAbCdEfGhIj/",
    "https://www.tiktok.com/@nasa/video/7709957996436131086",
    "https://www.facebook.com/reel/1497381435689987/",
    "https://www.google.com/maps/placelists/list/2abcDEF",
    "https://www.tiktok.com/@nasa",
  ];
  writeFileSync(join(reqDir, "001.json"), JSON.stringify({ kind: "posts", urls, comments: 3, label: "Trip" }));
  const fake = fakePlatforms();
  const store = join(root, "store");
  const w = new Worker(store, { providers: [provider(fake), ...linkProviders("test-token", opts(fake))], media: mediaStore(store) });
  const st = await w.process(w.pending(reqDir)[0]);
  assert.equal(st.state, "done", st.error);
  assert.equal(st.rejected.length, 1);
  assert.match(st.links["https://www.google.com/maps/placelists/list/2abcDEF"], /^ok via tier2_apify_gmaps \(1 place\)/);
  for (const k of ["DAbCdEfGhIj", "tt_7709957996436131086", "fb_1633078842188388", "gm_ChIJxZXYx7cEdkgRdgAOZ6OHOJw"]) {
    assert.equal(w.store.getPost(k)?.status, "COMPLETE", `${k}: ${JSON.stringify(w.store.getPost(k)?.missing)}`);
  }
  const place = w.store.getPost("gm_ChIJxZXYx7cEdkgRdgAOZ6OHOJw");
  assert.ok(place.sources.some((s) => s.kind === "maps_list"));
  assert.ok(place.sources.some((s) => s.kind === "collection" && s.handle === "Trip"));
  assert.ok(place.record.comments.length <= 3);
  assert.ok(place.record.media[0].storage_key.startsWith("media/gm_ChIJxZXYx7cEdkgRdgAOZ6OHOJw/"));

  const out = join(root, "public");
  assert.equal(w.buildPublic(out), 4);
  const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
  const gm = index.posts.find((p) => p.platform === "google_maps");
  assert.equal(gm.place.name, "Dishoom Covent Garden");
  assert.deepEqual(new Set(index.posts.map((p) => p.platform)), new Set(["instagram", "tiktok", "facebook", "google_maps"]));
  assert.ok(!readFileSync(join(out, "posts", "tt_7709957996436131086.json"), "utf8").includes("api.apify.com"));
  const exported = [...records(w.store)];
  assert.ok(exported.every((r) => r.schema_version === "1.1" && r.post.platform));
});
