// Orchestration: targets in, merged and stored post records out.
//
// Providers are tried in order; a target one provider can't serve (blocked, transient) falls
// through to the next, a permanent error (private, missing) stops there. Then comments are
// optionally deepened, media is saved and each post is graded COMPLETE or PARTIAL.

import { assess, merge } from "./merge.js";
import { MediaStore } from "./media.js";
import { PRICE_PER_COMMENT_USD, PRICE_PER_POST_USD } from "./apify.js";
import { platformOfKey } from "./canonical.js";
import { ProviderError, blocked, configError, round, topComments } from "./util.js";

export const defaults = { limit: 12, since: null, comments: 0, linkComments: 0, listLimit: 100, media: "covers", budgetUsd: null, dryRun: false };
const isInstagram = (x) => !x.platform || x.platform === "instagram";

/** YYYY-MM-DD, ISO, or relative ("30 days", "6 months", "1 year") to YYYY-MM-DD. */
export function parseSince(since, today = new Date()) {
  if (!since) return null;
  const m = String(since).trim().toLowerCase().match(/^(\d+)\s*(day|week|month|year)s?$/);
  if (m) {
    const days = Number(m[1]) * { day: 1, week: 7, month: 30, year: 365 }[m[2]];
    return new Date(today.getTime() - days * 864e5).toISOString().slice(0, 10);
  }
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) throw configError(`--since must be a date (2026-01-31) or relative ('6 months'), got ${since}`);
  return d.toISOString().slice(0, 10);
}

export function estimateUsd(nPosts, comments = 0) {
  return round(nPosts * PRICE_PER_POST_USD + nPosts * comments * PRICE_PER_COMMENT_USD, 4);
}

class Budget {
  constructor(store, monthlyCapUsd, runBudgetUsd) {
    this.monthLeft = Math.max(0, monthlyCapUsd - store.monthSpend());
    this.runLeft = runBudgetUsd;
  }
  allowance(estimate) { return round(Math.min(this.monthLeft, this.runLeft, estimate * 1.25 + 0.01), 4); }
  spend(usd) { this.monthLeft -= usd; this.runLeft -= usd; }
}

export class Pipeline {
  constructor(store, providers, { media = null, monthlyCapUsd = 5, runBudgetUsd = 1 } = {}) {
    this.store = store;
    this.providers = providers.filter(isInstagram);
    this.linkProviders = providers.filter((p) => !isInstagram(p));
    this.media = media || new MediaStore(store.root);
    this.monthlyCapUsd = monthlyCapUsd;
    this.runBudgetUsd = runBudgetUsd;
  }

  async run(targets, options = {}) {
    const opts = { ...defaults, ...options };
    const rep = { profiles: {}, posts: {}, links: {}, spent_usd: 0, media_errors: [], estimate_usd: 0 };
    const budget = new Budget(this.store, this.monthlyCapUsd, opts.budgetUsd ?? this.runBudgetUsd);
    const since = parseSince(opts.since);
    const ig = targets.filter(isInstagram);
    const handles = [...new Set(ig.filter((t) => t.kind === "profile").map((t) => t.value))];
    const codes = [...new Set(ig.filter((t) => t.kind === "post").map((t) => t.value))];
    const byPlatform = new Map();
    for (const t of targets.filter((x) => !isInstagram(x))) {
      if (!byPlatform.has(t.platform)) byPlatform.set(t.platform, new Map());
      byPlatform.get(t.platform).set(t.url, t); // dedupe by link
    }
    rep.estimate_usd = estimateUsd(handles.length * opts.limit + codes.length, opts.comments);
    for (const [platform, ts] of byPlatform) {
      const prov = this.linkProviders.find((p) => p.platform === platform);
      if (prov) rep.estimate_usd = round(rep.estimate_usd + prov.estimateLinks([...ts.values()], this.#linkOpts(opts)), 4);
    }
    if (opts.dryRun) return rep;

    const touched = new Set();
    if (handles.length) await this.#profiles(handles, opts.limit, since, budget, rep, touched);
    if (codes.length) await this.#posts(codes, budget, rep, touched);
    for (const [platform, ts] of byPlatform) await this.#links(platform, [...ts.values()], opts, budget, rep, touched);
    if (opts.comments > 0 && touched.size) await this.#deepenComments([...touched], opts.comments, budget, rep);
    for (const code of [...touched].sort()) await this.#finish(code, opts.media, rep);
    rep.spent_usd = round(rep.spent_usd, 4);
    return rep;
  }

  async #profiles(handles, limit, since, budget, rep, touched) {
    let remaining = handles;
    for (const prov of this.providers) {
      if (!remaining.length) break;
      const charge = budget.allowance(prov.estimateCost(remaining.length * limit));
      if (charge < 0.01) {
        for (const h of remaining) this.store.logAttempt(`@${h}`, prov.name, "skipped", { detail: "budget exhausted" });
        for (const h of remaining) rep.profiles[h] = "skipped: budget exhausted";
        continue;
      }
      const t0 = Date.now();
      let results;
      try {
        results = await prov.fetchProfiles(remaining, limit, since, charge);
      } catch (e) {
        const err = e instanceof ProviderError ? e : blocked(e.message);
        results = new Map(remaining.map((h) => [h, err]));
      }
      const ms = Date.now() - t0;
      const next = [];
      for (const h of remaining) {
        const res = results.get(h) || blocked("no result");
        if (res instanceof ProviderError) {
          this.store.logAttempt(`@${h}`, prov.name, res.errorClass, { detail: res.message, ms });
          rep.profiles[h] = `${res.errorClass} via ${prov.name}: ${res.message}`;
          if (res.errorClass !== "permanent") next.push(h);
          continue;
        }
        budget.spend(res.cost_usd);
        rep.spent_usd += res.cost_usd;
        this.store.logAttempt(`@${h}`, prov.name, "ok", { ms, n_posts: res.posts.length, cost_usd: res.cost_usd });
        res.posts.forEach((post, i) => {
          this.#save(post, res.raw[i], prov.name);
          this.store.addSource(post.shortcode, "profile_feed", h);
          touched.add(post.shortcode);
        });
        rep.profiles[h] = `ok via ${prov.name} (${res.posts.length} posts)`;
      }
      remaining = next;
    }
  }

  async #posts(codes, budget, rep, touched) {
    let remaining = codes;
    for (const prov of this.providers) {
      if (!remaining.length) break;
      const charge = budget.allowance(prov.estimateCost(remaining.length));
      if (charge < 0.01) {
        for (const c of remaining) rep.posts[c] = "skipped: budget exhausted";
        continue;
      }
      const t0 = Date.now();
      let results;
      try {
        results = await prov.fetchPosts(remaining, charge);
      } catch (e) {
        const err = e instanceof ProviderError ? e : blocked(e.message);
        results = new Map(remaining.map((c) => [c, err]));
      }
      const ms = Date.now() - t0;
      const next = [];
      for (const c of remaining) {
        const res = results.get(c) || blocked("no result");
        if (!(res instanceof ProviderError) && res.posts.length) {
          budget.spend(res.cost_usd);
          rep.spent_usd += res.cost_usd;
          this.store.logAttempt(c, prov.name, "ok", { ms, n_posts: 1, cost_usd: res.cost_usd });
          this.#save(res.posts[0], res.raw[0], prov.name);
          this.store.addSource(c, "post_url");
          touched.add(c);
        } else if (res.errorClass === "permanent") {
          this.store.logAttempt(c, prov.name, "permanent", { detail: res.message, ms });
          this.store.markUnavailable(c, res.message);
          this.store.addSource(c, "post_url");
          rep.posts[c] = `UNAVAILABLE (${res.message})`;
        } else {
          const err = res instanceof ProviderError ? res : blocked("empty result");
          this.store.logAttempt(c, prov.name, err.errorClass, { detail: err.message, ms });
          rep.posts[c] = `failed via ${prov.name}: ${err.message}`;
          next.push(c);
        }
      }
      remaining = next;
    }
  }

  #linkOpts(opts) {
    return { comments: opts.linkComments, media: opts.media, listLimit: opts.listLimit };
  }

  /** TikTok, Facebook and Google Maps links: providers for the platform in fallback order. */
  async #links(platform, targets, opts, budget, rep, touched) {
    let remaining = targets;
    const provs = this.linkProviders.filter((p) => p.platform === platform);
    if (!provs.length) for (const t of targets) rep.links[t.url] = `no provider for ${platform}`;
    for (const prov of provs) {
      if (!remaining.length) break;
      const est = prov.estimateLinks(remaining, this.#linkOpts(opts));
      const left = Math.min(budget.monthLeft, budget.runLeft);
      if (left < est || left < 0.01) {
        for (const t of remaining) {
          this.store.logAttempt(t.url, prov.name, "skipped", { detail: "budget exhausted" });
          rep.links[t.url] = "skipped: budget exhausted";
        }
        continue;
      }
      const t0 = Date.now();
      let results, cost = 0;
      try {
        ({ results, cost } = await prov.fetchLinks(remaining, this.#linkOpts(opts), budget.allowance(est)));
      } catch (e) {
        const err = e instanceof ProviderError ? e : blocked(e.message);
        results = new Map(remaining.map((t) => [t.url, err]));
      }
      budget.spend(cost);
      rep.spent_usd += cost;
      const ms = Date.now() - t0;
      const next = [];
      const nOk = [...results.values()].reduce((n, r) => n + (r instanceof ProviderError ? 0 : r.posts.length), 0) || 1;
      for (const t of remaining) {
        const res = results.get(t.url) || blocked("no result");
        if (res instanceof ProviderError) {
          this.store.logAttempt(t.url, prov.name, res.errorClass, { detail: res.message, ms });
          rep.links[t.url] = `${res.errorClass === "permanent" ? "UNAVAILABLE" : "failed"} via ${prov.name}: ${res.message}`;
          if (res.errorClass !== "permanent") next.push(t);
          continue;
        }
        this.store.logAttempt(t.url, prov.name, "ok", { ms, n_posts: res.posts.length, cost_usd: round((cost * res.posts.length) / nOk) });
        res.posts.forEach((post, i) => {
          this.#save(post, res.raw[i], prov.name);
          if (t.kind === "list") this.store.addSource(post.shortcode, "maps_list", t.url);
          else this.store.addSource(post.shortcode, "post_url", null);
          touched.add(post.shortcode);
        });
        rep.links[t.url] = `ok via ${prov.name} (${res.posts.length} ${platform === "google_maps" ? "place" : "post"}${res.posts.length === 1 ? "" : "s"})`;
      }
      remaining = next;
    }
  }

  async #deepenComments(codes, perPost, budget, rep) {
    const apify = this.providers.find((p) => p.fetchComments);
    if (!apify) return;
    const want = codes.filter((c) => platformOfKey(c) === "instagram").filter((c) => {
      const row = this.store.getPost(c);
      if (!row || row.provenance?.comments === "manual") return false;
      const have = row.record.comments?.length ?? 0;
      return (row.record.stats?.comment_count ?? 0) > have && have < perPost;
    });
    if (!want.length) return;
    const charge = Math.min(budget.monthLeft, budget.runLeft, apify.estimateCost(0, want.length * perPost) * 1.25 + 0.01);
    if (charge < 0.01) return;
    const t0 = Date.now();
    let got;
    try {
      got = await apify.fetchComments(want, perPost, charge);
    } catch (e) {
      this.store.logAttempt(`comments x${want.length}`, `${apify.name}_comments`, e.errorClass || "blocked", { detail: e.message });
      return;
    }
    budget.spend(got.cost);
    rep.spent_usd += got.cost;
    this.store.logAttempt(`comments x${want.length}`, `${apify.name}_comments`, "ok", { ms: Date.now() - t0, n_posts: want.length, cost_usd: got.cost });
    for (const [c, comments] of got.comments) {
      if (!comments.length) continue;
      const row = this.store.getPost(c);
      row.record.comments = topComments([...(row.record.comments || []), ...comments]);
      row.provenance.comments = apify.name;
      this.store.putPost(c, { record: row.record, provenance: row.provenance });
    }
  }

  async #finish(code, policy, rep) {
    const row = this.store.getPost(code);
    if (!row) return;
    const errors = await this.media.downloadPost(row.record, policy);
    if (errors.length) {
      rep.media_errors.push(...errors);
      this.store.logAttempt(code, "media", "blocked", { detail: errors.join("; ") });
    }
    const { status, missing } = assess(row.record, policy);
    this.store.putPost(code, { record: row.record, status, missing });
    rep.posts[code] = status + (missing.length ? ` (missing: ${missing.join(", ")})` : "");
  }

  #save(post, raw, provider) {
    const merged = merge(this.store.getPost(post.shortcode), post, provider);
    const { status, missing } = assess(merged.record, "none");
    this.store.putPost(post.shortcode, { ...merged, status, missing });
    if (raw) this.store.putRaw(post.shortcode, provider, raw);
  }
}
