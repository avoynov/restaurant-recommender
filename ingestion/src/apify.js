// Hosted tier: Apify actors, logged-out, pay per result.
//
//   apify/instagram-scraper          profile feeds, single posts, profile details   ~$0.0027 per result (free plan)
//   apify/instagram-comment-scraper  deeper comments, optional                      ~$0.0026 per comment
//
// All handles in one call share a single actor run. Every run carries maxTotalChargeUsd,
// so Apify itself stops a run before it spends more than we allow.

import { postUrl, profileUrl, shortcodeOf } from "./canonical.js";
import {
  ProviderError, blocked, configError, isoUtc, nonNeg, normalizeTag, permanent, round, sleep,
  toFloat, toInt, topComments, transient,
} from "./util.js";

const API = "https://api.apify.com/v2";
export const POSTS_ACTOR = "apify~instagram-scraper";
export const COMMENTS_ACTOR = "apify~instagram-comment-scraper";
export const PRICE_PER_POST_USD = 0.0027;
export const PRICE_PER_COMMENT_USD = 0.0026;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
const PERMANENT_HINTS = ["not_found", "not found", "private", "doesn't exist", "does not exist", "no_items", "restricted"];

export class ApifyProvider {
  name = "tier2_apify";

  constructor(token, { fetchFn = globalThis.fetch, runTimeoutS = 600, pollS = 30, sleepFn = sleep,
    pricePerPost = PRICE_PER_POST_USD, pricePerComment = PRICE_PER_COMMENT_USD } = {}) {
    if (!token) throw configError("APIFY_TOKEN is not set");
    this.token = token;
    this.fetch = fetchFn;
    this.runTimeoutS = runTimeoutS;
    this.pollS = pollS;
    this.sleep = sleepFn;
    this.pricePerPost = pricePerPost;
    this.pricePerComment = pricePerComment;
  }

  async check() {
    const { data } = await this.request("GET", "/users/me");
    return { username: data.username, plan: data.plan?.id ?? null };
  }

  estimateCost(nPosts, nComments = 0) {
    return round(nPosts * this.pricePerPost + nComments * this.pricePerComment, 4);
  }

  /** One run for all handles. Returns Map(handle -> {posts, raw, cost_usd} | ProviderError). */
  async fetchProfiles(handles, limit, since, maxChargeUsd) {
    const urls = new Map(handles.map((h) => [profileUrl(h), h]));
    const input = { directUrls: [...urls.keys()], resultsType: "posts", resultsLimit: limit, addParentData: false };
    if (since) input.onlyPostsNewerThan = since;
    const { items, cost } = await this.run(POSTS_ACTOR, input, maxChargeUsd);

    const out = new Map(handles.map((h) => [h, { posts: [], raw: [], cost_usd: 0 }]));
    for (const item of items) {
      const h = ownerHandle(item, urls);
      if (!h) continue;
      if (item.error) { out.set(h, itemError(item)); continue; }
      const res = out.get(h);
      if (res instanceof ProviderError) continue;
      try {
        res.posts.push(this.normalize(item));
        res.raw.push(item);
      } catch (e) {
        console.warn(`apify item for @${h} could not be normalized: ${e.message}`);
      }
    }
    const total = [...out.values()].reduce((n, r) => n + (r instanceof ProviderError ? 0 : r.posts.length), 0) || 1;
    for (const r of out.values()) if (!(r instanceof ProviderError)) r.cost_usd = round((cost * r.posts.length) / total);
    return out;
  }

  /** Single posts by shortcode. Returns Map(code -> {posts, raw, cost_usd} | ProviderError). */
  async fetchPosts(codes, maxChargeUsd) {
    const input = { directUrls: codes.map(postUrl), resultsType: "posts", resultsLimit: 1, addParentData: false };
    const { items, cost } = await this.run(POSTS_ACTOR, input, maxChargeUsd);
    const ok = items.filter((i) => !i.error).length || 1;
    const out = new Map();
    for (const item of items) {
      const code = item.shortCode || shortcodeOf(item.inputUrl || item.url);
      if (!code) continue;
      if (item.error) out.set(code, itemError(item));
      else if (codes.includes(code)) out.set(code, { posts: [this.normalize(item)], raw: [item], cost_usd: round(cost / ok) });
    }
    for (const c of codes) if (!out.has(c)) out.set(c, permanent("post not returned (removed, private or not found)"));
    return out;
  }

  /** Deeper comments via the comment actor. Commenter handles are dropped here. */
  async fetchComments(codes, perPost, maxChargeUsd) {
    const input = { directUrls: codes.map(postUrl), resultsLimit: perPost, includeNestedComments: false };
    const { items, cost } = await this.run(COMMENTS_ACTOR, input, maxChargeUsd, this.pricePerComment);
    const out = new Map(codes.map((c) => [c, []]));
    for (const item of items) {
      if (item.error) continue;
      const code = shortcodeOf(item.postUrl || item.inputUrl);
      const text = (item.text || "").trim();
      if (out.has(code) && text) out.get(code).push({ text, like_count: toInt(item.likesCount), created_at: isoUtc(item.timestamp) });
    }
    for (const [c, cs] of out) out.set(c, topComments(cs));
    return { comments: out, cost };
  }

  /** Profile facts, mainly the post count, so the user can approve a full scrape. */
  async inspectProfiles(handles, maxChargeUsd = 0.05) {
    const urls = new Map(handles.map((h) => [profileUrl(h), h]));
    const { items, cost } = await this.run(POSTS_ACTOR, { directUrls: [...urls.keys()], resultsType: "details", resultsLimit: 1 }, maxChargeUsd);
    const out = new Map();
    for (const item of items) {
      const h = ownerHandle({ inputUrl: item.inputUrl, ownerUsername: item.username }, urls);
      if (!h) continue;
      out.set(h, item.error ? itemError(item) : {
        handle: h, full_name: item.fullName || null, post_count: toInt(item.postsCount),
        private: Boolean(item.private), is_business: item.isBusinessAccount ?? null, verified: item.verified ?? null,
      });
    }
    for (const h of handles) if (!out.has(h)) out.set(h, permanent("profile not found"));
    return { profiles: out, cost };
  }

  normalize(item) {
    const code = item.shortCode;
    if (!code) throw new Error("item has no shortCode");
    const type = { Image: "image", Video: "video", Sidecar: "carousel" }[item.type] ?? null;
    const comments = (item.latestComments || [])
      .filter((c) => c && (c.text || "").trim())
      .map((c) => ({ text: c.text.trim(), like_count: toInt(c.likesCount), created_at: isoUtc(c.timestamp) }));
    const nComments = toInt(item.commentsCount);
    let commentsVal = null; // comments exist but we didn't get them
    if (comments.length) commentsVal = topComments(comments);
    else if (nComments === 0 || item.isCommentsDisabled) commentsVal = [];

    return {
      shortcode: code,
      url: postUrl(code),
      type,
      author: { username: item.ownerUsername || null, full_name: item.ownerFullName || null, is_business: null },
      posted_at: isoUtc(item.timestamp),
      caption: item.caption ?? null,
      hashtags: (item.hashtags || []).map((t) => normalizeTag(t, "#")),
      mentions: (item.mentions || []).map((m) => normalizeTag(m, "@")),
      location: item.locationName || item.locationId
        ? { name: item.locationName || null, ig_location_id: item.locationId ? String(item.locationId) : null, lat: null, lng: null }
        : null,
      comments: commentsVal,
      media: mediaOf(item, type),
      stats: { like_count: nonNeg(item.likesCount), comment_count: nComments, view_count: nonNeg(item.videoPlayCount ?? item.videoViewCount) },
      is_pinned: item.isPinned ?? null,
      product_type: item.productType ?? null,
    };
  }

  // ---- HTTP plumbing ------------------------------------------------------------------------

  async run(actor, input, maxChargeUsd, unitPrice = this.pricePerPost) {
    const qs = new URLSearchParams({ timeout: String(this.runTimeoutS), maxTotalChargeUsd: maxChargeUsd.toFixed(4) });
    let { data: run } = await this.request("POST", `/acts/${actor}/runs?${qs}`, input);
    const deadline = Date.now() + (this.runTimeoutS + 120) * 1000;
    while (!TERMINAL.has(run.status)) {
      if (Date.now() > deadline) throw transient(`apify run ${run.id} did not finish in time`);
      ({ data: run } = await this.request("GET", `/actor-runs/${run.id}?waitForFinish=${this.pollS}`));
      if (!TERMINAL.has(run.status)) await this.sleep(1000);
    }
    const items = await this.datasetItems(run.defaultDatasetId);
    const cost = runCost(run, items.filter((i) => !i.error).length, unitPrice);
    console.log(`apify run ${run.id} ${run.status}: ${items.length} items, ~$${cost.toFixed(4)}`);
    // TIMED-OUT or ABORTED (for example the charge cap was reached) with partial data still counts.
    if (run.status === "SUCCEEDED" || items.length) return { items, cost };
    const msg = run.statusMessage || run.status;
    if (run.status === "TIMED-OUT") throw transient(`apify run timed out: ${msg}`);
    throw blocked(`apify run ${run.status.toLowerCase()}: ${msg}`);
  }

  async datasetItems(id) {
    const items = [];
    for (let offset = 0; ; offset += 1000) {
      const batch = await this.request("GET", `/datasets/${id}/items?clean=true&format=json&offset=${offset}&limit=1000`);
      items.push(...batch);
      if (batch.length < 1000) return items;
    }
  }

  async request(method, path, body, attempts = 4) {
    let delay = 2000;
    for (let attempt = 1; ; attempt++) {
      let err;
      try {
        const r = await this.fetch(API + path, {
          method,
          headers: { Authorization: `Bearer ${this.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (r.status < 400) return await r.json();
        err = await httpError(r);
      } catch (e) {
        err = e instanceof ProviderError ? e : transient(`network error talking to Apify: ${e.message}`);
      }
      if (err.errorClass !== "transient" || attempt >= attempts) throw err;
      await this.sleep(delay);
      delay *= 3;
    }
  }
}

async function httpError(r) {
  let detail = "";
  try {
    const e = (await r.json()).error || {};
    detail = [e.type, e.message].filter(Boolean).join(": ");
  } catch {
    detail = (await r.text().catch(() => "")).slice(0, 200);
  }
  const msg = `Apify HTTP ${r.status} ${detail}`.trim();
  const low = detail.toLowerCase();
  if (r.status === 429 || r.status >= 500) return transient(msg);
  if (r.status === 402 || ["credit", "usage", "limit-exceeded", "not-enough"].some((k) => low.includes(k))) {
    return blocked(`${msg} (out of credit or over the monthly limit)`);
  }
  if (r.status === 401 || r.status === 403) return configError(`${msg} (check APIFY_TOKEN)`);
  if (r.status === 404) return configError(`${msg} (actor or run not found)`);
  return blocked(msg);
}

function itemError(item) {
  const text = [item.error, item.errorDescription].filter(Boolean).join(": ");
  return PERMANENT_HINTS.some((k) => text.toLowerCase().includes(k)) ? permanent(text) : blocked(text);
}

function ownerHandle(item, urls) {
  const input = (item.inputUrl || "").replace(/\/?$/, "/");
  if (urls.has(input)) return urls.get(input);
  const owner = (item.ownerUsername || "").toLowerCase();
  return [...urls.values()].includes(owner) ? owner : null;
}

/** Prefer what Apify actually charged; fall back to items x list price. */
function runCost(run, nItems, unitPrice) {
  const counts = run.chargedEventCounts || {};
  const prices = run.pricingInfo?.pricingPerEvent?.actorChargeEvents || {};
  let total = 0;
  for (const [event, count] of Object.entries(counts)) {
    const p = prices[event] || {};
    const unit = p.eventPriceUsd ?? p.eventTieredPricingUsd?.FREE?.tieredEventPriceUsd;
    if (unit != null) total += unit * count;
  }
  return round(total || nItems * unitPrice);
}

function mediaOf(item, type) {
  const one = (node, idx) => {
    if (node.type === "Video" || node.videoUrl) {
      if (!node.videoUrl && !node.displayUrl) return null;
      return { idx, kind: "video", source_url: node.videoUrl || null, cover_url: node.displayUrl || null,
        width: toInt(node.dimensionsWidth), height: toInt(node.dimensionsHeight), duration_s: toFloat(node.videoDuration) };
    }
    if (node.displayUrl) {
      return { idx, kind: "image", source_url: node.displayUrl, cover_url: null,
        width: toInt(node.dimensionsWidth), height: toInt(node.dimensionsHeight), duration_s: null };
    }
    return null;
  };
  if (type === "carousel") {
    const children = item.childPosts || [];
    if (children.length) return children.map(one).filter(Boolean).map(withStorage);
    return (item.images || []).filter(Boolean).map((u, idx) => withStorage({ idx, kind: "image", source_url: u, cover_url: null, width: null, height: null, duration_s: null }));
  }
  const m = one(item, 0);
  return m ? [withStorage(m)] : [];
}

const withStorage = (m) => ({ ...m, storage_key: null, cover_storage_key: null, mime: null, bytes: null });
