import assert from "node:assert/strict";
import { test } from "node:test";
import { InputError, parseTarget, targetUrl } from "../src/canonical.js";

const ok = [
  ["nasa", { kind: "profile", value: "nasa" }],
  ["@Some.Bistro", { kind: "profile", value: "some.bistro" }],
  ["instagram.com/some_bistro", { kind: "profile", value: "some_bistro" }],
  ["https://www.instagram.com/nasa/?hl=en", { kind: "profile", value: "nasa" }],
  ["https://www.instagram.com/nasa/reels/", { kind: "profile", value: "nasa" }],
  ["https://www.instagram.com/p/DfahZrMjAqq/", { kind: "post", value: "DfahZrMjAqq" }],
  ["https://instagram.com/reel/DfahZrMjAqq?igsh=abc", { kind: "post", value: "DfahZrMjAqq" }],
  ["www.instagram.com/reels/C_xYz-12345/", { kind: "post", value: "C_xYz-12345" }],
  ["https://www.instagram.com/tv/C_xYz12345/#x", { kind: "post", value: "C_xYz12345" }],
  ["http://instagr.am/p/C_xYz12345/", { kind: "post", value: "C_xYz12345" }],
  ["https://www.instagram.com/nasa/p/DfahZrMjAqq/", { kind: "post", value: "DfahZrMjAqq" }],
];
for (const [raw, want] of ok) test(`accepts ${raw}`, () => assert.deepEqual(parseTarget(raw), want));

const bad = ["", "https://example.com/nasa", "https://www.instagram.com/stories/nasa/123/",
  "https://www.instagram.com/explore/tags/food/", "https://www.instagram.com/p/", "bad handle!", ".dot", "a..b", "explore", "instagram.com"];
for (const raw of bad) test(`rejects ${JSON.stringify(raw)}`, () => assert.throws(() => parseTarget(raw), InputError));

test("canonical post url is the /p/ form", () => {
  assert.equal(targetUrl(parseTarget("https://www.instagram.com/reel/DfahZrMjAqq/")), "https://www.instagram.com/p/DfahZrMjAqq/");
});
