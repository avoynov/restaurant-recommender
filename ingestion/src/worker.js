#!/usr/bin/env node
// Request worker for the GitHub Actions runner.
//
// The Pages app saves requests/{id}.json on main. The workflow runs this worker, which processes
// every request without a final status, keeps posts, media and statuses in the store folder (the
// `data` branch), and builds the public files the Pages app reads.
//
// Request kinds:
//   posts    { urls: [...], comments: 10, media: "all", label: "Date night", limit: 100 }
//            scrape these links: Instagram, TikTok and Facebook posts, Google Maps places and
//            public shared lists (limit = places per list)
//   inspect  { handle: "some.bistro" }                                          count posts, estimate cost
//   profile  { handle: "some.bistro", limit: 50, comments: 10 }                 scrape a profile's posts

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ApifyProvider, PRICE_PER_COMMENT_USD, PRICE_PER_POST_USD } from "./apify.js";
import { InputError, parseLink, parseTarget } from "./canonical.js";
import { MediaStore } from "./media.js";
import { linkProviders } from "./platforms.js";
import { publicPost } from "./export.js";
import { Pipeline } from "./pipeline.js";
import { Store } from "./store.js";
import { ProviderError, now, round } from "./util.js";

export const MAX_POSTS_PER_REQUEST = 500;
const MAX_COMMENTS = 50;
const FREE_COMMENTS = 10; // the posts actor returns about 10 recent comments per post at no extra cost

export const estimate = (nPosts, comments) =>
  round(nPosts * (PRICE_PER_POST_USD + Math.max(0, comments - FREE_COMMENTS) * PRICE_PER_COMMENT_USD), 4);

export class Worker {
  constructor(storeDir, { providers, media = null, monthlyCapUsd = 5 } = {}) {
    this.store = new Store(storeDir);
    this.providers = providers;
    this.media = media;
    this.monthlyCapUsd = monthlyCapUsd;
  }

  pending(requestsDir) {
    if (!existsSync(requestsDir)) return [];
    return readdirSync(requestsDir).filter((f) => f.endsWith(".json")).sort()
      .filter((f) => !["done", "failed"].includes(this.store.getStatus(f.slice(0, -5))?.state))
      .map((f) => join(requestsDir, f));
  }

  async process(path) {
    const id = path.split("/").pop().slice(0, -5);
    let req;
    try {
      req = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      return this.store.putStatus(id, { state: "failed", error: `request is not valid JSON: ${e.message}` });
    }
    this.store.putStatus(id, { state: "running", kind: req.kind, request: req, started_at: now() });
    if (!this.providers?.length) return this.store.putStatus(id, { state: "failed", error: "no provider configured (is APIFY_TOKEN set?)" });
    try {
      let result;
      if (req.kind === "inspect") result = await this.#inspect(req);
      else if (req.kind === "posts" || req.kind === "profile") result = await this.#scrape(req);
      else throw new InputError(`unknown request kind ${JSON.stringify(req.kind)}`);
      return this.store.putStatus(id, { state: "done", finished_at: now(), ...result });
    } catch (e) {
      if (!(e instanceof ProviderError || e instanceof InputError)) console.error(`request ${id} crashed:`, e);
      return this.store.putStatus(id, { state: "failed", finished_at: now(), error: e.message });
    }
  }

  async #inspect(req) {
    const t = parseTarget(req.handle || "");
    if (t.kind !== "profile") throw new InputError("inspect needs a profile handle or profile link");
    const apify = this.providers.find((p) => p.inspectProfiles && !p.platform);
    if (!apify) throw new InputError("inspect needs the Apify provider");
    const { profiles, cost } = await apify.inspectProfiles([t.value]);
    const info = profiles.get(t.value);
    this.store.logAttempt(`@${t.value}`, "tier2_apify_inspect", info instanceof ProviderError ? info.errorClass : "ok", { cost_usd: cost });
    if (info instanceof ProviderError) throw info;
    const comments = Number(req.comments ?? FREE_COMMENTS);
    info.estimate_usd_all = estimate(info.post_count || 0, comments);
    info.estimate_usd_first_500 = estimate(Math.min(info.post_count || 0, MAX_POSTS_PER_REQUEST), comments);
    return { profile: info, spent_usd: cost };
  }

  async #scrape(req) {
    const comments = Math.max(0, Math.min(Number(req.comments ?? FREE_COMMENTS), MAX_COMMENTS));
    const media = ["none", "covers", "all"].includes(req.media) ? req.media : "all";
    let targets = [];
    const rejected = [];
    let limit = 1;
    if (req.kind === "posts") {
      for (const u of req.urls || []) {
        try {
          const t = parseLink(u);
          if (t.kind !== "profile") targets.push(t);
          else rejected.push(`${u}: a profile, not a post link`);
        } catch (e) {
          rejected.push(e.message);
        }
      }
      targets = targets.slice(0, MAX_POSTS_PER_REQUEST);
    } else {
      const t = parseTarget(req.handle || "");
      if (t.kind !== "profile") throw new InputError("profile request needs a handle");
      targets = [t];
      limit = Math.max(1, Math.min(Number(req.limit) || 12, MAX_POSTS_PER_REQUEST));
    }
    if (!targets.length) throw new InputError(`no valid links in the request: ${rejected.slice(0, 5).join("; ")}`);

    const listLimit = Math.max(1, Math.min(Number(req.limit) || 100, MAX_POSTS_PER_REQUEST));
    const nPosts = req.kind === "posts" ? targets.length + targets.filter((t) => t.kind === "list").length * (listLimit - 1) : limit;
    const budgetUsd = Number(req.budget_usd) || Math.max(1, estimate(nPosts, comments) * 1.3);
    const pipe = new Pipeline(this.store, this.providers, { media: this.media, monthlyCapUsd: this.monthlyCapUsd, runBudgetUsd: budgetUsd });
    const rep = await pipe.run(targets, { limit, comments: comments > FREE_COMMENTS ? comments : 0, linkComments: comments, listLimit, media });

    const label = String(req.label || "").trim().slice(0, 80);
    for (const code of Object.keys(rep.posts)) {
      if (label) this.store.addSource(code, "collection", label);
      const row = this.store.getPost(code);
      if (row?.record?.comments?.length > comments) {
        row.record.comments = row.record.comments.slice(0, comments); // keep the top N asked for
        this.store.putPost(code, { record: row.record });
      }
    }
    return { posts: rep.posts, profiles: rep.profiles, links: rep.links, rejected, spent_usd: rep.spent_usd, media_errors: rep.media_errors.slice(0, 20) };
  }

  /** Files the Pages app reads: index.json, posts/{code}.json, media/. */
  buildPublic(out) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(out, "posts"), { recursive: true });
    const index = [];
    for (const row of this.store.posts(["COMPLETE", "PARTIAL"])) {
      const post = publicPost(row.record);
      const full = { post, provenance: row.provenance, status: row.status, missing: row.missing, sources: row.sources, updated_at: row.updated_at };
      writeFileSync(join(out, "posts", `${post.shortcode}.json`), JSON.stringify(full));
      const media = post.media || [];
      const thumbOf = (m) => (m.kind === "image" ? m.storage_key : m.cover_storage_key);
      const pl = post.place;
      index.push({
        shortcode: post.shortcode, platform: post.platform, type: post.type, author: post.author?.username ?? null,
        caption: (post.caption || "").slice(0, 200), posted_at: post.posted_at,
        thumb: media.map(thumbOf).find(Boolean) ?? null, n_media: media.length,
        has_video: media.some((m) => m.kind === "video" && m.storage_key),
        n_comments: post.comments?.length ?? 0, location: post.location?.name ?? null,
        place: pl ? { name: pl.name, rating: pl.rating, review_count: pl.review_count, category: pl.categories?.[0] ?? null, address: pl.address, price_level: pl.price_level } : null,
        status: row.status, sources: row.sources, updated_at: row.updated_at,
      });
    }
    index.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const requests = this.store.statuses().slice(0, 50).map((s) => ({
      id: s.id, kind: s.kind, state: s.state, error: s.error, started_at: s.started_at, finished_at: s.finished_at,
      spent_usd: s.spent_usd, profile: s.profile, posts: s.posts, links: s.links,
    }));
    writeFileSync(join(out, "index.json"), JSON.stringify({ generated_at: now(), posts: index, requests, spend: this.store.monthSpend() }));
    const mediaDir = join(this.store.root, "media");
    if (existsSync(mediaDir)) cpSync(mediaDir, join(out, "media"), { recursive: true });
    return index.length;
  }
}

async function main() {
  const { values } = parseArgs({ options: { requests: { type: "string" }, store: { type: "string" }, public: { type: "string" } } });
  if (!values.requests || !values.store) {
    console.error("usage: node src/worker.js --requests <dir> --store <dir> [--public <dir>]");
    process.exit(2);
  }
  const providers = [];
  const token = process.env.APIFY_TOKEN;
  try {
    providers.push(new ApifyProvider(token), ...linkProviders(token));
  } catch (e) {
    console.warn(e.message);
  }
  const media = new MediaStore(values.store, { apifyToken: token || null });
  const w = new Worker(values.store, { providers, media, monthlyCapUsd: Number(process.env.IG_MONTHLY_CAP_USD || 5) });
  const todo = w.pending(values.requests);
  console.log(`${todo.length} pending request(s)`);
  for (const p of todo) {
    const st = await w.process(p);
    console.log(`request ${st.id}: ${st.state}${st.error ? ` (${st.error})` : ""}`);
  }
  if (values.public) console.log(`public data: ${w.buildPublic(values.public)} posts`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
