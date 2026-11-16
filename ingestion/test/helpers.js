import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApifyProvider } from "../src/apify.js";
import { MediaStore } from "../src/media.js";

export const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
export const tmp = () => mkdtempSync(join(tmpdir(), "ig-"));
export const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(0)]);
export const MP4 = Uint8Array.from([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypisom"), ...new Array(64).fill(0)]);

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** In-memory Apify API: records runs, serves a dataset per actor (and per resultsType=details). */
export class FakeApify {
  constructor(datasets = {}, { status = "SUCCEEDED", failStart = null } = {}) {
    this.datasets = datasets;
    this.status = status;
    this.failStart = failStart;
    this.runs = [];
    this.fetch = this.fetch.bind(this);
  }
  async fetch(url, init = {}) {
    const u = new URL(url);
    const path = u.pathname;
    if (init.headers?.Authorization !== "Bearer test-token") return json(401, { error: { type: "token", message: "bad" } });
    if (init.method === "POST" && path.endsWith("/runs")) {
      if (this.failStart) return json(this.failStart, { error: { type: "x", message: "nope" } });
      const actor = path.split("/acts/")[1].split("/")[0];
      const input = JSON.parse(init.body);
      const key = actor + (input.resultsType === "details" ? "~details" : "");
      const id = `run${this.runs.length}`;
      this.runs.push({ actor, key, input, params: Object.fromEntries(u.searchParams) });
      return json(201, { data: { id, status: "RUNNING", defaultDatasetId: key } });
    }
    if (path.startsWith("/v2/actor-runs/")) {
      const run = this.runs[Number(path.split("/").pop().slice(3))];
      return json(200, { data: { id: "r", status: this.status, defaultDatasetId: run.key } });
    }
    if (path.startsWith("/v2/datasets/")) {
      const key = path.split("/")[3];
      return json(200, (this.datasets[key] || []).slice(Number(u.searchParams.get("offset") || 0)));
    }
    if (path === "/v2/users/me") return json(200, { data: { username: "tester", plan: { id: "FREE" } } });
    return json(404, { error: { type: "not-found", message: path } });
  }
}

export function fakeApify(extra = {}) {
  return new FakeApify({
    "apify~instagram-scraper": load("apify_profile_posts.json"),
    "apify~instagram-comment-scraper": load("apify_comments.json"),
    "apify~instagram-scraper~details": [{ inputUrl: "https://www.instagram.com/some.bistro/", username: "some.bistro", fullName: "Some Bistro", postsCount: 240, private: false, isBusinessAccount: true }],
    ...extra,
  });
}

export const provider = (fake, opts = {}) => new ApifyProvider("test-token", { fetchFn: fake.fetch, sleepFn: async () => {}, ...opts });

export async function cdnFetch(url) {
  const path = new URL(url).pathname;
  if (path.includes("broken")) return new Response(null, { status: 403 });
  return new Response(path.endsWith(".mp4") ? MP4 : JPEG, { status: 200 });
}
export const mediaStore = (root) => new MediaStore(root, { fetchFn: cdnFetch });
