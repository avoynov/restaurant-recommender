// Turn user input into canonical targets: profile handles or post shortcodes.
//
// Accepted:  nasa, @nasa, instagram.com/nasa, https://www.instagram.com/nasa/?hl=en
//            /p/{code}, /reel/{code}, /reels/{code}, /tv/{code}, instagr.am/p/{code}, /{user}/p/{code}
// Rejected:  Stories, highlights, explore pages, non-Instagram links (with a clear message).

const HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;
const SHORTCODE_RE = /^[A-Za-z0-9_-]{5,}$/;
const POST_KINDS = new Set(["p", "reel", "reels", "tv"]);
const HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com", "instagr.am", "www.instagr.am"]);
const RESERVED = new Set(["explore", "stories", "accounts", "direct", "about", "developer", "legal", "web",
  "emails", "challenge", "graphql", "api", "s", "highlights", "locations"]);

export class InputError extends Error {}

export const profileUrl = (handle) => `https://www.instagram.com/${handle}/`;
// /reel/ and /p/ share one shortcode, so /p/ is the canonical form.
export const postUrl = (code) => `https://www.instagram.com/p/${code}/`;

export function targetUrl(t) {
  return t.kind === "profile" ? profileUrl(t.value) : postUrl(t.value);
}

export function parseTarget(raw) {
  let s = String(raw ?? "").trim();
  if (!s) throw new InputError("empty input");
  if (s.startsWith("@")) return handle(s.slice(1));
  if (!s.includes("/") && !/\.(com|am|net|org|io|co)$/i.test(s)) return handle(s);

  let url;
  try {
    url = new URL(s.includes("://") ? s : "https://" + s);
  } catch {
    throw new InputError(`not an Instagram link or handle: ${JSON.stringify(raw)}`);
  }
  if (!HOSTS.has(url.hostname.toLowerCase())) throw new InputError(`not an Instagram link or handle: ${JSON.stringify(raw)}`);
  const segs = url.pathname.split("/").filter(Boolean);
  if (!segs.length) throw new InputError(`link has no profile or post: ${JSON.stringify(raw)}`);

  const head = segs[0].toLowerCase();
  if (POST_KINDS.has(head)) {
    if (segs.length < 2 || !SHORTCODE_RE.test(segs[1])) throw new InputError(`post link has no valid shortcode: ${JSON.stringify(raw)}`);
    return { kind: "post", value: segs[1] };
  }
  if (segs.length >= 3 && POST_KINDS.has(segs[1].toLowerCase()) && SHORTCODE_RE.test(segs[2])) {
    return { kind: "post", value: segs[2] };
  }
  if (RESERVED.has(head)) throw new InputError(`Stories, highlights and other non-post pages are not supported: ${JSON.stringify(raw)}`);
  if (segs.length === 1 || (segs.length === 2 && ["reels", "tagged", "feed"].includes(segs[1].toLowerCase()))) return handle(segs[0]);
  throw new InputError(`unrecognised Instagram link: ${JSON.stringify(raw)}`);
}

function handle(s) {
  if (!HANDLE_RE.test(s) || s.startsWith(".") || s.endsWith(".") || s.includes("..")) {
    throw new InputError(`invalid Instagram handle: ${JSON.stringify(s)}`);
  }
  if (RESERVED.has(s.toLowerCase())) throw new InputError(`${JSON.stringify(s)} is an Instagram page, not a profile`);
  return { kind: "profile", value: s.toLowerCase() };
}

/** Shortcode from a post URL, or null. */
export function shortcodeOf(url) {
  if (!url) return null;
  try {
    const t = parseTarget(url);
    return t.kind === "post" ? t.value : null;
  } catch {
    return null;
  }
}

// ---- Every platform ---------------------------------------------------------------------------
//
// parseLink(raw) -> { platform, kind, value, url }
//   instagram    kind post | profile, value shortcode | handle
//   tiktok       kind post, value video id (null for a short link until it is resolved)
//   facebook     kind post, value post or video id when the link carries one, else null
//   google_maps  kind place | list, value null (the scraper resolves the link)
// Record keys stay unique across platforms: Instagram keeps the shortcode, others are prefixed.

const PREFIX = { tiktok: "tt_", facebook: "fb_", google_maps: "gm_" };
export const recordKey = (platform, id) => (platform && platform !== "instagram" ? PREFIX[platform] : "") + String(id).replace(/[^A-Za-z0-9_-]/g, "");
export const platformOfKey = (key) => Object.entries(PREFIX).find(([, p]) => String(key).startsWith(p))?.[0] ?? "instagram";

const isTikTok = (h) => h === "tiktok.com" || h.endsWith(".tiktok.com") || h === "tiktokv.com" || h.endsWith(".tiktokv.com");
const isFacebook = (h) => ["facebook.com", "fb.com", "fb.watch", "fb.me"].some((d) => h === d || h.endsWith("." + d));
const isGoogle = (h) => /^(www\.|maps\.)?google\.[a-z.]{2,6}$/.test(h);
const TT_ID = /^\d{10,25}$/;
const FB_KEEP = ["story_fbid", "id", "v", "fbid", "set"];

export function parseLink(raw) {
  const s = String(raw ?? "").trim();
  if (!s) throw new InputError("empty input");
  let url = null;
  if (s.includes("/") || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)) {
    try {
      url = new URL(s.includes("://") ? s : "https://" + s);
    } catch {
      url = null;
    }
  }
  const host = url?.hostname.toLowerCase().replace(/^www\./, "") ?? "";
  if (url && isTikTok(host)) return tiktok(url, raw);
  if (url && isFacebook(host)) return facebook(url, raw);
  if (url && (host === "maps.app.goo.gl" || (host === "goo.gl" && url.pathname.startsWith("/maps")) || isGoogle(host))) return googleMaps(url, raw);
  const t = parseTarget(s);
  return { platform: "instagram", ...t, url: targetUrl(t) };
}

function tiktok(url, raw) {
  const host = url.hostname.toLowerCase();
  const segs = url.pathname.split("/").filter(Boolean);
  const short = ["vm.tiktok.com", "vt.tiktok.com"].includes(host) || segs[0] === "t";
  if (short) {
    if (!segs.length || (segs[0] === "t" && segs.length < 2)) throw new InputError(`TikTok short link has no code: ${JSON.stringify(raw)}`);
    return { platform: "tiktok", kind: "post", value: null, url: `https://${host}/${segs.join("/")}/` };
  }
  // /@user/video/ID, /@user/photo/ID, /share/video/ID (tiktokv.com, data exports), /v/ID.html, /embed/v2/ID
  let id = null, user = "", photo = false;
  if (segs[0]?.startsWith("@") && ["video", "photo"].includes(segs[1]) && TT_ID.test(segs[2] || "")) {
    [user, id, photo] = [segs[0].slice(1), segs[2], segs[1] === "photo"];
  } else {
    const i = segs.findIndex((x) => ["video", "v", "v2"].includes(x));
    const cand = i >= 0 ? (segs[i + 1] || "").replace(/\.html$/, "") : "";
    if (TT_ID.test(cand)) id = cand;
  }
  if (!id) {
    if (segs[0]?.startsWith("@") && segs.length === 1) throw new InputError(`TikTok profiles aren't supported yet, share a video link: ${JSON.stringify(raw)}`);
    throw new InputError(`unrecognised TikTok link: ${JSON.stringify(raw)}`);
  }
  return { platform: "tiktok", kind: "post", value: id, url: `https://www.tiktok.com/@${user}/${photo ? "photo" : "video"}/${id}` };
}

function facebook(url, raw) {
  const host = url.hostname.toLowerCase().replace(/^(www|m|web|mbasic|touch)\./, "");
  const segs = url.pathname.split("/").filter(Boolean);
  const q = url.searchParams;
  const keep = new URLSearchParams();
  for (const k of FB_KEEP) if (q.get(k)) keep.set(k, q.get(k));
  const canon = (path) => `https://www.facebook.com/${path}${keep.toString() ? "?" + keep : ""}`;
  if (host === "fb.watch" || host === "fb.me") {
    if (!segs.length) throw new InputError(`Facebook short link has no code: ${JSON.stringify(raw)}`);
    return { platform: "facebook", kind: "post", value: null, url: `https://fb.watch/${segs[0]}/` };
  }
  const path = segs.join("/") + (segs.length && !segs.at(-1).includes(".") ? "/" : "");
  const at = (name) => { const i = segs.indexOf(name); return i >= 0 ? segs[i + 1] || null : null; };
  let id = null;
  if (segs[0] === "share") {
    if (segs.length < 2) throw new InputError(`Facebook share link has no code: ${JSON.stringify(raw)}`);
    return { platform: "facebook", kind: "post", value: null, url: canon(path) };
  }
  if (["permalink.php", "story.php"].includes(segs[0])) id = q.get("story_fbid") && q.get("id") ? `${q.get("id")}_${q.get("story_fbid")}` : null;
  else if (segs[0] === "watch") id = q.get("v");
  else if (["photo", "photo.php"].includes(segs[0])) id = q.get("fbid");
  else if (segs.includes("videos")) id = segs.slice(segs.indexOf("videos") + 1).reverse().find((x) => /^\d{6,}$/.test(x)) ?? null;
  else id = at("reel") || at("posts") || at("permalink") || (segs.includes("photos") ? segs.at(-1) : null);
  if (!id || !/^[A-Za-z0-9_.-]{5,}$/.test(id)) {
    if (segs.length === 1 && !segs[0].includes(".php")) throw new InputError(`Facebook page feeds aren't supported yet, share a post or reel link: ${JSON.stringify(raw)}`);
    throw new InputError(`unrecognised Facebook link: ${JSON.stringify(raw)}`);
  }
  return { platform: "facebook", kind: "post", value: id, url: canon(path) };
}

function googleMaps(url, raw) {
  const host = url.hostname.toLowerCase();
  const p = url.pathname;
  const q = url.searchParams;
  if (host === "maps.app.goo.gl" || host === "goo.gl") {
    if (p.split("/").filter(Boolean).length < (host === "goo.gl" ? 2 : 1)) throw new InputError(`Google Maps short link has no code: ${JSON.stringify(raw)}`);
    return { platform: "google_maps", kind: "place", value: null, url: url.origin + p };
  }
  const onMaps = host.startsWith("maps.") || p.startsWith("/maps");
  if (!onMaps) throw new InputError(`not a Google Maps link: ${JSON.stringify(raw)}`);
  if (p.includes("/placelists/list/")) return { platform: "google_maps", kind: "list", value: null, url: url.href };
  if (p.includes("/place/") || q.get("cid") || q.get("query_place_id") || q.get("q") || q.get("ftid") || /!1s0x[0-9a-f]+:0x[0-9a-f]+/.test(p)) {
    return { platform: "google_maps", kind: "place", value: null, url: url.href };
  }
  throw new InputError(`Google Maps link is not a place or a shared list: ${JSON.stringify(raw)}`);
}
