// Handoff records (schema_version 1.1) for Dataset Population.
//
// 1.1 adds platform (instagram | tiktok | facebook | google_maps), platform_id, link, and place
// (Google Maps records, type "place"). Non-Instagram keys are prefixed: tt_, fb_, gm_.
//
// One JSON line per (post, source). Follows the design doc's handoff contract, plus additive
// fields consumers may ignore (status, missing, stats, is_pinned, product_type).
// Internal fields (CDN links) are stripped: media is passed by storage key only.

import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_VERSION } from "./util.js";

const MEDIA_KEYS = ["idx", "kind", "storage_key", "cover_storage_key", "mime", "bytes", "width", "height", "duration_s"];
const POST_KEYS = ["platform", "shortcode", "platform_id", "url", "type", "author", "posted_at", "caption", "hashtags", "mentions",
  "location", "place", "link", "comments", "media", "stats", "is_pinned", "product_type"];

export function publicPost(record) {
  const out = Object.fromEntries(POST_KEYS.map((k) => [k, record[k] ?? null]));
  out.platform ??= "instagram"; // records stored before schema 1.1
  out.platform_id ??= out.shortcode;
  if (out.media) out.media = out.media.map((m) => Object.fromEntries(MEDIA_KEYS.map((k) => [k, m[k] ?? null])));
  return out;
}

/** Stable UUID-shaped id from a string (same post and source give the same id). */
function stableId(s) {
  const h = createHash("sha1").update(s).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function* records(store, { includePartial = false, userId = null } = {}) {
  for (const row of store.posts(includePartial ? ["COMPLETE", "PARTIAL"] : ["COMPLETE"])) {
    const post = publicPost(row.record);
    for (const src of row.sources.length ? row.sources : [{ kind: "unknown", handle: null, first_seen: row.first_seen }]) {
      yield {
        schema_version: SCHEMA_VERSION,
        event_id: stableId(`${post.shortcode}|${src.kind}|${src.handle}|${userId}`),
        user_id: userId,
        save: { source: src.kind, handle: src.handle, collection: src.kind === "collection" ? src.handle : null, saved_at: src.first_seen },
        post,
        provenance: row.provenance,
        status: row.status,
        missing: row.missing,
      };
    }
  }
}

export function writeJsonl(store, path, opts = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const lines = [...records(store, opts)].map((r) => JSON.stringify(r));
  writeFileSync(path + ".tmp", lines.join("\n") + (lines.length ? "\n" : ""));
  renameSync(path + ".tmp", path);
  return lines.length;
}
