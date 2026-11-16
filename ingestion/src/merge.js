// Field-level merge of a fresh fetch into the stored record, with provenance.
//   * null never overwrites a value we already have;
//   * a field filled by hand ("manual") is never overwritten by an automated tier;
//   * otherwise the fresher automated value wins (CDN links and counts go stale);
//   * media already saved keeps its storage keys if the post's media layout is unchanged.

import { now } from "./util.js";

export const MERGE_FIELDS = ["type", "author", "posted_at", "caption", "hashtags", "mentions", "location", "comments", "media", "stats"];
const EXTRA = ["is_pinned", "product_type", "url"];

export function merge(existing, fresh, provider) {
  let record, prov;
  if (!existing?.record?.type && !existing?.record?.media) {
    record = structuredClone(fresh);
    prov = Object.fromEntries(MERGE_FIELDS.map((f) => [f, fresh[f] != null ? provider : null]));
  } else {
    record = structuredClone(existing.record);
    prov = { ...existing.provenance };
    for (const f of MERGE_FIELDS) {
      let val = fresh[f];
      if (val == null || prov[f] === "manual") continue;
      if (f === "media") val = carryStorage(record.media, val);
      record[f] = structuredClone(val);
      prov[f] = provider;
    }
    for (const f of EXTRA) if (fresh[f] != null) record[f] = fresh[f];
  }
  prov.fetched_at = now();
  delete prov.unavailable_reason;
  return { record, provenance: prov };
}

function carryStorage(old, fresh) {
  if (!old || old.length !== fresh.length || old.some((o, i) => o.kind !== fresh[i].kind)) return fresh;
  return fresh.map((n, i) => {
    const m = { ...n };
    for (const k of ["storage_key", "cover_storage_key", "mime", "bytes"]) if (old[i][k] != null) m[k] = old[i][k];
    return m;
  });
}

/**
 * Grade a record. COMPLETE needs type, author, date and the media the policy asks for.
 * Caption, comments and location can legitimately be missing; they are listed but don't block.
 */
export function assess(record, mediaPolicy) {
  const missing = ["type", "author", "posted_at"].filter((f) => record[f] == null);
  if (record.caption == null) missing.push("caption");
  if (record.comments == null) missing.push("comments");
  const media = record.media;
  let mediaOk = !(media == null || (!media.length && record.type));
  if (mediaOk && mediaPolicy !== "none") {
    for (const m of media) {
      if (m.kind === "image" && !m.storage_key) mediaOk = false;
      if (m.kind === "video" && mediaPolicy === "all" && !m.storage_key) mediaOk = false;
      if (m.kind === "video" && mediaPolicy === "covers" && m.cover_url && !m.cover_storage_key) mediaOk = false;
    }
  }
  if (!mediaOk) missing.push("media");
  const blocking = ["type", "author", "posted_at", "media"];
  return { status: missing.some((f) => blocking.includes(f)) ? "PARTIAL" : "COMPLETE", missing };
}
