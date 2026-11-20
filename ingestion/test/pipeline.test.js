import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseTarget } from "../src/canonical.js";
import { records, writeJsonl } from "../src/export.js";
import { assess, merge } from "../src/merge.js";
import { Pipeline, parseSince } from "../src/pipeline.js";
import { Store } from "../src/store.js";
import { Worker, estimate } from "../src/worker.js";
import { fakeApify, mediaStore, provider, tmp } from "./helpers.js";

async function run(targets, opts = {}, { cap = 5 } = {}) {
  const root = tmp();
  const fake = fakeApify();
  const store = new Store(root);
  const pipe = new Pipeline(store, [provider(fake)], { media: mediaStore(root), monthlyCapUsd: cap });
  const rep = await pipe.run(targets.map(parseTarget), opts);
  return { root, fake, store, rep };
}

test("end to end: profile, media saved, export follows the contract", async () => {
  const { root, store, rep } = await run(["some.bistro", "ghost.account"], { limit: 5 });
  assert.match(rep.profiles["some.bistro"], /^ok via tier2_apify \(3 posts\)/);
  assert.match(rep.profiles["ghost.account"], /^permanent/);
  assert.match(rep.posts.DAbCdEfGhIj, /^COMPLETE/);
  assert.equal(rep.posts.DImg0000000, "COMPLETE (missing: caption, comments)");

  const row = store.getPost("DAbCdEfGhIj");
  const [m0, m1] = row.record.media;
  assert.equal(m0.storage_key, "media/DAbCdEfGhIj/0.jpg");
  assert.equal(m0.mime, "image/jpeg");
  assert.equal(m1.cover_storage_key, "media/DAbCdEfGhIj/1_cover.jpg");
  assert.equal(m1.storage_key, null); // covers policy: video itself not saved
  assert.equal(row.provenance.caption, "tier2_apify");

  const out = join(root, "export.jsonl");
  assert.equal(writeJsonl(store, out), 3);
  const lines = readFileSync(out, "utf8").trim().split("\n").map(JSON.parse);
  const r = lines.find((x) => x.post.shortcode === "DAbCdEfGhIj");
  assert.equal(r.schema_version, "1.1");
  assert.equal(r.post.platform, "instagram");
  assert.equal(r.save.source, "profile_feed");
  assert.equal(r.save.handle, "some.bistro");
  const dumped = JSON.stringify(r);
  assert.ok(!dumped.includes("cdninstagram") && !dumped.includes("source_url"));
  assert.ok("location" in r.post && "comments" in r.post);
  assert.equal(lines.find((x) => x.post.shortcode === "DVid000000x").post.location, null);
});

test("media=all saves the video file", async () => {
  const { store } = await run(["some.bistro"], { media: "all" });
  const m = store.getPost("DVid000000x").record.media[0];
  assert.equal(m.storage_key, "media/DVid000000x/0.mp4");
  assert.equal(m.mime, "video/mp4");
});

test("deepen comments only for posts missing them", async () => {
  const { fake, store } = await run(["some.bistro"], { comments: 20 });
  const row = store.getPost("DImg0000000");
  assert.deepEqual(row.record.comments.map((c) => c.text), ["Gorgeous plating", "Is this the new menu?"]);
  assert.equal(row.provenance.comments, "tier2_apify");
  assert.ok(!fake.runs[1].input.directUrls.includes("https://www.instagram.com/p/DVid000000x/"));
});

test("budget exhausted skips the paid tier", async () => {
  const { fake, rep } = await run(["some.bistro"], {}, { cap: 0 });
  assert.equal(fake.runs.length, 0);
  assert.match(rep.profiles["some.bistro"], /budget/);
});

test("dry run only estimates", async () => {
  const { fake, rep } = await run(["a", "b"], { limit: 10, dryRun: true });
  assert.equal(rep.estimate_usd, 0.054);
  assert.equal(fake.runs.length, 0);
});

test("merge rules: manual wins, null never overwrites, storage keys carried", () => {
  const a = { shortcode: "X", caption: "from apify", comments: [{ text: "good", like_count: 3 }],
    media: [{ idx: 0, kind: "image", source_url: "u1", storage_key: "media/X/0.jpg", mime: "image/jpeg" }] };
  const first = merge(null, a, "tier2_apify");
  first.provenance.caption = "manual";
  first.record.caption = "typed by user";
  const b = { shortcode: "X", caption: "newer", comments: null, media: [{ idx: 0, kind: "image", source_url: "u2" }] };
  const { record, provenance } = merge(first, b, "tier2_other");
  assert.equal(record.caption, "typed by user");
  assert.equal(record.comments[0].text, "good");
  assert.equal(record.media[0].source_url, "u2");
  assert.equal(record.media[0].storage_key, "media/X/0.jpg");
  assert.equal(provenance.media, "tier2_other");
});

test("assess by media policy", () => {
  const rec = { type: "video", author: {}, posted_at: "t", caption: "c", comments: [],
    media: [{ kind: "video", cover_url: "c", storage_key: null, cover_storage_key: "k" }] };
  assert.deepEqual(assess(rec, "covers"), { status: "COMPLETE", missing: [] });
  assert.deepEqual(assess(rec, "all"), { status: "PARTIAL", missing: ["media"] });
});

test("parseSince", () => {
  assert.equal(parseSince("2026-01-31"), "2026-01-31");
  assert.equal(parseSince(null), null);
  assert.equal(parseSince("10 days", new Date("2026-11-16T00:00:00Z")), "2026-11-06");
});

test("worker: inspect, then profile with label, then posts; public build", async () => {
  const root = tmp();
  const reqDir = join(root, "requests");
  mkdirSync(reqDir);
  const reqs = {
    "001-inspect": { kind: "inspect", handle: "@some.bistro", comments: 10 },
    "002-profile": { kind: "profile", handle: "some.bistro", limit: 3, comments: 1, label: "Date night" },
    "003-posts": { kind: "posts", urls: ["https://www.instagram.com/reel/DVid000000x/", "nasa", "junk!"], comments: 5 },
  };
  for (const [id, body] of Object.entries(reqs)) writeFileSync(join(reqDir, `${id}.json`), JSON.stringify(body));
  const fake = fakeApify();
  const w = new Worker(join(root, "store"), { providers: [provider(fake)], media: mediaStore(join(root, "store")) });
  const todo = w.pending(reqDir);
  assert.equal(todo.length, 3);
  const [ins, prof, posts] = [await w.process(todo[0]), await w.process(todo[1]), await w.process(todo[2])];

  assert.equal(ins.state, "done");
  assert.equal(ins.profile.post_count, 240);
  assert.equal(ins.profile.estimate_usd_all, estimate(240, 10));

  assert.equal(prof.state, "done", prof.error);
  assert.deepEqual(Object.keys(prof.posts).sort(), ["DAbCdEfGhIj", "DImg0000000", "DVid000000x"]);
  const row = w.store.getPost("DAbCdEfGhIj");
  assert.equal(row.record.comments.length, 1); // trimmed to the N asked for
  assert.equal(row.record.media[1].storage_key, "media/DAbCdEfGhIj/1.mp4"); // videos saved by default

  assert.equal(posts.state, "done");
  assert.equal(posts.rejected.length, 2);
  assert.equal(w.pending(reqDir).length, 0);

  const out = join(root, "public");
  assert.equal(w.buildPublic(out), 3);
  const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
  const first = index.posts.find((p) => p.shortcode === "DAbCdEfGhIj");
  assert.equal(first.thumb, "media/DAbCdEfGhIj/0.jpg");
  assert.equal(first.has_video, true);
  assert.ok(first.sources.some((s) => s.kind === "collection" && s.handle === "Date night"));
  assert.ok(existsSync(join(out, "media/DAbCdEfGhIj/1.mp4")));
  assert.equal(index.requests.length, 3);
  assert.ok(!readFileSync(join(out, "posts/DAbCdEfGhIj.json"), "utf8").includes("cdninstagram"));
});

test("worker: bad requests fail cleanly", async () => {
  const root = tmp();
  const reqDir = join(root, "requests");
  mkdirSync(reqDir);
  writeFileSync(join(reqDir, "a.json"), JSON.stringify({ kind: "posts", urls: ["https://example.com/x"] }));
  writeFileSync(join(reqDir, "b.json"), JSON.stringify({ kind: "nope" }));
  writeFileSync(join(reqDir, "c.json"), "{not json");
  const w = new Worker(join(root, "store"), { providers: [provider(fakeApify())], media: mediaStore(join(root, "store")) });
  const states = [];
  for (const p of w.pending(reqDir)) states.push(await w.process(p));
  assert.deepEqual(states.map((s) => s.state), ["failed", "failed", "failed"]);
  assert.match(states[0].error, /no valid links/);
});

test("raw payloads drop commenter identities", () => {
  const s = new Store(tmp());
  s.putRaw("X", "p", { latestComments: [{ text: "hi", ownerUsername: "someone", owner: { u: 1 } }] });
  const stored = JSON.parse(readFileSync(join(s.root, "raw", "X.p.json"), "utf8"));
  assert.deepEqual(stored.payload, { latestComments: [{ text: "hi" }] });
});

test("unavailable posts are not exported", async () => {
  const s = new Store(tmp());
  s.markUnavailable("DGone000000", "removed");
  assert.equal([...records(s, { includePartial: true })].length, 0);
});
