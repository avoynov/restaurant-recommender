// File store: plain JSON files, so the data branch is readable and diffable.
//
//   posts/{shortcode}.json   { record, provenance, status, missing, sources, first_seen, updated_at }
//   raw/{shortcode}.{provider}.json   provider payload (commenters scrubbed), to re-normalize for free
//   status/{request id}.json          one file per request from the Pages app
//   ledger.jsonl                      every provider attempt, with cost; drives the spend caps
//   media/{shortcode}/...             saved photos and videos (written by media.js)

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { now } from "./util.js";

const COMMENT_LISTS = ["latestComments", "comments", "preview_comments"];
const COMMENTER_KEYS = new Set(["ownerUsername", "owner", "ownerProfilePicUrl", "ownerId", "user", "replies"]);

/** Drop who wrote each comment from raw payloads too (design: commenter handles are never stored). */
export function scrubCommenters(payload) {
  const out = { ...payload };
  for (const k of COMMENT_LISTS) {
    if (Array.isArray(out[k])) {
      out[k] = out[k].map((c) => (c && typeof c === "object" ? Object.fromEntries(Object.entries(c).filter(([key]) => !COMMENTER_KEYS.has(key))) : c));
    }
  }
  return out;
}

export class Store {
  constructor(root) {
    this.root = root;
    for (const d of ["posts", "raw", "status"]) mkdirSync(join(root, d), { recursive: true });
  }

  #path(...p) { return join(this.root, ...p); }
  #read(p) { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; }
  #write(p, obj) {
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(obj, null, 1));
    renameSync(tmp, p);
  }

  // posts ----------------------------------------------------------------------------------

  getPost(code) { return this.#read(this.#path("posts", `${code}.json`)); }

  putPost(code, fields) {
    const prev = this.getPost(code) || { sources: [], first_seen: now() };
    const row = { ...prev, ...fields, updated_at: now() };
    this.#write(this.#path("posts", `${code}.json`), row);
    return row;
  }

  markUnavailable(code, reason) {
    const prev = this.getPost(code);
    this.putPost(code, {
      record: prev?.record || { shortcode: code },
      provenance: { ...(prev?.provenance || {}), unavailable_reason: reason },
      status: "UNAVAILABLE",
      missing: ["all"],
    });
  }

  addSource(code, kind, handle = null) {
    const row = this.getPost(code);
    if (!row) return;
    if (!row.sources.some((s) => s.kind === kind && s.handle === handle)) {
      row.sources.push({ kind, handle, first_seen: now() });
      this.#write(this.#path("posts", `${code}.json`), row);
    }
  }

  *posts(statuses = null) {
    for (const f of readdirSync(this.#path("posts")).filter((f) => f.endsWith(".json")).sort()) {
      const row = this.#read(this.#path("posts", f));
      if (row && (!statuses || statuses.includes(row.status))) yield row;
    }
  }

  putRaw(code, provider, payload) {
    this.#write(this.#path("raw", `${code}.${provider}.json`), { fetched_at: now(), payload: scrubCommenters(payload) });
  }

  // requests --------------------------------------------------------------------------------

  getStatus(id) { return this.#read(this.#path("status", `${id}.json`)); }
  putStatus(id, fields) {
    const st = { ...(this.getStatus(id) || { id }), ...fields, updated_at: now() };
    this.#write(this.#path("status", `${id}.json`), st);
    return st;
  }
  statuses() {
    return readdirSync(this.#path("status")).filter((f) => f.endsWith(".json")).sort().reverse()
      .map((f) => this.#read(this.#path("status", f)));
  }

  // audit and spend -------------------------------------------------------------------------

  logAttempt(target, provider, outcome, { detail = null, ms = null, n_posts = null, cost_usd = 0 } = {}) {
    const line = { at: now(), target, provider, outcome, detail: detail ? String(detail).slice(0, 500) : null, ms, n_posts, cost_usd };
    appendFileSync(this.#path("ledger.jsonl"), JSON.stringify(line) + "\n");
  }

  *ledger() {
    const p = this.#path("ledger.jsonl");
    if (!existsSync(p)) return;
    for (const l of readFileSync(p, "utf8").split("\n")) if (l.trim()) yield JSON.parse(l);
  }

  spendSince(iso, prefix = "tier2_") {
    let s = 0;
    for (const a of this.ledger()) if (a.at >= iso && a.provider.startsWith(prefix)) s += a.cost_usd || 0;
    return Math.round(s * 1e4) / 1e4;
  }

  monthSpend() {
    return this.spendSince(new Date().toISOString().slice(0, 7) + "-01T00:00:00Z");
  }

  summary() {
    const posts = {};
    for (const p of this.posts()) posts[p.status] = (posts[p.status] || 0) + 1;
    const attempts = {};
    for (const a of this.ledger()) {
      const k = `${a.provider} ${a.outcome}`;
      attempts[k] = attempts[k] || { n: 0, cost_usd: 0 };
      attempts[k].n++;
      attempts[k].cost_usd = Math.round((attempts[k].cost_usd + (a.cost_usd || 0)) * 1e4) / 1e4;
    }
    return { posts, attempts, spend_this_month_usd: this.monthSpend() };
  }
}
