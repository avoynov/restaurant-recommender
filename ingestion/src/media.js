// Media lane: save photos, video covers and (optionally) full videos as our own files.
//
// Instagram CDN links expire within hours, so media is fetched right after metadata and passed
// downstream by storage key only. Keys look like media/{shortcode}/{idx}.{ext}; the folder maps
// 1:1 onto a bucket (R2) later.
//
// Policies: none (metadata only) | covers (photos + video covers) | all (adds full videos)

import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const MAX_BYTES = 100 * 1024 * 1024; // 100 MB per file
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** True file type from magic bytes, never from the URL. Returns [mime, ext] or null. */
export function sniff(head) {
  const b = head;
  const ascii = (s, e) => String.fromCharCode(...b.subarray(s, e));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ["image/jpeg", "jpg"];
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return ["image/png", "png"];
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return ["image/webp", "webp"];
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (["heic", "heix", "mif1", "msf1"].includes(brand)) return ["image/heic", "heic"];
    if (["avif", "avis"].includes(brand)) return ["image/avif", "avif"];
    return ["video/mp4", "mp4"];
  }
  return null;
}

export class MediaStore {
  constructor(root, { fetchFn = globalThis.fetch, apifyToken = null } = {}) {
    this.root = root;
    this.fetch = fetchFn;
    this.apifyToken = apifyToken;
  }

  /** Save what the policy wants and isn't stored yet. Mutates record.media; returns error strings. */
  async downloadPost(record, policy) {
    if (policy === "none" || !record.media?.length) return [];
    const errors = [];
    for (const m of record.media) {
      const jobs = [];
      if (m.kind === "image" && !m.storage_key && m.source_url) jobs.push([m.source_url, "storage_key", `${m.idx}`]);
      if (m.kind === "video") {
        if (m.cover_url && !m.cover_storage_key) jobs.push([m.cover_url, "cover_storage_key", `${m.idx}_cover`]);
        if (policy === "all" && !m.storage_key && m.source_url) jobs.push([m.source_url, "storage_key", `${m.idx}`]);
      }
      for (const [url, field, stem] of jobs) {
        try {
          const { key, mime, size } = await this.save(record.shortcode, stem, url);
          m[field] = key;
          if (field === "storage_key") Object.assign(m, { mime, bytes: size });
        } catch (e) {
          errors.push(`${record.shortcode}#${m.idx} ${field}: ${e.message}`);
        }
      }
    }
    return errors;
  }

  async save(code, stem, url) {
    const dir = join(this.root, "media", code);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${stem}.part`);
    try {
      // TikTok videos and covers come back as Apify key-value store records, which need the token.
      const headers = { "User-Agent": UA };
      if (this.apifyToken && new URL(url).hostname === "api.apify.com") headers.Authorization = `Bearer ${this.apifyToken}`;
      const r = await this.fetch(url, { headers, redirect: "follow" });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      if (Number(r.headers.get("content-length") || 0) > MAX_BYTES) throw new Error("too large");
      const fh = await open(tmp, "w");
      let size = 0;
      let head = new Uint8Array(0);
      try {
        for await (const chunk of r.body) {
          const c = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          if (head.length < 16) head = concat(head, c.subarray(0, 16 - head.length));
          size += c.length;
          if (size > MAX_BYTES) throw new Error("too large");
          await fh.write(c);
        }
      } finally {
        await fh.close();
      }
      const kind = sniff(head);
      if (!kind) throw new Error("not an image or video (unrecognised file type)");
      const [mime, ext] = kind;
      await rename(tmp, join(dir, `${stem}.${ext}`));
      return { key: `media/${code}/${stem}.${ext}`, mime, size };
    } finally {
      await rm(tmp, { force: true });
    }
  }
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
