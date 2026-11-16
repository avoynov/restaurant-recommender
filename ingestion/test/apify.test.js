import assert from "node:assert/strict";
import { test } from "node:test";
import { ApifyProvider } from "../src/apify.js";
import { ProviderError } from "../src/util.js";
import { FakeApify, fakeApify, load, provider } from "./helpers.js";

test("profile run input carries limits, date and spend cap", async () => {
  const fake = fakeApify();
  await provider(fake).fetchProfiles(["some.bistro", "ghost.account"], 12, "2026-01-01", 0.08);
  const run = fake.runs[0];
  assert.equal(run.actor, "apify~instagram-scraper");
  assert.deepEqual(run.input.directUrls, ["https://www.instagram.com/some.bistro/", "https://www.instagram.com/ghost.account/"]);
  assert.equal(run.input.resultsType, "posts");
  assert.equal(run.input.resultsLimit, 12);
  assert.equal(run.input.onlyPostsNewerThan, "2026-01-01");
  assert.equal(run.params.maxTotalChargeUsd, "0.0800");
});

test("results split by handle; error items are permanent and not charged", async () => {
  const out = await provider(fakeApify()).fetchProfiles(["some.bistro", "ghost.account"], 12, null, 1);
  assert.ok(out.get("ghost.account") instanceof ProviderError);
  assert.equal(out.get("ghost.account").errorClass, "permanent");
  const res = out.get("some.bistro");
  assert.deepEqual(res.posts.map((p) => p.shortcode), ["DAbCdEfGhIj", "DVid000000x", "DImg0000000"]);
  assert.equal(res.raw.length, 3);
  assert.ok(Math.abs(res.cost_usd - 3 * 0.0027) < 1e-6);
});

test("normalize carousel", () => {
  const p = provider(fakeApify()).normalize(load("apify_profile_posts.json")[0]);
  assert.equal(p.type, "carousel");
  assert.equal(p.posted_at, "2026-09-30T12:00:00Z");
  assert.equal(p.author.username, "some.bistro");
  assert.deepEqual(p.hashtags, ["#londonfood", "#pasta"]);
  assert.deepEqual(p.mentions, ["@chef.anna"]);
  assert.equal(p.location.ig_location_id, "123456");
  assert.deepEqual(p.comments.map((c) => c.text), ["Best carbonara in town", "Booking for Friday!"]);
  assert.ok(!("owner_username" in p.comments[0]));
  assert.deepEqual(p.media.map((m) => m.kind), ["image", "video"]);
  assert.match(p.media[1].source_url, /a1\.mp4$/);
  assert.equal(p.media[1].duration_s, 12.4);
});

test("normalize video: hidden likes, zero comments, epoch time, missing comments", () => {
  const a = provider(fakeApify());
  const [, vid, img] = load("apify_profile_posts.json");
  const v = a.normalize(vid);
  assert.equal(v.stats.like_count, null);
  assert.equal(v.stats.view_count, 10400);
  assert.deepEqual(v.comments, []);
  assert.equal(v.location, null);
  const i = a.normalize(img);
  assert.equal(i.comments, null);
  assert.equal(i.caption, null);
  assert.equal(i.posted_at, "2025-09-16T05:20:00Z");
});

test("real payloads recorded 15 Nov 2026 normalize", () => {
  const a = provider(fakeApify());
  const items = load("apify_live_2026-11-15.json");
  const posts = items.map((i) => a.normalize(i));
  assert.deepEqual(new Set(posts.map((p) => p.type)), new Set(["image", "video", "carousel"]));
  posts.forEach((p, k) => {
    assert.ok(p.author.username && p.posted_at.endsWith("Z"));
    assert.ok(p.comments.length > 0 && p.comments.length <= 50);
    assert.ok(p.media.length && p.media.every((m) => m.source_url || m.cover_url));
    if (p.type === "carousel") assert.equal(p.media.length, items[k].childPosts.length);
    if (p.type === "video") assert.ok(p.media[0].cover_url && p.media[0].duration_s);
  });
});

test("comments actor groups by post and sorts by likes", async () => {
  const fake = fakeApify();
  const { comments } = await provider(fake).fetchComments(["DImg0000000", "DAbCdEfGhIj"], 20, 0.5);
  assert.equal(fake.runs[0].actor, "apify~instagram-comment-scraper");
  assert.deepEqual(comments.get("DImg0000000").map((c) => c.text), ["Gorgeous plating", "Is this the new menu?"]);
});

test("inspect returns post count", async () => {
  const { profiles } = await provider(fakeApify()).inspectProfiles(["some.bistro"]);
  assert.equal(profiles.get("some.bistro").post_count, 240);
});

for (const [code, cls] of [[401, "config"], [402, "blocked"]]) {
  test(`HTTP ${code} is ${cls}`, async () => {
    await assert.rejects(provider(new FakeApify({}, { failStart: code })).fetchProfiles(["x"], 1, null, 0.1), (e) => e.errorClass === cls);
  });
}

test("failed run with no items is blocked; aborted run keeps partial data", async () => {
  await assert.rejects(provider(new FakeApify({}, { status: "FAILED" })).fetchProfiles(["x"], 1, null, 0.1), (e) => e.errorClass === "blocked");
  const partial = new FakeApify({ "apify~instagram-scraper": load("apify_profile_posts.json").slice(0, 1) }, { status: "ABORTED" });
  const out = await provider(partial).fetchProfiles(["some.bistro"], 5, null, 0.01);
  assert.equal(out.get("some.bistro").posts.length, 1);
});

test("5xx is retried", async () => {
  const fake = fakeApify();
  let n = 0;
  const flaky = async (url, init) => (url.endsWith("/users/me") && ++n < 3 ? new Response('{"error":{}}', { status: 503 }) : fake.fetch(url, init));
  const a = new ApifyProvider("test-token", { fetchFn: flaky, sleepFn: async () => {} });
  assert.deepEqual(await a.check(), { username: "tester", plan: "FREE" });
  assert.equal(n, 3);
});

test("missing token", () => assert.throws(() => new ApifyProvider(""), (e) => e.errorClass === "config"));
